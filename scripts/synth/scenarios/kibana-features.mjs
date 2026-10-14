/**
 * Kibana feature paths that are audited by action name rather than (only) as saved objects:
 * alerting rules, workflows, Agent Builder, SLOs, spaces, connectors and maintenance windows.
 *
 * Kibana does not record our X-Opaque-Id and API-key callers carry no api_key.name there, so every
 * expectation is scoped by the run-unique id or name the scenario chose, matched in
 * saved_object.id/name or in body.text. Everything is created in the default space.
 */
import { F, lit } from '../fields.mjs';

const tail = (runId) => runId.replace(/^syn-/, '');
const V = { headers: { 'Elastic-Api-Version': '2023-10-31', 'Content-Type': 'application/json' } };

/** Kibana-side expectation scoped to one run-unique token anywhere it can appear. */
const kbExp = (name, action, token, extra = {}) => ({
  name, source: 'kb',
  where: `${F.action} == ${lit(action)} AND (${F.soId} == ${lit(token)} OR ${F.soName} == ${lit(token)} OR ${F.msg} LIKE ${lit(`*${token}*`)})`,
  ...extra,
});

/** Probe a list route; absent features skip rather than fail. */
async function probe(c, path) {
  const r = await c.kb('GET', path, null, { expect: [200, 404, 410] });
  return r.status === 200 ? null : `${path} -> ${r.status}`;
}

const rule = {
  id: 'kibanaFeatures.rule-lifecycle',
  title: 'Alerting rule lifecycle: create, disable, enable, run soon, get, delete',
  personas: ['automation'],
  weights: [25, 30, 0],
  cadenceMin: 120,
  async run(ctx) {
    const c = ctx.as('automation');
    const absent = await probe(c, '/api/alerting/rules/_find?per_page=1');
    if (absent) return { skipped: absent };
    const name = `syn-rule-${tail(ctx.runId)}`;
    const created = await c.kb('POST', '/api/alerting/rule', {
      name, rule_type_id: '.es-query', consumer: 'alerts', enabled: true, tags: ['syn'],
      schedule: { interval: '1h' }, actions: [],
      params: { searchType: 'esQuery', index: ['syn-orders'], timeField: '@timestamp',
        esQuery: '{"query":{"match_all":{}}}', size: 0, threshold: [100000], thresholdComparator: '>',
        timeWindowSize: 5, timeWindowUnit: 'm' },
    });
    const id = created.body?.id;
    if (!id) return { name };
    await c.kb('POST', `/api/alerting/rule/${id}/_disable`, null, { expect: [200, 204] });
    await c.kb('POST', `/api/alerting/rule/${id}/_enable`, null, { expect: [200, 204] });
    // No public run-soon route on serverless (404); the UI's internal one answers with this header.
    await c.kb('POST', `/internal/alerting/rule/${id}/_run_soon`, null,
      { expect: [200, 204], headers: { 'x-elastic-internal-origin': 'kibana' } });
    await c.kb('GET', `/api/alerting/rule/${id}`);
    await c.kb('DELETE', `/api/alerting/rule/${id}`, null, { expect: [200, 204] });
    return { id, name };
  },
  expect: ({ id }) => !id ? [] : [
    kbExp('rule_create scores 25', 'rule_create', id, { risk: 25 }),
    kbExp('rule_disable scores 30', 'rule_disable', id, { risk: 30 }),
    kbExp('rule_enable scores 25', 'rule_enable', id, { risk: 25 }),
    kbExp('rule_run_soon scores 25 (added to CHANGE_PRED by name)', 'rule_run_soon', id, { risk: 25 }),
    kbExp('rule_get scores 0', 'rule_get', id, { risk: 0 }),
    kbExp('rule_delete scores 30', 'rule_delete', id, { risk: 30 }),
  ],
  async cleanup({ kb, act, assertOwned }) {
    const r = await kb.raw('/api/alerting/rules/_find?per_page=100&search_fields=name&search=syn-*', V);
    for (const x of r.body?.data || []) {
      if (!x.name?.startsWith('syn-')) continue;
      await act(`rule ${x.name}`, () => (assertOwned(x.name), kb.raw(`/api/alerting/rule/${x.id}`, { ...V, method: 'DELETE' })));
    }
  },
};

const wfYaml = (name, waitSec) => `version: "1"
name: ${name}
description: Synthetic audit workflow (cloud-audit-dashboards generator)
enabled: true
tags: ["syn"]
triggers:
  - type: manual
steps:
  - name: hold
    type: wait
    with:
      duration: "${waitSec}s"
  - name: log
    type: console
    with:
      message: "syn workflow ran"
`;

const workflows = {
  id: 'kibanaFeatures.workflows',
  title: 'Workflows: create, update, run, test, cancel, delete',
  personas: ['automation'],
  weights: [25, 30, 10],
  cadenceMin: 60,
  async run(ctx) {
    const c = ctx.as('automation');
    const absent = await probe(c, '/api/workflows');
    if (absent) return { skipped: absent };
    const name = `syn-wf-${tail(ctx.runId)}`;
    const created = await c.kb('POST', '/api/workflows/workflow', { yaml: wfYaml(name, 15) });
    const id = created.body?.id;
    if (!id) return { name };
    await c.kb('PUT', `/api/workflows/workflow/${id}`, { description: `updated by ${ctx.runId}` });
    const run = await c.kb('POST', `/api/workflows/workflow/${id}/run`, { inputs: {} });
    const runExec = run.body?.workflowExecutionId;
    const test = await c.kb('POST', '/api/workflows/test', { workflowYaml: wfYaml(name, 15), inputs: {} });
    const testExec = test.body?.workflowExecutionId;
    const testById = await c.kb('POST', '/api/workflows/test', { workflowId: id, inputs: {} });
    const testIdExec = testById.body?.workflowExecutionId;
    const execs = [runExec, testExec, testIdExec].filter(Boolean);
    for (const ex of execs) await c.kb('POST', `/api/workflows/executions/${ex}/cancel`, null, { expect: [200, 204] });
    // Cancel is asynchronous, and a force-delete with a live execution is a 409 that Kibana audits
    // as a failed workflow_delete (40). Wait for every execution to reach a terminal state first.
    for (const ex of execs) {
      for (let i = 0; i < 20; i++) {
        const st = await c.kb('GET', `/api/workflows/executions/${ex}`);
        // status flips to cancelled at once; the execution only stops holding the workflow when
        // finishedAt is set, which is when its current step (the wait) yields.
        if (st.body?.finishedAt) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await c.kb('DELETE', `/api/workflows/workflow/${id}?force=true`, null, { expect: [200, 204] });
    return { id, name, runExec, testExec, testIdExec };
  },
  expect: ({ id, runExec, testExec, testIdExec }) => !id ? [] : [
    kbExp('workflow_create scores 25', 'workflow_create', id, { risk: 25 }),
    kbExp('workflow_update scores 25', 'workflow_update', id, { risk: 25 }),
    ...(runExec ? [kbExp('workflow_run scores 10', 'workflow_run', runExec, { risk: 10 })] : []),
    ...(testExec ? [kbExp('workflow_test scores 10', 'workflow_test', testExec, { risk: 10 })] : []),
    ...(runExec ? [kbExp('workflow_execution_cancel scores 10 (ECS deletion, executions branch wins)', 'workflow_execution_cancel', runExec, { risk: 10 })] : []),
    // OBJ_GROK assumptions: run carries [id=…] [executionId=…]; a test of a saved workflow carries
    // [workflowId=…]; a test of draft YAML names no workflow at all, so obj_name falls back to g_exec.
    ...(runExec ? [{ name: 'OBJ_GROK: workflow_run body.text has [id=…] and [executionId=…]', source: 'kb', risk: 10,
      where: `${F.action} == "workflow_run" AND ${F.msg} LIKE ${lit(`*[id=${id}]*[executionId=${runExec}]*`)}` }] : []),
    ...(testIdExec ? [{ name: 'OBJ_GROK: workflow_test of a saved workflow has [workflowId=…]', source: 'kb', risk: 10,
      where: `${F.action} == "workflow_test" AND ${F.msg} LIKE ${lit(`*[workflowId=${id}]*`)}` }] : []),
    ...(testExec ? [{ name: 'OBJ_GROK: draft-yaml workflow_test names no workflow ([draft yaml])', source: 'kb', risk: 10,
      where: `${F.action} == "workflow_test" AND ${F.msg} LIKE ${lit(`*[draft yaml]*[executionId=${testExec}]*`)}` }] : []),
    kbExp('workflow_delete scores 30', 'workflow_delete', id, { risk: 30 }),
  ],
  async cleanup({ kb, act, assertOwned }) {
    const r = await kb.raw('/api/workflows?size=100&query=syn-', V);
    for (const w of r.body?.results || []) {
      if (!w.name?.startsWith('syn-')) continue;
      await act(`workflow ${w.name}`, () => (assertOwned(w.name), kb.raw(`/api/workflows/workflow/${w.id}?force=true`, { ...V, method: 'DELETE' })));
    }
  },
};

const agentBuilder = {
  id: 'kibanaFeatures.agent-builder',
  title: 'Agent Builder: tool and agent create, update, delete',
  personas: ['automation'],
  weights: [25, 30],
  cadenceMin: 240,
  async run(ctx) {
    const c = ctx.as('automation');
    const absent = await probe(c, '/api/agent_builder/tools');
    if (absent) return { skipped: absent };
    const toolId = `syn-orders-${tail(ctx.runId)}`;
    const agentId = `syn-agent-${tail(ctx.runId)}`;
    await c.kb('POST', '/api/agent_builder/tools', {
      id: toolId, type: 'esql', description: 'Synthetic: count syn-orders by status', tags: ['syn'],
      configuration: { query: 'FROM syn-orders | STATS n = COUNT(*) BY status', params: {} },
    });
    await c.kb('PUT', `/api/agent_builder/tools/${toolId}`, { description: `Synthetic, updated by ${ctx.runId}` });
    await c.kb('POST', '/api/agent_builder/agents', {
      id: agentId, name: agentId, description: 'Synthetic analyst agent',
      configuration: { instructions: 'Answer questions about syn-orders.', tools: [{ tool_ids: [toolId] }] },
    });
    await c.kb('PUT', `/api/agent_builder/agents/${agentId}`, { description: `Synthetic, updated by ${ctx.runId}` });
    await c.kb('DELETE', `/api/agent_builder/agents/${agentId}`);
    await c.kb('DELETE', `/api/agent_builder/tools/${toolId}`);
    return { toolId, agentId };
  },
  expect: ({ toolId, agentId }) => !toolId ? [] : [
    kbExp('agent_builder_tool_create scores 25', 'agent_builder_tool_create', toolId, { risk: 25 }),
    kbExp('agent_builder_tool_update scores 25', 'agent_builder_tool_update', toolId, { risk: 25 }),
    kbExp('agent_builder_tool_delete scores 30', 'agent_builder_tool_delete', toolId, { risk: 30 }),
    kbExp('agent_builder_agent_create scores 25', 'agent_builder_agent_create', agentId, { risk: 25 }),
    kbExp('agent_builder_agent_update scores 25', 'agent_builder_agent_update', agentId, { risk: 25 }),
    kbExp('agent_builder_agent_delete scores 30', 'agent_builder_agent_delete', agentId, { risk: 30 }),
  ],
  async cleanup({ kb, act, assertOwned }) {
    const a = await kb.raw('/api/agent_builder/agents', V);
    for (const x of a.body?.results || []) {
      if (!x.id?.startsWith('syn-')) continue;
      await act(`agent ${x.id}`, () => kb.raw(`/api/agent_builder/agents/${assertOwned(x.id)}`, { ...V, method: 'DELETE' }));
    }
    const t = await kb.raw('/api/agent_builder/tools', V);
    for (const x of t.body?.results || []) {
      if (!x.id?.startsWith('syn-') || x.type === 'builtin') continue;
      await act(`tool ${x.id}`, () => kb.raw(`/api/agent_builder/tools/${assertOwned(x.id)}`, { ...V, method: 'DELETE' }));
    }
  },
};

/**
 * SLO. Creating one writes a summary doc into .slo-observability.* AS THE CALLER, so a persona
 * without `all` on those indices is refused with 403 — after Kibana has already
 * audited "User is creating slo" (outcome unknown). Kibana does NOT roll the saved object back: it is
 * orphaned until someone deletes it, so the only deletion event is our own explicit delete.
 * Both scenarios are real and both are asserted: a granted lifecycle when the persona can, and the
 * refused one (which is what this persona produces today) otherwise. The saved_object_find (0)
 * events around them name only the SO uuid, which the run never learns, so 0 is not claimed.
 */
/**
 * An SLO is backed by two transforms (slo-<id>-<rev>, slo-summary-<id>-<rev>) and two ingest
 * pipelines. Kibana's delete does not always remove them — a refused create leaves them running, and
 * a delete issued by a different credential than the creator's answers 500 having removed only the
 * saved object — so they are swept explicitly. Their names derive from the SLO id rather than
 * starting with PREFIX, so ownership is checked against the syn-slo- id embedded in them.
 */
const SLO_ARTIFACT = /^(?:slo-|slo-summary-|\.slo-observability\.(?:sli|summary)\.pipeline-)(syn-slo-[A-Za-z0-9._-]+)-\d+$/;
export const sloOwned = (name, only) => {
  const m = SLO_ARTIFACT.exec(name);
  return Boolean(m) && (!only || m[1] === only);
};

async function sweepSloArtifacts({ es, act = (_l, fn) => fn(), only }) {
  const t = await es.raw('/_transform/slo-*syn-slo-*?size=1000');
  for (const { id } of t.body?.transforms || []) {
    if (!sloOwned(id, only)) continue;
    await act(`slo transform ${id}`, async () => {
      await es.raw(`/_transform/${id}/_stop?force=true&wait_for_completion=true`, { method: 'POST' });
      await es.raw(`/_transform/${id}?force=true`, { method: 'DELETE' });
    });
  }
  const p = await es.raw('/_ingest/pipeline/.slo-observability.*pipeline-syn-slo-*');
  for (const id of Object.keys(p.ok ? p.body : {})) {
    if (!sloOwned(id, only)) continue;
    await act(`slo pipeline ${id}`, () => es.raw(`/_ingest/pipeline/${id}`, { method: 'DELETE' }));
  }
}

const slo = {
  id: 'kibanaFeatures.slo',
  title: 'SLO: create, get, update, delete (or the refused create and its orphan)',
  personas: ['automation'],
  weights: [25, 30],
  cadenceMin: 720,
  async run(ctx) {
    const c = ctx.as('automation');
    const absent = await probe(c, '/api/observability/slos?perPage=1');
    if (absent) return { skipped: absent };
    const name = `syn-slo-${tail(ctx.runId)}`.slice(0, 48);
    const created = await c.kb('POST', '/api/observability/slos', {
      id: name, name, description: 'Synthetic: share of paid syn-orders',
      indicator: { type: 'sli.kql.custom', params: { index: 'syn-orders', good: 'status : "paid"', total: '', filter: '', timestampField: '@timestamp' } },
      timeWindow: { duration: '7d', type: 'rolling' }, budgetingMethod: 'occurrences', objective: { target: 0.5 }, tags: ['syn'],
    }, { expect: [200, 403] });
    if (created.status === 403) {
      // The refused create leaves its saved object behind (GET answers 404: no summary doc), and only
      // an explicit delete removes it. That delete is the caller's, and audited as such.
      // It becomes visible to the delete only after a refresh, so wait for _definitions to list it.
      for (let i = 0; i < 10; i++) {
        const d = await c.kb('GET', `/api/observability/slos/_definitions?search=${name}`);
        if ((d.body?.results || []).some((x) => x.id === name)) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await c.kb('DELETE', `/api/observability/slos/${name}`, null, { expect: [200, 204] });
      await sweepSloArtifacts({ es: ctx.admin, only: name });
      return { name, refused: true };
    }
    await c.kb('GET', `/api/observability/slos/${name}`);
    await c.kb('PUT', `/api/observability/slos/${name}`, { description: `Synthetic, updated by ${ctx.runId}` });
    await c.kb('DELETE', `/api/observability/slos/${name}`, null, { expect: [200, 204] });
    await sweepSloArtifacts({ es: ctx.admin, only: name });
    return { name, refused: false };
  },
  expect: ({ name, refused }) => {
    if (!name) return [];
    const so = (evtype) => `${F.soType} == "slo" AND ${F.evtype} == ${lit(evtype)} AND ${F.soName} == ${lit(name)}`;
    // Kibana audits an SLO UPDATE as saved_object_create (event.type creation): the update re-creates
    // the saved object, so there is never a `change` event for an SLO. Create + update = 2 creations.
    if (!refused) return [
      { name: 'slo create and update both audited as creations (25)', source: 'kb', risk: 25, min: 2, where: so('creation') },
      { name: 'slo update is never audited as a change', source: 'kb', min: 0, max: 0, where: so('change') },
      { name: 'slo saved object deleted (30)', source: 'kb', risk: 30, where: so('deletion') },
    ];
    return [
      // The refused create is audited only as an ATTEMPT (outcome unknown), never as a failure,
      // so it scores as a successful change rather than 40.
      { name: 'refused SLO create is audited as an attempted creation scoring 25, not a failure (40)', source: 'kb', risk: 25, where: so('creation') },
      { name: 'orphaned SLO saved object deleted (30)', source: 'kb', risk: 30, where: so('deletion') },
    ];
  },
  async cleanup({ es, kb, act, assertOwned }) {
    // _definitions reads the saved objects, so it also finds SLOs a refused create orphaned.
    const r = await kb.raw('/api/observability/slos/_definitions?perPage=100&search=syn-', V);
    for (const s of r.body?.results || []) {
      if (!s.name?.startsWith('syn-') || !s.id?.startsWith('syn-')) continue;
      await act(`slo ${s.name}`, () => (assertOwned(s.name), kb.raw(`/api/observability/slos/${assertOwned(s.id)}`, { ...V, method: 'DELETE' })));
    }
    await sweepSloArtifacts({ es, act });
  },
};

const space = {
  id: 'kibanaFeatures.space-lifecycle',
  title: 'Security admin creates and deletes a space',
  personas: ['secadmin'],
  weights: [25, 30],
  cadenceMin: 1440,
  async run(ctx) {
    const c = ctx.as('secadmin');
    const id = `syn-tmp-${tail(ctx.runId)}`;
    await c.kb('POST', '/api/spaces/space', { id, name: id, disabledFeatures: [] });
    await c.kb('DELETE', `/api/spaces/space/${id}`, null, { expect: [200, 204] });
    return { id };
  },
  expect: ({ id }) => !id ? [] : [
    kbExp('space_create scores 25', 'space_create', id, { risk: 25 }),
    kbExp('space_delete scores 30', 'space_delete', id, { risk: 30 }),
  ],
  async cleanup({ kb, act, assertOwned }) {
    const r = await kb.raw('/api/spaces/space');
    for (const s of (Array.isArray(r.body) ? r.body : []).filter((x) => x.id.startsWith('syn-tmp-'))) {
      await act(`space ${s.id}`, () => kb.raw(`/api/spaces/space/${assertOwned(s.id)}`, { method: 'DELETE' }));
    }
  },
};

const connector = {
  id: 'kibanaFeatures.connector',
  title: 'Connector create, update, delete (never executed)',
  personas: ['automation'],
  weights: [25, 30],
  cadenceMin: 360,
  async run(ctx) {
    const c = ctx.as('automation');
    const name = `syn-conn-${tail(ctx.runId)}`;
    const created = await c.kb('POST', '/api/actions/connector', {
      name, connector_type_id: '.index', config: { index: 'syn-app-logs', refresh: false }, secrets: {},
    });
    const id = created.body?.id;
    if (!id) return { name };
    await c.kb('PUT', `/api/actions/connector/${id}`, { name: `${name}-v2`, config: { index: 'syn-app-logs', refresh: false }, secrets: {} });
    await c.kb('DELETE', `/api/actions/connector/${id}`, null, { expect: [200, 204] });
    return { id, name };
  },
  expect: ({ id }) => !id ? [] : [
    kbExp('connector_create scores 25', 'connector_create', id, { risk: 25 }),
    kbExp('connector_update scores 25', 'connector_update', id, { risk: 25 }),
    kbExp('connector_delete scores 30', 'connector_delete', id, { risk: 30 }),
  ],
  async cleanup({ kb, act, assertOwned }) {
    const r = await kb.raw('/api/actions/connectors', V);
    for (const x of (Array.isArray(r.body) ? r.body : []).filter((x) => !x.is_preconfigured && x.name?.startsWith('syn-'))) {
      await act(`connector ${x.name}`, () => (assertOwned(x.name), kb.raw(`/api/actions/connector/${x.id}`, { ...V, method: 'DELETE' })));
    }
  },
};

const maintenance = {
  id: 'kibanaFeatures.maintenance-window',
  title: 'Maintenance window create and delete (scheduled 30 days out, disabled)',
  personas: ['automation'],
  weights: [25, 30],
  cadenceMin: 720,
  async run(ctx) {
    const c = ctx.as('automation');
    const absent = await probe(c, '/api/maintenance_window/_find?per_page=1');
    if (absent) return { skipped: absent };
    const title = `syn-mw-${tail(ctx.runId)}`;
    const start = new Date(Date.now() + 30 * 864e5).toISOString();
    const created = await c.kb('POST', '/api/maintenance_window', {
      title, enabled: false, schedule: { custom: { start, duration: '1h' } },
    });
    const id = created.body?.id;
    if (!id) return { title };
    await c.kb('DELETE', `/api/maintenance_window/${id}`, null, { expect: [200, 204] });
    return { id, title };
  },
  expect: ({ id }) => !id ? [] : [
    { name: 'maintenance window created (scores 25)', source: 'kb', risk: 25,
      where: `${F.evtype} == "creation" AND (${F.soId} == ${lit(id)} OR ${F.msg} LIKE ${lit(`*${id}*`)})` },
    { name: 'maintenance window deleted (scores 30)', source: 'kb', risk: 30,
      where: `${F.evtype} == "deletion" AND (${F.soId} == ${lit(id)} OR ${F.msg} LIKE ${lit(`*${id}*`)})` },
  ],
  async cleanup({ kb, act, assertOwned }) {
    const r = await kb.raw('/api/maintenance_window/_find?per_page=100', V);
    for (const m of r.body?.maintenanceWindows || r.body?.data || []) {
      if (!m.title?.startsWith('syn-')) continue;
      await act(`maintenance window ${m.title}`, () => (assertOwned(m.title), kb.raw(`/api/maintenance_window/${m.id}`, { ...V, method: 'DELETE' })));
    }
  },
};

export default [rule, workflows, agentBuilder, slo, space, connector, maintenance];
