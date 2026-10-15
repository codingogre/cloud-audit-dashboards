/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ACTOR_RESOLVE, NOISE, BAND, BAND_KEYS, TIME, BUCKET, SOURCE_LABEL, SOURCE_COLORS, dash, kpi, xy, bar, table, sized, vega, search,
  md, resetIds, privilegedKpi, grouped, fitRows, EDGE_NOTE
} from '../panels.mjs';
import {
  LEGEND_MD, ACTOR_KEYS
} from './shared.mjs';

/**
 * Panels that read the whole stream say so in their title. The legend panel tells the reader the
 * noise gate is on; without the tag, an ungated panel beside a gated one reads as the same population.
 */
const ALL = ' · all traffic';

/**
 * The two time charts on this page draw the SAME buckets over the SAME span. xy() fits the x domain to
 * the data, and Lens ends a fitted domain at the last bucket's START, so the newest bucket's bar fell
 * outside the plot and was never drawn (round-5 review: Audit volume ended one bar before the Vega stream
 * beside it, and its "the last bar is short" tooltip described a bar that was not there). Read from the
 * network on a 24h render: the ES|QL response carried the 13:00 bucket, the plot ended at 13:00. With no
 * x domain at all Lens spans the time range itself (the API offers only `fit` and a fixed `custom`), so
 * the last, partial bucket is drawn up to the range's end. Rendered: both charts end on the same bar.
 */
const fullRange = (p) => { delete p.config.axis.x.domain; return p; };

/**
 * A log value axis in compact numbers (1 · 10 · 100 · 1k · 10k · 100k · 1m), as 01 does: at full digits
 * Lens dropped "100,000" between 10,000 and 1,000,000 for want of room. Every bar carries its exact count
 * in its label, so the axis is only a ruler.
 */
const compactValues = (p) => { p.config.layers[0].y[0].format = { type: 'number', decimals: 0, compact: true }; return p; };

/**
 * A log value axis from 0.5, so a bucket with a single signal event still draws a bar (log(1) is the
 * floor otherwise, and 1–2 signal events per bucket is a quiet night). The API takes a custom domain only
 * with both ends, so the top is fixed, as on 01's time chart: 10M is ~10x the busiest 2-hour bucket of a
 * 7-day range today (01 measured ~130k), so a 5–10x busier project still fits.
 */
const logFloor = (p) => { p.config.axis.y.domain = { type: 'custom', min: 0.5, max: 1e7, rounding: false }; return p; };

/**
 * The bottom row: 13 grid rows hold exactly 12 table rows (fitRows), with no blank strip and stray rule
 * under the last one. Widths 13 / 22 / 13 for 1440px, with the count columns at 72px (a 7-digit count
 * still fits): at 12 columns Most frequent actions clipped "anonymous_access_denied" against Source, and
 * at 20 Busiest identities hard-cut "<unauthenticated-cloud-access-token>" (~241px at 1440) to
 * "<unauthenticated-cloud-a" (round-6 skeptic render). At 13 Event categories still prints every decade.
 */
const TABLE_H = 13;
const COUNT_W = 72;

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Total events${ALL}\` = COUNT(*)`, `Total events${ALL}`,
      'Every audited event in range, including machine noise. Compare with Signal to see how much the noise gate removes.'),
    kpi(8, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal events\` = COUNT(*)`, 'Signal events',
      'Events left after the noise gate removes health checks (cluster:monitor/main, elastic.maintenance), query internals (search, ES|QL, field_caps and async-search sub-requests, API key metadata lookups, Kibana /internal/ page requests and page-load lookups, and this suite reading and automatically installing its own saved objects), connection_granted and bulk authentication_success.'),
    // Gated, and resolved the same way as Busiest identities below, so the tile counts exactly the
    // identities that table ranks (an ungated count included people whose only traffic was the noise
    // gate's: 4 here over a 3-row table). Counted first by the raw identity fields, resolved after.
    kpi(15, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS n = COUNT(*) BY ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS \`Distinct actors\` = COUNT_DISTINCT(actor)`, 'Distinct actors',
      'Identities with signal traffic, behind the same noise gate and resolved the same way as Busiest identities: email, then API key name, then numeric user id. Someone whose only events are noise (browsing dashboards, health checks) is not counted here; Platform Volume counts all traffic.'),
    kpi(22, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | WHERE attributes.user.email IS NOT NULL | STATS \`Human actors\` = COUNT_DISTINCT(attributes.user.email)`, 'Human actors',
      'Distinct email addresses with signal traffic, behind the same noise gate as Signal events. Includes an API key whose events carry its creator’s email: such a row in Busiest identities reads “email · via key name”.'),
    // Widths follow the titles at a 1440px viewport, where a metric tile clips its secondary line and
    // wraps its title: the two "· all traffic" tiles need 9 columns, and Privileged ops' title 10. The
    // three short titles give up a column each.
    // PRIVILEGED (panels.mjs): Kibana's own API-key cleanup by elastic/kibana kept this tile permanently
    // non-zero (670 of 671 in an hour). It is left out and counted in the line under the number instead.
    kpi(29, 0, 10, 5, `FROM ${IDX} | ${TIME} | ${privilegedKpi(`Privileged ops${ALL}`)}`, `Privileged ops${ALL}`,
      'Security configuration changes — API keys created, changed or invalidated, roles and user profiles written — by any identity, over all traffic (the noise gate removes none of these, so gated and ungated counts are the same). Kibana’s own routine clean-up of API keys (invalidate_apikeys by the elastic/kibana service account) is not counted here; the line under the number (“excl. N cleanups”) says how many there were. Any other non-zero value deserves review.',
      { secondary: 'housekeeping_note' }),
    kpi(39, 0, 9, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action == "anonymous_access_denied" | STATS \`Failed events${ALL}\` = COUNT(*)`, `Failed events${ALL}`,
      'Failed outcomes plus anonymous access denials over all traffic, not only signal: a failure is worth seeing even when it is a health check or a query internal. The first place to look during an incident.'),
    // Named, pinned and ordered by the same SOURCE_LABEL / SOURCE_COLORS as 06's chart, so the two
    // sources are the same words and colours on both pages, and the stack stops swapping on refresh.
    fullRange(xy(0, 5, 32, 13, `Audit volume by source${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name | ${SOURCE_LABEL}`,
      'events', 'Total audited events over time, split by originating service. Elasticsearch audits every transport action, so its volume usually far exceeds Kibana’s — and the Kibana slice is where most of the forensic value is. The plot spans exactly the time range. The range ends a minute ago, part-way through the last bucket, so the last bar covers only part of its interval and is usually short; a bucket with no bar had no audit events delivered for it (the stream arrives in batches). Signal vs noise draws the same buckets over the same span.',
      { breakdown: 'source', colors: SOURCE_COLORS, legend: 'right' })),
    md(32, 5, 16, 13, LEGEND_MD),
    // Two rows taller than the rest of the page: at 13 the treemap's floor-sized tiles were too short
    // for a two-line name once the legend took its row under the plot.
    vega(0, 18, 24, 15, '01-actor-risk-treemap', 'Actor footprint · area by √events, color by risk total',
      `The top 12 identities by signal volume (fewer on a narrow screen, down to 8), in one block per kind; the rest of each kind is folded into one grey “+N more” tile (just “+N” where the tile is narrow; hover it for the count). Blocks: named API key (labelled by the KEY, with its owner — the principal that created it — on a further line when there is room, and in the tooltip); person (a real email address); cloud API key (an organization-level Cloud key, which the audit stream records only by id and with no owner); platform (Elastic’s own service accounts and automation, such as elastic/kibana, the Kibana service account); user, no email (a user name that signed in but carries no email; absent on most projects); and unattributed (no authenticated principal: <anonymous>, an unauthenticated token, or a user name that only ever failed to sign in, such as elastic or admin in a password-guessing run). An identity is one tile even when its events disagree about its kind; it goes in the most specific block any of them supports. Area grows with the SQUARE ROOT of event volume, so one dominant identity cannot crush the rest into slivers, plus the same small share for every tile, so the quietest identity keeps a readable name but is never drawn larger than a busier one. Each tile prints its event count where it fits (a bare number on a narrow tile): read the number, not the area, for how much more one identity did. A name too long for its tile ends in “…” — the tooltip has the full name and exact counts. Color is Risk total, the quantity the Security Anomalies risk leaderboard ranks by: each scoring event’s risk weight (from 10 for a workflow run to 50 for a security configuration change; 0 for anything that does not score, and 0 for Kibana’s own routine API-key clean-up, which Privileged ops leaves out too) summed over the identity’s events, on a square-root scale. It is in weight × events, not events, so it runs well above the counts on the tiles. A key that carries its creator’s email is its own tile here, but counts under the person in Busiest identities. ${EDGE_NOTE} That is how a tile here and the same identity’s row in Busiest identities can differ by one or two events.`),
    /**
     * Lens, not the Vega band stream (vega/07, which 06 keeps): stacked on a linear axis, Signal — the band
     * this chart is named after — was a 1px sliver at 1h (0.7% of the stream), and its buckets and time
     * axis disagreed with Audit volume beside it. Side-by-side bars on a log axis show both sides of the gate at
     * any ratio, over the same buckets and span as Audit volume. Bars, not lines: a line joins the buckets
     * either side of an empty one, which drew a night of 2, 0, 2, 1, 0 signal events as a flat 2. Counted
     * by BAND_KEYS first and classified by BAND after, exactly as 06's band charts are, so Signal here is
     * 06's Signal band and the Signal events tile. Grouping on the gate itself as a boolean took 1.7s at
     * 7 days on the replica (its RLIKE ran per event instead of pushing down); this shape 755ms against
     * 788ms for the Vega stream it replaces (alternating medians).
     */
    logFloor(fullRange(xy(24, 18, 24, 15, `Signal vs noise over time${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ts = ${BUCKET}, ${BAND_KEYS} | ${BAND} | EVAL side = CASE(band == "signal", "Signal", "Noise") | STATS events = SUM(n) BY ts, side | EVAL ord = CASE(side == "Signal", 0, 1) | SORT ord, ts`,
      'events', 'Every audited event per time bucket, on either side of the noise gate: Signal is what the gate keeps (the Signal events tile, and what every gated panel reads), Noise is what it removes (health pings, query internals, API key lookups, page loads, bulk sign-in events and this suite’s own traffic). The two bars of a bucket add up to its Audit volume bar. LOG SCALE: each gridline is ten times the one below, so a bucket with one signal event among tens of thousands still shows; read the gap between the two bar tops as a ratio (one gridline apart is 10×). Platform Volume splits the noise into its bands. As on Audit volume, the last bucket covers only part of its interval, and a missing bar means no events on that side of the gate in that bucket.',
      { kind: 'bar', xcol: 'ts', breakdown: 'side', colors: { Signal: '#54B399', Noise: '#98A2B3' }, yScale: 'log' }))),
    table(0, 33, 13, TABLE_H, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY action = attributes.event.action, source = resource.attributes.service.name | ${SOURCE_LABEL} | SORT events DESC | LIMIT ${fitRows(TABLE_H)}`,
      ['action', sized('source', 100, { min: 100 })], [sized('events', COUNT_W, { min: COUNT_W })], 'Top audited actions after the noise gate, with the service that emitted them.'),
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
    table(13, 33, 22, TABLE_H, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS events = COUNT(*), actions = COUNT_DISTINCT(attributes.event.action), last_seen = MAX(@timestamp) BY actor, attributes.api_key.name | EVAL actor = CASE(attributes.api_key.name IS NOT NULL AND attributes.api_key.name != actor, CONCAT(actor, " · via key ", attributes.api_key.name), actor) | SORT events DESC | LIMIT ${fitRows(TABLE_H)}`,
      ['actor'], [sized('events', COUNT_W, { min: COUNT_W }), sized('actions', COUNT_W, { min: COUNT_W }), 'last_seen'],
      'The identities generating the most signal traffic, and how varied their behaviour is; the rows sum to Signal events when they all fit, and fewer rows than the bound means every identity with signal is listed (Distinct actors counts the same set). Identity resolves to an email, then an API key name, then a user id. An identity’s treemap tile and its row here can differ by an event or two at the range’s edges, because each panel reads the clock for itself. Elasticsearch stamps an API key’s CREATOR’s email on every event the key emits, so any number of machines authenticating with one key resolve to one person: such a row reads “email · via key name” and is a credential’s traffic, not the person at a keyboard. To follow one person across the suite, pick them in the Person (email) control above.'),
    // A bar rather than the donut it replaces: the donut's thin slices carried no label and it had no
    // legend, so the small categories could not be named. Grouping on the multi-valued field counts
    // an event once per category, as MV_EXPAND did, without materialising a row per value.
    // Every label carries its count, as 01's log bars do, and the axis is compact: in full digits Lens
    // dropped the 100,000 tick at 24h, and a count printed inside only the bars wide enough for it left
    // the reader two places to look. grouped() runs on the eight rows left after the LIMIT.
    compactValues(bar(35, 33, 13, TABLE_H, `Event categories${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY category = attributes.event.category | EVAL category = COALESCE(category, "none recorded") | SORT events DESC | LIMIT 8 | EVAL category = CONCAT(category, " · ", ${grouped('events')}) | KEEP category, events`,
      'category', 'events', 'ECS event categories over the whole stream, noise included, each with its count, on a log scale so the small categories are as readable as the bulk: read each bar by its count, not its length (each axis step is ten times the one before). event.category is a multi-value array, so an event in two categories counts once in each and the bars sum to more than the event total; “none recorded” is events that carry no category. A category with a single event has no visible bar.',
      { yScale: 'log' })),
    // h=25, not 15: Discover rows are 27px on a 28px grid unit, so the last visible row moves 1px per
    // unit of height. At 15 it was cut through its text; at 25 the grid ends on a row boundary.
    search(0, 46, 48, 25, '10-raw-signal-feed', 'Live signal feed · Kibana key clean-up left out',
      'The newest 200 signal events, newest first, behind the same noise gate as Signal events, without Kibana’s own routine API-key clean-up (invalidate_apikeys by the elastic/kibana service account, every few seconds), which would otherwise fill it: Privileged ops counts those in its “excl. N cleanups” line, and they still count in Signal events. Detail is the Kibana message, the transport action on an Elasticsearch event, or for a security change (API key, role) what it changed: “API key <name or id> + N more” for one call that invalidated several keys. A Client IP marked internal is Kibana or the platform calling Elasticsearch on someone’s behalf, not where they are; “none recorded” is an event with no client address, such as Kibana’s own service account working inside the platform. Automation reads as long runs of near-identical rows from one identity: this suite’s own install is left out by the gate, but any other script — a deploy, a scan, a tool polling an API — can fill this feed for minutes. To read past it, pick a Person above, or open the session and filter that identity out. Open the Discover session to page further back or add columns.'),
  ];
  return dash('cloud-audit-00-command-center', '[Audit] 🎛️ Command Center',
    'Entry point for Cloud Audit Dashboards. KPIs, volume, actor risk and the live signal feed.', P);
}
