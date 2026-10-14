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
import { ROOT, withStream } from './lib/env.mjs';
import { es } from './lib/http.mjs';
import { success, fail, detail, warn } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { checkLayout } from './lib/layout.mjs';

/**
 * Every query runs through es.esqlRun(), which cancels it on overrun — a plain /_query keeps
 * running on the cluster after the client gives up, and serverless has no way to stop it. BUDGET is
 * the hard limit (over it fails the build); SLOW is reported, because a query that passes today at
 * 8s is the one that times out on a busier day.
 */
const BUDGET_MS = Number(process.env.AUDIT_LINT_BUDGET_MS) || 30e3;
const SLOW_MS = 5e3;

export const PARAMS = () => {
  const end = new Date(), start = new Date(Date.now() - 3600e3);
  return [{ _tstart: start.toISOString() }, { _tend: end.toISOString() }];
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
export function bounded(q) {
  if (/\?_tstart|\?_tend|@timestamp\s*[<>]/.test(q)) return q;
  const i = q.indexOf('|');
  return i === -1 ? `${q} | ${TIME_BOUND}` : `${q.slice(0, i)}| ${TIME_BOUND} ${q.slice(i)}`;
}

function collect(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'query' || k === 'esql') && typeof v === 'string' && /^\s*FROM\s/i.test(v)) out.push(v);
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
export function stripContext(node) {
  if (Array.isArray(node)) return node.filter((v) => !CONTEXT_CLAUSES.has(v)).map(stripContext);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, stripContext(v)]));
  return node;
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
    qs.forEach((q, i) => items.push({ src: `dashboards/${name}`, i, q }));
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

  const items = gatherQueries();
  const timings = [];
  let bad = 0;
  for (const { src, i, q: raw } of items) {
    const q = bounded(raw);
    const res = await es.esqlRun(q, PARAMS(), { budgetMs: BUDGET_MS });
    timings.push({ src: `${src}[${i}]`, ms: res.ms });
    if (res.ok) continue;
    bad++;
    const reason = res.body?.error?.root_cause?.[0]?.reason || res.body?.error?.reason || JSON.stringify(res.body);
    fail(`${src}[${i}] ${String(reason).replace(/\n/g, ' ').slice(0, 220)}`);
    detail(q.slice(0, 200));
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

  const total = items.length + dsl.length;
  const slow = timings.filter((t) => t.ms >= SLOW_MS).sort((a, b) => b.ms - a.ms);
  slow.slice(0, 10).forEach((t) => warn(`slow: ${(t.ms / 1000).toFixed(1)}s  ${t.src}`));
  if (bad) throw new Error(`${bad}/${total} queries failed — fix before deploying`);
  const worst = timings.reduce((m, t) => (t.ms > m.ms ? t : m), { ms: 0, src: '-' });
  success(`${items.length} ES|QL + ${dsl.length} DSL queries OK — slowest ${(worst.ms / 1000).toFixed(1)}s (${worst.src})`);
}
