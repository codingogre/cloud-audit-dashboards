/**
 * Persona-scoped HTTP for the generator, plus the run ledger.
 *
 * Unlike lib/http.mjs this never throws on a status: a generator that makes a contractor attempt a
 * delete WANTS the 403. Each call declares what it expects (`ok`, `denied`, `absent`, `any`, or a
 * list of statuses) and the ledger records whether that held. A scenario whose calls did not do
 * what it intended is a generator bug, and verification refuses to blame the audit stream for it.
 *
 * So a response's `ok` means "matched what the call expected", NOT "2xx": a refused write that was
 * meant to be refused is ok:true. Read `status` when the HTTP result itself matters.
 *
 * Every request carries X-Opaque-Id `<runId>/<scenario>/<seq>`, so an audit event can be traced
 * back to the exact call that caused it whenever the stream records the header.
 *
 * The ledger holds no secrets: persona keys never leave process memory.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from '../lib/env.mjs';

const EXPECT = {
  ok: (s) => s >= 200 && s < 300,
  denied: (s) => s === 401 || s === 403,
  absent: (s) => s === 404 || s === 410,
  any: () => true,
};

export const matches = (expect, status) =>
  Array.isArray(expect) ? expect.includes(status) : (EXPECT[expect] || EXPECT.ok)(status);

export class Ledger {
  constructor(runId, { dir = join(ROOT, 'build', 'synth'), persist = true } = {}) {
    this.runId = runId;
    this.entries = [];
    this.file = persist ? join(dir, `${runId}.jsonl`) : null;
    if (this.file) mkdirSync(dir, { recursive: true });
  }
  add(e) {
    this.entries.push(e);
    if (this.file) appendFileSync(this.file, JSON.stringify(e) + '\n');
  }
  forScenario(id) { return this.entries.filter((e) => e.scenario === id); }
  unexpected() { return this.entries.filter((e) => !e.ok); }
}

/**
 * Retry policy. 429 means the request was refused before it ran, so it is retried for any method.
 * A transport fault or 502/503/504 may have happened AFTER the server acted, so only idempotent
 * methods retry on those — resending a POST could create a second rule, key or execution. A call
 * can opt in with `idempotent: true`. A status the call itself expects is never retried.
 */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const AFTER_EFFECT = new Set([502, 503, 504]);
const SECRET_KEYS = /^(api_key|encoded|password|token|access_token|refresh_token|secret)$/i;

/** Drop credential-bearing fields before anything is logged or persisted. */
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '<redacted>' : redact(x)]));
  return v;
}

export function makeClient({ persona, key, runId, scenario, ledger, seq = { n: 0 }, fetchImpl = fetch, retries = 3 }) {
  const auth = key ? { Authorization: `ApiKey ${key}` } : {};

  async function call(target, method, path, body, { expect = 'ok', space, headers = {}, version = '2023-10-31', note, idempotent } = {}) {
    const base = target === 'es' ? cfg.es : `${cfg.kibana}${space && space !== 'default' ? `/s/${space}` : ''}`;
    const opaque = `${runId}/${scenario}/${seq.round !== undefined ? `${seq.round}.` : ''}${++seq.n}`;
    const safeRetry = idempotent ?? IDEMPOTENT.has(method.toUpperCase());
    const h = { ...auth, 'X-Opaque-Id': opaque, ...headers };
    if (body !== undefined && body !== null) h['Content-Type'] ??= 'application/json';
    if (target === 'kb') { h['kbn-xsrf'] = 'true'; if (version) h['Elastic-Api-Version'] = version; }
    const payload = body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));

    let res, text = '', err;
    const t0 = new Date();
    for (let attempt = 0; attempt <= retries; attempt++) {
      err = undefined;
      try {
        res = await fetchImpl(`${base}${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60e3) });
        text = await res.text();
        const retryable = res.status === 429 || (safeRetry && AFTER_EFFECT.has(res.status));
        if (!retryable || (Array.isArray(expect) && expect.includes(res.status))) break;
      } catch (e) { err = e; if (!safeRetry) break; }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    const status = res ? res.status : 0;
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { _raw: text.slice(0, 2000) }; }
    const ok = !err && matches(expect, status);
    ledger?.add({
      ts: t0.toISOString(), run: runId, scenario, persona: persona || '<anonymous>', target, method,
      path: (space && space !== 'default' && target === 'kb' ? `/s/${space}` : '') + path,
      status, expect, ok, opaque, ...(note ? { note } : {}),
      ...(ok ? {} : { error: err ? String(err.message || err) : summarize(parsed) }),
    });
    return { status, ok, body: parsed };
  }

  return {
    persona,
    es: (method, path, body, opts) => call('es', method, path, body, opts),
    kb: (method, path, body, opts) => call('kb', method, path, body, opts),
  };
}

function summarize(raw) {
  const b = redact(raw);
  const m = b?.error?.reason || b?.error?.root_cause?.[0]?.reason || b?.message || b?.error || b?._raw || b;
  return (typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 300);
}
