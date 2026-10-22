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
 *   2. The control bar. `PUT /api/dashboards/{id}` is Zod-strict and silently drops
 *      `controlGroupInput` — it does not error, it just returns a dashboard without it.
 *
 * Both are repaired the same way, in ONE _export -> mutate -> _import round trip per
 * dashboard. Note the ordering constraint: the PUT passes above wipe both every time, so
 * this post-pass is not an install step, it is part of every deploy.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT, nsId } from './lib/env.mjs';
import { dashId, strays, SUITE } from './lib/suite.mjs';
import { kb } from './lib/http.mjs';
import { success, detail, info } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { controlGroup, dataViewObject, isControlRef, CONTROLS, RETIRED_DATA_VIEW_IDS } from './lib/controls.mjs';
import { panelDrilldown, hasFilterableColumn, ACTOR_360, drilldownRefs, isDrilldownRef } from './lib/drilldowns.mjs';
import { checkLayout } from './lib/layout.mjs';
import { smallMarkdown } from './lib/panels.mjs';

/**
 * The Dashboards API payload: the definitions minus the in-memory annotations the post-pass and the
 * layout check read. `PUT /api/dashboards/{id}` is Zod-strict, so a panel's `drill` destination and
 * table()'s `narrow1440` flag and the `lint` annotation (table(), search()) cannot ride along — they are kept on the in-memory definition and
 * stripped here, which is also what gets written to dashboards/*.json, since those files are the
 * payload as sent.
 */
const payload = (def) => ({ ...def, panels: def.panels.map(({ drill, narrow1440, lint, headed, ...p }) => p) });

/** Write the generated definitions to disk so they are diffable in review. */
export function emit() {
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

async function applyImportOnlyState(all) {
  const { controlGroupInput, references: controlRefs } = controlGroup();

  // Imported defensively rather than relying on `--objects` having run: a dashboard whose
  // controlGroup reference points at a missing data view imports clean and then renders an
  // empty control bar, which is worse than failing.
  await kb.importObjects([dataViewObject()]);
  detail(`data view ${dataViewObject().id} ensured`);

  let vegaTotal = 0;
  let drillTotal = 0;
  for (const [name, def] of Object.entries(all)) {
    const id = dashId(name);
    const introPanels = Object.fromEntries(def.panels.filter((p) => p.headed).map((p) => [p.id, p.config.content]));
    const vegaPanels = Object.fromEntries(
      def.panels.filter((p) => p.type === 'vis' && p.config?.ref_id).map((p) => [p.id, p.config.ref_id]));
    // Drilldowns fire on FILTER_TRIGGER, so they belong only on panels that already carry a
    // click-to-filter column. Everywhere else drills IN to Actor 360; Actor 360's panels drill OUT
    // only where a panel names its destination — drilling from it to itself would be a no-op.
    const drillPanels = new Map(def.panels.filter(hasFilterableColumn)
      .map((p) => [p.id, id === ACTOR_360 ? p.drill : ACTOR_360]).filter(([, dest]) => dest));

    const [obj] = await kb.exportObjects([{ type: 'dashboard', id }]);
    const panels = JSON.parse(obj.attributes.panelsJSON);
    // Drop any control references from a previous deploy before re-adding, or each run
    // appends a duplicate set and the import eventually rejects the object.
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
    obj.attributes.controlGroupInput = controlGroupInput;
    obj.references = [...refs, ...controlRefs];
    await kb.importObjects([obj]);
    if (intros !== Object.keys(introPanels).length) throw new Error(`${id}: ${intros} of ${Object.keys(introPanels).length} intro panels found in the export`);
    detail(`${id}: ${changed} vega re-pointed, ${intros} intro(s), ${CONTROLS.length} controls, ${drilled} drilldown(s)`);
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
}

export async function run() {
  const all = emit();
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
