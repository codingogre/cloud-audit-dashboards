/** 06 Platform Volume — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ACTOR_RESOLVE, NOISE, BAND, BAND_KEYS, TIME, BUCKET, KIND_REFINE, SOURCE_LABEL, SOURCE_COLORS,
  dash, kpi, xy, table, vega, filterable, resetIds, cloudKeyLabel, isCloudKeyId, grouped
} from '../panels.mjs';
import { rawId } from '../suite.mjs';

/**
 * SIGNAL VS NOISE OVER TIME is one full-Vega panel (vega/07), not a Vega stream above a Lens share chart.
 *
 * Round 5 stacked the two so a minute lined up down the page, and they did not: Lens and Vega lay out a
 * time axis differently (plot inset, end padding), so 23:15 sat at x 1030 above and 1004 below, and their
 * tick sets and legends differed (the Lens legend dropped a band that was zero in the window). No setting
 * makes two renderers agree, so the charts now share ONE x scale in one spec: events stacked by band, then
 * Signal alone on its own square-root scale — at a 1–2% share Signal was a hairline on both stacked charts,
 * the series the panel is named for — then each bucket as 100%. One labelled time axis sits under the last
 * chart and one legend lists all four bands plus the lull swatch. One ES|QL query feeds all three (the
 * stream's, unchanged), so the page runs one band-by-bucket query where it ran two.
 *
 * vega/07 is also 00's stream, on a 15-row panel: under 440px of chart the spec draws the stacked events
 * alone, exactly as before. This panel is 25 rows, which is what selects the three-chart form.
 *
 * QUIET RULE. The share chart does not split a lull: it shades it with a "Too few events to split" swatch
 * that the legend names and the tooltip explains. Round 5 left those buckets blank, and a reader saw
 * holes where the stream above showed traffic. The rule picking them is unchanged, moved from ES|QL into
 * the spec's transforms (window lag/lead over the aggregated buckets, so it costs nothing):
 * As 100%, a bucket of six events stands exactly as tall as one of 7,000 (rendered: six minutes of solid
 * "Query internals" during a lull). Below, "blank" means such a bucket: shaded, not split.
 *
 * History, because each earlier rule failed on a render. Round 2 dropped a bucket under a tenth of the
 * median and drew a picket fence of bars and gaps over a stretch of ~500 / ~1,000-event minutes; round 3
 * kept anything of 50 events or more, and a 58-event lull between minutes of 3,700 and 5,600 stood at
 * 80% Signal; round 4 dropped a bucket under a THIRD of the median, and the round-5 review found the
 * fence again (live, 1h, median 4,240: minutes of 1,249 / 1,727 / 1,581 / 1,287 / 2,417 straddle the
 * 1,413 cut, so every other bar vanished). Any single cut fences whatever traffic oscillates around it.
 *
 * So the cut has hysteresis (a Schmitt trigger): with T the window's typical bucket total, a bucket is
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
 * A bucket under T that sits between two blank ones (or empty slots) is blank as well, quiet or loud: the
 * loud case above approximates its neighbours from their totals, and a quiet bucket two places from any
 * tiny one escaped it — round-6 skeptic, live 1h: one 1,064-event minute split at full height between
 * eight shaded minutes on each side, the picket the rule exists to prevent. A second pass over the
 * computed flags (lag/lead of blank) catches both; a bucket at either edge of the data is never forced.
 *
 * T is the median of the buckets holding at least a twentieth of the MEAN bucket, not of every bucket.
 * A plain median is captured by whatever most buckets are, and when most of a window is an overnight
 * trickle the trickle IS typical (round-6 skeptic, live 4h 10:00–14:00Z: 28 buckets of 1–37 events
 * then 19 of 3,700–49,000; median 19, so every 5-event bucket split at full height beside the 49,000
 * ones). The mean is pulled up by the busy buckets, so a twentieth of it drops the trickle from the
 * median and leaves a steady stream with one spike alone (60 minutes of ~100 and one of 20,000: mean
 * ~465, cut ~23, T 100). Simulated on the same live and replica windows: 4h and 6h now shade the trickle
 * as one run; 1h, 24h and every 7-day-replica window blank the same buckets as before.
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
 * Neighbours come from lag/lead over the present buckets: the bucket k spans away is one of the k before
 * (after) it when present, else 0 inside the data's range and "unknown" beyond it; span is the interval
 * BUCKET(…, 75, …) picks (ES|QL's auto-date roundings, the table the spec carries). Checked against the
 * ES|QL version it replaces on the live 1h window: the same 15 buckets blanked, 43 drawn; spans line up
 * with the data at 15m, 1h, 4h, 12h, 24h and the 7-day replica.
 */

/**
 * The intro (draft 8 of the 1.0.3 customer copy, INTRO TEXT in panels.mjs). It replaces "The quarantine
 * dashboard" note that sat under the tiles; what that note said in field names now lives in the tiles'
 * tooltips (authentication_success, cluster:monitor/main, the band sum on All events), and the API key
 * creator rule (Kind "human + key") in Highest-volume identities'. Bands are named exactly as the tiles.
 */
const INTRO = {
  h: 6,
  heading: 'All audit traffic, with nothing left out',
  paragraphs: [
    'The other dashboards hide routine background traffic so the meaningful events stand out. This page counts everything, split into four groups that add up to the total.',
    "**Signal** is what the other dashboards show. **Auth success** is logged once for every authenticated request. **Query internals** are the background steps behind searches and page loads. **Infra health** is Elastic's own monitoring.",
    'Use it to understand audit volume and to see how busy each API key is. **How to use it:** choose a Project, Person (email) or Client IP in the controls and set the time picker.',
  ],
};

export function build() {
  resetIds();
  const P = [
    // HTTP requests rides on All events as its secondary, which frees a tile so the four band tiles
    // that follow add up to the headline: Signal + Auth success + Query internals + Infra health =
    // All events. One pass computes both (60ms, the same as the separate tile it replaces). The
    // secondary is a string because the metric shows a bare secondary number with no label; ES|QL
    // has no thousands separator, so grouped() writes "52,113" the way Lens prints the number above it.
    // "requests", not "HTTP requests": "728,436 HTTP requests" was cut at an 8-column tile's edge at 1440px.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`All events\` = COUNT(*), requests = COUNT_DISTINCT(http.request.id) | EVAL detail = CONCAT(${grouped('requests')}, " requests") | KEEP \`All events\`, detail`, 'All events',
      'Total audited events, unfiltered. Beneath it, the distinct HTTP requests behind them — one request often emits several audit records. Every event lands in exactly one of the four bands (Signal, Auth success, Query internals, Infra health), so those tiles add up to this one, give or take the events of the second between two tiles\' fetches.', { secondary: 'detail' }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${NOISE} | STATS \`Signal\` = COUNT(*)`, 'Signal', 'Events that survive the noise gate: what every other dashboard reads.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE event.action == "authentication_success" | STATS \`Auth success\` = COUNT(*)`, 'Auth success',
      'Successful authentication events (authentication_success). Elasticsearch logs one per authenticated request, so credentials making many calls generate most of them.'),
    // Counted BY BAND_KEYS with no prefilter, like Signal share: BAND decides membership over the
    // grouped rows, so this tile cannot drift from the charts. A positive superset prefilter measured
    // no faster (450ms vs 454ms, 7d replica) once KIBANA_INTERNALS joined the band, and it was one more
    // list to keep in step. COALESCE because SUM over no rows is null, where COUNT was 0.
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ${BAND_KEYS} | ${BAND} | WHERE band == "query-noise" | STATS q = SUM(n) | EVAL \`Query internals\` = COALESCE(q, 0) | KEEP \`Query internals\``, 'Query internals',
      'The machinery behind a query, not a decision anyone made: Elasticsearch search phases, ES|QL sub-requests, field_caps, async search and point-in-time; reads of API key metadata (api_key/get and query); Kibana /internal/ page requests; reads of this suite’s own saved objects; and transport connection_granted.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.action IN ("cluster:monitor/main","elastic.maintenance") | STATS \`Infra health\` = COUNT(*)`, 'Infra health',
      'Health-check and platform maintenance traffic: cluster:monitor/main and elastic.maintenance.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS n = COUNT(*) BY ${BAND_KEYS} | ${BAND} | STATS total = SUM(n), sig = SUM(CASE(band == "signal", n, 0)) | EVAL \`Signal share\` = ROUND(sig * 1.0 / total, 4) | KEEP \`Signal share\``, 'Signal share',
      'Percentage of the firehose that survives the noise gate. The lower this is, the more the other dashboards are earning their keep.', { fmt: 'percent', dec: 2 }),
    // vega/07 draws one rect per band per bucket, and JSON has nowhere to say why it looks as it
    // does. A rect is one bucket wide: the smaller of the closest gap between buckets and the
    // interval BUCKET(…, 75, …) picks for the window (ES|QL's auto-date roundings, 1s … 1y), never
    // "until the next bucket", which stretched one minute's count across every empty minute after
    // it once a filter made the data sparse. The x domain is the whole time window: t0/t1 are
    // ?_tstart/?_tend echoed after the STATS. `"domain": {"%timefilter%": true}` was tried — on an
    // ES|QL spec it renders the bare Vega "Error". Axis labels sit left-aligned beside their tick, as
    // Lens draws them, so a tick near the right edge has its label blanked: it hung past the plot's
    // right edge on 00 at 1440px. The blank zone is measured in PIXELS — 36px for "22:25", 100px for a
    // midnight label carrying its date — because a 6%-of-window zone dropped a last label that had room.
    // At 25 rows the spec draws its three charts on one time axis (SIGNAL VS NOISE OVER TIME, above).
    vega(0, 5, 30, 25, '07-noise-ratio-stream', 'Signal vs noise over time',
      'Three views of the same buckets on one time axis. Top: audit events per bucket, stacked by band, so the top edge is the whole firehose and Signal sits on the baseline. Middle: Signal alone, on its own square-root scale, so a rise or fall in the events the other dashboards read is visible at any share. Bottom: each bucket as 100%, split by band — whether a spike was more noise or more signal. A lull is shaded and not split, because as a percentage a few dozen events would stand as tall as the busiest bucket: a bucket under a tenth of the window’s typical volume (the median bucket, leaving out a trickle under a twentieth of the average), one under a third right beside such a bucket, and a lone low bucket inside a lull; a stretch that is merely quiet is split. Hover any bar for its numbers.'),
    // Named keys only, which is why it can be empty while the stream is busy: an organization-level Cloud
    // API key — very often the one running this suite — carries no name, and the stream records it by id
    // alone, so it is on Highest-volume identities, marked, and never here (listing it would need a
    // computed key column, and a computed column loses the click-to-pin; panels.mjs blankNull).
    // h=15: fitRows(15) = 14 rows end 10px above the grid's bottom rule. At h=13 the 12 rows ended 2px
    // above it, which read as a sliver of a thirteenth row (round-5 review).
    // The empty words name the condition in four words: "(empty when none in range)" read as a developer
    // note (round-5 review), and "(empty when no named key was used)" runs off an 18-column title at 1440px.
    // Created by reconciles with Highest-volume identities: a key made by a person has that person's email
    // on its events (so its traffic is under the person there), any other key has its creator's user.name —
    // for a Cloud API key, its id, shown in the suite's one form.
    // Created by at 140px and Events at 72px leave the key name ~260px at a 1440px viewport: at 150 / 90
    // "syn-new-hire-20261014-152111-2820" ran under Created by, and at 140 / 80 it touched it.
    table(30, 5, 18, 15, 'Named API keys',
      `FROM ${IDX} | ${TIME} | WHERE api_key.name IS NOT NULL | STATS events = COUNT(*), emails = VALUES(user.email), names = VALUES(user.name) BY api_key.name ` +
      `| EVAL creator = COALESCE(MV_MIN(emails), MV_MIN(names)), n_creators = COALESCE(MV_COUNT(emails), 0) + COALESCE(MV_COUNT(names), 0) ` +
      `| EVAL created_by = COALESCE(CONCAT(${cloudKeyLabel('creator')}, CASE(n_creators > 1 AND emails IS NULL, CONCAT(" + ", TO_STRING(n_creators - 1), " more"), "")), " ") ` +
      '| KEEP api_key.name, created_by, events | SORT events DESC, api_key.name | LIMIT 14',
      [filterable('api_key.name'), { column: 'created_by', label: 'Created by', width: 140 }], [{ column: 'events', width: 72 }],
      'The busiest API keys that have a name, by events, as many as the panel holds. Click a key to pin it across the suite. Created by is who made the key, which Elasticsearch records on every event the key emits. A key made by a person counts under that person’s email in Highest-volume identities (Kind “human + key”); any other key has its own row there, with the same count as here. Empty when no named key was used in the time range: a Cloud API key has no name in the audit stream, so it is never listed here even while it drives the stream; it is in Highest-volume identities as “_4KEO… · Cloud API key” (its first five characters).',
      { empty: 'empty when unused' }),
    // Grouped on the raw keyword, relabelled after: the two-condition CASE runs on the grouped rows,
    // not on every event (panels.mjs QUERY SHAPE rules 1–2). Same labels, colours and order as 00's.
    xy(30, 20, 18, 10, 'Audit volume by source service',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${BUCKET}, source = service.name | ${SOURCE_LABEL}`,
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
    table(0, 30, 22, 10, 'Noisiest transport actions',
      `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.action IS NOT NULL | ${ACTOR_RESOLVE} ` +
      '| STATS n = COUNT(*) BY elasticsearch.audit.action, actor ' +
      '| STATS events = SUM(n), actors = COUNT(*), top = MAX(CONCAT(TO_STRING(1000000000000 + n), actor)) BY elasticsearch.audit.action ' +
      `| EVAL top_identity = SUBSTRING(top, 14) | EVAL top_identity = CONCAT(${cloudKeyLabel('top_identity')}, CASE(actors > 1, CONCAT(" + ", TO_STRING(actors - 1), " more"), "")) ` +
      '| KEEP elasticsearch.audit.action, top_identity, events | SORT events DESC, elasticsearch.audit.action | LIMIT 8',
      // Busiest identity at 210px holds "_4KEO… · Cloud API key + 19 more" and Events at 80px a seven-digit
      // count, so the action keeps the rest: at 22 columns and even widths, 1440px left
      // "cluster:admin/xpack/security/api_key/get" 4px short of the identity beside it.
      ['elasticsearch.audit.action', { column: 'top_identity', label: 'Busiest identity', width: 210 }], [{ column: 'events', width: 80 }],
      'Highest-volume Elasticsearch transport actions, unfiltered. Busiest identity is the identity behind most of each action’s events (resolved as in Highest-volume identities), followed by how many others also called it. ES|QL’s own fan-out (esql/compute, search_shards, field_caps[n]) is in Query internals, and much of it is dashboards querying this stream — often the Cloud API key running this suite, shown as “_4KEO… · Cloud API key” (its first five characters).'),
    // Kind is refined after the STATS (KIND_REFINE, then the key cases), where it costs nothing: ACTOR's
    // two-way CASE called every key — the Cloud API key and each named key — "service", the same word as
    // a service account, on a dashboard titled "… & API Keys" (round-5 review). A row is a named key when
    // all its events came through one (via_key == events: ACTOR_RESOLVE takes the key name only when the
    // event has no email), and a person's row is "human + key" when some of it did — the creator-stamping
    // caveat of the note, shown where it applies instead of a Via named key column that, on a project
    // whose keys were all made by the Cloud API key, could only ever read 0 or 100% (round-5 review).
    // No Created by column: at 1h, with no named key in the window, it was a 140px header over nothing on
    // every row (round-5 review). Who made a key is Named API keys' column, beside the stream; a key's row
    // here has the same count as there.
    // A name that only ever failed to sign in ("admin", 93 events at 24h: realm_authentication_failed and
    // authentication_failed, nothing else) is a guessed username, not a service account; ACTOR's cut called
    // it "service" (round-5 skeptic). Tested on the action VALUES after the STATS, not with a per-event
    // filtered COUNT: 7d replica 375–448ms against 384–402ms before, where VALUES replaces the
    // COUNT_DISTINCT that Actions was (MV_COUNT of the same set).
    // h=10 for both tables in this row: fitRows(10) = 8 rows, ending 14px above the grid's bottom rule.
    // At h=13 (12 rows) the last row ended 2px above it and read as a sliver of a thirteenth (round-5
    // review), and at 1h, when a handful of identities make the whole stream, 12 rows left 60% blank.
    table(22, 30, 26, 10, 'Highest-volume identities',
      `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS events = COUNT(*), via_key = COUNT(api_key.name), ` +
      `acts = VALUES(event.action) BY actor, actor_kind | ${KIND_REFINE} ` +
      '| EVAL actions = MV_COUNT(acts), acts = MV_CONCAT(MV_SORT(acts), ",") ' +
      `| EVAL actor_kind = CASE(${isCloudKeyId('actor')}, "API key", actor_kind == "service" AND via_key == events, "API key", ` +
      'actor_kind == "human" AND via_key > 0, "human + key", ' +
      'actor_kind == "service" AND acts IN ("authentication_failed", "realm_authentication_failed", "authentication_failed,realm_authentication_failed"), "failed sign-in", actor_kind) ' +
      '| KEEP actor, actor_kind, events, actions | SORT events DESC, actor | LIMIT 8',
      // Kind at 120px holds "unauthenticated" (it was cut at 92).
      // 26 columns, Noisiest 22: at 24 / 24 the Identity column kept ~215px at a 1440px viewport and
      // "<unauthenticated-cloud-access-token>" ran into Kind (round-5 skeptic); Noisiest's longest
      // action and "_4KEO… · Cloud API key + 19 more" still fit at 22.
      ['actor', { column: 'actor_kind', width: 120 }], ['events', { column: 'actions', width: 72 }],
      'Unfiltered volume leaderboard, top identities by events — this is where the machine traffic shows up (often the Cloud API key running this suite). Only the busiest rows fit, so quieter identities — including the smaller keys in Named API keys — are beyond the rows shown. Kind “API key” is a named (Elasticsearch) API key, listed under its own name, or a Cloud API key; who made a named key is in Named API keys. When a PERSON makes a key, its events carry that person’s email, so they count under the person, whose Kind then reads “human + key”. Kind “failed sign-in” is a username that only ever failed to authenticate — usually a guess, not an account.'),
  ];
  return dash(rawId('06-platform-volume'), '[Audit] 📊 Platform Volume & API Keys',
    'The unfiltered firehose, quarantined so the forensic dashboards stay readable.', P, { intro: INTRO });
}
