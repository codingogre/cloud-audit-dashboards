/**
 * Kibana saved-object lifecycles: data views, dashboards, tags, and the same work across spaces.
 *
 * Kibana audits saved-object CUD as saved_object_create/update/delete with outcome "unknown" (the
 * call is logged before it runs), reads as saved_object_resolve/get, and populates
 * kibana.saved_object.{id,type,name} on all of them. It does not record our X-Opaque-Id and a
 * persona key leaves no api_key.name on Kibana events, so every expectation here is scoped by an
 * object id that only this run can have generated.
 *
 * Ids are chosen by the generator (`syn-<kind>-<runId>`) wherever the API accepts one, so cleanup
 * can find leftovers by prefix. Tags are the exception: the tagging API mints a UUID, so their
 * NAME carries the prefix and cleanup matches on that.
 *
 * Tagging has no public API on serverless: /api/saved_objects_tagging/* exists but answers 400
 * "not available with the current configuration" unless called as Kibana's own UI does, with
 * `x-elastic-internal-origin`. That is the path the UI takes, so it is the path a human's tag edit
 * would audit under.
 */
import { F, lit } from '../fields.mjs';
import { SPACES } from '../personas.mjs';

const INTERNAL = { 'x-elastic-internal-origin': 'Kibana' };
const ALL_SPACES = ['default', ...SPACES];
const kbPath = (space, p) => (space && space !== 'default' ? `/s/${space}${p}` : p);

const so = (type, id) => `${F.soType} == ${lit(type)} AND ${F.soId} == ${lit(id)}`;
const act = (...a) => (a.length === 1 ? `${F.action} == ${lit(a[0])}` : `${F.action} IN (${a.map(lit).join(', ')})`);
// A GET is audited as saved_object_resolve. saved_object_get is NOT a read signal: dashboard
// update/delete emit their own gets, so matching it would let the read expectation pass vacuously.
const READ = 'saved_object_resolve';

/** create / read / update / delete expectations for one object, with the dashboards' weights. */
const lifecycle = (type, id, label, { space, name, readMin = 1 } = {}) => {
  const at = space ? ` AND ${F.space} == ${lit(space)}` : '';
  return [
    { name: `${label}: create`, source: 'kb', risk: 25,
      where: `${so(type, id)} AND ${act('saved_object_create')} AND ${F.outcome} == "unknown" AND ${F.evtype} == "creation"${at}${name ? ` AND ${F.soName} == ${lit(name)}` : ''}` },
    { name: `${label}: read`, source: 'kb', risk: 0, min: readMin, where: `${so(type, id)} AND ${act(READ)}${at}` },
    { name: `${label}: update`, source: 'kb', risk: 25,
      where: `${so(type, id)} AND ${act('saved_object_update')} AND ${F.evtype} == "change"${at}` },
    { name: `${label}: delete`, source: 'kb', risk: 30,
      where: `${so(type, id)} AND ${act('saved_object_delete')} AND ${F.evtype} == "deletion"${at}` },
  ];
};

/** Run-unique, prefixed, and safe for assertOwned (no whitespace). */
const ids = (runId) => ({
  dv: `syn-dv-${runId}`, dvName: `syn-invoices-${runId}`,
  dash: `syn-dash-${runId}`, dashTitle: `syn-q4-plan-${runId}`,
  tagName: `syn-tag-${runId}`,
  dvFin: `syn-dvfin-${runId}`, dashMkt: `syn-dashmkt-${runId}`,
});

const dataView = {
  id: 'kibanaObjects.dataView',
  title: 'Data view lifecycle (index-pattern create / read / update / delete)',
  personas: ['analyst'],
  weights: [25, 0, 25, 30],
  cadenceMin: 30,
  async run(ctx) {
    const k = ids(ctx.runId);
    const a = ctx.as('analyst');
    // The default space's config is not ours to touch. If it has no default data view, the
    // analyst's create would 400 on the implied config write (see ensureDefaultDataView), so the
    // lifecycle moves to a syn- space we may pin instead of depending on default-space state.
    const d = await a.kb('GET', '/api/data_views/default', null, { expect: [200, 404] });
    if (d.status === 404) return { skipped: 'data views API absent (404)' };
    const space = d.body?.data_view_id ? 'default' : SPACES[1];
    if (space !== 'default') await ensureDefaultDataView(ctx.adminKb, space);
    await a.kb('POST', '/api/data_views/data_view',
      { data_view: { id: k.dv, title: 'syn-invoices*', name: k.dvName } }, { expect: 'ok', space });
    await a.kb('GET', `/api/data_views/data_view/${k.dv}`, null, { expect: 'ok', space });
    await a.kb('POST', `/api/data_views/data_view/${k.dv}`, { data_view: { name: `${k.dvName}-v2` } }, { expect: 'ok', space });
    await a.kb('DELETE', `/api/data_views/data_view/${k.dv}`, null, { expect: 'ok', space });
    return { id: k.dv, name: k.dvName, space };
  },
  // Data view update resolves the object internally first, so the GET is the SECOND resolve.
  expect: (f) => lifecycle('index-pattern', f.id, 'data view', { name: f.name, space: f.space, readMin: 2 }),
  cleanup: (t) => cleanDataViews(t),
};

const dashboard = {
  id: 'kibanaObjects.dashboard',
  title: 'Dashboard lifecycle via the Dashboards API',
  personas: ['analyst'],
  weights: [25, 0, 25, 30],
  cadenceMin: 60,
  async run(ctx) {
    const k = ids(ctx.runId);
    const a = ctx.as('analyst');
    // PUT /api/dashboards/{id} is an upsert and the only form that takes our id; POST mints a UUID.
    const c = await a.kb('PUT', `/api/dashboards/${k.dash}`, { title: k.dashTitle, panels: [] }, { expect: [200, 201, 404] });
    if (c.status === 404) return { skipped: 'Dashboards API absent (404)' };
    await a.kb('GET', `/api/dashboards/${k.dash}`, null, { expect: 'ok' });
    await a.kb('PUT', `/api/dashboards/${k.dash}`, { title: `${k.dashTitle}-v2`, panels: [] }, { expect: 'ok' });
    await a.kb('DELETE', `/api/dashboards/${k.dash}`, null, { expect: 'ok' });
    return { id: k.dash, title: k.dashTitle };
  },
  expect: (f) => lifecycle('dashboard', f.id, 'dashboard', { name: f.title, space: 'default' }),
  cleanup: (t) => cleanDashboards(t),
};

const tag = {
  id: 'kibanaObjects.tag',
  title: 'Tag create / rename / delete (saved-objects tagging)',
  personas: ['analyst'],
  weights: [25, 25, 30],
  cadenceMin: 240,
  async run(ctx) {
    const k = ids(ctx.runId);
    const a = ctx.as('analyst');
    const o = { headers: INTERNAL };
    const c = await a.kb('POST', '/api/saved_objects_tagging/tags/create',
      { name: k.tagName, description: 'synthetic', color: '#D36086' }, { ...o, expect: [200, 400, 404] });
    if (c.status !== 200) return { skipped: `tagging API unavailable (${c.status}: ${String(c.body?.message).slice(0, 120)})` };
    const id = c.body?.tag?.id;
    if (!id) return { skipped: 'tag create returned no id' }; // cleanup still finds it by name
    await a.kb('POST', `/api/saved_objects_tagging/tags/${id}`, { name: `${k.tagName}-v2`, description: 'synthetic', color: '#54B399' }, { ...o, expect: 'ok' });
    await a.kb('DELETE', `/api/saved_objects_tagging/tags/${id}`, null, { ...o, expect: 'ok' });
    return { id, name: k.tagName };
  },
  expect: (f) => {
    const [create, , update, del] = lifecycle('tag', f.id, 'tag', { name: f.name });
    return [create, update, del];
  },
  cleanup: (t) => cleanTags(t),
};

const crossSpace = {
  id: 'kibanaObjects.crossSpace',
  title: 'Cross-space work in syn-finance and syn-marketing',
  personas: ['analyst'],
  weights: [0, 25, 30],
  cadenceMin: 15,
  async run(ctx) {
    const k = ids(ctx.runId);
    const a = ctx.as('analyst');
    const [fin, mkt] = SPACES;
    await ensureDefaultDataView(ctx.adminKb, fin);
    await a.kb('GET', '/api/data_views', null, { expect: 'ok' });
    await a.kb('GET', '/api/data_views', null, { expect: 'ok', space: fin });
    await a.kb('POST', '/api/data_views/data_view',
      { data_view: { id: k.dvFin, title: 'syn-invoices*', name: k.dvFin } }, { expect: 'ok', space: fin });
    await a.kb('GET', `/api/data_views/data_view/${k.dvFin}`, null, { expect: 'ok', space: fin });
    await a.kb('PUT', `/api/dashboards/${k.dashMkt}`, { title: k.dashMkt, panels: [] }, { expect: 'ok', space: mkt });
    await a.kb('GET', `/api/dashboards/${k.dashMkt}`, null, { expect: 'ok', space: mkt });
    // The same id from the wrong space is a 404: objects are space-isolated.
    await a.kb('GET', `/api/dashboards/${k.dashMkt}`, null, { expect: 'absent', space: fin });
    await a.kb('DELETE', `/api/data_views/data_view/${k.dvFin}`, null, { expect: 'ok', space: fin });
    await a.kb('DELETE', `/api/dashboards/${k.dashMkt}`, null, { expect: 'ok', space: mkt });
    return { dvFin: k.dvFin, dashMkt: k.dashMkt, fin, mkt };
  },
  expect: (f) => [
    { name: 'finance: data view created in syn-finance', source: 'kb', risk: 25,
      where: `${so('index-pattern', f.dvFin)} AND ${act('saved_object_create')} AND ${F.space} == ${lit(f.fin)}` },
    { name: 'finance: data view read in syn-finance', source: 'kb', risk: 0,
      where: `${so('index-pattern', f.dvFin)} AND ${act(READ)} AND ${F.space} == ${lit(f.fin)}` },
    { name: 'finance: data view deleted in syn-finance', source: 'kb', risk: 30,
      where: `${so('index-pattern', f.dvFin)} AND ${act('saved_object_delete')} AND ${F.space} == ${lit(f.fin)}` },
    { name: 'marketing: dashboard created in syn-marketing', source: 'kb', risk: 25,
      where: `${so('dashboard', f.dashMkt)} AND ${act('saved_object_create')} AND ${F.space} == ${lit(f.mkt)}` },
    { name: 'marketing: dashboard read in syn-marketing', source: 'kb', risk: 0,
      where: `${so('dashboard', f.dashMkt)} AND ${act(READ)} AND ${F.space} == ${lit(f.mkt)}` },
    { name: 'marketing: dashboard deleted in syn-marketing', source: 'kb', risk: 30,
      where: `${so('dashboard', f.dashMkt)} AND ${act('saved_object_delete')} AND ${F.space} == ${lit(f.mkt)}` },
    // Observed: the wrong-space GET answers 404 but is audited as resolve outcome "success" with no
    // saved_object.name, so a cross-space probe never shows as a failure (audit-fidelity gap, observed live).
    { name: 'finance: wrong-space dashboard lookup audited as resolve "success"', source: 'kb', risk: 0,
      where: `${act(READ)} AND ${F.outcome} == "success" AND ${F.space} == ${lit(f.fin)} AND ${F.msg} LIKE ${lit(`*dashboard [id=${f.dashMkt}]*`)}` },
  ],
  // Removed inline on success; a run that dies midway leaves them in the syn-* spaces, which these sweep.
  cleanup: async (t) => { await cleanDataViews(t); await cleanDashboards(t); },
};

const KBH = { 'Elastic-Api-Version': '2023-10-31' };

/**
 * The first data view created in a space with no default data view also tries to make itself the
 * default, which is an advanced-settings write: the analyst gets 400 "Unable to update config"
 * even though the data view itself WAS created. A real analyst in a fresh space hits the same thing.
 * The admin pins a default first; Kibana does not require the id to resolve, so nothing is created.
 */
async function ensureDefaultDataView(kb, space) {
  const cur = await kb.raw(kbPath(space, '/api/data_views/default'), { headers: KBH });
  if (cur.body?.data_view_id) return;
  await kb.raw(kbPath(space, '/api/data_views/default'), {
    method: 'POST', headers: KBH, body: { data_view_id: `syn-${space.replace(/^syn-/, '')}-default`, force: true },
  });
}

/* ---------------------------------------------------------------- cleanup: prefix-only */

async function cleanDataViews({ kb, act: a, assertOwned }) {
  for (const space of ALL_SPACES) {
    const r = await kb.raw(kbPath(space, '/api/data_views'), { headers: KBH });
    for (const dv of (r.body?.data_view || []).filter((x) => x.id?.startsWith('syn-'))) {
      await a(`data view ${space}/${dv.id}`, () =>
        kb.raw(kbPath(space, `/api/data_views/data_view/${assertOwned(dv.id)}`), { method: 'DELETE', headers: KBH }));
    }
  }
}

async function cleanDashboards({ kb, act: a, assertOwned }) {
  for (const space of ALL_SPACES) {
    const found = [];
    for (let page = 1; page <= 50; page++) {
      const r = await kb.raw(kbPath(space, `/api/dashboards?per_page=100&page=${page}`), { headers: KBH });
      const data = r.body?.data || [];
      found.push(...data.filter((d) => d.id?.startsWith('syn-')));
      if (data.length < 100) break;
    }
    for (const d of found) {
      await a(`dashboard ${space}/${d.id}`, () =>
        kb.raw(kbPath(space, `/api/dashboards/${assertOwned(d.id)}`), { method: 'DELETE', headers: KBH }));
    }
  }
}

async function cleanTags({ kb, act: a, assertOwned }) {
  const r = await kb.raw('/api/saved_objects_tagging/tags', { headers: { ...KBH, ...INTERNAL } });
  for (const t of (r.body?.tags || []).filter((x) => x.name?.startsWith('syn-'))) {
    assertOwned(t.name);
    await a(`tag ${t.name} (${t.id})`, () =>
      kb.raw(`/api/saved_objects_tagging/tags/${encodeURIComponent(t.id)}`, { method: 'DELETE', headers: { ...KBH, ...INTERNAL } }));
  }
}

export default [dataView, dashboard, tag, crossSpace];
