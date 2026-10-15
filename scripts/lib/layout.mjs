/**
 * Offline structural checks over the generated dashboard definitions.
 *
 * Nothing else in the pipeline can catch what this catches. `PUT /api/dashboards/{id}` accepts
 * overlapping panels without complaint, and `--verify` cannot see it either: a collided panel
 * still renders, just in the wrong place, so the DOM-text gates (broken, noData) stay green. That
 * is the same blind spot that let --verify pass while it was capturing only the top 1400px.
 *
 * This has already bitten once — growing the index heatmap to two rows silently collided with a
 * Discover panel 15 grid units further down, which was not visible in the same screenful of
 * source. It is a pure function over an in-memory object graph, so it costs nothing to run.
 *
 * Checked against the POST-dash() panel list, which is the geometry that actually deploys: dash()
 * prepends the nav bar at y=0 and shifts every authored panel down by NAV_H, so running it here
 * validates dash() too rather than trusting it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cfg } from './env.mjs';
import { CONTROLS } from './controls.mjs';
import {
  NAV_H, NOISE, BAND, BAND_KEYS, RISK, RISK_KEYS, RISK_RESTORE, VERB, ACTOR_RESOLVE, OBJ, OBJ_ID, OBJ_TYPE, CHANGE_PRED, CRED, OBJ_PRESENT,
  CRED_TYPE_LABEL, INDEX_FAMILY, CONCRETE, SYS_INDEX, ACTOR_LABEL, MAGNITUDE_RAMP, SEVERITY_RAMP, fitRows, tableLimit,
  KIBANA_INTERNALS, BOUNDED, BARE_COUNT, grouped, FAILED_OR_DENIED,
} from './panels.mjs';

export const GRID_W = 48;

/**
 * Vega specs and Discover sessions embed ES|QL as literal text — they are static JSON and do not
 * import the fragments — so a change to RISK, NOISE, VERB or OBJ silently desynchronises them from
 * every Lens panel beside them on the same dashboard. The panels still render, they are just
 * computing something different, which is exactly the class of failure --verify cannot see.
 * Asserting the fragment appears verbatim makes that impossible to miss.
 *
 * This is not hypothetical: RISK had drifted in two Vega specs and VERB in a third by the time
 * this check was written.
 */
// ACTOR_LABEL: every static file that DISPLAYS an identity shows an opaque Cloud API key id in the one
// shared form ("_4KEO… · Cloud API key"); Lens tables get it from table().
const FRAGMENT_USES = {
  'vega/01-actor-risk-treemap.json': { NOISE, RISK, RISK_KEYS, RISK_RESTORE, ACTOR_LABEL },
  'vega/03-object-verb-heatmap.json': { VERB, OBJ_ID, OBJ_TYPE },
  'vega/02-auth-matrix.json': { ACTOR_RESOLVE, CRED_TYPE_LABEL, ACTOR_LABEL },
  'vega/04-actor-index-matrix.json': { ACTOR_RESOLVE, CONCRETE, INDEX_FAMILY, ACTOR_LABEL },
  'vega/05-rare-event-scatter.json': { RISK, RISK_KEYS, RISK_RESTORE },
  'vega/06-geo-origin.json': { ACTOR_RESOLVE },
  'vega/07-noise-ratio-stream.json': { BAND_KEYS, BAND },
  // Groups on the real attributes.user.email (never the actor COALESCE), so there is no fragment to pin.
  'vega/10-actor-geography.json': {},
  'vega/11-actor-object-flow.json': { OBJ_PRESENT, CRED, VERB, OBJ_TYPE },
  'searches/01-all-mutations.json': { CHANGE_PRED, ACTOR_RESOLVE, VERB, OBJ, ACTOR_LABEL },
  // FAILED_OR_DENIED: one failed sign-in counts once (no per-realm traces), as on 01's and 04's tiles.
  'searches/02-failed-authentications.json': { ACTOR_RESOLVE, FAILED_OR_DENIED, ACTOR_LABEL },
  'searches/03-security-config-changes.json': { ACTOR_RESOLVE, ACTOR_LABEL },
  'searches/04-kibana-object-changes.json': { ACTOR_RESOLVE, VERB, OBJ, OBJ_PRESENT, KIBANA_INTERNALS, ACTOR_LABEL },
  'searches/05-system-index-access.json': { ACTOR_RESOLVE, SYS_INDEX, ACTOR_LABEL },
  // 06 and 10 previously carried a bare `NOT (... IN ...)` gate. That is null on Kibana events —
  // where the Elasticsearch action field does not exist — and `WHERE null` drops the row, so both
  // sessions were silently returning ZERO Kibana audit, measured live against an hour that held
  // plenty. The fragment is null-guarded; pinning these two to it is what stops that regressing again.
  'searches/06-actor-first-seen.json': { ACTOR_RESOLVE, NOISE, ACTOR_LABEL },
  'searches/08-cross-space-activity.json': { ACTOR_RESOLVE, ACTOR_LABEL },
  'searches/09-session-reconstruction.json': { ACTOR_RESOLVE, ACTOR_LABEL },
  'searches/10-raw-signal-feed.json': { ACTOR_RESOLVE, NOISE, ACTOR_LABEL },
};

function checkGrid(name, panels, problems) {
  const seen = new Map();
  for (const p of panels) {
    const { x, y, w, h } = p.grid || {};
    const id = p.id || p.config?.title || p.type;
    for (const [k, v] of Object.entries({ x, y, w, h })) {
      if (!Number.isInteger(v)) problems.push(`${name}: panel ${id} has non-integer ${k}=${v}`);
    }
    if (x < 0 || y < 0) problems.push(`${name}: panel ${id} at negative origin (${x},${y})`);
    if (w < 1 || h < 1) problems.push(`${name}: panel ${id} has zero/negative size ${w}x${h}`);
    // Reported separately from the occupancy check: an overflow and a two-panel collision both
    // produce over-covered cells, but they need different fixes.
    if (x + w > GRID_W) problems.push(`${name}: panel ${id} overflows the grid — x+w=${x + w} > ${GRID_W}`);
    if (seen.has(id)) problems.push(`${name}: duplicate panel id ${id}`);
    seen.set(id, p);
  }

  // Pairwise, because this is the message that names the two panels that actually collided.
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i].grid, b = panels[j].grid;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        problems.push(`${name}: panels ${panels[i].id} (${a.x},${a.y} ${a.w}x${a.h}) and `
          + `${panels[j].id} (${b.x},${b.y} ${b.w}x${b.h}) overlap`);
      }
    }
  }

  // Exact tessellation. Stronger than "no overlaps", and the only form that catches a HOLE —
  // which matters because Kibana floats panels upward to close gaps, so a hole means the authored
  // y values stop matching what renders and the NEXT reflow is the one that breaks.
  const maxY = Math.max(...panels.map((p) => p.grid.y + p.grid.h));
  const cover = new Uint16Array(maxY * GRID_W);
  for (const p of panels) {
    for (let yy = p.grid.y; yy < p.grid.y + p.grid.h; yy++) {
      for (let xx = p.grid.x; xx < Math.min(p.grid.x + p.grid.w, GRID_W); xx++) cover[yy * GRID_W + xx]++;
    }
  }
  const holes = [];
  for (let yy = 0; yy < maxY; yy++) {
    for (let xx = 0; xx < GRID_W; xx++) if (cover[yy * GRID_W + xx] === 0) { holes.push(`${xx},${yy}`); break; }
  }
  if (holes.length) problems.push(`${name}: grid has gaps — first empty cell per row at [${holes.slice(0, 6).join('] [')}]`);
  return maxY;
}

function checkNav(name, panels, problems) {
  const nav = panels[0];
  if (!nav || nav.type !== 'links') { problems.push(`${name}: first panel is not the nav bar`); return; }
  const { x, y, w, h } = nav.grid;
  if (x !== 0 || y !== 0 || w !== GRID_W || h !== NAV_H) {
    problems.push(`${name}: nav bar is at (${x},${y} ${w}x${h}), expected (0,0 ${GRID_W}x${NAV_H})`);
  }
  for (const p of panels.slice(1)) {
    if (p.grid.y < NAV_H) problems.push(`${name}: panel ${p.id} sits at y=${p.grid.y}, above the nav bar — built without dash()?`);
  }
}

/** A dangling ref_id deploys clean and then renders a broken panel, so resolve it offline. */
function checkRefs(name, panels, problems) {
  for (const p of panels) {
    const ref = p.config?.ref_id;
    if (!ref) continue;
    const [, kind, file] = ref.match(new RegExp(`^${cfg.ns}-(vega|search)-(.+)$`)) || [];
    const dir = kind === 'vega' ? 'vega' : 'searches';
    if (!file || !existsSync(join(ROOT, dir, `${file}.json`))) {
      problems.push(`${name}: panel ${p.id} references ${ref}, but ${dir}/${file}.json does not exist`);
    }
  }
}

function checkFragmentDrift(problems) {
  for (const [file, frags] of Object.entries(FRAGMENT_USES)) {
    const path = join(ROOT, file);
    if (!existsSync(path)) { problems.push(`fragment check: ${file} is missing`); continue; }
    // JSON.parse un-escapes, so the query text can be compared to the exported constant directly.
    const text = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')));
    const queries = [...text.matchAll(/"(?:query|esql)":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`)).join('\n');
    for (const [fragName, frag] of Object.entries(frags)) {
      if (!queries.includes(frag)) {
        problems.push(`fragment drift: ${file} no longer embeds ${fragName} verbatim — `
          + `it hardcodes the ES|QL, so update it to match scripts/lib/panels.mjs`);
      }
    }
  }
}

/**
 * Vega specs whose data comes from the Elasticsearch DSL (`url.index` + `url.body`) rather than ES|QL.
 * They carry no ES|QL text, so FRAGMENT_USES cannot pin them — this list is how they are accounted for
 * instead. Every file in vega/ must appear in one list or the other: a spec registered nowhere is a
 * spec nothing checks, and that is how drift went unnoticed before FRAGMENT_USES existed.
 */
const DSL_SPECS = new Set([
  'vega/08-actor-baseline-band.json',
  'vega/09-activity-punchcard.json',
  'vega/12-actor-cohort.json',
  'vega/13-session-gantt.json',
]);

/**
 * DSL specs that deliberately hold one dataset scoped by the control bar and estate-wide datasets
 * beside it, so a person can be drawn against everyone else. The estate-wide half looks like a
 * forgotten placeholder, which is exactly why its shape is asserted rather than trusted.
 *
 * The cohort must still follow the Project control, and Kibana cannot apply one control's filter to
 * a DSL dataset: it is all three clauses or none. So the scoped dataset reports which projects the
 * selection is active in, the estate dataset is broken down by project, and the spec picks the rows.
 * Both halves must aggregate on the Project control's field — without that, the cohort silently goes
 * back to ranking across every project whatever the control says.
 */
const TWO_DATASET_SPECS = new Set(['vega/12-actor-cohort.json']);
const CONTEXT_CLAUSES = ['%dashboard_context-must_clause%', '%dashboard_context-must_not_clause%', '%dashboard_context-filter_clause%'];

function dataEntries(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => dataEntries(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.url && typeof node.url === 'object' && typeof node.url.index === 'string' && node.url.body) out.push(node);
  for (const v of Object.values(node)) dataEntries(v, out);
  return out;
}

/** Every legend `values` expression in a spec (Vega-Lite `legend.values.expr`, or a Vega legend's `values.signal`). */
function legendValueExprs(node, inLegend = false, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => legendValueExprs(n, inLegend, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (inLegend && node.values && typeof node.values === 'object') {
    const e = node.values.expr ?? node.values.signal;
    if (typeof e === 'string') out.push(e);
  }
  for (const [k, v] of Object.entries(node)) legendValueExprs(v, k === 'legend' || k === 'legends', out);
  return out;
}

function textMarks(node, isVL, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => textMarks(n, isVL, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (isVL && (node.mark === 'text' || node.mark?.type === 'text')) out.push(node);
  if (!isVL && node.type === 'text' && (node.encode || node.from)) out.push(node);
  for (const v of Object.values(node)) textMarks(v, isVL, out);
  return out;
}

/**
 * Every non-linear scale in a spec, Vega (`scales[]`) or Vega-Lite (`encoding.<channel>.scale`), with
 * the channel it drives where Vega-Lite names one.
 */
function scalesOf(node, channel, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => scalesOf(n, channel, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (['log', 'symlog', 'sqrt', 'pow'].includes(node.type) && node.range !== undefined) out.push({ channel, scale: node });
  for (const [k, v] of Object.entries(node)) scalesOf(v, k === 'scale' ? channel : k, out);
  return out;
}

/**
 * MAGNITUDE (README, Vega colour; panels.mjs MAGNITUDE_RAMP). A magnitude scale is a colour ramp over
 * the four suite hues: a one-hue opacity ramp went flat on the dark theme, and any other hex list on a
 * log colour scale is a ramp nobody checked in both themes. Severity keeps SEVERITY_RAMP.
 */
const OPACITY_CHANNELS = new Set(['opacity', 'fillOpacity', 'strokeOpacity']);
function checkMagnitude(file, spec, problems) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const scaleNames = new Map();
  for (const { channel, scale } of scalesOf(spec)) {
    const r = scale.range;
    const numeric = Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number' && v >= 0 && v <= 1);
    if (numeric && (OPACITY_CHANNELS.has(channel) || scale.name)) {
      if (scale.name) scaleNames.set(scale.name, true);
      problems.push(`vega: ${file} encodes magnitude as opacity (${scale.type} scale${scale.name ? ` "${scale.name}"` : ''}, range ${JSON.stringify(r)}) — flat on the dark theme; use a colour scale with range MAGNITUDE_RAMP`);
    }
    const hexes = Array.isArray(r) && r.length > 1 && r.every((v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
    if (hexes && !same(r, MAGNITUDE_RAMP) && !same(r, SEVERITY_RAMP)) {
      problems.push(`vega: ${file} has a ${scale.type} colour ramp ${JSON.stringify(r)} — use MAGNITUDE_RAMP (volume) or SEVERITY_RAMP (risk) from panels.mjs`);
    }
    if (hexes && same(r, MAGNITUDE_RAMP) && (scale.nice || scale.domainMin !== undefined)) {
      problems.push(`vega: ${file} stretches a MAGNITUDE_RAMP domain (nice/domainMin) — fit it to the data so the hues span what is drawn`);
    }
  }
}

/**
 * Rules for Vega specs that nothing downstream can see break. Each was established on a live 9.6
 * serverless dashboard, not read off documentation.
 */
function checkVega(problems) {
  const dir = join(ROOT, 'vega');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const file = `vega/${f}`;
    const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const isVL = String(spec.$schema || '').includes('vega-lite');
    const dsl = dataEntries(spec);

    if (!FRAGMENT_USES[file] && !DSL_SPECS.has(file)) {
      problems.push(`vega: ${file} is in neither FRAGMENT_USES nor DSL_SPECS in scripts/lib/layout.mjs — nothing checks it`);
    }
    if (dsl.length && !DSL_SPECS.has(file)) problems.push(`vega: ${file} has a DSL data source but is not listed in DSL_SPECS`);
    // LEGEND STABILITY (README, Vega colour): a categorical legend lists its scale's whole domain, so the
    // key does not change with the window. One built from the categories present (pluck(data(…))) lost
    // "Infra health" from 00's Signal vs noise at 1h while the help text said the entry stays.
    for (const v of legendValueExprs(spec)) {
      if (/indexof\s*\(\s*pluck\s*\(\s*data\s*\(/.test(v)) problems.push(`vega: ${file} builds a legend's values from the rows present — list the scale's whole domain (gated only on whether there are rows), so the key is the same in every window`);
    }
    if (DSL_SPECS.has(file) && !dsl.length) problems.push(`vega: ${file} is listed in DSL_SPECS but has no url.index + url.body data`);

    // Kibana's DSL parser matches responses back to requests by name, and for UNNAMED requests it
    // compares every candidate against the RESULT's index — so the second unnamed dataset's response
    // overwrites the first and the second gets nothing. The panel renders a bare "Error".
    const names = dsl.map((d) => d.name);
    if (dsl.length > 1 && (names.some((n) => !n) || new Set(names).size !== names.length)) {
      problems.push(`vega: ${file} has ${dsl.length} DSL datasets without unique names — Kibana will cross their responses`);
    }

    let scoped = 0;
    for (const d of dsl) {
      const label = `${file} dataset ${d.name || '(unnamed)'}`;
      // %timefield% re-binds the panel to the time picker, and either key alongside body.query throws.
      if (d.url['%timefield%'] !== undefined || d.url['%context%'] !== undefined) {
        problems.push(`vega: ${label} sets %timefield%/%context% — a fixed-window DSL spec must use the %dashboard_context-*% placeholders instead`);
      }
      const q = JSON.stringify(d.url.body.query || {});
      // No picker applies to these, so a missing range scans all of retention on every load.
      if (!/"@timestamp":\{"gte?"/.test(q)) problems.push(`vega: ${label} has no explicit @timestamp range — it would scan all of retention`);
      if (q.includes('%dashboard_context-must_clause%')) scoped++;
    }
    if (TWO_DATASET_SPECS.has(file)) {
      const body = (d) => JSON.stringify(d.url.body);
      const full = dsl.filter((d) => CONTEXT_CLAUSES.every((c) => body(d).includes(c)));
      const none = dsl.filter((d) => CONTEXT_CLAUSES.every((c) => !body(d).includes(c)));
      if (full.length !== 1 || none.length < 1 || full.length + none.length !== dsl.length) {
        problems.push(`vega: ${file} must hold exactly one DSL dataset scoped by all three control-bar clauses and at least one estate-wide dataset with none of them `
          + `(found ${dsl.length}: ${full.length} fully scoped, ${none.length} unscoped, ${dsl.length - full.length - none.length} partly scoped)`);
      }
      const projectField = `"field":"${CONTROLS[0].field}"`;
      for (const d of dsl) {
        if (!body(d).includes(projectField)) {
          problems.push(`vega: ${file} dataset ${d.name} does not aggregate on ${CONTROLS[0].field} — the cohort would stop following the ${CONTROLS[0].title} control`);
        }
      }
    } else if (dsl.length && scoped !== dsl.length) {
      problems.push(`vega: ${file} has a DSL dataset without %dashboard_context-must_clause% — the control bar would not scope it`);
    }

    checkMagnitude(file, spec, problems);

    // Kibana themes guide/title styles but not mark text: an unstyled text mark renders #000, which is
    // invisible on the dark theme. Full Vega: give it style "guide-label"/"guide-title" (theme-aware) or
    // an explicit fill. Vega-Lite: `style` does not reach text marks at all, so put words in a title,
    // subtitle, axis or tooltip — title.text accepts an expression — or set an explicit colour.
    for (const m of textMarks(spec, isVL)) {
      if (isVL) {
        const md = typeof m.mark === 'object' ? m.mark : {};
        if (md.color === undefined && md.fill === undefined && !m.encoding?.color && !m.encoding?.fill) {
          problems.push(`vega: ${file} has a Vega-Lite text mark with no colour — it renders black on the dark theme; use a title expression or set a colour`);
        }
      } else {
        const styled = [].concat(m.style || []).some((st) => /^(guide|group)-/.test(st));
        const filled = ['enter', 'update'].some((k) => m.encode?.[k]?.fill !== undefined);
        if (!styled && !filled) {
          problems.push(`vega: ${file} has a text mark with no style or fill — it renders #000; add style: "guide-label"`);
        }
      }
    }
  }
}

/**
 * md() lifts a leading `#`-`###` heading into the panel title (see panels.mjs MARKDOWN SIZE), so one
 * that survives into the content is a heading in the middle of a note, rendering at ~20px over 14px
 * panel titles. `####` and below are fine: they render as bold body text. The one exception is an intro
 * panel (introMd(), `headed`): its heading IS its title, so it carries exactly one, before its body, and
 * no panel title over it.
 */
function checkMarkdown(name, panels, problems) {
  for (const p of panels) {
    if (p.type !== 'markdown') continue;
    const lines = (p.config?.content || '').split('\n').filter((l) => /^#{1,3}\s/.test(l));
    const allowed = p.headed && !p.config?.title && lines.length === 1 && p.config.content.startsWith(lines[0]) ? 1 : 0;
    for (const line of lines.slice(allowed)) problems.push(`${name}: markdown panel ${p.id} has an oversized heading "${line.slice(0, 40)}" — use the panel title, or ####`);
  }
}

/**
 * A session that RENAMEs a column for display must list it by the NEW name: listed by the old one,
 * Discover renders an empty column under the raw header, which is exactly what the rename was for.
 */
function checkSessions(problems) {
  const dir = join(ROOT, 'searches');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const renamed = [...String(d.esql || '').matchAll(/\|\s*RENAME\s+([^|]+)/gi)]
      .flatMap((m) => m[1].split(',').map((pair) => pair.trim().split(/\s+AS\s+/i)[0]?.replace(/`/g, '')));
    const used = [...(d.columns || []), ...(d.sort || []).map(([c]) => c), ...Object.keys(d.grid?.columns || {})];
    for (const c of used.filter((u) => renamed.includes(u))) {
      problems.push(`searches/${f}: "${c}" is RENAMEd in the query but still listed by its old name in columns/sort/grid`);
    }
  }
}

/**
 * A title must not promise more rows than the panel shows. table() clamps a trailing LIMIT to the rows
 * that fit (panels.mjs, COMPLETENESS), so "Every address they used" over a LIMITed table is false as
 * soon as the data outgrows the panel — and Lens gives no cue that rows were cut. Retitle it ("Busiest
 * addresses", "Top 10 …"), or pass { scroll: true } when the LIMIT is itself the promise. The words are
 * matched whole, so "allowed" and "overall" do not trip it.
 */
export const PROMISES_ALL = /\b(every|everything|all)\b/i;
function checkCompleteness(name, panels, problems) {
  for (const p of panels) {
    if (p.config?.type !== 'data_table' || !p.lint?.limit || p.lint.scroll) continue;
    const t = p.config.title || '';
    if (PROMISES_ALL.test(t)) {
      problems.push(`${name}: table ${p.id} "${t}" promises every row but is LIMITed to ${p.lint.limit} — retitle it (top/busiest/most recent), or pass { scroll: true } if the LIMIT is the promise`);
    }
  }
}

/**
 * ROWS (panels.mjs, ROWS THAT FIT and CUT). A Lens table shows no cue that rows continue, so:
 *   - a LIMIT above fitRows(h) needs { scroll: true } (and table() then says "scroll" in the
 *     description, never the title: a title is shown at every window, including those with nothing to
 *     scroll);
 *   - a LIMITed table states its cut as an UPPER BOUND ("· top 10 at most", "up to 100"), because a list
 *     cut at N beside a tile counting more reads as complete otherwise — and a bare "top 10" over the 3
 *     rows a short window holds is false.
 * Checked on the final query, so a LIMIT that is not the trailing step (which table() cannot clamp) is
 * caught too.
 */
function checkRows(name, panels, problems) {
  for (const p of panels) {
    if (p.config?.type !== 'data_table') continue;
    const q = p.config.data_source?.query || '';
    const n = tableLimit(q);
    const t = p.config.title || '';
    if (!n) continue;
    const fit = fitRows(p.grid.h);
    if (n > fit && !p.lint?.scroll) {
      problems.push(`${name}: table ${p.id} "${t}" is LIMIT ${n} but h=${p.grid.h} shows ${fit} rows — rows would be hidden with no cue; lower the LIMIT, grow the panel, or pass { scroll: true }`);
    }
    if (n < fit && !p.lint?.scroll) {
      problems.push(`${name}: table ${p.id} "${t}" is LIMIT ${n} but h=${p.grid.h} has room for ${fit} rows — the LIMIT must equal the rows that fit (end the query with the LIMIT so table() sets it, or shorten the panel)`);
    }
    if ((p.lint?.wrap || n > fit) && !/\bscroll\b/i.test(p.config.description || '')) {
      problems.push(`${name}: table ${p.id} "${t}" holds more rows than it shows but its description does not say "scroll"`);
    }
    if (p.lint?.cut !== false && !BOUNDED(n).test(t)) {
      problems.push(`${name}: table ${p.id} "${t}" is cut at ${n} rows but its title does not say so as a bound — build it with table(), which appends "· top ${n} at most"`);
    }
  }
}

/**
 * CLICK FILTERS. A click-to-filter column must reach the table as the raw field: grouped on it, or kept
 * as it is. Kibana builds no filter from a column the query creates (an EVAL, a STATS aggregate or a
 * RENAME that assigns the name), even when the name is a real field: Lens still draws the cell as a link,
 * but a click yields no filter, so neither "Apply filter" nor any drilldown appears. 07's "System and
 * hidden index reads" shipped that way through 1.0.2 (clicked in Playwright, 1.0.3).
 */
export function checkClickFilters(name, panels, problems) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const p of panels) {
    const q = p.config?.data_source?.query || '';
    for (const r of p.config?.rows || []) {
      if (!r?.click_filter) continue;
      const assigned = new RegExp(`(\\||,|\\bEVAL)\\s*\`?${esc(r.column)}\`?\\s*=(?!=)|\\bAS\\s+\`?${esc(r.column)}\`?(\\s|,|$)`).test(q);
      if (assigned) problems.push(`${name}: panel ${p.id} "${p.config.title}" assigns its click-to-filter column ${r.column} in the query — Kibana builds no filter from a column created at query time, so a click does nothing; group on the raw field instead`);
    }
  }
}

/**
 * TITLES (panels.mjs, CUT). Every panel title is shown at every time range and every row count, so it
 * may state only what is true at all of them. Three forms were false at some window in the round-5
 * review, and are rejected on every panel type (tables, charts, Vega, Discover sessions):
 *   - a bare count after an order word ("top 10", "latest 9", "newest 1,000", "the 30 most recent"),
 *     over the 1 to 3 rows a short window holds: write the bound ("10 at most", "up to 10");
 *   - an instruction, "scroll", over a table with nothing to scroll: say it in the description;
 *   - a window caveat, "(may be empty at 1h)", over 774 rows at 24h: { empty: 'quiet' } now reads
 *     "(empty when none in range)".
 */
function checkTitles(name, panels, problems) {
  for (const p of panels) {
    const t = p.config?.title || '';
    const bare = BARE_COUNT.exec(t);
    if (bare) problems.push(`${name}: panel ${p.id} "${t}" states a count ("${bare[0]}") that is false whenever the window holds fewer — word it as a bound ("${bare[2]} at most", "up to ${bare[2]}")`);
    if (/\bscroll\b/i.test(t)) problems.push(`${name}: panel ${p.id} "${t}" carries an instruction ("scroll") that is false when every row fits — put it in the description`);
    if (/\(may be empty\b|\bat 1h\b/i.test(t)) problems.push(`${name}: panel ${p.id} "${t}" carries a caveat for one time window — use { empty: 'quiet' } ("(empty when none in range)")`);
  }
}

/**
 * EMPTY wording (panels.mjs, EMPTY STATES). A title shows whether or not the panel has rows, so an
 * empty-state clause must be a parenthetical condition — "(empty = good)", "(empty when …)" — never the
 * round-3 status form "· none is good" / "· empty without …", which read as a verdict on a full table.
 */
const EMPTY_STATUS = /·\s*(none is good|often empty|empty\b)/i;
function checkEmptyWording(name, panels, problems) {
  for (const p of panels) {
    const t = p.config?.title || '';
    if (EMPTY_STATUS.test(t)) {
      problems.push(`${name}: panel ${p.id} "${t}" states an empty state as a status — use { empty } (EMPTY), which words it as a condition`);
    }
  }
}

/**
 * DIGITS (panels.mjs, grouped()). A KPI's secondary line is text, so a count in it prints as ES|QL's
 * TO_STRING writes it — "2326" under tiles that Lens prints as "1,728,070". Every count there goes
 * through grouped() (a value that cannot reach 1,000 too: the rule is cheaper to keep than the
 * exceptions). Fails --lint: returns the tiles whose secondary line stringifies a column without grouping it.
 */
export function ungroupedSecondaries(panels) {
  const out = [];
  for (const p of panels) {
    if (p.config?.type !== 'metric' || !p.config.metrics?.some((m) => m.type === 'secondary')) continue;
    const q = p.config.data_source?.query || '';
    const tail = q.slice(q.lastIndexOf('| STATS'));
    const bare = [...tail.matchAll(/TO_STRING\((\w+)\)/g)].map((m) => m[1]).filter((c) => !tail.includes(grouped(c)));
    if (bare.length) out.push({ id: p.id, cols: [...new Set(bare)] });
  }
  return out;
}

/** Returns an array of human-readable problems; empty means clean. */
export function checkLayout(all) {
  const problems = [];
  let panelCount = 0;
  const rows = [];
  for (const [name, def] of Object.entries(all)) {
    const panels = def.panels;
    panelCount += panels.length;
    checkNav(name, panels, problems);
    const maxY = checkGrid(name, panels, problems);
    checkRefs(name, panels, problems);
    checkMarkdown(name, panels, problems);
    checkCompleteness(name, panels, problems);
    checkRows(name, panels, problems);
    checkClickFilters(name, panels, problems);
    checkTitles(name, panels, problems);
    checkEmptyWording(name, panels, problems);
    rows.push(`${name}: panels=${panels.length} rows=${maxY}`);
    // Advisory, not a failure: a table whose columns cannot fit a 1440px viewport needs a layout
    // decision (a wider panel or fewer columns), which no width arithmetic can make. See fitWidths().
    for (const u of ungroupedSecondaries(panels)) problems.push(`${name}: KPI ${u.id} prints ${u.cols.join(', ')} in its secondary line without grouped() digits (panels.mjs) — "2326" beside tiles Lens prints as "1,728,070"`);
    for (const p of panels.filter((q) => q.narrow1440)) rows.push(`${name}: advisory — "${p.config.title}" (w=${p.grid.w}) clips its text columns at a 1440px viewport`);
  }
  checkFragmentDrift(problems);
  checkVega(problems);
  checkSessions(problems);
  return { problems, panelCount, dashboards: Object.keys(all).length, rows };
}
