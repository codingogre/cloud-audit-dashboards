/**
 * Elasticsearch data-plane scenarios (catalogue S01–S07): the volume the dashboards must gate as
 * noise, and the weight-0 reads and index admin that make up the signal they must keep.
 *
 * Every ES expectation is auto-scoped by verify.mjs to this scenario's X-Opaque-Id, so the counts
 * here are this run's calls and nobody else's. `gated` is the complement of the dashboards' own
 * NOISE constant, so the noise assertions break when the gate changes, not when a copy of it does.
 *
 * Writes land only in syn-* indices. Index admin uses a run-unique syn-tmp-* index that run()
 * deletes; HR rows carry employee `syn-<run>` and are removed in-run. cleanup() sweeps both.
 */
import { NOISE } from '../../lib/panels.mjs';
import { F, lit } from '../fields.mjs';

/** True for events the dashboards' NOISE gate removes. */
const gated = `NOT (${NOISE.replace(/^WHERE\s+/, '')})`;
const act = (a) => `${F.esAction} == ${lit(a)}`;
const granted = `${F.action} == "access_granted" AND ${F.outcome} == "success"`;
const touches = (index) => `MV_CONTAINS(${F.indices}, ${lit(index)})`;
/** Any recorded index is dot-prefixed: the same test the 03/07 system-index panels make after MV_EXPAND. */
const dotIndex = `(MV_CONCAT(${F.indices}, "|") LIKE ".*" OR MV_CONCAT(${F.indices}, "|") LIKE "*|.*")`;
/**
 * Every ES event the scenario's calls caused scores 0. The positive expectations only look at what
 * was meant to happen; this one catches what was not, e.g. a `?refresh=true` the role cannot cover
 * turning into an access_denied at 40 while the granted write still passes.
 */
const allZero = { name: 'nothing this scenario caused scores above 0', source: 'es', where: 'true', risk: 0 };
const ndjson = { headers: { 'Content-Type': 'application/x-ndjson' } };
const slug = (runId) => runId.toLowerCase().replace(/^syn-/, '').replace(/[^a-z0-9-]/g, '-');

const healthCheck = {
  id: 'es.healthCheck',
  title: 'SRE health-check loop: infra noise plus authentication volume',
  personas: ['sre'],
  weights: [0],
  cadenceMin: 1,
  /** /_cluster/health, /_cat/health and /_health_report are 410 on serverless (and a 410 is not audited). */
  async run(ctx) {
    const c = ctx.as('sre');
    const n = 3 + ctx.r.int(0, 3);
    for (let i = 0; i < n; i++) await c.es('GET', '/', null, { expect: 'ok' });
    // One index-health read per run: it fans out to ~5 transport actions that all survive NOISE.
    await c.es('GET', '/_cat/indices/syn-*?format=json&h=index,health,docs.count', null, { expect: 'ok' });
    return { n };
  },
  expect: ({ n }) => [
    { name: 'cluster:monitor/main granted', source: 'es', persona: 'sre', where: `${act('cluster:monitor/main')} AND ${granted}`, min: n, risk: 0 },
    { name: 'cluster:monitor/main is removed by NOISE', source: 'es', persona: 'sre', where: `${act('cluster:monitor/main')} AND ${gated}`, min: n, risk: 0 },
    { name: 'index health (_cat/indices -> indices:monitor/stats) survives NOISE', source: 'es', persona: 'sre',
      where: `${act('indices:monitor/stats')} AND ${granted} AND NOT (${gated})`, risk: 0 },
    { name: 'authentication_success per request', source: 'es', persona: 'sre', where: `${F.action} == "authentication_success"`, min: n + 1, risk: 0 },
    allZero,
  ],
};

const bot = {
  id: 'es.bot',
  title: 'High-volume ETL key: bulk ingest, searches, point-in-time',
  personas: ['bot'],
  weights: [0],
  cadenceMin: 1,
  async run(ctx) {
    const c = ctx.as('bot');
    const rounds = 3, searches = 15;
    for (let b = 0; b < rounds; b++) {
      const lines = [];
      for (let i = 0; i < 50; i++) {
        lines.push(JSON.stringify({ index: { _index: 'syn-app-logs' } }));
        lines.push(JSON.stringify({ '@timestamp': new Date().toISOString(), level: ctx.r.pick(['info', 'info', 'warn', 'error']),
          service: 'syn-etl-ingest', message: `${ctx.runId} batch ${b} row ${i}` }));
      }
      await c.es('POST', '/_bulk', lines.join('\n') + '\n', { expect: 'ok', ...ndjson });
    }
    for (let i = 0; i < searches; i++) {
      await c.es('POST', '/syn-orders/_search', { size: 10, query: { term: { region: ctx.r.pick(['us-east', 'us-west', 'eu-west', 'ap-south']) } } }, { expect: 'ok' });
    }
    const pit = await c.es('POST', '/syn-orders/_pit?keep_alive=1m', null, { expect: 'ok' });
    if (pit.body?.id) {
      await c.es('POST', '/_search', { size: 5, pit: { id: pit.body.id, keep_alive: '1m' }, sort: [{ '@timestamp': 'asc' }] }, { expect: 'ok' });
      await c.es('DELETE', '/_pit', { id: pit.body.id }, { expect: 'ok' });
    }
    return { rounds, searches, pit: !!pit.body?.id };
  },
  expect: ({ rounds, searches, pit }) => [
    // One _bulk fans out to bulk + bulk[s] + bulk[s][p], so a bulk* count of `rounds` is met by one call.
    { name: 'bulk shard writes into syn-app-logs granted', source: 'es', persona: 'bot',
      where: `${act('indices:data/write/bulk[s]')} AND ${granted} AND ${touches('syn-app-logs')}`, min: rounds, risk: 0 },
    { name: 'bulk writes survive NOISE (signal)', source: 'es', persona: 'bot', where: `${act('indices:data/write/bulk')} AND NOT (${gated})`, min: rounds, risk: 0 },
    { name: 'searches granted and gated as query noise', source: 'es', persona: 'bot', where: `${act('indices:data/read/search')} AND ${granted} AND ${gated}`, min: searches, risk: 0 },
    ...(pit ? [
      { name: 'point-in-time open/close gated as query noise', source: 'es', persona: 'bot', where: `${F.esAction} LIKE "indices:data/read/*point_in_time" AND ${gated}`, min: 2, risk: 0 },
    ] : []),
    allZero,
  ],
};

const searchBurst = {
  id: 'es.searchBurst',
  title: 'Search-only burst: raises total events, never signal',
  personas: ['analyst'],
  weights: [0],
  cadenceMin: 60,
  async run(ctx) {
    const c = ctx.as('analyst');
    const n = 50;
    for (let i = 0; i < n; i++) await c.es('POST', '/syn-orders/_search', { size: 1, query: { match_all: {} } }, { expect: 'ok' });
    return { n };
  },
  expect: ({ n }) => [
    { name: 'every search is removed by NOISE', source: 'es', persona: 'analyst', where: `${act('indices:data/read/search')} AND ${gated}`, min: n, risk: 0 },
    { name: 'every authentication_success is removed by NOISE', source: 'es', persona: 'analyst', where: `${F.action} == "authentication_success" AND ${gated}`, min: n, risk: 0 },
    allZero,
  ],
};

const analystReads = {
  id: 'es.analystReads',
  title: 'Analyst reads: get, mget, mapping, field caps, ES|QL sync and async',
  personas: ['analyst'],
  weights: [0],
  cadenceMin: 3,
  async run(ctx) {
    const c = ctx.as('analyst');
    const id = String(ctx.r.int(1, 200)).padStart(5, '0');
    await c.es('GET', `/syn-orders/_doc/${id}`, null, { expect: 'ok' });
    await c.es('POST', '/_mget', { docs: [{ _index: 'syn-orders', _id: id }, { _index: 'syn-invoices', _id: id }] }, { expect: 'ok' });
    await c.es('GET', '/syn-orders,syn-invoices/_mapping', null, { expect: 'ok' });
    await c.es('GET', '/syn-orders,syn-invoices/_field_caps?fields=*', null, { expect: 'ok' });
    await c.es('POST', '/syn-orders,syn-invoices/_count', { query: { match_all: {} } }, { expect: 'ok' });
    await c.es('POST', '/_query', { query: 'FROM syn-orders | STATS n = COUNT(*) BY status | SORT n DESC' }, { expect: 'ok' });
    const a = await c.es('POST', '/_query/async', {
      query: 'FROM syn-invoices | STATS total = SUM(amount) BY paid', wait_for_completion_timeout: '5s', keep_on_completion: false,
    }, { expect: 'ok' });
    if (a.body?.id) await c.es('DELETE', `/_query/async/${a.body.id}`, null, { expect: [200, 404] });
    return { id };
  },
  expect: () => [
    { name: 'get on syn-orders', source: 'es', persona: 'analyst', where: `${act('indices:data/read/get')} AND ${granted} AND ${touches('syn-orders')}`, risk: 0 },
    // The top-level mget records no indices; its per-shard children name each index.
    { name: 'mget reached syn-invoices', source: 'es', persona: 'analyst', where: `${act('indices:data/read/mget[shard]')} AND ${granted} AND ${touches('syn-invoices')}`, risk: 0 },
    { name: 'mapping read', source: 'es', persona: 'analyst', where: `${act('indices:admin/mappings/get')} AND ${granted} AND ${touches('syn-invoices')}`, risk: 0 },
    { name: 'ES|QL requests', source: 'es', persona: 'analyst', where: `${act('indices:data/read/esql')} AND ${granted}`, min: 2, risk: 0 },
    { name: 'async ES|QL read syn-invoices', source: 'es', persona: 'analyst', where: `${F.esAction} LIKE "indices:data/read/esql/*" AND ${granted} AND ${touches('syn-invoices')}`, risk: 0 },
    // get, get[s], mget, 2x mget[shard], 2x mget[shard][s], mapping, field_caps, 2x esql: >= 11 stable signal events.
    { name: 'reads survive NOISE (signal)', source: 'es', persona: 'analyst', where: `${F.action} == "access_granted" AND NOT (${gated})`, min: 10, risk: 0 },
    allZero,
  ],
};

const sreIndexAdmin = {
  id: 'es.sreIndexAdmin',
  title: 'SRE index admin: create, mapping, doc, delete a run-unique index',
  personas: ['sre'],
  weights: [0],
  cadenceMin: 15,
  async run(ctx) {
    const c = ctx.as('sre');
    // Loop mode keeps one runId for 12h: a time component keeps 48 runs/day from drawing the same name.
    const index = `syn-tmp-${slug(ctx.runId)}-${Date.now().toString(36)}${ctx.r.int(10, 99)}`;
    await c.es('PUT', `/${index}`, { mappings: { properties: { '@timestamp': { type: 'date' } } } }, { expect: 'ok' });
    await c.es('PUT', `/${index}/_mapping`, { properties: { note: { type: 'keyword' } } }, { expect: 'ok' });
    await c.es('POST', `/${index}/_doc?refresh=true`, { '@timestamp': new Date().toISOString(), note: ctx.runId }, { expect: 'ok' });
    await c.es('GET', '/_cat/indices/syn-*?format=json', null, { expect: 'ok' });
    await c.es('DELETE', `/${index}`, null, { expect: 'ok' });
    return { index };
  },
  expect: ({ index }) => [
    { name: 'index create', source: 'es', persona: 'sre', where: `${act('indices:admin/create')} AND ${granted} AND ${touches(index)}`, risk: 0 },
    { name: 'mapping put', source: 'es', persona: 'sre', where: `${F.esAction} LIKE "indices:admin/mapping/put*" AND ${granted} AND ${touches(index)}`, risk: 0 },
    { name: 'document write', source: 'es', persona: 'sre', where: `${F.esAction} LIKE "indices:data/write/*" AND ${granted} AND ${touches(index)}`, risk: 0 },
    { name: 'index delete', source: 'es', persona: 'sre', where: `${act('indices:admin/delete')} AND ${granted} AND ${touches(index)}`, risk: 0 },
    allZero,
  ],
  async cleanup({ es, act: step, assertOwned }) {
    const r = await es.raw('/_resolve/index/syn-tmp-*?expand_wildcards=open,closed');
    for (const i of r.body?.indices || []) {
      await step(`index ${i.name}`, () => es.raw(`/${assertOwned(i.name)}`, { method: 'DELETE' }));
    }
  },
};

const hrDataOwner = {
  id: 'es.hrDataOwner',
  title: 'HR data owner: the only identity touching syn-hr-salaries',
  personas: ['hr'],
  weights: [0],
  cadenceMin: 10,
  async run(ctx) {
    const c = ctx.as('hr');
    const employee = `syn-${slug(ctx.runId)}`;
    const put = await c.es('POST', '/syn-hr-salaries/_doc',
      { employee, department: ctx.r.pick(['eng', 'sales', 'finance', 'ops']), salary: 60000 + ctx.r.int(0, 140000), band: 'L4' }, { expect: 'ok' });
    const id = put.body?._id;
    if (id) {
      await c.es('GET', `/syn-hr-salaries/_doc/${id}`, null, { expect: 'ok' });
      await c.es('DELETE', `/syn-hr-salaries/_doc/${id}`, null, { expect: 'ok' });
    }
    return { employee };
  },
  expect: () => [
    // A single _doc write fans out to 3+ write/* events, so a write/* count proves nothing about the delete.
    { name: 'document create in syn-hr-salaries', source: 'es', persona: 'hr', where: `${act('indices:data/write/index:op_type/create')} AND ${granted} AND ${touches('syn-hr-salaries')}`, risk: 0 },
    { name: 'read from syn-hr-salaries', source: 'es', persona: 'hr', where: `${act('indices:data/read/get')} AND ${granted} AND ${touches('syn-hr-salaries')}`, risk: 0 },
    { name: 'document delete in syn-hr-salaries', source: 'es', persona: 'hr', where: `${act('indices:data/write/delete')} AND ${granted} AND ${touches('syn-hr-salaries')}`, risk: 0 },
    allZero,
  ],
  async cleanup({ es, act: step, assertOwned, only }) {
    const index = assertOwned('syn-hr-salaries');
    // `only` (a run tag) narrows the sweep to one run's rows; without it every synthetic row goes.
    const prefix = only ? `syn-${only}` : 'syn-';
    const q = { query: { prefix: { employee: prefix } } };
    const r = await es.raw(`/${index}/_count`, { method: 'POST', body: q });
    if (r.body?.count > 0) {
      await step(`${index}: ${r.body.count} docs with employee ${prefix}*`,
        () => es.raw(`/${index}/_delete_by_query?refresh=true`, { method: 'POST', body: q }));
    }
  },
};

const systemIndexRead = {
  id: 'es.systemIndexRead',
  title: 'Granted read of hidden .alerts-* system indices',
  personas: ['sre'],
  weights: [0],
  cadenceMin: 30,
  async run(ctx) {
    const c = ctx.as('sre');
    const s = await c.es('GET', '/.alerts-*/_search?size=1&expand_wildcards=all', null, { expect: [200, 403, 404] });
    if (s.status === 403) return { skipped: '.alerts-* read is not grantable to an API key on this project' };
    // A wildcard that matches nothing is a 200 over zero shards, not a 404 (allow_no_indices).
    if (s.status === 404 || !(s.body?._shards?.total > 0)) return { skipped: 'no .alerts-* indices exist yet' };
    await c.es('GET', '/.alerts-*/_field_caps?fields=@timestamp&expand_wildcards=all', null, { expect: 'ok' });
    return {};
  },
  expect: () => [
    { name: '.alerts-* data streams read (not only .ds- backing indices)', source: 'es', persona: 'sre',
      where: `${granted} AND CONCAT("|", MV_CONCAT(${F.indices}, "|")) LIKE "*|.alerts-*"`, min: 2, risk: 0 },
    { name: 'system field_caps survives NOISE (the _search itself is gated)', source: 'es', persona: 'sre',
      where: `${act('indices:data/read/field_caps')} AND ${granted} AND ${dotIndex} AND NOT (${gated})`, risk: 0 },
    allZero,
  ],
};

export default [healthCheck, bot, searchBurst, analystReads, sreIndexAdmin, hrDataOwner, systemIndexRead];
