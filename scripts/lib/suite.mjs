/**
 * The suite's dashboards as a catalogue: which exist, their deployed ids, their nav labels, the order of
 * the navigation strip, and which are opt-in.
 *
 * Three things here are deliberately separate, because they changed independently in 1.0.2:
 *
 *   name   the source module and dashboards/<name>.json, and the deploy order (definitions.mjs). Stable.
 *   id     the deployed saved-object id, `elastic_cloud-audit-<name>` with no source number (1.0.3, the
 *          human's choice). Command Center is `elastic_cloud-audit-dashboard`: the Cloud UI's "Log delivery"
 *          page links to that exact id, so it must never change again. nsId() namespaces every id the same
 *          way (`elastic_cloud-audit-<ns>-actor-360`), so a private deploy under AUDIT_ID_NS cannot collide
 *          with production. The noise gate's SUITE_SELF and SUITE_INSTALL_URL (panels.mjs) count
 *          `elastic_cloud-audit-*` as the suite's own traffic, and `cloud-audit-*` (the Vega and Discover
 *          objects, the data view and the retired dashboard ids) too. Only dashboard ids carry `elastic_`.
 *   order  this array's order is the navigation strip's order, left to right. Actor 360 is second: it is
 *          where an analyst goes from anything noticed on Command Center.
 *
 * `optional` names an opt-in: the dashboard is built, linked and deployed only when that name is in
 * AUDIT_WITH (`./audit … --with platform-volume` sets it for one command). Every command reads the set
 * from here, so --objects, --dashboards, --verify, --perf and --lint always agree on it.
 */
import { nsId } from './env.mjs';

export const SUITE = [
  { name: '00-command-center',     id: 'elastic_cloud-audit-dashboard',          label: '\u{1F39B}️  Command Center' },
  { name: '07-actor-360',          id: 'elastic_cloud-audit-actor-360',          label: '\u{1F464}  Actor 360' },
  { name: '01-identity-access',    id: 'elastic_cloud-audit-identity-access',    label: '\u{1F510}  Identity & Access' },
  { name: '02-kibana-objects',     id: 'elastic_cloud-audit-kibana-objects',     label: '\u{1F5C2}️  Kibana Object Forensics' },
  { name: '03-data-access',        id: 'elastic_cloud-audit-data-access',        label: '\u{1F50E}  Elasticsearch Data Access' },
  { name: '04-security-anomalies', id: 'elastic_cloud-audit-security-anomalies', label: '\u{1F6A8}  Security & Anomalies' },
  { name: '05-geo-network',        id: 'elastic_cloud-audit-geo-network',        label: '\u{1F30D}  Geo & Network' },
  { name: '06-platform-volume',    id: 'elastic_cloud-audit-platform-volume',    label: '\u{1F4CA}  Platform Volume', optional: 'platform-volume' },
];

/**
 * Ids this suite deployed under in an earlier release. --dashboards removes them from the space it deploys
 * to (each is read first); --clean dashboards does too. Before 1.0.2 Command Center was
 * cloud-audit-00-command-center; before 1.0.3 every other dashboard carried its source number
 * (cloud-audit-<NN>-<name>), Platform Volume's included.
 */
export const RETIRED_IDS = [
  'cloud-audit-00-command-center',
  'cloud-audit-01-identity-access',
  'cloud-audit-02-kibana-objects',
  'cloud-audit-03-data-access',
  'cloud-audit-04-security-anomalies',
  'cloud-audit-05-geo-network',
  'cloud-audit-06-platform-volume',
  'cloud-audit-07-actor-360',
];

/** A dashboard's id as authored, before AUDIT_ID_NS namespaces it (a drilldown destination, dash()). */
export function rawId(name) {
  const d = SUITE.find((x) => x.name === name);
  if (!d) throw new Error(`no dashboard named ${name}`);
  return d.id;
}

/** The opt-in names AUDIT_WITH accepts. */
export const OPT_INS = SUITE.filter((d) => d.optional).map((d) => d.optional);

/** AUDIT_WITH as a set. An unknown name throws rather than silently deploying less than was asked for. */
export function optIns(env = process.env) {
  const want = String(env.AUDIT_WITH || '').split(',').map((x) => x.trim()).filter(Boolean);
  const bad = want.filter((w) => !OPT_INS.includes(w));
  if (bad.length) throw new Error(`AUDIT_WITH / --with: unknown ${bad.join(', ')} (known: ${OPT_INS.join(', ')})`);
  return new Set(want);
}

/**
 * `--with <name>[,<name>]` (or `--with=<name>`) may appear anywhere after the command. It is folded
 * into AUDIT_WITH before any command module loads, so the opt-in set (lib/suite.mjs) is one value for
 * the whole run and every command builds the same suite. It adds to an AUDIT_WITH from .env.
 */
export function takeWith(args, env = process.env) {
  const out = [];
  const add = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--with') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--with needs a name, e.g. --with platform-volume');
      add.push(args[++i]);
    } else if (a.startsWith('--with=')) add.push(a.slice('--with='.length));
    else out.push(a);
  }
  if (add.length) env.AUDIT_WITH = [env.AUDIT_WITH, ...add].filter(Boolean).join(',');
  return out;
}

/** The dashboards this run builds and deploys, in navigation order. */
export const deployed = () => {
  const on = optIns();
  return SUITE.filter((d) => !d.optional || on.has(d.optional));
};

export const isDeployed = (name) => deployed().some((d) => d.name === name);

/** A dashboard's deployed id, in the active AUDIT_ID_NS namespace. */
export const dashId = (name) => nsId(rawId(name));

/** Saved-object ids of suite dashboards this run must NOT leave behind: retired ids and opted-out dashboards. */
export const strays = () => {
  const on = new Set(deployed().map((d) => d.name));
  return [...RETIRED_IDS.map(nsId), ...SUITE.filter((d) => !on.has(d.name)).map((d) => nsId(d.id))];
};
