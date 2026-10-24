/**
 * Builds and deploys the audit dashboards.
 *
 * Deployment is two passes: a dashboardLink panel only validates once its target exists,
 * so the first pass creates every dashboard and the second wires up navigation.
 *
 * Then applyImportOnlyState() fixes the two things the Dashboards API cannot express:
 *
 *   1. Vega. That API accepts only links / markdown / vis / discover_session panels, and a
 *      `vis` panel with a ref_id ALWAYS serialises its reference as type "lens". Vega charts
 *      are legacy `visualization` saved objects, so those panels render "Visualization type
 *      not found." until the reference is rewritten to the classic by-reference form.
 *
 *   2. Intro text size, drilldowns and the section check (below).
 *
 * The control bar used to be patched in here too, as `controlGroupInput`, which the API dropped. Since 1.0.5.1
 * it rides the PUT as `pinned_panels` (controls.mjs), which the 9.6 API accepts and the round trip keeps.
 * This post-pass is one _export -> mutate -> _import per dashboard, on every deploy: the PUT passes reset
 * what it patches.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT, nsId, RETIRED_OBJECTS } from './lib/env.mjs';
import { dashId, strays, SUITE } from './lib/suite.mjs';
import { kb } from './lib/http.mjs';
import { success, detail, info } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { pinnedPanels, dataViewObject, isControlRef, CONTROLS, RETIRED_DATA_VIEW_IDS } from './lib/controls.mjs';
import { panelDrilldown, hasFilterableColumn, ACTOR_360, drilldownRefs, isDrilldownRef } from './lib/drilldowns.mjs';
import { checkLayout } from './lib/layout.mjs';
import { smallMarkdown, writeTileSpecs, flatPanels } from './lib/panels.mjs';
import { requireView } from './lib/view.mjs';

/**
 * The Dashboards API payload: the definitions minus the in-memory annotations the post-pass and the
 * layout check read. `PUT /api/dashboards/{id}` is Zod-strict, so a panel's `drill` destination and
 * table()'s `narrow1440` flag and the `lint` annotation (table(), search()) cannot ride along — they are kept on the in-memory definition and
 * stripped here, which is also what gets written to dashboards/*.json, since those files are the
 * payload as sent. So are `headed` and `small` (the post-pass's small-text markers, panels.mjs INTRO TEXT).
 */
const strip = ({ drill, narrow1440, lint, headed, small, ...p }) => p;
/**
 * A section (panels.mjs, SECTIONS) goes out as the API's shape — a `panels` entry with no `type`, its grid only
 * a y — and its own panels stripped the same way. Exported for the unit tests.
 */
const apiEntry = (p) => (p.section
  ? { id: p.id, title: p.title, collapsed: p.collapsed, grid: { y: p.grid.y }, panels: p.panels.map(strip) }
  : strip(p));
export const payload = (def) => ({ ...def, panels: def.panels.map(apiEntry), pinned_panels: pinnedPanels() });

/** Write the generated definitions to disk so they are diffable in review. */
export function emit() {
  // The previous-period and coverage specs are generated from panels.mjs (PREV_TILES, coverageSpec), so
  // they are written first and the layout check below reads the current ones. Their text carries no id,
  // so a private AUDIT_ID_NS run writes the same bytes.
  writeTileSpecs();
  const all = buildAll();
  // --dashboards is runnable without --lint, and this is the command that actually writes and
  // PUTs the definitions. Belt and braces.
  const { problems } = checkLayout(all);
  if (problems.length) throw new Error(`refusing to deploy:\n  ${problems.join('\n  ')}`);
  // dashboards/*.json is committed and reviewed as the deployed payload, so a private render under
  // AUDIT_ID_NS (whose ids and links carry the namespace) must not overwrite it.
  if (process.env.AUDIT_ID_NS) return all;
  mkdirSync(join(ROOT, 'dashboards'), { recursive: true });
  for (const [name, def] of Object.entries(all)) {
    writeFileSync(join(ROOT, 'dashboards', `${name}.json`), JSON.stringify(payload(def), null, 2) + '\n');
  }
  // The files are this run's set and nothing else: an opt-in left out has no payload, and a stale copy
  // of it would carry a nav strip that no longer matches the others.
  for (const { name } of SUITE.filter((d) => !all[d.name])) rmSync(join(ROOT, 'dashboards', `${name}.json`), { force: true });
  return all;
}

/**
 * The saved object's view of the sections (panels.mjs, SECTIONS) must match the definition: one `sections`
 * entry per defined section, by id, titled and collapsed as defined, and exactly that section's panels
 * carrying its id in gridData.sectionId. Exported for the unit tests.
 */
export function checkSections(id, obj, panels, sections) {
  const stored = new Map((obj.attributes.sections || []).map((s) => [s.gridData?.i, s]));
  if (stored.size !== sections.length) throw new Error(`${id}: saved object has ${stored.size} section(s), the definition ${sections.length}`);
  for (const sec of sections) {
    const s = stored.get(sec.id);
    if (!s) throw new Error(`${id}: section ${sec.id} "${sec.title}" is missing from the saved object`);
    if (s.title !== sec.title || s.collapsed !== sec.collapsed) {
      throw new Error(`${id}: section ${sec.id} is "${s.title}" collapsed=${s.collapsed}, defined "${sec.title}" collapsed=${sec.collapsed}`);
    }
    const inside = panels.filter((p) => p.gridData?.sectionId === sec.id).map((p) => p.panelIndex).sort();
    const want = sec.panels.map((p) => p.id).sort();
    if (JSON.stringify(inside) !== JSON.stringify(want)) throw new Error(`${id}: section ${sec.id} holds [${inside.join(', ')}], defined [${want.join(', ')}]`);
  }
  for (const p of panels) {
    const sid = p.gridData?.sectionId;
    if (sid && !stored.has(sid)) throw new Error(`${id}: panel ${p.panelIndex} is in section ${sid}, which the saved object does not define`);
  }
}

async function applyImportOnlyState(all) {
  let vegaTotal = 0;
  let drillTotal = 0;
  for (const [name, def] of Object.entries(all)) {
    const id = dashId(name);
    // Section headers are not panels: the export keeps their inner panels in panelsJSON (gridData.sectionId)
    // and the headers in a separate `sections` attribute. So everything below reads the flat panel list, and
    // `sections` rides the import untouched (asserted after the import).
    const flat = flatPanels(def.panels);
    const sections = def.panels.filter((p) => p.section);
    const introPanels = Object.fromEntries(flat.filter((p) => p.headed || p.small).map((p) => [p.id, p.config.content]));
    const vegaPanels = Object.fromEntries(
      flat.filter((p) => p.type === 'vis' && p.config?.ref_id).map((p) => [p.id, p.config.ref_id]));
    // Drilldowns fire on FILTER_TRIGGER, so they belong only on panels that already carry a
    // click-to-filter column. Everywhere else drills IN to Identity 360; Identity 360's panels drill OUT
    // only where a panel names its destination — drilling from it to itself would be a no-op.
    const drillPanels = new Map(flat.filter(hasFilterableColumn)
      .map((p) => [p.id, id === ACTOR_360 ? p.drill : ACTOR_360]).filter(([, dest]) => dest));

    const [obj] = await kb.exportObjects([{ type: 'dashboard', id }]);
    const panels = JSON.parse(obj.attributes.panelsJSON);
    checkSections(id, obj, panels, sections);
    // Drop the control-group references a pre-1.0.5.1 deploy patched in (controlGroup_<id>:optionsListDataView).
    // The ES|QL controls in pinned_panels reference no data view (1.0.5.2); the PUT replaced the classic ones'.
    let refs = (obj.references || []).filter((r) => !isControlRef(r.name) && !isDrilldownRef(r.name));
    let changed = 0;
    for (const p of panels) {
      const vid = vegaPanels[p.panelIndex];
      if (!vid) continue;
      const refName = `panel_${p.panelIndex}`;
      p.type = 'visualization';
      p.panelRefName = refName;
      delete p.embeddableConfig?.savedObjectId;
      refs = refs.filter((r) => r.name !== `${p.panelIndex}:savedObjectRef` && r.name !== refName);
      refs.push({ name: refName, type: 'visualization', id: vid });
      changed++;
    }
    // Column widths used to be patched in here. The 9.6 Dashboards API now carries `width` (and
    // `label`) on data_table rows AND metrics itself — verified by PUT then _export — so they ride
    // the PUT like any other panel option and this post-pass no longer touches them.

    // Intro panels (INTRO TEXT, panels.mjs) become a by-value legacy markdown visualization, the only
    // markdown renderer with a text size; their content is the same markdown the PUT carried.
    let intros = 0;
    for (const p of panels) {
      const src = introPanels[p.panelIndex];
      if (!src) continue;
      p.type = 'visualization';
      p.embeddableConfig = smallMarkdown(src);
      delete p.panelRefName;
      refs = refs.filter((r) => !r.name.startsWith(`${p.panelIndex}:`));
      intros++;
    }

    let drilled = 0;
    for (const p of panels) {
      if (!drillPanels.has(p.panelIndex)) continue;
      p.embeddableConfig = p.embeddableConfig || {};
      p.embeddableConfig.enhancements = panelDrilldown(id, p.panelIndex, drillPanels.get(p.panelIndex));
      refs.push(...drilldownRefs(p.panelIndex, p.embeddableConfig.enhancements));
      drilled++;
    }
    obj.attributes.panelsJSON = JSON.stringify(panels);
    delete obj.attributes.controlGroupInput;
    obj.references = refs;
    await kb.importObjects([obj]);
    // Read it back: an import that dropped or re-ordered the `sections` attribute would leave the inner
    // panels orphaned on a sectionId nothing defines, and that renders, silently, as a different layout.
    const [back] = await kb.exportObjects([{ type: 'dashboard', id }]);
    checkSections(`${id} (after import)`, back, JSON.parse(back.attributes.panelsJSON), sections);
    if (intros !== Object.keys(introPanels).length) throw new Error(`${id}: ${intros} of ${Object.keys(introPanels).length} intro panels found in the export`);
    detail(`${id}: ${changed} vega re-pointed, ${intros} small-text panel(s), ${sections.length} section(s), ${CONTROLS.length} controls, ${drilled} drilldown(s)`);
    vegaTotal += changed;
    drillTotal += drilled;
  }
  return { vegaTotal, drillTotal };
}

/**
 * A suite dashboard this run does not deploy must not stay behind: its nav strip would
 * still list the old set, and a retired id still links to dashboards by their old ids. That is every
 * RETIRED_IDS entry (lib/suite.mjs: the pre-1.0.2 Command Center id cloud-audit-00-command-center and the
 * numbered pre-1.0.3 ids cloud-audit-<NN>-<name>), and Platform Volume when it is not opted in. Only those
 * exact ids are touched, and each is read first.
 */
async function removeStrays() {
  for (const id of strays()) {
    const r = await kb.sRaw(`/api/dashboards/${id}`, { method: 'GET' });
    if (r.status === 404) continue;
    const d = await kb.sRaw(`/api/dashboards/${id}`, { method: 'DELETE' });
    if (!d.ok && d.status !== 404) throw new Error(`could not remove stray dashboard ${id}: ${d.status}`);
    info(`removed ${id}: not in this deploy's set (retired id, or an opt-in left out)`);
  }
  // Earlier releases' data view. Removed only after every dashboard points at the current one.
  for (const id of RETIRED_DATA_VIEW_IDS.map(nsId)) {
    const status = await kb.deleteObject('index-pattern', id);
    if (status === 404) continue;
    if (status >= 300) throw new Error(`could not remove retired data view ${id}: ${status}`);
    info(`removed retired data view ${id}`);
  }
  // The numbered Vega and Discover ids of 1.0.5 and earlier (env.mjs, RETIRED_OBJECTS). Same rule: only
  // after every dashboard above has been re-pointed at the unnumbered id, so no panel is left dangling.
  let retired = 0;
  for (const { type, id } of RETIRED_OBJECTS()) {
    const status = await kb.deleteObject(type, id);
    if (status === 404) continue;
    if (status >= 300) throw new Error(`could not remove retired ${type} ${id}: ${status}`);
    retired++;
  }
  if (retired) info(`removed ${retired} retired numbered Vega/Discover id(s)`);
}

export async function run() {
  const all = emit();
  // The prior-period tiles read the events view, which --objects creates; without it they render an error.
  await requireView();
  // The suite's data view. No control names it since 1.0.5.2 (the classic Project and Client IP controls did,
  // which is why it is ensured before the first PUT), but it is a public id and still deploys with the suite.
  await kb.importObjects([dataViewObject()]);
  detail(`data view ${dataViewObject().id} ensured`);
  detail(`generated ${Object.keys(all).length} dashboard definitions`);

  for (const pass of [1, 2]) {
    for (const [name, def] of Object.entries(all)) {
      await kb.sPut(`/api/dashboards/${dashId(name)}`, payload(def));
    }
    if (pass === 1) info('pass 1 complete — creating dashboards');
  }
  for (const name of Object.keys(all)) detail(dashId(name));

  const { vegaTotal, drillTotal } = await applyImportOnlyState(all);
  success(`${Object.keys(all).length} dashboards deployed to the Default space`
    + ` (${vegaTotal} Vega re-pointed, ${CONTROLS.length} controls each, ${drillTotal} drilldowns)`);
  await removeStrays();
  info(`Open: ${cfg.kbs}/app/dashboards#/view/${dashId('00-command-center')}`);
}
