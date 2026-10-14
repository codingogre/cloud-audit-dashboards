/**
 * The shared panel helpers' presentation contract: headers, widths, visible rows, legends and
 * markdown headings. No network. Each rule here was settled by rendering a live 9.6 dashboard (see
 * the comments in scripts/lib/panels.mjs); these tests keep a refactor from quietly undoing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  table, sized, filterable, label, humanise, fitRows, xy, bar, md, COLUMNS, PALETTE_ID,
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
  const t = table(0, 0, 24, 12, 't', 'FROM x | LIMIT 5',
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

test('fitRows() and the LIMIT clamp', () => {
  assert.deepEqual([8, 12, 14].map(fitRows), [6, 10, 13]);
  const q = (t) => t.config.data_source.query;
  assert.match(q(table(0, 0, 16, 12, 't', 'FROM x | SORT a | LIMIT 30', ['a'], ['b'], 'd')), /\| LIMIT 10$/);
  assert.match(q(table(0, 0, 16, 12, 't', 'FROM x | LIMIT 5', ['a'], ['b'], 'd')), /\| LIMIT 5$/, 'never raised');
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
