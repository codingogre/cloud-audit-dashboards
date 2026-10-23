/** 01 Identity & Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, ACTOR_KEYS, ORG, CRED_TYPE_LABEL, CRED_TYPE_COLORS, TIME, dash, kpi, xy, table, sized,
  vega, search, resetIds, bar, filterable, grouped, FAILED_OR_DENIED, SIGNIN_FAILED
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import { WHO, RAW_RECORDS } from './shared.mjs';

// FAILED_OR_DENIED and SIGNIN_FAILED live in panels.mjs: 04's failure panels count the same way.

/**
 * Every API key, of both kinds, and the one key that names it. Measured on the live stream (24h):
 *
 *   Cloud API key          api_key.* absent; user.domain "_cloud_api_key" and user.name = the
 *                          key's id. It carried ~880k events a day — far the busiest credential — and the
 *                          old `api_key.name IS NOT NULL` filter left it off every API-key panel, so the
 *                          tile read "0 · none in range" beside a chart of thousands of API-key requests.
 *   Elasticsearch API key  api_key.id and .name; user.name is the principal that OWNS it (here, the
 *                          Cloud API key that minted it). No key event carries an email (0 of ~39,000
 *                          over 30 days, 1.0.5.1).
 *
 * So a key is `COALESCE(api_key.id, user.name)` under this filter, and the two kinds never collide: a
 * row with no api_key.id is a Cloud key by construction. Kibana logs a call made with an Elasticsearch
 * key as user.domain "_es_api_key" with no key id, so those calls cannot be put on a key and are not here.
 * 7d on the perf replica: Busiest API keys 50 → 260ms, the tile 43 → 90ms, the inventory 90 → 390ms —
 * the cost of the 1.7M Cloud-key events the panels used to skip.
 */
const KEYED = 'WHERE api_key.id IS NOT NULL OR user.domain == "_cloud_api_key"';
const KEY_DERIVE = 'EVAL key_id = COALESCE(api_key.id, user.name), ' +
  'kind = CASE(api_key.id IS NULL, "Cloud", "Elasticsearch")';

/**
 * "N things" for a KPI's secondary line, in words when N is 0 or 1. A digit zero renders slashed in the
 * metric font, which read as a different typeface from the words beside it, so zero is spelt out.
 * A multi-branch CASE, but it runs once, on the single row a STATS without BY returns.
 */
const count = (x, one, many, zero) =>
  `CASE(${x} == 0, "${zero}", ${x} == 1, "1 ${one}", CONCAT(${grouped(x)}, " ${many}"))`;

/**
 * A log-scale bar chart's value axis, from 0.5 so a count of 1 still draws a bar (log(1) is the floor
 * otherwise). The API takes a custom domain only with both ends (a min alone is a 400), so the top is
 * set with room to spare. Measured live: one Cloud API key sends ~1.4M events a day, so a 7-day
 * range's ~2.2h intervals peak near 130k and a 30-day total is ~42M. The whole-range bars' 1B is
 * 10x a 30-day total. (The time chart has its own per-minute axis: rateBar below.)
 */
const logBar = (p, max) => { p.config.axis.y.domain = { type: 'custom', min: 0.5, max, rounding: false }; return p; };

/**
 * The time chart's per-minute axis (the panel says why per minute): 0.001 to 100k, printed in the
 * compact form the whole-range bars use (1 · 100 · 10k), so the page has one number style on its axes.
 * A custom numeral pattern, which the 9.6 Dashboards API accepts and stores (checked by PUT and GET):
 * '0.[000]a' prints decimals only where there are any, so 0.001 and 0.033 read as such where the
 * compact number type would print "0".
 */
const rateBar = (p) => {
  p.config.axis.y.domain = { type: 'custom', min: 0.001, max: 1e5, rounding: false };
  p.config.layers[0].y[0].format = { type: 'custom', pattern: '0.[000]a' };
  return p;
};

/**
 * Time bars counted back from the end of the range, for a per-minute rate (the time chart below says
 * why Lens needs them). One interval, `span` seconds, from BUCKET's ladder at its 75-bar target, so a bar
 * is 1 minute at 1h, 30 at 24h and 3 hours at 7d as before. Its CASE reads only the two range
 * parameters, so ES|QL folds it to a constant: per event the query adds one DATE_DIFF and a division.
 *
 *   EVAL k = DATE_DIFF("second", @timestamp, ?_tend) / <span>      per event: whole intervals before the end
 *   STATS events = COUNT(*) BY k, <series> | <bars(series)>         per grouped row: ts, per_minute
 *
 * Bar k covers (end − (k+1)·span, end − k·span], so the newest bar ends exactly at the range end and the
 * oldest starts at its start: the first and last bars Lens will draw (a bar must start inside the range
 * and no later than one bar before its end). Anchored to the minute instead, so bar times read as whole
 * minutes, one end or the other always fell outside. A range that is not a whole number of spans leaves
 * a remainder older than the oldest bar; that bar absorbs it (k clamped to n − 1), with the remainder
 * in its divisor, so every rate is exact.
 */
const R_LEN = 'DATE_DIFF("second", TO_DATETIME(?_tstart), TO_DATETIME(?_tend))';
const SPAN = `CASE(${R_LEN} <= 4500, 60, ${R_LEN} <= 22500, 300, ${R_LEN} <= 45000, 600, ${R_LEN} <= 135000, 1800, ${R_LEN} <= 270000, 3600, ${R_LEN} <= 810000, 10800, ${R_LEN} <= 3240000, 43200, 86400)`;
const ANCHORED = {
  k: `EVAL k = DATE_DIFF("second", @timestamp, TO_DATETIME(?_tend)) / ${SPAN}`,
  bars: (series) => `EVAL k = LEAST(k, GREATEST(${R_LEN} / ${SPAN}, 1) - 1) | STATS events = SUM(events) BY k, ${series} | ` +
    `EVAL span = ${SPAN}, n = GREATEST(${R_LEN} / ${SPAN}, 1), ts = TO_DATETIME(TO_LONG(TO_DATETIME(?_tend)) - (k + 1) * span * 1000), ` +
    `per_minute = events * 60.0 / (span + CASE(k == n - 1, ${R_LEN} - n * span, 0))`,
};

/**
 * The two whole-range bar charts carry each count in the category label ("Machine · 78,628"), so their
 * value axis is only a log ruler. Lens thins tick labels that do not fit, and the plots differ in width
 * by their category labels, so with full digits one read "1 · 100 · 10,000 · 100,000,000" and the other
 * "1 · 100 · 1,000,000"; angled labels made both agree but still dropped 1,000,000, so the decades were
 * spaced unevenly. Compact numbers (1 · 100 · 10k · 1m · 100m) fit every second decade horizontally on
 * both plots at 1440px and 1920px. The API refuses `labels.visible` (a 400), so hiding them was not an
 * option. The 1B top stays: it keeps a 10x-busier 7-day range on the plot.
 */
const compactLog = (p) => {
  p.config.layers[0].y[0].format = { type: 'number', decimals: 0, compact: true };
  return p;
};

/** The intro (draft 3 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 6,
  heading: "Who signed in, how, and what failed",
  paragraphs: [
    "See which sign-in methods and credentials are in use, your busiest people and API keys, every key and when it was last used, and each failed or denied attempt.",
    `Use it to check that access looks as expected, review API keys, or follow up on failed sign-ins. Empty failure panels are good news. ${RAW_RECORDS}`,
    "**How to use it:** choose a Project, Identity type, Identity or Client IP in the controls and set the time picker. Click an email in a table to filter the whole suite to that person.",
  ],
  howTo: [
    'Identities read as in the Identity dropdown: an email, else an API key’s name, else the account name. A key named after a person is still a key.',
    'No API key carries an email. Kibana does not record which Elasticsearch key it was given, so those rows read “Unnamed key of” the key’s owner.',
    'Cloud API keys have no name or owner: tables show the start of the id, “_4KEO… · Cloud API key”, with Owner “Cloud organization”.',
    'A re-issued key keeps its name under a new id, so key ids can outnumber names.',
    'A failed sign-in counts once per attempt. Credential type exists only on Elasticsearch requests, so those panels leave out Kibana traffic.',
    'Identity type and Identity apply to this page only: the links above carry Project, Client IP and pinned filters, not them.',
  ],
};

export function build() {
  resetIds();
  const P = [
    // Counted on the actor (ACTOR_RESOLVE, the Identity dropdown's values) — the key Identity first and last
    // seen groups by — over all traffic, like that session, so the tile and the session's row count are the
    // same number. A person is an identity with an email (the rule prefers it), so the people here are the
    // Humans tile beside it. "Unnamed key of …" identities (1.0.5.1) are neither a person nor a key name.
    // The line under the number used to read "1 human · 31 machine": the 31 lumped the synthetic
    // syn-new-hire-* API keys (named like people), user names tried in a failed sign-in and the
    // <anonymous> placeholders under one word that fitted none of them. It now counts the one kind it can
    // name exactly, API keys by the name the COALESCE gives them (KEYED's test), and leaves the people to
    // the Humans tile ("1 human · 23 key names" was cut at a 1440px viewport); the description lists the
    // rest. "key names", not "keys": the API keys tile counts key ids, and a re-issued key is one name
    // under several ids (22 names, 103 ids at 24h). Grouped on the raw identity fields first (QUERY SHAPE
    // rule 2): a filtered COUNT_DISTINCT(actor) per event cost ~370ms over 7 days on the replica against
    // ~250ms for the old tile; counted on the grouped rows it is ~290ms.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS BY ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS \`Identities\` = COUNT_DISTINCT(actor), keys = COUNT_DISTINCT(actor) WHERE user.email IS NULL AND (api_key.name IS NOT NULL OR user.domain == "_cloud_api_key") | EVAL detail = CASE(keys == 0, "no API keys", keys == 1, "incl. 1 key name", CONCAT("incl. ", ${grouped('keys')}, " key names")) | KEEP \`Identities\`, detail`,
      'Identities', 'Distinct identities, all traffic: people, API keys, service accounts, user names tried in failed sign-ins, and placeholders for anonymous requests. The line above the number counts the API key names among them. Identity first and last seen lists each.',
      { secondary: 'detail' }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Humans\` = COUNT_DISTINCT(user.email), sso = COUNT_DISTINCT(user.email) WHERE user.domain == "cloud-saml-kibana" | EVAL detail = CASE(sso == 0, "none used SSO", CONCAT(${grouped('sso')}, " used SSO")) | KEEP \`Humans\`, detail`,
      'Humans', 'Distinct email addresses across all traffic: the people Busiest human identities ranks. Only a person’s own sign-in carries an email, never an API key; the line above the number says how many used SAML SSO.',
      { secondary: 'detail' }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KEYED} | STATS BY api_key.id, api_key.name, user.name | ${KEY_DERIVE}, name = COALESCE(api_key.name, user.name) | STATS \`API keys\` = COUNT_DISTINCT(key_id), names = COUNT_DISTINCT(name) | EVAL detail = CASE(\`API keys\` == 0, "none in range", names == 1, "1 name", CONCAT(${grouped('names')}, " names")) | KEEP \`API keys\`, detail`,
      'API keys', 'Distinct API keys used in range, Cloud and Elasticsearch, one per row of API key inventory. The line above the number counts their names: a name with many ids is one key re-issued many times.',
      { secondary: 'detail' }),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE user.domain == "cloud-saml-kibana" | STATS \`SSO events\` = COUNT(*), logins = COUNT(*) WHERE event.action == "user_login" | EVAL detail = CASE(\`SSO events\` == 0, "none in range", logins == 0, "signed in earlier", logins == 1, "1 new sign-in", CONCAT(${grouped('logins')}, " new sign-ins")) | KEEP \`SSO events\`, detail`,
      'SSO events', 'Events from people using Kibana in a browser through SAML SSO. The line above the number counts new sign-ins in range, or reads “signed in earlier” when the sessions began before the range.',
      { secondary: 'detail' }),
    // The line under the number names ONE part, the failed sign-ins; the title says the rest is denied.
    // "N logins · M denied" read as N successful logins beside SSO events' "no new sign-ins", and
    // "539 failed sign-ins · 628 denied" was cut to "… · 62" in an 8-column tile at a 1440px viewport.
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS \`Failed or denied\` = COUNT(*), signin = COUNT(*) WHERE event.action IN (${SIGNIN_FAILED}) | EVAL detail = CASE(signin == 0, "no failed sign-ins", signin == 1, "1 failed sign-in", signin == \`Failed or denied\`, "all failed sign-ins", CONCAT(${grouped('signin')}, " failed sign-ins")) | KEEP \`Failed or denied\`, detail`,
      'Failed or denied', 'Failed sign-ins plus requests refused or failed after sign-in. The line above the number counts the failed sign-ins; the rest are signed-in identities hitting a permission wall, not someone guessing credentials.',
      { secondary: 'detail' }),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE kibana.session.id IS NOT NULL | STATS \`Kibana sessions\` = COUNT_DISTINCT(kibana.session.id), people = COUNT_DISTINCT(user.email) | EVAL detail = CASE(\`Kibana sessions\` == 0, "none in range", ${count('people', 'person', 'people', 'no email recorded')}) | KEEP \`Kibana sessions\`, detail`,
      'Kibana sessions', 'Distinct Kibana browser sessions observed in range, and how many people (by email) they belong to.',
      { secondary: 'detail' }),
    // Bars, not a line. ES|QL returns no row for an interval without traffic, so a line ran straight
    // across a ten-minute gap as if requests had continued, and a type seen in one interval only (SAML,
    // Realm) was a single point with nothing to join — no mark at all. A bar is drawn where there is a
    // row and nowhere else. Grouped, not stacked: stacking on a log axis misstates every upper series.
    //
    // PER MINUTE, not per bar. A count per bar grows with the bar: BUCKET picks 1 minute at 1h, 30 at 24h,
    // 3 hours at 7d and 12 at 30d, so the busiest bar measured ~5k at 1h, ~177k at 24h and ~1M at 7d (live,
    // 2026-10-15). A fixed log axis — the API takes a custom domain only with both ends — had to reach 10M
    // for a busy 7-day range at 10x today's volume, which left the top three of its seven decades empty at
    // 1h. Per minute, the busiest bar is ~5–6k in every one of those windows, so the axis can stop at 100k
    // (10x headroom at 10x volume) in all of them. The other end: one request in a 3-hour bar is 0.0056 a
    // minute, so the floor is 0.001, and a lone SAML or Realm request at 24h draws a bar 1.5 decades tall
    // instead of the sliver it was at a 0.5 floor.
    //
    // BARS COUNTED BACK FROM THE END OF THE RANGE (ANCHORED), not BUCKET's calendar grid. Lens draws a
    // time bar only if it starts at or after the range start and at or before (range end − one bar):
    // checked on a fixed 24h range (2026-10-15, round-6 skeptic), it dropped BOTH of BUCKET's partial
    // bars — the oldest, which starts before the range, and the newest, which runs past its end. The
    // newest was the worse loss: the last 30 minutes at 24h (3 hours at 7d) of the busiest key never
    // drew, nor did a sign-in made in them, while the matrix and the tiles beside it counted it.
    // Leaving out the x domain or rounding it changed nothing. Anchored bars end exactly at the range
    // end and step back one interval at a time, so every bar is whole and inside what Lens draws.
    rateBar(xy(0, 5, 24, 12, 'Elasticsearch requests per minute by credential type',
        `FROM ${IDX} | ${TIME} | WHERE authentication.type IS NOT NULL | ${ANCHORED.k} | STATS events = COUNT(*) BY k, authentication.type | ${ANCHORED.bars('authentication.type')} | EVAL ${CRED_TYPE_LABEL} | KEEP ts, auth, per_minute | SORT auth`,
        'per_minute', 'Elasticsearch requests per minute by credential type: API key, token (SSO browsers and service accounts), realm (username and password) or SAML. Log scale, so small types stay readable. A shift in this mix is worth explaining.',
        { breakdown: 'auth', kind: 'bar', colors: CRED_TYPE_COLORS, yScale: 'log', xcol: 'ts' })),
    vega(24, 5, 24, 12, '02-auth-matrix', 'Credential type by identity · Elasticsearch requests',
      'Which credential type each of the 12 busiest identities uses, with its Elasticsearch request count in each cell. Colors match the time chart beside it. People should sign in by token (SSO); services by API key.'),
    // Bars on a log axis, not the donuts they replace. A donut rounds a share: in an hour where a Cloud
    // API key sent ~450k events and one person 33, the only slice label read "Machine 100%" beside a
    // legend listing Elastic and a Humans tile reading 1 — the label contradicted the page. Here the
    // category name carries the count ("Elastic · 33"), and on a log axis its bar is visible beside one
    // of 450k. (The donut labels also set name and percentage in two fonts, and wrapped "Cloud API
    // key".) The count is in the axis label, not a Lens value label: Lens prints a value label only
    // where it fits inside the bar, so at a 1440px viewport "SAML SSO" (37 events) had no number at
    // all and "Elastic 37" sat half outside its bar; an axis label is always drawn. The 0.5 floor gives
    // a count of 1 a visible bar (logBar).
    // Grouped on the raw email first, then classified: ORG reads only user.email, so the
    // CASE runs once per person instead of once per event.
    compactLog(logBar(bar(0, 17, 12, 12, 'Events by identity origin',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY user.email | ${ORG} | STATS events = SUM(events) BY origin = actor_org | EVAL origin = CONCAT(origin, " · ", ${grouped('events')}) | SORT events DESC`,
      'origin', 'events', 'Events, not identities, by the email on the event: Elastic (@elastic.co), Tenant (any other address) or Machine (no email). Log scale: read the count, not the bar length. One busy key can make Machine nearly all traffic.',
      { yScale: 'log' }), 1e9)),
    compactLog(logBar(bar(12, 17, 12, 12, 'Events by authentication realm',
      `FROM ${IDX} | ${TIME} | WHERE user.domain IS NOT NULL | STATS events = COUNT(*) BY user.domain | EVAL realm = CASE(user.domain == "cloud-saml-kibana", "SAML SSO", user.domain == "_es_api_key", "Elasticsearch API key", user.domain == "_cloud_api_key", "Cloud API key", STARTS_WITH(user.domain, "_service_account"), "Service account", STARTS_WITH(user.domain, "_"), "Other internal", user.domain) | STATS events = SUM(events) BY realm | EVAL realm = CONCAT(realm, " · ", ${grouped('events')}) | SORT events DESC`,
      'realm', 'events', 'Events by how they were authenticated: SAML SSO is people signing in through a browser; Elasticsearch and Cloud API keys are programmatic; Service account is Elastic’s own components. Log scale: read each bar’s count, not its length.',
      { yScale: 'log' }), 1e9)),
    // ONE ROW PER KEY NAME. One row per key id put a re-issued key on the page twice — at 24h
    // syn-analyst-raj.patel, syn-automation-ops and syn-etl-ingest-bot each held two of the ten rows,
    // identical but for a 20-character id, and read as duplicates (round-5 review); each of those names
    // carried 15 ids. By name, the Key IDs column says how many ids a name ran under, the API keys tile's
    // two numbers (ids, and names on the line under it) are this table's Key IDs total and row count (a name two creators share is two rows here, one name there),
    // and API key inventory below lists every id. Grouped on the raw fields: user.name is a group key
    // because it IS the id of a Cloud API key, and for an Elasticsearch key it is the creator, so two
    // creators' keys that share a name stay two rows. A Cloud API key has no api_key.id, so it counts 0
    // distinct ids and is the one Kind "Cloud" row (one id: its own). The label runs on grouped rows,
    // never per event.
    // 1.0.5: both key columns are the raw group keys, so both are click-to-filter and the table drills into
    // Actor 360. Until then API key was assigned in ES|QL (COALESCE with the short Cloud key form), which Lens
    // refuses to filter on. Now a Cloud key's row reads "-" under API key and its FULL id under "Key ID
    // (Cloud) / creator" — the one place outside API key inventory that shows it whole — and an
    // Elasticsearch key's row shows its creator's principal there. The Kind column gave its width to that
    // column: at 24 columns a 1440px viewport cannot hold both beside a 36-character key name, and the "-"
    // under API key says Cloud. Events and IPs are sized: auto, they took ~240px of a 655px panel at 1440.
    table(24, 17, 24, 12, 'Busiest API keys by name',
      `FROM ${IDX} | ${TIME} | ${KEYED} | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip), key_ids = COUNT_DISTINCT(api_key.id) BY api_key.name, user.name | EVAL key_ids = GREATEST(key_ids, 1) | SORT events DESC, api_key.name, user.name | LIMIT 10`,
      [filterable('api_key.name', { label: 'API key' }), filterable('user.name', { label: 'Key ID (Cloud) / creator', width: 175, min: 165 })], [sized('key_ids', 90, { label: 'Key IDs', min: 72 }), sized('events', 100), sized('ips', 56)],
      'The busiest API keys, one row per name, with volume and distinct client IPs. The next column is the creator, or a Cloud API key’s full id (it has no name). Many IPs on one key deserve a look.'),
    // Grouped on the email alone. user.full_name was a second key, but over 7 days it was empty on all
    // but 2 of ~11,600 events for the one SSO user, and on those 2 it held the email again — so it split
    // one person into two rows and otherwise filled a column with "-". The email is the person, and it
    // is the click filter. First and last seen and IPs are not repeated here: they are on Identity first
    // and last seen, for the same events. Without them this table fits 12 columns (an email keeps ~215px
    // at a 1440px viewport), and the failures beside it get the 36 that six columns need there: at 32 the
    // Result column cut "<unauthenticated-cloud-access-token>" in Identity (rendered at 1440).
    table(0, 29, 12, 12, 'Busiest human identities',
      `FROM ${IDX} | ${TIME} | WHERE user.email IS NOT NULL | STATS events = COUNT(*) BY user.email | SORT events DESC | LIMIT 10`,
      [WHO], ['events'],
      'The people the Humans tile counts, busiest first, over all traffic. Identity first and last seen has the rest, with first and last seen times and IP counts. Click an email to pin that person across the suite.'),
    // Grouped on the raw identity fields and resolved afterwards (QUERY SHAPE rule 2): the COALESCE then
    // runs once per group instead of once per failed event. An action that is neither a failed sign-in
    // nor access_denied is here only because its outcome was failure, and without saying so a
    // saved_object_update row read as a normal operation — so a Result column names the kind, with the
    // same words as the Failed sign-ins session. It is a separate column, not a suffix on Action: Lens
    // refuses click-to-filter on a column assigned in ES|QL, and Action is a STATS BY alias that keeps it.
    // Ties are broken by recency and then by name: on events alone, rows with equal counts (admin and
    // elastic at 30 each) swapped places between two renders of the same range. A failure with no client
    // address (anonymous_access_denied) reads "no IP", the page's words for it, not a bare "-"; the
    // column is display-only (no click filter), so it can be assigned in ES|QL.
    table(12, 29, 36, 12, 'Top failed or denied access',
      `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY ${ACTOR_KEYS}, action = event.action, ip = client.ip | ${ACTOR_RESOLVE} | STATS events = SUM(events), last_seen = MAX(last_seen) BY actor, action, ip | EVAL result = CASE(action IN (${SIGNIN_FAILED}), "failed sign-in", action == "access_denied", "denied", "failed"), ip = COALESCE(TO_STRING(ip), "no IP") | SORT events DESC, last_seen DESC, actor, action, ip | LIMIT 10`,
      ['actor', sized('action', 175), 'result', 'ip'], ['events', 'last_seen'],
      'Failed sign-ins and refused requests by identity, action and source IP, most frequent first. Result names the kind: failed sign-in, denied (refused an action) or failed (any other failure).',
      { empty: 'good' }),
    // The sessions run full width. Side by side at 24 columns, seven and eight columns shared ~800px:
    // timestamps wrapped onto three lines and the last column was cut off at the panel edge. These are
    // the record-level evidence, so every column has to be readable without opening Discover.
    search(0, 41, 48, 12, '02-failed-authentications', 'Failed sign-ins and denied access · newest 1,000 at most',
      'The newest failed sign-ins and refused requests, record by record, up to 1,000; the Failed or denied tile has the total. Credential reads “not authenticated” when no credential worked; Country reads “internal” for Kibana or the platform acting for someone.',
      { empty: 'good' }),
    search(0, 53, 48, 12, '07-api-key-activity', 'API key inventory',
      'Every API key used in range (up to 1,000), Cloud and Elasticsearch, busiest first, with owner, volume, IP spread, indices touched and first and last use. Owner is its creator: a person or the Cloud API key that minted it.'),
    search(0, 65, 48, 14, '06-actor-first-seen', 'Identity first and last seen',
      'Every identity in range (up to 1,000), all traffic, newest first appearance on top, with all its events and its signal events after the noise gate. Widen the time range to tell a brand-new identity from a quiet one.'),
  ];
  return dash(rawId('01-identity-access'), '[Audit] 🔐 Identity & Access',
    'Who authenticated, how, from where, and what failed. Resolves the numeric user.name into real identities.', P, { intro: INTRO });
}
