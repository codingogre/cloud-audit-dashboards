/**
 * Custom panels (9.6 `custom_content`, tech preview): the panel shape the Dashboards API accepted on a live
 * deploy, the query guards every panel query obeys, and a template the sandbox will render. No network.
 * scripts/lib/custom.mjs records what the API and renderer were measured to accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandIcons, loadTemplate, ICONS, TEMPLATE_LIMIT } from '../../scripts/lib/custom.mjs';
import { CONTROLS_WHERE } from '../../scripts/lib/panels.mjs';
import { buildAll } from '../../scripts/lib/definitions.mjs';

const customPanels = () => Object.entries(buildAll()).flatMap(([name, d]) =>
  d.panels.flatMap((p) => (p.section ? p.panels : [p])).filter((p) => p.type === 'custom_content').map((p) => ({ name, p })));

test('Identity 360 carries the identity-path custom panel in the shape the 9.6 API accepted', () => {
  const found = customPanels();
  assert.equal(found.length, 1);
  const { name, p } = found[0];
  assert.match(name, /07-actor-360/);
  assert.deepEqual(Object.keys(p.config).sort(), ['description', 'esql_query', 'template', 'title']);
  assert.equal(p.config.esql_query.length, 1, 'the API takes at most one query');
});

test('a custom panel query obeys the suite guards: control bar, nullify, no FORK, no noise gate', () => {
  for (const { p } of customPanels()) {
    const q = p.config.esql_query[0];
    assert.ok(q.includes(CONTROLS_WHERE), 'follows the four dropdowns');
    assert.ok(q.startsWith('SET unmapped_fields="nullify";'), 'names api_key.* through TIME, so it must nullify');
    assert.ok(!/\| FORK /.test(q), 'a FORK branch re-runs the whole pipeline above it (4.8s at 7d on the perf replica)');
    assert.match(q, /\| SORT step, rank DESC \| LIMIT \d+$/, 'stages in reading order, objects last, so the cap only trims objects');
    assert.ok(!/indices:data\/read\/search/.test(q), 'the noise gate would remove the reads the last step shows');
  }
});

test('a custom panel template is what the sandbox renders: no script, no handlers, no sprite, no remote URLs', () => {
  for (const { p } of customPanels()) {
    const t = p.config.template;
    assert.ok(Buffer.byteLength(t) < TEMPLATE_LIMIT);
    assert.ok(!/<script/i.test(t), 'scripts never run');
    assert.ok(!/\son[a-z]+\s*=/i.test(t), 'inline handlers never run');
    assert.ok(!/<use\b/.test(t), '<use> is stripped by the sanitizer, so an icon drawn through it is blank');
    assert.ok(!/<icon\b/.test(t), 'every icon tag expanded at build time');
    assert.ok(!/(src|href)\s*=\s*"(https?:)?\/\//i.test(t), 'remote resources do not load and remote links lose their href');
    for (const [, href] of t.matchAll(/href="([^"]+)"/g)) assert.match(href, /^\/app\/(dashboards|discover)/, `only Kibana dashboard/Discover links survive: ${href}`);
  }
});

test('expandIcons(): a named icon becomes its SVG, a variable becomes a Liquid case, an unknown name throws', () => {
  assert.equal(expandIcons('<icon name="db" class="x"/>'), `<svg class="ic x" viewBox="0 0 16 16" aria-hidden="true">${ICONS.db}</svg>`);
  const v = expandIcons('<icon var="ic"/>');
  assert.ok(v.startsWith('{%- case ic -%}') && v.endsWith('{%- endcase -%}'));
  for (const k of Object.keys(ICONS)) assert.ok(v.includes(`{%- when "${k}" -%}`));
  assert.throws(() => expandIcons('<icon name="nope"/>'), /unknown icon/);
});

test('the identity-path template steps through six panes with one radio each', () => {
  const t = loadTemplate('11-identity-path');
  for (let i = 0; i <= 5; i++) {
    assert.ok(t.includes(`id="ip${i}"`), `radio ip${i}`);
    assert.ok(t.includes(`#ip${i}:checked~.panes .k${i}`), `pane ${i} is shown by its radio`);
  }
  assert.ok(t.includes('class="pane k{{ n }}"'), 'steps 1-4 come from one loop');
});
