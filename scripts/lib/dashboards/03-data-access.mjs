/** 03 Elasticsearch Data Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../env.mjs';
import {
  IDX, ACTOR_RESOLVE, NOISE, TIME, BUCKET, ESS, dash, kpi, xy, table, vega, search, sized, resetIds
} from '../panels.mjs';

/**
 * Folds dated daily indices and data-stream backing indices into the family they belong to, so
 * `.ds-logs-x-2026.10.14-000001` and `logs-x` are one row and seven `.slo-…-2026-10-0N` days are one.
 * The same characters as 07-actor-360.mjs, so "index family" means one thing in the suite; it should
 * move to panels.mjs next to the other fragments (and into the vega/04 drift check) — that is a shared
 * file, so it is duplicated here for now.
 */
const INDEX_FAMILY = String.raw`REPLACE(REPLACE(attributes.elasticsearch.audit.indices, """^\.ds-""", ""), """[-.]?\d{4}[.-]\d{2}[.-]\d{2}(-\d+)?$""", "")`;

/**
 * Index EXPRESSIONS, not indices: `*`, `-*`, `syn-*` and date math like `<.slo-…{2026-10-14||/d}>`.
 * Elasticsearch records the expression as the client wrote it, and the concrete indices it resolved
 * to appear on the shard-level events beside it, so counting both double-counts and lists a pattern
 * as if it were something you could open. Applied to grouped rows, so it costs nothing per document.
 */
const CONCRETE = 'WHERE LOCATE(attributes.elasticsearch.audit.indices, "*") == 0 AND NOT attributes.elasticsearch.audit.indices LIKE "<*"';

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
 * searches/05-system-index-access.json carries the same text; it should become a drift-checked
 * fragment in panels.mjs (shared file — requested, not done here).
 */
const SYS_INDEX =
  'WHERE ((attributes.elasticsearch.audit.indices LIKE ".*" AND NOT attributes.elasticsearch.audit.indices LIKE ".ds-*") ' +
  'OR attributes.elasticsearch.audit.indices LIKE ".ds-.*") ' +
  'AND (attributes.elasticsearch.audit.action IS NULL OR NOT attributes.elasticsearch.audit.action LIKE "*[*")';

/**
 * Transport fan-out, dropped AFTER aggregation so it costs nothing: shard/node copies (`…[s]`, `[n]`,
 * `[p]`, `search[phase/…]`) and the ES|QL engine's own sub-actions (`esql/compute`, `esql/data`,
 * `esql/search_shards`, `esql/resolve_fields`, `esql/async/get` polling). One ES|QL query used to
 * read as six rows here; the top-level `indices:data/read/esql` request still counts once.
 */
const FANOUT = '(attributes.elasticsearch.audit.action LIKE "*[*" OR attributes.elasticsearch.audit.action LIKE "indices:data/read/esql/*")';

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

/** Pinned so a family keeps its colour as families come and go with the window. PALETTE hues. */
const FAMILY_COLORS = {
  read: '#54B399', write: '#6092C0', 'index admin': '#D6BF57', 'security admin': '#E7664C',
  'cluster admin': '#9170B8', monitor: '#B9A888', other: '#CA8EAE',
};

/** The tooltip for a Vega panel is its spec's own description — one source, so they cannot disagree. */
const specDescription = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8')).description;

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ESS} | STATS \`Elasticsearch events\` = COUNT(*)`, 'Elasticsearch events', 'All Elasticsearch audit events in range.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | STATS BY attributes.elasticsearch.audit.indices | ${CONCRETE} | EVAL family = ${INDEX_FAMILY} | STATS \`Index families\` = COUNT_DISTINCT(family)`,
      'Index families', 'Distinct indices named in audited requests, with each data stream\'s backing indices and each run of dated daily indices counted once. Wildcard and date-math expressions (*, -*, <…{now/d}>) are patterns, not indices, and are left out.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Distinct actions\` = COUNT_DISTINCT(attributes.elasticsearch.audit.action)`, 'Distinct actions', 'Distinct Elasticsearch transport actions (cluster:*, indices:*), shard-level variants included.'),
    // The top-level request only. `LIKE "*esql*"` also counted the engine's own fan-out (compute,
    // data, search_shards, resolve_fields, async polling) and read ~9x the queries actually run —
    // a figure that grew with shard count, not with anyone's activity. `==` also pushes down.
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action == "indices:data/read/esql" | STATS \`ES|QL queries\` = COUNT(*)`, 'ES|QL queries',
      'ES|QL queries submitted — one per query, not per shard or sub-step. Includes the queries these dashboards run to draw themselves.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | ${SYS_INDEX} | STATS \`System index access\` = COUNT(*)`, 'System index access',
      'Requests touching dot-prefixed system and hidden indices (.kibana*, .security*, .slo-*, .alerts-*), counted once per index named. Backing indices of ordinary data streams (.ds-logs-…) are not system data and are left out, as are shard-level copies of a request.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "access_denied" OR attributes.event.action == "anonymous_access_denied" | STATS \`Access denied\` = COUNT(*)`, 'Access denied', 'Authorization denials. Sustained non-zero values mean a misconfigured client or a probe.'),
    xy(0, 5, 24, 15, 'Data access over time by action family',
      `FROM ${IDX} | ${TIME} | ${ESS} | ${NOISE} | STATS n = COUNT(*) BY time = ${BUCKET}, attributes.elasticsearch.audit.action | WHERE attributes.elasticsearch.audit.action IS NULL OR NOT ${FANOUT} | ${FAMILY} | STATS events = SUM(n) BY time, family`,
      'events', 'Elasticsearch audit volume over time by kind of transport action, after the noise gate and with shard-level and ES|QL sub-step fan-out removed, so each request counts once. "other" is mostly authentication events that carry no transport action.',
      { breakdown: 'family', xcol: 'time', colors: FAMILY_COLORS }),
    vega(24, 5, 24, 30, '04-actor-index-matrix', 'Who reads which index family', specDescription('04-actor-index-matrix')),
    table(0, 20, 24, 15, 'Most-accessed index families',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | STATS n = COUNT(*) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.indices | ${CONCRETE} | ${ACTOR_RESOLVE}, index = ${INDEX_FAMILY} | STATS events = SUM(n), indices = COUNT_DISTINCT(attributes.elasticsearch.audit.indices), actors = COUNT_DISTINCT(actor) BY index | SORT events DESC | LIMIT 15`,
      [{ column: 'index', label: 'Index family' }], ['indices', 'events', 'actors'],
      'Which indices see the most audited access, and how many distinct identities touch each. A data stream and its backing indices are one row, as is a run of dated daily indices; `Indices` says how many real indices the row folds together. Wildcard and date-math expressions are left out. A request naming several indices counts once per index.'),
    table(0, 35, 18, 12, 'Transport actions',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.action IS NOT NULL | ${NOISE} | STATS events = COUNT(*) BY attributes.elasticsearch.audit.action, request = attributes.elasticsearch.audit.request.name | WHERE NOT ${FANOUT} | SORT events DESC | LIMIT 15`,
      ['attributes.elasticsearch.audit.action', sized('request', 170)], ['events'],
      'Elasticsearch transport actions with their request class, after the noise gate removes health pings, search-phase internals and connection and bulk-authentication events. Shard-level copies and the ES|QL engine\'s sub-steps are folded away, so a query counts once as indices:data/read/esql — including the queries these dashboards run.'),
    table(18, 35, 30, 12, 'Denied requests',
      `FROM ${IDX} | ${TIME} | WHERE attributes.event.action == "access_denied" OR attributes.event.action == "anonymous_access_denied" | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.action, index = attributes.elasticsearch.audit.indices | ${ACTOR_RESOLVE}, index = COALESCE(index, "—"), attributes.elasticsearch.audit.action = COALESCE(attributes.elasticsearch.audit.action, "—") | KEEP actor, index, attributes.elasticsearch.audit.action, events, last_seen | SORT last_seen DESC | LIMIT 15`,
      ['actor', 'index', sized('attributes.elasticsearch.audit.action', 290)], ['events', 'last_seen'],
      'Who was refused, what they asked for and on which index — newest first. This is the failure slice the old outcome donut drew as a hairline. Index "—" is a cluster-level request; <anonymous> with action "—" is an HTTP call that carried no credentials. A request naming several indices shows once per index. Empty means nothing was denied in range.'),
    table(0, 47, 48, 14, '⚠️ System and hidden index access',
      `FROM ${IDX} | ${TIME} | WHERE attributes.elasticsearch.audit.indices IS NOT NULL | MV_EXPAND attributes.elasticsearch.audit.indices | ${SYS_INDEX} | STATS n = COUNT(*), seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, attributes.elasticsearch.audit.indices, action = attributes.elasticsearch.audit.action | ${ACTOR_RESOLVE}, area = ${SYS_AREA} | STATS events = SUM(n), indices = COUNT_DISTINCT(attributes.elasticsearch.audit.indices), last_seen = MAX(seen) BY actor, area, action | SORT last_seen DESC | LIMIT 25`,
      ['actor', { column: 'area', label: 'Index group' }, { column: 'action', label: 'Transport action' }], ['indices', 'events', 'last_seen'],
      'Who touched system and hidden indices — Kibana internals, the security index, alerting and SLO data — one row per identity, index group (.alerts*, .slo*, .kibana*…) and action. `Indices` says how many real indices the row covers; the Discover session below names each one. Sorted by most recent, not by volume: sorting by volume buries a one-off read under routine polling. Backing indices of ordinary data streams (.ds-logs-…) and shard-level copies of a request are left out. Expected from Kibana and platform automation; unexpected from anyone else.'),
    search(0, 61, 48, 15, '05-system-index-access', 'System index access',
      'The newest 1,000 requests against a system or hidden index, one row per index named, newest first. It stops at 1,000, so it can hold fewer rows than the System index access tile counts.'),
  ];
  return dash('cloud-audit-03-data-access', '[Audit] 🔎 Elasticsearch Data Access',
    'What data was read, by whom, through which transport action — including system indices.', P);
}
