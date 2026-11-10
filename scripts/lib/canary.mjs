/**
 * THE PRIOR-PERIOD CANARY (1.0.5.1, run by --verify). The prior-period tiles escape Kibana's hidden time filter
 * only because Kibana finds no time column on the events view (panels.mjs, PREVIOUS-PERIOD TILES) — behaviour a
 * code comment describes and no documentation promises. If a Kibana update brings the filter back, the tiles do not
 * break: their prior counts quietly read 0 ("none in prior 24h"), which no text check can tell from a quiet day.
 * So --verify watches the requests the tiles send (/internal/search/esql_async) and what comes back, and fails if
 *   - a request on the view carries a range filter (on @timestamp, the view's time column or anything else), or
 *   - a tile on the page sent no request, or its answer could not be read, or
 *   - a tile's prior count differs from TIME on the stream over the same prior window (prevEsql, with the request's
 *     own dropdown values), which includes reading 0 where the stream has events.
 * The END_WINDOWS charts (Identity 360's ① row, the session timeline) read the same view, so their requests are held
 * to the same no-range-filter rule, and a page that shows one must send its view queries (1.0.8.2).
 * Exported pieces are pure, so the unit tests can feed them captured bodies.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, withStream, objId, CONTROL_VARS, ROOT, DEFAULT_VIEW } from './env.mjs';
import { es } from './http.mjs';
import { PREV_TILES, prevQuery, prevStreamQuery, prevEsql, prevRef, flatPanels, END_WINDOWS, PREV_LOOKBACK_DAYS } from './panels.mjs';

export const ESQL_ASYNC = /\/internal\/search\/esql_async(\/|\?|$)/;

/** Every view query of an END_WINDOWS spec, keyed `window <ref>`. */
export const windowQueries = () => {
  const out = [];
  const walk = (n, ref) => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x, ref));
    if (!n || typeof n !== 'object') return;
    if (n.url?.['%type%'] === 'esql' && String(n.url.query).includes(DEFAULT_VIEW)) out.push([withStream(n.url.query), `window ${ref}`]);
    Object.values(n).forEach((x) => walk(x, ref));
  };
  for (const ref of Object.keys(END_WINDOWS)) walk(JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8')), ref);
  return out;
};

/** The tile keys (and 'stream', and `window <ref>`) each deployed query text belongs to. */
export const canaryQueries = () => new Map([
  ...Object.keys(PREV_TILES).map((k) => [withStream(prevQuery(k)), k]),
  [withStream(prevStreamQuery()), 'stream'],
  ...windowQueries(),
]);

/** The prior-period tiles a dashboard definition places, by key. */
export const tilesOn = (def) => {
  const refs = new Set(flatPanels(def.panels).map((p) => p.config?.ref_id).filter(Boolean));
  return Object.keys(PREV_TILES).filter((k) => refs.has(objId('vega', prevRef(k))));
};

/** The END_WINDOWS specs a dashboard definition places, by ref. */
export const windowsOn = (def) => {
  const refs = new Set(flatPanels(def.panels).map((p) => p.config?.ref_id).filter(Boolean));
  return Object.keys(END_WINDOWS).filter((r) => refs.has(objId('vega', r)));
};

/** Every range clause anywhere in a request's filter, as `field` names. */
export function rangeFields(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => rangeFields(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.range && typeof node.range === 'object') out.push(...Object.keys(node.range));
  for (const v of Object.values(node)) rangeFields(v, out);
  return out;
}

/** A Kibana search request body's ES|QL parts, or null. */
export function readRequest(text) {
  let b;
  try { b = JSON.parse(text || '{}'); } catch { return null; }
  const p = b.params || b;
  return typeof p.query === 'string' ? { query: p.query, filter: p.filter, params: p.params || [] } : null;
}

/** The first row of a Kibana esql_async response, keyed by column, or null while it is still running. */
export function readRow(body) {
  const raw = body?.rawResponse || body?.response || body;
  if (!raw?.columns || body?.isRunning) return null;
  const v = raw.values?.[0];
  return v ? Object.fromEntries(raw.columns.map((c, i) => [c.name, v[i]])) : {};
}

const paramValue = (params, name) => params.find((p) => p && name in p)?.[name];

/** Wire the capture onto a Playwright page; returns the state the checks read. */
export function watch(page) {
  const queries = canaryQueries();
  const state = { requests: [], rows: [], unread: [] };
  const byId = new Map();
  const keyOf = (q) => queries.get(q) || (q.includes(cfg.view) ? 'other' : null);
  page.on('request', (rq) => {
    if (rq.method() !== 'POST' || !ESQL_ASYNC.test(rq.url())) return;
    const r = readRequest(rq.postData());
    const key = r && keyOf(r.query);
    if (key) state.requests.push({ key, ranges: rangeFields(r.filter), params: r.params });
  });
  page.on('response', async (rs) => {
    const rq = rs.request();
    if (rq.method() !== 'POST' || !ESQL_ASYNC.test(rs.url())) return;
    const r = readRequest(rq.postData());
    const id = decodeURIComponent((/esql_async\/([^/?]+)/.exec(rs.url()) || [])[1] || '');
    const key = (r && keyOf(r.query)) || byId.get(id)?.key;
    if (!key) return;
    let body;
    try { body = await rs.json(); } catch { state.unread.push({ key, status: rs.status() }); return; }
    if (body?.id) byId.set(body.id, { key, params: r?.params || byId.get(id)?.params });
    const row = readRow(body);
    if (row) state.rows.push({ key, row, params: r?.params || byId.get(id)?.params || [] });
  });
  return state;
}

/**
 * The verdict for one page: `problems` fail the run, `tiles` go in report.json. `expected` is tilesOn(def), `windows`
 * windowsOn(def). The ground truth is TIME on the stream over each tile's prior window, so it costs one small query per tile.
 */
export async function judge(state, expected, { budgetMs = 30e3, esqlRun = es.esqlRun, windows = [] } = {}) {
  const problems = [], tiles = [];
  const stream = state.rows.filter((r) => r.key === 'stream').at(-1);
  const firstEvent = stream?.row?.t0 ?? null;
  for (const r of state.requests) {
    if (!r.ranges.length) continue;
    problems.push(r.key.startsWith('window ')
      ? `${r.key}: Kibana attached a range filter on ${[...new Set(r.ranges)].join(', ')} — the chart is cut to the picker's range instead of its own window`
      : `prior-period ${r.key}: Kibana attached a range filter on ${[...new Set(r.ranges)].join(', ')} — the hidden time filter is back, so prior counts read 0`);
  }
  for (const ref of windows) {
    if (!state.requests.some((r) => r.key === `window ${ref}`)) problems.push(`window ${ref}: the chart sent no request on ${cfg.view}`);
  }
  for (const key of expected) {
    if (!state.requests.some((r) => r.key === key)) { problems.push(`prior-period ${key}: the tile sent no request on ${cfg.view}`); continue; }
    const got = state.rows.filter((r) => r.key === key).at(-1);
    if (!got) { problems.push(`prior-period ${key}: no answer could be read${state.unread.some((u) => u.key === key) ? ' (unparseable response)' : ''}`); continue; }
    const { cur, prev, s, e } = got.row;
    // Every variable TIME reads (CONTROLS_WHERE), as the tile's own request sent it: an unbound one is a hard error.
    const who = CONTROL_VARS.map((n) => ({ [n]: paramValue(got.params, n) ?? '' }));
    const truth = await esqlRun(prevEsql(key), [{ _tstart: new Date(2 * s - e).toISOString() }, { _tend: new Date(s).toISOString() }, ...who], { budgetMs });
    const want = truth.ok ? truth.body.values?.[0]?.[0] : undefined;
    // A prior window reaching past the lookback (a picker ending days ago) is cut at NOW() - PREV_LOOKBACK_DAYS by the
    // tile, which then reads "no full prior": it can only count fewer than the whole window, never the same.
    const clipped = 2 * s - e < Date.now() - PREV_LOOKBACK_DAYS * 864e5;
    tiles.push({ key, cur, prev, priorOnStream: want, clipped, from: new Date(2 * s - e).toISOString(), to: new Date(s).toISOString() });
    if (want === undefined) problems.push(`prior-period ${key}: the ground-truth query failed (${JSON.stringify(truth.body).slice(0, 120)})`);
    else if (prev === 0 && want > 0 && firstEvent !== null && s > firstEvent) {
      problems.push(`prior-period ${key}: the prior count reads 0 while the picker starts after the stream's first event (${new Date(firstEvent).toISOString()}) and the stream holds ${want} — the hidden time filter is back`);
    } else if (clipped ? prev > want : prev !== want) {
      problems.push(`prior-period ${key}: the tile's prior count is ${prev}, TIME on the stream counts ${want} over the same window${clipped ? ' (the tile cuts it at the lookback, so it cannot read more)' : ''}`);
    }
  }
  if (expected.length && !stream) problems.push(`prior-period: the stream's first event (the "no full prior" gate) was never read`);
  return { problems, tiles, firstEvent };
}
