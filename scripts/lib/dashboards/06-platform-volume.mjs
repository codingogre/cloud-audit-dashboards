/** 06 Platform Volume — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, NOISE, BAND, BAND_KEYS, TIME, BUCKET, KIND_REFINE, SOURCE_LABEL, SOURCE_COLORS, PALETTE,
  dash, kpi, xy, table, vega, md, filterable, resetIds
} from '../panels.mjs';

/**
 * Reader-facing band names. BAND's values are slugs ("authn-volume") that the drift check pins
 * verbatim, so they are relabelled AFTER the STATS — a CASE over a few hundred aggregated rows,
 * which costs nothing, where relabelling inside BAND would change the grouped value on every event.
 * vega/07-noise-ratio-stream.json carries this same text after its BAND; keep the two identical, or
 * the Vega and Lens legends name the same band differently on the same page.
 */
const BAND_LABEL =
  'EVAL band = CASE(band == "signal", "Signal", band == "authn-volume", "Auth success", ' +
  'band == "query-noise", "Query internals", "Infra health")';

/**
 * Lens draws breakdown series in the order they first appear in the result, first at the bottom of
 * the stack and first in the legend. Left to the hash order of the STATS, Signal landed on top of a
 * 100% stack, where its share can only be read against a moving floor. Sorting puts Signal on the
 * baseline, in the same order as the Vega stream; it runs over the aggregated rows only.
 */
const BAND_ORDER =
  'EVAL ord = CASE(band == "signal", 0, band == "authn-volume", 1, band == "query-noise", 2, 3) | SORT ord | DROP ord';

/**
 * One colour per band, from PALETTE, pinned so the Lens share chart and the Vega stream agree — the
 * review found blue meaning "authn" on one and "query noise" on the other, one panel apart. The two
 * noise bands take the warm, low-salience hues so the eye goes to Signal first; no grey, because a
 * grey that reads on white sits on the gridlines in dark theme.
 */
const BAND_COLORS = { 'Signal': PALETTE[0], 'Auth success': PALETTE[1], 'Query internals': PALETTE[6], 'Infra health': PALETTE[7] };

/**
 * Band share shows each bucket as 100%, so a bucket of six events stood exactly as tall as one of 7,000
 * (rendered: six minutes of solid "Query internals" during a lull). QUIET_BUCKETS drops a bucket whose
 * total is under a tenth of the window's median bucket. That needs a window-wide figure beside per-bucket
 * rows, and INLINE STATS re-runs the scan (measured 0.5s → 2.2s at 7d), so it is done by hand over the
 * already-aggregated rows: one row per bucket (total + its band counts packed into a multi-value), one
 * row for the window (the median + every bucket packed), then expanded back. It runs over at most
 * 75 × 4 rows, so the 7-day cost is unchanged (~0.58s either way, alternating runs on the perf replica).
 * The bucket comes back under the column name xy() plots, as a datetime.
 */
const QUIET_BUCKETS =
  'STATS total = SUM(events), parts = VALUES(CONCAT(band, "=", TO_STRING(events))) BY ts ' +
  '| STATS typical = MEDIAN(total), b = VALUES(CONCAT(TO_STRING(ts), "#", TO_STRING(total), "#", MV_CONCAT(parts, ";"))) ' +
  '| MV_EXPAND b | DISSECT b "%{ts}#%{total}#%{parts}" | WHERE TO_LONG(total) * 10 >= typical ' +
  '| EVAL part = SPLIT(parts, ";") | MV_EXPAND part | DISSECT part "%{band}=%{events}" ' +
  `| EVAL \`${BUCKET}\` = TO_DATETIME(ts), events = TO_LONG(events) | KEEP \`${BUCKET}\`, band, events`;

/**
 * The top identity is usually an organisation-level Cloud API key, which the stream records by id alone:
 * 93% of all events under a bare "_4KEOq…", with nothing saying what it is. vega/02 marks the same
 * principal the same way. realm = MIN(user.domain) rather than a per-event boolean: "_cloud_api_key"
 * sorts first among the realms, and the MIN measured 0.36 → 0.49s at 7d where the boolean took 0.78s.
 * Only a row with no email and no named-key traffic is marked; the CASE runs on the grouped rows.
 */
const CLOUD_KEY_MARK =
  'EVAL actor = CASE(realm == "_cloud_api_key" AND actor_kind == "service" AND via_key == 0, CONCAT(actor, " · Cloud API key"), actor)';

/**
 * The note is a full-width strip rather than a side column: at 10 columns every inline code chip
 * wrapped onto its own line and the API-key caveat — the sentence that matters most — was clipped
 * off the bottom. Bands are bold run-ins named exactly as the legends and KPI tiles name them.
 */
const VOL_NOTE = `### The quarantine dashboard

Every other dashboard applies a **noise gate**; this one does not, so the whole firehose stays measurable. Every event lands in exactly one band:
**Signal** — what the other dashboards read · **Auth success** — Elasticsearch's \`authentication_success\`, one per authenticated request
**Query internals** — search, ES|QL, Kibana \`/internal/\`, suite self-views, \`connection_granted\` · **Infra health** — \`cluster:monitor/main\`, \`elastic.maintenance\`

An API key's events carry its **creator's** email, so a busy key can read as a person: **Via API key** in *Highest-volume identities* shows how much of a name is a key.`;

export function build() {
  resetIds();
  const P = [
    // HTTP requests rides on All events as its secondary, which frees a tile so the four band tiles
    // that follow add up to the headline: Signal + Auth success + Query internals + Infra health =
    // All events. One pass computes both (60ms, the same as the separate tile it replaces). The
    // secondary is a string because the metric shows a bare secondary number with no label; ES|QL
    // has no thousands separator, so large counts read as "52.1k" rather than an unpunctuated 52113.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`All events\` = COUNT(*), requests = COUNT_DISTINCT(attributes.http.request.id) | EVAL detail = CONCAT(CASE(requests < 1000, TO_STRING(requests), CONCAT(TO_STRING(ROUND(requests / 1000.0, 1)), "k")), " HTTP requests") | KEEP \`All events\`, detail`, 'All events',
      'Total audited events, unfiltered. Beneath it, the distinct HTTP requests behind them — one request often emits several audit records.', { secondary: 'detail' }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal\` = COUNT(*)`, 'Signal', 'Events that survive the noise gate: what every other dashboard reads.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "authentication_success" | STATS \`Auth success\` = COUNT(*)`, 'Auth success',
      'Successful authentication events. Elasticsearch logs one per authenticated request, so credentials making many calls generate most of them.'),
    // Counted BY BAND_KEYS with no prefilter, like Signal share: BAND decides membership over the
    // grouped rows, so this tile cannot drift from the charts. A positive superset prefilter measured
    // no faster (450ms vs 454ms, 7d replica) once KIBANA_INTERNALS joined the band, and it was one more
    // list to keep in step. COALESCE because SUM over no rows is null, where COUNT was 0.
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ${BAND_KEYS} | ${BAND} | WHERE band == "query-noise" | STATS q = SUM(n) | EVAL \`Query internals\` = COALESCE(q, 0) | KEEP \`Query internals\``, 'Query internals',
      'The machinery behind a query, not a decision anyone made: Elasticsearch search phases, ES|QL sub-requests, field_caps, async search and point-in-time; Kibana /internal/ page requests; reads of this suite’s own saved objects; and transport connection_granted.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IN ("cluster:monitor/main","elastic.maintenance") | STATS \`Infra health\` = COUNT(*)`, 'Infra health',
      'Health-check and platform maintenance traffic.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ${BAND_KEYS} | ${BAND} | STATS total = SUM(n), sig = SUM(CASE(band == "signal", n, 0)) | EVAL \`Signal share\` = ROUND(sig * 1.0 / total, 4) | KEEP \`Signal share\``, 'Signal share',
      'Percentage of the firehose that survives the noise gate. The lower this is, the more the other dashboards are earning their keep.', { fmt: 'percent', dec: 2 }),
    md(0, 5, 48, 7, VOL_NOTE),
    // vega/07 draws one rect per band per bucket, and JSON has nowhere to say why it looks as it
    // does. A rect is one bucket wide: the smaller of the closest gap between buckets and the
    // interval BUCKET(…, 75, …) picks for the window (ES|QL's auto-date roundings, 1s … 1y), never
    // "until the next bucket", which stretched one minute's count across every empty minute after
    // it once a filter made the data sparse. The x domain is the whole time window, so the chart
    // lines up with the Lens charts below: t0/t1 are ?_tstart/?_tend echoed after the STATS and
    // drawn as an invisible rule. `"domain": {"%timefilter%": true}` was tried — on an ES|QL spec
    // it renders the bare Vega "Error".
    vega(0, 12, 30, 13, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Audit events per time bucket, stacked by band, so the top edge is the whole firehose and Signal sits on the baseline. Hover a segment for its band and the bucket total.'),
    // Named keys only, which is why it can be empty while the stream is busy: an organisation-level Cloud
    // API key — very often the one running this suite — carries no name, and the stream records it by id
    // alone, so it is on Highest-volume identities, marked, and never here. LIMIT 10, not fitRows(13) = 12:
    // a twelfth row sat on the panel's bottom edge with no sign whether more followed, and "busiest" with
    // the count in the description is the honest promise.
    table(30, 12, 18, 13, 'Busiest named API keys',
      `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.name IS NOT NULL | STATS events = COUNT(*) BY attributes.api_key.name | SORT events DESC | LIMIT 10`,
      [filterable('attributes.api_key.name')], ['events'],
      'The 10 busiest API keys that have a name, by events. Click a key to pin it across the suite. A Cloud API key has no name in the audit stream, so it is not listed here; it appears by id, marked "· Cloud API key", in Highest-volume identities. These counts are the same events as that table\'s Via API key column.',
      { empty: 'empty without named-key traffic' }),
    // The share view, not a second copy of the stream above: both ran the same BAND × BUCKET query,
    // so the stacked-volume reading appeared twice. Percentages show what the volume chart cannot —
    // whether a spike was more noise or more signal.
    xy(0, 25, 24, 12, 'Band share over time',
      `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ts = ${BUCKET}, ${BAND_KEYS} | ${BAND} | STATS events = SUM(n) BY ts, band | ${QUIET_BUCKETS} | ${BAND_ORDER} | ${BAND_LABEL}`,
      'events', 'Each bucket’s events as 100%, split by band. A rising Signal share means activity, not housekeeping, is driving the volume. A bucket with under a tenth of the window’s typical (median) volume is left blank: a percentage of a handful of events would stand as tall as a busy minute. Signal vs noise over time shows every bucket’s volume.',
      { kind: 'bar_percentage', breakdown: 'band', colors: BAND_COLORS }),
    // Grouped on the raw keyword, relabelled after: the two-condition CASE runs on the grouped rows,
    // not on every event (panels.mjs QUERY SHAPE rules 1–2). Same labels, colours and order as 00's.
    xy(24, 25, 24, 12, 'Audit volume by source service',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name | ${SOURCE_LABEL}`,
      'events', 'Elasticsearch versus Kibana audit volume over time. Elasticsearch audits every transport action, so it usually dwarfs Kibana.',
      { breakdown: 'source', colors: SOURCE_COLORS }),
    table(0, 37, 24, 12, 'Noisiest transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | STATS events = COUNT(*), actors = COUNT_DISTINCT(COALESCE(attributes.user.email, attributes.api_key.name, attributes.user.name)) BY attributes.elasticsearch.audit.action | SORT events DESC | LIMIT 15`,
      ['attributes.elasticsearch.audit.action'], ['events', 'actors'],
      'Highest-volume Elasticsearch transport actions, unfiltered, with the number of identities behind each. ES|QL’s own fan-out (esql/compute, search_shards, field_caps[n]) is in Query internals, and much of it is dashboards querying this stream.'),
    // Kind is refined after the STATS (KIND_REFINE), where it costs nothing: ACTOR's two-way CASE calls
    // an unauthenticated principal and Elastic's own service accounts "service", which contradicts
    // SCOPE's vocabulary on every other dashboard. via_key is COUNT(field) — non-null values — so it is the share of a row's volume that
    // came through a named key, which is what the note's creator-stamping caveat asks the reader to
    // check, without splitting a person's row by key (measured: same cost as without it).
    table(24, 37, 24, 12, 'Highest-volume identities',
      `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS events = COUNT(*), via_key = COUNT(attributes.api_key.name), actions = COUNT_DISTINCT(attributes.event.action), realm = MIN(attributes.user.domain) BY actor, actor_kind | ${KIND_REFINE} | ${CLOUD_KEY_MARK} | SORT events DESC | LIMIT 15`,
      // Via API key and Actions are narrowed (90 / 72px still hold their headers) so that at a 1440px
      // viewport the Identity column keeps ~280px: "_4KEOq… · Cloud API key" ran into Kind at 248px.
      ['actor', 'actor_kind'], ['events', { column: 'via_key', label: 'Via API key', width: 90 }, { column: 'actions', width: 72 }],
      'Unfiltered volume leaderboard, top identities by events — this is where the machine traffic shows up. An id marked "· Cloud API key" is an organisation-level Elastic Cloud API key, which the stream records only by id (often the credential running this suite); any other opaque id is a principal with no email or key name. Via API key: how many of the row’s events came through a named API key, the same events Busiest named API keys counts.'),
  ];
  return dash('cloud-audit-06-platform-volume', '[Audit] 📊 Platform Volume & API Keys',
    'The unfiltered firehose, quarantined so the forensic dashboards stay readable.', P);
}
