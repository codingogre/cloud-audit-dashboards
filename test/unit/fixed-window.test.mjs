/**
 * 1.0.5.1 fixed-window Vega: vega/08, 09, 12 and 13 are ES|QL specs on a panel with its own time range
 * (VEGA_WINDOWS in panels.mjs), so they follow the identity dropdowns and still ignore the picker. No network:
 * the queries' numbers are checked live against the old DSL forms (HANDOFF), and --lint runs them over the window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VEGA_WINDOWS, windowMs, fixedWindow, vega, TIME, TIME_ONLY, IDENTITY_WHERE, CLIENT_IP_WHERE, PROJECT_WHERE, HOUR_AGO, flatPanels } from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { checkLayout, checkTwoDatasets } from '../../scripts/lib/layout.mjs';
import { PARAMS, gatherDsl } from '../../scripts/esql.mjs';
import { ROOT, objId } from '../../scripts/lib/env.mjs';

const spec = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8'));
const esqlUrls = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => esqlUrls(n, out));
  else if (node && typeof node === 'object') {
    if (node.url?.['%type%'] === 'esql') out.push(node);
    Object.values(node).forEach((v) => esqlUrls(v, out));
  }
  return out;
};

test('the four fixed windows: 7 days for Actor 360\'s baseline row, 24 hours for the session timeline', () => {
  assert.deepEqual(Object.keys(VEGA_WINDOWS).sort(), ['08-actor-baseline-band', '09-activity-punchcard', '12-actor-cohort', '13-session-gantt']);
  assert.equal(windowMs(VEGA_WINDOWS['08-actor-baseline-band']), 7 * 864e5);
  assert.equal(windowMs(VEGA_WINDOWS['13-session-gantt']), 864e5);
  assert.equal(windowMs({ from: 'now-15m', to: 'now' }), 900e3);
  // A rounded or absolute range would badge as a long string, or mean something else to the linters.
  for (const bad of [{ from: 'now-167h/h', to: 'now' }, { from: 'now-7d', to: 'now-1m' }, { from: '2026-10-01T00:00:00Z', to: 'now' }]) {
    assert.throws(() => windowMs(bad), /fixed window/);
  }
  assert.equal(fixedWindow('vega/12-actor-cohort.json'), VEGA_WINDOWS['12-actor-cohort']);
  assert.equal(fixedWindow('12-actor-cohort'), VEGA_WINDOWS['12-actor-cohort']);
  assert.equal(fixedWindow('vega/07-noise-ratio-stream.json'), undefined);
  assert.equal(fixedWindow('dashboards/07-actor-360'), undefined);
});

test('vega() puts the window on the panel, and only for a VEGA_WINDOWS spec', () => {
  const p = vega(0, 0, 16, 14, '09-activity-punchcard', 't', 'd');
  assert.deepEqual(p.config.time_range, { from: 'now-7d', to: 'now' });
  assert.notEqual(p.config.time_range, VEGA_WINDOWS['09-activity-punchcard'], 'a copy, so a caller cannot edit the table');
  assert.equal(vega(0, 0, 16, 14, '07-noise-ratio-stream', 't', 'd').config.time_range, undefined);
});

test('every panel showing a fixed-window spec carries its window, on Actor 360 and Kibana Objects', () => {
  const seen = {};
  for (const [name, d] of Object.entries(buildAll())) {
    for (const p of flatPanels(d.panels)) {
      for (const ref of Object.keys(VEGA_WINDOWS)) {
        if (p.config?.ref_id !== objId('vega', ref)) continue;
        assert.deepEqual(p.config.time_range, VEGA_WINDOWS[ref], `${name} ${ref}`);
        (seen[ref] ??= []).push(name);
      }
      if (p.config?.time_range) assert.ok(Object.keys(VEGA_WINDOWS).some((r) => p.config.ref_id === objId('vega', r)), `${name}: ${p.id} has a range of its own`);
    }
  }
  assert.deepEqual(seen['13-session-gantt'].sort(), ['02-kibana-objects', '07-actor-360']);
  for (const r of ['08-actor-baseline-band', '09-activity-punchcard', '12-actor-cohort']) assert.deepEqual(seen[r], ['07-actor-360'], r);
});

test('the layout check fails a stray panel range and a range that differs from VEGA_WINDOWS', () => {
  const all = buildAll();
  const a360 = flatPanels(all['07-actor-360'].panels);
  a360.find((p) => p.config?.ref_id === objId('vega', '13-session-gantt')).config.time_range = { from: 'now-48h', to: 'now' };
  a360.find((p) => p.config?.ref_id === objId('vega', '11-actor-object-flow')).config.time_range = { from: 'now-7d', to: 'now' };
  const problems = checkLayout(all).problems.join('\n');
  assert.match(problems, /shows vega\/13-session-gantt with time range \{"from":"now-48h"/);
  assert.match(problems, /has its own time range but is not a VEGA_WINDOWS spec/);
  assert.deepEqual(checkLayout(buildAll()).problems, []);
});

test('fixed-window specs are ES|QL bounded by TIME, with no DSL left, and query their window in --lint', () => {
  const dslSrc = new Set(gatherDsl().map((d) => d.src));
  for (const ref of Object.keys(VEGA_WINDOWS)) {
    const s = spec(ref);
    assert.ok(!dslSrc.has(`vega/${ref}.json`), `${ref}: no DSL data source`);
    const urls = esqlUrls(s);
    assert.ok(urls.length > 0, ref);
    for (const d of urls) {
      assert.ok(d.url.query.includes(TIME_ONLY), `${ref} ${d.name}: bounded by the window`);
      assert.equal(d.url['%timefield%'], '@timestamp', `${ref} ${d.name}`);
      assert.equal(d.url.query.startsWith('SET unmapped_fields="nullify";'), d.url.query.includes('api_key.'), `${ref} ${d.name}: nullSafe exactly when it names api_key.* (TIME does)`);
    }
    assert.ok(urls.some((d) => d.url.query.includes(TIME)), `${ref}: something follows the identity dropdowns`);
    const [s0, e0] = PARAMS(`vega/${ref}.json`);
    assert.ok(Math.abs(Date.parse(e0._tend) - Date.parse(s0._tstart) - windowMs(VEGA_WINDOWS[ref])) < 1000, `${ref}: --lint runs it over its own window`);
  }
  const [s1, e1] = PARAMS('vega/07-noise-ratio-stream.json');
  assert.ok(Math.abs(Date.parse(e1._tend) - Date.parse(s1._tstart) - 3600e3) < 1000, 'a picker-bound spec keeps the 1h lint window');
});

test('the hourly specs keep the 168 hours ending with the one filling, keyed the same way', () => {
  for (const ref of ['08-actor-baseline-band', '09-activity-punchcard']) {
    const text = JSON.stringify(spec(ref));
    const q = esqlUrls(spec(ref))[0].url.query;
    assert.ok(q.includes(`BY hour = DATE_TRUNC(1 hour, @timestamp) | EVAL ${HOUR_AGO} | WHERE ago <= 167`), ref);
    assert.ok(text.includes('(floor(now() / 3600000) - datum.ago) * 3600000'), `${ref}: ago 0 is the hour now filling`);
  }
  // 08 reads its 168 hours from a sequence, so an empty selection still prints "No activity …".
  const hours = spec('08-actor-baseline-band').data.find((d) => d.name === 'hours');
  assert.deepEqual(hours.transform[0], { type: 'sequence', start: 0, stop: 168, as: 'ago' });
  assert.equal(hours.transform[1].default, 0);
  assert.deepEqual(spec('09-activity-punchcard').transform[0], { impute: 'doc_count', key: 'ago', keyvals: { start: 0, stop: 168 }, value: 0 });
});

test('the cohort: one selection dataset (pills + all four dropdowns), estate datasets on TIME_ONLY and the Project dropdown, both by project', () => {
  const s = spec('12-actor-cohort');
  const ok = []; checkTwoDatasets('vega/12-actor-cohort.json', s, ok);
  assert.deepEqual(ok, []);
  const urls = Object.fromEntries(esqlUrls(s).map((d) => [d.name, d.url]));
  assert.deepEqual(Object.keys(urls).sort(), ['estate', 'scope', 'whole']);
  assert.equal(urls.scope['%context%'], true);
  for (const n of ['estate', 'whole']) {
    assert.equal(urls[n]['%context%'], undefined, `${n}: no pills or KQL`);
    assert.ok(urls[n].query.includes(`${TIME_ONLY} AND ${PROJECT_WHERE} |`), `${n}: follows the Project dropdown (1.0.5.2)`);
    assert.ok(!urls[n].query.includes(IDENTITY_WHERE) && !urls[n].query.includes(CLIENT_IP_WHERE), `${n}: not narrowed by the other dropdowns`);
  }
  // The guard trips on each way the estate half could quietly become the selection, or lose the Project control.
  const broken = (mutate) => { const c = structuredClone(s); mutate(Object.fromEntries(esqlUrls(c).map((d) => [d.name, d.url]))); const p = []; checkTwoDatasets('x', c, p); return p.join('\n'); };
  assert.match(broken((u) => { u.estate['%context%'] = true; }), /exactly one ES\|QL dataset/);
  assert.match(broken((u) => { u.whole.query = u.whole.query.replace(TIME_ONLY, TIME); }), /exactly one ES\|QL dataset/);
  // An estate that dropped the Project dropdown would rank one project's person against every project again.
  assert.match(broken((u) => { u.estate.query = u.estate.query.replace(` AND ${PROJECT_WHERE}`, ''); }), /exactly one ES\|QL dataset/);
  assert.match(broken((u) => { u.estate.query = u.estate.query.replace('BY project = project.name, ', 'BY '); }), /no estate dataset grouped BY project\.name/);
  assert.match(broken((u) => { u.scope.query = u.scope.query.replace('BY project = project.name, ', 'BY '); }), /selection dataset scope does not group BY project\.name/);
  // The empty states read the same words as before the port.
  assert.ok(JSON.stringify(s).includes("'Only one person with an email' + sp + ' in 7 days'"));
});

test('the session timeline: 12 newest sessions in ms, no-email and multi-space cells handled', () => {
  const s = spec('13-session-gantt');
  const [sess, nos] = ['sessions', 'nosession'].map((n) => s.data.find((d) => d.name === n));
  assert.match(sess.url.query, /BY key = kibana\.session\.id \| SORT ended DESC, key \| LIMIT 12 \| EVAL start = TO_LONG\(started\), end = TO_LONG\(ended\)/);
  assert.match(nos.url.query, /WHERE kibana\.session\.id IS NULL \| STATS t = MAX\(@timestamp\) \| EVAL t = TO_LONG\(t\)/);
  const f = (as) => sess.transform.find((t) => t.as === as).expr;
  const run = (expr, datum) => Function('datum', 'isValid', 'isArray', 'join', `return (${expr});`)(datum, (v) => v !== null && v !== undefined, Array.isArray, (a, sep) => a.join(sep));
  assert.equal(run(f('actor'), {}), 'no email recorded', 'dropNullColumns drops an all-null column: undefined, not null');
  assert.equal(run(f('actor'), { actor: 'a@b.c' }), 'a@b.c');
  assert.equal(run(f('spaceList'), { spaces: ['default', 'syn'] }), 'default, syn');
  assert.equal(run(f('spaceList'), { spaces: 'default' }), 'default', 'one value comes back as a scalar');
  assert.equal(run(f('spaceList'), {}), '');
});
