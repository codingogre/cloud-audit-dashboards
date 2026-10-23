/**
 * The dashboard control bar: Project, Identity type, Identity, Client IP (CONTROLS below), and the suite's data
 * view.
 *
 * Fields NOT offered, and why: `user.name` alone (a numeric id, a key id or a key's owner, depending on the
 * credential — Identity covers it); `user.full_name` (removed in 1.0.2, NULL for some identities); a runtime
 * "identity" field on the data view (tried in 1.0.5: its pill is DSL on a field the index does not have, so
 * every ES|QL panel went empty — the ES|QL variable controls are what replaced it).
 */
import { cfg, nsId } from './env.mjs';
import { stableUuid } from './ids.mjs';
import { IDENTITY_KEYS, IDENTITY_KIND, IDENTITY, ANY, nullSafe } from './panels.mjs';

/** The suite's data view on the stream. The classic Project and Client IP controls aggregated against it until
 *  1.0.5.2; no control does now, but it still deploys: a public id, like the dashboards' (`elastic_cloud-audit-*`),
 *  which it replaced `cloud-audit-dv` with in 1.0.4, and a viewer may have built a Lens chart or a rule on it. */
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
 * THE CONTROL BAR: Project · Identity type · Identity · Client IP, all four ES|QL variable controls (1.0.5.2).
 *
 * Each lists the values an ES|QL query works out, opens on "Any" (panels.mjs, ANY) and sets one variable:
 * ?project, ?identity_kind, ?identity, ?client_ip. TIME's CONTROLS_WHERE (panels.mjs) reads all four in every
 * ES|QL panel. Single-select (the user's choice): it keeps a selected panel at ~20-35ms over 30 days; multi-select
 * has no fast path.
 *
 * Identity type and Identity replaced Person (email) and API key in 1.0.5.1. Those two read one raw field each,
 * and the fields change meaning with the credential (panels.mjs, IDENTITY), so a Cloud API key was in neither
 * list and user.name was sometimes a person, sometimes a key id, sometimes a key's owner. Project and Client IP
 * were classic options lists on raw fields until 1.0.5.2, when they moved to ES|QL so that all four behave alike:
 * the same "Any", the same single choice, the same reach. Before that a viewer met two kinds of control on one bar,
 * one that left a filter pill and travelled with the nav links, one that did neither.
 *
 * What a variable control cannot do, all measured on 9.6 (.sessions research, esql-controls-probe):
 *   - a panel that is not ES|QL ignores it: DSL Vega specs (vega/14 Audit data held, by design) and Discover
 *     sessions (1.0.5.1 converted every dashboard Discover panel to a Lens table for this reason);
 *   - its selection is not in the URL and the nav links do not carry it: each dashboard opens at "Any". A pill
 *     does travel, which is why the tables' raw columns (Client IP among them) stay click-to-filter;
 *   - Identity chains on Identity type through its query (?identity_kind), but a stale Identity is not cleared
 *     when the type changes: the dropdown shows a warning and the panels read 0 until it is set back to Any.
 *     Project and Client IP chain on nothing, so no choice can strand another;
 *   - a single-select choice cannot be cleared (no Clear button; re-clicking keeps it), so each list starts
 *     with "Any", which every guard treats as no selection.
 *
 * Project leads, because one audit project usually collects the streams of several serverless projects. project.*
 * names the project that EMITTED the event, populated on every Elasticsearch and Kibana event (verified
 * 2026-10-14); the name, not the 32-hex id. Actor 360's cohort rank (vega/12) ranks the selection against an
 * estate that follows the Project dropdown and no other (TWO_DATASET_SPECS in layout.mjs). Client IP is last: it
 * answers "who was at this address". Its list is the busiest addresses in range, as text; the dropdown searches it.
 *
 * Every control goes out in the PUT payload's `pinned_panels` (the 9.6 Dashboards API accepts them there;
 * verified by PUT, GET and an _export/_import round trip), so nothing is patched in after the deploy.
 */
// width 'small' with grow: four 'medium' controls wrapped Client IP onto a second row at a 1440px viewport
// (rendered, 1.0.5); 'small' is a minimum, and grow shares the row out evenly at any width.
const OPTIONS_TIME = 'WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart';
/** ES|QL's own row ceiling, written out: each list is the busiest values in range, up to this many. */
export const OPTIONS_MAX = 10000;
/**
 * An options query: count first by the raw keys, derive the column, then list the values busiest first behind
 * one "Any" row (panels.mjs, ANY: the only way to clear an ES|QL control). FORK runs both branches over the same
 * counted rows; the Any branch carries the largest long, so it sorts to the top. A value that is null (an event
 * with no project or no client IP) is not listed: nothing could select it.
 */
const optionsQuery = (col, keys, derive) => nullSafe(
  `FROM ${cfg.dataStream} | ${OPTIONS_TIME} | STATS n = COUNT(*) BY ${keys} | ${derive} ` +
  `| FORK (STATS n = SUM(n) BY ${col}) (STATS n = COUNT(*) | EVAL ${col} = "${ANY}", n = 9223372036854775807) ` +
  `| SORT n DESC | LIMIT ${OPTIONS_MAX} | KEEP ${col}`);
export const CONTROLS = [
  { variable: 'project', title: 'Project', width: 'small',
    query: () => optionsQuery('project', 'project.name', 'WHERE project.name IS NOT NULL | EVAL project = project.name') },
  { variable: 'identity_kind', title: 'Identity type', width: 'small',
    query: () => optionsQuery('identity_kind', IDENTITY_KEYS, `EVAL ${IDENTITY_KIND}`) },
  // Chained on Identity type through ?identity_kind; "" or "Any" lists every identity.
  { variable: 'identity', title: 'Identity', width: 'small',
    query: () => optionsQuery('identity', IDENTITY_KEYS, `EVAL ${IDENTITY_KIND}, ${IDENTITY} ` +
      `| WHERE ?identity_kind == "" OR ?identity_kind == "${ANY}" OR identity_kind == ?identity_kind`) },
  // Text, because a control's value is text: CLIENT_IP_WHERE turns the choice back into an ip.
  { variable: 'client_ip', title: 'Client IP', width: 'small',
    query: () => optionsQuery('client_ip', 'client.ip', 'WHERE client.ip IS NOT NULL | EVAL client_ip = TO_STRING(client.ip)') },
];

/** Deterministic per variable, so redeploys do not churn control ids. */
const controlId = (c) => stableUuid(`cloud-audit-control:esql:${c.variable}`);

/** The control bar as the Dashboards API's `pinned_panels`, in order. */
export function pinnedPanels() {
  return CONTROLS.map((c) => ({
    id: controlId(c), type: 'esql_control', width: c.width, grow: true,
    config: {
      title: c.title, control_type: 'VALUES_FROM_QUERY', variable_name: c.variable, variable_type: 'values',
      // Starts on Any, so all four dropdowns read "Any" on a fresh page (the user's preference, 1.0.5.1).
      esql_query: c.query(), selected_options: [ANY], single_select: true,
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
