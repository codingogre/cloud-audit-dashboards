/** 02 Kibana Object Forensics — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, TIME, BUCKET, KIB, VERB, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_ID, OBJ_TYPE, PALETTE, KIBANA_INTERNALS, dash, kpi, xy, bar, table,
  vega, search, resetIds, sized
} from '../panels.mjs';
import {
  CHANGED, CHANGED_KEYS, CHANGED_DERIVE
} from './shared.mjs';

/**
 * OBJ_NAME falls back to the execution id when a workflow event names nothing else: a cancel only
 * carries [executionId=…], and a test of an unsaved draft says "[draft yaml]". A bare 36-character
 * uuid in the Object column reads as a different object from the workflow on the row beside it, so
 * those rows say what they are, shortened to 8 characters the way CHANGED's `execution` is.
 *
 * Split around the STATS rather than rewriting obj_name before it: rewriting the grouped column
 * row by row measured ~80ms slower on the Mutations query (200ms against 115ms, 24h), while
 * flagging it and relabelling the grouped rows costs nothing measurable. The flag is a function of
 * the name, so adding it to BY never splits a group.
 */
const EXEC_FLAG = 'EVAL is_exec = obj_name == g_exec';
const EXEC_LABEL = 'EVAL name = CASE(is_exec, CONCAT("execution ", LEFT(name, 8)), name)';

/**
 * Drops Kibana's own page and XHR requests before the five GROKs in OBJ_GROK run, which is about half of
 * every Kibana event in range. It changes no row: an http_request that names no saved-object type
 * derives obj_type "http_request", which no allow-list here contains. Written type-first so the
 * common case short-circuits on a field test, and null-safe, because Fleet emits events with no
 * action at all, and `!=` on null would drop those along with the noise.
 */
const NOT_HTTP = 'WHERE attributes.kibana.saved_object.type IS NOT NULL OR attributes.event.action IS NULL OR attributes.event.action != "http_request"';

/**
 * The high-value table is sorted newest first, and every dashboard view by every viewer is a
 * saved_object_resolve of a cloud-audit-* dashboard plus a find of its data view, so on a deployed suite
 * its ten rows were always the suite watching itself be watched (24h render: all ten). This leaves out
 * exactly what the noise gate calls query internals — the suite's own READS, space lookups and
 * point-in-time paging — through the same KIBANA_INTERNALS vocabulary, so the two can never disagree. A
 * change to a suite object is not a read and stays. Null-guarded: Fleet emits events with no action.
 * Runs after NOT_HTTP, so the url.original RLIKE inside it only ever sees the few http_request rows that
 * name a saved-object type.
 */
const NOT_INTERNAL = `WHERE attributes.event.action IS NULL OR NOT (${KIBANA_INTERNALS})`;

/**
 * Change verbs keep a meaning-bearing colour on every render rather than whatever order the palette
 * hands out that hour: create green, update yellow, delete red. All from PALETTE, so they read on both
 * themes. Nothing that occurs often sits next to delete's red: run was the orange (#DA8B45) and in dark
 * theme the two could not be told apart at sliver height (round-4 review), so orange now marks only
 * "other" (saved_object_remove_references, 17 a day) and the ML open/start pair takes the pink. Every
 * verb VERB can return for a CHANGE event is pinned, so no unpinned value restarts the palette.
 */
const VERB_COLORS = {
  create: PALETTE[0], update: PALETTE[5], delete: PALETTE[9], cancel: PALETTE[1], run: PALETTE[3],
  test: PALETTE[4], enable: PALETTE[6], disable: PALETTE[8], open: PALETTE[2], start: PALETTE[2], other: PALETTE[7],
};

/**
 * The same CHANGE gate as the Mutations tile, so the activity chart's bars add up to that tile. VERB is a
 * multi-branch CASE and runs on the grouped (bucket, action) rows, never per event (QUERY SHAPE rule 1).
 */
const CHANGE_SERIES = `${CHANGE} | STATS n = COUNT(*) BY ${BUCKET}, attributes.event.action | ${VERB} | STATS events = SUM(n) BY \`${BUCKET}\`, verb`;

/**
 * Space ids as the audit stream records them. Kibana writes a space's id (the /s/<id> in its URL) on
 * every event and its display name on none — not even on space_get/space_find, whose saved_object.name
 * is null (checked over 24h, 2026-10-14) — so no panel can show the name. Line-wrapping a list breaks
 * after a hyphen, which split "r3chk-04" into "r3chk-" and "04" as if they were two spaces; a WORD
 * JOINER (U+2060) after each hyphen in searches/08's Space list removes that break opportunity and
 * prints nothing. It is a display column with no filter behind it (Discover renames it), so the
 * invisible character costs no pivot.
 */
const SPACE_ID_NOTE = 'A space is shown by its id, the /s/<id> in its URL: the audit stream records no space display name, not even on a space read. Spaces that tooling creates and deletes (review or test spaces) are real activity and rank like any other.';

/**
 * Lens takes series order — stack order and legend order — from the order rows arrive in, and an
 * unsorted STATS hands them back in whatever order the shards finished. Two renders minutes apart
 * drew delete at the bottom of the stack and first in the legend, then create. Create first keeps the
 * bulk as the stable base; the rest follow alphabetically.
 * Sorting runs on the ≤ ~800 aggregated rows, so it costs nothing measurable.
 */
const SERIES_ORDER = 'SORT verb != "create", verb';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | STATS \`Kibana events\` = COUNT(*)`, 'Kibana events', 'All Kibana audit events. Usually a small fraction of raw stream volume, but most of the forensic value — this is where saved objects, spaces and sessions are recorded.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | STATS \`Mutations\` = COUNT(*)`, 'Mutations',
      'Every Kibana state change in range, selected by ECS event.type rather than by an action-name suffix. That matters: a suffix test cannot see rule_enable, rule_disable, the whole case_user_action family, or anything the workflow, ML and agent-builder features emit, because none of those action names end in _create/_update/_delete. Point-in-time open/close are ECS-tagged creation/deletion but are query internals, and are excluded by name.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | STATS \`Objects touched\` = COUNT_DISTINCT(obj_id)`, 'Objects touched',
      'Distinct Kibana objects accessed or modified in range — reads included, as the name says. Identity is attributes.kibana.saved_object.id where Kibana records one and is recovered from body.text otherwise, because workflows, ML jobs and agent-builder tools carry no saved_object fields at all.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | WHERE obj_id IS NOT NULL | STATS n = COUNT(*) BY ${CHANGED_KEYS} | ${OBJ_TYPE} | STATS \`Object types\` = COUNT_DISTINCT(obj_type)`, 'Object types',
      'How many different kinds of thing were involved (dashboard, alert, index-pattern, tag, workflow …). Restricted to events that actually name an object: without that guard the derived type falls back to the action name and http_request — logged for every Kibana request — would count as an object type.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Spaces\` = COUNT_DISTINCT(attributes.kibana.space.id)`, 'Spaces', 'Distinct Kibana spaces with activity.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | ${ACTOR} | STATS \`Editors\` = COUNT_DISTINCT(actor)`, 'Editors',
      'Distinct identities that changed anything in Kibana in range, resolved the same way every other actor panel resolves them. Counting emails alone misses changes made by credentials that carry no email. Includes people who only enabled a rule, ran a workflow or created an ML job — none of which an action-name suffix test counts as a change.'),
    table(0, 5, 48, 14, '⚠️ Mutations — the 30 most recent Kibana state changes',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | ${EXEC_FLAG} | ${ACTOR} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY actor, ${CHANGED_KEYS}, obj_name, space = attributes.kibana.space.id, result, is_exec | ${CHANGED_DERIVE} | STATS events = SUM(n), last_change = MAX(last_ts) BY actor, verb, type = obj_type, name = obj_name, space, result, is_exec | SORT last_change DESC | LIMIT 30 | ${EXEC_LABEL}`,
      [sized('actor', 260), 'verb', sized('type', 200, { label: 'Object type' }), sized('name', 430, { label: 'Object' }),
        'space', 'result'], ['events', 'last_change'],
      'The single most important panel in the suite: state changes in Kibana, with who did it, what it was called, and which space it lives in. These are the 30 most recent (scroll for the rest); every change in range is in "All mutations" on Security & Anomalies, and the "Kibana saved-object activity" session further down this page lists reads and changes together. Two columns to read carefully. Object type and Object are the real saved-object fields where Kibana records them and are otherwise recovered from the event message, because workflows, ML jobs and agent-builder objects carry no saved_object fields. A workflow cancel, or a test of an unsaved draft, names only its run, so it reads "execution" and the run id\'s first 8 characters. Result is "attempted" where Kibana logged the attempt rather than the outcome — that is how the saved-object path records things, so it is normal, and a "failure" here is a change that was denied.',
      // The title promises thirty, so the LIMIT stays above the 13 rows the panel shows.
      { scroll: true }),
    vega(0, 19, 24, 13, '03-object-verb-heatmap', 'Object type × operation',
      'Saved-object type against operation, writes first; all Kibana traffic, reads included. Cell colour is the event count on a log scale, running teal (fewest) through blue and purple to pink (most); the legend spans exactly the counts drawn. Every cell has an outline, so a single create, update or delete stays visible beside thousands of reads: the write columns are the forensic signal. Past 13 object types the rest share one "N more types" row at the bottom; types with any write rank first, so a rare change is never the one folded away. Hover a cell for its count and how many distinct objects it covers.'),
    xy(24, 19, 24, 13, 'Kibana state changes over time · reads in the heatmap',
      `FROM ${IDX} | ${TIME} | ${CHANGE_SERIES} | ${SERIES_ORDER}`,
      'events', 'The Mutations tile over time, by operation: the same events, so the bars add up to that tile. Reads are left out because they outnumber changes about thirty to one and flattened every change into a sliver; the heatmap beside this panel and Busiest object types below show them. A deploy shows as a block of creates, updates and deletes together.',
      { breakdown: 'verb', colors: VERB_COLORS, legend: 'right' }),
    table(0, 32, 20, 12, 'Most-accessed objects · suite views left out',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.name IS NOT NULL | ${NOT_INTERNAL} | ${ACTOR} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor) BY name = attributes.kibana.saved_object.name, type = attributes.kibana.saved_object.type | SORT events DESC | LIMIT 15`,
      ['name', sized('type', 100, { label: 'Object type' })], ['events', 'actors'],
      'Real object titles from kibana.saved_object.name, ranked by events, reads and changes together. Like the high-value table beside it, this leaves out what the noise gate calls query internals: views of this audit suite\'s own dashboards, searches and data view, which otherwise filled every row with the suite watching itself be watched. A change to a suite object is kept, so a deploy of the suite ranks here. Identities counts people and API keys alike, resolved the way every actor panel resolves them. The tiles, the heatmap and Busiest object types still count suite views: they read all Kibana traffic.'),
    table(20, 32, 28, 12, 'Latest high-value object access · suite views left out',
      `FROM ${IDX} | ${TIME} | ${KIB} | ${NOT_HTTP} | ${NOT_INTERNAL} | ${OBJ_GROK} | ${OBJ_NAME} | ${EXEC_FLAG} | ${ACTOR} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY actor, ${CHANGED_KEYS}, obj_name, is_exec | ${CHANGED_DERIVE} | WHERE obj_type IN ("dashboard","slo","alert","alerting_rule","tag","index-pattern","workflow","agent-builder-agent","agent-builder-tool","ml-job") | STATS last_seen = MAX(last_ts) BY actor, verb, type = obj_type, name = obj_name, is_exec | SORT last_seen DESC | LIMIT 10 | ${EXEC_LABEL}`,
      // 28 of 48 columns, taken from the four-column table beside it: at half width its six columns
      // clipped at a 1440px viewport (the layout advisory). Every pixel the fixed columns do not need
      // goes to Object, the column that clipped.
      // Identity keeps its width at a narrow viewport (min): an email cut short names nobody. 190, not
      // 175: a 20-character opaque key id filled 175 to within 8px of Operation, and the two read as one.
      [sized('actor', 190, { min: 175 }), sized('verb', 80), sized('type', 110, { label: 'Object type' }), sized('name', 250, { label: 'Object' })],
      // No Events column: the panel answers "who touched it, and when", and the 72px a count took was
      // what left Object clipped at a 1440px viewport.
      ['last_seen'],
      'The ten most recent reads and changes of the high-value object types: dashboards, data views, SLOs, alert rules, tags, workflows, agent-builder agents and tools, and ML jobs — who touched which one, and when. A type that nobody touched in range has no rows. Unlike the panel beside it, this one leaves out what the noise gate calls query internals: views of this audit suite\'s own dashboards and data view, space lookups and point-in-time paging, which on a deployed suite would fill every row; a change to a suite object is kept. Both `alert` and `alerting_rule` are included, because Kibana records the same rule under either type depending on which code path audited it. On a narrow screen a long object name wraps onto a second line; scroll the table for the last rows.',
      // Wrapped: at a 1440px viewport Object gets ~180px, and Lens hard-cuts a clipped cell mid-glyph
      // ("[Audit] Elasticsearch Data A"), which reads as a different name. No width split of this row
      // fits both tables' names at 1440 without dropping a column, so the long names take a second line
      // there instead. At 1920 every name fits on one line and the rows render as before.
      { wrap: true }),
    // A table, not a bar chart: "space" (every page load reads the active space) outweighs the rarest
    // listed types by two to three orders of magnitude, so on a linear axis their bars were hairlines
    // with labels beside nothing, and Lens' log axis printed crowded non-decade ticks at 1h
    // ("1 2 3 5 7 20 40 70 …"). The heatmap above is the picture; this is the numbers.
    table(0, 44, 12, 11, 'Busiest object types',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.type IS NOT NULL | STATS events = COUNT(*), objects = COUNT_DISTINCT(attributes.kibana.saved_object.id) BY type = attributes.kibana.saved_object.type | SORT events DESC | LIMIT 10`,
      [sized('type', 150, { label: 'Object type' })], ['events', sized('objects', 90, { label: 'Objects' })],
      'All Kibana traffic, suite views included, unlike the two tables above: the saved-object types with the most events, reads and changes, as in the heatmap above (which splits each type by operation). Objects is how many distinct objects of that type were touched. "space" ranks high because every Kibana page load reads the active space.'),
    bar(12, 44, 12, 11, 'Top 10 spaces by id · all traffic',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.space.id IS NOT NULL | STATS events = COUNT(*) BY space = attributes.kibana.space.id | SORT events DESC | LIMIT 10`,
      'space', 'events', `Kibana activity in the ten busiest spaces, all Kibana traffic like the Spaces tile; hover a bar for its count. ${SPACE_ID_NOTE} Viewing these audit dashboards counts too: each panel load is audited in the space it is viewed from, so the space the suite is installed in, and any space it is rendered in for review, carries its own reads.`),
    search(24, 44, 24, 11, '08-cross-space-activity', 'Cross-space activity · all traffic',
      `Identities ranked by how many Kibana spaces they touched, with every space listed. Anything above one space is worth understanding. All Kibana traffic, like the Spaces tile. ${SPACE_ID_NOTE}`),
    search(0, 55, 48, 15, '04-kibana-object-changes', 'Kibana saved-object activity · suite views left out · newest 1,000 at most',
      'Kibana events that named an object, reads and changes, newest first; the newest 1,000 in range, so the result count above the grid is that cap, not a total. Like the two tables above, it leaves out what the noise gate calls query internals (views of this audit suite\'s own dashboards, searches and data view, space lookups and point-in-time paging), which otherwise filled every visible row with the suite watching itself; a change to a suite object is kept. Kibana\'s page requests and logins name no object and are left out too. Object is the title the object had when the event was recorded, so a renamed object shows its old title on older rows; the id in Message does not change. Open in Discover to filter on a column or page further back.'),
    search(0, 70, 48, 14, '09-session-reconstruction', 'Session reconstruction · newest 1,000 at most',
      'One person\'s Kibana sessions, event by event, newest first: every object they opened and changed, with the sentence Kibana wrote for each. Operation uses the same words as the heatmap (get, resolve, create …); an event that names no object keeps its own action, such as "http request" for a public API call. Pin an identity first, then open in Discover, filter to one Session and sort Time ascending to replay it forward. Kibana\'s internal UI requests, space lookups and point-in-time internals are left out; public API calls such as an export are kept, and so are views of this audit suite, because they are part of what the person did. Object is the title the object had at the time, so a renamed object shows its old title on older rows. Session is printed in full, so it can be read and copied; on a narrow screen the grid scrolls sideways for Object type, Space and Message. API-key traffic carries no session.',
      { empty: 'empty when nobody used a browser' }),
  ];
  return dash('cloud-audit-02-kibana-objects', '[Audit] 🗂️ Kibana Object Forensics',
    'Every Kibana saved-object read and change, by type, name, space and actor.', P);
}
