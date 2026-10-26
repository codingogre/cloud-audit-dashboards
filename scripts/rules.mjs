/**
 * --rules: deploy the starter alert pack (lib/rules.mjs) to Universal Alerting in the Default space.
 *
 *   emit()   writes rules/<slug>.json, the exact PUT bodies, for review (skipped under AUDIT_ID_NS, as
 *            dashboards/*.json is, so a private copy never overwrites the committed production payloads).
 *   run()    for each rule: GET by id; 404 RULE_NOT_FOUND → PUT with enabled:false; 200 and the stored rule already
 *            says what the body says → nothing written (a PUT bumps the version and reschedules an enabled rule);
 *            200 otherwise → PUT with the stored `enabled`, so the customer's on/off is kept. Each write is read
 *            back and checked. Then RETIRED_RULE_IDS are removed (exact ids, each read first). Nothing is found by
 *            tag or name. `enabled` is always sent: a PUT that leaves it out keeps the stored value, but on a rule
 *            deleted between the GET and the PUT it creates the rule enabled (create defaults to true).
 *   deploy() run() for --deploy: on a project where Universal Alerting is off or absent it warns and skips, so
 *            the dashboards still deploy; `--rules` on its own fails instead.
 *   clean()  exact-id DELETE of every rule and retired id (--clean rules / all). A 404 RULE_NOT_FOUND is "was not
 *            there"; with Universal Alerting off or absent there is nothing to remove, so it warns and returns and
 *            `--clean all` carries on to the dashboards and ingest.
 *
 * Writes go through kb.sRaw: the alerting_v2 routes accepted its Elastic-Api-Version header on PUT, POST and DELETE
 * (measured 2026-10-26 on a private copy), and kbn-xsrf is required. A 409 RULE_ALREADY_EXISTS on a PUT means
 * the id lives in another space (a rule id is unique across spaces); 409 IMMUTABLE_FIELDS_CHANGED, a kind change.
 * Universal Alerting off answers 503 on every route (alerting:v2:enabled); a project without it answers a bare 404,
 * where a missing rule's 404 carries code RULE_NOT_FOUND (both measured 2026-10-26).
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, nsId } from './lib/env.mjs';
import { kb } from './lib/http.mjs';
import { success, info, warn, detail } from './lib/log.mjs';
import { RULES, RETIRED_RULE_IDS, ruleId, rulePayload, ruleTag } from './lib/rules.mjs';

const API = '/api/alerting/v2/rules';
export const RULES_DIR = join(ROOT, 'rules');
export const ruleFile = (slug) => `${slug}.json`;

/** A 404 for a rule id that is not there, as against a route that is not there. */
const notFound = (r) => r.status === 404 && r.body?.code === 'RULE_NOT_FOUND';
/** Universal Alerting is off (503 on every route) or this Kibana has no alerting_v2 routes (a bare 404). */
export const unavailable = (r) => r.status === 503 || (r.status === 404 && !notFound(r));

/** What a failed call means, naming what to fix. */
function explain(what, r) {
  const msg = r.body?.message || r.body?.error || JSON.stringify(r.body ?? null).slice(0, 300);
  if (r.status === 503) return `${what}: 503 — Universal Alerting is off on this project (Stack Management → Advanced settings → alerting:v2:enabled)`;
  if (unavailable(r)) return `${what}: 404 — this Kibana has no Universal Alerting API (${API})`;
  if (r.status === 401 || r.status === 403) return `${what}: ${r.status} — the API key needs the manage_alerting-v2-rules privilege (${msg})`;
  return `${what}: ${r.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
}

/** Write the generated payloads to disk so they are diffable in review. */
export function emit() {
  const out = RULES.map((r) => ({ rule: r, id: ruleId(r.slug), body: rulePayload(r) }));
  if (process.env.AUDIT_ID_NS) return out;
  mkdirSync(RULES_DIR, { recursive: true });
  const want = new Set(out.map(({ rule }) => ruleFile(rule.slug)));
  for (const { rule, body } of out) writeFileSync(join(RULES_DIR, ruleFile(rule.slug)), JSON.stringify(body, null, 2) + '\n');
  // The files are the pack and nothing else: a renamed or dropped rule must not leave its payload behind.
  for (const f of readdirSync(RULES_DIR).filter((f) => f.endsWith('.json') && !want.has(f))) rmSync(join(RULES_DIR, f));
  return out;
}

/** Fields the read-back must match, beside `enabled`. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Every field `want` names is in `got` with the same value, in any key order; `got` may carry more. */
export function covers(got, want) {
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => covers(got[i], w));
  if (want && typeof want === 'object') return !!got && typeof got === 'object' && Object.keys(want).every((k) => covers(got[k], want[k]));
  return got === want;
}

/** An error that says the alerting_v2 API is not there, so deploy() can skip rather than fail. */
function unavailableError(msg) { const e = new Error(msg); e.unavailable = true; return e; }

export async function run() {
  const out = emit();
  let created = 0, replaced = 0, unchanged = 0;
  for (const { rule, id, body } of out) {
    const path = `${API}/${id}`;
    const before = await kb.sRaw(path, { method: 'GET' });
    if (unavailable(before)) throw unavailableError(explain(`read rule ${id}`, before));
    if (before.status !== 200 && !notFound(before)) throw new Error(explain(`read rule ${id}`, before));
    const isNew = before.status !== 200;
    if (!isNew && covers(before.body, body)) {
      unchanged++;
      detail(`${id}: unchanged, ${before.body.enabled ? 'enabled' : 'disabled'} (v${before.body.version})`);
      continue;
    }
    // Created disabled; a replace sends the stored value, so the customer's on/off survives every redeploy.
    const put = await kb.sRaw(path, { method: 'PUT', body: { ...body, enabled: isNew ? false : before.body.enabled } });
    if (!put.ok) {
      if (put.status === 409 && put.body?.code === 'IMMUTABLE_FIELDS_CHANGED') {
        throw new Error(`${explain(`rule ${id}`, put)} — its kind cannot change in place: ./audit --clean rules, then --rules again`);
      }
      if (put.status === 409 && put.body?.code === 'RULE_ALREADY_EXISTS') {
        throw new Error(`${explain(`rule ${id}`, put)} — a rule id is unique across spaces: this id already exists in another space`);
      }
      throw new Error(explain(`write rule ${id}`, put));
    }
    const got = await kb.sRaw(path, { method: 'GET' });
    if (!got.ok) throw new Error(explain(`read back rule ${id}`, got));
    const g = got.body;
    const problems = [];
    if (g.kind !== 'alert') problems.push(`kind is ${g.kind}`);
    if (!same(g.query, body.query)) problems.push('query differs from what was sent');
    if (!same(g.grouping, body.grouping)) problems.push('grouping differs');
    if (!same(g.schedule, body.schedule)) problems.push('schedule differs');
    if (g.metadata?.name !== body.metadata.name) problems.push('name differs');
    if (isNew && g.enabled !== false) problems.push(`created enabled (${g.enabled}), not disabled`);
    if (!isNew && g.enabled !== before.body.enabled) problems.push(`enabled changed from ${before.body.enabled} to ${g.enabled}`);
    if (problems.length) throw new Error(`rule ${id} read back wrong: ${problems.join('; ')}`);
    if (isNew) created++; else replaced++;
    detail(`${id}: ${isNew ? 'created, disabled' : `replaced, ${g.enabled ? 'enabled' : 'disabled'} as it was`} (v${g.version})`);
  }
  await removeRetired();
  success(`${out.length} alert rules deployed to the Default space (${created} created disabled, ${replaced} replaced, ${unchanged} unchanged; on/off kept)`);
  info(`Enable them in Stack Management → Rules, and route alerts with an action policy matching the tag "${ruleTag()}"`);
  return out;
}

/** --deploy's rules step: the dashboards are already in place, so a project without Universal Alerting is a warning. */
export async function deploy() {
  try {
    return await run();
  } catch (e) {
    if (!e.unavailable) throw e;
    warn(`alert rules skipped: ${e.message}`);
    return [];
  }
}

/** Earlier releases' rule ids: exact ids only, each read first. */
async function removeRetired() {
  for (const id of RETIRED_RULE_IDS.map(nsId)) {
    const r = await kb.sRaw(`${API}/${id}`, { method: 'GET' });
    if (notFound(r)) continue;
    if (!r.ok) throw new Error(explain(`read retired rule ${id}`, r));
    const d = await kb.sRaw(`${API}/${id}`, { method: 'DELETE' });
    if (!d.ok && !notFound(d)) throw new Error(explain(`remove retired rule ${id}`, d));
    info(`removed retired rule ${id}`);
  }
}

/** --clean rules: every rule this suite deploys or ever deployed, by exact id. */
export async function clean() {
  const ids = [...RULES.map((r) => ruleId(r.slug)), ...RETIRED_RULE_IDS.map(nsId)];
  const failed = [];
  for (const id of ids) {
    const r = await kb.sRaw(`${API}/${id}`, { method: 'DELETE' });
    if (unavailable(r)) { warn(`no alert rules removed: ${explain(`rule ${id}`, r)}`); return; }
    detail(`rule ${id}: ${r.status}`);
    if (!r.ok && !notFound(r)) failed.push(explain(id, r));
  }
  if (failed.length) throw new Error(`could not delete: ${failed.join('; ')}`);
  success(`removed up to ${ids.length} alert rules`);
}
