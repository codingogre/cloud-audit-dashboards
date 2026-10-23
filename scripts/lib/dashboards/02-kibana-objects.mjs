/** 02 Kibana Object Forensics — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_KEYS, ACTOR_RESOLVE, TIME, BUCKET, KIB, VERB, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_ID, OBJ_TYPE, PALETTE, KIBANA_INTERNALS, dash, kpi,
  prevKpi, xy, bar, table, vega, resetIds, sized, ACTOR, OBJ, OBJ_PRESENT, filterable
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import {
  CHANGED, CHANGED_KEYS, CHANGED_DERIVE, specDescription, PIN_PRINCIPAL_SHORT, RAW_RECORDS, IDENTITY_HOW_TO, sessionRecords
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
 * What the three "noise gate applied" panels leave out, and what they keep. Round 5 titled them "suite left out", and a reviewer then read rows that were all this suite's
 * review tooling: a review space torn down (space_delete, then Kibana's cascade deleting that space's
 * settings, usage counters and objects, the copies with fresh ids that no `cloud-audit-` id test can
 * see), and probe dashboards. That is real activity and the gate rightly keeps it — it is not by key or
 * by space — so the title names the gate instead of promising a population. "Noise gate applied" is the
 * suite's own term: Command Center's Live signal feed and the Raw signal feed session use the same gate.
 */
// The gate's full wording is in the README (Reading the panels) and, in short, in this page's How to read block.

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
 * JOINER (U+2060) after each hyphen in Cross-space activity's Space list (and searches/08's) removes that break
 * opportunity and prints nothing. It is a display column the query assigns, never a click filter, so the
 * invisible character costs no pivot.
 */
// Said once, in this page's How to read block, rather than in each tooltip.

/**
 * Lens takes series order — stack order and legend order — from the order rows arrive in, and an
 * unsorted STATS hands them back in whatever order the shards finished. Two renders minutes apart
 * drew delete at the bottom of the stack and first in the legend, then create. Create first keeps the
 * bulk as the stable base, then update, delete and other change — the order the heatmap's columns read.
 * Sorting runs on the ≤ ~300 aggregated rows, so it costs nothing measurable.
 */
const SERIES_ORDER = 'SORT verb != "create", verb != "update", verb != "delete"';

/**
 * CROSS_SPACE (searches/08): identities by how many spaces they touched, all Kibana traffic. Counted first by the
 * raw identity fields and the space (QUERY SHAPE rule 2), resolved after. The list wraps (`{ wrap: true }`), so a
 * WORD JOINER after each hyphen stops "r3chk-04" breaking into "r3chk-" and "04".
 */
const CROSS_SPACE = `FROM ${IDX} | ${TIME} | WHERE kibana.space.id IS NOT NULL | STATS n = COUNT(*) BY ${ACTOR_KEYS}, kibana.space.id ` +
  `| ${ACTOR_RESOLVE} | STATS events = SUM(n), spaces = COUNT_DISTINCT(kibana.space.id), space_list = VALUES(kibana.space.id) BY actor ` +
  '| SORT spaces DESC, events DESC | LIMIT 1000 | EVAL space_list = REPLACE(MV_CONCAT(MV_SORT(space_list), ", "), "-", "-⁠")';

/**
 * OBJECT_ACTIVITY (searches/04): Kibana reads and changes of named objects, newest first, less KIBANA_INTERNALS.
 * Sorted and cut before VERB, OBJ and the label run (QUERY SHAPE rule 3): searches/04 went 10.6s → 0.18s over 7
 * days for that.
 */
const OBJECT_ACTIVITY = `FROM ${IDX} | ${TIME} | ${KIB} | WHERE ${OBJ_PRESENT} | ${NOT_INTERNAL} | SORT @timestamp DESC | LIMIT 1000 ` +
  `| ${ACTOR_RESOLVE} | ${VERB} | ${OBJ} | ${objLabel('obj_name', 'obj_type')} | KEEP @timestamp, actor, verb, obj_type, obj_name, kibana.space.id, body.text`;

/** The intro (draft 4 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 6,
  heading: "Every change to your Kibana content, and who made it",
  paragraphs: [
    `Dashboards, visualizations, data views, alert rules, SLOs, workflows and other saved objects: what was created, edited, deleted or opened, in which space, and by whom. ${RAW_RECORDS}`,
    "Use it to answer questions such as \"Who deleted that dashboard?\" or \"What changed before the alert stopped firing?\" Panels marked *noise gate applied* skip these audit dashboards' own activity, so you see your team's work.",
    "**How to use it:** choose a Project, Identity type, Identity or Client IP in the controls and set the time picker. At the bottom, click a session bar or a session ID to replay that browser session step by step.",
  ],
  howTo: [
    '*Noise gate applied* leaves out page loads, usage counters, paging and these dashboards’ own views and install; real changes, test spaces included, stay.',
    'Object is the title at the time, so a renamed object shows its old name on older rows; a workflow run reads “execution” and its run id.',
    'Spaces show by the id in their URL, not by name, which the audit log does not record. A sign-in belongs to no space.',
    'Click a session bar to pin that session and zoom to it; remove the pill and reset the time to return. Shift-click pins the person.',
    'While a session is pinned, Elasticsearch panels read empty: only browser sign-ins carry a session id, so API-only identities have no bars.',
    IDENTITY_HOW_TO,
  ],
};

export function build() {
  resetIds();
  const P = [
    // A DSL Vega tile with a previous-period line (PREV_TILES in panels.mjs, held to its ES|QL by --lint).
    prevKpi(0, 0, 8, 5, 'kibana-events', 'All Kibana audit events: a small share of the stream, but where saved objects, spaces and sessions are recorded.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | STATS \`Mutations\` = COUNT(*)`, 'Mutations',
      'Every change to Kibana content in range: creates, updates, deletes and other changes such as enabling a rule, running a workflow or starting an ML job.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | STATS \`Objects touched\` = COUNT_DISTINCT(obj_id)`, 'Objects touched',
      'Distinct Kibana objects read or changed in range, reads included. Workflows, ML jobs and agent-builder tools count too.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | WHERE obj_id IS NOT NULL | STATS n = COUNT(*) BY ${CHANGED_KEYS} | ${OBJ_TYPE} | STATS \`Object types\` = COUNT_DISTINCT(obj_type)`, 'Object types',
      'How many kinds of Kibana object were involved: dashboard, alert, index-pattern, tag, workflow and so on. Only events that name an object count.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Spaces\` = COUNT_DISTINCT(kibana.space.id)`, 'Spaces', 'Distinct Kibana spaces with activity.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | STATS BY ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS \`Editors\` = COUNT_DISTINCT(actor)`, 'Editors',
      'Distinct identities that changed anything in Kibana, including those that only enabled a rule, ran a workflow or created an ML job, and credentials with no email.'),
    // A row is a GROUP — one identity making one kind of change to one object in one space with one
    // result, over the whole range — so "the 30 most recent state changes" over a row reading Events 17
    // promised 30 changes and showed up to 30 × 17 (round-5 review). The title says it is grouped.
    table(0, 5, 48, 14, '⚠️ Mutations — most recent Kibana state changes, repeats grouped into one row',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | ${EXEC_FLAG} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY ${ACTOR_KEYS}, ${CHANGED_KEYS}, obj_name, space = kibana.space.id, result, is_exec | ${ACTOR_RESOLVE} | ${CHANGED_DERIVE} | STATS events = SUM(n), last_change = MAX(last_ts) BY actor, user.name, verb, type = obj_type, name = obj_name, space, result, is_exec | SORT last_change DESC | LIMIT 30 | ${EXEC_LABEL} | ${objLabel('name', 'type')}`,
      [sized('actor', 230), PIN_PRINCIPAL_SHORT, 'verb', sized('type', 160, { label: 'Object type' }), sized('name', 430, { label: 'Object' }),
        'space', 'result'], ['events', 'last_change'],
      'Kibana state changes, with who, which object and which space. Repeats of the same change share a row; Events counts them. “attempted” is how Kibana logs most changes; “failure” means the change was denied.',
      // Thirty is the bound the title states ("30 at most"), so the LIMIT stays above the 13 rows the panel shows.
      // Wrapped since 1.0.5: Principal id (raw user.name, the click-through to Actor 360) took 165px, and at a
      // 1440px viewport Object would otherwise be hard-cut at ~150px; at 1920 rows stay on one line.
      { wrap: true }),
    vega(0, 19, 24, 13, '03-object-verb-heatmap', 'Object type × operation',
      'Kibana object types against operations, all traffic, writes first. Color runs teal (fewest) to pink (most), on a log scale. Every cell is outlined, so one create, update or delete stays visible beside thousands of reads: check the write columns.'),
    xy(24, 19, 24, 13, 'Kibana state changes over time · reads in the heatmap',
      `FROM ${IDX} | ${TIME} | ${CHANGE_SERIES} | ${SERIES_ORDER}`,
      'events', 'The Mutations tile over time: creates, updates, deletes, and every other change (enabling or running a rule or workflow, starting an ML job…) as one series. Reads are in the heatmap. A deploy shows as a block of all three.',
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
      `FROM ${IDX} | ${TIME} | WHERE kibana.saved_object.id IS NOT NULL | ${NOT_INTERNAL} | STATS n = COUNT(*), title = MAX(kibana.saved_object.name) BY id = kibana.saved_object.id, type = kibana.saved_object.type, ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS events = SUM(n), actors = COUNT_DISTINCT(actor), title = MAX(title) BY id, type | EVAL name = COALESCE(title, id) | INLINE STATS same = COUNT(*) BY name, type | EVAL name = CASE(same > 1, CONCAT(name, " · ", id), name) | ${objLabel('name', 'type')} | DROP title, id, same | SORT events DESC | LIMIT 10`,
      // Object type 155, not 100: "ingest_manager_settings" broke at its underscore into two lines that read
      // as two values (round-5 review). At a 1440px viewport Object still gets ~230px and wraps.
      [{ column: 'name', label: 'Object' }, sized('type', 155, { label: 'Object type' })], ['events', 'actors'],
      'The Kibana objects with the most reads and changes, and how many identities touched each. Routine page loads and this suite’s own activity are left out; the tiles above count everything.',
      // Wrapped, like the high-value table beside it: at a 1440px viewport Name gets ~230px, and Lens
      // hard-cut "[Audit] Raw signal feed (noise gate applied)" into the Object type column (round-4
      // skeptic render). No width split of four columns at w=22 fits a 36-character name; at 1920 every
      // row is still one line.
      { wrap: true, empty: 'empty when only internals' }),
    table(22, 32, 26, 12, 'Latest high-value object access · noise gate applied',
      `FROM ${IDX} | ${TIME} | ${KIB} | ${NOT_HTTP} | ${NOT_INTERNAL} | ${OBJ_GROK} | ${OBJ_NAME} | ${EXEC_FLAG} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY ${ACTOR_KEYS}, ${CHANGED_KEYS}, obj_name, is_exec | ${ACTOR_RESOLVE} | ${CHANGED_DERIVE} | WHERE obj_type IN ("dashboard","slo","alert","alerting_rule","tag","index-pattern","workflow","agent-builder-agent","agent-builder-tool","ml-job") | STATS last_seen = MAX(last_ts) BY actor, verb, type = obj_type, name = obj_name, is_exec | SORT last_seen DESC | LIMIT 10 | ${EXEC_LABEL}`,
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
      'The most recent reads and changes of high-value objects (dashboards, data views, SLOs, alert rules, tags, workflows, agents, tools, ML jobs), with who and when. Routine page loads and this suite’s own activity are left out.',
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
      'Saved-object types with the most events, reads and changes, over all Kibana traffic (routine included, unlike the two tables above). Objects counts distinct objects touched. “space” ranks high because every page load reads the active space.'),
    bar(12, 44, 12, 11, 'Busiest spaces by id · all traffic · up to 10',
      `FROM ${IDX} | ${TIME} | WHERE kibana.space.id IS NOT NULL | STATS events = COUNT(*) BY space = kibana.space.id | SORT events DESC | LIMIT 10`,
      'space', 'events', 'Kibana activity in the busiest spaces, all traffic; hover a bar for its count. Viewing these dashboards counts too, in the space they are viewed from.'),
    // Lens tables since 1.0.5.1 (RECORD FEEDS, panels.mjs), so the identity dropdowns narrow them; each keeps the
    // logic of the Discover session of the same name (searches/08, 04). Space list wraps, as the session's three-line
    // rows did, so a long list is read whole.
    table(24, 44, 24, 11, 'Cross-space activity · all traffic', CROSS_SPACE,
      ['actor', { column: 'space_list', label: 'Space list' }], [sized('spaces', 80, { label: 'Spaces' }), 'events'],
      'Identities ranked by how many Kibana spaces they touched, all traffic, with the spaces named. More than one space is worth understanding.',
      { wrap: true }),
    table(0, 55, 48, 15, 'Kibana saved-object activity · noise gate applied', OBJECT_ACTIVITY,
      [sized('actor', 245, { min: 200 }), 'verb', sized('obj_type', 140, { label: 'Object type' }), { column: 'obj_name', label: 'Object' }, filterable('kibana.space.id'), 'body.text'],
      ['@timestamp'],
      'Kibana reads and changes of named objects, record by record, newest first. Routine page loads and this suite’s own activity are left out. Click a Space to pin it.',
      { scroll: true }),
    // The session timeline from Actor 360 (vega/13, one spec, so the two pages cannot disagree), directly
    // above the records it indexes: a click on a bar pins that session and zooms the picker to it, which
    // narrows Session reconstruction beneath. On its own fixed 24 hours (VEGA_WINDOWS) on a page where every
    // other panel follows the picker: Kibana badges the panel "Last 24 hours", so the title does not repeat it.
    vega(0, 70, 48, 7, '13-session-gantt', 'Kibana browser sessions · your time zone', specDescription('13-session-gantt')),
    sessionRecords(0, 77, 48, 14, 'Session reconstruction',
      'One person’s Kibana session, event by event, newest first: each object they opened or changed, in Kibana’s own words. Click a session bar above, or a Session cell, to narrow it to one session.',
      { empty: 'empty when no browser session opened or changed anything' }),
  ];
  return dash(rawId('02-kibana-objects'), '[Audit] 🗂️ Kibana Object Forensics',
    'Every Kibana saved-object read and change, by type, name, space and actor.', P, { intro: INTRO });
}
