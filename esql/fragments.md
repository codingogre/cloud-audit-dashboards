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

`actor_org` splits traffic by the email on the event: `Elastic` is an `@elastic.co` address, `Tenant`
is any other address (including API-key traffic, which carries its creator's email), and `Machine`
is traffic with no email at all. Its values are title case because they are display values — a pie
prints them as they are. This `Tenant` is not the same as `actor_scope`'s `tenant` below, which means
"neither platform automation nor unauthenticated".

```esql
| EVAL actor = COALESCE(attributes.user.email, attributes.api_key.name, attributes.user.name, "<anonymous>"),
       actor_kind = CASE(attributes.user.email IS NOT NULL, "human", "service"),
       actor_org  = CASE(attributes.user.email IS NULL, "Machine",
                         attributes.user.email LIKE "*@elastic.co", "Elastic", "Tenant")
```

`actor_org` is a two-condition `CASE`, so it runs after a `STATS` grouped on `attributes.user.email`,
never per event (see *Query shape decides cost* below). `actor_kind` stays a one-condition cut for the
same reason; a panel that shows the kind refines it on the grouped rows with `SCOPE`'s vocabulary, so
`<anonymous>` reads `unauthenticated` and Elastic's own service accounts read `platform`, not `service`:

```esql
| EVAL actor_kind = CASE(actor IN (<unauthenticated principals>), "unauthenticated",
                         actor IN (<platform principals>), "platform", actor_kind)
```

An identity that resolves to a 20-character opaque id is the end of the ladder, not a defect: an
organization-level Elastic Cloud API key, which the audit stream records only by id — no name, no owner.
It is displayed in one form everywhere an identity is shown, `_4KEO… · Cloud API key`, by `ACTOR_LABEL`,
the last step before display (after the last `STATS … BY actor`, so two keys sharing a prefix never
merge):

```esql
| EVAL actor = CASE((LENGTH(actor) == 20 AND actor RLIKE "[-_A-Za-z0-9]{20}" AND NOT actor RLIKE "[0-9]{20}"),
                    CONCAT(LEFT(actor, 5), "… · Cloud API key"), actor)
```

A value test, not a realm test: the same key arrives with `user.domain` `_cloud_api_key` on
Elasticsearch events and sometimes `_es_api_key` on Kibana's (live, 24h: 261,172 and 6,521 events), and
the realm test it replaces split one key into two rows. `-` leads the character class because Lucene
reads `_-]` as a range. `table()` appends it to every table showing `actor`; the Discover sessions and
the treemap and matrix specs embed it verbatim, and the drift check pins it. For a key-name or owner
column that would print `-`, `0` or `(no name)` for such a key, `cloudKeyLabel(col, otherwise)` gives the
same form (API key inventory: `COALESCE(attributes.api_key.name, <cloudKeyLabel(user.name, "(no name)")>)`).

## Noise gate — ON by default

**Both halves must be null-guarded.** `attributes.elasticsearch.audit.action` does not exist on
Kibana audit events, so a bare `NOT (field IN (...))` evaluates to null there — and `WHERE null`
drops the row. The previous gate therefore discarded 100% of Kibana audit, which is a small
fraction of the stream carrying nearly all of the forensic value.

Composition varies by workload, so the gate targets several noise classes rather than assuming any
one of them is the bulk:

| Class | What | Why it is noise |
| --- | --- | --- |
| Infra health | `cluster:monitor/main`, `elastic.maintenance` | pings and platform housekeeping |
| Query internals, Elasticsearch | search phases, `msearch`, `scroll`, PIT and reader contexts; **ES\|QL and every sub-request** (`esql/compute`, `esql/data`, `esql/search_shards`, `esql/resolve_fields`, `esql/async/get`, `indices:admin/esql/*`); `field_caps` and `field_caps[n]`; `async_search/*`; `indices:admin/resolve/*`; `indices:admin/shards/search_shards`; ES\|QL's query listing (`cluster:monitor/xpack/esql/*`); and the two cluster reads Kibana makes on every page load, `cluster:monitor/project/tags` and `cluster:monitor/xpack/inference/get` (24h: 1,707 and 1,704 against 1,666 page shells); **reads of API key metadata**, `cluster:admin/xpack/security/api_key/get` and `…/api_key/query` (`API_KEY_READS`, round 6: a client polling its own key, 12,595 a day live, 1,369 of 1,805 Signal events in one hour) | the machinery every dashboard, Discover tab and client runs to read data. With many viewers, each viewer's own panel queries were the top "signal" |
| Query internals, Kibana | `http_request` to an `/internal/` route (with or without `/s/<space>`): `/internal/search/esql_async`, feature flags, controls options, session checks; the dashboard app's content-management reads (`/api/content_management/rpc/get`, `search`, `mget`, `bulkGet`); **page-load plumbing** — `/bootstrap.js`, `/bootstrap-anonymous.js`, `/translations/…`, the `/app/<app>` page shell, `/api/core/…`, `/api/licensing/…`, `/api/banners/…`, `/api/ui_counters/…` and the space picker's `/api/spaces/space` list; `saved_object_open/close_point_in_time`; `space_get` / `space_find` ("User has accessed space", once per page load) | what the browser calls to draw a page. A content-management read is also audited as its own `saved_object_*` event, and a change through a public route is audited again as its own event (`space_create`, `saved_object_create` …). Every other public `/api/` route, `/api/spaces/space/<id>`, an rpc create/update/delete, and a space create/update/delete stay signal |
| Page-load lookups | `saved_object_get` of the `config` / `config-global` settings object; `saved_object_find` of `index-pattern` (the logs-\* / metrics-\* default data-view check, the workflows data views) | what every Kibana page load reads before it draws (24h: 2,021 each, one per page load, by every viewer and by the verify renderer). Resolving, creating or changing a particular data view stays signal |
| The suite itself (`SUITE_SELF`) | on a `cloud-audit-*` or `elastic_cloud-audit-*` (Command Center) object: a **read** (`saved_object_get` / `_resolve` / `_find`) by anyone; **any** event with no Kibana browser session (`attributes.kibana.session.id IS NULL`). And an `http_request` to `/api/saved_objects/_import` or `_export`, or to a public route that names a suite id (`PUT /api/dashboards/cloud-audit-…`) — `SUITE_INSTALL_URL`, session-blind | a read is the suite watching itself be watched, one per panel load per viewer. A session-less event is the automated install: `./audit --objects/--dashboards` imports, exports, creates, updates and deletes the suite's objects with an API key, and after a redeploy that was every row of the Live signal feed (24h: 10,368 events). Each object an import or export touches is audited again as its own `saved_object_*` event, so gating the request line loses no object. A person **editing** a suite dashboard does it in a browser session and stays signal; it is a test of the channel, never of a key. Every change, the install's included, stays in `CHANGE_PRED` (02 Mutations, 04 Mutation feed, 07 What they changed), and views stay on 02's all-traffic tiles, heatmap and Busiest object types |
| Connection / authn volume | `connection_granted`, `authentication_success` | one per transport connection / authenticated request |

A read of a system index is not lost to the gate: `SYS_INDEX` selects on the index name and never
passes through it.

**API key reads are query internals; key changes are not.** Gated by the human's decision (round 6):
`api_key/get` and `api_key/query` read a key's metadata and grant nothing. Live, 24h: 12,595 `get` and 41
`query` against 300 `create`, 74 `invalidate` and 24 `update`; on this project nearly every `get` is the
Cloud API key this repo's own tooling runs as, polling while it deploys and renders, and it was most of
Command Center's Signal and every row of its Live signal feed. Creating, granting, updating and
invalidating a key stay signal (and scored, through `security_config_change`). The test is on the action,
never on a key, so a denied read is gated like a denied search; the failure panels take no gate and still
list it. 7-day replica: signal 333,360 → 309,810; no gated query moved (gated count ~210ms, band charts
~0.65–0.8s, treemap ~310ms, before and after, alternating runs).

```esql
| WHERE (attributes.elasticsearch.audit.action IS NULL OR NOT (
      attributes.elasticsearch.audit.action IN ("cluster:monitor/main", "elastic.maintenance")
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/search*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/msearch*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/scroll*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/*point_in_time"
      OR attributes.elasticsearch.audit.action == "indices:data/read/open_reader_context"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/esql*"
      OR attributes.elasticsearch.audit.action LIKE "indices:admin/esql/*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/field_caps*"
      OR attributes.elasticsearch.audit.action LIKE "indices:data/read/async_search/*"
      OR attributes.elasticsearch.audit.action LIKE "indices:admin/resolve/*"
      OR attributes.elasticsearch.audit.action == "indices:admin/shards/search_shards"
      OR attributes.elasticsearch.audit.action LIKE "cluster:monitor/xpack/esql/*"
      OR attributes.elasticsearch.audit.action IN ("cluster:monitor/project/tags", "cluster:monitor/xpack/inference/get",
           "cluster:admin/xpack/security/api_key/get", "cluster:admin/xpack/security/api_key/query")))
    AND (attributes.event.action IS NULL OR NOT (
      attributes.event.action IN ("authentication_success","connection_granted")
      OR <KIBANA_INTERNALS>))
```

`KIBANA_INTERNALS` (exported from `panels.mjs`):

```esql
attributes.event.action IN ("saved_object_open_point_in_time","saved_object_close_point_in_time","space_get","space_find")
  OR (attributes.event.action == "http_request" AND attributes.url.original IS NOT NULL
      AND attributes.url.original RLIKE "<KIBANA_PLUMBING_URL>|<SUITE_INSTALL_URL>")
  OR (attributes.kibana.saved_object.type IS NOT NULL AND (
      (attributes.event.action == "saved_object_get" AND attributes.kibana.saved_object.type IN ("config","config-global"))
      OR (attributes.event.action == "saved_object_find" AND attributes.kibana.saved_object.type == "index-pattern")))
  OR <SUITE_SELF>
```

`SUITE_INSTALL_URL` is `https?://[^/]+(/s/[^/]+)?/api/(saved_objects/(_import|_export)|[^?]*/(elastic_)?cloud-audit-).*`, an alternative
of the plumbing RLIKE (a second RLIKE behind a session test measured slower on the band charts), and
`SUITE_SELF`:

```esql
(attributes.kibana.saved_object.id IS NOT NULL AND (attributes.kibana.saved_object.id LIKE "cloud-audit-*" OR attributes.kibana.saved_object.id LIKE "elastic_cloud-audit-*")
  AND (attributes.event.action IN ("saved_object_get","saved_object_resolve","saved_object_find")
       OR attributes.kibana.session.id IS NULL))
```

`KIBANA_PLUMBING_URL` — each alternative carries its own tail, so `api/spaces/space` matches the list a
page load fetches and not `/api/spaces/space/<id>`; `[.]` rather than `\.` keeps the static copies free
of escapes:

```
https?://[^/]+(/s/[^/]+)?/((internal|translations|app)/.*|api/content_management/rpc/(get|search|mget|bulkGet).*
  |bootstrap(-anonymous)?[.]js.*|api/(core|licensing|banners|ui_counters)/.*|api/spaces/space([?].*)?)
```

The page-load half was added after the round-4 review found `User is requesting [/s/_audit/bootstrap.js]`
leading Command Center's Live signal feed. Measured on the live stream over 24h, it newly gates 10,429
events, one set per page load: the space list 2,021, `bootstrap.js` 1,669, capabilities 1,668, banners
1,668, `/app/dashboards` 1,666, licensing 1,661, ui_counters 73 — and nothing else (`DELETE
/api/spaces/space/<id>` stays signal). On the 7-day replica signal goes 377,070 → 359,940 (`http_request`
72,870 → 55,740). Cost: a cold gated count takes ~200ms at 7 days before and after the change (old
pattern cold 191–214ms, new 196–212ms) and both settle to ~65–70ms once Elasticsearch caches the
filter; the band charts are unchanged (~475ms).

It only runs where `event.action` is non-null, and each extra field is `IS NOT NULL AND …`
(`false AND null` is false), so it never yields null and never drops a row. `url.original` is a
`wildcard` field; `RLIKE` on it costs the same as `LIKE "*/internal/*"` (36ms vs 34ms, 7 days) and is
exact where the `LIKE` also matched `/api/internal/…`. (Measured before the content-management
alternation was added to the same pattern; the whole gate re-measured with it is below.)

Measured on the 2.6M-event, 7-day replica: the gate keeps 377,070 events where the narrower one kept
1,539,450; the gated count takes 70ms against 45ms (a gated `STATS BY event.action` 72ms against 75ms,
fewer rows to group), and no gated dashboard query moved past its old
cost class (see *Performance* in the README).

### Bands

Band classification shares the same vocabulary, so the gate and the bands cannot disagree (on the
replica, Signal from `NOISE` and the `signal` band are both 377,070). `BAND` is a multi-branch `CASE`,
so it only ever runs on rows grouped `BY BAND_KEYS`. Two fields `KIBANA_INTERNALS` reads are near-unique
per event (a URL, a saved-object id), so they are grouped as one boolean, `kib_internal` — the
`RISK_KEYS` trick — and `BAND` reads that column. A `CASE` condition that evaluates to null falls
through, so Kibana events with no internal match land in `signal`.

```esql
| STATS n = COUNT(*) BY <panel keys>,
    attributes.elasticsearch.audit.action, attributes.event.action, kib_internal = (<KIBANA_INTERNALS>)
| EVAL band = CASE(
    attributes.elasticsearch.audit.action IN ("cluster:monitor/main", "elastic.maintenance"), "infra-noise",
    <the Elasticsearch query-internals disjunction above>, "query-noise",
    kib_internal, "query-noise",
    attributes.event.action == "connection_granted", "query-noise",
    attributes.event.action == "authentication_success", "authn-volume", "signal")
| STATS events = SUM(n) BY <panel keys>, band
```

`kib_internal` has to be computed per event, and loading `url.original` and `saved_object.id` for every
event is what that costs: a band query over 7 days went from ~100ms to ~450ms (the share-over-time
chart 541ms, the vega/07 stream 642ms). A positive prefilter does not help — `BAND` must see every event to share out 100%.

## Privileged operations

`security_config_change` is the stream's word for a privileged write, but Kibana cleans up API keys on
its own: `elastic/kibana` invalidates keys every few milliseconds (payload ids such as
`kibana-api-key-service-test`). Live: 670 of 671 privileged ops in one hour, 2,026 of 2,770 in 24h. So
the tiles that say "any non-zero deserves review" leave exactly that out, and say how much:

```esql
| WHERE attributes.elasticsearch.audit.security_config_change IS NOT NULL AND NOT <HOUSEKEEPING>
-- HOUSEKEEPING:
(attributes.event.action IS NOT NULL AND attributes.event.action == "invalidate_apikeys"
 AND attributes.user.name IS NOT NULL AND attributes.user.name IN (<PLATFORM_ACTORS>) AND attributes.api_key.name IS NULL)
```

Every term is guarded, so `NOT HOUSEKEEPING` never drops a row. A key Kibana *creates* on a user's behalf
(`create_apikey` by `elastic/kibana` when a rule is saved) and any invalidation by a tenant identity still
count. `privilegedKpi(col)` is the KPI form: `COUNT(*) WHERE NOT housekeeping` plus a `housekeeping_note`
for the secondary line (7 days: 157ms against 134ms for the bare count). `RISK` scores the same
housekeeping **0** (round 6, the human's decision; see *Risk scoring*), so the treemap, the leaderboard,
*Why these identities scored*, the scatter and Actor 360's Risk agree with these tiles. A deliberate
invalidation by a person, a named key or a Cloud API key still scores 45.

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

Every dashboard's saved range **ends at `now-1m`** (`TIME_TO`, set by `dash()`; `--verify` and the demo
guide links use it too). Audit events become searchable seconds after they happen (on 07 a closed window
kept growing for 5–7s), and each panel resolves `now` for itself about a second apart, so with a range
ending at `now` two numbers side by side differed by whatever landed in between. A minute back nothing is
still arriving; what is left is the sub-second spread between panels at both ends of the range, which
`EDGE_NOTE` states where a page sets a total beside its parts. The last bucket still covers only part of
its interval (the range ends part-way through it), so it is usually short — say "covers part of its
interval", not "still filling".

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
    housekeeping, 0,                                   -- Kibana's own key clean-up; a key of RISK_KEYS
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

**Housekeeping scores 0, first.** `housekeeping` is `HOUSEKEEPING` (see *Privileged operations*) grouped
as a boolean key of `RISK_KEYS`, so it needs no `user.name` / `api_key.name` group keys: Kibana's own
`invalidate_apikeys` through no named key used to make `elastic/kibana` the hottest tile on the treemap
(267 of its 268 events in an hour) beside a Privileged ops tile calling the same events routine. Live,
24h: 2,710 such events now score 0; `elastic/kibana` still scores for the keys it creates on a user's
behalf (`create_apikey`, 325) and its profile writes. 7-day replica: every scoring panel within ±15ms
(04 Mean severity 64 → 77ms, the leaderboard 84 → 90ms, the treemap 304 → 313ms, the scatter 87 → 92ms).

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
    attributes.event.outcome, resource.attributes.service.name, et = MV_CONCAT(attributes.event.type, ","),
    housekeeping = <HOUSEKEEPING>
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
    "elastic/fleet-server","elastic/kibana"), "platform",
    actor IN ("<anonymous>","<unauthenticated-cloud-access-token>","<unauthenticated-saml-user>",
    "<unauthenticated-cloud-api-key>"), "unauthenticated",
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

## Failed sign-ins — one attempt counts once

Elasticsearch writes one `realm_authentication_failed` per realm an attempt tried, beside the one
`authentication_failed` for the request, so with two realms one bad password was three events. Every
failure count — 01's *Failed or denied* tile, its failure table and `searches/02`, 04's *Failures* tile and
*Top failures and denials* — uses `FAILED_OR_DENIED` (`panels.mjs`; `SIGNIN_WORDS` says it in a
description), and the drift check pins it in `searches/02`:

```esql
| WHERE attributes.event.action IN ("authentication_failed","anonymous_access_denied")
     OR (attributes.event.outcome == "failure"
         AND (attributes.event.action IS NULL OR attributes.event.action != "realm_authentication_failed"))
```

Live, 24h: 04's old `outcome == "failure"` count 1,182 → 1,052 (130 realm traces), now equal to 01's tile.
`RISK` still scores a realm trace as a failure (40); only the counts above drop it.

## Credential, across both audit sources

`attributes.authentication.type` is an Elasticsearch-audit field — it is null on almost every
Kibana event. `attributes.user.domain` is populated there, so the COALESCE is what gives a
credential dimension any fan-out on Kibana data, and it is the split between a person in a browser
(`cloud-saml-kibana`) and a script calling Kibana with a key (`_es_api_key`).

```esql
| EVAL credential = COALESCE(attributes.authentication.type, attributes.user.domain, "unknown")
```

Derived, so never click-filter on it. To pin a credential, filter on either source field.

`attributes.authentication.type` in words, for any chart that breaks down by it (01's line chart and
the vega/02 matrix embed this text; the drift check pins vega/02). Apply it after a `STATS` that groups
on the raw field, and pin a colour for every value it can produce (`CRED_TYPE_COLORS`): an unpinned
breakdown value takes the palette from its start, which a pinned value already holds.

```esql
| EVAL auth = CASE(attributes.authentication.type == "api_key", "API key",
    attributes.authentication.type == "token", "Token", attributes.authentication.type == "realm", "Realm",
    attributes.authentication.type == "saml", "SAML",
    attributes.authentication.type == "anonymous", "Anonymous", attributes.authentication.type == "internal", "Internal",
    attributes.authentication.type)
```

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

### Location per address — `IP_GEO`

Enrichment is forward-only, so one client IP can carry both enriched events and older ones with no
`client.geo.*`. Grouping `BY client.ip, client.geo.*` prints that address twice — placed, and "not
placeable" — and a breakdown that selects `client.geo.country_iso_code IS NULL` per event calls a
resolvable public address "no geoip match" (live, 24h: `65.185.62.22` as Powell with 434,065 events and
as unplaceable with 391). An IP table groups by the address only:

```esql
| STATS events = COUNT(*),
        country = MAX(client.geo.country_name), city = MAX(client.geo.city_name),
        placed = COUNT(client.geo.country_iso_code)
    BY client.ip
```

`placed == 0` is the only honest "cannot be placed"; on a placed address, `events - placed` is events
that predate enrichment (or the seconds before the geoip database loaded) — show it if useful, never
call it unplaceable. Why addresses do not resolve: `STATS events = COUNT(*), placed = COUNT(client.geo.country_iso_code)
BY client.ip | WHERE placed == 0 | <address class>`. Measured, 7 days: the IP footprint 306ms → 394ms,
the unresolved breakdown 35ms → 81ms. `MAX` over a keyword is lexicographic; pairing city and country
through one `CONCAT` measured 484ms and is not worth it.

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
