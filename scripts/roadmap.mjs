/**
 * docs/roadmap.html is the roadmap's source: one self-contained page whose data (design holes, use cases,
 * releases) sits in its <script id="data"> block. GitHub does not render HTML, so this writes the same
 * content to docs/ROADMAP.md. Run it after editing the page:
 *
 *   node scripts/roadmap.mjs
 *
 * test/unit/roadmap.test.mjs fails when the committed Markdown is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HTML = join(ROOT, 'docs', 'roadmap.html');
export const MD = join(ROOT, 'docs', 'ROADMAP.md');

const COV = { answered: 'Answered', partly: 'Partly', 'needs-alerting-or-retention': 'Needs alerting or retention', 'not-in-data': 'Not in the data' };

/** The page's data block, plus the static header and summary text. */
export function readPage(html) {
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('docs/roadmap.html has no <script id="data"> block');
  const data = JSON.parse(m[1]);
  const pick = (re, what) => { const r = html.match(re); if (!r) throw new Error(`docs/roadmap.html: no ${what}`); return r[1]; };
  return {
    data,
    title: text(pick(/<h1>([\s\S]*?)<\/h1>/, 'h1')),
    lede: text(pick(/<p class="lede">([\s\S]*?)<\/p>/, 'lede')),
    reviewed: text(pick(/<span>(Reviewed [\s\S]*?)<\/span>/, 'Reviewed line')),
    summaryTitle: text(pick(/<section id="summary">[\s\S]*?<h2>([\s\S]*?)<\/h2>/, 'summary heading')),
    summary: pick(/<ul class="findings">([\s\S]*?)<\/ul>/, 'summary list'),
    roadmapIntro: text(pick(/From here to full coverage<\/h2><\/div>\s*<p>([\s\S]*?)<\/p>/, 'roadmap intro')),
  };
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
function text(s) {
  return s.replace(/<b>([\s\S]*?)<\/b>/g, '**$1**').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, (e) => ENT[e] ?? e).replace(/\s+/g, ' ').trim();
}
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function toMarkdown(page) {
  const { data: D } = page;
  const rows = D.rows, holes = D.holes;
  const count = (arr, k) => arr.filter((r) => r.coverage === k).length;
  const pct = (n, t) => Math.round((n / t) * 100);
  const T = rows.length;
  const mgr = rows.filter((r) => r.personas.includes('Manager'));
  // The page fills these spans from the data at load time; do the same here.
  const fill = {
    's-total': String(T),
    's-ans': `${count(rows, 'answered')} (${pct(count(rows, 'answered'), T)}%)`,
    's-part': `${count(rows, 'partly')} (${pct(count(rows, 'partly'), T)}%)`,
    's-alert': String(count(rows, 'needs-alerting-or-retention')),
    's-mgr': `${count(mgr, 'answered')} of their ${mgr.length} questions are answered outright.`,
  };
  const summary = page.summary
    .replace(/<span id="([a-z-]+)"><\/span>/g, (all, id) => fill[id] ?? all)
    .match(/<li>[\s\S]*?<\/li>/g).map((li) => `- ${text(li)}`);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  const out = [];
  out.push(`# ${page.title}`, '');
  out.push('<!-- Generated from docs/roadmap.html by `node scripts/roadmap.mjs`. Edit the page, not this file. -->', '');
  out.push(page.lede, '');
  out.push(`${page.reviewed} · ${T} use cases · ${holes.length} open design holes. The full page, with filters and every`,
    'use case\'s detail, is [`docs/roadmap.html`](roadmap.html): download it and open it in a browser.', '');
  out.push(`## ${page.summaryTitle}`, '', ...summary, '');
  out.push('| Coverage | Use cases |', '| --- | --- |');
  for (const [k, label] of Object.entries(COV)) out.push(`| ${label} | ${count(rows, k)} |`);
  out.push('');

  out.push('## Roadmap', '', page.roadmapIntro.replace(/ Expand a release for its use cases and holes\.$/, ''), '');
  for (const p of D.phases) {
    out.push(`### ${p.v} — ${p.name}`, '', p.goal, '');
    for (const it of p.items) out.push(`- ${it}`);
    const ph = p.holes.map((i) => holes[i]);
    const uc = p.uc.map((id) => byId[id]).filter(Boolean);
    out.push('', `${ph.length} design holes · ${uc.length} use cases`, '');
    if (ph.length) { out.push('Design holes:', ''); for (const h of ph) out.push(`- **${cell(h.severity)}** — ${cell(h.title)}`); out.push(''); }
    if (uc.length) { out.push('Use cases:', ''); for (const r of uc) out.push(`- ${r.id} — ${cell(r.question)}`); out.push(''); }
  }
  const outOfReach = (D.out_of_reach || []).map((id) => byId[id]).filter(Boolean);
  if (outOfReach.length) {
    out.push('### Out of reach on serverless', '');
    for (const r of outOfReach) out.push(`- ${r.id} — ${cell(r.question)}${r.blocker ? ` (${cell(r.blocker)})` : ''}`);
    out.push('');
  }

  out.push('## Design holes', '');
  holes.forEach((h, i) => {
    out.push(`### ${i + 1}. ${h.title}`, '');
    out.push(`Severity **${h.severity}** · ${h.area} · ${h.personas.join(', ')} · effort ${h.effort} · planned for ${h.phase}`, '');
    out.push(`- **Impact:** ${h.impact}`, `- **Fix:** ${h.fix}`, `- **Evidence:** ${h.evidence}`, '');
  });

  out.push('## Use cases', '');
  out.push('| Id | Personas | Question | Coverage | Planned for |', '| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const plan = r.phase === 'out' ? 'Out of reach' : r.phase || '';
    out.push(`| ${r.id} | ${cell(r.personas.join(', '))} | ${cell(r.question)} | ${COV[r.coverage] || r.coverage} | ${plan} |`);
  }
  out.push('');
  return out.join('\n');
}

export function build() { return toMarkdown(readPage(readFileSync(HTML, 'utf8'))); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(MD, build());
  console.log(`wrote ${MD}`);
}
