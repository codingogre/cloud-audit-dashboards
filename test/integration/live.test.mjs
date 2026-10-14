/**
 * Live integration suite. Runs against the project in .env and only when AUDIT_IT=1 (npm run test:it).
 *
 * Order matters and the file runs serially:
 *   1. schema      the configured stream exists and nothing the suite relies on was renamed or unmapped
 *   2. generator   every scenario runs as its personas and each lands in the audit stream, scoring
 *                  exactly as the dashboards' own RISK constant says it should
 *   3. dashboards  every ES|QL and DSL query that ships executes against the stream the generator
 *                  just filled — an "Unknown column" or a renamed index fails here, not in a demo
 *   4. ingest      geoip enrichment is flowing on the traffic step 2 produced
 *
 * Cleanup is scoped to this run's scenarios: a full `--synth clean` would also remove what a
 * concurrently running generator is using.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cfg } from '../../scripts/lib/env.mjs';

const enabled = process.env.AUDIT_IT === '1';
if (enabled && existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const { es } = await import('../../scripts/lib/http.mjs');
const { drift, VALUE_RENAMES, STREAM, lit } = await import('../../scripts/synth/fields.mjs');
const { createRun, teardown } = await import('../../scripts/synth/context.mjs');
const { SCENARIOS, validate, select } = await import('../../scripts/synth/scenarios/index.mjs');
const { verify } = await import('../../scripts/synth/verify.mjs');
const { runScenarios } = await import('../../scripts/synth.mjs');
const { gatherQueries, gatherDsl, bounded, PARAMS, stripContext } = await import('../../scripts/esql.mjs');
const ingest = await import('../../scripts/ingest.mjs');

const opts = { skip: enabled ? false : 'set AUDIT_IT=1 to run the live suite' };
const only = process.env.AUDIT_IT_ONLY;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const runId = `syn-it-${stamp}-${String(process.pid).slice(-4)}`;
let ctx, list, results, from;

before(async () => {
  if (!enabled) return;
  list = validate(select(only));
  from = new Date(Date.now() - 5e3).toISOString();
});

after(async () => {
  if (!enabled) return;
  if (ctx) await ctx.retire();
  if (list) await teardown({ scenarios: list, scoped: true });
});

test('schema: the configured stream exists and nothing referenced is renamed or unmapped', opts, async (t) => {
  const ds = await es.raw(`/_data_stream/${cfg.dataStream}`);
  assert.equal(ds.status, 200, `data stream ${cfg.dataStream} not found (${ds.status}) — is AUDIT_STREAM right and audit logging on?`);
  const d = await drift();
  assert.ok(!d.error, d.error);
  for (const f of d.fields.filter((x) => x.status === 'mapped-empty')) t.diagnostic(`mapped but never populated in the sample: ${f.path}`);
  for (const f of d.fields.filter((x) => x.status === 'not-observed')) t.diagnostic(`not mapped and not observed: ${f.path}`);
  const blocking = d.fields.filter((f) => ['renamed', 'candidate', 'unmapped'].includes(f.status))
    .map((f) => `${f.status}: ${f.path}${f.to ? ` -> ${f.to}` : ''}${f.candidates ? ` -> ${f.candidates.join('|')}` : ''}`);
  assert.deepEqual([...blocking, ...d.unmapped.map((u) => `emitted but unmapped: ${u}`)], []);
});

test('schema: retired literal values are no longer emitted', opts, async () => {
  for (const v of VALUE_RENAMES) {
    const r = await es.esql(`FROM ${STREAM} | WHERE @timestamp > NOW() - 1 day | STATS was = COUNT_DISTINCT(CASE(${v.field} == ${lit(v.was)}, 1, null)), now = COUNT_DISTINCT(CASE(${v.field} == ${lit(v.now)}, 1, null))`);
    const [was, now] = r.values[0];
    assert.equal(was, 0, `${v.field} still carries retired "${v.was}"`);
    assert.equal(now, 1, `${v.field} has no "${v.now}" events in the last day`);
  }
});

test('generator: every scenario lands in the audit stream and scores as the dashboards expect', opts, async (t) => {
  ctx = await createRun({ runId, persist: true, log: false });
  await runScenarios(ctx, list);
  results = await verify(list, { runId, from, ledger: ctx.ledger, timeoutMs: Number(process.env.AUDIT_IT_TIMEOUT_MIN || 8) * 60e3 });
  for (const r of results) {
    await t.test(r.id, { skip: r.skipped ? `platform: ${r.skipped}` : false }, () => {
      const gen = r.generatorErrors.map((g) => `generator: ${g.method || ''} ${g.path || ''} -> ${g.status ?? ''} want ${JSON.stringify(g.expect)} ${g.error || ''}`);
      const exp = r.expectations.filter((e) => e.kind === 'must' && !e.pass)
        .map((e) => `${e.name}: n=${e.n}${e.risk !== undefined ? ` risk=${(e.risks || []).join('/')} want ${e.risk}` : ''}${e.error ? ` (${e.error})` : ''}`);
      for (const e of r.expectations.filter((x) => x.kind === 'finding')) t.diagnostic(`finding ${e.pass ? 'observed' : 'not observed'}: ${e.name} (n=${e.n})`);
      assert.deepEqual([...gen, ...exp], []);
    });
  }
});

test('dashboards: every shipping ES|QL query executes against the configured stream', opts, async () => {
  const failures = [];
  for (const { src, i, q } of gatherQueries()) {
    const r = await es.esqlRun(bounded(q), PARAMS(), { budgetMs: 45e3 });
    if (!r.ok) failures.push(`${src}[${i}]: ${String(r.body?.error?.root_cause?.[0]?.reason || r.body?.error?.reason || r.status).slice(0, 160)}`);
    else if (!q.includes(cfg.dataStream) && /FROM\s+logs-/.test(q)) failures.push(`${src}[${i}]: reads ${/FROM\s+(\S+)/.exec(q)[1]}, not ${cfg.dataStream}`);
  }
  assert.deepEqual(failures, []);
});

test('dashboards: every DSL (Vega) data source targets the configured stream and resolves', opts, async () => {
  const failures = [];
  for (const { src, i, index, body } of gatherDsl()) {
    if (index !== cfg.dataStream) failures.push(`${src}[dsl ${i}]: index ${index}`);
    const r = await es.searchRun(index, stripContext(body), { budgetMs: 45e3 });
    if (!r.ok) failures.push(`${src}[dsl ${i}]: ${String(r.body?.error?.root_cause?.[0]?.reason || r.status).slice(0, 160)}`);
  }
  assert.deepEqual(failures, []);
});

test('ingest: geoip enrichment is flowing on fresh traffic', opts, async () => {
  await assert.doesNotReject(() => ingest.check());
});
