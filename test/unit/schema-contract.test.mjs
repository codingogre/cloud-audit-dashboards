/**
 * Static schema contract: the dashboards must target the stream and source names verified against
 * live data. No network. These turn a platform rename into a red build instead of a dashboard that
 * quietly shows zero.
 *
 * The expected stream is AUDIT_STREAM when set (.env is read as ./audit reads it) and otherwise the
 * pinned VERIFIED_STREAM — never the code's own default, which would make the check compare the
 * dashboards with themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseStream } from '../../scripts/lib/env.mjs';
import { SOURCE, VALUE_RENAMES, VERIFIED_STREAM } from '../../scripts/synth/fields.mjs';
import { IDX } from '../../scripts/lib/panels.mjs';

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const EXPECTED = process.env.AUDIT_STREAM || VERIFIED_STREAM;
const { dataset } = parseStream(EXPECTED);

const rel = (f) => f.replace(`${ROOT}/`, '');
const sources = () => [
  join(ROOT, 'scripts', 'lib', 'panels.mjs'),
  join(ROOT, 'scripts', 'lib', 'controls.mjs'),
  join(ROOT, 'scripts', 'demo-guide.mjs'),
  ...readdirSync(join(ROOT, 'scripts', 'lib', 'dashboards')).map((f) => join(ROOT, 'scripts', 'lib', 'dashboards', f)),
  ...['vega', 'searches'].flatMap((d) => readdirSync(join(ROOT, d)).map((f) => join(ROOT, d, f))),
  join(ROOT, 'esql', 'fragments.md'),
].filter(existsSync);

/** Every audit-stream-looking literal: data stream names and the @custom/@template hooks derived from them. */
export function streamLiterals(text) {
  return [...text.matchAll(/logs-[a-z0-9_.]*audit[a-z0-9_.]*(?:-[a-z0-9_]+|@custom|@template)/g)].map((m) => m[0]);
}

/** Every quoted literal shaped like an audit source name, in any syntax: ==, !=, IN (...), JSON, DSL. */
export function sourceLiterals(text) {
  return [...text.matchAll(/\\?"((?:serverless-(?:elasticsearch|kibana)|(?:elasticsearch|kibana)-serverless))\\?"/g)].map((m) => m[1]);
}

test('self-test: the literal scanners see every syntax a dashboard can use', () => {
  const sample = String.raw`a == "elasticsearch-serverless" | b != "serverless-kibana" | IN ("serverless-elasticsearch", "kibana-serverless")
    {"term":{"resource.attributes.service.name":"elasticsearch-serverless"}} \"serverless-kibana\"
    FROM logs-serverless.audit.otel-elastic_cloud | logs-elastic_cloud.serverless_audit.otel@custom`;
  assert.deepEqual(sourceLiterals(sample), ['elasticsearch-serverless', 'serverless-kibana', 'serverless-elasticsearch', 'kibana-serverless', 'elasticsearch-serverless', 'serverless-kibana']);
  assert.deepEqual(streamLiterals(sample), ['logs-serverless.audit.otel-elastic_cloud', 'logs-elastic_cloud.serverless_audit.otel@custom']);
});

test('ingest assets are parameterised, and the dataset guard is where the placeholder renders', () => {
  const raw = readFileSync(join(ROOT, 'ingest', 'audit@custom.pipeline.json'), 'utf8');
  const component = readFileSync(join(ROOT, 'ingest', 'audit@custom.component.json'), 'utf8');
  assert.ok(!/serverless\.audit\.otel|serverless_audit/.test(raw + component), 'hard-coded dataset in ingest assets');
  const rendered = JSON.parse(raw.replaceAll('{{DATASET}}', dataset));
  const guards = rendered.processors.map((p) => Object.values(p)[0].if).filter(Boolean);
  assert.ok(guards.some((g) => g === `ctx.data_stream?.dataset == '${dataset}'`), `no processor is guarded to ${dataset}: ${guards.join(' | ')}`);
  assert.equal(JSON.parse(component.replaceAll('{{PIPELINE}}', `logs-${dataset}@custom`)).template.settings.index.final_pipeline, `logs-${dataset}@custom`);
});

test('dashboards query the expected audit stream', () => {
  assert.equal(IDX, EXPECTED, `panels.mjs IDX is "${IDX}" but the stream is "${EXPECTED}"`);
  const ok = new Set([EXPECTED, `logs-${dataset}@custom`, `logs-${dataset}@template`]);
  const stale = sources().flatMap((f) => streamLiterals(readFileSync(f, 'utf8')).filter((l) => !ok.has(l)).map((l) => `${rel(f)}: ${l}`));
  assert.deepEqual([...new Set(stale)], []);
});

test('dashboards use the source names the stream actually records', () => {
  const known = new Set(Object.values(SOURCE));
  const retired = new Set(VALUE_RENAMES.map((v) => v.was));
  const bad = sources().flatMap((f) => sourceLiterals(readFileSync(f, 'utf8'))
    .filter((v) => !known.has(v) || retired.has(v)).map((v) => `${rel(f)}: "${v}"`));
  assert.deepEqual([...new Set(bad)], []);
});
