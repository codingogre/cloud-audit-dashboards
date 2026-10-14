/**
 * Audit-scoped geoip enrichment.
 *
 * Deliberately NOT the global `logs@custom` hook: that fires for every logs-* data stream
 * in the project. Instead a dedicated pipeline is attached as `index.final_pipeline` on the
 * audit data stream only, and a component + index template keep it across rollover.
 *
 * Every name follows cfg.dataStream (AUDIT_STREAM), because Elastic has renamed the stream once
 * already: a pipeline guarded on the old dataset is installed, attached and silently does nothing.
 *
 * The index template is BUILT from the live OTel template rather than copied into the repo. The
 * audit stream is created by `logs-otel@template` (logsdb, passthrough attributes, dynamic:false),
 * and our template replaces it for this one pattern at the next rollover — so a stale copy of its
 * composed_of list would silently change the stream's mappings or index mode. Mirroring it at
 * install time keeps the stream exactly as Elastic defines it, plus our one component.
 *
 * The pipeline lifts the IP with a script processor rather than a dotted `field` path:
 * keys inside `attributes` are LITERAL dotted strings (attributes['network.forwarded_ip']),
 * so ingest's normal dot-path traversal finds nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from './lib/env.mjs';
import { es } from './lib/http.mjs';
import { success, detail } from './lib/log.mjs';

const BASE_TEMPLATE = 'logs-otel@template';
/** Stamped into everything --ingest installs; nothing without it is ever overwritten or deleted. */
export const MARKER = 'cloud-audit-dashboards';
/**
 * Installs that predate the marker are recognised by the descriptions this repo always wrote, so an
 * upgrade adopts them (and stamps the marker) instead of refusing to touch its own objects.
 */
const LEGACY = /^(Cloud Audit Dashboards — |Audit-scoped geoip enrichment of Cloud audit forwarded client IPs)/;
export const ours = (obj) => obj?._meta?.generator === MARKER
  || LEGACY.test(obj?._meta?.description || '') || LEGACY.test(obj?.description || '');

/**
 * Refuse to overwrite a same-named object someone else owns: `logs-<dataset>@custom` and
 * `@template` are conventional names an integration or an operator could also use.
 */
async function assertWritable(kind, path, pick) {
  const r = await es.raw(path);
  if (r.status === 404) return;
  const existing = pick(r.body);
  if (existing && !ours(existing)) throw new Error(`${kind} ${path} exists and is not ours (no _meta.generator=${MARKER}); refusing to overwrite`);
}

const read = (f) => readFileSync(join(ROOT, 'ingest', f), 'utf8')
  .replaceAll('{{DATASET}}', cfg.dataset).replaceAll('{{PIPELINE}}', cfg.pipeline);
const readJson = (f) => JSON.parse(read(f));

/** The audit stream's own template, re-derived from the managed OTel template it would otherwise use. */
export async function indexTemplate() {
  const live = await es.get(`/_index_template/${BASE_TEMPLATE}`);
  const base = live.index_templates?.[0]?.index_template;
  if (!base) throw new Error(`${BASE_TEMPLATE} not found — cannot mirror the stream's template safely`);
  const { created_date_millis, modified_date_millis, version, _meta, index_patterns, priority, ...rest } = base;
  return {
    ...rest,
    index_patterns: [`logs-${cfg.dataset}-*`],
    priority: Math.max(200, (priority || 0) + 1),
    composed_of: [...base.composed_of.filter((c) => c !== cfg.pipeline), cfg.pipeline],
    _meta: { managed: false, generator: MARKER, mirrors: `${BASE_TEMPLATE} v${version}`, mirrors_version: version,
             mirrors_composed_of: base.composed_of,
             description: 'Cloud Audit Dashboards — audit stream: mirrors the OTel logs template and appends audit-only geoip enrichment' },
  };
}

export async function run() {
  await assertWritable('pipeline', `/_ingest/pipeline/${cfg.pipeline}`, (b) => b[cfg.pipeline]);
  await assertWritable('component template', `/_component_template/${cfg.pipeline}`, (b) => b.component_templates?.[0]?.component_template);
  await assertWritable('index template', `/_index_template/${cfg.indexTemplate}`, (b) => b.index_templates?.[0]?.index_template);

  await es.put(`/_ingest/pipeline/${cfg.pipeline}`, readJson('audit@custom.pipeline.json'));
  detail(`ingest pipeline ${cfg.pipeline} (guarded to dataset ${cfg.dataset})`);

  await es.put(`/_component_template/${cfg.pipeline}`, readJson('audit@custom.component.json'));
  detail(`component template ${cfg.pipeline}`);

  // Validate BEFORE installing: a template that resolves to a different index mode would take
  // effect silently at the next rollover. Simulate it and compare with the live stream.
  const tpl = await indexTemplate();
  // Simulated BY NAME, i.e. as a replacement for the copy a previous run installed — the unnamed form
  // rejects a re-run because the installed copy has the same pattern and priority.
  const sim = await es.post(`/_index_template/_simulate/${cfg.indexTemplate}`, tpl);
  const mode = sim.template?.settings?.index?.mode || 'standard';
  const fp = sim.template?.settings?.index?.final_pipeline;
  const live = await es.get(`/${cfg.dataStream}/_settings?flat_settings=true`);
  const liveMode = Object.values(live)[0]?.settings?.['index.mode'] || 'standard';
  if (fp !== cfg.pipeline) throw new Error(`template would not run ${cfg.pipeline} (resolves final_pipeline=${fp})`);
  if (mode !== liveMode) throw new Error(`template would change index.mode ${liveMode} -> ${mode} at rollover; refusing`);
  await es.put(`/_index_template/${cfg.indexTemplate}`, tpl);
  detail(`index template ${cfg.indexTemplate} (${tpl._meta.mirrors} + ${cfg.pipeline}; mode=${mode}, verified by simulation)`);

  // Apply to the live data stream so enrichment starts now rather than at next rollover.
  await es.put(`/${cfg.dataStream}/_settings`, { 'index.final_pipeline': cfg.pipeline });
  detail(`final_pipeline set on ${cfg.dataStream}`);

  // client.* must be mapped explicitly: the index is dynamic:false, so enriched fields that are
  // not in the mapping are stored but cannot be queried. `tags` is mapped for the same reason: it is
  // where geoip records `_geoip_database_unavailable_*`, which happens for the first seconds after the
  // pipeline is attached while the database loads — unmapped, that failure is invisible.
  await es.put(`/${cfg.dataStream}/_mapping`, readJson('client-mappings.json'));
  detail('client.* mappings applied to the live data stream');

  success('Audit-scoped geoip enrichment installed (forward-only)');
}

/**
 * Our template is a snapshot of logs-otel@template. When Elastic ships a new version, the audit
 * stream would keep rolling over onto the old composition — so detect it and say to re-run --ingest.
 */
export async function templateDrift() {
  const [mine, live] = await Promise.all([
    es.raw(`/_index_template/${cfg.indexTemplate}`), es.raw(`/_index_template/${BASE_TEMPLATE}`)]);
  const m = mine.body?.index_templates?.[0]?.index_template;
  const b = live.body?.index_templates?.[0]?.index_template;
  if (!m) return { ok: false, reason: `${cfg.indexTemplate} is not installed — run ./audit --ingest` };
  if (!b) return { ok: false, reason: `${BASE_TEMPLATE} not found` };
  const wantComposed = JSON.stringify(b.composed_of);
  if (m._meta?.mirrors_version !== b.version || JSON.stringify(m._meta?.mirrors_composed_of) !== wantComposed) {
    return { ok: false, reason: `${BASE_TEMPLATE} is now v${b.version} (ours mirrors v${m._meta?.mirrors_version}) — re-run ./audit --ingest` };
  }
  return { ok: true };
}

/** Prove enrichment is actually flowing, not just configured. */
export async function check() {
  const tpl = await templateDrift();
  if (!tpl.ok) throw new Error(tpl.reason);
  detail(`index template current with ${BASE_TEMPLATE}`);
  const q = `FROM ${cfg.dataStream} | WHERE @timestamp > NOW() - 5 minutes ` +
            `| STATS total = COUNT(*), fwd = COUNT(attributes.network.forwarded_ip), ` +
            `ip = COUNT(client.ip), geo = COUNT(client.geo.country_iso_code)`;
  const r = await es.esql(q);
  const [total, fwd, ip, geo] = r.values[0] || [0, 0, 0, 0];
  detail(`last 5 min: ${total} events, ${fwd} with forwarded_ip, ${ip} lifted to client.ip, ${geo} geo-resolved`);
  // A quiet five minutes used to yield all zeros, skip the one assertion and print "verified"
  // having verified nothing. Refuse to pass on an empty sample.
  if (fwd === 0) throw new Error(`no sample to check: ${total} events in the last 5 minutes carried forwarded_ip`);
  if (ip === 0) throw new Error('enrichment is not running: forwarded_ip present but client.ip empty');
  // The lift can work while geoip resolves nothing — a private or CGNAT forwarded_ip finds no
  // database entry and the processor writes no error either, so this is the silent half.
  if (geo === 0) throw new Error(`geoip resolved nothing: ${ip} events carry client.ip but none carry client.geo.*`);
  const pct = ((geo / ip) * 100).toFixed(1);
  detail(`geo coverage ${pct}% of lifted IPs (private and CGNAT ranges do not resolve, which is expected)`);
  success('Geo enrichment verified');
}
