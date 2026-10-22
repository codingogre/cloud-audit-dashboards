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
        assert.match(intro.config.content, /^### [^\n.]+\n\n[^\n#<]+(\n\n[^\n#<]+)+\n$/, name);
        const below = def.panels.slice(2).map((p) => p.grid.y);
        assert.equal(Math.min(...below), intro.grid.y + intro.grid.h, `${name}: nothing overlaps or gaps under the intro`);
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
    const nav = navOf(buildAll()['07-actor-360']);
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

test('control bar (1.0.2): Project, Person (email), Client IP; no full_name; ids keyed on the field, chaining hierarchical', async () => {
  const { CONTROLS, controlGroup } = await import('../../scripts/lib/controls.mjs');
  const { stableUuid } = await import('../../scripts/lib/ids.mjs');
  assert.deepEqual(CONTROLS.map((c) => c.title), ['Project', 'Person (email)', 'Client IP']);
  assert.ok(!CONTROLS.some((c) => c.field === 'user.full_name'));
  const g = controlGroup();
  assert.equal(g.controlGroupInput.chainingSystem, 'HIERARCHICAL');
  const panels = JSON.parse(g.controlGroupInput.panelsJSON);
  // Ids are keyed on the field name. 1.0.4 renamed the fields to bare ECS names, so the ids changed with them.
  for (const [i, c] of CONTROLS.entries()) {
    const id = stableUuid(`cloud-audit-control:${c.field}`);
    assert.equal(panels[id].explicitInput.fieldName, c.field);
    assert.equal(panels[id].order, i);
  }
  assert.equal(Object.keys(panels).length, 3);
  assert.equal(g.references.length, 3);
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
