/** 00 Command Center — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, NOISE, BAND, BAND_KEYS, TIME, BUCKET, SOURCE_LABEL, SOURCE_COLORS, dash, kpi, xy, bar, table, sized, vega, resetIds,
  privilegedKpi, prevKpi, grouped, fitRows, COVERAGE_REF, COVERAGE_TITLE, ACTOR, filterable, HOUSEKEEPING, KIND_GROUPED, IDENTITY_KEYS
} from '../panels.mjs';
import {
  legendPanel, ACTOR_KEYS, PIN_PRINCIPAL, PIN_PRINCIPAL_SHORT, RAW_RECORDS
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

/**
 * Live signal feed (1.0.7.1: repeats grouped): searches/10-raw-signal-feed.json's events, bounded by TIME so the identity
 * dropdowns narrow it (RECORD FEEDS, panels.mjs), one row per identity, action, request, outcome and address. Until 1.0.7.1
 * it listed the newest 200 events, and one burst filled it: at 24h the 200 rows reached back 2h40m, 78 of them one Cloud
 * key's saved_object_find run inside 3 seconds (survey, hole 3). Grouped, 49 rows hold all 754 signal events of a 24h day,
 * and the burst is one row ("dashboard: 39 objects", 78 events).
 *
 * One STATS over the raw keys first (QUERY SHAPE rule 2: ACTOR_KEYS, the action, the request's parts, the outcome and
 * client.ip), cut to the 200 newest groups by their last event (QUERY SHAPE rule 3), and the CASEs that word each row run
 * on those 200. Request (1.0.5.6) still says what each request touched: an Elasticsearch event's transport action, a
 * Kibana saved-object event's "<type>: <title or id>" ("<type>: N objects" when a group read several), a Kibana web
 * request's path with its query string dropped (so the requests of one page group), or an Elasticsearch request's own
 * url.path when it ran no transport action (failed sign-ins: these rows read " " until 1.0.7.1), and "(not recorded)" on
 * the rest (7 days, live: 87 events, mostly activate_user_profile and create_apikey, carry no transport action, URL or
 * saved object; Action names them). `path` is computed only
 * where no transport action names the request: an Elasticsearch document path would otherwise split one action's group
 * per document. Request is computed, so it does not click; Action, Client IP and Principal id (the raw user.name, a group
 * key: it pins the identity and offers Open in Identity 360) do.
 *
 * Two STATS, because the path is the expensive part (measured on the 2.6M-event perf replica, `took`): with the REPLACE
 * on every event the query took 440ms at 24h and 1,974ms at 7d; without a path, 91ms and 278ms. So the first STATS
 * groups on the raw url.original and url.path (both wildcard fields, which group fine here), the REPLACE runs on those
 * groups, and a second STATS folds the groups whose paths differ only in host or query string: 101ms and 326ms. The
 * object count re-aggregates exactly by MAX: a saved-object event carries no URL, so each of its groups is one group of
 * the first STATS; that holds only while Kibana logs no URL on saved-object events (0 of 7,976 over 7 days, 2026-10-26),
 * and if it starts to, "N objects" would undercount with no error. The 1.0.7 feed (sorted and cut to 200 events first) took ~90ms at both windows; grouping has to read
 * every signal event in range, which is the price of a feed one burst cannot fill. The perf replica is the live stream
 * copied and re-dated, so a wider window adds events there but no new groups (647 at 24h and 7d; live: 70 and 234):
 * --perf times the event count, not the group count, and a stream with thousands of groups should be timed on real data.
 *
 * Columns at 1440px (1300px for a full-width table): Identity, Principal id, Action, Request, Outcome, Client IP, Events
 * and Last seen. Request is the column this feed is read for, and a transport action or a Kibana API path runs to
 * ~270px ("indices:admin/data_stream/lifecycle/get"); beside the Identity type badge it kept ~150px (~140px in 1.0.7).
 * So the feed is one of the tables with `noKind` (panels.mjs table()). That costs something: the type cannot be read
 * back from the name (README), so a named key or a service account reads like any other identity here; only a Cloud
 * key ("· Cloud API key") and an unnamed key ("Unnamed key of") still say what they are. The Identity type dropdown
 * still narrows the feed. The survey's Source
 * and First seen columns do not fit either: Source is implied by Request (a transport action is Elasticsearch, a saved
 * object or a path is Kibana), and a group's first event is in the Raw signal feed session.
 * client.ip is kept raw, with no "internal" tag (searches/10 adds one); the How to read block says what a 100.64/10 or
 * private address means.
 */
const FEED_KEYS = `${ACTOR_KEYS}, event.action, elasticsearch.audit.action, kibana.saved_object.type`;
const LIVE_FEED = `FROM ${IDX} | ${TIME} | ${NOISE} | WHERE NOT ${HOUSEKEEPING} ` +
  '| STATS events = COUNT(*), objects = COUNT_DISTINCT(kibana.saved_object.id), obj = MAX(COALESCE(kibana.saved_object.name, kibana.saved_object.id)), ' +
  `first_ts = MIN(@timestamp), last_ts = MAX(@timestamp) BY ${FEED_KEYS}, url.original, url.path, outcome = event.outcome, client.ip ` +
  '| EVAL path = CASE(elasticsearch.audit.action IS NULL, COALESCE(REPLACE(url.original, "^https?://[^/]+|[?].*$", ""), url.path)) ' +
  '| STATS events = SUM(events), objects = MAX(objects), obj = MAX(obj), first_ts = MIN(first_ts), last_ts = MAX(last_ts) ' +
  `BY ${FEED_KEYS}, path, outcome, client.ip ` +
  `| SORT last_ts DESC | LIMIT 200 | ${ACTOR_RESOLVE} ` +
  '| EVAL result = CASE(outcome == "unknown", "attempted", outcome), ' +
  'request = CASE(elasticsearch.audit.action IS NOT NULL, elasticsearch.audit.action, ' +
  'objects > 1, CONCAT(kibana.saved_object.type, ": ", TO_STRING(objects), " objects"), ' +
  'kibana.saved_object.type IS NOT NULL, CONCAT(kibana.saved_object.type, ": ", COALESCE(obj, "(no id)")), ' +
  // A bulk saved-object read ("User has accessed saved objects") records no object at all.
  'path IS NOT NULL, path, event.action LIKE "saved_object_*", "(objects not recorded)", "(not recorded)") ' +
  '| KEEP last_ts, events, actor, user.name, event.action, request, result, client.ip';

/** The intro (draft 1 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 6,
  heading: "See who did what across your Elastic Cloud projects",
  paragraphs: [
    "This overview shows how much activity there was, who was busiest, which identities carry the most risk, and the latest events as they arrive.",
    "Start here for a routine review or when something looks wrong, then use the links above to go deeper on one person, sign-ins, Kibana objects, data access, security or location.",
    `**How to use it:** choose a Project, Identity type, Identity or Client IP in the controls to focus every panel, and set the time picker. ${RAW_RECORDS}`,
  ],
  howTo: [
    'Risk is weight × events, from 10 for a workflow run to 50 for a security change, so it runs far above event counts.',
    'Identities read as in the Identity dropdown; a Cloud API key is shortened to the start of its id, “_4KEO… · Cloud API key”. The badge beside each is its Identity type.',
    'The links above carry the time range and filter pills to the next page, but no dropdown choice: pick again there.',
    'Click an underlined value (an action, an address, a Principal id) to filter the page; a Principal id also opens Identity 360, and a Cloud API key’s id covers the keys it created.',
    'In the Live signal feed, a Client IP in 100.64/10 or a private range is Kibana or the platform acting for someone, not where they are.',
    'The last time bucket is partial, and panels side by side can differ by an event or two at the edges of the range.',
  ],
};

export function build() {
  resetIds();
  // Platform Volume is opt-in (lib/suite.mjs): a description may point at it only when it is deployed.
  const pv = isDeployed('06-platform-volume');
  const P = [
    // An ES|QL Vega tile on the events view with a previous-period line (PREV_TILES in panels.mjs); --lint holds both counts to
    // the ES|QL `FROM … | TIME | STATS COUNT(*)` it replaced.
    prevKpi(0, 0, 8, 5, 'total-events',
      'Every audited event in range, routine machine traffic included. Compare with Signal events to see how much the noise gate removes.'),
    kpi(8, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal events\` = COUNT(*)`, 'Signal events',
      'Events left after the noise gate removes routine traffic: health checks, the background requests behind searches and page loads, API key lookups, bulk sign-in records and these dashboards\' own activity.'),
    // Gated, and resolved the same way as Busiest identities below, so the tile counts exactly the
    // identities that table ranks (an ungated count included people whose only traffic was the noise
    // gate's: 4 here over a 3-row table). Counted first by the raw identity fields, resolved after.
    kpi(15, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS n = COUNT(*) BY ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS \`Distinct identities\` = COUNT_DISTINCT(actor)`, 'Distinct identities',
      `Identities with signal traffic, named as in Busiest identities. Someone whose only events are routine (browsing dashboards, health checks) is not counted here${pv ? '; Platform Volume counts all traffic' : ''}.`),
    kpi(22, 0, 7, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | WHERE user.email IS NOT NULL | STATS \`Human identities\` = COUNT_DISTINCT(user.email)`, 'Human identities',
      'Distinct people with signal traffic, counted by email address. API key traffic has carried no email in this audit log, so it is not counted here, even for a key a person created.'),
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
    // A tile click pins the identity (vega/01 kibanaAddFilter), so the panel carries the Identity 360 drilldown (`pins`).
    vega(0, 21, 24, 15, '01-actor-risk-treemap', 'Identity footprint · area by √events, color by risk total',
      'The busiest identities as tiles, grouped by kind. Bigger means more activity: read the printed count, not the area. Stronger color means more risk; all green means nothing scored. Click a tile to pin the identity or open Identity 360.',
      { pins: true }),
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
    table(0, 36, 12, TABLE_H, 'Most frequent actions',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY event.action, source = service.name | ${SOURCE_LABEL} | SORT events DESC | LIMIT ${fitRows(TABLE_H)}`,
      [filterable('event.action', { label: 'Action' }), sized('source', 100, { min: 100 })], [sized('events', COUNT_W, { min: COUNT_W })], 'Top audited actions after the noise gate, with the service that emitted them. Click an action to filter the page by it.'),
    /**
     * Groups on the computed `actor` like the Distinct identities tile, so the two count identities the
     * same way: counted first by ACTOR_KEYS, resolved on the grouped rows (1.0.5.1; it resolved per event).
     *
     * No Email column. It was the click-to-pin column, but Identity already IS the email wherever there
     * is one, and on every other row Lens drew it as an underlined, clickable "-". The pin from this
     * page is the Identity control (or any Email cell on the other dashboards).
     *
     * No "email · via key" form any more (1.0.5.1): it was for an API key whose events carry its creator's
     * email, and no API key event in the stream carries one (0 of 39,000 over 30 days). Identity is now the
     * Identity dropdown's own value, so a row can be found there.
     *
     * Principal id (1.0.5, PIN_PRINCIPAL in shared.mjs) is the click-through: raw user.name, a group key, so a
     * click pins the principal and offers Open in Identity 360. Only that one of the two pin columns fits,
     * and only in place of Last seen and Actions: Principal id keeps the ~245px the 36-character placeholder
     * `<unauthenticated-cloud-access-token>` needs (cut at 165px, rendered). 25 columns since 1.0.5.4, for the
     * Identity type badge: the two panels beside it gave one column each. A named key's row pins its owner;
     * picking the key in the Identity dropdown narrows to it.
     */
    table(12, 36, 25, TABLE_H, 'Busiest identities',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS events = COUNT(*) BY ${IDENTITY_KEYS} | ${ACTOR_RESOLVE} | ${KIND_GROUPED} | STATS events = SUM(events) BY actor, identity_kind, user.name | SORT events DESC | LIMIT ${fitRows(TABLE_H)}`,
      ['actor', PIN_PRINCIPAL], [sized('events', COUNT_W, { min: COUNT_W })],
      'The identities with the most signal traffic, named as in the Identity dropdown, so any row can be picked there. Click a Principal id to filter the page or open Identity 360.'),
    // A bar rather than the donut it replaces: the donut's thin slices carried no label and it had no
    // legend, so the small categories could not be named. Grouping on the multi-valued field counts
    // an event once per category, as MV_EXPAND did, without materialising a row per value.
    // Every label carries its count, as 01's log bars do, and the axis is compact: in full digits Lens
    // dropped the 100,000 tick at 24h, and a count printed inside only the bars wide enough for it left
    // the reader two places to look. grouped() runs on the eight rows left after the LIMIT.
    compactValues(bar(37, 36, 11, TABLE_H, `Event categories${ALL}`,
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY category = event.category | EVAL category = COALESCE(category, "none recorded") | SORT events DESC | LIMIT 8 | EVAL category = CONCAT(category, " · ", ${grouped('events')}) | KEEP category, events`,
      'category', 'events', 'Event categories across all traffic, routine included. Log scale: read each bar’s count, not its length. An event can belong to two categories, so the bars sum to more than the total; “none recorded” means no category.',
      { yScale: 'log' })),
    // The record feed (RECORD FEEDS, panels.mjs): a Lens table, so the identity dropdowns narrow it. The same
    // events as the Raw signal feed session the intro links to (NOISE, then Kibana's key clean-up left out), with
    // repeats grouped (LIVE_FEED). 25 rows show 26 lines (fitRows), and the 200 groups the title states scroll.
    table(0, 49, 48, 25, 'Live signal feed · repeats grouped · Kibana key clean-up left out', LIVE_FEED,
      [sized('actor', 240, { min: 210 }), PIN_PRINCIPAL_SHORT, filterable('event.action', { label: 'Action', width: 175, min: 165 }),
        { column: 'request', label: 'Request' }, sized('result', 85, { label: 'Outcome', min: 80 }), filterable('client.ip', { label: 'Client IP', width: 125, min: 118 })],
      [sized('events', 66, { min: 64 }), sized('last_ts', 190, { label: 'Last seen', min: 190 })],
      'The newest signal activity, one row per identity, action, request, outcome and address, with its event count. Routine traffic and Kibana’s key clean-up left out. Click a Principal id, Action or Client IP to pin it.',
      { scroll: true, noKind: 'Request needs the room at 1440px; the Identity type dropdown still narrows the feed' }),
  ];
  return dash(rawId('00-command-center'), '[Audit] 🎛️ Command Center',
    'Entry point for Cloud Audit Dashboards. KPIs, volume, identity risk and the live signal feed.', P, { intro: INTRO });
}
