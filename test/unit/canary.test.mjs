/**
 * The prior-period canary (scripts/lib/canary.mjs, run by --verify) and the events view's naming (env.mjs). No
 * network: the request and response bodies are shaped like the ones captured from Kibana 9.6 in 1.0.5.1, and the
 * ground-truth query is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeFields, readRequest, readRow, judge, tilesOn, canaryQueries, ESQL_ASYNC } from '../../scripts/lib/canary.mjs';
import { cfg, withStream, DEFAULT_VIEW, DEFAULT_STREAM } from '../../scripts/lib/env.mjs';
import { prevQuery, PREV_TILES, prevEsql } from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';

const RANGE = { bool: { must: [{ bool: { filter: [] } }, { bool: { filter: [{ range: { '@timestamp': { gte: 'a', lte: 'b' } } }] } }] } };

test('the events view is named per namespace, and withStream() rewrites it in the committed specs', () => {
  const was = process.env.AUDIT_ID_NS;
  try {
    delete process.env.AUDIT_ID_NS;
    assert.equal(cfg.view, DEFAULT_VIEW);
    assert.equal(withStream(`FROM ${DEFAULT_VIEW} | LIMIT 1`), `FROM ${DEFAULT_VIEW} | LIMIT 1`);
    process.env.AUDIT_ID_NS = 'x';
    assert.equal(cfg.view, 'cloud-audit-x-events-view');
    assert.equal(withStream(`FROM ${DEFAULT_VIEW} | LIMIT 1`), 'FROM cloud-audit-x-events-view | LIMIT 1');
    assert.ok(!withStream(prevQuery('total-events')).includes(DEFAULT_VIEW));
  } finally { if (was === undefined) delete process.env.AUDIT_ID_NS; else process.env.AUDIT_ID_NS = was; }
});

test('rangeFields() finds a range clause at any depth', () => {
  assert.deepEqual(rangeFields(RANGE), ['@timestamp']);
  assert.deepEqual(rangeFields({ bool: { must: [], filter: [], should: [], must_not: [] } }), []);
  assert.deepEqual(rangeFields(undefined), []);
  assert.deepEqual(rangeFields([{ range: { event_time: {} } }]), ['event_time']);
});

test('readRequest() and readRow() read Kibana esql_async bodies', () => {
  assert.ok(ESQL_ASYNC.test('https://k/internal/search/esql_async'));
  assert.ok(ESQL_ASYNC.test('https://k/internal/search/esql_async/FmV4Y2'));
  assert.ok(!ESQL_ASYNC.test('https://k/internal/search/esql'));
  const r = readRequest(JSON.stringify({ params: { query: 'FROM v | LIMIT 1', filter: RANGE, params: [{ _tstart: 'a' }] } }));
  assert.equal(r.query, 'FROM v | LIMIT 1');
  assert.deepEqual(r.params, [{ _tstart: 'a' }]);
  assert.equal(readRequest('not json'), null);
  assert.equal(readRequest('{}'), null);
  const body = { id: 'x', isRunning: false, rawResponse: { columns: [{ name: 'cur' }, { name: 'prev' }], values: [[3, 2]] } };
  assert.deepEqual(readRow(body), { cur: 3, prev: 2 });
  assert.equal(readRow({ ...body, isRunning: true }), null, 'a running search has no answer yet');
  assert.deepEqual(readRow({ rawResponse: { columns: [{ name: 't0' }], values: [] } }), {});
});

test('tilesOn() finds the prior-period tiles each dashboard places', () => {
  const all = buildAll();
  assert.deepEqual(tilesOn(all['00-command-center']), ['total-events', 'failed-events']);
  assert.deepEqual(tilesOn(all['02-kibana-objects']), ['kibana-events']);
  assert.deepEqual(tilesOn(all['03-data-access']), ['es-events', 'esql-queries', 'access-denied']);
  assert.deepEqual(tilesOn(all['07-actor-360']), []);
  assert.equal(canaryQueries().get(withStream(prevQuery('es-events'))), 'es-events');
});

const S = Date.UTC(2026, 9, 22, 10), E = S + 864e5;
const P = [{ _tstart: new Date(S).toISOString() }, { _tend: new Date(E).toISOString() }, { identity_kind: '' }, { identity: '' }];
const state = ({ ranges = [], prev = 2200, stream = true } = {}) => ({
  requests: [{ key: 'total-events', ranges, params: P }, { key: 'stream', ranges: [], params: [] }],
  rows: [{ key: 'total-events', row: { cur: 9, prev, s: S, e: E }, params: P }, ...(stream ? [{ key: 'stream', row: { t0: S - 9 * 864e5 }, params: [] }] : [])],
  unread: [],
});
const truth = (n) => async (q, params) => {
  assert.equal(q, prevEsql('total-events'));
  assert.equal(params[0]._tstart, new Date(2 * S - E).toISOString(), 'the prior window starts one length before the picker');
  assert.equal(params[1]._tend, new Date(S).toISOString(), 'and ends where the picker starts');
  return { ok: true, body: { values: [[n]] } };
};

test('judge(): a clean page passes, and the report carries both counts', async () => {
  const v = await judge(state(), ['total-events'], { esqlRun: truth(2200) });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.tiles.map((t) => [t.key, t.cur, t.prev, t.priorOnStream]), [['total-events', 9, 2200, 2200]]);
});

test('judge(): fails when the hidden time filter comes back', async () => {
  const v = await judge(state({ ranges: ['@timestamp'] }), ['total-events'], { esqlRun: truth(2200) });
  assert.match(v.problems.join('\n'), /range filter on @timestamp/);
});

test('judge(): fails when prior reads 0 while the picker starts after the stream\'s first event', async () => {
  const v = await judge(state({ prev: 0 }), ['total-events'], { esqlRun: truth(2200) });
  assert.match(v.problems.join('\n'), /prior count reads 0 while the picker starts after the stream's first event/);
  const w = await judge(state({ prev: 0 }), ['total-events'], { esqlRun: truth(0) });
  assert.deepEqual(w.problems, [], 'a prior period that really was empty is not a failure');
  const d = await judge(state({ prev: 7 }), ['total-events'], { esqlRun: truth(8) });
  assert.match(d.problems.join('\n'), /prior count is 7, TIME on the stream counts 8/);
});

test('judge(): fails when a tile on the page sent nothing, or the gate was never read', async () => {
  const v = await judge({ requests: [], rows: [], unread: [] }, ['access-denied'], { esqlRun: truth(0) });
  assert.match(v.problems.join('\n'), /access-denied: the tile sent no request/);
  const g = await judge(state({ stream: false }), ['total-events'], { esqlRun: truth(2200) });
  assert.match(g.problems.join('\n'), /never read/);
  assert.deepEqual((await judge({ requests: [], rows: [], unread: [] }, [])).problems, [], 'a page with no tiles has nothing to check');
});

test('the canary covers every tile', () => {
  const keys = new Set(canaryQueries().values());
  for (const k of Object.keys(PREV_TILES)) assert.ok(keys.has(k), k);
  assert.ok(keys.has('stream'));
  assert.ok(DEFAULT_STREAM);
});
