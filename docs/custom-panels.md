# Custom panels (Kibana 9.6, tech preview) — evaluation

Kibana 9.6 adds **custom panels** (`custom_content` in the Dashboards API): an HTML + inline-CSS template
filled by **one** ES|QL query through Liquid, rendered in a sandboxed frame. This page records what they can
and cannot do, measured on a private deploy on 2026-11-06, which panels in the suite they would improve, and
what the Identity 360 prototype found.

Docs: <https://www.elastic.co/docs/explore-analyze/visualize/custom-panels>. Status: Serverless preview,
Stack "planned".

## How dynamic they can be without JavaScript

**What works**, all verified in a live render:

| Technique | Use |
|---|---|
| Hidden radios + `<label for>` + `:checked ~` | A real click-through stepper: tabs, Next/Back buttons, a progress bar that fills |
| `@keyframes`, `transition`, staggered `animation-delay` from `forloop` | Panes slide in, cards cascade, bars grow to their value |
| SVG `stroke-dashoffset` animation and SMIL `<animateMotion>` | "Marching" flow lines, dots that travel along a path; thickness and speed driven by the data |
| `:has()` | Hovering one row dims the others |
| `<details>` / `<summary>` | Expand a row to show more |
| Theme variables (`--cc-color-*`, `--cc-vis-0..9`, `--cc-motion-*`) | Correct in light and dark with no theme detection |
| Links to `/app/dashboards…` and `/app/discover…` | Navigate (Kibana adds `target=_top`) |

**What does not:**

- **No dashboard interaction.** A click cannot add a filter, set the time or open a drilldown, so the Vega
  flow's click-to-pin and every table's click-to-filter have no equivalent.
- **Links lose context.** They drop the time range, filters and dropdown selections. Every other link loses
  its `href`.
- **No recomputation.** Every row is rendered when the query returns; clicking only shows or hides what is
  already there.
- **One query.** Several result sets need `FORK` or the stage-expansion shape below.
- **Reduced motion.** Kibana switches animation off for viewers who ask for reduced motion, so a design must
  read correctly standing still. The prototype does.

## API and renderer facts (would be expensive to rediscover)

- Panel: `{ type: 'custom_content', config: { title, description, template, esql_query: [q], time_range? } }`.
  `esql_query` is an array of **at most one** string. Unknown config keys are **dropped silently**, not
  rejected, so a misspelled key deploys "successfully" and does nothing.
- It survives the suite's `_export → _import` post-pass unchanged.
- The query follows the time picker, filter pills and the four ES|QL controls. `SET unmapped_fields` and
  `FORK` work.
- **`last` is a reserved word in ES|QL** (`NULLS LAST`), and `SPLIT` takes only a single-byte delimiter.
- **Liquid runs inside `<style>`**, so a template can generate CSS rules from rows.
- **A `FORK` branch re-runs everything above it.** Seven branches cost seven times the base query (4.8s against
  ~0.8s at 7 days on the perf replica). Use one pipeline that MV_EXPANDs each row into the stages it feeds,
  then `STATS … BY stage, key`.
- **`<use>` is stripped**, so an SVG sprite renders blank.
- **Liquid HTML-escapes every `{{ }}` output**, so markup cannot be chosen at runtime by printing a string.
  The suite expands icons at build time instead (`<icon name>` / `<icon var>` in `scripts/lib/custom.mjs`).
- Without a query the template is not run through Liquid at all.
- Liquid's `where`, `map`, `sum` and `group_by` do not work on `rows`, because each column is a
  `{value, pct}` object. `if`/`case`, `forloop`, `split`, `slice`, `round` and arithmetic do.
- `.pct` is relative to the column's maximum across **all** rows, not per group, so shares are computed in
  the template from a total row.
- Inside one ES|QL `EVAL`, a later assignment saw an earlier one's input, not its output
  (`opens = COALESCE(opens, 0), v = opens + reads` gave null). Split it into two `EVAL`s.

## The prototype: Identity 360 drill-down

On Identity 360, directly below the Vega ribbon ("How they reached what they touched in Kibana"), so the two
can be compared. Source: `custom/11-identity-path.html`; query `IDENTITY_PATH` in
`scripts/lib/dashboards/07-actor-360.mjs`; labels in `LABELS` in `scripts/lib/custom.mjs`.

**Shape.** Five columns: Credential, Space, Object type, Operation, then Objects and the data Kibana read. Each
column shows only what is under the pick to its left, and the panel opens already drilled down the busiest path.
The breadcrumb steps back. A first version used separate summary steps that did not narrow; a four-lens review
(SOC analyst, visual design, data semantics, ES|QL cost) replaced it with this drill-down. Both versions are on
the branch history.

**Two measures, never added.**
- Kibana **actions**: opened, changed, ran, and **listed**. A listing counts once per search request, not once
  per object the search returned. One Fleet page load writes a find event for every tag on it, which is why a tag
  used to show "80 object events" and no data.
- Elasticsearch **data requests**: distinct requests Kibana sent that read documents (`READ_ACTIONS` in
  `panels.mjs`). Name and field lookups (`LOOKUP_ACTIONS`) are kept apart and shown as "names looked up".

**Where data attaches.** Every request Kibana sends to Elasticsearch carries
`x-opaque-id: <request id>;kibana:<kind>:<app>:<id>…`, naming the dashboard or app behind it. A read joins its
object on (credential, type, id). It takes the space the object was opened in and sits under **Opened** when the
object was opened in range. Otherwise it sits under **Read data** with "Not recorded" as the space: apps,
unsaved Discover, and objects opened before the range. The request id alone does not join them, because a
dashboard `get` and its panels' searches are separate requests.

**Risk carries up.** Failures (red) and Elastic system data sets (lock) are counted at every level. A risky child
is kept in the top 10 of its parent ahead of busier ones.

**How the no-JavaScript drill-down works.** One radio group per parent node, so each hidden group remembers its
own pick and choosing a different credential cascades to that credential's busiest path. Liquid writes one CSS
rule per node into `<style>`: `.ip:has(#n<ancestor>:checked)…:has(#n<node>:checked) :is(.g<node>,.b<node>)`.
That rule shows the node's children and its breadcrumb only while the node and all its ancestors are picked.
Node ids are MD5 prefixes of the path, computed in ES|QL. Items are styled with `input:checked + .bx`, not
`.it:has(:checked)`: with `:has()`, Chrome left a stale highlight on the item that had just been unchecked.

**Query.** Count first by raw fields with the request id as a key. Join objects by pack, group and unpack (an
`INLINE STATS` here cost about 450ms of 1.0s). Expand each fine row into the six levels it feeds, then take the
`TOP` 10 children per parent over a packed string and unpack. No FORK.

**Measured (2026-11-06):** about 0.15s over 24h live, and about 0.6s at 7 days on the 2.6M-event perf replica,
under the 0.7s budget. Identity 360 loads in 3.05s at 7 days, with this query no longer its slowest. Rendered and
inspected in dark and light, at 1440 and 1100px, and with reduced motion. Its animations are entrance-only and
come to rest on the final frame.

**Dropdowns:** the panel follows all four. Project, Identity type and Identity narrow every column. Client IP
narrows the Kibana actions but leaves no data requests, because Kibana's reads on a user's behalf carry Kibana's
own internal address (100.64.x.x), not the browser's. The panel says so when it happens. This is accepted as is.

**Differences from the ribbon, on purpose:** routine internals and the suite's own reads are left out, as on
Kibana Object Forensics, so the counts are lower than the ribbon's.

**Open decision:** replace the ribbon, or keep both. The ribbon keeps click-to-pin; the drill-down narrows,
explains each measure, and adds the data Kibana read.

## Where else they fit

Ranked by what they improve against what they lose. Interactivity listed is what the panel has today.

| # | Panel(s) | Why a custom panel is better | What is lost |
|---|---|---|---|
| 1 | **Identity 360 dossier**: Who this is + Events, Risk, Index families, Client IPs (07) | One card: type badge, principal, last seen, worst risk, countries | The Principal-id pin, which matters little because the dropdown already scopes the page |
| 2 | **Geo-resolution accounting** (05: six tiles + the resolution table) | A 100% partition bar with "where it shows" replaces a table that replaced a donut; already one query, no click columns | Nothing |
| 3 | **Security posture board** (04: six tiles) | Green/amber/red states, housekeeping notes as sentences, "all clear" when zero | Nothing; keep the config-changes table for its pins |
| 4 | **Band equation** (06: six tiles) | One `BAND` query, so All = Signal + Auth + Query internals + Infra adds up by construction | Nothing (06 is opt-in, so less reach) |
| 5 | **KPI strip with prior-period deltas** (00) | Replaces Vega look-alike tiles and their dark-mode probe with theme variables | Needs a check that the prior period still escapes the hidden time filter |
| 6 | **Live suite status** (00: the static legend + Audit data held) | Live signal share, newest event "Xm ago", identity types present | The whole-stream coverage part ignores the picker today; a custom panel follows it |
| 7 | **Risk weight ladder** (04 weights list, 07 receipts) | The static weights become a live ladder whose subtotals add up to the Risk tile | Keep the receipts table for its drill to 04 |
| 8 | **Access scorecards** (01, also 02 and 03 tile rows) | Real sentences instead of CASE-built detail lines ("1 human, used SSO, 3 new sign-ins") | Nothing |

**Next tier:** the working-rhythm punchcard and the 02/03/04 matrices as CSS grids. Vega already draws them
well and they have no clicks to lose.

**Not a fit:** the treemap (layout and identity pin), the session Gantt (zoom, pins, Back undo), maps (no EMS
fetch), every table with click-to-filter or Open in Discover, and the navigation strip (custom-panel links
drop the time and filters).
