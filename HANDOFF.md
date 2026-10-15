# HANDOFF

`CLAUDE.md`-style durable context lives in `README.md` and `esql/fragments.md` and wins on
conflict. This file is "where we are right now" and should be assumed stale.

## Round 5 — cross-cutting fixes from the round-4 production review, 2026-10-15

Shared code only; per-dashboard fixers apply the conventions. Rules in `README.md` → *Presentation
conventions*, fragments in `esql/fragments.md`.

- **Cuts are bounds, not counts.** `table()` appends "· top N at most" / "· newest N at most" (or "· N at
  most" after a title that already says Top/Latest/most recent); a bare "top 10", "latest 9", "the 30 most
  recent" throws at build and fails `--lint` on every panel type (`BARE_COUNT`, `BOUNDED`). A trailing LIMIT
  is SET to `fitRows(h)` (raised as well as lowered); `--lint` fails a non-scroll LIMIT that is not the rows
  that fit. "· scroll" and "(may be empty at 1h)" are banned from titles: `SCROLL_NOTE` goes in the
  description, and `{ empty: 'quiet' }` now reads "(empty when none in range)". "(empty = good)" and "(empty when …)" stay.
- **The suite's own install is noise** (`SUITE_SELF`, `SUITE_INSTALL_URL` inside `KIBANA_INTERNALS`): any
  event on a `cloud-audit-*` object with no Kibana browser session, the `_import`/`_export`/suite-id request
  lines, plus the page-load lookups (`config`/`config-global` get, `index-pattern` find). A browser edit
  of a suite dashboard stays signal; every change stays in `CHANGE_PRED`. No key id named. 7-day replica:
  gated count ~80 → ~95ms (signal 356,190 → 333,360); the BAND charts ~0.55 → ~0.75s (max 849ms).
- **`grouped(col)`** is in `panels.mjs`; every KPI secondary line uses it (`--lint` fails one that does
  not). `privilegedKpi()` prints "excl. 2,285 cleanups".
- **Categorical Vega legends list their whole domain** (vega/07 now always shows four bands); `--lint`
  rejects a legend `values` built with `indexof(pluck(data(…)))`.
- Open decisions left alone: naming the Cloud API key, gating api_key/get reads, risk scoring of the key
  cleanup, now-1m trimming, the Geo coverage denominator.

## Round 4 — cross-cutting fixes from the production review, 2026-10-15

Six causes behind most round-4 findings, fixed in shared code; rules in `README.md` → *Presentation
conventions*, fragments in `esql/fragments.md`. Facts behind them:

- **Hidden rows were not hidden.** Every deployed LIMIT already equals `fitRows(h)` (checked by GET on the
  production dashboards: 06's tables are LIMIT 10 at h=12, 07's scoring table LIMIT 8 at h=10); reviewers
  read the source LIMITs. Re-measured on a production render: rows start 57px below the panel top, and at
  h=12 ten 24px rows end 22px above the grid's bottom rule — the "blank strip" is that remainder. The real
  defect was a cut list whose title did not say so, so `table()` now appends "· top N" / "· latest N"
  (and "· scroll" where it holds more than it shows), and `--lint` enforces all three. Discover sessions
  are explicitly scrollable ("1,000 results" plus a scrollbar); their half-cut last row is a 27px row pitch
  against 28px grid units and cannot be snapped by panel height below h=24.
- **Empty-state words are conditions now** — "(empty = good)", "(may be empty at 1h)", "(empty when …)" —
  because Kibana 9.6 has no empty-only text and a title shows either way. `emptyOf()` throws on anything
  else; `--lint` rejects the old "· none is good" form.
- **Magnitude is a colour ramp** (`MAGNITUDE_RAMP`, teal → blue → purple → pink, log, domain fitted to the
  data) on vega/02, 03, 04, 06, 09 and 13. The opacity ramp was flat on dark. `--lint` rejects an opacity
  magnitude scale and any other hex list on a log colour scale.
- **`_4KEO… · Cloud API key`** is the one display form of an opaque Cloud API key id (`ACTOR_LABEL`,
  `cloudKeyLabel()`); `table()` applies it to every table showing `actor`, and every static session/spec
  that shows an identity embeds it (drift-pinned). The id is this repo's own tooling key: never gate it
  out or hardcode it; the human is still deciding how to NAME it, which is now a one-line change.
- **Page-load noise** is gated (`KIBANA_PLUMBING_URL` inside `KIBANA_INTERNALS`; static copies re-synced).
- **Privileged ops** leave out Kibana's own `invalidate_apikeys` (`PRIVILEGED`, `HOUSEKEEPING`,
  `privilegedKpi()`), applied on 00; 04's Config changes KPI and table still need it.

## UI polish — shared helpers, 2026-10-14

A rendered review of every panel found the same few causes behind most findings, all in shared code.
They are fixed centrally; the rules are in `README.md` → *Presentation conventions*. Facts behind
them, each verified on the live 9.6 project:

- **`data_table` takes `label` and `width` on rows and metrics natively** (export shows `customLabel`
  and the column width). The width post-pass in `dashboards.mjs` is gone. A label does not change the
  filtered field: clicking a labelled email cell pinned `attributes.user.email: …`.
- **Lens never ellipsises a clipped cell**, at any density or row height. Width by role is the remedy.
- **`config.legend` on `xy` defaults to hidden even with a breakdown.** `{visibility, position,
  layout: {type: list|grid}}`; `size` is only legal with left/right. A bottom list clips past ~6 series.
- **Discover in ES|QL mode ignores `fieldAttrs.customLabel`.** Headers come from `RENAME`. On the
  embedded grid a renamed column has no filter-for; in Discover itself filter-for appends a WHERE on
  the alias. `rowHeight`, `headerRowHeight` and `grid.columns.<name>.width` survive import verbatim.
- **Markdown has no font-size setting** (`settings` takes only `open_links_in_new_tab`); a markdown
  panel does take `title`/`description`.
- **Saved-object ids are global across spaces** for every type this suite deploys, so a second
  space needs `AUDIT_ID_NS`. Renders for this work: `AUDIT_SPACE=uifix-shared AUDIT_ID_NS=uifix-shared`.
  `scripts/perf.mjs` maps refs to files by the default `cloud-audit-` prefix and assumes it.

## Shared-file requests from the per-dashboard review, 2026-10-14

The eight per-dashboard fixers could not touch shared files; their requests are applied centrally.
Facts behind them, verified on the live 9.6 project (private space, read back with GET /api/dashboards):

- **`axis.y.title: {visible: true, text}` and `axis.y.scale: 'log'` survive the PUT** on an `xy` panel;
  `xy()` takes them as `yTitle` / `yScale`. **A pie takes `legend.size`, `styling.labels.position`,
  `styling.values.percent_decimals` and `group_by[].color` with a mapping** — `pie()` emits all four,
  so the local `keyed()` (01) and `geoPie()` (05) are gone.
- **A null click-filter cell renders as an underlined `-` link, `""` as an underlined `(blank)` link, and
  `" "` as an empty cell** — checked side by side on one panel. But blanking it means assigning the
  column in ES|QL, and Lens then refuses the filter on EVERY cell of that column: clicking a real email
  opened *"You can't apply a filter or drill down from this value because it relies on a field created
  at query time"* (rendered; the untouched column on 01 offered "Apply filter" and "Open in Actor 360").
  So `blankNull()` is for display columns only, and 00's Busiest identities lost its Email column
  instead (Identity already is the email wherever there is one). 04's Email columns keep their dashes.
- **Lens column widths are absolute pixels.** At a 1440px viewport the 48-column grid is 1316px (8px
  gutters) and a table's data grid is its panel less 16px. `table()` now budgets for that; the four
  tables that cannot give their text columns ~120px even at their floors are named by `--lint` as
  advisories (01 "Human identity footprint", 02 "Dashboards, SLOs and alert rules touched", 04
  "Identities by first appearance in range", 05 "Top client locations") — each needs a wider panel or
  fewer columns, which is a layout decision, not arithmetic.
- **Lens stack and legend order follow row order**, so every breakdown query ends with a SORT
  (`SOURCE_LABEL` sorts by source; 06's bands by an order column).
- **On an ES|QL Vega spec, `"domain": {"%timefilter%": true}` renders the bare "Error".** Echo
  `?_tstart`/`?_tend` after the STATS instead (vega/07). And on an ES|QL time chart size a bar to the
  bucket interval, never "until the next row": empty buckets have no row.
- **Lens drops a pie's outside label for a small slice on a short panel**, so a pie always has a legend.
- **Top-axis rotated labels:** a positive `labelAngle` with `labelAlign: "right"`; a negative angle runs
  the last label off the panel edge (vega/04). No other spec rotates top-axis labels.

Declined, with reasons, in the commit message of this change: extending the noise gate to ES|QL's own
fan-out (since done, with the perf pass — see *The noise gate's share depends on the workload*); naming Elasticsearch security actions inside the OBJ fragment; a `label` on `kpi()`
secondaries (unverified against the API); a lint check comparing `vega()` descriptions with spec
descriptions. `ACTOR_RESOLVE` is unchanged by decision: the opaque id stays, and every table, session
and Vega panel that shows it now says what it is.

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
query could still have been sharing the cluster. On the 2.6M-event perf replica the busiest-identities
panel returns in ~0.1s over 24h and ~0.3s over 7 days. What actually costs is query **shape** — see
`esql/fragments.md` → *Query shape decides cost*: a `CASE` with two or more conditions costs ~4µs per
row it runs on (the noise gate's negation, once blamed, is cheap). So every multi-branch fragment
(`RISK`, `BAND`, `VERB`, `OBJ_TYPE`, …) runs on rows already counted by the raw fields it reads, and
the output is identical: the Command Center treemap went 31s → 0.8s over 7 days, the Actor 360 flow
2,839ms → 145ms over 24h.

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
expression over a named dataset and *is* themed — that is how the maps carry live readings (the cohort is full Vega since 2026-10-14).
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
one mid-tone hue. The exact convention (hue, opacity floor, scale, legend) is now in `README.md` →
*Presentation conventions*; note the punchcard's own 0.07 floor is below it.

**Vega chrome must not be hardcoded.** All 7 specs used to set axis/title/legend colours for dark
mode, which rendered grey-on-white in Kibana light mode. Kibana supplies theme-aware defaults for
exactly those keys when a spec does not override them. Do not reintroduce them.

## Not done, deliberately

- **Two pre-existing Vega specs are slow**, surfaced by the new lint timings: `vega/05-rare-event-scatter`
  **13.3s** and `vega/01-actor-risk-treemap` **6.4s** at 1h. Both evaluate the `RISK` CASE and the actor
  COALESCE on every document before grouping; the aggregate-first rewrite should apply. Outside the
  Actor 360 scope of this change, so left for a follow-up.
- **The Actor 360 cohort panel's cost tracks the 7-day document count.** Its estate dataset is unfiltered
  and carries two per-identity `cardinality` sub-aggregations, once estate-wide and once per project.
  Re-measured 2026-10-14 on the 2.6M-document perf replica at 7 days: under 0.1s cold, and ~0.25s cold
  with high-cardinality stand-ins for project (52 values) and identity. The replica holds one project
  and one email identity, so the real per-project fan-out has not been measured at volume. The ~4s
  recorded here before (live stream, 2026-09-15) did not reproduce.
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
(`authentication_success` plus `GET /` → `cluster:monitor/main`), query internals and transport
`connection_granted`. Query internals took in ES|QL and all its sub-requests, `field_caps`,
`async_search`, index resolution, Kibana `/internal/` page requests and reads of the suite's own
`cloud-audit-*` objects (`KIBANA_INTERNALS`), because with many viewers their own panel queries were
the top "signal" (7-day replica: signal 1.54M → 0.38M of 2.6M). `BAND` now needs `BAND_KEYS`, which
groups a `kib_internal` boolean; band queries cost ~450ms at 7 days instead of ~100ms. `space_get` /
`space_find` and the dashboard app's `/api/content_management/rpc/{get,search,mget,bulkGet}` reads are
in it too (one per page load per viewer). The page-load plumbing (`/bootstrap.js`, `/app/<app>`, `/api/core`, `/api/licensing`, `/api/banners`,
`/api/ui_counters`, `/translations`, the `/api/spaces/space` list) joined it in round 4 (`KIBANA_PLUMBING_URL`),
after it led Command Center's Live signal feed. Still signal: `cluster:admin/xpack/security/api_key/get`
by the Cloud API key (9,230 a day, access_granted from an internal address) — a security read, left for
a decision rather than gated on a guess. How much the gate removes is a property of the stream, not of the
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
