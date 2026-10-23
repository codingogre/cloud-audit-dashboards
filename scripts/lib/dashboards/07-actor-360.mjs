/** 07 Actor 360 — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, TIME, IDENTITY_WHERE, ACTOR_KEYS, ACTOR_RESOLVE, INDEX_FAMILY, IP_GEO, indexFamily, dash, kpi, table, vega, section, row, stack, resetIds,
  sized, filterable, grouped, SYS_INDEX, fitRows
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import {
  riskScored, CHANGED, CHANGED_KEYS, CHANGED_DERIVE, specDescription, RAW_RECORDS, IDENTITY_HOW_TO, sessionRecords
} from './shared.mjs';

/**
 * One identity's whole footprint on one page — pick someone in Identity in the control bar and every panel
 * becomes their story. With nobody selected it is the whole estate, which is a useful "who is here"
 * view in its own right.
 *
 * The page is organised around TIME BINDING (see panels.mjs), because it mixes both kinds and a
 * reader has to know which window each panel shows:
 *
 *   ① Is this normal?   fixed 7 days — ES|QL Vega on a panel range (VEGA_WINDOWS), which keeps the control
 *                        bar and the identity dropdowns but ignores the picker, so a baseline and a weekly
 *                        rhythm are possible whatever the picker reads. Kibana badges each panel "Last 7 days",
 *                        so the titles do not repeat it (at 1440px the repeat cut "Where they rank — last 7 d")
 *   ② What they did     follows the time picker
 *   ③ Evidence          a 24-hour session timeline (badged "Last 24 hours") over the raw records
 *
 * Who this is shows the identity as the Identity dropdown names it (ACTOR_RESOLVE, counted first by ACTOR_KEYS)
 * beside the raw Principal id it ran as, which is what a filter pill can match.
 */

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
const NOT_PATTERN = `WHERE NOT (${isPattern('elasticsearch.audit.indices')})`;

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
const NOT_FANOUT = '(elasticsearch.audit.action IS NULL OR NOT elasticsearch.audit.action LIKE "*[*")';

/**
 * DELETING A SPACE DELETES WHAT IS IN IT, and Kibana audits each of those objects as its own
 * saved_object_delete — with the space the REQUEST was made in (usually `default`), not the deleted space
 * the object lived in, and with the space_delete's own http.request.id (probed: `DELETE space r6shared`
 * and its 13 object deletes share request 0b8878ad… and all read space `default`). Grouped by name, the
 * same-named objects of many deleted spaces merged into one row: round-5 review read "[Audit] Actor
 * first-seen and footprint · default · 74 events", one object deleted 74 times in a space it was never in.
 * At 24h, 2,801 of 3,132 saved-object deletes were that cascade (89 space deletes).
 *
 * So a cascaded delete is folded into the space delete that caused it: that row reads "r6shared · and the
 * 13 objects in it", its Events count every delete it stands for (so the table's deletes still add up to
 * the flow's), and a delete with no space delete in its request keeps its own row. The request id is kept
 * only for the two delete actions (one boolean per event, cheap), so the extra grouping is one row per
 * delete request rather than per change.
 *
 * ES|QL has no window function and no join here, so the request's verdict reaches its rows through one
 * more STATS on the grouped rows: keyed by the request for a delete and by the row itself otherwise, each
 * row packed into one string so a bulk delete of several objects (one request, no space) unpacks back
 * into its rows with MV_EXPAND + DISSECT. INLINE STATS was the obvious tool and was measured out: once
 * its result is used it re-runs the whole scan, 0.47s → 1.9s over 7 days on the replica.
 * `␞` separates the packed fields; a name containing it would mis-split, and none does.
 */
const SEP = '␞';
const PACK = ['event.action', 'kibana.saved_object.type', 'obj_name', 'execution', 'space', 'result']
  .map((c) => `COALESCE(${c}, "")`).join(`, "${SEP}", `) + `, "${SEP}", TO_STRING(n), "${SEP}", TO_STRING(last_ts)`;
const CASCADE_KEY = 'EVAL req = CASE(event.action IN ("space_delete", "saved_object_delete"), http.request.id)';
const CASCADE_FOLD =
  `EVAL pack = CONCAT(${PACK}), sd = event.action == "space_delete" ` +
  '| STATS n = SUM(n), inside = SUM(n) WHERE event.action == "saved_object_delete", last_ts = MAX(last_ts), ' +
  'gone = COUNT(*) WHERE sd, sname = MAX(obj_name) WHERE sd, sspace = MAX(space) WHERE sd, sres = MAX(result) WHERE sd, rows = VALUES(pack) ' +
  'BY k = COALESCE(req, pack) ' +
  `| EVAL rows = CASE(gone > 0, CONCAT("space_delete${SEP}space${SEP}", COALESCE(sname, "a deleted space"), "${SEP}—${SEP}", COALESCE(sspace, ""), "${SEP}", COALESCE(sres, ""), "${SEP}", TO_STRING(n), "${SEP}", TO_STRING(last_ts)), rows), inside = CASE(gone > 0, inside, 0) ` +
  `| MV_EXPAND rows | DISSECT rows "%{a}${SEP}%{t}${SEP}%{obj_name}${SEP}%{execution}${SEP}%{sp}${SEP}%{res}${SEP}%{ns}${SEP}%{ts}" ` +
  '| EVAL event.action = CASE(a == "", null, a), kibana.saved_object.type = CASE(t == "", null, t), ' +
  'space = CASE(sp == "", null, sp), result = CASE(res == "", null, res), n = TO_LONG(ns), last_ts = TO_DATETIME(ts) ' +
  `| STATS n = SUM(n), inside = SUM(inside), last_ts = MAX(last_ts) BY ${CHANGED_KEYS}, obj_name, execution, space, result`;

/**
 * What each RISK weight means, in words, for the receipts table's "Why it scored" column. The Risk tile
 * names its worst weight as the NUMBER, which this column sits beside: a tile subtitle holds ~22
 * characters at a 1440px viewport, and "worst: security config change" after a count was cut there. A
 * multi-branch CASE, so it runs on the grouped rows of riskScored() — a handful per (action, weight) —
 * never per event.
 */
const WEIGHT_WORDS = [[50, 'security config change'], [45, 'API keys invalidated'], [40, 'failed or denied'],
  [35, 'anonymous request denied'], [30, 'destructive Kibana change'], [25, 'Kibana change'], [10, 'workflow execution']];
const weightWords = (col) => `CASE(${WEIGHT_WORDS.map(([w, words]) => `${col} == ${w}, "${words}"`).join(', ')}, "scored")`;

/**
 * The intro (draft 2 of the 1.0.3 customer copy, INTRO TEXT in panels.mjs): why you would open the page,
 * then how. It names the clock because the page mixes two: section ① is computed in UTC (a weekly rhythm
 * has to read the same for every viewer), while every table timestamp and the session timeline are in the
 * browser's zone like the rest of Kibana, and side by side they disagree by the viewer's UTC offset. The
 * section bands below carry the section headings.
 */
const INTRO = {
  h: 6,
  heading: 'Everything one person did, on one page',
  paragraphs: [
    `Use it to check whether their activity is normal, see what they changed and read, and gather evidence for a review or investigation. ${RAW_RECORDS}`,
    '**How to use it:** pick someone in the Identity control, or click a Principal id in a table; with nobody selected, the page covers everyone. ① *Is this normal?* always looks at the last 7 days in UTC, ② *What they did* follows the time picker, and ③ *Evidence* ends in the raw records. Table times are in your time zone.',
  ],
  howTo: [
    'Pick an Identity type first to shorten the Identity list. A person’s API keys are identities of their own, so their traffic never counts under the person.',
    'The ① panels read a fixed 7 days with no noise gate, so they will not match the Events tile or the time picker.',
    'Baseline: the band is their usual range for each hour; with under three days of history no band is drawn.',
    'The Risk tile and Every scoring action count whole minutes only, so they can stop up to a minute short of the panels around them.',
    'Session timeline: click a bar to pin a session (Elasticsearch panels then read empty); API-only identities have no sessions.',
    IDENTITY_HOW_TO,
  ],
};

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
 * that gap. Round 6 ended every dashboard's range at now-1m (TIME_TO, panels.mjs), so nothing in range is
 * still arriving; what is left is the spread between the two panels' `now` at both ends of the range.
 *
 * Round 6 measured that spread on its own render, and it is not always sub-second. light-1h showed Risk
 * 43,980 over Sum 43,580 with all 7 rows visible. Re-running the tile query on windows ending every 5s:
 * 43,580 is the window ending 13:43:09 UTC and 43,980 the one ending 13:43:25 — the two panels resolved
 * `now` ~16 seconds apart (the render resizes its viewport after loading, and a panel that re-renders then
 * can re-fetch), while this repo's own deploy was writing ~2 saved objects a second at that edge. Same
 * window, same number, every time (16,380 = 16,380 at 1h, 496,650 = 496,650 at 24h); the gap is the
 * clock, and a later re-fetch is not something a query can prevent.
 *
 * So the tile and its receipt do not take TIME: both cut their window to whole minutes (WHOLE_MINUTES), so
 * two fetches seconds apart resolve to the SAME window unless they straddle a minute boundary — about one
 * load in sixty for a one-second spread, where TIME let any traffic at either edge show. The cost is that
 * these two panels stop at the last whole minute, up to a minute short of the panels around them, which
 * the page's How to read block says. A one-condition WHERE on constants: free.
 *
 * The START is rounded UP, to the first whole minute inside the range (1.0.5). Until then it was
 * DATE_TRUNC(?_tstart), the minute boundary at or BEFORE the range's start — but Kibana sends every Lens
 * ES|QL request a hidden `@timestamp >= _tstart` filter (THE HIDDEN LENS TIME FILTER, panels.mjs), which
 * silently cut those up-to-59 seconds back off. So the real window began at each panel's own _tstart,
 * the start edge was not whole minutes at all, and the two panels could still differ by whatever landed
 * in the second between their starts. Rounded up, the start is inside the filter and the same for both.
 *
 * It carries IDENTITY_WHERE as TIME does (1.0.5.1): without it the Risk tile and its receipts ignored the
 * Identity dropdowns and read the whole estate's risk beside an Events tile narrowed to one identity.
 */
const WHOLE_MINUTES = 'WHERE @timestamp < DATE_TRUNC(1 minute, TO_DATETIME(?_tend)) AND @timestamp >= DATE_TRUNC(1 minute, TO_DATETIME(?_tstart)) + 1 minute' +
  ` AND ${IDENTITY_WHERE}`;

export function build() {
  resetIds();
  const P = stack([
    row(7, [
      // Identity as the Identity dropdown names it (1.0.5.1) and the principal it ran as. Until 1.0.5.1 this was
      // email and principal id, and an unnamed key's Kibana events (user.domain _es_api_key) read as its owner,
      // the Cloud API key. Identity is computed, so the pin is Principal id, a group key of the last STATS: for
      // a person their numeric Cloud id, for a Cloud API key its full id. At 16 columns a 1440px viewport holds
      // an identity, a 20-character id and one count, no more.
      [16, (x, y, w, h) => table(x, y, w, h, 'Who this is — by identity and principal id',
        `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${ACTOR_KEYS} | WHERE user.email IS NOT NULL OR NOT STARTS_WITH(user.name, "<") | ${ACTOR_RESOLVE} | STATS events = SUM(events) BY actor, user.name | SORT events DESC, actor, user.name | LIMIT 10`,
        ['actor', filterable('user.name', { label: 'Principal id', width: 165, min: 160 })], ['events'],
        'The identities behind the selection, busiest first, named as in the Identity dropdown, with the Principal id each ran as. Click a Principal id to pin it across the suite. Unattributed requests count in Events but have no row.')],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | STATS Events = COUNT(*), actions = COUNT_DISTINCT(event.action, 100), last_ts = MAX(@timestamp) | EVAL mins = DATE_DIFF("minutes", last_ts, NOW()) | EVAL detail = CASE(Events == 0, "no activity", CONCAT(${grouped('actions')}, CASE(actions == 1, " action", " actions"), " · ", CASE(mins < 1, "just now", mins < 60, CONCAT(${grouped('mins')}, "m ago"), CONCAT(TO_STRING(mins / 60), "h ago")))) | KEEP Events, detail`,
        'Events', 'Every audited event for the selection, how many distinct actions that was, and how recently they were last seen. Routine traffic included, so it counts connection housekeeping.',
        { secondary: 'detail' })],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${WHOLE_MINUTES} | ${riskScored()} | STATS sev = SUM(risk * n) BY event.action, risk | STATS Risk = SUM(sev), worst = MAX(risk), kinds = COUNT(*) | EVAL detail = CASE(worst IS NULL, "nothing scored", CONCAT(${grouped('kinds')}, CASE(kinds == 1, " action · worst ", " actions · worst "), ${grouped('worst')})), Risk = COALESCE(Risk, 0) | KEEP Risk, detail`,
        'Risk', 'Total risk for the selection (weight × events for everything that scored), how many scoring actions, and the highest weight; 50 is a security configuration change. Routine activity scores zero. Every scoring action below lists the receipts.',
        { secondary: 'detail' })],
      // Families, not raw names, so the tile counts the same thing as "What they read, by index family"
      // below: a raw count put every dated daily index and its .ds- backing index in separately, and
      // counted request patterns like `*`, `-*` and date math as indices. VALUES first keeps the scan a
      // single keyword aggregation — the fold runs over the handful of distinct names, not documents.
      // Drops shard-level fan-out like the two index tables below (round-5 skeptic): with fan-out in, at 1h
      // the tile read "from 5 indices" beside a table whose Indices column summed to 2, the other three
      // being audit-stream backing generations named only by shard copies. Boolean on a raw keyword.
      // Measured against the raw COUNT_DISTINCT it replaced: 55ms vs 50ms at 1h, 57ms vs 52ms at 24h.
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | WHERE ${NOT_FANOUT} | STATS idx = VALUES(elasticsearch.audit.indices) | MV_EXPAND idx | EVAL name = CASE(${isPattern('idx')}, null, idx) | EVAL family = ${indexFamily('name')} | STATS \`Index families\` = COUNT_DISTINCT(family), names = COUNT_DISTINCT(name) | EVAL detail = CASE(names == 0, "no index named", CONCAT("from ", ${grouped('names')}, CASE(names == 1, " index", " indices"))) | KEEP \`Index families\`, detail`,
        'Index families', 'How widely this selection reaches into Elasticsearch: index families named in their requests, and how many distinct indices those families hold. Dated and backing indices fold into one family, so thirty days of a daily index is one.',
        { secondary: 'detail' })],
      [8, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), ${IP_GEO} BY client.ip | STATS \`Client IPs\` = COUNT(*), countries = COUNT_DISTINCT(country), unplaced = SUM(CASE(placed == 0, 1, 0)) | EVAL detail = CASE(\`Client IPs\` == 0, "no client address", CONCAT(${grouped('countries')}, CASE(countries == 1, " country · ", " countries · "), ${grouped('unplaced')}, " unplaced")) | KEEP \`Client IPs\`, detail`,
        'Client IPs', 'Distinct real client addresses for this selection, how many countries they resolve to, and how many cannot be placed (always so for a private address). Many addresses for one named person is the shared-credential signal.',
        { secondary: 'detail' })],
    ]),

    // Directly under the KPI row rather than at the foot of section ②, so the tile and its receipt are
    // read together; the Sum footer is what a reader compares with the tile (WHOLE_MINUTES).
    // EVERY row, scrollable, rather than a top-N: the Risk tile above counts these rows and sums their
    // Risk column, and a top 8 under "43 actions" is a receipt that cannot add up (round-3 review). The
    // set is closed — one row per scoring action and weight, bounded by Kibana's and Elasticsearch's
    // action vocabulary (43 over 24h at today's volume; volume adds events, not rows) — so the LIMIT is
    // a guard, not a cut, and the title says "every" instead of a count (the description says "scroll").
    row(13, [[48, (x, y, w, h) => drillTo(rawId('04-security-anomalies'), table(x, y, w, h, 'Every scoring action and its weight, largest first · its Sum is the Risk tile',
      `FROM ${IDX} | ${WHOLE_MINUTES} | ${riskScored({ aggs: 'last_ts = MAX(@timestamp)' })} | STATS events = SUM(n), severity = SUM(risk * n), last_seen = MAX(last_ts) BY event.action, weight = risk | EVAL why = ${weightWords('weight')} | SORT severity DESC | LIMIT 500`,
      // weight is a number, so it reads as one (right-aligned, beside the other numbers); it stays in the
      // BY clause, so the grouping is unchanged. The action stays the raw event.action because it is the
      // click-to-filter column (an assigned column cannot take a pill); `why` says it in words.
      [filterable('event.action'), sized('why', 220, { label: 'Why it scored' })],
      // The Sum footer is the tile's number computed from THESE rows in the same fetch, so the receipt
      // reconciles on screen whatever is scrolled. Its label says "all rows" because only 11 of 43 fit at 24h (the list scrolls; a title may not say so, CUT in panels.mjs), and 180px holds "Sum, all rows: 4,360,050" at 10x today's 24h.
      ['weight', 'events', { column: 'severity', label: 'Risk', width: 180, summary: { type: 'sum', label: 'Sum, all rows' } }, 'last_seen'],
      'The receipts for the Risk tile: one row per scoring action and weight, largest first; scroll for more. Risk is weight × events, and the Sum under it is the tile\'s number. Click an action, then Open in Security & Anomalies.', { scroll: true, cut: false }))]]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '① Is this normal?', 'fixed 7-day window in UTC (ignores the time picker)')]]),
    row(14, [
      [20, vegaPanel('08-actor-baseline-band', 'Is this normal for them? — hourly (UTC)')],
      [12, vegaPanel('12-actor-cohort', 'Where they rank')],
      [16, vegaPanel('09-activity-punchcard', 'Working rhythm — by hour (UTC)')],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '② What they did', 'follows the time picker · times in your time zone')]]),
    row(11, [[48, vegaPanel('11-actor-object-flow', 'How they reached what they touched in Kibana — credential → space → object → operation')]]),
    // Deletes first, then newest. Newest-first alone showed ten creates from the latest burst and put
    // 1,859 deletes (24h) below the panel edge, so a reader concluded this person deleted nothing (round-3
    // review). A delete is the change an investigator looks for first and the one RISK weighs highest
    // here, so it leads; the rest follow newest first, and the list scrolls to the guard of 100 rows.
    // `gone` is a one-condition EVAL on the grouped rows, so it costs nothing per event.
    row(12, [[48, (x, y, w, h) => table(x, y, w, h, '⚠️ What they changed — deletes first, then newest · up to 100',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | ${CASCADE_KEY} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY ${CHANGED_KEYS}, obj_name, execution, space = kibana.space.id, result, req | ${CASCADE_FOLD} | ${CHANGED_DERIVE} | STATS events = SUM(n), inside = SUM(inside), last_seen = MAX(last_ts) BY verb, type = obj_type, name = obj_name, execution, space, result | EVAL name = CASE(execution == "—", name, CONCAT(name, " · run ", execution)), type = REPLACE(type, "-", " "), gone = verb == "delete" | EVAL name = CASE(inside > 0, CONCAT(name, " · and the ", ${grouped('inside')}, CASE(inside == 1, " object in it", " objects in it")), name) | EVAL verb = CASE(result == "failure", CONCAT(verb, " (failed)"), verb) | DROP execution, result, inside | SORT gone DESC, last_seen DESC | DROP gone | LIMIT 100`,
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
      'What this selection changed, ran or deleted in Kibana: deletes first, then newest first, up to 100 rows. “(failed)” marks a denied change; other rows are changes Kibana recorded as attempted or completed.', { scroll: true })]]),
    row(11, [
      // A table, not a bar chart. The audit stream itself (every dashboard on this page reads it) is
      // routinely 10x the next family, so on a linear axis the rest of the ranking were 1-2px slivers
      // that read as zero; and Lens hides a bar's value label when it does not fit inside the bar, so
      // `values: true` labelled only the two bars that needed it least. The ranking is the point, and
      // a sorted count column carries it at any spread and at any volume.
      [20, (x, y, w, h) => table(x, y, w, h, 'What they read, by index family',
        `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL AND ${NOT_FANOUT} | MV_EXPAND elasticsearch.audit.indices | STATS n = COUNT(*) BY elasticsearch.audit.indices | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT(*) BY family | SORT events DESC, family | LIMIT ${fitRows(11)}`,
        [{ column: 'family', label: 'Index family' }], ['indices', 'events'],
        'The index families this selection read most, busiest first. Dated and backing indices fold into one family; Indices counts how many of its members were read. The audit stream usually tops the list because these dashboards read it.')],
      [28, (x, y, w, h) => drillTo(rawId('03-data-access'), table(x, y, w, h, '⚠️ System and hidden index reads',
        `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL | MV_EXPAND elasticsearch.audit.indices | ${SYS_INDEX} | STATS n = COUNT(*), seen = MAX(@timestamp) BY elasticsearch.audit.indices, action = elasticsearch.audit.action | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | INLINE STATS events = SUM(n), indices = COUNT_DISTINCT(elasticsearch.audit.indices), actions = COUNT_DISTINCT(action), last_seen = MAX(seen), named_idx = MIN(elasticsearch.audit.indices) WHERE NOT elasticsearch.audit.indices LIKE ".ds-*", any_idx = MIN(elasticsearch.audit.indices) BY family | WHERE elasticsearch.audit.indices == COALESCE(named_idx, any_idx) | STATS events = MAX(events), indices = MAX(indices), actions = MAX(actions), last_seen = MAX(last_seen) BY elasticsearch.audit.indices, family | SORT events DESC, family | LIMIT ${fitRows(11)}`,
        // The index column is the GROUP KEY of the last STATS, never assigned by an EVAL. Through 1.0.2 it was
        // `EVAL elasticsearch.audit.indices = COALESCE(named_idx, any_idx)` after a STATS BY family:
        // Lens drew it as a link, but Kibana builds no filter from a column created at query time, so a click
        // produced no filter, no "Apply filter" and therefore no drilldown menu at all (clicked in Playwright,
        // 1.0.3). INLINE STATS computes the family totals on the grouped rows, the WHERE keeps the family's
        // representative index, and the STATS BY that raw field dedupes it (one row per action before it).
        // Same rows as before at 1h, 24h and 7d; ~190ms against ~115ms over 24h and 7 days on the live stream.
        // Two count columns at 70px (from 90) so the longest family member, .alerts-observability.threshold.alerts-default, fits at 1440px.
        // The index column flexes and takes the rest; 20/28 split with the family table for the same reason.
        [filterable('elasticsearch.audit.indices', { label: 'Index (one per family)' })], [sized('indices', 70), sized('actions', 70), 'events', 'last_seen'],
        'The system and hidden index families this selection read, counted as in “What they read, by index family” beside it. Click a row to pin it, then open Elasticsearch Data Access to see who else reads it.', { empty: 'good' }))],
    ]),
    row(12, [
      // 18/30 rather than 24/24: a world map is about twice as wide as it is tall, so at w=24 the map was
      // height-bound and a third of the panel sat empty beside it (round-4 review); the address table
      // takes the width instead.
      [18, vegaPanel('10-actor-geography', 'Where they connected from')],
      [30, (x, y, w, h) => drillTo(rawId('05-geo-network'), table(x, y, w, h, 'Busiest addresses they used',
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), last_seen = MAX(@timestamp), ${IP_GEO} BY client.ip | EVAL city = CASE(placed == 0, "unplaced", COALESCE(city, "—")), country = CASE(placed == 0, "unplaced", country) | SORT events DESC | LIMIT 25`,
        [filterable('client.ip'), 'city', 'country'], ['events', 'last_seen'],
        'This selection’s real client addresses, busiest first, including ones the map cannot show. “unplaced” means no location was found, always so for a private address; “—” is a country with no city. Click an address to pin it.'))],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '③ Evidence', 'session timeline is fixed at 24 hours · the records follow the time picker · your time zone')]]),
    row(7, [[48, vegaPanel('13-session-gantt', 'Kibana browser sessions · your time zone')]]),
    row(12, [[48, (x, y, w, h) => sessionRecords(x, y, w, h, 'Session records',
      'The raw Kibana events behind the session timeline, newest first. Click a timeline bar, or a Session cell, to read one session. An hour with only an idle Kibana tab is empty.', { empty: 'quiet' })]]),
  ]);
  return dash(rawId('07-actor-360'), '[Audit] 👤 Actor 360',
    'One identity’s complete footprint — pick someone in Identity in the control bar and every panel becomes their story.', P, { intro: INTRO });
}
