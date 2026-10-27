/**
 * The shared panel helpers' presentation contract: headers, widths, visible rows, legends and
 * markdown headings. No network. Each rule here was settled by rendering a live 9.6 dashboard (see
 * the comments in scripts/lib/panels.mjs); these tests keep a refactor from quietly undoing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  table, sized, filterable, label, humanise, fitRows, xy, bar, md, pie, blankNull, gridPx, COLUMNS, PALETTE_ID,
} from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { sessionGrid } from '../../scripts/objects.mjs';
import { nsId, objId, objFile, objFiles, RETIRED_OBJECTS } from '../../scripts/lib/env.mjs';

test('label() uses the suite vocabulary, then humanises', () => {
  assert.equal(label('actor'), 'Identity');
  assert.equal(label('last_seen'), 'Last seen');
  assert.equal(label('user.email'), 'Email');
  assert.equal(label('kibana.saved_object.id'), 'ID');
  assert.equal(label('client_geo_country'), 'Client geo country');
  assert.equal(humanise('api_key_ips'), 'API key IPs');
  assert.equal(humanise('Last seen'), 'Last seen', 'an alias that is already a header is left alone');
});

test('no table in the suite shows a raw dotted or snake_case header', () => {
  for (const [name, def] of Object.entries(buildAll())) {
    for (const p of def.panels.filter((x) => x.config?.type === 'data_table')) {
      for (const c of [...p.config.rows, ...p.config.metrics]) {
        assert.ok(c.label, `${name} "${p.config.title}": ${c.column} has no label`);
        assert.doesNotMatch(c.label, /[._]/, `${name} "${p.config.title}": header "${c.label}"`);
      }
    }
  }
});

test('table() labels without touching the filtered field, and sizes by role', () => {
  const t = table(0, 0, 48, 12, 't', 'FROM x | LIMIT 5',
    [filterable('user.email'), 'action', sized('name', 300, { label: 'Object' })], ['events', 'last_seen'], 'd');
  const [email, action, name] = t.config.rows;
  assert.deepEqual([email.column, email.label, email.click_filter], ['user.email', 'Email', true]);
  assert.equal(action.width, undefined, 'text columns flex');
  assert.deepEqual([name.label, name.width], ['Object', 300], 'call-site label and width win');
  assert.equal(t.config.metrics[0].width, COLUMNS.events.width);
  assert.equal(t.config.metrics[1].width, COLUMNS.last_seen.width, 'metric dates are sized too');
});

test('a table whose every column is fixed lets its widest row column flex', () => {
  const t = table(0, 0, 48, 12, 't', 'FROM x', [sized('actor', 200), sized('name', 400), 'verb'], ['events'], 'd');
  assert.equal(t.config.rows[1].column, 'identity_kind', 'Identity type rides beside Identity (1.0.5.4)');
  assert.equal(t.config.rows[2].width, undefined);
  assert.equal(t.config.rows[0].width, 200);
});

test('table() budgets fixed widths for a 1440px viewport, and flags a table it cannot rescue', () => {
  assert.equal(gridPx(24), 638, 'measured: a 24-column table at 1440px has a 638px data grid');
  const tight = table(0, 0, 15, 12, 't', 'q', ['location'], ['events', 'actors', 'ips'], 'd');
  const w = tight.config.metrics.map((c) => c.width);
  assert.ok(w.every((x) => x < 90 && x >= 72), `counts shrink toward their 72px floor: ${w}`);
  assert.ok(gridPx(15) - w.reduce((a, b) => a + b, 0) >= 150, 'the text column gets its minimum');
  assert.equal(tight.narrow1440, undefined);
  // Dates never shrink; a table its floors cannot rescue is flagged for a layout decision.
  const hopeless = table(0, 0, 12, 12, 't', 'q', ['actor'], ['first_seen', 'last_seen', 'events'], 'd');
  assert.deepEqual(hopeless.config.metrics.map((c) => c.width), [190, 190, 72]);
  assert.equal(hopeless.narrow1440, true);
  assert.ok(!JSON.stringify(tight).includes('"min"'), 'floors never reach the API payload');
  // Every table the suite ships either fits at 1440 or is flagged for a layout decision.
  for (const [name, def] of Object.entries(buildAll())) {
    for (const p of def.panels.filter((x) => x.config?.type === 'data_table' && !x.narrow1440)) {
      const cols = [...p.config.rows, ...p.config.metrics];
      const fixed = cols.filter((c) => c.width).reduce((a, c) => a + c.width, 0);
      const flex = cols.filter((c) => !c.width).length;
      assert.ok(!flex || (gridPx(p.grid.w) - fixed) / flex >= 120, `${name} "${p.config.title}" leaves its text columns under 120px at 1440`);
    }
  }
  // 04 Config changes (1.0.5 review): the API key and Principal id columns left Latest target 153px at 1440,
  // which cut "(none named in the payload)" (~165px rendered) mid-word.
  const config = buildAll()['04-security-anomalies'].panels.find((p) => p.config?.title?.startsWith('🚨 Config changes'));
  const used = [...config.config.rows, ...config.config.metrics].filter((c) => c.width).reduce((a, c) => a + c.width, 0);
  assert.ok(gridPx(config.grid.w) - used >= 170, `04 Config changes leaves Latest target ${gridPx(config.grid.w) - used}px at 1440`);
});

test('a table\'s tooltip is its own words (the opaque-key note lives in the How to read blocks); blankNull() blanks after the STATS', () => {
  assert.equal(table(0, 0, 24, 12, 't', 'q', ['actor'], ['events'], 'Who.').config.description, 'Who.');
  assert.equal(table(0, 0, 24, 12, 't', 'q', ['action'], ['events'], 'What.').config.description, 'What.');
  assert.equal(blankNull('via_key', 'owner'), 'EVAL via_key = COALESCE(via_key, " "), owner = COALESCE(owner, " ")');
  // A filter column must never be assigned in the query: Lens then refuses to filter on it.
  for (const [name, def] of Object.entries(buildAll())) {
    for (const p of def.panels.filter((x) => x.config?.type === 'data_table')) {
      for (const c of p.config.rows.filter((r) => r.click_filter)) {
        assert.doesNotMatch(p.config.data_source.query, new RegExp(`EVAL[^|]*\\b${c.column.replace(/\./g, '\\.')}\\s*=(?!=)`),
          `${name} "${p.config.title}" assigns its filter column ${c.column}`);
      }
    }
  }
});

test('fitRows() and the LIMIT clamp', () => {
  assert.deepEqual([8, 12, 14].map(fitRows), [6, 10, 13]);
  const q = (t) => t.config.data_source.query;
  assert.match(q(table(0, 0, 16, 12, 't', 'FROM x | SORT a | LIMIT 30', ['a'], ['b'], 'd')), /\| LIMIT 10$/);
  assert.match(q(table(0, 0, 16, 12, 't', 'FROM x | LIMIT 5', ['a'], ['b'], 'd')), /\| LIMIT 10$/, 'raised too: the LIMIT is exactly the rows that fit');
  assert.match(q(table(0, 0, 16, 12, 't', 'FROM x | LIMIT 30', ['a'], ['b'], 'd', { scroll: true })), /\| LIMIT 30$/);
  assert.match(q(table(0, 0, 16, 12, 't', 'FROM x | LIMIT 30', ['a'], ['b'], 'd', { wrap: true })), /\| LIMIT 30$/);
});

test('xy() shows a legend exactly when there is a breakdown, on a distinct-hue palette', () => {
  const split = xy(0, 0, 24, 12, 't', 'q', 'events', 'd', { breakdown: 'band', colors: { signal: '#54B399' } });
  assert.deepEqual(split.config.legend, { visibility: 'visible', position: 'bottom', layout: { type: 'list' } });
  assert.equal(split.config.layers[0].breakdown_by.color.palette, PALETTE_ID);
  assert.deepEqual(split.config.layers[0].breakdown_by.color.mapping,
    [{ values: ['signal'], color: { type: 'color_code', value: '#54B399' } }]);
  assert.equal(xy(0, 0, 24, 12, 't', 'q', 'events', 'd').config.legend.visibility, 'hidden');
  assert.equal(xy(0, 0, 24, 12, 't', 'q', 'e', 'd', { breakdown: 'v', legend: 'right' }).config.legend.position, 'right');
  assert.equal(bar(0, 0, 24, 12, 't', 'q', 'c', 'v', 'd', { values: true }).config.styling.bars.data_labels.visible, true);
  assert.throws(() => xy(0, 0, 24, 12, 't', 'q', 'e', 'd', { legend: 'inside' }));
  const log = xy(0, 0, 24, 12, 't', 'q', 'e', 'd', { yScale: 'log', yTitle: 'Summed severity' });
  assert.equal(log.config.axis.y.scale, 'log');
  assert.deepEqual(log.config.axis.y.title, { visible: true, text: 'Summed severity' });
  assert.deepEqual(xy(0, 0, 24, 12, 't', 'q', 'e', 'd').config.axis.y, { title: { visible: false } });
});

test('pie() always names its slices: a legend, inside labels, one-decimal percentages, pinned colours', () => {
  const p = pie(0, 0, 12, 11, 't', 'q', 'slice', 'n', 'd', { donut: 's', colors: { A: '#54B399' } });
  assert.deepEqual(p.config.legend, { visibility: 'visible', position: 'right', size: 'l' });
  assert.deepEqual(p.config.styling, { labels: { visible: true, position: 'inside' },
    values: { visible: true, mode: 'percentage', percent_decimals: 1 }, donut_hole: 's' });
  assert.equal(p.config.group_by[0].color.palette, PALETTE_ID);
  assert.deepEqual(p.config.group_by[0].color.mapping, [{ values: ['A'], color: { type: 'color_code', value: '#54B399' } }]);
  assert.throws(() => pie(0, 0, 12, 11, 't', 'q', 's', 'n', 'd', { legend: 'top' }));
});

test('md() lifts a leading heading into the panel title', () => {
  const m = md(0, 0, 12, 8, '<style>a{}</style>\n### 🌍 About this data\n\nBody **text**.');
  assert.equal(m.config.title, '🌍 About this data');
  assert.equal(m.config.content, '<style>a{}</style>\nBody **text**.');
  assert.equal(md(0, 0, 12, 2, '#### Section · _1h_').config.title, undefined, '#### is a band, not a title');
  assert.equal(md(0, 0, 12, 8, 'x', { title: 'T' }).config.title, 'T');
});

test('sessionGrid() defaults one-line rows and widths for dates and IPs', () => {
  const g = sessionGrid({ columns: ['Time', 'Identity', 'Client IP'], grid: { columns: { Identity: { width: 220 } } } });
  assert.equal(g.rowHeight, 1);
  assert.deepEqual(Object.keys(g.grid.columns).sort(), ['Client IP', 'Identity', 'Time']);
  assert.equal(sessionGrid({ row_height: -1 }).rowHeight, -1);
});

test('nsId() is the identity unless AUDIT_ID_NS is set', () => {
  const was = process.env.AUDIT_ID_NS;
  try {
    delete process.env.AUDIT_ID_NS;
    assert.equal(nsId('cloud-audit-vega-x'), 'cloud-audit-vega-x');
    process.env.AUDIT_ID_NS = 'mine';
    assert.equal(nsId('cloud-audit-vega-x'), 'cloud-audit-mine-vega-x');
  } finally {
    if (was === undefined) delete process.env.AUDIT_ID_NS; else process.env.AUDIT_ID_NS = was;
  }
});

test('AUDIT_ID_NS refuses a word a production id starts with, so a private deploy cannot touch production (review)', async () => {
  const { RESERVED_NS, checkNamespace, objFiles, objId, RETIRED_OBJECTS, DEFAULT_VIEW } = await import('../../scripts/lib/env.mjs');
  const { SUITE, RETIRED_IDS } = await import('../../scripts/lib/suite.mjs');
  const { RETIRED_DATA_VIEW_IDS } = await import('../../scripts/lib/controls.mjs');
  const { RULES, ruleId, RETIRED_RULE_IDS } = await import('../../scripts/lib/rules.mjs');
  const was = process.env.AUDIT_ID_NS;
  try {
    delete process.env.AUDIT_ID_NS;
    const ids = [...SUITE.map((d) => d.id), ...RETIRED_IDS, ...RETIRED_DATA_VIEW_IDS, 'elastic_cloud-audit-logs', DEFAULT_VIEW,
      ...RULES.map((r) => ruleId(r.slug)), ...RETIRED_RULE_IDS,
      'cloud-audit-adhoc-dv', ...['vega', 'search'].flatMap((k) => objFiles(k).map((f) => objId(k, f))), ...RETIRED_OBJECTS().map((o) => o.id)];
    for (const id of ids) {
      const first = id.replace(/^(elastic_)?cloud-audit-/, '').split('-')[0];
      assert.ok(/^\d/.test(first) || RESERVED_NS.includes(first), `${id}: "${first}" must be in RESERVED_NS`);
    }
  } finally {
    if (was === undefined) delete process.env.AUDIT_ID_NS; else process.env.AUDIT_ID_NS = was;
  }
  for (const n of RESERVED_NS) assert.throws(() => checkNamespace(n), /production id/);
  for (const n of ['00', '7x', 'Wip', 'a-b', '']) assert.throws(() => checkNamespace(n));
  assert.doesNotThrow(() => checkNamespace('r1051'));
});

test('Vega and Discover ids drop the file order number; files map back; the numbered ids are retired (1.0.5.1)', () => {
  const was = process.env.AUDIT_ID_NS;
  try {
    for (const ns of [undefined, 'mine']) {
      if (ns === undefined) delete process.env.AUDIT_ID_NS; else process.env.AUDIT_ID_NS = ns;
      const pre = ns ? `cloud-audit-${ns}` : 'cloud-audit';
      assert.equal(objId('vega', '01-actor-risk-treemap'), `${pre}-vega-actor-risk-treemap`);
      assert.equal(objId('vega', '15-prev-total-events.json'), `${pre}-vega-prev-total-events`);
      assert.equal(objId('search', '00-all-events'), `${pre}-search-all-events`);
      for (const kind of ['vega', 'search']) {
        const dir = kind === 'vega' ? 'vega' : 'searches';
        const files = objFiles(kind);
        assert.ok(files.length > 0);
        // Every id is unique and reads back to its own file.
        assert.equal(new Set(files.map((f) => objId(kind, f))).size, files.length, `${kind}: unique ids`);
        for (const f of files) assert.equal(objFile(objId(kind, f)), `${dir}/${f}`);
      }
      assert.equal(objFile(`${pre}-vega-no-such-chart`), null);
      assert.equal(objFile(`${pre}-vega-01-actor-risk-treemap`), null, 'a numbered id is not a current one');
      const retired = RETIRED_OBJECTS();
      assert.equal(retired.length, objFiles('vega').length + objFiles('search').length);
      assert.ok(retired.some((o) => o.type === 'visualization' && o.id === `${pre}-vega-01-actor-risk-treemap`));
      assert.ok(retired.some((o) => o.type === 'search' && o.id === `${pre}-search-10-raw-signal-feed`));
      // Never a live id: retiring one would delete the object a dashboard now points at.
      const live = new Set(['vega', 'search'].flatMap((k) => objFiles(k).map((f) => objId(k, f))));
      assert.ok(retired.every((o) => !live.has(o.id)));
    }
  } finally {
    if (was === undefined) delete process.env.AUDIT_ID_NS; else process.env.AUDIT_ID_NS = was;
  }
});

test('empty states live in the title; completeness is a lint failure on a LIMITed table', async () => {
  const { EMPTY } = await import('../../scripts/lib/panels.mjs');
  const { PROMISES_ALL, checkLayout } = await import('../../scripts/lib/layout.mjs');
  const good = table(0, 0, 24, 12, '⚠️ System index reads', 'FROM x | LIMIT 30', ['a'], ['b'], 'Reads.', { empty: 'good' });
  assert.equal(good.config.title, `⚠️ System index reads · top 10 at most ${EMPTY.good.title}`);
  // 'quiet' named one window ("(may be empty at 1h)") and read as wrong at every other: now a condition.
  const quiet = table(0, 0, 24, 12, 'Config changes', 'FROM x | LIMIT 30', ['a'], ['b'], 'Changes.', { empty: 'quiet' });
  assert.equal(quiet.config.title, 'Config changes · top 10 at most (empty when none in range)');
  assert.equal(quiet.config.description, 'Changes.', 'the title carries the empty state; the tooltip gains no sentence');
  assert.equal(EMPTY.good.title, '(empty = good)', 'a condition, true whether or not there are rows');
  assert.equal(good.config.description, 'Reads.');
  const own = table(0, 0, 24, 12, 'API key throughput', 'q', ['a'], ['b'], 'Keys.', { empty: 'empty without API-key traffic' });
  assert.equal(own.config.title, 'API key throughput (empty without API-key traffic)');
  assert.throws(() => table(0, 0, 24, 12, 't', 'q', ['a'], ['b'], 'd', { empty: 'none is good' }), /condition/);
  assert.equal(table(0, 0, 24, 12, 't', 'q', ['a'], ['b'], 'd').config.title, 't', 'no empty option, title untouched');
  assert.equal(good.lint.limit, 10);
  assert.ok(PROMISES_ALL.test('Every address they used') && PROMISES_ALL.test('all changes'));
  assert.ok(!PROMISES_ALL.test('Allowed overall callers'));
  // The rule is wired into checkLayout: a suite that passes today must fail with one promising title.
  const all = buildAll();
  const [name, def] = Object.entries(all).find(([, d]) => d.panels.some((p) => p.lint?.limit && !p.lint.scroll));
  const p = def.panels.find((x) => x.lint?.limit && !x.lint.scroll);
  const saved = p.config.title;
  p.config.title = 'Every row';
  assert.ok(checkLayout(all).problems.some((m) => m.startsWith(`${name}: table ${p.id} "Every row" promises every row`)));
  p.config.title = saved;
  // In-memory annotations never reach the Dashboards API payload.
  const text = JSON.stringify(Object.values(all).map((d) => d.panels.map(({ drill, narrow1440, lint, ...q }) => q)));
  assert.doesNotMatch(text, /"lint":/);
});

test('NOISE and BAND share one vocabulary; BAND reads the kib_internal key BAND_KEYS defines; IP_GEO groups by address', async () => {
  const { NOISE, BAND, BAND_KEYS, KIBANA_INTERNALS, IP_GEO } = await import('../../scripts/lib/panels.mjs');
  assert.ok(NOISE.includes(KIBANA_INTERNALS) && BAND_KEYS.includes(`kib_internal = (${KIBANA_INTERNALS})`));
  assert.match(BAND, /kib_internal, "query-noise"/);
  for (const a of ['indices:data/read/esql*', 'indices:data/read/field_caps*', 'indices:data/read/async_search/*', 'indices:admin/resolve/*']) {
    assert.ok(NOISE.includes(`"${a}"`) && BAND.includes(`"${a}"`), a);
  }
  // Every non-action field KIBANA_INTERNALS reads is IS NOT NULL-guarded, so the gate never yields null.
  for (const f of ['url.original', 'kibana.saved_object.id', 'kibana.saved_object.type']) assert.ok(KIBANA_INTERNALS.includes(`${f} IS NOT NULL AND`), f);
  // The browser-session test is IS NULL, which is never null itself.
  assert.ok(!/kibana\.session\.id (?!IS NULL)/.test(KIBANA_INTERNALS));
  assert.doesNotMatch(IP_GEO, /\bBY\b/);
  assert.match(IP_GEO, /placed = COUNT\(client\.geo\.country_iso_code\)/);
});

test('a LIMITed table states its cut as a bound, and a scrollable one says scroll in its description', async () => {
  const { checkLayout } = await import('../../scripts/lib/layout.mjs');
  const { SCROLL_NOTE, BARE_COUNT, BOUNDED } = await import('../../scripts/lib/panels.mjs');
  const mk = (title, q, h, o) => table(0, 0, 24, h, title, q, ['a'], ['b'], 'd', o);
  const t = (...a) => mk(...a).config.title;
  assert.equal(t('Busiest', 'FROM x | SORT events DESC | LIMIT 30', 12), 'Busiest · top 10 at most');
  assert.equal(t('Changes', 'FROM x | SORT last_seen DESC | LIMIT 30', 12), 'Changes · newest 10 at most');
  assert.equal(t('Top transport actions', 'FROM x | SORT events DESC | LIMIT 30', 14), 'Top transport actions · 13 at most', 'the order word is already there');
  assert.equal(t('Mutations — most recent changes', 'FROM x | SORT @timestamp DESC | LIMIT 30 | EVAL a = 1', 14, { scroll: true }),
    'Mutations — most recent changes · 30 at most', 'LIMIT above the visible rows: the bound, no "scroll" in the title');
  assert.equal(t('What changed · up to 100', 'FROM x | SORT d DESC | LIMIT 100', 12, { scroll: true }), 'What changed · up to 100');
  assert.equal(t('High value', 'FROM x | SORT last_seen DESC | LIMIT 10', 12, { wrap: true }), 'High value · newest 10 at most');
  assert.ok(mk('High value', 'FROM x | SORT last_seen DESC | LIMIT 10', 12, { wrap: true }).config.description.endsWith(SCROLL_NOTE));
  assert.equal(SCROLL_NOTE, 'Scroll for more.', 'three words, so a 37-word tip still fits TIP_MAX_WORDS');
  assert.equal(table(0, 0, 24, 12, 't', 'FROM x | LIMIT 10', ['a'], ['b'], 'Rows; scroll for the rest.', { wrap: true }).config.description,
    'Rows; scroll for the rest.', 'a description that already says scroll is left alone');
  assert.ok(!mk('Busiest', 'FROM x | LIMIT 30', 12).config.description.includes(SCROLL_NOTE));
  assert.equal(t('Classes', 'FROM x | STATS n = COUNT(*) BY c', 9), 'Classes', 'no LIMIT, no cut');
  assert.equal(t('Fixed', 'FROM x | LIMIT 5', 9, { cut: false }), 'Fixed');
  assert.throws(() => t('the 30 most recent', 'FROM x | SORT ts DESC | LIMIT 30', 14, { scroll: true }), /a count in a title/);
  assert.throws(() => t('Top 9 types', 'FROM x | LIMIT 9', 11), /a count in a title/);
  assert.ok(BARE_COUNT.test('Top 10 spaces') && BARE_COUNT.test('· top 10 identities') && BARE_COUNT.test('newest 1,000'));
  assert.ok(!BARE_COUNT.test('newest 1,000 at most') && !BARE_COUNT.test('· up to 10') && !BARE_COUNT.test('top 10 at most'));
  assert.ok(BOUNDED(1000).test('newest 1,000 at most') && BOUNDED(10).test('up to 10') && !BOUNDED(10).test('top 10'));
  // Wired into checkLayout: a hidden-row table, a short LIMIT, an unannounced cut and title caveats all fail.
  const all = buildAll();
  const [name, def] = Object.entries(all).find(([, d]) => d.panels.some((p) => p.lint?.limit && !p.lint.scroll));
  const p = def.panels.find((x) => x.lint?.limit && !x.lint.scroll);
  const saved = { title: p.config.title, q: p.config.data_source.query };
  p.config.title = 'Unannounced · scroll (may be empty at 1h)';
  p.config.data_source.query = saved.q.replace(/LIMIT \d+/g, 'LIMIT 99');
  let problems = checkLayout(all).problems.filter((m) => m.includes(p.id));
  assert.ok(problems.some((m) => /rows would be hidden/.test(m)), problems.join('\n'));
  assert.ok(problems.some((m) => /description does not say "scroll"/.test(m)));
  assert.ok(problems.some((m) => /does not say so as a bound/.test(m)));
  assert.ok(problems.some((m) => /instruction \("scroll"\)/.test(m)));
  assert.ok(problems.some((m) => /caveat for one time window/.test(m)));
  p.config.title = 'Busiest · top 2 at most';
  p.config.data_source.query = saved.q.replace(/LIMIT \d+/g, 'LIMIT 2');
  problems = checkLayout(all).problems.filter((m) => m.includes(p.id));
  assert.ok(problems.some((m) => /must equal the rows that fit/.test(m)), problems.join('\n'));
  p.config.title = 'Top 10 things';
  assert.ok(checkLayout(all).problems.some((m) => m.includes(p.id) && /states a count/.test(m)));
  Object.assign(p.config, { title: saved.title }); p.config.data_source.query = saved.q;
});

/** The identity shapes the live stream records (1.0.5.1, .sessions identity-facts): raw fields as a STATS groups them. */
const CLOUD = '_4KEOqEBFWdu4E65tC03';
const IDENTITY_FIXTURES = [
  [{ 'user.email': 'a@example.com', 'user.domain': 'cloud-saml-kibana', 'user.name': '3512997522' }, 'a@example.com', 'a@example.com', 'Person'],
  [{ 'api_key.name': 'ci-deploy', 'user.domain': '_cloud_api_key', 'user.name': CLOUD }, 'ci-deploy', 'ci-deploy', 'Elasticsearch API key'],
  [{ 'user.domain': '_cloud_api_key', 'user.name': CLOUD }, `${CLOUD} · Cloud API key`, '_4KEO… · Cloud API key', 'Cloud API key'],
  // Shape H: a Kibana event made with an Elasticsearch key. user.name is the key's OWNER, not the key.
  [{ 'user.domain': '_es_api_key', 'user.name': CLOUD }, `Unnamed key of ${CLOUD}`, 'Unnamed key of _4KEO…', 'Unnamed API key'],
  [{ 'user.domain': '_service_account', 'user.name': 'elastic/kibana' }, 'elastic/kibana', 'elastic/kibana', 'Service account'],
  [{ 'user.name': 'admin', 'event.action': 'authentication_failed' }, 'admin', 'admin', 'Failed sign-in'],
  [{ 'user.name': '<unauthenticated-cloud-access-token>' }, '<unauthenticated-cloud-access-token>', '<unauthenticated-cloud-access-token>', 'Other'],
  [{ 'event.action': 'connection_granted' }, '(unattributed)', '(unattributed)', 'Unattributed'],
];

test('1.0.5.1: a table names an identity as the Identity dropdown lists it, and picking that value selects its events', async () => {
  const { ACTOR_RESOLVE, ACTOR_LABEL, IDENTITY, IDENTITY_WHERE, ACTOR_KEYS, identityLabel } = await import('../../scripts/lib/panels.mjs');
  const { compile, evalBody } = await import('./esql-expr.mjs');
  // One rule: the display column and the dropdown's options are the same expression.
  assert.equal(evalBody(ACTOR_RESOLVE), IDENTITY.replace(/^identity = /, ''));
  for (const f of ['user.email', 'api_key.name', 'user.domain', 'user.name']) assert.ok(ACTOR_KEYS.split(', ').includes(f), f);
  const resolve = compile(evalBody(ACTOR_RESOLVE)), label = compile(evalBody(ACTOR_LABEL));
  const lit = (s) => JSON.stringify(s);
  const where = (identity, kind = '') => compile(IDENTITY_WHERE.replaceAll('?identity_kind', lit(kind)).replaceAll('?identity', lit(identity)));
  for (const [doc, full, shown, kind] of IDENTITY_FIXTURES) {
    const actor = resolve(doc);
    assert.equal(actor, full, JSON.stringify(doc));
    assert.equal(label({ actor }), shown, `${full} is shown as ${shown}`);
    assert.equal(where(actor)(doc), true, `picking "${full}" in Identity selects its event`);
    assert.equal(where(actor, kind)(doc), true, `and under Identity type ${kind}`);
    assert.equal(where('')(doc), true, 'nothing picked selects everything');
    for (const [other, otherFull] of IDENTITY_FIXTURES) {
      if (otherFull !== full) assert.notEqual(where(otherFull)(doc), true, `"${otherFull}" does not select ${full}'s event`);
    }
  }
  // The shape-H fix: the Cloud API key no longer claims the events of the keys it owns.
  assert.notEqual(where(`${CLOUD} · Cloud API key`)({ 'user.domain': '_es_api_key', 'user.name': CLOUD }), true);
  // A bare name equal to a key id or an owner (a failed sign-in typed it, say) selects neither key's events (review).
  assert.notEqual(where(CLOUD)({ 'user.domain': '_cloud_api_key', 'user.name': CLOUD }), true, 'bare id vs the Cloud key');
  assert.notEqual(where(CLOUD)({ 'user.domain': '_es_api_key', 'user.name': CLOUD }), true, 'bare id vs its unnamed keys');
  assert.equal(where(CLOUD)({ 'user.name': CLOUD, 'event.action': 'authentication_failed' }), true, 'but still its own failed sign-in');
  // "Any" is the same as nothing picked, for both dropdowns.
  for (const [doc] of IDENTITY_FIXTURES) assert.equal(where('Any', 'Any')(doc), true);
  // Only a 20-character key id is shortened; a person's numeric id and any other name are left alone.
  assert.equal(compile(identityLabel('x'))({ x: 'Unnamed key of 3512997522' }), 'Unnamed key of 3512997522');
});

test('an opaque Cloud API key id has one display form, and table() applies it', async () => {
  const { ACTOR_LABEL, CLOUD_KEY_TAG, cloudKeyLabel } = await import('../../scripts/lib/panels.mjs');
  assert.equal(CLOUD_KEY_TAG, '… · Cloud API key');
  // Two REPLACEs, no CASE: the identity's short form (the test above evaluates it). A raw key id (a key's
  // owner, a creator) takes cloudKeyLabel() and reads the same.
  assert.match(ACTOR_LABEL, /^EVAL actor = REPLACE\(REPLACE\(actor, /);
  assert.ok(ACTOR_LABEL.includes(CLOUD_KEY_TAG) && cloudKeyLabel('user.name').includes(CLOUD_KEY_TAG));
  assert.match(cloudKeyLabel('user.name', 'api_key.name'), /, api_key\.name\)$/);
  const q = table(0, 0, 24, 12, 't', 'FROM x | STATS events = COUNT(*) BY actor | SORT events DESC | LIMIT 30', ['actor'], ['events'], 'd').config.data_source.query;
  assert.ok(q.endsWith(`| LIMIT 10 | ${ACTOR_LABEL}`), 'after the clamp, on the displayed rows only');
  assert.ok(!table(0, 0, 24, 12, 't', 'FROM x | LIMIT 3', ['action'], ['events'], 'd').config.data_source.query.includes(ACTOR_LABEL));
});

test('privileged ops leave out only Kibana\'s own key clean-up, and say how much', async () => {
  const { HOUSEKEEPING, PRIVILEGED, privilegedKpi, PLATFORM_ACTORS } = await import('../../scripts/lib/panels.mjs');
  assert.ok(HOUSEKEEPING.includes('"invalidate_apikeys"') && HOUSEKEEPING.includes(PLATFORM_ACTORS));
  // Every term guarded, so NOT HOUSEKEEPING never evaluates to null and drops a row.
  for (const f of ['event.action', 'user.name']) assert.ok(HOUSEKEEPING.includes(`${f} IS NOT NULL AND ${f}`), f);
  assert.ok(PRIVILEGED.endsWith(`AND NOT ${HOUSEKEEPING}`));
  assert.match(privilegedKpi('Privileged ops'), /COUNT\(\*\) WHERE NOT housekeeping.*housekeeping_note/);
  // The short, digit-grouped second line ("excl. 2,285 cleanups"), so it never outweighs the number under it.
  assert.match(privilegedKpi('Privileged ops'), /CONCAT\("excl\. ", CASE\(LENGTH\(TO_STRING\(cleanups\)\) <= 3/);
});

test('round 6: API key reads are query internals; key changes stay signal', async () => {
  const { NOISE, BAND } = await import('../../scripts/lib/panels.mjs');
  for (const a of ['cluster:admin/xpack/security/api_key/get', 'cluster:admin/xpack/security/api_key/query']) {
    assert.ok(NOISE.includes(`"${a}"`) && BAND.includes(`"${a}"`), a);
  }
  for (const a of ['create', 'grant', 'update', 'invalidate']) assert.ok(!NOISE.includes(`security/api_key/${a}`), a);
});

test('round 6: Kibana\'s key clean-up scores 0 in RISK, through a boolean key RISK_KEYS groups', async () => {
  const { RISK, RISK_KEYS, HOUSEKEEPING } = await import('../../scripts/lib/panels.mjs');
  assert.match(RISK, /^EVAL risk = CASE\(housekeeping, 0, /);
  assert.ok(RISK_KEYS.includes(`housekeeping = ${HOUSEKEEPING}, `));
});

test('1.0.5: SUITE_INSTALL — the session-less install scores 0 after failures, via a RISK_KEYS boolean; mutation lists keep it', async () => {
  const { RISK, RISK_KEYS, SUITE_INSTALL, SUITE_SELF, SUITE_ID_TEST, NOISE, CHANGE_PRED } = await import('../../scripts/lib/panels.mjs');
  assert.ok(RISK_KEYS.endsWith(`suite_install = ${SUITE_INSTALL}`));
  assert.ok(RISK.includes('event.outcome == "failure", 40, suite_install, 0, '));
  assert.ok(RISK.indexOf('suite_install, 0') < RISK.indexOf(CHANGE_PRED), 'before every change weight');
  assert.equal(SUITE_INSTALL, `(${SUITE_ID_TEST} AND kibana.session.id IS NULL)`);
  // SUITE_SELF text is frozen: five static copies embed it through NOISE / KIBANA_INTERNALS / BAND_KEYS.
  assert.equal(SUITE_SELF, '(kibana.saved_object.id IS NOT NULL AND (kibana.saved_object.id LIKE "cloud-audit-*" OR kibana.saved_object.id LIKE "elastic_cloud-audit-*") AND (event.action IN ("saved_object_get","saved_object_resolve","saved_object_find") OR kibana.session.id IS NULL))');
  assert.ok(NOISE.includes(SUITE_SELF));
  assert.ok(!CHANGE_PRED.includes('cloud-audit'), 'CHANGE keeps the install');
  assert.ok(!SUITE_INSTALL.includes('user.name') && !SUITE_INSTALL.includes('api_key'), 'a test of the channel, never of a key');
});

test('1.0.5: RISK, evaluated on events — the suite install scores 0, a browser edit or a denied write still scores', async () => {
  const { RISK, HOUSEKEEPING, SUITE_INSTALL, CHANGE_PRED } = await import('../../scripts/lib/panels.mjs');
  const { compile, evalBody } = await import('./esql-expr.mjs');
  const hk = compile(HOUSEKEEPING), si = compile(SUITE_INSTALL), risk = compile(evalBody(RISK)), change = compile(CHANGE_PRED);
  // Each RISK_KEYS boolean computed from the raw event, as the STATS groups it, then RISK on the result.
  const score = (doc) => { const d = { ...doc, housekeeping: hk(doc), suite_install: si(doc) }; return risk(d); };
  const kb = (o) => ({ 'service.name': 'serverless-kibana', 'event.outcome': 'success', 'user.name': '_4KEOqEBFWdu4E65tC03', ...o });
  const create = kb({ 'event.action': 'saved_object_create', 'event.type': 'creation', 'kibana.saved_object.id': 'elastic_cloud-audit-security-anomalies' });

  assert.equal(si(create), true);
  assert.equal(score(create), 0, 'a session-less create of a suite object');
  assert.equal(score({ ...create, 'kibana.saved_object.id': 'rc105-cloud-audit-x' }), 25, 'an id that only contains the prefix is not a suite id');
  assert.equal(score(kb({ 'event.action': 'saved_object_create', 'event.type': 'creation', 'kibana.saved_object.id': 'cloud-audit-01-identity-access' })), 0, 'a cloud-audit-* object (Vega, Discover, data view)');
  assert.equal(score({ ...create, 'event.action': 'saved_object_delete', 'event.type': 'deletion' }), 0, 'a session-less delete of a suite object');
  assert.equal(change(create), true, 'still a change, so every mutation list keeps it');

  const browser = { ...create, 'event.action': 'saved_object_update', 'event.type': 'change', 'kibana.session.id': 'sess-1', 'user.email': 'a@example.com' };
  assert.equal(si(browser), false);
  assert.equal(score(browser), 25, 'a person editing a suite dashboard in a browser still scores');
  assert.equal(score({ ...browser, 'event.action': 'saved_object_delete', 'event.type': 'deletion' }), 30);

  assert.equal(score({ ...create, 'event.outcome': 'failure' }), 40, 'a denied write to a suite object still scores 40');
  assert.equal(score(kb({ 'event.action': 'saved_object_create', 'event.type': 'creation', 'kibana.saved_object.id': 'my-dashboard' })), 25, 'any other object keeps its weight');
  // The space-delete cascade (ids like dashboard:cloud-audit-01-…:viewed:…) stays scored, by design.
  assert.equal(score(kb({ 'event.action': 'saved_object_delete', 'event.type': 'deletion', 'kibana.saved_object.id': 'dashboard:cloud-audit-01-identity-access:viewed:server:20261014' })), 30);
  // The evaluator agrees with the documented housekeeping rule, so it is reading RISK as ES|QL does.
  assert.equal(score({ 'event.action': 'invalidate_apikeys', 'user.name': 'elastic/kibana', 'elasticsearch.audit.security_config_change': 'present' }), 0);
  assert.equal(score({ 'event.action': 'invalidate_apikeys', 'user.name': 'someone', 'elasticsearch.audit.security_config_change': 'present' }), 45);
});

test('round 6: every dashboard range ends at now-1m', () => {
  for (const [name, d] of Object.entries(buildAll())) assert.equal(d.time_range.to, 'now-1m', name);
});

test('round 6: one failed sign-in counts once on 01 and 04 (no per-realm traces)', async () => {
  const { FAILED_OR_DENIED } = await import('../../scripts/lib/panels.mjs');
  assert.match(FAILED_OR_DENIED, /event\.action != "realm_authentication_failed"/);
  const all = buildAll();
  for (const name of Object.keys(all).filter((n) => /^0[14]-/.test(n))) {
    const qs = JSON.stringify(all[name].panels);
    assert.ok(qs.includes(JSON.stringify(FAILED_OR_DENIED).slice(1, -1)), name);
    assert.ok(!/IN \(\\"authentication_failed\\",\\"realm_authentication_failed\\"/.test(qs), name);
  }
});

test('checkClickFilters() rejects a click-to-filter column the query assigns, and passes a grouped raw field', async () => {
  const { checkClickFilters } = await import('../../scripts/lib/layout.mjs');
  const panel = (query, column) => ({ id: 'p', config: { title: 't', data_source: { query }, rows: [{ column, click_filter: true }] } });
  const run = (q, c) => { const problems = []; checkClickFilters('d', [panel(q, c)], problems); return problems; };
  const F = 'elasticsearch.audit.indices';
  assert.equal(run(`FROM x | STATS a = MIN(${F}) BY family | EVAL \`${F}\` = COALESCE(a, "") | LIMIT 9`, F).length, 1);
  assert.equal(run(`FROM x | STATS n = COUNT(*), ${F} = MIN(y) BY family`, F).length, 1);
  assert.equal(run(`FROM x | STATS n = COUNT(*) BY y | RENAME y AS ${F}`, F).length, 1);
  assert.equal(run(`FROM x | INLINE STATS m = MIN(${F}) BY family | WHERE ${F} == m | STATS n = MAX(n) BY ${F}, family`, F).length, 0);
  assert.equal(run('FROM x | STATS events = COUNT(*) BY user.email | SORT events DESC', 'user.email').length, 0);
});

test('nullSafe (1.0.4): SET unmapped_fields="nullify" on exactly the queries that name api_key.*', async () => {
  const { nullSafe, NULL_SAFE } = await import('../../scripts/lib/panels.mjs');
  assert.equal(NULL_SAFE, 'SET unmapped_fields="nullify";');
  const q = 'FROM x | EVAL actor = COALESCE(user.email, api_key.name, user.name)';
  assert.equal(nullSafe(q), `${NULL_SAFE} ${q}`);
  assert.equal(nullSafe(nullSafe(q)), nullSafe(q), 'idempotent');
  assert.equal(nullSafe('FROM x | KEEP user.email'), 'FROM x | KEEP user.email', 'no api_key field, no SET');
  assert.equal(nullSafe('FROM x | KEEP my_api_key.name'), 'FROM x | KEEP my_api_key.name');
});

test('nullSafe (1.0.4): every shipped query that names api_key.* carries the SET, and none other does', async () => {
  const { gatherQueries } = await import('../../scripts/esql.mjs');
  const { ruleQueries } = await import('../../scripts/lib/rules.mjs');
  // 108 since 1.0.5.1: the six prior-period tiles (PREV_TILES) are ES|QL again, two datasets each.
  assert.ok(gatherQueries().length >= 108, `collector still sees every query (${gatherQueries().length})`);
  // The alert rules (1.0.6) are linted beside them, so they meet the same rule.
  const items = [...gatherQueries(), ...ruleQueries()];
  const names = (q) => /(?<![\w.])api_key\./.test(q);
  for (const { src, q } of items) {
    assert.equal(q.startsWith('SET unmapped_fields="nullify"; FROM '), names(q), `${src}: SET iff api_key.*`);
  }
  assert.ok(items.filter(({ q }) => q.startsWith('SET ')).length >= 45);
});

test('the strict lint pass: a typo hidden by SET nullify fails; an unmapped api_key.* field does not (review)', async () => {
  const { strictQuery, strictProblem } = await import('../../scripts/esql.mjs');
  assert.equal(strictQuery('FROM x | KEEP a'), null);
  assert.equal(strictQuery('SET unmapped_fields="nullify"; FROM x | KEEP a'), 'FROM x | KEEP a | LIMIT 0');
  const err = (reason) => ({ ok: false, body: { error: { reason } } });
  assert.equal(strictProblem({ ok: true }), null);
  assert.equal(strictProblem(err('Found 1 problem\nline 1:20: Unknown column [api_key.name]')), null);
  assert.match(strictProblem(err('Found 2 problems\nline 1:20: Unknown column [api_key.name]\nline 1:40: Unknown column [user.emial]')), /user\.emial/);
  assert.match(strictProblem(err('parsing_exception')), /fails without the nullify SET/);
});

test('bounded() keeps SET first and splices the time bound after FROM', async () => {
  const { bounded } = await import('../../scripts/esql.mjs');
  const b = bounded('SET unmapped_fields="nullify"; FROM x | STATS n = COUNT(*) BY api_key.name');
  assert.match(b, /^SET unmapped_fields="nullify"; FROM x \| WHERE .*\| STATS n = COUNT\(\*\) BY api_key\.name$/);
  const view = 'FROM v | WHERE event_time >= NOW() - 15 days | STATS t0 = MIN(event_time)';
  assert.equal(bounded(view), view, 'a query on the events view bounds itself, and has no @timestamp to bound');
});

test('every tooltip is 40 words at most, appended notes included, and so is every Discover session description', async () => {
  const { checkLayout, checkTips, checkSearchTips, tipWords, TIP_MAX_WORDS } = await import('../../scripts/lib/layout.mjs');
  const { prevKpi, PREV_NOTE } = await import('../../scripts/lib/panels.mjs');
  assert.equal(TIP_MAX_WORDS, 40);
  // A word has a letter or digit in it: separators and symbols do not count, a hyphenated word counts once.
  assert.equal(tipWords('Risk is weight × events — API-key clean-up · “email · via key”'), 9);
  assert.equal(tipWords(''), 0);
  assert.equal(tipWords(undefined), 0);
  for (const [name, def] of Object.entries(buildAll())) {
    for (const p of def.panels) {
      assert.ok(tipWords(p.config?.description) <= TIP_MAX_WORDS, `${name} ${p.id}: ${tipWords(p.config?.description)} words`);
    }
  }
  // What a builder appends counts: the prior-period note rides on the tile's own words.
  const tile = prevKpi(0, 0, 8, 5, 'total-events', 'Every audited event.');
  assert.equal(tile.config.description, `Every audited event. ${PREV_NOTE}`);
  assert.ok(tipWords(PREV_NOTE) <= 15, 'the note leaves room for the tile\'s own words');
  // Wired into checkLayout: one long tooltip fails, naming the panel.
  const all = buildAll();
  const [name, def] = Object.entries(all)[0];
  const p = def.panels.find((x) => x.config?.description);
  const saved = p.config.description;
  p.config.description = Array.from({ length: 41 }, (_, i) => `w${i}`).join(' ');
  assert.ok(checkLayout(all).problems.some((m) => m.startsWith(`${name}: panel ${p.id}`) && /41-word tooltip/.test(m)));
  p.config.description = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
  const out = []; checkTips(name, def.panels, out);
  assert.deepEqual(out, [], 'exactly 40 passes');
  p.config.description = saved;
  // searches/*.json: the shipped ones pass, and a long one in a scratch directory fails.
  const none = []; checkSearchTips(none); assert.deepEqual(none, []);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tips-'));
  try {
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ description: Array(41).fill('word').join(' ') }));
    const bad = []; checkSearchTips(bad, dir);
    assert.ok(bad.length === 1 && /searches\/x\.json: a 41-word description/.test(bad[0]), bad.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // A tooltip inside a section (the How to read panel, panels.mjs SECTIONS) is held to the same limit.
  const sec = def.panels.find((x) => x.section);
  sec.panels[0].config.description = Array(41).fill('word').join(' ');
  assert.ok(checkLayout(all).problems.some((m) => m.startsWith(`${name}: panel ${sec.panels[0].id}`) && /41-word tooltip/.test(m)), 'inner panels are checked');
  delete sec.panels[0].config.description;
});

test('How to read: a collapsed section under the intro, one small-text panel of bullets, and the API shape payload() sends', async () => {
  const { introMd, howToSection, collapsible, flatPanels, HOW_TO_MAX, HOW_TO_LABEL, HOW_TO_ROWS, NAV_H, resetIds } = await import('../../scripts/lib/panels.mjs');
  const { payload } = await import('../../scripts/dashboards.mjs');
  // The intro no longer carries the list.
  assert.equal(introMd(0, 0, 48, 6, 'Heading', ['One.']).config.content, '### Heading\n\nOne.\n');
  resetIds();
  const s = howToSection(9, ['First caveat.', 'Second caveat.']);
  assert.deepEqual([s.section, s.id, s.title, s.collapsed, s.grid], [true, 'sec-01', HOW_TO_LABEL, true, { x: 0, y: 9, w: 48, h: 1 }]);
  assert.equal(s.panels.length, 1);
  const [inner] = s.panels;
  assert.deepEqual([inner.type, inner.id, inner.small, inner.grid], ['markdown', 'md-02', true, { x: 0, y: 0, w: 48, h: HOW_TO_ROWS(2) }]);
  assert.equal(inner.config.content, '- First caveat.\n- Second caveat.\n', 'bullets only: the section header is the heading');
  assert.throws(() => howToSection(9, Array(HOW_TO_MAX + 1).fill('b')), /at most/);
  assert.throws(() => howToSection(9, ['two\nlines']), /one source line/);
  assert.throws(() => howToSection(9, []), /no bullets/);
  assert.match(howToSection(9, ['See [it](@search:00-all-events).']).panels[0].config.content, /\]\(\/app\/discover#\/view\/[\w-]+-search-all-events\)/);
  assert.deepEqual(flatPanels([{ id: 'a' }, s, { id: 'b' }]).map((p) => p.id), ['a', inner.id, 'b']);
  // payload(): a section is a panels entry with NO type, its grid only a y, its panels stripped like any other.
  const out = payload({ title: 't', panels: [s, collapsible(3, 'x', [{ type: 'markdown', id: 'm', headed: true, lint: {}, grid: { x: 0, y: 0, w: 48, h: 2 }, config: { content: 'c' } }])] });
  assert.deepEqual(out.panels[0], { id: 'sec-01', title: HOW_TO_LABEL, collapsed: true, grid: { y: 9 },
    panels: [{ type: 'markdown', id: 'md-02', grid: { x: 0, y: 0, w: 48, h: HOW_TO_ROWS(2) }, config: { content: '- First caveat.\n- Second caveat.\n' } }] });
  assert.ok(!('type' in out.panels[1]) && !('section' in out.panels[1]) && !('headed' in out.panels[1].panels[0]) && !('lint' in out.panels[1].panels[0]));
  // Every dashboard, both sets: intro, then the section directly under it, then the authored panels one row below.
  for (const AUDIT_WITH of [undefined, 'platform-volume']) {
    const prev = process.env.AUDIT_WITH;
    if (AUDIT_WITH) process.env.AUDIT_WITH = AUDIT_WITH; else delete process.env.AUDIT_WITH;
    try {
      for (const [n, d] of Object.entries(buildAll())) {
        const [, intro, sec, ...rest] = d.panels;
        assert.ok(intro.headed && !intro.config.content.includes(HOW_TO_LABEL), `${n}: the intro has no How to read list`);
        assert.equal(intro.grid.h, 6, `${n}: the intro is back at its measured height`);
        assert.ok(sec.section && sec.title === HOW_TO_LABEL && sec.collapsed, `${n}: How to read section, collapsed`);
        assert.equal(sec.grid.y, NAV_H + intro.grid.h, `${n}: directly under the intro`);
        assert.equal(Math.min(...rest.map((p) => p.grid.y)), sec.grid.y + 1, `${n}: the page resumes one row under the section header`);
        assert.ok(rest.every((p) => !p.section), `${n}: one section`);
        const bullets = sec.panels[0].config.content.trimEnd().split('\n');
        assert.ok(bullets.length >= 3 && bullets.length <= HOW_TO_MAX && bullets.every((b) => /^- [^\n<]+$/.test(b)), `${n}: 3–${HOW_TO_MAX} one-line bullets`);
      }
    } finally { if (prev === undefined) delete process.env.AUDIT_WITH; else process.env.AUDIT_WITH = prev; }
  }
});

test('the layout check understands sections: one header row on the page, its own grid inside, collapsed, under the intro', async () => {
  const { checkLayout } = await import('../../scripts/lib/layout.mjs');
  const fresh = () => buildAll();
  const first = (all) => { const [name, def] = Object.entries(all)[0]; return { name, def, sec: def.panels.find((p) => p.section) }; };
  assert.deepEqual(checkLayout(fresh()).problems, [], 'the shipped set is clean');
  const probs = (mut) => { const all = fresh(); const c = first(all); mut(c); return { ...c, problems: checkLayout(all).problems }; };
  let r = probs(({ sec }) => { sec.collapsed = false; });
  assert.ok(r.problems.some((m) => m === `${r.name}: section ${r.sec.id} "How to read this page" is not collapsed`), r.problems.join('\n'));
  r = probs(({ sec }) => { sec.grid.h = 2; });
  assert.ok(r.problems.some((m) => /header is \(0, 48x2\), expected one full-width row/.test(m)));
  r = probs(({ sec }) => { sec.panels[0].grid.y = 1; });
  assert.ok(r.problems.some((m) => m.startsWith(`${r.name} § How to read this page: grid has gaps`)), 'inner panels tessellate from y=0');
  r = probs(({ sec, def }) => { sec.panels[0].id = def.panels[0].id; });
  assert.ok(r.problems.some((m) => m.includes(`duplicate id ${r.def.panels[0].id}`)));
  r = probs(({ sec }) => { sec.panels = []; });
  assert.ok(r.problems.some((m) => /is empty$/.test(m)));
  // Moving the section one row down leaves a hole under the intro AND puts it away from the intro.
  r = probs(({ sec, def }) => { for (const p of def.panels.slice(def.panels.indexOf(sec))) p.grid.y += 1; });
  assert.ok(r.problems.some((m) => /grid has gaps/.test(m)) && r.problems.some((m) => /not directly under the intro/.test(m)), r.problems.join('\n'));
  // A panel after it on the header's row collides with the header.
  r = probs(({ sec, def }) => { def.panels[def.panels.indexOf(sec) + 1].grid.y -= 1; });
  assert.ok(r.problems.some((m) => m.includes(`panels ${r.sec.id} `) && / overlap$/.test(m)), r.problems.join('\n'));
});

test('the post-pass refuses a saved object whose sections do not match the definition', async () => {
  const { checkSections } = await import('../../scripts/dashboards.mjs');
  const { collapsible } = await import('../../scripts/lib/panels.mjs');
  const sec = { ...collapsible(9, 'How to read this page', [{ type: 'markdown', id: 'md-19', grid: { x: 0, y: 0, w: 48, h: 6 } }]), id: 'sec-18' };
  // The shape _export returns (probed on 9.6): inner panels carry gridData.sectionId, headers sit in `sections`.
  const obj = (sections) => ({ attributes: { sections } });
  const stored = [{ collapsed: true, gridData: { i: 'sec-18', y: 9 }, title: 'How to read this page' }];
  const panels = [{ panelIndex: 'md-16', gridData: { y: 3 } }, { panelIndex: 'md-19', gridData: { y: 0, sectionId: 'sec-18' } }];
  assert.doesNotThrow(() => checkSections('d', obj(stored), panels, [sec]));
  assert.doesNotThrow(() => checkSections('d', obj(undefined), [panels[0]], []), 'no sections, none expected');
  assert.throws(() => checkSections('d', obj(undefined), panels, [sec]), /0 section\(s\), the definition 1/);
  assert.throws(() => checkSections('d', obj([{ ...stored[0], collapsed: false }]), panels, [sec]), /collapsed=false/);
  assert.throws(() => checkSections('d', obj(stored), [panels[0], { ...panels[1], gridData: { y: 0 } }], [sec]), /holds \[\], defined \[md-19\]/);
  assert.throws(() => checkSections('d', obj(stored), [...panels, { panelIndex: 'x', gridData: { sectionId: 'sec-99' } }], [sec]), /holds|sec-99/);
});

test('Identity type (1.0.5.4): a badge beside Identity on every table, one colour per dropdown value', async () => {
  const { IDENTITY_KINDS, IDENTITY_KIND_COLORS, flatPanels } = await import('../../scripts/lib/panels.mjs');
  assert.deepEqual(Object.keys(IDENTITY_KIND_COLORS).sort(), IDENTITY_KINDS.map(([k]) => k).sort(), 'every type the dropdown lists has a colour');
  let tables = 0;
  for (const [name, def] of Object.entries(buildAll())) {
    for (const p of flatPanels(def.panels).filter((x) => x.config?.type === 'data_table')) {
      const cols = p.config.rows.map((r) => r.column);
      const at = cols.indexOf('actor');
      if (at < 0) continue;
      tables++;
      const kind = p.config.rows[at + 1];
      assert.equal(kind?.column, 'identity_kind', `${name}: ${p.config.title} shows Identity type right after Identity`);
      assert.equal(kind.apply_color_to, 'badge');
      assert.deepEqual(kind.color.mapping.map((m) => m.values[0]).sort(), Object.keys(IDENTITY_KIND_COLORS).sort());
      assert.match(p.config.data_source.query, /identity_kind = CASE\(/, `${name}: ${p.config.title} works the type out`);
    }
  }
  assert.ok(tables >= 22, `${tables} identity tables`);
});

test('Identity type (1.0.7.1): every table that shows Identity, the opt-in Platform Volume included, returns identity_kind and shows it; no exemption exists', async () => {
  const { flatPanels } = await import('../../scripts/lib/panels.mjs');
  const prev = process.env.AUDIT_WITH;
  process.env.AUDIT_WITH = 'platform-volume';
  try {
    const all = buildAll();
    assert.ok(all['06-platform-volume'], 'Platform Volume is built');
    const seen = [];
    for (const [name, def] of Object.entries(all)) {
      for (const p of flatPanels(def.panels).filter((x) => x.config?.type === 'data_table' && x.config.rows.some((r) => r.column === 'actor'))) {
        const cols = p.config.rows.map((r) => r.column);
        assert.ok(cols.includes('identity_kind'), `${name}: ${p.config.title} shows Identity without its Identity type`);
        assert.match(p.config.data_source.query, /\| KEEP [^|]*\bidentity_kind\b|BY [^|]*\bidentity_kind\b/, `${name}: ${p.config.title} returns identity_kind`);
        assert.equal(p.lint?.noKind, undefined, `${name}: ${p.config.title}`);
        seen.push(`${name}: ${p.config.title.split(' · ')[0]}`);
      }
    }
    for (const t of ['00-command-center: Live signal feed', '01-identity-access: Top failed or denied access', '01-identity-access: Failed sign-ins and denied access', '06-platform-volume: Highest-volume identities']) {
      assert.ok(seen.includes(t), t);
    }
    const t = table(0, 0, 48, 12, 't', 'FROM x | KEEP actor, identity_kind, user.name | LIMIT 10', ['actor', filterable('user.name')], [], 'd', { noKind: 'old option' });
    assert.deepEqual(t.config.rows.map((r) => r.column), ['actor', 'identity_kind', 'user.name'], 'noKind is no longer an option: the badge is always added');
    assert.equal(t.lint.noKind, undefined);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_WITH; else process.env.AUDIT_WITH = prev;
  }
});

test('checkIdentityPins() (1.0.7): a table showing Identity needs a click-to-filter identity column, or a recorded noPin reason', async () => {
  const { checkIdentityPins } = await import('../../scripts/lib/layout.mjs');
  const { PIN_PRINCIPAL_SHORT } = await import('../../scripts/lib/dashboards/shared.mjs');
  const q = 'FROM x | STATS events = COUNT(*) BY actor, identity_kind, user.name | SORT events DESC | LIMIT 10';
  const run = (rows, opts) => { const problems = []; checkIdentityPins('d', [table(0, 0, 48, 12, 't', q, rows, ['events'], 'd', opts)], problems); return problems; };
  const noPin = run(['actor', filterable('event.action')]);
  assert.equal(noPin.length, 1);
  assert.match(noPin[0], /shows Identity but has no click-to-filter identity column/);
  assert.deepEqual(run(['actor', filterable('event.action')], { noPin: 'the fold row has no principal' }), []);
  assert.equal(run(['actor'], { noPin: '  ' }).length, 1, 'a blank reason is no reason');
  assert.deepEqual(run(['actor', PIN_PRINCIPAL_SHORT]), []);
  assert.deepEqual(run(['actor', filterable('user.email')]), []);
  assert.deepEqual(run(['actor', filterable('api_key.name')]), []);
  assert.deepEqual(run([filterable('event.action')]), [], 'no Identity column, nothing to pin');
  assert.equal(run(['actor', { column: 'user.name' }]).length, 1, 'a user.name column that does not click does not count');
});

test('every identity table in the suite pins (1.0.7); the two exemptions say why, and the treemap drills into Identity 360', async () => {
  const { checkIdentityPins } = await import('../../scripts/lib/layout.mjs');
  const { flatPanels } = await import('../../scripts/lib/panels.mjs');
  const { payload } = await import('../../scripts/dashboards.mjs');
  const prev = process.env.AUDIT_WITH;
  process.env.AUDIT_WITH = 'platform-volume';
  try {
    const all = buildAll();
    const exempt = [];
    for (const [name, def] of Object.entries(all)) {
      const problems = []; checkIdentityPins(name, flatPanels(def.panels), problems);
      assert.deepEqual(problems, [], name);
      for (const p of flatPanels(def.panels).filter((x) => x.lint?.noPin)) exempt.push(`${name}: ${p.config.title.split(' · ')[0]}`);
    }
    assert.deepEqual(exempt.sort(), ['03-data-access: Denied requests by identity', '06-platform-volume: Highest-volume identities']);
    const tree = flatPanels(all['00-command-center'].panels).find((p) => p.config?.ref_id?.endsWith('actor-risk-treemap'));
    assert.equal(tree.pins, true, 'the treemap pins an identity, so it gets the drilldown');
    const sent = JSON.stringify(payload(all['00-command-center']));
    assert.doesNotMatch(sent, /"pins":/, 'pins is stripped from the payload');
    assert.doesNotMatch(sent, /"noPin":/);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_WITH; else process.env.AUDIT_WITH = prev;
  }
});

test('checkGradientLegends() (1.0.7, hole 15): a gradient legend and its scale fills go through a zero-domain guard', async () => {
  const { checkGradientLegends } = await import('../../scripts/lib/layout.mjs');
  const spec = (guarded) => ({
    signals: [{ name: 'empty', update: "length(data('raw')) === 0" }, ...(guarded ? [{ name: 'noRisk', update: "!empty && domain('risk')[1] <= 0" }] : [])],
    scales: [{ name: 'risk', type: 'sqrt', domain: { data: 'raw', field: 'severity' }, range: ['#54B399', '#D6BF57', '#E7664C'] }],
    marks: [{ type: 'rect', encode: { update: { fill: { signal: guarded ? "noRisk ? '#54B399' : scale('risk', datum.severity)" : "scale('risk', datum.severity)" } } } }],
    legends: [{ fill: 'risk', type: 'gradient', values: { signal: guarded ? "empty || noRisk ? [] : [0, domain('risk')[1]]" : "empty ? [] : [0, domain('risk')[1]]" } }],
  });
  const run = (s) => { const problems = []; checkGradientLegends('vega/x.json', s, problems); return problems; };
  assert.equal(run(spec(false)).length, 1, 'no guard signal at all');
  assert.match(run(spec(false))[0], /no signal compares domain\('risk'\)\[1\] with 0/);
  assert.deepEqual(run(spec(true)), []);
  const half = spec(true); half.marks[0].encode.update.fill.signal = "scale('risk', datum.severity)";
  assert.equal(run(half).length, 1, 'an unguarded fill beside a guarded legend');
  const vals = spec(true); vals.legends[0].values.signal = "empty ? [] : [0, domain('risk')[1]]";
  assert.equal(run(vals).length, 1, 'legend values that ignore the guard');
  // Blind spots the 1.0.7 review found, each of which used to pass.
  const enc = spec(true); enc.marks[0].encode.update.fill = { scale: 'risk', field: 'severity' };
  assert.equal(run(enc).length, 1, 'a { scale } fill encoding');
  const list = spec(true); list.marks[0].encode.update.fill = [{ test: 'datum.folded', value: '#98A2B3' }, { scale: 'risk', field: 'severity' }];
  assert.equal(run(list).length, 1, 'a { scale } fill behind a test that is not the guard');
  const ok = spec(true); ok.marks[0].encode.update.fill = [{ test: 'noRisk', value: '#54B399' }, { scale: 'risk', field: 'severity' }];
  assert.deepEqual(run(ok), [], 'a { scale } fill behind the guard');
  const untyped = spec(false); delete untyped.legends[0].type;
  assert.equal(run(untyped).length, 1, 'no legend type over a continuous scale is still a gradient');
  const sym = spec(false); delete sym.legends[0].type; sym.scales[0].type = 'ordinal';
  assert.deepEqual(run(sym), [], 'a symbol legend over an ordinal scale is not checked');
  const reads = spec(true); reads.signals[1] = { name: 'noRisk', update: "domain('risk')[1] / 4" };
  assert.equal(run(reads).length, 1, 'a signal that only reads domain(S)[1] is not a guard');
  const nested = spec(false); nested.marks = [{ type: 'group', legends: nested.legends, marks: nested.marks }]; nested.legends = [];
  assert.equal(run(nested).length, 1, 'a legend inside a group mark');
  // The shipped treemap passes.
  const { readFileSync } = await import('node:fs');
  const tm = JSON.parse(readFileSync(new URL('../../vega/01-actor-risk-treemap.json', import.meta.url), 'utf8'));
  assert.deepEqual(run(tm), []);
});

test('vega/01 treemap (1.0.7): a tile click pins the identity by its prefix, a folded tile pins nothing; vega/11 has no clear-all', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => JSON.parse(readFileSync(new URL(`../../vega/${f}`, import.meta.url), 'utf8'));
  const tm = read('01-actor-risk-treemap.json');
  const q = tm.data[0].url.query;
  assert.match(q, /pin = CASE\(user\.email IS NOT NULL, CONCAT\("e\|", user\.email\), api_key\.name IS NOT NULL, CONCAT\("k\|"/);
  assert.match(q, /pin = MAX\(pin\) BY actor, identity_kind \|/);
  assert.match(q, /KEEP actor, identity_kind, owner, pin,/);
  // 1.0.7.1: blocks are the eight Identity types, worked out as the identity tables work them out.
  const { IDENTITY_KEYS, KIND_GROUPED, ACTOR_RESOLVE, IDENTITY_KINDS } = await import('../../scripts/lib/panels.mjs');
  assert.ok(q.includes(`BY ${IDENTITY_KEYS} | ${ACTOR_RESOLVE} | ${KIND_GROUPED} |`), 'IDENTITY_KEYS → ACTOR_RESOLVE → KIND_GROUPED');
  for (const [k] of IDENTITY_KINDS) assert.ok(KIND_GROUPED.includes(`"${k}"`), k);
  assert.doesNotMatch(JSON.stringify(tm), /actor_kind|kind_rank|"Kind"|'Kind'/, 'no second kind vocabulary');
  assert.ok(tm.data.find((d) => d.name === 'tree').transform.find((t) => t.type === 'nest').keys.includes('identity_kind'));
  const rect = tm.marks.find((m) => m.type === 'rect');
  assert.equal(rect.name, 'tile');
  assert.ok(rect.encode.update.cursor, 'cursor pointer on a pinnable tile');
  const click = tm.signals.find((s) => s.on?.some((o) => o.events === '@tile:click'));
  const expr = click.on[0].update;
  assert.match(expr, /^datum\.folded \|\| !datum\.pin \? null : kibanaAddFilter\(/);
  for (const f of ['user.email', 'api_key.name', 'user.domain', 'user.name']) assert.ok(expr.includes(`'${f}'`), f);
  assert.match(expr, /must_not: \[\{exists: \{field: 'user\.email'\}\}, \{exists: \{field: 'api_key\.name'\}\}\]/);
  // k| and u| carry the Identity dropdown's own conditions (1.0.7 review): a bare user.name phrase on a 1-event
  // "user, no email" tile matched that person's 6,570 events.
  assert.ok(expr.includes("{bool: {filter: [{match_phrase: {'api_key.name': substring(datum.pin, 2)}}], must_not: [{exists: {field: 'user.email'}}]}}"), 'k| excludes events with an email');
  assert.ok(expr.includes("{terms: {'user.domain': ['_cloud_api_key', '_es_api_key', '_service_account']}}"), 'u| and f| exclude key and service-account realms');
  // f| (1.0.7.1) pins a Failed sign-in tile to the failed sign-ins under that name; u| (Other) leaves them out.
  assert.ok(expr.includes("=== 'f|' ? {bool: {filter: [{match_phrase: {'user.name': substring(datum.pin, 2)}}, {terms: {'event.action': ['authentication_failed', 'anonymous_access_denied']}}]"), 'f| filters to failed sign-ins');
  assert.match(expr, /must_not: \[[^\]]*\]\}\}, \{terms: \{'event\.action': \['authentication_failed', 'anonymous_access_denied'\]\}\}\]\}\}, 'logs-/, 'u| excludes failed sign-ins');
  assert.match(q, /user\.domain IN \("_cloud_api_key","_es_api_key","_service_account"\), CONCAT\("d\|"/, 'a service account pins by its realm');
  assert.match(q, /failed_signin, CONCAT\("f\|", user\.name\), CONCAT\("u\|", user\.name\)\)/);
  assert.doesNotMatch(expr, /: \{match_phrase: \{'user\.name'/, 'no bare user.name phrase');
  assert.deepEqual(tm.scales.find((x) => x.name === 'risk').domain, { data: 'raw', field: 'severity' }, 'the colour scale and the no-risk guard cover folded identities');
  assert.ok(tm.marks.find((m) => m.type === 'text' && m.from?.data === 'leaves'), 'tile text');
  const leaves = tm.data.find((d) => d.name === 'leaves').transform.map((t) => t.as);
  for (const x of ['a', 'b', 'c']) assert.ok(leaves.includes(`${x}_risk`), `${x}_risk line`);
  // 1.0.7.1: a narrow tile printed "1" without "event"; the count prints whole ("1 event") or not at all.
  const lt = tm.data.find((d) => d.name === 'leaves').transform;
  for (const t of lt.filter((x) => /^[abc]_lines$|^lines$/.test(x.as))) assert.ok(!t.expr.includes("format(datum.events, ',')"), `${t.as} prints a bare number`);
  for (const x of ['a', 'b', 'c']) assert.match(lt.find((t) => t.as === `${x}_cnt`).expr, /length\(datum\.count\) <=/);
  assert.ok(!read('11-actor-object-flow.json').signals.some((s) => s.on?.some((o) => /dblclick/.test(JSON.stringify(o.events)))), 'no double-click clear-all');
});

test('drillTargets()/repointVega() (1.0.7): a pinning Vega panel gets the drilldown and the scoped savedObjectRef', async () => {
  const { drillTargets, repointVega } = await import('../../scripts/dashboards.mjs');
  const { ACTOR_360 } = await import('../../scripts/lib/drilldowns.mjs');
  const flat = [
    { id: 'v1', type: 'vis', pins: true, config: { ref_id: 'tree' } },
    { id: 'v2', type: 'vis', config: { ref_id: 'flow' } },
  ];
  const drill = drillTargets('elastic_cloud-audit-00-command-center', flat);
  assert.deepEqual([...drill.keys()], ['v1'], 'pins puts a Vega panel among the drilled panels');
  assert.equal(drill.get('v1'), ACTOR_360);
  const panels = [{ panelIndex: 'v1', panelRefName: 'panel_v1', embeddableConfig: { savedObjectId: 'x' } }, { panelIndex: 'v2', embeddableConfig: {} }];
  const refs0 = [{ name: 'panel_v1', type: 'visualization', id: 'old' }, { name: 'v1:savedObjectRef', type: 'visualization', id: 'old' }];
  const { refs, changed } = repointVega(panels, refs0, { v1: 'tree', v2: 'flow' }, drill);
  assert.equal(changed, 2);
  assert.equal(panels[0].panelRefName, undefined, 'a drilled Vega panel has no legacy panelRefName');
  assert.equal(panels[0].embeddableConfig.savedObjectId, undefined);
  assert.equal(panels[1].panelRefName, 'panel_v2', 'an undrilled one keeps panel_<idx>');
  assert.deepEqual(refs, [{ name: 'v1:savedObjectRef', type: 'visualization', id: 'tree' }, { name: 'panel_v2', type: 'visualization', id: 'flow' }]);
});
