/** 03 Elasticsearch Data Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, NOISE, TIME, BUCKET, ESS, dash, kpi, xy, table, pie, vega, search, resetIds
} from '../panels.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ESS} | STATS \`Elasticsearch events\` = COUNT(*)`, 'Elasticsearch events', 'All Elasticsearch audit events in range.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Indices touched\` = COUNT_DISTINCT(attributes.elasticsearch.audit.indices)`, 'Indices touched', 'Distinct indices named in audited requests.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Distinct actions\` = COUNT_DISTINCT(attributes.elasticsearch.audit.action)`, 'Distinct actions', 'Distinct Elasticsearch transport actions (cluster:*, indices:*).'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action LIKE "*esql*" | STATS \`ES|QL requests\` = COUNT(*)`, 'ES|QL requests', 'Requests on the ES|QL execution path — someone running queries, including these dashboards.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | WHERE attributes.elasticsearch.audit.indices LIKE ".*" | STATS \`System index access\` = COUNT(*)`, 'System index access', 'Requests touching dot-prefixed system indices (.kibana*, .security*, .slo-*, .alerts-*). Privileged by nature.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "access_denied" OR attributes.event.action == "anonymous_access_denied" | STATS \`Access denied\` = COUNT(*)`, 'Access denied', 'Authorization denials. Sustained non-zero values mean a misconfigured client or a probe.'),
    xy(0, 5, 24, 15, 'Data access over time by category',
      `FROM ${IDX} | ${TIME} | ${ESS} | ${NOISE} | MV_EXPAND attributes.event.category | STATS events = COUNT(*) BY ${BUCKET}, category = attributes.event.category`,
      'events', 'Elasticsearch audit volume over time by ECS category, noise gate applied.', { breakdown: 'category' }),
    vega(24, 5, 24, 30, '04-actor-index-matrix', 'Who reads which index',
      'Heatmap of the busiest identity/index pairs — index down the side, identity across the top, colour is request volume. Reading down a column shows one identity\'s data footprint; reading across a row shows who touches an index.'),
    table(0, 20, 24, 15, 'Most-accessed indices',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | ${ACTOR} | MV_EXPAND attributes.elasticsearch.audit.indices | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor) BY index = attributes.elasticsearch.audit.indices | SORT events DESC | LIMIT 15`,
      ['index'], ['events', 'actors'], 'Which indices see the most audited access, and how many distinct identities touch each.'),
    table(0, 35, 24, 12, 'Transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | ${NOISE} | STATS events = COUNT(*) BY action = attributes.elasticsearch.audit.action, request = attributes.elasticsearch.audit.request.name | SORT events DESC | LIMIT 15`,
      ['action', 'request'], ['events'],
      'Elasticsearch transport actions with their request class, after the noise gate removes health pings, search-phase internals and connection and bulk-authentication events.'),
    table(0, 47, 48, 12, '⚠️ System and hidden index access',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | ${ACTOR} | MV_EXPAND attributes.elasticsearch.audit.indices | WHERE attributes.elasticsearch.audit.indices LIKE ".*" | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY actor, index = attributes.elasticsearch.audit.indices, action = attributes.elasticsearch.audit.action | SORT last_seen DESC | LIMIT 25`,
      ['actor', 'index', 'action'], ['events', 'last_seen'],
      'Access to dot-prefixed system indices — Kibana internals, the security index, alerting and SLO data. Sorted by most recent, not by volume: sorting by volume buries a one-off read under Kibana’s own continuous polling. Expected from elastic/kibana; unexpected from anyone else.'),
    pie(24, 35, 24, 12, 'Request outcome',
      `FROM ${IDX} | ${TIME} | ${ESS} | STATS events = COUNT(*) BY outcome = attributes.event.outcome`,
      'outcome', 'events', 'Outcome distribution for Elasticsearch audit events.'),
    search(0, 59, 48, 15, '05-system-index-access', 'System index access', 'Every request against a dot-prefixed index, newest first.'),
  ];
  return dash('cloud-audit-03-data-access', '[Audit] 🔎 Elasticsearch Data Access',
    'What data was read, by whom, through which transport action — including system indices.', P);
}
