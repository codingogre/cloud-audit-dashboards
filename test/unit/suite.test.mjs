/**
 * The deployed set (1.0.2, ids 1.0.3): Command Center's fixed id, the navigation order, and Platform Volume as an
 * opt-in that leaves no tab, drilldown or sentence behind when it is off. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAll } from '../../scripts/lib/definitions.mjs';
import { SUITE, deployed, dashId, optIns, takeWith, strays } from '../../scripts/lib/suite.mjs';
import { panelDrilldown, hasFilterableColumn, ACTOR_360 } from '../../scripts/lib/drilldowns.mjs';

/** Runs fn with the given env overrides (undefined deletes), restoring the previous values after. */
function withEnv(vars, fn) {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** Every dashboard id 1.0.2 deployed: RETIRED_IDS, removed by --dashboards and --clean. */
const NUMBERED = ['cloud-audit-00-command-center', 'cloud-audit-01-identity-access', 'cloud-audit-02-kibana-objects',
  'cloud-audit-03-data-access', 'cloud-audit-04-security-anomalies', 'cloud-audit-05-geo-network',
  'cloud-audit-06-platform-volume', 'cloud-audit-07-actor-360'];

const DEFAULT_NAV = ['Command Center', 'Actor 360', 'Identity & Access', 'Kibana Object Forensics',
  'Elasticsearch Data Access', 'Security & Anomalies', 'Geo & Network'];
const navOf = (def) => def.panels[0].config.links;
const plain = (label) => label.replace(/^\S+\s+/, '');
const markdown = (all) => Object.values(all).flatMap((d) => d.panels.filter((p) => p.type === 'markdown'));
/** Every drilldown destination the post-pass would attach, from the same rule scripts/dashboards.mjs applies. */
const drillTargets = (all) => Object.keys(all).flatMap((name) => all[name].panels.filter(hasFilterableColumn)
  .map((p) => (dashId(name) === ACTOR_360 ? p.drill : ACTOR_360)).filter(Boolean));

test('default set: seven dashboards, Command Center at elastic_cloud-audit-dashboard, Actor 360 second, no Platform Volume anywhere', () => {
  withEnv({ AUDIT_WITH: undefined, AUDIT_ID_NS: undefined }, () => {
    const all = buildAll();
    assert.deepEqual(Object.keys(all), ['00-command-center', '01-identity-access', '02-kibana-objects', '03-data-access',
      '04-security-anomalies', '05-geo-network', '07-actor-360']);
    assert.equal(dashId('00-command-center'), 'elastic_cloud-audit-dashboard');
    assert.equal(dashId('01-identity-access'), 'elastic_cloud-audit-identity-access');
    // 1.0.3: every dashboard id is elastic_cloud-audit-<name>, with no source number.
    assert.deepEqual(SUITE.map((d) => dashId(d.name)), ['elastic_cloud-audit-dashboard', 'elastic_cloud-audit-actor-360',
      'elastic_cloud-audit-identity-access', 'elastic_cloud-audit-kibana-objects', 'elastic_cloud-audit-data-access',
      'elastic_cloud-audit-security-anomalies', 'elastic_cloud-audit-geo-network', 'elastic_cloud-audit-platform-volume']);
    for (const [name, def] of Object.entries(all)) {
      const nav = navOf(def);
      assert.deepEqual(nav.map((l) => plain(l.label)), DEFAULT_NAV, `${name} nav order`);
      assert.equal(nav[0].destination, 'elastic_cloud-audit-dashboard');
      assert.equal(nav[1].destination, 'elastic_cloud-audit-actor-360');
      assert.deepEqual(nav.map((l) => l.destination), deployed().map((d) => d.id), `${name} nav ids`);
    }
    const text = JSON.stringify(all);
    assert.doesNotMatch(text, /platform-volume|Platform Volume/, 'no link, drilldown or text names the opt-in');
    assert.doesNotMatch(text, /cloud-audit-0\d-/, 'no retired numbered id is linked anywhere');
    for (const dest of drillTargets(all)) assert.ok(deployed().some((d) => d.id === dest), `drilldown to ${dest}`);
    assert.throws(() => panelDrilldown('x', 'p', 'elastic_cloud-audit-platform-volume'), /not a deployed dashboard/);
    assert.deepEqual(strays(), [...NUMBERED, 'elastic_cloud-audit-platform-volume']);
  });
});

test('--with platform-volume: eight dashboards, its tab last on every nav strip, the legend points at it', () => {
  withEnv({ AUDIT_WITH: 'platform-volume', AUDIT_ID_NS: undefined }, () => {
    const all = buildAll();
    assert.equal(Object.keys(all).length, 8);
    assert.ok(all['06-platform-volume']);
    for (const [name, def] of Object.entries(all)) {
      assert.deepEqual(navOf(def).map((l) => plain(l.label)), [...DEFAULT_NAV, 'Platform Volume'], `${name} nav order`);
      assert.equal(navOf(def).at(-1).destination, 'elastic_cloud-audit-platform-volume');
    }
    const legend = all['00-command-center'].panels.find((p) => p.type === 'markdown' && p.config.content.includes('### How to read this suite'));
    assert.match(legend.config.content, /own activity\. \*\*📊 Platform Volume\*\* shows everything\.\n/);
    assert.ok(panelDrilldown('x', 'p', 'elastic_cloud-audit-platform-volume'), 'a drilldown to it is allowed once it is deployed');
    assert.deepEqual(strays(), NUMBERED);
  });
  withEnv({ AUDIT_WITH: undefined }, () => {
    const legend = markdown(buildAll()).find((p) => p.config.content.includes('### How to read this suite'));
    assert.match(legend.config.content, /own activity\.\n/, 'the sentence ends cleanly without it');
    assert.ok(legend.headed && legend.config.content.startsWith('### How to read this suite\n\n'), 'the legend is in the intro style');
    assert.doesNotMatch(legend.config.content, /<style>|`[^`]*`\s*[.,;:]\s*`/, 'no style block (it would print as text), no punctuation between two code chips');
  });
});

test('every dashboard opens with a full-width intro under the nav strip: an in-panel heading, then small text', async () => {
  const { smallMarkdown, INTRO_PT } = await import('../../scripts/lib/panels.mjs');
  const { nsId } = await import('../../scripts/lib/env.mjs');
  const vis = smallMarkdown('### x\n\ny\n');
  assert.deepEqual([vis.hidePanelTitles, vis.savedVis.type, vis.savedVis.params.fontSize, vis.savedVis.params.markdown], [true, 'markdown', INTRO_PT, '### x\n\ny\n']);
  for (const AUDIT_WITH of [undefined, 'platform-volume']) {
    withEnv({ AUDIT_WITH, AUDIT_ID_NS: undefined }, () => {
      for (const [name, def] of Object.entries(buildAll())) {
        const [nav, intro] = def.panels;
        assert.equal(nav.type, 'links');
        assert.equal(intro.type, 'markdown', `${name}: second panel is the intro`);
        assert.deepEqual([intro.grid.x, intro.grid.y, intro.grid.w], [0, nav.grid.h, 48], `${name}: intro full width under the nav`);
        assert.equal(intro.config.title, undefined, `${name}: the heading is the title`);
        assert.ok(intro.headed, `${name}: the post-pass turns it into small text`);
        // A paragraph may carry a link whose URL has a # in it (/app/discover#/view/…), but never starts with one.
        // The How to read list is not in it (1.0.5): it is the collapsed section under it (panels.test.mjs).
        assert.match(intro.config.content, /^### [^\n.]+\n\n(?!#)[^\n<]+(\n\n(?!#)[^\n<]+)+\n$/, name);
        // Every intro links to the raw events: both Discover sessions, by their ids in this namespace.
        for (const slug of ['all-events', 'raw-signal-feed']) {
          assert.ok(intro.config.content.includes(`](/app/discover#/view/${nsId(`cloud-audit-search-${slug}`)})`), `${name}: links to ${slug}`);
        }
        assert.doesNotMatch(intro.config.content, /@search:|https?:/, `${name}: links resolved and relative`);
        const below = def.panels.slice(2).map((p) => p.grid.y);
        assert.equal(Math.min(...below), intro.grid.y + intro.grid.h, `${name}: nothing overlaps or gaps under the intro`);
        assert.ok(def.panels[2].section, `${name}: what sits directly under the intro is the How to read section`);
      }
    });
  }
});

test('no markdown panel carries an em dash, in either set', () => {
  for (const AUDIT_WITH of [undefined, 'platform-volume']) {
    withEnv({ AUDIT_WITH }, () => {
      for (const p of markdown(buildAll())) assert.ok(!p.config.content.includes('—'), `${p.id}: ${p.config.content.slice(0, 80)}`);
    });
  }
});

test('AUDIT_ID_NS namespaces Command Center too, so a private deploy never touches elastic_cloud-audit-dashboard', () => {
  withEnv({ AUDIT_WITH: undefined, AUDIT_ID_NS: 'pm1' }, () => {
    assert.equal(dashId('00-command-center'), 'elastic_cloud-audit-pm1-dashboard');
    const built = buildAll();
    const nav = navOf(built['07-actor-360']);
    // The intro's raw-event links point at the private copy of each Discover session, not production's.
    assert.match(built['00-command-center'].panels[1].config.content, /\]\(\/app\/discover#\/view\/cloud-audit-pm1-search-all-events\)/);
    assert.deepEqual(nav.slice(0, 2).map((l) => l.destination), ['elastic_cloud-audit-pm1-dashboard', 'elastic_cloud-audit-pm1-actor-360']);
    assert.ok(nav.every((l) => /^elastic_cloud-audit-pm1-[a-z0-9-]+$/.test(l.destination)));
    assert.equal(new Set(nav.map((l) => l.destination)).size, nav.length, 'namespaced ids stay unique');
    // A destination that is already namespaced (the default, ACTOR_360) is not namespaced twice.
    const to = (dest) => panelDrilldown('x', 'p', dest).dynamicActions.events[0].action.config.dashboardId;
    assert.equal(to('elastic_cloud-audit-pm1-actor-360'), 'elastic_cloud-audit-pm1-actor-360');
    assert.equal(to('elastic_cloud-audit-geo-network'), 'elastic_cloud-audit-pm1-geo-network');
    assert.equal(to('elastic_cloud-audit-dashboard'), 'elastic_cloud-audit-pm1-dashboard');
    assert.equal(to('elastic_cloud-audit-pm1-dashboard'), 'elastic_cloud-audit-pm1-dashboard');
    // The numbered ids an earlier private deploy left in its space are namespaced the way it deployed them.
    assert.deepEqual(strays().slice(0, 2), ['cloud-audit-pm1-00-command-center', 'cloud-audit-pm1-01-identity-access']);
  });
});

test('the noise gate counts every dashboard (elastic_cloud-audit-*) as the suite\'s own traffic', async () => {
  const { SUITE_SELF, SUITE_INSTALL_URL } = await import('../../scripts/lib/panels.mjs');
  assert.match(SUITE_SELF, /saved_object\.id LIKE "elastic_cloud-audit-\*"/);
  assert.match(SUITE_SELF, /saved_object\.id LIKE "cloud-audit-\*"/);
  const re = new RegExp(`^(?:${SUITE_INSTALL_URL})$`);
  for (const u of ['https://k.example/s/audit/api/dashboards/elastic_cloud-audit-dashboard',
    'https://k.example/api/dashboards/elastic_cloud-audit-pm1-dashboard', 'https://k.example/api/dashboards/cloud-audit-07-actor-360',
    'https://k.example/s/audit/api/dashboards/elastic_cloud-audit-actor-360', 'https://k.example/api/dashboards/elastic_cloud-audit-pm1-geo-network']) assert.ok(re.test(u), u);
  assert.ok(!re.test('https://k.example/api/dashboards/my-dashboard'));
  // A private deploy's own Command Center is the suite too, and a stranger's elastic-* id is not.
  assert.ok(!re.test('https://k.example/api/dashboards/elastic-other-dashboard'));
});

test('--with is folded into AUDIT_WITH, adds to .env, and an unknown name is refused', () => {
  const env = { AUDIT_WITH: '' };
  assert.deepEqual(takeWith(['run', '--with', 'platform-volume', '--only', 'x'], env), ['run', '--only', 'x']);
  assert.equal(env.AUDIT_WITH, 'platform-volume');
  const env2 = { AUDIT_WITH: 'platform-volume' };
  assert.deepEqual(takeWith(['--with=platform-volume'], env2), []);
  assert.deepEqual([...optIns(env2)], ['platform-volume']);
  assert.throws(() => takeWith(['--with'], {}), /needs a name/);
  assert.throws(() => optIns({ AUDIT_WITH: 'platform-volumes' }), /unknown platform-volumes/);
  assert.deepEqual(SUITE.filter((d) => d.optional).map((d) => d.name), ['06-platform-volume']);
});

test('control bar (1.0.5.1): Project, Identity type, Identity, Client IP; identity is ES|QL, single-select, chained', async () => {
  const { CONTROLS, pinnedPanels } = await import('../../scripts/lib/controls.mjs');
  const { stableUuid } = await import('../../scripts/lib/ids.mjs');
  const { payload } = await import('../../scripts/dashboards.mjs');
  assert.deepEqual(CONTROLS.map((c) => c.title), ['Project', 'Identity type', 'Identity', 'Client IP']);
  const pp = pinnedPanels();
  assert.deepEqual(pp.map((p) => p.type), ['options_list_control', 'esql_control', 'esql_control', 'options_list_control']);
  assert.deepEqual(pp.filter((p) => p.config.field_name).map((p) => p.config.field_name), ['project.name', 'client.ip']);
  // Classic control ids stay keyed on the field, so Project and Client IP keep their 1.0.5 ids.
  assert.equal(pp[0].id, stableUuid('cloud-audit-control:project.name'));
  assert.equal(pp[3].id, stableUuid('cloud-audit-control:client.ip'));
  const [kind, who] = [pp[1].config, pp[2].config];
  assert.deepEqual([kind.variable_name, who.variable_name], ['identity_kind', 'identity']);
  for (const c of [kind, who]) {
    assert.equal(c.single_select, true, 'single-select: multi-select has no fast path');
    assert.equal(c.variable_type, 'values');
    assert.equal(c.control_type, 'VALUES_FROM_QUERY');
    assert.match(c.esql_query, /^SET unmapped_fields="nullify"; FROM /, 'names api_key.*, so it carries the SET');
    assert.match(c.esql_query, /STATS n = COUNT\(\*\) BY user\.email, api_key\.name, user\.domain, user\.name/, 'counts first');
    assert.ok(!/\?identity\b(?!_kind)/.test(c.esql_query), 'an options query never reads the variable it sets');
  }
  assert.ok(!kind.esql_query.includes('?identity_kind'));
  assert.match(who.esql_query, /\?identity_kind == "" OR identity_kind == \?identity_kind/, 'Identity chains on Identity type');
  // Every dashboard sends the bar in the PUT; nothing is patched in afterwards.
  for (const [name, def] of Object.entries(buildAll())) assert.deepEqual(payload(def).pinned_panels, pp, name);
});

test('a dashboard drilldown carries the reference Kibana navigates by, so "Open in …" never lands on #/create', async () => {
  const { drilldownRefs, isDrilldownRef } = await import('../../scripts/lib/drilldowns.mjs');
  withEnv({ AUDIT_WITH: undefined, AUDIT_ID_NS: undefined }, () => {
    const enh = panelDrilldown('elastic_cloud-audit-identity-access', 'tbl-12');
    const [ev] = enh.dynamicActions.events;
    assert.deepEqual(drilldownRefs('tbl-12', enh), [{
      name: `tbl-12:drilldown:DASHBOARD_TO_DASHBOARD_DRILLDOWN:${ev.eventId}:dashboardId`, type: 'dashboard', id: 'elastic_cloud-audit-actor-360' }]);
    assert.ok(isDrilldownRef(drilldownRefs('tbl-12', enh)[0].name));
    assert.ok(!isDrilldownRef('panel_tbl-3') && !isDrilldownRef('controlGroup_x:optionsListDataView'));
  });
});

test('data view (1.0.4): public id elastic_cloud-audit-logs, namespaced like the dashboards; cloud-audit-dv retired', async () => {
  const { DATA_VIEW_ID, RETIRED_DATA_VIEW_IDS, dataViewObject } = await import('../../scripts/lib/controls.mjs');
  const { nsId } = await import('../../scripts/lib/env.mjs');
  if (!process.env.AUDIT_ID_NS) assert.equal(DATA_VIEW_ID, 'elastic_cloud-audit-logs');
  assert.equal(dataViewObject().id, DATA_VIEW_ID);
  assert.deepEqual(RETIRED_DATA_VIEW_IDS, ['cloud-audit-dv']);
  withEnv({ AUDIT_ID_NS: 'pm1' }, () => {
    assert.equal(nsId('elastic_cloud-audit-logs'), 'elastic_cloud-audit-pm1-logs');
    assert.equal(nsId('cloud-audit-dv'), 'cloud-audit-pm1-dv');
  });
});

test('identity tables (1.0.5): a raw Principal id / API key click column on each, so each drills into Actor 360', async () => {
  const { checkClickFilters } = await import('../../scripts/lib/layout.mjs');
  const { discoverUrl } = await import('../../scripts/lib/panels.mjs');
  withEnv({ AUDIT_WITH: undefined, AUDIT_ID_NS: undefined }, () => {
    const all = buildAll();
    const find = (name, title) => all[name].panels.find((p) => p.config?.title?.startsWith(title));
    const clicks = (p) => p.config.rows.filter((r) => r.click_filter).map((r) => r.column);
    const want = {
      '00-command-center': { 'Busiest identities': ['user.name'] },
      '01-identity-access': { 'Busiest API keys by name': ['api_key.name', 'user.name'] },
      '02-kibana-objects': { '⚠️ Mutations': ['user.name'] },
      '03-data-access': { '⚠️ Who touched system and hidden indices': ['api_key.name', 'user.name'] },
      '04-security-anomalies': {
        '🚨 Config changes': ['api_key.name', 'user.name'], 'Identities by first appearance': ['user.name'],
        'Risk leaderboard': ['api_key.name', 'user.name'], 'Why these identities scored': ['user.name'],
        'Top failures and denials': ['user.name'],
      },
      '07-actor-360': { 'Who this is': ['user.name'] },
    };
    for (const [name, tables] of Object.entries(want)) {
      for (const [title, cols] of Object.entries(tables)) {
        const p = find(name, title);
        assert.ok(p, `${name}: ${title}`);
        assert.deepEqual(clicks(p), cols, `${name}: ${title} click columns`);
        assert.ok(hasFilterableColumn(p), `${name}: ${title} gets a drilldown`);
        // Each click column is a STATS BY group key the query never assigns.
        for (const c of cols) assert.match(p.config.data_source.query, new RegExp(`BY [^|]*\\b${c.replace('.', '\\.')}\\b`), `${name}: ${title} groups on ${c}`);
        const problems = []; checkClickFilters(name, [p], problems);
        assert.deepEqual(problems, []);
      }
    }
    // The folded table cannot carry them (its last row would need the raw keys nulled).
    assert.ok(!hasFilterableColumn(find('03-data-access', 'Denied requests by identity')));
    // Actor 360's Who this is leaves the placeholders out, so its 165px Principal id never cuts one.
    assert.match(find('07-actor-360', 'Who this is').config.data_source.query, /NOT STARTS_WITH\(user\.name, "<"\)/);
    assert.equal(discoverUrl('00-all-events'), '/app/discover#/view/cloud-audit-search-all-events');
    assert.throws(() => discoverUrl('99-nope'), /no searches\/99-nope\.json/);
  });
});

test('1.0.5.1: the identity a panel shows is resolved on grouped rows (by ACTOR_KEYS) or on a row feed\'s returned rows, never per event of a wide scan', async () => {
  const { ACTOR_RESOLVE, ACTOR_LABEL } = await import('../../scripts/lib/panels.mjs');
  const { readFileSync, readdirSync } = await import('node:fs');
  // Filtered to a few hundred events before resolving, and measured (22ms and 10ms at 30 days): panels.mjs.
  const PER_EVENT_OK = ['🚨 Config changes', 'Top failures and denials'];
  const check = (where, q) => {
    const at = q.indexOf(ACTOR_RESOLVE);
    if (at < 0) return;
    const stages = q.slice(0, at).split('|').map((s) => s.trim());
    const stats = stages.filter((s) => /^(FORK \()?STATS\b/.test(s)).pop();
    if (stats) assert.match(stats, /\bBY\b.*\buser\.domain\b/, `${where}: resolves after a STATS that does not group on user.domain`);
    else assert.ok(stages.some((s) => /^LIMIT\b/.test(s)) || PER_EVENT_OK.some((t) => where.includes(t)), `${where}: resolves the identity per event`);
  };
  withEnv({ AUDIT_WITH: 'platform-volume', AUDIT_ID_NS: undefined }, () => {
    let n = 0;
    for (const [name, d] of Object.entries(buildAll())) {
      for (const p of d.panels.flatMap((x) => (x.section ? x.panels : [x]))) {
        const q = p.config?.data_source?.query;
        if (q?.includes(ACTOR_RESOLVE)) { n++; check(`${name}: ${p.config.title}`, q); }
        // Every table that shows the identity shortens a key id the one shared way.
        if (q && p.config.rows?.some((r) => r.column === 'actor')) assert.ok(q.endsWith(ACTOR_LABEL), `${name}: ${p.config.title}`);
      }
    }
    assert.ok(n >= 20, `${n} panels resolve an identity`);
  });
  for (const dir of ['vega', 'searches']) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const doc = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if ((k === 'query' || k === 'esql') && typeof v === 'string') check(`${dir}/${f}`, v); else walk(v); } };
      walk(doc);
    }
  }
});
