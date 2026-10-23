/** 03 Elasticsearch Data Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../env.mjs';
import {
  IDX, ACTOR_RESOLVE, TIME, BUCKET, ESS, INDEX_FAMILY, CONCRETE, SYS_INDEX, cloudKeyLabel, dash, kpi, prevKpi, xy, table, vega, sized, filterable, fitRows, resetIds
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import { PIN_BY, PIN_KEY, PIN_PRINCIPAL_SHORT, RAW_RECORDS } from './shared.mjs';

/**
 * Transport fan-out, dropped AFTER aggregation so it costs nothing: shard/node copies (`…[s]`, `[n]`,
 * `[p]`, `search[phase/…]`) and the ES|QL engine's own sub-actions (`esql/compute`, `esql/data`,
 * `esql/search_shards`, `esql/resolve_fields`, `esql/async/get` polling). One ES|QL query used to
 * read as six rows here; the top-level `indices:data/read/esql` request still counts once.
 */
const FANOUT = '(elasticsearch.audit.action LIKE "*[*" OR elasticsearch.audit.action LIKE "indices:data/read/esql/*")';

/**
 * The search an async search runs for itself: `indices:data/read/search` with an EMPTY request class
 * (not null). On both the live stream and the 7-day replica its count and last-seen equal
 * `async_search/submit` exactly, so left in it showed every async search twice — as a second
 * "indices:data/read/search · —" row in Top transport actions and a second read in the volume chart.
 * Needs the request name in the first STATS; COALESCE keeps a null request (none seen) from turning
 * the whole test null, which WHERE NOT would drop.
 */
const ASYNC_INNER = '(elasticsearch.audit.action == "indices:data/read/search" AND COALESCE(request, "-") == "")';

/**
 * Action family for the volume chart. ECS `event.category` was the old split, and on Elasticsearch
 * audit it is all but one value, so the stack read as one colour with unexplained slivers. Derived
 * from the grouped action, never per document (QUERY SHAPE rule 2 in panels.mjs). Security admin is
 * tested before generic cluster admin — first match wins.
 */
const FAMILY =
  'EVAL family = CASE(elasticsearch.audit.action LIKE "indices:data/read*", "read", ' +
  'elasticsearch.audit.action LIKE "indices:data/write*", "write", ' +
  'elasticsearch.audit.action LIKE "indices:admin*", "index admin", ' +
  'elasticsearch.audit.action LIKE "cluster:admin/xpack/security*", "security admin", ' +
  'elasticsearch.audit.action LIKE "cluster:admin*", "cluster admin", ' +
  'elasticsearch.audit.action LIKE "*:monitor*", "monitor", "other")';

/**
 * The system area an index belongs to: `.alerts-observability.apm.alerts-default` → `.alerts*`,
 * `.slo-observability.sli-v3.6.2026-10-08` → `.slo*`, `.kibana_task_manager_8` → `.kibana*`, with a
 * `.ds-` prefix dropped first. Coarser than INDEX_FAMILY on purpose: one alerts query names ten
 * .alerts-* indices and one SLO read names a dozen dated ones, so per-index rows let a single
 * request fill a table and push everyone else out of view. The exact index is in Raw system index
 * requests below. `.alert-actions` is named whole: cut at its first hyphen it read `.alert*`, which sat
 * beside `.alerts*` in the same cell and looked like a typo of it (round-4 review).
 */
const sysArea = (col) => String.raw`CONCAT(REPLACE(${col}, """^(?:\.ds-)?(\.(?:alert-actions|[^-._]+)).*$""", "$1"), "*")`;
const SYS_AREA = sysArea('elasticsearch.audit.indices');

/**
 * An index family, with system and hidden families folded into their area — the same groups the ⚠️
 * table names. Six `.alerts-*` rows at 283 events each, all one persona's field_caps request, pushed
 * real data families out of Top index families and the matrix (round-4 review). One-condition CASE on
 * grouped rows (QUERY SHAPE rule 1), and the Index families tile counts the same folded families.
 * Takes the column already holding INDEX_FAMILY.
 */
const foldSys = (col) => `EVAL ${col} = CASE(LEFT(${col}, 1) == ".", ${sysArea(col)}, ${col})`;

/**
 * Per-run indices: a name stamped with a date AND a time of day, then whatever the run appended
 * (`syn-tmp-20261014-152111-2820-mv8b4yna60`, `syn-tmp-20261014-133125-8909-2454`), is one family,
 * shown as its stem with a `*` (`syn-tmp*`). INDEX_FAMILY folds only a trailing calendar date, so each
 * such index was its own family: a 24h window held 60 of them at ~10 events each, they took 6 of the
 * matrix's 25 rows under raw generated names and counted 60 times in the Index families tile (round-5
 * review). The test is the shape of the name (8 digits, then 6), never a particular prefix. One
 * REPLACE on grouped rows, after INDEX_FAMILY; vega/04 embeds the same text.
 */
const foldRun = (col) => String.raw`EVAL ${col} = REPLACE(${col}, """[-.]\d{8}[-.T]?\d{6}(?:[-.].*)?$""", "*")`;

/** INDEX_FAMILY's value, then both folds: what "index family" means on every panel of this page. */
const fold = (col) => `${foldRun(col)} | ${foldSys(col)}`;

/**
 * The copies of a request that name the same index again: shard and node copies (`…[s]`, `[n]`,
 * `search[phase/…]`), and the ES|QL engine's `search_shards` and `data` steps. Left out PER EVENT
 * (a boolean, cheap — QUERY SHAPE rule 1) by every panel that counts events per index, so a request
 * counts once per index it names. Measured on the live stream over 24h: every index family is named
 * by a top-level event as well, so nothing is lost — field_caps[n] alone had tripled one persona's
 * .alerts* reads against the ⚠️ table. An ES|QL query names its indices only on its sub-steps (the
 * top-level `indices:data/read/esql` event names none), so `esql/resolve_fields`, one per query, is the
 * one kept. Unlike FANOUT, which drops every ES|QL sub-step because Top transport actions counts the
 * top-level request.
 */
const COPIES = '(elasticsearch.audit.action IS NULL OR NOT (elasticsearch.audit.action LIKE "*[*" OR elasticsearch.audit.action IN ("indices:data/read/esql/search_shards", "indices:data/read/esql/data")))';

/**
 * Pinned so a family keeps its colour as families come and go with the window. PALETTE hues, chosen so
 * no two near hues touch in the stack (alphabetical: cluster admin, index admin, monitor, other, read,
 * security admin, write): tan beside yellow and pink beside red-orange were indistinguishable in dark.
 */
const FAMILY_COLORS = {
  read: '#54B399', write: '#6092C0', 'index admin': '#D6BF57', 'security admin': '#E7664C',
  'cluster admin': '#9170B8', monitor: '#D36086', other: '#B9A888',
};


/**
 * "Busiest" from rows already grouped by (key, actor): the largest n per key, carried as a string so
 * MAX can pick it — the count offset to a fixed 13 digits, then the identity. Runs on the grouped rows
 * (identity × family pairs), never per event.
 */
const BUSIEST_KEY = 'CONCAT(TO_STRING(n + 1000000000000), actor)';

/**
 * NO NOISE GATE ON THIS PAGE. The suite's gate drops query internals — search, msearch, scroll, ES|QL,
 * field_caps, async search — and on a page about who reads what, those reads ARE the subject: gated,
 * the volume chart lost its whole "read" family (36k of 37k requests in an hour) and Transport actions
 * kept five admin rows. So every panel here counts all traffic, which is also what makes the KPIs,
 * the tables and the matrix reconcile (README: same gate). The duplication the gate used to hide is
 * removed instead by folding FANOUT and ASYNC_INNER and by counting only events that name a transport action.
 */

/**
 * Folds every row past the (rows − 1) newest into one "N other identities" row, so a newest-first table
 * still adds up to its tile when more identities are in range than it can show. Runs on the per-identity
 * rows (a few dozen), never per event: INLINE STATS hands each row the newest-first list of Last seen
 * values, the (rows − 1)th of which is the cut. The sort key is Last seen with the identity appended,
 * unique per row: VALUES de-duplicates, so on bare Last seen two identities refused in the same
 * millisecond would share one value, move the cut down a row and push the eleventh row past LIMIT,
 * where the Denials column no longer adds up to the tile. Expects `actor`, `events`, `last_seen`, `latest`,
 * and `actions`, `indices` as VALUES lists, so the folded row carries the union of its identities' actions and
 * indices (a true distinct count, not the largest of theirs) and its newest denial, the one its Last seen
 * names; adds `folded` (how many identities a row stands for).
 */
const foldRest = (rows) =>
  `EVAL sk = CONCAT(TO_STRING(last_seen), "|", actor) | ` +
  `INLINE STATS ids = COUNT(*), recent = VALUES(sk) | EVAL cut = MV_MIN(MV_SLICE(MV_SORT(recent, "DESC"), 0, ${rows - 2})) | ` +
  `EVAL actor = CASE(ids > ${rows} AND sk < cut, "~rest", actor) | ` +
  'STATS events = SUM(events), last_seen = MAX(last_seen), latest = MAX(latest), actions = VALUES(actions), indices = VALUES(indices), folded = COUNT(*) BY actor | ' +
  'EVAL actor = CASE(actor == "~rest", CONCAT(TO_STRING(folded), " other identities"), actor)';

/** The tooltip for a Vega panel is its spec's own description — one source, so they cannot disagree. */
const specDescription = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8')).description;

/**
 * The volume chart's legend sits right with each family's range total (Lens legend statistics, read
 * back from a deployed panel): at 24h "cluster admin" was 69 requests beside 89,446 reads, a bar too thin
 * to see, so the legend named a family the chart did not visibly draw. Size xl: at l the right legend
 * cut "cluster admin" and "security admin".
 */
const withTotals = (p) => { p.config.legend = { ...p.config.legend, size: 'xl', statistics: ['total'] }; return p; };

/** The intro (draft 5 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 6,
  heading: "What data was read or written in Elasticsearch, and by whom",
  paragraphs: [
    `See which indices each identity uses, the kinds of requests they made, any denied requests, and every touch of system or hidden indices. ${RAW_RECORDS}`,
    "Related indices are grouped into one family, so a data stream and its daily backing indices read as a single row. Use it to confirm that sensitive data is reached only by the people and keys you expect.",
    "**How to use it:** choose a Project, Person (email), API key or Client IP in the controls and set the time picker. Empty denied and system-index panels usually mean all is well.",
  ],
  howTo: [
    'This page counts all traffic, these dashboards’ own reads included: on a page about who reads what, those reads are the subject.',
    'A request counts once per index it names; shard copies and internal sub-steps are left out. Ranked tables show the top rows; the tiles count everything.',
    'Matrix: a blank cell means no reads, or too few to be among the 500 busiest identity–family pairs.',
    'System and hidden index access is expected from Kibana and platform automation; from anyone else, look closer.',
    'The chart legend’s totals leave out the partial bucket at the right edge, so they can run behind the tiles.',
  ],
};

export function build() {
  resetIds();
  const P = [
    // Three DSL Vega tiles with a previous-period line (PREV_TILES in panels.mjs, held to their ES|QL by --lint).
    prevKpi(0, 0, 8, 5, 'es-events', 'All Elasticsearch audit events in range.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL AND ${COPIES} | STATS BY elasticsearch.audit.indices | ${CONCRETE} | EVAL family = ${INDEX_FAMILY} | ${fold('family')} | STATS \`Index families\` = COUNT_DISTINCT(family)`,
      'Index families', 'Distinct index families named in requests. A data stream and its backing indices, or a run of dated indices, count as one family; system and hidden indices count once per area. Wildcard patterns are not counted.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.action IS NOT NULL | STATS BY elasticsearch.audit.action | WHERE NOT ${FANOUT} | STATS \`Distinct actions\` = COUNT(*)`, 'Distinct actions',
      'Distinct Elasticsearch transport actions (cluster:*, indices:*), the same actions Top transport actions lists, all traffic.'),
    // The top-level request only (PREV_TILES esql-queries). `LIKE "*esql*"` also counted the engine's own fan-out (compute,
    // data, search_shards, resolve_fields, async polling) and read ~9x the queries actually run —
    // a figure that grew with shard count, not with anyone's activity. `==` also pushes down.
    prevKpi(24, 0, 8, 5, 'esql-queries',
      'ES|QL queries submitted, one per query rather than per shard or sub-step. Includes the queries these dashboards run to draw themselves.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL | MV_EXPAND elasticsearch.audit.indices | ${SYS_INDEX} | STATS \`System index access\` = COUNT(*)`, 'System index access',
      'Requests touching system and hidden indices (.kibana*, .security*, .slo-*, .alerts-*), counted once per index named. Ordinary data-stream backing indices are not system data and are left out.'),
    prevKpi(40, 0, 8, 5, 'access-denied', 'Authorization denials. Sustained non-zero values mean a misconfigured client or a probe.'),
    withTotals(xy(0, 5, 24, 15, 'Data access over time by action family',
      `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.action IS NOT NULL | STATS n = COUNT(*) BY time = ${BUCKET}, elasticsearch.audit.action, request = elasticsearch.audit.request.name | WHERE NOT ${FANOUT} AND NOT ${ASYNC_INNER} | ${FAMILY} | STATS events = SUM(n) BY time, family | SORT family`,
      'events', 'Elasticsearch requests over time by kind of action (read, write, admin…), all traffic, including these dashboards’ own reads. Each request counts once. The legend gives each kind’s total; a gap means no audited requests then.',
      { breakdown: 'family', xcol: 'time', colors: FAMILY_COLORS, legend: 'right' })),
    // The matrix (vega/04) packs to the top left: each band scale's range is min(panel, cells × step),
    // with the cell count read from a no-op `opacity` / `strokeWidth` scale over the same field — a
    // scale cannot read its own domain (Vega errors), and only `width/height: "container"` lets a
    // position scale take a custom range under autosize fit. The legend follows the last row
    // (orient "none"). Identity labels stand at -90° with labelAlign "left": each stays inside its own
    // column at any count, where the 35° diagonal crossed neighbouring lanes and ran the first label
    // off the top-left. Round 3 showed one 1h identity as two cells adrift in a 900×800 panel.
    // With three identities or fewer (a quiet hour is often only these dashboards' own key) the
    // columns widen to 200px and the labels stand level, centred over their cells — round 4 read a
    // lone identity as a rotated id; round 5 found the CELL still capped at 64px inside the 200px
    // column, so a level label spilled past it on both sides — the cell now fills its column there,
    // and the axis title stands 8px clear of the labels. Rows are in Top index families' order (each
    // family's events from every identity, then name — the table sorts the same way), so the two
    // read side by side; ranked only among the ten identities shown, they had no visible order.
    // The line above the matrix counts what is drawn ("1 identity ×
    // 2 index families shown"), so a sparse window reads as sparse, not as a panel that promised
    // ten identities and failed to draw them.
    vega(24, 5, 24, 30, '04-actor-index-matrix', 'Who reads which index family · up to 10 identities', specDescription('04-actor-index-matrix')),
    // Busiest identity per family, so a quiet hour that is only these dashboards reading the audit
    // stream says so on the row (Identities 1, Busiest the Cloud key) instead of reading as two
    // unexplained rows. Two STATS over grouped rows; BUSIEST_KEY picks the largest pair per family.
    // The Indices count gave its width to it: with both, a 48-character family name was cut at a
    // 1440px viewport, and wrapping it took three lines a row (rendered).
    table(0, 20, 24, 15, 'Top index families by events',
      `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL AND ${COPIES} | STATS n = COUNT(*) BY user.email, api_key.name, user.name, elasticsearch.audit.indices | ${CONCRETE} | ${ACTOR_RESOLVE}, index = ${INDEX_FAMILY} | ${fold('index')} | STATS n = SUM(n) BY index, actor | EVAL k = ${BUSIEST_KEY} | STATS events = SUM(n), actors = COUNT(*), top = MAX(k) BY index | SORT events DESC, index | LIMIT ${fitRows(15)} | EVAL busiest = SUBSTRING(top, 14) | EVAL busiest = ${cloudKeyLabel('busiest')} | KEEP index, busiest, actors, events`,
      [{ column: 'index', label: 'Index family' }, sized('busiest', 170, { label: 'Busiest identity' })], [sized('actors', 80), sized('events', 84)],
      'The busiest index families across all traffic, with how many identities touched each and the busiest one. Over a quiet range this is often just the audit stream, read by the identity these dashboards run as.'),
    table(0, 35, 48, 14, 'Top transport actions',
      `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.action IS NOT NULL | STATS n = COUNT(*), seen = MAX(@timestamp) BY user.email, api_key.name, user.name, elasticsearch.audit.action, request = elasticsearch.audit.request.name | WHERE NOT ${FANOUT} AND NOT ${ASYNC_INNER} | ${ACTOR_RESOLVE}, request = CASE(request IS NULL OR request == "", "—", request) | STATS events = SUM(n), actors = COUNT_DISTINCT(actor), last_seen = MAX(seen) BY elasticsearch.audit.action, request | SORT events DESC | LIMIT ${fitRows(14)}`,
      [sized('elasticsearch.audit.action', 420), 'request'], ['actors', 'events', 'last_seen'],
      'The busiest Elasticsearch actions with their request type and how many identities sent each, all traffic, including these dashboards’ own reads. Each request counts once. The Distinct actions tile counts every action, listed or not.'),
    // One row per identity: per (identity, action, index) one persona's run filled the panel and the
    // visible rows summed to 749 of the tile's 853 (round 3). The newest denial's action and index are
    // carried as one sortable string (ISO time first), so they belong to the same event as Last seen.
    // foldRest() folds every identity past the ninth newest into one last row, so the rows add up to
    // the Access denied tile at any count (round 4: ten of fifteen identities summed to 842 of 853).
    // No API key / Principal id click columns here (PIN_COLS, shared.mjs): the folded row would need its raw
    // keys nulled, and a column the query assigns cannot be clicked. The fold wins; the table below has them.
    table(0, 49, 48, 12, 'Denied requests by identity',
      `FROM ${IDX} | ${TIME} | WHERE event.action == "access_denied" OR event.action == "anonymous_access_denied" | STATS events = COUNT(*), seen = MAX(@timestamp) BY user.email, api_key.name, user.name, elasticsearch.audit.action, elasticsearch.audit.indices | ${ACTOR_RESOLVE}, k = CONCAT(TO_STRING(seen), "|", COALESCE(elasticsearch.audit.action, "—"), "|", COALESCE(elasticsearch.audit.indices, "—")) | STATS events = SUM(events), last_seen = MAX(seen), latest = MAX(k), actions = VALUES(elasticsearch.audit.action), indices = VALUES(elasticsearch.audit.indices) BY actor | ${foldRest(fitRows(12))} | EVAL latest_action = MV_SLICE(SPLIT(latest, "|"), 1), latest_index = MV_SLICE(SPLIT(latest, "|"), 2), actions = COALESCE(MV_COUNT(actions), 0), indices = COALESCE(MV_COUNT(indices), 0) | KEEP actor, latest_action, latest_index, actions, indices, events, last_seen | SORT last_seen DESC | LIMIT ${fitRows(12)}`,
      ['actor', { column: 'latest_action', label: 'Latest denied action' }, { column: 'latest_index', label: 'On index' }], [{ column: 'actions', label: 'Actions' }, 'indices', { column: 'events', label: 'Denials' }, 'last_seen'],
      'Who was refused, newest first: each identity’s latest denied action and index, how many actions and indices, and its denials. A last row “N other identities” holds the rest; index “—” is a cluster-level request.',
      { empty: 'good' }),
    // One row per identity, for the same reason: per (identity, index group, action) a single
    // resolve/index request naming a dozen system areas filled the panel and pushed every other
    // identity out of view, so the newest-first sort hid the one-off reads it exists to surface.
    // FAMILY runs on the grouped rows (identity × index × action), never per event.
    table(0, 61, 48, 10, '⚠️ Who touched system and hidden indices',
      `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL | MV_EXPAND elasticsearch.audit.indices | ${SYS_INDEX} | STATS n = COUNT(*), seen = MAX(@timestamp) BY user.email, api_key.name, user.name, elasticsearch.audit.indices, elasticsearch.audit.action | ${ACTOR_RESOLVE}, area = ${SYS_AREA} | ${FAMILY} | STATS events = SUM(n), indices = COUNT_DISTINCT(elasticsearch.audit.indices), groups = VALUES(area), kinds = VALUES(family), last_seen = MAX(seen) BY actor, ${PIN_BY} | EVAL groups = MV_CONCAT(MV_SORT(groups), ", "), kinds = MV_CONCAT(MV_SORT(kinds), ", ") | KEEP actor, api_key.name, user.name, groups, kinds, indices, events, last_seen | SORT last_seen DESC | LIMIT 25`,
      ['actor', PIN_KEY, PIN_PRINCIPAL_SHORT, { column: 'groups', label: 'Index groups' }, sized('kinds', 240, { label: 'Kind of access' })], ['indices', 'events', 'last_seen'],
      'Who touched system and hidden indices (Kibana internals, security, alerting, SLO data), with the index groups, kinds of action and request count. Expected from Kibana and platform automation; from anyone else, a write is worth a look.',
      { empty: 'quiet', wrap: true }),
    // The raw requests, as a Lens table since 1.0.5.1 (RECORD FEEDS, panels.mjs), so the identity dropdowns narrow
    // it: searches/05's logic, sorted and cut straight after the filter (QUERY SHAPE rule 3). Transport action,
    // Index and Client IP are the raw fields, so a click pins them.
    table(0, 71, 48, 12, 'Raw system index requests',
      `FROM ${IDX} | ${TIME} | WHERE elasticsearch.audit.indices IS NOT NULL | MV_EXPAND elasticsearch.audit.indices | ${SYS_INDEX} | SORT @timestamp DESC | LIMIT 1000 | ${ACTOR_RESOLVE} | KEEP @timestamp, actor, elasticsearch.audit.action, elasticsearch.audit.indices, client.ip`,
      [sized('actor', 245, { min: 200 }), filterable('elasticsearch.audit.action', { width: 300, min: 240 }), filterable('elasticsearch.audit.indices'), filterable('client.ip')], ['@timestamp'],
      'The raw requests behind the system index table above, one row per index named, newest first: one request naming ten indices is ten rows. Click an action, index or address to pin it.',
      { scroll: true, empty: 'quiet' }),
  ];
  return dash(rawId('03-data-access'), '[Audit] 🔎 Elasticsearch Data Access',
    'What data was read, by whom, through which transport action — including system indices.', P, { intro: INTRO });
}
