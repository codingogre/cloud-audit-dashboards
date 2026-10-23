/** 04 Security & Anomalies — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, RISK_INDEX_STATS, RISK_INDEX_EVAL, NOISE, TIME, BUCKET, SCOPE, PALETTE, PRIVILEGED,
  privilegedKpi, FAILED_OR_DENIED, RISK_PREFILTER, RISK_KEYS, RISK_RESTORE, RISK, grouped, dash, kpi, xy, table, vega, search, sized, fitRows, resetIds
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import {
  ACTOR_KEYS, riskScored, PIN_BY, PIN_COLS, PIN_KEY, PIN_PRINCIPAL, PIN_PRINCIPAL_SHORT, RAW_RECORDS
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
 * was left out on the line above the number. Round 4 found this page's tiles, table and feed contradicting each
 * other by 4 events in one 1h render (676 against 680): every one of the 680 was that clean-up,
 * arriving every few seconds while the panels below the fold were still mounting. With it gone, what
 * these panels count is a few events an hour rather than a few a second, and since round 6 the range
 * ends at now-1m.
 */

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
// Kibana's own API-key clean-up is named once, in this page's How to read block, not in every tooltip.
/**
 * No Email column on this page's identity tables. On every render (1h and 24h) it held only dashes:
 * the identities that score are API keys, service accounts and unauthenticated principals, and
 * Identity already IS the email for a person. The README rule for a click-to-filter column of dashes
 * applies (drop it). The click-to-pin and the Actor 360 drilldown come from the API key and Principal id
 * columns instead (PIN_COLS, shared.mjs, 1.0.5), which are filled for exactly those identities.
 */

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
/**
 * 1.0.5: the API key and Principal id click columns (PIN_COLS) take ~315px of these rows, so table() shrinks
 * the fixed columns at a 1440px viewport (fitWidths) — and Lens widths are absolute, so 1920 gets the same.
 * Identity keeps 245px there (`<unauthenticated-cloud-access-token>`, 36 characters, needs ~241px) and an
 * action name 185px (`realm_authentication_failed`, `saved_object_create (failed)`).
 */
const WHO_COL = sized('actor', IDENTITY_W, { min: 245 });
const WHAT_COL = sized('action', ACTION_W, { min: 185 });
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
  h: 12,
  heading: "The activity most worth a second look",
  paragraphs: [
    `Each sensitive action earns a risk weight, from 10 for a workflow run up to 50 for a security setting change, while routine work scores zero. ${RAW_RECORDS}`,
    "Panels rank identities by that risk, show newly seen identities, and list every security configuration change. Elastic's own routine API key clean-up is counted separately, so it never hides real changes.",
    "**How to use it:** choose a Project, Person (email), API key or Client IP in the controls and set the time picker. Hover the ⓘ beside a panel title to see how it is scored.",
  ],
  howTo: [
    'Weights: security config change 50, key invalidation 45, failure 40, anonymous denial 35, destructive change 30, other Kibana change 25, workflow run 10.',
    'Risk total is weight × events, not an event count. A failed action scores on its own row, marked (failed).',
    'Kibana’s own API-key clean-up and this suite’s automated install score 0; the line above a tile’s number counts them.',
    'Scope separates your identities, Elastic platform automation and unauthenticated requests; an identity without an email is not necessarily external.',
    'Click an API key or Principal id to filter the page or open Actor 360; a Cloud API key’s id also covers the API keys it created.',
  ],
};

export function build() {
  resetIds();
  const P = [
    // The scale lives in the column name because it is the one ratio among five counts: a bare
    // "34.2" beside "377" reads as another count. A `secondary` line would say it too, but would
    // push this tile's number off the baseline its five siblings share.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${riskScored()} | STATS ${RISK_INDEX_STATS} | ${RISK_INDEX_EVAL} | EVAL \`Mean severity (of 50)\` = mean_severity | KEEP \`Mean severity (of 50)\``, 'Mean severity (of 50)',
      'Average risk weight per scoring event, on the 0–50 scale, from 50 for a config change down to 10 for a workflow run. Routine activity scores 0 and is excluded, so read it with Scoring events beside it.', { dec: 1 }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${privilegedKpi('Config changes')}`, 'Config changes',
      'Security configuration changes: API keys created, changed or invalidated, and roles and user profiles written. Kibana’s routine API-key clean-up is left out; the line above the number counts it. Any other change deserves review.',
      { secondary: 'housekeeping_note' }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE event.action == "invalidate_apikeys" | ${privilegedKpi('Key invalidations')}`, 'Key invalidations',
      'API key invalidation requests (one can revoke several keys): routine rotation, or a credential revoked in a hurry. Part of Config changes. Kibana’s routine API-key clean-up is left out; the line above the number counts it.',
      { secondary: 'housekeeping_note' }),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS \`Failures\` = COUNT(*)`, 'Failures', 'Events that failed: failed sign-ins (each attempt counted once), denials and any other failed action. Counted as on Identity & Access’s Failed or denied tile, so the two agree.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE event.action == "anonymous_access_denied" | STATS \`Anonymous denials\` = COUNT(*)`, 'Anonymous denials', 'Unauthenticated requests that were rejected.'),
    // riskScored() spelled out without its `WHERE risk > 0`, so the suite's own install (scored 0 through the
    // suite_install key) can be counted in the second line, the way privilegedKpi() counts the cleanups.
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${RISK_PREFILTER} | STATS n = COUNT(*) BY ${RISK_KEYS} | ${RISK_RESTORE} | ${RISK} ` +
      '| STATS scoring = SUM(n) WHERE risk > 0, installs = SUM(n) WHERE suite_install AND risk == 0 ' +
      '| EVAL `Scoring events` = COALESCE(scoring, 0), installs = COALESCE(installs, 0), ' +
      `install_note = CASE(installs == 0, "no suite installs in range", CONCAT("excl. ", ${grouped('installs')}, " suite installs")) ` +
      '| KEEP `Scoring events`, install_note', 'Scoring events',
      'Events that carried any risk weight: what Mean severity averages over. This suite’s own automated install scores 0 and is left out; the line above the number counts it.',
      { secondary: 'install_note' }),
    // One row per identity and action, not per payload: grouped by the raw payload, every API key id
    // made its own one-event row (10 of 12 rows at 24h read "invalidate_apikeys · 1") and the JSON was
    // hard-clipped mid-glyph. The payload stays whole in the event feed at the foot of the page; here
    // it is reduced to what it names. Full width so that name is never the column that clips.
    // The 1.0.5 API key and Principal id columns took that width back: at 1440, Latest target cut
    // "(none named in the payload)" mid-word. Identity, Action and Targets were sized above their values
    // (update_user_profile_data is ~145px) and API key is mostly "-" here, so they give it up and Latest
    // target keeps 175px at 1440.
    table(0, 5, 48, 7, `🚨 Config changes · up to ${fitRows(7)} identity–action pairs, latest first`,
      `FROM ${IDX} | ${TIME} | ${PRIVILEGED} | ${TARGET} | ${ACTOR_RESOLVE} | STATS events = COUNT(*), targets = COUNT_DISTINCT(SPLIT(target, ",")), latest = LAST(target, @timestamp), last_change = MAX(@timestamp) BY actor, ${PIN_BY}, action = event.action | SORT last_change DESC | ${SCOPE} | ${TARGET_SHOW} | LIMIT ${fitRows(7)}`,
      [sized('actor', 195, { min: 190 }), { ...PIN_KEY, width: 125 }, PIN_PRINCIPAL_SHORT, 'actor_scope', sized('action', 160, { min: 150 }), { column: 'latest', label: 'Latest target' }],
      [sized('targets', 80, { label: 'Targets' }), 'events', 'last_change'],
      'Security configuration changes (API keys, roles, user profiles) by identity and action, most recent first, with the latest target and how many targets. Many invalidations over many keys is rotation; over one key, a loop.',
      { empty: 'good' }),
    vega(0, 12, 24, 13, '05-rare-event-scatter', 'Highest-severity actions, by how rare',
      'The highest-severity scoring actions in range, placed by how often each happened: rarer is further left, so look top-left first. Color repeats the risk weight, blue for 10 up to deep red for 50. Hover for who and when.'),
    // Bars, not an area: an area interpolates straight across empty buckets and draws minutes of
    // rising risk that never happened. Split by scope so a spike says whose it was before anyone
    // has to open the leaderboard. The scope EVALs run on the scored subset only (measured: 0.2s vs
    // 0.15s unsplit over 1h).
    xy(24, 12, 24, 13, 'Risk over time',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: `${BUCKET}, ${ACTOR_KEYS}` })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS \`Summed severity\` = SUM(risk * n) BY \`${BUCKET}\`, actor_scope | SORT actor_scope`,
      'Summed severity', 'Risk weight summed per interval, routine activity excluded, split by tenant identities, Elastic platform automation or unauthenticated requests. Spikes are clusters of privileged, failed or denied activity. A blank stretch means nothing scored then.',
      { breakdown: 'actor_scope', colors: SCOPE_COLORS, yTitle: 'Summed severity' }),
    // first_seen is window-censored (see NEW_IN_RANGE). Grouped on actor alone and scoped AFTER
    // the STATS — scope is a function of actor. Full width: at half width its six columns left
    // Identity under 120px at a 1440px viewport (a --lint advisory), and the width buys Last seen.
    // The LIMIT stays last so table() can lower it to the rows the panel shows (it only matches a
    // trailing LIMIT); the EVALs between it and the SORT are per-row and do not stop the top-N.
    table(0, 25, 48, TH, 'Identities by first appearance in range',
      `FROM ${IDX} | ${TIME} | ${NOISE} | STATS first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY user.email, ${PIN_BY} | ${ACTOR_RESOLVE} | SORT first_seen DESC, actor | ${SCOPE} | ${NEW_IN_RANGE} | LIMIT ${fitRows(TH)}`,
      [WHO_COL, PIN_PRINCIPAL, sized('new_in_range', 70, { label: 'New' })], ['first_seen', 'last_seen', 'events', { column: 'ips', label: 'Client IPs' }, SCOPE_LAST],
      'Identities by their first signal event in the range, latest first. New reads “yes” unless they were already active as the range opened. A “yes” near the top is worth a question; widen the range to tell new from returning.'),
    // Full width because Identity is free text: at half width a 36-character identity
    // (<unauthenticated-cloud-access-token>, a long persona name) was cut. One decimal on
    // the mean throughout, since "40" beside "26.4" reads as two kinds of number.
    table(0, 38, 48, TH, 'Risk leaderboard — top identities by total severity',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: ACTOR_KEYS })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS ${RISK_INDEX_STATS}, privileged = SUM(CASE(scc, n, 0)) BY actor, actor_scope, ${PIN_BY} | ${RISK_INDEX_EVAL} | SORT risk_total DESC, actor | LIMIT ${fitRows(TH)}`,
      [WHO_COL, ...PIN_COLS],
      // Two-word headers get the width to stay on one line: wrapped, "Scoring events" and "Mean severity"
      // made the header row 16px taller, and the twelfth row of an h=13 table was cut through its glyphs.
      ['risk_total', sized('scoring_events', 120), { column: 'mean_severity', width: 120, format: { type: 'number', decimals: 1 } }, 'privileged', SCOPE_LAST],
      'Identities ranked by total risk, so sustained behavior outranks one high-severity event. Scope sets Elastic’s own platform automation (such as elastic.maintenance) apart from your users. Privileged counts security configuration changes.'),
    table(0, 51, 48, TH, 'Why these identities scored — top risky actions, with their weight',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: ACTOR_KEYS, aggs: 'last_ts = MAX(@timestamp)' })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS events = SUM(n), risk_total = SUM(risk * n), last_seen = MAX(last_ts) BY actor, actor_scope, ${PIN_BY}, action = event.action, weight = risk, failed = event.outcome == "failure" | ${FAILED_MARK} | SORT risk_total DESC, actor, action | LIMIT ${fitRows(TH)}`,
      // weight is a group key, but listed as a metric so it right-aligns with the numbers it multiplies.
      [WHO_COL, PIN_PRINCIPAL, WHAT_COL], ['weight', 'events', 'risk_total', 'last_seen', SCOPE_LAST],
      'The receipts behind the risk leaderboard: the identity and action pairs that added the most risk, with weight, count and last time. Risk total is weight × events. A rare action may be missing; see Highest-severity actions.'),
    // Full width: identity and the action name are variable-length text, and at half width the
    // action — the column the panel exists for — was the one cut. One row per identity and action:
    // grouped by source IP as well (round 4), elastic and admin took two rows each and a pair's count
    // was split across rows, so it no longer matched the same pair in Why these identities scored
    // (alex.kim access_denied 467 here, 480 there). The address survives as the newest one plus a
    // count of how many there were; LAST and COUNT_DISTINCT run on the failure subset only.
    // The platform hop is tagged "(internal)" as 05 does, on the grouped rows (one condition, after the STATS);
    // the newest anonymous denial came through it, so untagged it read as the prober's address.
    // Principal id only of the two pin columns (1.0.5): with API key as well, Latest IP, Client IPs and Scope
    // no longer fit a 1440px viewport. A named key's failures pin the identity that created it.
    // The same holds for first appearance and Why: only the leaderboard has room for both.
    table(0, 64, 48, TH, 'Top failures and denials by identity and action',
      `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | ${ACTOR_RESOLVE} | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip), ip = LAST(client.ip, @timestamp), last_seen = MAX(@timestamp) BY actor, user.name, action = event.action | SORT events DESC, actor, action | ${SCOPE} | EVAL ip = COALESCE(CASE(CIDR_MATCH(ip, "100.64.0.0/10"), CONCAT(TO_STRING(ip), " (internal)"), TO_STRING(ip)), "none recorded") | LIMIT ${fitRows(TH)}`,
      [WHO_COL, PIN_PRINCIPAL, WHAT_COL, { column: 'ip', label: 'Latest IP', width: 200, min: 170 }], [{ column: 'ips', label: 'Client IPs' }, 'events', 'last_seen', SCOPE_LAST],
      'Failed and denied operations by identity and action, most frequent first, with the latest client IP and how many addresses were used. Many addresses behind one identity suggests a spray; “(internal)” is the platform’s own hop.', { empty: 'good' }),
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
      'Every security configuration change, one event per row, newest first. The payload is cut at the panel edge: expand a row to read it whole. Capped at the newest 1,000; the Config changes tile has the total.',
      { empty: 'good' }),
    search(0, 77, 48, 25, '01-all-mutations', 'Mutation feed · newest 1,000 at most',
      'Every create, update and delete in Kibana and in Elasticsearch security configuration, newest first, with what each change named. Capped at the newest 1,000, so the result count is that cap; narrow the time range to reach older events.'),
  ];
  return dash(rawId('04-security-anomalies'), '[Audit] 🚨 Security & Anomalies',
    'Mean-severity risk scoring, privileged operations, failures and newly seen identities.', P, { intro: INTRO });
}
