/**
 * The dashboard control bar: Project, Identity type, Identity, Client IP (CONTROLS below), and the data view
 * the classic controls aggregate against.
 *
 * Fields NOT offered, and why: `user.name` alone (a numeric id, a key id or a key's owner, depending on the
 * credential — Identity covers it); `user.full_name` (removed in 1.0.2, NULL for some identities); a runtime
 * "identity" field on the data view (tried in 1.0.5: its pill is DSL on a field the index does not have, so
 * every ES|QL panel went empty — the ES|QL variable controls are what replaced it).
 */
import { cfg, nsId } from './env.mjs';
import { stableUuid } from './ids.mjs';
import { IDENTITY_KEYS, IDENTITY_KIND, IDENTITY, nullSafe } from './panels.mjs';

/** The data view the controls aggregate against. Real saved object, not the ad-hoc one
 *  the Discover sessions carry inline — a control resolves its field list by reference.
 *  A public id, like the dashboards' (`elastic_cloud-audit-*`); it replaced `cloud-audit-dv` in 1.0.4. */
export const DATA_VIEW_ID = nsId('elastic_cloud-audit-logs');

/** Data view ids earlier releases deployed. --objects and --clean delete them. */
export const RETIRED_DATA_VIEW_IDS = ['cloud-audit-dv'];

export const dataViewObject = () => ({
  id: DATA_VIEW_ID, type: 'index-pattern',
  coreMigrationVersion: '8.8.0', typeMigrationVersion: '8.0.0', references: [],
  attributes: {
    title: cfg.dataStream,
    name: 'Cloud audit stream',
    timeFieldName: '@timestamp',
    sourceFilters: '[]', fieldAttrs: '{}', runtimeFieldMap: '{}', fieldFormatMap: '{}',
    allowNoIndex: true,
  },
});

/**
 * THE CONTROL BAR (1.0.5.1): Project · Identity type · Identity · Client IP.
 *
 * Project and Client IP are classic options lists on raw fields: a choice becomes a filter pill, which every
 * panel honours — Lens, both kinds of Vega, Discover — and which the nav links carry to the next dashboard.
 *
 * Identity type and Identity replace Person (email) and API key. Those two read one raw field each, and the
 * fields change meaning with the credential (panels.mjs, IDENTITY), so a Cloud API key was in neither list and
 * user.name was sometimes a person, sometimes a key id, sometimes a key's owner. They are ES|QL variable
 * controls instead: each lists the values an ES|QL query works out (IDENTITY_KIND, IDENTITY), and a choice
 * sets ?identity_kind / ?identity, which TIME's IDENTITY_WHERE reads in every ES|QL panel. Single-select
 * (the user's choice): it keeps a selected panel at ~20ms over 30 days; multi-select has no fast path.
 *
 * What a variable control cannot do, all measured on 9.6 (.sessions research, esql-controls-probe):
 *   - a panel that is not ES|QL ignores it: DSL Vega specs (vega/14 Audit data held, by design) and Discover
 *     sessions (1.0.5.1 converted every dashboard Discover panel to a Lens table for this reason);
 *   - its selection is not in the URL and the nav links do not carry it: each dashboard opens at "Any";
 *   - a classic control (Project) does not narrow its option list;
 *   - Identity chains on Identity type through its query (?identity_kind), but a stale Identity is not cleared
 *     when the type changes: the dropdown shows a warning and the panels read 0 until it is cleared.
 *
 * Project leads, because one audit project usually collects the streams of several serverless projects. project.*
 * names the project that EMITTED the event, populated on every Elasticsearch and Kibana event (verified
 * 2026-10-14); the name, not the 32-hex id. Actor 360's cohort rank (vega/12) follows the Project control and
 * no other; see TWO_DATASET_SPECS in layout.mjs. Client IP is last: it answers "who was at this address".
 *
 * Every control goes out in the PUT payload's `pinned_panels` (the 9.6 Dashboards API accepts both kinds there;
 * verified by PUT, GET and an _export/_import round trip), so nothing is patched in after the deploy.
 */
// width 'small' with grow: four 'medium' controls wrapped Client IP onto a second row at a 1440px viewport
// (rendered, 1.0.5); 'small' is a minimum, and grow shares the row out evenly at any width.
const OPTIONS_TIME = 'WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart';
const optionsQuery = (tail) => nullSafe(
  `FROM ${cfg.dataStream} | ${OPTIONS_TIME} | STATS n = COUNT(*) BY ${IDENTITY_KEYS} | ${tail}`);
export const CONTROLS = [
  { field: 'project.name', title: 'Project', width: 'small', search: 'prefix' },
  { variable: 'identity_kind', title: 'Identity type', width: 'small',
    query: () => optionsQuery(`EVAL ${IDENTITY_KIND} | STATS n = SUM(n) BY identity_kind | SORT n DESC | KEEP identity_kind`) },
  // Chained on Identity type through ?identity_kind; "" (nothing chosen) lists every identity.
  { variable: 'identity', title: 'Identity', width: 'small',
    query: () => optionsQuery(`EVAL ${IDENTITY_KIND}, ${IDENTITY} | WHERE ?identity_kind == "" OR identity_kind == ?identity_kind ` +
      '| STATS n = SUM(n) BY identity | SORT n DESC | KEEP identity') },
  // 'wildcard', not 'prefix': prefix search on an `ip` field only matches whole octets, so
  // typing "100.64" returns nothing while "100.64.0.10" works. Wildcard matches substrings.
  { field: 'client.ip', title: 'Client IP', width: 'small', search: 'wildcard' },
];

/** Deterministic per field or variable, so redeploys do not churn control ids. */
const controlId = (c) => stableUuid(`cloud-audit-control:${c.field || `esql:${c.variable}`}`);

/** The control bar as the Dashboards API's `pinned_panels`, in order. */
export function pinnedPanels() {
  return CONTROLS.map((c) => (c.field
    ? {
      id: controlId(c), type: 'options_list_control', width: c.width, grow: true,
      config: {
        title: c.title, data_view_id: DATA_VIEW_ID, field_name: c.field, search_technique: c.search,
        selected_options: [], single_select: false, exclude: false, exists_selected: false,
        use_global_filters: true, ignore_validations: false, sort: { by: '_count', direction: 'desc' },
      },
    }
    : {
      id: controlId(c), type: 'esql_control', width: c.width, grow: true,
      config: {
        title: c.title, control_type: 'VALUES_FROM_QUERY', variable_name: c.variable, variable_type: 'values',
        esql_query: c.query(), selected_options: [], single_select: true,
      },
    }));
}

/**
 * Reference names this module owns, so the post-pass replaces rather than duplicates them.
 * Deliberately matches ANY control kind's data view, not just optionsList: a range- or
 * time-slider control added later would otherwise slip past the filter and accumulate a stale
 * reference on every deploy — the exact failure this guard exists to prevent.
 */
export const isControlRef = (name) => /^controlGroup_.*:.*DataView$/.test(name);
