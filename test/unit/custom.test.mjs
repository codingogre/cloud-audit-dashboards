/**
 * Custom panels (9.6 `custom_content`, tech preview): the panel shape the Dashboards API accepted on a live
 * deploy, the query guards every panel query obeys, and a template the sandbox will render. No network.
 * scripts/lib/custom.mjs records what the API and renderer were measured to accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandIcons, expandLabels, loadTemplate, ICONS, LABELS, TEMPLATE_LIMIT } from '../../scripts/lib/custom.mjs';
import { CONTROLS_WHERE, READ_ACTIONS, LOOKUP_ACTIONS } from '../../scripts/lib/panels.mjs';
import { IDENTITY_PATH } from '../../scripts/lib/dashboards/07-actor-360.mjs';
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
    assert.match(q, /\| SORT lvl, pid, acts DESC, k \| LIMIT \d+$/, 'levels in order and siblings contiguous, busiest first');
    assert.ok(!q.includes('NOT (elasticsearch.audit.action LIKE "indices:data/read/search*"'), 'the noise gate would remove the reads the last step shows');
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

test('the drill-down template: one radio group per parent, children revealed by a generated rule, no Liquid that fails on rows', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  const t = loadTemplate('11-identity-path');
  assert.ok(src.includes('name="r{{ p }}"'), 'siblings share one radio group per parent');
  assert.ok(src.includes(':has(#n{{ r["nid"].value }}:checked) :is(.g{{ r["nid"].value }},.b{{ r["nid"].value }})'), 'a node shows its children and crumb');
  assert.ok(!/\|\s*(where|map|group_by|sum)\s*:/.test(src), 'where/map/group_by/sum do not work on rows');
  assert.ok(!src.includes('.pct'), '.pct is relative to all rows, not a parent');
  assert.ok(!/object events/i.test(src), '"object events" conflated two measures; retired');
  for (const [, body] of t.matchAll(/@keyframes\s+\w+\s*\{([^}]*\{[^}]*\})*[^}]*\}/g)) assert.ok(!/\bto\s*\{/.test(body), 'keyframes define only `from`, so reduced motion shows the settled frame');
  assert.ok(!/infinite/.test(t), 'nothing animates forever');
});

test('expandLabels(): every level resolves a known key and falls back to the raw key', () => {
  const out = expandLabels('<labels level="L" key="k"/>');
  for (const [lvl, table] of Object.entries(LABELS)) {
    assert.ok(out.includes(`{%- when ${lvl} -%}`));
    for (const [key, [lbl]] of Object.entries(table)) assert.ok(out.includes(`{%- when "${key}" -%}{%- assign lbl = "${lbl}"`), `${lvl}/${key}`);
  }
  assert.ok(out.includes('{%- assign lbl = k | replace: "-", " " -%}'));
});

test('the drill-down query: action lists from the fragments, a tree with ids, no FORK', () => {
  const q = IDENTITY_PATH;
  for (const a of [...READ_ACTIONS, ...LOOKUP_ACTIONS]) assert.ok(q.includes(`"${a}"`), a);
  assert.equal(READ_ACTIONS.filter((a) => LOOKUP_ACTIONS.includes(a)).length, 0, 'read and lookup are disjoint');
  assert.ok([...READ_ACTIONS, ...LOOKUP_ACTIONS].every((a) => !a.includes('[')), 'no shard or node copies');
  assert.ok(q.includes('MV_EXPAND lvl') && q.includes('TOP(pack, 10, "desc")') && q.includes('MD5('));
  assert.ok(q.includes('COUNT_DISTINCT(rq) WHERE op == "list"'), 'a listing counts once per request, not per object returned');
  assert.ok(!q.includes('INLINE STATS'), 'an INLINE STATS join cost ~450ms at 7d');
});
