/**
 * THE EVENTS VIEW (1.0.5.1): the one Elasticsearch object the suite deploys. An ES|QL view over the audit stream
 * with @timestamp renamed (EVENTS_VIEW_QUERY), which the prior-period tiles read so that Kibana attaches no hidden
 * time filter to them (panels.mjs, PREVIOUS-PERIOD TILES). Named per namespace (cfg.view): AUDIT_ID_NS=x deploys
 * `logs-cloud-audit-x-events-view` beside production's `logs-cloud-audit-events-view`.
 *
 * Privileges, measured on serverless with narrowed API keys (1.0.5.1). Views are index-level resources:
 *   create or replace   index privilege create_view on the view name (no read on the stream is needed to create)
 *   delete              delete_view
 *   read the definition read_view_metadata (requireView() below; it falls back to a query without it)
 *   all three           manage_view (or manage)
 *   query it            read on the view name AND on the stream — so does every dashboard viewer, or the
 *                       prior-period tiles show an error for them. The `logs-` name is why a viewer role on
 *                       `logs-*` already covers it (env.mjs, DEFAULT_VIEW)
 * No cluster privilege is involved: cluster `manage` alone could do none of it.
 */
import { cfg, RETIRED_VIEWS } from './env.mjs';
import { es } from './http.mjs';
import { EVENTS_VIEW_QUERY } from './panels.mjs';

const path = () => `/_query/view/${encodeURIComponent(cfg.view)}`;
const reason = (r) => r.body?.error?.root_cause?.[0]?.reason || r.body?.error?.reason || JSON.stringify(r.body).slice(0, 200);

/** Create or replace the view, then read it back. */
export async function putView() {
  const query = EVENTS_VIEW_QUERY();
  const r = await es.raw(path(), { method: 'PUT', body: { query } });
  if (!r.ok) {
    throw new Error(`could not create the ES|QL view ${cfg.view} (${r.status}: ${reason(r)}). `
      + `The API key needs the index privilege create_view (or manage_view) on ${cfg.view}; see README, Platform constraints`);
  }
  await requireView();
  return { name: cfg.view, query };
}

/**
 * Fails clearly when the view is missing or defined differently: without it every prior-period tile renders a
 * bare "Error", which a deploy would otherwise report as a success. Run before --dashboards and --verify.
 */
export async function requireView() {
  const r = await es.raw(path());
  const fix = 'run ./audit --objects (with the same AUDIT_ID_NS) first';
  if (r.status === 404) throw new Error(`the ES|QL view ${cfg.view} does not exist, so the prior-period tiles would show an error: ${fix}`);
  if (r.ok) {
    const v = (r.body.views || []).find((x) => x.name === cfg.view);
    if (!v) throw new Error(`the ES|QL view ${cfg.view} does not exist, so the prior-period tiles would show an error: ${fix}`);
    if (v.query !== EVENTS_VIEW_QUERY()) throw new Error(`the ES|QL view ${cfg.view} reads "${v.query}", not "${EVENTS_VIEW_QUERY()}": ${fix}`);
    return v;
  }
  // No read_view_metadata on this key: settle for proving the view answers a query.
  const q = await es.esqlRun(`FROM ${cfg.view} | LIMIT 0`, undefined, { budgetMs: 15e3 });
  if (!q.ok) throw new Error(`the ES|QL view ${cfg.view} cannot be read (${q.status}: ${reason(q)}): ${fix}`);
  return { name: cfg.view };
}

/** Delete the view; resolves to the status (404: it was not there). */
export async function deleteView() {
  const r = await es.raw(path(), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`could not delete the ES|QL view ${cfg.view} (${r.status}: ${reason(r)}); the key needs delete_view on it`);
  return r.status;
}

/** Delete the view names earlier builds used (env.mjs RETIRED_VIEWS); a 404 is "was not there". */
export async function deleteRetiredViews() {
  const out = [];
  for (const name of RETIRED_VIEWS()) {
    const r = await es.raw(`/_query/view/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(`could not delete the retired ES|QL view ${name} (${r.status}: ${reason(r)})`);
    out.push({ name, status: r.status });
  }
  return out;
}
