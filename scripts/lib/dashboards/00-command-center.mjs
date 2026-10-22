/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ACTOR_RESOLVE, NOISE, BAND, BAND_KEYS, TIME, BUCKET, SOURCE_LABEL, SOURCE_COLORS, dash, kpi, xy, bar, table, sized, vega, search,
  resetIds, privilegedKpi, prevKpi, grouped, fitRows, COVERAGE_REF, COVERAGE_TITLE
} from '../panels.mjs';
import {
  legendPanel, ACTOR_KEYS, PIN_PRINCIPAL, RAW_RECORDS
} from './shared.mjs';
import { isDeployed, rawId } from '../suite.mjs';

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

/** The intro (draft 1 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 12,
  heading: "See who did what across your Elastic Cloud projects",
  paragraphs: [
    "This overview shows how much activity there was, who was busiest, which identities carry the most risk, and the latest events as they arrive.",
    "Start here for a routine review or when something looks wrong, then use the links above to go deeper on one person, sign-ins, Kibana objects, data access, security or location.",
    `**How to use it:** choose a Project, Person (email), API key or Client IP in the controls to focus every panel, and set the time picker. ${RAW_RECORDS}`,
  ],
  howTo: [
    'Risk is weight × events, from 10 for a workflow run to 50 for a security change, so it runs far above event counts.',
    'An API key carries its creator’s email, so a person’s row can include a machine’s traffic (“email · via key”).',
    'Click a Principal id to filter the page or open Actor 360; a Cloud API key’s id also covers the API keys it created.',
    'A Client IP marked *internal* is Kibana or the platform acting for someone, not where they are.',
    'The last time bucket is partial, and panels side by side can differ by an event or two at the edges of the range.',
  ],
};

export function build() {
  resetIds();
  // Platform Volume is opt-in (lib/suite.mjs): a description may point at it only when it is deployed.
  const pv = isDeployed('06-platform-volume');
  const P = [
    // A DSL Vega tile with a previous-period line (PREV_TILES in panels.mjs); --lint holds its count to
    // the ES|QL `FROM … | TIME | STATS COUNT(*)` it replaced.
    prevKpi(0, 0, 8, 5, 'total-events',
      'Every audited event in range, routine machine traffic included. Compare with Signal events to see how much the noise gate removes.'),
    kpi(8, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal events\` = COUNT(*)`, 'Signal events',
      'Events left after the noise gate removes routine traffic: health checks, the background requests behind searches and page loads, API key lookups, bulk sign-in records and these dashboards\' own activity.'),
    // Gated, and resolved the same way as Busiest identities below, so the tile counts exactly the
    // identities that table ranks (an ungated count included people whose only traffic was the noise
    // gate's: 4 here over a 3-row table). Counted first by the raw identity fields, resolved after.
    kpi(15, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS n = COUNT(*) BY ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS \`Distinct actors\` = COUNT_DISTINCT(actor)`, 'Distinct actors',
      `Identities with signal traffic, named as in Busiest identities. Someone whose only events are routine (browsing dashboards, health checks) is not counted here${pv ? '; Platform Volume counts all traffic' : ''}.`),
    kpi(22, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | WHERE user.email IS NOT NULL | STATS \`Human actors\` = COUNT_DISTINCT(user.email)`, 'Human actors',
      'Distinct email addresses with signal traffic. Includes API keys whose events carry their creator’s email; Busiest identities shows those as “email · via key name”.'),
    // Widths follow the titles at a 1440px viewport, where a metric tile clips its secondary line and
    // wraps its title: the two "· all traffic" tiles need 9 columns, and Privileged ops' title 10. The
    // three short titles give up a column each.
    // PRIVILEGED (panels.mjs): Kibana's own API-key cleanup by elastic/kibana kept this tile permanently
    // non-zero (670 of 671 in an hour). It is left out and counted in the line under the number instead.
    kpi(29, 0, 10, 5, `FROM ${IDX} | ${TIME} | ${privilegedKpi(`Privileged ops${ALL}`)}`, `Privileged ops${ALL}`,
      'Security configuration changes (API keys created, changed or invalidated; roles and user profiles written) by anyone, all traffic. Kibana’s routine API-key clean-up is left out; the line above the number counts it. Any other non-zero value deserves review.',
      { secondary: 'housekeeping_note' }),
    prevKpi(39, 0, 9, 5, 'failed-events',
      'Failed outcomes and anonymous access denials across all traffic, routine included. The first place to look during an incident.'),
    // Named, pinned and ordered by the same SOURCE_LABEL / SOURCE_COLORS as 06's chart, so the two
    // sources are the same words and colours on both pages, and the stack stops swapping on refresh.
    fullRange(xy(0, 5, 32, 16, `Audit volume by source${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = service.name | ${SOURCE_LABEL}`,
      'events', 'Total audited events over time, by source service. Elasticsearch usually far outweighs Kibana, but Kibana holds most of the forensic value. The last bar is partial; a gap means no events were delivered for that bucket.',
      { breakdown: 'source', colors: SOURCE_COLORS, legend: 'right' })),
    // 11 rows, not 13: in the intro style (small text) the legend needs ~257px at 1920 and ~275px at 1440, so
    // 13 rows (356px) left a 100px blank under it; 11 (300px) fits both with no scrollbar. Audit volume
    // beside it spans the legend and the coverage tile under it.
    legendPanel(32, 5, 16, 11),
    // How far back the stream goes (panels.mjs, DATA COVERAGE): under the legend, which is about reading
    // the suite too, so Audit volume beside them grows to the pair's 16 rows rather than the grid gaining
    // a row of its own. No panel title: the spec draws one, like the metric tiles.
    vega(32, 16, 16, 5, COVERAGE_REF, '',
      'How far back this project\'s audit stream goes: its first stored event and the days since. It ignores the time picker and the controls. The retention line is the data stream\'s setting, read when the dashboards were installed.'),
    // Two rows taller than the rest of the page: at 13 the treemap's floor-sized tiles were too short
    // for a two-line name once the legend took its row under the plot.
    vega(0, 21, 24, 15, '01-actor-risk-treemap', 'Actor footprint · area by √events, color by risk total',
      'The busiest identities as tiles, grouped by kind: named API key, person, Cloud API key, platform, user without email, unattributed. Bigger means more activity, but read the printed count, not the area. Stronger color means more risk.'),
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
    logFloor(fullRange(xy(24, 21, 24, 15, `Signal vs noise over time${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ts = ${BUCKET}, ${BAND_KEYS} | ${BAND} | EVAL side = CASE(band == "signal", "Signal", "Noise") | STATS events = SUM(n) BY ts, side | EVAL ord = CASE(side == "Signal", 0, 1) | SORT ord, ts`,
      'events', 'Every bucket split into Signal, what the noise gate keeps, and Noise, the routine traffic it removes. Log scale: each gridline is ten times the one below, so read the gap between the bars as a ratio.',
      { kind: 'bar', xcol: 'ts', breakdown: 'side', colors: { Signal: '#54B399', Noise: '#98A2B3' }, yScale: 'log' }))),
    table(0, 36, 13, TABLE_H, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY action = event.action, source = service.name | ${SOURCE_LABEL} | SORT events DESC | LIMIT ${fitRows(TABLE_H)}`,
      ['action', sized('source', 100, { min: 100 })], [sized('events', COUNT_W, { min: COUNT_W })], 'Top audited actions after the noise gate, with the service that emitted them.'),
    /**
     * Groups on the computed `actor` like the Distinct actors tile, so the two count identities the
     * same way. A Kind column was tried and dropped: telling a cloud API key from an unattributed
     * principal needs user.domain on every event, which measured several times slower.
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
     *
     * Principal id (1.0.5, PIN_PRINCIPAL in shared.mjs) is the click-through: raw user.name, a group key, so a
     * click pins the principal and offers Open in Actor 360. Only that one of the two pin columns fits 22
     * columns at 1440px, and only in place of Last seen and Actions: Identity and Principal id each keep the
     * ~245px the 36-character placeholder `<unauthenticated-cloud-access-token>` needs (both cut it at
     * 165px, rendered). A named key's row pins its creator; the API key control pins the key itself.
     */
    table(13, 36, 22, TABLE_H, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR} | STATS events = COUNT(*) BY actor, api_key.name, user.name | EVAL actor = CASE(api_key.name IS NOT NULL AND api_key.name != actor, CONCAT(actor, " · via key ", api_key.name), actor) | SORT events DESC | LIMIT ${fitRows(TABLE_H)}`,
      ['actor', PIN_PRINCIPAL], [sized('events', COUNT_W, { min: COUNT_W })],
      'The identities with the most signal traffic. A row reading “email · via key name” is an API key’s traffic stamped with its creator’s email, not that person at a keyboard. Click a Principal id to filter or open Actor 360.'),
    // A bar rather than the donut it replaces: the donut's thin slices carried no label and it had no
    // legend, so the small categories could not be named. Grouping on the multi-valued field counts
    // an event once per category, as MV_EXPAND did, without materialising a row per value.
    // Every label carries its count, as 01's log bars do, and the axis is compact: in full digits Lens
    // dropped the 100,000 tick at 24h, and a count printed inside only the bars wide enough for it left
    // the reader two places to look. grouped() runs on the eight rows left after the LIMIT.
    compactValues(bar(35, 36, 13, TABLE_H, `Event categories${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY category = event.category | EVAL category = COALESCE(category, "none recorded") | SORT events DESC | LIMIT 8 | EVAL category = CONCAT(category, " · ", ${grouped('events')}) | KEEP category, events`,
      'category', 'events', 'Event categories across all traffic, routine included. Log scale: read each bar’s count, not its length. An event can belong to two categories, so the bars sum to more than the total; “none recorded” means no category.',
      { yScale: 'log' })),
    // h=25, not 15: Discover rows are 27px on a 28px grid unit, so the last visible row moves 1px per
    // unit of height. At 15 it was cut through its text; at 25 the grid ends on a row boundary.
    search(0, 49, 48, 25, '10-raw-signal-feed', 'Live signal feed · Kibana key clean-up left out',
      'The newest 200 signal events, with routine traffic and Kibana’s own key clean-up left out. Long runs of near-identical rows from one identity are automation: pick a Person, or filter it out in Discover, to read past it.'),
  ];
  return dash(rawId('00-command-center'), '[Audit] 🎛️ Command Center',
    'Entry point for Cloud Audit Dashboards. KPIs, volume, actor risk and the live signal feed.', P, { intro: INTRO });
}
