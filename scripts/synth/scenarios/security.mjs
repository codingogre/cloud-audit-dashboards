/**
 * Security configuration: role lifecycle, API key create / update / invalidate, use of a revoked
 * key, the role-mapping negative probe, and a newly-seen identity.
 *
 * Scoping is the subtle part. Elasticsearch writes each security-config-change event (put_role,
 * delete_role, create_apikey, change_apikey, invalidate_apikeys) WITHOUT the caller's X-Opaque-Id —
 * only the paired access_granted carries it — so those expectations are `unscoped` and pinned
 * instead by the run-unique role name or key id inside security_config_change. They still carry
 * api_key.name, so persona: holds. Changes made by the admin (Cloud API key) carry neither.
 *
 * Platform constraints, observed live (serverless):
 *   - An API key may only mint a DERIVED key, and only with an explicit empty role descriptor
 *     ({name: {}}); omitting role_descriptors or passing {} is a 400.
 *   - Updating any API key with API-key authentication is a 400 ("only the owner user can update"),
 *     yet ES has already emitted change_apikey, outcome success, at authorization time.
 *   - manage_own_api_key cannot invalidate (403, even with owner:true), so the security admin
 *     (manage_api_key) revokes the child, by id only.
 *   - A revoked key is anonymous_access_denied, not authentication_failed.
 *   - Role mappings answer 410 api_not_available; only authentication_success is audited.
 */
import { F, lit } from '../fields.mjs';

const ROLE = 'syn-role-';
const CHILD = 'syn-child-';
const MAP = 'syn-map-';
/** Run-unique suffix: runId already starts with syn-. */
const tag = (runId) => runId.replace(/^syn-/, '');
/** A security_config_change event whose JSON payload names `needle`; its own event has no opaque id. */
const change = (action, needle, extra = {}) => ({
  source: 'es', unscoped: true, risk: 50,
  where: `${F.action} == ${lit(action)} AND ${F.secChange} LIKE ${lit(`*${needle}*`)}`, ...extra,
});

/** Derived child key owned by the SRE: no privileges, 1h expiry, synthetic metadata for teardown. */
async function mintChild(ctx, n) {
  const name = `${CHILD}${tag(ctx.runId)}-${n}`;
  const res = await ctx.as('sre').es('POST', '/_security/api_key', {
    name, expiration: '1h', role_descriptors: { 'syn-child': {} },
    metadata: { synthetic: true, run: ctx.runId, generator: 'cloud-audit-dashboards' },
  }, { expect: 'ok' });
  return res.ok ? { name, id: res.body.id, encoded: res.body.encoded } : null;
}

/** Revoke by id as the security admin; never a persona key (assert the name before touching it). */
async function revoke(ctx, child) {
  if (!child.name.startsWith(CHILD)) throw new Error(`refusing to invalidate ${child.name}`);
  const res = await ctx.as('secadmin').es('DELETE', '/_security/api_key', { ids: [child.id] }, { expect: 'ok' });
  if (res.ok) child.revoked = true;
  return res.ok;
}

const roleLifecycle = {
  id: 'security.role-lifecycle',
  title: 'Security admin creates, widens and deletes a run-unique custom role',
  personas: ['secadmin'],
  weights: [0, 50],
  cadenceMin: 720,
  async run(ctx) {
    const s = ctx.as('secadmin');
    const role = `${ROLE}${tag(ctx.runId)}`;
    await s.es('PUT', `/_security/role/${role}`, { indices: [{ names: ['syn-orders'], privileges: ['read'] }] }, { expect: 'ok' });
    await s.es('PUT', `/_security/role/${role}`,
      { indices: [{ names: ['syn-orders'], privileges: ['read', 'view_index_metadata'] }] }, { expect: 'ok' });
    await s.es('DELETE', `/_security/role/${role}`, undefined, { expect: 'ok' });
    return { role };
  },
  expect: ({ role }) => [
    change('put_role', `"name":"${role}"`, { name: 'put_role create + update', persona: 'secadmin', min: 2 }),
    change('put_role', 'view_index_metadata', { name: 'put_role update carries the widened privilege', persona: 'secadmin',
      where: `${F.action} == "put_role" AND ${F.secChange} LIKE ${lit(`*${role}*`)} AND ${F.secChange} LIKE "*view_index_metadata*"` }),
    change('delete_role', `"name":"${role}"`, { name: 'delete_role', persona: 'secadmin' }),
    { name: 'opaque-scoped PutRoleRequest grants', source: 'es', persona: 'secadmin', min: 2, risk: 0,
      where: `${F.action} == "access_granted" AND ${F.reqName} == "PutRoleRequest"` },
  ],
  async cleanup({ es, act, assertOwned }) {
    const roles = await es.raw('/_security/role');
    for (const name of Object.keys(roles.body || {}).filter((n) => n.startsWith(ROLE))) {
      await act(`role ${name}`, () => es.raw(`/_security/role/${assertOwned(name)}`, { method: 'DELETE' }));
    }
  },
};

const keyCreateUpdate = {
  id: 'security.apikey-create-update',
  title: 'SRE mints a derived child key, then tries to update its metadata',
  personas: ['sre'],
  weights: [50],
  cadenceMin: 180,
  async run(ctx) {
    const child = await mintChild(ctx, 'a');
    if (!child) return { error: 'child key not created' };
    ctx.state.securityChild = child;
    // API-key auth can never update a key (400), but change_apikey is audited before the handler refuses.
    await ctx.as('sre').es('PUT', `/_security/api_key/${child.id}`,
      { metadata: { synthetic: true, run: ctx.runId, rotated: true } }, { expect: [400], note: 'update via API key is a 400 by design' });
    return { name: child.name, id: child.id };
  },
  expect: ({ name, id }) => [
    change('create_apikey', `"name":"${name}"`, { name: 'create_apikey for the child key', persona: 'sre' }),
    change('change_apikey', `"id":"${id}"`, { name: 'change_apikey audited (despite the 400)', persona: 'sre' }),
  ],
  async cleanup({ es, act, assertOwned, only }) {
    // `only` (a run tag) narrows the sweep to one run's child keys; without it every one goes.
    const prefix = only ? `${CHILD}${only}` : CHILD;
    const res = await es.raw('/_security/_query/api_key', {
      method: 'POST', body: { size: 1000, query: { bool: { must: [{ prefix: { name: prefix } }, { term: { invalidated: false } }] } } },
    });
    const keys = (res.body?.api_keys || []).filter((k) => k.metadata?.synthetic === true && k.name.startsWith(prefix));
    for (const k of keys) assertOwned(k.name);
    if (keys.length) await act(`invalidate ${keys.length} ${prefix}* API keys`,
      () => es.raw('/_security/api_key', { method: 'DELETE', body: { ids: keys.map((k) => k.id) } }));
  },
};

const keyInvalidate = {
  id: 'security.apikey-invalidate',
  title: 'Security admin revokes the SRE\'s child key',
  personas: ['sre', 'secadmin'],
  weights: [45],
  cadenceMin: 180,
  async run(ctx) {
    let child = ctx.state.securityChild;
    if (!child || child.revoked) child = await mintChild(ctx, 'b');
    if (!child) return { error: 'child key not created' };
    if (!(await revoke(ctx, child))) return { error: 'invalidate failed' };
    ctx.state.securityRevoked = child;
    return { name: child.name, id: child.id };
  },
  // invalidate_apikeys always carries security_config_change: 45 here proves its CASE branch precedes the 50 branch.
  expect: ({ id }) => [
    { ...change('invalidate_apikeys', `"${id}"`, { name: 'invalidate_apikeys for the child id', persona: 'secadmin' }), risk: 45 },
  ],
};

const revokedUse = {
  id: 'security.revoked-key-use',
  title: 'Someone presents the revoked child key',
  personas: ['anon'],
  weights: [35],
  cadenceMin: 180,
  async run(ctx) {
    let child = ctx.state.securityRevoked;
    if (!child) {
      child = await mintChild(ctx, 'c');
      if (!child || !(await revoke(ctx, child))) return { error: 'could not prepare a revoked key' };
    }
    ctx.state.securityRevoked = null;
    const c = ctx.raw(child.encoded, `${child.name} (revoked)`);
    await c.es('GET', '/', undefined, { expect: 'denied' });
    await c.es('GET', '/_security/_authenticate', undefined, { expect: 'denied' });
    return { name: child.name };
  },
  expect: () => [
    { name: 'revoked key is anonymous_access_denied', source: 'es', min: 2, risk: 35,
      where: `${F.action} == "anonymous_access_denied" AND ${F.outcome} == "failure" AND ${F.keyName} IS NULL` },
  ],
};

const roleMappingProbe = {
  id: 'security.role-mapping-probe',
  title: 'Security admin probes role mappings (not available to serverless tenants)',
  personas: ['secadmin'],
  weights: [0],
  cadenceMin: 1440,
  async run(ctx) {
    const name = `${MAP}${tag(ctx.runId)}`;
    const res = await ctx.as('secadmin').es('PUT', `/_security/role_mapping/${name}`,
      { roles: ['viewer'], enabled: false, rules: { field: { username: 'syn-nobody' } }, metadata: { synthetic: true } },
      { expect: 'absent' });
    // Should role mappings ever ship to serverless, the PUT above lands a mapping: remove it at once
    // (the ledger already flags the 2xx), so the probe never leaves anything behind. res.ok means
    // "matched expect", not 2xx, so test the status.
    if (res.status >= 200 && res.status < 300) await ctx.as('secadmin').es('DELETE', `/_security/role_mapping/${name}`, undefined, { expect: 'ok' });
    return { name, status: res.status };
  },
  // The HTTP status is the assertion (ledger). Observed live: only authentication_success is audited, no access_* event.
  expect: ({ name }) => [
    { name: 'probe is authenticated (the only event a 410 leaves)', source: 'es', persona: 'secadmin', risk: 0,
      where: `${F.action} == "authentication_success" AND ${F.urlPath} == ${lit(`/_security/role_mapping/${name}`)}` },
  ],
  async cleanup({ es, act, assertOwned }) {
    const res = await es.raw('/_security/role_mapping');
    if (!res.ok) return; // 410 on serverless: nothing can exist
    for (const name of Object.keys(res.body || {}).filter((n) => n.startsWith(MAP))) {
      await act(`role mapping ${name}`, () => es.raw(`/_security/role_mapping/${assertOwned(name)}`, { method: 'DELETE' }));
    }
  },
};

const newIdentity = {
  id: 'security.new-identity',
  title: 'A new hire\'s key is minted mid-run, reads syn-orders and is refused a write',
  personas: ['newHire'],
  weights: [0, 40, 50],
  cadenceMin: 1440,
  async run(ctx) {
    const name = await ctx.mintNewHire();
    const n = ctx.as('newHire');
    await n.es('GET', '/_security/_authenticate', undefined, { expect: 'ok' });
    await n.es('POST', '/syn-orders/_search', { size: 5, query: { term: { status: 'paid' } } }, { expect: 'ok' });
    await n.es('POST', '/syn-orders/_doc', { order_id: `${name}-probe`, status: 'new' }, { expect: 'denied' });
    await n.kb('GET', '/api/data_views', undefined, { expect: 'ok' });
    return { name };
  },
  expect: ({ name }) => [
    change('create_apikey', `"name":"${name}"`, { name: 'admin mints the new-hire key' }),
    { name: 'new hire authenticates', source: 'es', persona: 'newHire', risk: 0,
      where: `${F.action} == "authentication_success"` },
    { name: 'new hire reads syn-orders', source: 'es', persona: 'newHire', risk: 0,
      where: `${F.action} == "access_granted" AND ${F.reqName} == "SearchRequest" AND ${F.indices} == "syn-orders"` },
    { name: 'new hire denied a write', source: 'es', persona: 'newHire', risk: 40,
      where: `${F.action} == "access_denied" AND ${F.outcome} == "failure" AND ${F.indices} == "syn-orders"` },
    { name: 'Kibana\'s ES calls for the new hire carry its key name', source: 'es', persona: 'newHire', unscoped: true, risk: 0,
      where: `NOT (COALESCE(MV_FIRST(${F.opaqueId}), "") LIKE "syn-*")` },
  ],
};

export default [roleLifecycle, keyCreateUpdate, keyInvalidate, revokedUse, roleMappingProbe, newIdentity];
