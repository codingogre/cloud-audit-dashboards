# Cloud Audit Dashboards

Eight cross-linked Kibana dashboards over the Elastic Cloud Serverless audit stream
`logs-elastic_cloud.serverless_audit.otel-default`, built entirely from ES|QL and deployed as code
by a dependency-free Node CLI.

Everything here is version-controlled and idempotent: `./audit --deploy` is safe to re-run,
`PUT /api/dashboards/{id}` upserts against stable ids, and no dashboard is ever edited by hand.

```bash
cp .env.example .env      # fill in EC_URL, KB_URL, EC_API_KEY
./audit --deploy          # space -> ingest -> lint -> objects -> dashboards
./audit --verify          # render all 8 in Chromium and inspect for broken panels
```

---

## What the data actually is

Profiled against a live audit stream before a single panel was written. These facts drove every
design decision that follows.

| Fact | Consequence |
| --- | --- |
| One stream carries **two** audit sources: `serverless-elasticsearch` (named `elasticsearch-serverless` before the 2026 schema change) and `serverless-kibana` | Every panel states which source it reads. Kibana events are usually a small slice of the volume but carry nearly all of the forensic value. |
| `attributes.user.name` is a **numeric id** (`1234567890`), not a name | Every actor-facing panel resolves identity through `COALESCE(user.email, api_key.name, user.name)`. Without it the whole suite shows integers. |
| **A single high-volume API key can dominate the stream**, and Elasticsearch stamps that key's **creator** on every event it emits | A noise gate is ON by default everywhere except the Platform Volume dashboard. Actor-facing panels also carry the `api_key` column, so an automated workload is never mistaken for the person who minted its credential. |
| The gate's old `NOT (field IN (...))` form was **null for every Kibana event**, and `WHERE null` drops the row | Both halves are explicitly null-guarded. Before the fix the "Signal events" KPI excluded 100% of Kibana audit. |
| Composition depends on the workload, so no single noise class can be assumed to be the bulk — health checks (`cluster:monitor/main`), **search-phase internals** and transport **`connection_granted`** are all targeted | The gate and the volume bands share one vocabulary (`NOISE_ES_ACTIONS`, `NOISE_ES_QUERY_INTERNALS`, `NOISE_EVENT_ACTIONS`) so they cannot disagree. |
| Wide time windows once looked unservable — "2h, 3h and 4h all exceed 60s" | Those readings were taken back to back, and a synchronous ES\|QL query outlives the client that gave up on it and **cannot be cancelled** on serverless. Every query this repo runs now goes through a cancellable, budgeted call, and `--lint` reports its timings. What actually costs is query *shape* — see [`esql/fragments.md`](esql/fragments.md). Measured with `./audit --perf` on a 2.6M-event, 7-day replica, every panel query now returns in under 0.9s at 7 days and every dashboard loads in under 2.5s (see *Performance*). Dashboards still default to `now-1h` as the readable view of right now. |
| `attributes.source.ip` is the **internal proxy** (`100.64.x.x` CGNAT, `10.x.x.x` mesh) | All geography uses `attributes.network.forwarded_ip`, the real public client IP. Using the obvious field would place every user in the datacentre. |
| `attributes.event.category` / `.type` are **arrays** | `MV_EXPAND` before any `STATS ... BY`. |
| `attributes.event.type` is **single-valued on Kibana** but **multi-valued on Elasticsearch** (`access_granted` = `["access","allowed"]`), and ES\|QL returns **null, not false**, for `IN` on a multi-value operand | The "what changed" predicate selects on `event.type` and is therefore implicitly Kibana-only. It carries an explicit `service.name` test so that is visible rather than accidental, and it is fail-closed everywhere else. |
| Kibana populates `kibana.saved_object.{id,type,name}` **only on the saved-objects audit path** — workflows, agent-builder, ML, product docs and secrets populate none of them | Object identity is recovered from `body.text`, which is never null on a Kibana event. Before this, every such change rendered as a blank row. |
| Kibana logs an **attempt** (`outcome: unknown`, *"User is creating…"*) on the saved-objects path and a **completion** (`outcome: success`, *"User updated…"*) on the newer feature path | Change panels relabel `unknown` to "attempted" rather than showing it raw, which reads as a defect. |
| `attributes.elasticsearch.audit.security_config_change` is a **JSON string**, not an object | Rendered verbatim as text; its internals are never aggregated. |
| `body.text` carries pre-rendered prose, but **only on Kibana events** | Always paired with the `serverless-kibana` source filter. |
| Keys inside `attributes` are **literal dotted strings** (`attributes['network.forwarded_ip']`) | Ingest processors cannot reach them by dot-path; the geoip pipeline lifts the IP with a script processor. |
| Index mapping is `dynamic: false`, and a dynamic template maps `attributes.*` to `flattened` | Enriched fields must be explicitly mapped at the **top level** (`client.*`), not under `attributes.*`. |
| `attributes.http.request.body.size` / `response.body.size` are mapped but **never populated** | Byte-volume KPIs are impossible; Platform Volume uses distinct HTTP request ids and a signal-share percentage instead. |

Full fragment reference: [`esql/fragments.md`](esql/fragments.md).

---

## The dashboards

All eight carry a horizontal navigation bar pinned at the top, a default `now-1h` range,
auto-refresh off, and a hover tooltip on every panel explaining what it shows and how to read it.

| # | Dashboard | What it answers |
| --- | --- | --- |
| 00 | 🎛️ **Command Center** | Entry point. Six KPIs, volume by source, actor-risk treemap, signal-vs-noise stream, live signal feed. |
| 01 | 🔐 **Identity & Access** | Who authenticated, with which credential type, from where, and what failed. API key inventory with ownership. |
| 02 | 🗂️ **Kibana Object Forensics** | Every Kibana read and state change by type, name, space and actor. Changes are surfaced first, full width — they are rare and always worth reading individually. |
| 03 | 🔎 **Elasticsearch Data Access** | What data was read, by whom, through which transport action, including dot-prefixed system indices. |
| 04 | 🚨 **Security & Anomalies** | Mean severity (0–50) and a risk leaderboard, security config changes, rare/privileged operations, newly seen identities. |
| 05 | 🌍 **Geo & Network** | Real client geography, choropleth, impossible-travel detection, and proof that `source.ip` is the wrong field. |
| 06 | 📊 **Platform Volume** | The unfiltered firehose, quarantined so the rest stay readable. |
| 07 | 👤 **Actor 360** | One identity's whole footprint — pick a person in the control bar. **① Is this normal?** reads a fixed 7 days whatever the picker says: activity against their own hourly baseline, their rank among the week's 40 busiest identities, their weekly rhythm. **② What they did** follows the picker: a credential → space → object → operation flow, changes, reads, a map with travel lines, the risk receipts. **③ Evidence**: a 24-hour session timeline whose bars zoom the dashboard to that session, over the raw records. |

### The risk model

Severity weights, with routine activity scoring **0** on purpose:

| Event | Weight |
| --- | --- |
| `security_config_change` present | 50 |
| `invalidate_apikeys` | 45 |
| `event.outcome == "failure"` | 40 |
| `anonymous_access_denied` | 35 |
| destructive Kibana change (ECS `deletion`, plus `rule_disable`) | 30 |
| any other Kibana change | 25 |
| workflow execution (`run` / `test` / `execution_cancel`) | 10 |
| everything else | 0 |

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
destination with `drill`, which is kept on the in-memory definition and stripped from the API payload.

**Vega panels filter too.** On Actor 360, clicking a credential or a space in the flow, or
shift-clicking a session, pins it across the suite; clicking a session sets the dashboard's time
range to it. Double-clicking the flow clears every pill on the page.

**The control bar** — four option-list dropdowns on every dashboard, defined in
`scripts/lib/controls.mjs`:

| Control | Field | Why |
|---|---|---|
| Project | `attributes.project.name` | The serverless project that **emitted** the event. An audit project usually collects the audit streams of several projects; this narrows the whole dashboard — and, through hierarchical chaining, every dropdown after it — to one of them. Populated on every Elasticsearch and Kibana event. Names are not unique in Elastic Cloud, so projects that share a name share an option. **Actor 360's cohort rank follows Project and nothing else:** it ranks against everyone active in the projects the selection is active in, so a Person or Client IP selection highlights that identity instead of shrinking the cohort to one. Exact across all projects or within one; across several (not all) it sums events and takes each distinct count's per-project maximum, and its title says *approximate*. |
| Person (name) | `attributes.user.full_name` | Human-readable display names. **Null for some identities**, so it can never be the only identity control. |
| Person (email) | `attributes.user.email` | The reliable identity key — never null for a human. |
| Client IP | `client.ip` | Can hold more distinct addresses than anyone could eyeball, which is the point of a searchable dropdown. |

`attributes.user.name` is deliberately not offered — it is a numeric id, not a name.

Controls need a real data view, so `cloud-audit-dv` is deployed as an `index-pattern` saved
object; the Discover sessions keep their inline ad-hoc one. State shape was settled empirically
against 9.6.0 serverless (import a throwaway dashboard, export it back): control state is
**wrapped in `explicitInput`**, and the data view arrives by reference named
`controlGroup_<uuid>:optionsListDataView`.

**What "sticky across dashboards" actually means**, measured end to end in a browser: selecting
an identity scopes every panel, KPIs included, and clicking through the nav bar
carries the *filter* to the destination, where every panel is correctly scoped and a pill reads
`attributes.user.email: <identity>`. The destination's **dropdown itself reads "Any"** — control
selections live in dashboard app state, which `use_filters` does not carry. The numbers are
right everywhere; the widget does not re-display the selection. Read the pill, not the dropdown.

The older click-to-filter path still exists and needs neither:

- identity columns are `click_filter: true` on the **real** `attributes.user.email` field, never
  on the derived `actor` COALESCE, which has nothing behind it in `_source`;
- every ES|QL panel already carries `ignoreGlobalFilters: false` — Kibana materialises it itself
  as a Lens datasource-layer property (verified in a real `_export`: 11 of 11 ES|QL layers), so
  it is deliberately NOT emitted in the deploy payload, where the Zod-strict API would drop it;
  the 9.6 `esql` expression function compiles dashboard pills through `buildEsQuery` into the ES
  `filter` parameter;
- the nav bar's `dashboardLink`s carry `use_filters: true`.

So clicking an identity pins it, and it stays pinned across every dashboard. Verified at the
data layer: a `match_phrase` filter on `attributes.user.email` and a native ES|QL `WHERE` return
identical counts.

## Geo enrichment

`attributes.network.forwarded_ip` holds the real public client IP. An **audit-scoped**
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
| A Lens table prints a null cell as `-` (a clickable, underlined `-` in a click-to-filter column) and an empty string as `(blank)`; a column the query assigns — even `EVAL attributes.user.email = COALESCE(…)` — loses click-to-filter (*"relies on a field created at query time"*) | `blankNull()` blanks display columns only; a filter column keeps its nulls, or is dropped where they dominate |
| A pie's outside slice labels are dropped for small slices when the panel is short | `pie()` always draws a legend (`right`, size `l`), so every category is named somewhere |
| On an ES\|QL Vega spec, `"domain": {"%timefilter%": true}` renders the bare "Error" | Echo `?_tstart` / `?_tend` after the `STATS` and draw them as an invisible mark, so the axis spans the whole window (vega/07) |
| Metric items accept no per-item `color` | Styling lives at config root |
| `dashboardLink` targets must already exist | Dashboards deploy in two passes |
| Reporting API rejects `pngV2` / `printablePdfV2` | Verification drives Chromium directly |
| An ES\|QL Vega spec **always** follows the time picker — omitting `%timefield%` does not opt out | A panel that needs its own window (a 7-day baseline on a 1h dashboard) is a **DSL** Vega spec: `url.index` + `url.body` with an explicit `@timestamp` range and the `%dashboard_context-*%` placeholders keeps the control-bar filters and ignores the picker. Confirmed on a live dashboard |
| Two **unnamed** DSL datasets in one Vega spec cross their responses — the second gets nothing and the panel shows a bare "Error" | Every DSL dataset carries a unique `name`; `layout.mjs` fails the build otherwise. (Kibana's `es_query_parser` matches results by the result's index, not the request's) |
| Kibana themes axis, legend and title text, but **not text marks** — an unstyled text mark is `#000` on the dark theme | Full Vega text marks take `style: "guide-label"` / `"guide-title"`, which Kibana colours per theme. Vega-Lite `style` does not reach text marks at all; there, words go in a `title` whose `text` is an expression |
| `kibanaAddFilter(query, index)` resolves `index` by data view **title** | Pass `logs-elastic_cloud.serverless_audit.otel-default`; the id `cloud-audit-dv` renders *Index "cloud-audit-dv" not found* |
| External URLs are blocked in Vega on serverless | The basemap is Elastic Maps Service: `{"%type%": "emsfile", "name": "World Countries"}` with `format: {type: "topojson", feature: "data"}` — not `property: "features"`, which yields one useless row |
| Vega errors render inside the panel as `li.vgaVis__message--err`, often as a bare "Error" | `--verify` counts those elements in addition to reading text |
| Dashboards, visualizations, searches and data views are **multiple-isolated**: an id is unique across all spaces | With the suite deployed in one space, a second space's `PUT /api/dashboards/cloud-audit-…` is a 409 and `_import` silently re-ids the Vega and Discover objects. For a private render set `AUDIT_ID_NS` alongside `AUDIT_SPACE` (`AUDIT_SPACE=x AUDIT_ID_NS=x ./audit --objects`, then `--dashboards`, `--verify`) and every id becomes `cloud-audit-x-…` |
| `data_table` rows and metrics take `label` and `width` natively (stored as the Lens `customLabel` and column width) | `table()` titles every column and sizes it by role; see *Presentation conventions*. A label never changes the filtered field |
| An `xy` chart's legend defaults to `hidden`, even with a `breakdown_by` | `xy()` emits `config.legend` (`bottom` list by default when there is a split) and the `eui_amsterdam` palette; Kibana's `default` palette pairs each hue with a pale tint that vanishes on white |
| Markdown panels have no font-size setting, and `###` renders at ~20px | `md()` lifts a leading heading into the panel title; `layout.mjs` rejects `#`–`###` anywhere else |
| Discover in ES\|QL mode ignores the ad-hoc data view's `fieldAttrs.customLabel` | Session headers come from a trailing `RENAME` — see *Presentation conventions* for the filter trade-off |

---

## Presentation conventions

These dashboards are read by people who did not build them, in both themes, at several times
today's volume. Each rule below came out of a rendered review of every panel, and each is enforced
in shared code rather than at call sites.

**Lens tables — `table()` in `scripts/lib/panels.mjs`.**
- *Headers.* Name ES\|QL columns for the query (snake_case aliases, raw fields) and let `table()`
  title them: `COLUMNS` maps the suite vocabulary (`actor` → Identity, `last_seen` → Last seen,
  `attributes.user.email` → Email …) and anything unlisted is humanised. `sized(col, w, { label })` or
  `filterable(col, { label })` overrides. A label is a Lens custom label, so a click-to-filter column
  labelled "Email" still pins `attributes.user.email` — never alias a filter column in ES\|QL.
- *Widths are roles.* Dates, counts, IPs and short enums have fixed widths from `COLUMNS`, on metrics as
  well as rows; text columns flex and share the rest. Lens hard-clips a cell without an ellipsis, so
  width is the only defence. Give a text column `sized()` only to stop a sibling taking all the slack.
- *Narrow viewports.* A Lens width is absolute pixels, so `table()` budgets every table for a 1440px
  viewport (a w-column panel's grid is w × 1324/48 − 24px there). When the fixed widths leave a text
  column under 150px, they shrink toward their floors (dates never; counts to 72px, IPs to 118px; a `sized()` column
  to 70%, or its own `min`). A table that cannot give its text columns ~120px even at its floors is listed as
  an advisory by the layout check: it needs a wider panel or fewer columns. Render with
  `AUDIT_VERIFY_WIDTH=1440` to see it.
- *Visible rows.* Tables are compact density with one-line rows, and a trailing `| LIMIT n` is lowered
  to `fitRows(h)` (h=8 → 6, h=12 → 10, h=14 → 13) because a Lens table gives no cue that rows
  continue. Only a LIMIT that is the query's very last step is lowered, so per-row EVALs go before
  the SORT/LIMIT. `{ scroll: true }` keeps the LIMIT when the title promises a count; `{ wrap: true }`
  gives auto-height rows for a column whose whole value matters.
- *Empty cells.* A null prints as `-`. On a display column, end the query with `blankNull(col)` after
  the `STATS` and it prints nothing. Never on a click-to-filter column: Lens refuses to filter on any
  column the query assigns ("created at query time"), so a null there stays an underlined `-`. Where
  those dominate, drop the column (00's Busiest identities has no Email column for that reason).
- *Opaque identities.* An Identity that resolves to a bare id is a principal with no email or key name
  — usually an organisation-level Cloud API key. `table()` appends that explanation to the description
  of every table showing `actor`; Discover sessions with an Identity column say it themselves.

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

**Discover sessions — `searches/*.json`.** End the ES\|QL with `| RENAME field AS Header, …` after
every drift-checked fragment, list the new names in `columns` and `sort`, and put `@timestamp` first
(renamed `Time`). `grid.columns` sets widths; dates and IPs get one by default, and rows are one line
(`row_height` overrides). The trade-off, measured: on the embedded dashboard grid a renamed column
loses its filter-for/out cell actions, because no index field stands behind the new name; in the
Discover app filter-for still works — it appends `| WHERE \`Header\` == …`. The suite's pivots are
the control bar and the Lens click-to-filter columns, so sessions rename everything they show.
`layout.mjs` fails a session that lists a renamed column by its old name. Pattern:
`searches/10-raw-signal-feed.json`.

**Vega colour.** A spec cannot tell which theme it is in, so no colour may sit near either
background (dark panels are ~`#111C2C`, light are white).
- *Magnitude* (heatmap cells, matrix cells, bars whose colour repeats their length): one mid-tone
  hue on the mark, `"color": "#3987e5"`, and encode volume as **opacity**:
  `"opacity": {"field": …, "type": "quantitative", "scale": {"type": "log", "range": [0.35, 1]}}`
  (`symlog` only if zeros reach the chart, and never with `nice`). The 0.35 floor is what keeps the
  rarest cell ≥1.5:1 against both backgrounds — at the old 0.07 it was 1.1:1, invisible, and on the
  forensic panels the rare cell is the point. Legend: `"values"` at decades
  (`[1, 10, 100, 1000, 10000]`) with `"labelExpr": "format(datum.value, '~s')"`, filtered to the
  decades inside the data's range — a `10k` entry when nothing reached 10,000 is a false reading, and
  `tickCount` on a log scale draws one; symlog places default ticks linearly. Never a light-to-dark ramp, never a stop like `#0B1628` or `#1D2A3A`.
- *Severity* (a second quantity on the same mark, as on the treemap and the rare-event scatter):
  `"range": ["#54B399", "#D6BF57", "#E7664C"]` over `[0, RISK_MAX]` — mid-tones only, monotone in
  meaning. Text drawn over a severity fill uses `#1D1E24` on the yellow and orange stops.
- *Categories*: `PALETTE` in `panels.mjs` (`#54B399, #6092C0, #D36086, #9170B8, #CA8EAE, #D6BF57,
  #B9A888, #DA8B45, #AA6556, #E7664C`) — the same ten Lens draws breakdowns with, so a category
  pinned with `xy({ colors })` and the same category in Vega can match.
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
./audit --space          Create the Kibana space (default: audit; override with AUDIT_SPACE)
./audit --ingest         Install the audit-scoped geoip pipeline, templates and client.* mappings
./audit --ingest-check   Assert enrichment is actually flowing on live data
./audit --lint           Execute every query in the repo — ES|QL and the DSL behind Vega specs — under a
                         time budget that cancels overruns; fails the build on any error
./audit --objects        Deploy the data view, 13 Vega visualizations and 10 Discover sessions
./audit --dashboards     Generate dashboards/*.json and deploy every dashboard
./audit --verify         Render every dashboard in Chromium and inspect for broken panels
                         AUDIT_VERIFY_THEME=light renders light mode (default: dark)
                         AUDIT_VERIFY_RANGE=now-24h widens the window (default: now-1h)
                         AUDIT_VERIFY_WIDTH=1440 narrows the viewport (default: 1920)
./audit --perf <sub>     Time every query at production volume on a replica: seed | run | clean
./audit --queries        List ES|QL queries registered on the project, and whether each is still
                         scanning. Check it before trusting any timing
./audit --deploy         Full pipeline
./audit --demo-guide     Generate the presenter runbook from live data (--redact to mask identities)
./audit --clean <target> Tear down: dashboards | ingest | all
./audit --synth <sub>    Synthetic audit activity — see below
```

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
spec registered, DSL specs windowed, scoped and named, text marks readable in both themes.

`--verify` exists because static checks cannot see a panel that renders empty, clipped or
mid-load. It screenshots every dashboard to a fresh timestamped directory under
`build/render-<stamp>-<theme>/` and **fails the build** on broken panels, raw-markup leakage, a
control bar that is not exactly `CONTROLS.length` wide, or a capture that never grew past the
viewport. Stuck loading states and panel counts are *recorded* in `report.json` but do not fail —
they are noisy on a healthy dashboard. `AUDIT_VERIFY_THEME=light` renders light mode; the Vega
specs are theme-aware and a dark-only verifier cannot see a regression in the other half.
`AUDIT_VERIFY_WIDTH=1440` renders at a laptop viewport, where Lens' fixed pixel column widths clip what
1920 does not (see *Presentation conventions*), and `AUDIT_VERIFY_RANGE=now-24h` renders a populated
suite when synthetic traffic has been idle for the last hour.
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
| 1h | 139ms | 34ms | 237ms (Actor 360) |
| 24h | 197ms | 43ms | 547ms (Kibana Objects) |
| 7d | 819ms (Command Center treemap) | 73ms | 2.3s (Actor 360) |

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
                                                      every scenario recurs inside a 1h dashboard window
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
  space.mjs ingest.mjs      Provisioning
  esql.mjs                  Query linter: ES|QL and Vega DSL, budgeted and timed
  queries.mjs               What is running on the cluster right now
  objects.mjs               Data view + Vega + Discover sessions -> _import (stable ids)
  dashboards.mjs            Generate, deploy, then apply Vega + control post-pass
  verify.mjs clean.mjs
  lib/
    panels.mjs              ES|QL fragments + panel builders
    definitions.mjs         Assembles the dashboards
    dashboards/             One module per dashboard, plus shared.mjs
    layout.mjs              Offline structural checks (grid, fragment drift, Vega rules)
    drilldowns.mjs          Panel drilldowns, into and out of Actor 360
    controls.mjs            Control bar + its data view (import-only dashboard state)
    html.mjs                Presenter-guide markup and stylesheet
    env.mjs http.mjs log.mjs
dashboards/*.json           Generated definitions, committed for review
vega/*.json                 13 Vega specs (4 full Vega, 9 Vega-Lite)
searches/*.json             10 ES|QL Discover sessions
ingest/*.json               Pipeline, templates, mappings, space
esql/fragments.md           Canonical query fragments
```

`dashboards/*.json` are generated by `scripts/lib/dashboards/*.mjs` and committed so panel
changes show up as readable diffs in review.

---

## Requirements

- Node.js ≥ 22 (`process.loadEnvFile`, and glob patterns in `node --test`)
- An Elastic Cloud Serverless project with Cloud audit logging enabled
- An API key with `manage_index_templates`, `manage_ingest_pipelines`, read on the audit data
  stream, and Kibana write access to the target space
- `--verify` only: `npm install playwright && npx playwright install chromium`
