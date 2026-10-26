/**
 * --clean against stubbed Kibana and Elasticsearch: a private copy (AUDIT_ID_NS) never reaches the ingest
 * pipeline and templates, which have no namespace and serve production too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUDIT_ID_NS = 'r999';
const { kb, es } = await import('../../scripts/lib/http.mjs');
const { run } = await import('../../scripts/clean.mjs');

async function stubbed(fn) {
  const calls = [];
  const was = { sRaw: kb.sRaw, deleteObject: kb.deleteObject, raw: es.raw, log: console.log };
  kb.sRaw = async (path, { method } = {}) => { calls.push(`kb ${method} ${path}`); return { ok: false, status: 404, body: {} }; };
  kb.deleteObject = async (type, id) => { calls.push(`kb DELETE ${type} ${id}`); return 404; };
  es.raw = async (path, { method = 'GET' } = {}) => { calls.push(`es ${method} ${path}`); return { ok: false, status: 404, body: {} }; };
  console.log = () => {};
  try { return await fn(calls); } finally {
    kb.sRaw = was.sRaw; kb.deleteObject = was.deleteObject; es.raw = was.raw; console.log = was.log;
  }
}

const SHARED = /_index_template|_component_template|_ingest\/pipeline|\/_settings/;

test('--clean ingest under AUDIT_ID_NS refuses and touches nothing', async () => {
  await stubbed(async (calls) => {
    await assert.rejects(run(['ingest']), /shared with production/);
    assert.deepEqual(calls, []);
  });
});

test('--clean all under AUDIT_ID_NS removes the private copy and leaves ingest alone', async () => {
  await stubbed(async (calls) => {
    await run(['all']);
    assert.ok(calls.length > 0, 'the private copy is cleaned');
    assert.deepEqual(calls.filter((c) => SHARED.test(c)), [], 'no call reaches the shared pipeline or templates');
    const views = calls.filter((c) => c.includes('/_query/view/'));
    assert.ok(views.length > 0 && views.every((c) => c.includes('r999')), 'only the private view is deleted');
  });
});
