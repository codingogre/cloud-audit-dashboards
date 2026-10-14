/** 04 Security & Anomalies — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, RISK_INDEX_STATS, RISK_INDEX_EVAL, NOISE, TIME, BUCKET, SCOPE, PALETTE, dash, kpi, xy, table,
  vega, search, sized, resetIds
} from '../panels.mjs';
import {
  WHO, RISK_SCORED
} from './shared.mjs';

/**
 * Scope colours, pinned so a stacked bar reads the same on every refresh. Unauthenticated takes the
 * warm hue because it is the one an analyst should notice; platform the quiet green, because it is
 * Elastic's own automation and mostly expected.
 */
const SCOPE_COLORS = { tenant: PALETTE[1], platform: PALETTE[0], unauthenticated: PALETTE[7] };

/**
 * "unauthenticated" exactly fills the 105px short-label width, so it ran into the next column with
 * no gap (rendered). It is the longest Scope value and the one that matters, so the column gets 15px more.
 */
const SCOPE_COL = sized('actor_scope', 120);

/**
 * "First seen" is the first event INSIDE the picker's range, so anything active when the range
 * opened looks new. Flag it instead of hiding it: an identity first seen in the opening twelfth of
 * the range (5 minutes of an hour, 14 hours of a week) was most likely already active before it,
 * and reads "no". Derived after the STATS, over at most a screenful of rows, so it costs nothing.
 */
const NEW_IN_RANGE =
  'EVAL new_in_range = CASE(TO_LONG(first_seen) - TO_LONG(TO_DATETIME(?_tstart)) > ' +
  '(TO_LONG(TO_DATETIME(?_tend)) - TO_LONG(TO_DATETIME(?_tstart))) / 12, "yes", "no")';

export function build() {
  resetIds();
  const P = [
    // The scale lives in the column name because it is the one ratio among five counts: a bare
    // "34.2" beside "377" reads as another count. A `secondary` line would say it too, but would
    // push this tile's number off the baseline its five siblings share.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | STATS ${RISK_INDEX_STATS} | ${RISK_INDEX_EVAL} | EVAL \`Mean severity (of 50)\` = mean_severity | KEEP \`Mean severity (of 50)\``, 'Mean severity (of 50)',
      'Average severity weight across scoring events, on the same 0–50 scale as the weights: config change 50, key invalidation 45, failure 40, anonymous denial 35, destructive change 30, other Kibana change 25, workflow execution 10. Executions weigh least on purpose — they are the one class with unbounded cadence, and a scheduled workflow firing every minute would otherwise turn total risk back into an event count. Routine activity scores 0 and is excluded, so this is not a disguised event count — read it with Scoring events beside it.', { dec: 1 }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Config changes\` = COUNT(attributes.elasticsearch.audit.security_config_change)`, 'Config changes', 'Security configuration changes recorded by Elasticsearch.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "invalidate_apikeys" | STATS \`Key invalidations\` = COUNT(*)`, 'Key invalidations', 'API keys invalidated in range — legitimate rotation, or a credential being revoked in a hurry.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" | STATS \`Failures\` = COUNT(*)`, 'Failures', 'Events with a failure outcome.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "anonymous_access_denied" | STATS \`Anonymous denials\` = COUNT(*)`, 'Anonymous denials', 'Unauthenticated requests that were rejected.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | STATS \`Scoring events\` = COUNT(*)`, 'Scoring events', 'Number of events that carried any risk weight at all — the denominator of Mean severity, and the volume that severity is averaged over.'),
    // Identity and action are short and bounded (update_user_profile_data, the longest config-change action, is 24 characters); the payload is what the panel is for, so it
    // takes everything they leave (~400px, enough for a create_apikey id in full).
    table(0, 5, 28, 13, '🚨 Security configuration changes',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.security_config_change IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), last_change = MAX(@timestamp) BY actor, action = attributes.event.action, change = attributes.elasticsearch.audit.security_config_change | SORT last_change DESC | LIMIT 25`,
      [sized('actor', 200), sized('action', 165), 'change'], ['events', 'last_change'],
      'Raw security_config_change payloads, grouped by identity and action. The field is a JSON string, shown verbatim — it names the exact API key ids or profile uids affected. A long payload (an invalidation listing many keys) is cut at the column edge; the Config-change event feed below shows each one in full.'),
    vega(28, 5, 20, 13, '05-rare-event-scatter', 'Rare and privileged operations',
      'The highest-severity scoring actions in range, one row per action and weight, placed by how often each happened: rarer is further left, so the top-left is rare and high-severity — look there first. Colour is the severity weight. A failed change scores 40 whatever it changed, so it gets its own row, marked (failed). Hover a point for how many identities did it and when. Routine activity scores 0 and is not shown.'),
    // Bars, not an area: an area interpolates straight across empty buckets and draws minutes of
    // rising risk that never happened. Split by scope so a spike says whose it was before anyone
    // has to open the leaderboard. The scope EVALs run on the scored subset only (measured: 0.2s vs
    // 0.15s unsplit over 1h).
    xy(0, 18, 24, 12, 'Risk over time',
      `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS \`Summed severity\` = SUM(risk) BY ${BUCKET}, actor_scope`,
      'Summed severity', 'Summed severity weight per interval, routine activity excluded, split by who it came from: tenant identities, Elastic platform automation, or unauthenticated requests. Spikes are clusters of privileged, failed or denied activity.',
      { breakdown: 'actor_scope', colors: SCOPE_COLORS }),
    // first_seen is window-censored (see NEW_IN_RANGE). Grouped on actor alone and scoped AFTER
    // the STATS — scope is a function of actor — which is cheaper than the actor_kind it replaces:
    // that was constant "service" for every API-key and native identity, unauthenticated ones included.
    // The LIMIT stays last so table() can lower it to the rows the panel shows (it only matches a
    // trailing LIMIT); the EVALs between it and the SORT are per-row and do not stop the top-N.
    table(24, 18, 24, 12, 'Identities by first appearance in range',
      `FROM ${IDX} | ${TIME} | ${NOISE} | ${ACTOR_RESOLVE} | STATS first_seen = MIN(@timestamp), events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY actor | SORT first_seen DESC | ${SCOPE} | ${NEW_IN_RANGE} | LIMIT 15`,
      ['actor', SCOPE_COL, sized('new_in_range', 105, { label: 'New in range' })], ['first_seen', 'events', { column: 'ips', label: 'Client IPs' }],
      'Identities ordered by their first event inside the selected range, latest first. First seen is within the range, not ever: an identity that was already active when the range opened also shows a first-seen near its start. New in range reads "no" for those (first seen in the opening twelfth of the range). A "yes" near the top is an identity worth a question; widen the range to tell a new identity from a returning one. Client IPs is 0 for identities whose events record no client address (the Kibana service account, platform automation).'),
    // Full width because Identity and Email are both free text: at half width a 36-character
    // identity (<unauthenticated-cloud-access-token>, a long persona name) was cut. One decimal on
    // the mean throughout, since "40" beside "26.4" reads as two kinds of number.
    table(0, 30, 48, 12, 'Risk leaderboard',
      `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS ${RISK_INDEX_STATS}, privileged = COUNT(attributes.elasticsearch.audit.security_config_change) BY actor, actor_scope, attributes.user.email | ${RISK_INDEX_EVAL} | SORT risk_total DESC | LIMIT 15`,
      ['actor', SCOPE_COL, WHO],
      ['risk_total', 'scoring_events', { column: 'mean_severity', format: { type: 'number', decimals: 1 } }, 'privileged'],
      'Identities ranked by total accumulated severity, so sustained behaviour outranks a single high-severity event. Scope separates tenant identities from Elastic platform automation and unauthenticated requests — without it elastic.maintenance can top this table, because Elastic platform automation performs routine security config changes itself. API keys and native users carry no email; click an email, where there is one, to pin that identity across the whole suite.'),
    table(0, 42, 48, 12, 'Why these identities scored — every risky action, with its weight',
      `FROM ${IDX} | ${TIME} | ${RISK_SCORED} | ${ACTOR_RESOLVE} | ${SCOPE} | STATS events = COUNT(*), risk_total = SUM(risk), last_seen = MAX(@timestamp) BY actor, actor_scope, attributes.user.email, action = attributes.event.action, weight = risk | SORT risk_total DESC | LIMIT 30`,
      // weight is a group key, but listed as a metric so it right-aligns with the numbers it multiplies.
      ['actor', SCOPE_COL, WHO, 'action'], ['weight', 'events', 'risk_total', 'last_seen'],
      'The receipts behind the leaderboard: for each identity, exactly which actions scored, what each one weighed, how many times, and when it last happened. Risk total is weight × events, the same quantity the leaderboard sums. This is what turns a score into evidence. Click an email to pin that identity across the suite.'),
    // Full width: identity, email and the action name are all variable-length text, and at half
    // width the action — the column the panel exists for — was the one cut.
    table(0, 54, 48, 10, 'Failures and denials by identity',
      `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action IN ("authentication_failed","realm_authentication_failed","anonymous_access_denied") | ${ACTOR_RESOLVE} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY actor, attributes.user.email, action = attributes.event.action, ip = client.ip | SORT events DESC | ${SCOPE} | LIMIT 15`,
      ['actor', SCOPE_COL, WHO, 'action', 'ip'], ['events', 'last_seen'],
      'Failed and denied operations grouped by identity, action and source IP. Scope separates unauthenticated probes from tenant identities and Elastic platform automation. API keys and native users (elastic, admin) carry no email, so an empty email does not mean an external probe — read Scope.'),
    search(0, 64, 48, 12, '03-security-config-changes', 'Config-change event feed', 'Every security configuration change as its own event, newest first, with the payload in full. Expand a row to read a long payload.'),
    search(0, 76, 48, 14, '01-all-mutations', 'All mutations', 'Every create, update and delete across Kibana and Elasticsearch security config, newest first.'),
  ];
  return dash('cloud-audit-04-security-anomalies', '[Audit] 🚨 Security & Anomalies',
    'Mean-severity risk scoring, privileged operations, failures and newly seen identities.', P);
}
