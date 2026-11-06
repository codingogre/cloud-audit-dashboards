/**
 * Panel drilldowns — into Identity 360 from everywhere else, and out of Identity 360 to the topic dashboards.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nsId, objId, withStream, ROOT } from './env.mjs';
import { SUITE, deployed, dashId } from './suite.mjs';

export const ACTOR_360 = dashId('07-actor-360');

/** Panels with at least one click-to-filter column are the ones a FILTER_TRIGGER can fire on. */
export const hasFilterableColumn = (panel) =>
  Array.isArray(panel.config?.rows) && panel.config.rows.some((r) => r && typeof r === 'object' && r.click_filter);

/**
 * The drilldown to splice onto one panel's embeddableConfig.
 * `useCurrentFilters` is what carries the clicked value through to the destination.
 *
 * Every dashboard's identity panels drill IN to Identity 360. Identity 360's own panels drill OUT, to the
 * dashboard that owns the dimension clicked — an action to Security & Anomalies, an address to Geo &
 * Network — because Identity 360 is where something is noticed and the topic dashboards are where it is
 * investigated. The Identity 360 seed carries no destination suffix, so adding outbound drilldowns did
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

/**
 * OPEN IN DISCOVER (1.0.7.2). A record panel names the Discover session that holds the same records, with
 * Discover's columns, paging and cell filters; the session keeps its own LIMIT (`discover: '<searches ref>'`, kept on the in-memory definition and stripped from the payload, like
 * `drill`; openIn() in shared.mjs sets it). The post-pass gives that panel a URL drilldown on the panel menu
 * (CONTEXT_MENU_TRIGGER: the ⋯ menu, beside Settings, not a cell click), which opens the session in the same tab
 * (openInNewTab false, as every suite drilldown and Kibana itself) with the dashboard's CURRENT state, from Kibana's
 * URL drilldown context:
 *
 *   time     `_g=(time:…)`, context.panel.timeRange: the panel's window (the picker's, or a fixed panel's own)
 *   pills    as ES|QL. Discover in ES|QL mode IGNORES filter pills: probed on 9.6 serverless, a session opened with
 *            event.action: saved_object_create in `_a` or in `_g` still listed 10,000 events of every kind, and no
 *            ES|QL request carried the filter. So each enabled pill that is a phrase on one field (every table
 *            cell's, and the timeline's `session:` pill) becomes `| WHERE \`field\` == "value"` (NOT … when
 *            negated), written straight after the session's FROM, where the raw fields still exist
 *   KQL      the query bar's text, the same way, as `| WHERE KQL("""…""")`
 *
 * With no pills and no KQL the query is the session's own, so Discover shows it unmodified. Not carried: the four
 * dropdowns (ES|QL variables; no session reads them), and a pill that is not a single-field phrase (the treemap's
 * identity pill, a range, an "exists"): those are left out, as the README says. The session text is the deployed one
 * (withStream), rison-quoted around the template's own blocks; a pill value holding ' or ! would break the rison
 * string (none of the suite's click fields holds one). The value is read with `lookup`, not `{{this}}`: Kibana's
 * handlebars fails on a string `this` ("Cannot use 'in' operator … in saved_object_create") and then hides the menu
 * entry altogether (probed on 9.6 serverless).
 *
 * A panel scoped by a dropdown alone (07's whole page is the Identity dropdown) opens every identity's records: such a
 * panel names its link (`discoverName`, openInByTitle's third argument) so the menu says the dropdown is not carried.
 *
 * Relative to `kibanaUrl` (the Default space's base), so no URL is committed; the session id goes through objId(), so
 * a private copy (AUDIT_ID_NS) opens its own sessions.
 */
export const DISCOVER_ACTION = 'Open in Discover';
const risonText = (t) => t.replace(/!/g, '!!').replace(/'/g, "!'");
/** Fixed template text: rison-quoted, then URL-encoded here (the drilldown runs with encodeUrl false). */
const enc = (t) => encodeURIComponent(risonText(t));
/**
 * A value read at click time, through Kibana's own URL-drilldown helpers: made a string (`concat`, so a number or an
 * ip does not throw in `replace`), `"` escaped for a KQL phrase when `kql`, rison-quoted (! then '), URL-encoded.
 * Handlebars' single-quoted literal '\"' is the two characters \" (only \' is unescaped there).
 */
const val = (expr, kql = false) => {
  const s = kql ? `(replace (concat ${expr}) '"' '\\"')` : `(concat ${expr})`;
  return `{{{encodeURIComponent (replace (replace ${s} "!" "!!") "'" "!'")}}}`;
};
/**
 * Each enabled phrase pill as `WHERE KQL("""field:"value" """)`, `NOT KQL(…)` when it excludes: the pill's own
 * semantics, so a multi-valued field matches on any one value and an excluding pill keeps the events where the field is
 * missing. `==` did neither (measured live: a multi-value index pill 0 rows against 1,972; NOT kibana.space.id 0 against
 * 96,247), and KQL pushes down to Lucene, so it costs less than the unfiltered session.
 */
export const PILLS_AS_ESQL =
  '{{#each context.panel.filters}}{{#unless meta.disabled}}{{#each query.match_phrase}}' + enc(' | WHERE ') +
  '{{#if ../meta.negate}}' + enc('NOT ') + '{{/if}}' + enc('KQL("""') + '{{{encodeURIComponent @key}}}' + enc(':"') +
  val('(lookup ../query.match_phrase @key)', true) + enc('" """)') + '{{/each}}{{/unless}}{{/each}}' +
  '{{#if context.panel.query.query}}' + enc(' | WHERE KQL("""') + val('context.panel.query.query') + enc('""")') + '{{/if}}';
export const discoverTemplate = (searchId, esql) => {
  const m = /^(.*?\bFROM\s+\S+)(\s+\|.*)$/s.exec(esql);
  if (!m) throw new Error(`${searchId}: no "FROM <stream> |" to put the dashboard's pills after`);
  if (/\{\{|\}\}/.test(esql)) throw new Error(`${searchId}: the query holds "{{" or "}}", which the URL template would read`);
  return `{{kibanaUrl}}/app/discover#/view/${searchId}?_g=(time:{{rison context.panel.timeRange}})` +
    `&_a=(query:(esql:'${enc(m[1])}${PILLS_AS_ESQL}${enc(m[2])}'))`;
};
export function discoverDrilldown(dashboardId, panelId, ref, name = DISCOVER_ACTION) {
  const searchId = objId('search', ref);
  const { esql } = JSON.parse(withStream(readFileSync(join(ROOT, 'searches', `${ref}.json`), 'utf8')));
  return {
    eventId: stableUuid(`cloud-audit-discover:${dashboardId}:${panelId}:${searchId}`),
    triggers: ['CONTEXT_MENU_TRIGGER'],
    action: {
      factoryId: 'URL_DRILLDOWN',
      name,
      config: { url: { template: discoverTemplate(searchId, esql) }, openInNewTab: false, encodeUrl: false },
    },
  };
}
/** One panel's enhancements: its Identity 360 / topic drilldown (FILTER_TRIGGER) and its Open in Discover link. */
export function panelEnhancements(dashboardId, panelId, { dest, discover, discoverName } = {}) {
  const events = [
    ...(dest ? panelDrilldown(dashboardId, panelId, dest).dynamicActions.events : []),
    ...(discover ? [discoverDrilldown(dashboardId, panelId, discover, discoverName)] : []),
  ];
  return events.length ? { dynamicActions: { events } } : null;
}
