/**
 * Tears down what this repo created. Destructive, so the target must be named explicitly.
 *
 *   --clean dashboards   every dashboard + its data view, Vega and Discover sessions
 *   --clean ingest       the audit-scoped pipeline and templates (mappings are left alone;
 *                        removing a field mapping requires a reindex)
 *   --clean all          both, plus the space
 */
import { cfg } from './lib/env.mjs';
import { kb, es } from './lib/http.mjs';
import { success, info, warn, detail } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.mjs';
import { DATA_VIEW_ID } from './lib/controls.mjs';

async function cleanDashboards() {
  for (const name of Object.keys(buildAll())) {
    const r = await kb.sRaw(`/api/dashboards/cloud-audit-${name}`, { method: 'DELETE' });
    detail(`dashboard cloud-audit-${name}: ${r.status}`);
  }
  const objs = [
    ...readdirSync(join(ROOT, 'vega')).filter((f) => f.endsWith('.json'))
      .map((f) => ({ type: 'visualization', id: `cloud-audit-vega-${f.replace('.json', '')}` })),
    ...readdirSync(join(ROOT, 'searches')).filter((f) => f.endsWith('.json'))
      .map((f) => ({ type: 'search', id: `cloud-audit-search-${f.replace('.json', '')}` })),
    // The controls' data view lives in neither vega/ nor searches/, so it has to be named
    // explicitly or `--clean dashboards` silently orphans it.
    { type: 'index-pattern', id: DATA_VIEW_ID },
  ];
  await kb.raw(`/s/${cfg.space}/api/saved_objects/_bulk_delete?force=true`, {
    method: 'POST', body: JSON.stringify(objs), headers: { 'Content-Type': 'application/json' },
  });
  success(`removed ${Object.keys(buildAll()).length} dashboards and ${objs.length} saved objects`);
}

async function cleanIngest() {
  await es.raw(`/${cfg.dataStream}/_settings`, {
    method: 'PUT', body: JSON.stringify({ 'index.final_pipeline': null }), headers: { 'Content-Type': 'application/json' },
  });
  for (const [path, label] of [
    [`/_index_template/logs-serverless.audit.otel@template`, 'index template'],
    [`/_component_template/${cfg.pipeline}`, 'component template'],
    [`/_ingest/pipeline/${cfg.pipeline}`, 'ingest pipeline'],
  ]) {
    const r = await es.raw(path, { method: 'DELETE' });
    detail(`${label}: ${r.status}`);
  }
  warn('client.* field mappings were left in place — removing a mapping needs a reindex');
  success('audit-scoped enrichment removed');
}

export async function run(argv = []) {
  const target = argv[0];
  if (!target) { info('Nothing deleted. Pass a target: dashboards | ingest | all'); return; }
  if (target === 'dashboards' || target === 'all') await cleanDashboards();
  if (target === 'ingest' || target === 'all') await cleanIngest();
  if (target === 'all') {
    const r = await kb.raw(`/api/spaces/space/${cfg.space}`, { method: 'DELETE' });
    detail(`space ${cfg.space}: ${r.status}`);
  }
}
