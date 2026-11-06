/**
 * CUSTOM PANELS (Kibana 9.6, serverless tech preview): `custom_content` dashboard panels, an HTML + inline-CSS
 * template filled by ONE ES|QL query through Liquid. The template lives in custom/<ref>.html and is
 * deployed inside the dashboard (no saved object, unlike Vega).
 *
 * What the 9.6 API and renderer actually do (measured on a private deploy, 2026-11-06; HANDOFF.md):
 *  - Panel: `{ type: 'custom_content', config: { title, description, template, esql_query: [q], time_range? } }`.
 *    `esql_query` takes at most ONE string; unknown config keys are dropped silently, not rejected.
 *  - It survives the _export → _import post-pass (dashboards.mjs applyImportOnlyState) unchanged.
 *  - The query follows the time picker, pills and the ES|QL controls; FORK and `SET unmapped_fields` work.
 *  - The template renders in a sandboxed srcdoc iframe: no scripts, `<use>` is stripped (so no SVG sprite),
 *    links to /app/dashboards and /app/discover get target=_top, any other link loses its href.
 *  - Radio/label steppers, `:checked ~`, `:has()`, `<details>`, @keyframes and SMIL `<animateMotion>` all work.
 *  - Liquid HTML-ESCAPES every `{{ }}` output, so markup cannot be chosen at runtime by printing a string.
 *    Icons are therefore expanded HERE, at build time: `<icon name="db"/>` becomes the SVG, and
 *    `<icon var="ic"/>` becomes a Liquid `case` over every icon with each SVG written out literally.
 *  - Without an esql_query the template is not run through Liquid at all.
 *  - Liquid's `where`, `map`, `sum` and `group_by` do not work on `rows` (each column is a {value, pct} object);
 *    `if`/`case`, `forloop`, `split`, `slice`, `round` and arithmetic do. `.pct` is relative to the column's
 *    maximum over ALL rows, so per-stage shares are computed in the template from a total row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env.mjs';

/** 16×16 stroke icons. Paths only; expandIcons() wraps them. */
export const ICONS = {
  person: '<circle cx="8" cy="5" r="3"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>',
  key: '<circle cx="5" cy="8" r="3"/><path d="M8 8h6.5M12 8v2.5M14 8v2"/>',
  cloud: '<path d="M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1 2.5 2.5 0 0 0 .3 5Z"/>',
  q: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1V10M8 12h0"/>',
  space: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  dash: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6h12M6 6v8"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  lens: '<path d="M2 14V2M2 14h12M5 11V8M8 11V5M11 11V7"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11ZM6.5 14h3"/>',
  tag: '<path d="M2 2h6l6 6-6 6-6-6Z"/><circle cx="5.5" cy="5.5" r="1"/>',
  pkg: '<path d="m8 1.5 6 3v7l-6 3-6-3v-7ZM2 4.5l6 3 6-3M8 7.5v7"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  flow: '<circle cx="3.5" cy="4" r="1.8"/><circle cx="12.5" cy="12" r="1.8"/><path d="M5.3 4H9a2 2 0 0 1 2 2v4.2"/>',
  app: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
  box: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h0M2.5 8h0M2.5 12h0"/>',
  plus: '<circle cx="8" cy="8" r="6"/><path d="M8 5v6M5 8h6"/>',
  pen: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3Z"/>',
  trash: '<path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9"/>',
  play: '<path d="M4.5 2.5v11l9-5.5Z"/>',
  db: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
  chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
};

/** The template size limit Kibana enforces (docs: 500 KB). */
export const TEMPLATE_LIMIT = 500 * 1024;

const svg = (paths, cls) => `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;

/** `<icon name="x" class="…"/>` and `<icon var="v" class="…"/>` → literal SVG markup (see the header). */
export function expandIcons(src) {
  return src.replace(/<icon\s+(name|var)="([\w-]+)"(?:\s+class="([^"]*)")?\s*\/>/g, (m, kind, ref, cls = '') => {
    if (kind === 'name') {
      if (!ICONS[ref]) throw new Error(`custom panel template: unknown icon "${ref}"`);
      return svg(ICONS[ref], cls);
    }
    const whens = Object.entries(ICONS).map(([k, p]) => `{%- when "${k}" -%}${svg(p, cls)}`).join('');
    return `{%- case ${ref} -%}${whens}{%- else -%}${svg(ICONS.box, cls)}{%- endcase -%}`;
  });
}

/** custom/<ref>.html with its icons expanded. Throws on a leftover <icon> tag or an oversized result. */
export function loadTemplate(ref) {
  const out = expandIcons(expandLabels(readFileSync(join(ROOT, 'custom', `${ref}.html`), 'utf8')));
  if (/<icon\b/.test(out)) throw new Error(`custom/${ref}.html: an <icon> tag did not expand (needs name="…" or var="…")`);
  if (/<labels\b/.test(out)) throw new Error(`custom/${ref}.html: a <labels> tag did not expand (needs level="…" key="…")`);
  if (Buffer.byteLength(out) > TEMPLATE_LIMIT) throw new Error(`custom/${ref}.html expands to ${Buffer.byteLength(out)} bytes, over Kibana's ${TEMPLATE_LIMIT}`);
  return out;
}

/**
 * Display words for the drill-down's levels, one table so the panel cannot drift from itself: [label, meaning, icon].
 * Level 1 credential (user.domain, or authentication.type), 3 object type, 4 operation. Spaces (2) show their id.
 */
export const LABELS = {
  1: {
    'cloud-saml-kibana': ['SAML SSO', 'a person in a browser', 'person'],
    _es_api_key: ['Elasticsearch API key', 'a script or integration', 'key'],
    _cloud_api_key: ['Cloud API key', 'Elastic Cloud automation', 'cloud'],
    api_key: ['API key', 'a script or integration', 'key'],
    token: ['Session token', 'a signed-in session', 'person'],
    _service_account: ['Service account', 'an Elastic service', 'gear'],
  },
  2: {
    default: ['default', 'the Default space', 'space'],
    '(space not recorded)': ['Not recorded', 'Kibana logged no space', 'space'],
    '(several spaces)': ['Several', 'opened in more than one', 'space'],
  },
  3: {
    dashboard: ['Dashboards', 'saved dashboards', 'dash'],
    'index-pattern': ['Data views', 'index patterns', 'db'],
    search: ['Discover sessions', 'saved or unsaved', 'search'],
    visualization: ['Visualizations', 'legacy and Vega', 'lens'],
    lens: ['Lens charts', 'saved visualizations', 'lens'],
    alert: ['Rules', 'alerting rules', 'bell'],
    rule: ['Rules', 'alerting rules', 'bell'],
    action: ['Connectors', 'alert connectors', 'flow'],
    tag: ['Tags', 'object tags', 'tag'],
    'epm-packages': ['Fleet integrations', 'installed packages', 'pkg'],
    'epm-packages-assets': ['Integration assets', 'package contents', 'pkg'],
    config: ['Advanced settings', 'space settings', 'gear'],
    'config-global': ['Global settings', 'Kibana-wide settings', 'gear'],
    ingest_manager_settings: ['Fleet settings', 'Fleet configuration', 'gear'],
    space: ['Spaces', 'Kibana spaces', 'space'],
    app: ['Kibana apps', 'no saved object', 'app'],
    workflow: ['Workflows', 'automation', 'flow'],
  },
  4: {
    open: ['Opened', 'one object at a time', 'eye'],
    list: ['Listed', 'in a list or search', 'list'],
    create: ['Created', 'made something new', 'plus'],
    change: ['Changed', 'edited or updated', 'pen'],
    delete: ['Deleted', 'removed it', 'trash'],
    run: ['Ran', 'executed or tested', 'play'],
    read: ['Read data', 'an app, or opened earlier', 'db'],
  },
};
/** Fallbacks when a key is not in the table: the raw key (hyphens as spaces), a generic meaning and icon. */
const LABEL_FALLBACK = { 1: ['other realm', 'q'], 2: ['Kibana space', 'space'], 3: ['saved object type', 'box'], 4: ['other action', 'q'] };

/**
 * `<labels level="L" key="k"/>` → Liquid that assigns `lbl`, `sub` and `ic` for key `k` at level `L` (both Liquid
 * variables), from LABELS. Expanded before the icons, so `ic` can feed an `<icon var="ic"/>`.
 */
export function expandLabels(src) {
  return src.replace(/<labels\s+level="(\w+)"\s+key="(\w+)"\s*\/>/g, (m, lv, key) => {
    const lit = (s) => `"${s.replace(/"/g, '\\"')}"`;
    const set = ([l, s, i]) => `{%- assign lbl = ${lit(l)} -%}{%- assign sub = ${lit(s)} -%}{%- assign ic = ${lit(i)} -%}`;
    const levels = Object.entries(LABELS).map(([n, table]) => {
      const [fsub, fic] = LABEL_FALLBACK[n];
      const whens = Object.entries(table).map(([k, v]) => `{%- when ${lit(k)} -%}${set(v)}`).join('');
      return `{%- when ${n} -%}{%- case ${key} -%}${whens}{%- else -%}{%- assign lbl = ${key} | replace: "-", " " -%}{%- assign sub = ${lit(fsub)} -%}{%- assign ic = ${lit(fic)} -%}{%- endcase -%}`;
    }).join('');
    return `{%- case ${lv} -%}${levels}{%- endcase -%}`;
  });
}
