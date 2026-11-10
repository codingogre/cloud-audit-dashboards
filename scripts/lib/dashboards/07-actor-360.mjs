/** 07 Identity 360 — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, TIME, CONTROLS_WHERE, ACTOR_KEYS, ACTOR_RESOLVE, INDEX_FAMILY, IP_GEO, indexFamily, dash, kpi, table, vega, section, row, stack, resetIds,
  sized, filterable, grouped, SYS_INDEX, fitRows, IDENTITY_KEYS, KIND_GROUPED,
  custom, KIBANA_INTERNALS, OBJ_PRESENT, OBJ_TYPE, READ_ACTIONS, LOOKUP_ACTIONS, inList, TIME_ONLY, PROJECT_WHERE, IDENTITY_WHERE, CLIENT_IP_WHERE
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import { LABELS } from '../custom.mjs';
import {
  riskScored, CHANGED, CHANGED_KEYS, CHANGED_DERIVE, specDescription, RAW_RECORDS, IDENTITY_HOW_TO, sessionRecords, openInByTitle
} from './shared.mjs';

/**
 * One identity's whole footprint on one page — pick someone in Identity in the control bar and every panel
 * becomes their story. With nobody selected it is the whole estate, which is a useful "who is here"
 * view in its own right.
 *
 * The page is organised around TIME BINDING (see panels.mjs), because it mixes both kinds and a
 * reader has to know which window each panel shows:
 *
 *   ① Is this normal?   the 7 days to the picker's end — ES|QL Vega on the events view (END_WINDOWS), which keeps
 *                        the control bar and the identity dropdowns, so a baseline and a weekly rhythm are
 *                        possible whatever the picker's range. No panel badge says so (no panel range): the
 *                        section header does (at 1440px a title repeat cut "Where they rank — last 7 d")
 *   ② What they did     follows the time picker
 *   ③ Evidence          the 24 hours to the picker's end as a session timeline, over the raw records
 *
 * Who this is shows the identity as the Identity dropdown names it (ACTOR_RESOLVE, counted first by ACTOR_KEYS)
 * beside the raw Principal id it ran as, which is what a filter pill can match.
 */

/**
 * IDENTITY PATH (custom panel, 1.0.8): a guided drill-down — credential › space › object type › operation ›
 * the objects, and under each object the Elasticsearch data Kibana read for it (custom/11-identity-path.html).
 * Each column shows only the children of what is picked to its left; it opens on the busiest path.
 *
 * TWO MEASURES, never added. Kibana-side ACTIONS: opened (get/resolve), created, changed, deleted, ran, and LISTED —
 * counted once per list or search request (`http.request.id` of a *_find), not once per object it returned: one
 * Fleet page load writes a find event for every tag on it. Elasticsearch-side DATA REQUESTS: distinct requests Kibana
 * sent that READ documents (READ_ACTIONS); field and name lookups (LOOKUP_ACTIONS) are kept apart as "looked up".
 *
 * WHERE DATA ATTACHES. Kibana names the dashboard or app behind every request it sends (`x-opaque-id:
 * <request id>;kibana:<kind>:<app>:<id>…`). A read joins its object on (credential, type, object id), and sits under
 * Opened when the object was opened in range, under "Read data" otherwise (opened earlier, or an app with no saved
 * object).
 *
 * SPACE AND CLIENT IP OF A READ. Elasticsearch's events record neither: their client is Kibana (100.64.x.x) and
 * they carry no space. Kibana writes an `http_request` event, with the space, the browser's address and the request
 * id, for most requests, and a request joins it on that id. For a browser it writes none for the data searches
 * themselves (none of 371 SAML dashboard reads over 7 days matched one, 2026-11-06), only for the lookups around
 * them (field lists, time fields, sources). So a read with no event of its own takes the space and address of the
 * same credential's other requests for the same object or app (Kibana's own events for it, and the lookups that
 * did join), when they agree on one; otherwise "(several spaces)" or "(space not recorded)", and no address.
 * Client IP is tested after that, never in the source filter.
 *
 * SHAPE. Count first by raw fields with the request id as a key, derive on grouped rows, one INLINE STATS for the
 * object join, MV_EXPAND each fine row into the six levels it feeds, sum BY level and path, then TOP 25 children per
 * parent over a packed string (keep-risky flag first, then actions) and unpack. Ids are MD5 prefixes of the path, so
 * Liquid can emit one CSS rule per node that shows its children only while it and its ancestors are checked. No
 * FORK (each branch re-runs the pipeline). Never SUM a count after MV_EXPAND of indices: per-index rows repeat it.
 */
const K_SIDE = 'service.name == "serverless-kibana"';
const OPAQUE = '`http.request.header.x-opaque-id`';
const T_PATH = '\\t'; // an ES|QL tab escape: SPLIT takes a single-byte delimiter only
const T_SEP = '␞';
const T_PACKED = ['keep', 'acts', 'kacts', 'opens', 'creates', 'changes', 'deletes', 'runs', 'lists', 'fails', 'objs', 'dreq', 'dsets', 'sysn', 'lk',
  'name', 'famlist', 'lklist', 'lastf', 'key'];
const T_NUMS = T_PACKED.slice(2, 15);
/** The fine row's columns that ride through the object join (cred, type and oid are its group keys). */
/** The grouped row's columns that ride through the request join. */
const T_JOIN = ['cred', 'space', 'cip', 'type', 'op', 'oid', 'rq', 'es', 'meta', 'lang', 'n', 'nf', 'ts', 'nm', 'ix', 'actor'];
const T_FINE = ['space', 'cip', 'op', 'rq', 'fam', 'meta', 'lang', 'es', 'n', 'nf', 'ts', 'nm', 'actor'];
const t_md5 = (x) => `SUBSTRING(MD5(${x}), 1, 10)`;
const t_prefix = (n) => `MV_CONCAT(MV_SLICE(parts, 0, ${n - 1}), "${T_PATH}")`;
const HTTP_REQ = `${K_SIDE} AND event.action == "http_request"`;
/**
 * Only a person's requests to the endpoints that look up or search data can join a read, so only those are read:
 * all of them took the query from 0.6s to 1.65s at 7d on the perf replica (239k events, 170k from API keys), these
 * 0.67s. An API key's reads still take their object's space; an endpoint missing here only loses the join.
 */
const HTTP_JOINABLE = `${HTTP_REQ} AND NOT user.domain IN ("_cloud_api_key", "_es_api_key") ` +
  'AND url.original RLIKE "https?://[^/]*(/s/[^/]*)?/(internal/(data_views|controls|esql|esql_registry|index_management|index-pattern-management|apm|search)|api/(fleet|index_management|metrics))/.*"';
/** Client IP against the browser's address a row carries after the request join (`cip`), not the event's own. */
export const T_CLIENT_IP = CLIENT_IP_WHERE.replace('client.ip ==', 'cip ==');
/** The drill-down's row cap. The template says so when a result reaches it (custom/11-identity-path.html). */
export const T_ROWS = 6000;
/**
 * How many identities the selection covers, from the data, not from ?identity: a pinned Principal id pill or an
 * Identity type narrows it as surely as the Identity control. Each event is counted BY its raw identity keys in the
 * first STATS, named the suite's way (ACTOR_RESOLVE) on those grouped rows, carried through both joins as `actor`,
 * and counted distinct on the level-0 row only. The panel asks for a pick when it covers more than one.
 */
const T_IDS = 'ids = COUNT_DISTINCT(actor) WHERE lvl == 0';
/** The fine rows both the drill-down and its Lens fallback read: joined, typed, after Client IP. */
const T_BASE =
  `FROM ${IDX} | ${TIME_ONLY} AND ${PROJECT_WHERE} AND ${IDENTITY_WHERE} ` +
  `| WHERE (${K_SIDE} AND ${OBJ_PRESENT} AND (event.action IS NULL OR NOT (${KIBANA_INTERNALS}))) OR (${HTTP_JOINABLE}) ` +
  `OR (service.name == "serverless-elasticsearch" AND elasticsearch.audit.indices IS NOT NULL AND ${OPAQUE} LIKE "*;kibana:*" ` +
  `AND ${inList('elasticsearch.audit.action', [...READ_ACTIONS, ...LOOKUP_ACTIONS])}) ` +
  `| EVAL rq = CASE(${K_SIDE}, CASE(event.action LIKE "*_find" OR event.action == "http_request", http.request.id), ${OPAQUE}) ` +
  '| STATS n = COUNT(*), nf = COUNT(*) WHERE event.outcome == "failure", ts = MAX(@timestamp), nm = MAX(kibana.saved_object.name), ' +
  'idx = VALUES(elasticsearch.audit.indices) BY service.name, user.domain, authentication.type, kibana.space.id, kibana.saved_object.type, ' +
  'kibana.saved_object.id, event.action, act = elasticsearch.audit.action, rq, client.ip, user.email, api_key.name, user.name ' +
  `| EVAL http = ${HTTP_REQ} | ${OBJ_TYPE} | ${ACTOR_RESOLVE} ` +
  `| EVAL es = NOT ${K_SIDE}, ctx = REPLACE(rq, "^[^;]*;kibana:", "") ` +
  '| EVAL c_app = CASE(es, REPLACE(ctx, "^[^:;]*:([^:;]*):.*$", "$1")), c_id = CASE(es, REPLACE(ctx, "^[^:;]*:[^:;]*:([^;]*).*$", "$1")), ' +
  `meta = es AND ${inList('act', LOOKUP_ACTIONS)}, ` +
  // the request's language, for the per-request detail; ES|QL's own field lookups count as ES|QL
  'lang = CASE(es, CASE(act LIKE "*esql*", "ES|QL", act LIKE "*field_caps*", "field list", act LIKE "indices:admin/*", "name lookup", act LIKE "*/sql*", "SQL", act LIKE "*/eql*", "EQL", "search")) ' +
  '| EVAL cred = COALESCE(user.domain, authentication.type, "unknown"), space = CASE(es, null, COALESCE(kibana.space.id, "no space")), ' +
  'cip = CASE(es, null, client.ip), rid = CASE(es, MV_FIRST(SPLIT(rq, ";")), rq), ' +
  'type = CASE(es, CASE(c_app == "dashboards" AND c_id != "", "dashboard", c_app == "discover", "search", CONCAT("app:", COALESCE(c_app, ""))), obj_type), ' +
  'op = CASE(es, "read", event.action LIKE "*_find", "list", event.action LIKE "*_get" OR event.action LIKE "*_resolve" OR event.action LIKE "*bulk_get*", "open", ' +
  'event.action LIKE "*_delete*", "delete", event.action LIKE "*_create*", "create", ' +
  'event.action LIKE "*_run*" OR event.action LIKE "*_test" OR event.action LIKE "*_execute*" OR event.action LIKE "*_start*", "run", "change"), ' +
  'oid = CASE(es, CASE(c_id IS NOT NULL AND c_id != "", c_id, CONCAT("app:", COALESCE(c_app, ""))), COALESCE(kibana.saved_object.id, obj_type)) ' +
  '| WHERE http OR NOT (oid LIKE "cloud-audit-*" OR oid LIKE "elastic_cloud-audit-*") ' +
  // the request join: a request takes the space and browser address of Kibana's http_request event with its id.
  // Pack, group by request id, unpack, in one pass: an INLINE STATS re-runs everything above it (2.4s at 7d).
  `| EVAL ix = MV_CONCAT(idx, "|"), jp = CONCAT(${T_JOIN.map((c) => `COALESCE(TO_STRING(${c}), "")`).join(`, "${T_SEP}", `)}) ` +
  '| STATS rows = VALUES(jp) WHERE NOT http, hsp = VALUES(space) WHERE http, hip = MIN(cip) WHERE http BY rid ' +
  `| WHERE rows IS NOT NULL | MV_EXPAND rows | DISSECT rows "${T_JOIN.map((c) => `%{${c}_j}`).join(T_SEP)}" ` +
  '| EVAL es = es_j == "true", meta = meta_j == "true", n = CASE(n_j == "", null, TO_LONG(n_j)), nf = CASE(nf_j == "", null, TO_LONG(nf_j)), ' +
  'ts = TO_DATETIME(ts_j), nm = CASE(nm_j == "", null, nm_j), rq = CASE(rq_j == "", null, rq_j), cred = cred_j, type = type_j, op = op_j, oid = oid_j, ' +
  'lang = CASE(lang_j == "", null, lang_j), actor = actor_j, ' +
  'idx = CASE(ix_j == "", null, SPLIT(ix_j, "|")) ' +
  '| EVAL space = CASE(es, CASE(MV_COUNT(hsp) == 1, hsp), space_j), cip = CASE(es, hip, cip_j == "", null, TO_IP(cip_j)) ' +
  '| MV_EXPAND idx ' +
  `| EVAL fam = CASE(es AND LOCATE(idx, "*") == 0 AND NOT idx LIKE "<*", ${indexFamily('idx')}) ` +
  '| STATS n = SUM(n) WHERE NOT es, nf = SUM(nf), ts = MAX(ts), nm = MAX(nm) BY cred, space, cip, type, op, oid, rq, fam, meta, lang, es, actor ' +
  // the object join: a read with no space or address of its own takes its object's, and sits under Opened when the
  // object was opened in range.
  // Pack, group by object, unpack: an INLINE STATS here cost ~450ms of 1.0s at 7d on the perf replica.
  `| EVAL fp = CONCAT(${T_FINE.map((c) => `COALESCE(TO_STRING(${c}), "")`).join(`, "${T_SEP}", `)}) ` +
  '| STATS rows = VALUES(fp), kspaces = VALUES(space), kips = VALUES(cip), opened = SUM(n) WHERE op == "open", onm = MAX(nm) BY cred, type, oid ' +
  `| MV_EXPAND rows | DISSECT rows "${T_FINE.map((c) => `%{${c}_s}`).join(T_SEP)}" ` +
  '| EVAL es = es_s == "true", meta = meta_s == "true", n = CASE(n_s == "", null, TO_LONG(n_s)), nf = CASE(nf_s == "", null, TO_LONG(nf_s)), ' +
  'ts = TO_DATETIME(ts_s), space = CASE(space_s == "", null, space_s), rq = CASE(rq_s == "", null, rq_s), fam = CASE(fam_s == "", null, fam_s), ' +
  'nm = CASE(nm_s == "", null, nm_s), op = op_s, actor = actor_s, cip = CASE(cip_s == "", null, TO_IP(cip_s)), lang = CASE(lang_s == "", null, lang_s) ' +
  '| EVAL space = CASE(space IS NOT NULL, space, MV_COUNT(kspaces) == 1, kspaces, kspaces IS NULL, "(space not recorded)", "(several spaces)"), ' +
  'cip = CASE(cip IS NOT NULL, cip, MV_COUNT(kips) == 1, kips), nm = COALESCE(nm, onm) ' +
  `| WHERE ${T_CLIENT_IP} ` +
  '| EVAL op = CASE(es AND opened > 0, "open", es, "read", op)';
export const IDENTITY_PATH = `${T_BASE} ` +
  // level 6 lists the requests that ran a query (with or without documents back), never a bare name or field lookup:
  // Discover lists every index name on each refresh, and those buried the queries in the latest 25 (rendered 2026-11-09).
  // A query that read nothing is kept only when a named part of the page sent it (x-opaque-id carries a third part,
  // e.g. the histogram or a panel id): with none it is the page's own column and field discovery, not a run.
  '| EVAL lvl = [0, 1, 2, 3, 4, 5, 6] | MV_EXPAND lvl | WHERE lvl < 6 OR (es AND fam IS NOT NULL AND (NOT meta OR (lang IN ("ES|QL", "search", "SQL", "EQL") AND rq LIKE "*;*;*"))) ' +
  `| EVAL key = CASE(lvl == 0, "all", lvl == 1, cred, lvl == 2, CONCAT(cred, "${T_PATH}", space), lvl == 3, CONCAT(cred, "${T_PATH}", space, "${T_PATH}", type), ` +
  `lvl == 4, CONCAT(cred, "${T_PATH}", space, "${T_PATH}", type, "${T_PATH}", op), lvl == 5, CONCAT(cred, "${T_PATH}", space, "${T_PATH}", type, "${T_PATH}", op, "${T_PATH}", oid), ` +
  `CONCAT(cred, "${T_PATH}", space, "${T_PATH}", type, "${T_PATH}", op, "${T_PATH}", oid, "${T_PATH}", fam, "${T_PATH}", rq)) ` +
  '| STATS opens = SUM(n) WHERE op == "open", creates = SUM(n) WHERE op == "create", changes = SUM(n) WHERE op == "change", ' +
  'deletes = SUM(n) WHERE op == "delete", runs = SUM(n) WHERE op == "run", lists = COUNT_DISTINCT(rq) WHERE op == "list", ' +
  'kfails = SUM(nf) WHERE NOT es, rfails = COUNT_DISTINCT(rq) WHERE es AND nf > 0, objs = COUNT_DISTINCT(oid), ' +
  'dreq = COUNT_DISTINCT(rq) WHERE es AND NOT meta AND fam IS NOT NULL, sysn = COUNT_DISTINCT(fam) WHERE es AND NOT meta AND fam LIKE ".*", ' +
  `fams = VALUES(fam) WHERE es AND NOT meta, looked = VALUES(fam) WHERE es AND meta, langs = VALUES(lang) WHERE es, seen = MAX(ts), name = MAX(nm), ${T_IDS} BY lvl, key ` +
  `| EVAL ${T_NUMS.filter((c) => !['kacts', 'dsets', 'lk', 'fails'].includes(c)).map((c) => `${c} = COALESCE(${c}, 0)`).join(', ')}, fails = COALESCE(kfails, 0) + COALESCE(rfails, 0) ` +
  // a request (level 6) ranks by time, newest first, so its parent keeps the latest 25
  '| EVAL kacts = opens + creates + changes + deletes + runs + lists, acts = CASE(lvl == 6, TO_LONG(seen) / 1000, opens + creates + changes + deletes + runs + lists + dreq), dsets = COALESCE(MV_COUNT(fams), 0), lk = COALESCE(MV_COUNT(looked), 0), ' +
  'keep = CASE(lvl < 6 AND (fails > 0 OR deletes > 0 OR sysn > 0), 1, 0), famlist = CASE(lvl == 6, MV_CONCAT(MV_SORT(langs), ", "), MV_CONCAT(MV_SORT(fams), "|")), lklist = MV_CONCAT(MV_SORT(looked), "|"), ' +
    // ISO, so the template formats it in the viewer's time zone (Liquid's date filter runs in the browser)
  'lastf = TO_STRING(seen), ' +
  `parent = CASE(lvl <= 1, "all", REPLACE(key, "${T_PATH}[^${T_PATH}]*$", "")) ` +
  `| EVAL pack = CONCAT(${T_PACKED.map((c) => (c === 'acts' ? 'TO_STRING(acts + 1000000000000)' : T_NUMS.includes(c) || c === 'keep' ? `TO_STRING(${c})` : `COALESCE(${c}, "")`)).join(`, "${T_SEP}", `)}) ` +
  '| STATS kids = TOP(pack, 25, "desc"), sib_n = COUNT(*), sib_acts = SUM(acts), sib_opens = SUM(opens), sib_chg = SUM(creates + changes + deletes + runs), ' +
  'sib_k = SUM(kacts), sib_lists = SUM(lists), sib_dreq = SUM(dreq), sib_fails = SUM(fails), ids = MAX(ids) BY lvl, parent ' +
  '| MV_EXPAND kids ' +
  `| DISSECT kids "${T_PACKED.map((c) => `%{${c}}`).join(T_SEP)}" ` +
  `| EVAL ${T_NUMS.map((c) => `${c} = TO_LONG(${c})`).join(', ')}, acts = TO_LONG(acts) - 1000000000000, keep = TO_LONG(keep) ` +
  `| EVAL parts = SPLIT(key, "${T_PATH}") ` +
  `| EVAL k = MV_LAST(parts), nid = ${t_md5('key')}, pid = CASE(lvl <= 1, null, ${t_md5('parent')}), ` +
  `h1 = CASE(lvl >= 2, ${t_md5(t_prefix(1))}), h2 = CASE(lvl >= 3, ${t_md5(t_prefix(2))}), h3 = CASE(lvl >= 4, ${t_md5(t_prefix(3))}), h4 = CASE(lvl >= 5, ${t_md5(t_prefix(4))}), ` +
  `h5 = CASE(lvl >= 6, ${t_md5(t_prefix(5))}), ` +
  'oid = CASE(lvl == 5 AND NOT MV_LAST(parts) LIKE "app:*", MV_LAST(parts)), ty = CASE(lvl >= 5, MV_SLICE(parts, 2, 2)), opn = CASE(lvl >= 5, MV_SLICE(parts, 3, 3)), ' +
  'ok = CASE(lvl == 6, MV_SLICE(parts, 4, 4)), fm = CASE(lvl == 6, MV_SLICE(parts, 5, 5)) ' +
  `| DROP kids, parts, parent | SORT lvl, pid, acts DESC, k | LIMIT ${T_ROWS}`;

/**
 * THE LENS FALLBACK (AUDIT_NO_CUSTOM=1 at build): the same paths as a table, should custom panels be unavailable.
 * It reads T_BASE, so the counts match the drill-down's first four columns; the labels come from LABELS.
 */
const T_WORDS = (lvl, col, fallback) => `CASE(${Object.entries(LABELS[lvl]).map(([k, [l]]) => `${col} == "${k}", "${l}"`).join(', ')}, ${fallback})`;
export const IDENTITY_PATH_TABLE = `${T_BASE} ` +
  '| STATS acts = SUM(n) WHERE NOT es AND op != "list", lists = COUNT_DISTINCT(rq) WHERE op == "list", ' +
  'data_requests = COUNT_DISTINCT(rq) WHERE es AND NOT meta AND fam IS NOT NULL, kfails = SUM(nf) WHERE NOT es, ' +
  'rfails = COUNT_DISTINCT(rq) WHERE es AND nf > 0, objects = COUNT_DISTINCT(oid), last_seen = MAX(ts) BY cred, space, type, op ' +
  '| EVAL kibana_actions = COALESCE(acts, 0) + COALESCE(lists, 0), failed = COALESCE(kfails, 0) + COALESCE(rfails, 0), ' +
  `credential = ${T_WORDS(1, 'cred', 'REPLACE(cred, "-", " ")')}, space = ${T_WORDS(2, 'space', 'space')}, ` +
  `object_type = ${T_WORDS(3, 'type', 'CASE(type LIKE "app:*", CONCAT(TO_UPPER(SUBSTRING(type, 5, 1)), REPLACE(SUBSTRING(type, 6), "[-_]", " "), " app"), REPLACE(type, "-", " "))')}, ` +
  `operation = ${T_WORDS(4, 'op', 'op')} ` +
  '| SORT kibana_actions DESC, data_requests DESC, credential, space | KEEP credential, space, object_type, operation, objects, kibana_actions, data_requests, failed, last_seen | LIMIT 100';
const PATH_TITLE = 'Drill down — credential › space › object type › operation › the data Kibana read';
const PATH_DESC = 'Pick a credential, space, object type and operation; each column narrows to the objects and the data Kibana read. Click a data set to list each request. Routine internals and this suite’s dashboards are left out.';
/** The drill-down, or with AUDIT_NO_CUSTOM=1 its Lens table in the same grid slot. */
const identityPath = (x, y, w, h) => (process.env.AUDIT_NO_CUSTOM
  ? table(x, y, w, h, 'Kibana paths — credential › space › object type › operation', IDENTITY_PATH_TABLE,
    [sized('credential', 170), sized('space', 160), sized('object_type', 180), 'operation'], ['objects', 'kibana_actions', 'data_requests', 'failed', 'last_seen'],
    'Each path this selection took through Kibana, busiest first: Kibana actions, and the data requests Kibana sent to Elasticsearch, never added. Routine internals and this suite’s dashboards are left out.', { scroll: true })
  : custom(x, y, w, h, '11-identity-path', PATH_TITLE, PATH_DESC, IDENTITY_PATH));

const vegaPanel = (ref, title) => (x, y, w, h) => vega(x, y, w, h, ref, title, specDescription(ref));

/** Out to the topic dashboard that owns the dimension clicked. Stripped before the API sees it. */
const drillTo = (destination, panel) => Object.assign(panel, { drill: destination });

/**
 * `*`, `-*` and `syn-*` arrive in the indices field as REQUEST PATTERNS, not indices — and so does
 * date math: the SLO writer names `<.slo-observability.sli-v3.6.{2026-10-13||/d{yyyy-MM-dd|UTC}}>`,
 * one distinct string per day, which no fold recognises. Each one counted as a family of its own (7 of
 * the 54 on the review render) beside the real dated indices it resolves to, which are already there.
 * Applied to the grouped rows (after a STATS), never per document, so it costs nothing.
 */
const isPattern = (col) => `LOCATE(${col}, "*") > 0 OR STARTS_WITH(${col}, "<")`;
const NOT_PATTERN = `WHERE NOT (${isPattern('elasticsearch.audit.indices')})`;

/**
 * The two index tables in ② count the SAME reads, so every dot-prefixed family in "What they read" is a
 * row of "System and hidden index reads" with the same Events and Indices (round-4 review: a family at
 * 283 events on the left was missing on the right, because the left folded its `.ds-.alerts-…` backing
 * index in and the right dropped every `.ds-*`; the right also listed request patterns the left drops).
 * Both now leave out request patterns and shard/node fan-out (`search[phase/query]`, `bulk[s][p]` …, the
 * action half of SYS_INDEX, which repeats a top-level request already audited with the same index), and
 * the right selects with SYS_INDEX — the definition 03 uses — so a dot-named stream's backing index
 * counts with its family. NOT_FANOUT is a boolean on a raw keyword, cheap per event (QUERY SHAPE rule 1).
 */
const NOT_FANOUT = '(elasticsearch.audit.action IS NULL OR NOT elasticsearch.audit.action LIKE "*[*")';

/**
 * DELETING A SPACE DELETES WHAT IS IN IT, and Kibana audits each of those objects as its own
 * saved_object_delete — with the space the REQUEST was made in (usually `default`), not the deleted space
 * the object lived in, and with the space_delete's own http.request.id (probed: `DELETE space r6shared`
 * and its 13 object deletes share request 0b8878ad… and all read space `default`). Grouped by name, the
 * same-named objects of many deleted spaces merged into one row: round-5 review read "[Audit] Actor
 * first-seen and footprint · default · 74 events", one object deleted 74 times in a space it was never in.
 * At 24h, 2,801 of 3,132 saved-object deletes were that cascade (89 space deletes).
 *
 * So a cascaded delete is folded into the space delete that caused it: that row reads "r6shared · and the
 * 13 objects in it", its Events count every delete it stands for (so the table's deletes still add up to
 * the flow's), and a delete with no space delete in its request keeps its own row. The request id is kept
 * only for the two delete actions (one boolean per event, cheap), so the extra grouping is one row per
 * delete request rather than per change.
 *
 * ES|QL has no window function and no join here, so the request's verdict reaches its rows through one
 * more STATS on the grouped rows: keyed by the request for a delete and by the row itself otherwise, each
 * row packed into one string so a bulk delete of several objects (one request, no space) unpacks back
 * into its rows with MV_EXPAND + DISSECT. INLINE STATS was the obvious tool and was measured out: once
 * its result is used it re-runs the whole scan, 0.47s → 1.9s over 7 days on the replica.
 * `␞` separates the packed fields; a name containing it would mis-split, and none does.
 */
const SEP = '␞';
const PACK = ['event.action', 'kibana.saved_object.type', 'obj_name', 'execution', 'space', 'result']
  .map((c) => `COALESCE(${c}, "")`).join(`, "${SEP}", `) + `, "${SEP}", TO_STRING(n), "${SEP}", TO_STRING(last_ts)`;
const CASCADE_KEY = 'EVAL req = CASE(event.action IN ("space_delete", "saved_object_delete"), http.request.id)';
const CASCADE_FOLD =
  `EVAL pack = CONCAT(${PACK}), sd = event.action == "space_delete" ` +
  '| STATS n = SUM(n), inside = SUM(n) WHERE event.action == "saved_object_delete", last_ts = MAX(last_ts), ' +
  'gone = COUNT(*) WHERE sd, sname = MAX(obj_name) WHERE sd, sspace = MAX(space) WHERE sd, sres = MAX(result) WHERE sd, rows = VALUES(pack) ' +
  'BY k = COALESCE(req, pack) ' +
  `| EVAL rows = CASE(gone > 0, CONCAT("space_delete${SEP}space${SEP}", COALESCE(sname, "a deleted space"), "${SEP}—${SEP}", COALESCE(sspace, ""), "${SEP}", COALESCE(sres, ""), "${SEP}", TO_STRING(n), "${SEP}", TO_STRING(last_ts)), rows), inside = CASE(gone > 0, inside, 0) ` +
  `| MV_EXPAND rows | DISSECT rows "%{a}${SEP}%{t}${SEP}%{obj_name}${SEP}%{execution}${SEP}%{sp}${SEP}%{res}${SEP}%{ns}${SEP}%{ts}" ` +
  '| EVAL event.action = CASE(a == "", null, a), kibana.saved_object.type = CASE(t == "", null, t), ' +
  'space = CASE(sp == "", null, sp), result = CASE(res == "", null, res), n = TO_LONG(ns), last_ts = TO_DATETIME(ts) ' +
  `| STATS n = SUM(n), inside = SUM(inside), last_ts = MAX(last_ts) BY ${CHANGED_KEYS}, obj_name, execution, space, result`;

/**
 * What each RISK weight means, in words, for the receipts table's "Why it scored" column. The Risk tile
 * names its worst weight as the NUMBER, which this column sits beside: a tile subtitle holds ~22
 * characters at a 1440px viewport, and "worst: security config change" after a count was cut there. A
 * multi-branch CASE, so it runs on the grouped rows of riskScored() — a handful per (action, weight) —
 * never per event.
 */
const WEIGHT_WORDS = [[50, 'security config change'], [45, 'API keys invalidated'], [40, 'failed or denied'],
  [35, 'anonymous request denied'], [30, 'destructive Kibana change'], [25, 'Kibana change'], [10, 'workflow execution']];
const weightWords = (col) => `CASE(${WEIGHT_WORDS.map(([w, words]) => `${col} == ${w}, "${words}"`).join(', ')}, "scored")`;

/**
 * The intro (draft 2 of the 1.0.3 customer copy, INTRO TEXT in panels.mjs): why you would open the page,
 * then how. Since 1.0.8.2 the whole page is in the viewer's time zone (section ① was UTC until then). The
 * section bands below carry the section headings.
 */
const INTRO = {
  h: 6,
  heading: 'Everything one person did, on one page',
  paragraphs: [
    `Use it to check whether their activity is normal, see what they changed and read, and gather evidence for a review or investigation. ${RAW_RECORDS}`,
    '**How to use it:** pick someone in the Identity control, or click a Principal id in a table; with nobody selected, the page covers everyone. ① *Is this normal?* looks at the 7 days up to the end of the time picker, ② *What they did* follows the time picker (24 hours on opening), and ③ *Evidence* ends in the raw records. Times are in your time zone.',
  ],
  howTo: [
    'Pick an Identity type first to shorten the Identity list. A person’s API keys are identities of their own, so their traffic never counts under the person.',
    'The ① panels read the 7 days before the picker’s end with no noise gate, so they will not match the Events tile.',
    'Baseline: the band is their usual range for each hour; with under three days of history no band is drawn.',
    'The Risk tile and Every scoring action count whole minutes only, so they can stop up to a minute short of the panels around them.',
    'Session timeline: click a bar to pin a session and zoom to it (Elasticsearch panels then read empty); the browser’s Back button returns to the previous time range, and removing the pill shows every session again. API-only identities have no sessions.',
    IDENTITY_HOW_TO,
  ],
};

/**
 * Why the Risk tile and the scoring table can disagree on a live stream, measured rather than guessed.
 * Over one window the two queries agree to the event (probed directly: 21,820 = 21,820 over 9 rows at
 * 1h, 411,675 = 411,675 over 43 rows at 24h). But Kibana resolves a relative range per PANEL, when that
 * panel fetches — request params captured in the browser: the table asked for 23:25:57.535–00:25:57.535
 * and the tile for 23:25:58.133–00:25:58.133, and 1.0s apart on a later load — and the newest seconds of
 * the stream are still arriving: a 5-second window that held 0 events when it closed held 161 45 seconds
 * later. So the later panel sees events the earlier one did not, and the earlier one keeps events that
 * have aged out for the later one. At an ordinary rate that is one event or none (the round-3 render's
 * "exactly 30 short" was one delete); during a burst — this repo's own deploy and render traffic creates
 * saved objects by the hundred — it reached 530 of 47,205. No query can pin another panel's "now", so the
 * table puts the difference in the first sentence of its description and both name it.
 *
 * Re-measured in round 5, because a review read "30 off with every row visible" as a defect in the
 * receipt: the browser sent the tile 02:19:07.524 and the table 02:19:06.868 as `?_tend` (0.66s apart;
 * 0.77s on the next load); the page showed Sum 521,410; both queries re-run on EITHER captured window
 * 30 seconds later returned 521,480 for both, tile and table alike. So the receipt is complete and the
 * two queries are equal; what moves is the stream itself — a closed two-minute window kept growing for
 * 5–7 seconds after it closed (3,005 → 3,025 Elasticsearch events) — and a 30 is one delete landing in
 * that gap. Round 6 ended every dashboard's range at now-1m (TIME_TO, panels.mjs), so nothing in range is
 * still arriving; what is left is the spread between the two panels' `now` at both ends of the range.
 *
 * Round 6 measured that spread on its own render, and it is not always sub-second. light-1h showed Risk
 * 43,980 over Sum 43,580 with all 7 rows visible. Re-running the tile query on windows ending every 5s:
 * 43,580 is the window ending 13:43:09 UTC and 43,980 the one ending 13:43:25 — the two panels resolved
 * `now` ~16 seconds apart (the render resizes its viewport after loading, and a panel that re-renders then
 * can re-fetch), while this repo's own deploy was writing ~2 saved objects a second at that edge. Same
 * window, same number, every time (16,380 = 16,380 at 1h, 496,650 = 496,650 at 24h); the gap is the
 * clock, and a later re-fetch is not something a query can prevent.
 *
 * So the tile and its receipt do not take TIME: both cut their window to whole minutes (WHOLE_MINUTES), so
 * two fetches seconds apart resolve to the SAME window unless they straddle a minute boundary — about one
 * load in sixty for a one-second spread, where TIME let any traffic at either edge show. The cost is that
 * these two panels stop at the last whole minute, up to a minute short of the panels around them, which
 * the page's How to read block says. A one-condition WHERE on constants: free.
 *
 * The START is rounded UP, to the first whole minute inside the range (1.0.5). Until then it was
 * DATE_TRUNC(?_tstart), the minute boundary at or BEFORE the range's start — but Kibana sends every Lens
 * ES|QL request a hidden `@timestamp >= _tstart` filter (THE HIDDEN LENS TIME FILTER, panels.mjs), which
 * silently cut those up-to-59 seconds back off. So the real window began at each panel's own _tstart,
 * the start edge was not whole minutes at all, and the two panels could still differ by whatever landed
 * in the second between their starts. Rounded up, the start is inside the filter and the same for both.
 *
 * It carries CONTROLS_WHERE as TIME does (1.0.5.1, all four dropdowns since 1.0.5.2): without it the Risk tile
 * and its receipts ignored the dropdowns and read the whole estate's risk beside an Events tile narrowed to one
 * identity.
 */
const WHOLE_MINUTES = 'WHERE @timestamp < DATE_TRUNC(1 minute, TO_DATETIME(?_tend)) AND @timestamp >= DATE_TRUNC(1 minute, TO_DATETIME(?_tstart)) + 1 minute' +
  ` AND ${CONTROLS_WHERE}`;

export function build() {
  resetIds();
  const P = stack([
    row(7, [
      // Identity as the Identity dropdown names it (1.0.5.1) and the principal it ran as. Until 1.0.5.1 this was
      // email and principal id, and an unnamed key's Kibana events (user.domain _es_api_key) read as its owner,
      // the Cloud API key. Identity is computed, so the pin is Principal id, a group key of the last STATS: for
      // a person their numeric Cloud id, for a Cloud API key its full id. At 16 columns a 1440px viewport holds
      // an identity, a 20-character id and one count, no more; 20 since 1.0.5.4, for the Identity type badge (the
      // four tiles went from 8 to 7 columns, as Command Center's are).
      [20, (x, y, w, h) => table(x, y, w, h, 'Who this is — by identity and principal id',
        `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ${IDENTITY_KEYS} | WHERE user.email IS NOT NULL OR NOT STARTS_WITH(user.name, "<") | ${ACTOR_RESOLVE} | ${KIND_GROUPED} | STATS events = SUM(events) BY actor, identity_kind, user.name | SORT events DESC, actor, user.name | LIMIT 10`,
        ['actor', filterable('user.name', { label: 'Principal id', width: 165, min: 160 })], ['events'],
        'The identities behind the selection, busiest first, named as in the Identity dropdown, with the Principal id each ran as. Click a Principal id to pin it across the suite. Unattributed requests count in Events but have no row.')],
      [7, (x, y, w, h) => kpi(x, y, w, h,
        // Identities as Who this is lists them (a person and each of their keys are separate; placeholder names and
      // unattributed requests left out): count BY the raw keys first, then resolve. Recency is measured to the end of the range, so a past range does not read "72h ago".
      `FROM ${IDX} | ${TIME} | STATS n = COUNT(*), av = VALUES(event.action), last_ts = MAX(@timestamp) BY ${IDENTITY_KEYS} | ${ACTOR_RESOLVE} | EVAL named = CASE(user.email IS NOT NULL OR NOT STARTS_WITH(user.name, "<"), actor, null) | STATS Events = SUM(n), ids = COUNT_DISTINCT(named), actions = COUNT_DISTINCT(av), last_ts = MAX(last_ts) | EVAL Events = COALESCE(Events, 0), mins = DATE_DIFF("minutes", last_ts, LEAST(TO_DATETIME(?_tend), NOW())) | EVAL detail = CASE(Events == 0, "no activity", CASE(ids > 1, CONCAT(${grouped('ids')}, " identities"), CONCAT(${grouped('actions')}, CASE(actions == 1, " action", " actions"), " · ", CASE(mins < 1, "just now", mins < 60, CONCAT(${grouped('mins')}, "m ago"), CONCAT(TO_STRING(mins / 60), "h ago"))))) | KEEP Events, detail`,
        'Events', 'Every audited event for the selection. For one identity, the line counts its distinct actions and how long before the end of the range it was last active; for more, how many identities the page covers. Routine traffic included.',
        { secondary: 'detail' })],
      [7, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${WHOLE_MINUTES} | ${riskScored()} | STATS sev = SUM(risk * n) BY event.action, risk | STATS Risk = SUM(sev), worst = MAX(risk), kinds = COUNT(*) | EVAL detail = CASE(worst IS NULL, "nothing scored", CONCAT(${grouped('kinds')}, CASE(kinds == 1, " action · worst ", " actions · worst "), ${grouped('worst')})), Risk = COALESCE(Risk, 0) | KEEP Risk, detail`,
        'Risk', 'Total risk for the selection (weight × events for everything that scored), how many scoring actions, and the highest weight; 50 is a security configuration change. Routine activity scores zero. Every scoring action below lists the receipts.',
        { secondary: 'detail' })],
      // Families, not raw names, so the tile counts the same thing as "What they read, by index family"
      // below: a raw count put every dated daily index and its .ds- backing index in separately, and
      // counted request patterns like `*`, `-*` and date math as indices. VALUES first keeps the scan a
      // single keyword aggregation — the fold runs over the handful of distinct names, not documents.
      // Drops shard-level fan-out like the two index tables below (round-5 skeptic): with fan-out in, at 1h
      // the tile read "from 5 indices" beside a table whose Indices column summed to 2, the other three
      // being audit-stream backing generations named only by shard copies. Boolean on a raw keyword.
      // Measured against the raw COUNT_DISTINCT it replaced: 55ms vs 50ms at 1h, 57ms vs 52ms at 24h.
      [7, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | WHERE ${NOT_FANOUT} | STATS idx = VALUES(elasticsearch.audit.indices) | MV_EXPAND idx | EVAL name = CASE(${isPattern('idx')}, null, idx) | EVAL family = ${indexFamily('name')} | STATS \`Index families\` = COUNT_DISTINCT(family), names = COUNT_DISTINCT(name) | EVAL detail = CASE(names == 0, "no index named", CONCAT("from ", ${grouped('names')}, CASE(names == 1, " index", " indices"))) | KEEP \`Index families\`, detail`,
        'Index families', 'How widely this selection reaches into Elasticsearch: index families named in their requests, and how many distinct indices those families hold. Dated and backing indices fold into one family, so thirty days of a daily index is one.',
        { secondary: 'detail' })],
      [7, (x, y, w, h) => kpi(x, y, w, h,
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), ${IP_GEO} BY client.ip | STATS \`Client IPs\` = COUNT(*), countries = COUNT_DISTINCT(country), unplaced = SUM(CASE(placed == 0, 1, 0)) | EVAL detail = CASE(\`Client IPs\` == 0, "no client address", CONCAT(${grouped('countries')}, CASE(countries == 1, " country", " countries"))) | KEEP \`Client IPs\`, detail`,
        'Client IPs', 'Distinct real client addresses for this selection, and how many countries they resolve to. Addresses with no known location (always so for a private address) count in the total only. Many addresses for one named person is the shared-credential signal.',
        { secondary: 'detail' })],
    ]),

    // Directly under the KPI row rather than at the foot of section ②, so the tile and its receipt are
    // read together; the Sum footer is what a reader compares with the tile (WHOLE_MINUTES).
    // EVERY row, scrollable, rather than a top-N: the Risk tile above counts these rows and sums their
    // Risk column, and a top 8 under "43 actions" is a receipt that cannot add up (round-3 review). The
    // set is closed — one row per scoring action and weight, bounded by Kibana's and Elasticsearch's
    // action vocabulary (43 over 24h at today's volume; volume adds events, not rows) — so the LIMIT is
    // a guard, not a cut, and the title says "every" instead of a count (the description says "scroll").
    row(13, [[48, (x, y, w, h) => drillTo(rawId('04-security-anomalies'), table(x, y, w, h, 'Every scoring action and its weight, largest first · its Sum is the Risk tile',
      `FROM ${IDX} | ${WHOLE_MINUTES} | ${riskScored({ aggs: 'last_ts = MAX(@timestamp)' })} | STATS events = SUM(n), severity = SUM(risk * n), last_seen = MAX(last_ts) BY event.action, weight = risk | EVAL why = ${weightWords('weight')} | SORT severity DESC | LIMIT 500`,
      // weight is a number, so it reads as one (right-aligned, beside the other numbers); it stays in the
      // BY clause, so the grouping is unchanged. The action stays the raw event.action because it is the
      // click-to-filter column (an assigned column cannot take a pill); `why` says it in words.
      [filterable('event.action'), sized('why', 220, { label: 'Why it scored' })],
      // The Sum footer is the tile's number computed from THESE rows in the same fetch, so the receipt
      // reconciles on screen whatever is scrolled. Its label says "all rows" because only 11 of 43 fit at 24h (the list scrolls; a title may not say so, CUT in panels.mjs), and 180px holds "Sum, all rows: 4,360,050" at 10x today's 24h.
      ['weight', 'events', { column: 'severity', label: 'Risk', width: 180, summary: { type: 'sum', label: 'Sum, all rows' } }, 'last_seen'],
      'The receipts for the Risk tile: one row per scoring action and weight, largest first; scroll for more. Risk is weight × events, and the Sum under it is the tile\'s number. Click an action, then Open in Security & Anomalies.', { scroll: true, cut: false }))]]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '① Is this normal?', 'the 7 days up to the end of the time picker')]]),
    row(14, [
      [20, vegaPanel('08-actor-baseline-band', 'Is this normal for them? — hourly')],
      [12, vegaPanel('12-actor-cohort', 'Where they rank')],
      [16, vegaPanel('09-activity-punchcard', 'Working rhythm — by hour')],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '② What they did', 'follows the time picker')]]),
    // Custom panel (1.0.8): replaced the Vega ribbon "How they reached what they touched in Kibana"
    // (vega/11-actor-object-flow, removed 2026-11-09 at the user's call); see IDENTITY_PATH.
    // Taller than the 16 rows it had beside the ribbon: a data set's requests open in a panel under the columns.
    row(22, [[48, identityPath]]),
    // Deletes first, then newest. Newest-first alone showed ten creates from the latest burst and put
    // 1,859 deletes (24h) below the panel edge, so a reader concluded this person deleted nothing (round-3
    // review). A delete is the change an investigator looks for first and the one RISK weighs highest
    // here, so it leads; the rest follow newest first, and the list scrolls to the guard of 100 rows.
    // `gone` is a one-condition EVAL on the grouped rows, so it costs nothing per event.
    row(12, [[48, (x, y, w, h) => table(x, y, w, h, '⚠️ What they changed — deletes first, then newest · up to 100',
      `FROM ${IDX} | ${TIME} | ${CHANGED} | ${CASCADE_KEY} | STATS n = COUNT(*), last_ts = MAX(@timestamp) BY ${CHANGED_KEYS}, obj_name, execution, space = kibana.space.id, result, req | ${CASCADE_FOLD} | ${CHANGED_DERIVE} | STATS events = SUM(n), inside = SUM(inside), last_seen = MAX(last_ts) BY verb, type = obj_type, name = obj_name, execution, space, result | EVAL name = CASE(execution == "—", name, CONCAT(name, " · run ", execution)), type = REPLACE(type, "-", " "), gone = verb == "delete" | EVAL name = CASE(inside > 0, CONCAT(name, " · and the ", ${grouped('inside')}, CASE(inside == 1, " object in it", " objects in it")), name) | EVAL verb = CASE(result == "failure", CONCAT(verb, " (failed)"), verb) | DROP execution, result, inside | SORT gone DESC, last_seen DESC | DROP gone | LIMIT 100`,
      // Space is a free-form id, so it gets room for one ('syn-marketing' filled 110px edge to edge).
      // No Execution column: it read "—" on every row that is not a workflow run, which is nearly all of
      // them, so the run id rides on the name instead ("Daily sweep · run 3f2a9c1e").
      // No Result column: Kibana logs most saved-object changes as an attempt (outcome "unknown"), so it
      // read "attempted" on every visible row in every round-4 render and told the reader nothing. The one
      // outcome that matters, a denied change, rides on the operation instead: "delete (failed)". `result`
      // stays in the STATS so a failed change never merges with a successful one; the CASE runs on the
      // grouped rows.
      ['verb', sized('type', 200), sized('name', 560), sized('space', 170)],
      ['events', 'last_seen'],
      'What this selection changed, ran or deleted in Kibana: deletes first, then newest first, up to 100 rows. “(failed)” marks a denied change; other rows are changes Kibana recorded as attempted or completed.', { scroll: true })]]),
    row(11, [
      // A table, not a bar chart. The audit stream itself (every dashboard on this page reads it) is
      // routinely 10x the next family, so on a linear axis the rest of the ranking were 1-2px slivers
      // that read as zero; and Lens hides a bar's value label when it does not fit inside the bar, so
      // `values: true` labelled only the two bars that needed it least. The ranking is the point, and
      // a sorted count column carries it at any spread and at any volume.
      [20, (x, y, w, h) => table(x, y, w, h, 'What they read, by index family',
        `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL AND ${NOT_FANOUT} | MV_EXPAND elasticsearch.audit.indices | STATS n = COUNT(*) BY elasticsearch.audit.indices | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT(*) BY family | SORT events DESC, family | LIMIT ${fitRows(11)}`,
        [{ column: 'family', label: 'Index family' }], ['indices', 'events'],
        'The index families this selection read most, busiest first. Dated and backing indices fold into one family; Indices counts how many of its members were read. The audit stream usually tops the list because these dashboards read it.')],
      [28, (x, y, w, h) => drillTo(rawId('03-data-access'), table(x, y, w, h, '⚠️ System and hidden index reads',
        `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL | MV_EXPAND elasticsearch.audit.indices | ${SYS_INDEX} | STATS n = COUNT(*), seen = MAX(@timestamp) BY elasticsearch.audit.indices, action = elasticsearch.audit.action | ${NOT_PATTERN} | EVAL family = ${INDEX_FAMILY} | INLINE STATS events = SUM(n), indices = COUNT_DISTINCT(elasticsearch.audit.indices), actions = COUNT_DISTINCT(action), last_seen = MAX(seen), named_idx = MIN(elasticsearch.audit.indices) WHERE NOT elasticsearch.audit.indices LIKE ".ds-*", any_idx = MIN(elasticsearch.audit.indices) BY family | WHERE elasticsearch.audit.indices == COALESCE(named_idx, any_idx) | STATS events = MAX(events), indices = MAX(indices), actions = MAX(actions), last_seen = MAX(last_seen) BY elasticsearch.audit.indices, family | SORT events DESC, family | LIMIT ${fitRows(11)}`,
        // The index column is the GROUP KEY of the last STATS, never assigned by an EVAL. Through 1.0.2 it was
        // `EVAL elasticsearch.audit.indices = COALESCE(named_idx, any_idx)` after a STATS BY family:
        // Lens drew it as a link, but Kibana builds no filter from a column created at query time, so a click
        // produced no filter, no "Apply filter" and therefore no drilldown menu at all (clicked in Playwright,
        // 1.0.3). INLINE STATS computes the family totals on the grouped rows, the WHERE keeps the family's
        // representative index, and the STATS BY that raw field dedupes it (one row per action before it).
        // Same rows as before at 1h, 24h and 7d; ~190ms against ~115ms over 24h and 7 days on the live stream.
        // Two count columns at 70px (from 90) so the longest family member, .alerts-observability.threshold.alerts-default, fits at 1440px.
        // The index column flexes and takes the rest; 20/28 split with the family table for the same reason.
        [filterable('elasticsearch.audit.indices', { label: 'Index (one per family)' })], [sized('indices', 70), sized('actions', 70), 'events', 'last_seen'],
        'The system and hidden index families this selection read, counted as in “What they read, by index family” beside it. Click a row to pin it, then open Elasticsearch Data Access to see who else reads it.', { empty: 'good' }))],
    ]),
    row(12, [
      // 18/30 rather than 24/24: a world map is about twice as wide as it is tall, so at w=24 the map was
      // height-bound and a third of the panel sat empty beside it (round-4 review); the address table
      // takes the width instead.
      [18, vegaPanel('10-actor-geography', 'Where they connected from')],
      [30, (x, y, w, h) => drillTo(rawId('05-geo-network'), table(x, y, w, h, 'Busiest addresses they used',
        `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), last_seen = MAX(@timestamp), ${IP_GEO} BY client.ip | EVAL city = CASE(placed == 0, "unplaced", COALESCE(city, "—")), country = CASE(placed == 0, "unplaced", country) | SORT events DESC | LIMIT 25`,
        [filterable('client.ip'), 'city', 'country'], ['events', 'last_seen'],
        'This selection’s real client addresses, busiest first, including ones the map cannot show. “unplaced” means no location was found, always so for a private address; “—” is a country with no city. Click an address to pin it.'))],
    ]),

    row(2, [[48, (x, y, w, h) => section(x, y, w, h, '③ Evidence', 'session timeline: the 24 hours up to the end of the time picker · the records follow the picker')]]),
    row(7, [[48, vegaPanel('13-session-gantt', 'Kibana browser sessions · your time zone')]]),
    row(12, [[48, (x, y, w, h) => sessionRecords(x, y, w, h, 'Session records',
      'The raw Kibana events behind the session timeline, newest first. Click a timeline bar, or a Session cell, to read one session. An hour with only an idle Kibana tab is empty.', { empty: 'quiet' })]]),
  ]);
  // Open in Discover (1.0.7.2): each record panel's menu opens the session holding the same records (shared.mjs).
  openInByTitle(P, {
    "Who this is": '06-actor-first-seen',
    "⚠️ What they changed": '01-all-mutations',
    "⚠️ System and hidden index reads": '05-system-index-access',
    "Kibana browser sessions": '09-session-reconstruction',
    "Session records": '09-session-reconstruction',
    // A URL drilldown cannot read an ES|QL variable, so a link opens every identity's records unless the identity
    // arrived as a pill (a click-through); the menu says so (1.0.7.2 review).
  }, 'Open in Discover (ignores the Identity dropdown)');
  return dash(rawId('07-actor-360'), '[Audit] 👤 Identity 360',
    'One identity’s complete footprint — pick someone in Identity in the control bar and every panel becomes their story.', P, { intro: INTRO });
}
