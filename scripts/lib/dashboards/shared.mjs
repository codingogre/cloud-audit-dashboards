/** Constants shared by more than one dashboard module. */
import { cfg } from '../env.mjs';
import {
  RISK, VERB, CSS_NAV, RISK_PREFILTER, CHANGE, OBJ, OUTCOME, filterable
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

export const LEGEND_MD = CSS_NAV + `
### How to read this suite

**Noise gate is ON** — health pings, query internals and bulk \`authentication_success\`
are excluded; how much that removes varies by workload. Unfiltered totals live on **📊 Platform Volume**.

**Identity is resolved** — \`user.name\` is a numeric id, so panels fall back
\`user.email\` → \`api_key.name\`.

**Client IPs are real** — \`source.ip\` is the proxy; geography comes from
\`network.forwarded_ip\`.

*Hover any panel title for detail.*`;

export const GEO_NOTE = `### 🌍 About this data

Geo is resolved **at ingest** by \`${cfg.pipeline}\`, which lifts
\`attributes.network.forwarded_ip\` to \`client.ip\` and resolves \`client.geo.*\`.

**Not \`source.ip\`** — that is the *internal proxy* (\`100.64.x.x\` CGNAT, \`10.x.x.x\` mesh),
never the real client.

**Forward-only** — events from before the pipeline was installed have no geo.`;

export const VOL_NOTE = `### 📊 The quarantine dashboard

Every other dashboard applies a **noise gate**. This one deliberately does not, so the
firehose stays measurable without drowning the forensic views.

- **\`infra-noise\`** — \`cluster:monitor/main\` + \`elastic.maintenance\` health traffic
- **\`query-noise\`** — search-phase internals, reader contexts, PITs, \`connection_granted\`
- **\`authn-volume\`** — bulk \`authentication_success\`, one per request
- **\`signal\`** — everything else: what the other dashboards read

Elasticsearch stamps an API key's **creator's** email on every event the key emits, so a busy
key's traffic resolves to a person's name on the identity panels — check the \`api_key\` column
before reading a name as a human.`;

export const RISK_SCORED = `${RISK_PREFILTER} | ${RISK} | WHERE risk > 0`;

/**
 * "What changed", as one pipeline. CHANGE selects state changes by ECS type, OBJ recovers the
 * object's identity from body.text where Kibana records no saved_object fields, and OUTCOME
 * relabels Kibana's `unknown` attempt records.
 *
 * `execution` is COALESCEd rather than left null so the column reads "—" on the rows that are not
 * executions instead of "(null)". It is truncated to 8 characters because Kibana sizes a column to
 * its widest value: at the full 36-character uuid the column held "—" on almost every row while
 * squeezing `name` into truncation. Eight hex characters is plenty to match a cancel row against
 * the run it cancelled by eye, which is the only thing this column is for — the full id is in the
 * session feed at the bottom of the page.
 */
export const CHANGED = `${CHANGE} | ${VERB} | ${OBJ} | ${OUTCOME} | EVAL execution = COALESCE(LEFT(g_exec, 8), "—")`;
