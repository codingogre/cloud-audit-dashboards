/** 04 Security & Anomalies — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, RISK_INDEX_STATS, RISK_INDEX_EVAL, NOISE, TIME, BUCKET, SCOPE, PALETTE, dash, kpi, xy, table,
  vega, search, sized, blankNull, resetIds
} from '../panels.mjs';
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
const CHG = 'attributes.elasticsearch.audit.security_config_change';
const TARGET =
  `GROK ${CHG} """"name":"%{DATA:t_name}"""" | GROK ${CHG} """"ids":\\[%{DATA:t_ids}\\]""" | ` +
  `GROK ${CHG} """"id":"%{DATA:t_id}"""" | GROK ${CHG} """"uid":"%{DATA:t_uid}"""" | ` +
  'EVAL target = COALESCE(t_name, REPLACE(t_ids, "\\"", ""), t_id, t_uid)';
/**
 * The latest target for display, on the grouped rows: spaced after its commas, and cut with a visible
 * ellipsis — Lens hard-clips a cell mid-glyph with no cue, and an invalidation can list dozens of ids.
 */
const TARGET_SHOW =
  'EVAL latest = REPLACE(latest, ",", ", ") | EVAL latest = CASE(LENGTH(latest) > 72, CONCAT(LEFT(latest, 71), "…"), latest)';

/**
 * No Email column on this page's identity tables. On every render (1h and 24h) it held only dashes:
 * the identities that score are API keys, service accounts and unauthenticated principals, and
 * Identity already IS the email for a person. The README rule for a click-to-filter column of dashes
 * applies (drop it). The cost is the click-to-pin and the Actor 360 drilldown from these tables;
 * the Person (email) control pins a person on this page and carries to Actor 360.
 */
const PIN_HINT = 'To follow one person, pick them in the Person (email) control; the pin carries to Actor 360.';

export function build() {
  resetIds();
  const P = [
    // The scale lives in the column name because it is the one ratio among five counts: a bare
    // "34.2" beside "377" reads as another count. A `secondary` line would say it too, but would
    // push this tile's number off the baseline its five siblings share.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${riskScored()} | STATS ${RISK_INDEX_STATS} | ${RISK_INDEX_EVAL} | EVAL \`Mean severity (of 50)\` = mean_severity | KEEP \`Mean severity (of 50)\``, 'Mean severity (of 50)',
      'Average severity weight across scoring events, on the same 0–50 scale as the weights: config change 50, key invalidation 45, failure 40, anonymous denial 35, destructive change 30, other Kibana change 25, workflow execution 10. Executions weigh least on purpose — they are the one class with unbounded cadence, and a scheduled workflow firing every minute would otherwise turn total risk back into an event count. Routine activity scores 0 and is excluded, so this is not a disguised event count — read it with Scoring events beside it.', { dec: 1 }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Config changes\` = COUNT(attributes.elasticsearch.audit.security_config_change)`, 'Config changes', 'Security configuration changes recorded by Elasticsearch — the total that the configuration-change table and feed below draw from.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "invalidate_apikeys" | STATS \`Key invalidations\` = COUNT(*)`, 'Key invalidations', 'API keys invalidated in range — legitimate rotation, or a credential being revoked in a hurry.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" | STATS \`Failures\` = COUNT(*)`, 'Failures', 'Events with a failure outcome.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "anonymous_access_denied" | STATS \`Anonymous denials\` = COUNT(*)`, 'Anonymous denials', 'Unauthenticated requests that were rejected.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${riskScored()} | STATS scoring = SUM(n) | EVAL \`Scoring events\` = COALESCE(scoring, 0) | KEEP \`Scoring events\``, 'Scoring events', 'Number of events that carried any risk weight at all — the denominator of Mean severity, and the volume that severity is averaged over.'),
    // One row per identity and action, not per payload: grouped by the raw payload, every API key id
    // made its own one-event row (10 of 12 rows at 24h read "invalidate_apikeys · 1") and the JSON was
    // hard-clipped mid-glyph. The payload stays whole in the event feed at the foot of the page; here
    // it is reduced to what it names. Full width so that name is never the column that clips.
    table(0, 5, 48, 11, '🚨 Security configuration changes, most recent first',
      `FROM ${IDX} | ${TIME} | WHERE ${CHG} IS NOT NULL | ${TARGET} | ${ACTOR_RESOLVE} | STATS events = COUNT(*), targets = COUNT_DISTINCT(SPLIT(target, ",")), latest = LAST(target, @timestamp), last_change = MAX(@timestamp) BY actor, action = attributes.event.action | SORT last_change DESC | ${SCOPE} | ${TARGET_SHOW} | ${blankNull('latest')} | LIMIT 25`,
      [sized('actor', 220), 'actor_scope', sized('action', 190), { column: 'latest', label: 'Latest target' }],
      [sized('targets', 90, { label: 'Targets' }), 'events', 'last_change'],
      'Security configuration changes grouped by identity and action, the most recently active first; in a busy range the quieter pairs are beyond the rows shown, so Events here add up to Config changes above only when every pair fits. Latest target is what the newest of those changes named (the API key, the key ids of an invalidation, the role, or the user profile), and Targets counts the different ones named across all of them: hundreds of invalidations over hundreds of keys is rotation, hundreds over one key is a loop. A profile activation names no target, because it is the signed-in user\'s own. The full JSON payload of every change is in the Config-change event feed at the foot of the page.'),
    vega(0, 16, 24, 13, '05-rare-event-scatter', 'Rare and privileged operations',
      'The highest-severity scoring actions in range, one row per action and weight, placed by how often each happened: rarer is further left, so the top-left is rare and high-severity — look there first. Shows the top 12 by severity, rarest first within a weight; the subtitle says how many actions scored in all. Colour is the severity weight. A failed change scores 40 whatever it changed, so it gets its own row, marked (failed). Hover a point for how many identities did it and when. Routine activity scores 0 and is not shown.'),
    // Bars, not an area: an area interpolates straight across empty buckets and draws minutes of
    // rising risk that never happened. Split by scope so a spike says whose it was before anyone
    // has to open the leaderboard. The scope EVALs run on the scored subset only (measured: 0.2s vs
    // 0.15s unsplit over 1h).
    xy(24, 16, 24, 13, 'Risk over time',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: `${BUCKET}, ${ACTOR_KEYS}` })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS \`Summed severity\` = SUM(risk * n) BY \`${BUCKET}\`, actor_scope | SORT actor_scope`,
      'Summed severity', 'Summed severity weight per interval, routine activity excluded, split by who it came from: tenant identities, Elastic platform automation, or unauthenticated requests. Spikes are clusters of privileged, failed or denied activity.',
      { breakdown: 'actor_scope', colors: SCOPE_COLORS, yTitle: 'Summed severity' }),
    // first_seen is window-censored (see NEW_IN_RANGE). Grouped on actor alone and scoped AFTER
    // the STATS — scope is a function of actor. Full width: at half width its six columns left
    // Identity under 120px at a 1440px viewport (a --lint advisory), and the width buys Last seen.
    // The LIMIT stays last so table() can lower it to the rows the panel shows (it only matches a
    // trailing LIMIT); the EVALs between it and the SORT are per-row and do not stop the top-N.
    table(0, 29, 48, 10, 'Identities by first appearance in range, latest first',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR_RESOLVE} | STATS first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY actor | SORT first_seen DESC | ${SCOPE} | ${NEW_IN_RANGE} | LIMIT 15`,
      ['actor', 'actor_scope', sized('new_in_range', 70, { label: 'New' })], ['first_seen', 'last_seen', 'events', { column: 'ips', label: 'Client IPs' }],
      'Identities ordered by their first event inside the selected range, latest first, from signal events only (query internals are left out, as on every gated panel). First seen is within the range, not ever: an identity that was already active when the range opened also shows a first-seen near its start. New reads "no" for those (first seen in the opening twelfth of the range) and "yes" otherwise; on a project whose audit history is shorter than the range, every identity reads "yes". A "yes" near the top is an identity worth a question; widen the range to tell a new identity from a returning one. Client IPs is 0 for identities whose events record no client address (the Kibana service account, platform automation).'),
    // Full width because Identity is free text: at half width a 36-character identity
    // (<unauthenticated-cloud-access-token>, a long persona name) was cut. One decimal on
    // the mean throughout, since "40" beside "26.4" reads as two kinds of number.
    table(0, 39, 48, 12, 'Risk leaderboard — top identities by total severity',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: ACTOR_KEYS })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS ${RISK_INDEX_STATS}, privileged = SUM(CASE(scc, n, 0)) BY actor, actor_scope | ${RISK_INDEX_EVAL} | SORT risk_total DESC | LIMIT 15`,
      ['actor', 'actor_scope'],
      ['risk_total', 'scoring_events', { column: 'mean_severity', format: { type: 'number', decimals: 1 } }, 'privileged'],
      `Identities ranked by total accumulated severity, so sustained behaviour outranks a single high-severity event; only the top of the ranking fits the panel. Scope separates tenant identities from Elastic platform automation and unauthenticated requests — without it elastic.maintenance can top this table, because Elastic platform automation performs routine security config changes itself. Identity is the email for a person and the key name for an API key. ${PIN_HINT}`),
    table(0, 51, 48, 12, 'Why these identities scored — top risky actions, with their weight',
      `FROM ${IDX} | ${TIME} | ${riskScored({ by: ACTOR_KEYS, aggs: 'last_ts = MAX(@timestamp)' })} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS events = SUM(n), risk_total = SUM(risk * n), last_seen = MAX(last_ts) BY actor, actor_scope, action = attributes.event.action, weight = risk | SORT risk_total DESC | LIMIT 30`,
      // weight is a group key, but listed as a metric so it right-aligns with the numbers it multiplies.
      ['actor', 'actor_scope', 'action'], ['weight', 'events', 'risk_total', 'last_seen'],
      `The receipts behind the leaderboard: the identity and action pairs that contributed the most risk, with what each action weighed, how many times it happened, and when it last did. Risk total is weight × events, the same quantity the leaderboard sums. Only the largest contributions fit the panel, so a rare action can be missing here: Rare and privileged operations lists the actions by severity instead. ${PIN_HINT}`),
    // Full width: identity and the action name are variable-length text, and at half width the
    // action — the column the panel exists for — was the one cut.
    table(0, 63, 48, 10, 'Failures and denials by identity, most frequent first',
      `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action IN ("authentication_failed","realm_authentication_failed","anonymous_access_denied") | ${ACTOR_RESOLVE} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY actor, action = attributes.event.action, ip = client.ip | SORT events DESC | ${SCOPE} | LIMIT 15`,
      ['actor', 'actor_scope', 'action', 'ip'], ['events', 'last_seen'],
      `Failed and denied operations grouped by identity, action and source IP, the most frequent first; only the top rows fit the panel. These are the events the Failures tile counts (every denial and failed sign-in carries a failure outcome), and the Anonymous denials tile is their anonymous_access_denied rows. Scope separates unauthenticated probes from tenant identities and Elastic platform automation. API keys and native users (elastic, admin) carry no email, so an Identity that is not an email does not mean an external probe — read Scope. ${PIN_HINT}`, { empty: 'good' }),
    // Discover in ES|QL mode returns at most 1,000 rows and prints that as "1,000 results", which on a
    // 24h range sat under a Config changes tile reading 1,976. The cap is the reason, so the title says it.
    search(0, 73, 48, 12, '03-security-config-changes', 'Config-change event feed · newest 1,000 at most',
      'Every security configuration change as its own event, newest first, with the payload in full; expand a row to read a long one. Discover returns at most the newest 1,000 events, and its result count is that cap rather than the total: when it reads 1,000, the Config changes tile at the top has the total.'),
    search(0, 85, 48, 14, '01-all-mutations', 'Mutation feed · newest 1,000 at most',
      'Creates, updates and deletes across Kibana and Elasticsearch security config, newest first. Discover returns at most the newest 1,000 events, and its result count is that cap rather than the total. To reach older events, narrow the time range.'),
  ];
  return dash('cloud-audit-04-security-anomalies', '[Audit] 🚨 Security & Anomalies',
    'Mean-severity risk scoring, privileged operations, failures and newly seen identities.', P);
}
