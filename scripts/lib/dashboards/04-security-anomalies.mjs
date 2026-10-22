/** 04 Security & Anomalies — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, RISK_INDEX_STATS, RISK_INDEX_EVAL, NOISE, TIME, BUCKET, SCOPE, PALETTE, PRIVILEGED,
  privilegedKpi, FAILED_OR_DENIED, RISK_PREFILTER, RISK_KEYS, RISK_RESTORE, RISK, grouped, SIGNIN_WORDS, EDGE_NOTE, dash, kpi, xy, table, vega, search, sized, fitRows, resetIds
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import {
  ACTOR_KEYS, riskScored
} from './shared.mjs';

/**
 * Scope colours, pinned so a stacked bar reads the same on every refresh. Unauthenticated takes the
 * warm hue because it is the one an analyst should notice; platform the quiet green, because it is
 * Elastic's own automation and mostly expected.
 */
const SCOPE_COLORS = { tenant: PALETTE[1], platform: PALETTE[0], unauthenticated: PALETTE[7] };

/**
 * "First seen" is the first event INSIDE the picker's range, so anything active when the range
 * opened looks new. Flag it instead of hiding it: an identity first seen in the opening twelfth of
 * the range (5 minutes of an hour, 14 hours of a week) was most likely already active before it,
 * and reads "no". Derived after the STATS, over at most a screenful of rows, so it costs nothing.
 * Measured from the range, not from the first event in it: the data's own start would move with a
 * Person pill, and a pinned identity would then always read "no".
 */
const NEW_IN_RANGE =
  'EVAL new_in_range = CASE(TO_LONG(first_seen) - TO_LONG(TO_DATETIME(?_tstart)) > ' +
  '(TO_LONG(TO_DATETIME(?_tend)) - TO_LONG(TO_DATETIME(?_tstart))) / 12, "yes", "no")';

/**
 * What a security_config_change payload names, as a short string: the API key's name on a create,
 * the key ids on an invalidation (comma-separated, so SPLIT() counts them one by one), the key id on
 * a change, the role name, or the user profile uid. Four GROKs over the JSON string, first match
 * wins — `"name":"` cannot match `"names":[`, and on a create the key name precedes the nested
 * `"source":{"id":…}`. Per event, but only on events that carry a payload (a few thousand a day),
 * and GROK is one of the cheap per-event operations (QUERY SHAPE rule 1).
 */
const CHG = 'elasticsearch.audit.security_config_change';
const TARGET =
  `GROK ${CHG} """"name":"%{DATA:t_name}"""" | GROK ${CHG} """"ids":\\[%{DATA:t_ids}\\]""" | ` +
  `GROK ${CHG} """"id":"%{DATA:t_id}"""" | GROK ${CHG} """"uid":"%{DATA:t_uid}"""" | ` +
  'EVAL target = COALESCE(t_name, REPLACE(t_ids, "\\"", ""), t_id, t_uid)';
/**
 * The latest target for display, on the grouped rows: spaced after its commas, and cut with a visible
 * ellipsis — Lens hard-clips a cell mid-glyph with no cue, and an invalidation can list dozens of ids.
 */
const TARGET_SHOW =
  'EVAL latest = REPLACE(latest, ",", ", ") | EVAL latest = CASE(LENGTH(latest) > 72, CONCAT(LEFT(latest, 71), "…"), latest) ' +
  '| EVAL latest = COALESCE(latest, "(none named in the payload)")';

/**
 * PRIVILEGED, on every panel here that counts security config changes (the two tiles, the table, the
 * feed, the leaderboard's Privileged column): Kibana's own API-key clean-up (HOUSEKEEPING) is left out
 * of all of them, so they reconcile with each other and with 00's Privileged ops. The tiles show what
 * was left out on their second line. Round 4 found this page's tiles, table and feed contradicting each
 * other by 4 events in one 1h render (676 against 680): every one of the 680 was that clean-up,
 * arriving every few seconds while the panels below the fold were still mounting. With it gone, what
 * these panels count is a few events an hour rather than a few a second, and since round 6 the range
 * ends at now-1m, so LIVE_NOTE is the shared EDGE_NOTE.
 */
const LIVE_NOTE = EDGE_NOTE;

/**
 * A failed action gets its own row and a visible mark wherever an action is scored: the scatter's
 * "saved_object_create (failed)" and the Why table's. The Why table grouped failures and successes of a
 * pair apart (by weight) but printed both under the bare action name, so "_4KEO… · Cloud API key ·
 * saved_object_create · 8,104" sat beside Top failures' "… saved_object_create · 25" with nothing to say
 * one was the other's successes (round-5 review). It now groups on the outcome itself, so a failed
 * security config change (which RISK weighs 50, not 40) is split out too, and marks the failed rows the
 * way vega/05 does — not when the name already says it (access_denied, authentication_failed). A
 * one-condition CASE over the grouped rows.
 */
const FAILED_MARK =
  'EVAL action = CASE(failed AND NOT (action LIKE "*fail*" OR action LIKE "*denied*"), CONCAT(action, " (failed)"), action) | DROP failed';
const CLEANUP = 'Kibana\'s own API-key clean-up (invalidate_apikeys by the elastic/kibana service account through no named key, every few seconds) is left out, as on Command Center\'s Privileged ops';
const CLEANUP_NOTE = `${CLEANUP}; the second line says how many such events the range held.`;
/**
 * No Email column on this page's identity tables. On every render (1h and 24h) it held only dashes:
 * the identities that score are API keys, service accounts and unauthenticated principals, and
 * Identity already IS the email for a person. The README rule for a click-to-filter column of dashes
 * applies (drop it). The cost is the click-to-pin and the Actor 360 drilldown from these tables;
 * the Person (email) control pins a person on this page and carries to Actor 360.
 */
const PIN_HINT = 'To follow one person, pick them in the Person (email) control; the pin carries to Actor 360.';

/**
 * ROW READING on the full-width identity tables. Lens gives any column without a width all the slack,
 * and these tables had only one text column, Identity: at 24h it ended near x=355 while the next column
 * started near x=1420 (round-5 review), so a reader could not follow an identity across to its numbers.
 * Identity is now capped at IDENTITY_W — the 36 characters of `<unauthenticated-cloud-access-token>` and
 * a long work email fit — and the slack goes to Scope, moved to the end of the row (a string column sits
 * in `metrics` as well as `rows`, verified on a deployed panel; Lens orders the columns rows first, then
 * metrics), left-aligned there since a metric right-aligns by default. The numbers now sit right after the
 * identity, and the slack is the space after Scope's short word, at the row's end.
 */
const IDENTITY_W = 300;
const ACTION_W = 290;
const SCOPE_LAST = { column: 'actor_scope', width: undefined, alignment: 'left' };

/**
 * Lens tables end exactly on a row at h ≡ 1 (mod 6): fitRows(h) = (28h − 76) / 24 with no remainder.
 * At h=10–12 the remainder was a 14–20px blank strip, with its own rule line, under the last row, which
 * read as an empty footer row (round-5 review). Every table here is h=13 (twelve whole rows) except Config
 * changes at h=7 (five): with the clean-up left out it holds one or two pairs in the default hour, and at
 * h=13 that left a 300px void at the top of the page.
 */
const TH = 13;

/**
 * TIE ORDER. Every ranked table here sorts on a count, and counts tie often (admin and elastic both 81
 * scoring events; four _4KEO… failure pairs at 19 each). With no tie-breaker the tied rows swapped
 * places between two renders a minute apart (round-6 review), so each SORT ends on the identity and,
 * where there is one, the action. It runs on the grouped rows, so it costs nothing.
 */

/** The intro (draft 6 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 6,
  heading: "The activity most worth a second look",
  paragraphs: [
    "Each sensitive action earns a risk weight, from 10 for a workflow run up to 50 for a security setting change, while routine work scores zero.",
    "Panels rank identities by that risk, show newly seen identities, and list every security configuration change. Elastic's own routine API key clean-up is counted separately, so it never hides real changes.",
    "**How to use it:** choose a Project, Person (email) or Client IP in the controls and set the time picker. Hover the ⓘ beside a panel title to see how it is scored.",
  ],
};

export function build() {
  resetIds();
  const P = [
    // The scale lives in the column name because it is the one ratio among five counts: a bare
    // "34.2" beside "377" reads as another count. A `secondary` line would say it too, but would
    // push this tile's number off the baseline its five siblings share.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${riskScored()} | STATS ${RISK_INDEX_STATS} | ${RISK_INDEX_EVAL} | EVAL \`Mean severity (of 50)\` = mean_severity | KEEP \`Mean severity (of 50)\``, 'Mean severity (of 50)',
      'Average severity weight across scoring events, on the same 0–50 scale as the weights: config change 50, key invalidation 45, failure 40, anonymous denial 35, destructive change 30, other Kibana change 25, workflow execution 10. Executions weigh least on purpose — they are the one class with unbounded cadence, and a scheduled workflow firing every minute would otherwise turn total risk back into an event count. Routine activity scores 0 and is excluded, so this is not a disguised event count — read it with Scoring events beside it.', { dec: 1 }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${privilegedKpi('Config changes')}`, 'Config changes',
      `Security configuration changes recorded by Elasticsearch (API keys created, changed or invalidated, roles and user profiles written) — the total that the Config changes table and the event feed below draw from. ${CLEANUP_NOTE} ${LIVE_NOTE}`,
      { secondary: 'housekeeping_note' }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE event.action == "invalidate_apikeys" | ${privilegedKpi('Key invalidations')}`, 'Key invalidations',
      `invalidate_apikeys requests in range (one request can name several keys) — legitimate rotation, or a credential being revoked in a hurry; a subset of Config changes. ${CLEANUP_NOTE} Risk scoring leaves the same clean-up out (it scores 0), so the invalidations it weighs are these.`,
      { secondary: 'housekeeping_note' }),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS \`Failures\` = COUNT(*)`, 'Failures', `Events with a failure outcome: failed sign-ins (${SIGNIN_WORDS}), denials and any other failed action. Counted as on Identity & Access's Failed or denied tile, so the two agree.`),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE event.action == "anonymous_access_denied" | STATS \`Anonymous denials\` = COUNT(*)`, 'Anonymous denials', 'Unauthenticated requests that were rejected.'),
    // riskScored() spelled out without its `WHERE risk > 0`, so the suite's own install (scored 0 through the
    // suite_install key) can be counted in the second line, the way privilegedKpi() counts the cleanups.
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${RISK_PREFILTER} | STATS n = COUNT(*) BY ${RISK_KEYS} | ${RISK_RESTORE} | ${RISK} ` +
      '| STATS scoring = SUM(n) WHERE risk > 0, installs = SUM(n) WHERE suite_install AND risk == 0 ' +
      '| EVAL `Scoring events` = COALESCE(scoring, 0), installs = COALESCE(installs, 0), ' +
      `install_note = CASE(installs == 0, "no suite installs in range", CONCAT("excl. ", ${grouped('installs')}, " suite installs")) ` +
      '| KEEP `Scoring events`, install_note', 'Scoring events',
      'Number of events that carried any risk weight at all — the denominator of Mean severity, and the volume that severity is averaged over. The suite\'s own automated install (its cloud-audit-* objects written with no browser session) scores 0, so it is left out and counted in the second line instead; it is still listed in the Mutation feed.',
      { secondary: 'install_note' }),
    // One row per identity and action, not per payload: grouped by the raw payload, every API key id
    // made its own one-event row (10 of 12 rows at 24h read "invalidate_apikeys · 1") and the JSON was
    // hard-clipped mid-glyph. The payload stays whole in the event feed at the foot of the page; here
    // it is reduced to what it names. Full width so that name is never the column that clips.
    table(0, 5, 48, 7, `🚨 Config changes · up to ${fitRows(7)} identity–action pairs, latest first`,
      `FROM ${IDX} | ${TIME} | ${PRIVILEGED} | ${TARGET} | ${ACTOR_RESOLVE} | STATS events = COUNT(*), targets = COUNT_DISTINCT(SPLIT(target, ",")), latest = LAST(target, @timestamp), last_change = MAX(@timestamp) BY actor, action = event.action | SORT last_change DESC | ${SCOPE} | ${TARGET_SHOW} | LIMIT ${fitRows(7)}`,
      [sized('actor', 220), 'actor_scope', sized('action', 190), { column: 'latest', label: 'Latest target' }],
      [sized('targets', 90, { label: 'Targets' }), 'events', 'last_change'],
      `Security configuration changes grouped by identity and action, the most recently active first; in a busy range the quieter pairs are beyond the rows shown, so Events here add up to the Config changes tile only when every pair fits. ${CLEANUP}. Latest target is what the newest of those changes named (the API key, the key ids of an invalidation, the role, or the user profile), and Targets counts the different ones named across all of them: hundreds of invalidations over hundreds of keys is rotation, hundreds over one key is a loop. A profile activation names no target (it is the signed-in user's own profile), so it reads "(none named in the payload)" and 0. A key named "TaskManager: … - <id>" is one Kibana created to run a task on that identity's behalf: the id at its end is its owner's, not a name for it. The full JSON payload of every change is in the Config-change event feed at the foot of the page.`,
      { empty: 'good' }),
    vega(0, 12, 24, 13, '05-rare-event-scatter', 'Highest-severity actions, by how rare',
      'The highest-severity scoring actions in range, one row per action and weight, placed by how often each happened: rarer is further left, so the top-left is rare and high-severity — look there first. Shows the top 12 by severity, rarest first within a weight; the subtitle says how many actions scored in all. On a quiet range the top 12 reach down to routine Kibana changes (weight 25), which can be frequent: rare is a position on this chart, not a filter. Each row ends with its severity weight, which the colour repeats: one colour per weight, blue for 10 up to deep red for 50, keyed below the chart (the key lists only the weights the chart shows). A failed action gets its own row, marked (failed) unless its name already says so, as in Why these identities scored; a failed Kibana change scores 40 whatever it changed. Hover a point for how many identities did it and when. Routine activity scores 0 and is not shown. Kibana\'s own API-key clean-up scores 0, as it is left out of the Key invalidations tile, so invalidate_apikeys here counts the same invalidations that tile does (with a failed one, if any, on its own (failed) row).'),
    // Bars, not an area: an area interpolates straight across empty buckets and draws minutes of
    // rising risk that never happened. Split by scope so a spike says whose it was before anyone
    // has to open the leaderboard. The scope EVALs run on the scored subset only (measured: 0.2s vs
    // 0.15s unsplit over 1h).
    xy(24, 12, 24, 13, 'Risk over time',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: `${BUCKET}, ${ACTOR_KEYS}` })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS \`Summed severity\` = SUM(risk * n) BY \`${BUCKET}\`, actor_scope | SORT actor_scope`,
      'Summed severity', 'Summed severity weight per interval, routine activity excluded, split by who it came from: tenant identities, Elastic platform automation, or unauthenticated requests. Spikes are clusters of privileged, failed or denied activity. The axis always spans the whole range: a blank stretch means nothing scored then, or, on a project younger than the range, that the audit stream had not started yet.',
      { breakdown: 'actor_scope', colors: SCOPE_COLORS, yTitle: 'Summed severity' }),
    // first_seen is window-censored (see NEW_IN_RANGE). Grouped on actor alone and scoped AFTER
    // the STATS — scope is a function of actor. Full width: at half width its six columns left
    // Identity under 120px at a 1440px viewport (a --lint advisory), and the width buys Last seen.
    // The LIMIT stays last so table() can lower it to the rows the panel shows (it only matches a
    // trailing LIMIT); the EVALs between it and the SORT are per-row and do not stop the top-N.
    table(0, 25, 48, TH, 'Identities by first appearance in range',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR_RESOLVE} | STATS first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY actor | SORT first_seen DESC, actor | ${SCOPE} | ${NEW_IN_RANGE} | LIMIT ${fitRows(TH)}`,
      [sized('actor', IDENTITY_W), sized('new_in_range', 70, { label: 'New' })], ['first_seen', 'last_seen', 'events', { column: 'ips', label: 'Client IPs' }, SCOPE_LAST],
      'Identities ordered by their first event inside the selected range, latest first, from signal events only (query internals are left out, as on every gated panel). First seen is within the range, not ever: an identity that was already active when the range opened also shows a first-seen near its start. New reads "no" for those (first seen in the opening twelfth of the range) and "yes" otherwise; on a project whose audit history is shorter than the range, every identity reads "yes". A "yes" near the top is an identity worth a question; widen the range to tell a new identity from a returning one. Client IPs is 0 for an identity none of whose events recorded a client address: the Kibana service account and platform automation, which call from inside the platform, and a sign-in rejected before its caller was identified — <unauthenticated-cloud-api-key> events carry only the platform proxy\'s address, so they have no client address to count.'),
    // Full width because Identity is free text: at half width a 36-character identity
    // (<unauthenticated-cloud-access-token>, a long persona name) was cut. One decimal on
    // the mean throughout, since "40" beside "26.4" reads as two kinds of number.
    table(0, 38, 48, TH, 'Risk leaderboard — top identities by total severity',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: ACTOR_KEYS })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS ${RISK_INDEX_STATS}, privileged = SUM(CASE(scc, n, 0)) BY actor, actor_scope | ${RISK_INDEX_EVAL} | SORT risk_total DESC, actor | LIMIT ${fitRows(TH)}`,
      [sized('actor', IDENTITY_W)],
      // Two-word headers get the width to stay on one line: wrapped, "Scoring events" and "Mean severity"
      // made the header row 16px taller, and the twelfth row of an h=13 table was cut through its glyphs.
      ['risk_total', sized('scoring_events', 120), { column: 'mean_severity', width: 120, format: { type: 'number', decimals: 1 } }, 'privileged', SCOPE_LAST],
      `Identities ranked by total accumulated severity, so sustained behaviour outranks a single high-severity event; only the top of the ranking fits the panel. Scope separates tenant identities from Elastic platform automation and unauthenticated requests — without it elastic.maintenance can top this table, because Elastic platform automation performs routine security config changes itself. Privileged counts the identity's security config changes the way the Config changes tile does. Kibana's own API-key clean-up is left out of both columns: it scores 0, so the elastic/kibana service account appears here only for something else it did. The suite's own install of its cloud-audit-* objects, made with no browser session, scores 0 too, so the key that deploys the suite is ranked only for what else it did. Identity is the email for a person and the key name for a named API key. ${PIN_HINT}`),
    table(0, 51, 48, TH, 'Why these identities scored — top risky actions, with their weight',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: ACTOR_KEYS, aggs: 'last_ts = MAX(@timestamp)' })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS events = SUM(n), risk_total = SUM(risk * n), last_seen = MAX(last_ts) BY actor, actor_scope, action = event.action, weight = risk, failed = event.outcome == "failure" | ${FAILED_MARK} | SORT risk_total DESC, actor, action | LIMIT ${fitRows(TH)}`,
      // weight is a group key, but listed as a metric so it right-aligns with the numbers it multiplies.
      [sized('actor', IDENTITY_W), sized('action', ACTION_W)], ['weight', 'events', 'risk_total', 'last_seen', SCOPE_LAST],
      `The receipts behind the leaderboard: the identity and action pairs that contributed the most risk, with what each action weighed, how many times it happened, and when it last did. Risk total is weight × events, the same quantity the leaderboard sums. A failed action is its own row, marked (failed) unless its name already says so (access_denied, authentication_failed): for a pair that also appears in Top failures and denials, that row's Events is the same number, and the unmarked row beside it is the pair's successes. realm_authentication_failed, the trace Elasticsearch writes for each realm a failed sign-in tried, still scores here, though the failure counts leave it out so that an attempt counts once. Only the largest contributions fit the panel, so a rare action can be missing here: Highest-severity actions, by how rare lists the actions by severity instead. ${PIN_HINT}`),
    // Full width: identity and the action name are variable-length text, and at half width the
    // action — the column the panel exists for — was the one cut. One row per identity and action:
    // grouped by source IP as well (round 4), elastic and admin took two rows each and a pair's count
    // was split across rows, so it no longer matched the same pair in Why these identities scored
    // (alex.kim access_denied 467 here, 480 there). The address survives as the newest one plus a
    // count of how many there were; LAST and COUNT_DISTINCT run on the failure subset only.
    // The platform hop is tagged "(internal)" as 05 does, on the grouped rows (one condition, after the STATS);
    // the newest anonymous denial came through it, so untagged it read as the prober's address.
    table(0, 64, 48, TH, 'Top failures and denials by identity and action',
      `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | ${ACTOR_RESOLVE} | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip), ip = LAST(client.ip, @timestamp), last_seen = MAX(@timestamp) BY actor, action = event.action | SORT events DESC, actor, action | ${SCOPE} | EVAL ip = COALESCE(CASE(CIDR_MATCH(ip, "100.64.0.0/10"), CONCAT(TO_STRING(ip), " (internal)"), TO_STRING(ip)), "none recorded") | LIMIT ${fitRows(TH)}`,
      [sized('actor', IDENTITY_W), sized('action', ACTION_W), { column: 'ip', label: 'Latest IP', width: 200 }], [{ column: 'ips', label: 'Client IPs' }, 'events', 'last_seen', SCOPE_LAST],
      `Failed and denied operations, one row per identity and action, the most frequent first; only the top rows fit the panel. These are the events the Failures tile counts (every denial and failed sign-in carries a failure outcome), and the Anonymous denials tile is their anonymous_access_denied rows. A failure is scored on a row of its own in Why these identities scored, marked (failed) unless the action's name already says so, so where a pair appears in both, Events here is the same number as on that row. Latest IP is the client address of the newest of those events ("none recorded" when none of them carried one, as for <unauthenticated-cloud-api-key>, whose events record only the platform proxy) and Client IPs counts the different addresses they came from: many addresses behind one identity is a spray, one address behind many identities is one source trying names. An address tagged (internal) is the platform-internal hop (100.64/10), as on Geo & Network: the platform calling on the client's behalf, not the client, and Client IPs counts it too. Scope separates unauthenticated probes from tenant identities and Elastic platform automation. API keys and native users (elastic, admin) carry no email, so an Identity that is not an email does not mean an external probe — read Scope. ${PIN_HINT}`, { empty: 'good' }),
    // Discover in ES|QL mode returns at most 1,000 rows and prints that as "1,000 results", which on a
    // 24h range sat under a Config changes tile reading 1,976. The cap is the reason, so the title says it.
    //
    // FEED HEIGHTS are set so the grid ends on a whole row. An embedded Discover grid starts its first
    // row 106px below a panel's 28h px, and rows step 27px (one line) or 46px (two lines) against the
    // dashboard's 28px unit, so most heights cut the last visible row through its glyphs (round 4: h=12
    // left 14px of a ninth row, h=14 16px of an eleventh). Changing h moves the cut by only 1px a unit;
    // the heights that land on a row edge are 1-line h=25–27 and 2-line h=12. The session has no
    // density or rows-per-page setting that the embedded grid honours (both tried, both ignored).
    //   Config feed: one-line rows (searches/03 row_height 1) at h=25 = exactly 22 rows. It was two-line
    //   rows at h=12 (5 rows) so a long create_apikey payload showed more before it was cut, but most rows
    //   are short (activate_user_profile, delete_role: ~50 characters) and left half the grid as empty
    //   second lines, 5 of 776 events in view (round-5 review). A long payload is one click away (expand).
    //   Mutation feed: one-line rows at h=25 = exactly 22 rows, the page's long read.
    // The Config-change feed sits LAST: it is mostly empty over the default hour (a change or two once the
    // clean-up is left out), and a sparse grid at the foot of the page reads as the end of it, not a gap.
    search(0, 102, 48, 25, '03-security-config-changes', 'Config-change event feed · newest 1,000 at most',
      `Every security configuration change the Config changes tile counts, as its own event, newest first, one line each: the payload is cut at the panel edge, so expand a row to read it whole. ${CLEANUP}. Discover returns at most the newest 1,000 events, and its result count is that cap rather than the total: when it reads 1,000, the Config changes tile at the top has the total. Scroll the grid for older rows.`,
      { empty: 'good' }),
    search(0, 77, 48, 25, '01-all-mutations', 'Mutation feed · newest 1,000 at most',
      `Creates, updates and deletes across Kibana and Elasticsearch security config, newest first. Object is what the change named: the saved object or feature object for a Kibana change; for an Elasticsearch security change, the API key's name, the key ids of an invalidation, the role or the profile, with its full JSON payload under Message. ${CLEANUP}. Space id is the space's id, the /s/<id> in its URL: the audit stream records no space display name, not even on a space read. It is empty on an Elasticsearch security change, which belongs to no space. Spaces that tooling creates and deletes (review or test spaces) are real activity, and so is the config object Kibana creates the first time a space is opened. Discover returns at most the newest 1,000 events, and its result count is that cap rather than the total. Scroll the grid for older rows; to reach older events still, narrow the time range.`),
  ];
  return dash(rawId('04-security-anomalies'), '[Audit] 🚨 Security & Anomalies',
    'Mean-severity risk scoring, privileged operations, failures and newly seen identities.', P, { intro: INTRO });
}
