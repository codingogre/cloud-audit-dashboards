/**
 * HTML helpers for the generated presenter guide.
 *
 * The idiom is that a step owns everything it needs — the action, the link that performs it,
 * the block to paste, and the line to say. Minute badges are summed out of the rendered DOM
 * rather than typed, so the hero total can never disagree with the steps.
 */

/** HTML-escape. Nullish becomes empty rather than the string "null". */
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Inline formatting for strings this file builds itself: **bold** and `code`.
 * Anything that needs escaping goes through codeblock(), which escapes.
 */
export const rich = (s) => String(s ?? '')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

/** Thousands separators, fixed to en-US so output does not vary by machine locale. */
export const fmt = (n) => (n === null || n === undefined || Number.isNaN(Number(n)))
  ? '\u2014' : Number(n).toLocaleString('en-US');

export const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

export const codeblock = (code, lang = '') =>
  `<div class="code"><div class="bar"><span>${esc(lang)}</span><button class="copy" type="button" aria-label="Copy">${COPY_ICON}</button></div><pre>${esc(code)}</pre></div>`;

export const talk = (s) => `<div class="talk">${rich(s)}</div>`;
export const check = (list) => `<ul class="check">${list.map((i) => `<li>${rich(i)}</li>`).join('')}</ul>`;
export const callout = (kind, label, body, code = '', lang = '') =>
  `<div class="callout ${kind}"><span class="label">${esc(label)}</span>${rich(body)}${code ? codeblock(code, lang) : ''}</div>`;
export const a = (href, text) => `<a class="kb" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

/**
 * Table cells carry DATA, so they are escaped before the markdown idiom is applied. rich() alone
 * would let a value like `<anonymous>` be parsed as a tag and vanish, leaving an empty cell that
 * reads as a bug. esc() leaves backticks and asterisks alone, so **bold** and `code` still work.
 */
const cell = (c) => rich(esc(c));

export const rows = (header, body) =>
  `<table><thead><tr>${header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    body.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/** A use case: the question an analyst brings, what proves it, then the steps. */
export const useCase = ({ id, n, title, proves, steps }) => `
<h2 id="${id}">${n} &middot; ${esc(title)}</h2>
<p class="proves"><strong>What this proves:</strong> ${rich(proves)}</p>
${steps.join('\n')}`;

export const MINS_RE = /<span class="mins">(\d+) min<\/span>/g;
export const minutesIn = (html) => [...html.matchAll(MINS_RE)].reduce((n, m) => n + Number(m[1]), 0);
export const stepsIn = (html) => (html.match(/class="step"/g) || []).length;

/** Step factory bound to a running counter, so numbering is a property of the document. */
export function stepper() {
  let n = 0;
  return (title, o = {}) => {
    n += 1;
    return `
<div class="step">
  <div class="step-head"><span class="n">${n}</span><h3>${esc(title)}</h3>${o.mins ? `<span class="mins">${esc(o.mins)}</span>` : ''}</div>
  ${o.act ? `<p class="act">${rich(o.act)}</p>` : ''}
  ${(o.links || (o.link ? [o.link] : [])).map((l) => `<a class="go" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(' ')}
  ${o.codeCap ? `<p class="cap">${rich(o.codeCap)}</p>` : ''}
  ${o.code ? codeblock(o.code, o.lang || '') : ''}
  ${o.table ? rows(o.table.head, o.table.body) : ''}
  ${o.say ? talk(o.say) : ''}
  ${(o.notes || (o.note ? [o.note] : [])).map((nt) => callout(nt.kind || 'tip', nt.label, nt.body, nt.code, nt.lang)).join('')}
</div>`;
  };
}

export const CSS = `<style>
:root{--bg:#0B0B16;--surface:#15152E;--panel:#1B1B3A;--code:#121226;--wire:#2A2F45;
--white:#fff;--muted:#9AA0B5;--teal:#00BFB3;--blue:#0077CC;--yellow:#FEC514;--magenta:#F04E98;--green:#00D47E}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--white);font:15px/1.62 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:0 24px 96px}
.hero{background:linear-gradient(140deg,#12122b,#0B0B16 70%);border-bottom:1px solid var(--wire);padding:56px 0 40px;margin-bottom:36px}
.hero .wrap{padding-bottom:0}
.kicker{color:var(--teal);font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
h1{font-size:38px;line-height:1.15;margin:10px 0 12px}
h2{font-size:24px;margin:44px 0 14px;padding-top:14px;border-top:1px solid var(--wire)}
h3{font-size:17px;margin:0}
.aud{color:var(--muted);margin:0 0 18px}
.thesis{background:var(--panel);border-left:3px solid var(--teal);padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:26px 0 0}
.stat{background:var(--surface);border:1px solid var(--wire);border-radius:10px;padding:14px 16px}
.stat b{display:block;font-size:26px;line-height:1.2}
.stat span{color:var(--muted);font-size:12px}
nav.toc{background:var(--surface);border:1px solid var(--wire);border-radius:10px;padding:16px 20px;columns:2;column-gap:32px}
nav.toc a{display:block;color:var(--muted);text-decoration:none;padding:3px 0;font-size:14px;break-inside:avoid}
nav.toc a:hover{color:var(--teal)}
.talk{border-left:3px solid var(--teal);background:rgba(0,191,179,.06);padding:12px 16px 12px 58px;border-radius:0 8px 8px 0;margin:12px 0;position:relative}
.talk::before{content:"SAY";position:absolute;left:16px;top:12px;color:var(--teal);font-size:11px;font-weight:700;letter-spacing:.08em}
ul.check{list-style:none;padding:0;margin:12px 0}
ul.check li{position:relative;padding:4px 0 4px 30px}
ul.check li::before{content:"";position:absolute;left:2px;top:9px;width:14px;height:14px;border:1.5px solid var(--wire);border-radius:3px}
.callout{border-radius:8px;padding:12px 16px;margin:14px 0;border:1px solid}
.callout .code{margin:10px 0 0}
.callout .label{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.callout.tip{background:rgba(0,119,204,.08);border-color:rgba(0,119,204,.4)}.callout.tip .label{color:var(--blue)}
.callout.warn{background:rgba(254,197,20,.08);border-color:rgba(254,197,20,.4)}.callout.warn .label{color:var(--yellow)}
.callout.stop{background:rgba(240,78,152,.09);border-color:rgba(240,78,152,.45)}.callout.stop .label{color:var(--magenta)}
.step{background:var(--surface);border:1px solid var(--wire);border-radius:12px;padding:16px 20px;margin:14px 0}
.step-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.step-head .n{background:var(--teal);color:#06121a;font-weight:700;border-radius:6px;width:26px;height:26px;display:grid;place-items:center;font-size:13px;flex:none}
.step-head .mins{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}
.step .act{margin:0 0 10px}
.step .cap{margin:14px 0 -4px;color:var(--muted);font-size:13.5px}
.step .go+.go{margin-left:8px}
.step .go{display:inline-block;margin:2px 0 10px;padding:8px 14px;border-radius:7px;background:var(--blue);color:#fff;text-decoration:none;font-size:13.5px;font-weight:600}
.step .go:hover{filter:brightness(1.12)}
.proves{color:var(--muted);background:var(--panel);border-left:3px solid var(--blue);padding:11px 16px;border-radius:0 8px 8px 0;margin:0 0 6px}
.proves strong{color:var(--white)}
.code{background:var(--code);border:1px solid var(--wire);border-radius:8px;overflow:hidden;margin:12px 0}
.code .bar{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:rgba(255,255,255,.03);color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.code button{background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 4px;display:flex}
.code button:hover{color:var(--teal)}
.code button.done{color:var(--green)}
.code pre{margin:0;padding:12px 14px;overflow-x:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dbe1f1;white-space:pre-wrap;word-break:break-word}
code{background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px;font:12.5px ui-monospace,Menlo,monospace}
a.kb{color:var(--teal);text-decoration:none;border-bottom:1px dashed rgba(0,191,179,.5)}
a.kb:hover{color:var(--magenta);border-bottom-color:var(--magenta)}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--wire);vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
td code{white-space:nowrap}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600}
.pill.ok{background:rgba(0,212,126,.15);color:var(--green)}
.pill.hold{background:rgba(240,78,152,.15);color:var(--magenta)}
.muted{color:var(--muted)}
@media (max-width:720px){nav.toc{columns:1}h1{font-size:29px}.wrap{padding:0 16px 64px}}
@media print{body{background:#fff;color:#111}.hero{background:#fff;border-bottom-color:#ccc}.talk,.step,.stat,nav.toc{background:#fff;border-color:#ccc}.thesis,.proves{background:#fff;color:#111}.proves strong{color:#111}nav.toc a,.muted,.aud,.stat span,.step .cap,.step-head .mins{color:#444}.step .go{background:#fff;color:#0077CC;border:1px solid #0077CC}a.kb{color:#0077CC}}
</style>`;

/** The one piece of interactivity: copy buttons, with a file:// fallback. */
export const COPY_JS = `<script>
document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('.code .copy');
  if (!btn) return;
  var pre = btn.closest('.code').querySelector('pre');
  var text = pre ? pre.textContent : '';
  var done = function () { btn.classList.add('done'); setTimeout(function () { btn.classList.remove('done'); }, 1400); };
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done); }
  else {
    // Non-secure contexts have no clipboard API; this guide is usually opened from a file:// path.
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* nothing else to try */ }
    document.body.removeChild(ta);
  }
});
</script>`;
