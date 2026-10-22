# Cloud Audit Dashboards

Seven cross-linked Kibana dashboards (eight with the opt-in Platform Volume) over the Elastic Cloud Serverless audit stream
`logs-elastic_cloud.serverless_audit.otel-default`, built entirely from ES|QL and deployed as code
by a dependency-free Node CLI.

Everything here is version-controlled and idempotent: `./audit --deploy` is safe to re-run,
`PUT /api/dashboards/{id}` upserts against stable ids, and no dashboard is ever edited by hand.

```bash
cp .env.example .env      # fill in EC_URL, KB_URL, EC_API_KEY
./audit --deploy          # ingest -> lint -> objects -> dashboards, into the Default space
./audit --verify          # render every deployed dashboard in Chromium and inspect for broken panels
```

Command Center, the entry point, deploys at the saved-object id **`elastic_cloud-audit-dashboard`**:
`<kibana>/app/dashboards#/view/elastic_cloud-audit-dashboard`. The suite installs into Kibana's **Default space**, so
that link needs no `/s/<space>` prefix. The Cloud UI's *Log delivery* page
links to that id, so it is fixed. Every other dashboard is `elastic_cloud-audit-<name>`, with no number:
`elastic_cloud-audit-actor-360`, `-identity-access`, `-kibana-objects`, `-data-access`, `-security-anomalies`,
`-geo-network` and, when deployed, `-platform-volume`. The numbered ids of 1.0.2 and earlier
(`cloud-audit-<NN>-<name>`) are retired: `--dashboards` removes them. The data view the controls use is
**`elastic_cloud-audit-logs`**; it replaced `cloud-audit-dv` in 1.0.4, and `--dashboards` removes the old one.
Releases up to 1.0.3 installed into a dedicated `audit` space; 1.0.4 and later install into Default.

---

## What the data actually is

Profiled against a live audit stream before a single panel was written. These facts drove every
design decision that follows.

| Fact | Consequence |
| --- | --- |
| One stream carries **two** audit sources: `serverless-elasticsearch` (named `elasticsearch-serverless` before the 2026 schema change) and `serverless-kibana` | Every panel states which source it reads. Kibana events are usually a small slice of the volume but carry nearly all of the forensic value. |
| `user.name` is a **numeric id** (`1234567890`), not a name | Every actor-facing panel resolves identity through `COALESCE(user.email, api_key.name, user.name)`. Without it the whole suite shows integers. |
| **A single high-volume API key can dominate the stream**, and Elasticsearch stamps that key's **creator** on every event it emits | A noise gate is ON by default everywhere except the panels titled *all traffic* and the opt-in Platform Volume dashboard. Actor-facing panels also carry the `api_key` column, so an automated workload is never mistaken for the person who minted its credential. |
| The gate's old `NOT (field IN (...))` form was **null for every Kibana event**, and `WHERE null` drops the row | Both halves are explicitly null-guarded. Before the fix the "Signal events" KPI excluded 100% of Kibana audit. |
| Composition depends on the workload, so no single noise class can be assumed to be the bulk — health checks (`cluster:monitor/main`), **search-phase internals** and transport **`connection_granted`** are all targeted | The gate and the volume bands share one vocabulary (`NOISE_ES_ACTIONS`, `NOISE_ES_QUERY_INTERNALS`, `NOISE_EVENT_ACTIONS`) so they cannot disagree. |
| **Reading the audit stream is audited.** Every dashboard panel, Discover tab and API client that queries data emits ES\|QL sub-requests (`esql/compute`, `esql/data`, `esql/search_shards`, `resolve_fields`), `field_caps`, `async_search`, Kibana `/internal/*`, content-management and page-load requests (`bootstrap.js`, `/app/…`, capabilities, licensing), "User has accessed space" and "User has accessed dashboard" reads — with thousands of viewers, the viewers' own queries were the top "signal" | All of it is **Query internals**, gated out with search phases (`KIBANA_INTERNALS` covers the Kibana half). So are reads of API key metadata (`security/api_key/get` and `/query`): a client polling its own key, which on this project is the suite's own tooling key; creating, granting, updating and invalidating a key stay signal. The two lookups every page load makes (`config-global` get, `index-pattern` find) are noise. So is the suite's own traffic (`SUITE_SELF`): a get/resolve/find of a `cloud-audit-*` object by anyone, and any event on one with no Kibana browser session — the automated install, with its `_import` / `_export` request lines. A person editing a suite dashboard in a browser stays signal, and every change, the install's included, stays in `CHANGE_PRED`. The session-less install also scores 0 in the risk model (`SUITE_INSTALL`) unless it failed; 04's *Scoring events* tile counts it in its second line. Unfiltered counts stay on Command Center's *all traffic* panels, on 02's object panels and, when it is deployed, on Platform Volume. 7-day replica: signal 1.54M → 0.38M of 2.6M events. |
| Wide time windows once looked unservable — "2h, 3h and 4h all exceed 60s" | Those readings were taken back to back, and a synchronous ES\|QL query outlives the client that gave up on it and **cannot be cancelled** on serverless. Every query this repo runs now goes through a cancellable, budgeted call, and `--lint` reports its timings. What actually costs is query *shape* — see [`esql/fragments.md`](esql/fragments.md). Measured with `./audit --perf` on a 2.6M-event, 7-day replica, every panel query now returns in under 0.7s at 7 days and every dashboard loads in under 3.5s (see *Performance*). Dashboards default to the last 24 hours (`now-24h`, `DEFAULT_FROM` since 1.0.5; it was `now-1h`), ending at `now-1m` so nothing in range is still arriving. |
| `source.ip` is the **internal proxy** (`100.64.x.x` CGNAT, `10.x.x.x` mesh) | All geography uses `network.forwarded_ip`, the real public client IP. Using the obvious field would place every user in the datacentre. |
| `event.category` / `.type` are **arrays** | `MV_EXPAND` before any `STATS ... BY`. |
| `event.type` is **single-valued on Kibana** but **multi-valued on Elasticsearch** (`access_granted` = `["access","allowed"]`), and ES\|QL returns **null, not false**, for `IN` on a multi-value operand | The "what changed" predicate selects on `event.type` and is therefore implicitly Kibana-only. It carries an explicit `service.name` test so that is visible rather than accidental, and it is fail-closed everywhere else. |
| Kibana populates `kibana.saved_object.{id,type,name}` **only on the saved-objects audit path** — workflows, agent-builder, ML, product docs and secrets populate none of them | Object identity is recovered from `body.text`, which is never null on a Kibana event. Before this, every such change rendered as a blank row. |
| Kibana logs an **attempt** (`outcome: unknown`, *"User is creating…"*) on the saved-objects path and a **completion** (`outcome: success`, *"User updated…"*) on the newer feature path | Change panels relabel `unknown` to "attempted" rather than showing it raw, which reads as a defect. |
| `elasticsearch.audit.security_config_change` is a **JSON string**, not an object | Rendered verbatim as text; its internals are never aggregated. |
| `body.text` carries pre-rendered prose, but **only on Kibana events** | Always paired with the `serverless-kibana` source filter. |
| Keys inside `attributes` are **literal dotted strings** (`attributes['network.forwarded_ip']`) | Ingest processors cannot reach them by dot-path; the geoip pipeline lifts the IP with a script processor. |
| `attributes` and `resource.attributes` are **passthrough** objects, so every field under them is also queryable by its bare ECS name (`event.action` reads `attributes.event.action`, `service.name` reads `resource.attributes.service.name`) | Every query, control and filter uses the ECS names. The stored paths appear only in the ingest pipeline. A field that is not mapped yet is unknown under both names. |
| `api_key.id` and `api_key.name` get a mapping only when the **first API-key event** arrives | On a project where no key has been used yet, a query naming them fails with *Unknown column*. Every query that names `api_key.*` (most actor queries, through the identity `COALESCE`) starts with `SET unmapped_fields="nullify";` so the column reads as null instead (`nullSafe()` in `panels.mjs`; written out in `searches/` and `vega/`). Only those queries carry it, so a typo elsewhere still fails loudly. Discover underlines a column that is not mapped yet as a warning; the query still runs. |
| Index mapping is `dynamic: false`, and a dynamic template maps `attributes.*` to `flattened` | Enriched fields must be explicitly mapped at the **top level** (`client.*`), not under `attributes.*`. |
| `http.request.body.size` / `response.body.size` are mapped but **never populated** | Byte-volume KPIs are impossible; Platform Volume uses distinct HTTP request ids and a signal-share percentage instead. |

Full fragment reference: [`esql/fragments.md`](esql/fragments.md).

---

## The dashboards

Every dashboard carries a horizontal navigation bar pinned at the top, a short customer-facing intro
directly under it (what the page is for and how to use it, as a heading over small text), a default range of the last 24 hours
ending a minute ago (`now-24h` → `now-1m`, `DEFAULT_FROM` and `TIME_TO`),
auto-refresh off, and a hover tooltip on every panel explaining what it shows and how to read it.
The bar lists the deployed dashboards in one order on every page: Command Center, Actor 360,
Identity & Access, Kibana Object Forensics, Elasticsearch Data Access, Security & Anomalies, Geo &
Network, and Platform Volume last when it is deployed. The numbers below are source file names
(`scripts/lib/dashboards/NN-*.mjs`, `dashboards/NN-*.json`), not the bar's order and not part of any id.

| # | Dashboard | What it answers |
| --- | --- | --- |
| 00 | 🎛️ **Command Center** (`elastic_cloud-audit-dashboard`) | Entry point. Six KPIs (Total and Failed events compare with the prior period), volume by source, how far back the audit data goes, actor-risk treemap, signal-vs-noise stream, live signal feed. |
| 01 | 🔐 **Identity & Access** | Who authenticated, with which credential type, from where, and what failed. API key inventory with ownership. |
| 02 | 🗂️ **Kibana Object Forensics** | Every Kibana read and state change by type, name, space and actor. Changes are surfaced first, full width — they are rare and always worth reading individually. Ends with Actor 360's 24-hour session timeline over Session reconstruction: a click on a session bar narrows the records to that session. |
| 03 | 🔎 **Elasticsearch Data Access** | What data was read, by whom, through which transport action, including dot-prefixed system indices. |
| 04 | 🚨 **Security & Anomalies** | Mean severity (0–50) and a risk leaderboard, security config changes, rare/privileged operations, newly seen identities. |
| 05 | 🌍 **Geo & Network** | Real client geography, choropleth, impossible-travel detection, and proof that `source.ip` is the wrong field. |
| 06 | 📊 **Platform Volume** · *opt-in* | The unfiltered firehose, quarantined so the rest stay readable. Not deployed unless asked for: see *Optional dashboards* under Commands. |
| 07 | 👤 **Actor 360** | One identity's whole footprint — pick a person in the control bar. **① Is this normal?** reads a fixed 7 days whatever the picker says: activity against their own hourly baseline, their rank among the week's 40 busiest identities, their weekly rhythm. **② What they did** follows the picker: a credential → space → object → operation flow, changes, reads, a map with travel lines, the risk receipts. **③ Evidence**: a 24-hour session timeline whose bars filter the dashboard to that session and zoom it there, over the raw records. |

### The risk model

Severity weights, with routine activity scoring **0** on purpose:

| Event | Weight |
| --- | --- |
| Kibana's own API-key clean-up (`HOUSEKEEPING`: `invalidate_apikeys` by a platform account through no named key) | 0 |
| `security_config_change` present | 50 |
| `invalidate_apikeys` | 45 |
| `event.outcome == "failure"` | 40 |
| `anonymous_access_denied` | 35 |
| destructive Kibana change (ECS `deletion`, plus `rule_disable`) | 30 |
| any other Kibana change | 25 |
| workflow execution (`run` / `test` / `execution_cancel`) | 10 |
| everything else | 0 |

The clean-up row is tested first and is the same rule the Privileged ops and Config changes tiles leave
out, so no risk panel paints `elastic/kibana` hot for events those tiles call routine. A deliberate
invalidation by a person, a named key or a Cloud API key still weighs 45.

**Branch order is load-bearing.** ES|QL `CASE` is first-match-wins, and the original order tested
the generic predicates first, which made two of these weights dead code: `invalidate_apikeys`
always carries a `security_config_change` payload so it scored 50, and `anonymous_access_denied`
always carries `outcome == "failure"` so it scored 40, and 45 and 35 could never fire.
Action-specific branches are now tested before the generic ones.

The same discipline governs the three change branches. **Executions are tested before deletions**,
because `workflow_execution_cancel` is ECS-tagged `deletion` and would otherwise score 30 as though
a workflow had been deleted. **Executions weigh least on purpose** — they are the one class here
with unbounded cadence, and a scheduled workflow firing every minute at 25 would turn total risk
back into an event count wearing a hat, which is the failure the 0-baseline exists to prevent.
**Destructive sits at 30, below anonymous denial and failure**, so "a mutation that was denied is
the more interesting event" still holds: a failed delete still scores 40.

The KPI reports **mean severity on the same 0–50 scale as the weights**, not a "normalised 0–100
index". The index it replaced divided by the maximum weight while the smallest non-zero weight was
25, so it could never read below 50 — half its advertised range was unreachable, and an identity
whose scoring events all shared one weight could only read 100, 80 or 50. A scale whose floor is half its span does not
survive an analyst reading it.

```
mean_severity = ROUND(SUM(risk) / COUNT(*), 1)      -- over scoring events only
```

The leaderboard sorts by `risk_total` so sustained behaviour outranks a single high-severity
event, and carries an `actor_scope` column separating Elastic's own platform automation from
tenant identities — without it `elastic.maintenance` can top the table, because Elastic's
platform automation can perform security config changes on a serverless project, and those carry
the highest weight.

### Drill-down

The suite ships **controls** and **drilldowns**, and neither can go through the Dashboards API.
`PUT /api/dashboards/{id}` silently drops both `controlGroupInput` and
`enhancements.dynamicActions`, and a GET→edit→PUT round-trip would destroy every Vega panel, which
the API itself warns about via `warnings[].type: "dropped_panel"`. Both are therefore applied by the
same `_export → mutate → _import` post-pass that repoints Vega — see `applyImportOnlyState()` in
`scripts/dashboards.mjs`. Because the PUT passes wipe that state on every deploy, the post-pass is
part of every `--dashboards` run, not an install step.

**Drilldowns run both ways.** Every identity panel elsewhere offers *Open in Actor 360*. Actor 360's
own panels drill **out**, to the dashboard that owns the dimension clicked — an action to Security &
Anomalies, an address to Geo & Network, an index to Elasticsearch Data Access — because Actor 360 is
where something is noticed and the topic dashboards are where it is investigated. A panel names its
destination with `drill`, which is kept on the in-memory definition and stripped from the API payload. A
click-to-filter column must reach Lens as the raw field (a group key, or kept as it is): Kibana builds no
filter from a column the query assigns, even under a real field name, so the cell still looks like a link
but a click opens nothing, drilldown included. `layout.mjs` fails such a column (`checkClickFilters`).

**Vega panels filter too.** On Actor 360, clicking a credential or a space in the flow, or
shift-clicking a session, pins it across the suite. Clicking a session (on Actor 360 and on Kibana
Object Forensics) pins a `session: …` pill on `kibana.session.id` AND sets the time range to
the session plus a minute either side, because the records under the timeline follow the picker while
the timeline is fixed at 24 hours. The zoom is sent 0.7s and 1.4s after the click, from a Vega timer:
`kibanaAddFilter` resolves its data view over the network before it fires, and a time change sent first
reloads the panel and drops the filter (clicked in Playwright: the pill never appeared); sent 5s later,
the reload the filter itself causes has already replaced the view and the zoom is lost. Double-clicking
the flow clears every pill on the page.

**The control bar** — four option-list dropdowns on every dashboard, defined in
`scripts/lib/controls.mjs` (width `small` with grow, so the four share one row at 1440px and at 1920px):

| Control | Field | Why |
|---|---|---|
| Project | `project.name` | The serverless project that **emitted** the event. An audit project usually collects the audit streams of several projects; this narrows the whole dashboard — and, through hierarchical chaining, every dropdown after it — to one of them. Populated on every Elasticsearch and Kibana event. Names are not unique in Elastic Cloud, so projects that share a name share an option. **Actor 360's cohort rank follows Project and nothing else:** it ranks against everyone active in the projects the selection is active in, so a Person or Client IP selection highlights that identity instead of shrinking the cohort to one. Exact across all projects or within one; across several (not all) it sums events and takes each distinct count's per-project maximum, and its title says *approximate*. |
| Person (email) | `user.email` | The identity control: the reliable identity key, never null for a human. |
| API key | `api_key.name` | A named Elasticsearch API key. A Cloud API key has no name, so it is not listed: pin one from a *Principal id* cell instead (below). After Person in the chain, so choosing a person narrows it to keys whose events carry that email, which is usually none. A runtime "identity" field was tried instead and rejected: its pill is a filter on a field the index does not have, and every ES\|QL panel went empty. On a project where no API key has been used yet the field is unmapped and the list is simply empty. |
| Client IP | `client.ip` | Can hold more distinct addresses than anyone could eyeball, which is the point of a searchable dropdown. |

`user.name` is deliberately not offered as a dropdown — it is a numeric id, not a name; it is reachable
from the *Principal id* click columns instead. Nor is
`user.full_name` (a *Person (name)* control until 1.0.2): it is null for some identities,
so a name dropdown silently missed people the email dropdown finds.

Controls need a real data view, so `elastic_cloud-audit-logs` is deployed as an `index-pattern` saved
object; the Discover sessions keep their inline ad-hoc one. State shape was settled empirically
against 9.6.0 serverless (import a throwaway dashboard, export it back): control state is
**wrapped in `explicitInput`**, and the data view arrives by reference named
`controlGroup_<uuid>:optionsListDataView`.

**What "sticky across dashboards" actually means**, measured end to end in a browser: selecting
an identity scopes every panel, KPIs included, and clicking through the nav bar
carries the *filter* to the destination, where every panel is correctly scoped and a pill reads
`user.email: <identity>`. The destination's **dropdown itself reads "Any"** — control
selections live in dashboard app state, which `use_filters` does not carry. The numbers are
right everywhere; the widget does not re-display the selection. Read the pill, not the dropdown.

The older click-to-filter path still exists and needs neither:

- identity columns are `click_filter: true` on the **real** `user.email` field, never
  on the derived `actor` COALESCE, which has nothing behind it in `_source`;
- every ES|QL panel already carries `ignoreGlobalFilters: false` — Kibana materialises it itself
  as a Lens datasource-layer property (verified in a real `_export`: 11 of 11 ES|QL layers), so
  it is deliberately NOT emitted in the deploy payload, where the Zod-strict API would drop it;
  the 9.6 `esql` expression function compiles dashboard pills through `buildEsQuery` into the ES
  `filter` parameter;
- the nav bar's `dashboardLink`s carry `use_filters: true`.

**Identity tables click through to Actor 360** (1.0.5). An identity table shows *Identity*, the computed
`actor`, which cannot be clicked. Beside it, the tables on 00, 02, 03 and 04 carry the raw fields behind it as
STATS BY group keys and show them as narrow click-to-filter columns (`PIN_BY`, `PIN_KEY`, `PIN_PRINCIPAL` in
`scripts/lib/dashboards/shared.mjs`): **Principal id** (`user.name`: a Cloud API key's full id, a service
account, a person's numeric id) everywhere, and **API key** (`api_key.name`) where a row has room for both
(04's *Risk leaderboard* and *Config changes*, 03's system-index table). A click pins the field and offers
*Open in Actor 360*; verified in Playwright on a private deploy (04 leaderboard and 01 Busiest API keys →
Actor 360 with `user.name: <id>` pinned, every panel narrowed). Two things to know, both in the tooltips:
- A Principal id pin is the principal, not the credential. On a Cloud API key it also matches every
  Elasticsearch API key that key created, because Elasticsearch stamps the creator in `user.name`; a named
  key's row, where there is no API key column, pins the identity that created it. The API key control pins
  the key itself.
- *Principal id* is 250px where `<unauthenticated-cloud-access-token>` (36 characters) can appear, and 165px
  where it cannot (it never signs in, so it changes nothing and reads no index). 00's *Busiest identities*
  gave Last seen and Actions to it.
03's *Denied requests by identity* has none: its last row folds the rest (`foldRest`), and nulling the raw
keys there would mean assigning them. 07's *Who this is* groups by email **and** principal id, so it is not
empty under a key or Cloud-key pill. The extra group keys split a row only where one identity carries two
principals, so a table can hold a row more than the distinct count beside it.

So clicking an identity pins it, and it stays pinned across every dashboard. Verified at the
data layer: a `match_phrase` filter on `user.email` and a native ES|QL `WHERE` return
identical counts.

## Geo enrichment

`network.forwarded_ip` holds the real public client IP. An **audit-scoped**
ingest pipeline lifts it to `client.ip` and geo-resolves `client.geo.*`.

Scoping matters. The obvious hook, `logs@custom`, fires for *every* `logs-*` data stream in
the project. Instead this installs a dedicated pipeline attached as `index.final_pipeline` on
the audit data stream only, with a component + index template so it survives rollover:

```
ingest/audit@custom.pipeline.json    script (lifts the dotted key) + geoip, guarded to the audit dataset
ingest/audit@custom.component.json   client.* and tags mappings + final_pipeline
(index template)                     BUILT at install time from the live logs-otel@template
```

Every name derives from `AUDIT_STREAM` (`logs-<dataset>@custom`, `logs-<dataset>@template`), because
Elastic has renamed the stream once already and a pipeline guarded on the old dataset installs, attaches
and silently does nothing.

The index template is **not** a committed copy. The audit stream is created by Elastic's managed
`logs-otel@template` (logsdb mode, passthrough `attributes`, `dynamic: false`); ours replaces it for this
one pattern at the next rollover, so a stale copy would silently change the stream's mappings or index
mode. `--ingest` mirrors the live template, appends our component, **simulates it as a replacement for the
installed copy, and refuses to install if the index mode would change**. It is idempotent.

The database is Elastic's built-in **MaxMind GeoLite2-City**. On serverless it cannot be inspected or
replaced (`_ingest/geoip/*` answers 410). Country is reliable; city is often the ISP's location, so read
city-level panels (impossible travel) accordingly. For the first seconds after the pipeline is attached the
database may not be loaded yet: those events keep `client.ip`, get no geo, and carry
`tags: ["_geoip_database_unavailable_GeoLite2-City.mmdb"]`. `tags` is mapped so that is visible.

**Enrichment is forward-only.** Documents indexed before installation carry no geo. Verify it
is actually running with `./audit --ingest-check`. Only public client IPs resolve: Kibana's own calls
to Elasticsearch arrive from internal `100.64.0.0/10` addresses.

---

## Platform constraints

Probed against Kibana 9.6 serverless. Several are undocumented and cost real time to discover:

| Constraint | Handling |
| --- | --- |
| Generic `/api/saved_objects/{type}/{id}` CRUD is **disabled** on serverless | Vega and Discover sessions deploy through `_import` (multipart ndjson) |
| The Dashboards API accepts only `links`, `markdown`, `vis`, `discover_session` panels | `map` is unavailable. Inline `region_map` exists but takes no palette, legend or extent through the API (one alert-red fill over the basemap labels, a collapsed legend), so 05's map is a Vega choropleth over Elastic Maps Service (`vega/06-geo-origin.json`) |
| A `vis` panel with `ref_id` **always** serialises its reference as `type: "lens"` | Vega charts are legacy `visualization` objects, so `repointVega()` rewrites those panels to the classic `panelRefName` form after deploy. Without it every Vega panel renders *"Visualization type not found."* |
| ES\|QL visualizations cannot be standalone saved objects | Lens panels are inline in the dashboard definition, which also keeps each dashboard self-contained and diffable |
| XY split key is `breakdown_by`, not `breakdown` | — |
| Partition charts use `metrics[]` + `group_by[]`, not `slice_by`/`metric` | — |
| A `data_table` with an empty `metrics` array crashes the API | Raw event listings are aggregated, or shipped as Discover panels |
| A Lens table prints a null cell as `-` (a clickable, underlined `-` in a click-to-filter column) and an empty string as `(blank)`; a column the query assigns — even `EVAL user.email = COALESCE(…)` — loses click-to-filter (*"relies on a field created at query time"*) | `blankNull()` blanks display columns only; a filter column keeps its nulls, or is dropped where they dominate |
| A pie's outside slice labels are dropped for small slices when the panel is short | `pie()` always draws a legend (`right`, size `l`), so every category is named somewhere |
| On an ES\|QL Vega spec, `"domain": {"%timefilter%": true}` renders the bare "Error" | Echo `?_tstart` / `?_tend` after the `STATS` and draw them as an invisible mark, so the axis spans the whole window (vega/07) |
| Metric items accept no per-item `color` | Styling lives at config root |
| `dashboardLink` targets must already exist | Dashboards deploy in two passes |
| Reporting API rejects `pngV2` / `printablePdfV2` | Verification drives Chromium directly |
| **Every Lens ES\|QL request carries a hidden `@timestamp` range filter for exactly the picker's window**, whether or not the query uses `?_tstart`/`?_tend` (captured in the browser: `"filter":{"bool":{"filter":[{"range":{"@timestamp":{"gte":…,"lte":…}}}]}}` beside the params, on a query that never compares `@timestamp` with `?_tstart`). Kibana adds it for the layer's time field — the column first compared with the params, else `@timestamp` at run time; another column only moves it | No Lens panel can read outside the range: a previous-period count comes back 0, and a lower bound below `?_tstart` is silently cut there (it was on Actor 360's whole-minute window until 1.0.5). The prior-period tiles and *Audit data held* are DSL Vega specs instead (`PREV_TILES`, `coverageSpec()` in `panels.mjs`) |
| A DSL Vega body can read the picker without being bound to it: `{"%timefilter%": "min"}` / `"max"` anywhere in `body.query` or `body.aggs` becomes the window's start or end in ms (a script's `params` included) | The prior-period tiles take their own range from a 15-day lookback through `"max"`, and split events into prior and current by `min`/`max` in a script `range` aggregation. `--lint` binds the placeholders to a fixed window and checks each tile's count against its ES\|QL twin (*parity*) |
| An ES\|QL Vega spec **always** follows the time picker — omitting `%timefield%` does not opt out | A panel that needs its own window (a 7-day baseline on a 24h dashboard) is a **DSL** Vega spec: `url.index` + `url.body` with an explicit `@timestamp` range and the `%dashboard_context-*%` placeholders keeps the control-bar filters and ignores the picker. Confirmed on a live dashboard |
| Two **unnamed** DSL datasets in one Vega spec cross their responses — the second gets nothing and the panel shows a bare "Error" | Every DSL dataset carries a unique `name`; `layout.mjs` fails the build otherwise. (Kibana's `es_query_parser` matches results by the result's index, not the request's) |
| Kibana themes axis, legend and title text, but **not text marks** — an unstyled text mark is `#000` on the dark theme | Full Vega text marks take `style: "guide-label"` / `"guide-title"`, which Kibana colours per theme. Vega-Lite `style` does not reach text marks at all; there, words go in a `title` whose `text` is an expression. Every themed Vega style is the same *subdued* text colour (measured: `rgb(152,168,195)` dark, `rgb(81,99,129)` light), a step softer than a Lens metric's title and number, and a spec cannot read the theme, so the Vega metric tiles' words are that step softer than the Lens tiles beside them |
| `kibanaAddFilter(query, index)` resolves `index` by data view **title** | Pass `logs-elastic_cloud.serverless_audit.otel-default`; the id `elastic_cloud-audit-logs` renders *Index "elastic_cloud-audit-logs" not found* |
| External URLs are blocked in Vega on serverless | The basemap is Elastic Maps Service: `{"%type%": "emsfile", "name": "World Countries"}` with `format: {type: "topojson", feature: "data"}` — not `property: "features"`, which yields one useless row |
| Vega errors render inside the panel as `li.vgaVis__message--err`, often as a bare "Error" | `--verify` counts those elements in addition to reading text |
| Dashboards, visualizations, searches and data views are **multiple-isolated**: an id is unique across all spaces | With the suite deployed in one space, a second space's `PUT /api/dashboards/elastic_cloud-audit-…` is a 409 and `_import` silently re-ids the Vega and Discover objects. The suite lives in the Default space, so a private render sits beside production under its own ids: set `AUDIT_ID_NS` (`AUDIT_ID_NS=x ./audit --objects`, then `--dashboards`, `--verify`) and every id is namespaced: `cloud-audit-x-…` for the Vega and Discover objects, `elastic_cloud-audit-x-…` for the dashboards and the data view (`elastic_cloud-audit-x-dashboard`, `elastic_cloud-audit-x-logs`, …) |
| `data_table` rows and metrics take `label` and `width` natively (stored as the Lens `customLabel` and column width) | `table()` titles every column and sizes it by role; see *Presentation conventions*. A label never changes the filtered field |
| An `xy` chart's legend defaults to `hidden`, even with a `breakdown_by` | `xy()` emits `config.legend` (`bottom` list by default when there is a split) and the `eui_amsterdam` palette; Kibana's `default` palette pairs each hue with a pale tint that vanishes on white |
| Markdown panels have no font-size setting, `###` renders at ~20px, and raw HTML is **dropped** before render: a `<style>` block or a `<div class>` never reaches the page (probed: no style element in the DOM; the old `CSS_NAV` block on Command Center never styled anything) | `md()` lifts a leading heading into the panel title; `layout.mjs` rejects `#`–`###` anywhere else. The intros need small text, which only the legacy markdown *visualization* has (`fontSize` in pt), so the post-pass swaps each intro for a by-value one at 9pt: 12px paragraphs, a 17px `###` heading, theme colours (see *Presentation conventions*) |
| Discover in ES\|QL mode ignores the ad-hoc data view's `fieldAttrs.customLabel` | Session headers come from a trailing `RENAME` — see *Presentation conventions* for the filter trade-off |

---

## Presentation conventions

These dashboards are read by people who did not build them, in both themes, at several times
today's volume. Each rule below came out of a rendered review of every panel, and each is enforced
in shared code rather than at call sites.

**Lens tables — `table()` in `scripts/lib/panels.mjs`.**
- *Headers.* Name ES\|QL columns for the query (snake_case aliases, raw fields) and let `table()`
  title them: `COLUMNS` maps the suite vocabulary (`actor` → Identity, `last_seen` → Last seen,
  `user.email` → Email …) and anything unlisted is humanised. `sized(col, w, { label })` or
  `filterable(col, { label })` overrides. A label is a Lens custom label, so a click-to-filter column
  labelled "Email" still pins `user.email` — never alias a filter column in ES\|QL.
- *Widths are roles.* Dates, counts, IPs and short enums have fixed widths from `COLUMNS`, on metrics as
  well as rows; text columns flex and share the rest. Lens hard-clips a cell without an ellipsis, so
  width is the only defence. Give a text column `sized()` only to stop a sibling taking all the slack.
- *Narrow viewports.* A Lens width is absolute pixels, so `table()` budgets every table for a 1440px
  viewport (a w-column panel's grid is w × 1324/48 − 24px there). When the fixed widths leave a text
  column under 150px, they shrink toward their floors (dates never; counts to 72px, IPs to 118px; a `sized()` column
  to 70%, or its own `min`). A table that cannot give its text columns ~120px even at its floors is listed as
  an advisory by the layout check: it needs a wider panel or fewer columns. Render with
  `AUDIT_VERIFY_WIDTH=1440` to see it.
- *Visible rows.* Tables are compact density with one-line rows, and a trailing `| LIMIT n` is **set** to
  `fitRows(h)` (h=8 → 6, h=11 → 9, h=12 → 10, h=13 → 12, h=14 → 13), raised or lowered, so the LIMIT is
  always exactly the rows the panel shows: above it rows hide with no cue, below it the title's bound
  sits over room for more. Author the LIMIT as `fitRows(h)` so the source reads true. Only a LIMIT that is
  the query's very last step is set, so per-row EVALs go before the SORT/LIMIT; `--lint` fails a LIMIT
  that is not the rows that fit (either way) unless `{ scroll: true }`. `{ scroll: true }` keeps a larger
  LIMIT for a feed whose bound is the point; `{ wrap: true }` gives auto-height rows for a column whose
  whole value matters. Rows start 57px below the panel top; at h=12 ten 24px rows end 22px above the
  grid's bottom rule, and that remainder is the blank strip under the last row, not a hidden row.
- *Say where the list is cut — as a bound.* A partial list read as complete when its title did not say it
  was cut ("Top transport actions" over 9 rows beside a tile reading 12), and a cut stated as a count was
  false whenever the window held fewer ("Top 14 index families" over 2 rows at 1h, "Busiest object types ·
  top 9" over 8). So `table()` appends an **upper bound**, true at any row count: *"· top 10 at most"*, or
  *"· newest 10 at most"* when the LIMIT follows a `SORT` on a time column `DESC` (the sessions already say
  *"newest 1,000 at most"*); a title that already names the order (*Top …*, *Latest …*, *… most recent …*)
  gets only *"· 13 at most"*; a title may write its own bound as *"up to 100"*. A bare count after an order
  word (*top 10*, *latest 9*, *newest 1,000*, *the 30 most recent*) throws at build and fails `--lint` on
  every panel type, charts and Vega included. `{ cut: false }` opts a closed set out.
- *Titles carry no instructions and no window caveats.* A title is shown at every time range and every row
  count, so *"· scroll"* over a table with nothing to scroll and *"(may be empty at 1h)"* over 774 rows at
  24h were false there. A table that holds more rows than it shows (`{ scroll: true }` above `fitRows(h)`,
  or `{ wrap: true }`) says so in its **description** (`SCROLL_NOTE`, appended by `table()`), and
  `{ empty: 'quiet' }` reads *"(empty when none in range)"*. `--lint` fails *scroll*, *(may be empty …)* and *at 1h* in any
  panel title, and a scrollable table whose description does not say *scroll*.
- *Empty cells.* A null prints as `-`. On a display column, end the query with `blankNull(col)` after
  the `STATS` and it prints nothing. Never on a click-to-filter column: Lens refuses to filter on any
  column the query assigns ("created at query time"), so a null there stays an underlined `-`. Where
  those dominate, drop the column (00's Busiest identities has no Email column for that reason).
- *Empty states.* Kibana prints a bare "No results found" for an empty ES\|QL table or Discover session,
  no 9.6 setting replaces it, and a description is only a tooltip. A query cannot add a placeholder row
  without making every row column "created at query time" (no click-to-filter, no drilldown). So the
  meaning goes in the title — and since the title shows whether or not there are rows, its words must be
  true either way: a parenthetical *condition*, never a status. `table(…, { empty: 'good' })` →
  *"Denied requests · top 7 at most (empty = good)"*; your own words must start *empty when / if /
  without / unless* → *"(empty when no browser sessions)"* (anything else throws at build). `'quiet'` →
  *"(empty when none in range)"*: its old words, *"(may be empty at 1h)"*, named one window and read as
  wrong at every other. Round 3's *"· none is good"* and *"· empty without X"* read as a verdict on the rows
  whenever the table was full; `--lint` rejects that form. `search()` takes the same option, and the
  description gains the matching sentence. Use it on every panel a 1h render shows empty on a
  healthy project (an hour is still one click in the picker; the default became 24 hours in 1.0.5).
- *Completeness.* A title must not promise more than the panel shows. A LIMITed table whose title says
  *every*, *everything* or *all* fails `--lint` (`layout.mjs` `PROMISES_ALL`): say *top*, *busiest* or
  *most recent*, or pass `{ scroll: true }` when the LIMIT is a guard on a closed set (07's *Every scoring
  action*).
- *Opaque identities — one form.* An Identity that resolves to a 20-character id is an organisation-level
  Elastic Cloud API key: the stream records no name and no owner for it. It is shown the same way
  everywhere an identity is shown — **`_4KEO… · Cloud API key`** (first five characters, then the tag) —
  by `ACTOR_LABEL` in `panels.mjs` (the full id is in every *Principal id* column, in 01's *Busiest API keys*
under *Key ID (Cloud) / creator*, and in API key inventory): `table()` appends it to every table showing `actor` (after the LIMIT,
  so after the last `STATS BY actor`), and every Discover session and Vega spec that shows an identity
  embeds it verbatim (pinned by the drift check). A key-name or owner column that would print `-`,
  `0` or `(no name)` for such a key uses `cloudKeyLabel(col, otherwise)` instead (API key inventory). The
  test is on the value, not the realm: the same key arrives as `_cloud_api_key` on Elasticsearch events
  and sometimes `_es_api_key` on Kibana's. Never gate a specific key out and never hardcode its id: on
  this project the busiest such key is this repo's own tooling, and that is real audit data.
- *Privileged operations.* `security_config_change` is the stream's word for a privileged write, but
  Kibana's own clean-up — `invalidate_apikeys` by `elastic/kibana`, every few milliseconds — kept every
  "any non-zero deserves review" tile permanently non-zero (670 of 671 in an hour). `PRIVILEGED` leaves
  out exactly that (`HOUSEKEEPING`: `invalidate_apikeys` by a platform principal through no named key);
  `privilegedKpi(col)` puts the excluded count in the tile's secondary line in the short form
  *"excl. 2,285 cleanups"*: Lens right-aligns that line directly above the number, and the longer
  *"284 key cleanups left out"* over a *1* read as the tile's headline. A key Kibana creates on a
  user's behalf, and any tenant invalidation, still count. The risk model scores the same clean-up 0
  (`RISK`'s first branch reads the `housekeeping` key of `RISK_KEYS`), so every risk panel agrees with
  these tiles; never write a tooltip that explains a mismatch between them.
- *The suite's own install scores 0.* `./audit --objects/--dashboards` writes the suite's `cloud-audit-*`
  objects with a Cloud API key and no browser session. `NOISE` kept that out of the feeds, but every risk
  panel scored it, so 04's leaderboard ranked the deploy key first (about 4,500 of its 5,400 severity in
  24h) while 00's treemap did not. `SUITE_INSTALL` (a suite object id and no `kibana.session.id`) is a key
  of `RISK_KEYS`, and `RISK` scores it 0 right after the failure branch: a denied write to a suite object
  still scores 40, and a person editing a suite dashboard in a browser still scores 25 / 30. It stays in
  `CHANGE_PRED` and on every mutation list, and 04's *Scoring events* tile says *"excl. N suite installs"*.
  It tests the channel, not a key, so never narrow it to the deploy key's id.
- *Failed sign-ins count once.* Every failure count uses `FAILED_OR_DENIED` (`panels.mjs`), which drops
  the per-realm `realm_authentication_failed` traces; `SIGNIN_WORDS` says so in a description. 01 and 04
  both use it, so their failure tiles are the same number.
- *Live edge.* Every saved range ends at `now-1m` (`TIME_TO` in `dash()`; `--verify` renders the same), so
  never describe a bar or a total as "still filling", or two panels as differing by "rows landing between
  the two queries". The last bucket covers only part of its interval. Where a page sets a total beside
  its parts, `EDGE_NOTE` states the one gap left: panels read the clock up to a second apart.

**KPI secondary lines — grouped digits.** A metric tile's secondary line is a string the query builds,
and ES\|QL's `TO_STRING` prints *"2326"* beside tiles Lens prints as *"1,728,070"*. Every count in it goes
through `grouped(col)` in `panels.mjs` — `CONCAT(${grouped('signin')}, " failed sign-ins")` — on the
single row the STATS returns (a multi-branch CASE, so never per event). Keep the line short (an 8-column
tile shows ~22 characters at 1440px) and quiet, a qualifier of the number under it. `--lint` fails a
secondary line that stringifies a column without `grouped()`.

**Prior-period tiles (1.0.5).** Six headline counts whose filter is plain — 00 *Total events* and *Failed
events*, 02 *Kibana events*, 03 *Elasticsearch events*, *ES\|QL queries* and *Access denied* — show the
change against the same length of time just before the range: *"▲ 34% vs prior 24h"*, *"▼ 50% …"*, *"▲ 15×
…"* at ten times or more, *"none in prior 24h"*, and *"no full prior 24h"* when the audit stream (or the
tiles' 15-day lookback) starts inside that earlier period, so a new project never shows a false rise. Lens
cannot read outside the picker (*Platform constraints*), so each is a generated DSL Vega spec
(`vega/15-prev-*.json` from `PREV_TILES` in `panels.mjs`; edit the table, never the files) drawn at a Lens
metric's sizes and offsets, measured at 1920 and 1440 in both themes. `PREV_TILES` holds each tile's ES\|QL
`WHERE` and DSL clauses side by side, and `--lint` fails if the two count a different number of events over
a fixed 14-day window. A tile whose filter is not plain DSL (the noise gate, risk, resolved identities,
distinct counts) stays Lens. *Audit data held* (00, `vega/14`) is the same kind of tile over the whole
stream: days since the first stored event, ignoring the picker and the controls, with the retention the
data stream's lifecycle reported at `--objects` time.

**Numbers that sit together must reconcile.** A KPI and the table beside or below it, two tables
counting "the same" identities or events, or a tile and the chart under it must agree, or say on the
panel why not. Two things make them disagree, and both are rules:
- *Same gate.* Both are gated by `NOISE`, or neither is. A presence panel (rule 4 of QUERY SHAPE) is
  ungated by design; one beside a gated panel says *all traffic* in its title, as 00's do.
- *Same resolution.* Both count the same key: the `actor` COALESCE (`ACTOR_RESOLVE`), or the raw
  `user.email`, or `api_key.name` — not one of each. The email groups an API key's
  events under its creator; the COALESCE gives the key its own row. A distinct count
  (`COUNT_DISTINCT(actor)`) counts what the table beside it groups by. (The review that set this rule
  found 32 identities in a KPI over a 28-row table, and one person at 12,649 events in one panel and
  8,526 in another.)
- *Same population otherwise.* A table cut by LIMIT does not sum to its KPI; its title says *top* (see
  *Completeness*) and, where a reader will add the rows up, the description says the rest is beyond the
  limit. A table that adds a filter the KPI lacks (Kibana only, humans only, client IP present) names it in
  the title.
Where a difference is the point (gated vs all traffic, email vs key), the title or the first sentence
of the description names it — never only the tooltip of the other panel.

**IP tables group by the address.** `STATS … , ${IP_GEO} BY client.ip` (see
[`esql/fragments.md`](esql/fragments.md), *Location per address*): never `BY client.ip, client.geo.*`,
which prints an address twice when some of its events predate enrichment. `placed == 0` is the only
"not placeable".

**Charts — `xy()` / `bar()`.** A breakdown gets a legend (`legend: 'bottom' | 'right' | 'hidden'`).
`bottom` is one line and clips past ~6 series: use `'right'`, or fold the tail into "other" in the
query. `colors: { value: '#hex' }` pins a category to a colour so it matches across panels — pin every
value the query can produce, because an unpinned value takes the palette from its start, where a
pinned one may already sit (shared maps: `CRED_TYPE_COLORS`, `SOURCE_COLORS`). End a breakdown query
with a `SORT` on the breakdown (or an order column): Lens stacks and lists series in row order, and an
unsorted `STATS` reshuffles them between refreshes. `values: true` labels only bars wide enough to hold
the label, so it names the leaders, not the tail. `yScale: 'log'` for series that differ by orders of
magnitude; `yTitle` for a measure the panel title does not name.

**Pies — `pie()`.** Always a legend (`right`, size `l`, or `bottom`/`hidden`), slice labels `inside`
(or `outside`), percentages at one decimal, and the `eui_amsterdam` palette with `colors` pinning —
unpinned, slice colours follow slice order, which follows volume.

**Markdown — `md()`.** A note's heading is its panel title. A leading `#`–`###` line is lifted into
it; `####` is a bold run-in label (and what `section()` draws).

**Intros — `introMd()` / `dash(…, { intro })`.** Every dashboard opens with a full-width intro under the
nav strip (`intro: { h, heading, paragraphs }`; `dash()` places it and moves every authored panel down by
`h`), and Command Center's *How to read this suite* box (`legendPanel()`) is written the same way: a `###`
heading in the panel with no trailing period and no panel title, then one source line per paragraph, no
HTML. They are PUT as plain markdown, which is what `dashboards/*.json` shows, and the post-pass replaces
each with a by-value legacy markdown visualization at `INTRO_PT` (9pt: 12px text on an 18px line, 14px
between paragraphs). Size `h` by rendering at 1920 and at 1440 (`AUDIT_VERIFY_WIDTH=1440`): a 48-column
intro with three one-line paragraphs is ~151px, so h=6; a paragraph that wraps at 1440 (over ~220
characters) adds 18px. Too short shows a scrollbar, too tall a blank band, and no check sees either.
Technical detail (field names, exceptions) goes in the panel tooltips, not in an intro.
Every intro (and so every dashboard) links to the raw events with `RAW_RECORDS` (`shared.mjs`): *"Raw records:
All audit events, Raw signal feed"*, written `[words](@search:<ref>)` and resolved by `introMd()` to the
relative `/app/discover#/view/<id>` through `nsId()`, so a private deploy links to its own sessions and no
Kibana URL is committed. Clicking it opens the Discover session (verified). The nav strip stays dashboards
only: a Links-panel `externalLink` carries neither the pills nor the time range.

**Discover sessions — `searches/*.json`.** End the ES\|QL with `| RENAME field AS Header, …` after
every drift-checked fragment, list the new names in `columns` and `sort`, and put `@timestamp` first
(renamed `Time`). `grid.columns` sets widths; dates and IPs get one by default, and rows are one line
(`row_height` overrides). The trade-off, measured: on the embedded dashboard grid a renamed column
loses its filter-for/out cell actions, because no index field stands behind the new name; in the
Discover app filter-for still works — it appends `| WHERE \`Header\` == …`. The suite's pivots are
the control bar and the Lens click-to-filter columns, so sessions rename everything they show, with
one exception: `searches/09` keeps `kibana.session.id` raw, under its field name, so a
session cell offers Filter for/out on the dashboard. There is no friendlier header to be had: the saved
search's `grid.columns.<name>` is a closed schema in 9.6 (import rejects `display`, `displayAsText`,
`label`, `customLabel`, `displayName` and `name`; only `width` passes), and `fieldAttrs.customLabel` is
ignored in ES|QL mode. `layout.mjs` fails a session that lists a renamed column by its old name. Pattern:
`searches/10-raw-signal-feed.json`.

**Vega colour.** A spec cannot tell which theme it is in, so no colour may sit near either
background (dark panels are ~`#111C2C`, light are white).
- *Magnitude* (heatmap, matrix and punchcard cells, gantt bars, choropleth countries): a **colour**
  ramp over four mid-tone suite hues, `MAGNITUDE_RAMP` in `panels.mjs` —
  `"color": {"field": …, "type": "quantitative", "scale": {"type": "log", "range": ["#54B399", "#6092C0",
  "#9170B8", "#D36086"], "interpolate": "hcl"}}`, teal (fewest) → blue → purple → pink (most). The
  one-hue opacity ramp it replaces (`#3987e5` at 0.35–1) was nearly flat on the dark theme: every step
  from 10 to 100k sat between 2.0:1 and 4.7:1 of the same blue, and the round-4 review could not tell
  1 from 1k from 100k on 01's, 02's or 03's matrix. Hue does not depend on the background; every stop is
  ≥2.5:1 on white and ≥4.3:1 on the dark panel. **Fit the domain to the data** — no `nice`, no
  `domainMin` — so the four hues span what is drawn: a domain stretched to 1–10M left real cells two
  shades apart. The gradient legend then covers exactly the drawn range; label it at the decades inside
  `domain('color')` (the domain's own ends when fewer than two decades fall inside) with
  `"labelExpr": "format(datum.value, '.2~s')"`. `--lint` rejects an opacity magnitude scale and any other
  hex list on a log colour scale. Never a light-to-dark ramp, never a stop like `#0B1628` or `#1D2A3A`.
- *Severity* (a second quantity on the same mark, as on the treemap and the rare-event scatter):
  `"range": ["#54B399", "#D6BF57", "#E7664C"]` (`SEVERITY_RAMP`) over `[0, RISK_MAX]` — mid-tones only,
  monotone in meaning. Text drawn over a severity fill uses `#1D1E24` on the yellow and orange stops.
- *Categories*: `PALETTE` in `panels.mjs` (`#54B399, #6092C0, #D36086, #9170B8, #CA8EAE, #D6BF57,
  #B9A888, #DA8B45, #AA6556, #E7664C`) — the same ten Lens draws breakdowns with, so a category
  pinned with `xy({ colors })` and the same category in Vega can match.
- *Categorical legends list the whole domain.* A legend whose entries come from the categories present
  (`values: indexof(pluck(data('rows'), …))`) changes with the window — 00's Signal vs noise lost *Infra
  health* at 1h while its help text said the entry stays. List the scale's domain, gated only on whether
  there are rows: `"values": {"expr": "length(data('rows')) ? ['Signal', …, 'Infra health'] : []"}`. An absent
  band then keeps its swatch and reads as zero. `--lint` rejects a legend `values` expression built from
  the rows present.
- Legends sit outside the plot (`"orient": "bottom"` or `"right"`), never `bottom-right` inside it.
- Rotated labels on a TOP axis use a positive `labelAngle` with `labelAlign: "right"`, so each ends at
  its own column and runs inward: a negative angle runs the last label off the panel's right edge,
  and no column count is safe from it (vega/04).

**Vega empty states.** A selection that matches nothing must read as empty, not as a broken chart. Every
spec says so in words — *No activity for this selection in this time range* (or *in the last 7 days*
on a fixed-window panel) — and hides whatever would print `NaN`, `undefined` or a key for nothing:
legends over an empty domain, decade axes, solid placeholder cells, a flat line on a degenerate scale.
- *Vega-Lite*: name the data source (`"data": {"name": "rows", …}`), put the message in
  `title.text` as an expression over `length(data('rows'))` (text marks are not themed), and give the
  legend and axes `titleOpacity` / `labelOpacity` / `symbolOpacity` / `domainOpacity` expressions.
  A fixed legend `values` list becomes `{"expr": "length(data('rows')) ? [1, 10, …] : []"}`.
- *Full Vega*: a signal such as `empty`, a centred `style: "guide-label"` text mark or the existing
  headline, and `opacity` on each legend part (`title`, `labels`, `symbols`, `gradient`) — opacity on
  the legend *group* does not reach its children.
- Verify by rendering with the Project control set to **Exclude** the only project: every panel is empty.

---

## Commands

```
./audit --ingest         Install the audit-scoped geoip pipeline, templates and client.* mappings
./audit --ingest-check   Assert enrichment is actually flowing on live data
./audit --lint           Execute every query in the repo — ES|QL and the DSL behind Vega specs — under a
                         time budget that cancels overruns; fails the build on any error
./audit --objects        Deploy the data view, 20 Vega visualizations and 11 Discover sessions
./audit --dashboards     Generate dashboards/*.json and deploy every dashboard
./audit --verify         Render every dashboard in Chromium and inspect for broken panels
                         AUDIT_VERIFY_THEME=light renders light mode (default: dark)
                         AUDIT_VERIFY_RANGE=now-1h sets the window (default: now-24h, the
                         dashboards' saved range); every range ends at now-1m, as theirs does
                         AUDIT_VERIFY_WIDTH=1440 narrows the viewport (default: 1920)
                         AUDIT_VERIFY_ONLY=00,07 renders only dashboards whose name contains one
./audit --perf <sub>     Time every query at production volume on a replica: seed | run | clean
./audit --queries        List ES|QL queries registered on the project, and whether each is still
                         scanning. Check it before trusting any timing
./audit --deploy         Full pipeline
./audit --demo-guide     Generate the presenter runbook from live data (--redact to mask identities)
./audit --clean <target> Tear down: dashboards | ingest | all
./audit --synth <sub>    Synthetic audit activity — see below
./audit <command> --with platform-volume
                         Include the opt-in Platform Volume dashboard (AUDIT_WITH=platform-volume)
```

### Optional dashboards

**Platform Volume (06) is not deployed by default.** The suite deploys seven dashboards; add the
unfiltered-firehose dashboard with `--with`:

```bash
./audit --dashboards --with platform-volume      # deploy eight, with its tab last on every nav bar
AUDIT_WITH=platform-volume ./audit --verify      # same set from the environment (or put it in .env)
```

`--with <name>` works on every command and adds to `AUDIT_WITH`, which can also be set in `.env` to
make the choice once for every command, so `--objects`, `--dashboards`, `--verify`, `--perf` and
`--lint` always agree on the set (`lib/suite.mjs` owns it). An unknown name fails the command. When
Platform Volume is left out there is no nav tab for it, no drilldown to it, and no text that mentions
it: the Command Center legend's "Platform Volume shows everything" and the two tooltips that
point at it appear only when it is deployed. The Vega spec it shares with Command Center (signal vs
noise) deploys either way.

`--dashboards` deploys exactly that set. A suite dashboard left by an earlier deploy and
not in this run's set is read and removed: Platform Volume after a deploy without `--with`, and
every retired id in `RETIRED_IDS` (`lib/suite.mjs`): Command Center's pre-1.0.2 `cloud-audit-00-command-center`
and the numbered `cloud-audit-<NN>-<name>` ids of 1.0.2, Platform Volume's included. `--clean dashboards`
removes them too. `dashboards/*.json` is written for the
set too, so the committed files are the default seven; a `--with` run (without `AUDIT_ID_NS`) adds
`dashboards/06-platform-volume.json` and the eighth nav link to the others.

`--lint` runs before every deploy and executes every query against the cluster with concrete
`?_tstart` / `?_tend` values, so the exact text that ships is proven to run first. That includes the
Elasticsearch DSL behind the fixed-window Vega specs, which it runs unfiltered — the expensive case —
and whose `format.property` path it checks resolves, because a typo there renders an empty panel that
nothing downstream can see. Each query runs through `es.esqlRun()` / `es.searchRun()`: async
submission with a budget, cancelled on overrun. Never use a synchronous `/_query` here — it outlives
a client that gives up, and serverless has no way to stop it. `--lint` also prints anything slower
than 5s, which is how a panel that passes today is noticed before it times out on a busier day.

Before any query runs, `--lint` checks structure offline: exact grid tessellation, fragment drift
between the Lens panels and the static ES|QL in Vega and Discover, and the Vega rules above — every
spec registered, DSL specs windowed, scoped and named, text marks readable in both themes. After the
queries it runs the prior-period *parity* check: each `PREV_TILES` tile's DSL and ES\|QL counts over the same
fixed window must be equal.

`--verify` exists because static checks cannot see a panel that renders empty, clipped or
mid-load. It screenshots every dashboard to a fresh timestamped directory under
`build/render-<stamp>-<theme>/` and **fails the build** on broken panels, raw-markup leakage, a
control bar that is not exactly `CONTROLS.length` wide, or a capture that never grew past the
viewport. Stuck loading states and panel counts are *recorded* in `report.json` but do not fail —
they are noisy on a healthy dashboard. `AUDIT_VERIFY_THEME=light` renders light mode; the Vega
specs are theme-aware and a dark-only verifier cannot see a regression in the other half.
`AUDIT_VERIFY_WIDTH=1440` renders at a laptop viewport, where Lens' fixed pixel column widths clip what
1920 does not (see *Presentation conventions*). The window defaults to the dashboards' own 24 hours;
`AUDIT_VERIFY_RANGE=now-1h` renders the sparse view an hour gives.
Three failures it was built to catch, all real:

- a selector-based check reported zero broken panels while every Vega chart displayed
  *"Visualization type not found."* — detection now reads rendered **text**;
- attaching the `ApiKey` header to *all* requests made Kibana's CDN reject lazily-loaded
  bundles, breaking exactly the code-split panels. The header is now scoped to the Kibana origin;
- every screenshot was silently one viewport tall, because Kibana scrolls an inner container so
  `document.body.scrollHeight` returns the viewport height and `fullPage: true` had nothing to
  grow into. Nothing below the fold had ever been looked at. It now measures
  `[data-test-subj="kbnChromeLayoutApplication"]`, re-measures after the lazy-mount walk, and
  fails rather than degrading quietly to one screen.

**Screenshots are written, not judged.** Open them.

### Performance

`--lint` times queries on the live stream, which holds only a few hours of events, so a 7-day panel
looks as cheap there as a 1-hour one. `./audit --perf seed` copies the live stream into a sibling
`-perf` data stream under the production template, re-stamped over 7 days. `./audit --perf run` then
times every dashboard query on it, one at a time and as a concurrent page load per dashboard. Windows
end at the newest replica document. Each run writes `build/perf-<stamp>/report.json`, and it warns
when ES|QL work is already resident on the dataset, because that load skews every timing.

Measured 2026-10-14 with `./audit --perf run --windows 1h,24h,7d` on a 2,625,300-event replica
(117 queries per window, 30s budget per query, quiet cluster):

| Window | Slowest query | Median query | Slowest dashboard load (all its queries at once) |
| --- | --- | --- | --- |
| 1h | 146ms | 33ms | 223ms (Actor 360) |
| 24h | 208ms | 43ms | 516ms (Platform Volume) |
| 7d | 642ms (Signal vs noise, vega/07) | 76ms | 3.2s (Platform Volume) |

Re-measured after the noise gate took in ES\|QL, field_caps, async-search and Kibana `/internal/`
internals (see *Noise gate* in [`esql/fragments.md`](esql/fragments.md)). The gated panels got cheaper
where they had the most signal to chew — the treemap 819ms → 309ms, *Identity first and last seen*
392ms → 159ms — and the band panels dearer: `BAND_KEYS` loads `url.original` and `saved_object.id` for
every event, so each band query on Platform Volume went from ~100ms to ~450ms at 7 days (Signal vs noise
294ms → 642ms), and that page's concurrent load from 1.9s to 3.2s.

Before the query-shape rewrites in [`esql/fragments.md`](esql/fragments.md), the 7-day Command
Center, Kibana Objects, Security Anomalies and Platform Volume loads each hit the 30s budget, and the
treemap alone took 30s at 24 hours. No query fails or is cancelled now. A new panel should be checked
with `--perf run --only <dashboard>` (a substring of the dashboard name, e.g. `07-actor`) before it ships.

---

## Synthetic activity and the test suite

A project nobody uses produces no audit events, and a dashboard over an empty stream proves nothing.
`--synth` drives **real API traffic** as a cast of personas so the platform itself emits audit events,
then proves each one landed and scores the way the dashboards say it should. It never indexes into the
audit stream.

```
./audit --synth run    [--only ids] [--no-verify] [--keep] [--timeout-min n]
./audit --synth loop   [--minutes n] [--only ids] [--demo]   continuous traffic; --demo compresses cadences so
                                                      every scenario recurs inside a 1h window
./audit --synth schema                                field drift: referenced fields vs the live stream
./audit --synth list                                  personas, scenarios, weights, cadence
./audit --synth clean  [--dry-run] [--only ids]       remove syn-* resources

npm test               unit + static schema contract (no network, no .env needed)
npm run test:it        live suite against the project in .env (AUDIT_IT_ONLY=<ids> to narrow)
```

**Personas** are Elasticsearch API keys (`syn-sre-maria.lopez`, `syn-contractor-alex.kim`, …), each with its
own role, minted per run with a 25h expiry and held only in memory. Serverless has no native realm and
inviting Cloud users sends real email, so a key per persona is the only way to get distinct identities.
**Scenarios** (`scripts/synth/scenarios/`, contract in `index.mjs`) cover every risk weight — 0, 10, 25,
30, 35, 40, 45, 50 — across Elasticsearch data access, security configuration, denials, anonymous and
bogus credentials, Kibana saved objects, and Kibana feature paths (rules, workflows, Agent Builder, SLOs,
connectors, maintenance windows, spaces).

**Verification** runs each expectation as ES|QL against the stream and scores the matches with
`panels.mjs`'s own `RISK`, so a test fails when the scorer and the data disagree — not a copy of the
scorer. Elasticsearch events are scoped to the run by `X-Opaque-Id` (`<runId>/<scenario>/<seq>`), which
the stream records; Kibana does not record it, so Kibana expectations scope by run-unique object ids.
Upper-bound claims (`risk`, `max`) are re-judged after a settle delay, because audit delivery takes
10–60s and a late event can break them.

**Safety.** Every created name starts with `syn-` and every delete passes `assertOwned()`. A full
`clean` also sweeps keys, roles, indices and spaces project-wide, which removes what a concurrent run is
using; `--only` and the integration suite clean only their own scenarios' leftovers.

What the suite cannot synthesise: a human SSO login (so `user.email` and `kibana.session.id`), real
geographic spread (one runner has one egress IP), and multi-day baselines (audit timestamps cannot be
backfilled — run `loop` for a week).

---

## Layout

```
audit                       Dependency-free CLI entry point
scripts/
  main.mjs                  Command dispatch
  ingest.mjs                Provisioning
  esql.mjs                  Query linter: ES|QL and Vega DSL, budgeted and timed
  queries.mjs               What is running on the cluster right now
  objects.mjs               Data view + Vega + Discover sessions -> _import (stable ids)
  dashboards.mjs            Generate, deploy, then apply Vega + control post-pass
  verify.mjs clean.mjs
  lib/
    panels.mjs              ES|QL fragments + panel builders
    definitions.mjs         Assembles the dashboards
    suite.mjs               Dashboard ids, nav order, the opt-in set (--with / AUDIT_WITH)
    dashboards/             One module per dashboard, plus shared.mjs
    layout.mjs              Offline structural checks (grid, fragment drift, Vega rules)
    drilldowns.mjs          Panel drilldowns, into and out of Actor 360
    controls.mjs            Control bar + its data view (import-only dashboard state)
    html.mjs                Presenter-guide markup and stylesheet
    env.mjs http.mjs log.mjs
dashboards/*.json           Generated definitions, committed for review
vega/*.json                 20 Vega specs (13 full Vega, 7 Vega-Lite); 14 and 15-prev-* are generated
searches/*.json             11 ES|QL Discover sessions (00 is every event, unfiltered)
ingest/*.json               Pipeline, templates, mappings
esql/fragments.md           Canonical query fragments
```

`dashboards/*.json` are generated by `scripts/lib/dashboards/*.mjs` and committed so panel
changes show up as readable diffs in review.

---

## Requirements

- Node.js ≥ 22 (`process.loadEnvFile`, and glob patterns in `node --test`)
- An Elastic Cloud Serverless project with Cloud audit logging enabled
- An API key with `manage_index_templates`, `manage_ingest_pipelines`, read on the audit data
  stream, and Kibana write access to the Default space
- `--verify` only: `npm install playwright && npx playwright install chromium`
