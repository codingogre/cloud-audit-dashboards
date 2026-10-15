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
 * (rendered: six minutes of solid "Query internals" during a lull). QUIET_BUCKETS blanks such buckets.
 *
 * History, because each earlier rule failed on a render. Round 2 dropped a bucket under a tenth of the
 * median and drew a picket fence of bars and gaps over a stretch of ~500 / ~1,000-event minutes; round 3
 * kept anything of 50 events or more, and a 58-event lull between minutes of 3,700 and 5,600 stood at
 * 80% Signal; round 4 dropped a bucket under a THIRD of the median, and the round-5 review found the
 * fence again (live, 1h, median 4,240: minutes of 1,249 / 1,727 / 1,581 / 1,287 / 2,417 straddle the
 * 1,413 cut, so every other bar vanished). Any single cut fences whatever traffic oscillates around it.
 *
 * So the cut has hysteresis (a Schmitt trigger): with T the window's median bucket total, a bucket is
 * tiny under T/10 and quiet under T/3, and only a tiny bucket can START a blank. A quiet bucket is blank
 * only when its run of quiet buckets reaches a tiny one; a stretch that merely swings around T/3, with no
 * tiny bucket in it, is drawn whole.
 *
 *   tiny                         always blank — its share cannot honestly stand at full height
 *   quiet, beside a tiny bucket  blank: the shoulder of a lull (looked up to two buckets along the run)
 *   quiet, otherwise             drawn: a dip, or a quiet stretch, is not a lull
 *   loud (≥ T/3)                 drawn, unless it is under T and BOTH sides are blank: a lone low bar
 *                                inside a lull. A bucket at or above T is always drawn.
 *
 * Beyond the first or last bucket counts as unknown, not as 0: otherwise a window that opens on a quiet
 * minute reads the minute before it as a lull and blanks its own opening (it did, at 16:00–17:00: two
 * ~1,200-event minutes). Inside the data an empty bucket is 0, i.e. tiny.
 *
 * Two rules failed before this one, both in round 5. Blanking a quiet bucket unless BOTH neighbours were
 * loud left a two-bucket hole in steady ~500–1,100 traffic (520 / 812 side by side under an 838 cut);
 * blanking every quiet run of 3+ moved the hole, not removed it (T 2,935, cut 978: 483 / 978 / 606
 * blanked, and the 1,152 beside them dropped as a lone bar, mid-stretch). Any rule keyed to T/3 holes a
 * stretch that sits on T/3; seeding the blank only from T/10 is what ends that.
 *
 * A ratio, not an absolute floor, so it holds at 5–10× today's volume, and a low-volume project whose
 * buckets are all small together keeps them. Simulated on thirteen live windows (1h, 4h, 6h, 24h) and the
 * 7-day replica: real lulls (2–68 events a bucket, and empty buckets) blank as one run each; the steady
 * stretches the earlier rules holed draw whole, except a single 275-event minute (under T/10) in one
 * window; 24h still drops only the partial first bucket (628 events against T 39,014).
 *
 * It needs each bucket's neighbours, and ES|QL has no window functions; INLINE STATS re-runs the scan
 * (measured 0.5s → 2.2s at 7d). So it is done by hand over the already-aggregated rows: one row per
 * bucket (total + its band counts packed), one row for the window (the median, every bucket packed,
 * and an index string ";<ms>=<total>;…"), then expanded back; a neighbour is LOCATE(index, ";<ms ±
 * span>="). `span` is the interval BUCKET(…, 75, …) picks for the window — ES|QL's auto-date roundings,
 * the same table vega/07 carries — worked out from ?_tstart/?_tend in seconds (a millisecond DATE_DIFF
 * overflows an int past 24 days). Everything after the first STATS runs on at most 75 × 4 rows, so it
 * costs nothing at 7d. The bucket comes back under the column name xy() plots, as a datetime.
 */
const SPANS_S = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 10800, 43200, 86400, 604800, 2592000, 7776000];
const SPAN =
  `CASE(${SPANS_S.map((s) => `need <= ${s}, ${s}`).join(', ')}, 31536000)`;
/**
 * The total of the bucket k spans away: 0 when it is inside the data's range with no events, -1 when it lies
 * beyond the first or last bucket (outside the window, or before the data starts), which counts as neither
 * tiny nor quiet — a window that opens mid-stretch must not read the minute before it as a lull.
 */
const NB = (name, k) => {
  const at = `ms + ${k} * span`;
  const key = `CONCAT(";", TO_STRING(${at}), "=")`;
  return `${name} = CASE(${at} < lo OR ${at} > hi, TO_LONG(-1), LOCATE(idx, ${key}) > 0, ` +
    `TO_LONG(MV_FIRST(SPLIT(SUBSTRING(idx, LOCATE(idx, ${key}) + LENGTH(${key})), ";"))), TO_LONG(0))`;
};
const T_ = (v) => `${v} >= 0 AND ${v} * 10 < typical`;
const Q_ = (v) => `${v} >= 0 AND ${v} * 3 < typical`;
const QUIET_BUCKETS =
  'STATS total = SUM(events), parts = VALUES(CONCAT(band, "=", TO_STRING(events))) BY ts | EVAL ms = TO_LONG(ts) ' +
  '| STATS typical = MEDIAN(total), b = VALUES(CONCAT(TO_STRING(ms), "#", TO_STRING(total), "#", MV_CONCAT(parts, ";"))), ' +
  'idx = VALUES(CONCAT(";", TO_STRING(ms), "=", TO_STRING(total))), lo = MIN(ms), hi = MAX(ms) ' +
  '| EVAL idx = CONCAT(MV_CONCAT(idx, ""), ";"), need = DATE_DIFF("second", TO_DATETIME(?_tstart), TO_DATETIME(?_tend)) / 75.0 ' +
  `| EVAL span = 1000 * TO_LONG(${SPAN}) ` +
  '| MV_EXPAND b | DISSECT b "%{ms}#%{total}#%{parts}" | EVAL ms = TO_LONG(ms), total = TO_LONG(total) ' +
  `| EVAL ${NB('p1', -1)}, ${NB('n1', 1)}, ${NB('p2', -2)}, ${NB('n2', 2)}, ${NB('p3', -3)}, ${NB('n3', 3)} ` +
  // t* tiny, q* quiet (a tiny bucket is quiet too); T = typical. Blank: a tiny bucket; a quiet one whose quiet run
  // reaches a tiny bucket within two steps; a loud one under T whose BOTH sides are blank (a side is blank when it
  // is beyond the data, tiny, or quiet and running into a tiny bucket within three steps).
  `| EVAL tp1 = ${T_('p1')}, tp2 = ${T_('p2')}, tp3 = ${T_('p3')}, tn1 = ${T_('n1')}, tn2 = ${T_('n2')}, tn3 = ${T_('n3')}, ` +
  `qp1 = ${Q_('p1')}, qp2 = ${Q_('p2')}, qn1 = ${Q_('n1')}, qn2 = ${Q_('n2')} ` +
  '| WHERE CASE(total * 10 < typical, false, ' +
  'total * 3 < typical, NOT (tp1 OR tn1 OR (qp1 AND tp2) OR (qn1 AND tn2)), ' +
  'total >= typical OR NOT ((p1 < 0 OR tp1 OR (qp1 AND (tp2 OR (qp2 AND tp3)))) AND (n1 < 0 OR tn1 OR (qn1 AND (tn2 OR (qn2 AND tn3)))))) ' +
  '| EVAL part = SPLIT(parts, ";") | MV_EXPAND part | DISSECT part "%{band}=%{events}" ' +
  `| EVAL \`${BUCKET}\` = TO_DATETIME(ms), events = TO_LONG(events) | KEEP \`${BUCKET}\`, band, events`;

/**
 * The note is a full-width strip rather than a side column: at 10 columns every inline code chip
 * wrapped onto its own line and the API-key caveat — the sentence that matters most — was clipped
 * off the bottom. Bands are bold run-ins named exactly as the legends and KPI tiles name them.
 */
const VOL_NOTE = `### The quarantine dashboard

Every other dashboard applies a **noise gate**; this one does not, so the whole firehose stays measurable. Every event lands in exactly one band, so the four band tiles add up to **All events** (on a live window, give or take the few events that arrive while the tiles load):
**Signal**: what the other dashboards read · **Auth success**: Elasticsearch's \`authentication_success\`, one per authenticated request
**Query internals**: search, \`ES|QL\`, Kibana \`/internal/\`, the suite's own traffic, \`connection_granted\` · **Infra health**: \`cluster:monitor/main\`, \`elastic.maintenance\`

A named API key's events carry its **creator**: a person's key counts under that person (Kind **human + key**), any other under its own name.`;

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
    // edge on 00 at 1440px ("labelBound" did nothing with labelOverlap off). The blank zone is measured in
    // PIXELS — 36px for "22:25", 100px for a midnight label carrying its date — because a 6%-of-window
    // zone dropped a last label that had room (06 at 1920: 22:25 blank, 68px from the edge, while Band
    // share below printed it). Band share sits directly under this chart at the same width (30 columns),
    // so a minute lines up down the page (the stream's y axis is held at minExtent 50, the width of
    // "200,000", so a quiet window's "12,000" does not widen its plot past Band share's); Audit volume by
    // source takes the other 18.
    vega(0, 12, 30, 13, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Audit events per time bucket, stacked by band, so the top edge is the whole firehose and Signal sits on the baseline. Hover a segment for its band and the bucket total.'),
    // Named keys only, which is why it can be empty while the stream is busy: an organization-level Cloud
    // API key — very often the one running this suite — carries no name, and the stream records it by id
    // alone, so it is on Highest-volume identities, marked, and never here. The LIMIT is fitRows(13) = 12,
    // set by table(): round 4 held it at 10 because a twelfth row on the panel's bottom edge gave no sign
    // whether more followed, and the title's bound ("· top 12 at most") is now that sign.
    // Created by is the same column as Highest-volume identities' and reconciles the two: a key made by a
    // person has that person's email on its events (so its traffic is under the person there), any other
    // key has its creator's user.name — for a Cloud API key, its id, shown in the suite's one form.
    // Created by at 140px and Events at 72px leave the key name ~260px at a 1440px viewport: at 150 / 90
    // "syn-new-hire-20261014-152111-2820" ran under Created by, and at 140 / 80 it touched it.
    table(30, 12, 18, 13, 'Named API keys',
      `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.name IS NOT NULL | STATS events = COUNT(*), emails = VALUES(attributes.user.email), names = VALUES(attributes.user.name) BY attributes.api_key.name ` +
      `| EVAL creator = COALESCE(MV_MIN(emails), MV_MIN(names)), n_creators = COALESCE(MV_COUNT(emails), 0) + COALESCE(MV_COUNT(names), 0) ` +
      `| EVAL created_by = COALESCE(CONCAT(${cloudKeyLabel('creator')}, CASE(n_creators > 1 AND emails IS NULL, CONCAT(" + ", TO_STRING(n_creators - 1), " more"), "")), " ") ` +
      '| KEEP attributes.api_key.name, created_by, events | SORT events DESC, attributes.api_key.name | LIMIT 12',
      [filterable('attributes.api_key.name'), { column: 'created_by', label: 'Created by', width: 140 }], [{ column: 'events', width: 72 }],
      'The busiest API keys that have a name, by events, as many as the panel holds. Click a key to pin it across the suite. Created by is who made the key, which Elasticsearch records on every event the key emits. A key made by a person counts under that person’s email in Highest-volume identities (Kind “human + key”); any other key has its own row there, with the same count as here. A Cloud API key has no name in the audit stream, so it is not listed here; it appears by id, as “_4KEO… · Cloud API key” (its first five characters).',
      // 'quiet', not "(empty without named-key traffic)": with the "top 12 at most" bound the longer
      // words ran past the edge of an 18-column panel at 1440px.
      { empty: 'quiet' }),
    // The share view, not a second copy of the stream above: both ran the same BAND × BUCKET query,
    // so the stacked-volume reading appeared twice. Percentages show what the volume chart cannot —
    // whether a spike was more noise or more signal.
    xy(0, 25, 30, 12, 'Band share over time',
      `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ts = ${BUCKET}, ${BAND_KEYS} | ${BAND} | STATS events = SUM(n) BY ts, band | ${QUIET_BUCKETS} | ${BAND_ORDER} | ${BAND_LABEL}`,
      'events', 'Each bucket’s events as 100%, split by band. A rising Signal share means activity, not housekeeping, is driving the volume. A lull is left blank, because as a percentage a few dozen events would stand as tall as the busiest minute: a bucket under a tenth of the window’s typical (median) volume, a bucket under a third of it right beside one of those, and a lone low bar inside such a lull. A stretch that is merely quiet is drawn. Signal vs noise over time, directly above, shows every bucket’s volume.',
      { kind: 'bar_percentage', breakdown: 'band', colors: BAND_COLORS }),
    // Grouped on the raw keyword, relabelled after: the two-condition CASE runs on the grouped rows,
    // not on every event (panels.mjs QUERY SHAPE rules 1–2). Same labels, colours and order as 00's.
    xy(30, 25, 18, 12, 'Audit volume by source service',
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
    table(0, 37, 22, 13, 'Noisiest transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | ${ACTOR_RESOLVE} ` +
      '| STATS n = COUNT(*) BY attributes.elasticsearch.audit.action, actor ' +
      '| STATS events = SUM(n), actors = COUNT(*), top = MAX(CONCAT(TO_STRING(1000000000000 + n), actor)) BY attributes.elasticsearch.audit.action ' +
      `| EVAL top_identity = SUBSTRING(top, 14) | EVAL top_identity = CONCAT(${cloudKeyLabel('top_identity')}, CASE(actors > 1, CONCAT(" + ", TO_STRING(actors - 1), " more"), "")) ` +
      '| KEEP attributes.elasticsearch.audit.action, top_identity, events | SORT events DESC, attributes.elasticsearch.audit.action | LIMIT 12',
      // Busiest identity at 210px holds "_4KEO… · Cloud API key + 19 more" and Events at 80px a seven-digit
      // count, so the action keeps the rest: at 22 columns and even widths, 1440px left
      // "cluster:admin/xpack/security/api_key/get" 4px short of the identity beside it.
      ['attributes.elasticsearch.audit.action', { column: 'top_identity', label: 'Busiest identity', width: 210 }], [{ column: 'events', width: 80 }],
      'Highest-volume Elasticsearch transport actions, unfiltered. Busiest identity is the identity behind most of each action’s events (resolved as in Highest-volume identities), followed by how many others also called it. ES|QL’s own fan-out (esql/compute, search_shards, field_caps[n]) is in Query internals, and much of it is dashboards querying this stream — often the Cloud API key running this suite, shown as “_4KEO… · Cloud API key” (its first five characters).'),
    // Kind is refined after the STATS (KIND_REFINE, then the key cases), where it costs nothing: ACTOR's
    // two-way CASE called every key — the Cloud API key and each named key — "service", the same word as
    // a service account, on a dashboard titled "… & API Keys" (round-5 review). A row is a named key when
    // all its events came through one (via_key == events: ACTOR_RESOLVE takes the key name only when the
    // event has no email), and a person's row is "human + key" when some of it did — the creator-stamping
    // caveat of the note, shown where it applies instead of a Via named key column that, on a project
    // whose keys were all made by the Cloud API key, could only ever read 0 or 100% (round-5 review).
    // Created by is the key's creator, which Elasticsearch stamps as user.name on every event the key
    // emits (HANDOFF.md): VALUES over named-key events only, so a person's row carries nothing extra.
    // A name that only ever failed to sign in ("admin", 93 events at 24h: realm_authentication_failed and
    // authentication_failed, nothing else) is a guessed username, not a service account; ACTOR's cut called
    // it "service" (round-5 skeptic). Tested on the action VALUES after the STATS, not with a per-event
    // filtered COUNT: 7d replica 375–448ms against 384–402ms before, where VALUES replaces the
    // COUNT_DISTINCT that Actions was (MV_COUNT of the same set).
    // fitRows(13) = 12 rows exactly; at h=12 the 10 rows left a blank strip under the last one.
    table(22, 37, 26, 13, 'Highest-volume identities',
      `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS events = COUNT(*), via_key = COUNT(attributes.api_key.name), ` +
      'creators = VALUES(attributes.user.name) WHERE attributes.api_key.name IS NOT NULL, ' +
      `acts = VALUES(attributes.event.action) BY actor, actor_kind | ${KIND_REFINE} ` +
      '| EVAL actions = MV_COUNT(acts), acts = MV_CONCAT(MV_SORT(acts), ",") ' +
      `| EVAL actor_kind = CASE(${isCloudKeyId('actor')}, "API key", actor_kind == "service" AND via_key == events, "API key", ` +
      'actor_kind == "human" AND via_key > 0, "human + key", ' +
      'actor_kind == "service" AND acts IN ("authentication_failed", "realm_authentication_failed", "authentication_failed,realm_authentication_failed"), "failed sign-in", actor_kind) ' +
      '| EVAL creator = CASE(actor_kind == "API key" AND via_key == events, MV_MIN(creators)), n_creators = MV_COUNT(creators) ' +
      `| EVAL created_by = COALESCE(CONCAT(${cloudKeyLabel('creator')}, CASE(n_creators > 1, CONCAT(" + ", TO_STRING(n_creators - 1), " more"), "")), " ") ` +
      '| KEEP actor, actor_kind, created_by, events, actions | SORT events DESC, actor | LIMIT 12',
      // Kind at 120px holds "unauthenticated" (it was cut at 92); Created by holds "_4KEO… · Cloud API key".
      // 26 columns, Noisiest 22: at 24 / 24 the Identity column kept ~215px at a 1440px viewport and
      // "<unauthenticated-cloud-access-token>" ran into Kind (round-5 skeptic); Noisiest's longest
      // action and "_4KEO… · Cloud API key + 19 more" still fit at 22.
      ['actor', { column: 'actor_kind', width: 120 }, { column: 'created_by', label: 'Created by', width: 140 }], ['events', { column: 'actions', width: 72 }],
      'Unfiltered volume leaderboard, top identities by events — this is where the machine traffic shows up (often the Cloud API key running this suite). Only the busiest rows fit, so quieter identities — including the smaller keys in Named API keys — are beyond the rows shown. Kind “API key” is a named (Elasticsearch) API key, listed under its own name, or a Cloud API key; Created by is who made a named key, which Elasticsearch records on every event the key emits. When a PERSON makes a key, its events carry that person’s email, so they count under the person, whose Kind then reads “human + key”. Kind “failed sign-in” is a username that only ever failed to authenticate — usually a guess, not an account.'),
  ];
  return dash('cloud-audit-06-platform-volume', '[Audit] 📊 Platform Volume & API Keys',
    'The unfiltered firehose, quarantined so the forensic dashboards stay readable.', P);
}
