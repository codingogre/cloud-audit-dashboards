/**
 * Deploys Vega visualizations and ES|QL Discover sessions with STABLE ids.
 *
 * The generic /api/saved_objects CRUD API is disabled on serverless, so everything goes
 * through _import. Stable ids matter: dashboards reference these by id, so an
 * auto-generated UUID would break every panel on the next deploy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { cfg, ROOT, withStream, nsId } from './lib/env.mjs';
import { kb } from './lib/http.mjs';
import { dataViewObject } from './lib/controls.mjs';
import { stableUuid } from './lib/ids.mjs';
import { success, detail } from './lib/log.mjs';

const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function vegaObject(file) {
  const name = basename(file, '.json');
  const spec = JSON.parse(withStream(readFileSync(file, 'utf8')));
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
    id: nsId(`cloud-audit-vega-${name}`), type: 'visualization',
    coreMigrationVersion: '8.8.0', typeMigrationVersion: '8.5.0', references: [],
    attributes: {
      title: `[Audit] ${title}`, description: sub, uiStateJSON: '{}',
      kibanaSavedObjectMeta: { searchSourceJSON: '{}' },
      visState: JSON.stringify({ title: `[Audit] ${title}`, type: 'vega', aggs: [], params: { spec: JSON.stringify(spec, null, 2) } }),
    },
  };
}

/**
 * DISCOVER SESSION HEADERS. A session's column header is its ES|QL column name, and nothing else in
 * the saved object changes it — `fieldAttrs.customLabel` on the ad-hoc data view survives import
 * but Discover ignores it in ES|QL mode (rendered: headers stayed raw). So a session names its
 * columns for readers with a trailing `| RENAME field AS Header, …` after every drift-checked
 * fragment, and lists the new names in `columns`.
 *
 * The trade-off, measured on a live dashboard: on the EMBEDDED grid a renamed column loses its
 * filter-for/filter-out cell actions (only copy and expand remain), because there is no index field
 * behind the new name; a raw field keeps them and pins a real-field pill. In the Discover app both
 * work — there filter-for appends `| WHERE \`Header\` == "…"` to the query. The suite's pivots
 * (person, client IP) are the control bar and the Lens click-to-filter columns, not session cells,
 * so the suite renames: a raw dotted header in front of every viewer costs more than a cell action
 * one click away in Discover. `@timestamp` is renamed to Time like any other column; it stays a
 * date, and the time picker still applies because Kibana filters on the data view's time field
 * before the query runs.
 *
 * `row_height` defaults to 1 line. Discover's default is auto-height, which wrapped an 8-column
 * session into 65px rows showing four records in a 14-unit panel. `grid` is Discover's own
 * `{ columns: { name: { width } } }`; dates and IPs get a default width by header, so the text
 * columns share the rest instead of everything splitting evenly.
 */
// Discover sets cell text in a monospace face, so a full timestamp needs ~40px more than in Lens.
const SESSION_WIDTHS = { Time: 235, 'First seen': 235, 'Last seen': 235, 'Client IP': 130, IP: 130, 'Proxy IP': 130 };

export function sessionGrid(d) {
  const cols = Object.fromEntries((d.columns || []).filter((c) => SESSION_WIDTHS[c]).map((c) => [c, { width: SESSION_WIDTHS[c] }]));
  return { grid: { columns: { ...cols, ...(d.grid?.columns || {}) } }, rowHeight: d.row_height ?? 1 };
}

function searchObject(file) {
  const slug = basename(file, '.json');
  const d = JSON.parse(withStream(readFileSync(file, 'utf8')));
  const adhoc = {
    id: 'cloud-audit-adhoc-dv', title: cfg.dataStream, timeFieldName: '@timestamp',
    sourceFilters: [], type: 'esql', fieldFormats: {}, runtimeFieldMap: {},
    allowNoIndex: false, name: cfg.dataStream, allowHidden: false,
  };
  const searchSource = { query: { esql: d.esql }, index: adhoc, filter: [], highlightAll: true, version: true };
  return {
    id: nsId(`cloud-audit-search-${slug}`), type: 'search',
    coreMigrationVersion: '8.8.0', typeMigrationVersion: '10.15.0', references: [],
    attributes: {
      title: d.title, description: d.description || '',
      tabs: [{
        id: stableUuid(`cloud-audit-${slug}`), label: d.tab_label || 'Results',
        attributes: {
          isTextBasedQuery: true, usesAdHocDataView: true,
          columns: d.columns || [], sort: d.sort || [],
          ...sessionGrid(d), hideChart: !!d.hide_chart, chartInterval: 'auto',
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
