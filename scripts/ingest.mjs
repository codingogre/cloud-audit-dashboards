/**
 * Audit-scoped geoip enrichment.
 *
 * Deliberately NOT the global `logs@custom` hook: that fires for every logs-* data stream
 * in the project. Instead a dedicated pipeline is attached as `index.final_pipeline` on the
 * audit data stream only, and a component + index template keep it across rollover.
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

const read = (f) => JSON.parse(readFileSync(join(ROOT, 'ingest', f), 'utf8'));

export async function run() {
  await es.put(`/_ingest/pipeline/${cfg.pipeline}`, read('logs-serverless.audit.otel@custom.pipeline.json'));
  detail(`ingest pipeline ${cfg.pipeline}`);

  await es.put(`/_component_template/${cfg.pipeline}`, read('logs-serverless.audit.otel@custom.component.json'));
  detail(`component template ${cfg.pipeline}`);

  await es.put('/_index_template/logs-serverless.audit.otel@template', read('logs-serverless.audit.otel@template.json'));
  detail('index template logs-serverless.audit.otel@template');

  // Apply to the live data stream so enrichment starts now rather than at next rollover.
  await es.put(`/${cfg.dataStream}/_settings`, { 'index.final_pipeline': cfg.pipeline });
  detail(`final_pipeline set on ${cfg.dataStream}`);

  // client.* must be mapped explicitly: the index is dynamic:false and a dynamic template
  // maps attributes.* to flattened, so enriched fields have to live at the top level.
  await es.put(`/${cfg.dataStream}/_mapping`, read('client-mappings.json'));
  detail('client.* mappings applied to the live data stream');

  success('Audit-scoped geoip enrichment installed (forward-only)');
}

/** Prove enrichment is actually flowing, not just configured. */
export async function check() {
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
