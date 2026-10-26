/**
 * The starter alert pack (1.0.6, lib/rules.mjs): stable namespaced ids, the alerting_v2 body (kind alert, no
 * actions, no `enabled`), queries that bound themselves with TIME_ONLY and bind nothing but ?_tstart/?_tend, a
 * lookback at least as wide as every window the text names, and committed rules/*.json equal to what the
 * definitions build. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { RULES, RETIRED_RULE_IDS, ruleId, rulePayload, ruleQuery, ruleQueries, durationMs, SEVERITIES, RULE_TAG, ROUTING_TAG } from '../../scripts/lib/rules.mjs';
import { TIME_ONLY, TIME, CONTROLS_WHERE, IDENTITY_WHERE, NULL_SAFE } from '../../scripts/lib/panels.mjs';
import { SUITE } from '../../scripts/lib/suite.mjs';
import { RESERVED_NS } from '../../scripts/lib/env.mjs';

function withEnv(vars, fn) {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const SLUGS = ['failed-signin-burst', 'signin-after-failures', 'api-key-or-role-change',
  'unusual-hour-security-change', 'first-seen-identity', 'audit-events-stopped'];

test('six rules with the agreed slugs; ids are cloud-audit-rule-<slug>, namespaced under AUDIT_ID_NS', () => {
  assert.deepEqual(RULES.map((r) => r.slug), SLUGS);
  withEnv({ AUDIT_ID_NS: undefined }, () => {
    assert.deepEqual(RULES.map((r) => ruleId(r.slug)), SLUGS.map((s) => `cloud-audit-rule-${s}`));
  });
  withEnv({ AUDIT_ID_NS: 'r106' }, () => {
    assert.equal(ruleId('failed-signin-burst'), 'cloud-audit-r106-rule-failed-signin-burst');
    assert.equal(ruleId('failed-signin-burst'), ruleId('failed-signin-burst'), 'stable');
  });
  for (const r of RULES) assert.match(ruleId(r.slug), /^[a-zA-Z0-9_-]{1,150}$/, 'the API id pattern');
  assert.ok(Array.isArray(RETIRED_RULE_IDS));
});

test('"rule" is reserved, so AUDIT_ID_NS=rule cannot make production rule ids look private', () => {
  assert.ok(RESERVED_NS.includes('rule'));
  withEnv({ AUDIT_ID_NS: 'rule' }, () => assert.throws(() => ruleId('failed-signin-burst'), /production id/));
});

test('the PUT body: kind alert, no actions, no enabled, tags and routing tag, the two artifacts', () => withEnv({ AUDIT_ID_NS: undefined }, () => {
  for (const r of RULES) {
    const p = rulePayload(r);
    assert.equal(p.kind, 'alert', r.slug);
    assert.ok(!('enabled' in p), `${r.slug}: the deployer decides enabled`);
    assert.ok(!('actions' in p), `${r.slug}: no actions on a rule`);
    assert.equal(p.time_field, '@timestamp');
    assert.deepEqual(p.recovery, { strategy: 'no_breach' });
    assert.deepEqual(p.no_data, { strategy: 'ignore' });
    // Without it a group's first breach is only pending (measured), so a one-run alert would never open.
    assert.deepEqual(p.state_transition, { pending: { count: 0 } }, `${r.slug}: alert on the first breach`);
    assert.equal(p.metadata.tags[0], RULE_TAG);
    assert.equal(RULE_TAG, 'cloud-audit');
    assert.deepEqual(p.metadata.routing_tags, [ROUTING_TAG]);
    assert.equal(ROUTING_TAG, 'cloud-audit');
    assert.ok(p.metadata.tags.length >= 1 && p.metadata.tags.length <= 20 && p.metadata.tags.every((t) => t.length <= 128));
    assert.ok(p.metadata.description.length >= 1 && p.metadata.description.length <= 1024, `${r.slug}: description 1-1024`);
    assert.ok(p.metadata.name.length <= 256);
    assert.match(p.metadata.name, /^\[Audit\] /, `${r.slug}: the dashboards' title convention`);
    assert.ok(p.query.base.length <= 10000);
    assert.deepEqual(p.artifacts.map((a) => a.id), ['dashboard', 'runbook']);
    assert.ok(p.artifacts[1].data.content.trim().length > 0 && p.artifacts[1].data.content.length <= 50000);
    assert.ok(p.grouping.fields.length >= 1 && p.grouping.fields.length <= 16);
    assert.match(p.schedule.every, /^\d+(ms|s|m|h|d|w)$/);
    assert.ok(durationMs(p.schedule.every) >= 60e3, `${r.slug}: at least the 1m minimum interval`);
  }
  const names = RULES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, 'names unique');
}));

test('a private copy carries its namespace as tag and routing tag, never the production one', () => {
  withEnv({ AUDIT_ID_NS: 'r106' }, () => {
    for (const r of RULES) {
      const p = rulePayload(r);
      assert.equal(p.metadata.tags[0], 'cloud-audit-r106', r.slug);
      assert.deepEqual(p.metadata.routing_tags, ['cloud-audit-r106'], r.slug);
      assert.ok(!p.metadata.tags.includes(RULE_TAG) && !p.metadata.routing_tags.includes(ROUTING_TAG), r.slug);
    }
  });
});

test('each rule links to a suite dashboard, in the active namespace', () => {
  const ids = (ns) => withEnv({ AUDIT_ID_NS: ns }, () => RULES.map((r) => rulePayload(r).artifacts[0].data.dashboard_id));
  const prod = ids(undefined);
  for (const id of prod) assert.ok(SUITE.some((d) => d.id === id), `${id} is a suite dashboard`);
  for (const id of ids('r106')) assert.match(id, /^elastic_cloud-audit-r106-/);
  assert.throws(() => rulePayload({ ...RULES[0], dashboard: 'nope' }), /no suite dashboard/);
});

test('every rule query bounds itself with TIME_ONLY and binds nothing but ?_tstart/?_tend', () => {
  for (const r of RULES) {
    const q = ruleQuery(r);
    assert.ok(q.includes(TIME_ONLY), `${r.slug}: TIME_ONLY`);
    const vars = [...q.matchAll(/\?(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(vars)].filter((v) => v !== '_tstart' && v !== '_tend'), [], `${r.slug}: no dropdown variable`);
    for (const [frag, name] of [[TIME, 'TIME'], [CONTROLS_WHERE, 'CONTROLS_WHERE'], [IDENTITY_WHERE, 'IDENTITY_WHERE']]) {
      assert.ok(!q.includes(frag), `${r.slug}: no ${name}`);
    }
    assert.ok(!/\bNOW\(\)/i.test(q), `${r.slug}: windows are relative to ?_tend, never NOW()`);
    assert.ok(!r.query.includes('| LIMIT'), `${r.slug}: Kibana appends its own row cap`);
  }
});

/** Every `?_tend) - N unit` window the text names, in ms. */
const UNIT = { millisecond: 1, second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 };
export const innerWindows = (q) => [...q.matchAll(/\?_tend\)?\s*-\s*(\d+)\s*(millisecond|second|minute|hour|day|week)s?\b/gi)]
  .map((m) => Number(m[1]) * UNIT[m[2].toLowerCase()]);

test('schedule.lookback is set and at least as wide as every window the query names after ?_tend', () => {
  assert.deepEqual(innerWindows('x > TO_DATETIME(?_tend) - 15 minutes AND y > TO_DATETIME(?_tend) - 2 days'), [9e5, 1728e5]);
  for (const r of RULES) {
    assert.ok(r.schedule.lookback, `${r.slug}: lookback set (it defaults to every, which silently narrows the window)`);
    const lb = durationMs(r.schedule.lookback);
    assert.ok(lb <= 365 * 864e5);
    for (const w of innerWindows(ruleQuery(r))) assert.ok(lb >= w, `${r.slug}: lookback ${r.schedule.lookback} < a ${w / 6e4} minute window`);
    assert.ok(lb >= durationMs(r.schedule.every), `${r.slug}: lookback covers the interval, so no event falls between runs`);
  }
});

test('every rule outputs a severity column and its grouping fields', () => {
  for (const r of RULES) {
    const q = ruleQuery(r);
    assert.match(q, /\bseverity\s*=/, `${r.slug}: severity column`);
    for (const s of q.matchAll(/severity\s*=\s*CASE\(([^)]*)\)|severity\s*=\s*"(\w+)"/g)) {
      for (const lit of (s[1] ?? `"${s[2]}"`).match(/"(\w+)"/g) || []) {
        assert.ok(SEVERITIES.includes(lit.slice(1, -1)), `${r.slug}: severity ${lit} is not one of ${SEVERITIES.join('|')}`);
      }
    }
    // After the last STATS, the columns are what that STATS and the EVALs/KEEP after it name.
    const tail = q.slice(q.lastIndexOf('STATS '));
    for (const f of r.grouping) assert.ok(tail.includes(f), `${r.slug}: grouping field ${f} in the output`);
  }
  // The text check above cannot see a column dropped by KEEP; the lint can, because each rule hands it these.
  for (const it of ruleQueries()) {
    const r = RULES.find((x) => `rules/${x.slug}` === it.src);
    assert.deepEqual(it.cols, ['severity', ...r.grouping], `${it.src}: the lint checks severity and the grouping columns`);
  }
});

test('a rule query that names api_key.* carries the nullify SET, and none other does', () => {
  for (const { src, q } of ruleQueries()) {
    assert.equal(q.startsWith(`${NULL_SAFE} FROM `), /(?<![\w.])api_key\./.test(q), `${src}: SET iff api_key.*`);
  }
});

test('the committed rules/*.json are exactly what the definitions build (production namespace)', async () => {
  const { RULES_DIR, ruleFile } = await import('../../scripts/rules.mjs');
  withEnv({ AUDIT_ID_NS: undefined }, () => {
    const files = readdirSync(RULES_DIR).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(files, RULES.map((r) => ruleFile(r.slug)).sort(), 'one file per rule, nothing else');
    for (const r of RULES) {
      const file = readFileSync(`${RULES_DIR}/${ruleFile(r.slug)}`, 'utf8');
      assert.ok(file === JSON.stringify(rulePayload(r), null, 2) + '\n',
        `rules/${ruleFile(r.slug)} is stale: regenerate with node -e "import('./scripts/rules.mjs').then(m=>m.emit())"`);
    }
  });
});

test('every panel, dashboard and control a runbook names in bold is one the built dashboards carry', () => {
  // The committed dashboards/*.json are what --dashboards deploys; a runbook names a panel by its title without
  // the generated row-count suffix ("· top 10 at most"), so a bold name must be a whole title or the part before " · ".
  const titles = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'title' && typeof v === 'string') titles.add(v); else walk(v); }
  };
  for (const f of readdirSync('dashboards').filter((f) => f.endsWith('.json'))) walk(JSON.parse(readFileSync(`dashboards/${f}`, 'utf8')));
  const HEADINGS = new Set(['What it means.', 'Triage', 'What is normal.', 'High']);
  for (const r of RULES) {
    for (const [, b] of r.runbook.matchAll(/\*\*([^*]+)\*\*/g)) {
      if (HEADINGS.has(b)) continue;
      const ok = [...titles].some((t) => t === b || t.startsWith(`${b} · `) || t.startsWith(`${b} (`));
      assert.ok(ok, `${r.slug}: runbook names "${b}", which no dashboard carries`);
    }
  }
});

/**
 * scripts/rules.mjs against a stubbed Kibana (kb.sRaw replaced): what each call sends, under the private namespace
 * (so emit() writes no files). `store` is the Kibana side: id → stored rule.
 */
async function withKibana(store, fn, { status } = {}) {
  const { kb } = await import('../../scripts/lib/http.mjs');
  const calls = [];
  const was = kb.sRaw;
  const nf = (id) => ({ ok: false, status: 404, body: { code: 'RULE_NOT_FOUND', message: `Rule with id "${id}" not found` } });
  kb.sRaw = async (path, { method, body } = {}) => {
    calls.push({ method, path, body });
    if (status) return { ok: false, status, body: status === 503 ? { message: 'off' } : { statusCode: 404, error: 'Not Found', message: 'Not Found' } };
    const id = path.split('/').pop();
    if (method === 'GET') return store[id] ? { ok: true, status: 200, body: structuredClone(store[id]) } : nf(id);
    if (method === 'DELETE') { if (!store[id]) return nf(id); delete store[id]; return { ok: true, status: 204, body: null }; }
    if (method === 'PUT') {
      const prev = store[id];
      store[id] = { id, ...structuredClone(body), enabled: body.enabled ?? prev?.enabled ?? true, version: (prev?.version ?? 0) + 1 };
      return { ok: true, status: prev ? 200 : 201, body: store[id] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const quiet = console.log;
  console.log = () => {};
  const prevNs = process.env.AUDIT_ID_NS;
  process.env.AUDIT_ID_NS = 'r106';
  try { return await fn(calls); } finally {
    kb.sRaw = was; console.log = quiet;
    if (prevNs === undefined) delete process.env.AUDIT_ID_NS; else process.env.AUDIT_ID_NS = prevNs;
  }
}

test('--rules creates each rule disabled, in the private namespace, by exact id', async () => {
  const { run } = await import('../../scripts/rules.mjs');
  const store = {};
  await withKibana(store, async (calls) => {
    await run();
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, RULES.length);
    for (const p of puts) {
      assert.match(p.path, /^\/api\/alerting\/v2\/rules\/cloud-audit-r106-rule-[a-z-]+$/);
      assert.equal(p.body.enabled, false, `${p.path}: created disabled`);
    }
    assert.ok(calls.every((c) => c.path.includes('/cloud-audit-r106-rule-')), 'never a production id');
  });
  assert.ok(Object.values(store).every((r) => r.enabled === false));
});

test('--rules keeps a rule the customer enabled, and writes nothing when the stored rule already matches', async () => {
  const { run } = await import('../../scripts/rules.mjs');
  const store = {};
  await withKibana(store, async () => run());
  const [first, second] = Object.keys(store);
  store[first].enabled = true;
  store[second].metadata.description = 'edited by hand';
  await withKibana(store, async (calls) => {
    await run();
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(puts.map((p) => p.path.split('/').pop()), [second], 'only the rule that differs is written');
    assert.equal(puts[0].body.enabled, false, 'the stored value is sent, not left to the default');
  });
  assert.equal(store[first].enabled, true);
  assert.equal(store[first].version, 1, 'no new version for an unchanged rule');
  assert.equal(store[second].version, 2);
});

test('--clean rules deletes by exact id; with Universal Alerting off it warns instead of failing', async () => {
  const { clean, run, deploy } = await import('../../scripts/rules.mjs');
  const store = {};
  await withKibana(store, async () => run());
  await withKibana(store, async (calls) => {
    await clean();
    assert.ok(calls.every((c) => c.method === 'DELETE' && /\/cloud-audit-r106-rule-[a-z-]+$/.test(c.path)));
  });
  assert.deepEqual(store, {});
  for (const status of [503, 404]) {
    await withKibana({}, async () => {
      await clean();
      await assert.rejects(run(), (e) => e.unavailable === true, `--rules fails on ${status}`);
      assert.deepEqual(await deploy(), [], `--deploy skips on ${status}`);
    }, { status });
  }
});
