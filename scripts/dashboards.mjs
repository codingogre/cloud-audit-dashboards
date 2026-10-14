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
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT, nsId } from './lib/env.mjs';
import { kb } from './lib/http.mjs';
import { success, detail, info } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { controlGroup, dataViewObject, isControlRef, CONTROLS } from './lib/controls.mjs';
import { panelDrilldown, hasFilterableColumn, ACTOR_360 } from './lib/drilldowns.mjs';
import { checkLayout } from './lib/layout.mjs';

/**
 * The Dashboards API payload: the definitions minus the in-memory annotations the post-pass reads.
 * `PUT /api/dashboards/{id}` is Zod-strict, so a panel's `drill` destination cannot ride along — it is
 * kept on the in-memory definition for applyImportOnlyState() and stripped here, which is also what
 * gets written to dashboards/*.json, since those files are the payload as sent.
 */
const payload = (def) => ({ ...def, panels: def.panels.map(({ drill, ...p }) => p) });

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
    const id = nsId(`cloud-audit-${name}`);
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
    let refs = (obj.references || []).filter((r) => !isControlRef(r.name));
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

    let drilled = 0;
    for (const p of panels) {
      if (!drillPanels.has(p.panelIndex)) continue;
      p.embeddableConfig = p.embeddableConfig || {};
      p.embeddableConfig.enhancements = panelDrilldown(id, p.panelIndex, drillPanels.get(p.panelIndex));
      drilled++;
    }
    obj.attributes.panelsJSON = JSON.stringify(panels);
    obj.attributes.controlGroupInput = controlGroupInput;
    obj.references = [...refs, ...controlRefs];
    await kb.importObjects([obj]);
    detail(`${id}: ${changed} vega re-pointed, ${CONTROLS.length} controls, ${drilled} drilldown(s)`);
    vegaTotal += changed;
    drillTotal += drilled;
  }
  return { vegaTotal, drillTotal };
}

export async function run() {
  const all = emit();
  detail(`generated ${Object.keys(all).length} dashboard definitions`);

  for (const pass of [1, 2]) {
    for (const [name, def] of Object.entries(all)) {
      await kb.sPut(`/api/dashboards/${nsId(`cloud-audit-${name}`)}`, payload(def));
    }
    if (pass === 1) info('pass 1 complete — creating dashboards');
  }
  for (const name of Object.keys(all)) detail(nsId(`cloud-audit-${name}`));

  const { vegaTotal, drillTotal } = await applyImportOnlyState(all);
  success(`${Object.keys(all).length} dashboards deployed to space "${cfg.space}"`
    + ` (${vegaTotal} Vega re-pointed, ${CONTROLS.length} controls each, ${drillTotal} drilldowns)`);
  info(`Open: ${cfg.kbs}/app/dashboards#/view/${nsId('cloud-audit-00-command-center')}`);
}
