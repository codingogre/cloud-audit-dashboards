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

/**
 * Order matters. The index template goes first, so a rollover mid-teardown cannot create a backing
 * index that re-attaches the pipeline. Then the pipeline is detached from EVERY backing index and
 * that is re-read and confirmed — deleting a pipeline still named as a final_pipeline would make
 * every audit document fail ingest. Nothing is deleted unless it carries our ownership marker.
 */
async function cleanIngest() {
  const { MARKER, ours } = await import('./ingest.mjs');
  const owned = async (path, pick) => {
    const r = await es.raw(path);
    if (r.status === 404) return null;
    const obj = pick(r.body);
    if (!ours(obj)) throw new Error(`${path} is not ours (no _meta.generator=${MARKER}); refusing to delete`);
    return obj;
  };
  const del = async (path, label) => {
    const r = await es.raw(path, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    detail(`${label}: ${r.status === 404 ? 'already gone' : 'deleted'}`);
  };

  if (await owned(`/_index_template/${cfg.indexTemplate}`, (b) => b.index_templates?.[0]?.index_template)) {
    await del(`/_index_template/${cfg.indexTemplate}`, 'index template');
  }

  const reset = await es.raw(`/${cfg.dataStream}/_settings`, {
    method: 'PUT', body: JSON.stringify({ 'index.final_pipeline': null }), headers: { 'Content-Type': 'application/json' },
  });
  if (!reset.ok && reset.status !== 404) throw new Error(`could not detach ${cfg.pipeline} from ${cfg.dataStream} (${reset.status}); nothing else removed`);
  const after = await es.raw(`/${cfg.dataStream}/_settings?flat_settings=true`);
  const still = Object.entries(after.body || {}).filter(([, v]) => v.settings?.['index.final_pipeline'] === cfg.pipeline).map(([k]) => k);
  if (still.length) throw new Error(`${still.join(', ')} still run ${cfg.pipeline}; not deleting it`);
  detail(`final_pipeline detached from every backing index of ${cfg.dataStream}`);

  if (await owned(`/_component_template/${cfg.pipeline}`, (b) => b.component_templates?.[0]?.component_template)) {
    await del(`/_component_template/${cfg.pipeline}`, 'component template');
  }
  if (await owned(`/_ingest/pipeline/${cfg.pipeline}`, (b) => b[cfg.pipeline])) {
    await del(`/_ingest/pipeline/${cfg.pipeline}`, 'ingest pipeline');
  }
  warn('client.* and tags field mappings were left in place — removing a mapping needs a reindex');
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
