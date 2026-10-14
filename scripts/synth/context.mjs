/**
 * A generator run: seed data, spaces, persona keys, and the per-scenario clients built on them.
 *
 * Setup runs as the admin key and is idempotent, so `--synth run` can be repeated against the same
 * project. Persona keys are minted fresh each run (25h expiry) and held only in memory: a key that
 * outlives its process is a credential lying around, and expiry is the backstop if teardown never
 * runs. Names are stable across runs, so a persona is one identity on every dashboard however many
 * times its key is re-minted.
 *
 * Teardown deletes only resources named with PREFIX — assertOwned() is the single gate every
 * destructive call passes through.
 */
import { es, kb } from '../lib/http.mjs';
import { info, detail, warn } from '../lib/log.mjs';
import { PERSONAS, PREFIX, SPACES, assertOwned, newHire } from './personas.mjs';
import { Ledger, makeClient } from './client.mjs';
import { rng } from './rng.mjs';

export const SEED_INDICES = ['syn-orders', 'syn-invoices', 'syn-customers', 'syn-hr-salaries', 'syn-app-logs'];

const MAPPINGS = {
  'syn-orders':      { order_id: 'keyword', customer: 'keyword', status: 'keyword', amount: 'double', region: 'keyword', '@timestamp': 'date' },
  'syn-invoices':    { invoice_id: 'keyword', order_id: 'keyword', amount: 'double', due: 'date', paid: 'boolean' },
  'syn-customers':   { customer: 'keyword', name: 'text', tier: 'keyword', country: 'keyword' },
  'syn-hr-salaries': { employee: 'keyword', department: 'keyword', salary: 'double', band: 'keyword' },
  'syn-app-logs':    { '@timestamp': 'date', level: 'keyword', service: 'keyword', message: 'text' },
};

export function seedDocs(index, r, n) {
  const regions = ['us-east', 'us-west', 'eu-west', 'ap-south'];
  const statuses = ['new', 'paid', 'shipped', 'refunded', 'cancelled'];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(5, '0');
    switch (index) {
      case 'syn-orders': out.push({ _id: id, order_id: `O-${id}`, customer: `C-${r.int(1, 200)}`, status: r.pick(statuses),
        amount: Math.round(r.next() * 50000) / 100, region: r.pick(regions), '@timestamp': new Date(Date.UTC(2026, 9, r.int(1, 14))).toISOString() }); break;
      case 'syn-invoices': out.push({ _id: id, invoice_id: `I-${id}`, order_id: `O-${id}`, amount: Math.round(r.next() * 50000) / 100,
        due: new Date(Date.UTC(2026, 10, r.int(1, 28))).toISOString(), paid: r.chance(0.6) }); break;
      case 'syn-customers': out.push({ _id: id, customer: `C-${i}`, name: `Customer ${i}`, tier: r.pick(['gold', 'silver', 'bronze']), country: r.pick(['US', 'DE', 'IN', 'BR', 'JP']) }); break;
      case 'syn-hr-salaries': out.push({ _id: id, employee: `E-${id}`, department: r.pick(['eng', 'sales', 'finance', 'ops']),
        salary: 60000 + r.int(0, 140000), band: r.pick(['L3', 'L4', 'L5', 'L6']) }); break;
      default: out.push({ _id: id, '@timestamp': new Date().toISOString(), level: r.pick(['info', 'info', 'info', 'warn', 'error']),
        service: r.pick(['checkout', 'cart', 'search']), message: `synthetic event ${id}` });
    }
  }
  return out;
}

export const bulkBody = (index, docs) =>
  docs.map(({ _id, ...d }) => `${JSON.stringify({ index: { _index: index, _id } })}\n${JSON.stringify(d)}`).join('\n') + '\n';

async function seedProject(r, { kibana = true } = {}) {
  for (const index of SEED_INDICES) {
    const props = Object.fromEntries(Object.entries(MAPPINGS[index]).map(([k, t]) => [k, { type: t }]));
    const put = await es.raw(`/${index}`, { method: 'PUT', body: { mappings: { properties: props } } });
    if (!put.ok && put.body?.error?.type !== 'resource_already_exists_exception') {
      throw new Error(`seed ${index}: ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
    }
    const bulk = await es.raw('/_bulk?refresh=wait_for', {
      method: 'POST', body: bulkBody(index, seedDocs(index, r, 200)), headers: { 'Content-Type': 'application/x-ndjson' },
    });
    if (!bulk.ok || bulk.body.errors) throw new Error(`seed bulk ${index}: ${bulk.status}`);
  }
  // Spaces are Kibana's: an ES-only run must not fail because Kibana is unavailable.
  if (!kibana) return;
  for (const id of SPACES) {
    const res = await kb.raw('/api/spaces/space', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: `Syn ${id.slice(PREFIX.length)}`, disabledFeatures: [] }),
    });
    // Only the cross-space scenario needs these, and Kibana being down must not stop an ES-only run.
    if (!res.ok && res.status !== 409) warn(`space ${id} not created (${res.status}); cross-space scenarios will fail`);
  }
}

/** The tag every scenario embeds in what it creates: the run id without its `syn-` prefix. */
export const runTag = (runId) => String(runId).replace(/^syn-/, '').toLowerCase();

export async function mint(persona, runId) {
  const res = await es.raw('/_security/api_key', {
    method: 'POST',
    body: { name: assertOwned(persona.name), expiration: '25h',
            role_descriptors: { [persona.name]: persona.role },
            metadata: { synthetic: true, run: runId, generator: 'cloud-audit-dashboards' } },
  });
  if (!res.ok) throw new Error(`mint ${persona.name}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return { id: res.body.id, encoded: res.body.encoded };
}

/**
 * Build a run. `seedData=false` skips seeding (loop re-mints); `personas` limits minting to the
 * personas the selected scenarios declare; `kibana=false` skips the Kibana half of seeding.
 * Returns ctx with: runId, r (seeded rng), ledger, keys, state (scenario facts), forScenario(id).
 *
 * Minting is all-or-nothing: if any persona fails, the keys already minted are invalidated before
 * the error propagates, so a failed start never leaves live credentials behind.
 */
export async function createRun({ runId, seed = runId, seedData = true, persist = true, log = true,
                                  personas = Object.keys(PERSONAS), kibana = true } = {}) {
  const r = rng(seed);
  const ledger = new Ledger(runId, { persist });
  if (seedData) { if (log) info(`Seeding syn-* indices${kibana ? ' and spaces' : ''}`); await seedProject(r, { kibana }); }
  const keys = {};
  try {
    for (const id of personas.filter((p) => PERSONAS[p])) keys[id] = await mint(PERSONAS[id], runId);
  } catch (e) {
    const ids = Object.values(keys).map((k) => k.id);
    if (ids.length) await es.raw('/_security/api_key', { method: 'DELETE', body: { ids } }).catch(() => {});
    throw e;
  }
  if (log) detail(`minted ${Object.keys(keys).length} persona keys (25h expiry, held in memory only)`);
  return {
    runId, r, ledger, keys, state: {},
    started: new Date(),
    async mintNewHire() {
      const p = newHire(runId);
      // Loop mode re-runs this: retire the previous key rather than orphan it until expiry.
      if (keys.newHire) await es.raw('/_security/api_key', { method: 'DELETE', body: { ids: [keys.newHire.id] } });
      keys.newHire = await mint(p, runId);
      return p.name;
    },
    /**
     * Clients bound to one scenario so every call's opaque id names it. `round` (loop mode) is
     * folded into the sequence so ids never repeat across rounds: `<runId>/<scenario>/<round>.<n>`.
     */
    forScenario(scenario, { round } = {}) {
      const seq = { n: 0, round };
      const as = (personaId) => {
        if (!keys[personaId]) throw new Error(`unknown persona "${personaId}"`);
        const name = personaId === 'newHire' ? newHire(runId).name : PERSONAS[personaId].name;
        return makeClient({ persona: name, key: keys[personaId].encoded, runId, scenario, ledger, seq });
      };
      return {
        runId, r, state: this.state, as,
        anon: makeClient({ persona: null, key: null, runId, scenario, ledger, seq }),
        raw: (encoded, label) => makeClient({ persona: label, key: encoded, runId, scenario, ledger, seq }),
        admin: es, adminKb: kb,
      };
    },
    async retire() {
      const ids = Object.values(keys).map((k) => k.id);
      if (!ids.length) return;
      const res = await es.raw('/_security/api_key', { method: 'DELETE', body: { ids } }).catch((e) => ({ ok: false, status: String(e.message) }));
      if (!res.ok) warn(`could not invalidate persona keys: ${res.status} — they expire within 25h`);
      else for (const k of Object.keys(keys)) delete keys[k];
    },
  };
}

/**
 * Remove PREFIX resources the generator created. Each delete passes assertOwned().
 *
 *   runIds: [..]  RUN-SCOPED: only deletes whose label names one of these runs' tags happen, and each
 *                 cleanup() gets `only` so batch sweeps narrow to that run. Anything it cannot attribute
 *                 to the run is left for an explicit full clean — the safe failure. This is what
 *                 `--synth run` and the integration suite use, so they never touch a concurrent run.
 *   scoped: true  only the given scenarios' cleanup(), across all runs, without the project-wide sweep
 *   (neither)     every scenario's cleanup plus the sweep of keys, roles, indices and spaces
 *
 * Returns { removed, failed, skipped }. A delete counts as removed only if it succeeded (or the thing
 * was already gone); anything else is reported, never silently counted.
 */
export async function teardown({ scenarios = [], dryRun = false, scoped = false, runIds, clients = { es, kb } } = {}) {
  const tags = runIds?.length ? runIds.map(runTag) : null;
  const removed = [], failed = [], skipped = [];
  const act = async (label, fn) => {
    if (tags && !tags.some((t) => label.toLowerCase().includes(t))) { skipped.push(label); return; }
    if (dryRun) { removed.push(label); return; }
    try {
      const res = await fn();
      if (res && res.ok === false && res.status !== 404) failed.push(`${label}: ${res.status}`);
      else removed.push(label);
    } catch (e) { failed.push(`${label}: ${e.message}`); }
  };
  const only = tags?.length === 1 ? tags[0] : undefined;

  for (const s of scenarios) {
    if (typeof s.cleanup !== 'function') continue;
    try { await s.cleanup({ es: clients.es, kb: clients.kb, act, assertOwned, dryRun, only }); }
    catch (e) { failed.push(`${s.id} cleanup: ${e.message}`); }
  }
  if (scoped || tags) return { removed, failed, skipped };

  const keys = await es.raw('/_security/_query/api_key', {
    method: 'POST', body: { size: 1000, query: { bool: { must: [{ prefix: { name: PREFIX } }, { term: { invalidated: false } }] } } },
  });
  const ids = (keys.body?.api_keys || []).filter((k) => k.metadata?.synthetic === true && k.name.startsWith(PREFIX)).map((k) => k.id);
  if (ids.length) await act(`invalidate ${ids.length} ${PREFIX}* API keys`, () => es.raw('/_security/api_key', { method: 'DELETE', body: { ids } }));

  const roles = await es.raw('/_security/role');
  for (const name of Object.keys(roles.body || {}).filter((n) => n.startsWith(PREFIX))) {
    await act(`role ${name}`, () => es.raw(`/_security/role/${assertOwned(name)}`, { method: 'DELETE' }));
  }
  const idx = await es.raw(`/_resolve/index/${PREFIX}*?expand_wildcards=open,closed`);
  for (const i of idx.body?.indices || []) {
    await act(`index ${i.name}`, () => es.raw(`/${assertOwned(i.name)}`, { method: 'DELETE' }));
  }
  const spaces = await kb.raw('/api/spaces/space');
  for (const s of (Array.isArray(spaces.body) ? spaces.body : []).filter((x) => x.id.startsWith(PREFIX))) {
    await act(`space ${s.id}`, () => kb.raw(`/api/spaces/space/${assertOwned(s.id)}`, { method: 'DELETE' }));
  }
  return { removed, failed, skipped };
}
