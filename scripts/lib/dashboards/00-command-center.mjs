/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ACTOR_RESOLVE, NOISE, TIME, BUCKET, SOURCE_LABEL, SOURCE_COLORS, dash, kpi, xy, bar, table, sized, vega, search,
  md, resetIds, privilegedKpi
} from '../panels.mjs';
import {
  LEGEND_MD, ACTOR_KEYS
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
    kpi(8, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal events\` = COUNT(*)`, 'Signal events',
      'Events left after the noise gate removes health checks (cluster:monitor/main, elastic.maintenance), query internals (search, ES|QL, field_caps and async-search sub-requests, Kibana /internal/ page requests, and this suite reading its own saved objects), connection_granted and bulk authentication_success.'),
    // Gated, and resolved the same way as Busiest identities below, so the tile counts exactly the
    // identities that table ranks (an ungated count included people whose only traffic was the noise
    // gate's: 4 here over a 3-row table). Counted first by the raw identity fields, resolved after.
    kpi(15, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS n = COUNT(*) BY ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS \`Distinct actors\` = COUNT_DISTINCT(actor)`, 'Distinct actors',
      'Identities with signal traffic, behind the same noise gate and resolved the same way as Busiest identities: email, then API key name, then numeric user id. Someone whose only events are noise (browsing dashboards, health checks) is not counted here; Platform Volume counts all traffic.'),
    kpi(22, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | WHERE attributes.user.email IS NOT NULL | STATS \`Human actors\` = COUNT_DISTINCT(attributes.user.email)`, 'Human actors',
      'Distinct email addresses with signal traffic, behind the same noise gate as Signal events. Includes an API key whose events carry its creator’s email: such a row in Busiest identities reads “email · via key name”.'),
    // Widths follow the titles at a 1440px viewport, where a metric tile clips its secondary line and
    // wraps its title: the two "· all traffic" tiles need 9 columns, and Privileged ops' "N key cleanups
    // left out" line 10. The three short titles give up a column each.
    // PRIVILEGED (panels.mjs): Kibana's own API-key cleanup by elastic/kibana kept this tile permanently
    // non-zero (670 of 671 in an hour). It is left out and counted in the line under the number instead.
    kpi(29, 0, 10, 5, `FROM ${IDX} | ${TIME} | ${privilegedKpi(`Privileged ops${ALL}`)}`, `Privileged ops${ALL}`,
      'Security configuration changes — API keys created, changed or invalidated, roles and user profiles written — by any identity, over all traffic (the noise gate removes none of these, so gated and ungated counts are the same). Kibana’s own routine clean-up of API keys (invalidate_apikeys by the elastic/kibana service account) is not counted here; the line under the number (“N key cleanups left out”) says how many there were. Any other non-zero value deserves review.',
      { secondary: 'housekeeping_note' }),
    kpi(39, 0, 9, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action == "anonymous_access_denied" | STATS \`Failed events${ALL}\` = COUNT(*)`, `Failed events${ALL}`,
      'Failed outcomes plus anonymous access denials over all traffic, not only signal: a failure is worth seeing even when it is a health check or a query internal. The first place to look during an incident.'),
    // Named, pinned and ordered by the same SOURCE_LABEL / SOURCE_COLORS as 06's chart, so the two
    // sources are the same words and colours on both pages, and the stack stops swapping on refresh.
    xy(0, 5, 32, 13, `Audit volume by source${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name | ${SOURCE_LABEL}`,
      'events', 'Total audited events over time, split by originating service. Elasticsearch audits every transport action, so its volume usually far exceeds Kibana’s — and the Kibana slice is where most of the forensic value is. The last bar is the bucket still filling, so it is usually short; a bucket with no bar had no audit events delivered for it (the stream arrives in batches).',
      { breakdown: 'source', colors: SOURCE_COLORS }),
    md(32, 5, 16, 13, LEGEND_MD),
    // Two rows taller than the rest of the page: at 13 the treemap's floor-sized tiles were too short
    // for a two-line name once the legend took its row under the plot.
    vega(0, 18, 24, 15, '01-actor-risk-treemap', 'Actor footprint · area by √events, colour by severity',
      'The top 12 identities by signal volume (fewer on a narrow screen, down to 8), in one block per kind; the rest of each kind is folded into one grey “+N more” tile (hover it for the count). Blocks: named API key (labelled by the KEY, with its owner — the principal that created it — on a further line when there is room, and in the tooltip), person (a real email address), cloud API key (an organization-level Cloud key, which the audit stream records only by id and with no owner), and unattributed (a token or opaque principal). An identity is one tile even when its events disagree about its kind; it goes in the most specific block any of them supports. Area grows with the SQUARE ROOT of event volume, so one dominant identity cannot crush the rest into slivers, plus the same small share for every tile, so the quietest identity keeps a readable name but is never drawn larger than a busier one. Each tile prints its event count where it fits: read the number, not the area, for how much more one identity did. A name too long for its tile ends in “…” — the tooltip has the full name and exact counts. Colour is accumulated severity, the quantity the risk leaderboard ranks by, on a square-root scale. A key that carries its creator’s email is its own tile here, but counts under the person in Busiest identities.'),
    vega(24, 18, 24, 15, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Audit events per time bucket, stacked by band — Signal on the baseline, then bulk authentication, query internals and infrastructure health — so the top edge is the whole firehose. Shows why the noise gate exists. Hover a segment for its band and the bucket total. Infrastructure health (cluster:monitor/main pings) is usually too thin to see beside the rest, or absent from a short window, although its legend entry stays: Platform Volume counts it. As on Audit volume, the last bucket is still filling and an empty bucket had no audit events delivered.'),
    table(0, 33, 12, 12, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY action = attributes.event.action, source = resource.attributes.service.name | ${SOURCE_LABEL} | SORT events DESC | LIMIT 10`,
      ['action', sized('source', 105, { min: 100 })], ['events'], 'Top audited actions after the noise gate, with the service that emitted them.'),
    /**
     * Groups on the computed `actor` like the Distinct actors tile, so the two count identities the
     * same way. A Kind column was tried and dropped: telling a cloud API key from an unattributed
     * principal needs attributes.user.domain on every event, which measured several times slower.
     *
     * No Email column. It was the click-to-pin column, but Identity already IS the email wherever there
     * is one, and on every other row Lens drew it as an underlined, clickable "-". The pin from this
     * page is the Person (email) control (or any Email cell on the other dashboards).
     *
     * No Via API key column either. It was filled only where Elasticsearch stamped a key's creator's
     * email on the key's events, which this estate never does: four renders showed it blank on every
     * row. The case it exists for is folded into Identity instead ("alice@x · via key ci-deploy"), so
     * it still reads where it happens and costs no width where it does not. `actor` is computed, so
     * relabelling it loses no click-filter (it never had one).
     */
    table(12, 33, 24, 12, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action), last_seen = MAX(@timestamp) BY actor, attributes.api_key.name | EVAL actor = CASE(attributes.api_key.name IS NOT NULL AND attributes.api_key.name != actor, CONCAT(actor, " · via key ", attributes.api_key.name), actor) | SORT events DESC | LIMIT 10`,
      ['actor'], ['events', 'actions', 'last_seen'],
      'The identities generating the most signal traffic, and how varied their behaviour is; the rows sum to Signal events when they all fit. Identity resolves to an email, then an API key name, then a user id. Elasticsearch stamps an API key’s CREATOR’s email on every event the key emits, so any number of machines authenticating with one key resolve to one person: such a row reads “email · via key name” and is a credential’s traffic, not the person at a keyboard. To follow one person across the suite, pick them in the Person (email) control above.'),
    // A bar rather than the donut it replaces: the donut's thin slices carried no label and it had no
    // legend, so the small categories could not be named. Grouping on the multi-valued field counts
    // an event once per category, as MV_EXPAND did, without materialising a row per value.
    bar(36, 33, 12, 12, `Event categories${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY category = attributes.event.category | EVAL category = COALESCE(category, "none recorded") | SORT events DESC | LIMIT 8 | EVAL category = CASE(events < 100, CONCAT(category, " · ", TO_STRING(events)), category)`,
      'category', 'events', 'ECS event categories over the whole stream, noise included, on a log scale so the small categories are as readable as the bulk: read each bar by its label, not its length. event.category is a multi-value array, so an event in two categories counts once in each and the bars sum to more than the event total; “none recorded” is events that carry no category. A bar too short to hold its number (under 100 events) carries it in its label instead.',
      { values: true, yScale: 'log' }),
    // h=25, not 15: Discover rows are 27px on a 28px grid unit, so the last visible row moves 1px per
    // unit of height. At 15 it was cut through its text; at 25 the grid ends on a row boundary.
    search(0, 45, 48, 25, '10-raw-signal-feed', 'Live signal feed',
      'The newest 200 signal events, newest first, behind the same noise gate as Signal events. Detail is the Kibana message, the transport action on an Elasticsearch event, or for a security change (API key, role) what it changed: “API key <name or id> + N more” for one call that invalidated several keys. A Client IP marked internal is Kibana or the platform calling Elasticsearch on someone’s behalf, not where they are; “none recorded” is an event with no client address, such as Kibana’s own service account working inside the platform. Automation reads as long runs of near-identical rows from one identity: a deploy or a scripted scan can fill this feed for minutes. To read past it, pick a Person above, or open the session and filter that identity out. Open the Discover session to page further back or add columns.'),
  ];
  return dash('cloud-audit-00-command-center', '[Audit] 🎛️ Command Center',
    'Entry point for Cloud Audit Dashboards. KPIs, volume, actor risk and the live signal feed.', P);
}
