/**
 * The audit-stream field map the generator's assertions are written against.
 *
 * Every assertion names a logical field (F.action), never a path, so a schema change is an edit
 * here and nowhere else. `drift()` reads the live mapping and reports every path in this map —
 * and every field the dashboards reference — that the stream no longer has. That is the check to
 * run first when the stream's shape is in doubt: a renamed field does not fail an ES|QL query that
 * filters on it, it just matches nothing, and an empty panel looks exactly like a quiet hour.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from '../lib/env.mjs';
import { es } from '../lib/http.mjs';

export const STREAM = cfg.dataStream;

/** The stream name verified against live data; the schema-contract test pins the dashboards to it. */
export { DEFAULT_STREAM as VERIFIED_STREAM } from '../lib/env.mjs';

export const F = {
  source:    'service.name',
  action:    'event.action',
  outcome:   'event.outcome',
  evtype:    'event.type',
  category:  'event.category',
  esAction:  'elasticsearch.audit.action',
  reqName:   'elasticsearch.audit.request.name',
  indices:   'elasticsearch.audit.indices',
  secChange: 'elasticsearch.audit.security_config_change',
  keyName:   'api_key.name',
  keyId:     'api_key.id',
  email:     'user.email',
  userName:  'user.name',
  domain:    'user.domain',
  authType:  'authentication.type',
  soType:    'kibana.saved_object.type',
  soId:      'kibana.saved_object.id',
  soName:    'kibana.saved_object.name',
  space:     'kibana.space.id',
  msg:       'body.text',
  urlPath:   'url.path',
  urlOrig:   'url.original',
  /** Hyphenated, so it must be backtick-quoted to parse in ES|QL. */
  opaqueId:  '`http.request.header.x-opaque-id`',
  projectId: 'project.id',
  fwdIp:     'network.forwarded_ip',
  clientIp:  'client.ip',
};

/** Source names as the stream records them. Elasticsearch's was `elasticsearch-serverless` before the rename. */
export const SOURCE = { es: 'serverless-elasticsearch', kb: 'serverless-kibana' };

/** ES|QL string literal. Assertions interpolate ids and names the generator chose, never user input. */
export const lit = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Roots of every field path the dashboard sources reference. Queries name ECS fields bare
 * (`event.action`, `service.name`): the stream maps `attributes` and `resource.attributes` as
 * passthrough objects, so the bare name resolves to the stored `attributes.event.action`.
 */
const ROOTS = ['event', 'elasticsearch', 'user', 'api_key', 'kibana', 'authentication', 'url', 'source',
  'project', 'network', 'http', 'service', 'client', 'body'];

/** Same roots, not fields: Vega's event object and a Vega data source's `url` request. */
const NOT_FIELDS = new Set(['event.shiftKey', 'url.body', 'url.index']);

/** Every field path under ROOTS that the dashboard sources reference. */
export function referencedFields() {
  const files = [
    join(ROOT, 'scripts', 'lib', 'panels.mjs'),
    ...readdirSync(join(ROOT, 'scripts', 'lib', 'dashboards')).map((f) => join(ROOT, 'scripts', 'lib', 'dashboards', f)),
    ...['vega', 'searches', 'esql'].flatMap((d) => readdirSync(join(ROOT, d)).map((f) => join(ROOT, d, f))),
  ];
  const seen = new Set();
  const re = new RegExp(`(?<![\\w.$-])((?:${ROOTS.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])`, 'g');
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(re)) seen.add(m[1]);
  return [...seen].filter((p) => !NOT_FIELDS.has(p)).sort();
}

/**
 * Field paths whose replacement has been confirmed on live data. A drift report names the
 * replacement instead of calling the old path missing; add to this as renames are confirmed.
 */
export const RENAMES = {};

/** Value-level renames: same field, different literal. Checked against what the stream holds. */
export const VALUE_RENAMES = [
  { field: F.source, was: 'elasticsearch-serverless', now: SOURCE.es },
];

const unquote = (p) => p.replace(/`/g, '');

/** Passthrough objects in the stream's mapping, highest priority first (resource 40, scope 30, attributes 20). */
const PASSTHROUGH = ['resource.attributes', 'scope.attributes', 'attributes'];

/**
 * Pure classification, separated from the I/O so every status is unit-testable.
 * queryable: Set of mapped leaf paths; emitted: Map(path -> doc count) from _source; wanted: paths.
 */
export function classify({ queryable, emitted, wanted }) {
  const everything = new Set([...queryable, ...emitted.keys()]);
  const leaf = (p) => p.split('.').slice(-2).join('.');
  // A bare ECS name and its stored passthrough path are one field, not a rename candidate.
  const twins = (p) => [p, ...PASSTHROUGH.map((r) => `${r}.${p}`)];
  const isEmitted = (p) => twins(p).some((t) => emitted.has(t));
  const sameField = (a, b) => twins(a).includes(b) || twins(b).includes(a);
  const isParent = (p) => [...queryable].some((q) => q.startsWith(`${p}.`));
  // A geo_point is stored as {lat, lon}: its leaves are covered by the mapped point itself.
  const underLeaf = (p) => [...queryable].some((q) => p.startsWith(`${q}.`));
  const fields = [...wanted].sort().filter((p) => !isParent(p)).map((path) => {
    if (queryable.has(path)) return { path, status: isEmitted(path) ? 'mapped' : 'mapped-empty' };
    if (RENAMES[path]) return { path, status: 'renamed', to: RENAMES[path] };
    if (emitted.has(path)) return { path, status: 'unmapped', docs: emitted.get(path) };
    const candidates = [...everything].filter((q) => !sameField(q, path) && leaf(q) === leaf(path));
    if (candidates.length) return { path, status: 'candidate', candidates };
    return { path, status: 'not-observed' };
  });
  const unmapped = [...emitted.keys()].filter((p) => !queryable.has(p) && !isParent(p) && !underLeaf(p)).sort();
  return { fields, unmapped };
}

/**
 * Where a field went, if anywhere. Absence from field_caps is never taken as "removed" on its own:
 *
 *   mapped           queryable at the referenced path, and populated in the sample
 *   mapped-empty     in the mapping but no sampled document carries a value — queries run and see
 *                    null. field_caps HIDES these unless include_empty_fields=true, which is how an
 *                    earlier version of this check wrongly reported user.email as gone
 *   renamed          a confirmed replacement in RENAMES
 *   candidate        same leaf name at another queryable or emitted path — likely moved; confirm it
 *   unmapped         present in _source but not mapped (the stream is dynamic:false), so every
 *                    ES|QL query naming it fails with "Unknown column" — fixable with a mapping
 *   not-observed     neither mapped nor emitted in the sample. Not proof of removal: many fields
 *                    only appear on particular event kinds (an email needs a human SSO login)
 *
 * The document sample is walked in full, so emitted-but-unmapped keys are found even when the
 * mapping has never heard of them.
 */
export async function drift({ sample = 5000 } = {}) {
  const caps = await es.raw(`/${STREAM}/_field_caps?fields=*&include_empty_fields=true`);
  if (!caps.ok) return { ok: false, error: `field_caps ${caps.status}`, fields: [], unmapped: [] };
  const queryable = new Set(Object.entries(caps.body.fields || {})
    .filter(([, t]) => !('object' in t) && !('nested' in t)).map(([k]) => k));
  // A RANDOM sample across a week, not the newest N: during a generator run the newest documents are
  // almost all synthetic API-key traffic, which carries no email or session — so a recency sample once
  // hid fields that human SSO events were populating the whole time.
  const docs = await es.raw(`/${STREAM}/_search`, {
    method: 'POST', body: { size: sample, query: { function_score: {
      query: { range: { '@timestamp': { gte: 'now-7d' } } }, random_score: {}, boost_mode: 'replace' } } },
  });
  const emitted = new Map();
  const walk = (o, p) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
    else if (p) emitted.set(p, (emitted.get(p) || 0) + 1);
  };
  for (const h of docs.body?.hits?.hits || []) walk(h._source, '');

  const { fields, unmapped } = classify({ queryable, emitted, wanted: [...new Set([...Object.values(F).map(unquote), ...referencedFields()])] });

  const values = [];
  for (const v of VALUE_RENAMES) {
    const r = await es.esqlRun(`FROM ${STREAM} | STATS n = COUNT(*) BY v = ${v.field} | WHERE v IN (${lit(v.was)}, ${lit(v.now)})`);
    const seen = Object.fromEntries((r.body?.values || []).map(([n, val]) => [val, n]));
    values.push({ ...v, wasCount: seen[v.was] || 0, nowCount: seen[v.now] || 0 });
  }

  const blocking = fields.filter((f) => f.status === 'unmapped' || f.status === 'candidate' || f.status === 'renamed');
  return { ok: !blocking.length && !unmapped.length, fields, values, unmapped,
           queryableCount: queryable.size, sampled: docs.body?.hits?.hits?.length || 0 };
}
