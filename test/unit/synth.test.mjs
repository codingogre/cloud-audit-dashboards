/**
 * Generator unit tests: no network, no .env. These pin the rules that keep the generator safe
 * (ownership, no secrets in the ledger), correct (scoping, verdicts) and reproducible (seeded rng).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS, PREFIX, SPACES, assertOwned, newHire } from '../../scripts/synth/personas.mjs';
import { SCENARIOS, validate, select } from '../../scripts/synth/scenarios/index.mjs';
import { judge, buildQuery } from '../../scripts/synth/verify.mjs';
import { F, SOURCE, lit, referencedFields } from '../../scripts/synth/fields.mjs';
import { makeClient, matches, Ledger } from '../../scripts/synth/client.mjs';
import { rng } from '../../scripts/synth/rng.mjs';
import { seedDocs, bulkBody, SEED_INDICES } from '../../scripts/synth/context.mjs';
import { sloOwned } from '../../scripts/synth/scenarios/kibana-features.mjs';
import { RISK } from '../../scripts/lib/panels.mjs';
import { parseStream } from '../../scripts/lib/env.mjs';

const RISK_WEIGHTS = [0, 10, 25, 30, 35, 40, 45, 50];

test('scenario registry meets the contract', () => {
  assert.doesNotThrow(() => validate());
  assert.ok(SCENARIOS.length >= 25, `only ${SCENARIOS.length} scenarios`);
});

test('validate() rejects contract violations', () => {
  const ok = { id: 'g.a', title: 't', personas: ['sre'], weights: [0], cadenceMin: 1, run() {}, expect() {} };
  assert.doesNotThrow(() => validate([ok]));
  assert.throws(() => validate([ok, { ...ok }]), /duplicate id/);
  assert.throws(() => validate([{ ...ok, id: 'nogroup' }]), /group\.name/);
  assert.throws(() => validate([{ ...ok, personas: ['ghost'] }]), /unknown persona/);
  assert.throws(() => validate([{ ...ok, weights: [7] }]), /RISK weights/);
  assert.throws(() => validate([{ ...ok, cadenceMin: 0 }]), /cadenceMin/);
  assert.throws(() => validate([{ ...ok, run: undefined }]), /run\(\)/);
});

test('every RISK weight is produced by at least one scenario', () => {
  const covered = new Set(SCENARIOS.flatMap((s) => s.weights));
  assert.deepEqual(RISK_WEIGHTS.filter((w) => !covered.has(w)), []);
});

test('every RISK weight literal in panels.mjs is a weight the generator knows', () => {
  const inScorer = [...RISK.matchAll(/,\s*(\d+),/g)].map((m) => Number(m[1]));
  const last = Number(/,\s*(\d+)\)$/.exec(RISK)[1]);
  for (const w of [...inScorer, last]) assert.ok(RISK_WEIGHTS.includes(w), `scorer weight ${w} unknown to the generator`);
});

test('every persona is exercised, and every scenario that creates things can clean them up', () => {
  const used = new Set(SCENARIOS.flatMap((s) => s.personas));
  for (const id of Object.keys(PERSONAS)) assert.ok(used.has(id), `persona ${id} is never used`);
  const creators = SCENARIOS.filter((s) => /create|lifecycle|admin|owner|workflow|connector|maintenance|tag|dataView|dashboard|crossSpace|slo|agent/i.test(s.id));
  for (const s of creators) assert.equal(typeof s.cleanup, 'function', `${s.id} creates resources but has no cleanup()`);
});

test('select() picks by id or group prefix and rejects unknown ids', () => {
  assert.ok(select('es').every((s) => s.id.startsWith('es.')));
  assert.equal(select('kibanaFeatures.slo').length, 1);
  assert.throws(() => select('nope'), /unknown scenario/);
});

test('personas are prefixed, least-privileged where intended', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    assert.ok(p.name.startsWith(PREFIX), `${id} not prefixed`);
    assert.ok(!(p.role.cluster || []).includes('all'), `${id} has cluster:all`);
    assert.ok(!(p.role.cluster || []).includes('manage'), `${id} has cluster:manage`);
  }
  const securityAdmins = Object.entries(PERSONAS).filter(([, p]) => (p.role.cluster || []).includes('manage_security')).map(([id]) => id);
  assert.deepEqual(securityAdmins, ['secadmin']);
  const contractorIdx = PERSONAS.contractor.role.indices.flatMap((i) => i.privileges);
  assert.deepEqual(contractorIdx, ['read']);
  assert.ok(newHire('syn-20260101-000000-1').name.startsWith(PREFIX));
  for (const s of SPACES) assert.ok(s.startsWith(PREFIX));
});

test('assertOwned() is the gate for every destructive call', () => {
  assert.equal(assertOwned('syn-orders'), 'syn-orders');
  for (const bad of ['orders', 'syn-', 'syn-*', 'syn-a,b', 'syn- x', '', null, undefined, '.kibana', 'logs-syn-x', 'syn-?']) {
    assert.throws(() => assertOwned(bad), /refusing/, `accepted ${bad}`);
  }
});

test('sloOwned() accepts only artifacts of syn-slo SLOs', () => {
  assert.ok(sloOwned('slo-syn-slo-20261014-1-1'));
  assert.ok(sloOwned('slo-summary-syn-slo-x-2'));
  assert.ok(sloOwned('.slo-observability.sli.pipeline-syn-slo-x-1'));
  assert.ok(sloOwned('slo-syn-slo-abc-1', 'syn-slo-abc'));
  assert.ok(!sloOwned('slo-syn-slo-abc-1', 'syn-slo-other'));
  for (const bad of ['slo-prod-latency-1', 'slo-syn-slo-x', 'syn-slo-x-1', 'slo-summary-checkout-1']) assert.ok(!sloOwned(bad), bad);
});

test('judge(): lower bound, upper bound and exact risk', () => {
  assert.equal(judge({ min: 1 }, [{ n: 1, risk: 0 }]).pass, true);
  assert.equal(judge({ min: 2 }, [{ n: 1, risk: 0 }]).pass, false);
  assert.equal(judge({ min: 0, max: 0 }, []).pass, true);
  assert.equal(judge({ min: 0, max: 0 }, [{ n: 1, risk: 0 }]).pass, false);
  assert.equal(judge({ risk: 45 }, [{ n: 2, risk: 45 }]).pass, true);
  assert.match(judge({ risk: 45 }, [{ n: 1, risk: 45 }, { n: 1, risk: 50 }]).error, /scored 45\/50 not 45/);
  assert.equal(judge({ risk: 0 }, []).pass, false, 'a risk claim over no events must not pass by default');
  assert.equal(judge({ risk: 0, min: 0 }, []).pass, true, 'unless the expectation allows zero');
});

test('buildQuery(): ES expectations are scoped to the scenario opaque id, Kibana ones are not', () => {
  const win = { from: '2026-10-14T00:00:00Z', to: '2026-10-14T01:00:00Z', runId: 'syn-R', scenario: 'es.x' };
  const esq = buildQuery({ source: 'es', persona: 'sre', where: 'true' }, win);
  assert.match(esq, /MV_FIRST\(`attributes\.http\.request\.header\.x-opaque-id`\) LIKE "syn-R\/es\.x\/\*"/);
  assert.match(esq, new RegExp(`${F.keyName.replace(/\./g, '\\.')} == "${PERSONAS.sre.name}"`));
  assert.match(esq, new RegExp(`"${SOURCE.es}"`));
  assert.ok(esq.includes(RISK), 'must score with the dashboards\' own RISK');
  assert.ok(!buildQuery({ source: 'es', unscoped: true, where: 'true' }, win).includes('x-opaque-id'));
  assert.ok(!buildQuery({ source: 'kb', where: 'true' }, win).includes('x-opaque-id'));
  assert.throws(() => buildQuery({ persona: 'ghost', where: 'true' }, win), /unknown persona/);
});

test('every scenario expectation builds a query over mapped-style paths only', () => {
  const facts = new Proxy({}, { get: (_t, k) => (k === 'skipped' || k === 'refused' ? undefined : `syn-fact-${String(k)}`) });
  for (const s of SCENARIOS) {
    let exps;
    try { exps = s.expect(facts, { runId: 'syn-R' }) || []; } catch { continue; } // shape-specific facts
    for (const e of exps) {
      assert.equal(typeof e.name, 'string', `${s.id}: expectation without name`);
      assert.equal(typeof e.where, 'string', `${s.id}/${e.name}: where must be a string`);
      assert.ok(!/attributes\.user\.email|kibana\.session\.id/.test(e.where), `${s.id}/${e.name}: references a field the stream does not map`);
      if (e.kind) assert.ok(['must', 'finding'].includes(e.kind), `${s.id}/${e.name}: bad kind`);
    }
  }
});

test('lit() escapes quotes and backslashes for ES|QL', () => {
  assert.equal(lit('a"b\\c'), '"a\\"b\\\\c"');
});

test('referencedFields() sees the dashboards\' field vocabulary', () => {
  const r = referencedFields();
  for (const f of ['attributes.event.action', 'resource.attributes.service.name', 'attributes.elasticsearch.audit.action']) assert.ok(r.includes(f), f);
});

test('matches(): expectation classes', () => {
  assert.ok(matches('ok', 204) && !matches('ok', 403));
  assert.ok(matches('denied', 401) && matches('denied', 403) && !matches('denied', 404));
  assert.ok(matches('absent', 410) && matches([200, 409], 409) && matches('any', 500));
});

function fakeFetch(statuses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return { status, text: async () => JSON.stringify({ status }) };
  };
  fn.calls = calls;
  return fn;
}

test('client: headers, opaque id, Kibana space path, ledger without secrets', async () => {
  process.env.EC_URL ??= 'https://es.example'; process.env.KB_URL ??= 'https://kb.example';
  const f = fakeFetch([200]);
  const ledger = new Ledger('syn-R', { persist: false });
  const c = makeClient({ persona: 'syn-p', key: 'SECRETKEY', runId: 'syn-R', scenario: 'g.s', ledger, fetchImpl: f });
  await c.kb('POST', '/api/x', { a: 1 }, { space: 'syn-finance' });
  await c.es('GET', '/');
  const [kbCall, esCall] = f.calls;
  assert.match(kbCall.url, /\/s\/syn-finance\/api\/x$/);
  assert.equal(kbCall.init.headers['kbn-xsrf'], 'true');
  assert.equal(kbCall.init.headers['X-Opaque-Id'], 'syn-R/g.s/1');
  assert.equal(esCall.init.headers['X-Opaque-Id'], 'syn-R/g.s/2');
  assert.equal(esCall.init.headers.Authorization, 'ApiKey SECRETKEY');
  assert.ok(!JSON.stringify(ledger.entries).includes('SECRETKEY'), 'ledger leaked the key');
  assert.equal(ledger.entries.length, 2);
});

test('client: retries transient 5xx/429, never a status the call was meant to provoke', async () => {
  const flaky = fakeFetch([503, 503, 200]);
  const c = makeClient({ persona: 'p', key: 'k', runId: 'r', scenario: 's', fetchImpl: flaky, retries: 3 });
  const r = await c.es('GET', '/');
  assert.equal(r.status, 200); assert.equal(flaky.calls.length, 3);

  const denied = fakeFetch([403, 200]);
  const d = makeClient({ persona: 'p', key: 'k', runId: 'r', scenario: 's', fetchImpl: denied });
  const r2 = await d.es('DELETE', '/syn-orders', null, { expect: 'denied' });
  assert.equal(r2.status, 403); assert.equal(r2.ok, true); assert.equal(denied.calls.length, 1);

  const meant = fakeFetch([429, 200]);
  const m = makeClient({ persona: 'p', key: 'k', runId: 'r', scenario: 's', fetchImpl: meant });
  assert.equal((await m.es('GET', '/', null, { expect: [429] })).status, 429);
  assert.equal(meant.calls.length, 1);
});

test('client: an unexpected status is recorded as a generator error', async () => {
  const ledger = new Ledger('syn-R', { persist: false });
  const c = makeClient({ persona: 'p', key: 'k', runId: 'syn-R', scenario: 's', ledger, fetchImpl: fakeFetch([403]) });
  const r = await c.es('GET', '/');
  assert.equal(r.ok, false);
  assert.equal(ledger.unexpected().length, 1);
});

test('rng is deterministic per seed', () => {
  const a = rng('seed'), b = rng('seed'), c = rng('other');
  const xs = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, () => c.next()));
  const s = rng(1).shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual([...s].sort(), [1, 2, 3, 4, 5]);
});

test('seed data is reproducible and the bulk body is valid NDJSON', () => {
  for (const idx of SEED_INDICES) {
    assert.ok(idx.startsWith(PREFIX));
    const a = seedDocs(idx, rng('x'), 20), b = seedDocs(idx, rng('x'), 20);
    assert.deepEqual(a, b);
    const lines = bulkBody(idx, a).trim().split('\n');
    assert.equal(lines.length, 40);
    for (const l of lines) JSON.parse(l);
    assert.equal(JSON.parse(lines[0]).index._index, idx);
  }
});

test('parseStream() derives dataset and namespace, and rejects non-logs names', () => {
  assert.deepEqual(parseStream('logs-elastic_cloud.serverless_audit.otel-default'),
    { dataset: 'elastic_cloud.serverless_audit.otel', namespace: 'default' });
  assert.deepEqual(parseStream('logs-serverless.audit.otel-elastic_cloud'),
    { dataset: 'serverless.audit.otel', namespace: 'elastic_cloud' });
  assert.throws(() => parseStream('metrics-x'), /not a logs-/);
});
