/** 02 Kibana Object Forensics — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, TIME, BUCKET, KIB, VERB, CHANGE, OBJ, OBJ_ID, OBJ_TYPE, dash, kpi, xy, table, pie,
  vega, search, resetIds, sized
} from '../panels.mjs';
import {
  CHANGED
} from './shared.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | STATS \`Kibana events\` = COUNT(*)`, 'Kibana events', 'All Kibana audit events. Usually a small fraction of raw stream volume, but most of the forensic value — this is where saved objects, spaces and sessions are recorded.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | STATS \`Mutations\` = COUNT(*)`, 'Mutations',
      'Every Kibana state change in range, selected by ECS event.type rather than by an action-name suffix. That matters: a suffix test cannot see rule_enable, rule_disable, the whole case_user_action family, or anything the workflow, ML and agent-builder features emit, because none of those action names end in _create/_update/_delete. Point-in-time open/close are ECS-tagged creation/deletion but are query internals, and are excluded by name.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | STATS \`Objects touched\` = COUNT_DISTINCT(obj_id)`, 'Objects touched',
      'Distinct Kibana objects accessed or modified in range — reads included, as the name says. Identity is attributes.kibana.saved_object.id where Kibana records one and is recovered from body.text otherwise, because workflows, ML jobs and agent-builder tools carry no saved_object fields at all.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KIB} | ${OBJ_ID} | ${OBJ_TYPE} | WHERE obj_id IS NOT NULL | STATS \`Object types\` = COUNT_DISTINCT(obj_type)`, 'Object types',
      'How many different kinds of thing were involved (dashboard, alert, index-pattern, tag, workflow …). Restricted to events that actually name an object: without that guard the derived type falls back to the action name and http_request — logged for every Kibana request — would count as an object type.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Spaces\` = COUNT_DISTINCT(attributes.kibana.space.id)`, 'Spaces', 'Distinct Kibana spaces with activity.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${CHANGE} | ${ACTOR} | STATS \`Editors\` = COUNT_DISTINCT(actor)`, 'Editors',
      'Distinct identities that changed anything in Kibana in range, resolved the same way every other actor panel resolves them. Counting emails alone misses changes made by credentials that carry no email. Includes people who only enabled a rule, ran a workflow or created an ML job — none of which an action-name suffix test counts as a change.'),
    table(0, 5, 48, 14, '⚠️ Mutations — the 30 most recent Kibana state changes',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | ${ACTOR} | STATS events = COUNT(*), last_change = MAX(@timestamp) BY actor, verb, type = obj_type, name = obj_name, space = attributes.kibana.space.id, result | SORT last_change DESC | LIMIT 30`,
      [sized('actor', 260), 'verb', sized('type', 200), sized('name', 430),
        sized('space', 110), sized('result', 120)], ['events', 'last_change'],
      'The single most important panel in the suite: state changes in Kibana, with who did it, what it was called, and which space it lives in. This is the 30 most recent — for a complete export use the Discover session below it. Two columns to read carefully. `type` and `name` are the real saved-object fields where Kibana records them and are otherwise recovered from the event message, because workflows, ML jobs and agent-builder objects carry no saved_object fields and would otherwise render as blank rows. `result` is "attempted" where Kibana logged the attempt rather than the outcome — that is how the saved-object path records things, so it is normal, and a "failure" here is a change that was denied.'),
    vega(0, 19, 24, 13, '03-object-verb-heatmap', 'Object type × operation',
      'Heatmap of saved-object type against operation. Reads typically dominate; the create/update/delete columns are the forensic signal.'),
    xy(24, 19, 24, 13, 'Saved-object activity over time',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.type IS NOT NULL | ${VERB} | STATS events = COUNT(*) BY ${BUCKET}, verb`,
      'events', 'Saved-object operations over time, split by verb.', { breakdown: 'verb' }),
    table(0, 32, 24, 12, 'Most-accessed objects by name',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.name IS NOT NULL | STATS events = COUNT(*), actors = COUNT_DISTINCT(attributes.user.email) BY name = attributes.kibana.saved_object.name, type = attributes.kibana.saved_object.type | SORT events DESC | LIMIT 15`,
      ['name', 'type'], ['events', 'actors'],
      'Real object titles from kibana.saved_object.name — the dashboards, rules and other objects people actually opened.'),
    pie(0, 44, 24, 11, 'Object types accessed',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.saved_object.type IS NOT NULL | STATS events = COUNT(*) BY type = attributes.kibana.saved_object.type`,
      'type', 'events', 'Share of saved-object traffic by type. Background reads by Kibana features and integrations can outweigh human activity.'),
    pie(24, 44, 24, 11, 'Activity by space',
      `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.space.id IS NOT NULL | STATS events = COUNT(*) BY space = attributes.kibana.space.id`,
      'space', 'events', 'Kibana activity split across spaces.'),
    table(24, 32, 24, 12, 'Dashboards, SLOs and alert rules touched',
      `FROM ${IDX} | ${TIME} | ${KIB} | ${VERB} | ${OBJ} | WHERE obj_type IN ("dashboard","slo","alert","alerting_rule","tag","index-pattern","workflow","agent-builder-agent","agent-builder-tool","ml-job") | ${ACTOR} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY actor, verb, type = obj_type, name = obj_name | SORT last_seen DESC | LIMIT 15`,
      ['actor', 'verb', 'type', 'name'], ['events', 'last_seen'],
      'Audit trail for the high-value object types only — who touched which dashboard, SLO, rule, workflow or ML job, and when. The allow-list carries both `alert` and `alerting_rule`: Kibana records the same rule under either type depending on which code path audited it.'),
    search(0, 70, 24, 14, '09-session-reconstruction', 'Session reconstruction',
      'One human’s Kibana session replayed in order — every object they opened and changed, with body.text rendering each event as a readable sentence. Pin an identity first and this becomes their hour, step by step.'),
    search(24, 70, 24, 14, '08-cross-space-activity', 'Cross-space activity',
      'Identities ranked by how many Kibana spaces they touched. Anything above one space is worth understanding.'),
    search(0, 55, 48, 15, '04-kibana-object-changes', 'Kibana saved-object activity',
      'Full Kibana saved-object audit trail. body.text renders each event as a readable sentence.'),
  ];
  return dash('cloud-audit-02-kibana-objects', '[Audit] 🗂️ Kibana Object Forensics',
    'Every Kibana saved-object read and change, by type, name, space and actor.', P);
}
