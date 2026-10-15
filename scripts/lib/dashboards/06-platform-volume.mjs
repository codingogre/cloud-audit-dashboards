/** 06 Platform Volume — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ACTOR_RESOLVE, NOISE, BAND, BAND_KEYS, TIME, BUCKET, KIND_REFINE, SOURCE_LABEL, SOURCE_COLORS, PALETTE,
  dash, kpi, xy, table, vega, md, filterable, resetIds, cloudKeyLabel, isCloudKeyId, grouped
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
 * total is under a THIRD of the window's median bucket (QUIET_RATIO).
 *
 * History, because each earlier rule failed on a render. Round 2 dropped a bucket under a tenth of the
 * median; a 1h window quiet for 25 minutes then busy (median ~8,000) rendered its quiet stretch of
 * alternating ~500 / ~1,000-event minutes as a picket fence of bars and gaps. Round 3 kept anything
 * of 50 events or more to stop that, and the round-4 review found the opposite defect: a one-minute
 * lull of a few dozen events (live: 58 events between minutes of 3,700 and 5,600) drawn at 80% Signal,
 * the tallest-looking mark on the page, and the 24h window's opening half-bucket (628 events against a
 * median of ~38,000) drawn as full as the busiest half hour. An absolute floor cannot be right at
 * every volume — at 5–10× today's traffic a lull is hundreds or thousands of events — so the rule is a
 * ratio alone, and a third rather than a tenth: the picket-fence stretch (500 / 1,000 against 8,000)
 * now blanks as a whole, a lull blanks, and a low-volume project, whose buckets are all small together,
 * keeps them. Measured on the live stream: 1h (median 1,457) drops 13 of 57 minutes, the lull's
 * (2–448 events), and keeps the ~550–1,000-event stretch that follows; 24h drops only the partial
 * first bucket. On the 7-day replica it drops 6 of 48 buckets (a quarter would drop 5, a tenth 4).
 *
 * The rule needs a window-wide figure beside per-bucket rows, and INLINE STATS re-runs the scan
 * (measured 0.5s → 2.2s at 7d), so it is done by hand over the already-aggregated rows: one row per
 * bucket (total + its band counts packed into a multi-value), one row for the window (the median +
 * every bucket packed), then expanded back. It runs over at most 75 × 4 rows, so the 7-day cost is
 * unchanged. The bucket comes back under the column name xy() plots, as a datetime.
 */
const QUIET_RATIO = 3;
const QUIET_BUCKETS =
  'STATS total = SUM(events), parts = VALUES(CONCAT(band, "=", TO_STRING(events))) BY ts ' +
  '| STATS typical = MEDIAN(total), b = VALUES(CONCAT(TO_STRING(ts), "#", TO_STRING(total), "#", MV_CONCAT(parts, ";"))) ' +
  `| MV_EXPAND b | DISSECT b "%{ts}#%{total}#%{parts}" | WHERE TO_LONG(total) * ${QUIET_RATIO} >= typical ` +
  '| EVAL part = SPLIT(parts, ";") | MV_EXPAND part | DISSECT part "%{band}=%{events}" ' +
  `| EVAL \`${BUCKET}\` = TO_DATETIME(ts), events = TO_LONG(events) | KEEP \`${BUCKET}\`, band, events`;

/**
 * The note is a full-width strip rather than a side column: at 10 columns every inline code chip
 * wrapped onto its own line and the API-key caveat — the sentence that matters most — was clipped
 * off the bottom. Bands are bold run-ins named exactly as the legends and KPI tiles name them.
 */
const VOL_NOTE = `### The quarantine dashboard

Every other dashboard applies a **noise gate**; this one does not, so the whole firehose stays measurable. Every event lands in exactly one band, so the four band tiles add up to **All events** (on a live window, give or take the few events that arrive while the tiles load):
**Signal** — what the other dashboards read · **Auth success** — Elasticsearch's \`authentication_success\`, one per authenticated request
**Query internals** — search, \`ES|QL\`, Kibana \`/internal/\`, the suite's own traffic, \`connection_granted\` · **Infra health** — \`cluster:monitor/main\`, \`elastic.maintenance\`

An API key's events carry its **creator's** email, so a busy key can read as a person: **Via named key** in *Highest-volume identities* shows how much of a name is a key.`;

export function build() {
  resetIds();
  const P = [
    // HTTP requests rides on All events as its secondary, which frees a tile so the four band tiles
    // that follow add up to the headline: Signal + Auth success + Query internals + Infra health =
    // All events. One pass computes both (60ms, the same as the separate tile it replaces). The
    // secondary is a string because the metric shows a bare secondary number with no label; ES|QL
    // has no thousands separator, so grouped() writes "52,113" the way Lens prints the number above it.
    // "requests", not "HTTP requests": "728,436 HTTP requests" was cut at an 8-column tile's edge at 1440px.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`All events\` = COUNT(*), requests = COUNT_DISTINCT(attributes.http.request.id) | EVAL detail = CONCAT(${grouped('requests')}, " requests") | KEEP \`All events\`, detail`, 'All events',
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
    // it renders the bare Vega "Error". Axis labels sit left-aligned beside their tick, as Lens draws
    // them, so a tick in the last 6% of the window has its label blanked: it hung past the plot's right
    // edge on 00 at 1440px ("labelBound" did nothing with labelOverlap off).
    vega(0, 12, 30, 13, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Audit events per time bucket, stacked by band, so the top edge is the whole firehose and Signal sits on the baseline. Hover a segment for its band and the bucket total.'),
    // Named keys only, which is why it can be empty while the stream is busy: an organization-level Cloud
    // API key — very often the one running this suite — carries no name, and the stream records it by id
    // alone, so it is on Highest-volume identities, marked, and never here. The LIMIT is fitRows(13) = 12,
    // set by table(): round 4 held it at 10 because a twelfth row on the panel's bottom edge gave no sign
    // whether more followed, and the title's bound ("· top 12 at most") is now that sign.
    table(30, 12, 18, 13, 'Named API keys',
      `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.name IS NOT NULL | STATS events = COUNT(*) BY attributes.api_key.name | SORT events DESC | LIMIT 12`,
      [filterable('attributes.api_key.name')], ['events'],
      'The busiest API keys that have a name, by events, as many as the panel holds. Click a key to pin it across the suite. A Cloud API key has no name in the audit stream, so it is not listed here; it appears by id in Highest-volume identities, as “_4KEO… · Cloud API key” (its first five characters). These counts are the same events as that table\'s Via named key column.',
      // 'quiet', not "(empty without named-key traffic)": with the "top 12 at most" bound the longer
      // words ran past the edge of an 18-column panel at 1440px.
      { empty: 'quiet' }),
    // The share view, not a second copy of the stream above: both ran the same BAND × BUCKET query,
    // so the stacked-volume reading appeared twice. Percentages show what the volume chart cannot —
    // whether a spike was more noise or more signal.
    xy(0, 25, 24, 12, 'Band share over time',
      `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ts = ${BUCKET}, ${BAND_KEYS} | ${BAND} | STATS events = SUM(n) BY ts, band | ${QUIET_BUCKETS} | ${BAND_ORDER} | ${BAND_LABEL}`,
      'events', 'Each bucket’s events as 100%, split by band. A rising Signal share means activity, not housekeeping, is driving the volume. A bucket with under a third of the window’s typical (median) volume is left blank: as a percentage, a lull of a few dozen events would stand as tall as the busiest minute. Signal vs noise over time shows every bucket’s volume.',
      { kind: 'bar_percentage', breakdown: 'band', colors: BAND_COLORS }),
    // Grouped on the raw keyword, relabelled after: the two-condition CASE runs on the grouped rows,
    // not on every event (panels.mjs QUERY SHAPE rules 1–2). Same labels, colours and order as 00's.
    xy(24, 25, 24, 12, 'Audit volume by source service',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = resource.attributes.service.name | ${SOURCE_LABEL}`,
      'events', 'Elasticsearch versus Kibana audit volume over time. Elasticsearch audits every transport action, so it usually dwarfs Kibana.',
      { breakdown: 'source', colors: SOURCE_COLORS }),
    // Busiest identity replaces an Identities count that read 1 on every row at 1h (one machine identity
    // drives the whole firehose in a short window) and told the reader nothing; who is behind the noise
    // does, in every window, and "+ N more" keeps the count. Counted by action and the ACTOR_RESOLVE
    // COALESCE (Same resolution as Highest-volume identities beside it), then folded per action: the
    // busiest identity is the MAX of "<count, zero-padded by adding 1e12><identity>", whose first 13
    // characters are the count. The label runs on the grouped rows, before the SORT/LIMIT that table()
    // lowers; the name breaks ties, which otherwise swapped two equal rows between refreshes. Measured on
    // the 7-day replica: 111–158ms against 101–113ms for the count it replaces.
    table(0, 37, 24, 12, 'Noisiest transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | ${ACTOR_RESOLVE} ` +
      '| STATS n = COUNT(*) BY attributes.elasticsearch.audit.action, actor ' +
      '| STATS events = SUM(n), actors = COUNT(*), top = MAX(CONCAT(TO_STRING(1000000000000 + n), actor)) BY attributes.elasticsearch.audit.action ' +
      `| EVAL top_identity = SUBSTRING(top, 14) | EVAL top_identity = CONCAT(${cloudKeyLabel('top_identity')}, CASE(actors > 1, CONCAT(" + ", TO_STRING(actors - 1), " more"), "")) ` +
      '| KEEP attributes.elasticsearch.audit.action, top_identity, events | SORT events DESC, attributes.elasticsearch.audit.action | LIMIT 15',
      ['attributes.elasticsearch.audit.action', { column: 'top_identity', label: 'Busiest identity' }], ['events'],
      'Highest-volume Elasticsearch transport actions, unfiltered. Busiest identity is the identity behind most of each action’s events (resolved as in Highest-volume identities), followed by how many others also called it. ES|QL’s own fan-out (esql/compute, search_shards, field_caps[n]) is in Query internals, and much of it is dashboards querying this stream — often the Cloud API key running this suite, shown as “_4KEO… · Cloud API key” (its first five characters).'),
    // Kind is refined after the STATS (KIND_REFINE), where it costs nothing: ACTOR's two-way CASE calls
    // an unauthenticated principal and Elastic's own service accounts "service", which contradicts
    // SCOPE's vocabulary on every other dashboard. via_key is COUNT(field) — non-null values — so it is the share of a row's volume that
    // came through a named key, which is what the note's creator-stamping caveat asks the reader to
    // check, without splitting a person's row by key (measured: same cost as without it). On a Cloud API
    // key row it is null, printed "-": a 0 there read as "this API key's traffic came through no API key"
    // (round-4 review). The one-condition CASE runs on the grouped rows.
    table(24, 37, 24, 12, 'Highest-volume identities',
      `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS events = COUNT(*), via_key = COUNT(attributes.api_key.name), actions = COUNT_DISTINCT(attributes.event.action) BY actor, actor_kind | ${KIND_REFINE} | EVAL via_key = CASE(${isCloudKeyId('actor')}, null, via_key) | SORT events DESC, actor | LIMIT 15`,
      // Via API key and Actions are narrowed (90 / 72px still hold their headers) so that at a 1440px
      // viewport the Identity column keeps ~280px: "_4KEOq… · Cloud API key" ran into Kind at 248px.
      ['actor', 'actor_kind'], ['events', { column: 'via_key', label: 'Via named key', width: 100 }, { column: 'actions', width: 72 }],
      'Unfiltered volume leaderboard, top identities by events — this is where the machine traffic shows up (often the Cloud API key running this suite). Only the busiest rows fit, so quieter identities — including the smaller keys in Named API keys — are beyond the rows shown. Via named key: how many of the row’s events came through a NAMED (Elasticsearch) API key, the same events Named API keys counts. It reads “-” on a Cloud API key row: that key is itself the credential, and its events carry no key name, so the question does not apply.'),
  ];
  return dash('cloud-audit-06-platform-volume', '[Audit] 📊 Platform Volume & API Keys',
    'The unfiltered firehose, quarantined so the forensic dashboards stay readable.', P);
}
