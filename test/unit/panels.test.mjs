/**
 * The shared panel helpers' presentation contract: headers, widths, visible rows, legends and
 * markdown headings. No network. Each rule here was settled by rendering a live 9.6 dashboard (see
 * the comments in scripts/lib/panels.mjs); these tests keep a refactor from quietly undoing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  table, sized, filterable, label, humanise, fitRows, xy, bar, md, pie, blankNull, gridPx, COLUMNS, PALETTE_ID,
  OPAQUE_ID_NOTE,
} from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { sessionGrid } from '../../scripts/objects.mjs';
import { nsId } from '../../scripts/lib/env.mjs';

test('label() uses the suite vocabulary, then humanises', () => {
  assert.equal(label('actor'), 'Identity');
  assert.equal(label('last_seen'), 'Last seen');
  assert.equal(label('attributes.user.email'), 'Email');
  assert.equal(label('attributes.kibana.saved_object.id'), 'ID');
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
    [filterable('attributes.user.email'), 'action', sized('name', 300, { label: 'Object' })], ['events', 'last_seen'], 'd');
  const [email, action, name] = t.config.rows;
  assert.deepEqual([email.column, email.label, email.click_filter], ['attributes.user.email', 'Email', true]);
  assert.equal(action.width, undefined, 'text columns flex');
  assert.deepEqual([name.label, name.width], ['Object', 300], 'call-site label and width win');
  assert.equal(t.config.metrics[0].width, COLUMNS.events.width);
  assert.equal(t.config.metrics[1].width, COLUMNS.last_seen.width, 'metric dates are sized too');
});

test('a table whose every column is fixed lets its widest row column flex', () => {
  const t = table(0, 0, 48, 12, 't', 'FROM x', [sized('actor', 200), sized('name', 400), 'verb'], ['events'], 'd');
  assert.equal(t.config.rows[1].width, undefined);
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
});

test('a table showing the resolved identity explains an opaque one; blankNull() blanks after the STATS', () => {
  assert.ok(table(0, 0, 24, 12, 't', 'q', ['actor'], ['events'], 'Who.').config.description.endsWith(OPAQUE_ID_NOTE));
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
    assert.equal(nsId('cloud-audit-vega-01-x'), 'cloud-audit-vega-01-x');
    process.env.AUDIT_ID_NS = 'mine';
    assert.equal(nsId('cloud-audit-vega-01-x'), 'cloud-audit-mine-vega-01-x');
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
  assert.ok(quiet.config.description.endsWith(EMPTY.quiet.desc));
  assert.equal(EMPTY.good.title, '(empty = good)', 'a condition, true whether or not there are rows');
  assert.ok(good.config.description.startsWith('Reads. ') && good.config.description.endsWith(EMPTY.good.desc));
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
  for (const f of ['attributes.url.original', 'attributes.kibana.saved_object.id', 'attributes.kibana.saved_object.type']) assert.ok(KIBANA_INTERNALS.includes(`${f} IS NOT NULL AND`), f);
  // The browser-session test is IS NULL, which is never null itself.
  assert.ok(!/attributes\.kibana\.session\.id (?!IS NULL)/.test(KIBANA_INTERNALS));
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

test('an opaque Cloud API key id has one display form, and table() applies it', async () => {
  const { ACTOR_LABEL, CLOUD_KEY_TAG, cloudKeyLabel } = await import('../../scripts/lib/panels.mjs');
  assert.equal(CLOUD_KEY_TAG, '… · Cloud API key');
  assert.match(ACTOR_LABEL, /^EVAL actor = CASE\(/);
  assert.match(cloudKeyLabel('attributes.user.name', 'attributes.api_key.name'), /, attributes\.api_key\.name\)$/);
  const q = table(0, 0, 24, 12, 't', 'FROM x | STATS events = COUNT(*) BY actor | SORT events DESC | LIMIT 30', ['actor'], ['events'], 'd').config.data_source.query;
  assert.ok(q.endsWith(`| LIMIT 10 | ${ACTOR_LABEL}`), 'after the clamp, on the displayed rows only');
  assert.ok(!table(0, 0, 24, 12, 't', 'FROM x | LIMIT 3', ['action'], ['events'], 'd').config.data_source.query.includes(ACTOR_LABEL));
});

test('privileged ops leave out only Kibana\'s own key clean-up, and say how much', async () => {
  const { HOUSEKEEPING, PRIVILEGED, privilegedKpi, PLATFORM_ACTORS } = await import('../../scripts/lib/panels.mjs');
  assert.ok(HOUSEKEEPING.includes('"invalidate_apikeys"') && HOUSEKEEPING.includes(PLATFORM_ACTORS));
  // Every term guarded, so NOT HOUSEKEEPING never evaluates to null and drops a row.
  for (const f of ['attributes.event.action', 'attributes.user.name']) assert.ok(HOUSEKEEPING.includes(`${f} IS NOT NULL AND ${f}`), f);
  assert.ok(PRIVILEGED.endsWith(`AND NOT ${HOUSEKEEPING}`));
  assert.match(privilegedKpi('Privileged ops'), /COUNT\(\*\) WHERE NOT housekeeping.*housekeeping_note/);
  // The short, digit-grouped second line ("excl. 2,285 cleanups"), so it never outweighs the number under it.
  assert.match(privilegedKpi('Privileged ops'), /CONCAT\("excl\. ", CASE\(LENGTH\(TO_STRING\(cleanups\)\) <= 3/);
});
