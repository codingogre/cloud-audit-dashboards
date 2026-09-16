/**
 * Deploys Vega visualizations and ES|QL Discover sessions with STABLE ids.
 *
 * The generic /api/saved_objects CRUD API is disabled on serverless, so everything goes
 * through _import. Stable ids matter: dashboards reference these by id, so an
 * auto-generated UUID would break every panel on the next deploy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { cfg, ROOT } from './lib/env.mjs';
import { kb } from './lib/http.mjs';
import { dataViewObject } from './lib/controls.mjs';
import { stableUuid } from './lib/ids.mjs';
import { success, detail } from './lib/log.mjs';

const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function vegaObject(file) {
  const name = basename(file, '.json');
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const t = spec.title;
  // Spec titles are intentionally blank — the Kibana panel title supplies the heading —
  // so fall back to a readable name derived from the filename. A title may also be an
  // expression ({expr: ...}) that renders a live reading from the data, which is the only
  // theme-aware way to put words inside a Vega-Lite spec; that is not a saved-object title.
  const str = (v) => (typeof v === 'string' ? v : '');
  const raw = typeof t === 'object' && t ? str(t.text) : str(t);
  const title = raw || titleCase(name.replace(/^\d+-/, ''));
  // A top-level `description` wins, for the same reason: the subtitle may be an expression.
  const sub = str(spec.description) || (typeof t === 'object' && t ? str(t.subtitle) : '');
  return {
    id: `cloud-audit-vega-${name}`, type: 'visualization',
    coreMigrationVersion: '8.8.0', typeMigrationVersion: '8.5.0', references: [],
    attributes: {
      title: `[Audit] ${title}`, description: sub, uiStateJSON: '{}',
      kibanaSavedObjectMeta: { searchSourceJSON: '{}' },
      visState: JSON.stringify({ title: `[Audit] ${title}`, type: 'vega', aggs: [], params: { spec: JSON.stringify(spec, null, 2) } }),
    },
  };
}

function searchObject(file) {
  const slug = basename(file, '.json');
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const adhoc = {
    id: 'cloud-audit-adhoc-dv', title: cfg.dataStream, timeFieldName: '@timestamp',
    sourceFilters: [], type: 'esql', fieldFormats: {}, runtimeFieldMap: {},
    allowNoIndex: false, name: cfg.dataStream, allowHidden: false,
  };
  const searchSource = { query: { esql: d.esql }, index: adhoc, filter: [], highlightAll: true, version: true };
  return {
    id: `cloud-audit-search-${slug}`, type: 'search',
    coreMigrationVersion: '8.8.0', typeMigrationVersion: '10.15.0', references: [],
    attributes: {
      title: d.title, description: d.description || '',
      tabs: [{
        id: stableUuid(`cloud-audit-${slug}`), label: d.tab_label || 'Results',
        attributes: {
          isTextBasedQuery: true, usesAdHocDataView: true,
          columns: d.columns || [], sort: d.sort || [],
          grid: {}, hideChart: !!d.hide_chart, chartInterval: 'auto',
          controlGroupJson: '{}', timeRestore: false,
          kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify(searchSource) },
        },
      }],
    },
  };
}

const listJson = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.json')).sort().map((f) => join(ROOT, dir, f));

export async function run() {
  const objects = [
    dataViewObject(),
    ...listJson('vega').map(vegaObject),
    ...listJson('searches').map(searchObject),
  ];
  const res = await kb.importObjects(objects);
  detail(`${res.successCount} objects imported into space "${cfg.space}"`);
  success(`${objects.filter((o) => o.type === 'visualization').length} Vega visualizations, ${objects.filter((o) => o.type === 'search').length} Discover sessions`);
  return objects;
}
