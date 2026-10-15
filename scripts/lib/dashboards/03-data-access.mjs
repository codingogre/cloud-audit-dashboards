/** 03 Elasticsearch Data Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../env.mjs';
import {
  IDX, ACTOR_RESOLVE, TIME, BUCKET, ESS, INDEX_FAMILY, CONCRETE, SYS_INDEX, cloudKeyLabel, dash, kpi, xy, table, vega, search, sized, resetIds
} from '../panels.mjs';

/**
 * Transport fan-out, dropped AFTER aggregation so it costs nothing: shard/node copies (`…[s]`, `[n]`,
 * `[p]`, `search[phase/…]`) and the ES|QL engine's own sub-actions (`esql/compute`, `esql/data`,
 * `esql/search_shards`, `esql/resolve_fields`, `esql/async/get` polling). One ES|QL query used to
 * read as six rows here; the top-level `indices:data/read/esql` request still counts once.
 */
const FANOUT = '(attributes.elasticsearch.audit.action LIKE "*[*" OR attributes.elasticsearch.audit.action LIKE "indices:data/read/esql/*")';

/**
 * The search an async search runs for itself: `indices:data/read/search` with an EMPTY request class
 * (not null). On both the live stream and the 7-day replica its count and last-seen equal
 * `async_search/submit` exactly, so left in it showed every async search twice — as a second
 * "indices:data/read/search · —" row in Top transport actions and a second read in the volume chart.
 * Needs the request name in the first STATS; COALESCE keeps a null request (none seen) from turning
 * the whole test null, which WHERE NOT would drop.
 */
const ASYNC_INNER = '(attributes.elasticsearch.audit.action == "indices:data/read/search" AND COALESCE(request, "-") == "")';

/**
 * Action family for the volume chart. ECS `event.category` was the old split, and on Elasticsearch
 * audit it is all but one value, so the stack read as one colour with unexplained slivers. Derived
 * from the grouped action, never per document (QUERY SHAPE rule 2 in panels.mjs). Security admin is
 * tested before generic cluster admin — first match wins.
 */
const FAMILY =
  'EVAL family = CASE(attributes.elasticsearch.audit.action LIKE "indices:data/read*", "read", ' +
  'attributes.elasticsearch.audit.action LIKE "indices:data/write*", "write", ' +
  'attributes.elasticsearch.audit.action LIKE "indices:admin*", "index admin", ' +
  'attributes.elasticsearch.audit.action LIKE "cluster:admin/xpack/security*", "security admin", ' +
  'attributes.elasticsearch.audit.action LIKE "cluster:admin*", "cluster admin", ' +
  'attributes.elasticsearch.audit.action LIKE "*:monitor*", "monitor", "other")';

/**
 * The system area an index belongs to: `.alerts-observability.apm.alerts-default` → `.alerts*`,
 * `.slo-observability.sli-v3.6.2026-10-08` → `.slo*`, `.kibana_task_manager_8` → `.kibana*`, with a
 * `.ds-` prefix dropped first. Coarser than INDEX_FAMILY on purpose: one alerts query names ten
 * .alerts-* indices and one SLO read names a dozen dated ones, so per-index rows let a single
 * request fill the ⚠️ table and push everyone else out of view. The table is for spotting WHO; the
 * exact index is in the Discover session under it.
 */
const SYS_AREA = String.raw`CONCAT(REPLACE(attributes.elasticsearch.audit.indices, """^(?:\.ds-)?(\.[^-._]+).*$""", "$1"), "*")`;

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
 * THE LIVE EDGE. Audit events become searchable a few seconds after they happen, and this page's own
 * queries are audited reads, so the last seconds of the range are still filling while the panels load.
 * Measured on the live stream: one fixed 1h range read 5,266 ES|QL queries and, 4s later, 5,270 —
 * then held. Each panel is queried at its own moment, so the ES|QL queries tile and its row in Top
 * transport actions can differ by a few at the default "now" range (round 3 saw 17,012 vs 17,011) and
 * agree once the range ends a minute in the past. Said on both panels, since no query can remove it.
 */
const LIVE_EDGE = 'At a range ending now, panels beside each other can differ by a few: audit events land a few seconds after they happen (this page\'s own queries among them), and each panel is read at a slightly different moment.';

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

/** The tooltip for a Vega panel is its spec's own description — one source, so they cannot disagree. */
const specDescription = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8')).description;

/**
 * The volume chart's legend sits right with each family's range total (Lens legend statistics, read
 * back from a deployed panel): at 24h "cluster admin" was 69 requests beside 89,446 reads, a bar too thin
 * to see, so the legend named a family the chart did not visibly draw. Size xl: at l the right legend
 * cut "cluster admin" and "security admin".
 */
const withTotals = (p) => { p.config.legend = { ...p.config.legend, size: 'xl', statistics: ['total'] }; return p; };

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ESS} | STATS \`Elasticsearch events\` = COUNT(*)`, 'Elasticsearch events', 'All Elasticsearch audit events in range.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | STATS BY attributes.elasticsearch.audit.indices | ${CONCRETE} | EVAL family = ${INDEX_FAMILY} | STATS \`Index families\` = COUNT_DISTINCT(family)`,
      'Index families', 'Distinct indices named in audited requests, with each data stream\'s backing indices and each run of dated daily indices counted once. Wildcard and date-math expressions (*, -*, <…{now/d}>) are patterns, not indices, and are left out.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | STATS BY attributes.elasticsearch.audit.action | WHERE NOT ${FANOUT} | STATS \`Distinct actions\` = COUNT(*)`, 'Distinct actions',
      'Distinct Elasticsearch transport actions (cluster:*, indices:*), with shard-level copies and ES|QL sub-steps folded away — the same actions Top transport actions lists, all traffic.'),
    // The top-level request only. `LIKE "*esql*"` also counted the engine's own fan-out (compute,
    // data, search_shards, resolve_fields, async polling) and read ~9x the queries actually run —
    // a figure that grew with shard count, not with anyone's activity. `==` also pushes down.
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action == "indices:data/read/esql" | STATS \`ES|QL queries\` = COUNT(*)`, 'ES|QL queries',
      `ES|QL queries submitted — one per query, not per shard or sub-step. Includes the queries these dashboards run to draw themselves. Equals the indices:data/read/esql row in Top transport actions. ${LIVE_EDGE}`),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | ${SYS_INDEX} | STATS \`System index access\` = COUNT(*)`, 'System index access',
      'Requests touching dot-prefixed system and hidden indices (.kibana*, .security*, .slo-*, .alerts-*), counted once per index named. Backing indices of ordinary data streams (.ds-logs-…) are not system data and are left out, as are shard-level copies of a request.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "access_denied" OR attributes.event.action == "anonymous_access_denied" | STATS \`Access denied\` = COUNT(*)`, 'Access denied', 'Authorization denials. Sustained non-zero values mean a misconfigured client or a probe.'),
    withTotals(xy(0, 5, 24, 15, 'Data access over time by action family',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | STATS n = COUNT(*) BY time = ${BUCKET}, attributes.elasticsearch.audit.action, request = attributes.elasticsearch.audit.request.name | WHERE NOT ${FANOUT} AND NOT ${ASYNC_INNER} | ${FAMILY} | STATS events = SUM(n) BY time, family | SORT family`,
      'events', 'Every Elasticsearch request that names a transport action, by kind of action — all traffic, the searches and ES|QL these dashboards run among the reads. Shard-level copies, ES|QL sub-steps and the search an async search runs for itself are folded away so a request counts once, and authentication and connection events (which name no action) are left out, so it sums to less than the Elasticsearch events tile. The legend gives each family\'s total, so a family too small to see as a bar is still counted; Lens leaves the bucket still filling at the right edge out of those totals (up to half an hour at 24h), so they run behind the bars and the tiles. A stretch with no bars means no audited Elasticsearch request in that span — on a wide range that includes the time before the project\'s audit stream began.',
      { breakdown: 'family', xcol: 'time', colors: FAMILY_COLORS, legend: 'right' })),
    // The matrix (vega/04) packs to the top left: each band scale's range is min(panel, cells × step),
    // with the cell count read from a no-op `opacity` / `strokeWidth` scale over the same field — a
    // scale cannot read its own domain (Vega errors), and only `width/height: "container"` lets a
    // position scale take a custom range under autosize fit. The legend follows the last row
    // (orient "none"). Identity labels stand at -90° with labelAlign "left": each stays inside its own
    // column at any count, where the 35° diagonal crossed neighbouring lanes and ran the first label
    // off the top-left. Round 3 showed one 1h identity as two cells adrift in a 900×800 panel.
    vega(24, 5, 24, 30, '04-actor-index-matrix', 'Who reads which index family · up to 10 identities', specDescription('04-actor-index-matrix')),
    // Busiest identity per family, so a quiet hour that is only these dashboards reading the audit
    // stream says so on the row (Identities 1, Busiest the Cloud key) instead of reading as two
    // unexplained rows. Two STATS over grouped rows; BUSIEST_KEY picks the largest pair per family.
    // The Indices count gave its width to it: with both, a 48-character family name was cut at a
    // 1440px viewport, and wrapping it took three lines a row (rendered).
    table(0, 20, 24, 15, 'Top index families by events',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | STATS n = COUNT(*) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.indices | ${CONCRETE} | ${ACTOR_RESOLVE}, index = ${INDEX_FAMILY} | STATS n = SUM(n) BY index, actor | EVAL k = ${BUSIEST_KEY} | STATS events = SUM(n), actors = COUNT(*), top = MAX(k) BY index | SORT events DESC | LIMIT 14 | EVAL busiest = SUBSTRING(top, 14) | EVAL busiest = ${cloudKeyLabel('busiest')} | KEEP index, busiest, actors, events`,
      [{ column: 'index', label: 'Index family' }, sized('busiest', 170, { label: 'Busiest identity' })], [sized('actors', 80), sized('events', 84)],
      'The busiest index families, all traffic; the Index families tile counts every one, so the rest are beyond this list. Identities is how many distinct identities touched the family, and Busiest identity is the one with the most requests against it — over a quiet hour the list is often only the audit stream itself, read by the identity these dashboards run as. A data stream and its backing indices are one row, as is a run of dated daily indices. Wildcard and date-math expressions are left out. A request naming several indices counts once per index, and a search\'s shard-level copies count too (they are the events that name the concrete indices behind a wildcard), so Events runs above the request counts in Data access over time and Top transport actions; it is the same count the matrix beside it colours. A Busiest identity shown as “_4KEO… · Cloud API key” is an organization-level Elastic Cloud API key, which the audit stream records only by its opaque id.'),
    table(0, 35, 48, 14, 'Top transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | STATS n = COUNT(*), seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.action, request = attributes.elasticsearch.audit.request.name | WHERE NOT ${FANOUT} AND NOT ${ASYNC_INNER} | ${ACTOR_RESOLVE}, request = CASE(request IS NULL OR request == "", "—", request) | STATS events = SUM(n), actors = COUNT_DISTINCT(actor), last_seen = MAX(seen) BY attributes.elasticsearch.audit.action, request | SORT events DESC | LIMIT 15`,
      [sized('attributes.elasticsearch.audit.action', 420), 'request'], ['actors', 'events', 'last_seen'],
      `The busiest Elasticsearch transport actions with their request class, all traffic — the searches and ES|QL reads these dashboards run included, since reads are what this page is about. The Distinct actions tile counts every action; the rest are beyond this list, and an action sent with two request classes is two rows. Shard-level copies, ES|QL sub-steps and the search an async search runs for itself are folded away, so a request counts once. Identities is how many distinct identities sent the action; Request "—" means the event named no request class. ${LIVE_EDGE}`),
    // One row per identity: per (identity, action, index) one persona's run filled the panel and the
    // visible rows summed to 749 of the tile's 853 (round 3). The newest denial's action and index are
    // carried as one sortable string (ISO time first), so they belong to the same event as Last seen.
    table(0, 49, 48, 12, 'Denied requests by identity',
      `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "access_denied" OR attributes.event.action == "anonymous_access_denied" | STATS events = COUNT(*), seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.action, attributes.elasticsearch.audit.indices | ${ACTOR_RESOLVE}, k = CONCAT(TO_STRING(seen), "|", COALESCE(attributes.elasticsearch.audit.action, "—"), "|", COALESCE(attributes.elasticsearch.audit.indices, "—")) | STATS events = SUM(events), last_seen = MAX(seen), latest = MAX(k), actions = COUNT_DISTINCT(attributes.elasticsearch.audit.action), indices = COUNT_DISTINCT(attributes.elasticsearch.audit.indices) BY actor | EVAL latest_action = MV_SLICE(SPLIT(latest, "|"), 1), latest_index = MV_SLICE(SPLIT(latest, "|"), 2) | KEEP actor, latest_action, latest_index, actions, indices, events, last_seen | SORT last_seen DESC | LIMIT 15`,
      ['actor', { column: 'latest_action', label: 'Latest denied action' }, { column: 'latest_index', label: 'On index' }], [{ column: 'actions', label: 'Actions' }, 'indices', { column: 'events', label: 'Denials' }, 'last_seen'],
      'Who was refused, newest first: one row per identity, with the action and index of its most recent denial, how many distinct actions and indices it was refused on, and its denials in range — the rows add up to the Access denied tile when every identity is in view. On index "—" is a cluster-level request; <anonymous> with action "—" is an HTTP call that carried no credentials.',
      { empty: 'good' }),
    // One row per identity, for the same reason: per (identity, index group, action) a single
    // resolve/index request naming a dozen system areas filled the panel and pushed every other
    // identity out of view, so the newest-first sort hid the one-off reads it exists to surface.
    // FAMILY runs on the grouped rows (identity × index × action), never per event.
    table(0, 61, 48, 10, '⚠️ Who touched system and hidden indices',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | ${SYS_INDEX} | STATS n = COUNT(*), seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.indices, attributes.elasticsearch.audit.action | ${ACTOR_RESOLVE}, area = ${SYS_AREA} | ${FAMILY} | STATS events = SUM(n), indices = COUNT_DISTINCT(attributes.elasticsearch.audit.indices), groups = VALUES(area), kinds = VALUES(family), last_seen = MAX(seen) BY actor | EVAL groups = MV_CONCAT(MV_SORT(groups), ", "), kinds = MV_CONCAT(MV_SORT(kinds), ", ") | KEEP actor, groups, kinds, indices, events, last_seen | SORT last_seen DESC | LIMIT 25`,
      ['actor', { column: 'groups', label: 'Index groups' }, sized('kinds', 240, { label: 'Kind of access' })], ['indices', 'events', 'last_seen'],
      'Who touched system and hidden indices — Kibana internals, the security index, alerting and SLO data — one row per identity, newest first: the index groups it touched (.alerts*, .slo*, .kibana*…), the kinds of transport action (read, write, index admin, monitor…), how many real indices, and its requests in range, which add up to the System index access tile when every identity is in view. The Discover session below names each index and action. Backing indices of ordinary data streams (.ds-logs-…) and shard-level copies of a request are left out. Expected from Kibana and platform automation; unexpected from anyone else, and a write from anyone else is worth a look. An identity that touched many groups wraps onto a second line rather than cutting the list short.',
      { empty: 'quiet', wrap: true }),
    search(0, 71, 48, 12, '05-system-index-access', 'Raw system index requests · newest 1,000 at most',
      'The raw events behind the table above: the newest 1,000 requests against a system or hidden index, one row per index named, newest first. It stops at 1,000, so it can hold fewer rows than the System index access tile counts — the "1,000 results" above the grid is that cap, not the total.',
      { empty: 'quiet' }),
  ];
  return dash('cloud-audit-03-data-access', '[Audit] 🔎 Elasticsearch Data Access',
    'What data was read, by whom, through which transport action — including system indices.', P);
}
