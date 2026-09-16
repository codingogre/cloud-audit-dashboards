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
 * QUERY SHAPE decides cost far more than window size on the audit stream. Three rules, each measured:
 *
 *   1. Lead with a positive, pushable term; never lead with a negation. NOISE is all negation, and a
 *      negation cannot push down to the index, so it is evaluated per document: on one day,
 *      `== "access_granted"` ran in 3.9s and `NOT (... IN ...)` over a same-sized result took >60s.
 *   2. Group on real keyword fields, derive afterwards. STATS BY attributes.user.email is ~4.3x faster
 *      than STATS BY the actor COALESCE (42ms vs 180ms over 24h; 468ms vs 2,074ms over a much
 *      larger document set), because a computed value gives up global ordinals.
 *   3. A panel that measures presence does not take the noise gate. access_granted is emitted
 *      for every authorised action — often several per request — and it IS a person's activity;
 *      gating it removes the thing the panel exists to show.
 */

export const IDX = 'logs-serverless.audit.otel-elastic_cloud';

/**
 * Identity resolution, split from actor_kind because the Discover sessions need the first half and
 * not the second. Keeping it as its own constant is what lets the drift check assert that every
 * static ES|QL file resolves identity the same way — this is the fallback chain the whole suite
 * rests on (user.name is a numeric id, so it is the last resort, not the first).
 */
export const ACTOR_RESOLVE =
  'EVAL actor = COALESCE(attributes.user.email, attributes.api_key.name, attributes.user.name, "<anonymous>")';

export const ACTOR =
  `${ACTOR_RESOLVE}, actor_kind = CASE(attributes.user.email IS NOT NULL, "human", "service")`;

export const ORG =
  'EVAL actor_org = CASE(attributes.user.email IS NULL, "machine", ' +
  'attributes.user.email LIKE "*@elastic.co", "Elastic", "tenant")';

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
 * of five; measured at 0.41s over 24h.
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
/** STATS cannot divide two of its own aggregates, so the ratio is an EVAL afterwards. */
export const RISK_INDEX_STATS = `risk_total = SUM(risk), scoring_events = COUNT(*)`;
export const RISK_INDEX_EVAL  =
  `EVAL mean_severity = ROUND(1.0 * risk_total / scoring_events, 1)`;

/**
 * Platform identities are Elastic's own automation, not tenant activity. Left unsplit they can
 * top the risk leaderboard: platform automation such as elastic.maintenance performs routine
 * security config changes, which carry the highest weight.
 */
export const PLATFORM_ACTORS =
  '"elastic.maintenance","autoscaling","elasticsearch-controller","elastic/fleet-server"';
/** Anything the cluster could not attribute to a principal. Not platform — nobody owns these. */
export const UNAUTH_ACTORS =
  '"<anonymous>","<unauthenticated-cloud-access-token>","<unauthenticated-saml-user>"';
export const SCOPE =
  `EVAL actor_scope = CASE(actor IN (${PLATFORM_ACTORS}), "platform", ` +
  `actor IN (${UNAUTH_ACTORS}), "unauthenticated", "tenant")`;

/**
 * Pushed ahead of the ACTOR/RISK EVALs so scoring runs over the few events that can score
 * instead of the whole window. Without it the leaderboard took 16s because COALESCE/CASE were
 * evaluated on every event before `WHERE risk > 0` pruned anything.
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
 * The noise vocabulary, shared by NOISE and BAND so the gate and the bands can never disagree.
 *
 * `attributes.elasticsearch.audit.action` does not exist on Kibana audit events. The previous
 * gate was a bare `NOT (... IN ...)`, which is null for those rows — and `WHERE null` drops the
 * row, so the gate silently discarded 100% of Kibana audit: the small slice of the stream that
 * carries nearly all of the forensic value. Every predicate below is explicitly null-guarded.
 *
 * cluster:monitor/main is not the only bulk. Search-phase internals (scroll/query/can_match,
 * reader contexts, PITs) and transport connection_granted can outweigh it, so all of them are
 * gated. What survives is a small fraction of the stream, and Kibana audit is part of it rather
 * than being thrown away.
 */
const NOISE_ES_ACTIONS = '"cluster:monitor/main", "elastic.maintenance"';
const NOISE_ES_QUERY_INTERNALS =
  'attributes.elasticsearch.audit.action LIKE "indices:data/read/search*" ' +
  'OR attributes.elasticsearch.audit.action LIKE "indices:data/read/*point_in_time" ' +
  'OR attributes.elasticsearch.audit.action == "indices:data/read/open_reader_context"';
const NOISE_EVENT_ACTIONS = '"authentication_success","connection_granted"';

export const NOISE =
  `WHERE (attributes.elasticsearch.audit.action IS NULL OR NOT (` +
  `attributes.elasticsearch.audit.action IN (${NOISE_ES_ACTIONS}) OR ${NOISE_ES_QUERY_INTERNALS})) ` +
  `AND (attributes.event.action IS NULL OR NOT (attributes.event.action IN (${NOISE_EVENT_ACTIONS})))`;

/**
 * Band classification for the quarantine dashboard. A CASE condition that evaluates to null
 * falls through rather than matching, so Kibana events land in "signal" as intended.
 */
export const BAND =
  `EVAL band = CASE(attributes.elasticsearch.audit.action IN (${NOISE_ES_ACTIONS}), "infra-noise", ` +
  `${NOISE_ES_QUERY_INTERNALS}, "query-noise", ` +
  `attributes.event.action == "connection_granted", "query-noise", ` +
  `attributes.event.action == "authentication_success", "authn-volume", "signal")`;

export const TIME   = 'WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart';
export const BUCKET = 'BUCKET(@timestamp, 75, ?_tstart, ?_tend)';
export const KIB    = 'WHERE resource.attributes.service.name == "serverless-kibana"';
export const ESS    = 'WHERE resource.attributes.service.name == "elasticsearch-serverless"';

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

export const xy = (x, y, w, h, title, q, ycol, desc, { kind = 'bar_stacked', breakdown, xcol, label = '@timestamp', temporal = true } = {}) => {
  const layer = {
    type: kind, data_source: { type: 'esql', query: q },
    x: { column: xcol || BUCKET, label }, y: [{ column: ycol }],
  };
  if (breakdown) layer.breakdown_by = { column: breakdown };
  const axis = { x: { title: { visible: false } }, y: { title: { visible: false } } };
  if (temporal) Object.assign(axis.x, { scale: 'temporal', domain: { type: 'fit', rounding: false } });
  return { type: 'vis', id: nid('xy'), grid: { x, y, w, h },
           config: { title, description: desc, type: 'xy', axis, layers: [layer] } };
};

/** A categorical horizontal bar chart: `cat` down the side, `val` along. The non-temporal xy path. */
export const bar = (x, y, w, h, title, q, cat, val, desc) =>
  xy(x, y, w, h, title, q, val, desc, { kind: 'bar_horizontal', xcol: cat, label: cat, temporal: false });

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
export const table = (x, y, w, h, title, q, rows, metrics, desc) => ({
  type: 'vis', id: nid('tbl'), grid: { x, y, w, h },
  config: {
    title, description: desc, type: 'data_table',
    data_source: { type: 'esql', query: q },
    rows: rows.map((c) => (typeof c === 'string' ? { column: c } : c)),
    metrics: metrics.map((m) => (typeof m === 'string' ? { column: m } : m)),
  },
});

/** A row column whose cells are click-to-filter. See table(). */
export const filterable = (column) => ({ column, click_filter: true });

/**
 * A row column with a fixed pixel width. See table().
 *
 * Kibana's data table divides the panel evenly between columns, so on a wide panel with many
 * columns every column gets the same width regardless of what it holds — which truncates the one
 * column that matters (an object name) to make room for one that holds "—". Widths are applied by
 * the _import post-pass in dashboards.mjs, because `PUT /api/dashboards/{id}` does not carry them.
 */
export const sized = (column, width, extra = {}) => ({ column, width, ...extra });

export const pie = (x, y, w, h, title, q, sliceCol, metricCol, desc, { donut = 'm', kind = 'pie' } = {}) => {
  const config = {
    title, description: desc, type: kind,
    data_source: { type: 'esql', query: q },
    metrics: [{ column: metricCol }], group_by: [{ column: sliceCol }],
  };
  if (kind === 'pie') config.styling = { donut_hole: donut };
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
  config: { ref_id: `cloud-audit-vega-${ref}`, title, description: desc },
});

export const search = (x, y, w, h, ref, title, desc) => ({
  type: 'discover_session', id: nid('ds'), grid: { x, y, w, h },
  config: { ref_id: `cloud-audit-search-${ref}`, title, description: desc },
});

export const md = (x, y, w, h, content) => ({
  type: 'markdown', id: nid('md'), grid: { x, y, w, h }, config: { content },
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
    links: DASH.filter(([d]) => d !== current).map(([d, label]) => ({
      type: 'dashboardLink', destination: d, label,
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

export const NAV_H = 4;

/**
 * Navigation always goes on top: pin the links bar at y=0 and shift authored panels down.
 *
 * Default range is 1h. That used to be justified here as a hard limit — "2h, 3h and 4h exceed 60s;
 * 24h exceeds 110s" — and those numbers were real but misattributed. They were taken back to back:
 * a synchronous ES|QL query outlives the client that gave up on it and cannot be cancelled on
 * serverless, so a measurement taken after a timeout may have been sharing the cluster with it.
 * Re-measured on a quiet cluster, the busiest-identities panel returns in 221ms over a
 * high-volume window. 1h stays the default because it is the readable view of "right now", and
 * because wide *unfiltered* group-bys are still the expensive case — see QUERY SHAPE above.
 * `./audit --lint` times every query, so this claim is checked rather than asserted.
 */
export const dash = (id, title, description, panels, timeFrom = 'now-1h') => ({
  title, description,
  time_range: { from: timeFrom, to: 'now' },
  refresh_interval: { pause: true, value: 60000 },
  panels: [links(0, 0, 48, NAV_H, id),
           ...panels.map((p) => ({ ...p, grid: { ...p.grid, y: p.grid.y + NAV_H } }))],
});
