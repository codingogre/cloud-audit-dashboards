/**
 * The dashboard control bar — three dropdowns that scope the whole suite: Project, Person (email), Client IP.
 *
 * Why this lives outside the dashboard definitions: `PUT /api/dashboards/{id}` is
 * Zod-strict and silently drops `controlGroupInput`, so the control bar cannot travel
 * with the rest of the definition. It is applied by the same _export -> mutate -> _import
 * post-pass that repoints Vega panels, and it is re-applied on every `--dashboards` run
 * because each run's PUT passes wipe it first. That is the design, not a leak.
 *
 * Shape verified empirically against Kibana 9.6.0 serverless — a throwaway dashboard was
 * imported with a hand-built control group and exported back. Two things the export
 * settled, both of which the REST schema documentation does not:
 *   - control state is WRAPPED in `explicitInput`, not flat in the panel entry;
 *   - the data view arrives by REFERENCE, named `controlGroup_<uuid>:optionsListDataView`,
 *     and `dataViewId` inside explicitInput must match that reference's id.
 *
 * Field choices are driven by what the audit stream actually carries:
 *   project.name    the emitting serverless project — see CONTROLS below
 *   user.email      the identity control: the reliable key, never null for a human
 *   client.ip                  high-cardinality — too many to eyeball, which is the point of
 *                              a searchable dropdown rather than a table
 * `user.name` is deliberately NOT offered: it is a numeric id (e.g. 1234567890), not
 * a name. See esql/fragments.md. `user.full_name` is not offered either (removed in
 * 1.0.2): it was NULL for some identities, so a "Person (name)" dropdown silently missed people
 * that the email dropdown always finds, and two person controls invited a contradictory pair.
 */
import { cfg, nsId } from './env.mjs';
import { stableUuid } from './ids.mjs';

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
 * Order is deliberate. Project leads because an audit project usually collects the audit
 * streams of SEVERAL serverless projects, and the chaining below is HIERARCHICAL: picking a
 * project narrows every dropdown after it to the people and addresses seen in that project.
 * Then email, the identity control, because it is what actually resolves a person; IP last
 * because it answers a different question ("who was at this address") rather than "what did
 * this person do".
 *
 * project.* names the project that EMITTED the event, not the audit project that
 * stores it, and it is populated on every Elasticsearch and Kibana event (verified 2026-10-14,
 * 100% of both sources). The name, not the id, because the id is a 32-hex string nobody
 * recognises; Elastic Cloud does not enforce unique project names, so an org that reuses a
 * name across regions gets those projects merged under one option.
 *
 * Actor 360's cohort rank (vega/12) follows this control and no other. Kibana applies the control
 * bar to a DSL dataset as all-or-nothing, so the spec works out the projects in scope itself; see
 * TWO_DATASET_SPECS in layout.mjs.
 */
export const CONTROLS = [
  { field: 'project.name',   title: 'Project',        width: 'medium', search: 'prefix' },
  { field: 'user.email',     title: 'Person (email)', width: 'medium', search: 'prefix' },
  // 'wildcard', not 'prefix': prefix search on an `ip` field only matches whole octets, so
  // typing "100.64" returns nothing while "100.64.0.10" works. Wildcard matches substrings.
  { field: 'client.ip',                 title: 'Client IP',      width: 'medium', search: 'wildcard' },
];

/** Deterministic per field, so redeploys do not churn control ids (and therefore do not
 *  orphan a selection the analyst has already made). Keyed on the field, not the position, so
 *  removing a control (full_name, 1.0.2) left the others' ids and selections untouched. */
const controlId = (field) => stableUuid(`cloud-audit-control:${field}`);

/**
 * Build the control group and the references it needs.
 * Returns null-safe values ready to splice onto an exported dashboard saved object.
 */
export function controlGroup() {
  const panels = {};
  const references = [];
  CONTROLS.forEach((c, order) => {
    const id = controlId(c.field);
    const kind = c.kind || 'optionsList';
    panels[id] = {
      type: `${kind}Control`, order, grow: true, width: c.width,
      explicitInput: {
        id, fieldName: c.field, title: c.title,
        dataViewId: DATA_VIEW_ID,
        searchTechnique: c.search,
        selectedOptions: [], exclude: false, existsSelected: false,
        singleSelect: false,
      },
    };
    references.push({
      name: `controlGroup_${id}:${kind}DataView`,
      type: 'index-pattern', id: DATA_VIEW_ID,
    });
  });
  return {
    controlGroupInput: {
      chainingSystem: 'HIERARCHICAL',
      labelPosition: 'oneLine',
      showApplySelections: false,
      ignoreParentSettingsJSON: JSON.stringify({
        ignoreFilters: false, ignoreQuery: false, ignoreTimerange: false, ignoreValidations: false,
      }),
      panelsJSON: JSON.stringify(panels),
    },
    references,
  };
}

/**
 * Reference names this module owns, so the post-pass replaces rather than duplicates them.
 * Deliberately matches ANY control kind's data view, not just optionsList: a range- or
 * time-slider control added later would otherwise slip past the filter and accumulate a stale
 * reference on every deploy — the exact failure this guard exists to prevent.
 */
export const isControlRef = (name) => /^controlGroup_.*:.*DataView$/.test(name);
