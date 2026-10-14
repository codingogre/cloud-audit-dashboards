/** 07 Actor 360 — see scripts/lib/definitions.mjs for how the suite is assembled. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../env.mjs';
import {
  IDX, TIME, CRED, INDEX_FAMILY, indexFamily, dash, kpi, table, vega, search, md, section, row, stack, resetIds, sized, filterable,
} from '../panels.mjs';
import { riskScored, CHANGED, CHANGED_KEYS, CHANGED_DERIVE } from './shared.mjs';

/**
 * One identity's whole footprint on one page — pick a person in the control bar and every panel
 * becomes their story. With nobody selected it is the whole estate, which is a useful "who is here"
 * view in its own right.
 *
 * The page is organised around TIME BINDING (see panels.mjs), because it mixes both kinds and a
 * reader has to know which window each panel shows:
 *
 *   ① Is this normal?   fixed 7 days — DSL Vega, which keeps the control-bar filters but ignores
 *                        the picker, so a baseline and a weekly rhythm are possible on a now-1h page
 *   ② What they did     follows the time picker
 *   ③ Evidence          a 24-hour session timeline over the raw records
 *
 * No panel here groups by the actor COALESCE: that is the shape that goes slow unfiltered, and on a
 * page already about one identity the resolution ladder buys nothing. Identity panels group on the
 * real attributes.user.email instead, which is also the only thing a filter pill can match.
 */

/** The tooltip for a Vega panel is its spec's own description — one source, so they cannot disagree. */
const specDescription = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8')).description;
const vegaPanel = (ref, title) => (x, y, w, h) => vega(x, y, w, h, ref, title, specDescription(ref));

/** Out to the topic dashboard that owns the dimension clicked. Stripped before the API sees it. */
const drillTo = (destination, panel) => Object.assign(panel, { drill: destination });

/**
 * `*`, `-*` and `syn-*` arrive in the indices field as REQUEST PATTERNS, not indices — and so does
 * date math: the SLO writer names `<.slo-observability.sli-v3.6.{2026-10-13||/d{yyyy-MM-dd|UTC}}>`,
 * one distinct string per day, which no fold recognises. Each one counted as a family of its own (7 of
 * the 54 on the review render) beside the real dated indices it resolves to, which are already there.
 * Applied to the grouped rows (after a STATS), never per document, so it costs nothing.
 */
const isPattern = (col) => `LOCATE(${col}, "*") > 0 OR STARTS_WITH(${col}, "<")`;
const NOT_PATTERN = `WHERE NOT (${isPattern('attributes.elasticsearch.audit.indices')})`;

/**
 * One paragraph with a bold lead rather than a `####` heading over a paragraph: markdown renders
 * `####` at bold body size, which sat visibly SMALLER than the 16px paragraph under it — an inverted
 * hierarchy in the first thing on the page. The section bands below carry the real headings.
 *
 * The clock is named here because the page mixes two: section ① is computed in UTC (a weekly rhythm
 * has to read the same for every viewer), while every table timestamp and the session timeline are in
 * the browser's zone like the rest of Kibana. Side by side they disagree by the viewer's UTC offset,
 * and nothing else on the page says which is which.
 */
const ORIENTATION = `👤 **Pick a person in the control bar** and every panel becomes their story; with nobody selected it describes the whole estate. **① Is this normal?** reads a fixed 7 days in UTC, whatever the time picker says · **② What they did** follows the picker · **③ Evidence** ends in the raw records. Table times and the session timeline are in your time zone.`;

export function build() {
  resetIds();
  const P = stack([
    row(3, [[48, (x, y, w, h) => md(x, y, w, h, ORIENTATION)]]),

    row(7, [
      [16, (x, y, w, h) => table(x, y, w, h, 'Who this is',
        `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS events = COUNT(*), keys = COUNT_DISTINCT(attributes.api_key.name, 100) BY attributes.user.email | SORT events DESC | LIMIT 10`,
        [filterable('attributes.user.email')], ['events', 'keys'],
        'The people in range, busiest first — click an email to pin that identity across the suite. Counts only events that carry a user email, so with nobody selected the total here is less than the Events tile: API-key and service traffic with no email behind it has nothing to group on. `API keys` counts the API keys acting under that email: Elasticsearch stamps a key\'s CREATOR on every event the key emits, so a person with keys may be carrying a machine\'s traffic.')],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | STATS Events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action, 100), last_ts = MAX(@timestamp) | EVAL mins = DATE_DIFF("minutes", last_ts, NOW()) | EVAL detail = CASE(Events == 0, "no activity", CONCAT(TO_STRING(actions), CASE(actions == 1, " action", " actions"), " · ", CASE(mins < 1, "seen just now", mins < 60, CONCAT("seen ", TO_STRING(mins), "m ago"), CONCAT("seen ", TO_STRING(mins / 60), "h ago")))) | KEEP Events, detail`,
        'Events', 'Every audited event for the selection, how many different things that was, and how recently they were last seen. Unfiltered by the noise gate, so it includes connection housekeeping.',
        { secondary: 'detail' })],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | ${riskScored()} | STATS Risk = SUM(risk * n), worst = MAX(risk) | EVAL detail = CASE(worst IS NULL, "nothing scored", CONCAT("worst: ", CASE(worst == 50, "config change", worst == 45, "keys invalidated", worst == 40, "failure", worst == 35, "anonymous denied", worst == 30, "destructive change", worst == 25, "Kibana change", "execution"))), Risk = COALESCE(Risk, 0) | KEEP Risk, detail`,
        'Risk', 'Summed severity of everything that scored, and what the single worst-weighted event was. Routine activity scores zero, so this is not an event count in disguise; the receipts are in "Everything that scored" below.',
        { secondary: 'detail' })],
      // Families, not raw names, so the tile counts the same thing as "What they read, by index family"
      // below: a raw count put every dated daily index and its .ds- backing index in separately, and
      // counted request patterns like `*`, `-*` and date math as indices. VALUES first keeps the scan a
      // single keyword aggregation — the fold runs over the handful of distinct names, not documents.
      // Measured against the raw COUNT_DISTINCT it replaced: 55ms vs 50ms at 1h, 57ms vs 52ms at 24h.
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | STATS idx = VALUES(attributes.elasticsearch.audit.indices), spaces = COUNT_DISTINCT(attributes.kibana.space.id, 100), sessions = COUNT_DISTINCT(attributes.kibana.session.id, 100) | MV_EXPAND idx | EVAL family = CASE(${isPattern('idx')}, null, ${indexFamily('idx')}) | STATS \`Index families\` = COUNT_DISTINCT(family), spaces = MAX(spaces), sessions = MAX(sessions) | EVAL detail = CONCAT(TO_STRING(spaces), CASE(spaces == 1, " Kibana space · ", " Kibana spaces · "), TO_STRING(sessions), CASE(sessions == 1, " session", " sessions")) | KEEP \`Index families\`, detail`,
        'Index families', 'The width of their reach: index families named in their requests, the Kibana spaces worked in, and browser sessions. A family folds dated daily indices and data-stream backing indices together, as "What they read, by index family" does, so one dashboard reading thirty days of a daily index is one family. Request patterns such as * and date-math names are not counted.',
        { secondary: 'detail' })],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | ${CRED} | STATS \`Client IPs\` = COUNT_DISTINCT(client.ip), countries = COUNT_DISTINCT(client.geo.country_iso_code, 100), creds = VALUES(credential) | EVAL detail = CONCAT(TO_STRING(countries), CASE(countries == 1, " country · ", " countries · "), CASE(MV_COUNT(creds) == 1, creds, CONCAT(TO_STRING(MV_COUNT(creds)), " credential kinds"))) | KEEP \`Client IPs\`, detail`,
        'Client IPs', 'Distinct real client addresses, resolved countries, and how they authenticated — authentication type where Elasticsearch records one, realm otherwise. Many addresses for one named person is the shared-credential signal; private and CGNAT addresses cannot be placed in a country at all.',
        { secondary: 'detail' })],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '① Is this normal?', 'fixed 7-day window in UTC — ignores the time picker')]]),
    row(14, [
      [20, vegaPanel('08-actor-baseline-band', 'Is this normal for them? — hourly, last 7 days (UTC)')],
      [12, vegaPanel('12-actor-cohort', 'Where they rank among the busiest — last 7 days')],
      [16, vegaPanel('09-activity-punchcard', 'Working rhythm — last 7 days (UTC)')],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '② What they did', 'follows the time picker · times in your time zone')]]),
    row(11, [[48, vegaPanel('11-actor-object-flow', 'How they reached what they touched in Kibana — credential → space → object → operation')]]),
    row(12, [[48, (x, y, w, h) => table(x, y, w, h, '⚠️ What they changed',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY ${CHANGED_KEYS}, obj_name, execution, space = attributes.kibana.space.id, result | ${CHANGED_DERIVE} | STATS events = SUM(n), last_seen = MAX(last_ts) BY verb, type = obj_type, name = obj_name, execution, space, result | SORT last_seen DESC | LIMIT 25`,
      // Space is a free-form id, so it gets room for one ('syn-marketing' filled 110px edge to edge).
      ['verb', sized('type', 200), sized('name', 430), sized('execution', 110), sized('space', 170), sized('result', 120)],
      ['events', 'last_seen'],
      'Everything they changed, ran or deleted in Kibana — newest first. `type` and `name` are the real saved-object fields where Kibana records them, and are otherwise recovered from the event message: workflows, agent-builder agents and tools, ML jobs and secrets carry no saved_object fields at all. `execution` is the first 8 characters of the run id on workflow run/test/cancel events, and "—" everywhere else — a cancel and the run it cancelled share that id; the full id is in the session records at the bottom of the page. `result` reads "attempted" where Kibana logged the attempt rather than the outcome; "failure" is a change that was denied.')]]),
    row(11, [
      // A table, not a bar chart. The audit stream itself (every dashboard on this page reads it) is
      // routinely 10x the next family, so on a linear axis the rest of the ranking were 1-2px slivers
      // that read as zero; and Lens hides a bar's value label when it does not fit inside the bar, so
      // `values: true` labelled only the two bars that needed it least. The ranking is the point, and
      // a sorted count column carries it at any spread and at any volume.
      [18, (x, y, w, h) => table(x, y, w, h, 'What they read, by index family',
        `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | STATS n = COUNT(*) BY attributes.elasticsearch.audit.indices | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT(*) BY family | SORT events DESC | LIMIT 12`,
        [{ column: 'family', label: 'Index family' }], ['indices', 'events'],
        'Where their reads concentrate, busiest first. Dated daily indices and data-stream backing indices are folded into the family they belong to, so a date-suffixed series is one row and `Indices` says how many of its members were read. A request naming several indices counts once per index; request patterns such as * and date-math names are left out. The audit stream itself usually tops the list, because every dashboard on this page reads it.')],
      [30, (x, y, w, h) => drillTo('cloud-audit-03-data-access', table(x, y, w, h, '⚠️ System and hidden index reads',
        `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | WHERE attributes.elasticsearch.audit.indices LIKE ".*" AND NOT attributes.elasticsearch.audit.indices LIKE ".ds-*" | STATS n = COUNT(*), seen = MAX(@timestamp) BY attributes.elasticsearch.audit.indices, action = attributes.elasticsearch.audit.action | EVAL family = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT_DISTINCT(attributes.elasticsearch.audit.indices), actions = COUNT_DISTINCT(action), last_seen = MAX(seen), \`attributes.elasticsearch.audit.indices\` = MIN(attributes.elasticsearch.audit.indices) BY family | SORT events DESC | LIMIT 20`,
        // Unsized: every metric has a role width, so the index takes the rest of the panel. A fixed 420
        // here starved the metrics and clipped Last seen at the panel edge.
        [filterable('attributes.elasticsearch.audit.indices')], ['indices', 'actions', 'events', 'last_seen'],
        'Dot-prefixed indices — system and hidden — that their requests named, one row per index family: daily indices of the same stream are folded together and `indices` says how many were touched. The index shown is one real member of the family, which is what a click pins; then "Open in Elasticsearch Data Access" to see who else reads it. Data-stream backing indices (.ds-*) are left out; they are ordinary data.'))],
    ]),
    row(12, [
      [24, vegaPanel('10-actor-geography', 'Where they connected from')],
      [24, (x, y, w, h) => drillTo('cloud-audit-05-geo-network', table(x, y, w, h, 'Every address they used',
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY client.ip, city = client.geo.city_name, country = client.geo.country_name | EVAL city = COALESCE(city, CASE(country IS NULL, "unplaced", "—")), country = COALESCE(country, "unplaced") | SORT events DESC | LIMIT 25`,
        [filterable('client.ip'), 'city', 'country'], ['events', 'last_seen'],
        'Every real client address, including the ones the map cannot show: "unplaced" means geoip could not place it, which is always the case for a private or CGNAT address, and "—" is a country with no city. Click an address to pin it, then "Open in Geo & Network".'))],
    ]),
    row(10, [[48, (x, y, w, h) => drillTo('cloud-audit-04-security-anomalies', table(x, y, w, h, 'Everything that scored, with its weight',
      `FROM ${IDX} | ${TIME} | ${riskScored({ aggs: 'last_ts = MAX(@timestamp)' })} | STATS events = SUM(n), severity = SUM(risk * n), last_seen = MAX(last_ts) BY attributes.event.action, weight = risk | SORT severity DESC | LIMIT 25`,
      // weight is a number, so it reads as one (right-aligned, beside the other numbers); it stays in the
      // BY clause, so the grouping is unchanged.
      [filterable('attributes.event.action')], ['weight', 'events', 'severity', 'last_seen'],
      'The receipts behind the Risk tile: exactly which actions carried a weight, what each weighed, how often, and when last. Click an action to pin it, then "Open in Security & Anomalies" to see who else does it — the pinned person and action combine, so clear the person pill first to compare.'))]]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '③ Evidence', 'session timeline is fixed at 24 hours · the records follow the time picker · your time zone')]]),
    row(9, [[48, vegaPanel('13-session-gantt', 'Kibana sessions — last 24 hours, your time zone')]]),
    row(12, [[48, (x, y, w, h) => search(x, y, w, h, '09-session-reconstruction', 'Session records',
      'The raw Kibana events behind every panel above, newest first, with full session and object ids and the message Kibana wrote.')]]),
  ]);
  return dash('cloud-audit-07-actor-360', '[Audit] 👤 Actor 360',
    'One identity’s complete footprint — pick a person in the control bar and every panel becomes their story.', P);
}
