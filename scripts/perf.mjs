/**
 * Query performance at production volume, measured against a replica rather than the live stream.
 *
 *   --perf seed  [--copies N] [--days D] [--slices S] [--max-minutes M] [--seed s] [--force-append]
 *   --perf run   [--windows 1h,24h,7d] [--budget ms] [--only name,...] [--anchor data|now]
 *   --perf clean
 *
 * Why a replica: the live audit stream holds a couple of hours of events, so every window wider than
 * that measures the same documents and a 7-day panel looks as cheap as a 1-hour one. `seed` copies the
 * live stream N times into logs-<dataset>-perf, re-stamping each copy into the last D days, so the
 * windows the dashboards offer have the density they will have in production. The replica is a
 * sibling data stream of the same dataset, so the repo's own index template (logsdb, passthrough
 * attributes, client.* mappings, the geoip final_pipeline) creates it — the mapping under test is
 * the production mapping, not an approximation of it.
 *
 * The live stream is only ever READ. Every write and delete here goes through assertPerfTarget(),
 * which refuses any name that is not a -perf stream distinct from the live one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT, DEFAULT_STREAM, parseStream } from './lib/env.mjs';
import { es } from './lib/http.mjs';
import { info, success, fail, detail, warn } from './lib/log.mjs';

/**
 * NOTHING that reaches scripts/lib/panels.mjs may be imported statically here. panels.mjs binds
 * `IDX = cfg.dataStream` at module load, so a static import would freeze every dashboard query onto
 * the live stream before `run` has had a chance to point AUDIT_STREAM at the replica. esql.mjs and
 * definitions.mjs are loaded with import() inside cmdRun(), after the env is set.
 */

const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const fmtMs = (ms) => (ms == null ? '-' : ms >= 10e3 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const n = (x) => Number(x).toLocaleString('en-US');

const opt = (args, name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
};
const num = (args, name, dflt) => {
  const v = Number(opt(args, name, dflt));
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`${name} must be a positive number`);
  return v;
};

// ---------------------------------------------------------------------------------------------
// Pure parts (unit-tested)
// ---------------------------------------------------------------------------------------------

/** The replica's name: the live stream's dataset with namespace `perf`, so the dataset's template applies. */
export const perfStreamFor = (live) => `logs-${parseStream(live).dataset}-perf`;

/**
 * The one guard every write and delete passes through. Deliberately redundant: the derived name
 * cannot be the live one today, but this is the check that still holds if someone later makes the
 * target configurable, sets AUDIT_STREAM to the replica, or passes a pattern.
 */
export function assertPerfTarget(target, live) {
  if (typeof target !== 'string' || !target) throw new Error('perf target stream is empty');
  if (/[*,?\s]/.test(target)) throw new Error(`refusing perf target "${target}": patterns and lists are not allowed`);
  if (!target.endsWith('-perf')) throw new Error(`refusing perf target "${target}": it must end in -perf`);
  if (target === live || target === DEFAULT_STREAM) throw new Error(`refusing perf target "${target}": that is the live audit stream`);
  if (live.endsWith('-perf')) throw new Error(`AUDIT_STREAM is "${live}" — point it at the live stream, not the replica`);
  return target;
}

/** `1h,24h,7d` -> [{ label, ms }]. Units m/h/d; the label is kept verbatim for the report. */
export function parseWindows(spec) {
  const out = String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((label) => {
    const m = /^(\d+)(m|h|d)$/.exec(label);
    if (!m || Number(m[1]) <= 0) throw new Error(`bad window "${label}" — use e.g. 15m, 1h, 24h, 7d`);
    return { label, ms: Number(m[1]) * { m: 60e3, h: 3600e3, d: DAY }[m[2]] };
  });
  if (!out.length) throw new Error('--windows is empty');
  return out;
}

/** The picker params Kibana injects, for one window ending `now`. Same shape as esql.mjs PARAMS(). */
export const windowParams = (ms, now = Date.now()) =>
  [{ _tstart: new Date(now - ms).toISOString() }, { _tend: new Date(now).toISOString() }];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/**
 * Where each copy lands: a whole-copy shift, so every copy keeps the source's sessions, bursts and
 * ordering intact (a per-document shift would scatter one Kibana session across the week).
 *
 * The obvious plan — shift by whole days to keep the time-of-day shape — does not work on this
 * source: it spans ~2 hours, so whole-day shifts stack every copy on the same two hours of each
 * day, and a 1h window at any other hour of the day is empty. Instead:
 *
 *   copy 0      ends exactly at `now`, so the 1h and 24h windows always contain a full-density block
 *   copies 1..  one per equal stratum of [now - days, now - span], at a seeded point inside it, so
 *               the week is covered evenly with no clumping and the plan is reproducible from --seed
 *
 * Every block ends at or before `now`: a future-dated document would sit outside every window.
 */
export function planCopies({ copies, days, srcMin, srcMax, now, seed = 1 }) {
  if (!(copies >= 1) || !(days > 0)) throw new Error('copies and days must be positive');
  if (!(srcMax >= srcMin)) throw new Error('source time range is empty');
  const span = srcMax - srcMin;
  const rand = mulberry32(typeof seed === 'number' ? seed : hash(seed));
  const plan = [{ copy: 0, shiftMs: now - srcMax }];
  const lo = now - days * DAY, hi = Math.max(lo, now - span);
  const w = (hi - lo) / Math.max(1, copies - 1);
  for (let k = 1; k < copies; k++) {
    const start = lo + (k - 1) * w + rand() * w;
    plan.push({ copy: k, shiftMs: Math.round(start - srcMin) });
  }
  return plan.map((p) => ({ ...p, start: srcMin + p.shiftMs, end: srcMax + p.shiftMs }));
}

/**
 * The per-copy reindex script.
 *
 * _id gets a run+copy suffix because reindex keeps the source _id, and op_type=create then rejects
 * every copy after the first as a version conflict. A deterministic suffix (not a null id) means a
 * retried copy conflicts harmlessly instead of duplicating, while a later --force-append run, with a
 * different run tag, adds new documents. observed_timestamp moves with @timestamp so the two never
 * disagree by days. data_stream.namespace is rewritten so a replica document never claims to be live.
 */
export function copyScript({ shiftMs, runTag, copy }) {
  return {
    lang: 'painless',
    params: { shift: shiftMs, suffix: `-p${runTag}c${copy}`, namespace: 'perf' },
    source: [
      "def t = ctx._source['@timestamp'];",
      "if (t instanceof Number) { ctx._source['@timestamp'] = t + params.shift; }",
      "else if (t != null) { ctx._source['@timestamp'] = Instant.parse(t.toString()).plusMillis(params.shift).toString(); }",
      "def o = ctx._source['observed_timestamp'];",
      "if (o instanceof String) { ctx._source['observed_timestamp'] = Instant.parse(o).plusMillis(params.shift).toString(); }",
      'ctx._id = ctx._id + params.suffix;',
      'if (ctx._source.data_stream instanceof Map) { ctx._source.data_stream.namespace = params.namespace; }',
    ].join(' '),
  };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** Every saved-object ref a dashboard's panels make, at any depth. */
function refsOf(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((v) => refsOf(v, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'ref_id' && typeof v === 'string') out.add(v);
      else refsOf(v, out);
    }
  }
  return out;
}

/**
 * Group the --lint inventory the way Kibana issues it: one page load runs the dashboard's own panel
 * queries plus the queries inside every Vega spec and Discover session it embeds. A spec embedded on
 * two dashboards is in both groups. Specs no dashboard embeds land in "(unreferenced)" so the
 * inventory stays complete — they are timed but have no page load.
 */
export function groupByDashboard(defs, esqlItems, dslItems) {
  const fileFor = (ref) => {
    // Ids carry an optional AUDIT_ID_NS segment (cloud-audit-<ns>-vega-…, see nsId()); without
    // tolerating it every embedded spec would silently fall into "(unreferenced)".
    let m = /^cloud-audit(?:-.+?)?-vega-(.+)$/.exec(ref); if (m) return `vega/${m[1]}.json`;
    m = /^cloud-audit(?:-.+?)?-search-(.+)$/.exec(ref); if (m) return `searches/${m[1]}.json`;
    return null;
  };
  const all = [
    ...esqlItems.map((x) => ({ kind: 'esql', key: `${x.src}[${x.i}]`, ...x })),
    ...dslItems.map((x) => ({ kind: 'dsl', key: `${x.src}[dsl ${x.i}]`, ...x })),
  ];
  const used = new Set();
  const groups = Object.entries(defs).map(([name, d]) => {
    const files = new Set([...refsOf(d.panels)].map(fileFor).filter(Boolean));
    const items = all.filter((x) => x.src === `dashboards/${name}` || files.has(x.src));
    items.forEach((x) => used.add(x.key));
    return { name, items };
  });
  const rest = all.filter((x) => !used.has(x.key));
  if (rest.length) groups.push({ name: '(unreferenced)', items: rest, noPageLoad: true });
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Cluster helpers
// ---------------------------------------------------------------------------------------------

const reasonOf = (r) => String(r.body?.error?.root_cause?.[0]?.reason || r.body?.error?.reason || JSON.stringify(r.body)).replace(/\n/g, ' ');

async function esqlRows(query, budgetMs = 60e3) {
  const r = await es.esqlRun(query, null, { budgetMs });
  if (!r.ok) throw new Error(`ES|QL ${r.status}: ${reasonOf(r).slice(0, 300)}`);
  const cols = r.body.columns.map((c) => c.name);
  return r.body.values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

const streamExists = async (name) => (await es.raw(`/_data_stream/${name}`)).status === 200;

async function perDay(stream) {
  return esqlRows(`FROM ${stream} | EVAL day = DATE_TRUNC(1 day, @timestamp) | STATS docs = COUNT(*) BY day | SORT day`);
}

/**
 * Resident ES|QL work on the audit dataset — live or replica — skews every timing taken while it
 * runs, and none of it can be cancelled on serverless (see scripts/queries.mjs). Warn, do not refuse:
 * an open dashboard in someone's browser is enough to put entries here.
 */
async function residentQueries(dataset) {
  const { queries = {} } = await es.get('/_query/queries', { timeoutMs: 30e3 });
  return Object.values(queries).filter((q) => (q.query || '').includes(dataset))
    .map((q) => ({ secs: q.running_time_nanos / 1e9, query: (q.query || '').replace(/\s+/g, ' ').slice(0, 100) }));
}

// ---------------------------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------------------------

let stopping = false;

/**
 * Run one copy as a reindex task and poll it. The task API is the only progress channel: on
 * serverless GET /_tasks/{id} works, but GET /_tasks (list) and POST /_tasks/{id}/_cancel answer
 * 410 api_not_available, so a started copy cannot be stopped — Ctrl-C only stops further copies.
 */
async function reindexCopy({ live, dest, srcMaxIso, slices, script, label }) {
  assertPerfTarget(dest, live);
  const body = {
    // Upper-bounded at the planned source max: the live stream keeps growing during the seed, and a
    // document newer than the plan's srcMax would be shifted past `now` into the future.
    source: { index: live, size: 1000, query: { range: { '@timestamp': { lte: srcMaxIso } } } },
    dest: { index: dest, op_type: 'create' },
    script, conflicts: 'proceed',
  };
  // slices=auto resolves to ONE slice here: serverless reports a single shard. An explicit count
  // is what parallelises it (measured: 1 slice ~1.1k docs/s, 4 slices ~5k docs/s).
  const r = await es.raw(`/_reindex?wait_for_completion=false&slices=${slices}`, { method: 'POST', body });
  if (!r.ok || !r.body.task) throw new Error(`${label}: reindex refused (${r.status}): ${reasonOf(r).slice(0, 300)}`);
  const task = r.body.task;
  const t0 = Date.now();
  let lastLog = t0;
  for (;;) {
    await sleep(2000);
    const t = await es.raw(`/_tasks/${encodeURIComponent(task)}`, { timeoutMs: 30e3 }).catch((e) => ({ ok: false, status: 0, body: { error: { reason: e.message } } }));
    if (!t.ok) { warn(`${label}: task poll ${t.status} ${reasonOf(t).slice(0, 120)} — retrying`); continue; }
    const st = t.body.task?.status || {};
    if (t.body.completed) {
      const res = t.body.response || {};
      const failures = res.failures || [];
      if (t.body.error) throw new Error(`${label}: task failed: ${JSON.stringify(t.body.error).slice(0, 300)}`);
      return { task, ms: Date.now() - t0, created: res.created ?? st.created ?? 0, total: res.total ?? st.total ?? 0,
               conflicts: res.version_conflicts ?? 0, failures: failures.length, firstFailure: failures[0] };
    }
    if (Date.now() - lastLog > 15e3) {
      lastLog = Date.now();
      detail(`${label}: ${n(st.created || 0)}/${n(st.total || 0)} after ${fmtMs(Date.now() - t0)}`);
    }
  }
}

async function cmdSeed(args) {
  const live = cfg.dataStream;
  const dest = assertPerfTarget(perfStreamFor(live), live);
  const copies = num(args, '--copies', 30);
  const days = num(args, '--days', 7);
  const slices = num(args, '--slices', 4);
  const maxMinutes = num(args, '--max-minutes', 25);
  const seed = opt(args, '--seed', 'perf');
  const append = args.includes('--force-append');

  if (await streamExists(dest) && !append) {
    throw new Error(`${dest} already exists — run ./audit --perf clean first, or pass --force-append to add copies`);
  }
  const [src] = await esqlRows(`FROM ${live} | STATS docs = COUNT(*), lo = MIN(@timestamp), hi = MAX(@timestamp)`);
  if (!src?.docs) throw new Error(`${live} is empty — nothing to replicate`);
  const srcMin = Date.parse(src.lo), srcMax = Date.parse(src.hi);
  info(`source ${live}: ${n(src.docs)} docs, ${src.lo} .. ${src.hi} (${((srcMax - srcMin) / 3600e3).toFixed(1)}h)`);
  info(`target ${dest}: ${copies} copies over ${days}d, ${slices} slices/copy, stop launching after ${maxMinutes} min`);

  const now = Date.now();
  const runTag = stamp().replace('-', '');
  const plan = planCopies({ copies, days, srcMin, srcMax, now, seed });
  const srcMaxIso = new Date(srcMax).toISOString();

  const onSig = () => {
    if (stopping) process.exit(130);
    stopping = true;
    warn('stopping after the current copy (a started reindex cannot be cancelled on serverless); signal again to exit now');
  };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);

  const t0 = Date.now();
  const done = [];
  try {
    for (const p of plan) {
      if (stopping) break;
      if (Date.now() - t0 > maxMinutes * 60e3) { warn(`--max-minutes ${maxMinutes} reached: ${done.length}/${copies} copies seeded`); break; }
      const label = `copy ${String(p.copy + 1).padStart(2)}/${copies}`;
      const r = await reindexCopy({ live, dest, srcMaxIso, slices, label, script: copyScript({ shiftMs: p.shiftMs, runTag, copy: p.copy }) });
      done.push({ ...p, ...r });
      const rate = r.ms ? Math.round(r.created / (r.ms / 1000)) : 0;
      (r.failures ? warn : detail)(`${label}: ${n(r.created)} docs -> ${new Date(p.start).toISOString().slice(0, 16)}..${new Date(p.end).toISOString().slice(11, 16)}Z`
        + ` in ${fmtMs(r.ms)} (${n(rate)}/s)${r.conflicts ? `, ${n(r.conflicts)} conflicts` : ''}${r.failures ? `, ${r.failures} FAILURES: ${JSON.stringify(r.firstFailure).slice(0, 160)}` : ''}`);
    }
  } finally {
    process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
  }

  await es.raw(`/${dest}/_refresh`, { method: 'POST' });
  const elapsed = Date.now() - t0;
  const created = done.reduce((s, d) => s + d.created, 0);
  const days_ = await perDay(dest);
  const total = days_.reduce((s, d) => s + d.docs, 0);
  info('documents per day (UTC):');
  for (const d of days_) detail(`${String(d.day).slice(0, 10)}  ${n(d.docs).padStart(12)}`);
  success(`${dest}: ${n(total)} docs (${n(created)} created by ${done.length} copies this run) in ${fmtMs(elapsed)}`);

  const out = join(ROOT, 'build', `perf-seed-${stamp()}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'seed.json'), JSON.stringify({ live, dest, source: src, copies, days, slices, seed, runTag,
    elapsedMs: elapsed, created, total, perDay: days_, copiesDone: done }, null, 2));
  detail(`plan and per-copy timings: ${join(out, 'seed.json').replace(`${ROOT}/`, '')}`);
}

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------

/**
 * Bind a DSL spec as Kibana would for a given picker window. es_query_parser.ts applies the picker
 * ONLY when the spec sets %timefield%; otherwise the spec's own explicit range is the whole truth and
 * the picker changes nothing (see the TIME BINDING table in panels.mjs). Every DSL spec in the repo
 * today is in the second group — they show fixed 24h/7d windows on purpose.
 */
export function bindDsl(body, timefield, stripContext, win, now = Date.now()) {
  const b = stripContext(body);
  if (!timefield) return b;
  const range = { range: { [timefield]: { gte: new Date(now - win.ms).toISOString(), lte: new Date(now).toISOString(), format: 'strict_date_optional_time' } } };
  return { ...b, query: { bool: { filter: [range, ...(b.query ? [b.query] : [])] } } };
}

async function timeOne(item, win, budgetMs, lib, anchor) {
  const r = item.kind === 'esql'
    ? await es.esqlRun(lib.bounded(item.q), windowParams(win.ms, anchor), { budgetMs })
    : await es.searchRun(item.index, bindDsl(item.body, item.timefield, lib.stripContext, win, anchor), { budgetMs });
  return { ms: r.ms, ok: r.ok, cancelled: !!r.cancelled, error: r.ok ? undefined : reasonOf(r).slice(0, 200) };
}

async function cmdRun(args) {
  const live = cfg.dataStream;
  const perf = assertPerfTarget(perfStreamFor(live), live);
  const windows = parseWindows(opt(args, '--windows', '1h,24h,7d'));
  const budgetMs = num(args, '--budget', 30e3);
  const only = opt(args, '--only', '');
  const anchorMode = opt(args, '--anchor', 'data');
  if (!['data', 'now'].includes(anchorMode)) throw new Error('--anchor must be data or now');

  if (!(await streamExists(perf))) throw new Error(`${perf} does not exist — run ./audit --perf seed first`);
  const [st] = await esqlRows(`FROM ${perf} | STATS docs = COUNT(*), lo = MIN(@timestamp), hi = MAX(@timestamp)`);
  info(`replica ${perf}: ${n(st.docs)} docs, ${st.lo} .. ${st.hi}`);
  const hiAge = Date.now() - Date.parse(st.hi);
  /**
   * Where the picker's "now" sits. In production the stream is continuous, so the last hour is always
   * full; the replica stops at seed time, so a window ending at the wall clock under-fills by however
   * long ago the seed ran (a 1h window 15 min after the seed holds 45 min of data). `data` (default)
   * ends every picker-bound window at the newest replica document; `now` is the wall clock. Fixed-window
   * DSL specs resolve their own `now-…` on the server and cannot be re-anchored.
   */
  const anchor = anchorMode === 'data' ? Math.min(Date.now(), Date.parse(st.hi) + 1) : Date.now();
  if (anchorMode === 'now' && hiAge > 600e3) warn(`newest replica document is ${fmtMs(hiAge)} old — wall-clock windows under-fill; use --anchor data or re-seed`);
  info(`picker windows end at ${new Date(anchor).toISOString()} (--anchor ${anchorMode})`);

  // Now, and only now, point the suite at the replica and load it (see the import note at the top).
  process.env.AUDIT_STREAM = perf;
  const lib = await import('./esql.mjs');
  const { buildAll } = await import('./lib/definitions.mjs');
  const esqlItems = lib.gatherQueries();
  const dslItems = lib.gatherDsl();
  // If anything still names the live stream the replica is not what is being measured; refuse.
  const stray = [...esqlItems.map((x) => x.q), ...dslItems.map((x) => x.index)].filter((t) => t.includes(live) || !t.includes(perf));
  if (stray.length) throw new Error(`${stray.length} queries do not target ${perf} (e.g. ${stray[0].slice(0, 120)}) — refusing to time them`);

  let groups = groupByDashboard(buildAll(), esqlItems, dslItems);
  if (only) { const want = only.split(','); groups = groups.filter((g) => want.some((w) => g.name.includes(w))); }
  const unique = new Map(groups.flatMap((g) => g.items).map((x) => [x.key, x]));
  const followsPicker = (x) => x.kind === 'esql' || !!x.timefield;
  const fixed = [...unique.values()].filter((x) => !followsPicker(x));
  info(`${esqlItems.length} ES|QL + ${dslItems.length} DSL queries in ${groups.length} groups; budget ${fmtMs(budgetMs)}/query; windows ${windows.map((w) => w.label).join(', ')}`);
  if (fixed.length) detail(`fixed window (picker ignored, same query in every window): ${fixed.map((x) => x.key).join(', ')}`);

  const resident = await residentQueries(parseStream(live).dataset);
  if (resident.length) {
    warn(`${resident.length} ES|QL quer${resident.length === 1 ? 'y is' : 'ies are'} already running on the audit dataset — timings will include their load:`);
    resident.slice(0, 5).forEach((r) => detail(`${r.secs.toFixed(0)}s  ${r.query}`));
  } else detail('no resident ES|QL queries on the audit dataset');

  const seq = [];   // { window, key, src, kind, ms, ok, cancelled, error }
  const conc = [];  // { window, dashboard, wallMs, n, failed, cancelled, items: [...] }
  for (const win of windows) {
    info(`window ${win.label}: sequential, ${unique.size} queries`);
    // (a) One at a time on a quiet cluster: the query's own cost. Each unique query is timed once
    // per window even when several dashboards embed it.
    const byKey = new Map();
    for (const x of unique.values()) {
      const r = await timeOne(x, win, budgetMs, lib, anchor);
      byKey.set(x.key, r);
      seq.push({ window: win.label, key: x.key, src: x.src, kind: x.kind, follows: followsPicker(x), ...r });
      if (!r.ok) (r.cancelled ? warn : fail)(`${win.label} ${x.key}: ${r.cancelled ? `cancelled at ${fmtMs(budgetMs)} budget` : r.error}`);
    }
    // (b) A page load: every query on one dashboard at once, as Kibana fans them out, wall-clock
    // from first submit to last response. Dashboards are loaded one after another, never together.
    info(`window ${win.label}: concurrent page loads`);
    for (const g of groups) {
      if (g.noPageLoad) continue;
      const t0 = Date.now();
      const rs = await Promise.all(g.items.map(async (x) => ({ key: x.key, ...(await timeOne(x, win, budgetMs, lib, anchor)) })));
      const wallMs = Date.now() - t0;
      const failed = rs.filter((r) => !r.ok).length, cancelled = rs.filter((r) => r.cancelled).length;
      conc.push({ window: win.label, dashboard: g.name, wallMs, n: rs.length, failed, cancelled, items: rs });
      (failed ? warn : detail)(`${win.label} ${g.name.padEnd(24)} ${String(rs.length).padStart(3)} queries  wall ${fmtMs(wallMs).padStart(7)}${failed ? `  ${failed} failed (${cancelled} over budget)` : ''}`);
    }
    for (const g of groups) {
      g.seq ??= {};
      g.seq[win.label] = g.items.map((x) => ({ key: x.key, ...byKey.get(x.key) }));
    }
  }

  // Report
  const rows = [];
  for (const g of groups) {
    for (const win of windows) {
      const s = g.seq[win.label];
      const ms = s.map((r) => r.ms);
      const worst = s.reduce((m, r) => (r.ms > m.ms ? r : m), { ms: -1 });
      const c = conc.find((x) => x.dashboard === g.name && x.window === win.label);
      rows.push({ dashboard: g.name, window: win.label, queries: s.length, slowestMs: worst.ms, slowest: worst.key,
                  p50Ms: percentile(ms, 0.5), concurrentWallMs: c?.wallMs ?? null, failed: s.filter((r) => !r.ok).length,
                  concurrentFailed: c?.failed ?? null });
    }
  }
  console.log('');
  console.log(`${'dashboard'.padEnd(24)} ${'window'.padEnd(6)} ${'n'.padStart(3)} ${'slowest'.padStart(8)} ${'p50'.padStart(7)} ${'page'.padStart(8)}  slowest query`);
  for (const r of rows) {
    console.log(`${r.dashboard.padEnd(24)} ${r.window.padEnd(6)} ${String(r.queries).padStart(3)} ${fmtMs(r.slowestMs).padStart(8)} ${fmtMs(r.p50Ms).padStart(7)} ${fmtMs(r.concurrentWallMs).padStart(8)}  ${r.slowest}${r.failed ? `  (${r.failed} failed)` : ''}`);
  }
  const top = [...seq].sort((a, b) => b.ms - a.ms).slice(0, 15);
  console.log('\nslowest 15 (sequential):');
  for (const t of top) console.log(`  ${fmtMs(t.ms).padStart(8)}  ${t.window.padEnd(5)} ${t.key}${t.follows ? '' : '  [fixed window]'}${t.ok ? '' : t.cancelled ? '  CANCELLED' : '  FAILED'}`);

  const out = join(ROOT, 'build', `perf-${stamp()}`);
  mkdirSync(out, { recursive: true });
  const file = join(out, 'report.json');
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), stream: perf, docs: st.docs, span: [st.lo, st.hi],
    budgetMs, anchor: new Date(anchor).toISOString(), anchorMode, windows: windows.map((w) => w.label), residentAtStart: resident, summary: rows, sequential: seq, concurrent: conc }, null, 2));
  const bad = seq.filter((s) => !s.ok).length;
  (bad ? warn : success)(`${seq.length} timings, ${bad} over budget or failed — report ${file.replace(`${ROOT}/`, '')}`);
}

// ---------------------------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------------------------

async function cmdClean() {
  const live = cfg.dataStream;
  const dest = assertPerfTarget(perfStreamFor(live), live);
  // DELETE /_data_stream takes patterns; the guard above has already refused anything but one exact name.
  const r = await es.raw(`/_data_stream/${dest}`, { method: 'DELETE' });
  if (r.status === 404) { info(`${dest} does not exist; nothing deleted`); return; }
  if (!r.ok) throw new Error(`delete ${dest}: ${r.status} ${reasonOf(r).slice(0, 200)}`);
  success(`deleted data stream ${dest}`);
}

export async function run(args = []) {
  const sub = args[0];
  const table = { seed: cmdSeed, run: cmdRun, clean: cmdClean };
  if (!table[sub]) throw new Error(`--perf needs one of: ${Object.keys(table).join(', ')}`);
  return table[sub](args.slice(1));
}
