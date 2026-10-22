/**
 * The verifier's control flow, the drift classifier and run-scoped cleanup — all without a cluster.
 * The evaluator, clock and sleep are injected so poll/settle timing is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../../scripts/synth/verify.mjs';
import { classify } from '../../scripts/synth/fields.mjs';
import { teardown, runTag } from '../../scripts/synth/context.mjs';
import { assertOwned } from '../../scripts/synth/personas.mjs';
import { redact, makeClient } from '../../scripts/synth/client.mjs';
import esData from '../../scripts/synth/scenarios/es-data.mjs';
import security from '../../scripts/synth/scenarios/security.mjs';

// The client builds URLs from cfg; unit tests never reach them (fetch is faked).
process.env.EC_URL ??= 'https://es.invalid'; process.env.KB_URL ??= 'https://kb.invalid';

const scenario = (expect) => ({ id: 'g.s', title: 't', facts: {}, expect: () => expect });
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

/** An evaluator that answers from a script: calls[i] for the i-th evaluation of an expectation. */
function scripted(answers) {
  const seen = new Map();
  return async (exp) => {
    const i = seen.get(exp.name) || 0; seen.set(exp.name, i + 1);
    const a = answers[exp.name][Math.min(i, answers[exp.name].length - 1)];
    return { ...exp, ...a };
  };
}

test('verify: polls until a late event satisfies an expectation', async () => {
  const c = clock();
  const [r] = await verify([scenario([{ name: 'late', where: 'x' }])], {
    runId: 'r', from: 'f', timeoutMs: 120e3, pollMs: 20e3, settleMs: 0, ...c,
    evaluateFn: scripted({ late: [{ pass: false, n: 0 }, { pass: false, n: 0 }, { pass: true, n: 1 }] }),
  });
  assert.equal(r.pass, true);
});

test('verify: a scoring event arriving during the settle window turns a pass into a fail', async () => {
  const c = clock();
  const [r] = await verify([scenario([{ name: 'zero', where: 'x', risk: 0 }])], {
    runId: 'r', from: 'f', timeoutMs: 60e3, settleMs: 45e3, ...c,
    evaluateFn: scripted({ zero: [{ pass: true, n: 3, risks: [0] }, { pass: false, n: 4, risks: [0, 40], error: 'scored 0/40 not 0' }] }),
  });
  assert.equal(r.pass, false);
  assert.equal(r.expectations[0].settled, true);
});

test('verify: a settle re-check that cannot run keeps the earlier verdict and says so', async () => {
  const c = clock();
  const [r] = await verify([scenario([{ name: 'zero', where: 'x', risk: 0 }])], {
    runId: 'r', from: 'f', timeoutMs: 60e3, settleMs: 45e3, ...c,
    evaluateFn: scripted({ zero: [{ pass: true, n: 3 }, { pass: false, queryFailed: true, error: 'transport: reset' }] }),
  });
  assert.equal(r.pass, true);
  assert.match(r.expectations[0].settleError, /transport/);
});

test('verify: stops at the deadline even when every evaluation is slow', async () => {
  const c = clock();
  let calls = 0;
  const slow = async (exp) => { calls++; await c.sleep(50e3); return { ...exp, pass: false, n: 0 }; };
  const exps = Array.from({ length: 10 }, (_, i) => ({ name: `e${i}`, where: 'x' }));
  const [r] = await verify([scenario(exps)], { runId: 'r', from: 'f', timeoutMs: 120e3, settleMs: 0, evaluateFn: slow, ...c });
  assert.equal(r.pass, false);
  assert.ok(calls <= 3, `ran ${calls} evaluations against a 120s budget of 50s each`);
});

test('verify: generator errors fail a scenario whose expectations all passed', async () => {
  const ledger = { forScenario: () => [{ ok: false, method: 'GET', path: '/', status: 500 }] };
  const [r] = await verify([scenario([{ name: 'a', where: 'x' }])], {
    runId: 'r', from: 'f', ledger, timeoutMs: 60e3, settleMs: 0, ...clock(), evaluateFn: async (e) => ({ ...e, pass: true, n: 1 }),
  });
  assert.equal(r.pass, false);
});

test('verify: rejects a non-numeric timeout instead of polling forever', async () => {
  await assert.rejects(() => verify([], { timeoutMs: NaN }), /timeoutMs/);
});

test('classify(): every drift status', () => {
  const queryable = new Set(['attributes.user.email', 'attributes.user.name', 'client.geo.location', 'user.id']);
  const emitted = new Map([['attributes.user.name', 5], ['attributes.secret.thing', 2], ['client.geo.location.lat', 3], ['attributes.user.id', 1]]);
  const wanted = ['attributes.user.email', 'attributes.user.name', 'attributes.secret.thing', 'attributes.user.id', 'attributes.gone.away', 'client.geo'];
  const { fields, unmapped } = classify({ queryable, emitted, wanted });
  const st = Object.fromEntries(fields.map((f) => [f.path, f.status]));
  assert.equal(st['attributes.user.email'], 'mapped-empty');
  assert.equal(st['attributes.user.name'], 'mapped');
  assert.equal(st['attributes.secret.thing'], 'unmapped');
  assert.equal(st['attributes.user.id'], 'unmapped', 'emitted at this path but mapped only elsewhere');
  assert.equal(st['attributes.gone.away'], 'not-observed');
  assert.ok(!('client.geo' in st), 'a parent of mapped fields is not itself a field');
  assert.deepEqual(unmapped, ['attributes.secret.thing', 'attributes.user.id'], 'geo_point lat/lon is covered by the mapped point');
});

test('classify(): a field present only under another path is reported as a move candidate', () => {
  const { fields } = classify({ queryable: new Set(['client.user.email']), emitted: new Map(), wanted: ['user.email'] });
  assert.equal(fields[0].status, 'candidate');
  assert.deepEqual(fields[0].candidates, ['client.user.email']);
});

test('classify(): a bare ECS name and its stored passthrough path are one field', () => {
  // field_caps lists both forms; _source stores the literal keys under attributes / resource.attributes.
  const queryable = new Set(['user.email', 'attributes.user.email', 'service.name', 'resource.attributes.service.name', 'api_key.name']);
  const emitted = new Map([['attributes.user.email', 4], ['resource.attributes.service.name', 9]]);
  const { fields } = classify({ queryable, emitted, wanted: ['user.email', 'service.name', 'api_key.name'] });
  const st = Object.fromEntries(fields.map((f) => [f.path, f.status]));
  assert.deepEqual(st, { 'api_key.name': 'mapped-empty', 'service.name': 'mapped', 'user.email': 'mapped' });
});

test('teardown(runIds): deletes only what names this run, never another run\'s resources', async () => {
  const A = 'syn-20261014-120000-1111', B = 'syn-20261014-120500-2222';
  const done = [];
  const fake = { id: 'g.fake', cleanup: async ({ act }) => {
    for (const run of [A, B]) await act(`thing syn-x-${runTag(run)}`, async () => { done.push(run); return { ok: true }; });
    await act('batch of 3 syn-* things', async () => { done.push('batch'); return { ok: true }; });
  } };
  const res = await teardown({ scenarios: [fake], runIds: [A], clients: {} });
  assert.deepEqual(done, [A]);
  assert.equal(res.skipped.length, 2);
});

test('teardown: a failed delete is reported, a 404 counts as already gone', async () => {
  const fake = { id: 'g.fake', cleanup: async ({ act }) => {
    await act('a syn-x', async () => ({ ok: false, status: 500 }));
    await act('b syn-y', async () => ({ ok: false, status: 404 }));
    await act('c syn-z', async () => { throw new Error('boom'); });
  } };
  const res = await teardown({ scenarios: [fake], scoped: true, clients: {} });
  assert.deepEqual(res.removed, ['b syn-y']);
  assert.equal(res.failed.length, 2);
});

/** A fake ES whose listings contain two runs' resources; records every mutating call. */
function fakeEs(runs) {
  const writes = [];
  return {
    writes,
    raw: async (path, opts = {}) => {
      const body = opts.body;
      if ((opts.method || 'GET') !== 'GET' && !path.includes('_count') && !path.startsWith('/_security/_query') && !path.startsWith('/_resolve')) writes.push({ path, body });
      if (path.startsWith('/_security/_query/api_key')) {
        const prefix = body.query.bool.must[0].prefix.name;
        return { ok: true, body: { api_keys: runs.map((r) => ({ id: `id-${r}`, name: `syn-child-${runTag(r)}-1`, metadata: { synthetic: true } })).filter((k) => k.name.startsWith(prefix)) } };
      }
      if (path.includes('/_count')) return { ok: true, body: { count: 1 } };
      if (path.startsWith('/_security/role')) return { ok: true, body: Object.fromEntries(runs.map((r) => [`syn-role-${runTag(r)}`, {}])) };
      if (path.startsWith('/_resolve/index')) return { ok: true, body: { indices: runs.map((r) => ({ name: `syn-tmp-${runTag(r)}-1` })) } };
      return { ok: true, status: 200, body: {} };
    },
  };
}

test('module cleanups, run-scoped: ES and security sweeps never touch the other run', async () => {
  const A = 'syn-20261014-120000-1111', B = 'syn-20261014-120500-2222';
  const es = fakeEs([A, B]);
  await teardown({ scenarios: [...esData, ...security], runIds: [A], clients: { es, kb: es } });
  const touched = JSON.stringify(es.writes);
  assert.ok(es.writes.length > 0, 'nothing was cleaned for run A');
  assert.ok(!touched.includes(runTag(B)), `run B was touched: ${touched}`);
});

test('assertOwned() guards every delete label path used by the fake sweep', () => {
  assert.throws(() => assertOwned('prod-index'));
});

test('redact(): credentials never survive into logs or the ledger', () => {
  const r = redact({ id: 'x', api_key: 'S1', encoded: 'S2', nested: [{ token: 'S3', password: 'S4', ok: 1 }] });
  assert.ok(!JSON.stringify(r).match(/S[1-4]/));
  assert.equal(r.nested[0].ok, 1);
});

function fakeFetch(statuses, { throwFirst = false } = {}) {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    if (throwFirst && calls.length === 1) throw new Error('socket hang up');
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return { status, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

test('client retry policy: POST is never resent after a possible side effect; 429 always retried', async () => {
  const mk = (f) => makeClient({ persona: 'p', key: 'k', runId: 'r', scenario: 's', fetchImpl: f, retries: 2 });
  const post503 = fakeFetch([503, 200]);
  assert.equal((await mk(post503).es('POST', '/x', {})).status, 503);
  assert.equal(post503.calls.length, 1);
  const postReset = fakeFetch([200], { throwFirst: true });
  assert.equal((await mk(postReset).es('POST', '/x', {})).status, 0);
  assert.equal(postReset.calls.length, 1);
  const post429 = fakeFetch([429, 200]);
  assert.equal((await mk(post429).es('POST', '/x', {})).status, 200);
  const get503 = fakeFetch([503, 200]);
  assert.equal((await mk(get503).es('GET', '/x')).status, 200);
  const optIn = fakeFetch([502, 200]);
  assert.equal((await mk(optIn).es('POST', '/x', {}, { idempotent: true })).status, 200);
});

test('client: loop-mode opaque ids carry the round so they never repeat', async () => {
  const seen = [];
  const f = async (_u, init) => { seen.push(init.headers['X-Opaque-Id']); return { status: 200, text: async () => '{}' }; };
  const seq = { n: 0, round: 7 };
  const c = makeClient({ persona: 'p', key: 'k', runId: 'syn-R', scenario: 'g.s', fetchImpl: f, seq });
  await c.es('GET', '/'); await c.es('GET', '/');
  assert.deepEqual(seen, ['syn-R/g.s/7.1', 'syn-R/g.s/7.2']);
});
