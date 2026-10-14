/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, NOISE, TIME, BUCKET, SOURCE_LABEL, SOURCE_COLORS, dash, kpi, xy, bar, table, sized, blankNull, vega, search,
  md, resetIds
} from '../panels.mjs';
import {
  LEGEND_MD
} from './shared.mjs';

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
    // Named, pinned and ordered by the same SOURCE_LABEL / SOURCE_COLORS as 06's chart, so the two
    // sources are the same words and colours on both pages, and the stack stops swapping on refresh.
    xy(0, 5, 32, 13, `Audit volume by source${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name | ${SOURCE_LABEL}`,
      'events', 'Total audited events over time, split by originating service. Elasticsearch audits every transport action, so its volume usually far exceeds Kibana’s — and the Kibana slice is where most of the forensic value is.',
      { breakdown: 'source', colors: SOURCE_COLORS }),
    md(32, 5, 16, 13, LEGEND_MD),
    // Two rows taller than the rest of the page: at 13 the treemap's floor-sized tiles were too short
    // for a two-line name once the legend took its row under the plot.
    vega(0, 18, 24, 15, '01-actor-risk-treemap', 'Actor footprint sized by volume, coloured by severity',
      'The top 40 identities in range, in one block per kind: named API key (labelled by the KEY, with its owner — the principal that created it — on a further line when there is room, and in the tooltip), person (a real email address), cloud API key (an organisation-level Cloud key, which the audit stream records only by id and with no owner), and unattributed (a token or opaque principal). An identity is one tile even when its events disagree about its kind; it goes in the most specific block any of them supports. Area grows with the SQUARE ROOT of event volume, so one dominant identity cannot crush the rest into slivers, and the smallest identities get a minimum tile so every name stays readable — read exact counts from the tooltip. Colour is accumulated severity, the quantity the risk leaderboard ranks by.'),
    vega(24, 18, 24, 15, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Audit events per time bucket, stacked by band — Signal on the baseline, then bulk authentication, query internals and infrastructure health — so the top edge is the whole firehose. Shows why the noise gate exists. Hover a segment for its band and the bucket total.'),
    table(0, 33, 12, 12, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY action = attributes.event.action, source = resource.attributes.service.name | ${SOURCE_LABEL} | SORT events DESC | LIMIT 12`,
      ['action', sized('source', 105, { min: 100 })], ['events'], 'Top audited actions after the noise gate, with the service that emitted them.'),
    /**
     * `via_key` is the key's name only where the identity resolved to a PERSON. On every other row the
     * key name is already the identity, and repeating it in a second column (as this table used to)
     * hid the one case the column exists for: a key stamped with its creator's email.
     *
     * Groups on the computed `actor` like the Distinct actors tile, so the two count identities the
     * same way. A Kind column was tried and dropped: telling a cloud API key from an unattributed
     * principal needs attributes.user.domain on every event, which measured several times slower.
     *
     * No Email column. It was the click-to-pin column, but Identity already IS the email wherever there
     * is one, and on every other row Lens drew it as an underlined, clickable "-" — most of the column,
     * in any estate run by keys. It cannot be blanked: assigning the column in ES|QL makes Lens refuse
     * the filter ("created at query time"), and no Lens setting hides a null link. So the column went,
     * and the pin from this page is the Person (email) control (or any Email cell on the other dashboards).
     * via_key is blanked where empty: it is display-only, so blankNull() costs it nothing.
     */
    table(12, 33, 24, 12, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action) BY actor, attributes.api_key.name | EVAL via_key = CASE(attributes.api_key.name != actor, attributes.api_key.name) | ${blankNull('via_key')} | SORT events DESC | LIMIT 12`,
      [sized('actor', 300, { min: 240 }), { column: 'via_key', label: 'Via API key' }], ['events', 'actions'],
      'Who is generating signal traffic, and how varied their behaviour is. Identity resolves to an email, then an API key name, then a user id. Elasticsearch stamps an API key’s CREATOR’s email on every event the key emits, so any number of machines authenticating with one key resolves to one person’s name: where Via API key is filled in, that row is a credential’s traffic, not the person at a keyboard. To follow one person across the suite, pick them in the Person (email) control above.'),
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
