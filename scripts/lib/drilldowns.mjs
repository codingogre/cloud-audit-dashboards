/**
 * Panel drilldowns — into Actor 360 from everywhere else, and out of Actor 360 to the topic dashboards.
 *
 * Like the control bar, this is state `PUT /api/dashboards/{id}` silently drops, so it rides the
 * same _export -> mutate -> _import post-pass in scripts/dashboards.mjs.
 *
 * Shape verified empirically against Kibana 9.6.0 serverless: attach `enhancements.dynamicActions`
 * to a panel's embeddableConfig, import, export back. The structure survives verbatim, `dashboardId`
 * included, BUT that inline id is not what the dashboard app navigates by. On load Kibana injects
 * the target from a reference named `<panelIndex>:drilldown:DASHBOARD_TO_DASHBOARD_DRILLDOWN:
 * <eventId>:dashboardId`; with no such reference the target is blank and "Open in …" lands on an
 * empty `#/create` dashboard. Through 1.0.1 every suite drilldown did exactly that (clicked in
 * Playwright, 2026-10-15, on production and on a private deploy). drilldownRefs() supplies the
 * reference, and the inline id stays as well, matching what Kibana itself exports.
 *
 * FILTER_TRIGGER is the click-to-filter trigger, so the drilldown appears exactly where an
 * identity cell is already clickable. That is why it is attached only to panels carrying a
 * `click_filter` column: on any other panel the trigger never fires and the menu entry would be
 * dead weight.
 */
import { stableUuid } from './ids.mjs';
import { nsId } from './env.mjs';
import { SUITE, deployed, dashId } from './suite.mjs';

export const ACTOR_360 = dashId('07-actor-360');

/** Panels with at least one click-to-filter column are the ones a FILTER_TRIGGER can fire on. */
export const hasFilterableColumn = (panel) =>
  Array.isArray(panel.config?.rows) && panel.config.rows.some((r) => r && typeof r === 'object' && r.click_filter);

/**
 * The drilldown to splice onto one panel's embeddableConfig.
 * `useCurrentFilters` is what carries the clicked value through to the destination.
 *
 * Every dashboard's identity panels drill IN to Actor 360. Actor 360's own panels drill OUT, to the
 * dashboard that owns the dimension clicked — an action to Security & Anomalies, an address to Geo &
 * Network — because Actor 360 is where something is noticed and the topic dashboards are where it is
 * investigated. The Actor 360 seed carries no destination suffix, so adding outbound drilldowns did
 * not change the ids of the inbound ones.
 */
/** A drilldown reference name ends in this; the post-pass drops stale ones before re-adding. */
export const isDrilldownRef = (name) => /:drilldown:DASHBOARD_TO_DASHBOARD_DRILLDOWN:[^:]+:dashboardId$/.test(name);

/** The references Kibana resolves a panel's dashboard drilldowns through (see the header). */
export const drilldownRefs = (panelIndex, enhancements) => (enhancements?.dynamicActions?.events || [])
  .filter((ev) => ev.action?.factoryId === 'DASHBOARD_TO_DASHBOARD_DRILLDOWN')
  .map((ev) => ({ name: `${panelIndex}:drilldown:DASHBOARD_TO_DASHBOARD_DRILLDOWN:${ev.eventId}:dashboardId`, type: 'dashboard', id: ev.action.config.dashboardId }));

export function panelDrilldown(dashboardId, panelId, dest = ACTOR_360) {
  // Destinations are authored as the un-namespaced ids (rawId(), lib/suite.mjs); the default, ACTOR_360,
  // is already namespaced, and nsId() leaves a namespaced id alone.
  const destination = nsId(dest);
  // A drilldown to a dashboard this run does not deploy (an opt-in left out) would open "not found".
  if (!deployed().some((d) => nsId(d.id) === destination)) throw new Error(`drilldown ${dashboardId}/${panelId} -> ${destination}: not a deployed dashboard`);
  const label = SUITE.find((d) => nsId(d.id) === destination).label.replace(/^\S+\s+/, '');
  const seed = destination === ACTOR_360
    ? `cloud-audit-drilldown:${dashboardId}:${panelId}`
    : `cloud-audit-drilldown:${dashboardId}:${panelId}:${destination}`;
  return {
    dynamicActions: {
      events: [{
        eventId: stableUuid(seed),
        triggers: ['FILTER_TRIGGER'],
        action: {
          factoryId: 'DASHBOARD_TO_DASHBOARD_DRILLDOWN',
          name: `Open in ${label}`,
          config: {
            dashboardId: destination,
            useCurrentFilters: true,
            useCurrentDateRange: true,
            openInNewTab: false,
          },
        },
      }],
    },
  };
}
