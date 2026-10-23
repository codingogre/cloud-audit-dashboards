/**
 * 1.0.5 time features: the 24-hour default range, the previous-period tiles (PREV_TILES, ES|QL on the events
 * view since 1.0.5.1) and the data coverage tile. No network: each tile's parity with TIME is checked live by `./audit --lint`;
 * these tests pin the table's shape, the generated specs and the words the second line prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREV_TILES, PREV_LOOKBACK_DAYS, prevSpec, prevEsql, prevQuery, prevStreamQuery, prevRef, prevKpi, tileSpecs, coverageSpec,
  retentionText, COVERAGE_REF, COVERAGE_DEFAULT_RETENTION, DEFAULT_FROM, TIME, IDENTITY_WHERE, NULL_SAFE, VIEW_TIME,
} from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { checkLayout, checkEscape } from '../../scripts/lib/layout.mjs';
import { stripContext, lintWindow } from '../../scripts/esql.mjs';
import { ROOT, nsId, DEFAULT_STREAM, DEFAULT_VIEW } from '../../scripts/lib/env.mjs';

const CONTEXT = ['%dashboard_context-must_clause%', '%dashboard_context-must_not_clause%', '%dashboard_context-filter_clause%'];

test('every dashboard opens on the last 24 hours, ending a minute ago', () => {
  assert.equal(DEFAULT_FROM, 'now-24h');
  for (const [name, d] of Object.entries(buildAll())) assert.deepEqual(d.time_range, { from: 'now-24h', to: 'now-1m' }, name);
});

test('PREV_TILES: a title and one ES|QL WHERE per tile', () => {
  const keys = Object.keys(PREV_TILES);
  assert.ok(keys.length >= 6, 'about six simple headline tiles');
  for (const [key, t] of Object.entries(PREV_TILES)) {
    assert.deepEqual(Object.keys(t).sort(), ['esql', 'title'], key);
    assert.equal(typeof t.title, 'string', key);
    assert.ok(t.title.length > 0 && t.title.length <= 28, `${key}: a title an 8-column tile holds`);
    assert.equal(typeof t.esql, 'string', key);
    assert.ok(t.esql === '' || /^WHERE \S/.test(t.esql), `${key}: esql is one WHERE (or empty for every event)`);
    assert.ok(!/\?_t|@timestamp|event_time|STATS|\|/.test(t.esql), `${key}: the WHERE carries no window and no pipe`);
    assert.equal(prevEsql(key), `FROM ${process.env.AUDIT_STREAM || DEFAULT_STREAM} | ${TIME}${t.esql ? ` | ${t.esql}` : ''} | STATS n = COUNT(*)`);
  }
});

test('a previous-period spec: ES|QL on the events view, its own window, the dropdowns and the control bar kept', () => {
  for (const key of Object.keys(PREV_TILES)) {
    const spec = prevSpec(key);
    assert.deepEqual(spec.data.map((d) => d.name), ['stream', 'tile'], key);
    const [stream, tile] = spec.data;
    for (const d of spec.data) {
      assert.equal(d.url['%type%'], 'esql', `${key} ${d.name}`);
      assert.equal(d.url['%timefield%'], undefined, `${key} ${d.name}: no %timefield%`);
      assert.ok(d.url.query.includes(`FROM ${DEFAULT_VIEW} |`), `${key} ${d.name}: reads the view, so no time filter is attached`);
      assert.ok(!d.url.query.includes('@timestamp'), `${key} ${d.name}: the view has no @timestamp`);
      assert.ok(d.url.query.includes(`${VIEW_TIME} >= NOW() - ${PREV_LOOKBACK_DAYS} days`), `${key} ${d.name}: capped at the lookback`);
    }
    assert.equal(tile.url['%context%'], true, `${key}: pills, KQL and the control bar reach the tile`);
    assert.equal(tile.url.query, prevQuery(key));
    assert.ok(tile.url.query.includes(IDENTITY_WHERE), `${key}: both counts follow the Identity dropdowns`);
    assert.ok(tile.url.query.startsWith(NULL_SAFE), `${key}: it names api_key.*, so it is null-safe`);
    if (PREV_TILES[key].esql) assert.ok(tile.url.query.includes(`| ${PREV_TILES[key].esql} |`), `${key}: the table's WHERE`);
    assert.equal(stream.url['%context%'], undefined, `${key}: the stream's first event ignores the pills`);
    assert.equal(stream.url.query, prevStreamQuery());
    assert.ok(!stream.url.query.includes('?'), `${key}: the stream's first event ignores the dropdowns and the picker`);
    const problems = []; checkEscape(key, spec, problems);
    assert.deepEqual(problems, [], `${key}: keeps the escape rules`);
    for (const m of spec.marks) assert.match(m.style, /^guide-(title|label)$/, `${key}: theme-aware text`);
  }
});

test('the tile query reads the windows TIME does: (start, end] now, (2·start−end, start] before', () => {
  const q = prevQuery('total-events');
  const S = 'TO_DATETIME(?_tstart)', E = 'TO_DATETIME(?_tend)';
  assert.ok(q.includes(`WHERE ${VIEW_TIME} <= ${E} AND ${VIEW_TIME} > TO_DATETIME(2 * TO_LONG(${S}) - TO_LONG(${E}))`), 'the end is in, the prior start is out');
  assert.ok(q.includes(`STATS cur = COUNT(*) WHERE ${VIEW_TIME} > ${S}, prev = COUNT(*) WHERE ${VIEW_TIME} <= ${S}`), 'the start belongs to the prior window, as in TIME (> ?_tstart)');
  assert.ok(q.endsWith(`| EVAL s = TO_LONG(${S}), e = TO_LONG(${E})`), 'the window comes back in ms for the second line');
  assert.match(TIME, /^WHERE @timestamp <= \?_tend AND @timestamp > \?_tstart /, 'TIME is the bound the parity lint compares with');
  assert.throws(() => prevQuery('no-such-tile'), /no previous-period tile/);
});

test('the escape rules catch each way the hidden time filter comes back', () => {
  const flag = (query, url = {}) => { const p = []; checkEscape('t', { data: [{ name: 'd', url: { '%type%': 'esql', query, ...url } }] }, p); return p; };
  const base = `FROM ${DEFAULT_VIEW} | WHERE ${VIEW_TIME} > TO_DATETIME(?_tstart) | STATS c = COUNT(*)`;
  assert.deepEqual(flag(base), []);
  assert.match(flag(`FROM ${DEFAULT_VIEW} | WHERE ${VIEW_TIME} > ?_tstart | STATS c = COUNT(*)`)[0], /bare/);
  assert.match(flag(`FROM ${DEFAULT_VIEW} | WHERE ?_tend >= ${VIEW_TIME} | STATS c = COUNT(*)`)[0], /bare/);
  assert.match(flag(`FROM ${DEFAULT_VIEW} | EVAL s = ?_tstart | STATS c = COUNT(*)`)[0], /assigns/);
  assert.ok(flag(`FROM ${DEFAULT_VIEW} | STATS c = COUNT(*) BY b = BUCKET(${VIEW_TIME}, 20, TO_DATETIME(?_tstart), TO_DATETIME(?_tend))`).some((m) => /buckets/.test(m)));
  assert.match(flag(`FROM ${DEFAULT_VIEW} | STATS first = MIN(${VIEW_TIME})`)[0], /reserved/);
  assert.match(flag(base, { '%timefield%': VIEW_TIME })[0], /%timefield%/);
  assert.match(flag(`FROM ${DEFAULT_VIEW} | WHERE @timestamp > TO_DATETIME(?_tstart)`)[0], /@timestamp/);
  assert.deepEqual(flag(`FROM ${DEFAULT_STREAM} | WHERE @timestamp > ?_tstart`), [], 'a query on the stream is not on the escape route');
});

/** Evaluate the spec's formula chain the way Vega would, with the expression functions it uses. */
function tile(row, { now = Date.UTC(2026, 9, 22, 12), first = Date.UTC(2026, 9, 1) } = {}) {
  const spec = prevSpec('total-events');
  const signals = { ...Object.fromEntries(spec.signals.map((s) => [s.name, s.value])), t0: first };
  const fns = {
    round: Math.round, abs: Math.abs, max: Math.max, now: () => now, isValid: (v) => v !== null && v !== undefined && !Number.isNaN(v),
    format: (v) => v.toLocaleString('en-US'),
  };
  const datum = { ...row };
  for (const { as, expr } of spec.data[1].transform) {
    datum[as] = Function('datum', ...Object.keys(fns), ...Object.keys(signals), `return (${expr});`)(datum, ...Object.values(fns), ...Object.values(signals));
  }
  return datum;
}
/** One row as the tile query returns it: the two counts and the window's bounds in ms. */
const row = ({ cur, prev, hours = 24, end = Date.UTC(2026, 9, 22, 11, 59) }) => ({ cur, prev, s: end - hours * 3600e3, e: end });

test('the t0 signal reads the stream dataset\'s first event, or null', () => {
  const sig = prevSpec('total-events').signals.find((s) => s.name === 't0');
  const isValid = (v) => v !== null && v !== undefined;
  const run = (rows) => Function('data', 'length', 'isValid', `return (${sig.update});`)(() => rows, (a) => a.length, isValid);
  assert.equal(run([{ t0: 5 }]), 5);
  assert.equal(run([{}]), null, 'an empty stream: the null column is dropped');
  assert.equal(run([]), null);
});

test('the second line: change, ×, zero cases and the stream-start guard', () => {
  assert.equal(tile(row({ cur: 134, prev: 100 })).detail, '▲ 34% vs prior 24h');
  assert.equal(tile(row({ cur: 50, prev: 100 })).detail, '▼ 50% vs prior 24h');
  assert.equal(tile(row({ cur: 0, prev: 100 })).detail, '▼ 100% vs prior 24h');
  assert.equal(tile(row({ cur: 1000, prev: 100 })).detail, '▲ 10× vs prior 24h');
  assert.equal(tile(row({ cur: 34809, prev: 2285 })).detail, '▲ 15× vs prior 24h');
  assert.equal(tile(row({ cur: 999, prev: 100 })).detail, '▲ 899% vs prior 24h');
  assert.equal(tile(row({ cur: 1001, prev: 1000 })).detail, '▲ <1% vs prior 24h');
  assert.equal(tile(row({ cur: 100, prev: 100 })).detail, 'same as prior 24h');
  assert.equal(tile(row({ cur: 7, prev: 0 })).detail, 'none in prior 24h');
  assert.equal(tile(row({ cur: 0, prev: 0 })).detail, '0 in prior 24h too');
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 1 })).detail, '▲ 600% vs prior 1h');
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 24 * 7 })).detail, '▲ 600% vs prior 7d');
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 0.5 })).detail, '▲ 600% vs prior 30m');
  // The picker's presets end a minute early (TIME_TO), and still read as the preset.
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 59 / 60 })).detail, '▲ 600% vs prior 1h');
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 24 - 1 / 60 })).detail, '▲ 600% vs prior 24h');
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 24 * 7 - 1 / 60 })).detail, '▲ 600% vs prior 7d');
  assert.equal(tile(row({ cur: 7, prev: 1, hours: 15 / 60 - 1 / 60 })).detail, '▲ 600% vs prior 14m');
  // The stream started inside the prior window: no false ▲ against a period nothing was recorded in.
  assert.equal(tile(row({ cur: 900, prev: 10 }), { first: Date.UTC(2026, 9, 21, 0) }).detail, 'no full prior 24h');
  // The prior window reaches past the lookback (30 days back from a 15-day read).
  assert.equal(tile(row({ cur: 900, prev: 10, hours: 24 * 30 })).detail, 'no full prior 30d');
  // An empty stream.
  assert.equal(tile(row({ cur: 0, prev: 0 }), { first: null }).detail, 'no full prior 24h');
  assert.equal(tile(row({ cur: 88929, prev: 1 })).value, '88,929');
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
