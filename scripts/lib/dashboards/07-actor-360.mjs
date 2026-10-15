/** 07 Actor 360 — see scripts/lib/definitions.mjs for how the suite is assembled. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../env.mjs';
import {
  IDX, TIME, INDEX_FAMILY, IP_GEO, indexFamily, dash, kpi, table, vega, search, md, section, row, stack, resetIds, sized, filterable, grouped,
  SYS_INDEX, fitRows
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
 * The two index tables in ② count the SAME reads, so every dot-prefixed family in "What they read" is a
 * row of "System and hidden index reads" with the same Events and Indices (round-4 review: a family at
 * 283 events on the left was missing on the right, because the left folded its `.ds-.alerts-…` backing
 * index in and the right dropped every `.ds-*`; the right also listed request patterns the left drops).
 * Both now leave out request patterns and shard/node fan-out (`search[phase/query]`, `bulk[s][p]` …, the
 * action half of SYS_INDEX, which repeats a top-level request already audited with the same index), and
 * the right selects with SYS_INDEX — the definition 03 uses — so a dot-named stream's backing index
 * counts with its family. NOT_FANOUT is a boolean on a raw keyword, cheap per event (QUERY SHAPE rule 1).
 */
const NOT_FANOUT = '(attributes.elasticsearch.audit.action IS NULL OR NOT attributes.elasticsearch.audit.action LIKE "*[*")';

/**
 * What each RISK weight means, in words, for the receipts table's "Why it scored" column. The Risk tile
 * names its worst weight as the NUMBER, which this column sits beside: a tile subtitle holds ~22
 * characters at a 1440px viewport, and "worst: security config change" after a count was cut there. A
 * seven-branch CASE, so it runs on the grouped rows of riskScored() — a handful per (action, weight) —
 * never per event.
 */
const WEIGHT_WORDS = [[50, 'security config change'], [45, 'API keys invalidated'], [40, 'failed or denied'],
  [35, 'anonymous request denied'], [30, 'destructive Kibana change'], [25, 'Kibana change'], [10, 'workflow execution']];
const weightWords = (col) => `CASE(${WEIGHT_WORDS.map(([w, words]) => `${col} == ${w}, "${words}"`).join(', ')}, "scored")`;

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
const ORIENTATION = `👤 **Pick a person in the control bar** and every panel becomes their story; with nobody selected it is the whole estate. **① Is this normal?** is a fixed 7 days in UTC · **② What they did** follows the time picker · **③ Evidence** ends in the raw records. Table times and the session timeline are in your time zone.`;

/**
 * Why the Risk tile and the scoring table can disagree on a live stream, measured rather than guessed.
 * Over one window the two queries agree to the event (probed directly: 21,820 = 21,820 over 9 rows at
 * 1h, 411,675 = 411,675 over 43 rows at 24h). But Kibana resolves a relative range per PANEL, when that
 * panel fetches — request params captured in the browser: the table asked for 23:25:57.535–00:25:57.535
 * and the tile for 23:25:58.133–00:25:58.133, and 1.0s apart on a later load — and the newest seconds of
 * the stream are still arriving: a 5-second window that held 0 events when it closed held 161 45 seconds
 * later. So the later panel sees events the earlier one did not, and the earlier one keeps events that
 * have aged out for the later one. At an ordinary rate that is one event or none (the round-3 render's
 * "exactly 30 short" was one delete); during a burst — this repo's own deploy and render traffic creates
 * saved objects by the hundred — it reached 530 of 47,205. No query can pin another panel's "now", so the
 * table puts the difference in the first sentence of its description and both name it.
 *
 * Re-measured in round 5, because a review read "30 off with every row visible" as a defect in the
 * receipt: the browser sent the tile 02:19:07.524 and the table 02:19:06.868 as `?_tend` (0.66s apart;
 * 0.77s on the next load); the page showed Sum 521,410; both queries re-run on EITHER captured window
 * 30 seconds later returned 521,480 for both, tile and table alike. So the receipt is complete and the
 * two queries are equal; what moves is the stream itself — a closed two-minute window kept growing for
 * 5–7 seconds after it closed (3,005 → 3,025 Elasticsearch events) — and a 30 is one delete landing in
 * that gap. The fix is to end both windows short of the live edge, which is the suite-wide "trim to
 * now-1m" question left to the human; until then the table's TITLE says the Sum can trail the tile, so
 * the explanation is on the surface rather than only in a tooltip.
 */
const RACE_NOTE = "Kibana reads 'now' separately for each panel when it fetches (about a second apart here), and the newest seconds of the stream are still arriving, so on a relative range the Risk tile and the scoring table can differ by the events that landed or aged out in between: usually none or one, more during a burst of activity. Over the same window the two queries agree to the event; an absolute range that ends a minute or more in the past makes them identical.";

export function build() {
  resetIds();
  const P = stack([
    row(3, [[48, (x, y, w, h) => md(x, y, w, h, ORIENTATION)]]),

    row(7, [
      [16, (x, y, w, h) => table(x, y, w, h, 'Who this is — people, by email',
        `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS events = COUNT(*), keys = COUNT_DISTINCT(attributes.api_key.name, 100) BY attributes.user.email | SORT events DESC | LIMIT 10`,
        [filterable('attributes.user.email')], ['events', { column: 'keys', label: 'Own API keys' }],
        'People only: counts only events that carry a user email, so an organization-level Cloud API key (`_4KEO… · Cloud API key`), which belongs to no person, is never a row here even when it is the busiest credential in the flow below; and with nobody selected these rows add up to far less than the Events tile: API-key and service traffic with no email behind it has nothing to group on here, and is counted in the tile. The people in range, busiest first — click an email to pin that identity across the suite. `Own API keys` counts the named API keys acting under that email: Elasticsearch stamps a key\'s CREATOR on every event the key emits, so a person with keys may be carrying a machine\'s traffic. It reads 0 beside API-key credentials in the flow below when that key traffic carries no email.')],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | STATS Events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action, 100), last_ts = MAX(@timestamp) | EVAL mins = DATE_DIFF("minutes", last_ts, NOW()) | EVAL detail = CASE(Events == 0, "no activity", CONCAT(${grouped('actions')}, CASE(actions == 1, " action", " actions"), " · ", CASE(mins < 1, "just now", mins < 60, CONCAT(${grouped('mins')}, "m ago"), CONCAT(TO_STRING(mins / 60), "h ago")))) | KEEP Events, detail`,
        'Events', 'Every audited event for the selection, how many different things that was, and how recently they were last seen. Unfiltered by the noise gate, so it includes connection housekeeping.',
        { secondary: 'detail' })],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | ${riskScored()} | STATS sev = SUM(risk * n) BY attributes.event.action, risk | STATS Risk = SUM(sev), worst = MAX(risk), kinds = COUNT(*) | EVAL detail = CASE(worst IS NULL, "nothing scored", CONCAT(${grouped('kinds')}, CASE(kinds == 1, " action · worst ", " actions · worst "), ${grouped('worst')})), Risk = COALESCE(Risk, 0) | KEEP Risk, detail`,
        'Risk', 'Summed severity (weight × events) of everything that scored, how many scoring actions that was, and the highest weight among them (50 is a security config change; the table below names every weight in words). Routine activity scores zero, so this is not an event count in disguise. The receipts are in "Every scoring action" below: one row per action and weight, scrollable, and the Sum under its Risk column is this number; the count here is its number of rows. An action that scored at two weights (a create that succeeded, and one that failed) counts twice, as it is two rows there. ' + RACE_NOTE,
        { secondary: 'detail' })],
      // Families, not raw names, so the tile counts the same thing as "What they read, by index family"
      // below: a raw count put every dated daily index and its .ds- backing index in separately, and
      // counted request patterns like `*`, `-*` and date math as indices. VALUES first keeps the scan a
      // single keyword aggregation — the fold runs over the handful of distinct names, not documents.
      // Measured against the raw COUNT_DISTINCT it replaced: 55ms vs 50ms at 1h, 57ms vs 52ms at 24h.
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | STATS idx = VALUES(attributes.elasticsearch.audit.indices) | MV_EXPAND idx | EVAL name = CASE(${isPattern('idx')}, null, idx) | EVAL family = ${indexFamily('name')} | STATS \`Index families\` = COUNT_DISTINCT(family), names = COUNT_DISTINCT(name) | EVAL detail = CASE(names == 0, "no index named", CONCAT("from ", ${grouped('names')}, CASE(names == 1, " index", " indices"))) | KEEP \`Index families\`, detail`,
        'Index families', 'The width of their reach in Elasticsearch: index families named in their requests, and how many distinct indices those families hold. A family folds dated daily indices and data-stream backing indices together, as "What they read, by index family" does, so one dashboard reading thirty days of a daily index is one family. Request patterns such as * and date-math names are not counted.',
        { secondary: 'detail' })],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), ${IP_GEO} BY client.ip | STATS \`Client IPs\` = COUNT(*), countries = COUNT_DISTINCT(country), unplaced = SUM(CASE(placed == 0, 1, 0)) | EVAL detail = CASE(\`Client IPs\` == 0, "no client address", CONCAT(${grouped('countries')}, CASE(countries == 1, " country · ", " countries · "), ${grouped('unplaced')}, " unplaced")) | KEEP \`Client IPs\`, detail`,
        'Client IPs', 'Distinct real client addresses — the rows of "Busiest addresses they used" below — how many countries they resolve to, and how many cannot be placed at all, which is always the case for a private or CGNAT address. Many addresses for one named person is the shared-credential signal.',
        { secondary: 'detail' })],
    ]),

    // Directly under the KPI row rather than at the foot of section ②, so the tile and its receipt are
    // read together; the Sum footer is what a reader compares with the tile. See RACE_NOTE for why the
    // two can differ by the events that arrive between their fetches.
    // EVERY row, scrollable, rather than a top-N: the Risk tile above counts these rows and sums their
    // Risk column, and a top 8 under "43 actions" is a receipt that cannot add up (round-3 review). The
    // set is closed — one row per scoring action and weight, bounded by Kibana's and Elasticsearch's
    // action vocabulary (43 over 24h at today's volume; volume adds events, not rows) — so the LIMIT is
    // a guard, not a cut, and the title says "every" instead of a count (the description says "scroll").
    row(11, [[48, (x, y, w, h) => drillTo('cloud-audit-04-security-anomalies', table(x, y, w, h, 'Every scoring action and its weight, largest first · its Sum is the Risk tile, give or take events landing as the page loads',
      `FROM ${IDX} | ${TIME} | ${riskScored({ aggs: 'last_ts = MAX(@timestamp)' })} | STATS events = SUM(n), severity = SUM(risk * n), last_seen = MAX(last_ts) BY attributes.event.action, weight = risk | EVAL why = ${weightWords('weight')} | SORT severity DESC | LIMIT 500`,
      // weight is a number, so it reads as one (right-aligned, beside the other numbers); it stays in the
      // BY clause, so the grouping is unchanged. The action stays the raw event.action because it is the
      // click-to-filter column (an assigned column cannot take a pill); `why` says it in words.
      [filterable('attributes.event.action'), sized('why', 220, { label: 'Why it scored' })],
      // The Sum footer is the tile's number computed from THESE rows in the same fetch, so the receipt
      // reconciles on screen whatever is scrolled; 130px holds "Sum: 4,360,050" at 10x today's 24h.
      ['weight', 'events', { column: 'severity', label: 'Risk', width: 130, summary: { type: 'sum' } }, 'last_seen'],
      'The receipts for the Risk tile: the Sum under Risk totals every row, scrolled into view or not, and is the tile\'s number over the same window — on a live stream the two can differ by the events that arrive between the two panels\' fetches (below). One row per scoring action and weight, largest first; Risk here is weight × events, and the tile\'s subtitle counts the rows. ' + RACE_NOTE + ' Click an action to pin it, then "Open in Security & Anomalies" to see who else does it — the pinned person and action combine, so clear the person pill first to compare.', { scroll: true, cut: false }))]]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '① Is this normal?', 'fixed 7-day window in UTC — ignores the time picker')]]),
    row(14, [
      [20, vegaPanel('08-actor-baseline-band', 'Is this normal for them? — hourly, last 7 days (UTC)')],
      [12, vegaPanel('12-actor-cohort', 'Where they rank — last 7 days')],
      [16, vegaPanel('09-activity-punchcard', 'Working rhythm — last 7 days (UTC)')],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '② What they did', 'follows the time picker · times in your time zone')]]),
    row(11, [[48, vegaPanel('11-actor-object-flow', 'How they reached what they touched in Kibana — credential → space → object → operation')]]),
    // Deletes first, then newest. Newest-first alone showed ten creates from the latest burst and put
    // 1,859 deletes (24h) below the panel edge, so a reader concluded this person deleted nothing (round-3
    // review). A delete is the change an investigator looks for first and the one RISK weighs highest
    // here, so it leads; the rest follow newest first, and the list scrolls to the guard of 100 rows.
    // `gone` is a one-condition EVAL on the grouped rows, so it costs nothing per event.
    row(12, [[48, (x, y, w, h) => table(x, y, w, h, '⚠️ What they changed — deletes first, then newest · up to 100',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY ${CHANGED_KEYS}, obj_name, execution, space = attributes.kibana.space.id, result | ${CHANGED_DERIVE} | STATS events = SUM(n), last_seen = MAX(last_ts) BY verb, type = obj_type, name = obj_name, execution, space, result | EVAL name = CASE(execution == "—", name, CONCAT(name, " · run ", execution)), type = REPLACE(type, "-", " "), gone = verb == "delete" | EVAL verb = CASE(result == "failure", CONCAT(verb, " (failed)"), verb) | DROP execution, result | SORT gone DESC, last_seen DESC | DROP gone | LIMIT 100`,
      // Space is a free-form id, so it gets room for one ('syn-marketing' filled 110px edge to edge).
      // No Execution column: it read "—" on every row that is not a workflow run, which is nearly all of
      // them, so the run id rides on the name instead ("Daily sweep · run 3f2a9c1e").
      // No Result column: Kibana logs most saved-object changes as an attempt (outcome "unknown"), so it
      // read "attempted" on every visible row in every round-4 render and told the reader nothing. The one
      // outcome that matters, a denied change, rides on the operation instead: "delete (failed)". `result`
      // stays in the STATS so a failed change never merges with a successful one; the CASE runs on the
      // grouped rows.
      ['verb', sized('type', 200), sized('name', 560), sized('space', 170)],
      ['events', 'last_seen'],
      'What they changed, ran or deleted in Kibana — deletes first, then everything else newest first; scroll for the rest, up to the first 100 rows. `type` and `name` are the real saved-object fields where Kibana records them, and are otherwise recovered from the event message: workflows, agent-builder agents and tools, ML jobs and secrets carry no saved_object fields at all. A workflow run, test or cancel carries its run on the name ("· run" and the first 8 characters of the run id) — a cancel and the run it cancelled share that id; the full id is in the session records at the bottom of the page. An operation marked "(failed)" was denied; every other row is a change Kibana recorded as attempted or completed (most saved-object changes are logged as the attempt, before the outcome is known).', { scroll: true })]]),
    row(11, [
      // A table, not a bar chart. The audit stream itself (every dashboard on this page reads it) is
      // routinely 10x the next family, so on a linear axis the rest of the ranking were 1-2px slivers
      // that read as zero; and Lens hides a bar's value label when it does not fit inside the bar, so
      // `values: true` labelled only the two bars that needed it least. The ranking is the point, and
      // a sorted count column carries it at any spread and at any volume.
      [20, (x, y, w, h) => table(x, y, w, h, 'What they read, by index family',
        `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL AND ${NOT_FANOUT} | MV_EXPAND attributes.elasticsearch.audit.indices | STATS n = COUNT(*) BY attributes.elasticsearch.audit.indices | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT(*) BY family | SORT events DESC, family | LIMIT ${fitRows(11)}`,
        [{ column: 'family', label: 'Index family' }], ['indices', 'events'],
        'Where their reads concentrate, busiest first. Dated daily indices and data-stream backing indices are folded into the family they belong to, so a date-suffixed series is one row and `Indices` says how many of its members were read. A request naming several indices counts once per index; request patterns such as * and date-math names are left out, and so are shard- and node-level repeats of a request (search[phase/query], bulk[s][p]), which Elasticsearch audits with the same index as the request itself. Every dot-prefixed family here is also a row of "System and hidden index reads", with the same counts. The audit stream itself usually tops the list, because every dashboard on this page reads it. This is the busiest few; the Index families tile above counts every family.')],
      [28, (x, y, w, h) => drillTo('cloud-audit-03-data-access', table(x, y, w, h, '⚠️ System and hidden index reads',
        `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | ${SYS_INDEX} | STATS n = COUNT(*), seen = MAX(@timestamp) BY attributes.elasticsearch.audit.indices, action = attributes.elasticsearch.audit.action | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT_DISTINCT(attributes.elasticsearch.audit.indices), actions = COUNT_DISTINCT(action), last_seen = MAX(seen), \`attributes.elasticsearch.audit.indices\` = MIN(attributes.elasticsearch.audit.indices) WHERE NOT attributes.elasticsearch.audit.indices LIKE ".ds-*" BY family | SORT events DESC, family | LIMIT ${fitRows(11)}`,
        // Two count columns at 70px (from 90) so the longest family member, .alerts-observability.threshold.alerts-default, fits at 1440px.
        // The index column flexes and takes the rest; 20/28 split with the family table for the same reason.
        [filterable('attributes.elasticsearch.audit.indices', { label: 'Index (one per family)' })], [sized('indices', 70), sized('actions', 70), 'events', 'last_seen'],
        'The dot-prefixed families of "What they read, by index family" beside it — system and hidden indices — counted the same way, so a family reads the same Events and Indices in both: daily indices and a dot-named stream\'s backing indices (.ds-.alerts-…) are folded into their family, and request patterns and shard-level repeats are left out. A backing index of an ordinary stream (.ds-logs-…) is ordinary data and is not here, as on Elasticsearch Data Access. The index shown is one real member of the family, never a backing index when the family has another — the row counts the whole family — and it is what a click pins; then "Open in Elasticsearch Data Access" to see who else reads it.', { empty: 'good' }))],
    ]),
    row(12, [
      // 18/30 rather than 24/24: a world map is about twice as wide as it is tall, so at w=24 the map was
      // height-bound and a third of the panel sat empty beside it (round-4 review); the address table
      // takes the width instead.
      [18, vegaPanel('10-actor-geography', 'Where they connected from')],
      [30, (x, y, w, h) => drillTo('cloud-audit-05-geo-network', table(x, y, w, h, 'Busiest addresses they used',
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), last_seen = MAX(@timestamp), ${IP_GEO} BY client.ip | EVAL city = CASE(placed == 0, "unplaced", COALESCE(city, "—")), country = CASE(placed == 0, "unplaced", country) | SORT events DESC | LIMIT 25`,
        [filterable('client.ip'), 'city', 'country'], ['events', 'last_seen'],
        'Their real client addresses, busiest first, one row per address — the same addresses the Client IPs tile counts — including the ones the map cannot show. "unplaced" means geoip placed none of that address\'s events, which is always the case for a private or CGNAT address; "—" is a country with no city. An address keeps its place even when some of its events predate geo enrichment. Click an address to pin it, then "Open in Geo & Network".'))],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '③ Evidence', 'session timeline is fixed at 24 hours · the records follow the time picker · your time zone')]]),
    row(7, [[48, vegaPanel('13-session-gantt', 'Kibana browser sessions — last 24 hours, your time zone')]]),
    row(12, [[48, (x, y, w, h) => search(x, y, w, h, '09-session-reconstruction', 'Session records',
      'The raw Kibana events behind the session timeline above, newest first, with the session, the object and the message Kibana wrote. Columns are cut to fit the panel: expand a row (the ⤢ at its left) to read the full session id, object name and message, or open the session in Discover. Like the timeline, it leaves out what an open browser tab does on its own — internal page requests, usage counters, point-in-time paging — so a session in the timeline always has records here, and an hour in which they only had Kibana open is empty.', { empty: 'quiet' })]]),
  ]);
  return dash('cloud-audit-07-actor-360', '[Audit] 👤 Actor 360',
    'One identity’s complete footprint — pick a person in the control bar and every panel becomes their story.', P);
}
