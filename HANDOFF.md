# HANDOFF

`CLAUDE.md`-style durable context lives in `README.md` and `esql/fragments.md` and wins on
conflict. This file is "where we are right now" and should be assumed stale.

## Next: 1.0.5.1 identity dropdowns, then 1.0.6 starter alert pack

- **1.0.5.1, first:** Discover session and Vega ids lose their numbers (`cloud-audit-search-all-events`,
  `cloud-audit-vega-actor-risk-treemap`). File names stay numbered; the leading `NN-` is stripped when the id is
  built, and the old numbered ids are deleted after the dashboards repoint (user request, 2026-10-23).
- **1.0.5.1:** dropdowns that make sense for "who acted". `user.email`, `user.name` and `api_key.name` change meaning by
  credential (for an Elasticsearch API key, `user.name` is the key's owner; a Cloud API key exists only as an id in
  `user.name`), so today's Person (email) and API key controls can't show every identity. Recommended: a query-time
  identity (one ES|QL CASE) driving ES|QL variable controls "Identity type" → "Identity", which Kibana 9.6 accepts as
  `pinned_panels` `esql_control` through the Dashboards API. The user still has to choose this over the ingest-time
  route. Full facts, probe results and the open questions are in the session handoff under `.sessions/` (local).
- **1.0.6:** five ES|QL alert rules shipped as code (failed-sign-in burst, success after failures, new key or role
  change, security change after hours, first-seen identity), built from the shared fragments.

## Release 1.0.5 — security-practitioner review fixes, 2026-10-23

Deployed to the Default space on 2026-10-23; the rc105 test copy was removed. Came out of the
security-practitioner review (136 use cases, 32 design holes): the fixes below are the eight the human
picked. Deferred: a starter alert pack (1.0.6 candidate) and an identity redesign — normalized
"who acted" dropdowns. An ES|QL-variable-control probe showed a runtime identity can drive dropdowns
(`pinned_panels` with `esql_control`, empty-selection guards, `COALESCE` for null identities), but
Discover sessions and DSL Vega don't read ES|QL variables, and filtering on a computed identity is slow
at 30 days unless pre-filtered on raw fields. Probe notes: `build/esqlctl-probe-1/` (local only).


- **The suite's own install no longer scores.** `SUITE_INSTALL` (a `cloud-audit-*` / `elastic_cloud-audit-*`
  object id with no `kibana.session.id`) is a new `RISK_KEYS` boolean, and `RISK` scores it 0 right after the
  failure branch (`suite_install, 0`): a denied write to a suite object still scores 40, a browser edit still
  25 / 30. Live, 24h: the deploy key's leaderboard total fell from about 5,430 to 900, now matching 00's
  treemap; 07's Risk tile and its receipts agree (1,180 = the five rows). It stays in `CHANGE_PRED`; 04's
  *Scoring events* tile shows *"excl. N suite installs"* (rendered at 1920 and 1440, no clipping). `SUITE_SELF`
  is now built from `SUITE_ID_TEST` but its text is byte-identical, so `NOISE` and its static copies did not
  move; vega/01 and vega/05 carry the new `RISK` / `RISK_KEYS` text. The space-delete cascade
  (`dashboard:cloud-audit-…:viewed:…`) stays scored on purpose. Also fixed: `synth/verify.mjs` ran `RISK` on
  raw events and had failed with *Unknown column [housekeeping]* since round 6; it now computes both keys
  first. `test/unit/esql-expr.mjs` is a small three-valued evaluator so unit tests score events with `RISK`.

- **Navigation and identity.** (a) Identity tables on 00, 02, 03 and 04 group on raw `user.name` (and
  `api_key.name` where a row has room) and show them as click-to-filter *Principal id* / *API key* columns
  (`PIN_*` in `shared.mjs`), so each drills into Actor 360; clicked in Playwright on `rc105` (04 leaderboard and
  01 Busiest API keys → Actor 360 with `user.name: _4KEO…` pinned, Risk 900 = the leaderboard row). Principal id
  is 250px where the 36-character `<unauthenticated-cloud-access-token>` can appear, 165px elsewhere; only the
  leaderboard, Config changes and 03's system-index table carry API key too (the rest did not fit 1440px).
  00 Busiest identities gave up Last seen and Actions; 02 Mutations now wraps; 03 Denied requests has none
  (`foldRest`). (b) Fourth control **API key** (`api_key.name`), third; all four `small` so they share one
  row at 1440. (c) Every intro links *All audit events* and *Raw signal feed* (`RAW_RECORDS`, `@search:` resolved
  by `introMd()` through `nsId()`, relative); clicked through to Discover. 02's intro is h=6 now (measured 25px
  under the text, like the rest). (d) 01 Busiest API keys groups raw: API key + *Key ID (Cloud) / creator* (full
  id), Kind dropped; 07 *Who this is* groups by email and principal id (placeholders left out), % of Events and
  Own API keys dropped for width. Rendered 24h at 1920 dark and 1440 light: no clipping in the changed tables.
  Not done: the optional treemap click-to-pin (vega/01).

- **Time.** (a) Every dashboard opens on the last 24 hours (`DEFAULT_FROM` in `panels.mjs`, still ending at
  `now-1m`); `--verify` defaults to the same window. The demo guide keeps its own `AUDIT_DEMO_WINDOW` (1h) and
  tells the presenter to set it. (b) **Prior-period tiles**: 00 Total / Failed events, 02 Kibana events, 03
  Elasticsearch events / ES|QL queries / Access denied are DSL Vega specs generated from `PREV_TILES`
  (`vega/15-prev-*.json`, written by `emit()` and `--objects`; a unit test fails when a file is stale). Each
  takes its own range from a 15-day lookback to `{"%timefilter%":"max"}` and splits events into prior and
  current with a script `range` aggregation over the picker's min/max; a `global` min of `@timestamp` gives
  *"no full prior 24h"* when the stream starts inside the prior window. `--lint` *parity* runs each tile's DSL
  and its ES|QL `WHERE` over the same fixed 14 days and fails on any difference (live: all six equal, from 856
  access denials to 2,983,456 events). Sizes and offsets match a Lens metric to the pixel at 1920 and 1440,
  both themes; the words are Kibana's subdued Vega text colour, a step softer than Lens (no theme-aware way
  round it: every Vega style gets that one colour, and `background` reads "transparent"). Lens cannot do
  this at all: **every Lens ES|QL request carries a hidden `@timestamp` filter for the picker's window**
  (recon `build/review-105/recon-time.md`; now in `panels.mjs` TIME BINDING and README *Platform
  constraints*). (c) **Audit data held** (00, under the legend; Audit volume grew to 16 rows beside the pair):
  days since the stream's first event, read live by a DSL min/max with no control-bar clauses
  (`WHOLE_STREAM_SPECS` in `layout.mjs` asserts that), and the retention `--objects` reads from
  `_data_stream/<stream>/_lifecycle` ("No retention limit set" here). (d) 07's `WHOLE_MINUTES` now starts at the
  first whole minute inside the range: the old `DATE_TRUNC(?_tstart)` start was cut back to `_tstart` by the
  hidden filter, so the start edge never was whole minutes.

- **Tooltips: two tiers, 40 words.** Every panel tooltip, as deployed, is at most 40 words (`TIP_MAX_WORDS`,
  `checkTips` in `layout.mjs`; `checkSearchTips` holds `searches/*.json` descriptions to the same), counting what a
  builder appends; `emit()` and `--lint` fail past it. They were up to 454 words. Rewritten from the review's
  proposals (`build/review-105/raw.json` *tips*, mapped in `recon-tips.md`) and re-checked against this release's
  changes (prior-period tiles, *Audit data held*, the Principal id columns, 07 *Who this is*, 02 *Editors*). Helpers:
  the opaque-key sentence (`OPAQUE_ID_NOTE`, 42 words on ~25 tooltips) and the empty-state sentence (`EMPTY.*.desc`)
  are no longer appended — the title carries the empty state, the legend and How to read blocks the Cloud-key form;
  `SCROLL_NOTE` is *"Scroll for more."*; `PREV_NOTE` is 15 words. `EDGE_NOTE`, `SIGNIN_WORDS`, `GATE_NOTE`,
  `SPACE_ID_NOTE`, `CLEANUP(_NOTE)`, `RACE_NOTE` and `PIN_NOTE(_ID)` are gone. Page-wide caveats moved into a
  **How to read this page** list per page (`intro.howTo`, ≤6 bullets; five per page, four on 06), now a collapsed
  section under the intro (next item). The detail went to README *Reading the panels* (new) and *Presentation conventions → Tooltips*. Vega
  descriptions shortened for the specs used as tooltips (04, 08–13). Hovered 31 tooltips in Playwright on 00, 02, 04,
  07 (and 06 on a throwaway `rc105pv`, since cleaned): full text shown, nothing cut.

- **How to read is a collapsed section, not part of the intro** (the human's decision: the list made every intro
  ~170px taller). `dash()` puts `intro.howTo` in a section titled *How to read this page*, collapsed, directly under
  the intro (`howToSection()` / `collapsible()` / `flatPanels()` in `panels.mjs`, SECTIONS): one full-width 9pt
  small-text panel of bullets (`small: true`, converted by the post-pass like an intro; `HOW_TO_ROWS(n)` = n+1, ~40px
  spare), no heading inside. Intros are back to h=6 (25px spare at both widths; 07 ~40). Authored panels start one row
  under the section header; ids before it did not move (intro, nav, then `sec-NN`, then its `md-NN`).
  API shape (probed, 9.6 serverless): a `panels` entry with no `type` — `{ id, title, collapsed, grid: { y }, panels }`;
  `payload()` emits it from the in-memory `{ section: true, grid: { x: 0, y, w: 48, h: 1 } }`. **Saved-object storage**
  (exported from `rc105`): inner panels stay in `panelsJSON` with `gridData.sectionId: "sec-NN"`, and the header is a
  separate `sections` attribute `[{ collapsed: true, gridData: { i, y }, title }]`; the _export → mutate → _import
  post-pass only rewrites `panelsJSON` / `controlGroupInput` / `references`, so it rides through, and `checkSections()`
  now reads the object back after `_import` and fails on a missing, open, retitled or orphaned section. `GET
  /api/dashboards` lists the section with `panels: []` once its panel is a legacy visualization (it omits every such
  panel, intros and Vega too) — expected. `layout.mjs` `checkSections`: header one full-width row, inner grid
  tessellated on its own, collapsed, non-empty, ids unique page-wide, How to read directly under the intro; every
  content check (tips, markdown, rows…) reads the flat list. `--verify` counts collapsed headers against the definition,
  captures `<id>.png` collapsed, clicks every header, re-checks broken text, and captures `<id>.open.png`; it now also
  fails on small-text overflow (`textSpare` = least room under any intro/How to read text). Rendered `rc105` 24h at
  1920 dark (`build/r105-sections-1920-dark-231921`, 01 re-run `build/r105-sections-1920-dark-01rerun-232820` after a
  transient network-suspend) and 1440 light (`build/r105-sections-1440-light-232929`), 06 on a throwaway `rc105pv`
  (`build/r105pv-06-233828-*`, since cleaned): sections=1/1 collapsed, opened, no overflow, nothing overlapping.

## Release 1.0.4 — ECS field names, null-safe API key fields, Default space, 2026-10-22

Product management's feedback on 1.0.3, plus two requests from the human.

- **ECS field names.** Every query, control, filter and Vega spec names fields bare (`event.action`,
  `user.email`, `service.name`), not by the OTel path (`attributes.event.action`,
  `resource.attributes.service.name`). `attributes` (priority 20) and `resource.attributes` (40) are
  passthrough objects, so results are identical; verified live. Untouched on purpose: the ingest
  pipeline (it reads the stored literal keys) and saved-object `attributes.panelsJSON` etc.
  `synth/fields.mjs` now scans bare ECS roots and treats `user.email` / `attributes.user.email` as one
  field, so the drift check still covers the dashboards.
- **API key fields no longer error on a fresh project.** `api_key.id` / `api_key.name` are mapped only
  after the first API-key event, so every panel naming them failed with *Unknown column* until then
  (the rename alone does not fix this: an unmapped field is unknown under both names). Every query that
  names `api_key.*` — 30 dashboard queries via `nullSafe()` in `panels.mjs`, all 11 searches, Vega 01,
  02, 04, 05, 06 — now starts with `SET unmapped_fields="nullify";`. Tested on Kibana 9.6 serverless
  before applying, each surface against a non-SET twin: Dashboards API, export/import, Lens metric /
  bar / xy / table, Vega ES|QL, Discover session panels, the Discover app (editor, histogram, field
  list, filter-for), controls, cell filters, drilldowns. All matched; a never-mapped column read as
  null where the twin showed the error. Only cosmetic catch: Discover's editor underlines a column with
  no mapping yet as a warning ("1 warning"); the query still runs. `esql.mjs` `collect()` accepts a
  leading `SET`, so `--lint` / `--perf` / the integration test still see all 102 queries (a unit test
  pins that SET appears on exactly the api_key queries).
- **Default space.** The suite installs into Kibana's Default space. `--space`, `scripts/space.mjs`,
  `ingest/space.json` and `AUDIT_SPACE` are gone; `cfg.kbs` is the bare Kibana URL. Private renders
  use `AUDIT_ID_NS` alone. The live `s_audit` space was emptied (31 suite objects deleted and confirmed
  404) and deleted; it held nothing else but Kibana's own managed `logs-*` / `metrics-*` data views and
  its settings object. A backup export was taken first (session scratchpad, not kept).
- **Data view id `elastic_cloud-audit-logs`** (the human's choice), replacing `cloud-audit-dv`.
  `--dashboards` deletes the retired id after every dashboard points at the new one; `--clean` too.
- **`--clean` actually deletes now.** It used `_bulk_delete`, which serverless refuses with 400 while the
  script reported success. It now deletes one object at a time through
  `content_management/rpc/delete` (`kb.deleteObject`), checking each status. The `search` and
  `index-pattern` content type ids, untested before, are verified.
- **New Discover session `[Audit] All audit events`** (`searches/00-all-events.json`): every event, no
  noise gate, newest 10,000 (Discover's ES|QL ceiling; verified it returns 10,000). Columns Time ·
  Identity · Source · Action · Outcome · Object · Client IP · Message, with Transport action, Object
  type, Space and Country in the field list. Explicit KEEP, because without it Discover lists both
  passthrough twins of every field.

Verified: 87 unit tests, `--lint` 102 ES|QL + 6 DSL, `--deploy` into Default, `--verify` at 24h (7
dashboards, 0 broken panels, 0 Vega errors, screenshots read), the new session rendered in Discover.

## Release 1.0.3 — unnumbered ids, customer intros, 2026-10-15

- **Dashboard ids drop their numbers** (the human's choice): `elastic_cloud-audit-<name>`, i.e.
  `elastic_cloud-audit-dashboard` (Command Center, unchanged), `-actor-360`, `-identity-access`, `-kibana-objects`,
  `-data-access`, `-security-anomalies`, `-geo-network`, `-platform-volume` (opt-in). Only dashboard ids changed:
  Vega (`cloud-audit-vega-*`), Discover (`cloud-audit-search-*`) and the data view keep theirs. `SUITE` in
  `lib/suite.mjs` owns them (`rawId()`, `dashId()`); modules and 07's outbound drilldowns read `rawId()`.
  Every numbered id (`cloud-audit-00-command-center` … `cloud-audit-07-actor-360`, 06 included) is in
  `RETIRED_IDS`, so `--dashboards` reads and deletes them and `--clean dashboards` covers them. With
  `AUDIT_ID_NS=x` ids are `elastic_cloud-audit-x-<name>`. `SUITE_SELF` / `SUITE_INSTALL_URL` already matched
  `elastic_cloud-audit-*`; a unit test now pins a namespaced and an un-namespaced new id.
  Proven on r103f: HEAD 6c604f4 deployed (6 numbered ids + Command Center), then this deploy removed all 6
  numbered ids and left exactly the 7 new ones. Playwright: 42/42 cross-dashboard nav links and 7/7
  drilldowns (01 → Actor 360, 05 ×3 → Actor 360, 07 → Security & Anomalies, Data Access, Geo & Network)
  land on the new id with the filter pill.
- **Customer intros** (approved copy, drafts 1–8): every dashboard opens with a full-width intro under the
  nav strip (`dash(…, { intro })`, `introMd()` in panels.mjs); Actor 360's orientation line and Platform
  Volume's "quarantine" note are replaced; Command Center's legend is draft 1b (`legendPanel()`), 11 rows
  now (13 left a 100px blank). Deviation from the brief: **a markdown panel's `<style>` block is dropped by
  9.6** (EuiMarkdownFormat sanitises HTML; no style element reaches the DOM, so `CSS_NAV` never styled the
  nav strip and is deleted). Small text therefore comes from the legacy markdown visualization's
  `fontSize`: intros are PUT as plain markdown and the post-pass swaps each for a by-value legacy markdown
  vis at 9pt (12px on an 18px line, 14px paragraph gap, 17px `###`). Heights measured at 1920 and 1440:
  h=6 everywhere, 02 h=7 (its last paragraph wraps at 1440). Draft 4's "*suite left out*" now reads
  "*noise gate applied*", the label 02's titles actually carry since round 5. Detail the old texts carried
  moved into tooltips: 05 Busiest client IPs (forwarded_ip vs source.ip), 06 All events (band sum),
  Auth success (`authentication_success`), Infra health (`cluster:monitor/main`, `elastic.maintenance`).
- **Small fixes:** 07's timeline title matches 02 (`· fixed last 24 hours, your time zone`); README's private
  example ids; searches/09 Time 215 → 208 and Space 100 → 80, so Message gets 248px at 1440 (was 221).
- **Skeptic (r103g):** 6c604f4 deployed from a temporary worktree (Command Center + 6 numbered ids), then HEAD:
  `--dashboards` removed all 6 numbered ids and the space held exactly the 7 new ones. Confirmed on the old
  deploy that `CSS_NAV` never reached the DOM (no matching style element; nav links in the theme colour), so
  dropping it loses nothing. Official `--verify` clean in dark 1h and light 24h at 1920 and 1440. Every intro
  and the legend measured in both themes at both widths: no scrollbar (no overflowing ancestor), 12px/18px
  body, 17px heading; spare space under the last line is the 25px padding except 07 and 02 at 1920 (~30px
  more, one grid row would scroll at 1440). Clicked 42/42 nav links and 7/7 drilldowns (menu shows "Open in
  …", lands on the new id with the filter pill). searches/09 at 1440: Time 208px holds the 194px date,
  Space 80px holds `s_audit`, nothing in either column truncated. Fixed: demo-guide's "the quarantine
  dashboard" now appears only when Platform Volume is deployed; `PUT /api/dashboards/…` examples in README,
  fragments.md and env.mjs name the new `elastic_cloud-audit-…` prefix.

## Release 1.0.3 — 1.0.2 merged under round 6, plus session filtering, 2026-10-15

- **Merge:** release-1.0.2 (7cfd933) merged into ui-polish. 1.0.2 wins on ids (`elastic_cloud-audit-dashboard`,
  `RETIRED_IDS`), nav order, Platform Volume opt-in, the 3-control bar and `drilldownRefs()`; round 6's
  API key read gate, cleanup score 0, `TIME_TO` now-1m, `FAILED_OR_DENIED`, `EDGE_NOTE` and 00's Lens
  time charts stand. `SUITE_SELF` matches both `cloud-audit-*` and `elastic_cloud-audit-*`. Generated
  `dashboards/*.json` re-emitted; no em dash in any markdown panel.
- **Session click (vega/13, on 07 and 02):** a click pins `session: <8 chars>…` (match_phrase on
  `attributes.kibana.session.id`) and zooms the picker to the session ±1 min; the zoom is sent from a
  Vega timer 0.7s/1.4s later (see README, *Vega panels filter too*). Shift-click still pins the email.
  Clicked in Playwright on r103: pill present, time range changed, records show one session only.
- **Skeptic (r103c):** vega/13 counted Kibana's space lookups (`space_get`, `space_find`) that searches/09 leaves out, so a
  clicked bar's tooltip said 1,019 events over 773 records and the spec's "exactly as in the session records below" was
  false. The spec now excludes them too; per-session counts match the records query exactly (773 / 1,609). Re-clicked
  B (07) and D (02) on the older session: pill, range zoomed, 773 rows of that session only; shift-click pins the email.
  Still open: at 1440, Session reconstruction's Message gets ~215px and cuts before `[id=…]` (expand the row to read it).
- **searches/09** shows the raw `attributes.kibana.session.id` (full id), so a dashboard cell offers
  Filter for/out (clicked: pill added, 1,000 → 845 rows, one session). No friendlier header exists in
  9.6: `grid.columns.<name>` accepts only `width`, and `fieldAttrs.customLabel` is ignored in ES|QL mode.
- **02** has the session timeline (full width, h=7) directly above Session reconstruction.
- **07 "System and hidden index reads"** opened no menu because its index column was assigned by an
  EVAL after `STATS BY family`; Kibana builds no filter from a query-time column. It is now the group key
  (INLINE STATS); clicked: "Apply filter to current view / Open in Elasticsearch Data Access".
  `layout.mjs` `checkClickFilters` fails any click-to-filter column the query assigns.

## Round 6 — the human's decisions, applied in shared code, 2026-10-15

Per-dashboard fixers apply these; rules in `README.md` → *Presentation conventions*, fragments in
`esql/fragments.md`.

- **API key metadata reads are query internals** (`API_KEY_READS` in `NOISE_ES_QUERY_INTERNALS`, so NOISE
  and BAND both): `cluster:admin/xpack/security/api_key/get` and `…/query`. Create, grant, update and
  invalidate stay signal. Action-based, no key named. 7-day replica: signal 333,360 → 309,810; every
  changed query within noise of before (alternating A/B, medians: gated count ~210ms, band charts
  0.65–0.8s, treemap ~310ms). Static copies re-synced: vega/01, vega/07, searches/06, searches/10.
- **Kibana's key clean-up scores 0** in `RISK` (first branch `housekeeping, 0`; `housekeeping =
  <HOUSEKEEPING>` is now a key of `RISK_KEYS`), so treemap, leaderboard, Why these identities scored, the
  scatter and Actor 360's Risk agree with Privileged ops / Config changes. 04's tooltips that explained the
  mismatch are reworded; its leaderboard's Privileged column is now `SUM(CASE(scc, n, 0))`. Static copies:
  vega/01, vega/05. demo-guide's risk query now counts first (`riskScored`).
- **Every saved range ends at `now-1m`** (`TIME_TO` in `dash()`); `--verify` and demo-guide links use it.
  `EDGE_NOTE` replaces 03's LIVE_EDGE, 04's LIVE_NOTE and 07's RACE_NOTE (the sub-second spread between
  panels' `now` is all that is left); "still filling" wording removed on 00 and 03; 07's receipt title no
  longer says "give or take". 06's QUIET_BUCKETS is unaffected (59-min / 1,439-min ranges pick the same
  1-minute / 30-minute spans).
- **`FAILED_OR_DENIED`, `SIGNIN_FAILED`, `SIGNIN_WORDS`** moved to `panels.mjs`; 04's Failures tile and Top
  failures table use it, so 04 Failures = 01 Failed or denied. Drift-pinned in searches/02.
- **LEGEND_MD**: no punctuation between two code chips; the noise sentence names API key lookups.
- Still open: naming the Cloud API key (label stays `_4KEO… · Cloud API key`), the Geo coverage
  denominator, and whether RISK should also drop realm_authentication_failed traces (still scored 40).

## Release 1.0.2 — product requests on top of 1.0.1, 2026-10-15

Round 6 follows as 1.0.3. Dashboard ids, nav order and the opt-in set now live in `scripts/lib/suite.mjs`.

- **Command Center's id is `elastic_cloud-audit-dashboard`** (the Cloud UI's *Log delivery* page links to
  it): `<kibana>/s/<space>/app/dashboards#/view/elastic_cloud-audit-dashboard`. The source stays
  `00-command-center.mjs/.json`; every other id is unchanged. `nsId()` namespaces it as
  `elastic_cloud-audit-<ns>-dashboard` and is now idempotent. `SUITE_SELF` / `SUITE_INSTALL_URL` also
  match `elastic_cloud-audit-*`, so views and installs of Command Center stay noise. `--dashboards` reads
  and removes the pre-1.0.2 `cloud-audit-00-command-center` from the space it deploys to.
- **Nav order:** Command Center, Actor 360, Identity & Access, Kibana Object Forensics, Elasticsearch
  Data Access, Security & Anomalies, Geo & Network, then Platform Volume when deployed.
- **No em dashes in markdown panels** (legend, 06 band note, 07 section headers). Titles, descriptions
  and other text were not changed. There is no lint rule; a unit test covers the markdown panels.
- **Platform Volume is opt-in:** `--with platform-volume` on any command, or `AUDIT_WITH=platform-volume`.
  Without it: no tab, no drilldown, and no legend or tooltip text that mentions it. `dashboards/*.json`
  is the default seven, and `--dashboards` removes a 06 left in the space.
- **Control bar is Project, Person (email), Client IP.** The Person (name) control
  (`attributes.user.full_name`, null for some identities) is gone; chaining stays HIERARCHICAL and
  `controlId()` is keyed on the field, so the remaining controls keep their ids and selections.
- **Drilldowns open their target again.** Through 1.0.1 every "Open in …" drilldown landed on an
  empty `#/create` dashboard (clicked in Playwright on production and on a private deploy): Kibana
  navigates by a `<panelIndex>:drilldown:DASHBOARD_TO_DASHBOARD_DRILLDOWN:<eventId>:dashboardId`
  reference, not the inline `dashboardId`. The post-pass now adds it (`drilldownRefs()`).
  Still open: on Actor 360, clicking a row of *System and hidden index reads* opens no menu at all,
  so its drilldown to Data Access cannot fire. That panel is unchanged since 1.0.1; left for 1.0.3.

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
after it led Command Center's Live signal feed. Reads of API key metadata (`security/api_key/get` and
`/query`) joined it in round 6 by the human's decision (12,595 a day live, nearly all the Cloud API key the
suite's tooling runs as); key create, grant, update and invalidate stay signal. How much the gate removes is a property of the stream, not of the
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
