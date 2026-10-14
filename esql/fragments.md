# Canonical ES|QL fragments — Cloud Audit Dashboards

Single source of truth. Every panel in `dashboards/` and `vega/` is built from these.
Measured against `logs-elastic_cloud.serverless_audit.otel-default`.

## Index

```esql
FROM logs-elastic_cloud.serverless_audit.otel-default
```

## Actor resolution — REQUIRED on every actor-facing panel

`attributes.user.name` is a numeric ID (`1234567890`), not a name. Human identity is in
`attributes.user.email`; machine identity in `attributes.api_key.name`.

`actor_org` splits traffic by the email on the event: `Elastic` is an `@elastic.co` address, `tenant`
is any other address (including API-key traffic, which carries its creator's email), and `machine`
is traffic with no email at all. This `tenant` is not the same as `actor_scope`'s `tenant` below,
which means "neither platform automation nor unauthenticated".

```esql
| EVAL actor = COALESCE(attributes.user.email, attributes.api_key.name, attributes.user.name, "<anonymous>"),
       actor_kind = CASE(attributes.user.email IS NOT NULL, "human", "service"),
       actor_org  = CASE(attributes.user.email IS NULL, "machine",
                         attributes.user.email LIKE "*@elastic.co", "Elastic", "tenant")
```

## Noise gate — ON by default

**Both halves must be null-guarded.** `attributes.elasticsearch.audit.action` does not exist on
Kibana audit events, so a bare `NOT (field IN (...))` evaluates to null there — and `WHERE null`
drops the row. The previous gate therefore discarded 100% of Kibana audit, which is a small
fraction of the stream carrying nearly all of the forensic value.

Composition varies by workload, so the gate targets several noise classes — `cluster:monitor/main`,
search-phase internals, transport `connection_granted` — rather than assuming any one of them is the
bulk.

```esql
| WHERE (attributes.elasticsearch.audit.action IS NULL OR NOT (
      attributes.elasticsearch.audit.action IN ("cluster:monitor/main", "elastic.maintenance")
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/search*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/*point_in_time"
      OR attributes.elasticsearch.audit.action == "indices:data/read/open_reader_context"))
    AND (attributes.event.action IS NULL
      OR NOT (attributes.event.action IN ("authentication_success","connection_granted")))
```

Band classification shares the same vocabulary, so the gate and the bands cannot disagree. A CASE
condition that evaluates to null falls through rather than matching, so Kibana events land in
`signal` as intended.

```esql
| EVAL band = CASE(
    attributes.elasticsearch.audit.action IN ("cluster:monitor/main", "elastic.maintenance"), "infra-noise",
    attributes.elasticsearch.audit.action LIKE "indices:data/read/search*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/*point_in_time"
      OR attributes.elasticsearch.audit.action == "indices:data/read/open_reader_context", "query-noise",
    attributes.event.action == "connection_granted", "query-noise",
    attributes.event.action == "authentication_success", "authn-volume", "signal")
```

## Source split

One stream carries two audit sources. Kibana events are a small share of volume and carry nearly
all of the forensic value.

```esql
| WHERE resource.attributes.service.name == "serverless-kibana"        -- Kibana audit
| WHERE resource.attributes.service.name == "serverless-elasticsearch" -- Elasticsearch audit
```

## Time bucketing

Kibana injects `?_tstart` / `?_tend`. Reference the full `BUCKET(...)` expression verbatim as the
column name, and set `axis.x.scale = "temporal"`.

```esql
| WHERE @timestamp <= ?_tend AND @timestamp > ?_tstart
| STATS events = COUNT(*) BY BUCKET(@timestamp, 75, ?_tstart, ?_tend)
```

## Risk scoring

Routine activity scores **0** on purpose. An earlier baseline of 1 made "total risk" a disguised
event count.

**Branch order is load-bearing** — `CASE` is first-match-wins. Testing the generic predicates
first made two weights unreachable: `invalidate_apikeys` always carries a `security_config_change`
payload (so it scored 50, never 45) and `anonymous_access_denied` always carries
`outcome == "failure"` (so it scored 40, never 35). Action-specific branches come first.

`CHANGE_PRED` below is the shared "is this a Kibana state change" predicate, embedded verbatim so
the scorer and the change panels can never disagree.

```esql
| EVAL risk = CASE(
    attributes.event.action == "invalidate_apikeys", 45,
    attributes.event.action == "anonymous_access_denied", 35,
    attributes.elasticsearch.audit.security_config_change IS NOT NULL, 50,
    attributes.event.outcome == "failure", 40,
    <CHANGE_PRED> AND attributes.event.action IN ("workflow_run","workflow_test","workflow_execution_cancel"), 10,
    <CHANGE_PRED> AND (attributes.event.type == "deletion" OR attributes.event.action == "rule_disable"), 30,
    <CHANGE_PRED>, 25,
    0)
| WHERE risk > 0
```

Three things about the change branches, each of which the order encodes:

- **Executions are tested first.** `workflow_execution_cancel` is ECS-tagged `deletion`, so if the
  destructive branch came first a cancelled run would score 30 as though a workflow were deleted.
- **Executions weigh 10, below authoring.** They are the one class with unbounded cadence; a
  scheduled workflow firing every minute at 25 would turn total risk back into an event count
  wearing a hat, which is the failure the 0-baseline note above records fixing once.
- **Destructive weighs 30, deliberately below anonymous denial (35) and failure (40)**, so "a
  failed mutation is the more interesting event" still holds: a failed delete still scores 40.

### Prefilter — required for acceptable latency

Push this **ahead** of the actor/risk EVALs. Without it, `COALESCE`/`CASE` are evaluated on every
document before `WHERE risk > 0` prunes anything. Keep it in sync with the weights above.

```esql
| WHERE attributes.elasticsearch.audit.security_config_change IS NOT NULL
    OR attributes.event.outcome == "failure"
    OR attributes.event.action IN ("invalidate_apikeys","anonymous_access_denied")
    OR <CHANGE_PRED>
```

The three change branches collapse to one clause here because they share `CHANGE_PRED`, so that
half cannot drift. `saved_object_create/update/delete` dropped out of the explicit list because
`CHANGE_PRED` subsumes them; net selectivity improves, because this also stops evaluating the
point-in-time events that used to reach the CASE only to score 0.

### Counted, then scored

`RISK` is a seven-branch `CASE`, so a scoring panel never evaluates it per event (see *Query shape
decides cost*). It counts by the raw fields `RISK` reads, restores them, and scores the grouped rows;
every count downstream is then `SUM(n)` and every severity `SUM(risk * n)`:

```esql
| <RISK_PREFILTER>
| STATS n = COUNT(*) BY <panel keys>,
    attributes.event.action, scc = attributes.elasticsearch.audit.security_config_change IS NOT NULL,
    attributes.event.outcome, resource.attributes.service.name, et = MV_CONCAT(attributes.event.type, ",")
| EVAL attributes.event.type = SPLIT(et, ","),
       attributes.elasticsearch.audit.security_config_change = CASE(scc, "present")
| <RISK>
| WHERE risk > 0
```

After the restore, `security_config_change` answers `IS NOT NULL` correctly and nothing else — a
panel that shows the payload reads it from the events, not from these rows.

### Mean severity

On the same 0–50 scale as the weights. This replaced a "normalised 0–100 index" whose floor was
50, because it divided by the maximum weight while the smallest non-zero weight was 25 — half the
advertised range was unreachable.

```esql
| STATS risk_total = SUM(risk * n), scoring_events = SUM(n) BY actor   // over the counted rows above
| EVAL mean_severity = ROUND(1.0 * risk_total / scoring_events, 1)
```

### Platform vs tenant

Elastic's own automation can perform security config changes on a serverless project, and those
carry the highest weight, so unsplit it can top the leaderboard.

```esql
| EVAL actor_scope = CASE(actor IN ("elastic.maintenance","autoscaling","elasticsearch-controller",
    "elastic/fleet-server"), "platform",
    actor IN ("<anonymous>","<unauthenticated-cloud-access-token>","<unauthenticated-saml-user>"), "unauthenticated",
    "tenant")
```

## What counts as a Kibana change

**Do not use an action-name suffix test for this.** It was the original approach and it silently
missed every mutation whose action does not end in `_create`/`_update`/`_delete` — for example
`rule_enable`, `rule_disable`, the whole `case_user_action_*` family,
`saved_object_update_objects_spaces`, `ml_open_ad_job`, `ml_start_ad_datafeed`, `workflow_run`,
`workflow_test` and `workflow_execution_cancel`. Select by ECS classification instead:

```esql
| WHERE (resource.attributes.service.name == "serverless-kibana" AND (
      (attributes.event.type IN ("change","creation","deletion")
       AND (attributes.event.action IS NULL OR NOT (attributes.event.action IN (
            "saved_object_open_point_in_time","saved_object_close_point_in_time"))))
      OR attributes.event.action IN ("rule_run_soon","secret_create")))
```

- `attributes.event.type` is **single-valued on Kibana** but **multi-valued on Elasticsearch**
  (`access_granted` carries `["access","allowed"]`). ES|QL returns **null, not false**, for `IN` on a
  multi-value operand — verified live — so in a `WHERE` the row drops and in a `CASE` the branch
  falls through. This predicate is fail-closed outside Kibana, and the explicit `service.name` test
  makes that intent visible.
- **Point-in-time is excluded by name.** Open/close PIT are ECS-tagged creation/deletion, they are
  query internals, and at their volume they would crowd out nearly everything else in the output.
- **Two genuine changes are ECS-tagged `access`** and must be added back: `rule_run_soon` and
  `secret_create`.

## Kibana verb

Wildcards on **both** sides for create/update: the newer action names bury the verb in the middle
(`case_user_action_update_case_status`, `saved_object_update_objects_spaces`), and a suffix-only
test reads them as "other". ML uses its own vocabulary and needs naming explicitly.

```esql
| EVAL verb = CASE(attributes.event.action LIKE "*_execution_cancel", "cancel",
                   attributes.event.action LIKE "*_run_soon", "run",
                   attributes.event.action LIKE "*_run",      "run",
                   attributes.event.action LIKE "*_test",     "test",
                   attributes.event.action LIKE "*_enable",   "enable",
                   attributes.event.action LIKE "*_disable",  "disable",
                   attributes.event.action LIKE "ml_put_*",   "create",
                   attributes.event.action LIKE "ml_open_*",  "open",
                   attributes.event.action LIKE "ml_start_*", "start",
                   attributes.event.action LIKE "*point_in_time", "pit",
                   attributes.event.action LIKE "*_create*",  "create",
                   attributes.event.action LIKE "*_update*",  "update",
                   attributes.event.action LIKE "*_delete",   "delete",
                   attributes.event.action LIKE "*_find",     "find",
                   attributes.event.action LIKE "*_get",      "get",
                   attributes.event.action LIKE "*_resolve",  "resolve", "other")
```

## Naming the object that changed

Kibana populates `attributes.kibana.saved_object.{id,type,name}` **only** on the saved-objects
audit path. Workflows, agent-builder agents and tools, ML jobs and datafeeds, product documentation
and secrets populate **none** of them; `connector_create`, the `case_*` family and `space_create`
carry a type but no name. `body.text` is never null on a Kibana event and always names the thing,
so it is the fallback.

```esql
| GROK body.text """\[(?:id|workflowId)=%{DATA:g_id}(?:,|\])"""
| GROK body.text """\[name=%{GREEDYDATA:g_name}\]"""
| GROK body.text """\[executionId=%{DATA:g_exec}\]"""
| GROK body.text """case id: %{NOTSPACE:g_case}"""
| GROK body.text """(?:job|datafeed) %{NOTSPACE:g_ml}"""
| EVAL obj_name = COALESCE(attributes.kibana.saved_object.name, g_name, g_id,
                           attributes.kibana.saved_object.id, g_case, g_ml, g_exec, body.text)
```

Message shapes these patterns exist for (object names are illustrative):

| shape | emitted by |
|---|---|
| `User is updating dashboard [id=…]` | `saved_object_*` |
| `User is creating rule [id=…] [name=[Example] Rule with brackets]` | `rule_*` — the name itself contains brackets, which is why `GREEDYDATA` and not `DATA` |
| `User has created agent [id=x, name="y"]` | `agent_builder_*` — the `(?:,\|\])` terminator stops the id swallowing the rest |
| `User ran workflow [id=…] [executionId=…]` | `workflow_run` |
| `User tested workflow [workflowId=…] [executionId=…]` | `workflow_test` — `workflowId`, not `id` |
| `User canceled workflow execution [executionId=…]` | `workflow_execution_cancel` — no workflow id at all; the execution id is the only join back to the run |
| `User created case id: <uuid> - user action id: <uuid>` | `case_user_action_*` — no brackets |
| `Creating anomaly detection job my-anomaly-job-…` | `ml_*` — free prose, no `id=` |

`body.text` is last in the ladder and is groupable in ES|QL, which is what guarantees the column is
never null.

## Credential, across both audit sources

`attributes.authentication.type` is an Elasticsearch-audit field — it is null on almost every
Kibana event. `attributes.user.domain` is populated there, so the COALESCE is what gives a
credential dimension any fan-out on Kibana data, and it is the split between a person in a browser
(`cloud-saml-kibana`) and a script calling Kibana with a key (`_es_api_key`).

```esql
| EVAL credential = COALESCE(attributes.authentication.type, attributes.user.domain, "unknown")
```

Derived, so never click-filter on it. To pin a credential, filter on either source field.

## Did the event touch an object?

`OBJ_TYPE` falls back to a `REPLACE` of the action name when nothing names a type, which turns
`http_request`, `user_login` and the point-in-time internals into "types". `OBJ_PRESENT` is true only
for events that name a real saved-object type or belong to a family `OBJ_TYPE` derives a type for.
Keep its families in step with `OBJ_TYPE`'s branches — a family added there and not here is silently
dropped by anything that filters on this.

```esql
| WHERE (attributes.kibana.saved_object.type IS NOT NULL OR attributes.event.action LIKE "ml_*"
    OR attributes.event.action LIKE "workflow_*" OR attributes.event.action LIKE "agent_builder_*"
    OR attributes.event.action LIKE "product_documentation_*" OR attributes.event.action == "secret_create")
```

It references only raw fields, so it works on rows already grouped by those fields.

## Query shape decides cost

Measured on the 2.6M-event perf replica (`./audit --perf`), alternating runs on a quiet cluster.

| Rule | Measurement |
| --- | --- |
| **A `CASE` with two or more conditions never runs per document.** It costs ~4µs per row it is evaluated on, whether or not it feeds a group-by; nesting it as one-condition `CASE`s does not help. Each condition alone, a one-condition `CASE`, `COALESCE`, boolean expressions, `GROK` and the whole noise gate are cheap. `RISK`, `BAND`, `VERB`, `OBJ_TYPE`, `ORG` and `SCOPE` are all this shape. | 7 days: `CASE(client.ip IS NULL, …, client.geo.country_iso_code IS NOT NULL, …, …)` 11.2s; either condition alone 90ms |
| **Count first by the raw fields a fragment reads, derive afterwards.** `STATS n = COUNT(*) BY` the raw keyword fields, apply the fragment unchanged to the grouped rows, then `STATS SUM(n) BY` what it derived (`MIN`/`MAX` a carried timestamp, `COUNT_DISTINCT` a carried key). The fragments still appear verbatim, so the drift check still pins them, and the output is identical. | the `CASE` above: 11.2s → 0.14s. Command Center treemap 31s → 0.8s, band charts 13s → 0.3s, object/verb heatmap 8.9s → 0.4s (7 days); Actor 360 flow 2,839ms → 145ms (24h) |
| **Keep the grouped rows few.** The `CASE` still costs per grouped row, so group on what it reads and nothing wider. `RISK_KEYS` groups `security_config_change` — a near-unique JSON payload — as a presence boolean, because `RISK` only asks `IS NOT NULL`. | hourly risk chart, 7 days: 18,001 grouped rows 1.7s, 2,936 rows 0.27s |
| **A multi-valued key is grouped joined.** `attributes.event.type` is multi-valued on Elasticsearch events; `STATS BY` it would count a document once per value. Group `et = MV_CONCAT(attributes.event.type, ",")` and restore it with `EVAL attributes.event.type = SPLIT(et, ",")`, which keeps `IN`/`==` returning null on those rows exactly as on the raw field. | identical rows on every risk panel, 24h and 7d |
| **A row feed sorts straight after its filter.** A Discover session that classifies rows puts `SORT @timestamp DESC` (and any `LIMIT`) before the `EVAL`s, so they run on the rows returned. | `searches/04` 10.6s → 0.18s, `searches/01` 3.2s → 0.3s (7 days) |
| **Group on raw keyword fields where you can.** A computed key such as the actor `COALESCE` is cheap enough, but only a raw field can take a filter pill. | 7 days: `BY attributes.user.email` 51–53ms, `BY` the actor COALESCE 183–195ms |
| **A panel that measures presence takes no noise gate.** `access_granted` *is* activity, so gating it removes the thing being measured. This is about meaning, not speed: the null-guarded gate itself is cheap. | 7 days: the full noise gate 42–56ms; `== "access_granted"` 25–38ms |
| **Sub-aggregations over a wide window cost the scan.** A bare `terms` reads ordinals; any sub-aggregation visits every document. | earlier measurement on the live stream: 7-day `terms` by email 270ms bare, ~4s with two `cardinality` sub-aggs, ~6s with `terms` sub-aggs. On the replica (one email) all three ran in 25–143ms, so re-check on a tenant with many users |
| **Low-cardinality `COUNT_DISTINCT` takes a precision threshold.** The default sizes the sketch for thousands of values. | `COUNT_DISTINCT(field, 100)` is exact for `event.action` (tens of values) |

A `STATS` with no `BY` returns null, not 0, for `SUM` over no rows, where `COUNT(*)` returned 0. A KPI
rewritten to `SUM(n)` `COALESCE`s after the `STATS` so an empty window still reads 0.

## Geo (populated by the audit-scoped final_pipeline)

`attributes.source.ip` is the internal proxy (100.64.x / 10.x) and is NOT the client.
`attributes.network.forwarded_ip` is the real public client IP; the pipeline lifts it to
`client.ip` and geo-resolves it into `client.geo.*`.

```esql
| WHERE client.geo.country_iso_code IS NOT NULL
| STATS events = COUNT(*) BY country = client.geo.country_iso_code, city = client.geo.city_name
```

## Gotchas

| Gotcha | Handling |
| --- | --- |
| `attributes.event.category` / `.type` are arrays | `MV_EXPAND` before `STATS ... BY` |
| `attributes.url.path` / `url.original` are `wildcard` | cast `::keyword` to group by them |
| `attributes.elasticsearch.audit.security_config_change` is a JSON *string* | render as text, never aggregate internals |
| `body.text` is only on Kibana events | always pair with the `serverless-kibana` source filter |
| Keys inside `attributes` are literal dotted strings | matters for ingest processors, not for ES\|QL |
| Root mapping is `dynamic: false` | enriched fields must be explicitly mapped (see `ingest/`) |
| Filter pills bind to a **source field**, not a derived column | `click_filter` goes on `attributes.user.email`; a pill on the `actor` COALESCE matches nothing |
| Wide windows used to "time out past `now-1h`" | that timing was confounded: the queries ran back to back — a synchronous query outlives its client and cannot be cancelled on serverless. Dashboards stay at 1h as the readable default; see *Query shape decides cost* for what actually costs |
| `_field_caps` reports `url.path` / `url.original` as `keyword` | they are `wildcard` in the backing index mapping — read `_mapping`, and never group on them unguarded |
| `LAST` is reserved | `last = MAX(@timestamp)` is a parse error; use `last_ts` |
