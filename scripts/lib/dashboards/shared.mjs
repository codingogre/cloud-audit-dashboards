/** Constants shared by more than one dashboard module. */
import {
  IDX, TIME, KIB, ACTOR_RESOLVE, RISK, VERB, introMd, RISK_PREFILTER, RISK_KEYS, RISK_RESTORE, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_TYPE, OUTCOME,
  filterable, table, sized, KIND_EVENT
} from '../panels.mjs';
import { isDeployed } from '../suite.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../env.mjs';

/**
 * The tooltip for a Vega panel is its spec's own description: one source, so they cannot disagree. A spec
 * shown on more than one page (13, the session timeline, on 02 and 07) words it for every page it is on.
 */
export const specDescription = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8')).description;

/**
 * The identity column, click-to-filter. Clicking a cell pins a filter pill on the real
 * user.email field, which every ES|QL panel honours and the nav bar carries across
 * every dashboard — the path from any panel to what one actor actually did.
 *
 * Deliberately NOT aliased to a friendly name: Kibana builds the filter from the column's
 * underlying field, so the column has to BE the literal field. An alias, or the derived `actor`
 * COALESCE, has nothing behind it in _source and the pill would match nothing.
 */
export const WHO = filterable('user.email');

/**
 * The suite legend on Command Center, "How to read this suite" (16 columns beside Audit volume: ~560px wide
 * at 1920, ~410px at 1440), in the intro style (INTRO TEXT in panels.mjs, draft 1b of the 1.0.3 customer
 * copy): Kibana's own heading, then small text, one source line per paragraph. It says in the reader's words
 * what NOISE gates (panels.mjs) — health checks, query internals ("the background requests behind each
 * search and page load"), API key lookups (API_KEY_READS), bulk sign-in records and SUITE_SELF — so a change
 * to the gate changes this sentence too, and the Signal events tooltip, which names the same five in plain
 * words. The exact list in field names, the identity order and network.forwarded_ip against source.ip are in
 * the README, Reading the panels.
 * Never put sentence punctuation between two code chips: round 5's "the numeric `user.name`. `_4KEO…`"
 * rendered as two chips joined by a stray period and read as if user.name were the Cloud key.
 * It no longer carries CSS_NAV: the 9.6 markdown panel drops a style block before render (it never styled
 * the strip), and the legacy renderer this panel becomes would print it as text (INTRO TEXT, panels.mjs).
 *
 * A function, because Platform Volume is opt-in (lib/suite.mjs): the pointer to its unfiltered totals
 * is there only when it is deployed, so the legend never names a dashboard the nav strip does not have.
 */
export const legendPanel = (x, y, w, h) => introMd(x, y, w, h, 'How to read this suite', [
  `**Routine traffic is left out** unless a panel title says *all traffic*. That covers health checks, the background requests behind each search and page load, API key lookups, bulk sign-in records, and these dashboards' own activity${
    isDeployed('06-platform-volume') ? '. **📊 Platform Volume** shows everything' : ''}.`,
  "**Each identity is named as in the Identity dropdown,** with its type beside it as a coloured badge; red is a failed sign-in.",
  '**Cloud API keys have no name**, so tables show the start of their ID, such as `_4KEO… · Cloud API key`. An Elasticsearch key used through Kibana reads *Unnamed key of* its owner.',
  "**Locations use the real client address,** not Elastic's own network hops. *Hover the ⓘ beside a panel title for details.*",
]);

/**
 * The intro sentence that links every dashboard to the raw events (1.0.5): the unfiltered "All audit events"
 * Discover session and the gated "Raw signal feed". introMd() resolves `@search:` (panels.mjs, discoverUrl).
 * Short on purpose: it shares a paragraph with other copy, and an intro paragraph stays on one line at
 * 1440px up to ~220 visible characters (INTRO TEXT).
 */
export const RAW_RECORDS = 'Raw records: [All audit events](@search:00-all-events), [Raw signal feed](@search:10-raw-signal-feed).';

/**
 * The How to read bullet for a page that shows identities (1.0.5.1): names in tables are the Identity dropdown's
 * values, a Cloud API key shortened (identityLabel, panels.mjs), and an ES|QL variable control's choice is not
 * carried by the nav links (README, Platform constraints). 00 and 01 say both at more length.
 */
export const IDENTITY_HOW_TO =
  'Identities read as in the Identity dropdown, a Cloud API key shortened to “_4KEO… · Cloud API key”, with the Identity type badge beside each. The dropdowns apply to this page only; the links above do not carry them.';

/** The raw identity fields ACTOR_RESOLVE reads, for a STATS that has to resolve the actor afterwards (panels.mjs). */
export { ACTOR_KEYS } from '../panels.mjs';

/**
 * CLICK-THROUGH TO ACTOR 360 FROM AN IDENTITY TABLE (1.0.5). Identity (`actor`) is the ACTOR_RESOLVE
 * COALESCE, computed in the query, so Lens builds no filter from it (checkClickFilters, layout.mjs) and a
 * table showing only Identity offered neither a pin nor the Identity 360 drilldown. These tables now also
 * group on the raw fields behind it and show them as two narrow click-to-filter columns:
 *
 *   API key        api_key.name — a named Elasticsearch API key
 *   Principal id   user.name — the authenticated principal: a Cloud API key's full 20-character id, a
 *                  service account, a person's numeric id
 *
 * Both are STATS BY group keys, never assigned, so the click reaches Lens as the real field and every such
 * table drills into Identity 360 (hasFilterableColumn, drilldowns.mjs). `actor` is a function of (email, key
 * name, user name), so the extra keys split a row only where one identity carries two principals.
 *
 * A Principal id pin is the principal, not the credential: on a Cloud API key it also matches the events of
 * every Elasticsearch API key that key minted, because Elasticsearch stamps the creator in user.name (the How to
 * read blocks of 00, 03 and 04 say so). `<anonymous>` has no user.name, so its row has nothing to pin.
 *
 * Widths, measured on a 1440px render: the longest principal the stream records is the placeholder
 * `<unauthenticated-cloud-access-token>` (36 characters, ~241px), so PIN_PRINCIPAL is 250px wide and keeps
 * 245 at 1440. Where no placeholder can appear — it never signs in, so it changes nothing and reads no index
 * — PIN_PRINCIPAL_SHORT is enough for a 20-character Cloud key id. Only where a row has room for both does
 * a table carry API key as well (PIN_COLS): it is mostly empty, and picking a named key in the Identity dropdown
 * narrows any page to it; without it a named key's row pins the identity that owns it (README, Reading the panels).
 *
 * Identity (`actor`) itself is the Identity dropdown's value (ACTOR_RESOLVE, 1.0.5.1), so these columns stay on
 * the raw fields: the dropdown is how a reader selects the shown identity, a cell click is how they pin a field.
 */
export const PIN_BY = 'api_key.name, user.name';
export const PIN_KEY = filterable('api_key.name', { label: 'API key', width: 150, min: 120 });
export const PIN_PRINCIPAL = filterable('user.name', { label: 'Principal id', width: 250, min: 245 });
export const PIN_PRINCIPAL_SHORT = filterable('user.name', { label: 'Principal id', width: 165, min: 160 });
export const PIN_COLS = [PIN_KEY, PIN_PRINCIPAL];

/**
 * The scoring events, counted before they are scored. RISK is a multi-branch CASE, and a CASE with
 * two or more conditions costs ~4µs per row however few branches match (panels.mjs, QUERY SHAPE),
 * so it runs on the rows of `STATS n = COUNT(*) BY <by>, RISK_KEYS` instead of on every event.
 *
 *   by    the extra group keys the panel needs downstream (ACTOR_KEYS, a BUCKET, …)
 *   aggs  extra per-group aggregates (`last_ts = MAX(@timestamp)`), re-aggregated downstream
 *
 * Every row it leaves carries `n`, so downstream a count is SUM(n), a severity is SUM(risk * n), and
 * a timestamp is MIN/MAX of the carried aggregate. A STATS with no BY returns null rather than 0 for
 * SUM over no rows, so a KPI that has to read 0 COALESCEs after it.
 *
 * `WHERE risk > 0` drops what RISK scores 0 on purpose — Kibana's key clean-up (`housekeeping`) and the
 * suite's own session-less install (`suite_install`), both keys of RISK_KEYS. 04's Scoring events tile
 * spells this pipeline out without that WHERE so it can count the install in its second line.
 */
export const riskScored = ({ by = '', aggs = '' } = {}) =>
  `${RISK_PREFILTER} | STATS n = COUNT(*)${aggs ? `, ${aggs}` : ''} BY ${by ? `${by}, ` : ''}${RISK_KEYS} ` +
  `| ${RISK_RESTORE} | ${RISK} | WHERE risk > 0`;

/**
 * "What changed", up to its first STATS. CHANGE selects state changes by ECS type, OBJ_GROK and
 * OBJ_NAME recover the object's name from body.text where Kibana records no saved_object fields, and
 * OUTCOME relabels Kibana's `unknown` attempt records (a one-condition CASE, which is cheap per event).
 * The object's type and the verb come after the STATS — see CHANGED_DERIVE.
 *
 * `execution` is COALESCEd rather than left null so the column reads "—" on the rows that are not
 * executions instead of "(null)". It is truncated to 8 characters because Kibana sizes a column to
 * its widest value: at the full 36-character uuid the column held "—" on almost every row while
 * squeezing `name` into truncation. Eight hex characters is plenty to match a cancel row against
 * the run it cancelled by eye, which is the only thing this column is for — the full id is in the
 * session feed at the bottom of the page.
 */
export const CHANGED = `${CHANGE} | ${OBJ_GROK} | ${OBJ_NAME} | ${OUTCOME} | EVAL execution = COALESCE(LEFT(g_exec, 8), "—")`;

/**
 * VERB and OBJ_TYPE are 16- and 10-branch CASEs over two raw fields, so they are not in CHANGED:
 * a change panel groups by CHANGED_KEYS first and applies CHANGED_DERIVE to the grouped rows, then
 * re-aggregates by verb/obj_type (SUM the counts, MAX the timestamps).
 */
export const CHANGED_KEYS = 'event.action, kibana.saved_object.type';
export const CHANGED_DERIVE = `${VERB} | ${OBJ_TYPE}`;

/**
 * SESSION RECORDS (02 Session reconstruction, 07 Session records): the Kibana events behind the session timeline
 * (vega/13), newest first, as a Lens table so the identity dropdowns narrow it (RECORD FEEDS, panels.mjs). The
 * logic of searches/09: events with a browser session, less what an open tab does on its own (paging, space
 * lookups, page and UI requests), so a tab left open adds no rows. A click on a Session cell pins
 * kibana.session.id, as a click on a timeline bar does; Space pins the space. Sorted and cut straight after the
 * filter (QUERY SHAPE rule 3), so VERB runs on the 1,000 rows kept.
 *
 * Object names what the row touched (1.0.5.4): "<type>: <title>", the id where Kibana recorded no title (a find
 * never carries one), and for a web request its path. Together with Operation that is everything Kibana's own
 * message said ("User has accessed dashboard [id=…]"), so the Message column went, for Identity type. Principal id
 * (1.0.7, PIN_PRINCIPAL_SHORT below) is the raw user.name, kept, so a click pins the identity or opens Identity 360.
 * Session (170px of a 44-character id still tells sessions apart; a click pins the whole id) and Identity (185px holds
 * an email of ~29 characters) gave it room, so Object keeps ~225px at a 1440px viewport.
 */
const SESSION_TAB_NOISE = 'event.action IN ("saved_object_open_point_in_time", "saved_object_close_point_in_time", "space_get", "space_find") ' +
  'OR (event.action == "http_request" AND (NOT body.text LIKE "*/api/*" OR body.text LIKE "*/api/ui_counters/*" OR body.text LIKE "*/api/content_management/*"))';
export const SESSION_RECORDS = `FROM ${IDX} | ${TIME} | ${KIB} | WHERE kibana.session.id IS NOT NULL | WHERE event.action IS NULL OR NOT (${SESSION_TAB_NOISE}) ` +
  `| SORT @timestamp DESC | LIMIT 1000 | ${ACTOR_RESOLVE} | ${KIND_EVENT} | ${VERB} ` +
  '| EVAL op = CASE(verb != "other", verb, COALESCE(REPLACE(event.action, "_", " "), "other")), ' +
  'object = CASE(kibana.saved_object.type IS NOT NULL, CONCAT(kibana.saved_object.type, ": ", COALESCE(kibana.saved_object.name, kibana.saved_object.id, "(no id)")), ' +
  'url.original IS NOT NULL, REPLACE(url.original, "^https?://[^/]+", ""), " ") ' +
  '| KEEP @timestamp, actor, identity_kind, user.name, kibana.session.id, op, object, kibana.space.id';
export const sessionRecords = (x, y, w, h, title, desc, opts = {}) => table(x, y, w, h, title, SESSION_RECORDS,
  [sized('actor', 185, { min: 175 }), PIN_PRINCIPAL_SHORT, filterable('kibana.session.id', { width: 170, min: 160 }), { column: 'op', label: 'Operation', width: 100 },
    { column: 'object', label: 'Object' }, filterable('kibana.space.id')],
  ['@timestamp'], desc, { scroll: true, ...opts });
