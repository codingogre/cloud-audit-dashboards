/**
 * Panel drilldowns — into Actor 360 from everywhere else, and out of Actor 360 to the topic dashboards.
 *
 * Like the control bar, this is state `PUT /api/dashboards/{id}` silently drops, so it rides the
 * same _export -> mutate -> _import post-pass in scripts/dashboards.mjs.
 *
 * Shape verified empirically against Kibana 9.6.0 serverless: attach `enhancements.dynamicActions`
 * to a panel's embeddableConfig, import, export back. The whole structure survives verbatim and —
 * unlike the control group's data view — `dashboardId` stays INLINE in config; Kibana extracts no
 * reference for it, so there is nothing extra to add to `references`.
 *
 * FILTER_TRIGGER is the click-to-filter trigger, so the drilldown appears exactly where an
 * identity cell is already clickable. That is why it is attached only to panels carrying a
 * `click_filter` column: on any other panel the trigger never fires and the menu entry would be
 * dead weight.
 */
import { stableUuid } from './ids.mjs';
import { DASH } from './panels.mjs';

export const ACTOR_360 = 'cloud-audit-07-actor-360';

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
export function panelDrilldown(dashboardId, panelId, destination = ACTOR_360) {
  const label = DASH.find(([id]) => id === destination)?.[1].replace(/^\S+\s+/, '') || 'Actor 360';
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
