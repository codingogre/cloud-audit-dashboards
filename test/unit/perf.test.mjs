/**
 * --perf's pure parts: no network, no .env. The guard tests are the important ones — seed and clean
 * write and delete, and the only thing standing between them and the live audit stream is
 * assertPerfTarget().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWindows, windowParams, perfStreamFor, assertPerfTarget, planCopies, copyScript, percentile,
  groupByDashboard, bindDsl,
} from '../../scripts/perf.mjs';
import { DEFAULT_STREAM } from '../../scripts/lib/env.mjs';
import { stripContext } from '../../scripts/esql.mjs';

const DAY = 864e5;

test('parseWindows accepts m/h/d lists and rejects anything else', () => {
  assert.deepEqual(parseWindows('1h,24h,7d'), [
    { label: '1h', ms: 3600e3 }, { label: '24h', ms: 24 * 3600e3 }, { label: '7d', ms: 7 * DAY }]);
  assert.deepEqual(parseWindows(' 15m '), [{ label: '15m', ms: 900e3 }]);
  for (const bad of ['', '1w', 'h', '0h', '-1h', '1.5h', '1h,,x']) assert.throws(() => parseWindows(bad), /window|empty/);
});

test('windowParams is the ?_tstart/?_tend shape Kibana sends, ending at now', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.deepEqual(windowParams(3600e3, now), [{ _tstart: '2026-10-14T11:00:00.000Z' }, { _tend: '2026-10-14T12:00:00.000Z' }]);
});

test('the replica is the live dataset with namespace perf', () => {
  assert.equal(perfStreamFor(DEFAULT_STREAM), 'logs-elastic_cloud.serverless_audit.otel-perf');
  assert.equal(perfStreamFor('logs-a.b-prod'), 'logs-a.b-perf');
});

test('assertPerfTarget refuses the live stream and anything that is not one exact -perf name', () => {
  const live = DEFAULT_STREAM;
  assert.equal(assertPerfTarget(perfStreamFor(live), live), 'logs-elastic_cloud.serverless_audit.otel-perf');
  assert.throws(() => assertPerfTarget(live, live), /-perf|live/);
  assert.throws(() => assertPerfTarget(DEFAULT_STREAM, 'logs-x-default'), /-perf|live/);
  assert.throws(() => assertPerfTarget('logs-x-perf', 'logs-x-perf'), /live/);
  assert.throws(() => assertPerfTarget('logs-*-perf', live), /pattern/);
  assert.throws(() => assertPerfTarget('logs-x-perf,logs-y-default', live), /pattern/);
  assert.throws(() => assertPerfTarget('', live), /empty/);
  // AUDIT_STREAM pointed at the replica would make the "live" stream the replica itself.
  assert.throws(() => assertPerfTarget('logs-y-perf', 'logs-x-perf'), /AUDIT_STREAM/);
});

test('planCopies: copy 0 ends at now, the rest cover the window evenly, nothing lands in the future', () => {
  const now = Date.parse('2026-10-14T15:30:00Z');
  const srcMin = now - 2 * 3600e3 - 60e3, srcMax = now - 60e3;
  const plan = planCopies({ copies: 30, days: 7, srcMin, srcMax, now, seed: 'x' });
  assert.equal(plan.length, 30);
  assert.equal(plan[0].end, now);
  for (const p of plan) {
    assert.ok(p.end <= now, `copy ${p.copy} ends in the future`);
    assert.ok(p.start >= now - 7 * DAY, `copy ${p.copy} starts before the window`);
    assert.equal(p.end - p.start, srcMax - srcMin, 'a copy is shifted whole, never stretched');
  }
  // Stratified: every day of the week receives at least one copy.
  const days = new Set(plan.map((p) => Math.floor((now - p.start) / DAY)));
  for (let d = 0; d < 7; d++) assert.ok(days.has(d), `no copy starts ${d} days back`);
  // Reproducible from the seed, different for another seed.
  assert.deepEqual(planCopies({ copies: 30, days: 7, srcMin, srcMax, now, seed: 'x' }), plan);
  assert.notDeepEqual(planCopies({ copies: 30, days: 7, srcMin, srcMax, now, seed: 'y' }), plan);
  assert.equal(planCopies({ copies: 1, days: 7, srcMin, srcMax, now }).length, 1);
  assert.throws(() => planCopies({ copies: 0, days: 7, srcMin, srcMax, now }), /positive/);
});

test('copyScript carries the shift, a run+copy id suffix and the perf namespace', () => {
  const s = copyScript({ shiftMs: -3 * DAY, runTag: '20261014153000', copy: 4 });
  assert.equal(s.lang, 'painless');
  assert.deepEqual(s.params, { shift: -3 * DAY, suffix: '-p20261014153000c4', namespace: 'perf' });
  assert.match(s.source, /plusMillis\(params\.shift\)/);
  assert.match(s.source, /ctx\._id = ctx\._id \+ params\.suffix/);
  assert.notEqual(copyScript({ shiftMs: 0, runTag: 't', copy: 1 }).params.suffix, copyScript({ shiftMs: 0, runTag: 't', copy: 2 }).params.suffix);
});

test('percentile', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.5), 5);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
});

test('groupByDashboard puts embedded Vega and Discover queries on every dashboard that embeds them', () => {
  const defs = {
    a: { panels: [{ config: { ref_id: 'cloud-audit-vega-actor-risk-treemap' } }, { config: { ref_id: 'cloud-audit-search-all-mutations' } }] },
    b: { panels: [{ config: { nested: [{ ref_id: 'cloud-audit-vega-actor-risk-treemap' }] } }] },
  };
  const V = 'vega/01-actor-risk-treemap.json', S = 'searches/01-all-mutations.json';
  const esql = [{ src: 'dashboards/a', i: 0, q: 'FROM s' }, { src: V, i: 0, q: 'FROM s' },
                { src: S, i: 0, q: 'FROM s' }, { src: 'vega/99-orphan.json', i: 0, q: 'FROM s' }];
  const dsl = [{ src: V, i: 0, index: 's', body: {} }];
  const g = Object.fromEntries(groupByDashboard(defs, esql, dsl).map((x) => [x.name, x.items.map((i) => i.key)]));
  assert.deepEqual(g.a, ['dashboards/a[0]', `${V}[0]`, `${S}[0]`, `${V}[dsl 0]`]);
  assert.deepEqual(g.b, [`${V}[0]`, `${V}[dsl 0]`]);
  assert.deepEqual(g['(unreferenced)'], ['vega/99-orphan.json[0]']);
});

test('bindDsl: no %timefield% keeps the spec window; with one, the picker range is ANDed', () => {
  const body = { size: 0, query: { bool: { must: ['%dashboard_context-must_clause%', { range: { '@timestamp': { gte: 'now-7d' } } }] } } };
  const fixed = bindDsl(body, undefined, stripContext, { ms: 3600e3 });
  assert.deepEqual(fixed.query.bool.must, [{ range: { '@timestamp': { gte: 'now-7d' } } }]);
  const now = Date.parse('2026-10-14T12:00:00Z');
  const bound = bindDsl(body, '@timestamp', stripContext, { ms: 3600e3 }, now);
  assert.equal(bound.query.bool.filter[0].range['@timestamp'].gte, '2026-10-14T11:00:00.000Z');
  assert.deepEqual(bound.query.bool.filter[1], fixed.query);
});

test('groupByDashboard resolves refs under an AUDIT_ID_NS namespace too', () => {
  const defs = { a: { panels: [{ config: { ref_id: 'cloud-audit-wip-vega-actor-risk-treemap' } }, { config: { ref_id: 'cloud-audit-wip-search-all-mutations' } }] } };
  const esql = [{ src: 'vega/01-actor-risk-treemap.json', i: 0, q: 'FROM s' }, { src: 'searches/01-all-mutations.json', i: 0, q: 'FROM s' }];
  const g = groupByDashboard(defs, esql, []);
  assert.deepEqual(g.map((x) => x.name), ['a'], 'nothing may fall into (unreferenced)');
});

test('on the real suite, every embedded Vega/Discover ref resolves to a gathered spec', async () => {
  const { buildAll } = await import('../../scripts/lib/definitions.mjs');
  const { gatherQueries, gatherDsl } = await import('../../scripts/esql.mjs');
  const esql = gatherQueries(), dsl = gatherDsl();
  const groups = groupByDashboard(buildAll(), esql, dsl);
  const keys = new Set(groups.flatMap((g) => g.items.map((i) => i.key)));
  assert.equal(keys.size, esql.length + dsl.length, 'the grouped inventory must be the whole --lint inventory');
  for (const g of groups.filter((x) => !x.noPageLoad)) {
    assert.ok(g.items.some((i) => i.src === `dashboards/${g.name}`), `${g.name} has no panel queries of its own`);
  }
  // A dashboard that embeds a spec must carry its queries; an embedded ref with no file would vanish.
  const embedded = groups.filter((g) => !g.noPageLoad).flatMap((g) => g.items).filter((i) => !i.src.startsWith('dashboards/'));
  assert.ok(embedded.length > 0, 'no Vega or Discover queries were attributed to any dashboard');
});
