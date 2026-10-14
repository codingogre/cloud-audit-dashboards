/**
 * ES|QL fragments and Kibana panel builders.
 *
 * Fragment rationale lives in esql/fragments.md. The panel shapes below were verified
 * empirically against Kibana 9.6 serverless — the Dashboards API accepts only
 * links / markdown / vis / discover_session panels, `breakdown_by` (not `breakdown`) is
 * the XY split key, partition charts use metrics[]+group_by[], and metric items take no
 * per-item colour.
 *
 * TIME BINDING is a property of the panel type, not a choice, and it decides what a panel can show:
 *
 *   Lens ES|QL (kpi/xy/table/pie)      always follows the time picker
 *   Vega, "%type%": "esql"             always follows it — omitting %timefield% does NOT opt out:
 *                                      Kibana looks the index's time field up and ANDs the range
 *   Vega, DSL (url.index + url.body)   follows it ONLY if %timefield% is set, so a DSL spec with an
 *                                      explicit @timestamp range and the %dashboard_context-*%
 *                                      placeholders keeps the control-bar filters AND its own window
 *
 * That last row is the only way a panel on a now-1h dashboard can show a 7-day baseline. It was read
 * from the 9.6 source (es_query_parser.ts / esql_query_parser.ts).
 *
 * QUERY SHAPE decides cost far more than window size on the audit stream. Measured on the 2.6M-event
 * perf replica (`./audit --perf`), alternating runs on a quiet cluster:
 *
 *   1. A CASE with two or more conditions never runs per document. It costs ~4µs per row it is
 *      evaluated on — whether or not it feeds a group-by, and nesting it as one-condition CASEs does
 *      not help — while each of its conditions alone, a one-condition CASE, COALESCE, boolean
 *      expressions, GROK and the whole NOISE negation cost next to nothing. Over 7 days,
 *      CASE(client.ip IS NULL, …, client.geo.country_iso_code IS NOT NULL, …, …) took 11.2s; either
 *      condition alone took 90ms. Every multi-branch fragment — RISK, BAND, VERB, OBJ_TYPE, ORG,
 *      SCOPE — is that shape.
 *   2. So count first, by the raw keyword fields the fragment reads, and derive afterwards:
 *      `STATS n = COUNT(*) BY <raw fields> | <fragment, unchanged> | STATS SUM(n) BY <derived>`
 *      (MIN/MAX a carried timestamp, COUNT_DISTINCT a carried key). The fragment text stays verbatim,
 *      so the drift check still pins it, and the output is identical: the CASE above went 11.2s →
 *      0.14s; the Command Center treemap 31s → 0.8s and the band charts 13s → 0.3s over 7 days.
 *      The CASE still costs per GROUPED row, so group on what it reads and nothing wider: RISK_KEYS
 *      groups a near-unique payload as a presence boolean. A multi-valued key (event.type on
 *      Elasticsearch events) is grouped as MV_CONCAT and restored with SPLIT, or a document would
 *      be counted once per value. A computed group key (the actor COALESCE) is cheap enough —
 *      183–195ms against 51–53ms for the raw email over 7 days — but only a raw field takes a pill.
 *   3. A row feed sorts straight after its filter. A Discover session that classifies rows (VERB,
 *      OBJ_TYPE) puts `SORT @timestamp DESC` (and any LIMIT) before the EVALs, so they run on the
 *      rows returned rather than on every row matched: searches/04 went 10.6s → 0.18s over 7 days.
 *   4. A panel that measures presence does not take the noise gate. access_granted is emitted
 *      for every authorised action — often several per request — and it IS a person's activity;
 *      gating it removes the thing the panel exists to show. (Not for speed: the null-guarded gate
 *      itself costs 45–56ms over 7 days. An earlier note blamed the negation for this file's slow
 *      queries; that was the multi-condition CASE of rule 1.)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, nsId, ROOT } from './env.mjs';

/** The audit stream, from config — one definition, so a rename is an .env change, not a code change. */
export const IDX = cfg.dataStream;

/**
 * Identity resolution, split from actor_kind because the Discover sessions need the first half and
 * not the second. Keeping it as its own constant is what lets the drift check assert that every
 * static ES|QL file resolves identity the same way — this is the fallback chain the whole suite
 * rests on (user.name is a numeric id, so it is the last resort, not the first).
 */
export const ACTOR_RESOLVE =
  'EVAL actor = COALESCE(attributes.user.email, attributes.api_key.name, attributes.user.name, "<anonymous>")';

/**
 * `actor_kind` here is the cheap first cut — "human" when the event carries an email, "service"
 * otherwise — because ACTOR runs per event and a CASE with two or more conditions must not (QUERY
 * SHAPE rule 1). That cut calls `<anonymous>` and Elastic's own service accounts "service" too; a
 * panel that SHOWS the kind groups by it and then applies KIND_REFINE to the grouped rows.
 */
export const ACTOR =
  `${ACTOR_RESOLVE}, actor_kind = CASE(attributes.user.email IS NOT NULL, "human", "service")`;

/**
 * Where an identity's traffic comes from, by the email on the event. Title case because these are
 * display values — a pie's slices and legend print them as they are — and they sit beside the
 * realm and credential-type labels, which are title case too. ORG reads only attributes.user.email,
 * so group by that first and apply ORG to the grouped rows.
 */
export const ORG =
  'EVAL actor_org = CASE(attributes.user.email IS NULL, "Machine", ' +
  'attributes.user.email LIKE "*@elastic.co", "Elastic", "Tenant")';

/**
 * attributes.authentication.type in words, as an EVAL assignment (`auth = CASE(…)`) so it can share an
 * EVAL with other columns: vega/02 embeds exactly this text, and the drift check pins it. Apply it
 * AFTER a STATS that groups on the raw field. "saml" is real on serverless (a SAML sign-in not yet
 * exchanged for a token). A type Elasticsearch has not documented falls through as its raw value.
 */
export const CRED_TYPE_LABEL =
  'auth = CASE(attributes.authentication.type == "api_key", "API key", ' +
  'attributes.authentication.type == "token", "Token", attributes.authentication.type == "realm", "Realm", ' +
  'attributes.authentication.type == "saml", "SAML", ' +
  'attributes.authentication.type == "anonymous", "Anonymous", attributes.authentication.type == "internal", "Internal", ' +
  'attributes.authentication.type)';

/**
 * How an identity authenticated, across both audit sources.
 *
 * attributes.authentication.type is an Elasticsearch-audit field: it is null on virtually every
 * Kibana event. attributes.user.domain IS populated there (cloud-saml-kibana), so the
 * COALESCE is what gives a credential dimension any fan-out on Kibana data — and it is the split
 * between a person in a browser (cloud-saml-kibana) and a script calling Kibana with a key
 * (_es_api_key), which no other field answers. It is derived, so never click-filter on it: a pill
 * on `credential` matches nothing.
 */
export const CRED =
  'EVAL credential = COALESCE(attributes.authentication.type, attributes.user.domain, "unknown")';

/**
 * What counts as a Kibana state change.
 *
 * Selected by ECS classification rather than by action-name suffix. The old suffix test (MUT,
 * kept below for the Elasticsearch half of searches/01) silently missed every mutation whose
 * action does not end in _create/_update/_delete — for example rule_enable, rule_disable, every
 * case_user_action_*, saved_object_update_objects_spaces, ml_open_ad_job, ml_start_ad_datafeed,
 * workflow_run, workflow_test and workflow_execution_cancel.
 *
 * Three things this predicate has to get right, each of them measured:
 *
 *   1. `attributes.event.type` is SINGLE-valued on every Kibana audit event checked, so IN is
 *      safe here without MV_EXPAND and cannot double-count. It is MULTI-valued on Elasticsearch
 *      events (access_granted carries ["access","allowed"]), and ES|QL returns null — not false —
 *      for IN on a multi-value operand, verified on live data. A null in WHERE drops the row
 *      and a null CASE condition falls through, so this predicate is fail-closed outside Kibana.
 *      The explicit service.name test makes that intent visible instead of accidental.
 *   2. Point-in-time is excluded BY NAME. Elasticsearch tags saved_object_open/close_point_in_time
 *      as creation/deletion, they are query internals, and they arrive in such volume that they
 *      would drown out every real change. The NOISE gate does not cover them — that gates the
 *      Elasticsearch *point_in_time transport action, not these Kibana event actions.
 *   3. Two genuine changes are ECS-tagged `access` and have to be added back by name:
 *      rule_run_soon ("User is running rule [...]") and secret_create. Without them they are lost.
 *
 * Null-guarded on event.action, per the rule the noise gate learned the hard way.
 */
const EXECUTIONS = '"workflow_run","workflow_test","workflow_execution_cancel"';

export const CHANGE_PRED =
  '(resource.attributes.service.name == "serverless-kibana" AND (' +
  '(attributes.event.type IN ("change","creation","deletion") ' +
  'AND (attributes.event.action IS NULL OR NOT (attributes.event.action IN (' +
  '"saved_object_open_point_in_time","saved_object_close_point_in_time")))) ' +
  'OR attributes.event.action IN ("rule_run_soon","secret_create")))';

export const CHANGE = `WHERE ${CHANGE_PRED}`;

/**
 * Recovers the changed object's identity from body.text when saved_object.* is absent.
 *
 * Kibana only populates attributes.kibana.saved_object.{id,type,name} on the saved-objects audit
 * path. Its newer feature-level events populate NONE of them — workflows, agent-builder agents and
 * tools, ML jobs and datafeeds, product documentation, secrets — and several others (connector_create,
 * case_*, space_create) carry a type but no name. body.text is never null on a Kibana event and
 * always names the thing, so it is the fallback.
 *
 * Each pattern below earns its place against a real message shape, all verified on live data
 * (the object names in the examples are illustrative):
 *
 *   \[(?:id|workflowId)=…(?:,|\])   [id=…], workflow_test's [workflowId=…], and agent-builder's
 *                                   [id=x, name="y"]. The (?:,|\]) terminator is what stops it
 *                                   swallowing the ", name=" blob into the id.
 *   \[name=%{GREEDYDATA}\]          [name=[Example] Rule with brackets]. GREEDYDATA, NOT DATA:
 *                                   DATA is non-greedy, stops at the first ], and yields
 *                                   "[Example".
 *   \[executionId=…\]               workflow_run / _test / _execution_cancel.
 *   case id: %{NOTSPACE}            case_user_action_*, which use no brackets at all.
 *   (?:job|datafeed) %{NOTSPACE}    ML prose — "Creating anomaly detection job my-anomaly-job-…".
 *
 * Patterns are ES|QL triple-quoted strings so a backslash is literal: the JS source needs \\[,
 * not \\\\[. GROK writes null into its own columns when it does not match and touches nothing
 * else, so the five stages compose safely.
 */
const G = (pat) => `GROK body.text """${pat}"""`;

export const OBJ_GROK = [
  G(String.raw`\[(?:id|workflowId)=%{DATA:g_id}(?:,|\])`),
  G(String.raw`\[name=%{GREEDYDATA:g_name}\]`),
  G(String.raw`\[executionId=%{DATA:g_exec}\]`),
  G(String.raw`case id: %{NOTSPACE:g_case}`),
  G(String.raw`(?:job|datafeed) %{NOTSPACE:g_ml}`),
].join(' | ');

/**
 * Kind of thing changed. Prefers the real saved-object type where Kibana records one, and derives
 * it from the action otherwise. The REPLACE at the bottom is the general case; the branches above
 * it are the feature names that would otherwise read as raw action strings.
 */
export const OBJ_TYPE =
  'EVAL obj_type = CASE(' +
  'attributes.kibana.saved_object.type IS NOT NULL, attributes.kibana.saved_object.type, ' +
  'attributes.event.action LIKE "ml_*ad_job", "ml-job", ' +
  'attributes.event.action LIKE "ml_*ad_datafeed", "ml-datafeed", ' +
  'attributes.event.action LIKE "workflow_execution_*", "workflow-execution", ' +
  'attributes.event.action LIKE "workflow_*", "workflow", ' +
  'attributes.event.action LIKE "agent_builder_agent_*", "agent-builder-agent", ' +
  'attributes.event.action LIKE "agent_builder_tool_*", "agent-builder-tool", ' +
  'attributes.event.action LIKE "product_documentation_*", "product-documentation", ' +
  'attributes.event.action == "secret_create", "secret", ' +
  // Fleet emits some events with NO event.action at all ("User deploying policy [id=...]",
  // "User creating enrollment API key [name=...]"). REPLACE on a null is null, which would put a
  // (null) bucket back on the heatmap and the object-type KPI — the exact thing this fragment
  // exists to remove. They are ECS-tagged `access`, so they never reach the change panels.
  'attributes.event.action IS NULL, "unclassified", ' +
  'REPLACE(attributes.event.action, "_(create|update|delete|enable|disable|run|run_soon|test|cancel)$", ""))';

/**
 * True when an event touched an object at all — the rows OBJ_TYPE names from a real type rather than
 * from its last-resort REPLACE of the action name (which turns http_request, user_login and the
 * point-in-time internals into "types"). Keep the families here in step with OBJ_TYPE's derived
 * branches above: a family added there and not here is silently dropped from anything that filters on
 * this. It references only raw fields, so it works on rows grouped by those fields, after a STATS.
 */
export const OBJ_PRESENT =
  '(attributes.kibana.saved_object.type IS NOT NULL OR attributes.event.action LIKE "ml_*" ' +
  'OR attributes.event.action LIKE "workflow_*" OR attributes.event.action LIKE "agent_builder_*" ' +
  'OR attributes.event.action LIKE "product_documentation_*" OR attributes.event.action == "secret_create")';

/**
 * Name of the thing changed. The ladder order is load-bearing: real name, then the name GROKed out
 * of the message, then the GROKed id, then the saved-object id, then the case id, the ML job and
 * the execution id, and finally the prose sentence itself. body.text last is what guarantees this
 * column is NEVER null — which is the whole point of the exercise.
 */
export const OBJ_NAME =
  'EVAL obj_name = COALESCE(attributes.kibana.saved_object.name, g_name, g_id, ' +
  'attributes.kibana.saved_object.id, g_case, g_ml, g_exec, body.text)';

/** The three together, ready to drop into a pipeline. */
export const OBJ = `${OBJ_GROK} | ${OBJ_TYPE} | ${OBJ_NAME}`;

/**
 * Light version for the KPIs, which need a distinct-object count over the FULL read volume
 * (every Kibana event in the window) rather than the few a change filter leaves. One GROK instead
 * of five; measured at 68–85ms over 24h on the perf replica.
 */
export const OBJ_ID =
  `${G(String.raw`\[(?:id|workflowId)=%{DATA:g_id}(?:,|\])`)} ` +
  '| EVAL obj_id = COALESCE(attributes.kibana.saved_object.id, g_id)';

/**
 * Kibana logs an ATTEMPT (outcome=unknown, "User is creating dashboard") on the saved-objects path
 * and a COMPLETION (outcome=success, "User updated workflow") on the newer feature path. A raw
 * "unknown" in a table reads as a defect, so it is relabelled to what it actually means.
 */
export const OUTCOME =
  'EVAL result = CASE(attributes.event.outcome == "unknown", "attempted", attributes.event.outcome)';

/**
 * Severity weights. Routine activity scores 0 on purpose: with a baseline of 1 the
 * "total risk" figure was just an event count wearing a hat (the two figures tracked each
 * other almost exactly).
 */
export const RISK_MAX = 50;

/**
 * ES|QL CASE is first-match-wins, so branch ORDER decides which weight an event actually gets.
 * The previous order tested the generic predicates first and made two documented weights dead
 * code: `invalidate_apikeys` always carries a security_config_change payload, so it scored 50
 * rather than 45, and `anonymous_access_denied` always carries outcome=failure, so it scored 40
 * rather than 35.
 *
 * Specific actions are therefore tested before the generic "was it a config change" and "did it
 * fail" branches. A FAILED mutation still scores 40 rather than 25/30 — a mutation that was
 * denied is the more interesting event, and that ordering is deliberate.
 *
 * The three CHANGE branches are ordered for the same reason:
 *
 *   - Executions are tested FIRST. `workflow_execution_cancel` is ECS-tagged `deletion`, so if
 *     the destructive branch came first a cancelled run would score 30 as though a workflow had
 *     been deleted.
 *   - Executions weigh 10, below authoring. They are the one class here with unbounded cadence:
 *     a scheduled workflow firing every minute at 25 would turn "total risk" back into an event
 *     count wearing a hat, which is the exact failure the RISK_MAX note above records fixing once.
 *     10 keeps them visible without letting frequency outrank severity.
 *   - Destructive changes weigh 30, deliberately BELOW anonymous denial (35) and failure (40), so
 *     the "a failed mutation is the more interesting event" ordering above still holds verbatim.
 *
 * Every change branch is gated on CHANGE_PRED — the same characters CHANGE uses — so the scorer
 * and the change panels can never disagree about what counts as a change.
 */
export const RISK =
  'EVAL risk = CASE(attributes.event.action == "invalidate_apikeys", 45, ' +
  'attributes.event.action == "anonymous_access_denied", 35, ' +
  'attributes.elasticsearch.audit.security_config_change IS NOT NULL, 50, ' +
  'attributes.event.outcome == "failure", 40, ' +
  `${CHANGE_PRED} AND attributes.event.action IN (${EXECUTIONS}), 10, ` +
  `${CHANGE_PRED} AND (attributes.event.type == "deletion" OR attributes.event.action == "rule_disable"), 30, ` +
  `${CHANGE_PRED}, 25, ` +
  '0)';

/**
 * Mean severity, on the same 0-50 scale as the weights themselves.
 *
 * This replaces a "normalised 0-100 index" that could not go below 50: it divided by the maximum
 * weight while the minimum non-zero weight was 25, so half the advertised range was unreachable,
 * and an identity whose scoring events all shared one weight could only read 100.0, 80.0 or 50.0.
 * A scale whose floor is half its span does not survive an analyst reading it. Mean severity is
 * the same information, stated on a scale the weights table explains directly.
 */
/**
 * STATS cannot divide two of its own aggregates, so the ratio is an EVAL afterwards. Weighted by `n`
 * because it runs over the grouped rows riskScored() leaves, not over documents (see RISK_KEYS).
 */
export const RISK_INDEX_STATS = `risk_total = SUM(risk * n), scoring_events = SUM(n)`;
export const RISK_INDEX_EVAL  =
  `EVAL mean_severity = ROUND(1.0 * risk_total / scoring_events, 1)`;

/**
 * Platform identities are Elastic's own automation, not tenant activity. Left unsplit they can
 * top the risk leaderboard: platform automation such as elastic.maintenance performs routine
 * security config changes, which carry the highest weight.
 */
export const PLATFORM_ACTORS =
  '"elastic.maintenance","autoscaling","elasticsearch-controller","elastic/fleet-server","elastic/kibana"';
/** Anything the cluster could not attribute to a principal. Not platform — nobody owns these. */
export const UNAUTH_ACTORS =
  '"<anonymous>","<unauthenticated-cloud-access-token>","<unauthenticated-saml-user>","<unauthenticated-cloud-api-key>"';
export const SCOPE =
  `EVAL actor_scope = CASE(actor IN (${PLATFORM_ACTORS}), "platform", ` +
  `actor IN (${UNAUTH_ACTORS}), "unauthenticated", "tenant")`;

/**
 * ACTOR's `actor_kind`, refined with SCOPE's vocabulary: an unattributed principal is
 * "unauthenticated" and Elastic's own automation (elastic/kibana included) is "platform", rather than
 * both reading "service". A three-way CASE, so it runs on grouped rows that carry `actor` and
 * `actor_kind` — after the STATS, never per event.
 */
export const KIND_REFINE =
  `EVAL actor_kind = CASE(actor IN (${UNAUTH_ACTORS}), "unauthenticated", actor IN (${PLATFORM_ACTORS}), "platform", actor_kind)`;

/**
 * Pushed ahead of the ACTOR/RISK EVALs so scoring runs over the few events that can score
 * instead of the whole window. Without it the leaderboard took 16s because COALESCE/CASE were
 * evaluated on every event before `WHERE risk > 0` pruned anything (re-measured on the perf replica:
 * 7.7–13.6s at 24h without it, 0.4s with it — it works by cutting the rows that reach RISK's CASE).
 *
 * This is the disjunction of the CASE conditions in RISK and must stay in sync with it. The
 * three change branches collapse to one clause here because they share CHANGE_PRED — the same
 * constant RISK embeds — so that half cannot drift. Only the branches above it are mirrored by
 * hand, and they are unchanged from the version that shipped.
 *
 * saved_object_create/update/delete dropped out of the explicit list because CHANGE_PRED now
 * subsumes them. Net selectivity is BETTER than before: this also stops evaluating the high-volume
 * point-in-time events that used to reach the CASE only to score 0.
 */
export const RISK_PREFILTER =
  'WHERE attributes.elasticsearch.audit.security_config_change IS NOT NULL ' +
  'OR attributes.event.outcome == "failure" ' +
  'OR attributes.event.action IN ("invalidate_apikeys","anonymous_access_denied") ' +
  `OR ${CHANGE_PRED}`;

/**
 * Every raw field RISK reads, as STATS keys, so a scoring panel counts first and scores the grouped
 * rows (QUERY SHAPE rules 1–2): `RISK_PREFILTER | STATS n = COUNT(*) BY …, RISK_KEYS | RISK_RESTORE |
 * RISK | WHERE risk > 0`, then every count downstream is SUM(n) and every severity SUM(risk * n).
 * Add a field here whenever RISK (or CHANGE_PRED inside it) starts reading one.
 *
 * Two fields are not grouped as they are, and RISK_RESTORE puts them back for RISK to read:
 *
 *   attributes.event.type is MULTI-valued on Elasticsearch events, and STATS BY a multi-valued field
 *   would count such a document once per value. It is grouped as one joined string and restored as
 *   the same multi-value, which keeps CHANGE_PRED's `IN` and `==` returning null on those rows exactly
 *   as on the raw field (no ECS event.type value contains a comma).
 *
 *   attributes.elasticsearch.audit.security_config_change is a JSON payload that is close to unique per
 *   event, and RISK only asks whether it is present. Grouping on the payload multiplied the rows that
 *   reach RISK sixfold (18,001 against 2,936 for the hourly risk chart over 7d on the perf replica), and
 *   a CASE costs per ROW after a STATS as well as before it. So it is grouped as the boolean `scc`, and
 *   restored as the placeholder "present" or null: after RISK_RESTORE that field answers IS NOT NULL
 *   correctly and nothing else — a panel that shows the payload must not read it from these rows.
 */
export const RISK_KEYS =
  'attributes.event.action, scc = attributes.elasticsearch.audit.security_config_change IS NOT NULL, ' +
  'attributes.event.outcome, resource.attributes.service.name, et = MV_CONCAT(attributes.event.type, ",")';
export const RISK_RESTORE =
  'EVAL attributes.event.type = SPLIT(et, ","), attributes.elasticsearch.audit.security_config_change = CASE(scc, "present")';

/**
 * The noise vocabulary, shared by NOISE and BAND so the gate and the bands can never disagree.
 *
 * `attributes.elasticsearch.audit.action` does not exist on Kibana audit events. The previous
 * gate was a bare `NOT (... IN ...)`, which is null for those rows — and `WHERE null` drops the
 * row, so the gate silently discarded 100% of Kibana audit: the small slice of the stream that
 * carries nearly all of the forensic value. Every predicate below is explicitly null-guarded.
 *
 * QUERY INTERNALS are the machinery every dashboard, Discover tab and API client runs to read data,
 * not something a person chose to do. With thousands of viewers they are the bulk of what is left
 * after the health pings, and before they were gated each viewer's own panel queries were the top
 * "signal" on Command Center. Measured on the 7-day replica: the gate keeps 377,070 of 2,625,300
 * events where the narrower one kept 1,539,450, at 70ms against 45ms for the whole gated count.
 *
 *   Elasticsearch   search phases, scroll, msearch, PIT and reader contexts; ES|QL and its
 *                   sub-requests (compute, data, search_shards, resolve_fields, async/get, and
 *                   indices:admin/esql/*); field_caps and its per-node fan-out; async_search; index
 *                   resolution; search_shards. A read of a system index is NOT lost: SYS_INDEX
 *                   selects on the index, not through this gate.
 *   Kibana          http_request to an /internal/ route (with or without the /s/<space> prefix) —
 *                   what the browser calls to draw a page: /internal/search/esql_async, feature
 *                   flags, controls options, session checks — and the content-management READS the
 *                   dashboard app makes to load and list objects (/api/content_management/rpc/get,
 *                   search, mget, bulkGet), each of which Kibana also audits as a saved_object_*
 *                   event. Every other public /api/ route stays signal, as does an rpc create,
 *                   update or delete. And saved_object_open/close_point_in_time: the saved-objects
 *                   client paging a find. And space_get / space_find: "User has accessed space", which
 *                   every Kibana page load emits for the active space — with the rest gated it was the
 *                   top "signal" action on Command Center. Creating, changing or deleting a space
 *                   stays signal.
 *   The suite       a read (get, resolve, find) of the suite's own saved objects — `cloud-audit-*`,
 *                   which covers every AUDIT_ID_NS namespace too. "User has accessed dashboard
 *                   [id=cloud-audit-…]" is the suite watching itself be watched, one per panel load
 *                   per viewer. A CHANGE to a suite object is not a read, and stays signal (and in
 *                   CHANGE_PRED, which this gate never touches): someone editing the audit dashboards
 *                   is exactly what an auditor wants to see. Who viewed them is still on 02's object
 *                   panels, which read all traffic.
 *
 * KIBANA_INTERNALS is evaluated only where event.action is known to be non-null (inside NOISE's
 * `IS NULL OR NOT (…)` and as a BAND_KEYS boolean), and the two fields it reads beyond the action are
 * each `IS NOT NULL AND …` — `false AND null` is false, so it never yields null and never drops a row.
 * url.original is a `wildcard` field: RLIKE on it measured the same as a LIKE (36ms vs 34ms, 7d) and is
 * exact where `LIKE "*\/internal/*"` also matched /api/internal/….
 */
const NOISE_ES_ACTIONS = '"cluster:monitor/main", "elastic.maintenance"';
const A_ = 'attributes.elasticsearch.audit.action';
const NOISE_ES_QUERY_INTERNALS =
  `${A_} LIKE "indices:data/read/search*" OR ${A_} LIKE "indices:data/read/msearch*" ` +
  `OR ${A_} LIKE "indices:data/read/scroll*" ` +
  `OR ${A_} LIKE "indices:data/read/*point_in_time" OR ${A_} == "indices:data/read/open_reader_context" ` +
  `OR ${A_} LIKE "indices:data/read/esql*" OR ${A_} LIKE "indices:admin/esql/*" ` +
  `OR ${A_} LIKE "indices:data/read/field_caps*" OR ${A_} LIKE "indices:data/read/async_search/*" ` +
  `OR ${A_} LIKE "indices:admin/resolve/*" OR ${A_} == "indices:admin/shards/search_shards"`;
const NOISE_EVENT_ACTIONS = '"authentication_success","connection_granted"';

export const KIBANA_INTERNALS =
  'attributes.event.action IN ("saved_object_open_point_in_time","saved_object_close_point_in_time","space_get","space_find") ' +
  'OR (attributes.event.action == "http_request" AND attributes.url.original IS NOT NULL ' +
  'AND attributes.url.original RLIKE "https?://[^/]+(/s/[^/]+)?/(internal/|api/content_management/rpc/(get|search|mget|bulkGet)).*") ' +
  'OR (attributes.event.action IN ("saved_object_get","saved_object_resolve","saved_object_find") ' +
  'AND attributes.kibana.saved_object.id IS NOT NULL AND attributes.kibana.saved_object.id LIKE "cloud-audit-*")';

export const NOISE =
  `WHERE (${A_} IS NULL OR NOT (` +
  `${A_} IN (${NOISE_ES_ACTIONS}) OR ${NOISE_ES_QUERY_INTERNALS})) ` +
  `AND (attributes.event.action IS NULL OR NOT (attributes.event.action IN (${NOISE_EVENT_ACTIONS}) OR ${KIBANA_INTERNALS}))`;

/**
 * The raw keys BAND reads, for `STATS n = COUNT(*) BY …, BAND_KEYS | BAND | STATS SUM(n) BY band`.
 * BAND is a multi-branch CASE, so it never runs per event (QUERY SHAPE rule 1). Two of the fields
 * KIBANA_INTERNALS reads are near-unique per event (a URL, a saved-object id), so they are grouped as
 * the one boolean `kib_internal` — the same trick RISK_KEYS plays with security_config_change — and
 * BAND reads that column. It is null where event.action is null, which BAND's CASE falls through.
 */
export const BAND_KEYS =
  `${A_}, attributes.event.action, kib_internal = (${KIBANA_INTERNALS})`;

/**
 * Band classification for the quarantine dashboard, over rows grouped BY BAND_KEYS. A CASE condition
 * that evaluates to null falls through rather than matching, so Kibana events land in "signal" unless
 * kib_internal says otherwise. "query-noise" is the reader's "Query internals" and covers the
 * Kibana and suite-self reads above as well as Elasticsearch's.
 */
export const BAND =
  `EVAL band = CASE(${A_} IN (${NOISE_ES_ACTIONS}), "infra-noise", ` +
  `${NOISE_ES_QUERY_INTERNALS}, "query-noise", ` +
  `kib_internal, "query-noise", ` +
  `attributes.event.action == "connection_granted", "query-noise", ` +
  `attributes.event.action == "authentication_success", "authn-volume", "signal")`;

/**
 * Location PER ADDRESS. Enrichment is forward-only (README, Geo enrichment), so one client IP can carry
 * both enriched events and older ones with no client.geo.* at all. Grouping BY client.ip AND the geo
 * fields then prints the same address twice — once placed, once "not placeable" — and a breakdown that
 * selects `client.geo.country_iso_code IS NULL` per event calls a resolvable public address "no geoip
 * match" (05 and 07, 24h on the live stream: 65.185.62.22 as Powell with 434,065 events and as
 * unplaceable with 391).
 *
 * So an IP table groups BY client.ip ONLY and takes these aggregates: the address's location from any
 * event that resolved, and `placed`, how many of its events did. `placed == 0` is the only honest
 * "cannot be placed"; `events - placed` on a placed address is events that predate enrichment (or the
 * seconds before the geoip database loaded), which a table may show but must not call unplaceable.
 * MAX over a keyword is lexicographic, so if an address ever resolved to two places the row shows one
 * of them; GeoLite2 does not move an address within a retention window in practice, and pairing the
 * two through CONCAT (so city and country come from one event) measured 484ms against 394ms at 7d.
 *
 *   STATS events = COUNT(*), ${IP_GEO} BY client.ip | …                       an IP table
 *   STATS events = COUNT(*), placed = COUNT(client.geo.country_iso_code) BY client.ip
 *     | WHERE placed == 0 | …                                                    why addresses do not resolve
 *
 * Measured on the 7-day replica: the IP footprint 306ms → 394ms; the unresolved breakdown 35ms → 81ms.
 */
export const IP_GEO =
  'country = MAX(client.geo.country_name), city = MAX(client.geo.city_name), placed = COUNT(client.geo.country_iso_code)';

export const TIME   = 'WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart';
export const BUCKET = 'BUCKET(@timestamp, 75, ?_tstart, ?_tend)';
export const KIB    = 'WHERE resource.attributes.service.name == "serverless-kibana"';
/** Elasticsearch's source name; `elasticsearch-serverless` before the 2026 schema change. */
export const ESS    = 'WHERE resource.attributes.service.name == "serverless-elasticsearch"';

/**
 * Folds dated daily indices and data-stream backing indices into the family they belong to, so
 * `.ds-logs-x-2026.10.14-000001` and `logs-x` are one row and seven `.slo-…-2026-10-0N` days are one.
 * One definition for 03 and 07, so "index family" means one thing in the suite; vega/04 embeds the
 * same text and the drift check pins it.
 */
export const indexFamily = (col) => String.raw`REPLACE(REPLACE(${col}, """^\.ds-""", ""), """[-.]?\d{4}[.-]\d{2}[.-]\d{2}(-\d+)?$""", "")`;
export const INDEX_FAMILY = indexFamily('attributes.elasticsearch.audit.indices');

/**
 * Index EXPRESSIONS, not indices: `*`, `-*`, `syn-*` and date math like `<.slo-…{2026-10-14||/d}>`.
 * Elasticsearch records the expression as the client wrote it, and the concrete indices it resolved
 * to appear on the shard-level events beside it, so counting both double-counts and lists a pattern
 * as if it were something you could open. Applied to grouped rows, so it costs nothing per document.
 * vega/04 embeds it verbatim.
 */
export const CONCRETE = 'WHERE LOCATE(attributes.elasticsearch.audit.indices, "*") == 0 AND NOT attributes.elasticsearch.audit.indices LIKE "<*"';

/**
 * A request to a system or hidden index. Two corrections to the bare `LIKE ".*"` this used to be:
 *
 *   .ds-*      A data stream's backing index starts with a dot whatever the stream is, so
 *              `.ds-logs-…` (the audit stream itself, read by these very dashboards) counted as a
 *              system index and filled the top of the ⚠️ table with false positives. It is ordinary
 *              data. A backing index of a DOT-named stream (`.ds-.alerts-…`) is still system data, so
 *              it stays in — which is where this deliberately differs from 07's blanket `.ds-*`.
 *   *[*        Shard- and node-level fan-out (`search[phase/query]`, `search[can_match][n]`,
 *              `field_caps[n]`, `bulk[s][p]`). Each repeats a top-level request that is itself
 *              audited with the same index, so it multiplied one read into five rows. NOT the noise
 *              gate: NOISE also drops the top-level `indices:data/read/search`, and a real search of
 *              .security is exactly what this view exists to show.
 *
 * Null-guarded on the action, per the noise-gate lesson. Applied after MV_EXPAND, per index value.
 * searches/05-system-index-access.json embeds the same text, and the drift check pins it.
 */
export const SYS_INDEX =
  'WHERE ((attributes.elasticsearch.audit.indices LIKE ".*" AND NOT attributes.elasticsearch.audit.indices LIKE ".ds-*") ' +
  'OR attributes.elasticsearch.audit.indices LIKE ".ds-.*") ' +
  'AND (attributes.elasticsearch.audit.action IS NULL OR NOT attributes.elasticsearch.audit.action LIKE "*[*")';

/**
 * Action -> verb. Shared by the change panels, 02's object/verb heatmap and the Discover sessions,
 * so the READ verbs have to survive alongside the write ones.
 *
 * First-match-wins, so the order is the specification. Executions and the enable/disable pair go
 * above the generic tests; `*_create*` and `*_update*` are wildcarded on BOTH sides because the
 * newer action names bury the verb in the middle — case_user_action_update_case_status and
 * saved_object_update_objects_spaces both read "other" under a suffix-only test. ML uses its own
 * vocabulary (put/open/start) and needs naming explicitly or every ML action reads "other" too.
 */
export const VERB =
  'EVAL verb = CASE(attributes.event.action LIKE "*_execution_cancel", "cancel", ' +
  'attributes.event.action LIKE "*_run_soon", "run", attributes.event.action LIKE "*_run", "run", ' +
  'attributes.event.action LIKE "*_test", "test", ' +
  'attributes.event.action LIKE "*_enable", "enable", attributes.event.action LIKE "*_disable", "disable", ' +
  'attributes.event.action LIKE "ml_put_*", "create", attributes.event.action LIKE "ml_open_*", "open", ' +
  'attributes.event.action LIKE "ml_start_*", "start", ' +
  'attributes.event.action LIKE "*point_in_time", "pit", ' +
  'attributes.event.action LIKE "*_create*", "create", ' +
  'attributes.event.action LIKE "*_update*", "update", attributes.event.action LIKE "*_delete", "delete", ' +
  'attributes.event.action LIKE "*_find", "find", attributes.event.action LIKE "*_get", "get", ' +
  'attributes.event.action LIKE "*_resolve", "resolve", "other")';

/**
 * The old suffix-based mutation test. SUPERSEDED by CHANGE for everything Kibana emits — it misses
 * rule_enable/disable, the case_user_action_* family and every workflow/ML/agent-builder action.
 *
 * Deliberately kept, and used in exactly one place: the Elasticsearch half of
 * searches/01-all-mutations, where CHANGE cannot reach. CHANGE is gated on
 * service.name == "serverless-kibana" and ES event.type is multi-valued (so IN returns null there),
 * which means CHANGE alone would empty that search of its Elasticsearch rows.
 */
export const MUT =
  'WHERE attributes.event.action LIKE "*_create" OR attributes.event.action LIKE "*_update" ' +
  'OR attributes.event.action LIKE "*_delete"';;

export const DASH = [
  ['cloud-audit-00-command-center',     '\u{1F39B}️  Command Center'],
  ['cloud-audit-01-identity-access',    '\u{1F510}  Identity & Access'],
  ['cloud-audit-02-kibana-objects',     '\u{1F5C2}️  Kibana Object Forensics'],
  ['cloud-audit-03-data-access',        '\u{1F50E}  Elasticsearch Data Access'],
  ['cloud-audit-04-security-anomalies', '\u{1F6A8}  Security & Anomalies'],
  ['cloud-audit-05-geo-network',        '\u{1F30D}  Geo & Network'],
  ['cloud-audit-06-platform-volume',    '\u{1F4CA}  Platform Volume'],
  ['cloud-audit-07-actor-360',          '\u{1F464}  Actor 360'],
];

let seq = 0;
export const resetIds = () => { seq = 0; };
const nid = (p) => `${p}-${String(++seq).padStart(2, '0')}`;

/**
 * A metric tile. `secondary` names a second column shown beneath the number — the metric chart has
 * no trendline and no value-based colour, so the secondary is where a tile gets its context: a
 * qualifying clause, a worst case, a freshness reading. It may be a keyword column built with CONCAT.
 */
export const kpi = (x, y, w, h, q, col, desc, { fmt = 'number', dec = 0, secondary } = {}) => ({
  type: 'vis', id: nid('kpi'), grid: { x, y, w, h },
  config: {
    title: '', description: desc, type: 'metric',
    data_source: { type: 'esql', query: q },
    metrics: [{ type: 'primary', column: col, format: { type: fmt, decimals: dec } },
      ...(secondary ? [{ type: 'secondary', column: secondary }] : [])],
  },
});

/**
 * The categorical palette for every Lens breakdown, and the order a Vega spec should draw categories
 * in so the two agree. Kibana's `default` palette pairs each hue with a pale tint (#16C5C0 then
 * #A6EDEA), so a two-series chart reads as one teal and its tint is about 1.4:1 on white — the
 * second series all but disappears in light theme. `eui_amsterdam` is ten distinct mid-tone hues,
 * each readable on both backgrounds; it was compared side by side against default,
 * eui_amsterdam_color_blind, kibana_v7_legacy, elastic_brand_2023 and neutral in both themes.
 */
export const PALETTE_ID = 'eui_amsterdam';
export const PALETTE = ['#54B399', '#6092C0', '#D36086', '#9170B8', '#CA8EAE', '#D6BF57', '#B9A888', '#DA8B45', '#AA6556', '#E7664C'];

/** A pinned colour mapping for a breakdown or slice dimension, in the shape xy() and pie() both emit. */
const colorMapping = (colors) => ({ mode: 'categorical', palette: PALETTE_ID,
  mapping: Object.entries(colors || {}).map(([v, hex]) => ({ values: [v], color: { type: 'color_code', value: hex } })) });

/**
 * One colour per CRED_TYPE_LABEL value, for any chart that breaks down by credential type. EVERY
 * value the CASE can produce is pinned: an unpinned value takes the palette from its start, and
 * PALETTE[0] is already API key's — unpinned, "SAML" (one event in 30 days) drew as a second green
 * line indistinguishable from API key. Only a type Elasticsearch has not documented can still collide.
 */
export const CRED_TYPE_COLORS = {
  'API key': PALETTE[0], Token: PALETTE[1], Realm: PALETTE[2], SAML: PALETTE[3], Anonymous: PALETTE[5], Internal: PALETTE[7],
};

/**
 * The two audit sources by name, for any panel that splits by resource.attributes.service.name. Apply
 * after a STATS grouped on `source = resource.attributes.service.name`: "serverless-" spends eleven
 * characters of every legend entry saying what the whole suite assumes. Pinned so Elasticsearch and
 * Kibana are the same colours on Command Center and Platform Volume, and SORTed because Lens takes stack
 * and legend order from row order: unsorted, the two swapped places between refreshes. Elasticsearch
 * first puts the bulk on the baseline.
 */
export const SOURCE_LABEL =
  'EVAL source = CASE(source == "serverless-elasticsearch", "Elasticsearch", source == "serverless-kibana", "Kibana", source) ' +
  '| SORT source';
export const SOURCE_COLORS = { Elasticsearch: PALETTE[3], Kibana: PALETTE[2] };

/**
 * Legend placement, verified against the 9.6 Dashboards API (`config.legend`) and rendered:
 *
 *   bottom  one row under the plot (`layout: list`). Costs ~25px of height and none of the width,
 *           so it is the default — but a list does not wrap, so past ~6 series the tail is
 *           CLIPPED at the panel edge. A breakdown with more values than that wants 'right', or a
 *           query that folds the tail into "other" (which also keeps colours from repeating: the
 *           palette has ten).
 *   right   one entry per line beside the plot. Takes ~140px of width and truncates long names.
 *   hidden  the API default, and what a chart with no breakdown gets: one series needs no key.
 *
 * Without this every breakdown chart in the suite rendered as unlabelled colour, because the API
 * default is `hidden` whether or not there is a split.
 */
const LEGEND = {
  bottom: { visibility: 'visible', position: 'bottom', layout: { type: 'list' } },
  right:  { visibility: 'visible', position: 'right' },
  hidden: { visibility: 'hidden' },
};

/**
 * `legend`  'bottom' | 'right' | 'hidden'; defaults to 'bottom' when there is a breakdown.
 * `colors`  { value: '#hex' } pins a breakdown value to a colour, so the same category is the same
 *           colour on every chart that shows it (e.g. the four BAND values on Lens and on Vega).
 *           Unpinned values take PALETTE from its START, not from after the pinned ones — so an
 *           unpinned value can land on a colour a pinned one already holds. Pin every value the
 *           query can produce (CRED_TYPE_COLORS does), or pin none.
 * `values`  true asks Lens to print each bar's value. Lens prints a label only where it fits INSIDE
 *           the bar, so the long thin tail of a ranked bar() stays unlabelled (hover for it); it labels
 *           the leaders, nothing more.
 * `yScale`  'log' for a line chart whose series differ by orders of magnitude (credential types: API
 *           keys carry ~99.6% of requests), so a minor series is as readable as the bulk.
 * `yTitle`  a y-axis title, for a measure the panel title does not already name ("Summed severity").
 *           Hidden by default: on a count it repeats the title.
 *
 * SERIES ORDER. Lens draws breakdown series — stack order and legend order — in the order rows
 * arrive, and an unsorted STATS returns them in whatever order the shards finished, so a stack
 * reshuffles between refreshes. A breakdown query ends with a SORT on the breakdown column (or an
 * explicit order column, as 06's bands do); it runs over the aggregated rows and costs nothing.
 */
export const xy = (x, y, w, h, title, q, ycol, desc,
  { kind = 'bar_stacked', breakdown, xcol, label = '@timestamp', temporal = true, legend, colors, values = false, yScale, yTitle } = {}) => {
  const layer = {
    type: kind, data_source: { type: 'esql', query: q },
    x: { column: xcol || BUCKET, label }, y: [{ column: ycol }],
  };
  if (breakdown) layer.breakdown_by = { column: breakdown, color: colorMapping(colors) };
  const axis = { x: { title: { visible: false } }, y: { title: yTitle ? { visible: true, text: yTitle } : { visible: false } } };
  if (yScale) axis.y.scale = yScale;
  if (temporal) Object.assign(axis.x, { scale: 'temporal', domain: { type: 'fit', rounding: false } });
  const config = { title, description: desc, type: 'xy', axis, layers: [layer],
    legend: LEGEND[legend || (breakdown ? 'bottom' : 'hidden')] };
  if (!config.legend) throw new Error(`xy "${title}": legend must be one of ${Object.keys(LEGEND).join(', ')}`);
  if (values) config.styling = { bars: { data_labels: { visible: true } } };
  return { type: 'vis', id: nid('xy'), grid: { x, y, w, h }, config };
};

/** A categorical horizontal bar chart: `cat` down the side, `val` along. The non-temporal xy path. */
export const bar = (x, y, w, h, title, q, cat, val, desc, opts = {}) =>
  xy(x, y, w, h, title, q, val, desc, { kind: 'bar_horizontal', xcol: cat, label: cat, temporal: false, ...opts });

/**
 * Rows accept either a column name or an object, so a column can opt into `click_filter` or a
 * fixed `width` (see filterable() and sized() below).
 *
 * Clicking such a cell emits a dashboard filter pill, and the 9.6 `esql` expression function
 * compiles pills through buildEsQuery into the ES `filter` parameter — Kibana materialises
 * `ignoreGlobalFilters: false` (camelCase) on each Lens ES|QL layer itself, so it is never
 * emitted here, and the nav bar's dashboardLinks carry `use_filters: true`, so the pill follows
 * the analyst across every dashboard in the suite.
 *
 * Only ever set it on a REAL field. `actor` is an EVAL COALESCE with nothing behind it in
 * _source, so a pill built from it matches nothing; identity filtering hangs off
 * attributes.user.email, which is `flattened` and answers term/match_phrase correctly
 * (verified: filter and native WHERE return the same count for the same identity).
 */
/**
 * HEADERS AND WIDTHS. A column's header is its `label`, which the 9.6 Dashboards API accepts on
 * every row and metric and stores as the Lens column's customLabel. It changes the header ONLY:
 * the column still reads `fieldName`, so a click_filter column labelled "Email" still pins
 * `attributes.user.email: …` — verified by clicking a labelled cell on a live dashboard. That is
 * why labels are applied here rather than by aliasing in ES|QL: an alias would cost the filter.
 *
 * So the convention is: name ES|QL columns for the query (snake_case, raw fields), and let table()
 * title them. COLUMNS holds the suite's vocabulary — one place, so "Identity" means the same
 * thing on every dashboard — and anything it does not list is humanised by label() below, so a
 * raw dotted name or a snake_case alias can no longer reach a header. An explicit `label` on a
 * column wins.
 *
 * `width` is a ROLE, not a per-panel number. Lens splits the panel evenly between unsized
 * columns, so on a six-column table a 3-digit count got the same ~150px as the identity it
 * belonged to, and a timestamp got too little to finish its minutes ("Oct 14, 2026 @ 10:2").
 * Fixing the width of every column whose content has a known length (dates, counts, IPs, short
 * enums) leaves the text columns to share whatever is left — which is the only way the column a
 * reader came for stops clipping. Lens does not ellipsise a clipped cell (it hard-cuts the
 * glyphs, at every density and row-height setting — checked), so a clipped value is
 * indistinguishable from a short one; width is the only remedy short of wrapping.
 *
 * Widths are for the compact density table() sets below. DATE fits Kibana's full default date
 * format, "Oct 14, 2026 @ 11:28:36.286", with nothing cut. Deliberately not DATE_FORMAT in ES|QL to
 * save width: that renders UTC as a string, while every Lens and Discover timestamp beside it is
 * in the browser's zone, and the column stops sorting as a date.
 *
 * Each role also has a FLOOR, the narrowest it can go and still hold its content; see fitWidths().
 * SCOPE is its own role because "unauthenticated", the longest Scope value and the one that matters,
 * exactly filled ENUM's 105px and ran into the next column with no gap (rendered on 04).
 */
const W = { DATE: 190, COUNT: 90, IP: 125, ENUM: 105, SCOPE: 120 };
const FLOOR = new Map([[W.DATE, 190], [W.COUNT, 72], [W.IP, 118], [W.ENUM, 92], [W.SCOPE, 120]]);
const C = (label, width) => (width ? { label, width, min: FLOOR.get(width) } : { label });

export const COLUMNS = {
  // who
  actor: C('Identity'), actor_kind: C('Kind', W.ENUM), actor_scope: C('Scope', W.SCOPE), actor_org: C('Origin', W.ENUM),
  'attributes.user.email': C('Email'), 'attributes.user.name': C('User'), user: C('User'), owner: C('Owner'),
  api_key: C('API key'), 'attributes.api_key.name': C('API key'), key_id: C('Key ID'), 'attributes.api_key.id': C('Key ID'),
  credential: C('Credential', W.ENUM),
  // what
  action: C('Action'), 'attributes.event.action': C('Action'), 'attributes.elasticsearch.audit.action': C('Transport action'),
  verb: C('Operation', W.ENUM), result: C('Result', W.ENUM), 'attributes.event.outcome': C('Outcome', W.ENUM),
  change: C('Change'), request: C('Request'), execution: C('Execution', W.ENUM), weight: C('Weight', W.COUNT),
  // on what
  name: C('Name'), type: C('Type'), obj_name: C('Object'), obj_type: C('Object type'), kind: C('Kind'),
  index: C('Index'), 'attributes.elasticsearch.audit.indices': C('Index'),
  space: C('Space', W.ENUM), 'attributes.kibana.space.id': C('Space', W.ENUM),
  'attributes.kibana.saved_object.name': C('Object'), 'attributes.kibana.saved_object.type': C('Object type'),
  source: C('Source'), 'resource.attributes.service.name': C('Source'),
  // from where
  ip: C('IP', W.IP), client_ip: C('Client IP', W.IP), 'client.ip': C('Client IP', W.IP), proxy: C('Proxy IP', W.IP),
  city: C('City'), country: C('Country', W.ENUM),
  // when
  first_seen: C('First seen', W.DATE), last_seen: C('Last seen', W.DATE), last_change: C('Last change', W.DATE),
  '@timestamp': C('Time', W.DATE),
  // how much
  events: C('Events', W.COUNT), actions: C('Actions', W.COUNT), actors: C('Identities', W.COUNT),
  addresses: C('Addresses', W.COUNT), cities: C('Cities', W.COUNT), countries: C('Countries', W.COUNT),
  ips: C('IPs', W.COUNT), indices: C('Indices', W.COUNT), keys: C('API keys', W.COUNT),
  privileged: C('Privileged', W.COUNT), severity: C('Severity', W.COUNT), risk_total: C('Risk total', W.COUNT),
  mean_severity: C('Mean severity', W.COUNT), scoring_events: C('Scoring events', W.COUNT),
};

/** Words humanise() must not sentence-case. */
const ACRONYMS = { ip: 'IP', ips: 'IPs', id: 'ID', api: 'API', url: 'URL', os: 'OS', ecs: 'ECS', iso: 'ISO', esql: 'ES|QL' };

/**
 * The header for a column COLUMNS does not list. A dotted field keeps only its last segment
 * (`attributes.kibana.saved_object.type` → "Type"); snake_case becomes words; the first word is
 * capitalised. A name that already looks like a header (`Last seen`, an ES|QL backtick alias) is
 * returned as written.
 */
export const humanise = (column) => {
  if (/[A-Z ]/.test(column) && !column.includes('.')) return column;
  const words = column.split('.').pop().split(/[_\s]+/).filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] || w.toLowerCase());
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Header text for a column: COLUMNS first, then humanise(). */
export const label = (column) => COLUMNS[column]?.label || humanise(column);

/**
 * ROWS THAT FIT. A Lens table gives no cue that rows continue below the panel edge — no scrollbar
 * until hovered, no "N more" — so a LIMIT larger than the visible rows hides rows from anyone
 * reading the dashboard rather than using it, and the last visible row is usually sliced in half.
 *
 * Measured on rendered panels at the compact density table() sets: a grid unit is 20px plus an 8px
 * gutter, the panel title takes ~33px, the header ~26px, and a single-line row is 24px. The 76 is
 * those fixed costs plus a margin that keeps the last row whole when a horizontal scrollbar
 * appears. h=12 → 10 rows, h=14 → 13, h=8 → 6.
 */
export const fitRows = (h) => Math.max(1, Math.floor((28 * h - 76) / 24));

/**
 * The table's density and row height. Compact (12px, 24px rows) rather than Lens' default (14px,
 * 36px rows): it fits ~50% more rows and ~15% more characters per pixel of width, which is what
 * every crowded and truncated table finding came down to, and it matches Discover's grid beside it.
 * One line per row so a row's height is fixed and fitRows() is exact; `wrap` trades that for
 * auto-height rows, for a column whose whole value is the point (a security_config_change payload).
 */
const DENSITY = { mode: 'compact', height: { value: { type: 'custom', lines: 1 } } };
const DENSITY_WRAP = { mode: 'compact', height: { value: { type: 'auto' } } };

/**
 * The finished column: suite label and role width, overridden by anything the call site set.
 * Applied to metrics as well as rows — the API carries `width` on both (verified by export) — which
 * is what lets a date that is an aggregate (`last_seen = MAX(@timestamp)`) stop clipping.
 */
const column = (c) => {
  const spec = typeof c === 'string' ? { column: c } : c;
  const { label: lbl, width, min } = COLUMNS[spec.column] || {};
  // A role's floor goes with the role's width; a call site that sets its own width gets the default floor.
  return { label: lbl || humanise(spec.column), ...(width ? { width, min } : {}), ...spec, ...(spec.width ? { min: spec.min } : {}) };
};

/**
 * `scroll` keeps the authored LIMIT even when it exceeds the visible rows — for a feed whose title
 * promises a count ("the 30 most recent"), where scrolling is the point. Otherwise a trailing
 * `| LIMIT n` is lowered to fitRows(h), so the query never fetches rows nobody can see. Only ever
 * lowered: a LIMIT already within the panel is left alone. `wrap` implies scroll, since auto-height
 * rows make the count unknowable.
 */
/**
 * NARROW VIEWPORTS. A Lens column width is absolute pixels, the same at every viewport, while the
 * panel is a share of the screen. Widths sized at 1920px add up to more than the panel at 1440px —
 * 04's first-appearance table left its Identity column 43px, and 05's locations table pushed its last
 * column out of view behind a horizontal scrollbar (both rendered). So table() budgets every table for
 * a 1440px viewport: when the fixed widths plus FLEX_MIN for each flexing column exceed the panel's
 * grid width there, the fixed columns give up the difference, each in proportion to how far it sits
 * above its floor. A date never shrinks (a cut timestamp is unreadable); a count stops at 72px
 * ("720,418" with its header), an IP at 118px; a sized() text column at 70% of what it asked for, or
 * its own `min` where a value is known to need more (an email, "Elasticsearch").
 *
 * Measured on a rendered dashboard: at a 1440px viewport the 48-column grid is 1316px wide with 8px
 * gutters, and a table's data grid is its panel less 16px, so a w-column table has w × 1324/48 − 24px.
 * Tables that fit at 1440 are untouched; the ones that do not get the same widths at 1920 too (Lens
 * has no relative width), where the space they gave up goes to the text columns that were clipping.
 * When even the floors do not fit, the text columns are what clips — fewer columns is then the fix.
 */
const GRID_PX_1440 = 1324;
const FLEX_MIN = 150; // an email or an action name; below ~120px (0.8×) a text column is unreadable
export const gridPx = (w) => Math.floor(w * GRID_PX_1440 / 48) - 24;
const floorOf = (c) => c.min ?? Math.max(Math.min(c.width, FLOOR.get(W.COUNT)), Math.round(c.width * 0.7));
export const fitWidths = (cols, w) => {
  const fixed = cols.filter((c) => c.width);
  const nflex = cols.length - fixed.length;
  const need = fixed.reduce((t, c) => t + c.width, 0) + nflex * FLEX_MIN - gridPx(w);
  const slack = fixed.map((c) => Math.max(0, c.width - floorOf(c)));
  const total = slack.reduce((a, b) => a + b, 0);
  if (need > 0 && total > 0) {
    const share = Math.min(1, need / total);
    fixed.forEach((c, i) => { c.width -= Math.ceil(slack[i] * share); });
  }
  // Below ~120px (0.8 × FLEX_MIN) a text column is unreadable at 1440 whatever the widths are; such a
  // table is reported (narrow1440) for a layout decision. A column whose value must not be cut gets a
  // `min` (02's Identity) so it keeps its width rather than paying for the rest.
  const left = gridPx(w) - fixed.reduce((t, c) => t + c.width, 0);
  const fits = !nflex || left / nflex >= 0.8 * FLEX_MIN;
  for (const c of cols) delete c.min;
  return fits;
};

/** True when a table panel cannot give each text column ~120px at a 1440px viewport. See fitWidths(). */
export const narrowOverflow = (p) => p.config?.type === 'data_table' && p.narrow1440 === true;

/**
 * An identity that reads as a 20-character id is ACTOR_RESOLVE's last resort, not a defect, and a reader
 * meeting one needs to be told so where they meet it. Appended to the description of every table that
 * shows the resolved identity, unless the description already explains it.
 */
export const OPAQUE_ID_NOTE = 'An Identity that reads as an opaque id is a principal whose events carry no email and no key name — usually an organisation-level Elastic Cloud API key, which the audit stream records only by its id.';
const withIdNote = (desc, cols) =>
  (cols.some((c) => c.column === 'actor') && !/opaque/i.test(desc || '') ? `${desc} ${OPAQUE_ID_NOTE}` : desc);

/**
 * Lens prints a null cell as "-". A single space renders as an empty cell (an empty string renders as
 * "(blank)") — checked on a live panel. Apply AFTER the STATS, to the grouped rows, and only to a
 * DISPLAY column: nothing downstream may test it for null.
 *
 * NEVER on a click-to-filter column. Lens treats any column the query assigns (EVAL, even back onto
 * the same field name) as "created at query time": the cell is still a link, but clicking it opens
 * "You can't apply a filter or drill down from this value", so the pin and the Actor 360 drilldown
 * are lost (rendered, then reverted). A null in a filter column therefore stays an underlined "-";
 * there is no Lens setting that hides it. Where those dashes dominate a column, drop the column.
 */
export const blankNull = (...cols) => `EVAL ${cols.map((c) => `${c} = COALESCE(${c}, " ")`).join(', ')}`;

/**
 * EMPTY STATES. A Lens ES|QL table and a Discover session that match nothing print Kibana's bare "No
 * results found". No setting to replace it was found for 9.6 — none in an exported data_table or
 * discover_session panel, and the serverless OAS route is a 404 — and a panel description is only a
 * hover tooltip. A query cannot supply a placeholder row either: ES|QL has no UNION, a STATS with no
 * BY is the only shape that always returns a row, and turning a grouped table into one (EVAL key =
 * CASE(match, raw), STATS BY key, INLINE STATS to know whether anything matched) makes every row
 * column "created at query time", which costs the click-to-filter pill and the Actor 360 drilldown,
 * and scans the whole window.
 *
 * So the meaning of an empty panel goes in its TITLE, the one text a reader sees with the panel:
 * `table(…, { empty: 'good' })` titles it "⚠️ System index reads · none is good", and search() takes
 * the same option. `empty` is an EMPTY key ('good': empty is the healthy state; 'quiet': often empty
 * over the default hour) or the reader-facing words themselves ("empty without API-key traffic"); the
 * description gains the matching sentence. Use it on every table or session that a verify render at
 * the default 1h shows empty on a healthy project. Keep the words short: they share the title line.
 */
export const EMPTY = {
  good: { title: 'none is good', desc: 'An empty panel means nothing matched in the time range, which is the healthy state.' },
  quiet: { title: 'often empty at 1h', desc: 'Often empty over the default hour on a healthy project; widen the time range to see older rows.' },
};
const emptyOf = (empty) => EMPTY[empty] ?? { title: empty, desc: `When this panel is empty: ${empty}.` };
const withEmptyTitle = (title, empty) => (empty ? `${title} · ${emptyOf(empty).title}` : title);
const withEmptyDesc = (desc, empty) => (empty ? `${desc || ''} ${emptyOf(empty).desc}`.trim() : desc);

/**
 * COMPLETENESS. A table whose trailing LIMIT is clamped to fitRows() shows the top rows only, so a
 * title that promises every row ("Every address they used", "everything that scored") is false as
 * soon as the data outgrows the panel. layout.mjs fails a LIMITed table whose title says every,
 * everything or all, unless it is { scroll: true } (and then the LIMIT itself is the promise). The
 * in-memory `lint` annotation carries what the check needs; dashboards.mjs strips it from the payload.
 */
export const table = (x, y, w, h, title, q, rows, metrics, desc, { scroll = false, wrap = false, empty } = {}) => {
  let query = q;
  if (!scroll && !wrap) {
    query = q.replace(/\|\s*LIMIT\s+(\d+)\s*$/i, (m, n) => `| LIMIT ${Math.min(Number(n), fitRows(h))}`);
  }
  const r = rows.map(column);
  const m = metrics.map(column);
  // Every column fixed leaves the rest of a wide panel as an empty band on the right (rendered: a
  // 260px band on a full-width table). So when nothing flexes, the widest row column does — it is
  // the one the widths were protecting, so it is the one that should take the slack.
  if (r.length && [...r, ...m].every((c) => c.width)) {
    delete r.reduce((a, b) => (b.width > a.width ? b : a)).width;
  }
  const fits = fitWidths([...r, ...m], w);
  const limit = Number(/\|\s*LIMIT\s+(\d+)\s*$/i.exec(query)?.[1]) || undefined;
  return {
    type: 'vis', id: nid('tbl'), grid: { x, y, w, h }, ...(fits ? {} : { narrow1440: true }),
    lint: { limit, scroll: scroll || wrap, ...(empty ? { empty } : {}) },
    config: {
      title: withEmptyTitle(title, empty), description: withEmptyDesc(withIdNote(desc, r), empty), type: 'data_table',
      data_source: { type: 'esql', query },
      styling: { density: wrap ? DENSITY_WRAP : DENSITY },
      rows: r, metrics: m,
    },
  };
};

/** A row column whose cells are click-to-filter. See table(). The label does not affect the filter. */
export const filterable = (column, extra = {}) => ({ column, click_filter: true, ...extra });

/**
 * A column with a fixed pixel width, and optionally its own `label` — `sized('name', 430,
 * { label: 'Object' })`. Works on rows and metrics. See table() for why widths are roles and for the
 * defaults COLUMNS already supplies; reach for this when a text column needs a floor so a sibling
 * text column does not take all the slack. `PUT /api/dashboards/{id}` carries `width` natively in
 * 9.6, so there is no post-pass for it any more.
 */
export const sized = (column, width, extra = {}) => ({ column, width, ...extra });

/**
 * A pie or donut. The API defaults draw every slice name OUTSIDE the ring with no legend: sub-1%
 * slices stacked their leader lines in one corner, a long name was cut ("_service_..."), and on a
 * short panel Lens drops the outside label of a small slice altogether — with no legend that
 * category vanished from the panel (rendered, 05 at h=9). So every pie gets:
 *
 *   legend   'right' (default) | 'bottom' | 'hidden'. The right legend is `size: 'l'` (the API takes
 *            s/m/l/xl/auto, and only beside a left/right legend): the default width cut "IP not
 *            geolocatable" and "Elasticsearch API key" short. The pie legend takes no values option.
 *   labels   'inside' (default) or 'outside': where slice labels go. Inside, Lens drops a label that
 *            does not fit its slice, which is what a legend beside it makes acceptable.
 *   values   percentages on the slices, at `percent_decimals` (default 1 — Lens otherwise mixed 1 and
 *            2 decimals on one ring: 39.3% beside 58.29%).
 *   colors   { value: '#hex' } pins slices, always on the eui_amsterdam palette. Unpinned, slice
 *            colours follow slice ORDER, which follows volume, so the same realm was pink in one
 *            render and blue in the next. Pin every value the query can produce.
 *
 * Every key was read back from a deployed panel (GET /api/dashboards).
 */
const PIE_LEGEND = {
  right:  { visibility: 'visible', position: 'right', size: 'l' },
  bottom: { visibility: 'visible', position: 'bottom' },
  hidden: { visibility: 'hidden' },
};
export const pie = (x, y, w, h, title, q, sliceCol, metricCol, desc,
  { donut = 'm', kind = 'pie', legend = 'right', labels = 'inside', percent_decimals = 1, colors } = {}) => {
  if (!PIE_LEGEND[legend]) throw new Error(`pie "${title}": legend must be one of ${Object.keys(PIE_LEGEND).join(', ')}`);
  const config = {
    title, description: desc, type: kind,
    data_source: { type: 'esql', query: q },
    metrics: [{ column: metricCol }], group_by: [{ column: sliceCol, color: colorMapping(colors) }],
    legend: PIE_LEGEND[legend],
    styling: { labels: { visible: true, position: labels }, values: { visible: true, mode: 'percentage', percent_decimals } },
  };
  if (kind === 'pie') config.styling.donut_hole = donut;
  return { type: 'vis', id: nid('pie'), grid: { x, y, w, h }, config };
};

export const regionMap = (x, y, w, h, title, q, regionCol, metricCol, desc) => ({
  type: 'vis', id: nid('map'), grid: { x, y, w, h },
  config: {
    title, description: desc, type: 'region_map',
    data_source: { type: 'esql', query: q },
    region: { column: regionCol }, metric: { column: metricCol },
  },
});

/** Vega panels are legacy `visualization` saved objects; see dashboards.mjs repointVega(). */
export const vega = (x, y, w, h, ref, title, desc) => ({
  type: 'vis', id: nid('vega'), grid: { x, y, w, h },
  config: { ref_id: nsId(`cloud-audit-vega-${ref}`), title, description: desc },
});

/**
 * A Discover session panel. Like table(), it explains an opaque Identity when the session shows one,
 * and takes `{ empty }` (see EMPTY STATES above) for a session that is often empty.
 */
export const search = (x, y, w, h, ref, title, desc, { empty } = {}) => {
  const cols = JSON.parse(readFileSync(join(ROOT, 'searches', `${ref}.json`), 'utf8')).columns || [];
  const description = cols.includes('Identity') && !/opaque/i.test(desc || '') ? `${desc} ${OPAQUE_ID_NOTE}` : desc;
  return {
    type: 'discover_session', id: nid('ds'), grid: { x, y, w, h }, ...(empty ? { lint: { empty } } : {}),
    config: { ref_id: nsId(`cloud-audit-search-${ref}`), title: withEmptyTitle(title, empty), description: withEmptyDesc(description, empty) },
  };
};

/**
 * MARKDOWN SIZE. A markdown panel renders its body at 16px and `###` at ~20px, against 14px panel
 * titles and 12px tables, so a side note with an in-content heading was the loudest thing in its
 * row; and `####` renders as bold body text, no bigger than the paragraph under it. The 9.6 API has
 * no font-size setting for markdown (checked: `settings` takes only open_links_in_new_tab).
 *
 * So the rule is: a note's heading is its PANEL TITLE, exactly like every other panel, and the
 * content is body text. md() enforces it: a leading `#`/`##`/`###` line (after an optional <style>
 * block) is lifted out of the content into `title`, and layout.mjs rejects one anywhere else. `####`
 * stays legal — it is how section() draws a band, and inside a long note it is a bold run-in label.
 */
export const md = (x, y, w, h, content, { title, description } = {}) => {
  const m = /^((?:<style>[\s\S]*?<\/style>\s*)?)#{1,3}[ \t]+([^\n]+)\n+/.exec(content);
  const config = { content: m ? m[1] + content.slice(m[0].length) : content };
  const t = title ?? m?.[2].trim();
  if (t) config.title = t;
  if (description) config.description = description;
  return { type: 'markdown', id: nid('md'), grid: { x, y, w, h }, config };
};

/**
 * A section header. `window` is required, not decorative: a dashboard can mix panels that follow
 * the time picker with panels on a fixed window (see TIME BINDING above), and a reader who cannot
 * tell which is which will misread both. Making it a parameter is what stops a fixed-window panel
 * being dropped into a picker-bound section without anyone saying so.
 */
export const section = (x, y, w, h, title, window, note = '') => md(x, y, w, h,
  `#### ${title} · _${window}_${note ? `\n${note}` : ''}`);

/**
 * Grid layout without hand-written coordinates.
 *
 *   stack([ row(7, [[16, (x, y, w, h) => table(x, y, w, h, ...)], [32, ...]]), row(2, ...) ])
 *
 * row() takes a height and [width, make] pairs; stack() threads y through the rows and throws unless
 * every row is exactly GRID_W wide. A gap or an overlap becomes unrepresentable, and inserting a band
 * renumbers nothing. layout.mjs still checks the deployed geometry independently — this makes it
 * correct by construction, that proves it.
 */
const GRID_W = 48;
export const row = (h, cells) => ({ h, cells });
export const stack = (rows, y0 = 0) => {
  const out = [];
  let y = y0;
  for (const [i, { h, cells }] of rows.entries()) {
    const width = cells.reduce((sum, [w]) => sum + w, 0);
    if (width !== GRID_W) throw new Error(`row ${i} at y=${y} is ${width} wide, not ${GRID_W}`);
    let x = 0;
    for (const [w, make] of cells) { out.push(make(x, y, w, h)); x += w; }
    y += h;
  }
  return out;
};

export const links = (x, y, w, h, current, layout = 'horizontal') => ({
  type: 'links', id: nid('nav'), grid: { x, y, w, h },
  config: {
    title: 'Audit suite navigation', layout,
    /**
     * use_filters carries the analyst's pinned identity filter across dashboards, so clicking an
     * email on Command Center and then clicking "Geo & Network" arrives already scoped to them.
     * Stated explicitly rather than relying on the API default, because the whole drill-down
     * story rests on it.
     */
    /**
     * All eight, in the same order on every dashboard. Dropping the current one shifted every
     * link after it, so the bar re-ordered itself depending on where you were. Kibana renders a
     * link to the dashboard you are on as the current item, which doubles as "you are here".
     */
    links: DASH.map(([d, label]) => ({
      type: 'dashboardLink', destination: nsId(d), label,
      options: { use_filters: true, use_time_range: true, open_in_new_tab: false },
    })),
  },
});

export const CSS_NAV = `<style>
ul, li { margin: 0; padding: 0; list-style: none; position: relative; }
a {
  display: block; padding: 8px 14px;
  color: #1ba9f5 !important; text-decoration: none !important;
  transition: all 0.3s ease !important; border-radius: 4px;
}
a:hover {
  background-color: rgba(27, 169, 245, 0.1) !important;
  color: #0079b8 !important; padding-left: 20px !important; cursor: pointer;
}
</style>
`;

/**
 * Three grid rows (76px): the panel title plus one row of links, with nothing spare. At four the bar
 * carried ~40px of dead space on every dashboard. dash() adds this to every authored y, so it can
 * change without touching any dashboard module.
 */
export const NAV_H = 3;

/**
 * Navigation always goes on top: pin the links bar at y=0 and shift authored panels down.
 *
 * Default range is 1h. That used to be justified here as a hard limit — "2h, 3h and 4h exceed 60s;
 * 24h exceeds 110s" — and those numbers were real but misattributed. They were taken back to back:
 * a synchronous ES|QL query outlives the client that gave up on it and cannot be cancelled on
 * serverless, so a measurement taken after a timeout may have been sharing the cluster with it.
 * Re-measured on the perf replica, the busiest-identities panel returns in 84–106ms over 24h and
 * ~0.3s over 7 days. 1h stays the default because it is the readable view of "right now"; what makes
 * a wide window expensive is query shape, not width — see QUERY SHAPE above.
 * `./audit --lint` times every query, so this claim is checked rather than asserted.
 */
export const dash = (id, title, description, panels, timeFrom = 'now-1h') => ({
  title, description,
  time_range: { from: timeFrom, to: 'now' },
  refresh_interval: { pause: true, value: 60000 },
  panels: [links(0, 0, 48, NAV_H, id),
           ...panels.map((p) => ({ ...p, grid: { ...p.grid, y: p.grid.y + NAV_H } }))],
});
