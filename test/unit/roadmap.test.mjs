import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, MD } from '../../scripts/roadmap.mjs';

test('docs/ROADMAP.md matches docs/roadmap.html', () => {
  assert.equal(readFileSync(MD, 'utf8'), build(), 'stale: run node scripts/roadmap.mjs');
});

test('every roadmap release names holes and use cases that exist', () => {
  const html = readFileSync(new URL('../../docs/roadmap.html', import.meta.url), 'utf8');
  const D = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const ids = new Set(D.rows.map((r) => r.id));
  for (const p of D.phases) {
    for (const i of p.holes) assert.ok(D.holes[i], `${p.v}: hole ${i} does not exist`);
    for (const u of p.uc) assert.ok(ids.has(u), `${p.v}: ${u} does not exist`);
  }
});
