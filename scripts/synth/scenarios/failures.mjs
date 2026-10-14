/**
 * Failures: the denials, anonymous probes and bad credentials the security panels exist to catch.
 *
 * Every call here is MEANT to be refused, so each declares `expect: 'denied'` and a 2xx is a
 * generator error: a contractor that can delete an index is a broken persona, not a quiet hour.
 * Nothing is created except the analyst's run-unique dashboard S21 needs as a delete target.
 *
 * Scoping: ES events carry our X-Opaque-Id, so ES expectations are scoped by verify.mjs. Kibana
 * events carry neither the header nor a persona name, so S21 scopes by the run-unique object ids.
 */
import { F, lit } from '../fields.mjs';

const OWN = 'syn-fail-';
/** Run-unique, Kibana-id-safe suffix (space ids allow only [a-z0-9_-]). */
const tag = (runId) => runId.replace(/^syn-/, '').toLowerCase();
const denied = (where, extra = {}) => ({ source: 'es', where: `${F.outcome} == "failure" AND ${where}`, risk: 40, ...extra });

/**
 * A 403 _search on a concrete index the key cannot read is audited as access_GRANTED on the
 * placeholder indices ["*","-*"], not access_denied: ES rewrites the forbidden name away before the
 * authorization check. A document GET is denied by name. Both shapes are asserted, the search one
 * as a finding because it is the platform behaviour the denial panels would want to be different.
 */
const searchRewritten = (who) => ({ name: `${who}: denied _search audited as access_granted on "-*" (0)`, source: 'es',
  persona: 'contractor', risk: 0,
  where: `${F.action} == "access_granted" AND ${F.esAction} == "indices:data/read/search" AND MV_CONCAT(${F.indices}, ",") == "*,-*"` });
const searchDenied = (who) => ({ name: `${who}: denied _search audited as access_denied`, source: 'es', kind: 'finding',
  persona: 'contractor', risk: 40, where: `${F.action} == "access_denied" AND ${F.esAction} == "indices:data/read/search"` });

const probe = {
  id: 'failures.system-index-probe',
  title: 'Contractor probes another team\'s index and Kibana system indices',
  personas: ['contractor'],
  weights: [40, 0],
  cadenceMin: 30,
  async run(ctx) {
    const c = ctx.as('contractor');
    // Concrete names: a wildcard such as .kibana* resolves to nothing the key may see and answers 200 empty.
    const targets = ['syn-hr-salaries', '.cases', '.workflows-executions'];
    for (const t of targets) {
      await c.es('POST', `/${t}/_search`, { size: 1, query: { match_all: {} } }, { expect: 'denied' });
      await c.es('GET', `/${t}/_doc/${t === 'syn-hr-salaries' ? '00001' : '1'}`, undefined, { expect: 'denied' });
    }
    return { targets };
  },
  expect: () => [
    denied(`${F.action} == "access_denied" AND ${F.indices} == "syn-hr-salaries"`,
      { name: 'contractor denied by name on syn-hr-salaries', persona: 'contractor' }),
    denied(`${F.action} == "access_denied" AND ${F.indices} LIKE ".*"`,
      { name: 'contractor denied on dot indices, indices populated', persona: 'contractor', min: 2 }),
    { ...searchRewritten('probe'), min: 3 },
    searchDenied('probe'),
  ],
};

const overreach = {
  id: 'failures.contractor-overreach',
  title: 'Contractor overreach burst: delete, write, read HR, list roles, mint a key',
  personas: ['contractor'],
  weights: [40, 0],
  cadenceMin: 90,
  async run(ctx) {
    const c = ctx.as('contractor');
    const n = ctx.r.int(1, 3);
    for (let i = 0; i < n; i++) {
      await c.es('DELETE', '/syn-orders', undefined, { expect: 'denied' });
      await c.es('PUT', `/syn-orders/_doc/${OWN}${tag(ctx.runId)}-${i}`, { note: 'contractor write' }, { expect: 'denied' });
      await c.es('POST', '/syn-hr-salaries/_search', { query: { range: { salary: { gte: 150000 } } } }, { expect: 'denied' });
      await c.es('GET', `/syn-hr-salaries/_doc/${String(ctx.r.int(1, 200)).padStart(5, '0')}`, undefined, { expect: 'denied' });
      await c.es('GET', '/_security/role', undefined, { expect: 'denied' });
      await c.es('POST', '/_security/api_key', {
        name: `${OWN}contractor-${tag(ctx.runId)}`, expiration: '1h',
        // Should the denial ever regress, teardown invalidates synthetic-tagged syn- keys.
        metadata: { synthetic: true, run: ctx.runId, generator: 'cloud-audit-dashboards' },
        role_descriptors: { escalate: { cluster: ['all'], indices: [{ names: ['*'], privileges: ['all'] }] } },
      }, { expect: 'denied' });
    }
    return { n };
  },
  expect: ({ n = 1 }) => {
    const a = (name, act) => denied(`${F.action} == "access_denied" AND ${F.esAction} LIKE ${lit(act)}`,
      { name: `contractor denied: ${name}`, persona: 'contractor', min: n });
    return [
      a('delete index', 'indices:admin/delete*'),
      a('write doc', 'indices:data/write/*'),
      a('read HR document', 'indices:data/read/get*'),
      a('list roles', 'cluster:admin/xpack/security/role/get*'),
      // A denied create carries no security_config_change, so it scores 40, not 50.
      a('create API key', 'cluster:admin/xpack/security/api_key/create*'),
      { ...searchRewritten('HR search'), min: n },
      searchDenied('HR search'),
    ];
  },
};

const ANON_PATHS = ['/', '/_cat/indices', '/syn-orders/_search', '/wp-login.php', '/.env'];

const scanner = {
  id: 'failures.anonymous-scanner',
  title: 'Anonymous scanner sweeps well-known paths with no credential',
  personas: ['anon'],
  weights: [35],
  cadenceMin: 45,
  async run(ctx) {
    for (const p of ANON_PATHS) await ctx.anon.es('GET', p, undefined, { expect: 'denied' });
    // Kibana: does an unauthenticated API call leave any audit record at all? url.original drops the
    // query string, so the run marker rides in the path where a record of it could be found.
    const marker = `${OWN}anon-${tag(ctx.runId)}`;
    await ctx.anon.kb('GET', `/api/dashboards/${marker}`, undefined, { expect: 'denied' });
    return { marker };
  },
  expect: ({ marker }) => [
    ...ANON_PATHS.map((p) => ({
      name: `anonymous_access_denied for ${p}`, source: 'es', risk: 35,
      where: `${F.action} == "anonymous_access_denied" AND ${F.urlPath} == ${lit(p)} AND ${F.keyName} IS NULL`,
    })),
    // Observed: Kibana answers 401 and writes no audit event at all.
    { name: 'Kibana audits an unauthenticated request', source: 'kb', kind: 'finding',
      where: `${F.urlOrig} LIKE ${lit(`*${marker}*`)}` },
  ],
};

const b64 = (s) => Buffer.from(s).toString('base64');

/**
 * The two credential types fail differently. An API key that does not exist is not an identity at
 * all and lands as anonymous_access_denied (35); a Basic username goes to the realms, which emit
 * realm_authentication_failed per realm tried plus one authentication_failed naming the user (40).
 */
const bogus = {
  id: 'failures.bogus-credentials',
  title: 'Bogus API key and Basic credentials',
  personas: ['anon'],
  weights: [35, 40],
  cadenceMin: 60,
  async run(ctx) {
    const key = ctx.raw(b64(`bogus${ctx.r.int(1000, 9999)}:bogus`), '<bogus-apikey>');
    await key.es('GET', '/', undefined, { expect: 'denied' });
    await key.es('GET', '/_security/_authenticate', undefined, { expect: 'denied' });
    const basic = ctx.raw(null, '<bogus-basic>');
    await basic.es('GET', '/', undefined, { expect: 'denied', headers: { Authorization: `Basic ${b64('admin:hunter2')}` } });
    await basic.es('GET', '/_cluster/health', undefined, { expect: 'denied', headers: { Authorization: `Basic ${b64('elastic:changeme')}` } });
    return {};
  },
  expect: () => [
    { name: 'bogus ApiKey -> anonymous_access_denied', source: 'es', risk: 35, min: 2,
      where: `${F.action} == "anonymous_access_denied" AND ${F.keyName} IS NULL AND ${F.userName} IS NULL` },
    { name: 'bogus Basic -> authentication_failed naming the user', source: 'es', risk: 40, min: 2,
      where: `${F.action} == "authentication_failed" AND ${F.outcome} == "failure" AND ${F.userName} IN ("admin", "elastic")` },
    { name: 'bogus Basic -> realm_authentication_failed', source: 'es', risk: 40, min: 2,
      where: `${F.action} == "realm_authentication_failed" AND ${F.outcome} == "failure" AND ${F.userName} IN ("admin", "elastic")` },
  ],
};

/**
 * Which denials Kibana audits depends on where the check happens. The dashboards and spaces APIs
 * authorize at the saved-object layer and emit `<op>` with outcome failure (40). The data views
 * API is refused by the route's feature privilege first, which leaves only an http_request
 * (outcome unknown, 0): a denied data-view write never reaches the failure panels.
 */
const kbWrites = {
  id: 'failures.kibana-write-denied',
  title: 'Read-only contractor attempts Kibana writes',
  personas: ['contractor', 'analyst'],
  weights: [40, 25, 30],
  cadenceMin: 120,
  async run(ctx) {
    const t = tag(ctx.runId);
    const dash = `${OWN}db-${t}`, newDash = `${OWN}dbx-${t}`, dv = `${OWN}dvx-${t}`, space = `${OWN}sp-${t}`;
    const analyst = ctx.as('analyst'), c = ctx.as('contractor');
    const made = await analyst.kb('PUT', `/api/dashboards/${dash}`, { title: dash }, { expect: [200, 201, 404] });
    if (made.status === 404) return { skipped: 'dashboards API absent' };
    await c.kb('DELETE', `/api/dashboards/${dash}`, undefined, { expect: 'denied' });
    await c.kb('PUT', `/api/dashboards/${dash}`, { title: `${dash}-renamed` }, { expect: 'denied' });
    // PUT with our own id, not POST: a POST that regressed to 2xx would leave a dashboard under a
    // server-generated id that no syn- prefix cleanup could find.
    await c.kb('PUT', `/api/dashboards/${newDash}`, { title: newDash }, { expect: 'denied' });
    await c.kb('POST', '/api/spaces/space', { id: space, name: space, disabledFeatures: [] }, { expect: 'denied' });
    await c.kb('POST', '/api/data_views/data_view', { data_view: { id: dv, title: 'syn-*', name: dv } }, { expect: 'denied' });
    await analyst.kb('DELETE', `/api/dashboards/${dash}`, undefined, { expect: 'ok' });
    return { dash, newDash, dv, space };
  },
  expect: ({ dash, newDash, dv, space }) => {
    const kbFail = (name, action, where) => ({ name, source: 'kb', risk: 40,
      where: `${F.action} == ${lit(action)} AND ${F.outcome} == "failure" AND ${where}` });
    return [
      kbFail('denied dashboard delete', 'saved_object_delete', `${F.soId} == ${lit(dash)}`),
      kbFail('denied dashboard update', 'saved_object_update', `${F.soId} == ${lit(dash)}`),
      kbFail('denied dashboard create', 'saved_object_create', `${F.soId} == ${lit(newDash)} AND ${F.soName} == ${lit(newDash)}`),
      kbFail('denied space create', 'space_create', `${F.soId} == ${lit(space)}`),
      // Observed: only an http_request (outcome unknown, url.original without query string), so
      // nothing run-unique to assert on. Kept as a finding until Kibana audits route-level denials.
      { name: 'denied data view create audited as a failure', source: 'kb', kind: 'finding', risk: 40,
        where: `${F.outcome} == "failure" AND ${F.soId} == ${lit(dv)}` },
      { name: 'analyst created the target', source: 'kb', risk: 25,
        where: `${F.action} == "saved_object_create" AND ${F.outcome} == "unknown" AND ${F.soId} == ${lit(dash)}` },
      { name: 'analyst deleted the target', source: 'kb', risk: 30,
        where: `${F.action} == "saved_object_delete" AND ${F.outcome} == "unknown" AND ${F.soId} == ${lit(dash)}` },
    ];
  },
  async cleanup({ kb, act, assertOwned }) {
    const v = { 'Elastic-Api-Version': '2023-10-31' };
    const stale = [];
    for (let page = 1; page <= 50; page++) {
      const res = await kb.raw(`/api/dashboards?query=${OWN}&per_page=100&page=${page}`, { headers: v });
      const data = res.body?.data || [];
      stale.push(...data.map((d) => String(d.id)).filter((id) => id.startsWith(OWN)));
      if (data.length < 100) break;
    }
    for (const id of stale) {
      await act(`dashboard ${id}`, () => kb.raw(`/api/dashboards/${assertOwned(id)}`, { method: 'DELETE', headers: v }));
    }
    const dvs = await kb.raw('/api/data_views');
    for (const d of dvs.body?.data_view || []) {
      if (!String(d.id).startsWith(OWN)) continue;
      await act(`data view ${d.id}`, () => kb.raw(`/api/data_views/data_view/${assertOwned(d.id)}`, { method: 'DELETE' }));
    }
    const spaces = await kb.raw('/api/spaces/space');
    for (const s of (Array.isArray(spaces.body) ? spaces.body : []).filter((x) => x.id.startsWith(OWN))) {
      await act(`space ${s.id}`, () => kb.raw(`/api/spaces/space/${assertOwned(s.id)}`, { method: 'DELETE' }));
    }
  },
};

export default [probe, overreach, scanner, bogus, kbWrites];
