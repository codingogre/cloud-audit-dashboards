/**
 * Proves a run landed: every expectation a scenario declares must match real audit events.
 *
 * An expectation is { name, where, min=1, max?, risk?, source?, persona?, unscoped?, kind='must'|'finding' }.
 * `where` is an ES|QL predicate over F.* paths. The verifier wraps it in the run's time window and,
 * when `risk` is set, scores the matches with the dashboards' own RISK constant from panels.mjs —
 * so these tests fail when the scorer and the stream disagree, not when a copy of the scorer does.
 *
 * `kind: 'finding'` marks platform behaviour that is plausible but unconfirmed (does Kibana audit
 * a 403? is the opaque id recorded?). A finding is reported either way and never fails the run;
 * once observed it should be promoted to 'must'.
 *
 * Audit delivery is asynchronous (10-60s observed), so unsatisfied expectations are re-polled until
 * `timeoutMs`. Satisfying a lower bound is final, but `risk` and `max` are claims about EVERY matching
 * event, and an event delivered after the first pass can break them — so once everything has passed,
 * the verifier waits `settleMs` and re-judges those. Without the settle pass, "every event this
 * scenario caused scores 0" passed on the first event to arrive and missed a 40 landing a poll later.
 */
import { es } from '../lib/http.mjs';
import { RISK } from '../lib/panels.mjs';
import { F, SOURCE, STREAM, lit } from './fields.mjs';
import { PERSONAS, newHire } from './personas.mjs';

const personaName = (id, runId) => (id === 'newHire' ? newHire(runId).name : PERSONAS[id]?.name);

/**
 * Elasticsearch records the caller's X-Opaque-Id, and the client stamps `<runId>/<scenario>/<seq>` on
 * every call, so an ES expectation is scoped to the exact scenario that should have caused it: two
 * runs sharing a project cannot satisfy each other's assertions. Kibana does not record the header,
 * so Kibana expectations scope by the object ids and names the run generated instead. Set
 * `unscoped: true` for an ES event that does not carry the header — notably every security config
 * change (put_role, delete_role, create_apikey, change_apikey, invalidate_apikeys) — and scope it
 * with a run-unique needle inside F.secChange instead, or it will match another run's events.
 */
export function buildQuery(exp, { from, to, runId, scenario }) {
  const where = [`@timestamp >= TO_DATETIME(${lit(from)}) AND @timestamp <= TO_DATETIME(${lit(to)})`];
  if (exp.source === 'es' && !exp.unscoped && scenario) {
    where.push(`MV_FIRST(${F.opaqueId}) LIKE ${lit(`${runId}/${scenario}/*`)}`);
  }
  if (exp.source) where.push(`${F.source} == ${lit(SOURCE[exp.source] || exp.source)}`);
  if (exp.persona) {
    const name = personaName(exp.persona, runId);
    if (!name) throw new Error(`expectation "${exp.name}" names unknown persona "${exp.persona}"`);
    where.push(`${F.keyName} == ${lit(name)}`);
  }
  where.push(`(${exp.where})`);
  return `FROM ${STREAM} | WHERE ${where.join(' AND ')} | ${RISK} | STATS n = COUNT(*) BY risk | SORT risk`;
}

/** Pure verdict over the risk-grouped rows, so the rules are unit-testable without a cluster. */
export function judge(exp, rows) {
  const n = rows.reduce((a, x) => a + x.n, 0);
  const risks = [...new Set(rows.map((x) => x.risk))];
  const min = exp.min ?? 1;
  const countOk = n >= min && (exp.max === undefined || n <= exp.max);
  // With no matching events a risk claim is vacuous: it holds only when the expectation allows zero.
  const riskOk = exp.risk === undefined || (n === 0 ? min === 0 : risks.length === 1 && risks[0] === exp.risk);
  const error = !countOk ? (n < min ? undefined : `n=${n} exceeds max ${exp.max}`)
    : !riskOk ? `scored ${risks.join('/')} not ${exp.risk}` : undefined;
  return { pass: countOk && riskOk, n, risks, ...(error ? { error } : {}) };
}

/**
 * One expectation against the stream. Never throws: a transport fault or a query error comes back
 * as an unsatisfied result marked `queryFailed`, which the poll loop simply retries.
 */
export async function evaluate(exp, win, { run = es.esqlRun, budgetMs = 30e3 } = {}) {
  let q;
  try { q = buildQuery(exp, win); } catch (e) { return { ...exp, pass: false, n: 0, error: e.message }; }
  let r;
  try { r = await run(q, undefined, { budgetMs }); }
  catch (e) { return { ...exp, pass: false, n: 0, queryFailed: true, error: `transport: ${e.message}`, query: q }; }
  if (!r.ok) {
    const reason = r.body?.error?.root_cause?.[0]?.reason || r.body?.error?.reason || `status ${r.status}`;
    return { ...exp, pass: false, n: 0, queryFailed: true, error: String(reason).slice(0, 300), query: q };
  }
  const { error: _drop, ...clean } = exp;
  return { ...clean, queryFailed: undefined, ...judge(exp, (r.body.values || []).map(([n, risk]) => ({ n, risk }))), query: q };
}

/**
 * Verify scenarios against a run. `scenarios` are scenario modules with their run facts attached
 * as `facts`. Returns one result per scenario: generator (ledger) health plus each expectation.
 */
export async function verify(scenarios, { runId, from, ledger, timeoutMs = 6 * 60e3, pollMs = 20e3, slackMs = 3 * 60e3,
                                          settleMs = 45e3, onPoll, evaluateFn = evaluate, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
                                          now = () => Date.now() } = {}) {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new Error(`verify: timeoutMs must be a positive number (got ${timeoutMs})`);
  const deadline = now() + timeoutMs;
  const results = scenarios.map((s) => {
    const calls = ledger ? ledger.forScenario(s.id) : [];
    const bad = calls.filter((c) => !c.ok);
    const exps = s.facts?.skipped ? [] : (s.expect?.(s.facts || {}, { runId }) || []);
    return { id: s.id, title: s.title, skipped: s.facts?.skipped, calls: calls.length, generatorErrors: bad,
             expectations: exps.map((e) => ({ ...e, kind: e.kind || 'must', pass: false, n: 0 })) };
  });
  const pending = () => results.flatMap((r) => r.expectations.filter((e) => !e.pass));
  const left = () => Math.max(0, deadline - now());
  for (;;) {
    const to = new Date(now() + slackMs).toISOString();
    // The deadline is checked per expectation, not per pass: on a slow cluster a single pass over
    // every expectation can take longer than the whole budget.
    for (const r of results) {
      for (let i = 0; i < r.expectations.length && left() > 0; i++) {
        if (r.expectations[i].pass) continue;
        r.expectations[i] = await evaluateFn(r.expectations[i], { from, to, runId, scenario: r.id }, { budgetMs: Math.min(30e3, left() || 1) });
      }
    }
    const waiting = pending().filter((e) => e.kind === 'must');
    onPoll?.(waiting.length, results);
    if (!waiting.length || now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  const upperBound = (e) => e.risk !== undefined || e.max !== undefined;
  if (settleMs > 0 && results.some((r) => r.expectations.some((e) => e.pass && upperBound(e)))) {
    await sleep(settleMs);
    const to = new Date(now() + slackMs).toISOString();
    for (const r of results) {
      for (let i = 0; i < r.expectations.length; i++) {
        const e = r.expectations[i];
        if (!(e.pass && upperBound(e))) continue;
        // Up to three tries. A re-judgement that could not RUN keeps the earlier verdict and says so:
        // "could not re-check" is not "re-checked and failed".
        let again;
        for (let k = 0; k < 3; k++) {
          again = await evaluateFn(e, { from, to, runId, scenario: r.id }, { budgetMs: 30e3 });
          if (!again.queryFailed) break;
          await sleep(2000 * (k + 1));
        }
        r.expectations[i] = again.queryFailed ? { ...e, settleError: again.error } : { ...again, settled: true };
      }
    }
  }
  for (const r of results) {
    r.pass = !r.generatorErrors.length && r.expectations.filter((e) => e.kind === 'must').every((e) => e.pass);
  }
  return results;
}

/** Landed-at-all check, independent of any scenario: did the stream receive anything since `from`? */
export async function landed(from) {
  const q = `FROM ${STREAM} | WHERE @timestamp >= TO_DATETIME(${lit(from)}) | STATS n = COUNT(*) BY ${F.source}`;
  let r;
  try { r = await es.esqlRun(q, undefined, { budgetMs: 30e3 }); }
  catch (e) { return { ok: false, status: 0, reason: `transport: ${e.message}` }; }
  if (!r.ok) return { ok: false, status: r.status, reason: r.body?.error?.root_cause?.[0]?.reason || r.body?.error?.reason };
  return { ok: true, bySource: Object.fromEntries((r.body.values || []).map(([n, s]) => [s, n])) };
}
