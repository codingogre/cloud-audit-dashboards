/** 06 Platform Volume — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, NOISE, BAND, TIME, BUCKET, dash, kpi, xy, table, vega, md, resetIds
} from '../panels.mjs';
import {
  VOL_NOTE
} from './shared.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`All events\` = COUNT(*)`, 'All events', 'Total audited events, unfiltered.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal\` = COUNT(*)`, 'Signal', 'Events that survive the noise gate.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IN ("cluster:monitor/main","elastic.maintenance") | STATS \`Infra noise\` = COUNT(*)`, 'Infra noise', 'Health-check and maintenance traffic.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "authentication_success" | STATS \`Bulk authn\` = COUNT(*)`, 'Bulk authn', 'Successful authentication events. Elasticsearch logs one per authenticated request, so credentials making many calls generate most of them.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`HTTP requests\` = COUNT_DISTINCT(attributes.http.request.id)`, 'HTTP requests', 'Distinct HTTP requests behind the audited events. One request often emits several audit records, so this is lower than the event count.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${BAND} | STATS total = COUNT(*), sig = COUNT(CASE(band == "signal", 1, null)) | EVAL \`Signal share\` = ROUND(sig * 1.0 / total, 4) | KEEP \`Signal share\``, 'Signal share',
      'Percentage of the firehose that survives the noise gate. The lower this is, the more the other dashboards are earning their keep.', { fmt: 'percent', dec: 2 }),
    vega(0, 5, 24, 13, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Stream graph of the four volume bands. The signal band is what every other dashboard shows.'),
    md(24, 5, 10, 13, VOL_NOTE),
    table(34, 5, 14, 13, 'API key throughput',
      `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.name IS NOT NULL | STATS events = COUNT(*) BY api_key = attributes.api_key.name | SORT events DESC | LIMIT 12`,
      ['api_key'], ['events'], 'Request volume per named API key.'),
    xy(0, 18, 24, 12, 'Volume band over time',
      `FROM ${IDX} | ${TIME} | ${BAND} | STATS events = COUNT(*) BY ${BUCKET}, band`,
      'events', 'Absolute event volume split into the four bands.', { breakdown: 'band' }),
    xy(24, 18, 24, 12, 'Audit volume by source service',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name`,
      'events', 'Elasticsearch versus Kibana audit volume over time.', { breakdown: 'source' }),
    table(0, 30, 24, 12, 'Noisiest transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | STATS events = COUNT(*), actors = COUNT_DISTINCT(COALESCE(attributes.user.email, attributes.api_key.name, attributes.user.name)) BY action = attributes.elasticsearch.audit.action | SORT events DESC | LIMIT 15`,
      ['action'], ['events', 'actors'], 'Highest-volume Elasticsearch transport actions, unfiltered.'),
    table(24, 30, 24, 12, 'Highest-volume identities',
      `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action) BY actor, actor_kind | SORT events DESC | LIMIT 15`,
      ['actor', 'actor_kind'], ['events', 'actions'], 'Unfiltered volume leaderboard — this is where the machine traffic shows up.'),
  ];
  return dash('cloud-audit-06-platform-volume', '[Audit] 📊 Platform Volume & API Keys',
    'The unfiltered firehose, quarantined so the forensic dashboards stay readable.', P);
}
