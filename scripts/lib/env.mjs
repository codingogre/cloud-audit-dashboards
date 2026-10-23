/** Resolves the repo .env into the shape every command needs. */
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see .env.example`);
  return v;
}

const strip = (u) => u.replace(/\/+$/, '');

/**
 * The audit stream verified against live data (2026-10-14). Elastic renamed it from
 * logs-serverless.audit.otel-elastic_cloud; AUDIT_STREAM overrides it for a project that differs.
 * The committed Vega/Discover JSON spells this name out, and withStream() rewrites it at load time.
 */
export const DEFAULT_STREAM = 'logs-elastic_cloud.serverless_audit.otel-default';
export const withStream = (text) => text.replaceAll(DEFAULT_STREAM, cfg.dataStream);

export function parseStream(name) {
  const m = /^logs-(.+)-([^-]+)$/.exec(name);
  if (!m) throw new Error(`AUDIT_STREAM "${name}" is not a logs-<dataset>-<namespace> data stream`);
  return { dataset: m[1], namespace: m[2] };
}

export const cfg = {
  get es()      { return strip(req('EC_URL')); },
  get kibana()  { return strip(req('KB_URL')); },
  get apiKey()  { return req('EC_API_KEY'); },
  /** Kibana base for everything the suite deploys: the Default space, which has no /s/<id> prefix. */
  get kbs()     { return this.kibana; },
  get dataStream() { return process.env.AUDIT_STREAM || DEFAULT_STREAM; },
  /** `logs-<dataset>-<namespace>`; the ingest names below derive from it so they follow a rename. */
  get dataset()  { return parseStream(this.dataStream).dataset; },
  get pipeline() { return `logs-${this.dataset}@custom`; },
  get indexTemplate() { return `logs-${this.dataset}@template`; },
  /**
   * Saved-object id namespace. Dashboards, visualizations, searches and data views are
   * multiple-isolated types, so an id is unique across ALL spaces: with the suite deployed in one
   * space, `PUT /api/dashboards/elastic_cloud-audit-…` in a second space answers 409, and `_import` quietly
   * writes the Vega and Discover objects under fresh ids, so every panel's ref dangles. The suite
   * installs into the Default space, so a private render of a work in progress (`AUDIT_ID_NS=x`)
   * sits beside production under its own ids. Unset, nothing changes: the deployed ids stay
   * `cloud-audit-*` / `elastic_cloud-audit-*`.
   */
  get ns() { return process.env.AUDIT_ID_NS ? `cloud-audit-${process.env.AUDIT_ID_NS}` : 'cloud-audit'; },
  ROOT,
};

/**
 * A `cloud-audit-…` id in the active namespace (identity when AUDIT_ID_NS is unset). A dashboard id
 * (`elastic_cloud-audit-<name>`, lib/suite.mjs) keeps its `elastic_` prefix and is namespaced the same
 * way: `elastic_cloud-audit-<ns>-dashboard` (Command Center), `elastic_cloud-audit-<ns>-actor-360`.
 */
export const nsId = (id) => {
  // Idempotent: an id already in the namespace is returned as is, so a caller holding a deployed id
  // (ACTOR_360, a dashId()) cannot namespace it twice into `…cloud-audit-<ns>-<ns>-…`.
  const bare = id.replace(/^elastic_/, '');
  if (process.env.AUDIT_ID_NS && bare.startsWith(`${cfg.ns}-`)) return id;
  return id.replace(/^(elastic_)?cloud-audit(?=-)/, (_, e = '') => `${e}${cfg.ns}`);
};

/**
 * VEGA AND DISCOVER IDS (1.0.5.1). The files in vega/ and searches/ are numbered (`01-actor-risk-treemap.json`)
 * so the repo lists them in order, and FRAGMENT_USES / DSL_SPECS (layout.mjs) are keyed on those names. The
 * saved-object id drops the number: `cloud-audit-vega-actor-risk-treemap`, `cloud-audit-search-all-events`.
 * A `ref` is a file name with or without `.json`. Ids up to 1.0.5 kept the number; RETIRED_OBJECTS lists them.
 */
const DIRS = { vega: 'vega', search: 'searches' };
const ORDER = /^\d+-/;
export const objSlug = (ref) => ref.replace(/\.json$/, '').replace(ORDER, '');
export const objId = (kind, ref) => {
  if (!DIRS[kind]) throw new Error(`objId: unknown kind ${kind}`);
  return nsId(`cloud-audit-${kind}-${objSlug(ref)}`);
};

/** The files of one kind, checked once: two files that drop to the same id would overwrite each other. */
const files = {};
export function objFiles(kind) {
  if (files[kind]) return files[kind];
  const list = readdirSync(resolve(ROOT, DIRS[kind])).filter((f) => f.endsWith('.json')).sort();
  const seen = new Map();
  for (const f of list) {
    const s = objSlug(f);
    if (seen.has(s)) throw new Error(`${DIRS[kind]}/${seen.get(s)} and ${DIRS[kind]}/${f} both deploy as ${objId(kind, f)}`);
    seen.set(s, f);
  }
  return (files[kind] = list);
}

/**
 * The repo path behind a deployed id (`vega/01-actor-risk-treemap.json`), in any AUDIT_ID_NS namespace,
 * or null. The --lint ref check and --perf's per-dashboard grouping read ids back to files through this.
 */
export function objFile(id) {
  const m = /^cloud-audit(?:-.+?)?-(vega|search)-(.+)$/.exec(id);
  if (!m) return null;
  const [, kind, slug] = m;
  const f = objFiles(kind).find((x) => objSlug(x) === slug);
  return f ? `${DIRS[kind]}/${f}` : null;
}

/**
 * The numbered ids 1.0.5 and earlier deployed (`cloud-audit-vega-01-actor-risk-treemap`), namespaced. They are
 * deleted after --dashboards re-points every panel (dashboards.mjs removeStrays) and by --clean. A file
 * with no order prefix kept its id, so it is never listed: deleting it would delete the live object.
 */
export const RETIRED_OBJECTS = () => Object.entries({ vega: 'visualization', search: 'search' }).flatMap(([kind, type]) =>
  objFiles(kind).filter((f) => ORDER.test(f))
    .map((f) => ({ type, id: nsId(`cloud-audit-${kind}-${f.replace(/\.json$/, '')}`) })));
