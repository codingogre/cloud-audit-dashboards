/**
 * Scenario registry, and the contract every scenario module meets.
 *
 * A module default-exports an array of scenarios:
 *
 *   {
 *     id:        'group.name'           unique, stable — tests and reports key on it
 *     title:     string
 *     personas:  ['analyst', ...]       PERSONAS keys it acts as ('anon' for no credential)
 *     weights:   [0, 25, 30]            RISK weights its events are meant to score (coverage test)
 *     cadenceMin: number                loop mode runs it at most this often
 *     run(ctx):  Promise<facts>         performs REAL calls through ctx.as(persona) / ctx.anon;
 *                                       returns facts (ids, names) that expect() needs, or
 *                                       { skipped: 'reason' } when the platform lacks the feature
 *     expect(facts, { runId }):         expectation[] — see verify.mjs
 *     cleanup?({ es, kb, act, assertOwned }): removes what run() leaves behind, PREFIX names only
 *   }
 *
 * run() must leave nothing behind that cleanup() cannot find, and must never touch a resource
 * whose name does not start with PREFIX.
 */
import esData from './es-data.mjs';
import security from './security.mjs';
import failures from './failures.mjs';
import kibanaObjects from './kibana-objects.mjs';
import kibanaFeatures from './kibana-features.mjs';
import { PERSONAS } from '../personas.mjs';

export const MODULES = { esData, security, failures, kibanaObjects, kibanaFeatures };

export const SCENARIOS = Object.values(MODULES).flat();

/** Throws on any contract violation. Unit-tested, and run before every generator invocation. */
export function validate(list = SCENARIOS) {
  const errors = [];
  const ids = new Set();
  for (const s of list) {
    const at = s?.id || '<no id>';
    if (!s || typeof s.id !== 'string' || !/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9-]*$/.test(s.id)) errors.push(`${at}: id must be "group.name"`);
    if (ids.has(s.id)) errors.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (typeof s.title !== 'string' || !s.title) errors.push(`${at}: title required`);
    if (typeof s.run !== 'function') errors.push(`${at}: run() required`);
    if (typeof s.expect !== 'function') errors.push(`${at}: expect() required`);
    if (!Array.isArray(s.personas) || !s.personas.length) errors.push(`${at}: personas[] required`);
    for (const p of s.personas || []) if (p !== 'anon' && p !== 'newHire' && !PERSONAS[p]) errors.push(`${at}: unknown persona ${p}`);
    if (!Array.isArray(s.weights) || s.weights.some((w) => ![0, 10, 25, 30, 35, 40, 45, 50].includes(w))) errors.push(`${at}: weights must be RISK weights`);
    if (!(s.cadenceMin > 0)) errors.push(`${at}: cadenceMin must be > 0`);
    if (s.cleanup !== undefined && typeof s.cleanup !== 'function') errors.push(`${at}: cleanup must be a function`);
  }
  if (errors.length) throw new Error(`scenario contract violations:\n  ${errors.join('\n  ')}`);
  return list;
}

export function select(only) {
  if (!only) return SCENARIOS;
  const want = only.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = SCENARIOS.filter((s) => want.some((w) => s.id === w || s.id.startsWith(`${w}.`)));
  const unknown = want.filter((w) => !SCENARIOS.some((s) => s.id === w || s.id.startsWith(`${w}.`)));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  return picked;
}
