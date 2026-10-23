/**
 * Renders every dashboard in a real browser and inspects the result.
 *
 * Serverless rejects the Reporting API export types (pngV2 / printablePdfV2), so this
 * drives Chromium directly via Playwright. Two things learned the hard way:
 *   - the ApiKey header must be scoped to the Kibana origin. Sent to kibana.estccdn.com
 *     the CDN rejects lazily-loaded bundles, which breaks exactly the code-split panels
 *     (Vega) and looks like a dashboard bug.
 *   - detection must read rendered TEXT. A selector-based check silently missed
 *     "Visualization type not found." and reported zero broken panels.
 * Screenshots land in a fresh timestamped directory; nothing is ever deleted.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { cfg, ROOT } from './lib/env.mjs';
import { dashId } from './lib/suite.mjs';
import { success, fail, detail, info, warn } from './lib/log.mjs';
import { buildAll } from './lib/definitions.mjs';
import { CONTROLS } from './lib/controls.mjs';
import { TIME_TO, DEFAULT_FROM } from './lib/panels.mjs';

/**
 * Kibana emits exactly six console errors on every FULL page load of any dashboard.
 * Measured identically on 00-command-center (two Vega panels) and 06-platform-volume (one), so
 * none of them belong to this suite and Vega has nothing to do with it: a CSP refusal for the
 * inline script Kibana injects into its own HTML, plus five HTTP failures on endpoints an ApiKey
 * principal is not entitled to call.
 *
 * This also explains the long-standing "Command Center 6, everything else 1" oddity, which was
 * never a Command Center defect: the verifier used to reuse ONE page, so navigating to a URL
 * differing only in the `#/view/<id>` fragment was a same-document navigation. Kibana bootstrapped
 * once, on whichever dashboard came first, and the rest only re-emitted the recurring favorites
 * 403. A fresh page per dashboard makes all of them report the same six.
 *
 * Classify by URL rather than text: a benign favorites 403 and a real content-management failure
 * print the same message. Anything NOT matched here is counted as unexpected and fails the run.
 */
const NOISE_TEXT = [/^Refused to execute inline script because it violates/];
const NOISE_URL = /\/internal\/api\/intercepts\/|\/internal\/cps\/project_routing\/|\/internal\/content_management\/favorites\//;
/**
 * The verifier signs in with an API key, and an API key has no user profile, so Kibana's profile
 * lookup answers 404 on every page. Only that exact pair is noise: any other status there (a 401 or
 * 500) still fails the run.
 */
const API_KEY_PROFILE_404 = (e) => /\/internal\/security\/user_profile(\?|$)/.test(e.url || '') && /status of 404/.test(e.text);
const isPlatformNoise = (e) => NOISE_TEXT.some((re) => re.test(e.text)) || NOISE_URL.test(e.url) || API_KEY_PROFILE_404(e);

function loadPlaywright() {
  for (const base of [ROOT, process.env.HOME]) {
    try { return createRequire(join(base, 'noop.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('playwright not found — run: npm install playwright && npx playwright install chromium');
}

/**
 * Collapsible sections (panels.mjs, SECTIONS) render as a header row whose title is a button; a collapsed one
 * carries the --collapsed class and aria-expanded=false (Kibana 9.6 kbn-grid-layout, read off the DOM).
 */
const SECTION_COLLAPSED = '[data-test-subj^="kbnGridSectionHeader-"].kbnGridSectionHeader--collapsed';
const SECTION_TITLE_CLOSED = 'button[data-test-subj^="kbnGridSectionTitle-"][aria-expanded="false"]';

/**
 * Kibana scrolls an INNER container, so document.body.scrollHeight is only the viewport height (measured:
 * 1400 while the real content was 2329) and fullPage:true silently captured a single screen — everything
 * below the fold went unlooked-at at first. The scroller is the chrome layout element;
 * [data-test-subj=dashboardViewport] does not exist in 9.6. euiDataGrid__virtualized is deliberately NOT
 * considered: a virtualised table reports a scrollHeight of ~50,000px and would blow the capture up.
 * Panels mount lazily, so walk the whole height, re-measure (panels mounted during the walk make the page
 * taller than the first reading, and a viewport fixed to the stale value clips the bottom silently), then
 * grow the viewport to the content so the capture is genuinely full-page.
 */
async function walkAndGrow(page, sel, width) {
  const height = () => page.evaluate((s) => {
    const el = document.querySelector(s);
    return Math.max(el?.scrollHeight || 0, document.body.scrollHeight);
  }, sel);
  const scrollTo = (v) => page.evaluate(([s, y]) => {
    const el = document.querySelector(s);
    (el && el.scrollHeight > el.clientHeight ? el : window).scrollTo(0, y);
  }, [sel, v]);
  const h = await height();
  for (let y = 0; y < h; y += 900) { await scrollTo(y); await page.waitForTimeout(700); }
  await scrollTo(0);
  const measured = Math.max(h, await height());
  const shot = Math.min(Math.max(measured + 120, 1400), 12000);
  await page.setViewportSize({ width, height: shot });
  await page.waitForTimeout(18000);
  return { shot, measured };
}

/** What the page text and DOM say about the panels mounted right now. */
const pageStats = (page) => page.evaluate(() => {
  const txt = document.body.innerText;
  const hits = (re) => (txt.match(re) || []).length;
  // Small-text panels (intros and How to read, the legacy markdown visualization): a body taller than its
  // panel is cut off or scrolls, which no layout check can see. Spare is the least room left under any text.
  const mkd = [...document.querySelectorAll('.markdownVis')].filter((e) => e.clientHeight > 0)
    .map((e) => ({ e, spare: Math.floor(e.clientHeight - (e.firstElementChild?.getBoundingClientRect().height || 0)) }));
  return {
    panels: document.querySelectorAll('[data-test-subj^="embeddablePanel"]').length,
    brokenPanels: hits(/Visualization type not found|Could not locate|Error loading|Unable to load|Failed to load|An error occurred|error in visualization|Index "[^"]*" not found/gi),
    /**
     * Vega reports its own failures inside the panel, and the text patterns above cannot see
     * most of them: a spec whose data failed to resolve shows a bare "Error", and matching
     * that word in page text would fire on any panel that merely mentions errors. Kibana
     * renders every Vega error as li.vgaVis__message--err (verified against a deliberately
     * broken spec and a kibanaAddFilter with a wrong data view), so count those as well —
     * in addition to the text, never instead of it.
     */
    vegaErrors: [...document.querySelectorAll('.vgaVis__message--err')].map((e) => e.innerText.trim().slice(0, 160)),
    vegaWarnings: document.querySelectorAll('.vgaVis__message--warn').length,
    stillLoading: document.querySelectorAll('[data-test-subj="embeddablePanelLoadingIndicator"], .euiProgress').length,
    noData: hits(/No results found|No data to display|no results match/gi),
    rawStyleLeak: txt.includes('a:hover') || txt.includes('<style>') || txt.includes('&lt;style&gt;'),
    // The control bar is import-only state that every --dashboards run wipes and
    // re-applies, so assert it rather than trusting the deploy log.
    controls: document.querySelectorAll('[data-test-subj^="optionsList-control-"]').length,
    textOverflow: mkd.filter((m) => m.spare < 0).map((m) => `${m.e.innerText.trim().slice(0, 50)}… (${-m.spare}px over)`),
    textSparePx: mkd.length ? Math.min(...mkd.map((m) => m.spare)) : 0,
  };
});

export async function run(argv = []) {
  const { chromium } = loadPlaywright();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const theme = process.env.AUDIT_VERIFY_THEME === 'light' ? 'light' : 'dark';
  /**
   * The window and the viewport are overridable because each hides a different class of defect. The
   * default is the dashboards' own saved range (DEFAULT_FROM, now-24h since 1.0.5), so a render is what a
   * viewer opens; AUDIT_VERIFY_RANGE=now-1h shows the sparse, often-empty view an hour gives, and wider
   * ranges show the previous-period tiles reading "no full prior …". And Lens column widths are absolute
   * pixels, so truncation that a 1920px pass never sees appears at AUDIT_VERIFY_WIDTH=1440.
   * The range ends where every dashboard's saved range ends (TIME_TO, now-1m), so a render shows what a
   * viewer opening the dashboard sees, and two panels side by side reconcile the way they do for them.
   */
  const range = process.env.AUDIT_VERIFY_RANGE || DEFAULT_FROM;
  if (!/^now-\d+[smhdwMy]$/.test(range)) throw new Error(`AUDIT_VERIFY_RANGE "${range}" is not a relative range like now-24h`);
  const width = Number(process.env.AUDIT_VERIFY_WIDTH || 1920);
  if (!Number.isInteger(width) || width < 800 || width > 3840) throw new Error(`AUDIT_VERIFY_WIDTH "${process.env.AUDIT_VERIFY_WIDTH}" is not a pixel width between 800 and 3840`);
  const out = argv[0] || join(ROOT, 'build', `render-${stamp}-${theme}`);
  mkdirSync(out, { recursive: true });
  info(`rendering to ${out}`);

  // AUDIT_VERIFY_ONLY=00,07-actor renders only the dashboards whose name contains one of the substrings,
  // so a fix to one page is re-rendered in a minute rather than eight.
  const only = (process.env.AUDIT_VERIFY_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  const all = buildAll();
  const ids = Object.keys(all).filter((n) => !only.length || only.some((o) => n.includes(o)))
    .map(dashId);
  const defs = Object.fromEntries(Object.entries(all).map(([n, d]) => [dashId(n), d.panels.filter((p) => p.section)]));
  if (!ids.length) throw new Error(`AUDIT_VERIFY_ONLY "${process.env.AUDIT_VERIFY_ONLY}" matches no dashboard`);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width, height: 1400 }, colorScheme: theme });
  info(`colour scheme: ${theme} · window: ${range} → ${TIME_TO} · viewport: ${width}px`);

  const origin = new URL(cfg.kibana).origin;
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) {
      await route.continue({ headers: { ...route.request().headers(), authorization: `ApiKey ${cfg.apiKey}` } });
    } else await route.continue();
  });

  const report = [];
  let bad = 0;
  for (const id of ids) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = m.location() || {};
      errs.push({ text: m.text().slice(0, 300), url: loc.url || '' });
    });
    page.on('pageerror', (e) => errs.push({ text: `uncaught: ${String(e).slice(0, 300)}`, url: '' }));
    try {
      await page.goto(`${cfg.kbs}/app/dashboards#/view/${id}?_g=(time:(from:${range},to:${TIME_TO}))`,
        { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(20000);
      // The inner scroller, walked and grown to the content (walkAndGrow).
      const SCROLLER = '[data-test-subj="kbnChromeLayoutApplication"]';
      const { shot, measured } = await walkAndGrow(page, SCROLLER, width);
      const stats = await pageStats(page);
      // SECTIONS (panels.mjs): every page carries a collapsed "How to read this page" section. Count them
      // before touching anything: a deploy that lost the saved object's `sections`, or left one open, shows
      // here as a header count that does not match the definition.
      const expectedSections = (defs[id] || []).length;
      stats.sectionsCollapsed = await page.locator(SECTION_COLLAPSED).count();
      const file = join(out, `${id}.png`);
      await page.screenshot({ path: file, fullPage: true });
      // Then open every section and look again, so the panels inside are rendered, checked for broken
      // text and overflow, and captured (<id>.open.png). The collapsed capture above is what a viewer sees first.
      let fileOpen = null;
      if (stats.sectionsCollapsed) {
        for (const btn of await page.locator(SECTION_TITLE_CLOSED).all()) await btn.click();
        await page.waitForTimeout(6000);
        await page.setViewportSize({ width, height: 1400 });
        const grown = await walkAndGrow(page, SCROLLER, width);
        const open = await pageStats(page);
        stats.sectionsOpened = stats.sectionsCollapsed - await page.locator(SECTION_COLLAPSED).count();
        for (const k of ['brokenPanels', 'noData']) stats[k] = Math.max(stats[k], open[k]);
        stats.vegaErrors = [...new Set([...stats.vegaErrors, ...open.vegaErrors])];
        stats.rawStyleLeak ||= open.rawStyleLeak;
        stats.textOverflow = [...new Set([...stats.textOverflow, ...open.textOverflow])];
        stats.textSparePx = Math.min(stats.textSparePx, open.textSparePx);
        stats.panelsOpen = open.panels;
        fileOpen = join(out, `${id}.open.png`);
        await page.screenshot({ path: fileOpen, fullPage: true });
        stats.openPx = grown.shot;
      }
      // Keep the text, not just a count: an unexplained number nobody can act on is how the
      // "6 vs 1" oddity sat unexamined for a while.
      const unexpected = errs.filter((e) => !isPlatformNoise(e));
      report.push({ id, ...stats, consoleErrors: errs.length, unexpectedErrors: unexpected, file, fileOpen });
      const truncated = shot >= 12000 || measured <= 1400;
      const line = `${id}  panels=${stats.panels} broken=${stats.brokenPanels} vegaErrors=${stats.vegaErrors.length}`
        + ` vegaWarnings=${stats.vegaWarnings} loading=${stats.stillLoading}`
        + ` noData=${stats.noData} styleLeak=${stats.rawStyleLeak}`
        + ` controls=${stats.controls}/${CONTROLS.length} sections=${stats.sectionsCollapsed}/${expectedSections}`
        + `${stats.sectionsCollapsed ? ` opened=${stats.sectionsOpened}` : ''} textSpare=${stats.textSparePx}px px=${shot}`
        + `${stats.textOverflow.length ? ` TEXT-OVERFLOW=${stats.textOverflow.length}` : ''}`
        + `${unexpected.length ? ` UNEXPECTED-ERRORS=${unexpected.length}` : ''}${truncated ? ' TRUNCATED' : ''}`;
      report[report.length - 1].capturedPx = shot;
      report[report.length - 1].measuredPx = measured;
      report[report.length - 1].truncated = truncated;
      report[report.length - 1].theme = theme;
      report[report.length - 1].range = range;
      report[report.length - 1].width = width;
      // A capture that never grew past the viewport means the scroller selector stopped
      // matching — that is exactly how this script was silently blind before, so fail loud.
      if (stats.brokenPanels || stats.vegaErrors.length || stats.rawStyleLeak || stats.controls !== CONTROLS.length
          || truncated || unexpected.length || stats.textOverflow.length
          || stats.sectionsCollapsed !== expectedSections || (stats.sectionsCollapsed && stats.sectionsOpened !== stats.sectionsCollapsed)) {
        bad++; fail(line);
        for (const e of stats.vegaErrors.slice(0, 5)) detail(`    vega: ${e}`);
        for (const e of unexpected.slice(0, 5)) detail(`    ${e.text}${e.url ? ` <- ${e.url}` : ''}`);
        for (const e of stats.textOverflow.slice(0, 5)) detail(`    text overflows its panel: ${e}`);
      } else detail(line);
    } catch (e) {
      bad++; fail(`${id} ${String(e).slice(0, 160)}`);
      report.push({ id, error: String(e).slice(0, 200) });
    } finally {
      // Cleanup must not mask the real error or abort the loop before report.json is written.
      try { await page.close(); } catch { /* page already gone */ }
    }
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  if (bad) throw new Error(`${bad} dashboard(s) rendered with problems — inspect the PNGs in ${out}`);
  warn('Screenshots written — open them and look before calling this done.');
  success(`all ${ids.length} dashboards rendered clean -> ${out}`);
}
