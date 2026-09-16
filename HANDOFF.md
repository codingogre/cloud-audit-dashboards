# HANDOFF

`CLAUDE.md`-style durable context lives in `README.md` and `esql/fragments.md` and wins on
conflict. This file is "where we are right now" and should be assumed stale.

## State — 2026-09-15

**Actor 360 was rebuilt** from a stack of tables into a page organised around three time regimes,
and the query harness was rebuilt underneath it after measuring why the suite's performance numbers
could not be trusted. Deployed to the `audit` space.

- `./audit --lint` passes: **111 ES|QL + 5 DSL queries**, grid clean across **131 panels**, every
  query budgeted and timed. It flags two pre-existing slow specs — see *Not done* below.
- `./audit --verify` final runs: **dark, all 8 clean**; **light, all clean except a `TRUNCATED` flag on
  Platform Volume** that is a false positive — the capture holds the whole page, but that dashboard is
  only ~1,433px tall and the heuristic fails anything it measures at ≤1400px (the viewport). It passed
  at 1433px in two other runs the same day. Not loosened here; a short dashboard needs a better test
  than "taller than the viewport", such as the last panel's bottom edge fitting inside the capture.
- Interactions exercised on the live Actor 360 page: a pinned identity scopes all six Vega panels with
  no errors; clicking a credential node in the flow pins `credential: cloud-saml-kibana`; clicking a
  session bar moves the time range from `now-24h` to that session ±1 minute; the three outbound
  drilldowns export with the right targets. Probe dashboards and visualizations used to establish the
  platform facts below were deleted afterwards.
- Actor 360 is 22 panels: a roster and four metric tiles with context lines, then
  **① Is this normal?** (fixed 7 days: baseline band, cohort rank, weekly punchcard), **② What they
  did** (follows the picker: credential → object flow, changes, index families, system reads, map with
  travel lines, addresses, risk receipts) and **③ Evidence** (24-hour session Gantt over the records).
- Six new Vega specs, `vega/08`–`13`. Four of them are **DSL** specs, the only kind that can hold
  its own window on a `now-1h` dashboard.
- `scripts/lib/definitions.mjs` is split into one module per dashboard under `scripts/lib/dashboards/`,
  built on a `row`/`stack` grid that makes a gap or an overlap unrepresentable. The other seven
  dashboards were proven byte-identical across the split.

### Things learned 2026-09-15 that would be expensive to learn again

**A synchronous ES|QL query outlives the client that gave up on it, and nothing can cancel it on
serverless.** Measured: a query abandoned by curl at 5s was still registered more than an hour later.
The ids `GET /_query/queries` lists are not async ids — `DELETE /_query/async/{id}` and `POST
…/stop` both answer 404 — and `/_tasks/{id}/_cancel` is `api_not_available`. Some abandoned entries go
on scanning; two stalled with `documents_found: 0` for 70+ minutes. While a batch of abandoned wide
queries was scanning, a plain `COUNT(*)` that normally takes 0.4s timed out at 40s. So:
**every query in this repo goes through `es.esqlRun()` / `es.searchRun()`** (async, short initial
wait so a cancellable id comes back at once, budgeted, `DELETE` on overrun — verified 1 → 0
resident), and `./audit --queries` shows what is registered and whether it is still scanning. Run it
before believing any timing.

**The old `now-1h` "cliff" was measured under the wrong conditions.** The block further down that
said 2h/3h/4h exceed 60s and 24h exceeds 110s was taken back to back, when an earlier timed-out
query could still have been sharing the cluster. On a quiet cluster the busiest-identities panel
returns in 221ms over a larger document set than any of the 2h–4h windows that had exceeded 60s.
What actually costs is query **shape** — see `esql/fragments.md` → *Query shape
decides cost*. The biggest single win measured: aggregate on raw fields first, apply
`CRED`/`VERB`/`OBJ_TYPE` to the grouped rows — the Actor 360 flow went 2,839ms → 145ms with identical
output, group for group.

**An ES|QL Vega spec always follows the time picker; a DSL spec only does if you ask.** In
`esql_query_parser.ts` omitting `%timefield%` does not opt out — Kibana looks the time field up and
ANDs the range. `es_query_parser.ts` applies it only when `%timefield%` is set. A DSL spec with an
explicit `@timestamp` range and the `%dashboard_context-*_clause%` placeholders keeps the control-bar
filters and ignores the picker — confirmed on a live dashboard (8 daily buckets on a 1h page, scoped
by an identity pill). It is also ~100x cheaper for an unfiltered weekly histogram: 0.9s vs a 90s
ES|QL timeout.

**Kibana crosses the responses of unnamed DSL datasets.** `es_query_parser.populateData` matches each
result against every request using the *result's* index, so with two unnamed datasets the second
response overwrites the first request and the second gets nothing: a bare "Error". Name every DSL
dataset uniquely; `layout.mjs` enforces it.

**Text marks are not themed.** Kibana sets theme colours for `guide-label`, `guide-title`,
`group-title` and `group-subtitle` styles and the axis lines — nothing else. An unstyled text mark
is `#000`, invisible on dark. Full Vega: `style: "guide-label"` (verified `#98A8C3` dark, `#516381`
light). Vega-Lite: `style` does not reach text marks (they stay black), but `title.text` accepts an
expression over a named dataset and *is* themed — that is how the cohort and map carry live readings.
`layout.mjs` rejects an unstyled text mark.

**Magnitude as opacity, not as a light-to-dark ramp.** A spec cannot tell which theme it is in, and a
light-to-dark ramp inverts salience in one of them — the busiest cell goes darkest and vanishes into
the dark background. One mid-tone hue with opacity carrying volume reads "more = stronger" on both.

**`kibanaAddFilter(query, index)` looks `index` up by data view *title*.** Pass
`logs-serverless.audit.otel-elastic_cloud`; the id `cloud-audit-dv` renders *Index "cloud-audit-dv" not
found*. Verified both ways on a throwaway dashboard.

**EMS works on serverless, but the file is TopoJSON.** `{"%type%": "emsfile", "name": "World
Countries"}` with `format: {type: "topojson", feature: "data"}` — `property: "features"` yields one
useless row and a blank map. Properties are `iso2`/`iso3`/`name`.

**A fat stroked path collapses a full-Vega spec to a sliver.** Under `autosize: fit`, a stroke's width
counts toward the scene bounds; a 180px ribbon reported bounds of −243..458 in a 290px panel and Vega
shrank `height` to 0. Draw sankey ribbons as filled bands. Found by rendering the spec headlessly with
real data rather than by redeploying — worth doing again for any full-Vega layout problem.

**Smaller Vega traps, each cost a render cycle:** `nice: true` on a `symlog` scale rounds the minimum
down linearly, straight to 0; symlog places ticks linearly, so give it decade `values` and format each
label yourself or 10 and 100 print as "0k"; a nested aggregation path (`last.value`) as a scale sort
field throws "Cannot read properties of undefined (reading 'value')" — flatten it in a formula first;
`LAST` is reserved in ES|QL, so `last = MAX(@timestamp)` is a parse error.

**`--verify` could not see most Vega failures.** A spec whose data fails shows a bare "Error" and a
wrong filter index shows *Index … not found*; neither matched its text patterns. Kibana renders both
as `li.vgaVis__message--err`, which `--verify` now counts as well — in addition to text, not instead.
It caught a real one (the Gantt's nested-path error) the first time it ran.

## State — 2026-09-11

Everything below is deployed to the `audit` space.

- 8 dashboards deployed, all rendering clean (`broken=0 loading=0 noData=0 styleLeak=false`)
- `./audit --lint` passes **111/111**, and now also prints `8 dashboards, 125 panels, grid clean`
- Presenter runbook: `./audit --demo-guide` → `build/demo-guide/DEMO-GUIDE.html`

### Shipped 2026-09-11 — "what changed" was lying, across the whole suite

The trigger was one panel: **"What they changed" on Actor 360 rendered `(null) (null)` rows.**
Root cause turned out to be suite-wide. Kibana populates
`attributes.kibana.saved_object.{id,type,name}` **only on the saved-objects audit path**; its newer
feature-level events populate none of them — workflows, agent-builder agents and tools, ML jobs and
datafeeds, product documentation, secrets — and `connector_create`, the `case_*` family and
`space_create` carry a type but no name. Every panel, search and Vega spec that described a change
grouped on those fields.

What changed, in one line each:

- **A shared `CHANGE` predicate** selects state changes by ECS `event.type` instead of by an
  action-name suffix. The suffix test missed `rule_enable`/`rule_disable` — someone silencing an
  alert rule was invisible everywhere in the suite — plus the whole `case_user_action_*` family and
  everything workflow/ML/agent-builder emits.
- **A shared `OBJ` fragment** recovers the object's type and name from `body.text` when
  `saved_object.*` is absent. Five GROK patterns, one per real message shape; `body.text` itself is
  last in the COALESCE ladder, which is what guarantees the column is never null.
- **Executions are in, and render meaningfully.** `workflow_run`/`_test`/`_execution_cancel` now
  appear with an `execution` column. A cancel carries only `[executionId=…]` — no workflow id at
  all — so the id is the only link back to the run that started it, and putting it in its own
  column is what lets an analyst tie the two rows together by eye. ES|QL has no self-join.
- **"What they changed" is full width**, and "What they read" with it (the only tidy way to free
  the row; both were truncating). Dashboard 02's Mutations panel got the same treatment.
- **`RISK` scores every object mutation**, not just `saved_object_*`. New tiers: destructive 30,
  other change 25, execution 10.
- **A committed structural checker** (`scripts/lib/layout.mjs`), wired into `--lint` and
  `--dashboards`. See below — it earned its keep immediately.

### Also shipped — filter by person, Actor 360, drilldowns, geo coverage

- **A control bar on every dashboard** — Person (name), Person (email), Client IP.
  A dropdown scopes the suite to a person without first finding a row to click; the earlier
  assumption that "the filter pill covers the same need" did not hold. See the
  Drill-down section of `README.md` for the full mechanism and its one caveat.
- **"Who reads which index" is now two rows tall** (`03-data-access`). At one row the index
  labels collided and the panel was unreadable. Panels below it were reflowed; there is an
  overlap check in the notes below.
- **Actor 360 shipped.** The eighth dashboard, and the one the control bar makes possible:
  pick a person and eleven panels become their footprint. It had been cut earlier on the
  grounds a filter pill covered the same need; it did not.
- **Drilldowns shipped.** "Open in Actor 360" on the four panels that carry a click-to-filter
  column. `enhancements.dynamicActions` survives `_import` verbatim on 9.6 serverless and
  `dashboardId` stays INLINE — no reference extraction, unlike the control group's data view.
- **The geo gap is closed on the dashboard.** A Geo coverage KPI, a resolution donut and a "Why
  client IPs do not resolve" CIDR breakdown. `client.geo_error` turned out to be never written and
  unwritable, so the permanently-null `lookup_error` column is gone.
- **`--verify` now captures the whole dashboard, runs in light mode, and reads console errors.**
  It previously captured only the top 1400px — see the landmine below.

## What to do first if you are picking this up

1. `./audit --lint` then `./audit --verify` — confirms the suite still deploys and renders.
   `--lint` now fails fast on panel geometry and on ES|QL fragment drift before it touches the
   cluster, so a red line there is structural, not a query error.
2. `AUDIT_VERIFY_THEME=light ./audit --verify` — light mode now passes the automated gates, but
   see the treemap landmine below: the gates cannot see a theme problem, only a broken panel.
3. `./audit --demo-guide` if you need current numbers. They drift within minutes — the signal share
   and even **the risk leaderboard's order**, which the guide prints as a table — so regenerate it
   shortly before running the walkthrough.

## Things I would not rediscover cheaply

**`event.type` is single-valued on Kibana and MULTI-valued on Elasticsearch, and ES|QL `IN`
returns null — not false — on a multi-value operand.** Measured: single-valued on every Kibana
event across a 7-day window; `access_granted` carries `["access","allowed"]`; the null behaviour
verified directly on multi-valued rows. So `event.type IN (...)` in a `WHERE` silently drops every
Elasticsearch row, and in a `CASE` the branch falls through. `CHANGE_PRED` is therefore implicitly
Kibana-only; it carries an explicit `service.name == "serverless-kibana"` test so that is visible
rather than accidental. This is the same null-trap family as the noise-gate bug below. **Do not
"simplify" that test away.**

**Two Discover sessions were running the OLD broken noise gate, and it went unnoticed.**
`searches/06-actor-first-seen` and `searches/10-raw-signal-feed` still carried the bare
`NOT (field IN (...))` form that the `NOISE` fragment was fixed for. Measured over one hour:
**every Kibana event was dropped — 0 survived**. `10-raw-signal-feed` is the "Live signal feed" on
the Command Center — the entry-point dashboard — so the headline feed had been showing zero Kibana
audit, which is the small slice of the stream carrying nearly all the forensic value. Found by the
fragment-drift check, not by looking.

**The correct noise gate is ~100x more expensive unbounded than the broken one.** Measured on the
raw-feed query with no time bound: broken gate 720ms, correct gate **>75s (times out)**, correct
gate at a 1h bound 627ms. The broken one was fast *because* it dropped every Kibana row through
cheap term filters; the correct one uses `LIKE` against a `flattened` field. Discover sessions
carry no time predicate of their own — Kibana applies the time picker — so **`--lint` now bounds
any query that has none**, which is how Kibana actually runs them. Without that the lint fails.

**`--lint` now runs a structural check before any network work**, and it is not optional garnish.
It found real drift the moment it was written: `RISK` had diverged in two Vega specs and `VERB` in a
third, because Vega specs and Discover sessions embed ES|QL as **literal text** and do not import
the fragments. A drifted Vega panel still renders — it is just computing something different from
the Lens panel beside it — so `--verify` provably cannot catch this. It also asserts every dashboard
is an exact grid tessellation (no overlaps AND no gaps, every row summing to 48), which is what the
panel-reflow landmine below used to need a throwaway script for.

**Kibana logs an attempt AND a completion, with different shapes.** The saved-objects path logs the
attempt (`outcome: unknown`, *"User **is** creating dashboard"*); the newer feature path logs the
outcome (`outcome: success`, *"User updated workflow"*). A raw `unknown` in a table reads as a
defect, so change panels relabel it to "attempted". A `failure` there is a change that was denied,
which the old panel could not show at all.

**~~The time range is a hard ceiling~~ — superseded, see the top of this file.** It
recorded "1h 0.8s; 2h/3h/4h >60s; 24h >110s" for panels that group by the COALESCE-resolved actor.
Those readings were real but not independent (a synchronous query outlives its client and cannot be
cancelled here). `scripts/demo-guide.mjs` still drives its narrative at `WINDOW` (1h) with an
`EVIDENCE_HOURS` (24h) window for selective queries, which remains a sensible split; only its
explanation of *why* was wrong.

**Null-safety is load-bearing in the noise gate.** `attributes.elasticsearch.audit.action` does
not exist on Kibana audit events, so a bare `NOT (field IN (...))` is null there and `WHERE
null` drops the row. That silently discarded 100% of Kibana audit — the small slice of the stream
carrying nearly all forensic value. Both halves of `NOISE` are explicitly null-guarded now. If
you ever add a predicate to that gate, guard it.

**CASE branch order decides which risk weight fires.** ES|QL `CASE` is first-match-wins.
Testing the generic predicates first made two documented weights dead code: `invalidate_apikeys`
always carries a `security_config_change` payload (scored 50, never 45) and
`anonymous_access_denied` always carries `outcome == "failure"` (scored 40, never 35).
Action-specific branches must stay above the generic ones.

**Elasticsearch stamps an API key's creator on every event the key emits.** Traffic authenticated
by a key carries both `user.email` = the person who created the key and
`authentication.type = api_key`, whichever client IP the request comes from. This is why
actor-facing panels carry an `api_key` column, and why the treemap labels machine tiles by the
**key** rather than by the key's owner — otherwise one identity renders twice, once as a person
and once as a machine credential.

**The suite's own queries land in the stream it measures.** Every request an analyst or `./audit`
makes to Elasticsearch is itself audited, so lint and verify runs, open dashboards and ad-hoc ES|QL
all add to the volume they measure. Exclude the identity or API key running the suite before taking
a volume baseline.

**`elastic.maintenance` is Elastic's platform automation, not tenant activity.** Exclude it with the
other platform actors (`WHERE actor_scope != "platform"`) before comparing a project's own activity
across time windows, or platform cadence will be counted as tenant work.

**Drilldowns and controls cannot go through `PUT /api/dashboards/{id}`.** It is Zod-strict and
silently drops both `controlGroupInput` and `enhancements.dynamicActions`; a GET→edit→PUT
round-trip additionally destroys every Vega panel (the API tells you so via
`warnings[].type: "dropped_panel"`). Anything richer than the REST schema needs the
`_import` post-pass that `repointVega()` already uses.

**What drill-down actually uses instead**, verified end to end in a browser: identity columns are
`click_filter: true` on the **real** `attributes.user.email` field (never the derived `actor`
COALESCE, which has nothing behind it in `_source`), Kibana materialises
`ignoreGlobalFilters: false` on each Lens ES|QL layer itself (camelCase — see the landmine below;
it is never emitted by this repo), and the nav links carry `use_filters: true`. Clicking an
identity pins a pill and it follows the analyst across every dashboard.

**`--verify` was blind below the fold at first.** Every PNG was exactly 1920x1400 —
the viewport — because Kibana scrolls an INNER container, so `document.body.scrollHeight` returns
the viewport height and `fullPage: true` captured one screen. The scroller is
`[data-test-subj="kbnChromeLayoutApplication"]`; `dashboardViewport` does not exist in 9.6.
`euiDataGrid__virtualized` must NOT be used for sizing — a virtualised table reports a
scrollHeight around 50,000px. The DOM-text counts (`broken`, `noData`) were always whole-page and
remained trustworthy; only the images were truncated.

**Controls need a real data view; ES|QL panels do not.** Every panel here is
`usesAdHocDataView: true`, so before this there was no `index-pattern` saved object at all.
`cloud-audit-dv` is now deployed by `--objects`, and `--dashboards` re-imports it defensively —
a control group whose data view reference dangles imports clean and then renders an empty
control bar, which is worse than failing.

**Control selections are NOT carried across dashboards; their filters are.** Measured end to
end: selecting an identity scopes every panel and the filter travels via the nav bar's
`use_filters: true`, landing as a pill on the destination — but the destination's dropdown reads
"Any", because control state lives in dashboard app state. The numbers are right everywhere.
Read the pill, not the dropdown.

**`ignoreGlobalFilters` is camelCase, materialised by Kibana, and must not be emitted.** It does
not appear in `dashboards/*.json` because that file is the pre-transform Dashboards-API payload.
In a real `_export` every ES|QL layer carries `"ignoreGlobalFilters": false` inside
`embeddableConfig.attributes.state.datasourceStates.textBased.layers.<id>`. It is a Lens
datasource property, not a panel option — adding it to the deploy payload would just be dropped.

**Panel reflow needs an overlap check — and now HAS one.** Growing the heatmap to two rows silently
collided with a Discover panel 15 units further down that was not visible in the same screenful of
source. `scripts/lib/layout.mjs` is now committed and runs in both `--lint` and `--dashboards`, so
this cannot recur silently. No more throwaway scripts.

**A carried pill and the destination's dropdown AND together, and can zero the dashboard.**
Navigating the nav bar carries the *filter* but not the control selection, so the destination shows
the pill while its dropdown reads "Any". Selecting a *different* identity there does not replace
the carried filter, it ANDs with it — and every panel goes to zero, which reads as a broken suite
rather than a filter conflict. Clear the pill before touching the destination's dropdown. This is
also why a stale pill from an earlier session is still worth checking for before trusting any
reading.

**~~The treemap is dark-only~~ — fixed since.** Its container is now transparent and its
ramp starts at `#4A6B85`. The near-black `#1D2A3A` anchor that note described now lives in
`vega/05-rare-event-scatter.json`, and `vega/02`/`03`/`04`/`06` share a six-stop ramp that is not
monotone in lightness, spans 133° of hue and starts at `#0B1628` (1.25:1 at its light end on white).
Not changed here — it is outside Actor 360 — but the Actor 360 specs show the alternative: opacity on
one mid-tone hue.

**Vega chrome must not be hardcoded.** All 7 specs used to set axis/title/legend colours for dark
mode, which rendered grey-on-white in Kibana light mode. Kibana supplies theme-aware defaults for
exactly those keys when a spec does not override them. Do not reintroduce them.

## Not done, deliberately

- **Two pre-existing Vega specs are slow**, surfaced by the new lint timings: `vega/05-rare-event-scatter`
  **13.3s** and `vega/01-actor-risk-treemap` **6.4s** at 1h. Both evaluate the `RISK` CASE and the actor
  COALESCE on every document before grouping; the aggregate-first rewrite should apply. Outside the
  Actor 360 scope of this change, so left for a follow-up.
- **The Actor 360 cohort panel costs ~4s when measured**, because it is deliberately unfiltered and
  needs two per-identity `cardinality` sub-aggregations over the whole week. Counting `terms` buckets
  instead was slower (~6s). Its cost tracks the number of documents in the 7-day window, so it rises
  and falls with stream volume rather than with anything in the spec.
- **No drilldown from "What they changed".** Its useful columns (`type`, `name`) are derived and a pill on
  them matches nothing; `space` is the only real field, and a drilldown on space alone was judged too
  weak to be worth it.
- **`./audit --clean dashboards` does not delete Vega specs, searches or the data view.** It calls
  `POST /api/saved_objects/_bulk_delete`, which serverless answers with 400 *"not available with the
  current configuration"*, and it does not check the status — so it reports success. Found while
  removing throwaway probe objects. What works, verified on 13 objects:
  `POST /s/<space>/api/content_management/rpc/delete` with
  `{"contentTypeId": "visualization", "id": "...", "version": 1}` and the headers `kbn-xsrf`,
  `x-elastic-internal-origin: kibana`, `elastic-api-version: 1`. Not changed here because `--clean` is
  destructive and a fix cannot be tested without tearing the deployment down; `search` and
  `index-pattern` content type ids are untested.
- **No transform.** The argument for one is retention, not speed — it only pays when a question looks
  further back than the audit data stream retains — and it needs a concrete long-horizon question
  before it earns a second implementation of the risk model.

- ~~**Actor 360 dashboard**~~ — shipped.
- ~~**`_import`-based drilldowns**~~ — shipped. `applyImportOnlyState()` in `scripts/dashboards.mjs`
  is a general export → mutate → import post-pass; `enhancements.dynamicActions` goes in at the
  same insertion point as `controlGroupInput`.
- **ES|QL `?actor` control variables** — superseded, not blocked. Person filtering is implemented
  with option-list controls instead, which emit *filters* rather than query variables and
  therefore never touch `PARAMS()` in `scripts/esql.mjs` — that blocker does not apply. The
  "unresolved unknown" is also resolved: control state is **wrapped in `explicitInput`**, proven by
  importing a throwaway dashboard and exporting it back (see `scripts/lib/controls.mjs`). Only
  revisit `?actor` variables if a control needs to rewrite the ES|QL text itself.
- ~~**Geo coverage gap**~~ — closed on the dashboard; see *Also shipped* above. A `forwarded_ip`
  that is itself private or CGNAT cannot be geo-resolved, and geoip writes no error for it, so Geo &
  Network shows coverage and a CIDR breakdown instead of an error column.

## The noise gate's share depends on the workload

**`NOISE`/`BAND` in `scripts/lib/panels.mjs` target connection housekeeping**
(`authentication_success` plus `GET /` → `cluster:monitor/main`), search-phase internals and
transport `connection_granted`. How much the gate removes is a property of the stream, not of the
gate, so the legend panel quotes no number; `--demo-guide` reads the share live. The vocabulary has
been validated against a limited set of workloads — revisit it when the bulk of a project's stream
is something else.

## Known gaps in "what changed" (Kibana-side, not ours to fix)

- **Fleet emits some events with no `event.action` at all** — *"User deploying policy [id=…]"*,
  *"User creating enrollment API key [name=…] [policy_id=…]"*. They are ECS-tagged `access`, so no
  action- or type-based predicate can class them as changes. `OBJ_TYPE` types them `unclassified`
  rather than null. Creating an enrollment API key is arguably a security-relevant change; if that
  matters to a deployment it has to be matched on `body.text`, which is fragile.
- **Kibana records the same alerting rule under two saved-object types**, `alert` and
  `alerting_rule`, depending on which code path audited it. A single rule edit can therefore produce
  two rows with different `type` values. Left faithful to the source and explained in the panel
  description rather than normalised away; the high-value-types allow-list on 02 carries both.
- **`rule_run_soon` and `secret_create` are ECS-tagged `access` despite being a change**, so they
  are added back to `CHANGE_PRED` by name. If Kibana adds more of these, the ECS predicate will not
  find them — check `STATS BY event.action, event.type` when something seems missing.
