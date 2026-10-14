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
  ROOT,
};
