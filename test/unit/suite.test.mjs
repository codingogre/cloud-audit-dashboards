/**
 * The deployed set (1.0.2): Command Center's fixed id, the navigation order, and Platform Volume as an
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
    assert.equal(dashId('01-identity-access'), 'cloud-audit-01-identity-access');
    for (const [name, def] of Object.entries(all)) {
      const nav = navOf(def);
      assert.deepEqual(nav.map((l) => plain(l.label)), DEFAULT_NAV, `${name} nav order`);
      assert.equal(nav[0].destination, 'elastic_cloud-audit-dashboard');
      assert.equal(nav[1].destination, 'cloud-audit-07-actor-360');
    }
    const text = JSON.stringify(all);
    assert.doesNotMatch(text, /platform-volume|Platform Volume/, 'no link, drilldown or text names the opt-in');
    assert.doesNotMatch(text, /cloud-audit-00-command-center/, 'the retired Command Center id is gone');
    for (const dest of drillTargets(all)) assert.ok(deployed().some((d) => d.id === dest), `drilldown to ${dest}`);
    assert.throws(() => panelDrilldown('x', 'p', 'cloud-audit-06-platform-volume'), /not a deployed dashboard/);
    assert.deepEqual(strays(), ['cloud-audit-00-command-center', 'cloud-audit-06-platform-volume']);
  });
});

test('--with platform-volume: eight dashboards, its tab last on every nav strip, the legend points at it', () => {
  withEnv({ AUDIT_WITH: 'platform-volume', AUDIT_ID_NS: undefined }, () => {
    const all = buildAll();
    assert.equal(Object.keys(all).length, 8);
    assert.ok(all['06-platform-volume']);
    for (const [name, def] of Object.entries(all)) {
      assert.deepEqual(navOf(def).map((l) => plain(l.label)), [...DEFAULT_NAV, 'Platform Volume'], `${name} nav order`);
      assert.equal(navOf(def).at(-1).destination, 'cloud-audit-06-platform-volume');
    }
    const legend = all['00-command-center'].panels.find((p) => p.type === 'markdown' && p.config.title === 'How to read this suite');
    assert.match(legend.config.content, /left out; unfiltered totals are on \*\*📊 Platform Volume\*\*\./);
    assert.ok(panelDrilldown('x', 'p', 'cloud-audit-06-platform-volume'), 'a drilldown to it is allowed once it is deployed');
    assert.deepEqual(strays(), ['cloud-audit-00-command-center']);
  });
  withEnv({ AUDIT_WITH: undefined }, () => {
    const legend = markdown(buildAll()).find((p) => p.config.title === 'How to read this suite');
    assert.match(legend.config.content, /own traffic are left out\.\n/, 'the sentence ends cleanly without it');
  });
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
    assert.deepEqual(nav.slice(0, 2).map((l) => l.destination), ['elastic_cloud-audit-pm1-dashboard', 'cloud-audit-pm1-07-actor-360']);
    assert.ok(nav.every((l) => /^(elastic_)?cloud-audit-pm1-/.test(l.destination)));
    // A destination that is already namespaced (the default, ACTOR_360) is not namespaced twice.
    const to = (dest) => panelDrilldown('x', 'p', dest).dynamicActions.events[0].action.config.dashboardId;
    assert.equal(to('cloud-audit-pm1-07-actor-360'), 'cloud-audit-pm1-07-actor-360');
    assert.equal(to('cloud-audit-05-geo-network'), 'cloud-audit-pm1-05-geo-network');
    assert.equal(to('elastic_cloud-audit-dashboard'), 'elastic_cloud-audit-pm1-dashboard');
    assert.equal(to('elastic_cloud-audit-pm1-dashboard'), 'elastic_cloud-audit-pm1-dashboard');
  });
});

test('the noise gate counts Command Center (elastic_cloud-audit-*) as the suite\'s own traffic', async () => {
  const { SUITE_SELF, SUITE_INSTALL_URL } = await import('../../scripts/lib/panels.mjs');
  assert.match(SUITE_SELF, /saved_object\.id LIKE "elastic_cloud-audit-\*"/);
  assert.match(SUITE_SELF, /saved_object\.id LIKE "cloud-audit-\*"/);
  const re = new RegExp(`^(?:${SUITE_INSTALL_URL})$`);
  for (const u of ['https://k.example/s/audit/api/dashboards/elastic_cloud-audit-dashboard',
    'https://k.example/api/dashboards/elastic_cloud-audit-pm1-dashboard', 'https://k.example/api/dashboards/cloud-audit-07-actor-360']) assert.ok(re.test(u), u);
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
  assert.ok(!CONTROLS.some((c) => c.field === 'attributes.user.full_name'));
  const g = controlGroup();
  assert.equal(g.controlGroupInput.chainingSystem, 'HIERARCHICAL');
  const panels = JSON.parse(g.controlGroupInput.panelsJSON);
  // The same ids 1.0.1 deployed for these fields, so a selection made before the upgrade survives.
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
    const enh = panelDrilldown('cloud-audit-01-identity-access', 'tbl-12');
    const [ev] = enh.dynamicActions.events;
    assert.deepEqual(drilldownRefs('tbl-12', enh), [{
      name: `tbl-12:drilldown:DASHBOARD_TO_DASHBOARD_DRILLDOWN:${ev.eventId}:dashboardId`, type: 'dashboard', id: 'cloud-audit-07-actor-360' }]);
    assert.ok(isDrilldownRef(drilldownRefs('tbl-12', enh)[0].name));
    assert.ok(!isDrilldownRef('panel_tbl-3') && !isDrilldownRef('controlGroup_x:optionsListDataView'));
  });
});
