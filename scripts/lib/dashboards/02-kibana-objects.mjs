/** 02 Kibana Object Forensics — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, TIME, BUCKET, KIB, VERB, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_ID, OBJ_TYPE, PALETTE, KIBANA_INTERNALS, dash, kpi, xy, bar, table,
  vega, search, resetIds, sized
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import {
  CHANGED, CHANGED_KEYS, CHANGED_DERIVE, specDescription
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
const NOT_HTTP = 'WHERE kibana.saved_object.type IS NOT NULL OR event.action IS NULL OR event.action != "http_request"';

/**
 * The high-value table is sorted newest first, and every dashboard view by every viewer is a
 * saved_object_resolve of a cloud-audit-* dashboard plus a find of its data view, so on a deployed suite
 * its ten rows were always the suite watching itself be watched (24h render: all ten). This leaves out
 * exactly what the noise gate calls query internals — the suite's own reads and automated install
 * (SUITE_SELF), page-load lookups, space lookups and point-in-time paging — through the same
 * KIBANA_INTERNALS vocabulary, so the two can never disagree. A suite object a person changes in a
 * browser session stays. Null-guarded: Fleet emits events with no action.
 * Runs after NOT_HTTP, so the url.original RLIKE inside it only ever sees the few http_request rows that
 * name a saved-object type.
 */
const NOT_INTERNAL = `WHERE event.action IS NULL OR NOT (${KIBANA_INTERNALS})`;

/**
 * What the three "noise gate applied" panels leave out, in one sentence each panel shares, and what they
 * keep. Round 5 titled them "suite left out", and a reviewer then read rows that were all this suite's
 * review tooling: a review space torn down (space_delete, then Kibana's cascade deleting that space's
 * settings, usage counters and objects, the copies with fresh ids that no `cloud-audit-` id test can
 * see), and probe dashboards. That is real activity and the gate rightly keeps it — it is not by key or
 * by space — so the title names the gate instead of promising a population. "Noise gate applied" is the
 * suite's own term: Command Center's Live signal feed and the Raw signal feed session use the same gate.
 */
const GATE_NOTE = 'Behind the noise gate, as on Command Center\'s Live signal feed: it leaves out what the gate calls query internals — views of this audit suite\'s own dashboards, searches and data view, the suite\'s automated install (the API imports, exports and writes that deploy it, with no browser session), the settings and data-view lookups every Kibana page load makes, space lookups and point-in-time paging — which otherwise filled every row with the suite watching and installing itself. It is a test of what happened, never of who or where: creating or deleting a space and everything Kibana deletes along with it (its settings, usage counters and the objects in it), and test or probe objects, stay, the suite\'s own review tooling included, because they are real changes.';

/**
 * Two kinds of object have no title and an id that reads as noise. A usage counter's id is
 * "<type>:<object id>:<counter>:<source>:<yyyymmdd>" ("dashboard:cloud-audit-…-06-platform-volume:viewed:
 * server:20261014"): Kibana deletes one per viewed dashboard when a space goes, and the raw id was cut
 * before the dashboard's name in the Object column (round-5 review). It is rewritten to lead with the
 * object it counts. The advanced-settings object (`config`, `config-global`) has the Kibana version as its
 * id, so "9.6.0" stood alone where a name belongs. A CASE over grouped rows (QUERY SHAPE rule 1), and a
 * function of the grouped name and type, so it never merges two rows.
 */
const objLabel = (name, type) => `EVAL ${name} = CASE(${type} == "usage-counter", ` +
  `REPLACE(${name}, "^([^:]+):(.+):([^:]+):[^:]+:([0-9]{4})([0-9]{2})([0-9]{2})$", "$2 ($1 $3 counter, $4-$5-$6)"), ` +
  `${type} == "config", CONCAT("Advanced settings ", ${name}), ${type} == "config-global", CONCAT("Global settings ", ${name}), ${name})`;

/**
 * The activity chart draws four series: create, update, delete, and "other change" for every other
 * verb VERB returns on a CHANGE event (enable, disable, run, test, cancel, ML open/start, remove
 * references). Round 5 drew all eleven: at 24h six of them (cancel, disable, enable, other, run, test)
 * were a few events a day each, so their legend entries named bars nobody could see, disable's
 * brown-red and other's orange sat beside delete's red, and "cancel" had no column in the heatmap
 * beside it (a cancel names a run, not an object id). The Mutations table above names every verb.
 * Colours are pinned and meaning-bearing — create green, update yellow, delete red, the rest blue —
 * all from PALETTE, so they read on both themes, and every value the query can produce is pinned.
 */
const VERB_COLORS = { create: PALETTE[0], update: PALETTE[5], delete: PALETTE[9], 'other change': PALETTE[1] };
const FOLD_VERBS = 'EVAL verb = CASE(verb IN ("create", "update", "delete"), verb, "other change")';

/**
 * The same CHANGE gate as the Mutations tile, so the activity chart's bars add up to that tile. VERB is a
 * multi-branch CASE and runs on the grouped (bucket, action) rows, never per event (QUERY SHAPE rule 1);
 * so does the fold.
 */
const CHANGE_SERIES = `${CHANGE} | STATS n = COUNT(*) BY ${BUCKET}, event.action | ${VERB} | ${FOLD_VERBS} | STATS events = SUM(n) BY \`${BUCKET}\`, verb`;

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
 * bulk as the stable base, then update, delete and other change — the order the heatmap's columns read.
 * Sorting runs on the ≤ ~300 aggregated rows, so it costs nothing measurable.
 */
const SERIES_ORDER = 'SORT verb != "create", verb != "update", verb != "delete"';

/** The intro (draft 4 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 7,
  heading: "Every change to your Kibana content, and who made it",
  paragraphs: [
    "Dashboards, visualizations, data views, alert rules, SLOs, workflows and other saved objects: what was created, edited, deleted or opened, in which space, and by whom.",
    "Use it to answer questions such as \"Who deleted that dashboard?\" or \"What changed before the alert stopped firing?\" Panels marked *noise gate applied* skip these audit dashboards' own activity, so you see your team's work.",
    "**How to use it:** choose a Project, Person (email) or Client IP in the controls and set the time picker. The session view at the bottom replays one browser session step by step. Click a session bar or a session ID to see exactly what happened in that browser session.",
  ],
};

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | STATS \`Kibana events\` = COUNT(*)`, 'Kibana events', 'All Kibana audit events. Usually a small fraction of raw stream volume, but most of the forensic value — this is where saved objects, spaces and sessions are recorded.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | STATS \`Mutations\` = COUNT(*)`, 'Mutations',
      'Every Kibana state change in range, selected by ECS event.type rather than by an action-name suffix. That matters: a suffix test cannot see rule_enable, rule_disable, the whole case_user_action family, or anything the workflow, ML and agent-builder features emit, because none of those action names end in _create/_update/_delete. Point-in-time open/close are ECS-tagged creation/deletion but are query internals, and are excluded by name.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | STATS \`Objects touched\` = COUNT_DISTINCT(obj_id)`, 'Objects touched',
      'Distinct Kibana objects accessed or modified in range — reads included, as the name says. Identity is kibana.saved_object.id where Kibana records one and is recovered from body.text otherwise, because workflows, ML jobs and agent-builder tools carry no saved_object fields at all.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | WHERE obj_id IS NOT NULL | STATS n = COUNT(*) BY ${CHANGED_KEYS} | ${OBJ_TYPE} | STATS \`Object types\` = COUNT_DISTINCT(obj_type)`, 'Object types',
      'How many different kinds of thing were involved (dashboard, alert, index-pattern, tag, workflow …). Restricted to events that actually name an object: without that guard the derived type falls back to the action name and http_request — logged for every Kibana request — would count as an object type.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Spaces\` = COUNT_DISTINCT(kibana.space.id)`, 'Spaces', 'Distinct Kibana spaces with activity.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | ${ACTOR} | STATS \`Editors\` = COUNT_DISTINCT(actor)`, 'Editors',
      'Distinct identities that changed anything in Kibana in range, resolved the same way every other actor panel resolves them. Counting emails alone misses changes made by credentials that carry no email. Includes people who only enabled a rule, ran a workflow or created an ML job — none of which an action-name suffix test counts as a change.'),
    // A row is a GROUP — one identity making one kind of change to one object in one space with one
    // result, over the whole range — so "the 30 most recent state changes" over a row reading Events 17
    // promised 30 changes and showed up to 30 × 17 (round-5 review). The title says it is grouped.
    table(0, 5, 48, 14, '⚠️ Mutations — most recent Kibana state changes, repeats grouped into one row',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | ${EXEC_FLAG} | ${ACTOR} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY actor, ${CHANGED_KEYS}, obj_name, space = kibana.space.id, result, is_exec | ${CHANGED_DERIVE} | STATS events = SUM(n), last_change = MAX(last_ts) BY actor, verb, type = obj_type, name = obj_name, space, result, is_exec | SORT last_change DESC | LIMIT 30 | ${EXEC_LABEL} | ${objLabel('name', 'type')}`,
      [sized('actor', 260), 'verb', sized('type', 200, { label: 'Object type' }), sized('name', 430, { label: 'Object' }),
        'space', 'result'], ['events', 'last_change'],
      'The single most important panel in the suite: state changes in Kibana, with who did it, what it was called, and which space it lives in. Each row groups the same change made again: one identity, one operation, one object, one space and one result over the whole time range. Events is how many times that happened and Last change is the newest of them, so a row reading Events 17 is seventeen changes, and the Mutations tile counts each one. The table holds the 30 groups changed most recently; every change in range is in "All mutations" on Security & Anomalies, and the "Kibana saved-object activity" session further down this page lists reads and changes together. Two columns to read carefully. Object type and Object are the real saved-object fields where Kibana records them and are otherwise recovered from the event message, because workflows, ML jobs and agent-builder objects carry no saved_object fields. A workflow cancel, or a test of an unsaved draft, names only its run, so it reads "execution" and the run id\'s first 8 characters. Result is "attempted" where Kibana logged the attempt rather than the outcome — that is how the saved-object path records things, so it is normal, and a "failure" here is a change that was denied.',
      // Thirty is the bound the title states ("30 at most"), so the LIMIT stays above the 13 rows the panel shows.
      { scroll: true }),
    vega(0, 19, 24, 13, '03-object-verb-heatmap', 'Object type × operation',
      'Saved-object type against operation, writes first; all Kibana traffic, reads included. Cell colour is the event count on a log scale, running teal (fewest) through blue and purple to pink (most); the legend spans exactly the counts drawn and labels both its ends. Every cell has an outline, so a single create, update or delete stays visible beside thousands of reads: the write columns are the forensic signal. An operation outside these words keeps Kibana\'s own, between the changes and the reads: "remove refs" (saved_object_remove_references) is a tag being unlinked from the objects it labelled, and it is one of the "other change" bars beside; "no action" is an event Kibana recorded without one (a Fleet policy deploy). Past 13 object types the rest share one "N more types" row at the bottom; types with any write rank first, so a rare change is never the one folded away. Hover a cell for its count and how many distinct objects it covers.'),
    xy(24, 19, 24, 13, 'Kibana state changes over time · reads in the heatmap',
      `FROM ${IDX} | ${TIME} | ${CHANGE_SERIES} | ${SERIES_ORDER}`,
      'events', 'The Mutations tile over time, by operation: the same events, so the bars add up to that tile. Creates, updates and deletes each have a colour; every other change — enabling, disabling, running, testing or cancelling a rule or workflow, opening or starting an ML job, removing references — is one "other change" series, because each is a few events a day and would be a sliver no one could see. The Mutations table above names each one. Reads are left out because they outnumber changes about thirty to one and flattened every change into a sliver; the heatmap beside this panel and the Object types table below show them. A deploy shows as a block of creates, updates and deletes together.',
      { breakdown: 'verb', colors: VERB_COLORS, legend: 'right' }),
    // 22 columns, two taken from the high-value table: once SUITE_SELF gated the suite's own install,
    // both tables are empty at 1h on a project nobody but the suite used, and each needs its empty
    // condition in the title. At w=20 "… · top 10 at most (empty when none outside the suite)" ran past the
    // panel edge at a 1440px viewport. "Busiest", not "Most-accessed": the word the two panels below use.
    table(0, 32, 22, 12, 'Busiest objects · noise gate applied',
      // Every event that names a saved object by id, shown by its title where Kibana recorded one and by
      // its id otherwise. Titles alone (saved_object.name IS NOT NULL) dropped every space and settings
      // write — Kibana records no title for either — so at 1h the table was empty while the activity
      // session below listed the API key creating spaces and their settings: two panels on one page
      // disagreeing about whether anything happened (round-5 render). A grouping on a COALESCE is a
      // computed key (QUERY SHAPE rule 2): 7d replica 190ms → 225ms.
      // Round 6: grouped by the object's id, its title taken from any event that recorded one. Kibana
      // records no title on a find, so a COALESCE(title, id) key split one dashboard into two rows —
      // "[Audit] Command Center" 69 and "elastic-cloud-audit-pm1-dashboard" 17, the same object (round-6
      // skeptic render) — and a renamed object into one row per title. Two objects that share a title
      // (the same dashboard installed in two spaces) then read alike, so a title two objects of one type share carries the id.
      // INLINE STATS runs on the grouped rows, never per event.
      `FROM ${IDX} | ${TIME} | WHERE kibana.saved_object.id IS NOT NULL | ${NOT_INTERNAL} | ${ACTOR} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), title = MAX(kibana.saved_object.name) BY id = kibana.saved_object.id, type = kibana.saved_object.type | EVAL name = COALESCE(title, id) | INLINE STATS same = COUNT(*) BY name, type | EVAL name = CASE(same > 1, CONCAT(name, " · ", id), name) | ${objLabel('name', 'type')} | DROP title, id, same | SORT events DESC | LIMIT 10`,
      // Object type 155, not 100: "ingest_manager_settings" broke at its underscore into two lines that read
      // as two values (round-5 review). At a 1440px viewport Object still gets ~230px and wraps.
      [{ column: 'name', label: 'Object' }, sized('type', 155, { label: 'Object type' })], ['events', 'actors'],
      `One row per object: its title from kibana.saved_object.name, or its id where Kibana recorded no title (a space); two objects with the same title (one dashboard installed in two spaces) are told apart by the id after the title, and a renamed object is one row under one of its titles. The advanced-settings object, whose id is the Kibana version, reads "Advanced settings 9.6.0" — one per space, counted together — and a usage counter (Kibana's per-object view count) leads with the object it counts. Ranked by events, reads and changes together. ${GATE_NOTE} So the table is empty when nothing but those internals happened in range, while the tiles above still count them. A suite object a person changed in Kibana is kept; every change, the install's included, is in Mutations above. Identities counts people and API keys alike, resolved the way every actor panel resolves them. The tiles, the heatmap and the Object types table read all Kibana traffic. On a narrow screen a long object name wraps onto a second line.`,
      // Wrapped, like the high-value table beside it: at a 1440px viewport Name gets ~230px, and Lens
      // hard-cut "[Audit] Raw signal feed (noise gate applied)" into the Object type column (round-4
      // skeptic render). No width split of four columns at w=22 fits a 36-character name; at 1920 every
      // row is still one line.
      { wrap: true, empty: 'empty when only internals' }),
    table(22, 32, 26, 12, 'Latest high-value object access · noise gate applied',
      `FROM ${IDX} | ${TIME} | ${KIB} | ${NOT_HTTP} | ${NOT_INTERNAL} | ${OBJ_GROK} | ${OBJ_NAME} | ${EXEC_FLAG} | ${ACTOR} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY actor, ${CHANGED_KEYS}, obj_name, is_exec | ${CHANGED_DERIVE} | WHERE obj_type IN ("dashboard","slo","alert","alerting_rule","tag","index-pattern","workflow","agent-builder-agent","agent-builder-tool","ml-job") | STATS last_seen = MAX(last_ts) BY actor, verb, type = obj_type, name = obj_name, is_exec | SORT last_seen DESC | LIMIT 10 | ${EXEC_LABEL}`,
      // 26 of 48 columns: at half width its six columns clipped at a 1440px viewport (the layout
      // advisory); with five (no Events) 26 holds them, and the two columns it gave back let the table
      // beside it carry its empty condition. Every pixel the fixed columns do not need goes to Object,
      // which wraps rather than clips.
      // Identity keeps its width at a narrow viewport (min): an email cut short names nobody. 190, not
      // 175: a 20-character opaque key id filled 175 to within 8px of Operation, and the two read as one.
      [sized('actor', 190, { min: 175 }), sized('verb', 80), sized('type', 110, { label: 'Object type' }), sized('name', 250, { label: 'Object' })],
      // No Events column: the panel answers "who touched it, and when", and the 72px a count took was
      // what left Object clipped at a 1440px viewport.
      ['last_seen'],
      `The ten most recent reads and changes of the high-value object types: dashboards, data views, SLOs, alert rules, tags, workflows, agent-builder agents and tools, and ML jobs — who touched which one, and when. A type that nobody touched in range has no rows. ${GATE_NOTE} So when no high-value object was opened or changed except by those internals the table is empty. A suite object a person changed in Kibana is kept; every change, the install's included, is in Mutations above. Both \`alert\` and \`alerting_rule\` are included, because Kibana records the same rule under either type depending on which code path audited it. On a narrow screen a long object name wraps onto a second line.`,
      // Wrapped: at a 1440px viewport Object gets ~180px, and Lens hard-cuts a clipped cell mid-glyph
      // ("[Audit] Elasticsearch Data A"), which reads as a different name. No width split of this row
      // fits both tables' names at 1440 without dropping a column, so the long names take a second line
      // there instead. At 1920 every name fits on one line and the rows render as before.
      { wrap: true, empty: 'empty when only internals' }),
    // A table, not a bar chart: "space" (every page load reads the active space) outweighs the rarest
    // listed types by two to three orders of magnitude, so on a linear axis their bars were hairlines
    // with labels beside nothing, and Lens' log axis printed crowded non-decade ticks at 1h
    // ("1 2 3 5 7 20 40 70 …"). The heatmap above is the picture; this is the numbers.
    // "noise included", the counterpart of the "noise gate applied" on the tables above (round 5 said
    // "suite included" here and "suite left out" above, and the tables above were then full of the
    // suite's review tooling, which the gate rightly keeps). Not "all traffic" like the two panels beside
    // it: a LIMITed table may not say "all" (layout.mjs PROMISES_ALL). "up to 9" (the bound fitRows(11)
    // sets) rather than the appended "· top 9 at most", which lost its "9" past the title line at a 1440px
    // viewport; "Object types" is the tile's own name.
    table(0, 44, 12, 11, 'Object types · noise included · up to 9',
      `FROM ${IDX} | ${TIME} | WHERE kibana.saved_object.type IS NOT NULL | STATS events = COUNT(*), objects = COUNT_DISTINCT(kibana.saved_object.id) BY type = kibana.saved_object.type | SORT events DESC | LIMIT 9`,
      [sized('type', 150, { label: 'Object type' })], ['events', sized('objects', 90, { label: 'Objects' })],
      'All Kibana traffic, like the Busiest spaces and Cross-space panels beside it and unlike the two tables above, which apply the noise gate: the saved-object types with the most events, busiest first, reads and changes, as in the heatmap above (which splits each type by operation). Objects is how many distinct objects of that type were touched. "space" ranks high because every Kibana page load reads the active space. The space row\'s Objects can run above the Spaces tile: the tile counts spaces something happened in, and a space that was only created, or created and deleted, with nothing done inside it (or a create that was denied) is a space object touched but not a space with activity.'),
    bar(12, 44, 12, 11, 'Busiest spaces by id · all traffic · up to 10',
      `FROM ${IDX} | ${TIME} | WHERE kibana.space.id IS NOT NULL | STATS events = COUNT(*) BY space = kibana.space.id | SORT events DESC | LIMIT 10`,
      'space', 'events', `Kibana activity in the ten busiest spaces, all Kibana traffic like the Spaces tile; hover a bar for its count. ${SPACE_ID_NOTE} Viewing these audit dashboards counts too: each panel load is audited in the space it is viewed from, so the space the suite is installed in, and any space it is rendered in for review, carries its own reads.`),
    search(24, 44, 24, 11, '08-cross-space-activity', 'Cross-space activity · all traffic',
      `Identities ranked by how many Kibana spaces they touched; Spaces is the count, and Space list names them alphabetically on up to three lines — a longer list ends in "…", and the ⤢ at a row's left opens the whole list. Anything above one space is worth understanding. All Kibana traffic, like the Spaces tile. Events counts events recorded in a space, so the column can add up to slightly less than the Kibana events tile: a sign-in (user_login) belongs to no space. ${SPACE_ID_NOTE}`),
    search(0, 55, 48, 15, '04-kibana-object-changes', 'Kibana saved-object activity · noise gate applied · newest 1,000 at most',
      `Kibana events that named an object, reads and changes, newest first; the newest 1,000 in range, so the result count above the grid is that cap, not a total. Like the two tables above: ${GATE_NOTE.replace(/^Behind/, 'behind')} A usage counter's Object leads with the object it counts. A suite object a person changed in Kibana is kept; every change, the install\'s included, is in Mutations at the top of the page. Kibana\'s page requests and logins name no object and are left out too. Object is the title the object had when the event was recorded, so a renamed object shows its old title on older rows; the id in Message does not change. Open in Discover to filter on a column or page further back.`),
    // The session timeline from Actor 360 (vega/13, one spec, so the two pages cannot disagree), directly
    // above the records it indexes: a click on a bar pins that session and zooms the picker to it, which
    // narrows Session reconstruction beneath. A DSL spec on its own fixed 24 hours, so the title says so
    // on a page where every other panel follows the picker.
    vega(0, 70, 48, 7, '13-session-gantt', 'Kibana browser sessions · fixed last 24 hours, your time zone', specDescription('13-session-gantt')),
    search(0, 77, 48, 14, '09-session-reconstruction', 'Session reconstruction · newest 1,000 at most',
      'One person\'s Kibana sessions, event by event, newest first: every object they opened and changed, with the sentence Kibana wrote for each, which names the object\'s type and id ("User has resolved dashboard [id=…]"). Operation uses the same words as the heatmap (get, resolve, create …); an event that names no object keeps its own action, such as "http request" for a public API call. To replay one session, click its bar in the session timeline above (it pins that session and zooms the time range to it), or hover a cell of the kibana.session.id column and choose Filter for value; then open in Discover and sort Time ascending to read it forward. Kibana\'s internal UI requests, usage counters, space lookups and point-in-time internals are left out; public API calls such as an export are kept, and so are views of this audit suite, because they are part of what the person did. That is why the panel can be empty while Cross-space activity above counts a signed-in person: a browser tab left open keeps sending those background requests (tag lists, usage counters, paging) without the person opening or changing anything. Object is the title the object had at the time, so a renamed object shows its old title on older rows. The session column keeps its field name, kibana.session.id, because a Discover session takes a header only from a rename, and a renamed column offers no Filter for on a dashboard; it holds the full id, cut to fit, and expanding a row (the ⤢ at its left) shows all of it. On a narrow screen the grid scrolls sideways for Space and Message. API-key traffic carries no session.',
      { empty: 'empty when no browser session opened or changed anything' }),
  ];
  return dash(rawId('02-kibana-objects'), '[Audit] 🗂️ Kibana Object Forensics',
    'Every Kibana saved-object read and change, by type, name, space and actor.', P, { intro: INTRO });
}
