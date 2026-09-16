/**
 * Thin fetch wrappers for Elasticsearch and Kibana.
 *
 * Everything authenticates with the same ApiKey. Kibana writes need kbn-xsrf, and the
 * Dashboards API is versioned, so those headers are applied centrally rather than at
 * each call site.
 */
import { cfg } from './env.mjs';

const auth = () => ({ Authorization: `ApiKey ${cfg.apiKey}` });

async function request(url, { method = 'GET', body, headers = {}, raw = false, timeoutMs } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...auth(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { _raw: text }; }
  if (raw) return { ok: res.ok, status: res.status, body: parsed };
  if (!res.ok) {
    const msg = parsed?.error?.reason || parsed?.message || parsed?.error || text.slice(0, 400);
    const err = new Error(`${method} ${url.replace(cfg.es, '').replace(cfg.kibana, '')} -> ${res.status}: ${
      typeof msg === 'string' ? msg.slice(0, 400) : JSON.stringify(msg).slice(0, 400)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export const es = {
  get:  (p, o)       => request(`${cfg.es}${p}`, o),
  put:  (p, body)    => request(`${cfg.es}${p}`, { method: 'PUT', body }),
  post: (p, body)    => request(`${cfg.es}${p}`, { method: 'POST', body }),
  del:  (p)          => request(`${cfg.es}${p}`, { method: 'DELETE' }),
  raw:  (p, o)       => request(`${cfg.es}${p}`, { ...o, raw: true }),
  /**
   * Run an ES|QL query under a time budget, and cancel it if the budget runs out.
   *
   * Never use the synchronous POST /_query for anything that might be slow. A query keeps
   * running on the cluster after its client disconnects, and serverless offers no
   * way to stop it: the ids GET /_query/queries lists are not cancellable (DELETE
   * /_query/async/{id} answers 404 for them), and /_tasks/{id}/_cancel is `api_not_available`.
   * Measured: a query abandoned by curl at 5s was still registered more than an hour later. Some
   * such entries go on scanning and some stall (GET /_query/queries/{id} shows documents_found), but
   * none can be stopped — and while a batch of abandoned wide queries was still scanning, a plain
   * COUNT(*) that normally takes 0.4s timed out at 40s. A linter firing 100+ queries through a
   * connection that can hang is how a cluster ends up measuring its own backlog.
   *
   * So: submit async with a short initial wait, which hands back a cancellable id straight away,
   * then poll inside the budget and DELETE on overrun (verified: 1 resident query -> 0). The only
   * handle that can cancel a query is the id in THIS response, so the submit must return
   * promptly — a submit that waited out the whole budget once hung past 60s on a loaded cluster
   * and stranded its query with no id to cancel. keep_alive is the backstop for exactly that case:
   * if this process dies mid-query, the cluster deletes the task when keep_alive lapses instead of
   * holding it for the 5-day default. Options go in the BODY; the query-string form is a 400.
   *
   * Returns { ok, status, body, ms, cancelled } and never throws on a query error.
   */
  async esqlRun(query, params, { budgetMs = 30000 } = {}) {
    const t0 = Date.now();
    const keepAlive = `${Math.max(60, Math.ceil(budgetMs / 1000) + 30)}s`;
    const body = { query, wait_for_completion_timeout: '1s', keep_on_completion: false, keep_alive: keepAlive };
    if (params) body.params = params;
    let res = await request(`${cfg.es}/_query/async`, { method: 'POST', body, raw: true, timeoutMs: 60e3 });
    let polled = false;
    while (res.ok && res.body?.is_running) {
      const id = encodeURIComponent(res.body.id);
      const left = budgetMs - (Date.now() - t0);
      if (left <= 0) {
        await request(`${cfg.es}/_query/async/${id}`, { method: 'DELETE', raw: true, timeoutMs: 30e3 });
        return { ok: false, status: 408, ms: Date.now() - t0, cancelled: true,
                 body: { error: { reason: `exceeded the ${budgetMs / 1000}s budget and was cancelled` } } };
      }
      const wait = Math.min(left, 5000);
      res = await request(`${cfg.es}/_query/async/${id}?wait_for_completion_timeout=${wait}ms&keep_alive=${keepAlive}`,
        { raw: true, timeoutMs: wait + 60e3 });
      polled = true;
      // A query that finished while we were polling leaves its result stored until keep_alive; tidy it.
      if (res.ok && !res.body?.is_running) await request(`${cfg.es}/_query/async/${id}`, { method: 'DELETE', raw: true, timeoutMs: 30e3 });
    }
    return { ...res, ms: Date.now() - t0, cancelled: false, polled };
  },
  /**
   * The DSL counterpart of esqlRun(), for Vega specs whose data source is `url.index` + `url.body`.
   * Same contract and the same reason: async search with a short initial wait so the id comes back
   * straight away, poll inside the budget, DELETE on overrun, keep_alive as the backstop. Returns
   * the plain search response as `body`, so a spec's `format.property` path resolves against it
   * exactly as Kibana resolves it.
   */
  async searchRun(index, searchBody, { budgetMs = 30000 } = {}) {
    const t0 = Date.now();
    const keepAlive = `${Math.max(60, Math.ceil(budgetMs / 1000) + 30)}s`;
    const qs = (wait) => `wait_for_completion_timeout=${wait}&keep_alive=${keepAlive}`;
    let res = await request(`${cfg.es}/${index}/_async_search?${qs('1s')}&keep_on_completion=false`,
      { method: 'POST', body: searchBody, raw: true, timeoutMs: 60e3 });
    while (res.ok && res.body?.is_running) {
      const id = encodeURIComponent(res.body.id);
      const left = budgetMs - (Date.now() - t0);
      if (left <= 0) {
        await request(`${cfg.es}/_async_search/${id}`, { method: 'DELETE', raw: true, timeoutMs: 30e3 });
        return { ok: false, status: 408, ms: Date.now() - t0, cancelled: true,
                 body: { error: { reason: `exceeded the ${budgetMs / 1000}s budget and was cancelled` } } };
      }
      const wait = Math.min(left, 5000);
      res = await request(`${cfg.es}/_async_search/${id}?${qs(`${wait}ms`)}`, { raw: true, timeoutMs: wait + 60e3 });
      if (res.ok && !res.body?.is_running) await request(`${cfg.es}/_async_search/${id}`, { method: 'DELETE', raw: true, timeoutMs: 30e3 });
    }
    const ms = Date.now() - t0;
    if (!res.ok) return { ...res, ms, cancelled: false };
    return { ok: true, status: res.status, ms, cancelled: false, body: res.body.response };
  },
  /** Throwing form of esqlRun(). Kibana injects ?_tstart/?_tend at runtime; supply them here. */
  async esql(query, params, opts) {
    const r = await es.esqlRun(query, params, opts);
    if (r.ok) return r.body;
    const reason = r.body?.error?.root_cause?.[0]?.reason || r.body?.error?.reason || JSON.stringify(r.body);
    const err = new Error(`ES|QL -> ${r.status}: ${String(reason).slice(0, 400)}`);
    Object.assign(err, { status: r.status, body: r.body, cancelled: r.cancelled });
    throw err;
  },
};

const KB_WRITE = { 'kbn-xsrf': 'true' };
const KB_API   = { 'Elastic-Api-Version': '2023-10-31' };

export const kb = {
  get:  (p, o)    => request(`${cfg.kibana}${p}`, o),
  post: (p, body) => request(`${cfg.kibana}${p}`, { method: 'POST', body, headers: KB_WRITE }),
  raw:  (p, o)    => request(`${cfg.kibana}${p}`, { ...o, raw: true, headers: { ...KB_WRITE, ...(o?.headers || {}) } }),
  /** Space-scoped helpers — everything this project deploys lives inside one space. */
  sGet:  (p, o)    => request(`${cfg.kbs}${p}`, { ...o, headers: { ...KB_API, ...(o?.headers || {}) } }),
  sPost: (p, body) => request(`${cfg.kbs}${p}`, { method: 'POST', body, headers: { ...KB_WRITE, ...KB_API } }),
  sPut:  (p, body) => request(`${cfg.kbs}${p}`, { method: 'PUT', body, headers: { ...KB_WRITE, ...KB_API } }),
  sDel:  (p)       => request(`${cfg.kbs}${p}`, { method: 'DELETE', headers: { ...KB_WRITE, ...KB_API } }),
  sRaw:  (p, o)    => request(`${cfg.kbs}${p}`, { ...o, raw: true, headers: { ...KB_WRITE, ...KB_API, ...(o?.headers || {}) } }),
  /**
   * Multipart ndjson import. The generic /api/saved_objects CRUD API is disabled on
   * serverless, so Vega visualizations and Discover sessions must go through _import.
   */
  async importObjects(objects, { overwrite = true } = {}) {
    const ndjson = objects.map((o) => JSON.stringify(o)).join('\n') + '\n';
    const form = new FormData();
    form.append('file', new Blob([ndjson], { type: 'application/ndjson' }), 'objects.ndjson');
    const res = await fetch(`${cfg.kbs}/api/saved_objects/_import?overwrite=${overwrite}`, {
      method: 'POST', headers: { ...auth(), 'kbn-xsrf': 'true' }, body: form,
    });
    const out = await res.json();
    if (!res.ok || out.success === false) {
      const errs = JSON.stringify(out.errors || out).slice(0, 500);
      throw new Error(`saved object import failed: ${errs}`);
    }
    return out;
  },
  async exportObjects(objects) {
    const res = await fetch(`${cfg.kbs}/api/saved_objects/_export`, {
      method: 'POST',
      headers: { ...auth(), 'kbn-xsrf': 'true', 'Content-Type': 'application/json' },
      body: JSON.stringify({ objects, excludeExportDetails: true }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`export failed: ${text.slice(0, 300)}`);
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  },
};
