/**
 * A tiny evaluator for the ES|QL boolean/CASE subset the scoring fragments use (RISK, HOUSEKEEPING,
 * SUITE_INSTALL, CHANGE_PRED): CASE, AND, OR, NOT, IS [NOT] NULL, ==, IN (…), LIKE "glob", parentheses,
 * string and number literals, and field names. Three-valued like ES|QL: a comparison with a null side is
 * null, AND/OR/NOT follow SQL's rules, and CASE takes the first condition that is exactly true. Fields are
 * read from a flat object keyed by the dotted name; a missing key is null. Test-only — it lets a unit test
 * ask "what does RISK score for this event?" without a cluster.
 */
function tokenize(src) {
  const out = [];
  const re = /\s*(?:("(?:[^"\\]|\\.)*")|(\d+(?:\.\d+)?)|([A-Za-z_][\w.]*)|(==|!=|[(),]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    if (!(m = re.exec(src))) throw new Error(`cannot tokenize at ${at}: ${src.slice(at, at + 30)}`);
    if (m[1]) out.push({ t: 'str', v: JSON.parse(m[1]) });
    else if (m[2]) out.push({ t: 'num', v: Number(m[2]) });
    else if (m[3]) out.push({ t: 'id', v: m[3] });
    else out.push({ t: 'op', v: m[4] });
  }
  return out;
}

const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);
const glob = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/** Parse once into a closure over a document. */
export function compile(src) {
  const tk = tokenize(src);
  let i = 0;
  const peek = (v) => tk[i] && (tk[i].v === v || (typeof tk[i].v === 'string' && tk[i].t === 'id' && tk[i].v.toUpperCase() === v));
  const eat = (v) => { if (!peek(v)) throw new Error(`expected ${v} at token ${i}: ${JSON.stringify(tk[i])}`); i++; };
  const kw = (v) => (peek(v) ? (i++, true) : false);

  function orE() { let l = andE(); while (kw('OR')) { const a = l, b = andE(); l = (d) => or3(a(d), b(d)); } return l; }
  function andE() { let l = notE(); while (kw('AND')) { const a = l, b = notE(); l = (d) => and3(a(d), b(d)); } return l; }
  function notE() { if (kw('NOT')) { const a = notE(); return (d) => { const v = a(d); return v === null ? null : !v; }; } return pred(); }
  function pred() {
    const l = primary();
    if (kw('IS')) { const neg = kw('NOT'); eat('NULL'); return (d) => ((l(d) === null) !== neg); }
    if (kw('==')) { const r = primary(); return (d) => { const a = l(d), b = r(d); return a === null || b === null ? null : a === b; }; }
    if (kw('IN')) {
      eat('('); const items = [primary()]; while (kw(',')) items.push(primary()); eat(')');
      return (d) => { const a = l(d); if (a === null) return null; const vs = items.map((f) => f(d)); return vs.includes(a) ? true : vs.includes(null) ? null : false; };
    }
    if (kw('LIKE')) { const r = primary(); return (d) => { const a = l(d), g = r(d); return a === null || g === null ? null : glob(g).test(a); }; }
    return l;
  }
  function primary() {
    const t = tk[i];
    if (!t) throw new Error('unexpected end');
    if (t.v === '(') { i++; const e = orE(); eat(')'); return e; }
    if (t.t === 'str' || t.t === 'num') { i++; return () => t.v; }
    if (t.t === 'id' && /^(true|false)$/i.test(t.v)) { i++; const v = /^true$/i.test(t.v); return () => v; }
    if (t.t === 'id' && t.v.toUpperCase() === 'CASE' && tk[i + 1]?.v === '(') {
      i += 2; const args = [orE()]; while (kw(',')) args.push(orE()); eat(')');
      return (d) => {
        for (let k = 0; k + 1 < args.length; k += 2) if (args[k](d) === true) return args[k + 1](d);
        return args.length % 2 ? args[args.length - 1](d) : null;
      };
    }
    if (t.t === 'id') { i++; return (d) => (d[t.v] === undefined ? null : d[t.v]); }
    throw new Error(`unexpected token ${JSON.stringify(t)}`);
  }
  const e = orE();
  if (i !== tk.length) throw new Error(`trailing tokens at ${i}: ${JSON.stringify(tk[i])}`);
  return e;
}

/** `EVAL risk = CASE(…)` → the CASE expression alone. */
export const evalBody = (s) => s.replace(/^EVAL\s+\w+\s*=\s*/, '');
