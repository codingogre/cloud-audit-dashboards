/**
 * 1.0.5 time features: the 24-hour default range, the previous-period tiles (PREV_TILES) and the data
 * coverage tile. No network: the parity of each tile's two forms is checked live by `./audit --lint`;
 * these tests pin the table's shape, the generated specs and the words the second line prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREV_TILES, PREV_LOOKBACK_DAYS, prevSpec, prevEsql, prevRef, prevKpi, tileSpecs, coverageSpec, retentionText,
  COVERAGE_REF, COVERAGE_DEFAULT_RETENTION, DEFAULT_FROM, TIME,
} from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { checkLayout } from '../../scripts/lib/layout.mjs';
import { stripContext, lintWindow } from '../../scripts/esql.mjs';
import { ROOT, nsId, DEFAULT_STREAM } from '../../scripts/lib/env.mjs';

const CONTEXT = ['%dashboard_context-must_clause%', '%dashboard_context-must_not_clause%', '%dashboard_context-filter_clause%'];

test('every dashboard opens on the last 24 hours, ending a minute ago', () => {
  assert.equal(DEFAULT_FROM, 'now-24h');
  for (const [name, d] of Object.entries(buildAll())) assert.deepEqual(d.time_range, { from: 'now-24h', to: 'now-1m' }, name);
});

test('PREV_TILES holds both forms of each tile side by side', () => {
  const keys = Object.keys(PREV_TILES);
  assert.ok(keys.length >= 6, 'about six simple headline tiles');
  for (const [key, t] of Object.entries(PREV_TILES)) {
    assert.deepEqual(Object.keys(t).sort(), ['dsl', 'esql', 'title'], key);
    assert.equal(typeof t.title, 'string', key);
    assert.ok(t.title.length > 0 && t.title.length <= 28, `${key}: a title an 8-column tile holds`);
    assert.equal(typeof t.esql, 'string', key);
    assert.ok(t.esql === '' || /^WHERE \S/.test(t.esql), `${key}: esql is one WHERE (or empty for every event)`);
    assert.ok(!/\?_t|@timestamp|STATS|\|/.test(t.esql), `${key}: the WHERE carries no window and no pipe — TIME supplies the window`);
    assert.ok(Array.isArray(t.dsl) && t.dsl.every((c) => c && typeof c === 'object' && !Array.isArray(c)), `${key}: dsl is a list of clauses`);
    assert.equal(t.esql === '', t.dsl.length === 0, `${key}: an empty filter on one side is empty on the other`);
    assert.ok(!JSON.stringify(t.dsl).includes('@timestamp'), `${key}: the DSL carries no window of its own`);
    assert.equal(prevEsql(key), `FROM ${process.env.AUDIT_STREAM || DEFAULT_STREAM} | ${TIME}${t.esql ? ` | ${t.esql}` : ''} | STATS n = COUNT(*)`);
  }
});

test('a previous-period spec: own window through the picker end, control bar kept, split by the picker', () => {
  for (const key of Object.keys(PREV_TILES)) {
    const spec = prevSpec(key);
    assert.equal(spec.data.length, 1, key);
    const { url } = spec.data[0];
    assert.equal(url['%timefield%'], undefined, `${key}: no %timefield%, so the picker does not bind it`);
    assert.equal(url.index, DEFAULT_STREAM);
    const q = url.body.query.bool;
    assert.equal(q.must[0], CONTEXT[0]); assert.equal(q.must_not[0], CONTEXT[1]); assert.equal(q.filter[0], CONTEXT[2]);
    assert.deepEqual(q.filter.slice(1), PREV_TILES[key].dsl, `${key}: filters on exactly the table's DSL`);
    assert.deepEqual(q.must[1].range['@timestamp'], { gte: `now-${PREV_LOOKBACK_DAYS}d`, lte: { '%timefilter%': 'max' }, format: 'epoch_millis' });
    const split = url.body.aggs.split.range;
    assert.deepEqual(split.script.params, { s: { '%timefilter%': 'min' }, e: { '%timefilter%': 'max' } });
    assert.deepEqual(split.ranges.map((r) => r.key), ['prev', 'cur']);
    assert.ok(url.body.aggs.stream.global, `${key}: the stream's first event ignores the pills`);
    for (const m of spec.marks) assert.match(m.style, /^guide-(title|label)$/, `${key}: theme-aware text`);
  }
});

test('the split script puts an event in the same window TIME does: (min, max] now, (2·min−max, min] before', () => {
  const src = prevSpec('total-events').data[0].url.body.aggs.split.range.script.source;
  // Painless here is plain Java arithmetic; run its return expression as JS.
  const ret = /return (.+);$/.exec(src)[1];
  const bucket = (t, s, e) => Function('t', 's', 'e', `return ${ret};`)(t, s, e);
  const s = 1000, e = 2000;
  assert.equal(bucket(2000, s, e), 1, 'the end is in, as in TIME (<= ?_tend)');
  assert.equal(bucket(1000, s, e), 0, 'the start is out, as in TIME (> ?_tstart)');
  assert.equal(bucket(1001, s, e), 1);
  assert.equal(bucket(2001, s, e), 2, 'after the range: in no bucket');
  assert.equal(bucket(1, s, e), 0);
  assert.equal(bucket(0, s, e), -1, 'before the prior window: in no bucket');
});

/** Evaluate the spec's formula chain the way Vega would, with the expression functions it uses. */
function tile(agg, { now = Date.UTC(2026, 9, 22, 12) } = {}) {
  const spec = prevSpec('total-events');
  const signals = Object.fromEntries(spec.signals.map((s) => [s.name, s.value]));
  const fns = {
    round: Math.round, abs: Math.abs, max: Math.max, now: () => now, isValid: (v) => v !== null && v !== undefined && !Number.isNaN(v),
    format: (v) => v.toLocaleString('en-US'),
  };
  const datum = { ...agg };
  for (const { as, expr } of spec.data[0].transform) {
    datum[as] = Function('datum', ...Object.keys(fns), ...Object.keys(signals), `return (${expr});`)(datum, ...Object.values(fns), ...Object.values(signals));
  }
  return datum;
}
const agg = ({ cur, prev, hours = 24, end = Date.UTC(2026, 9, 22, 11, 59), first = Date.UTC(2026, 9, 1) }) => ({
  split: { buckets: { cur: { doc_count: cur }, prev: { doc_count: prev } } },
  window: { buckets: { w: { from: end - hours * 3600e3, to: end } } },
  stream: { first: { value: first } },
});

test('the second line: change, ×, zero cases and the stream-start guard', () => {
  assert.equal(tile(agg({ cur: 134, prev: 100 })).detail, '▲ 34% vs prior 24h');
  assert.equal(tile(agg({ cur: 50, prev: 100 })).detail, '▼ 50% vs prior 24h');
  assert.equal(tile(agg({ cur: 0, prev: 100 })).detail, '▼ 100% vs prior 24h');
  assert.equal(tile(agg({ cur: 1000, prev: 100 })).detail, '▲ 10× vs prior 24h');
  assert.equal(tile(agg({ cur: 34809, prev: 2285 })).detail, '▲ 15× vs prior 24h');
  assert.equal(tile(agg({ cur: 999, prev: 100 })).detail, '▲ 899% vs prior 24h');
  assert.equal(tile(agg({ cur: 1001, prev: 1000 })).detail, '▲ <1% vs prior 24h');
  assert.equal(tile(agg({ cur: 100, prev: 100 })).detail, 'same as prior 24h');
  assert.equal(tile(agg({ cur: 7, prev: 0 })).detail, 'none in prior 24h');
  assert.equal(tile(agg({ cur: 0, prev: 0 })).detail, '0 in prior 24h too');
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 1 })).detail, '▲ 600% vs prior 1h');
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 24 * 7 })).detail, '▲ 600% vs prior 7d');
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 0.5 })).detail, '▲ 600% vs prior 30m');
  // The picker's presets end a minute early (TIME_TO), and still read as the preset.
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 59 / 60 })).detail, '▲ 600% vs prior 1h');
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 24 - 1 / 60 })).detail, '▲ 600% vs prior 24h');
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 24 * 7 - 1 / 60 })).detail, '▲ 600% vs prior 7d');
  assert.equal(tile(agg({ cur: 7, prev: 1, hours: 15 / 60 - 1 / 60 })).detail, '▲ 600% vs prior 14m');
  // The stream started inside the prior window: no false ▲ against a period nothing was recorded in.
  assert.equal(tile(agg({ cur: 900, prev: 10, first: Date.UTC(2026, 9, 21, 0) })).detail, 'no full prior 24h');
  // The prior window reaches past the lookback (30 days back from a 15-day read).
  assert.equal(tile(agg({ cur: 900, prev: 10, hours: 24 * 30 })).detail, 'no full prior 30d');
  // An empty stream.
  assert.equal(tile(agg({ cur: 0, prev: 0, first: null })).detail, 'no full prior 24h');
  assert.equal(tile(agg({ cur: 88929, prev: 1 })).value, '88,929');
  for (const d of ['▲ 1234× vs prior 24h', 'no full prior 24h']) assert.ok(d.length <= 20, `"${d}" fits an 8-column tile at 1440px`);
});

test('the committed vega/14 and vega/15-prev-* files are exactly what panels.mjs generates', () => {
  const specs = tileSpecs();
  assert.deepEqual(Object.keys(specs).sort(), [COVERAGE_REF, ...Object.keys(PREV_TILES).map(prevRef)].sort());
  for (const [name, spec] of Object.entries(specs)) {
    const file = readFileSync(join(ROOT, 'vega', `${name}.json`), 'utf8');
    assert.equal(file, JSON.stringify(spec, null, 2) + '\n', `vega/${name}.json is stale: regenerate with node -e "import('./scripts/dashboards.mjs').then(m=>m.emit())"`);
  }
});

test('every previous-period tile is on exactly one dashboard, as a title-less Vega panel, beside no Lens twin', () => {
  const all = buildAll();
  const panels = Object.values(all).flatMap((d) => d.panels);
  for (const [key, t] of Object.entries(PREV_TILES)) {
    const on = panels.filter((p) => p.config?.ref_id === nsId(`cloud-audit-vega-prev-${key}`));
    assert.equal(on.length, 1, key);
    assert.equal(on[0].config.title, '', `${key}: the spec draws the title`);
    assert.match(on[0].config.description, /prior period/, `${key}: the tooltip explains the second line`);
    assert.ok(!panels.some((p) => p.config?.type === 'metric' && JSON.stringify(p.config.metrics).includes(`"${t.title}"`)), `${key}: the Lens tile it replaced is gone`);
  }
  assert.throws(() => prevKpi(0, 0, 8, 5, 'no-such-tile', ''), /no previous-period tile/);
  assert.deepEqual(checkLayout(all).problems, []);
});

test('the coverage tile reads the whole stream, ignores the controls, and is on Command Center', () => {
  const spec = coverageSpec();
  const body = JSON.stringify(spec.data[0].url.body);
  for (const c of CONTEXT) assert.ok(!body.includes(c), `no ${c}: it describes the stream, not the selection`);
  assert.ok(!body.includes('%timefilter%') && spec.data[0].url['%timefield%'] === undefined, 'ignores the picker');
  assert.match(body, /"@timestamp":\{"gte"/);
  assert.equal(spec.signals.find((s) => s.name === 'retention').value, COVERAGE_DEFAULT_RETENTION);
  const cc = buildAll()['00-command-center'];
  const p = cc.panels.filter((q) => q.config?.ref_id === nsId('cloud-audit-vega-data-coverage'));
  assert.equal(p.length, 1);
  assert.ok(p[0].config.description.split(/\s+/).length <= 40, 'tip of 40 words at most');
});

test('retentionText() reads the lifecycle answer', () => {
  assert.equal(retentionText({ global_retention: {}, data_streams: [{ name: 's', lifecycle: { enabled: true } }] }), 'No retention limit set');
  assert.equal(retentionText({ data_streams: [{ lifecycle: { enabled: true, data_retention: '30d' } }] }), 'Kept for 30 days');
  assert.equal(retentionText({ data_streams: [{ lifecycle: { enabled: true, data_retention: '90d', effective_retention: '60d' } }] }), 'Kept for 60 days');
  assert.equal(retentionText({ global_retention: { default_retention: '1d' }, data_streams: [{ lifecycle: { enabled: true } }] }), 'Kept for 1 day');
  assert.equal(retentionText({ data_streams: [{ lifecycle: { enabled: true, data_retention: '12h' } }] }), 'Kept for 12 hours');
  assert.equal(retentionText({ data_streams: [{ lifecycle: { enabled: true, data_retention: '2w' } }] }), 'Kept for 2w');
  assert.equal(retentionText({ data_streams: [{ lifecycle: { enabled: false } }] }), 'Retention set outside the data stream');
  assert.equal(retentionText({}), COVERAGE_DEFAULT_RETENTION);
});

test('stripContext() binds %timefilter% to the window and refuses what it cannot bind', () => {
  const body = { query: { bool: { must: [CONTEXT[0], { range: { '@timestamp': { gte: 'now-15d', lte: { '%timefilter%': 'max' } } } }] } },
    aggs: { a: { script: { params: { s: { '%timefilter%': 'min' } } } } } };
  const out = stripContext(body, { min: 1, max: 2 });
  assert.deepEqual(out, { query: { bool: { must: [{ range: { '@timestamp': { gte: 'now-15d', lte: 2 } } }] } }, aggs: { a: { script: { params: { s: 1 } } } } });
  const w = lintWindow();
  assert.equal(w.max - w.min, 864e5);
  assert.throws(() => stripContext({ x: { '%timefilter%': 'min', shift: 1 } }, { min: 1, max: 2 }), /unsupported/);
});
