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

export const cfg = {
  get es()      { return strip(req('EC_URL')); },
  get kibana()  { return strip(req('KB_URL')); },
  get apiKey()  { return req('EC_API_KEY'); },
  get space()   { return process.env.AUDIT_SPACE || 'audit'; },
  /** Space-scoped Kibana base, e.g. https://…kb…/s/audit */
  get kbs()     { return `${this.kibana}/s/${this.space}`; },
  dataStream: 'logs-serverless.audit.otel-elastic_cloud',
  dataset: 'serverless.audit.otel',
  pipeline: 'logs-serverless.audit.otel@custom',
  ROOT,
};
