/**
 * THE STARTER ALERT PACK (1.0.6): ES|QL rules on Kibana's Universal Alerting (alerting_v2, /api/alerting/v2/rules),
 * shipped as code beside the dashboards. `./audit --rules` deploys them (scripts/rules.mjs) and writes the payloads
 * to rules/<slug>.json for review; --deploy runs it after --dashboards; `--clean rules` removes them.
 *
 * What a rule is, on this API (measured on the live project, 9.6 serverless):
 *   - kind "alert": the query IS the condition. Kibana runs `query.base` (+ `query.breach.segment`), every row that
 *     comes back is a breach, and `grouping.fields` (output columns) make one alert per group. A `severity` column
 *     (info | low | medium | high | critical) sets the alert's severity; the whole row is kept as the alert's data.
 *   - No actions. Delivery is the customer's: an action policy whose matcher tags meet `routing_tags`
 *     ("cloud-audit"), sending to a Workflow they own.
 *   - Deployed disabled. --rules creates a missing rule with enabled:false and replaces an existing one with its
 *     stored `enabled`, and writes nothing when the stored rule already matches: the customer's on/off survives
 *     every redeploy.
 *
 * TIME. Kibana adds a DSL range filter (@timestamp gt now-lookback, lte now) and, when the text names ?_tstart or
 * ?_tend, binds those two (and only those) to the same window as ISO strings. So every rule query bounds itself
 * with TIME_ONLY and writes any narrower window relative to ?_tend (`@timestamp > TO_DATETIME(?_tend) - 15
 * minutes`), never NOW(): the lint and a back-test can then bind any historical end. `schedule.lookback` must be
 * at least the widest window the text names (a unit test parses them). A rule must never use TIME, CONTROLS_WHERE
 * or IDENTITY_WHERE: no dropdown variable is bound when a rule runs, and an unbound one is a hard error.
 *
 * NAMES. Identities are named exactly as the Identity dropdown names them (count first by IDENTITY_KEYS, then
 * ACTOR_RESOLVE and KIND_GROUPED on the grouped rows), so an alert's identity pastes into the dropdown.
 *
 * IDS. `cloud-audit-rule-<slug>`, namespaced by nsId() (`cloud-audit-<ns>-rule-<slug>` under AUDIT_ID_NS; "rule" is
 * in RESERVED_NS). Rule saved objects are multiple-isolated like dashboards: an id is unique across spaces.
 * A private copy keeps the production names, as the dashboards keep their titles: the id and the tags separate them.
 */
import { cfg, nsId } from './env.mjs';
import { dashId, SUITE } from './suite.mjs';
import {
  IDX, TIME_ONLY, SIGNIN_FAILED, REALM_TRACE, PLATFORM_ACTORS, UNAUTH_ACTORS, PRIVILEGED, PRIVILEGED_TEST,
  IDENTITY_KEYS, ACTOR_RESOLVE, KIND_GROUPED, ESS, KIB, CHG, TARGET, INTERNAL_NET, nullSafe,
} from './panels.mjs';

/**
 * The tag every rule carries, and the routing tag a customer's action policy matches. A private copy
 * (AUDIT_ID_NS) carries its namespace instead (`cloud-audit-<ns>`): it sits in the same space as production, so
 * with the production tag a policy routing "cloud-audit" would deliver its alerts and a tag filter would list it.
 */
export const RULE_TAG = 'cloud-audit';
export const ROUTING_TAG = 'cloud-audit';
export const ruleTag = () => (process.env.AUDIT_ID_NS ? cfg.ns : RULE_TAG);
export const routingTag = () => (process.env.AUDIT_ID_NS ? cfg.ns : ROUTING_TAG);
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

/** ESS / KIB without their leading WHERE, for a STATS … WHERE clause. */
const cond = (where) => where.replace(/^WHERE\s+/, '');

/** The end of the rule's window, as a date (Kibana binds ?_tend as an ISO string). Inner windows count back from it. */
const END = 'TO_DATETIME(?_tend)';

/**
 * The requests an alerting_v2 rule makes when it runs. Enabling a rule mints a new Cloud API key (a new key on every
 * enable), and every event that key writes carries an x-opaque-id of `unknownId;kibana:task%20manager:run%20
 * alerting_v2%3Arule_executor:…` (measured 2026-10-26 on the private copy: 246 of 246 events, 10 keys). There is no
 * create_apikey event for it, so rule 3 sees nothing; rule 5 would report each one as a new identity. A client
 * chooses its own x-opaque-id and Elasticsearch records it as sent, so the test drops only Cloud API key events
 * that carry it: a person, an Elasticsearch key or an account cannot hide behind the header, and a Cloud API key
 * shows up unless every one of its requests carries it. This is the residue: a brand-new Cloud API key that sends
 * the header on every request is not seen (the runbook says so). Counting the header per identity instead, and
 * dropping a key only when every event matched, catches no more than this and tripled the run time (3.4 s against
 * 1.3 s, measured 2026-10-26): it reads the header of every event in 30 days, where this filter is pushed down.
 * Null-guarded, so NOT never drops a row that has no header or no domain.
 */
const RULE_RUNNER =
  '(user.domain IS NULL OR user.domain != "_cloud_api_key" OR `http.request.header.x-opaque-id` IS NULL ' +
  'OR NOT `http.request.header.x-opaque-id` LIKE "*;kibana:task%20manager:run%20alerting_v2%3Arule_executor:*")';

/* ---------------------------------------------------------------- rule 1: failed sign-in burst (UC-002) */

/**
 * Failures are counted first by IDENTITY_KEYS and address (a handful of rows), named the dropdown's way, then
 * copied into two branches by MV_EXPAND: by Client IP (every failure with an address, platform accounts and
 * unnamed attempts included) and by Identity (platform and placeholder names dropped). names_tried leaves the
 * placeholders out, so it is 0 or 1 in the Identity branch and spraying can only fire by address. The internal
 * 100.64/10 hop is flagged (platform_hop), not dropped: an attack through the platform proxy still counts. The
 * address is client.ip, or source.ip when the request carried no forwarded address (no client.ip): such failures
 * reach Elasticsearch through the platform hop, so their source.ip is a 100.64 address and they count there.
 * Severity high at ≥100 failures, not 50: at 50 a steady burst flipped medium↔high from run to run.
 */
const ADDR_INTERNAL = INTERNAL_NET.replace('client.ip', 'addr');
const FAILED_SIGNIN_BURST = nullSafe(
  `FROM ${IDX} | ${TIME_ONLY} | WHERE event.action IN (${SIGNIN_FAILED}) ` +
  `| STATS n = COUNT(*), first_ts = MIN(@timestamp), last_ts = MAX(@timestamp) BY ${IDENTITY_KEYS}, addr = COALESCE(client.ip, source.ip) ` +
  `| ${ACTOR_RESOLVE} | ${KIND_GROUPED} ` +
  `| EVAL hop = ${ADDR_INTERNAL}, burst_by = ["Client IP", "Identity"] | MV_EXPAND burst_by ` +
  `| EVAL burst_key = CASE(burst_by == "Client IP", TO_STRING(addr), actor IN (${PLATFORM_ACTORS}) OR actor IN (${UNAUTH_ACTORS}), null, actor) ` +
  '| WHERE burst_key IS NOT NULL ' +
  `| STATS failures = SUM(n), names_tried = COUNT_DISTINCT(actor) WHERE NOT actor IN (${UNAUTH_ACTORS}), hop_failures = SUM(n) WHERE hop, ` +
  'identities = VALUES(actor), identity_types = VALUES(identity_kind), client_ips = VALUES(addr), first_ts = MIN(first_ts), last_ts = MAX(last_ts) BY burst_by, burst_key ' +
  '| EVAL platform_hop = COALESCE(hop_failures, 0) > 0, severity = CASE(names_tried >= 5 OR failures >= 100, "high", "medium") ' +
  '| KEEP severity, burst_by, burst_key, failures, names_tried, identities, identity_types, client_ips, platform_hop, first_ts, last_ts');

const RUNBOOK_FAILED_SIGNIN_BURST = `**What it means.** Someone failed to sign in many times in 15 minutes. If the alert is by Client IP, one address failed again and again; five or more names tried from it points to password spraying. If it is by Identity, one name was tried again and again, from any number of addresses.

**Triage**
1. Read the alert: the address or name, the number of failures, the names tried and the time span.
2. Open **[Audit] 🔐 Identity & Access**, set the time to cover the alert, and pick the address in **Client IP** (or the name in **Identity**, with Identity type set to Failed sign-in). If the Client IP list does not offer the address, it is Elastic's own network hop: set Identity type to Failed sign-in instead.
3. Read **Top failed or denied access** for which names failed from where, then **Failed sign-ins and denied access** for the records one by one.
4. Open **[Audit] 🌍 Geo & Network**, pick the address in **Client IP** again (each page opens with Any), and read **Busiest client IPs** to see where the address is and how many identities use it.
5. Check whether anyone signed in successfully from that address or as that name around the same time. The "Successful sign-in after failed sign-ins" rule checks this for you. To check by hand, go back to Identity & Access with the address in **Client IP** and read **Identity first and last seen**: an identity other than a failed sign-in that was active there after the burst is the case to escalate.

**What is normal.** A person retrying an expired session or a mistyped key gives a few failures, not ten. A script or CI job with a revoked key can fail in bursts; the name tells you which one. An address in 100.64.0.0/10 is Elastic's own network hop, which carries many people's traffic, so look at the names tried rather than the address.`;

/* ---------------------------------------------------------------- rule 2: sign-in after failed sign-ins (UC-003) */

/**
 * Failures and successes are counted by IDENTITY_KEYS and client.ip, then MV_EXPAND makes two matches per row:
 * "same account" (the attempted user.name, platform and placeholder names dropped) and "same address" (a public
 * client.ip: the internal hop carries every SSO success and is never the attacker's address). INLINE STATS (GA
 * since 9.3) gives each match its failures, its first failure and its fifth (TOP keeps the five earliest failure
 * times of each row, and of the match), so signed_in lists only identities whose last sign-in came after five
 * failures: a success after one failure, with the rest after it, is not "failures, then a sign-in".
 */
const MIN_FAILURES = 5;
const SIGNIN_AFTER_FAILURES = nullSafe(`FROM ${IDX} | ${TIME_ONLY} ` +
  `| WHERE event.action IN (${SIGNIN_FAILED}, "authentication_success", "user_login") ` +
  `| STATS n = COUNT(*), first_ts = MIN(@timestamp), last_ts = MAX(@timestamp), early = TOP(@timestamp, ${MIN_FAILURES}, "asc") BY ${IDENTITY_KEYS}, client.ip ` +
  '| EVAL match = ["same account", "same address"] | MV_EXPAND match ' +
  `| EVAL match_value = CASE(match == "same account" AND NOT user.name IN (${PLATFORM_ACTORS}, ${UNAUTH_ACTORS}), user.name, match == "same address" AND NOT ${INTERNAL_NET}, TO_STRING(client.ip)) ` +
  '| WHERE match_value IS NOT NULL ' +
  `| INLINE STATS failures = SUM(n) WHERE failed_signin, first_fail = MIN(first_ts) WHERE failed_signin, fails = TOP(early, ${MIN_FAILURES}, "asc") WHERE failed_signin BY match, match_value ` +
  `| WHERE failures >= ${MIN_FAILURES} AND (failed_signin OR last_ts > MV_MAX(fails)) ` +
  `| ${ACTOR_RESOLVE} | ${KIND_GROUPED} ` +
  '| STATS failures = MAX(failures), first_fail = MAX(first_fail), last_success = MAX(last_ts) WHERE NOT failed_signin, ' +
  'failed_names = VALUES(actor) WHERE failed_signin, failed_from = VALUES(client.ip) WHERE failed_signin, signed_in = VALUES(actor) WHERE NOT failed_signin, ' +
  'signed_in_types = VALUES(identity_kind) WHERE NOT failed_signin, successes = SUM(n) WHERE NOT failed_signin BY match, match_value ' +
  '| WHERE last_success IS NOT NULL ' +
  '| EVAL severity = CASE(match == "same account", "high", "medium") ' +
  '| KEEP severity, match, match_value, failed_from, failed_names, signed_in, signed_in_types, failures, successes, first_fail, last_success');

const RUNBOOK_SIGNIN_AFTER_FAILURES = `**What it means.** Someone failed to sign in five or more times, and within 30 minutes a sign-in succeeded, either as the same account name or from the same public address. "Same account" means a guessed name got in: treat it as urgent. "Same address" means the address that was failing also had a successful sign-in. That is often your own office, VPN or shared network, where a script has a wrong password while everyone else signs in normally.

**Triage**
1. Open **[Audit] 🔐 Identity & Access** with the time range from the alert's first failure to its last success. Set **Client IP** to the address (for a same-account alert, to each address the failures came from).
2. In **Failed sign-ins and denied access** and **Top failed or denied access**, see which names were tried and how fast. Generic names (admin, elastic, root) or many different names point to guessing; one name failing again and again points to a stale password in a script.
3. Open **[Audit] 👤 Identity 360** and pick each identity that signed in, in the **Identity** dropdown. Check **Who this is — by identity and principal id**, **Busiest addresses they used** and **Where they connected from**: is this address normal for them?
4. On the same page, read **⚠️ What they changed — deletes first, then newest** and **What they read, by index family**. Anything after the sign-in that this identity does not usually do is the reason to act.
5. If the sign-in is not explained, revoke the API key or end the person's sessions, rotate the credential, and block the address.

**What is normal.** Your own offices, VPNs and automation hosts fire the "same address" form when a scheduled job keeps a wrong password while people sign in successfully. If the address is yours and the failed names belong to a known script, fix the script. Elastic's internal network addresses never count as the same address.`;

/* ---------------------------------------------------------------- rule 3: new API key or role change (UC-032/049/050) */

/** API-key and role writes (an allow-list): not the profile activations every SSO sign-in writes. */
const KEY_ROLE_ACTIONS =
  '"create_apikey","grant_apikey","change_apikey","change_apikeys","invalidate_apikeys",' +
  '"create_cross_cluster_apikey","change_cross_cluster_apikey",' +
  '"put_role","delete_role","put_role_mapping","delete_role_mapping","put_privileges","delete_privileges",' +
  '"create_service_token","delete_service_token",' +
  '"put_user","delete_user","change_password","change_disable_user","change_enable_user"';
/**
 * Keys Kibana makes for itself, the create-side twin of HOUSEKEEPING, guarded the same way so NOT never drops a row:
 * a create_apikey by a platform account, with no key name, whose payload says "managed":true. On the live stream
 * (30 days to 2026-10-26) that is exactly the 324 Task Manager keys ("TaskManager: workflow:run - …" and
 * "workflow:resume - …") and the one Fleet enrolment key, and no other create. Enabling an alerting_v2 rule writes
 * no create_apikey at all (it mints a Cloud API key, see RULE_RUNNER), so the pack does not fire this rule itself.
 */
const KIBANA_MANAGED_KEY =
  '(event.action IS NOT NULL AND event.action == "create_apikey" ' +
  `AND user.name IS NOT NULL AND user.name IN (${PLATFORM_ACTORS}) AND api_key.name IS NULL ` +
  `AND ${CHG} IS NOT NULL AND ${CHG} LIKE """*"managed":true*""")`;
/**
 * Why a change is high, per event, first match wins. RLIKE is a Lucene regex: a bare " opens a literal, so the
 * quotes are escaped. Not owned_by_authenticated_user:false: every invalidation carries it, including a caller
 * invalidating its own key a second after making it; it says how the request was scoped, not whose key it was.
 */
const KEY_ROLE_RISK =
  'EVAL reason = CASE(' +
  'event.action == "delete_role", "role deleted", ' +
  `${CHG} LIKE """*"run_as":["*""", "grants run_as", ` +
  `${CHG} RLIKE """.*\\"cluster\\":\\[[^\\]]*\\"all\\".*""", "grants cluster all", ` +
  `${CHG} RLIKE """.*\\"privileges\\":\\[[^\\]]*\\"all\\".*""", "grants all on indices or apps", ` +
  `event.action IN ("create_apikey","change_apikey","change_apikeys") AND ${CHG} LIKE """*"role_descriptors":[]*""", "key carries all its owner's rights", ` +
  'event.action == "invalidate_apikeys" AND MV_COUNT(target) >= 10, "10 or more keys invalidated at once", ' +
  'null)';
const API_KEY_KINDS = '("Elasticsearch API key","Unnamed API key","Cloud API key")';

const API_KEY_OR_ROLE_CHANGE = nullSafe(`FROM ${IDX} | ${TIME_ONLY} | ${PRIVILEGED} ` +
  `| WHERE event.action IN (${KEY_ROLE_ACTIONS}) AND NOT ${KIBANA_MANAGED_KEY} ` +
  `| ${TARGET} | EVAL target = SPLIT(target, ",") | ${KEY_ROLE_RISK} ` +
  '| STATS changes = COUNT(*), flagged = COUNT(*) WHERE reason IS NOT NULL, reasons = VALUES(reason), targets = VALUES(target), ' +
  `first_ts = MIN(@timestamp), last_ts = MAX(@timestamp) BY ${IDENTITY_KEYS}, event.action ` +
  `| ${ACTOR_RESOLVE} | ${KIND_GROUPED} ` +
  '| STATS changes = SUM(changes), flagged = SUM(flagged), reasons = VALUES(reasons), targets = VALUES(targets), first_ts = MIN(first_ts), last_ts = MAX(last_ts) BY actor, identity_kind, event.action ' +
  `| EVAL by_key = identity_kind IN ${API_KEY_KINDS} ` +
  '| EVAL severity = CASE(flagged > 0 OR by_key, "high", "medium"), ' +
  'reasons = CASE(NOT by_key, reasons, reasons IS NULL, "made by an API key", MV_APPEND(reasons, "made by an API key")), ' +
  'target_count = COALESCE(MV_COUNT(targets), 0), targets = MV_SLICE(targets, 0, 9) ' +
  '| KEEP severity, actor, identity_kind, event.action, changes, target_count, targets, reasons, first_ts, last_ts ' +
  '| SORT last_ts DESC');

const RUNBOOK_API_KEY_OR_ROLE_CHANGE = `**What it means.** An identity changed who can do what: it created, changed or invalidated an API key, or created, changed or deleted a role, role mapping, user or service token. There is one alert per identity and action. It stays open while that identity keeps making the change and closes about 15 minutes after the last one.

**High** when a role was deleted; a role or key grants run_as, or "all" on the cluster, on indices or on a Kibana application; a key was created with all of its owner's rights; 10 or more keys were invalidated at once; or the change was made by an API key rather than a person. The alert's reasons say which. Otherwise the alert is medium.

**Triage**
1. Read the alert: the identity, its type, the action, how many changes, the targets (key or role names, or the ids of invalidated keys) and the reasons.
2. Open **[Audit] 🚨 Security & Anomalies**, set the time to cover the alert, and paste the identity into the **Identity** dropdown exactly as the alert shows it.
3. In **🚨 Config changes**, find the identity and action. Latest target names the key or role.
4. In **Config-change event feed**, read the full change record: the privileges the role or key grants, its expiry, and which keys were invalidated.
5. Open **[Audit] 👤 Identity 360** for the identity. **Who this is — by identity and principal id** says what it is and who owns it.
6. For a new key, open **[Audit] 🔐 Identity & Access** and check **API key inventory**: has the key been used yet, from where, and on which indices?
7. If nobody expected the change, invalidate the key or restore the role, then rotate the credential that made it.

**What is normal.**
- Planned rotation: a new key created and an old one invalidated together, by your admin key or your automation.
- Deployment tooling creating short-lived keys or roles.
- On Serverless most changes are made by a Cloud API key, so "made by an API key" on its own is common. Read the other reasons first.

Already left out: the keys Kibana creates and cleans up for its own tasks and for Fleet, and the profile updates at each sign-in.`;

/* ---------------------------------------------------------------- rule 4: security change at an unusual hour (UC-129) */

/**
 * "An hour of day (UTC) this identity has not worked in its own last 30 days": the baseline is every event older
 * than 24 hours (any kind, so "worked" means any activity), the candidates are the security changes of the last
 * RECENT_MIN minutes, and everything between is dropped before the first STATS (the change test is pushed down,
 * which halved the CPU). An hour with no baseline event is unusual. Identities first seen less than
 * MIN_HISTORY_DAYS ago are left out: under a day old, every hour is new (rule 5 covers the first appearance).
 * RECENT_MIN is the 15-minute schedule plus a minute, so a change in a window's last seconds is not missed.
 * What counts as a change: PRIVILEGED (housekeeping out), less the profile writes every SSO sign-in makes, less
 * Elastic's own automation acting as itself (Task Manager's key grants). A deny-list, so actions not yet seen count.
 * Severity medium when every action is an API-key action, high when a role, role mapping, user, privilege or
 * token changed too.
 */
const RECENT_MIN = 16;
const MIN_HISTORY_DAYS = 7;
const PROFILE_ACTIONS = '"activate_user_profile","update_user_profile_data"';
const PLATFORM_SELF = `(user.name IS NOT NULL AND user.name IN (${PLATFORM_ACTORS}) AND api_key.name IS NULL)`;
const SECURITY_CHANGE = `${PRIVILEGED_TEST} AND (event.action IS NULL OR NOT event.action IN (${PROFILE_ACTIONS})) AND NOT ${PLATFORM_SELF}`;

const UNUSUAL_HOUR_SECURITY_CHANGE = nullSafe(`FROM ${IDX} | ${TIME_ONLY} ` +
  `| WHERE @timestamp <= ${END} - 24 hours OR (@timestamp > ${END} - ${RECENT_MIN} minutes AND ${SECURITY_CHANGE}) ` +
  `| EVAL recent = @timestamp > ${END} - 24 hours ` +
  '| STATS prior = COUNT(*) WHERE NOT recent, changes = COUNT(*) WHERE recent, first_ts = MIN(@timestamp), last_change = MAX(@timestamp) WHERE recent, ' +
  `actions = VALUES(event.action) WHERE recent BY ${IDENTITY_KEYS}, hr = DATE_TRUNC(1 hour, @timestamp) ` +
  `| ${ACTOR_RESOLVE} | ${KIND_GROUPED} ` +
  '| EVAL hour_utc = DATE_EXTRACT("hour_of_day", hr) ' +
  '| STATS prior = SUM(prior), changes = SUM(changes), first_ts = MIN(first_ts), last_change = MAX(last_change), actions = VALUES(actions) BY actor, identity_kind, hour_utc ' +
  '| STATS worked_hours = COUNT(*) WHERE prior > 0, first_seen = MIN(first_ts), changes = SUM(changes) WHERE prior == 0, actions = VALUES(actions) WHERE prior == 0, ' +
  'last_change = MAX(last_change) WHERE prior == 0, hour_utc = VALUES(hour_utc) WHERE prior == 0 AND changes > 0 BY actor, identity_kind ' +
  `| WHERE changes > 0 AND first_seen <= ${END} - ${MIN_HISTORY_DAYS} days ` +
  '| EVAL severity = CASE(TRIM(REPLACE(MV_CONCAT(actions, " "), "[a-z_]*apikeys?", "")) == "", "medium", "high") ' +
  '| KEEP severity, actor, identity_kind, hour_utc, changes, actions, worked_hours, last_change, first_seen');

const RUNBOOK_UNUSUAL_HOUR_SECURITY_CHANGE = `**What it means.** An identity changed API keys, roles or users at an hour of day (UTC) it has not worked in its last 30 days. "Worked" means any activity at all, not only changes, and the last 24 hours are not part of the comparison. The alert shows the identity, its type, the hour, the actions, how many hours of the day it normally works, and when it was first seen. Severity is high when the change is more than API keys (a role, role mapping, user or privilege), and medium for API keys only.

**Triage**
1. Open **[Audit] 👤 Identity 360**. In **Identity type** and **Identity**, pick the alert's values, then set the time to cover the change.
2. Compare **Working rhythm — by hour (UTC)** and **Is this normal for them? — hourly (UTC)**. Both always show the last 7 days and include the change itself. The alert compared the 30 days before the last 24 hours, so trust its count of the hours this identity normally works.
3. Check **Busiest addresses they used** and **Who this is — by identity and principal id** for an address or principal you do not recognise.
4. Open **[Audit] 🚨 Security & Anomalies** and read **Config-change event feed** for the full change record, including what a new key or role grants.
5. If the owner cannot explain it, invalidate the new keys, revert the role change, and review what the identity did next.

**What is normal.** Planned maintenance or a release outside normal hours, someone working late or from another time zone, an automation job moved to a new time, or a one-off key rotation. Confirm with the owner before closing.`;

/* ---------------------------------------------------------------- rule 5: new identity seen (UC-070) */

/**
 * No activity in the previous 30 days (the lookback), first event in the last hour before ?_tend. Failed sign-ins,
 * the realm's trace of them, and user_logout (it has no email, so it would make a second "Other" identity per
 * person) are dropped per event, and so are the Cloud API key requests the pack's own rules make (RULE_RUNNER). Platform and placeholder names are dropped after the
 * resolve: an Elasticsearch key owned by elastic/kibana must still be seen.
 * A new identity breaches four 15-minute runs, then recovers: one alert of about an hour.
 */
const FIRST_SEEN_IDENTITY = nullSafe(`FROM ${IDX} | ${TIME_ONLY} ` +
  `| WHERE ${REALM_TRACE} AND (event.action IS NULL OR NOT event.action IN (${SIGNIN_FAILED},"user_logout")) AND ${RULE_RUNNER} ` +
  `| STATS first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), events = COUNT(*), ipv = VALUES(client.ip), av = VALUES(event.action) BY ${IDENTITY_KEYS} ` +
  `| ${ACTOR_RESOLVE} | ${KIND_GROUPED} ` +
  '| STATS first_seen = MIN(first_seen), last_seen = MAX(last_seen), events = SUM(events), ipv = VALUES(ipv), av = VALUES(av) BY actor, identity_kind ' +
  `| WHERE first_seen > ${END} - 1 hour AND NOT actor IN (${PLATFORM_ACTORS},${UNAUTH_ACTORS}) ` +
  '| EVAL rare_kind = identity_kind IN ("Person","Cloud API key","Other") ' +
  '| EVAL severity = CASE(rare_kind, "medium", "low"), client_ips = MV_SLICE(ipv, 0, 9), actions = MV_SLICE(av, 0, 9) ' +
  '| KEEP severity, actor, identity_kind, first_seen, last_seen, events, client_ips, actions | SORT first_seen');

const RUNBOOK_FIRST_SEEN_IDENTITY = `**What it means.** An identity (a person signed in through Elastic Cloud, an API key, or an account) was active in this project and had done nothing here in the previous 30 days. Each identity alerts once, and the alert closes by itself about an hour later.

**Triage**
1. Open **[Audit] 🔐 Identity & Access**, set the time to the last 24 hours, and find the identity in **Identity first and last seen**. It lists every identity, newest first, whatever it did.
2. Open **[Audit] 👤 Identity 360** and set **Identity type** and **Identity** to the values in the alert. The alert names the identity exactly as the Identity list does.
3. Read **Who this is — by identity and principal id**, then **⚠️ What they changed — deletes first, then newest** and **What they read, by index family**.
4. Check **Where they connected from** and **Busiest addresses they used** for an address you do not recognise.
5. For an API key, go back to Identity & Access: **API key inventory** shows its owner. **Config-change event feed** on Security & Anomalies shows who created it.
6. Ask the owner to confirm. If nobody expected it, revoke the key or remove the person's access in Elastic Cloud.

**What is normal.** A new team member's first sign-in; a key that someone or a deployment tool has just created and used; a person back after more than 30 days away. Elasticsearch API keys, unnamed keys and service accounts alert as low; people, Cloud API keys and other accounts as medium.

Left out: the Cloud API keys Kibana makes to run alert rules, known by a marker on each of their requests. A new Cloud API key that copies that marker on every request is left out too.`;

/* ---------------------------------------------------------------- rule 6: audit events stopped arriving (UC-125) */

/**
 * One STATS with no BY, so one row even on an empty window, then one row per source. Elasticsearch writes a steady
 * trickle of background events (the longest gap in the stream's first 12 days was 14 minutes), so 30 silent minutes
 * means delivery stopped. Kibana can be idle for days, so it is judged by use instead: Elasticsearch requests made
 * through Kibana (user.domain cloud-saml-kibana) in the last 30 minutes, and no Kibana event. A Kibana that is down
 * entirely stops that traffic too, so only "up but not recording" is caught. last_event is null, and minutes_silent
 * the whole lookback (1440), when a source sent nothing in 24 hours.
 */
const AUDIT_EVENTS_STOPPED = `FROM ${IDX} | ${TIME_ONLY} ` +
  `| STATS es_last = MAX(@timestamp) WHERE ${cond(ESS)}, kb_last = MAX(@timestamp) WHERE ${cond(KIB)}, ` +
  `kb_use = COUNT(*) WHERE ${cond(ESS)} AND user.domain == "cloud-saml-kibana" AND @timestamp > ${END} - 30 minutes, ` +
  `kb_recent = COUNT(*) WHERE ${cond(KIB)} AND @timestamp > ${END} - 30 minutes ` +
  '| EVAL source = ["Elasticsearch", "Kibana"] | MV_EXPAND source ' +
  '| EVAL last_event = CASE(source == "Elasticsearch", es_last, kb_last), ' +
  `minutes_silent = DATE_DIFF("minute", COALESCE(last_event, TO_DATETIME(?_tstart)), ${END}), ` +
  'stopped = CASE(source == "Elasticsearch", minutes_silent >= 30, kb_use > 0 AND kb_recent == 0), severity = "high" ' +
  '| WHERE stopped ' +
  '| KEEP severity, source, last_event, minutes_silent';

const RUNBOOK_AUDIT_EVENTS_STOPPED = `**What it means.** Elasticsearch records a steady trickle of audit events even when nobody is working, so half an hour with none means delivery has stopped. For Kibana, it means people used Kibana in the last 30 minutes but Kibana recorded none of it.

**Triage**
1. Open **[Audit] 🎛️ Command Center**, set the time to the last 24 hours, and set **Project**, **Identity type**, **Identity** and **Client IP** to Any.
2. Read **Audit volume by source**. The gap in that source's bars is the time nothing was delivered; the alert's last event is where it starts.
3. In Elastic Cloud, open the project's Log delivery page and check that audit logs are still being sent to this project.
4. Read **Live signal feed** up to the start of the gap to see who was active just before it.
5. If logging was turned off on purpose, record who did it and why. If not, contact Elastic support.

**What is normal.** A short delivery delay closes the alert by itself at the next check, once events arrive. A Kibana that nobody is using never fires this alert.`;

/**
 * Each rule: slug (the id's last part), name, description (≤1024), runbook (Markdown), dashboard (a SUITE name the
 * alert links to), uc (use-case tags), schedule {every, lookback}, query (base), breach (segment or null),
 * grouping (output columns), and the defaults below unless a rule sets its own.
 *
 * state_transition pending count 0: an alert opens on the first breach. Without it a group's first breach is only
 * "pending" and turns active on the next run's breach, so a one-run alert (an unusual-hour change) would never open.
 */
export const RULES = [
  {
    slug: 'failed-signin-burst',
    name: '[Audit] Failed sign-in burst',
    description: 'Ten or more failed sign-ins in 15 minutes from one client IP or for one name, or five or more different names tried from one client IP. '
      + "Elastic's own platform accounts and unnamed attempts count toward the address but not toward a name. "
      + "Open Identity & Access, pick the alert's address in Client IP or its name in Identity, and read Top failed or denied access.",
    runbook: RUNBOOK_FAILED_SIGNIN_BURST,
    dashboard: '01-identity-access',
    uc: ['UC-002'],
    schedule: { every: '5m', lookback: '15m' },
    query: FAILED_SIGNIN_BURST,
    breach: 'WHERE failures >= 10 OR names_tried >= 5',
    grouping: ['burst_by', 'burst_key'],
  },
  {
    slug: 'signin-after-failures',
    name: '[Audit] Successful sign-in after failed sign-ins',
    description: 'Five or more failed sign-ins, then a successful sign-in within 30 minutes, for the same account name or from the same public address. '
      + "Elastic's internal network addresses never count as the same address. Kibana does not record failed sign-ins, so the failures are always Elasticsearch's, but the successful sign-in can be to Elasticsearch or to Kibana. "
      + 'Start on Identity & Access with the address in Client IP, then check each identity that signed in on Identity 360.',
    runbook: RUNBOOK_SIGNIN_AFTER_FAILURES,
    dashboard: '01-identity-access',
    uc: ['UC-003'],
    schedule: { every: '5m', lookback: '30m' },
    query: SIGNIN_AFTER_FAILURES,
    breach: null,
    grouping: ['match', 'match_value'],
  },
  {
    slug: 'api-key-or-role-change',
    name: '[Audit] New API key or role change',
    description: 'An API key was created, changed or invalidated, or a role, role mapping, user or service token was created, changed or deleted. '
      + 'The keys Kibana creates and cleans up for its own tasks are left out. '
      + 'Open Security & Anomalies and read Config changes; the Config-change event feed has the full change record.',
    runbook: RUNBOOK_API_KEY_OR_ROLE_CHANGE,
    dashboard: '04-security-anomalies',
    uc: ['UC-032', 'UC-049', 'UC-050'],
    schedule: { every: '5m', lookback: '15m' },
    query: API_KEY_OR_ROLE_CHANGE,
    breach: null,
    grouping: ['actor', 'event.action'],
  },
  {
    slug: 'unusual-hour-security-change',
    name: '[Audit] Security change at an unusual hour',
    description: 'An identity changed an API key, role or user at an hour of day (UTC) when it had no activity at all in its last 30 days, not counting the last 24 hours. '
      + "Identities first seen less than 7 days ago, Elastic's own automation and the profile updates at each sign-in are left out. "
      + 'Open Identity 360, pick the identity and read Working rhythm, then the Config-change event feed on Security & Anomalies.',
    runbook: RUNBOOK_UNUSUAL_HOUR_SECURITY_CHANGE,
    dashboard: '07-actor-360',
    uc: ['UC-129'],
    schedule: { every: '15m', lookback: '30d' },
    query: UNUSUAL_HOUR_SECURITY_CHANGE,
    breach: null,
    grouping: ['actor', 'identity_kind'],
  },
  {
    slug: 'first-seen-identity',
    name: '[Audit] New identity seen',
    description: 'A person, API key or account that had no activity in the previous 30 days was just active in this project. '
      + "Failed sign-ins, sign-outs, Elastic's own platform accounts and the keys Kibana makes to run alert rules are left out. "
      + 'Find it in Identity first and last seen on Identity & Access, then check what it did and where it connected from on Identity 360.',
    runbook: RUNBOOK_FIRST_SEEN_IDENTITY,
    dashboard: '01-identity-access',
    uc: ['UC-070'],
    schedule: { every: '15m', lookback: '30d' },
    query: FIRST_SEEN_IDENTITY,
    breach: null,
    grouping: ['actor', 'identity_kind'],
  },
  {
    slug: 'audit-events-stopped',
    name: '[Audit] Audit events stopped arriving',
    description: 'Elasticsearch sent no audit events for 30 minutes, or people used Kibana in the last 30 minutes but Kibana recorded none of it. '
      + 'An idle Kibana never fires this alert. A Kibana that is completely down looks idle, because its users\' traffic stops with it. '
      + 'Open Command Center and find the gap in Audit volume by source.',
    runbook: RUNBOOK_AUDIT_EVENTS_STOPPED,
    dashboard: '00-command-center',
    uc: ['UC-125'],
    schedule: { every: '5m', lookback: '24h' },
    query: AUDIT_EVENTS_STOPPED,
    breach: null,
    grouping: ['source'],
  },
].map((r) => ({ recovery: { strategy: 'no_breach' }, no_data: { strategy: 'ignore' }, state_transition: { pending: { count: 0 } }, ...r }));

/** Rule ids an earlier release deployed. --rules removes them (each read first); --clean rules does too. */
export const RETIRED_RULE_IDS = [];

/** A rule's deployed id, in the active AUDIT_ID_NS namespace. */
export const ruleId = (slug) => nsId(`cloud-audit-rule-${slug}`);

/** The query Kibana runs: base, then the breach segment (it joins them with a pipe). */
export const ruleQuery = (r) => (r.breach ? `${r.query} | ${r.breach}` : r.query);

/**
 * The alerting_v2 PUT body. No `enabled`: scripts/rules.mjs adds enabled:false on create only. No actions: the API
 * has none on a rule.
 */
export function rulePayload(r) {
  if (!SUITE.some((d) => d.name === r.dashboard)) throw new Error(`rule ${r.slug}: no suite dashboard named ${r.dashboard}`);
  return {
    kind: 'alert',
    metadata: {
      name: r.name,
      description: r.description,
      tags: [ruleTag(), ...r.uc],
      routing_tags: [routingTag()],
    },
    time_field: '@timestamp',
    schedule: { ...r.schedule },
    query: { base: r.query, ...(r.breach ? { breach: { segment: r.breach } } : {}) },
    recovery: r.recovery,
    no_data: r.no_data,
    ...(r.state_transition ? { state_transition: r.state_transition } : {}),
    grouping: { fields: [...r.grouping] },
    artifacts: [
      { id: 'dashboard', type: 'dashboard', data: { dashboard_id: dashId(r.dashboard) } },
      { id: 'runbook', type: 'runbook', data: { content: r.runbook } },
    ],
  };
}

/** For the lint: each rule's full query (base + breach) and its lookback. */
export const ruleQueries = () => RULES.map((r) => ({
  src: `rules/${r.slug}`, i: 0, q: ruleQuery(r), lookback: r.schedule.lookback, rule: true,
  // Kibana keys each alert on String(row[field] ?? ""): a grouping column the query does not return folds every
  // alert into one, silently. The lint fails on a missing column even when the query returns no rows.
  cols: ['severity', ...r.grouping],
}));

/** A duration as the API spells it (`15m`, `30d`) in milliseconds. */
export function durationMs(d) {
  const m = /^(\d+)(ms|s|m|h|d|w)$/.exec(d);
  if (!m) throw new Error(`not a duration: ${d}`);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
}
