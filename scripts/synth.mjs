/**
 * Synthetic audit activity: drive real API traffic as a cast of personas so the platform emits
 * real audit events, then prove they landed and score the way the dashboards expect.
 *
 *   --synth run    [--only ids] [--seed s] [--no-verify] [--keep] [--timeout-min n]
 *   --synth loop   [--minutes n] [--only ids] [--demo]   continuous traffic; --demo recurs every scenario within the hour
 *   --synth schema                                 field drift: map + dashboard refs vs live stream
 *   --synth list                                   scenarios, personas and weights
 *   --synth clean  [--dry-run] [--only ids] [--run runId]   every syn-* resource, one scenario group's, or one run's
 *
 * The generator writes only to syn-* indices and syn-* Kibana objects. It never indexes into the
 * audit stream: every event the stream holds afterwards was emitted by the platform itself.
 */
import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.mjs';
import { es } from './lib/http.mjs';
import { info, success, fail, detail, warn } from './lib/log.mjs';
import { createRun, teardown } from './synth/context.mjs';
import { SCENARIOS, validate, select } from './synth/scenarios/index.mjs';
import { verify, landed } from './synth/verify.mjs';
import { drift, STREAM } from './synth/fields.mjs';
import { PERSONAS } from './synth/personas.mjs';

const OUT = join(ROOT, 'build', 'synth');
const flag = (args, name) => args.includes(name);
export const opt = (args, name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
};
export const num = (args, name, dflt) => {
  const v = Number(opt(args, name, dflt));
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`${name} must be a positive number`);
  return v;
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const newRunId = () => `syn-${stamp()}-${String(process.pid).slice(-4)}`;
const personasFor = (list) => [...new Set(list.flatMap((s) => s.personas))].filter((p) => PERSONAS[p]);

/**
 * Ctrl-C / SIGTERM: the first signal asks the current command to stop at the next safe point and
 * run its own teardown (retire keys, clean this run's resources); a second signal exits at once.
 * Without this, an interrupted run skipped every `finally` and left live persona keys behind.
 */
let stopping = false;
export const isStopping = () => stopping;
function onSignals(label) {
  const handler = (sig) => {
    if (stopping) { fail(`${sig} again — exiting without cleanup; persona keys expire within 25h`); process.exit(130); }
    stopping = true;
    warn(`${sig}: stopping ${label} after the current step, then cleaning up (signal again to force)`);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
}

/** Ledger and report files are kept for two weeks; a long-running loop otherwise fills the disk. */
function pruneOutputs(days = 14) {
  try {
    mkdirSync(OUT, { recursive: true });
    for (const f of readdirSync(OUT)) {
      const p = join(OUT, f);
      if (Date.now() - statSync(p).mtimeMs > days * 864e5) rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
}

export async function runScenarios(ctx, list, { round } = {}) {
  for (const s of list) {
    if (stopping) { warn(`${s.id.padEnd(32)} not started (stopping)`); s.facts = { skipped: 'interrupted' }; continue; }
    const mark = ctx.ledger.entries.length;
    const sctx = ctx.forScenario(s.id, { round });
    sctx.mintNewHire = () => ctx.mintNewHire();
    try {
      s.facts = (await s.run(sctx)) || {};
    } catch (e) {
      s.facts = { error: String(e.message || e) };
      ctx.ledger.add({ ts: new Date().toISOString(), run: ctx.runId, scenario: s.id, ok: false, error: `run() threw: ${s.facts.error}` });
    }
    // Count only this invocation's calls: in loop mode the ledger spans every round.
    const calls = ctx.ledger.entries.slice(mark).filter((e) => e.scenario === s.id);
    const bad = calls.filter((c) => !c.ok).length;
    (s.facts.skipped ? warn : bad ? fail : detail)(`${s.id.padEnd(32)} ${s.facts.skipped ? `skipped: ${s.facts.skipped}` : `${calls.length} calls${bad ? `, ${bad} unexpected` : ''}`}`);
  }
}

export function report(results) {
  let failed = 0;
  for (const r of results) {
    if (r.skipped) { warn(`${r.id}: skipped (${r.skipped})`); continue; }
    (r.pass ? success : fail)(`${r.id} — ${r.title}`);
    if (!r.pass) failed++;
    for (const g of r.generatorErrors) detail(`  generator: ${g.method || ''} ${g.path || ''} -> ${g.status ?? ''} (expected ${JSON.stringify(g.expect)}) ${g.error || ''}`);
    for (const e of r.expectations) {
      const tag = e.pass ? 'ok' : e.kind === 'finding' ? 'finding' : 'FAIL';
      detail(`  [${tag}] ${e.name}: n=${e.n}${e.risk !== undefined ? ` risk=${(e.risks || []).join('/') || '-'} want ${e.risk}` : ''}${e.error ? ` — ${e.error}` : ''}${e.settleError ? ` (settle re-check could not run: ${e.settleError})` : ''}`);
    }
  }
  return failed;
}

function cleanupReport({ removed, failed, skipped }, label) {
  for (const f of failed) warn(`cleanup failed: ${f}`);
  detail(`${label}: removed ${removed.length}${skipped.length ? `, left ${skipped.length} not attributable to this run` : ''}${failed.length ? `, ${failed.length} FAILED` : ''}`);
  return failed.length;
}

async function cmdRun(args) {
  const list = validate(select(opt(args, '--only')));
  const timeoutMs = num(args, '--timeout-min', 6) * 60e3;
  const runId = newRunId();
  // A generous lower bound: ES expectations are opaque-id scoped and Kibana ones use run-unique ids,
  // so a wide window cannot match another run — while a narrow one loses events to clock skew.
  const from = new Date(Date.now() - 10 * 60e3).toISOString();
  pruneOutputs();
  info(`run ${runId}: ${list.length} scenarios against ${STREAM}`);
  const off = onSignals('the run');
  const ctx = await createRun({ runId, seed: opt(args, '--seed', runId), personas: personasFor(list) });
  let cleanupFailures = 0;
  try {
    try {
      await runScenarios(ctx, list);
    } finally {
      if (!flag(args, '--keep')) await ctx.retire();
    }
    mkdirSync(OUT, { recursive: true });
    if (flag(args, '--no-verify') || stopping) {
      const bad = ctx.ledger.unexpected();
      info(`ledger: ${ctx.ledger.file}`);
      if (bad.length) throw new Error(`${bad.length} calls did not behave as their scenario intended`);
      return success(stopping ? 'Interrupted — generated so far, not verified' : 'Generated (verification skipped)');
    }
    const l = await landed(from);
    if (!l.ok) warn(`audit stream not queryable yet (${l.status}: ${l.reason}) — waiting for delivery`);
    info(`verifying against ${STREAM} (up to ${timeoutMs / 60e3} min for delivery)`);
    const results = await verify(list, {
      runId, from, ledger: ctx.ledger, timeoutMs,
      onPoll: (left) => left && detail(`${left} expectations still waiting…`),
    });
    writeFileSync(join(OUT, `${runId}.report.json`), JSON.stringify({ runId, from, results }, null, 2));
    const failed = report(results);
    info(`report: build/synth/${runId}.report.json`);
    if (failed) throw new Error(`${failed} scenario(s) failed verification`);
    success(`All ${results.filter((r) => !r.skipped).length} scenarios verified in the audit stream`);
  } finally {
    // Run-scoped: only what THIS run created, so a concurrent run is never touched.
    if (!flag(args, '--keep')) cleanupFailures = cleanupReport(await teardown({ scenarios: list, runIds: [runId] }), 'cleanup');
    off();
    if (cleanupFailures) warn(`${cleanupFailures} cleanup step(s) failed — run ./audit --synth clean --dry-run to review`);
  }
}

/**
 * Demo tempo: production cadences (security changes every 12h, SLOs daily) leave most panels dark in
 * a 1h window (the dashboards' default until 1.0.5; 24h since). `--demo` compresses every cadence so each scenario recurs inside
 * the hour — 1-20 minutes — while keeping their relative order: noisy things stay frequent, rare
 * things stay comparatively rare. Each wait is jittered ±30% so activity does not look metronomic.
 */
export const demoCadence = (min) => Math.min(20, Math.max(1, Math.round(min / 24)));

async function cmdLoop(args) {
  const list = validate(select(opt(args, '--only')));
  const minutes = num(args, '--minutes', 60);
  const demo = flag(args, '--demo');
  const cadence = (s) => (demo ? demoCadence(s.cadenceMin) : s.cadenceMin);
  const nextDue = new Map();
  const until = Date.now() + minutes * 60e3;
  const runIds = [];
  let ctx = null, mintedAt = 0, round = 0, prunedAt = 0, failures = 0;
  pruneOutputs();
  info(`loop for ${minutes} min over ${list.length} scenarios${demo ? ' at demo tempo (every scenario recurs within the hour)' : ''}`);
  const off = onSignals('the loop');
  try {
    while (Date.now() < until && !stopping) {
      if (!ctx || Date.now() - mintedAt > 12 * 3600e3) {
        // Mint the replacement BEFORE retiring the old keys, and survive a failed rotation: one
        // transient error must not end a week-long baseline run.
        try {
          const next = await createRun({ runId: newRunId(), seedData: !ctx, personas: personasFor(list) });
          if (ctx) await ctx.retire();
          ctx = next; mintedAt = Date.now(); runIds.push(ctx.runId); failures = 0;
        } catch (e) {
          if (!ctx || ++failures > 10) throw e;
          warn(`key rotation failed (${e.message}); keeping current keys and retrying`);
        }
      }
      if (Date.now() - prunedAt > 3600e3) {
        // Keep the noise workload's index bounded: syn-app-logs would otherwise grow by ~200k docs a day.
        await es.raw('/syn-app-logs/_delete_by_query?conflicts=proceed', {
          method: 'POST', body: { query: { range: { '@timestamp': { lt: 'now-6h' } } } },
        }).catch(() => {});
        prunedAt = Date.now();
      }
      const due = list.filter((s) => !nextDue.has(s.id) || Date.now() >= nextDue.get(s.id));
      if (due.length) {
        info(`round ${++round}: ${due.map((s) => s.id).join(', ')}`);
        await runScenarios(ctx, ctx.r.shuffle(due), { round });
        for (const s of due) nextDue.set(s.id, Date.now() + cadence(s) * 60e3 * (0.7 + 0.6 * ctx.r.next()));
        // The ledger is persisted per call; memory keeps only the recent tail.
        if (ctx.ledger.entries.length > 20000) ctx.ledger.entries.splice(0, ctx.ledger.entries.length - 5000);
      }
      const wait = 15e3 + ctx.r.int(0, 15e3);
      for (let t = 0; t < wait && !stopping; t += 1000) await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    if (ctx) await ctx.retire();
    if (runIds.length) cleanupReport(await teardown({ scenarios: list, runIds }), 'cleanup');
    off();
  }
  success(`loop finished after ${round} rounds${stopping ? ' (interrupted)' : ''}`);
}

async function cmdSchema() {
  const d = await drift();
  if (d.error) throw new Error(d.error);
  info(`${STREAM}: ${d.queryableCount} queryable fields, ${d.sampled} documents sampled from the last 7 days`);
  const by = (st) => d.fields.filter((f) => f.status === st);
  for (const f of by('renamed')) warn(`renamed:      ${f.path} -> ${f.to}`);
  for (const f of by('candidate')) warn(`moved?:       ${f.path} -> ${f.candidates.join(' | ')} (confirm, then add to RENAMES)`);
  for (const f of by('unmapped')) warn(`unmapped:     ${f.path} (in ${f.docs} docs; queries naming it fail — needs a mapping)`);
  for (const f of by('mapped-empty')) detail(`mapped, never populated in the sample: ${f.path}`);
  for (const f of by('not-observed')) detail(`not observed: ${f.path} (not mapped, not emitted in the sample — no evidence either way)`);
  for (const u of d.unmapped) warn(`emitted but unmapped: ${u}`);
  for (const v of d.values) (v.wasCount ? warn : detail)(`value ${v.field}: "${v.was}" x${v.wasCount} -> "${v.now}" x${v.nowCount}`);
  success(`${by('mapped').length + by('mapped-empty').length}/${d.fields.length} referenced fields mapped (${by('mapped-empty').length} never populated in the sample)`);
  if (!d.ok) throw new Error('schema drift needs action (see renamed / moved / unmapped above)');
}

function cmdList() {
  for (const [id, p] of Object.entries(PERSONAS)) detail(`persona ${id.padEnd(11)} ${p.name.padEnd(26)} ${p.title}`);
  for (const s of SCENARIOS) detail(`${s.id.padEnd(32)} w=${s.weights.join('/').padEnd(10)} every ${String(s.cadenceMin).padStart(4)}m  ${s.title}`);
}

async function cmdClean(args) {
  const only = opt(args, '--only');
  const run = opt(args, '--run');
  const dryRun = flag(args, '--dry-run');
  const res = await teardown({ scenarios: only ? select(only) : SCENARIOS, dryRun, scoped: Boolean(only), runIds: run ? [run] : undefined });
  for (const r of res.removed) detail(r);
  for (const f of res.failed) warn(`failed: ${f}`);
  success(`${dryRun ? 'Would remove' : 'Removed'} ${res.removed.length} syn-* resources`);
  if (res.failed.length) throw new Error(`${res.failed.length} cleanup step(s) failed`);
}

export async function run(args = []) {
  validate();
  const sub = args[0];
  const rest = args.slice(1);
  const table = { run: cmdRun, loop: cmdLoop, schema: cmdSchema, list: cmdList, clean: cmdClean };
  if (!table[sub]) throw new Error(`--synth needs one of: ${Object.keys(table).join(', ')}`);
  return table[sub](rest);
}
