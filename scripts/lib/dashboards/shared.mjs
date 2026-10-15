/** Constants shared by more than one dashboard module. */
import {
  RISK, VERB, CSS_NAV, RISK_PREFILTER, RISK_KEYS, RISK_RESTORE, CHANGE, OBJ_GROK, OBJ_NAME, OBJ_TYPE, OUTCOME,
  filterable
} from '../panels.mjs';

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
 * The suite legend on Command Center (16 columns: ~560px wide at 1920, ~410px at 1440, ~330px tall —
 * at 1440 a separate closing line for the hover hint fell below the panel edge, so it ends the last paragraph).
 * One source line per paragraph: Kibana's markdown renders a source newline as a line break, so a
 * hard-wrapped paragraph breaks mid-sentence wherever the source did. A code chip cannot break either,
 * so each paragraph ends on plain words — `authentication_success` used to land alone on a line of its
 * own. The first sentence states the exception, because three panels on that page read all traffic and
 * say so in their titles. The noise sentence names every class NOISE gates (panels.mjs), in the reader's
 * words — infra health, query internals, page loads and their lookups, bulk sign-in events
 * (connection_granted, authentication_success), and SUITE_SELF (the suite's views and its automated
 * install) — so a change to the gate changes this sentence too. It must leave the closing paragraph
 * visible at 1440px: round 5's longer version, with a code chip, pushed it under the panel edge.
 */
export const LEGEND_MD = CSS_NAV + `
### How to read this suite

**Noise gate is ON** unless a title says *all traffic*: health pings, query internals, page loads, bulk sign-in events and this suite's own views and installs are left out; unfiltered totals are on **📊 Platform Volume**.

**Identity is resolved** as email, then API key name, then the numeric \`user.name\`. \`_4KEO… · Cloud API key\` is an organization-level Cloud key, recorded by id only.

**Client IPs are real**: geography comes from \`network.forwarded_ip\`; \`source.ip\` is only the proxy. *Hover a panel title for detail.*`;

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
