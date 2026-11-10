/**
 * 1.0.8.2 windows ending at the picker's end: vega/08, 09, 12 and 13 read the events view, bounded by 7 days (24 hours
 * for 13) back from ?_tend, so they follow the identity dropdowns AND the picker's end. No panel carries a range of its
 * own, and the specs show no wall-clock time. No network: --lint runs the queries and asks get_timefield about them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  END_WINDOWS, endWindowOf, endWindow, endWindowOnly, ANCHOR_QUERY, vega, IDENTITY_WHERE, CLIENT_IP_WHERE, PROJECT_WHERE,
  CONTROLS_WHERE, HOUR_AGO, flatPanels, VIEW_TIME,
} from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { checkLayout, checkTwoDatasets, checkEndWindowSpec, checkEscape } from '../../scripts/lib/layout.mjs';
import { gatherDsl, gatherQueries, bounded } from '../../scripts/esql.mjs';
import { ROOT, objId, DEFAULT_VIEW } from '../../scripts/lib/env.mjs';

const spec = (ref) => JSON.parse(readFileSync(join(ROOT, 'vega', `${ref}.json`), 'utf8'));
const esqlUrls = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => esqlUrls(n, out));
  else if (node && typeof node === 'object') {
    if (node.url?.['%type%'] === 'esql') out.push(node);
    Object.values(node).forEach((v) => esqlUrls(v, out));
  }
  return out;
};
const problemsOf = (ref, s) => { const p = []; checkEndWindowSpec(`vega/${ref}.json`, s, p); checkEscape(`vega/${ref}.json`, s, p); return p.join('\n'); };

test('the four windows: 7 days for Identity 360\'s baseline row, 24 hours for the session timeline', () => {
  assert.deepEqual(END_WINDOWS, { '08-actor-baseline-band': '7 days', '09-activity-punchcard': '7 days', '12-actor-cohort': '7 days', '13-session-gantt': '24 hours' });
  assert.equal(endWindowOf('vega/12-actor-cohort.json'), '7 days');
  assert.equal(endWindowOf('13-session-gantt'), '24 hours');
  assert.equal(endWindowOf('vega/07-noise-ratio-stream.json'), undefined);
  assert.equal(endWindowOf('dashboards/07-actor-360'), undefined);
  // Wrapped params only: a bare `event_time <= ?_tend` would make Kibana filter event_time to the picker's range.
  assert.equal(endWindowOnly('7 days'), `WHERE ${VIEW_TIME} <= TO_DATETIME(?_tend) AND ${VIEW_TIME} > TO_DATETIME(?_tend) - 7 days`);
  assert.equal(endWindow('24 hours'), `${endWindowOnly('24 hours')} AND ${CONTROLS_WHERE}`);
});

test('no panel carries a time range of its own, and the specs still sit on both pages', () => {
  assert.equal(vega(0, 0, 16, 14, '09-activity-punchcard', 't', 'd').config.time_range, undefined);
  const seen = {};
  for (const [name, d] of Object.entries(buildAll())) {
    for (const p of flatPanels(d.panels)) {
      assert.equal(p.config?.time_range, undefined, `${name}: ${p.id} has a range of its own`);
      for (const ref of Object.keys(END_WINDOWS)) if (p.config?.ref_id === objId('vega', ref)) (seen[ref] ??= []).push(name);
    }
  }
  assert.deepEqual(seen['13-session-gantt'].sort(), ['02-kibana-objects', '07-actor-360']);
  for (const r of ['08-actor-baseline-band', '09-activity-punchcard', '12-actor-cohort']) assert.deepEqual(seen[r], ['07-actor-360'], r);
});

test('the layout check fails a panel range', () => {
  const all = buildAll();
  flatPanels(all['07-actor-360'].panels).find((p) => p.config?.ref_id === objId('vega', '13-session-gantt')).config.time_range = { from: 'now-24h', to: 'now' };
  assert.match(checkLayout(all).problems.join('\n'), /has its own time range/);
  assert.deepEqual(checkLayout(buildAll()).problems, []);
});

test('each spec reads the view, bounded back from ?_tend, with no DSL, no %timefield% and no ?_tstart', () => {
  const dslSrc = new Set(gatherDsl().map((d) => d.src));
  for (const [ref, span] of Object.entries(END_WINDOWS)) {
    const s = spec(ref);
    assert.equal(problemsOf(ref, s), '', ref);
    assert.ok(!dslSrc.has(`vega/${ref}.json`), `${ref}: no DSL data source`);
    const urls = esqlUrls(s).filter((d) => d.url.query !== ANCHOR_QUERY);
    assert.ok(urls.length > 0, ref);
    for (const d of urls) {
      const q = d.url.query;
      assert.match(q, new RegExp(`^(SET unmapped_fields="nullify"; )?FROM ${DEFAULT_VIEW} \\| ${endWindowOnly(span).replace(/[()?|.*+]/g, '\\$&')}`), `${ref} ${d.name}`);
      assert.equal(d.url['%timefield%'], undefined, `${ref} ${d.name}`);
      assert.ok(!q.includes('?_tstart') && !q.includes('@timestamp'), `${ref} ${d.name}`);
      assert.equal(q.startsWith('SET unmapped_fields="nullify";'), q.includes('api_key.'), `${ref} ${d.name}: nullSafe exactly when it names api_key.*`);
      // bounded() must leave it alone: it bounds itself on the view's time column.
      assert.equal(bounded(q), q, `${ref} ${d.name}`);
    }
    assert.ok(urls.some((d) => d.url.query.includes(endWindow(span)) && d.url['%context%'] === true), `${ref}: something follows the dropdowns and the pills`);
  }
});

test('the specs show no wall-clock time and no UTC: every time is the anchor', () => {
  for (const ref of Object.keys(END_WINDOWS)) {
    const text = JSON.stringify(spec(ref));
    assert.ok(!/\bnow\s*\(/i.test(text), `${ref}: no now()`);
    assert.ok(!/utc/i.test(text.replace(/"query":"[^"]*"/g, '')), `${ref}: no UTC`);
  }
  for (const ref of ['08-actor-baseline-band', '12-actor-cohort', '13-session-gantt']) {
    const s = spec(ref);
    assert.deepEqual(s.data.find((d) => d.name === 'anchor').url, { '%type%': 'esql', query: ANCHOR_QUERY }, ref);
    assert.ok(s.signals.some((x) => x.name === 'e' && x.update.includes("data('anchor')[0].e")), `${ref}: signal e reads the anchor`);
  }
  // 09 is Vega-Lite (one data source), so the anchor rides on its rows and is spread over the imputed hours.
  const p = spec('09-activity-punchcard');
  assert.ok(p.data.url.query.endsWith('| EVAL e = TO_LONG(TO_DATETIME(?_tend)) | KEEP ago, doc_count, e'));
  assert.deepEqual(p.transform[1], { joinaggregate: [{ op: 'max', field: 'e', as: 'end' }] });
  // The gantt's axis ends at the picker's end.
  assert.equal(spec('13-session-gantt').scales.find((x) => x.name === 'x').domain.signal, '[e - 86400000, e]');
});

test('the guard trips on a now(), a UTC format, a dataset on the stream, ?_tstart, and a missing bound', () => {
  const ref = '08-actor-baseline-band';
  const mutate = (fn) => { const c = structuredClone(spec(ref)); fn(c); return problemsOf(ref, c); };
  const counts = (c) => c.data.find((d) => d.name === 'counts').url;
  assert.match(mutate((c) => { c.data.find((d) => d.name === 'hours').transform[2].expr = '(floor(now() / 3600000) - datum.ago) * 3600000'; }), /calls now\(\)/);
  assert.match(mutate((c) => { c.scales[0].type = 'utc'; }), /draws in UTC/);
  assert.match(mutate((c) => { counts(c).query = counts(c).query.replace(DEFAULT_VIEW, 'logs-elastic_cloud.serverless_audit.otel-default'); }), /does not read the events view/);
  assert.match(mutate((c) => { counts(c).query = counts(c).query.replace('- 7 days', '- 30 days'); }), /not bounded by endWindowOnly\('7 days'\)/);
  assert.match(mutate((c) => { counts(c).query = counts(c).query.replace('TO_DATETIME(?_tend) - 7 days', 'TO_DATETIME(?_tstart)'); }), /reads \?_tstart|not bounded/);
  assert.match(mutate((c) => { counts(c).query = counts(c).query.replace('event_time <= TO_DATETIME(?_tend)', 'event_time <= ?_tend'); }), /compares a column bare/);
  assert.match(mutate((c) => { counts(c)['%timefield%'] = '@timestamp'; }), /sets %timefield%/);
});

test('--lint gathers the anchor row and every view query (get_timefield asks about each)', () => {
  const qs = gatherQueries();
  for (const ref of Object.keys(END_WINDOWS)) {
    const mine = qs.filter((x) => x.src === `vega/${ref}.json`);
    assert.ok(mine.length && mine.every((x) => x.q === ANCHOR_QUERY || x.q.includes('-events-view')), ref);
  }
  assert.ok(qs.some((x) => x.src === 'vega/13-session-gantt.json' && x.q === ANCHOR_QUERY));
});

test('the hourly specs keep the 168 hours ending with the one the picker\'s end falls in, by local hour of day', () => {
  for (const ref of ['08-actor-baseline-band', '09-activity-punchcard']) {
    const q = esqlUrls(spec(ref)).find((d) => d.url.query !== ANCHOR_QUERY).url.query;
    assert.ok(q.includes(`BY hour = DATE_TRUNC(1 hour, event_time) | EVAL ${HOUR_AGO} | WHERE ago <= 167`), ref);
  }
  const b = spec('08-actor-baseline-band');
  const hours = b.data.find((d) => d.name === 'hours');
  assert.deepEqual(hours.transform[0], { type: 'sequence', start: 0, stop: 168, as: 'ago' });
  assert.equal(hours.transform[1].default, 0);
  assert.equal(hours.transform.find((t) => t.as === 'key').expr, '(floor(e / 3600000) - datum.ago) * 3600000');
  assert.equal(b.data.find((d) => d.name === 'series').transform.find((t) => t.as === 'slot').expr, 'hours(datum.key)');
  const p = spec('09-activity-punchcard');
  assert.deepEqual(p.transform[0], { impute: 'doc_count', key: 'ago', keyvals: { start: 0, stop: 168 }, value: 0 });
  assert.equal(p.transform.find((t) => t.as === 'key').calculate, '(floor(datum.end / 3600000) - datum.ago) * 3600000');
  assert.equal(p.transform.find((t) => t.as === 'hour').calculate, 'hours(datum.key)');
});

test('the cohort: one selection dataset (pills + all four dropdowns), estate datasets on the window and the Project dropdown, both by project', () => {
  const s = spec('12-actor-cohort');
  const ok = []; checkTwoDatasets('vega/12-actor-cohort.json', s, ok);
  assert.deepEqual(ok, []);
  const urls = Object.fromEntries(esqlUrls(s).map((d) => [d.name, d.url]));
  assert.deepEqual(Object.keys(urls).sort(), ['anchor', 'estate', 'scope', 'whole']);
  assert.equal(urls.scope['%context%'], true);
  for (const n of ['estate', 'whole']) {
    assert.equal(urls[n]['%context%'], undefined, `${n}: no pills or KQL`);
    assert.ok(urls[n].query.includes(`${endWindowOnly('7 days')} AND ${PROJECT_WHERE} |`), `${n}: follows the Project dropdown`);
    assert.ok(!urls[n].query.includes(IDENTITY_WHERE) && !urls[n].query.includes(CLIENT_IP_WHERE), `${n}: not narrowed by the other dropdowns`);
  }
  const broken = (mutate) => { const c = structuredClone(s); mutate(Object.fromEntries(esqlUrls(c).map((d) => [d.name, d.url]))); const p = []; checkTwoDatasets('vega/12-actor-cohort.json', c, p); return p.join('\n'); };
  assert.match(broken((u) => { u.estate['%context%'] = true; }), /exactly one ES\|QL dataset/);
  assert.match(broken((u) => { u.whole.query = u.whole.query.replace(endWindowOnly('7 days'), endWindow('7 days')); }), /exactly one ES\|QL dataset/);
  assert.match(broken((u) => { u.estate.query = u.estate.query.replace(` AND ${PROJECT_WHERE}`, ''); }), /exactly one ES\|QL dataset/);
  assert.match(broken((u) => { u.estate.query = u.estate.query.replace('BY project = project.name, ', 'BY '); }), /no estate dataset grouped BY project\.name/);
  assert.match(broken((u) => { u.scope.query = u.scope.query.replace('BY project = project.name, ', 'BY '); }), /selection dataset scope does not group BY project\.name/);
  assert.ok(JSON.stringify(s).includes("'Only one person with an email' + sp + ' in 7 days'"));
});

test('the session timeline: 12 newest sessions in ms, no-email and multi-space cells handled, zoom by timer ticks', () => {
  const s = spec('13-session-gantt');
  const [sess, nos] = ['sessions', 'nosession'].map((n) => s.data.find((d) => d.name === n));
  assert.match(sess.url.query, /BY key = kibana\.session\.id \| SORT ended DESC, key \| LIMIT 12 \| EVAL start = TO_LONG\(started\), end = TO_LONG\(ended\)/);
  assert.match(sess.url.query, /started = MIN\(event_time\), ended = MAX\(event_time\)/);
  assert.match(nos.url.query, /WHERE kibana\.session\.id IS NULL \| STATS t = MAX\(event_time\) \| EVAL t = TO_LONG\(t\)/);
  const f = (as) => sess.transform.find((t) => t.as === as).expr;
  const run = (expr, datum) => Function('datum', 'isValid', 'isArray', 'join', `return (${expr});`)(datum, (v) => v !== null && v !== undefined, Array.isArray, (a, sep) => a.join(sep));
  assert.equal(run(f('actor'), {}), 'no email recorded', 'dropNullColumns drops an all-null column: undefined, not null');
  assert.equal(run(f('actor'), { actor: 'a@b.c' }), 'a@b.c');
  assert.equal(run(f('spaceList'), { spaces: ['default', 'syn'] }), 'default, syn');
  assert.equal(run(f('spaceList'), { spaces: 'default' }), 'default', 'one value comes back as a scalar');
  assert.equal(run(f('spaceList'), {}), '');
  // The zoom fires at the 7th and the 14th 100ms tick, as it did at 0.7s and 1.4s.
  const z = s.signals.find((x) => x.name === 'zoomTo');
  const calls = [];
  const tick = (zoomTo) => Function('zoomTo', 'kibanaSetTimeFilter', `return (${z.on[1].update});`)(zoomTo, (a, b) => { calls.push([a, b]); });
  let st = Function('datum', `return (${z.on[0].update});`)({ start: 100000, end: 200000 });
  let n = 0;
  while (st && n < 30) { st = tick(st); n++; }
  assert.deepEqual(calls, [[40000, 260000], [40000, 260000]]);
  assert.equal(n, 15);
});
