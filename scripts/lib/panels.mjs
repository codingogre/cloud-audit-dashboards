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
 *   Vega, "%type%": "esql"             follows the PANEL's range — omitting %timefield% does NOT opt out:
 *                                      Kibana looks the index's time field up and ANDs the range. That
 *                                      range is the picker's unless the panel carries its own
 *                                      config.time_range (VEGA_WINDOWS): then ?_tstart/?_tend AND the
 *                                      hidden filter are that window, and Kibana badges the panel with it
 *   Vega ES|QL on THE EVENTS VIEW      does not: the view has no @timestamp, so Kibana finds no time
 *                                      field and attaches no range, and the query bounds itself
 *                                      (PREV_TILES; never compare a column bare with ?_tstart there)
 *   Vega, DSL (url.index + url.body)   follows it ONLY if %timefield% is set, so a DSL spec with an
 *                                      explicit @timestamp range and the %dashboard_context-*%
 *                                      placeholders keeps the control-bar filters AND its own window
 *
 * A fixed window on a now-24h dashboard (Actor 360's 7-day baseline, the 24-hour session timeline) is the
 * middle row with a VEGA_WINDOWS entry (1.0.5.1): an ES|QL spec bounded by TIME, so it also follows the
 * identity dropdowns, which no DSL spec can read. The last row is left for what a panel range cannot say:
 * a previous period (PREV_TILES, an ES|QL spec on the events view) and the stream's first event (vega/14, DSL). Read from the 9.6 source
 * (es_query_parser.ts / esql_query_parser.ts) and confirmed on live dashboards.
 *
 * THE HIDDEN LENS TIME FILTER (1.0.5, captured in the browser). "Lens ES|QL always follows the time
 * picker" is stronger than it sounds: every Lens ES|QL request carries a DSL range filter on @timestamp
 * for exactly [_tstart, _tend], beside the ?_tstart/?_tend params, WHETHER OR NOT the query compares
 * @timestamp with them. Kibana's esql expression (data/common/search/expressions/esql.ts) always adds
 * getTime() for the layer's time field; Lens takes that field from the column the query first compares
 * with ?_tstart/?_tend, and falls back to @timestamp at run time when there is none (07's WHOLE_MINUTES
 * layers are stored with no timeField and are still sent the filter). Pointing the comparison at another
 * field only moves the filter there. So no Lens panel can read an event outside the picker: a
 * `WHERE @timestamp > ?_tstart - 1 day` previous-period count comes back 0, and a lower bound below
 * ?_tstart is silently cut at ?_tstart. A fixed window is a panel range (VEGA_WINDOWS); a previous period,
 * or anything else outside the range, is a Vega spec on the events view or a DSL Vega spec, or nothing.
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
 *      be counted once per value. The identity a panel shows (ACTOR_RESOLVE, a five-condition CASE since
 *      1.0.5.1) is this shape too: group on ACTOR_KEYS, resolve, re-aggregate. Only a raw field takes a pill.
 *   3. A row feed sorts straight after its filter. A record feed or session that classifies rows (VERB,
 *      OBJ_TYPE) puts `SORT @timestamp DESC` (and any LIMIT) before the EVALs, so they run on the
 *      rows returned rather than on every row matched: searches/04 went 10.6s → 0.18s over 7 days.
 *   4. A panel that measures presence does not take the noise gate. access_granted is emitted
 *      for every authorised action — often several per request — and it IS a person's activity;
 *      gating it removes the thing the panel exists to show. (Not for speed: the null-guarded gate
 *      itself costs 45–56ms over 7 days. An earlier note blamed the negation for this file's slow
 *      queries; that was the multi-condition CASE of rule 1.)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, nsId, objId, ROOT, DEFAULT_STREAM, DEFAULT_VIEW } from './env.mjs';
import { deployed } from './suite.mjs';

/** The audit stream, from config — one definition, so a rename is an .env change, not a code change. */
export const IDX = cfg.dataStream;

/**
 * NULL-SAFE API KEY FIELDS. `api_key.id` and `api_key.name` get a mapping only when the first
 * API-key event arrives, so on a project where no key has been used yet any query naming them fails
 * with "Unknown column" and the panel shows an error. `SET unmapped_fields="nullify"` makes an
 * unmapped column read as null instead. It applies to the whole query, so it is added only where a
 * query names `api_key.*` (most actor queries, through ACTOR_RESOLVE): a typo anywhere else still
 * fails loudly. Verified on Kibana 9.6 serverless (1.0.4) on every surface the suite uses — Lens,
 * Vega, Discover sessions and the Discover app, controls, cell filters and drilldowns; Discover's
 * editor underlines a column that is not mapped yet as a warning, and the query still runs.
 * searches/*.json and vega/*.json carry the same prefix written out.
 */
export const NULL_SAFE = 'SET unmapped_fields="nullify";';
export const nullSafe = (q) => (/(?<![\w.])api_key\./.test(q) && !q.trimStart().startsWith('SET ') ? `${NULL_SAFE} ${q}` : q);

/**
 * IDENTITY (1.0.5.1): one answer per event to "which identity was this", behind the Identity type and Identity
 * dropdowns (ES|QL variable controls ?identity_kind and ?identity, controls.mjs).
 *
 * The raw fields change meaning with the credential, so no one of them names every identity:
 *   user.email      only for a person signed in through Elastic Cloud SSO; no API key ever carries one
 *   api_key.name    a named Elasticsearch API key, and only on Elasticsearch events
 *   user.name       the account the request RAN AS: a person's numeric Cloud user id, a Cloud API key's
 *                   20-character id (realm _cloud_api_key; nothing else names it), a service account
 *                   (elastic/kibana), an attempted name on a failed sign-in, or — for an Elasticsearch API
 *                   key — the key's OWNER. On a Kibana event made with an Elasticsearch key (user.domain
 *                   _es_api_key) Kibana records only that a key was used, so user.name there is the owner
 *                   and the key itself is unknown ("Unnamed key of <owner>").
 *
 * IDENTITY_KINDS lists each kind with its test, as plain boolean expressions on raw fields. IDENTITY_KIND and
 * IDENTITY are the same rules as CASEs for DISPLAY: multi-branch, so they run on grouped rows (count first
 * by IDENTITY_KEYS, QUERY SHAPE rule 2), never per event. IDENTITY_WHERE is the FILTER, per event, and is
 * written with no CASE and no COALESCE so Elasticsearch can answer most of it from the index:
 *
 *   PRE    a cheap superset any selected identity must pass (term tests the index answers)  20ms at 30 days
 *   KIND   ?identity_kind's test                                                             for a person
 *   EXACT  ?identity against the display rule, branch by branch                              (720ms with COALESCE)
 *
 * An empty dropdown sends "" (or "Any", see ANY) and every guard folds to true before the query runs (270ms → 270ms unselected).
 * Measured over 30 days on the live stream; selecting the Cloud API key, 98% of all events, costs ~850ms.
 * TIME carries IDENTITY_WHERE, so every ES|QL panel that bounds its window with TIME follows the dropdowns.
 */
export const CLOUD_KEY_SUFFIX = ' · Cloud API key';
export const UNNAMED_KEY_PREFIX = 'Unnamed key of ';
export const UNATTRIBUTED = '(unattributed)';
/**
 * The first option of both dropdowns. Kibana 9.6 gives an ES|QL control no way to clear a single-select
 * choice (no Clear button, and clicking the chosen value again keeps it), so "Any" is how a viewer goes back
 * to everyone. The guards treat it exactly like an empty selection (""), which is what a fresh page sends.
 */
export const ANY = 'Any';
const unset = (v) => `(?${v} == "" OR ?${v} == "${ANY}")`;
const KEY_DOMAINS = '"_cloud_api_key","_es_api_key","_service_account"';
const SIGNIN_FAILED_ACTIONS = '"authentication_failed","anonymous_access_denied"';
const NO_EMAIL = 'user.email IS NULL';
const NO_KEY_NAME = 'api_key.name IS NULL';
const OTHER_DOMAIN = `(user.domain IS NULL OR NOT user.domain IN (${KEY_DOMAINS}))`;
const FAILED_SIGNIN = `event.action IN (${SIGNIN_FAILED_ACTIONS})`;
const NOT_FAILED_SIGNIN = `(event.action IS NULL OR NOT event.action IN (${SIGNIN_FAILED_ACTIONS}))`;
const UNNAMED = `${NO_EMAIL} AND ${NO_KEY_NAME}`;
export const IDENTITY_KINDS = [
  ['Person', 'user.email IS NOT NULL'],
  ['Elasticsearch API key', `${NO_EMAIL} AND api_key.name IS NOT NULL`],
  ['Elasticsearch API key (name not recorded)', `${UNNAMED} AND user.domain == "_es_api_key"`],
  ['Cloud API key', `${UNNAMED} AND user.domain == "_cloud_api_key"`],
  ['Service account', `${UNNAMED} AND user.domain == "_service_account"`],
  ['Failed sign-in', `${UNNAMED} AND ${OTHER_DOMAIN} AND ${FAILED_SIGNIN}`],
  ['Unattributed', `${UNNAMED} AND ${OTHER_DOMAIN} AND ${NOT_FAILED_SIGNIN} AND user.name IS NULL`],
  ['Other', `${UNNAMED} AND ${OTHER_DOMAIN} AND ${NOT_FAILED_SIGNIN} AND user.name IS NOT NULL`],
];
/** The raw fields IDENTITY_KIND and IDENTITY read: group by these first, then derive. */
export const IDENTITY_KEYS = `user.email, api_key.name, user.domain, user.name, failed_signin = ${FAILED_SIGNIN}`;
export const IDENTITY_KIND =
  'identity_kind = CASE(user.email IS NOT NULL, "Person", api_key.name IS NOT NULL, "Elasticsearch API key", ' +
  'user.domain == "_es_api_key", "Elasticsearch API key (name not recorded)", user.domain == "_cloud_api_key", "Cloud API key", ' +
  'user.domain == "_service_account", "Service account", failed_signin, "Failed sign-in", user.name IS NULL, "Unattributed", "Other")';
const IDENTITY_EXPR =
  'CASE(user.email IS NOT NULL, user.email, api_key.name IS NOT NULL, api_key.name, ' +
  `user.domain == "_cloud_api_key", CONCAT(user.name, "${CLOUD_KEY_SUFFIX}"), ` +
  `user.domain == "_es_api_key", CONCAT("${UNNAMED_KEY_PREFIX}", user.name), ` +
  `user.name IS NOT NULL, user.name, "${UNATTRIBUTED}")`;
export const IDENTITY = `identity = ${IDENTITY_EXPR}`;
const IDENTITY_PRE =
  `(${unset('identity')} OR user.email == ?identity OR api_key.name == ?identity OR user.name == ?identity ` +
  `OR user.name == REPLACE(REPLACE(?identity, "${CLOUD_KEY_SUFFIX}$", ""), "^${UNNAMED_KEY_PREFIX}", "") ` +
  `OR (?identity == "${UNATTRIBUTED}" AND user.name IS NULL))`;
const IDENTITY_KIND_TEST =
  `(${unset('identity_kind')} OR ${IDENTITY_KINDS.map(([k, t]) => `(?identity_kind == "${k}" AND ${t})`).join(' OR ')})`;
const IDENTITY_EXACT =
  `(${unset('identity')} OR user.email == ?identity ` +
  `OR (${NO_EMAIL} AND api_key.name == ?identity) ` +
  `OR (${UNNAMED} AND user.domain == "_cloud_api_key" AND user.name == REPLACE(?identity, "${CLOUD_KEY_SUFFIX}$", "")) ` +
  `OR (${UNNAMED} AND user.domain == "_es_api_key" AND user.name == REPLACE(?identity, "^${UNNAMED_KEY_PREFIX}", "")) ` +
  `OR (${UNNAMED} AND (user.domain IS NULL OR NOT user.domain IN ("_cloud_api_key","_es_api_key")) AND user.name == ?identity) ` +
  `OR (?identity == "${UNATTRIBUTED}" AND ${UNNAMED} AND user.name IS NULL))`;
export const IDENTITY_WHERE = `${IDENTITY_PRE} AND ${IDENTITY_KIND_TEST} AND ${IDENTITY_EXACT}`;

/**
 * THE IDENTITY A PANEL SHOWS (1.0.5.1) is the Identity dropdown's own value, so a name read in a table can be
 * found in the dropdown and picking it narrows the page to that row. ACTOR_RESOLVE is IDENTITY's rule assigned
 * to `actor`, the column every identity table and Vega spec has always shown:
 *
 *   a person              their email
 *   Elasticsearch key     its name (api_key.name, Elasticsearch events only)
 *   Cloud API key         "<20-character id> · Cloud API key"
 *   key, name unknown     "Unnamed key of <owner>": a Kibana event made with an Elasticsearch key (user.domain
 *                         _es_api_key). Kibana records only the key's OWNER in user.name. Until 1.0.5.1 these
 *                         rows were shown as the owner itself, so a Cloud key's keys read as the Cloud key.
 *   anything else         user.name (a service account, a platform account, a name tried at sign-in, a
 *                         placeholder such as <unauthenticated-cloud-access-token>), else "(unattributed)"
 *
 * Until 1.0.5.1 it was COALESCE(user.email, api_key.name, user.name, "<anonymous>"): cheap per event, but it
 * named the owner of an unnamed key and printed a value the dropdown does not list. The CASE has five
 * conditions, so it NEVER runs per event (QUERY SHAPE rule 1): group by ACTOR_KEYS first, resolve, then
 * re-aggregate (SUM the counts, MAX the timestamps, COUNT_DISTINCT(actor) on the grouped rows). Measured on the
 * live stream over 30 days (3.1M events), per event against count-first: 05 Top client locations 223 → 140ms,
 * Busiest client IPs 532 → 416ms, vega/06 213 → 156ms (the old COALESCE: 113, 301, 98ms). The perf replica is
 * ~10x the live volume. A row feed applies it after its SORT and LIMIT (rule 3), on the rows it returns; a
 * panel that filters to a few hundred events first (04 Config changes, Top failures) may resolve per event
 * (22ms and 10ms at 30 days).
 *
 * ACTOR_KEYS is what it reads. user.domain is in it because the two key forms are told apart by the realm; a
 * query that groups on the pre-1.0.5.1 keys and then resolves fails loudly ("Unknown column [user.domain]").
 */
export const ACTOR_KEYS = 'user.email, api_key.name, user.domain, user.name';
export const ACTOR_RESOLVE = `EVAL actor = ${IDENTITY_EXPR}`;

/**
 * `actor_kind`: the cheap first cut, "human" when the row carries an email and "service" otherwise. A panel
 * that SHOWS the kind refines it on the grouped rows with KIND_REFINE. Like ACTOR_RESOLVE, it runs on rows
 * grouped by ACTOR_KEYS.
 */
export const ACTOR =
  `${ACTOR_RESOLVE}, actor_kind = CASE(user.email IS NOT NULL, "human", "service")`;

/**
 * Where an identity's traffic comes from, by the email on the event. Title case because these are
 * display values — a pie's slices and legend print them as they are — and they sit beside the
 * realm and credential-type labels, which are title case too. ORG reads only user.email,
 * so group by that first and apply ORG to the grouped rows.
 */
export const ORG =
  'EVAL actor_org = CASE(user.email IS NULL, "Machine", ' +
  'user.email LIKE "*@elastic.co", "Elastic", "Tenant")';

/**
 * authentication.type in words, as an EVAL assignment (`auth = CASE(…)`) so it can share an
 * EVAL with other columns: vega/02 embeds exactly this text, and the drift check pins it. Apply it
 * AFTER a STATS that groups on the raw field. "saml" is real on serverless (a SAML sign-in not yet
 * exchanged for a token). A type Elasticsearch has not documented falls through as its raw value.
 */
export const CRED_TYPE_LABEL =
  'auth = CASE(authentication.type == "api_key", "API key", ' +
  'authentication.type == "token", "Token", authentication.type == "realm", "Realm", ' +
  'authentication.type == "saml", "SAML", ' +
  'authentication.type == "anonymous", "Anonymous", authentication.type == "internal", "Internal", ' +
  'authentication.type)';

/**
 * How an identity authenticated, across both audit sources.
 *
 * authentication.type is an Elasticsearch-audit field: it is null on virtually every
 * Kibana event. user.domain IS populated there (cloud-saml-kibana), so the
 * COALESCE is what gives a credential dimension any fan-out on Kibana data — and it is the split
 * between a person in a browser (cloud-saml-kibana) and a script calling Kibana with a key
 * (_es_api_key), which no other field answers. It is derived, so never click-filter on it: a pill
 * on `credential` matches nothing.
 */
export const CRED =
  'EVAL credential = COALESCE(authentication.type, user.domain, "unknown")';

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
 *   1. `event.type` is SINGLE-valued on every Kibana audit event checked, so IN is
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
  '(service.name == "serverless-kibana" AND (' +
  '(event.type IN ("change","creation","deletion") ' +
  'AND (event.action IS NULL OR NOT (event.action IN (' +
  '"saved_object_open_point_in_time","saved_object_close_point_in_time")))) ' +
  'OR event.action IN ("rule_run_soon","secret_create")))';

export const CHANGE = `WHERE ${CHANGE_PRED}`;

/**
 * Recovers the changed object's identity from body.text when saved_object.* is absent.
 *
 * Kibana only populates kibana.saved_object.{id,type,name} on the saved-objects audit
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
  'kibana.saved_object.type IS NOT NULL, kibana.saved_object.type, ' +
  'event.action LIKE "ml_*ad_job", "ml-job", ' +
  'event.action LIKE "ml_*ad_datafeed", "ml-datafeed", ' +
  'event.action LIKE "workflow_execution_*", "workflow-execution", ' +
  'event.action LIKE "workflow_*", "workflow", ' +
  'event.action LIKE "agent_builder_agent_*", "agent-builder-agent", ' +
  'event.action LIKE "agent_builder_tool_*", "agent-builder-tool", ' +
  'event.action LIKE "product_documentation_*", "product-documentation", ' +
  'event.action == "secret_create", "secret", ' +
  // Fleet emits some events with NO event.action at all ("User deploying policy [id=...]",
  // "User creating enrollment API key [name=...]"). REPLACE on a null is null, which would put a
  // (null) bucket back on the heatmap and the object-type KPI — the exact thing this fragment
  // exists to remove. They are ECS-tagged `access`, so they never reach the change panels.
  'event.action IS NULL, "unclassified", ' +
  'REPLACE(event.action, "_(create|update|delete|enable|disable|run|run_soon|test|cancel)$", ""))';

/**
 * True when an event touched an object at all — the rows OBJ_TYPE names from a real type rather than
 * from its last-resort REPLACE of the action name (which turns http_request, user_login and the
 * point-in-time internals into "types"). Keep the families here in step with OBJ_TYPE's derived
 * branches above: a family added there and not here is silently dropped from anything that filters on
 * this. It references only raw fields, so it works on rows grouped by those fields, after a STATS.
 */
export const OBJ_PRESENT =
  '(kibana.saved_object.type IS NOT NULL OR event.action LIKE "ml_*" ' +
  'OR event.action LIKE "workflow_*" OR event.action LIKE "agent_builder_*" ' +
  'OR event.action LIKE "product_documentation_*" OR event.action == "secret_create")';

/**
 * Name of the thing changed. The ladder order is load-bearing: real name, then the name GROKed out
 * of the message, then the GROKed id, then the saved-object id, then the case id, the ML job and
 * the execution id, and finally the prose sentence itself. body.text last is what guarantees this
 * column is NEVER null — which is the whole point of the exercise.
 */
export const OBJ_NAME =
  'EVAL obj_name = COALESCE(kibana.saved_object.name, g_name, g_id, ' +
  'kibana.saved_object.id, g_case, g_ml, g_exec, body.text)';

/** The three together, ready to drop into a pipeline. */
export const OBJ = `${OBJ_GROK} | ${OBJ_TYPE} | ${OBJ_NAME}`;

/**
 * Light version for the KPIs, which need a distinct-object count over the FULL read volume
 * (every Kibana event in the window) rather than the few a change filter leaves. One GROK instead
 * of five; measured at 68–85ms over 24h on the perf replica.
 */
export const OBJ_ID =
  `${G(String.raw`\[(?:id|workflowId)=%{DATA:g_id}(?:,|\])`)} ` +
  '| EVAL obj_id = COALESCE(kibana.saved_object.id, g_id)';

/**
 * Kibana logs an ATTEMPT (outcome=unknown, "User is creating dashboard") on the saved-objects path
 * and a COMPLETION (outcome=success, "User updated workflow") on the newer feature path. A raw
 * "unknown" in a table reads as a defect, so it is relabelled to what it actually means.
 */
export const OUTCOME =
  'EVAL result = CASE(event.outcome == "unknown", "attempted", event.outcome)';

/**
 * A failed sign-in is one REQUEST that could not prove who it was: authentication_failed, or
 * anonymous_access_denied for a request that presented nothing. Elasticsearch also writes one
 * realm_authentication_failed per realm it tried on the way, so with two realms one bad password was
 * three events — 'admin' read 60 realm failures beside 30 authentication_failed at the same millisecond,
 * and the tile counted 90 "failed sign-ins" for 30 attempts. Measured by http.request.id over
 * the stream's whole span: 62 requests wrote 2 realm failures + 1 authentication_failed, 24 wrote the
 * authentication_failed alone, 327 one anonymous_access_denied, and 4 a realm failure with NO overall
 * failure (a later realm let them in). So realm_authentication_failed is a per-realm trace of an attempt
 * already counted, or of one that succeeded; it is left out of every panel here, outcome or not, and each
 * attempt counts once. Shared by 01 (Failed or denied, the failure table, searches/02) and 04 (Failures,
 * Top failures and denials), so the two pages count one bad password the same way.
 *
 * Everything else this page counts as a failure (access_denied, and any action whose outcome is failure)
 * is an AUTHENTICATED identity being refused — access_denied alone outnumbers the sign-in failures. The
 * panels therefore say "failed or denied", and the KPI splits the two so neither reads as the other.
 * The IS NULL guard keeps a failed event with no action in (a bare != drops it as null); it is written
 * as a boolean, not COALESCE(action, ""), so it pushes down to Lucene: the COALESCE form cost the
 * failure session ~90ms more over 7 days on the replica.
 */
export const SIGNIN_FAILED = '"authentication_failed","anonymous_access_denied"';
export const REALM_TRACE = '(event.action IS NULL OR event.action != "realm_authentication_failed")';
export const FAILED_OR_DENIED = `WHERE event.action IN (${SIGNIN_FAILED}) OR (event.outcome == "failure" AND ${REALM_TRACE})`;

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
 *
 * HOUSEKEEPING SCORES 0, and it is tested first (round 6, the human's decision). Kibana's own API-key
 * clean-up — invalidate_apikeys by a PLATFORM_ACTORS principal through no named key, every few seconds —
 * is the same rule 00's Privileged ops and 04's Config changes leave out, so every risk panel now agrees
 * with them: before, the treemap painted elastic/kibana the hottest identity on the page (267 of its 268
 * events in an hour were this clean-up) beside a tile calling the same events routine. A deliberate
 * invalidation by a person, a named key or a Cloud API key still weighs 45. `housekeeping` is the
 * boolean RISK_KEYS groups (HOUSEKEEPING reads user.name and api_key.name, which a scoring panel does not
 * otherwise group on), so RISK runs only after RISK_KEYS, as it always has.
 *
 * THE SUITE'S OWN INSTALL SCORES 0 (1.0.5). `./audit --objects/--dashboards` writes the suite's cloud-audit-*
 * objects through the public API with a Cloud API key and no browser session. NOISE already kept it out of
 * the feeds, but every risk panel scored it: measured live over 24h, about 4,500 of the deploying key's
 * 5,400 severity was its own install, so 04's leaderboard ranked the deploy key first while 00's treemap
 * (which runs NOISE first) did not. `suite_install` is SUITE_INSTALL as a RISK_KEYS boolean. Its branch sits
 * AFTER the failure branch, so a denied write to a suite object still scores 40, and before every change
 * weight. It tests the channel, so a person editing a suite dashboard in a browser still scores 25/30. The
 * install stays in CHANGE_PRED (every mutation list still shows it) and 04's Scoring events tile counts it
 * in its second line, so an unexpected spike of session-less writes to suite objects stays visible.
 */
export const RISK =
  'EVAL risk = CASE(housekeeping, 0, event.action == "invalidate_apikeys", 45, ' +
  'event.action == "anonymous_access_denied", 35, ' +
  'elasticsearch.audit.security_config_change IS NOT NULL, 50, ' +
  'event.outcome == "failure", 40, ' +
  'suite_install, 0, ' +
  `${CHANGE_PRED} AND event.action IN (${EXECUTIONS}), 10, ` +
  `${CHANGE_PRED} AND (event.type == "deletion" OR event.action == "rule_disable"), 30, ` +
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
/**
 * Anything the cluster could not attribute to a principal. Not platform — nobody owns these. "(unattributed)"
 * is ACTOR_RESOLVE's value for an event with no user.name (1.0.5.1; it was "<anonymous>", kept here so the
 * static specs that still test user.name against this list keep their meaning).
 */
export const UNAUTH_ACTORS =
  `"${UNATTRIBUTED}","<anonymous>","<unauthenticated-cloud-access-token>","<unauthenticated-saml-user>","<unauthenticated-cloud-api-key>"`;
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
 * PRIVILEGED OPERATIONS. A security_config_change is the stream's own word for a privileged write — an
 * API key created or invalidated, a role or user profile written — so "any non-zero value deserves
 * review" was the reading this KPI was built for. It stopped being true when Kibana started cleaning up
 * API keys on its own: `elastic/kibana`, the Kibana service account, invalidates keys every few
 * milliseconds (the ids in the payload are Kibana's own, e.g. `kibana-api-key-service-test`, or keys a
 * deleted rule left behind). Measured on the live stream: 670 of 671 privileged ops in one hour, 2,026
 * of 2,770 over 24h, so the tile never read 0 and taught viewers to ignore it.
 *
 * HOUSEKEEPING is exactly that: `invalidate_apikeys` by a PLATFORM_ACTORS principal through no named
 * key. Nothing else is excused — a key Kibana creates on a user's behalf (create_apikey by
 * elastic/kibana when a rule is saved) is a real grant and stays counted, and an invalidation by any
 * tenant identity is the event this tile exists for. Every term is guarded (`false AND null` is false),
 * so it is never null and `NOT HOUSEKEEPING` never drops a row.
 *
 * PRIVILEGED selects the rest. Use it wherever a panel promises privileged operations (00 Privileged
 * ops, 04 Config changes and its table) and say what it leaves out; privilegedKpi() puts the excluded
 * count in the tile's secondary line, so the housekeeping is never silently gone. RISK scores the same
 * housekeeping 0 (its first branch reads the `housekeeping` key RISK_KEYS groups), so the risk panels —
 * treemap, leaderboard, Why these identities scored, the scatter, Actor 360's Risk — agree with these tiles.
 */
export const HOUSEKEEPING =
  '(event.action IS NOT NULL AND event.action == "invalidate_apikeys" ' +
  `AND user.name IS NOT NULL AND user.name IN (${PLATFORM_ACTORS}) AND api_key.name IS NULL)`;
export const PRIVILEGED =
  `WHERE elasticsearch.audit.security_config_change IS NOT NULL AND NOT ${HOUSEKEEPING}`;

/**
 * A suite object id, any AUDIT_ID_NS namespace. Null-guarded and left without outer parentheses, so
 * SUITE_SELF below keeps its exact text (searches/04, 06, 10 and vega/01, 07 embed it verbatim through
 * NOISE, KIBANA_INTERNALS and BAND_KEYS). Defined here, before RISK_KEYS reads it at module load.
 */
export const SUITE_ID_TEST =
  'kibana.saved_object.id IS NOT NULL AND (kibana.saved_object.id LIKE "cloud-audit-*" OR kibana.saved_object.id LIKE "elastic_cloud-audit-*")';
/**
 * SUITE_INSTALL: a suite object touched with no Kibana browser session — `./audit --objects/--dashboards`
 * through the public API. RISK scores it 0 (after the failure branch, so a DENIED write to a suite object
 * still scores 40), through the `suite_install` key of RISK_KEYS. It stays in CHANGE_PRED, so 02 Mutations,
 * 04 Mutation feed and 07 What they changed still list it; a person editing a suite dashboard in a browser
 * has a session and still scores 25/30. A test of the channel, never of a key, like SUITE_SELF. Never null.
 */
export const SUITE_INSTALL = `(${SUITE_ID_TEST} AND kibana.session.id IS NULL)`;
/**
 * A count as text with thousands separators ("1,618,996"), the form Lens prints every number beside it
 * in: a KPI's secondary line, a category label that carries its count. TO_STRING alone gave "2326 key
 * cleanups left out" under tiles reading "1,728,070". ES|QL has no number formatting, so the digits are
 * grouped by hand, up to 12 of them. A multi-branch CASE, so use it only on rows a STATS already
 * produced (a KPI's single row, a bar chart's few categories), never per event (QUERY SHAPE rule 1).
 *
 *   EVAL detail = CONCAT(${grouped('signin')}, " failed sign-ins")
 */
export const grouped = (x) => {
  const s = `TO_STRING(${x})`, n = `LENGTH(${s})`;
  return `CASE(${n} <= 3, ${s}, ${n} <= 6, CONCAT(LEFT(${s}, ${n} - 3), ",", RIGHT(${s}, 3)), ${n} <= 9, CONCAT(LEFT(${s}, ${n} - 6), ",", SUBSTRING(${s}, ${n} - 5, 3), ",", RIGHT(${s}, 3)), CONCAT(LEFT(${s}, ${n} - 9), ",", SUBSTRING(${s}, ${n} - 8, 3), ",", SUBSTRING(${s}, ${n} - 5, 3), ",", RIGHT(${s}, 3)))`;
};

/**
 * The tail of a privileged-ops KPI: `FROM … | TIME | ${privilegedKpi('Privileged ops')}` gives the
 * count in `col` and, in `housekeeping_note`, how many routine Kibana key cleanups it left out — pass
 * `secondary: 'housekeeping_note'` to kpi(). Measured on the 7-day replica: 157ms against 134ms for the
 * bare COUNT(security_config_change) it replaces.
 *
 * The note is SHORT and quiet on purpose — "excl. 2,285 cleanups", digit-grouped. A metric tile's
 * secondary line is clipped without an ellipsis (an 8-column tile shows ~22 characters at 1440px), and
 * Lens right-aligns it directly above the main number, so "284 key cleanups left out" over a "1" read as
 * the tile's headline (round-4 review of 00): the eye landed on 284. A leading "excl." makes it read as a
 * qualifier of the number below it. One row, after the STATS, so the CASE costs nothing.
 */
export const privilegedKpi = (col) =>
  `WHERE elasticsearch.audit.security_config_change IS NOT NULL | EVAL housekeeping = ${HOUSEKEEPING} ` +
  `| STATS \`${col}\` = COUNT(*) WHERE NOT housekeeping, cleanups = COUNT(*) WHERE housekeeping ` +
  `| EVAL housekeeping_note = CASE(cleanups == 0, "no cleanups in range", CONCAT("excl. ", ${grouped('cleanups')}, " cleanups"))`;

/**
 * CLOUD API KEYS, AS AN IDENTITY. The stream records no name and no owner for an organization-level Elastic
 * Cloud API key: its only identifier is the 20-character id in user.name, and on this project such a key (the
 * one this repo's own tooling deploys, lints and renders with) is the busiest identity on every page. The
 * Identity dropdown lists it in full, "<id> · Cloud API key" (ACTOR_RESOLVE); a table SHOWS it shortened:
 *
 *   _4KEO… · Cloud API key          a Cloud API key
 *   Unnamed key of _4KEO…           an Elasticsearch key that Cloud API key owns, used through Kibana
 *
 * the first five characters of the id (enough to tell two keys apart by eye, and enough to find it by typing
 * in the Identity dropdown; the full id is in the Principal id column and in API key inventory). Every How to
 * read block that shows identities says so.
 *
 *   ACTOR_LABEL / identityLabel(col)  shortens a DISPLAYED identity (ACTOR_RESOLVE's value): two REPLACEs on a
 *                                     regex, no CASE. The last step before display, AFTER the last STATS BY
 *                                     actor (two keys sharing a prefix would merge if it ran first); table()
 *                                     appends ACTOR_LABEL to every table that shows `actor`.
 *   cloudKeyLabel(col, otherwise)     the same short form from a RAW user.name (a key's owner, a creator).
 *                                     `isCloudKeyId(col)` is a value test: a 20-character value of the
 *                                     base64url alphabet that is not all digits (a numeric Cloud user id is
 *                                     shorter; service accounts and key names never match).
 *
 * Per row, on the few rows a panel displays, so it costs nothing measurable.
 */
export const CLOUD_KEY_TAG = '… · Cloud API key';
export const isCloudKeyId = (col) =>
  `(LENGTH(${col}) == 20 AND ${col} RLIKE "[-_A-Za-z0-9]{20}" AND NOT ${col} RLIKE "[0-9]{20}")`;
export const cloudKeyLabel = (col, otherwise = col) =>
  `CASE(${isCloudKeyId(col)}, CONCAT(LEFT(${col}, 5), "${CLOUD_KEY_TAG}"), ${otherwise})`;
const KEY_ID_RE = '([-_A-Za-z0-9]{5})[-_A-Za-z0-9]{15}';
export const identityLabel = (col) =>
  `REPLACE(REPLACE(${col}, "^${KEY_ID_RE}${CLOUD_KEY_SUFFIX}$", "$1${CLOUD_KEY_TAG}"), ` +
  `"^${UNNAMED_KEY_PREFIX}${KEY_ID_RE}$", "${UNNAMED_KEY_PREFIX}$1…")`;
export const ACTOR_LABEL = `EVAL actor = ${identityLabel('actor')}`;

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
  'WHERE elasticsearch.audit.security_config_change IS NOT NULL ' +
  'OR event.outcome == "failure" ' +
  'OR event.action IN ("invalidate_apikeys","anonymous_access_denied") ' +
  `OR ${CHANGE_PRED}`;

/**
 * Every raw field RISK reads, as STATS keys, so a scoring panel counts first and scores the grouped
 * rows (QUERY SHAPE rules 1–2): `RISK_PREFILTER | STATS n = COUNT(*) BY …, RISK_KEYS | RISK_RESTORE |
 * RISK | WHERE risk > 0`, then every count downstream is SUM(n) and every severity SUM(risk * n).
 * Add a field here whenever RISK (or CHANGE_PRED inside it) starts reading one.
 *
 * Two fields are not grouped as they are, and RISK_RESTORE puts them back for RISK to read:
 *
 *   event.type is MULTI-valued on Elasticsearch events, and STATS BY a multi-valued field
 *   would count such a document once per value. It is grouped as one joined string and restored as
 *   the same multi-value, which keeps CHANGE_PRED's `IN` and `==` returning null on those rows exactly
 *   as on the raw field (no ECS event.type value contains a comma).
 *
 *   elasticsearch.audit.security_config_change is a JSON payload that is close to unique per
 *   event, and RISK only asks whether it is present. Grouping on the payload multiplied the rows that
 *   reach RISK sixfold (18,001 against 2,936 for the hourly risk chart over 7d on the perf replica), and
 *   a CASE costs per ROW after a STATS as well as before it. So it is grouped as the boolean `scc`, and
 *   restored as the placeholder "present" or null: after RISK_RESTORE that field answers IS NOT NULL
 *   correctly and nothing else — a panel that shows the payload must not read it from these rows.
 *
 * `housekeeping` is HOUSEKEEPING as a boolean key (the kib_internal trick): RISK's first branch reads it,
 * so Kibana's key clean-up scores 0 without every scoring panel grouping on user.name and api_key.name.
 * Never null (every term guarded), so it never splits a group three ways. `suite_install` is SUITE_INSTALL
 * the same way: RISK scores the suite's own session-less install 0, and 04's Scoring events tile counts it.
 */
export const RISK_KEYS =
  'event.action, scc = elasticsearch.audit.security_config_change IS NOT NULL, ' +
  'event.outcome, service.name, et = MV_CONCAT(event.type, ","), ' +
  `housekeeping = ${HOUSEKEEPING}, suite_install = ${SUITE_INSTALL}`;
export const RISK_RESTORE =
  'EVAL event.type = SPLIT(et, ","), elasticsearch.audit.security_config_change = CASE(scc, "present")';

/**
 * The noise vocabulary, shared by NOISE and BAND so the gate and the bands can never disagree.
 *
 * `elasticsearch.audit.action` does not exist on Kibana audit events. The previous
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
 *                   resolution; search_shards; ES|QL's query listing and lookup (cluster:monitor/
 *                   xpack/esql/*: list_queries, get_query). And the two cluster reads Kibana makes on
 *                   every page load — cluster:monitor/project/tags and xpack/inference/get, 1,707 and
 *                   1,704 in 24h against 1,666 page shells — which led the Live signal feed once the
 *                   Kibana half of the page load was gated (round 4). And reads of API key metadata
 *                   (security/api_key/get and /query, API_KEY_READS below — round 6): a client polling
 *                   its own key; creating, granting, updating or invalidating a key stays signal. A
 *                   read of a system index is NOT lost: SYS_INDEX selects on the index, not this gate.
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
 *                   And the two lookups every Kibana page load makes before it draws anything —
 *                   saved_object_get of the `config` / `config-global` settings object, and
 *                   saved_object_find of `index-pattern` (the logs-* / metrics-* default data-view check,
 *                   the workflows data views): 2,021 each in 24h, one per page load, by every viewer and
 *                   by the verify renderer. Reading, creating or changing a particular data view stays.
 *   The suite       (SUITE_SELF) what the suite does to its own saved objects — `cloud-audit-*` (the Vega
 *                   and Discover objects, the data view, and the retired numbered dashboard ids), plus
 *                   every dashboard as `elastic_cloud-audit-*` (Command Center's `elastic_cloud-audit-dashboard`
 *                   since 1.0.2, the id the Cloud UI links to; every other dashboard since 1.0.3); both
 *                   cover every AUDIT_ID_NS namespace too:
 *                     · a READ (get, resolve, find) by anyone: "User has accessed dashboard
 *                       [id=cloud-audit-…]" is the suite watching itself be watched, one per panel
 *                       load per viewer;
 *                     · ANY event on a suite object with no Kibana browser session: the automated
 *                       install. `./audit --objects/--dashboards` imports, exports, creates, updates and
 *                       deletes the suite's objects through the public API with an API key, and on a
 *                       redeploy that was every row of Command Center's Live signal feed and 8 of 10 of
 *                       02's Most-accessed objects (10,368 events in 24h);
 *                     · the request lines of an install: an http_request to /api/saved_objects/_import
 *                       or _export, or to a public route that names a suite id (PUT /api/dashboards/
 *                       cloud-audit-…). Each object an import or export touches is audited again as its
 *                       own saved_object_* event (verified: an _export of one dashboard is followed by
 *                       its saved_object_get), so an export of OTHER objects, by a script or a person,
 *                       still shows object by object; only the request line is gated.
 *                   A person editing a suite dashboard in Kibana does so in a browser session, so that
 *                   stays signal. It is a test of the channel, not of a key: no key id is named, and an
 *                   API-key write to anything that is not a suite object stays signal. Every CHANGE —
 *                   the install's included — is still in CHANGE_PRED, which this gate never touches, so
 *                   02's Mutations, 04's Mutation feed and 07's What they changed list it. Who VIEWED
 *                   the suite is still on 02's tiles, heatmap and Busiest object types (all traffic).
 *
 * KIBANA_INTERNALS is evaluated only where event.action is known to be non-null (inside NOISE's
 * `IS NULL OR NOT (…)` and as a BAND_KEYS boolean), and every other field it reads is either tested
 * `IS NULL` (never null itself) or guarded `IS NOT NULL AND …` — `false AND null` is false, so it never
 * yields null and never drops a row. url.original is a `wildcard` field: RLIKE on it measured the same
 * as a LIKE (36ms vs 34ms, 7d) and is exact where `LIKE "*\/internal/*"` also matched /api/internal/….
 */
const NOISE_ES_ACTIONS = '"cluster:monitor/main", "elastic.maintenance"';
const A_ = 'elasticsearch.audit.action';
/**
 * Reads of API key METADATA: `GET /_security/api_key` (api_key/get) and the query/list form
 * (api_key/query). Query internals by the human's decision (round 6): a client polling its own key — on
 * this project the Cloud API key the suite's tooling runs as, ~12,600 a day, several a second while a
 * render or deploy runs — was 1,369 of 1,805 Signal events in a 1h Command Center render and filled the
 * Live signal feed. A read of key metadata grants nothing. Key create, grant, update and invalidate stay
 * signal (and stay scored: they carry security_config_change). Action-based like every other query
 * internal, so a DENIED read is gated too; the failure panels do not take the noise gate and still list it.
 */
const API_KEY_READS = '"cluster:admin/xpack/security/api_key/get", "cluster:admin/xpack/security/api_key/query"';
const NOISE_ES_QUERY_INTERNALS =
  `${A_} LIKE "indices:data/read/search*" OR ${A_} LIKE "indices:data/read/msearch*" ` +
  `OR ${A_} LIKE "indices:data/read/scroll*" ` +
  `OR ${A_} LIKE "indices:data/read/*point_in_time" OR ${A_} == "indices:data/read/open_reader_context" ` +
  `OR ${A_} LIKE "indices:data/read/esql*" OR ${A_} LIKE "indices:admin/esql/*" ` +
  `OR ${A_} LIKE "indices:data/read/field_caps*" OR ${A_} LIKE "indices:data/read/async_search/*" ` +
  `OR ${A_} LIKE "indices:admin/resolve/*" OR ${A_} == "indices:admin/shards/search_shards" ` +
  `OR ${A_} LIKE "cluster:monitor/xpack/esql/*" ` +
  `OR ${A_} IN ("cluster:monitor/project/tags", "cluster:monitor/xpack/inference/get", ${API_KEY_READS})`;
const NOISE_EVENT_ACTIONS = '"authentication_success","connection_granted"';

/**
 * The URLs a browser fetches to draw a Kibana page, as one RLIKE over url.original (with or without the
 * /s/<space> prefix). Each alternative carries its own tail, so `api/spaces/space` matches the space
 * LIST a page load fetches and not `/api/spaces/space/<id>` (a space read, update or delete by id).
 *
 *   internal/…                          every /internal/ route: esql_async, feature flags, controls
 *   api/content_management/rpc/{get,search,mget,bulkGet}   the dashboard app loading and listing objects
 *   bootstrap.js, bootstrap-anonymous.js, translations/…, app/<app>   the page shell and its assets
 *   api/core/…, api/licensing/…, api/banners/…, api/ui_counters/…     capabilities, licence, banner and
 *                                        usage-counter calls every page makes once
 *   api/spaces/space                     the space picker's list, once per page load
 *
 * Measured on the live stream, 24h: the page-load half (all but the first two lines) newly gates 10,429
 * events and nothing else — one set per page load (the space list 2,021, bootstrap.js 1,669,
 * capabilities 1,668, banners 1,668, /app/dashboards 1,666, licensing 1,661, ui_counters 73) — which
 * led Command Center's Live signal feed. 7-day replica: signal 377,070 → 359,940; a cold gated count
 * ~200ms before and after, ~70ms once Elasticsearch caches the filter. A change made through a public
 * route is audited again as its own event (space_create, saved_object_create …), so gating the request
 * line loses no change. `[.]` rather than a backslash keeps the pattern free of escapes in the static
 * copies (vega/01, vega/07, searches/06, searches/10 — the drift check pins them).
 */
export const KIBANA_PLUMBING_URL =
  'https?://[^/]+(/s/[^/]+)?/((internal|translations|app)/.*|api/content_management/rpc/(get|search|mget|bulkGet).*' +
  '|bootstrap(-anonymous)?[.]js.*|api/(core|licensing|banners|ui_counters)/.*|api/spaces/space([?].*)?)';

/**
 * The suite's own install requests (see "The suite" above): an import or export, or a public route
 * naming a suite id. An alternative of the same RLIKE as KIBANA_PLUMBING_URL — a second RLIKE behind a
 * session test measured slower on the band charts — and session-blind, which loses nothing: every object
 * an import or export touches is audited again as its own saved_object_* event, and that is where the
 * session test applies.
 */
export const SUITE_INSTALL_URL = 'https?://[^/]+(/s/[^/]+)?/api/(saved_objects/(_import|_export)|[^?]*/(elastic_)?cloud-audit-).*';

/**
 * SUITE_SELF: the suite's own saved objects, read by anyone or touched with no browser session. The
 * session test is `IS NULL`, so it never yields null.
 */
export const SUITE_SELF =
  `(${SUITE_ID_TEST} ` +
  'AND (event.action IN ("saved_object_get","saved_object_resolve","saved_object_find") OR kibana.session.id IS NULL))';

export const KIBANA_INTERNALS =
  'event.action IN ("saved_object_open_point_in_time","saved_object_close_point_in_time","space_get","space_find") ' +
  'OR (event.action == "http_request" AND url.original IS NOT NULL ' +
  `AND url.original RLIKE "${KIBANA_PLUMBING_URL}|${SUITE_INSTALL_URL}") ` +
  'OR (kibana.saved_object.type IS NOT NULL AND (' +
  '(event.action == "saved_object_get" AND kibana.saved_object.type IN ("config","config-global")) ' +
  'OR (event.action == "saved_object_find" AND kibana.saved_object.type == "index-pattern"))) ' +
  `OR ${SUITE_SELF}`;

export const NOISE =
  `WHERE (${A_} IS NULL OR NOT (` +
  `${A_} IN (${NOISE_ES_ACTIONS}) OR ${NOISE_ES_QUERY_INTERNALS})) ` +
  `AND (event.action IS NULL OR NOT (event.action IN (${NOISE_EVENT_ACTIONS}) OR ${KIBANA_INTERNALS}))`;

/**
 * The raw keys BAND reads, for `STATS n = COUNT(*) BY …, BAND_KEYS | BAND | STATS SUM(n) BY band`.
 * BAND is a multi-branch CASE, so it never runs per event (QUERY SHAPE rule 1). Two of the fields
 * KIBANA_INTERNALS reads are near-unique per event (a URL, a saved-object id), so they are grouped as
 * the one boolean `kib_internal` — the same trick RISK_KEYS plays with security_config_change — and
 * BAND reads that column. It is null where event.action is null, which BAND's CASE falls through.
 */
export const BAND_KEYS =
  `${A_}, event.action, kib_internal = (${KIBANA_INTERNALS})`;

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
  `event.action == "connection_granted", "query-noise", ` +
  `event.action == "authentication_success", "authn-volume", "signal")`;

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

/** The picker window AND the identity dropdowns (IDENTITY above). TIME_ONLY is the bare window. */
export const TIME_ONLY = 'WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart';
export const TIME   = `${TIME_ONLY} AND ${IDENTITY_WHERE}`;
export const BUCKET = 'BUCKET(@timestamp, 75, ?_tstart, ?_tend)';
export const KIB    = 'WHERE service.name == "serverless-kibana"';
/** Elasticsearch's source name; `elasticsearch-serverless` before the 2026 schema change. */
export const ESS    = 'WHERE service.name == "serverless-elasticsearch"';

/**
 * Folds dated daily indices and data-stream backing indices into the family they belong to, so
 * `.ds-logs-x-2026.10.14-000001` and `logs-x` are one row and seven `.slo-…-2026-10-0N` days are one.
 * One definition for 03 and 07, so "index family" means one thing in the suite; vega/04 embeds the
 * same text and the drift check pins it.
 */
export const indexFamily = (col) => String.raw`REPLACE(REPLACE(${col}, """^\.ds-""", ""), """[-.]?\d{4}[.-]\d{2}[.-]\d{2}(-\d+)?$""", "")`;
export const INDEX_FAMILY = indexFamily('elasticsearch.audit.indices');

/**
 * Index EXPRESSIONS, not indices: `*`, `-*`, `syn-*` and date math like `<.slo-…{2026-10-14||/d}>`.
 * Elasticsearch records the expression as the client wrote it, and the concrete indices it resolved
 * to appear on the shard-level events beside it, so counting both double-counts and lists a pattern
 * as if it were something you could open. Applied to grouped rows, so it costs nothing per document.
 * vega/04 embeds it verbatim.
 */
export const CONCRETE = 'WHERE LOCATE(elasticsearch.audit.indices, "*") == 0 AND NOT elasticsearch.audit.indices LIKE "<*"';

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
  'WHERE ((elasticsearch.audit.indices LIKE ".*" AND NOT elasticsearch.audit.indices LIKE ".ds-*") ' +
  'OR elasticsearch.audit.indices LIKE ".ds-.*") ' +
  'AND (elasticsearch.audit.action IS NULL OR NOT elasticsearch.audit.action LIKE "*[*")';

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
  'EVAL verb = CASE(event.action LIKE "*_execution_cancel", "cancel", ' +
  'event.action LIKE "*_run_soon", "run", event.action LIKE "*_run", "run", ' +
  'event.action LIKE "*_test", "test", ' +
  'event.action LIKE "*_enable", "enable", event.action LIKE "*_disable", "disable", ' +
  'event.action LIKE "ml_put_*", "create", event.action LIKE "ml_open_*", "open", ' +
  'event.action LIKE "ml_start_*", "start", ' +
  'event.action LIKE "*point_in_time", "pit", ' +
  'event.action LIKE "*_create*", "create", ' +
  'event.action LIKE "*_update*", "update", event.action LIKE "*_delete", "delete", ' +
  'event.action LIKE "*_find", "find", event.action LIKE "*_get", "get", ' +
  'event.action LIKE "*_resolve", "resolve", "other")';

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
  'WHERE event.action LIKE "*_create" OR event.action LIKE "*_update" ' +
  'OR event.action LIKE "*_delete"';;

/**
 * The navigation strip's entries, in order: the dashboards this run deploys (see lib/suite.mjs, which
 * owns the order, the ids and the Platform Volume opt-in). A function, not a constant, because the set
 * depends on AUDIT_WITH at build time.
 */
export const navDashes = () => deployed().map((d) => [d.id, d.label]);

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
    data_source: { type: 'esql', query: nullSafe(q) },
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

/**
 * MAGNITUDE in Vega (heatmap, matrix and punchcard cells, gantt bars, choropleth countries): a COLOUR
 * ramp across four mid-tone suite hues, never a one-hue opacity ramp. The opacity ramp it replaces
 * (`#3987e5` at 0.35–1) held ≥1.5:1 against both backgrounds, but on the dark theme every step from 10
 * to 100k sat between 2.0:1 and 4.7:1 of the same blue, and the round-4 review could not tell 1 from
 * 1k from 100k on 01's credential matrix, 02's object × verb heatmap or 03's index matrix. Hue does not
 * depend on the background: teal → blue → purple → pink reads in both themes, every stop is ≥2.5:1 on
 * white and ≥4.3:1 on the dark panel (#111C2C), and no stop is a severity colour's yellow or red.
 *
 *   "scale": {"type": "log", "range": MAGNITUDE_RAMP, "interpolate": "hcl"}   — no `nice`, no
 *   `domainMin`: the domain is the data's own extent, so the ramp spans what is drawn (a 1h matrix of
 *   100–2k uses all four hues; a domain stretched to 1–10M left real cells two shades apart). A
 *   gradient legend then covers exactly the drawn range. layout.mjs rejects an opacity/fillOpacity
 *   magnitude scale and any other hex range on a log colour scale.
 */
export const MAGNITUDE_RAMP = ['#54B399', '#6092C0', '#9170B8', '#D36086'];
/** Severity, a second quantity on the same mark (treemap, rare-event scatter): monotone in meaning. */
export const SEVERITY_RAMP = ['#54B399', '#D6BF57', '#E7664C'];

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
 * The two audit sources by name, for any panel that splits by service.name. Apply
 * after a STATS grouped on `source = service.name`: "serverless-" spends eleven
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
    type: kind, data_source: { type: 'esql', query: nullSafe(q) },
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
 * user.email, which is `flattened` and answers term/match_phrase correctly
 * (verified: filter and native WHERE return the same count for the same identity).
 */
/**
 * HEADERS AND WIDTHS. A column's header is its `label`, which the 9.6 Dashboards API accepts on
 * every row and metric and stores as the Lens column's customLabel. It changes the header ONLY:
 * the column still reads `fieldName`, so a click_filter column labelled "Email" still pins
 * `user.email: …` — verified by clicking a labelled cell on a live dashboard. That is
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
  'user.email': C('Email'), 'user.name': C('User'), user: C('User'), owner: C('Owner'),
  api_key: C('API key'), 'api_key.name': C('API key'), key_id: C('Key ID'), 'api_key.id': C('Key ID'),
  credential: C('Credential', W.ENUM),
  // what
  action: C('Action'), 'event.action': C('Action'), 'elasticsearch.audit.action': C('Transport action'),
  verb: C('Operation', W.ENUM), result: C('Result', W.ENUM), 'event.outcome': C('Outcome', W.ENUM),
  change: C('Change'), request: C('Request'), execution: C('Execution', W.ENUM), weight: C('Weight', W.COUNT),
  // on what
  name: C('Name'), type: C('Type'), obj_name: C('Object'), obj_type: C('Object type'), kind: C('Kind'),
  index: C('Index'), 'elasticsearch.audit.indices': C('Index'),
  space: C('Space', W.ENUM), 'kibana.space.id': C('Space', W.ENUM),
  'kibana.saved_object.name': C('Object'), 'kibana.saved_object.type': C('Object type'),
  source: C('Source'), 'service.name': C('Source'),
  'kibana.session.id': C('Session'), 'body.text': C('Message'), 'elasticsearch.audit.security_config_change': C('Change'),
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
 * (`kibana.saved_object.type` → "Type"); snake_case becomes words; the first word is
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
 *
 * Re-measured 2026-10-14 on the production renders the round-4 review read (06 Noisiest transport
 * actions, h=12, light 24h, 1920px): rows start 57px below the panel top, ten 24px rows end 22px
 * above the grid's bottom rule, so an eleventh would be cut by 2px. The model is right, and every
 * deployed LIMIT already equals fitRows(h). What the review saw as "rows silently hidden" was the
 * remainder — up to one row-height of blank under the last row — on a list whose TITLE did not say it
 * was cut: "Top transport actions" over 9 rows beside a tile reading 12 reads as a complete list. So
 * the cut is now stated in the title (CUT below), and the blank strip reads as the end of a top-N.
 */
export const fitRows = (h) => Math.max(1, Math.floor((28 * h - 76) / 24));

/**
 * CUT. Every LIMITed table says in its title that the list is cut, as an UPPER BOUND that is true at any
 * row count: " · top 10 at most", or " · newest 10 at most" when the LIMIT follows a SORT on a time column
 * DESC (the Discover sessions already say "newest 1,000 at most"). A title that already names the order
 * ("Top transport actions", "Latest high-value object access", "… most recent …") gets only the bound:
 * "Top transport actions · 13 at most". A title that names its own bound ("· up to 100", "10 at most")
 * is left alone.
 *
 * Round 4 wrote the bare count instead ("Top 13 transport actions", "Busiest object types · top 9"), and
 * a count is a promise: the 1h render had 11 actions and 8 types under those titles, and "Top 14 index
 * families" sat over 2 rows (three blockers in the round-5 review). A bare count is now rejected here at
 * build and by --lint (layout.mjs BOUNDED): a number in a title must read as a bound.
 *
 * No instructions and no window-specific caveats in a title: it is shown at every time range and row
 * count, so "· scroll" over a table with nothing to scroll, or "(may be empty at 1h)" over 774 rows at
 * 24h, is false there. A table that holds more rows than fit — `{ scroll: true }` with a LIMIT above
 * fitRows(h), or `{ wrap: true }` — says so in its DESCRIPTION (SCROLL_NOTE, appended by table() unless the
 * description already says "scroll").
 * `{ cut: false }` opts out for a table whose rows are a closed set (a breakdown with a fixed number of
 * classes, or a guard LIMIT the title already words as "every …").
 */
const TIME_COLS = 'last_seen|last_ts|last_change|first_seen|latest|@timestamp|time|ts';
/** The row cap a table's output carries: the last LIMIT with no STATS after it. */
export const tableLimit = (q) => {
  const all = [...q.matchAll(/\|\s*LIMIT\s+(\d+)/gi)];
  const last = all[all.length - 1];
  if (!last || /\|\s*STATS\b/i.test(q.slice(last.index))) return undefined;
  return Number(last[1]);
};
/** "latest" when the last SORT before the row cap leads with a time column, DESC; "top" otherwise. */
export const cutWord = (q) => {
  const head = q.slice(0, q.search(/\|\s*LIMIT\s+\d+(?![\s\S]*\|\s*LIMIT\s)/i));
  const sorts = [...head.matchAll(/\|\s*SORT\s+`?([\w@.]+)`?\s+(DESC|ASC)?/gi)];
  const last = sorts[sorts.length - 1];
  return last && new RegExp(`^(${TIME_COLS})$`, 'i').test(last[1]) && /desc/i.test(last[2] || '') ? 'latest' : 'top';
};
/** 1000 -> "1,000", the form the titles and Lens print counts in. */
const fmtN = (n) => Number(n).toLocaleString('en-US');
/**
 * A number in a title read as an upper bound — "up to 10", "10 at most", "1,000 at most" — rather than a
 * count. BOUNDED(n) tests for that bound on n; BARE_COUNT finds a count stated after an order word
 * ("top 10", "latest 9", "newest 1,000", "first 100", "the 30 most recent"), which is a promise the
 * rows break whenever the window holds fewer.
 */
export const BOUNDED = (n) => new RegExp(`(\\bup to ${fmtN(n)}(?![\\d,])|(^|[^\\d,.])${fmtN(n)} at most\\b)`, 'i');
export const BARE_COUNT = /\b(top|latest|newest|first|busiest|the)\s+(\d(?:[\d,]*\d)?)(?![\d,])(?!\s+at most)/i;
const ORDER_WORDS = { top: /\btop\b/i, latest: /\b(latest|newest|most recent)\b/i };
export const withCut = (title, q, { cut = true } = {}) => {
  const n = tableLimit(q);
  if (!n || cut === false) return title;
  if (BOUNDED(n).test(title)) return title;
  if (BARE_COUNT.test(title)) {
    throw new Error(`table "${title}": a count in a title is a promise the rows break when the window holds fewer — drop it and let table() append "· ${n} at most", or write "up to ${n}"`);
  }
  const word = cutWord(q);
  return ORDER_WORDS[word].test(title) ? `${title} · ${fmtN(n)} at most` : `${title} · ${word === 'latest' ? 'newest' : 'top'} ${fmtN(n)} at most`;
};
/** The description sentence a table that holds more rows than it shows ends with. */
export const SCROLL_NOTE = 'Scroll for more.';
const withScrollNote = (desc, scrolls) => (scrolls && !/\bscroll\b/i.test(desc || '') ? `${desc || ''} ${SCROLL_NOTE}`.trim() : desc);

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
 * `scroll` keeps the authored LIMIT even when it exceeds the visible rows — for a feed whose bound is
 * the point ("· 30 at most", scroll for the rest; the description says so). Otherwise a trailing
 * `| LIMIT n` is SET to fitRows(h), raised or lowered, so the LIMIT is always exactly the rows the panel
 * shows: the query never fetches rows nobody can see, and the title's bound is never smaller than the
 * room the panel has. Author the LIMIT as fitRows(h) so the source reads true. `wrap` implies scroll,
 * since auto-height rows make the count unknowable.
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
 * An identity that reads as a 20-character id is ACTOR_RESOLVE's last resort, not a defect. Until 1.0.5 a sentence
 * saying so (OPAQUE_ID_NOTE) was appended to every tooltip that showed an identity, 42 words each time; it now
 * lives once, in Command Center's suite legend, in each dashboard's How to read block and in the README
 * (TOOLTIPS, below), so a tooltip stays within TIP_MAX_WORDS.
 */

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
 * So the meaning of an empty panel goes in its TITLE, the one text a reader sees with the panel — and
 * because the title shows whether or not there are rows, its words must be TRUE EITHER WAY. Round 3
 * appended "· none is good" and "· empty without X", which read as a verdict on the rows beneath them
 * whenever the table was full ("Failures by identity · none is good" over eight failures). The words are
 * now a parenthetical CONDITION, which a full table does not contradict:
 *
 *   { empty: 'good' }    "Denied requests · top 7 at most (empty = good)"
 *   { empty: 'empty when no browser sessions' }   your own words, which must start "empty when",
 *                        "empty if", "empty without" or "empty unless" — a condition, never a status
 *   { empty: 'quiet' }   "(empty when none in range)", and "Often empty over the default hour …" in the
 *                        description. Its old title words, "(may be empty at 1h)", named one window and
 *                        so read as wrong on every other: over 774 rows at 24h, and over 1 row at 1h
 *                        (round-5 review of 03, 04 and 07). Dropping them altogether left 03's two
 *                        system-index panels a bare "No results found" at 1h, so the condition stays,
 *                        worded for every window.
 *
 * The title carries the meaning alone: the description gains no sentence (1.0.5 — it repeated the title and
 * pushed tooltips past TIP_MAX_WORDS). Use it on every table or session that a verify render at 1h (still one
 * click away in the picker) shows empty on a healthy project. Keep the words short: they share the title line.
 */
export const EMPTY = {
  good: { title: '(empty = good)' },
  quiet: { title: '(empty when none in range)' },
};
export const EMPTY_CONDITION = /^empty (when|if|without|unless) \S/;
const emptyOf = (empty) => {
  if (EMPTY[empty]) return EMPTY[empty];
  if (!EMPTY_CONDITION.test(empty)) {
    throw new Error(`{ empty: "${empty}" } must be 'good', 'quiet', or a condition starting "empty when/if/without/unless …" — it is shown whether or not the panel has rows`);
  }
  return { title: `(${empty})` };
};
const withEmptyTitle = (title, empty) => (empty && emptyOf(empty).title ? `${title} ${emptyOf(empty).title}` : title);

/**
 * COMPLETENESS. A table whose trailing LIMIT is clamped to fitRows() shows the top rows only, so a
 * title that promises every row ("Every address they used", "everything that scored") is false as
 * soon as the data outgrows the panel. layout.mjs fails a LIMITed table whose title says every,
 * everything or all, unless it is { scroll: true } (and then the LIMIT itself is the promise). The
 * in-memory `lint` annotation carries what the check needs; dashboards.mjs strips it from the payload.
 */
export const table = (x, y, w, h, title, q, rows, metrics, desc, { scroll = false, wrap = false, empty, cut = true } = {}) => {
  let query = q;
  if (!scroll && !wrap) {
    // Exactly the rows that fit, in both directions: above it rows hide with no cue, below it the title's
    // bound ("top 10 at most") sits over a panel that had room for 12 (06 Busiest named API keys).
    query = q.replace(/\|\s*LIMIT\s+(\d+)\s*$/i, () => `| LIMIT ${fitRows(h)}`);
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
  const limit = tableLimit(query);
  // The Cloud API key display form (ACTOR_LABEL), on the rows the table shows — after the LIMIT, so it
  // runs on at most a screenful of rows and never before a STATS BY actor.
  if (r.some((c) => c.column === 'actor')) query = `${query} | ${ACTOR_LABEL}`;
  return {
    type: 'vis', id: nid('tbl'), grid: { x, y, w, h }, ...(fits ? {} : { narrow1440: true }),
    lint: { limit, scroll: scroll || wrap, wrap, cut, ...(empty ? { empty } : {}) },
    config: {
      title: withEmptyTitle(withCut(title, query, { cut }), empty),
      description: withScrollNote(desc, wrap || (scroll && limit > fitRows(h))),
      type: 'data_table',
      data_source: { type: 'esql', query: nullSafe(query) },
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
    data_source: { type: 'esql', query: nullSafe(q) },
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
    data_source: { type: 'esql', query: nullSafe(q) },
    region: { column: regionCol }, metric: { column: metricCol },
  },
});

/**
 * FIXED-WINDOW VEGA (1.0.5.1). A Vega chart that must ignore the time picker (Actor 360's "Is this normal?"
 * row over 7 days, the 24-hour session timeline) is an ES|QL spec bounded by TIME, so it follows the identity
 * dropdowns, on a panel with its own time range. Kibana sends that range as ?_tstart/?_tend and as the hidden
 * range filter, and badges the panel with it ("Last 7 days"; a viewer can click the badge to change it).
 *
 * This table is the one place such a window is declared: vega() puts it on every panel showing the spec, and
 * --lint (esql.mjs) and --perf run the spec's queries over it instead of the picker's window, so the panel and
 * its checks cannot drift. layout.mjs fails a panel range that is not this table's, and a listed spec that is
 * not ES|QL bounded by TIME. Only `now-<n><m|h|d>` → `now` (windowMs()).
 *
 * The hourly charts (08, 09) take "now-7d", not the DSL's "now-167h/h": a rounded range badges as "Last 167
 * hours rounded to the hour", ~235px of title. They count BY DATE_TRUNC(1 hour) and keep the 168 hours ending
 * with the one now filling (HOUR_AGO, `ago` 0–167): the same cells as the DSL histogram, to the event.
 */
export const VEGA_WINDOWS = {
  '08-actor-baseline-band': { from: 'now-7d', to: 'now' },
  '09-activity-punchcard': { from: 'now-7d', to: 'now' },
  '12-actor-cohort': { from: 'now-7d', to: 'now' },
  '13-session-gantt': { from: 'now-24h', to: 'now' },
};
const WINDOW_UNIT = { m: 60e3, h: 3600e3, d: 864e5 };
/** A VEGA_WINDOWS range's length in ms. Throws on a shape Kibana and the linters could read differently. */
export const windowMs = ({ from, to }) => {
  const m = /^now-(\d+)([mhd])$/.exec(from);
  if (!m || to !== 'now') throw new Error(`fixed window ${JSON.stringify({ from, to })}: use { from: 'now-<n><m|h|d>', to: 'now' }`);
  return Number(m[1]) * WINDOW_UNIT[m[2]];
};
/** The VEGA_WINDOWS entry for a spec path or ref ('vega/08-….json' or '08-…'), or undefined. */
export const fixedWindow = (src) => VEGA_WINDOWS[String(src).replace(/^vega\//, '').replace(/\.json$/, '')];
/**
 * An hourly fixed-window spec's hour, counted back from the one now filling (0) to the first of the seven
 * days (167). Evaluated on grouped rows, after `STATS … BY hour = DATE_TRUNC(1 hour, @timestamp)`.
 */
export const HOUR_AGO = 'ago = DATE_DIFF("hour", hour, DATE_TRUNC(1 hour, TO_DATETIME(?_tend)))';

/** Vega panels are legacy `visualization` saved objects; see dashboards.mjs repointVega(). */
export const vega = (x, y, w, h, ref, title, desc) => {
  const config = { ref_id: objId('vega', ref), title, description: desc };
  if (VEGA_WINDOWS[ref]) config.time_range = { ...VEGA_WINDOWS[ref] };
  return { type: 'vis', id: nid('vega'), grid: { x, y, w, h }, config };
};

/**
 * PREVIOUS-PERIOD TILES (1.0.5; ES|QL since 1.0.5.1). A headline count with a second line comparing it with
 * the period of the same length just before the range: "▲ 34% vs prior 24h". Each is a Vega spec drawn to
 * look like the Lens metric tiles beside it — title top left at 16px/500, the number bottom right at 36px/500,
 * the comparison right-aligned above it at 16px, the sizes and offsets read off a rendered Lens metric — with
 * theme colours from the guide-title / guide-label styles.
 *
 * WHY A VIEW. A Lens or Vega ES|QL request gets a hidden range filter for exactly the picker's window (THE
 * HIDDEN LENS TIME FILTER, above): Kibana asks /internal/esql/get_timefield which column to filter, and the
 * answer is the column the query compares bare with ?_tstart/?_tend, else @timestamp if the source has one.
 * So no ES|QL panel on the stream can count the period before the picker. These tiles read THE EVENTS VIEW
 * instead (EVENTS_VIEW_QUERY: the stream with @timestamp renamed to event_time, created by --objects), which
 * has no @timestamp, so no filter is attached and the query bounds its own window. That behaviour follows a
 * Kibana code comment, not documentation, so three guards hold it:
 *   - the query never compares a column bare with ?_tstart/?_tend (always TO_DATETIME(...)), never BUCKETs on
 *     them, never sets %timefield% and names no column `first` (ES|QL reserved word). layout.mjs fails a spec
 *     on the view that does (ESCAPE RULES), and `--lint` asks get_timefield for each tile's query and fails
 *     if Kibana would now attach a filter;
 *   - `--verify` captures the tiles' esql_async requests and fails if one carries a range filter, or if a
 *     prior count reads 0 where the stream has events (the canary for a Kibana change);
 *   - `--lint` parity: each tile's current AND prior counts must equal prevEsql(key), the plain TIME-bounded
 *     count on the stream, over the same two windows, with the dropdowns empty and with AUDIT_IDENTITY set.
 *
 * The query (prevQuery) reads (2·start − end, end], the prior and current windows together, with the same
 * open-start, closed-end bounds as TIME, and splits them with STATS … WHERE. It carries IDENTITY_WHERE, so
 * both counts follow the Identity type and Identity dropdowns; `%context%` brings the pills, KQL and the
 * Project and Client IP controls, whose filters run on the stream's raw fields under the view. It also caps
 * the read at PREV_LOOKBACK_DAYS: without that a 30-day picker would scan 60 days on every load.
 *
 * The second dataset (prevStreamQuery, `stream`) finds the first event of that lookback with no %context%
 * and no dropdowns — the stream's, whatever is selected. When the previous period starts before it the line
 * reads "no full prior 24h" instead of a rise against a period the stream was not recording. ≥10× prints as
 * "▲ 12×". "prior", not "previous": an 8-column tile at 1440px holds ~20 characters, and "▲ 418× vs
 * previous 1h" was cut to "previous …" (rendered).
 *
 * The specs (vega/15-prev-*.json) are generated from this table by writeTileSpecs(); never edit them by
 * hand — `npm test` fails when a file and the table disagree. `esql` is the tile's ES|QL WHERE (empty for
 * every event). Only plain filters are tiles: NOISE, RISK and COUNT_DISTINCT tiles stay Lens, whose hidden
 * filter they cannot escape without the same work. Measured live (1.0.5.1, ~3M events): 50–210ms per tile
 * from 1h to 7d, ~40ms with a person selected; the stream dataset ~30ms.
 */
export const PREV_LOOKBACK_DAYS = 15;
export const PREV_TILES = {
  'total-events': { title: 'Total events · all traffic', esql: '' },
  'failed-events': { title: 'Failed events · all traffic', esql: 'WHERE event.outcome == "failure" OR event.action == "anonymous_access_denied"' },
  'es-events': { title: 'Elasticsearch events', esql: ESS },
  'esql-queries': { title: 'ES|QL queries', esql: 'WHERE elasticsearch.audit.action == "indices:data/read/esql"' },
  'access-denied': { title: 'Access denied', esql: 'WHERE event.action == "access_denied" OR event.action == "anonymous_access_denied"' },
  'kibana-events': { title: 'Kibana events', esql: KIB },
};
export const prevRef = (key) => `15-prev-${key}`;

/** THE EVENTS VIEW's time column and its definition over a stream (env.mjs DEFAULT_VIEW, objects.mjs). */
export const VIEW_TIME = 'event_time';
export const EVENTS_VIEW_QUERY = (stream = cfg.dataStream) => `FROM ${stream} | RENAME @timestamp AS ${VIEW_TIME}`;
/** The picker's bounds, always wrapped: a bare `event_time > ?_tstart` makes Kibana filter event_time to the picker. */
const T_START = 'TO_DATETIME(?_tstart)';
const T_END = 'TO_DATETIME(?_tend)';
const PRIOR_START = `TO_DATETIME(2 * TO_LONG(${T_START}) - TO_LONG(${T_END}))`;

/** A tile's query: current and prior counts, and the window's bounds in ms (s, e) for the second line. */
export const prevQuery = (key, view = DEFAULT_VIEW) => {
  const t = PREV_TILES[key];
  if (!t) throw new Error(`no previous-period tile "${key}"`);
  return nullSafe(`FROM ${view} | WHERE ${VIEW_TIME} <= ${T_END} AND ${VIEW_TIME} > ${PRIOR_START}`
    + ` AND ${VIEW_TIME} >= NOW() - ${PREV_LOOKBACK_DAYS} days AND ${IDENTITY_WHERE}${t.esql ? ` | ${t.esql}` : ''}`
    + ` | STATS cur = COUNT(*) WHERE ${VIEW_TIME} > ${T_START}, prev = COUNT(*) WHERE ${VIEW_TIME} <= ${T_START}`
    + ` | EVAL s = TO_LONG(${T_START}), e = TO_LONG(${T_END})`);
};
/** The first event inside the lookback, of the whole stream: no context, no dropdowns. */
export const prevStreamQuery = (view = DEFAULT_VIEW) =>
  `FROM ${view} | WHERE ${VIEW_TIME} >= NOW() - ${PREV_LOOKBACK_DAYS} days | STATS t0 = MIN(${VIEW_TIME}) | EVAL t0 = TO_LONG(t0)`;
/** The plain TIME-bounded count on the stream that a tile's current and prior numbers must equal (--lint parity). */
export const prevEsql = (key) => `FROM ${IDX} | ${TIME}${PREV_TILES[key].esql ? ` | ${PREV_TILES[key].esql}` : ''} | STATS n = COUNT(*)`;

/** The metric tile's look, shared by the previous-period and data coverage specs. */
// Lens' own stack for a metric (computed style, 1.0.5): "Elastic UI Numeric" covers digits and a few
// marks in a monospaced face with a slashed zero, and the letters fall through to Inter — on a canvas
// exactly as in Lens, so "101,329" and "ES|QL" print as they do in the tiles beside these.
const TILE_FONT = '"Elastic UI Numeric", Inter, system-ui, sans-serif';
const tileText = (name, style, size, update) => ({
  type: 'text', name, style, from: { data: 'tile' },
  encode: { enter: { font: { value: TILE_FONT }, fontSize: { value: size }, fontWeight: { value: 500 } }, update },
});
/**
 * Offsets measured on a rendered Lens metric at 1920 and 1440 (1.0.5): the title's line box starts 16px
 * in from the panel's top-left, the number's 43px line box ends 16px above the bottom, and the secondary
 * line's 19px box ends 4px above the number. Kibana insets a Vega view 8px inside its panel, hence
 * TILE_PAD 8; the y offsets were then nudged until the glyph rows matched a Lens tile's to the pixel in
 * both themes at 1920 and 1440. What cannot match is the colour: Kibana gives every Vega guide style the
 * theme's subdued text colour (measured: rgb(152,168,195) dark, rgb(81,99,129) light, the same for
 * guide-title, guide-label, group-title and titles), where a Lens metric prints its title and number in
 * the full text colour, and a spec has no way to read the theme. So these tiles' words are a step
 * softer than their neighbours'; the README themes row is why they stay on the theme styles.
 */
export const tileMarks = (title, { bottomLeft = false } = {}) => [
  tileText('title', 'guide-title', 16, { x: { signal: 'pad' }, y: { signal: 'pad + 2.5' }, baseline: { value: 'top' }, text: { value: title }, limit: { signal: 'width - 2 * pad' } }),
  tileText('value', 'guide-title', 36, { x: { signal: 'width - pad' }, y: { signal: 'height - pad - 36.6' }, align: { value: 'right' }, baseline: { value: 'top' }, text: { field: 'value' } }),
  tileText('detail', 'guide-label', 16, { x: { signal: 'width - pad' }, y: { signal: 'height - pad - 63.3' }, align: { value: 'right' }, baseline: { value: 'top' }, text: { field: 'detail' }, limit: { signal: 'width - 2 * pad' } }),
  ...(bottomLeft ? [tileText('note', 'guide-label', 14, { x: { signal: 'pad' }, y: { signal: 'height - pad - 12' }, baseline: { value: 'alphabetic' }, text: { field: 'note' }, limit: { signal: 'width - 2 * pad - 140' } })] : []),
];
export const TILE_PAD = 8;

/**
 * The window's length as the line prints it: minutes under 55m, hours under 47.5h, days after. The
 * dashboards end their range a minute ago (TIME_TO), so "Last 1 hour" is a 59-minute window and must
 * still read "1h", and "Last 24 hours" 23h59m reads "24h".
 */
const SPAN = "(datum.len < 3300 ? round(datum.len / 60) + 'm' : datum.len < 171000 ? round(datum.len / 3600) + 'h' : round(datum.len / 86400) + 'd')";
const PREV_LINE =
  "!datum.full ? 'no full prior ' + datum.span"
  + " : datum.prev === 0 ? (datum.cur === 0 ? '0 in prior ' + datum.span + ' too' : 'none in prior ' + datum.span)"
  + " : datum.cur >= 10 * datum.prev ? '▲ ' + round(datum.cur / datum.prev) + '× vs prior ' + datum.span"
  + " : datum.cur === datum.prev ? 'same as prior ' + datum.span"
  + " : (datum.cur > datum.prev ? '▲ ' : '▼ ') + (abs(datum.pct) < 1 ? '<1' : abs(datum.pct)) + '% vs prior ' + datum.span";

export const prevSpec = (key) => {
  const t = PREV_TILES[key];
  if (!t) throw new Error(`no previous-period tile "${key}"`);
  return {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    description: `${t.title}, with the change against the previous period of the same length. Generated from PREV_TILES in scripts/lib/panels.mjs: do not edit.`,
    autosize: { type: 'fit', contains: 'padding' },
    padding: 0,
    signals: [
      { name: 'pad', value: TILE_PAD },
      { name: 'lookbackMs', value: PREV_LOOKBACK_DAYS * 864e5 },
      // The stream's first event in the lookback, in ms; null on an empty stream (the column is then dropped).
      { name: 't0', value: null, update: "length(data('stream')) && isValid(data('stream')[0].t0) ? data('stream')[0].t0 : null" },
    ],
    data: [
      { name: 'stream', url: { '%type%': 'esql', query: prevStreamQuery() } },
      {
        name: 'tile',
        url: { '%type%': 'esql', '%context%': true, query: prevQuery(key) },
        transform: [
          { type: 'formula', as: 'len', expr: '(datum.e - datum.s) / 1000' },
          { type: 'formula', as: 'span', expr: SPAN },
          { type: 'formula', as: 'full', expr: 'isValid(t0) && datum.s - datum.len * 1000 >= max(t0, now() - lookbackMs)' },
          { type: 'formula', as: 'pct', expr: 'datum.prev > 0 ? round((datum.cur - datum.prev) * 100 / datum.prev) : 0' },
          { type: 'formula', as: 'value', expr: "format(datum.cur, ',d')" },
          { type: 'formula', as: 'detail', expr: PREV_LINE },
        ],
      },
    ],
    marks: tileMarks(t.title),
  };
};

/**
 * A previous-period tile on a dashboard. The panel has no title, like the Lens metrics beside it: the
 * spec draws its own. `desc` is the tile's tooltip, and PREV_NOTE is appended to it (the line's forms —
 * ▲/▼, ×, "no full prior …" — are in the README, Prior-period tiles).
 */
export const PREV_NOTE = 'The line above the number compares it with the prior period of the same length.';
export const prevKpi = (x, y, w, h, key, desc) => {
  if (!PREV_TILES[key]) throw new Error(`no previous-period tile "${key}"`);
  return vega(x, y, w, h, prevRef(key), '', `${desc} ${PREV_NOTE}`);
};

/**
 * DATA COVERAGE (vega/14, 1.0.5): how far back the audit stream goes. The first event is read live — a
 * date written at deploy time would be a day stale tomorrow — by a DSL min/max with no %timefield% and
 * none of the %dashboard_context% placeholders, so it describes the whole stream whatever the picker and
 * the pills say (layout.mjs, WHOLE_STREAM_SPECS). Lens could not: its hidden time filter would make the
 * "first event" the picker's start. Retention can only come from the lifecycle API, which Vega cannot
 * call, so it is the `retention` signal, set when --objects deploys the spec (retentionText()).
 */
export const COVERAGE_REF = '14-data-coverage';
export const COVERAGE_TITLE = 'Audit data held';
export const COVERAGE_DEFAULT_RETENTION = 'Retention not checked';
export const coverageSpec = () => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  description: 'How far back the audit stream goes: its first event and the days since, with the retention set on the data stream when the suite was installed. Generated by coverageSpec() in scripts/lib/panels.mjs: do not edit.',
  autosize: { type: 'fit', contains: 'padding' },
  padding: 0,
  signals: [{ name: 'pad', value: TILE_PAD }, { name: 'retention', value: COVERAGE_DEFAULT_RETENTION }],
  data: [{
    name: 'tile',
    url: {
      index: DEFAULT_STREAM,
      body: {
        size: 0, track_total_hits: false,
        query: { bool: { filter: [{ range: { '@timestamp': { gte: 'now-100y', lte: 'now' } } }] } },
        aggs: { first: { min: { field: '@timestamp' } }, last: { max: { field: '@timestamp' } } },
      },
    },
    format: { property: 'aggregations' },
    transform: [
      { type: 'formula', as: 't0', expr: 'datum.first.value' },
      { type: 'formula', as: 'days', expr: 'isValid(datum.t0) ? (datum.last.value - datum.t0) / 864e5 : 0' },
      { type: 'formula', as: 'value', expr: "!isValid(datum.t0) ? 'none yet' : datum.days < 1 ? format(datum.days * 24, '.1f') + ' hours' : format(datum.days, '.1f') + ' days'" },
      { type: 'formula', as: 'detail', expr: "isValid(datum.t0) ? 'since ' + timeFormat(datum.t0, '%b %-d, %Y @ %H:%M') : ''" },
      { type: 'formula', as: 'note', expr: 'retention' },
    ],
  }],
  marks: tileMarks(COVERAGE_TITLE, { bottomLeft: true }),
});

/**
 * The retention line, from `GET _data_stream/<stream>/_lifecycle?include_defaults=true`: the effective
 * retention when the project sets one (the stream's own data_retention, or the project's global default),
 * otherwise "No retention limit set" — the case on this project in 1.0.5, where only the failure store
 * has a 30-day default. A stream not managed by a data stream lifecycle names no retention here at all.
 */
export const retentionText = (res) => {
  const ds = res?.data_streams?.[0];
  if (!ds) return COVERAGE_DEFAULT_RETENTION;
  const lc = ds.lifecycle;
  if (!lc || lc.enabled === false) return 'Retention set outside the data stream';
  const r = lc.effective_retention || lc.data_retention || res.global_retention?.default_retention;
  if (!r) return 'No retention limit set';
  const m = /^(\d+)([dh])$/.exec(r);
  if (!m) return `Kept for ${r}`;
  const n = Number(m[1]), unit = m[2] === 'd' ? 'day' : 'hour';
  return `Kept for ${n} ${unit}${n === 1 ? '' : 's'}`;
};

/** The generated specs: every previous-period tile and the coverage tile, keyed by vega/ file name. */
export const tileSpecs = () => ({
  ...Object.fromEntries(Object.keys(PREV_TILES).map((key) => [prevRef(key), prevSpec(key)])),
  [COVERAGE_REF]: coverageSpec(),
});
export const writeTileSpecs = () => {
  for (const [name, spec] of Object.entries(tileSpecs())) {
    writeFileSync(join(ROOT, 'vega', `${name}.json`), JSON.stringify(spec, null, 2) + '\n');
  }
};

/**
 * RECORD FEEDS (1.0.5.1). Every record-level list on a dashboard is a Lens ES|QL table built with table(), not a
 * Discover session panel: a Discover panel takes no ES|QL control variables, so it ignored the Identity type and
 * Identity dropdowns (controls.mjs) while every panel around it followed them. A feed is
 *
 *   FROM … | TIME | <filter> | SORT @timestamp DESC | LIMIT n | <per-row EVALs> | KEEP …
 *
 * TIME carries IDENTITY_WHERE, so the dropdowns narrow it. The SORT and LIMIT come straight after the filter
 * (QUERY SHAPE rule 3), so a classifying CASE runs on the n rows returned, never on every row matched. The time
 * is a metric column (`@timestamp`, "Time"), because a Lens data_table with no metric is rejected by the API;
 * it therefore sits at the right end, as Last seen does on every other table. `{ scroll: true }` keeps the
 * title's bound ("· newest 1,000 at most") and the description says "Scroll for more." Raw fields shown as they
 * are (Action, Client IP, Space, a session id) are click-to-filter; computed columns never are.
 * searches/*.json still deploy: the intros' "Raw records" links open two of them in Discover, and the rest stay
 * available there.
 */

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
 * INTRO TEXT (1.0.3, the human's format). Every dashboard opens with a customer-facing intro directly under
 * the navigation strip, and Command Center's "How to read this suite" box reads the same way: a normal
 * markdown heading INSIDE the panel (`###`, no trailing period, no panel title over it), then the body as
 * compact small text, one source line per paragraph.
 *
 * The 9.6 markdown panel cannot do small text. It renders through EuiMarkdownFormat, which has no size
 * setting through the API and SANITISES raw HTML: a `<style>` block or a `<div class>` is dropped before
 * render (probed on r103f: no style element reaches the page, and the h3 and paragraphs come through
 * bare, at 20px and 16px). So was CSS_NAV, the style block Command Center's legend carried for the
 * navigation strip until 1.0.3: it never reached the page, and it is gone. The legacy markdown
 * visualization does have a size: its `fontSize` (pt) sets the body, and its heading keeps a heading's size
 * (probed: fontSize 9 → paragraphs 12px on an 18px line, `###` 17px, 14px between paragraphs, theme
 * colours in both themes). So an intro is authored and PUT as a plain markdown panel, which is what
 * dashboards/*.json shows and what anything that skips the post-pass still renders, and the post-pass in
 * scripts/dashboards.mjs (smallMarkdown) swaps it for a by-value legacy markdown visualization at
 * INTRO_PT, title hidden — the same _export → mutate → _import route that re-points Vega. The legacy
 * renderer escapes HTML, so an intro carries none.
 *
 * HEIGHT is measured, not estimated: a 48-column intro at fontSize 9 is ~151px for a 37px heading and three
 * one-line paragraphs, so h=6 (160px) holds it at 1920 and at 1440 (a paragraph stays on one line up to ~220
 * visible characters at 1440: 02's 215- and 220-character paragraphs did, measured in 1.0.5, with 25px left
 * under the text as on every other intro). A paragraph that wraps at 1440 costs 18px; 07, two paragraphs with
 * one that wraps, is h=6 (137px). A link's URL does not count, only its words. Probe with `AUDIT_VERIFY_WIDTH=1440` after any copy change:
 * a panel that is too short shows a scrollbar, and the layout check cannot see it.
 *
 * `headed: true` is an in-memory annotation: the layout check allows the heading there and nowhere else,
 * the post-pass finds the panel by it, and the API payload strips it.
 *
 * HOW TO READ (1.0.5). A dashboard's `intro.howTo` is at most HOW_TO_MAX one-line bullets (~100 words in all):
 * the page-wide caveats a reader needs before trusting a number (what the noise gate drops, which panels ignore
 * the picker, why two panels can differ by an event), which used to be repeated inside every tooltip. They are
 * NOT in the intro: dash() puts them in a collapsed section titled "How to read this page" directly under it
 * (howToSection(), see SECTIONS below), so the intro stays at its own measured height and a reader opens the
 * list when they want it. Inside the section is one full-width small-text panel (the same legacy markdown
 * visualization as the intro, `small: true`), bullets only — the section header is the heading. A tight list is
 * 18px a line with no gap between items; each bullet stays on one line at 1440px (under ~200 characters) or
 * costs 18px. HOW_TO_ROWS(n) holds n bullets with ~25px to spare at 1920 and 1440, measured on rc105.
 *
 * TOOLTIPS (1.0.5): two tiers. A panel's description (its ⓘ tooltip) says what the panel shows and the one
 * thing needed to read it, in at most TIP_MAX_WORDS words (layout.mjs) — including anything a builder appends
 * (SCROLL_NOTE, PREV_NOTE). Page-wide caveats go in the dashboard's How to read block; mechanics (field
 * names, exact gate classes, why a count is shaped the way it is) go in the README, *Reading the panels*.
 * Plain words: no ES|QL, no field paths a reader would not type, no release history.
 */
export const INTRO_PT = 9;
/**
 * LINKS TO A DISCOVER SESSION (1.0.5). An intro may link to one of the suite's own Discover sessions as
 * `[words](@search:<ref>)`, `<ref>` a searches/*.json name. introMd() turns it into the relative link
 * `/app/discover#/view/<id>` at build time, with the id through nsId(), so a private deploy
 * (AUDIT_ID_NS) links to its own copy and production to production. Relative, so no Kibana URL is written
 * into dashboards/*.json; the suite installs into the Default space, so no /s/<space> prefix is needed.
 * The legacy markdown visualization renders links (openLinksInNewTab: false keeps Kibana's own tab). An
 * `externalLink` on the nav strip was the alternative: it carries neither the pills nor the time range, the
 * serverless schema for it could not be read, and the strip would wrap at 1440px.
 */
export const discoverUrl = (ref) => {
  if (!existsSync(join(ROOT, 'searches', `${ref}.json`))) throw new Error(`@search:${ref}: no searches/${ref}.json`);
  return `/app/discover#/view/${objId('search', ref)}`;
};
const searchLinks = (text) => text.replace(/\]\(@search:([\w-]+)\)/g, (_, ref) => `](${discoverUrl(ref)})`);
export const HOW_TO_LABEL = 'How to read this page';
export const HOW_TO_MAX = 6;
const plainLines = (what, lines) => {
  if (lines.some((p) => p.includes('\n'))) throw new Error(`${what}: one source line per paragraph or bullet`);
  if (lines.some((p) => /<[a-z/]/i.test(p))) throw new Error(`${what}: no HTML (the legacy renderer escapes it)`);
};
export const introMd = (x, y, w, h, heading, paragraphs) => {
  if (/[.\n]$/.test(heading) || /^#/.test(heading)) throw new Error(`intro heading "${heading}": plain words, no trailing period`);
  plainLines(`intro "${heading}"`, paragraphs);
  const content = `### ${heading}\n\n${paragraphs.map(searchLinks).join('\n\n')}\n`;
  return { type: 'markdown', id: nid('md'), grid: { x, y, w, h }, headed: true, config: { content } };
};

/**
 * SECTIONS (1.0.5). A collapsible section is, in the 9.6 Dashboards API, an ordinary entry of the top-level
 * `panels` array with NO `type` key: { id, title, collapsed, grid: { y }, panels: [...] } (a top-level
 * `sections` key and `type: "section"` are both 400 unrecognized_keys; probed on serverless 9.6). Its inner
 * panels' grid y is relative to the section; top-level panels after it keep their own y, one row below the
 * section's. The saved object stores it differently: the inner panels stay in `panelsJSON` with
 * `gridData.sectionId`, and the header is a separate `sections` attribute ([{ title, collapsed, gridData:
 * { i, y } }]), which the _export → _import post-pass carries through untouched (scripts/dashboards.mjs
 * asserts both survive).
 *
 * In memory a section is { section: true, id, title, collapsed, grid: { x: 0, y, w: 48, h: 1 }, panels }: the
 * full-width one-row grid is the header's place in the top-level grid, so the layout check tessellates it
 * like any panel and lays out its inner panels separately; payload() (scripts/dashboards.mjs) turns it into
 * the API shape. The id comes from the same per-dashboard sequence as every panel id.
 */
export const collapsible = (y, title, inner, { collapsed = true } = {}) =>
  ({ section: true, id: nid('sec'), title, collapsed, grid: { x: 0, y, w: GRID_W, h: 1 }, panels: inner });
/** The top-level panels with every section replaced by its inner panels: what carries content. */
export const flatPanels = (panels) => panels.flatMap((p) => (p.section ? p.panels : [p]));
/** Grid rows for n one-line How to read bullets at INTRO_PT (see HOW TO READ). */
export const HOW_TO_ROWS = (n) => n + 1;
export const howToSection = (y, bullets) => {
  if (!bullets.length) throw new Error('How to read: no bullets');
  if (bullets.length > HOW_TO_MAX) throw new Error(`How to read: ${bullets.length} bullets, ${HOW_TO_MAX} at most`);
  plainLines('How to read', bullets);
  const content = `${bullets.map((b) => `- ${searchLinks(b)}`).join('\n')}\n`;
  const sec = collapsible(y, HOW_TO_LABEL, []);
  sec.panels.push({ type: 'markdown', id: nid('md'), grid: { x: 0, y: 0, w: GRID_W, h: HOW_TO_ROWS(bullets.length) }, small: true, config: { content } });
  return sec;
};

/** The by-value legacy markdown visualization an intro panel becomes (see INTRO TEXT). */
export const smallMarkdown = (content) => ({
  hidePanelTitles: true, enhancements: {},
  savedVis: { id: '', title: '', description: '', type: 'markdown', uiState: {}, data: { aggs: [], searchSource: {} },
    params: { fontSize: INTRO_PT, openLinksInNewTab: false, markdown: content } },
});

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
     * Every deployed dashboard, in the same order on every dashboard. Dropping the current one shifted every
     * link after it, so the bar re-ordered itself depending on where you were. Kibana renders a
     * link to the dashboard you are on as the current item, which doubles as "you are here".
     */
    links: navDashes().map(([d, label]) => ({
      type: 'dashboardLink', destination: nsId(d), label,
      options: { use_filters: true, use_time_range: true, open_in_new_tab: false },
    })),
  },
});


/**
 * Three grid rows (76px): the panel title plus one row of links, with nothing spare. At four the bar
 * carried ~40px of dead space on every dashboard. dash() adds this to every authored y, so it can
 * change without touching any dashboard module.
 */
export const NAV_H = 3;

/**
 * Navigation always goes on top: pin the links bar at y=0 and shift authored panels down.
 *
 * Default range is the last 24 hours (DEFAULT_FROM, 1.0.5; it was 1h until then). 1h was once justified
 * here as a hard limit — "2h, 3h and 4h exceed 60s; 24h exceeds 110s" — and those numbers were real but
 * misattributed. They were taken back to back: a synchronous ES|QL query outlives the client that gave
 * up on it and cannot be cancelled on serverless, so a measurement taken after a timeout may have been
 * sharing the cluster with it. Re-measured on the perf replica, the busiest-identities panel returns in
 * 84–106ms over 24h and ~0.3s over 7 days; what makes a wide window expensive is query shape, not width —
 * see QUERY SHAPE above. A day is the review a viewer opens the suite for: an hour was often empty on a
 * quiet project, and a day gives the previous-period tiles (PREV_TILES) a whole day to compare with.
 * `./audit --lint` times every query, so the cost claim is checked rather than asserted.
 *
 * THE RANGE ENDS AT now-1m (TIME_TO), on every dashboard — the human's decision, round 6. Ending at `now`
 * put the live edge inside every panel: audit events become searchable seconds after they happen (a
 * closed two-minute window kept growing for 5–7s after it closed, measured on 07), each panel reads
 * `now` for itself about a second apart, and this suite's own queries are audited reads, so two numbers
 * side by side differed by whatever landed in between, and a description had to say so. A minute back,
 * nothing in range is still arriving. What is left is the sub-second spread between panels' `now`, at
 * BOTH ends of the range — a few events at most on an all-traffic count, none on anything quieter — which
 * the How to read blocks state where a page sets a total beside its parts. Not rounded (`now-1m/m`): rounding
 * `to` up lands on the minute boundary, which can be under a second behind the clock, inside the window
 * events are still arriving in. verify.mjs renders with the same end, so a render is what viewers see.
 */
export const TIME_TO = 'now-1m';
/**
 * `intro` is the dashboard's customer-facing intro ({ h, heading, paragraphs, howTo }, see INTRO TEXT): full
 * width, directly under the navigation strip, then its `howTo` bullets as a collapsed "How to read this page"
 * section (HOW TO READ, SECTIONS), and every authored panel moves down by the intro's height plus the section
 * header's row, so a module authors its own panels from y=0 and neither changes anything else in it.
 */
export const DEFAULT_FROM = 'now-24h';
export const dash = (id, title, description, panels, { intro, timeFrom = DEFAULT_FROM } = {}) => {
  // Ids in this order (intro, nav, section, its panel) so the intro's and the nav's ids did not move when
  // the How to read list left the intro.
  const top = intro ? [introMd(0, NAV_H, 48, intro.h, intro.heading, intro.paragraphs)] : [];
  const nav = links(0, 0, 48, NAV_H, id);
  const how = intro?.howTo?.length ? [howToSection(NAV_H + intro.h, intro.howTo)] : [];
  const below = NAV_H + (intro ? intro.h : 0) + how.reduce((n, s) => n + s.grid.h, 0);
  return {
    title, description,
    time_range: { from: timeFrom, to: TIME_TO },
    refresh_interval: { pause: true, value: 60000 },
    panels: [nav, ...top, ...how,
             ...panels.map((p) => ({ ...p, grid: { ...p.grid, y: p.grid.y + below } }))],
  };
};
