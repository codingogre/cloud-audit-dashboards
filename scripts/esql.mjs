/**
 * Executes every ES|QL query in the repo before anything deploys.
 *
 * Kibana injects ?_tstart/?_tend at runtime; the linter supplies concrete values so the
 * exact query text that will ship is validated end to end. Catches the mistakes this data
 * shape invites: multi-value fields needing MV_EXPAND, wildcard fields needing ::keyword,
 * and dotted names that ES|QL cannot resolve.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cfg, withStream, controlParams, NO_SELECTION } from './lib/env.mjs';
import { pinnedPanels } from './lib/controls.mjs';
import { es, kb } from './lib/http.mjs';
import { success, fail, detail, warn } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { checkLayout } from './lib/layout.mjs';
import { requireView } from './lib/view.mjs';
import { PREV_TILES, PREV_LOOKBACK_DAYS, prevSpec, prevEsql, fixedWindow, windowMs, prevQuery, prevStreamQuery, VIEW_TIME, ANY, flatPanels } from './lib/panels.mjs';

/**
 * Every query runs through es.esqlRun(), which cancels it on overrun — a plain /_query keeps
 * running on the cluster after the client gives up, and serverless has no way to stop it. BUDGET is
 * the hard limit (over it fails the build); SLOW is reported, because a query that passes today at
 * 8s is the one that times out on a busier day.
 */
const BUDGET_MS = Number(process.env.AUDIT_LINT_BUDGET_MS) || 30e3;
const SLOW_MS = 5e3;

/**
 * The params Kibana would send for a query from `src`: the last hour, as the picker's shortest preset, or the
 * spec's own window when its panel carries one (VEGA_WINDOWS in panels.mjs) — a fixed-window spec never runs
 * over the picker's range, so linting it there would time and validate a query no viewer runs.
 */
export const PARAMS = (src) => {
  const win = fixedWindow(src);
  const end = new Date(), start = new Date(Date.now() - (win ? windowMs(win) : 3600e3));
  return [{ _tstart: start.toISOString() }, { _tend: end.toISOString() }, ...controlParams()];
};

const TIME_BOUND = 'WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart';

/**
 * Discover sessions carry no time predicate of their own — Kibana applies the time picker — so
 * linting them verbatim runs an unbounded scan over the whole data stream, which is the one thing
 * Kibana never does. Bounding them here validates the query as it is actually executed.
 *
 * This is not cosmetic: an unbounded scan is not what any viewer runs, so its timing would mislead.
 * An earlier note here blamed the null-guarded noise gate — "a negation cannot push down, so it is
 * evaluated per document" — for a >75s unbounded raw feed. Re-measured on the 2.6M-event perf
 * replica, the raw signal feed returns in 30–57ms over 1h and 37–63ms over 7 days, and the full NOISE
 * gate costs 45–56ms over 7 days: the negation is cheap. What is expensive is a CASE with two or
 * more conditions evaluated per row (QUERY SHAPE in panels.mjs).
 */
/** The query without the nullify SET, planned but not run (LIMIT 0); null when it has no SET. */
export function strictQuery(q) {
  const m = /^\s*SET unmapped_fields="nullify";\s*/.exec(q);
  return m ? `${q.slice(m[0].length)} | LIMIT 0` : null;
}
/** What a strict plan's failure means: null when it ran, or when only api_key.* columns were unknown. */
export function strictProblem(res) {
  if (res.ok) return null;
  const reason = String(res.body?.error?.root_cause?.[0]?.reason || res.body?.error?.reason || JSON.stringify(res.body));
  const unknown = [...reason.matchAll(/Unknown column \[([^\]]+)\]/g)].map((x) => x[1]);
  if (unknown.length && unknown.every((c) => c.startsWith('api_key.'))) return null;
  return unknown.length
    ? `names ${unknown.filter((c) => !c.startsWith('api_key.')).join(', ')}, which the stream does not map — the nullify SET would show it as an empty column`
    : `fails without the nullify SET: ${reason.replace(/\n/g, ' ').slice(0, 200)}`;
}

export function bounded(q) {
  // A query on the events view (the prior-period tiles) bounds its own window, on VIEW_TIME: it has no @timestamp.
  if (/\?_tstart|\?_tend|@timestamp\s*[<>]/.test(q) || new RegExp(`\\b${VIEW_TIME}\\s*[<>]`).test(q)) return q;
  const i = q.indexOf('|');
  return i === -1 ? `${q} | ${TIME_BOUND}` : `${q.slice(0, i)}| ${TIME_BOUND} ${q.slice(i)}`;
}

function collect(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'query' || k === 'esql') && typeof v === 'string' && /^\s*(SET\s[^;]*;\s*)*FROM\s/i.test(v)) out.push(v);
      else collect(v, out);
    }
  }
}

/**
 * DSL Vega data sources — `{ url: { index, body }, format: { property } }` — carry no ES|QL, so
 * collect() cannot see them and they would otherwise ship completely unvalidated. A DSL panel that
 * returns nothing is not broken DOM text either, so --verify cannot catch it: this is the only gate.
 */
function collectDsl(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collectDsl(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  if (node.url && typeof node.url === 'object' && typeof node.url.index === 'string' && node.url.body) {
    // timefield is carried for --perf, which has to know whether Kibana would bind this spec to the picker.
    out.push({ index: node.url.index, body: node.url.body, property: node.format?.property, timefield: node.url['%timefield%'] });
  }
  for (const v of Object.values(node)) collectDsl(v, out);
}

/**
 * Kibana substitutes the dashboard's filters for these placeholders and removes them when there
 * are none, so stripping them lints the unfiltered case — the expensive one, and what an analyst
 * sees before picking anyone.
 */
const CONTEXT_CLAUSES = new Set(['%dashboard_context-must_clause%', '%dashboard_context-must_not_clause%',
  '%dashboard_context-filter_clause%']);
/**
 * `{"%timefilter%": "min" | "max"}` is the picker's start or end in ms, which Kibana substitutes anywhere
 * in a DSL body (no spec uses it since the previous-period tiles moved to ES|QL in 1.0.5.1; kept so one that
 * does is linted rather than rejected). Unreplaced, Elasticsearch rejects
 * the body, so the lint binds it to `win` — by default the dashboards' own range, the last 24 hours ending
 * a minute ago. Kibana's `shift`/`unit` options are not used by any spec, so they are refused here.
 */
export const lintWindow = (ms = 864e5, end = Date.now() - 60e3) => ({ min: end - ms, max: end });
export function stripContext(node, win = lintWindow()) {
  if (Array.isArray(node)) return node.filter((v) => !CONTEXT_CLAUSES.has(v)).map((v) => stripContext(v, win));
  if (node && typeof node === 'object') {
    if ('%timefilter%' in node) {
      if (Object.keys(node).length !== 1 || !(node['%timefilter%'] in win)) throw new Error(`unsupported %timefilter% ${JSON.stringify(node)}`);
      return win[node['%timefilter%']];
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, stripContext(v, win)]));
  }
  return node;
}

/**
 * PARITY (1.0.5; ES|QL tiles since 1.0.5.1). A prior-period tile reads the events view and bounds its own window
 * (panels.mjs, PREVIOUS-PERIOD TILES), so nothing else proves it counts what the Lens tiles beside it would. Each
 * tile's current and prior numbers must equal prevEsql(key), the plain TIME-bounded count on the stream, over the
 * current window and over the prior one, to the event: over the 7 days ending five minutes ago (whole seconds, so
 * nothing in it is still arriving; a quiet filter is often 0 for a day, and 0 = 0 proves little) and the 24 hours
 * a dashboard opens on. 7 + 7 days keeps the prior window inside the 15-day lookback, which would otherwise cut it.
 * It runs with the dropdowns empty, and again with the selection AUDIT_PROJECT, AUDIT_IDENTITY_KIND, AUDIT_IDENTITY and
 * AUDIT_CLIENT_IP make when any is set, so both counts are proven to follow a selection. The stream dataset's first event is checked against the stream's.
 */
export const parityWindows = (now = Date.now()) => {
  const end = Math.floor((now - 300e3) / 1000) * 1000;
  return [['7d', 7 * 864e5], ['24h', 864e5]].map(([label, len]) => ({ label, s: end - len, e: end }));
};
const iso = (ms) => new Date(ms).toISOString();
const paramsFor = (s, e, who) => [{ _tstart: iso(s) }, { _tend: iso(e) }, ...who];
export async function prevParity({ budgetMs = BUDGET_MS } = {}) {
  const env = controlParams();
  const selections = [{ label: 'nothing selected', who: controlParams(NO_SELECTION) }];
  const chosen = env.filter((p) => Object.values(p)[0] !== '');
  if (chosen.length) selections.push({ label: `selected ${JSON.stringify(Object.assign({}, ...chosen))}`, who: env });
  const one = (r) => (r.ok ? r.body.values?.[0] : undefined);
  const why = (r) => (r.ok ? '' : JSON.stringify(r.body).slice(0, 160));
  const out = [];
  for (const { label: sel, who } of selections) {
    for (const w of parityWindows()) {
      for (const key of Object.keys(PREV_TILES)) {
        const [tile, cur, prev] = await Promise.all([
          es.esqlRun(withStream(prevQuery(key)), paramsFor(w.s, w.e, who), { budgetMs }),
          es.esqlRun(prevEsql(key), paramsFor(w.s, w.e, who), { budgetMs }),
          es.esqlRun(prevEsql(key), paramsFor(2 * w.s - w.e, w.s, who), { budgetMs }),
        ]);
        const t = one(tile), want = [one(cur)?.[0], one(prev)?.[0]];
        const got = t ? [t[0], t[1]] : [undefined, undefined];
        out.push({ key: `${key} ${w.label} ${sel}`, got, want, ok: want.every((v) => v !== undefined) && got[0] === want[0] && got[1] === want[1],
          ms: Math.max(tile.ms || 0, cur.ms || 0, prev.ms || 0), error: why(tile) || why(cur) || why(prev) || undefined });
      }
    }
  }
  // The "no full prior" gate: the stream dataset's first event must be the stream's own, read with @timestamp.
  // Both reads cut the lookback at one fixed instant: with NOW() in each, two requests a moment apart disagree
  // whenever the oldest event leaves the lookback between them, which happens daily once the stream is older.
  const cut = `TO_DATETIME("${iso(Date.now() - PREV_LOOKBACK_DAYS * 864e5)}")`;
  const lookback = /NOW\(\) - \d+ days/;
  if (!lookback.test(prevStreamQuery())) throw new Error('prevStreamQuery() no longer bounds its lookback with NOW() - N days; update prevParity');
  const [g, d] = await Promise.all([
    es.esqlRun(withStream(prevStreamQuery()).replace(lookback, cut), undefined, { budgetMs }),
    es.esqlRun(`FROM ${cfg.dataStream} | WHERE @timestamp >= ${cut} | STATS t0 = MIN(@timestamp) | EVAL t0 = TO_LONG(t0)`, undefined, { budgetMs }),
  ]);
  // A picker longer than the lookback: the headline (current) count is never cut, only the prior window is.
  const long = parityWindows().map((w) => ({ ...w, label: `${PREV_LOOKBACK_DAYS + 5}d`, s: w.e - (PREV_LOOKBACK_DAYS + 5) * 864e5 }))[0];
  for (const key of Object.keys(PREV_TILES)) {
    const who = selections[0].who;
    const [tile, cur] = await Promise.all([
      es.esqlRun(withStream(prevQuery(key)), paramsFor(long.s, long.e, who), { budgetMs }),
      es.esqlRun(prevEsql(key), paramsFor(long.s, long.e, who), { budgetMs }),
    ]);
    const got = one(tile)?.[0], want = one(cur)?.[0];
    out.push({ key: `${key} ${long.label} current only`, got: [got], want: [want], ok: want !== undefined && got === want,
      ms: Math.max(tile.ms || 0, cur.ms || 0), error: why(tile) || why(cur) || undefined });
  }
  const gv = one(g)?.[0], dv = one(d)?.[0];
  out.push({ key: 'stream first event', got: [gv], want: [dv], ok: gv !== undefined && gv === dv, ms: Math.max(g.ms || 0, d.ms || 0), error: why(g) || why(d) || undefined });
  return out;
}

/**
 * The escape route's live guard (panels.mjs, PREVIOUS-PERIOD TILES). Kibana decides which column of an ES|QL
 * panel to filter to the picker by asking /internal/esql/get_timefield, so ask it about every query that reads
 * the events view: any answer other than "none" means the hidden filter is back and the prior counts read 0.
 * The rest of the lint never talks to Kibana; this is the one call that has to.
 */
export async function escapeCheck() {
  const qs = [...new Set(gatherQueries().map((x) => x.q).filter((q) => new RegExp(`FROM\\s+${cfg.view}\\b`).test(q)))];
  const out = [];
  for (const query of qs) {
    const r = await kb.raw('/internal/esql/get_timefield', { method: 'POST', body: { query },
      headers: { 'x-elastic-internal-origin': 'kibana', 'elastic-api-version': '1' } });
    out.push({ query, ok: r.ok && !r.body?.timeField, status: r.status, timeField: r.body?.timeField });
  }
  return out;
}

const resolvePath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function gatherDsl() {
  const items = [];
  const p = join(ROOT, 'vega');
  if (!existsSync(p)) return items;
  for (const f of readdirSync(p).filter((f) => f.endsWith('.json'))) {
    const found = []; collectDsl(JSON.parse(withStream(readFileSync(join(p, f), 'utf8'))), found);
    found.forEach((d, i) => items.push({ src: `vega/${f}`, i, ...d }));
  }
  return items;
}

export function gatherQueries() {
  const items = [];
  for (const [name, d] of Object.entries(buildAll())) {
    const qs = []; collect(d.panels, qs);
    // A table's columns must all come back from its query: Lens draws a column the result lacks as an error, and
    // nothing before a render would see it (1.0.5.4 added Identity type to 22 tables' queries by hand).
    const cols = new Map(flatPanels(d.panels).filter((p) => p.config?.type === 'data_table')
      .map((p) => [p.config.data_source.query, [...p.config.rows, ...p.config.metrics].map((c) => c.column)]));
    qs.forEach((q, i) => items.push({ src: `dashboards/${name}`, i, q, cols: cols.get(q) }));
  }
  for (const dir of ['vega', 'searches']) {
    const p = join(ROOT, dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p).filter((f) => f.endsWith('.json'))) {
      const doc = JSON.parse(withStream(readFileSync(join(p, f), 'utf8')));
      const qs = []; collect(doc, qs);
      qs.forEach((q, i) => items.push({ src: `${dir}/${f}`, i, q }));
    }
  }
  // The dropdowns' option queries (controls.mjs): a broken one leaves a control with nothing to pick.
  pinnedPanels().forEach((p, i) => items.push({ src: `controls/${p.config.variable_name}`, i, q: p.config.esql_query, control: true }));
  return items;
}

export async function run() {
  /**
   * Geometry and fragment-drift first, before any network work. Both are pure functions over the
   * in-memory definitions, so they cost milliseconds — and failing here means --lint does not burn
   * ~100 round trips validating a suite whose panels overlap or whose Vega has drifted.
   */
  const layout = checkLayout(buildAll());
  if (layout.problems.length) {
    layout.problems.forEach((m) => fail(m));
    throw new Error(`${layout.problems.length} structural problem(s) — fix before deploying`);
  }
  success(`${layout.dashboards} dashboards, ${layout.panelCount} panels, grid clean`);
  layout.rows.filter((r) => r.includes('advisory')).forEach((r) => warn(r));

  // The prior-period tiles read the events view: without it every one of their queries would fail with an unknown
  // index, so say what to run instead (--deploy creates it before it lints).
  await requireView();
  const items = gatherQueries();
  const timings = [];
  let bad = 0;
  for (const { src, i, q: raw, control, cols } of items) {
    const q = bounded(raw);
    const res = await es.esqlRun(q, PARAMS(src), { budgetMs: BUDGET_MS });
    timings.push({ src: `${src}[${i}]`, ms: res.ms });
    // A dropdown's list must open on "Any": it is the only way back to no selection (panels.mjs, ANY).
    if (res.ok && control && res.body.values?.[0]?.[0] !== ANY) {
      bad++;
      fail(`${src} lists ${JSON.stringify(res.body.values?.[0]?.[0])} first, not "${ANY}" — a viewer could not clear it`);
      continue;
    }
    const missing = res.ok && cols ? cols.filter((c) => !res.body.columns?.some((x) => x.name === c)) : [];
    if (missing.length) {
      bad++;
      fail(`${src}[${i}] shows ${missing.join(', ')}, which its query does not return`);
      continue;
    }
    if (res.ok) continue;
    bad++;
    const reason = res.body?.error?.root_cause?.[0]?.reason || res.body?.error?.reason || JSON.stringify(res.body);
    fail(`${src}[${i}] ${String(reason).replace(/\n/g, ' ').slice(0, 220)}`);
    detail(q.slice(0, 200));
  }

  // SET unmapped_fields="nullify" turns a misspelt field into a silent null column, and since TIME names
  // api_key.name (IDENTITY_WHERE, inside CONTROLS_WHERE) nearly every query carries it. So plan each such query once more without it,
  // cheaply (LIMIT 0): only an api_key.* field — legitimately unmapped on a project that never used a key — may be
  // unknown. Anything else unknown is a typo the SET was hiding.
  for (const { src, i, q: raw } of items) {
    const strict = strictQuery(bounded(raw));
    if (!strict) continue;
    const res = await es.esqlRun(strict, PARAMS(src), { budgetMs: BUDGET_MS });
    const typo = strictProblem(res);
    if (!typo) continue;
    bad++;
    fail(`${src}[${i}] ${typo}`);
  }

  const dsl = gatherDsl();
  for (const { src, i, index, body, property } of dsl) {
    const res = await es.searchRun(index, stripContext(body), { budgetMs: BUDGET_MS });
    timings.push({ src: `${src}[dsl ${i}]`, ms: res.ms });
    const reason = !res.ok
      ? (res.body?.error?.root_cause?.[0]?.reason || res.body?.error?.reason || JSON.stringify(res.body))
      // A typo'd format.property renders an empty panel and nothing downstream can see it.
      : (property && resolvePath(res.body, property) === undefined ? `format.property "${property}" resolves to nothing` : null);
    if (!reason) continue;
    bad++;
    fail(`${src}[dsl ${i}] ${String(reason).replace(/\n/g, ' ').slice(0, 220)}`);
  }

  const parity = await prevParity();
  for (const r of parity) {
    timings.push({ src: `parity ${r.key}`, ms: r.ms });
    if (r.ok) { detail(`parity ${r.key}: ${r.got.join(' / ')}`); continue; }
    bad++;
    fail(`parity ${r.key}: the tile reads ${JSON.stringify(r.got)}, TIME on the stream ${JSON.stringify(r.want)}${r.error ? ` (${r.error})` : ''} — prevQuery() in scripts/lib/panels.mjs must count what TIME counts`);
  }
  const escape = await escapeCheck();
  for (const r of escape) {
    if (r.ok) continue;
    bad++;
    fail(`escape: Kibana would filter ${r.timeField ? `"${r.timeField}"` : `(get_timefield ${r.status})`} to the picker on a query that reads the events view, so its prior count reads 0: ${r.query.slice(0, 120)}`);
  }
  if (escape.length) detail(`escape: Kibana attaches no time filter to the ${escape.length} queries on ${cfg.view}`);

  const total = items.length + dsl.length + parity.length + escape.length;
  const slow = timings.filter((t) => t.ms >= SLOW_MS).sort((a, b) => b.ms - a.ms);
  slow.slice(0, 10).forEach((t) => warn(`slow: ${(t.ms / 1000).toFixed(1)}s  ${t.src}`));
  if (bad) throw new Error(`${bad}/${total} queries failed — fix before deploying`);
  const worst = timings.reduce((m, t) => (t.ms > m.ms ? t : m), { ms: 0, src: '-' });
  success(`${items.length} ES|QL + ${dsl.length} DSL queries OK — slowest ${(worst.ms / 1000).toFixed(1)}s (${worst.src})`);
}
