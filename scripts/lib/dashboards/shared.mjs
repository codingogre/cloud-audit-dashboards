/** Constants shared by more than one dashboard module. */
import {
  RISK, VERB, introMd, RISK_PREFILTER, RISK_KEYS, RISK_RESTORE, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_TYPE, OUTCOME,
  filterable
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
 * attributes.user.email field, which every ES|QL panel honours and the nav bar carries across
 * every dashboard — the path from any panel to what one actor actually did.
 *
 * Deliberately NOT aliased to a friendly name: Kibana builds the filter from the column's
 * underlying field, so the column has to BE the literal field. An alias, or the derived `actor`
 * COALESCE, has nothing behind it in _source and the pill would match nothing.
 */
export const WHO = filterable('attributes.user.email');

/**
 * The suite legend on Command Center, "How to read this suite" (16 columns beside Audit volume: ~560px wide
 * at 1920, ~410px at 1440), in the intro style (INTRO TEXT in panels.mjs, draft 1b of the 1.0.3 customer
 * copy): Kibana's own heading, then small text, one source line per paragraph. It says in the reader's words
 * what NOISE gates (panels.mjs) — health checks, query internals ("the background requests behind each
 * search and page load"), API key lookups (API_KEY_READS), bulk sign-in records and SUITE_SELF — so a change
 * to the gate changes this sentence too. The exact list in field names is the Signal events tooltip; the
 * identity order is on Busiest identities and Distinct actors; network.forwarded_ip against source.ip is on
 * Geo & Network's Busiest client IPs and Proxy vs real client IP.
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
  "**Each identity is named** by its email address, or the API key's name when there is no email, or a numeric user ID as a last resort.",
  '**Cloud API keys have no name** in the audit log, so they appear by the start of their ID, such as `_4KEO… · Cloud API key`.',
  "**Locations use the real client address,** not Elastic's own network hops. *Hover the ⓘ beside a panel title for details.*",
]);

/** The raw identity fields ACTOR_RESOLVE reads, for a STATS that has to resolve the actor afterwards. */
export const ACTOR_KEYS = 'attributes.user.email, attributes.api_key.name, attributes.user.name';

/**
 * The scoring events, counted before they are scored. RISK is a seven-branch CASE, and a CASE with
 * two or more conditions costs ~4µs per row however few branches match (panels.mjs, QUERY SHAPE),
 * so it runs on the rows of `STATS n = COUNT(*) BY <by>, RISK_KEYS` instead of on every event.
 *
 *   by    the extra group keys the panel needs downstream (ACTOR_KEYS, a BUCKET, …)
 *   aggs  extra per-group aggregates (`last_ts = MAX(@timestamp)`), re-aggregated downstream
 *
 * Every row it leaves carries `n`, so downstream a count is SUM(n), a severity is SUM(risk * n), and
 * a timestamp is MIN/MAX of the carried aggregate. A STATS with no BY returns null rather than 0 for
 * SUM over no rows, so a KPI that has to read 0 COALESCEs after it.
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
export const CHANGED_KEYS = 'attributes.event.action, attributes.kibana.saved_object.type';
export const CHANGED_DERIVE = `${VERB} | ${OBJ_TYPE}`;
