/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, NOISE, TIME, BUCKET, dash, kpi, xy, table, pie, vega, search, md, resetIds
} from '../panels.mjs';
import {
  WHO, LEGEND_MD
} from './shared.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Total events\` = COUNT(*)`, 'Total events',
      'Every audited event in range, including machine noise. Compare with Signal to see how much the noise gate removes.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal events\` = COUNT(*)`, 'Signal events',
      'Events left after the noise gate removes health checks (cluster:monitor/main, elastic.maintenance), search-phase internals, connection_granted and bulk authentication_success.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS \`Distinct actors\` = COUNT_DISTINCT(actor)`, 'Distinct actors',
      'Unique identities resolved as email, then API key name, then numeric user id.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS \`Human actors\` = COUNT_DISTINCT(attributes.user.email)`, 'Human actors',
      'Distinct human identities (attributes.user.email). Machine traffic is excluded.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Privileged ops\` = COUNT(attributes.elasticsearch.audit.security_config_change)`, 'Privileged ops',
      'Security configuration changes: API key invalidation, user profile writes, role edits. Any non-zero value deserves review.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action == "anonymous_access_denied" | STATS \`Failed events\` = COUNT(*)`, 'Failed events',
      'Failed outcomes plus anonymous access denials — the first place to look during an incident.'),
    xy(0, 5, 32, 13, 'Audit volume by source',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name`,
      'events', 'Total audited events over time, split by originating service. Elasticsearch audits every transport action, so its volume usually far exceeds Kibana’s — and the Kibana slice is where most of the forensic value is.', { breakdown: 'source' }),
    md(32, 5, 16, 13, LEGEND_MD),
    vega(0, 18, 24, 13, '01-actor-risk-treemap', 'Actor footprint sized by volume, coloured by severity',
      'Treemap of the top 40 identities in range, in blocks by kind: service (a named API key, labelled by the KEY, with its owner — the principal that created it — on a second line and in the tooltip), human (a real email address), cloud API key (an organisation-level Cloud key, which the audit stream records only by id and with no owner), and unattributed (a token or opaque principal). A credential is never shown under a person’s name, so no identity appears twice. Area is event volume; colour is accumulated severity, the same quantity the risk leaderboard ranks by.'),
    vega(24, 18, 24, 13, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Stream graph banding the firehose into signal, bulk authentication, query internals and infrastructure noise, with a readable volume axis. Shows why the noise gate exists.'),
    table(0, 31, 16, 12, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY action = attributes.event.action, source = resource.attributes.service.name | SORT events DESC | LIMIT 12`,
      ['action', 'source'], ['events'], 'Top audited actions after the noise gate, with the service that emitted them.'),
    table(16, 31, 16, 12, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action) BY actor, attributes.api_key.name, attributes.user.email | SORT events DESC | LIMIT 12`,
      ['actor', 'attributes.api_key.name', WHO], ['events', 'actions'],
      'Who is generating signal traffic, and how varied their behaviour is. The api_key column matters: Elasticsearch stamps the key CREATOR’s email on every event a key emits, so any number of machines authenticating with one key resolves to one person’s name. Where that column is populated, the traffic is a credential, not a human. Click an email to pin that identity across the suite.'),
    pie(32, 31, 16, 12, 'Event categories',
      `FROM ${IDX} | ${TIME} | MV_EXPAND attributes.event.category | STATS events = COUNT(*) BY category = attributes.event.category`,
      'category', 'events', 'ECS event categories. event.category is a multi-value array, so rows are MV_EXPANDed before grouping — an event in two categories counts once in each. Percentages are therefore shares of category assignments, not of events, and sum to more than the event total.'),
    search(0, 43, 48, 15, '10-raw-signal-feed', 'Live signal feed',
      'The audit stream with the noise gate applied — readable, newest first. Use the Discover session to pivot or add columns.'),
  ];
  return dash('cloud-audit-00-command-center', '[Audit] 🎛️ Command Center',
    'Entry point for Cloud Audit Dashboards. KPIs, volume, actor risk and the live signal feed.', P);
}
