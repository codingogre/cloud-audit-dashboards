/**
 * List the ES|QL queries currently registered on the project, and whether each is still doing work.
 *
 * This exists because a query here does not stop when its client goes away, and nothing outside
 * the process that submitted it can stop it either: the ids GET /_query/queries returns are not
 * async ids (DELETE /_query/async/{id} and POST .../stop both answer 404 for every one of them), and
 * /_tasks/{id}/_cancel is not available on serverless. So there is no --kill.
 *
 * What it can tell you is whether the cluster is carrying abandoned work — the first thing to rule
 * out before believing any timing. An entry that has been registered for a long time is not
 * necessarily a load: two abandoned this way were still listed after 70 minutes with
 * documents_found 0, stalled rather than scanning. Hence the per-entry progress read below.
 *
 * Queries submitted through es.esqlRun() cancel themselves on overrun and carry a short keep_alive,
 * so anything long-lived listed here came from a synchronous /_query or an open Kibana dashboard.
 */
import { cfg } from './lib/env.mjs';
import { es } from './lib/http.mjs';
import { success, warn, detail, info } from './lib/log.mjs';

export async function run() {
  const { queries = {} } = await es.get('/_query/queries', { timeoutMs: 30e3 });
  const rows = [];
  for (const [id, q] of Object.entries(queries)) {
    // The list omits progress; the per-id view has it. Bounded, because a lookup can hang too.
    let docs = null;
    try { docs = (await es.get(`/_query/queries/${encodeURIComponent(id)}`, { timeoutMs: 10e3 })).documents_found ?? null; } catch { /* unknown */ }
    rows.push({ id, secs: q.running_time_nanos / 1e9, query: q.query || '', docs });
  }
  rows.sort((a, b) => b.secs - a.secs);
  if (!rows.length) { success('No ES|QL queries running'); return; }

  const ours = rows.filter((r) => r.query.includes(cfg.dataStream));
  info(`${rows.length} ES|QL quer${rows.length === 1 ? 'y' : 'ies'} registered, ${ours.length} on ${cfg.dataStream}`);
  for (const r of rows) {
    // ?_tstart/?_tend is the form Kibana panels send; NOW() is a script, a Discover tab or a person.
    const origin = /\?_tstart|\?_tend/.test(r.query) ? 'kibana panel' : 'script/console';
    const state = r.docs == null ? 'progress ?' : r.docs === 0 && r.secs >= 60 ? 'stalled' : `${r.docs.toLocaleString('en-US')} docs`;
    const line = `${r.secs.toFixed(0).padStart(6)}s  ${state.padEnd(14)} ${origin.padEnd(14)} ${r.query.replace(/\s+/g, ' ').slice(0, 96)}`;
    (r.secs >= 60 && state !== 'stalled' ? warn : detail)(line);
  }
  if (rows.some((r) => r.secs >= 60 && r.docs !== 0)) {
    warn('Long-running queries still scanning cannot be cancelled on serverless and will run to completion. '
      + 'Timings taken while they run are measuring them as well as the query under test.');
  }
}
