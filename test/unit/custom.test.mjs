/**
 * Custom panels (9.6 `custom_content`, tech preview): the panel shape the Dashboards API accepted on a live
 * deploy, the query guards every panel query obeys, and a template the sandbox will render. No network.
 * scripts/lib/custom.mjs records what the API and renderer were measured to accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandIcons, expandLabels, expandDsets, loadTemplate, ICONS, LABELS, TEMPLATE_LIMIT } from '../../scripts/lib/custom.mjs';
import { PROJECT_WHERE, IDENTITY_WHERE, CLIENT_IP_WHERE, READ_ACTIONS, LOOKUP_ACTIONS, ACTOR_RESOLVE } from '../../scripts/lib/panels.mjs';
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
  // the panel is content of the chip's own details: a closed details renders none of it, so no display rule hides it,
  // and a column hidden by a path change hides it with the column
  assert.match(t, /<details name="dsel" class="dk k\{\{ did \}\}"><summary [^>]*>[\s\S]*?<\/summary>\{%- assign q0 = rows\[dst\] [^%]*-%\}[^<]*<section class="dv"[\s\S]*?<\/section><\/details>/, 'the panel follows its summary inside the details');
  assert.ok(!/\.dv\{[^}]*display:none/.test(t) && !/\.v\{\{ (gp|did) \}\}/.test(t), 'no separate show rule per panel');
  assert.match(t, /\.dv\{position:fixed;[^}]*bottom:16px;height:calc\(46vh - 16px\)/, 'drawn under the columns, inside Kibana\'s 16px body padding');
  assert.ok(t.includes('.ip::after{content:"";display:none;flex:0 0 calc(46vh - 16px)}'), 'a spacer the panel\'s height makes room under the columns');
  assert.ok(t.includes(':has(#n{{ r["h4"].value }}:checked):has(.k{{ gp }}[open]:not(.mo:not([open]) .dk))::after{display:block}'), 'the spacer shows only while the open panel is itself shown');
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
  assert.ok(t.includes('{{ r["lastf"].value | date: "%b %-d %H:%M" }}') && t.includes('{{ q["lastf"].value | date: "%b %-d %H:%M:%S" }}'));
  assert.ok(!/\bUTC\b/.test(t.replace(/<style>[\s\S]*?<\/style>/, '')), 'no UTC label left');
});

test('the drill-down works from the keyboard: Tab follows the chip into its panel, and the chip closes it with focus kept', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  const t = loadTemplate('11-identity-path');
  assert.ok(!/\.dsel\{display:none\}/.test(t) && !t.includes('type="radio" name="dsel"'), 'hidden radios were mouse-only');
  assert.ok(!t.includes('class="x"') && !/Close<\/summary>/.test(t), 'a Close inside the hidden panel hid its own focused element, and the next Tab restarted at the top');
  assert.ok(t.includes('Press again to close.') && t.includes('Press the data set again to close'), 'the chip says how to close');
  // the panel sits in DOM (and so Tab) order right after its chip, not after every column
  const chip = t.indexOf('<summary class="ds dl'), panel = t.indexOf('<section class="dv"'), objs = t.indexOf('<section class="col objs">');
  assert.ok(objs > 0 && objs < chip && chip < panel && t.indexOf('</details>', panel) === t.indexOf('</section></details>', panel) + '</section>'.length, 'panel inside the objects column, after its chip, inside its details');
  assert.ok(/summary\.ds:focus-visible[^{]*\.dv \.tbw:focus-visible[^{]*\{outline:2px/.test(t), 'chips and the panel\'s scroller show focus');
  // a fixed panel is clipped by an ancestor's mask and pinned to an ancestor that keeps a transform
  assert.ok(t.includes('.ip:has(details.dk[open]) .col.objs .scroll{mask-image:none}'));
  assert.ok(!/animation:colIn[^;]*\bboth\b/.test(t), 'a filling transform made each column the panel\'s containing block');
  assert.ok(src.includes('.ip:has(#n{{ r["nid"].value }}:focus-visible) .b{{ r["nid"].value }}{outline:'), 'the breadcrumb shows which item has focus');
  assert.ok(/\.it input:focus-visible\+\.bx\{outline/.test(t), 'the level radios keep theirs');
  assert.equal((src.match(/<dset name="\w+" label="\w+"\/>/g) || []).length, 4, 'every chip goes through expandDsets');
});

test('expandDsets(): a data set with requests is a details in the dsel group carrying its panel, any other a plain label', () => {
  const out = expandDsets('<dset name="fm" label="lab"/>');
  assert.ok(out.includes('{%- if dmap contains dn -%}'));
  assert.ok(out.includes('<details name="dsel" class="dk k{{ did }}">'));
  assert.ok(out.includes('{%- assign did = dp[0] -%}{%- assign dst = dp[1] | plus: 0 -%}{%- assign dct = dp[2] | plus: 0 -%}{%- assign dfm = fm -%}'), 'panel id, first row and rows shown from dmap');
  const two = expandDsets('A<dset name="fm" label="lab"/>B<dset name="x" label="x"/>C<dpanel>\n<p>{{ dfm }}</p>\n</dpanel>\n');
  assert.ok(!two.includes('dpanel') && two.endsWith('C'), 'the panel block is cut from the template');
  assert.equal(two.split('</summary><p>{{ dfm }}</p></details>').length, 3, 'and written into every chip, after its summary');
  assert.ok(out.includes('{%- else -%}<span class="ds{% if c0 == "." %} sys{% endif %}" title="{{ fm }}">'), 'a lookup-only data set is not a dead link');
  assert.ok(!/(href|for)=/.test(out));
});

test('data-set ids are MD5 prefixes from the query, never built from the index name', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(!src.includes('replace: ".", "_"'), 'a name with + @ = ( ) \' & ! made an invalid selector');
  assert.ok(src.includes('.k{{ gp }}[open]') && src.includes('append: gp | append: "#" | append: forloop.index0'), 'the panel id is the level-6 parent id');
  assert.ok(IDENTITY_PATH.includes('pid = CASE(lvl <= 1, null, SUBSTRING(MD5(parent), 1, 10))'), 'parent of a request = object path + data set');
  assert.ok(src.includes('r["h5"].value | append: "#"'), 'dmap keys a panel by its object id');
  assert.ok(src.includes('{%- for q in rows offset: dst limit: dct -%}'), 'a panel reads its own rows from where they start, never a scan of every row per chip');
});

test('the row cap: the panel says so, and a cut panel counts the requests it shows', () => {
  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(IDENTITY_PATH.endsWith(`| LIMIT ${T_ROWS}`));
  assert.ok(src.includes(`rows.size >= ${T_ROWS}`), 'the template tests the same cap as the query');
  assert.ok(src.includes('Some objects and requests are not shown. Narrow the time range or pick an identity.'));
  assert.ok(src.includes('{% if dct < dsn %}; the latest {{ dct }} of {{ dsn }}{% endif %}'), '"the latest 25" was wrong when the cap cut a panel short');
  assert.ok(!src.includes('the latest 25 of'));
  // "and N more" / "+N smaller" subtract the children drawn (c) from the pre-LIMIT sib_n, so they stay true when cut
  assert.ok(src.includes('{%- assign rest = sn | minus: c -%}') && src.includes('{%- assign sn = r["sib_n"].value -%}'));
});

/**
 * A Liquid subset, enough to run the template's own thousands grouping: assign with filters, for over a range, if
 * with a comparison. Liquid is not a dependency, so the snippet is interpreted here rather than string-matched.
 */
function runLiquid(src, vars) {
  const toks = [...src.matchAll(/\{%-?\s*([\s\S]*?)\s*-?%\}/g)].map((m) => m[1]);
  const val = (x) => (/^-?\d+$/.test(x) ? Number(x) : /^"(.*)"$/.test(x) ? x.slice(1, -1) : vars[x]);
  const F = { modulo: (v, a) => v % a, prepend: (v, a) => `${a}${v}`, append: (v, a) => `${v}${a}`, minus: (v, a) => v - a,
    divided_by: (v, a) => v / a, plus: (v, a) => Number(v) + a, slice: (v, a, n) => String(v).slice(a < 0 ? String(v).length + a : a).slice(0, n) };
  const expr = (e) => e.split('|').map((x) => x.trim()).reduce((v, f, i) => {
    if (!i) return val(f);
    const [name, args = ''] = f.split(/:\s*/, 2);
    return F[name](v, ...args.split(',').map((x) => val(x.trim())));
  }, undefined);
  const run = (i, end) => {
    while (i < end) {
      const t = toks[i];
      if (t.startsWith('assign ')) { const [, k, e] = t.match(/^assign (\w+) = (.*)$/); vars[k] = expr(e); i++; }
      else if (t.startsWith('for ')) {
        const [, k, lo, hi] = t.match(/^for (\w+) in \((\d+)\.\.(\d+)\)$/);
        const close = toks.indexOf('endfor', i);
        for (let n = Number(lo); n <= Number(hi); n++) { vars[k] = n; run(i + 1, close); }
        i = close + 1;
      } else if (t.startsWith('if ')) {
        const [, a, op, b] = t.match(/^if (\w+) (>=|>) (\d+)$/);
        const close = toks.indexOf('endif', i);
        if (op === '>=' ? val(a) >= val(b) : val(a) > val(b)) run(i + 1, close);
        i = close + 1;
      } else throw new Error(`runLiquid: unsupported tag ${t}`);
    }
  };
  run(0, toks.length);
  return vars;
}

test('the identity prompt: counted from the rows, not ?identity, so a Principal id pill or Identity type narrows it too', () => {
  const q = IDENTITY_PATH;
  assert.ok(!/anyone|\?identity == ""/.test(q.slice(q.indexOf('| EVAL lvl = '))), 'the old flag read only the Identity control');
  // count BY the raw identity keys first, then name them the suite's way on the grouped rows (panels.mjs rule 2)
  const first = q.indexOf('BY service.name, user.domain'), resolve = q.indexOf(`| ${ACTOR_RESOLVE} `);
  assert.ok(first > 0 && resolve > first && q.slice(first, resolve).includes('user.email, api_key.name, user.name'), 'raw keys in the first STATS, resolved after it');
  assert.equal(q.split(ACTOR_RESOLVE).length, 2, 'resolved once, on grouped rows');
  // the identity rides through both packed joins and the fine STATS, so no INLINE STATS or second scan is needed
  for (const [pack, unpack] of [['%{actor_j}', 'actor = actor_j'], ['%{actor_s}', 'actor = actor_s']]) assert.ok(q.includes(pack) && q.includes(unpack));
  assert.match(q, /BY cred, space, cip, type, op, oid, rq, fam, meta, lang, es, actor /);
  assert.ok(q.includes('ids = COUNT_DISTINCT(actor) WHERE lvl == 0 BY lvl, key') && q.includes('ids = MAX(ids) BY lvl, parent'), 'counted on the level-0 row only, after the aggregation');
  assert.ok(!q.includes('INLINE STATS') && (q.match(/\bFROM /g) || []).length === 1);

  const src = readFileSync('custom/11-identity-path.html', 'utf8');
  assert.ok(src.includes('{%- assign ni = tot["ids"].value | default: 0 -%}') && src.includes('{%- if ni > 1 or cut -%}') && src.includes('{%- if ni > 1 -%}'), 'a prompt only above one identity');
  assert.ok(src.includes('<b>{{ nfmt }} identities.</b> Pick one in the Identity control, or click a Principal id in <i>Who this is</i>.'));
  assert.ok(!src.includes('All identities.'));
  const loop = src.slice(src.indexOf('{%- if ni > 1 -%}') + '{%- if ni > 1 -%}'.length, src.indexOf('<span class="who">'));
  for (const [n, want] of [[2, '2'], [999, '999'], [1000, '1,000'], [1005, '1,005'], [12345, '12,345'], [1234567, '1,234,567']]) {
    assert.equal(String(runLiquid(loop, { ni: n }).nfmt), want, `${n} grouped`);
  }
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
