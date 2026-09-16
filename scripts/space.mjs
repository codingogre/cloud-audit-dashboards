/** Creates the target Kibana space. 409 means it already exists, which is success. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from './lib/env.mjs';
import { kb } from './lib/http.mjs';
import { success, info } from './lib/log.mjs';

export async function run() {
  const body = JSON.parse(readFileSync(join(ROOT, 'ingest', 'space.json'), 'utf8'));
  body.id = cfg.space;
  const res = await kb.raw('/api/spaces/space', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (res.ok) success(`Space "${cfg.space}" created`);
  else if (res.status === 409) info(`Space "${cfg.space}" already exists`);
  else throw new Error(`space create failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
}
