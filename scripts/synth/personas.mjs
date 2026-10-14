/**
 * The synthetic cast. Each persona is an Elasticsearch API key whose NAME is the identity the
 * dashboards show (actor = COALESCE(user.email, api_key.name, ...)), minted by the admin key with
 * its own role_descriptors. Serverless has no native realm, and inviting Cloud users sends real
 * email, so a key per persona is the only way to give the audit stream distinct identities.
 *
 * Privileges are deliberately uneven: the contractor is meant to be refused, the bot is meant to be
 * loud, and only the security admin can touch security config. Kibana feature names are the ones
 * this project's GET /api/security/privileges lists (serverless 9.6) — a name it does not know is
 * rejected at mint time, which is the point at which a rename should surface.
 */
export const PREFIX = 'syn-';
export const SPACES = ['syn-finance', 'syn-marketing'];
const ALL_SPACES = ['space:default', ...SPACES.map((s) => `space:${s}`)];

const kibana = (privileges, resources = ALL_SPACES) =>
  [{ application: 'kibana-.kibana', privileges, resources }];

export const PERSONAS = {
  bot: {
    name: 'syn-etl-ingest-bot',
    title: 'High-volume ETL service key (the noise workload)',
    role: {
      cluster: ['monitor'],
      indices: [{ names: ['syn-*'], privileges: ['read', 'write', 'create_index', 'view_index_metadata'] }],
    },
  },
  sre: {
    name: 'syn-sre-maria.lopez',
    title: 'SRE: health checks, index admin, ES|QL',
    role: {
      cluster: ['monitor', 'manage_own_api_key'],
      indices: [
        { names: ['syn-*'], privileges: ['all'] },
        { names: ['.alerts-*'], privileges: ['read', 'view_index_metadata'], allow_restricted_indices: false },
      ],
      applications: kibana(['feature_dashboard_v2.read', 'feature_discover_v2.read']),
    },
  },
  analyst: {
    name: 'syn-analyst-raj.patel',
    title: 'Analyst: reads, ES|QL, Kibana content author across three spaces',
    role: {
      cluster: ['monitor'],
      indices: [{ names: ['syn-orders', 'syn-invoices', 'syn-customers', 'syn-app-logs'], privileges: ['read', 'view_index_metadata'] }],
      applications: kibana([
        'feature_dashboard_v2.all', 'feature_discover_v2.all', 'feature_indexPatterns.all',
        'feature_savedObjectsTagging.all', 'feature_visualize.all',
      ]),
    },
  },
  secadmin: {
    name: 'syn-secadmin-chen.wu',
    title: 'Security admin: roles, API key lifecycle, spaces',
    role: {
      cluster: ['manage_security', 'manage_api_key', 'monitor'],
      applications: kibana(['all'], ['*']),
    },
  },
  automation: {
    name: 'syn-automation-ops',
    title: 'Kibana automation: rules, workflows, agent builder, SLOs',
    role: {
      // An SLO is backed by transforms, an ingest pipeline and .slo-observability.* indices written
      // with the caller's own credentials; without these Kibana refuses the create.
      cluster: ['monitor', 'manage_transform', 'manage_ingest_pipelines'],
      indices: [
        { names: ['syn-*'], privileges: ['read', 'view_index_metadata'] },
        // `all`: write + create_index was measured insufficient (403); all was measured to succeed.
        { names: ['.slo-observability.*'], privileges: ['all'], allow_restricted_indices: false },
      ],
      applications: kibana(['all']),
    },
  },
  contractor: {
    name: 'syn-contractor-alex.kim',
    title: 'Under-privileged contractor: the source of denials',
    role: {
      indices: [{ names: ['syn-orders'], privileges: ['read'] }],
      applications: kibana(['feature_dashboard_v2.read'], ['space:default']),
    },
  },
  hr: {
    name: 'syn-hr-reporter',
    title: 'Narrow data owner: the only reader of syn-hr-salaries',
    role: {
      indices: [{ names: ['syn-hr-salaries'], privileges: ['read', 'write'] }],
    },
  },
};

/** A persona minted mid-run so "newly seen identity" panels have something new to find. */
export const newHire = (runId) => ({
  name: `syn-new-hire-${runId.replace(/^syn-/, '')}`,
  title: 'Newly seen identity',
  role: {
    indices: [{ names: ['syn-orders'], privileges: ['read'] }],
    applications: kibana(['feature_dashboard_v2.read'], ['space:default']),
  },
});

/** Every name the generator creates starts with PREFIX. Cleanup refuses anything else. */
export function assertOwned(name) {
  if (typeof name !== 'string' || !name.startsWith(PREFIX) || name.length <= PREFIX.length || /[*?,\s]/.test(name)) {
    throw new Error(`refusing to touch "${name}": not a ${PREFIX}* resource the generator owns`);
  }
  return name;
}
