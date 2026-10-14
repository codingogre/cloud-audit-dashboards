/** 02 Kibana Object Forensics — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, TIME, BUCKET, KIB, VERB, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_ID, OBJ_TYPE, PALETTE, dash, kpi, xy, bar, table,
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
 * The read verbs VERB can emit. Folding them into one series is what lets the activity chart carry
 * a legend that fits on one line under a half-width panel: VERB has fifteen outcomes, and reads are
 * the bulk of the volume but the least of the interest.
 */
const READS = '"get","find","resolve","pit","other"';

/**
 * Write verbs keep a meaning-bearing colour on every render rather than whatever order the palette
 * hands out that hour: create green, update yellow, delete red, reads the calm blue. All from
 * PALETTE, so they read on both themes.
 */
const VERB_COLORS = {
  read: PALETTE[1], create: PALETTE[0], update: PALETTE[5], delete: PALETTE[9],
  enable: PALETTE[3], disable: PALETTE[4], run: PALETTE[7], test: PALETTE[6], cancel: PALETTE[8], open: PALETTE[2], start: PALETTE[2],
};

/**
 * Lens takes series order — stack order and legend order — from the order rows arrive in, and an
 * unsorted STATS hands them back in whatever order the shards finished. Two renders minutes apart
 * drew delete at the bottom of the stack and first in the legend, then read. Read first keeps the
 * bulk as the stable base with the thin write slivers on top; the writes follow alphabetically.
 * Sorting runs on the ≤ ~800 aggregated rows, so it costs nothing measurable.
 */
const SERIES_ORDER = 'SORT verb != "read", verb';

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
      'Saved-object type against operation, writes first. The more solid the cell, the more events it holds, on a log scale, so a single create, update or delete stays visible beside thousands of reads: the write columns are the forensic signal. Hover a cell for its count and how many distinct objects it covers.'),
    xy(24, 19, 24, 13, 'Saved-object activity over time',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.type IS NOT NULL | STATS n = COUNT(*) BY ${BUCKET}, attributes.event.action | ${VERB} | EVAL verb = CASE(verb IN (${READS}), "read", verb) | STATS events = SUM(n) BY \`${BUCKET}\`, verb | ${SERIES_ORDER}`,
      'events', 'Saved-object operations over time. Get, find, resolve and the other read verbs are folded into one "read" series, so each write verb keeps its own colour and the legend stays short enough to read.',
      { breakdown: 'verb', colors: VERB_COLORS }),
    table(0, 32, 24, 12, 'Most-accessed objects by name',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.name IS NOT NULL | ${ACTOR} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor) BY name = attributes.kibana.saved_object.name, type = attributes.kibana.saved_object.type | SORT events DESC | LIMIT 15`,
      ['name', sized('type', 150, { label: 'Object type' })], ['events', 'actors'],
      'Real object titles from kibana.saved_object.name: the dashboards, rules and other objects people actually opened. Identities counts people and API keys alike, resolved the way every actor panel resolves them. Opening one of these audit dashboards is itself a read, so the suite\'s own dashboards and data view rank here in proportion to how much it is used.'),
    table(24, 32, 24, 12, 'Dashboards, SLOs and alert rules touched',
      `FROM ${IDX} | ${TIME} | ${KIB} | ${NOT_HTTP} | ${OBJ_GROK} | ${OBJ_NAME} | ${EXEC_FLAG} | ${ACTOR} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY actor, ${CHANGED_KEYS}, obj_name, is_exec | ${CHANGED_DERIVE} | WHERE obj_type IN ("dashboard","slo","alert","alerting_rule","tag","index-pattern","workflow","agent-builder-agent","agent-builder-tool","ml-job") | STATS events = SUM(n), last_seen = MAX(last_ts) BY actor, verb, type = obj_type, name = obj_name, is_exec | SORT last_seen DESC | LIMIT 10 | ${EXEC_LABEL}`,
      // Half width: every pixel the fixed columns do not need goes to Object, the column that clipped.
      [sized('actor', 175), sized('verb', 80), sized('type', 125, { label: 'Object type' }), sized('name', 250, { label: 'Object' })],
      [sized('events', 70), 'last_seen'],
      'Audit trail for the high-value object types only: who touched which dashboard, SLO, rule, workflow or ML job, and when. Both `alert` and `alerting_rule` are included, because Kibana records the same rule under either type depending on which code path audited it.'),
    bar(0, 44, 12, 11, 'Object types accessed',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.type IS NOT NULL | STATS events = COUNT(*) BY type = attributes.kibana.saved_object.type | SORT events DESC | LIMIT 10`,
      'type', 'events', 'The ten saved-object types with the most traffic. Background reads by Kibana features and integrations can outweigh human activity; the heatmap above splits each type by operation.', { values: true }),
    bar(12, 44, 12, 11, 'Activity by space',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.space.id IS NOT NULL | STATS events = COUNT(*) BY space = attributes.kibana.space.id | SORT events DESC | LIMIT 10`,
      'space', 'events', 'Kibana activity in the ten busiest spaces. Viewing these audit dashboards counts too, so the space they are installed in carries their own reads.', { values: true }),
    search(24, 44, 24, 11, '08-cross-space-activity', 'Cross-space activity',
      'Identities ranked by how many Kibana spaces they touched. Anything above one space is worth understanding.'),
    search(0, 55, 48, 15, '04-kibana-object-changes', 'Kibana saved-object activity',
      'Every Kibana event that named an object, reads and changes, newest first; the newest 1,000 in range. Kibana\'s page requests, logins and point-in-time internals name no object and are left out. Message is the sentence Kibana wrote for the event. Open in Discover to filter on a column or page further back.'),
    search(0, 70, 48, 14, '09-session-reconstruction', 'Session reconstruction',
      'One person\'s Kibana sessions, event by event, newest first: every object they opened and changed, with the sentence Kibana wrote for each. Pin an identity first, then open in Discover, filter to one Session and sort Time ascending to replay it forward. Kibana\'s internal UI requests and point-in-time internals are left out; public API calls such as an export are kept. Empty when nobody used Kibana in a browser in range: API-key traffic carries no session.'),
  ];
  return dash('cloud-audit-02-kibana-objects', '[Audit] 🗂️ Kibana Object Forensics',
    'Every Kibana saved-object read and change, by type, name, space and actor.', P);
}
