/** 04 Security & Anomalies — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, RISK_INDEX_STATS, RISK_INDEX_EVAL, NOISE, TIME, BUCKET, SCOPE, dash, kpi, xy, table,
  vega, search, resetIds
} from '../panels.mjs';
import {
  WHO, RISK_SCORED
} from './shared.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | STATS ${RISK_INDEX_STATS} | ${RISK_INDEX_EVAL} | EVAL \`Mean severity\` = mean_severity | KEEP \`Mean severity\``, 'Mean severity',
      'Average severity weight across scoring events, on the same 0–50 scale as the weights: config change 50, key invalidation 45, failure 40, anonymous denial 35, destructive change 30, other Kibana change 25, workflow execution 10. Executions weigh least on purpose — they are the one class with unbounded cadence, and a scheduled workflow firing every minute would otherwise turn total risk back into an event count. Routine activity scores 0 and is excluded, so this is not a disguised event count — read it with Scoring events beside it.', { dec: 1 }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Config changes\` = COUNT(attributes.elasticsearch.audit.security_config_change)`, 'Config changes', 'Security configuration changes recorded by Elasticsearch.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "invalidate_apikeys" | STATS \`Key invalidations\` = COUNT(*)`, 'Key invalidations', 'API keys invalidated in range — legitimate rotation, or a credential being revoked in a hurry.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" | STATS \`Failures\` = COUNT(*)`, 'Failures', 'Events with a failure outcome.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "anonymous_access_denied" | STATS \`Anonymous denials\` = COUNT(*)`, 'Anonymous denials', 'Unauthenticated requests that were rejected.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | STATS \`Scoring events\` = COUNT(*)`, 'Scoring events', 'Number of events that carried any risk weight at all — the denominator of Mean severity, and the volume that severity is averaged over.'),
    table(0, 5, 28, 13, '🚨 Security configuration changes',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.security_config_change IS NOT NULL | ${ACTOR} | STATS events = COUNT(*), last_change = MAX(@timestamp) BY actor, action = attributes.event.action, change = attributes.elasticsearch.audit.security_config_change | SORT last_change DESC | LIMIT 25`,
      ['actor', 'action', 'change'], ['events', 'last_change'],
      'Raw security_config_change payloads. The field is a JSON string, shown verbatim — it names the exact API key ids or profile uids affected.'),
    vega(28, 5, 20, 13, '05-rare-event-scatter', 'Rare and privileged operations',
      'Every action plotted against first occurrence. Smaller bubbles are rarer events; warmer colour is higher risk. Rare plus high-risk is where to look first.'),
    xy(0, 18, 24, 12, 'Risk over time',
      `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | STATS risk = SUM(risk) BY ${BUCKET}`,
      'risk', 'Summed risk over time, routine activity excluded. Spikes are clusters of privileged, failed or denied activity.', { kind: 'area' }),
    table(24, 18, 24, 12, 'Risk leaderboard',
      `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | ${ACTOR} | ${SCOPE} | STATS ${RISK_INDEX_STATS}, privileged = COUNT(attributes.elasticsearch.audit.security_config_change) BY actor, actor_scope, attributes.user.email | ${RISK_INDEX_EVAL} | SORT risk_total DESC | LIMIT 15`,
      ['actor', 'actor_scope', WHO], ['risk_total', 'scoring_events', 'mean_severity', 'privileged'],
      'Identities ranked by total accumulated severity, so sustained behaviour outranks a single high-severity event. actor_scope separates Elastic platform automation from tenant identities — without it elastic.maintenance can top this table, because Elastic platform automation performs routine security config changes itself. Click an email to pin that identity across the whole suite.'),
    table(0, 30, 48, 12, 'Why these identities scored — every risky action, with its weight',
      `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | ${ACTOR} | ${SCOPE} | STATS events = COUNT(*), severity = SUM(risk), last_seen = MAX(@timestamp) BY actor, actor_scope, attributes.user.email, action = attributes.event.action, weight = risk | SORT severity DESC | LIMIT 30`,
      ['actor', 'actor_scope', WHO, 'action', 'weight'], ['events', 'severity', 'last_seen'],
      'The receipts behind the leaderboard: for each identity, exactly which actions scored, what each one weighed, how many times, and when it last happened. This is what turns a score into evidence. Click an email to pin that identity across the suite.'),
    table(0, 42, 24, 12, 'Newly seen identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY actor, actor_kind | SORT first_seen DESC | LIMIT 15`,
      ['actor', 'actor_kind'], ['first_seen', 'last_seen', 'events', 'ips'],
      'Identities ordered by when they first appeared in the window. A brand-new identity at the top of this list is worth a question.'),
    table(24, 42, 24, 12, 'Failures and denials by identity',
      `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action IN ("authentication_failed","realm_authentication_failed","anonymous_access_denied") | ${ACTOR} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY actor, attributes.user.email, action = attributes.event.action, ip = client.ip | SORT events DESC | LIMIT 15`,
      ['actor', WHO, 'action', 'ip'], ['events', 'last_seen'],
      'Failed and denied operations grouped by identity, action and source IP. Rows with no email are unauthenticated — those are external probes, not staff.'),
    search(0, 54, 24, 14, '03-security-config-changes', 'Security configuration changes', 'Raw config-change payloads as a Discover session.'),
    search(24, 54, 24, 14, '01-all-mutations', 'All mutations', 'Every create, update and delete across Kibana and Elasticsearch security config.'),
  ];
  return dash('cloud-audit-04-security-anomalies', '[Audit] 🚨 Security & Anomalies',
    'Mean-severity risk scoring, privileged operations, failures and newly seen identities.', P);
}
