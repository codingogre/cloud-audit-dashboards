/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, NOISE, TIME, BUCKET, PALETTE, dash, kpi, xy, bar, table, sized, vega, search, md, resetIds
} from '../panels.mjs';
import {
  WHO, LEGEND_MD
} from './shared.mjs';

/**
 * "serverless-kibana" / "serverless-elasticsearch" spend eleven characters of every cell and legend
 * entry saying what the whole suite already assumes. Stripped AFTER the STATS, on the handful of
 * grouped rows, so the grouping still runs on the raw keyword field (see QUERY SHAPE in panels.mjs).
 */
const SOURCE = 'EVAL source = REPLACE(service, "^serverless-", "")';

/**
 * Panels that read the whole stream say so in their title. The legend panel tells the reader the
 * noise gate is on; without the tag, an ungated panel beside a gated one reads as the same population.
 */
const ALL = ' · all traffic';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Total events${ALL}\` = COUNT(*)`, `Total events${ALL}`,
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
    // Pinned so the two sources keep their colours if one of them is ever absent from a window.
    xy(0, 5, 32, 13, `Audit volume by source${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, service = resource.attributes.service.name | ${SOURCE}`,
      'events', 'Total audited events over time, split by originating service. Elasticsearch audits every transport action, so its volume usually far exceeds Kibana’s — and the Kibana slice is where most of the forensic value is.',
      { breakdown: 'source', colors: { kibana: PALETTE[0], elasticsearch: PALETTE[1] } }),
    md(32, 5, 16, 13, LEGEND_MD),
    // Two rows taller than the rest of the page: at 13 the treemap's floor-sized tiles were too short
    // for a two-line name once the legend took its row under the plot.
    vega(0, 18, 24, 15, '01-actor-risk-treemap', 'Actor footprint sized by volume, coloured by severity',
      'The top 40 identities in range, in one block per kind: named API key (labelled by the KEY, with its owner — the principal that created it — on a further line when there is room, and in the tooltip), person (a real email address), cloud API key (an organisation-level Cloud key, which the audit stream records only by id and with no owner), and unattributed (a token or opaque principal). An identity is one tile even when its events disagree about its kind; it goes in the most specific block any of them supports. Area grows with the SQUARE ROOT of event volume, so one dominant identity cannot crush the rest into slivers, and the smallest identities get a minimum tile so every name stays readable — read exact counts from the tooltip. Colour is accumulated severity, the quantity the risk leaderboard ranks by.'),
    vega(24, 18, 24, 15, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Stream graph banding the firehose into signal, bulk authentication, query internals and infrastructure noise, with a readable volume axis. Shows why the noise gate exists.'),
    table(0, 33, 12, 12, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY action = attributes.event.action, service = resource.attributes.service.name | ${SOURCE} | SORT events DESC | LIMIT 12`,
      ['action', sized('source', 105)], ['events'], 'Top audited actions after the noise gate, with the service that emitted them.'),
    /**
     * `via_key` is the key's name only where the identity resolved to a PERSON. On every other row the
     * key name is already the identity, and repeating it in a second column (as this table used to)
     * hid the one case the column exists for: a key stamped with its creator's email.
     *
     * Groups on the computed `actor` like the Distinct actors tile, so the two count identities the
     * same way. A Kind column was tried and dropped: telling a cloud API key from an unattributed
     * principal needs attributes.user.domain on every event, which measured several times slower.
     */
    table(12, 33, 24, 12, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action) BY actor, attributes.api_key.name, attributes.user.email | EVAL via_key = CASE(attributes.api_key.name != actor, attributes.api_key.name) | SORT events DESC | LIMIT 12`,
      [sized('actor', 260), { column: 'via_key', label: 'Via API key' }, WHO], ['events', 'actions'],
      'Who is generating signal traffic, and how varied their behaviour is. Identity resolves to an email, then an API key name, then a user id. Elasticsearch stamps an API key’s CREATOR’s email on every event the key emits, so any number of machines authenticating with one key resolves to one person’s name: where Via API key is filled in, that row is a credential’s traffic, not the person at a keyboard. Click an email to pin that identity across the suite.'),
    // A bar rather than the donut it replaces: the donut's thin slices carried no label and it had no
    // legend, so the small categories could not be named. Grouping on the multi-valued field counts
    // an event once per category, as MV_EXPAND did, without materialising a row per value.
    bar(36, 33, 12, 12, `Event categories${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY category = attributes.event.category | SORT events DESC | LIMIT 8`,
      'category', 'events', 'ECS event categories over the whole stream, noise included. event.category is a multi-value array, so an event in two categories counts once in each and the bars sum to more than the event total.',
      { values: true }),
    search(0, 45, 48, 15, '10-raw-signal-feed', 'Live signal feed',
      'The newest 200 signal events, newest first. Detail is the Kibana message, or the transport action on an Elasticsearch event. Open the Discover session to page further back or add columns.'),
  ];
  return dash('cloud-audit-00-command-center', '[Audit] 🎛️ Command Center',
    'Entry point for Cloud Audit Dashboards. KPIs, volume, actor risk and the live signal feed.', P);
}
