/** Resolves the repo .env into the shape every command needs. */
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
  get space()   { return process.env.AUDIT_SPACE || 'audit'; },
  /** Space-scoped Kibana base, e.g. https://…kb…/s/audit */
  get kbs()     { return `${this.kibana}/s/${this.space}`; },
  get dataStream() { return process.env.AUDIT_STREAM || DEFAULT_STREAM; },
  /** `logs-<dataset>-<namespace>`; the ingest names below derive from it so they follow a rename. */
  get dataset()  { return parseStream(this.dataStream).dataset; },
  get pipeline() { return `logs-${this.dataset}@custom`; },
  get indexTemplate() { return `logs-${this.dataset}@template`; },
  /**
   * Saved-object id namespace. Dashboards, visualizations, searches and data views are
   * multiple-isolated types, so an id is unique across ALL spaces: with the suite deployed in one
   * space, `PUT /api/dashboards/elastic_cloud-audit-…` in a second space answers 409, and `_import` quietly
   * writes the Vega and Discover objects under fresh ids, so every panel's ref dangles. A private
   * render of a work in progress (`AUDIT_SPACE=x AUDIT_ID_NS=x`) therefore needs its own ids. Unset,
   * nothing changes: the deployed ids stay `cloud-audit-*`.
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
