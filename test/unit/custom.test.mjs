/**
 * Custom panels (9.6 `custom_content`, tech preview): the panel shape the Dashboards API accepted on a live
 * deploy, the query guards every panel query obeys, and a template the sandbox will render. No network.
 * scripts/lib/custom.mjs records what the API and renderer were measured to accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandIcons, expandLabels, expandDsets, loadTemplate, ICONS, LABELS, TEMPLATE_LIMIT } from '../../scripts/lib/custom.mjs';
import { PROJECT_WHERE, IDENTITY_WHERE, CLIENT_IP_WHERE, READ_ACTIONS, LOOKUP_ACTIONS, ANY } from '../../scripts/lib/panels.mjs';
import { IDENTITY_PATH, IDENTITY_PATH_TABLE, T_CLIENT_IP, T_ROWS } from '../../scripts/lib/dashboards/07-actor-360.mjs';
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
    // Client IP is tested after the request join: a read's own client is Kibana (100.64.x.x), never the browser.
    assert.ok(q.includes(`${PROJECT_WHERE} AND ${IDENTITY_WHERE}`), 'follows Project, Identity type and Identity in the source filter');
    assert.ok(!q.includes(CLIENT_IP_WHERE), 'not Client IP in the source filter, or every read is dropped when it is set');
    assert.ok(T_CLIENT_IP !== CLIENT_IP_WHERE && T_CLIENT_IP.includes('cip == TO_IP('), 'Client IP against the joined address');
    const at = (s) => q.indexOf(s);
    assert.ok(at(`WHERE ${T_CLIENT_IP}`) > at('BY cred, type, oid'), 'Client IP after both joins');
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
  assert.ok(q.includes('MV_EXPAND lvl') && q.includes('TOP(pack, 25, "desc")') && q.includes('MD5('));
  assert.ok(q.includes('COUNT_DISTINCT(rq) WHERE op == "list"'), 'a listing counts once per request, not per object returned');
  assert.ok(!q.includes('INLINE STATS'), 'an INLINE STATS re-runs everything above it (2.4s at 7d for the request join)');
  // the request join: space and browser address from Kibana's http_request event, people and data endpoints only
  assert.ok(q.includes('event.action == "http_request" AND NOT user.domain IN ("_cloud_api_key", "_es_api_key") AND url.original RLIKE'),
    'every http_request event took the query to 1.65s at 7d');
  assert.ok(q.includes('BY rid ') && q.includes('kspaces = VALUES(space), kips = VALUES(cip)'), 'a read with no event of its own takes its object\'s space and address');
});

test('every child the query returns can be picked, and each Kibana app is its own object type', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(src.includes('{%- assign cap = 1000 -%}'), '"+3 more" that could not be opened was a dead end');
  assert.ok(src.includes('<div class="cs">') && /\.cs\{[^}]*overflow-y:auto/.test(src), 'a long column scrolls');
  assert.ok(!src.includes('name="lock"'), 'a lock beside a credential read as a property of the credential');
  assert.ok(IDENTITY_PATH.includes('CONCAT("app:", COALESCE(c_app, ""))'), 'each Kibana app is its own object type');
  assert.ok(expandLabels('<labels level="L" key="k"/>').includes('contains "app:"'), 'and is labelled by its name');
});

test('the drill-down never adds Kibana actions and data requests into one figure', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(!src.includes('<span class="ct">{{ a }}</span>'), 'one number summed two measures (599 = 583 actions + 16 data requests)');
  assert.ok(src.includes('r["kacts"].value') && src.includes('class="dq"'), 'actions, then data requests, each its own figure');
  assert.ok(!/\{\{ ra \}\} actions<\/div>/.test(src), 'the fold row counts actions and data requests apart');
  assert.ok(IDENTITY_PATH.includes('kacts = opens + creates + changes + deletes + runs + lists,') && IDENTITY_PATH.includes('sib_k = SUM(kacts)'));
});

test('a data set opens its queries in a panel under the columns, lookups left out, no dropdown', () => {
  const t = loadTemplate('11-identity-path');
  assert.ok(IDENTITY_PATH.includes('EVAL lvl = [0, 1, 2, 3, 4, 5, 6]'), 'a level per request');
  assert.ok(IDENTITY_PATH.includes('WHERE lvl < 6 OR (es AND fam IS NOT NULL AND (NOT meta OR (lang IN ("ES|QL", "search", "SQL", "EQL") AND rq LIKE "*;*;*")))'), 'bare lookups and background column discovery never listed');
  assert.ok(IDENTITY_PATH.includes('acts = CASE(lvl == 6, TO_LONG(seen) / 1000'), 'requests rank newest first');
  assert.ok(t.includes('<details name="dsel" class="dk k{{ did }}"><summary class="ds dl'), 'a data-set chip opens its panel');
  assert.ok(!/<details name="dsel"[^>]*\sopen/.test(t), 'nothing open by default');
  assert.ok(t.includes('<details name="dsel" class="dk xd"><summary class="x"'), 'Close is one more member of the group');
  assert.match(t, /\.dv\{display:none/, 'the panel is hidden until a data set is clicked');
  assert.ok(t.includes(':has(#n{{ r["h4"].value }}:checked):has(.k{{ gp }}[open]) .v{{ gp }}{display:flex}'), 'it shows only while the path to its object is still picked');
  assert.ok(t.includes('not the query text'), 'says the audit log has no query text');
});

test('the system badge sits from object type down, never on a credential or a space', () => {
  assert.ok(loadTemplate('11-identity-path').includes('r["sysn"].value > 0 and L >= 3'));
});

test('the sanitizer keeps the style: no tag-like text inside <style>', () => {
  // A `<` followed by a letter or `/` anywhere in a style element's text makes Kibana's sanitizer drop the whole
  // element (a CSS comment naming <details> blanked every rule on a 2026-11-10 private deploy).
  for (const { p } of customPanels()) {
    for (const [, css] of p.config.template.matchAll(/<style>([\s\S]*?)<\/style>/g)) assert.ok(!/<[\/\w]/.test(css), css.match(/.{0,40}<[\/\w].{0,20}/)?.[0]);
  }
});

test('the drill-down prints times in the viewer\'s zone: ISO from the query, formatted by Liquid in the browser', () => {
  const t = loadTemplate('11-identity-path');
  assert.ok(IDENTITY_PATH.includes('lastf = TO_STRING(seen)'), 'an ISO string, not a UTC-formatted one');
  assert.ok(!/DATE_FORMAT\("MMM/.test(IDENTITY_PATH));
  assert.ok(t.includes('{{ r["lastf"].value | date: "%b %-d %H:%M" }}') && t.includes('{{ r["lastf"].value | date: "%b %-d %H:%M:%S" }}'));
  assert.ok(!/\bUTC\b/.test(t.replace(/<style>[\s\S]*?<\/style>/, '')), 'no UTC label left');
});

test('the drill-down works from the keyboard: every chip, the list toggles and Close take focus and show it', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  const t = loadTemplate('11-identity-path');
  assert.ok(!/\.dsel\{display:none\}/.test(t) && !t.includes('type="radio" name="dsel"'), 'hidden radios were mouse-only');
  assert.ok(/summary\.ds:focus-visible[^{]*\.dv summary\.x:focus-visible[^{]*\{outline:2px/.test(t), 'chips and Close show focus');
  assert.ok(src.includes('.ip:has(#n{{ r["nid"].value }}:focus-visible) .b{{ r["nid"].value }}{outline:'), 'the breadcrumb shows which item has focus');
  assert.ok(/\.it input:focus-visible\+\.bx\{outline/.test(t), 'the level radios keep theirs');
  assert.equal((src.match(/<dset name="\w+" label="\w+"\/>/g) || []).length, 4, 'every chip goes through expandDsets');
});

test('expandDsets(): a data set with requests is a details in the dsel group, any other a plain label', () => {
  const out = expandDsets('<dset name="fm" label="lab"/>');
  assert.ok(out.includes('{%- if dmap contains dn -%}'));
  assert.ok(out.includes('<details name="dsel" class="dk k{{ did }}">'));
  assert.ok(out.includes('{%- else -%}<span class="ds{% if c0 == "." %} sys{% endif %}" title="{{ fm }}">'), 'a lookup-only data set is not a dead link');
  assert.ok(!/(href|for)=/.test(out));
});

test('data-set ids are MD5 prefixes from the query, never built from the index name', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(!src.includes('replace: ".", "_"'), 'a name with + @ = ( ) \' & ! made an invalid selector');
  assert.ok(src.includes('{%- assign did = gp -%}') && src.includes('.v{{ gp }}{display:flex}'), 'the panel id is the level-6 parent id');
  assert.ok(IDENTITY_PATH.includes('pid = CASE(lvl <= 1, null, SUBSTRING(MD5(parent), 1, 10))'), 'parent of a request = object path + data set');
  assert.ok(src.includes('append: r["h5"].value') || src.includes('r["h5"].value | append: "#"'), 'dmap keys a panel by its object id');
});

test('the row cap: the panel says so, and a cut panel counts the requests it shows', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(IDENTITY_PATH.endsWith(`| LIMIT ${T_ROWS}`));
  assert.ok(src.includes(`rows.size >= ${T_ROWS}`), 'the template tests the same cap as the query');
  assert.ok(src.includes('Some objects and requests are not shown. Narrow the time range or pick an identity.'));
  assert.ok(src.includes('{% if shn < sn %}; the latest {{ shn }} of {{ sn }}{% endif %}'), '"the latest 25" was wrong when the cap cut a panel short');
  assert.ok(!src.includes('the latest 25 of'));
  // "and N more" / "+N smaller" subtract the children drawn (c) from the pre-LIMIT sib_n, so they stay true when cut
  assert.ok(src.includes('{%- assign rest = sn | minus: c -%}') && src.includes('{%- assign sn = r["sib_n"].value -%}'));
});

test('nobody selected: the query flags it from ?identity, and the panel says it covers every identity', () => {
  const t = loadTemplate('11-identity-path');
  assert.ok(IDENTITY_WHERE.includes(`?identity == "" OR ?identity == "${ANY}"`), 'the control sends "" or Any for nobody');
  assert.ok(IDENTITY_PATH.includes(`anyone = CASE(lvl == 0 AND (?identity == "" OR ?identity == "${ANY}"), 1, 0)`));
  assert.ok(t.includes('{%- if tot["anyone"].value == 1 -%}') && t.includes('<b>All identities.</b> Pick one in the Identity control, or click a Principal id in <i>Who this is</i>.'));
});

test('AUDIT_NO_CUSTOM=1 swaps the drill-down for a Lens table of the same paths in the same slot', () => {
  const was = process.env.AUDIT_NO_CUSTOM;
  const pick = (all) => all['07-actor-360'].panels.flatMap((p) => (p.section ? p.panels : [p]));
  try {
    delete process.env.AUDIT_NO_CUSTOM;
    const drill = pick(buildAll()).find((p) => p.type === 'custom_content');
    process.env.AUDIT_NO_CUSTOM = '1';
    const all = buildAll();
    assert.equal(Object.values(all).flatMap((d) => d.panels.flatMap((p) => (p.section ? p.panels : [p]))).filter((p) => p.type === 'custom_content').length, 0);
    const tbl = pick(all).find((p) => p.config?.data_source?.query?.includes('BY cred, space, type, op'));
    assert.ok(tbl, 'a table of the paths');
    assert.equal(tbl.config.type, 'data_table');
    assert.deepEqual(tbl.grid, drill.grid, 'same grid slot');
    assert.ok(IDENTITY_PATH_TABLE.startsWith(IDENTITY_PATH.slice(0, IDENTITY_PATH.indexOf(' | EVAL lvl = '))), 'reads the drill-down\'s own fine rows');
    assert.ok(tbl.config.rows.map((r) => r.column).join() === 'credential,space,object_type,operation');
  } finally {
    if (was === undefined) delete process.env.AUDIT_NO_CUSTOM; else process.env.AUDIT_NO_CUSTOM = was;
  }
});

test('--verify looks inside the custom panel frame and fails a blank drill-down', () => {
  const v = readFileSync('scripts/verify.mjs', 'utf8');
  assert.ok(v.includes('page.frames()') && v.includes("document.querySelectorAll('.it')") && v.includes('No Kibana activity in this selection'));
  assert.ok(/\|\| truncated \|\| drillBad \|\|/.test(v), 'a blank drill-down fails the run');
  assert.ok(loadTemplate('11-identity-path').includes('No Kibana activity in this selection'), 'the empty state verify reads is still in the template');
});
