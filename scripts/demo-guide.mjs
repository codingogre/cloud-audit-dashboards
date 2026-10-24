/**
 * Generates the presenter guide for the audit suite.
 *
 * Every number in the finished HTML is read from the live audit stream at generation time
 * through the same ES|QL fragments the dashboards use. Nothing is retyped, so the guide and
 * the dashboards cannot drift — which matters, because an audit stream's composition changes
 * over time.
 *
 * Output goes to build/demo-guide/ (gitignored). A committed copy would be a snapshot of one
 * day's cluster, presented as if it were current.
 *
 *   ./audit --demo-guide            real identities
 *   ./audit --demo-guide --redact   identities masked, for a copy that will be passed on
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from './lib/env.mjs';
import { deployed, isDeployed, dashId } from './lib/suite.mjs';
import { es } from './lib/http.mjs';
import { success, info, detail, warn } from './lib/log.mjs';
import { IDX, NOISE, BAND, BAND_KEYS, ACTOR, ACTOR_RESOLVE, CHANGE, TIME_TO, nullSafe } from './lib/panels.mjs';
import { riskScored, ACTOR_KEYS } from './lib/dashboards/shared.mjs';
import {
  CSS, COPY_JS, esc, rich, fmt, codeblock, talk, check, callout, a, rows, useCase,
  stepper, minutesIn, stepsIn,
} from './lib/html.mjs';

/**
 * The window the guide is driven at.
 *
 * 1h is the readable view of "right now", the unfiltered identity-grouping panels are fastest there,
 * and the forensic panels still carry content. This used to be justified as a hard limit — "24h
 * exceeds 110s" — but those readings were taken back to back, and a synchronous query outlives
 * the client that gave up on it, so they were not independent. See HANDOFF.md.
 */
const WINDOW = process.env.AUDIT_DEMO_WINDOW || 'now-1h';
const WINDOW_LABEL = WINDOW === 'now-1h' ? 'Last 1 hour' : `Last ${WINDOW.replace('now-', '')}`;
const HOURS = Number((WINDOW.match(/now-(\d+)h/) || [, 1])[1]);

// The dashboards this run deploys (lib/suite.mjs): Platform Volume only when opted in, so the guide
// never sends a presenter to a dashboard that is not there.
const DASHBOARDS = deployed();
const PV = isDeployed('06-platform-volume');

const link = (name) => `${cfg.kbs}/app/dashboards#/view/${dashId(name)}?_g=(time:(from:${WINDOW},to:${TIME_TO}))`;

/** Discover, with an ES|QL query already applied — the "show me this identity's hour" path. */
const discover = (query) =>
  `${cfg.kbs}/app/discover#/?_g=(time:(from:${WINDOW},to:${TIME_TO}))&_a=(dataSource:(type:esql),query:(esql:'${
    nullSafe(query).replace(/'/g, "''")}'))`;

const W = `WHERE @timestamp <= NOW() AND @timestamp > NOW() - ${HOURS} hours`;

/**
 * Evidence window, separate from the live window on purpose.
 *
 * The guide is DRIVEN at one hour because that is the readable view of right now. The selective
 * evidence queries (named API keys, denials, config changes) describe long-lived properties of a
 * project, which an hour of data understates, so they run over EVIDENCE_HOURS instead. Being
 * selective, they run fine over a day; it is only the unfiltered STATS BY a resolved actor that
 * gets expensive over wide windows. Anything sourced from here is narrated as "in the last 24 hours".
 */
const EVIDENCE_HOURS = Number(process.env.AUDIT_DEMO_EVIDENCE_HOURS || 24);
const EV = `WHERE @timestamp <= NOW() AND @timestamp > NOW() - ${EVIDENCE_HOURS} hours`;

/** Big numbers in the hero tiles: a long raw count overflows a 150px tile and renders clipped. */
const compact = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '\u2014';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return v.toLocaleString('en-US');
};

/** Run a query, return rows; never let one slow panel kill the whole build. */
async function q(label, query) {
  const t = Date.now();
  try {
    const r = await es.esql(nullSafe(query));
    detail(`${label} — ${((Date.now() - t) / 1000).toFixed(1)}s, ${r.values?.length ?? 0} row(s)`);
    return r.values || [];
  } catch (err) {
    warn(`${label} failed: ${err.message.slice(0, 120)}`);
    return [];
  }
}
const one = (vals, i = 0) => (vals.length ? vals[0][i] : null);

/**
 * Masked identities keep the domain (it is the useful half) and lose the local part.
 *
 * Not asterisks: rich() resolves `**bold**`, so a run of them inside a masked address was being
 * parsed as markdown and the cell rendered mangled. An ellipsis has no meaning in that idiom.
 */
const mask = (email, redact) => {
  if (!redact || !email || !String(email).includes('@')) return email;
  const [u, d] = String(email).split('@');
  return `${u.slice(0, 2)}\u2026@${d}`;
};

export async function run(argv = []) {
  const redact = argv.includes('--redact');
  const out = join(ROOT, 'build', 'demo-guide');
  mkdirSync(out, { recursive: true });
  info(`reading live numbers over ${WINDOW} (redact=${redact})`);

  // ── The numbers ────────────────────────────────────────────────────────────────────
  const [span, totals, bandRows, sigBySvc, topIds, humans, denialRows, denialPaths,
         cfgChanges, mutations, geoCov, riskTop] = await Promise.all([
    q('stream span', `FROM ${IDX} | STATS oldest = MIN(@timestamp), newest = MAX(@timestamp), docs = COUNT(*)`),
    q('window total', `FROM ${IDX} | ${W} | STATS total = COUNT(*)`),
    q('band mix', `FROM ${IDX} | ${W} | STATS n = COUNT(*) BY ${BAND_KEYS} | ${BAND} | STATS events = SUM(n) BY band | SORT events DESC`),
    q('signal by service', `FROM ${IDX} | ${W} | ${NOISE} | STATS events = COUNT(*) BY svc = service.name | SORT events DESC`),
    q('top identities (24h)', `FROM ${IDX} | ${EV} | WHERE api_key.name IS NOT NULL | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY key = api_key.name, owner = user.email | SORT events DESC | LIMIT 8`),
    q('human interaction', `FROM ${IDX} | ${W} | WHERE service.name == "serverless-kibana" AND user.email IS NOT NULL | STATS events = COUNT(*), people = COUNT_DISTINCT(user.email)`),
    q('denials by country (24h)', `FROM ${IDX} | ${EV} | WHERE event.action == "anonymous_access_denied" | STATS n = COUNT(*) BY country = client.geo.country_iso_code | SORT n DESC | LIMIT 6`),
    q('denial paths (24h)', `FROM ${IDX} | ${EV} | WHERE event.action == "anonymous_access_denied" | STATS n = COUNT(*) BY path = url.path::keyword | SORT n DESC | LIMIT 8`),
    q('config changes (24h)', `FROM ${IDX} | ${EV} | WHERE elasticsearch.audit.security_config_change IS NOT NULL | ${ACTOR} | STATS n = COUNT(*) BY actor, action = event.action | SORT n DESC | LIMIT 6`),
    q('mutations', `FROM ${IDX} | ${W} | ${CHANGE} | STATS n = COUNT(*)`),
    q('geo coverage', `FROM ${IDX} | ${W} | EVAL g = CASE(client.geo.country_iso_code IS NOT NULL, "resolved", client.ip IS NOT NULL, "ip, no geo", "no client ip") | STATS n = COUNT(*) BY g | SORT n DESC`),
    q('risk leaderboard (24h)', `FROM ${IDX} | ${EV} | ${riskScored({ by: ACTOR_KEYS })} | ${ACTOR_RESOLVE} | STATS severity = SUM(risk * n), events = SUM(n) BY actor, action = event.action | SORT severity DESC | LIMIT 8`),
  ]);

  const docs = one(span, 2);
  const oldest = one(span, 0);
  const newest = one(span, 1);
  const total = one(totals) ?? 0;
  const bands = Object.fromEntries(bandRows.map((r) => [r[1], r[0]]));
  const signal = sigBySvc.reduce((n, r) => n + r[0], 0);
  const kibanaSignal = sigBySvc.find((r) => r[1] === 'serverless-kibana')?.[0] ?? 0;
  const kibanaShare = signal ? Math.round((kibanaSignal / signal) * 100) : 0;
  const signalShare = total ? (signal / total) * 100 : 0;
  const humanEvents = one(humans) ?? 0;
  const people = one(humans, 1) ?? 0;
  const denialTotal = denialRows.reduce((n, r) => n + r[0], 0);
  const mutCount = one(mutations) ?? 0;
  const days = oldest && newest ? Math.max(1, Math.round((Date.parse(newest) - Date.parse(oldest)) / 86400000)) : null;

  // The headline identity: the busiest named API key attributed to a tenant identity. Keys owned
  // by @elastic.co identities are skipped so tooling keys do not become the headline.
  const owned = topIds.filter((r) => r[2] && r[3]);
  const fleet = owned.find((r) => !String(r[3]).endsWith('@elastic.co')) || owned[0] || topIds[0] || [];
  const [fleetEvents, fleetIps, fleetKey, fleetOwner] = fleet;

  const step = stepper();
  const gv = (id, label) => ({ href: link(id), label: `${label} →` });

  // ── Use case 1 — find the humans ───────────────────────────────────────────────────
  const uc1 = useCase({
    id: 'uc1', n: 1, title: 'Is every identity on the project who it appears to be?',
    proves: `That the suite separates ${fmt(people)} real people from ~${fmt(total)} events of machine traffic — and shows whether any of those "people" is really a credential.`,
    steps: [
      step('Open the Command Center and set the frame', {
        mins: '1 min', link: gv('00-command-center', 'Open Command Center'),
        act: `Set the time picker to **${WINDOW_LABEL}**. Read the top row of KPIs left to right, then stop on **Signal events**.`,
        say: `This project has audited ${fmt(docs)} events${days ? ` over ${days} days` : ''}. In this window, ${fmt(total)} of them. Much of that is typically machine traffic — services authenticating and health-checking, not a person doing something. The number that matters is Signal: ${fmt(signal)}, about ${signalShare.toFixed(1)}% of the stream. Everything else in this suite reads that ${signalShare.toFixed(1)}%.`,
        note: {
          kind: 'tip', label: 'If someone asks how the gate works',
          body: `Four bands${PV ? ', and Platform Volume shows all of them' : ''}: infra health pings, query internals (search phases, reader contexts, point-in-time), bulk authentication, and signal. The first three are transport chatter with no forensic content.`,
        },
      }),
      step('Find the humans', {
        mins: '1 min', link: gv('02-kibana-objects', 'Open Kibana Object Forensics'),
        act: 'Kibana audit is a small share of raw volume and nearly all of the forensic value — saved objects, spaces, sessions. This is where people actually show up.',
        say: `Of ${fmt(signal)} signal events, ${fmt(kibanaSignal)} are Kibana — that is ${kibanaShare}% of the signal, and it is where your ${fmt(people)} named people appear. Everything a person does in this platform lands here.`,
        note: {
          kind: 'warn', label: 'Why the noise gate tests for null first',
          body: 'An earlier gate used `NOT (field IN (...))` on a field that does not exist on Kibana events. In ES|QL that is null, and `WHERE null` drops the row — so the gate silently discarded 100% of Kibana audit. This is why every noise predicate is explicitly null-guarded.',
        },
      }),
      step('Then check whether one credential is shared across many clients', {
        mins: '1 min', link: gv('00-command-center', 'Back to Command Center'),
        act: 'Scroll to **Busiest identities**. Find the busiest named API key (it reads as the key\'s name), then pick it in the **Identity** dropdown.',
        table: fleetKey ? {
          head: ['Identity (API key)', 'Events', 'Distinct client IPs'],
          body: [[`\`${fleetKey}\``, fmt(fleetEvents), fmt(fleetIps)]],
        } : null,
        say: `A named API key reads as its own name, never as the account that owns it, so its traffic is not credited to a person. Over the last 24 hours that key carried ${fmt(fleetEvents)} events from ${fmt(fleetIps)} distinct client IPs. When the addresses far outnumber what one workload would use, many clients share one credential.`,
        notes: [{
          kind: 'stop', label: 'Land this as a process finding, not an accusation',
          body: 'If a shared key does show up, nobody did anything wrong. The point is three practical consequences: when the key’s creator leaves, this breaks silently; you cannot tell one workload’s activity from another’s; and any single compromised client’s blast radius is the whole credential. The fix is a service account, and the audit log is how you find every key that needs one.',
        }],
      }),
    ],
  });

  // ── Use case 2 — who is knocking ───────────────────────────────────────────────────
  const denialTable = denialRows.filter((r) => r[1]).map((r) => [`\`${r[1]}\``, fmt(r[0])]);
  const pathTable = denialPaths.filter((r) => r[1]).slice(0, 6).map((r) => [`\`${r[1]}\``, fmt(r[0])]);
  /* Only claim "WordPress and PHP probes" when the paths in hand actually are that. */
  const scanning = denialPaths.some((r) => /wp-|\.php|webuploader|xmlrpc|wordpress/i.test(String(r[1] || '')));
  const uc2 = useCase({
    id: 'uc2', n: 2, title: 'Is the endpoint being probed from outside, and did anything get through?',
    proves: 'That the suite shows whether the endpoint is being probed from the public internet, whether anything got through, and why the obvious IP field would have hidden it.',
    steps: [
      step('Show the denials', {
        mins: '1 min', link: gv('04-security-anomalies', 'Open Security & Anomalies'),
        act: 'Read **Anonymous denials**, then scroll to **Failures and denials by identity**. Point at the rows with no email.',
        say: `${fmt(denialTotal)} unauthenticated requests were rejected in the last 24 hours. Rows with no identity are not staff — those are strangers. Nothing here got in; this is the control working, and it is the evidence you would hand an auditor.`,
      }),
      step('Show where they came from, and what they asked for', {
        mins: '1 min', link: gv('05-geo-network', 'Open Geo & Network'),
        act: 'Read the choropleth, then the client IP footprint. Then go back and read the denied URL paths.',
        table: pathTable.length ? { head: ['Path requested', 'Denials'], body: pathTable } : null,
        say: scanning
          ? 'These are not mistyped URLs. WordPress and PHP paths requested from an Elasticsearch endpoint are commodity internet scanning — someone spraying the address space looking for an unpatched CMS. Every one was denied.'
          : 'These are unauthenticated requests to paths nothing here serves — automated probing of the endpoint rather than anyone in your organisation. Every one was denied.',
        note: {
          kind: 'tip', label: 'The field that would have lied to you',
          body: 'Scroll to **Proxy vs real client IP**. `source.ip` is the internal proxy — `100.64.x` CGNAT and `10.x` mesh. Analysing it would have placed every one of these scanners inside your own datacentre. Geography here comes from `network.forwarded_ip`, resolved at ingest.',
        },
      }),
    ],
  });

  // ── Use case 3 — why is this identity risky, and what did they do ─────────────────────
  const riskTable = riskTop.filter((r) => r[2]).slice(0, 6)
    .map((r) => [`\`${mask(r[2], redact)}\``, `\`${r[3]}\``, fmt(r[1]), fmt(r[0])]);
  const uc3 = useCase({
    id: 'uc3', n: 3, title: 'Why did this identity score, and what did it do?',
    proves: 'That a risk score is never a dead end — every score decomposes into named actions with weights, and any identity can be pinned across every dashboard in one click.',
    steps: [
      step('Turn the score into its receipts', {
        mins: '1 min', link: gv('04-security-anomalies', 'Open Security & Anomalies'),
        act: 'Read **Risk leaderboard**, then drop straight to the panel beneath it: **Why these identities scored — every risky action, with its weight**.',
        table: riskTable.length ? { head: ['Identity', 'Action', 'Events', 'Accumulated severity'], body: riskTable } : null,
        say: 'A score on its own only raises the next question. The leaderboard ranks; this panel explains. For every identity you get the exact actions that scored, what each one weighs, how many times, and when it last happened. Nothing here is a black box — the weights are published and routine activity deliberately scores zero.',
        notes: [{
          kind: 'tip', label: 'The weights, if asked',
          body: 'Security config change 50 &middot; API key invalidation 45 &middot; failure 40 &middot; anonymous denial 35 &middot; destructive change 30 &middot; other Kibana change 25 &middot; workflow execution 10 &middot; everything else 0. `actor_scope` separates Elastic’s own platform automation from your identities — without it, Elastic’s maintenance account can top your risk table.',
        }],
      }),
      step('Pick an identity from the control bar', {
        mins: '1 min',
        act: 'At the top of every dashboard there are four dropdowns — **Project**, **Identity type**, **Identity** and **Client IP**. When the audit project collects several serverless projects, pick one under **Project** first. Choose **Person** under **Identity type**, then open **Identity**, type the first letters of an address and choose someone. Every panel on the dashboard rescopes to them.',
        say: 'An analyst should be able to pick a person or a key rather than hunt for them. Identity lists people by email, API keys by name and Cloud API keys by id, so every credential is one choice away.',
        note: {
          kind: 'tip', label: 'Why one Identity list',
          body: '`user.email`, `user.name` and `api_key.name` change meaning with the credential, so no single field names everyone. Identity works out one name per event, the same name every table shows. Client IP is searchable because there are usually far too many to scroll.',
        },
      }),
      step('Carry that identity across the whole suite', {
        mins: '1 min',
        act: 'Click the person\'s email in **Busiest human identities** on **Identity & Access** to pin it, then click through the navigation bar — **Kibana Object Forensics**, **Geo & Network**. The pinned filter travels with you and every panel stays scoped.',
        say: 'One selection, and every panel on every dashboard narrows to them — what they authenticated with, what they read, what they changed, where they were. No query writing, no rebuilding a view.',
        note: {
          kind: 'stop', label: 'Clear the pill before you touch a dropdown again',
          body: 'The dropdowns do not travel, Project included: each dashboard opens with all four on “Any”, and only the pill carries the selection: pick the Project again on each page. Choosing a different person in Identity does not replace the pill — it ANDs with it, and every panel drops to zero. Remove the pill first. Same rule before the next section: a pill left up silently scopes every number you show afterwards.',
        },
      }),
      step('Or drop into the raw events for that identity', {
        mins: '1 min',
        // The redacted copy must not leak the identity through the deep link either — that is the
        // one place a masked document would otherwise carry the real address in full.
        links: [{ href: discover(`FROM ${IDX} | WHERE user.email == "${redact ? 'someone@example.com' : (fleetOwner || 'someone@example.com')}" | KEEP @timestamp, event.action, kibana.saved_object.name, kibana.space.id, client.ip | SORT @timestamp DESC`), label: redact ? 'Open an identity in Discover (edit the address) →' : 'Open one identity in Discover →' }],
        act: 'When someone wants the underlying events rather than an aggregate, the Discover sessions are pre-built and pivotable.',
        say: 'Every panel here is ES|QL, and every ES|QL query opens in Discover. Nothing is locked in a visualization — an analyst can take any of this and keep going.',
      }),
    ],
  });

  // ── Use case 4 — prove it, live ────────────────────────────────────────────────────
  const cfgTable = cfgChanges.filter((r) => r[1]).slice(0, 5)
    .map((r) => [`\`${mask(r[1], redact)}\``, `\`${r[2]}\``, fmt(r[0])]);
  const uc4 = useCase({
    id: 'uc4', n: 4, title: 'Who changed something — and can the audit trail prove it live?',
    proves: 'That the audit trail is live, attributable and complete enough to reconstruct a change after the fact — including a change made live.',
    steps: [
      step('Make a change live', {
        mins: '1 min', link: gv('02-kibana-objects', 'Open Kibana Object Forensics'),
        act: 'Beforehand, have a throwaway dashboard ready. Now open it, rename it, and save. Say what you are doing while you do it.',
        say: 'I am going to change something in this platform right now, and then find myself in the audit trail. Watch the clock.',
        notes: [{
          kind: 'tip', label: 'Fill the thirty-second lag, do not watch a spinner',
          body: 'Kibana audit lands within roughly half a minute. Use the time: switch to **Security configuration changes** on Security & Anomalies and read the raw payload column — it names the exact key ids and profile uids affected.',
        }, {
          kind: 'warn', label: 'Expect Elastic’s automation there, and say so first',
          body: 'Elastic platform automation rotates its own credentials on serverless projects, so it can dominate that panel. Saying it before anyone asks is the difference between a caveat and a catch.',
        }],
      }),
      step('Now find yourself', {
        mins: '1 min', link: gv('02-kibana-objects', 'Back to Object Forensics'),
        act: 'Refresh. Read the **Mutations** panel — your rename is at the top, with your name, the verb, the object title and the space.',
        say: `${fmt(mutCount)} Kibana state changes in this window — saved objects, alerting rules, workflows, ML jobs, the lot — and the one I just made is at the top of the list — who, what, which object, which space, to the second. That is the whole point: not "someone changed a dashboard", but a name, a timestamp and an object.`,
        note: {
          kind: 'tip', label: 'The honest caveat',
          body: 'This panel is a recency-sorted top 30, not an exhaustive export. For the exhaustive version, open this panel’s query in Discover (Explore in Discover) and remove the LIMIT — that is what you would attach to an audit response.',
        },
      }),
    ],
  });

  // ── Landmines / Q&A / teardown ─────────────────────────────────────────────────────
  const landmines = rows(['If this happens', 'Do this'], [
    ['A panel sits on a loading spinner.',
     `Widening the picker makes the unfiltered identity-grouping panels slower, and a query already sent can keep running after you narrow it back. Return to **${WINDOW_LABEL}** and let the page settle rather than refreshing — each refresh adds work. To show history without widening, open **Identity 360**: its first band always reads the last seven days.`],
    ['Someone asks what the noise gate is hiding.',
     PV
       ? 'Open **Platform Volume**. It applies no gate and splits the stream into its four bands — infra health, query internals, authentication and signal — so every excluded event is still counted there. The gate only narrows the forensic views; do not claim more than the bands show.'
       : 'Point at **Signal vs noise over time** on Command Center. It applies no gate and stacks the stream in its four bands — infra health, query internals, authentication and signal — so every excluded event is still counted there. The gate only narrows the forensic views; do not claim more than the bands show.'],
    ['Someone asks why an Elastic account is in their risk table.',
     'It is Elastic platform automation performing credential rotation on the project. That is why `actor_scope` exists. Filter to `tenant` and the table becomes their own identities.'],
    ['Someone challenges a headline number.',
     'Open the panel’s hover tooltip — every panel states what it counts and how to read it. Then open the same query in Discover. Never defend a number you cannot show the query for.'],
    ['A filter pill from an earlier step is still applied.',
     'Every number on screen is scoped to that identity. Clear it and re-read the panel before continuing.'],
    ['Someone asks for something the suite does not do.',
     'Note it and say so. The suite is version-controlled code, so a new panel is a pull request, not a rebuild.'],
  ]);

  const qa = rows(['Question', 'Answer'], [
    ['Why is Kibana such a small share of the stream?',
     `Because Elasticsearch audits every transport action and Kibana audits user intent. In this window Kibana is ${fmt(kibanaSignal)} of ${fmt(signal)} signal events — ${kibanaShare}% — and it is where every human action appears.`],
    ['Can the risk score be tuned?',
     'Yes — it is a weight table in one file, ~six lines. The weights are deliberately coarse and routine activity scores zero, so the number is not a disguised event count.'],
    ['What is not covered here?',
     'Data content — this is who did what, not what was in the document. Also anything before the geo pipeline was installed: enrichment is forward-only, and older events carry no geography.'],
    ['How much geography actually resolves?',
     geoCov.length
       // Literal character, not an entity: this string lands in a table cell, and cells are
       // escaped, so "&middot;" would render as those eight characters.
       ? geoCov.map((r) => `${r[1]}: ${fmt(r[0])}`).join(' · ') + '. Events with a forwarded IP that still do not resolve are private or CGNAT ranges, which is expected.'
       : 'Resolved from the real client IP at ingest; private and CGNAT ranges do not resolve, which is expected.'],
    ['Does this work on other projects?',
     'Yes. It is a Node CLI with no dependencies — point it at another project and run `./audit --deploy`. Nothing is hand-built in the UI.'],
    ['Can these become alerts rather than dashboards?',
     'Every panel is an ES|QL query, and ES|QL alerting rules take the same query text. The dashboards are how you find the rule worth writing.'],
  ]);

  const preflight = check([
    `Open all ${DASHBOARDS.length} dashboards once, ~30 minutes before. Cold panels are slow; warm ones are not.`,
    `Set every dashboard to **${WINDOW_LABEL}** and confirm no panel is empty.`,
    'Create a throwaway dashboard for the live-change beat, and leave it open in a second tab.',
    'Clear any filter pill left over from rehearsal.',
    redact
      ? 'This copy is redacted. Real identities are visible on screen but masked in this document.'
      : '**Check the identity use case 1 will name before you show it.** It puts the owner of the busiest API key on screen by email, and the live dashboards are never masked. The point is a process gap, not a person — confirm that address is appropriate for this audience before you present.',
    PV ? 'Have the Platform Volume dashboard ready as the answer to "what are you filtering out?"'
       : 'Know where Signal vs noise over time sits on Command Center: it is the answer to "what are you filtering out?"',
    'Run `./audit --queries`. A query left scanning from earlier work slows every panel you open, and nothing can cancel it on serverless — if one is listed as still scanning, start later rather than present on a loaded project.',
  ]);

  // ── Assemble ───────────────────────────────────────────────────────────────────────
  const body = [uc1, uc2, uc3, uc4].join('\n');
  const mins = minutesIn(body);
  const steps = stepsIn(body);

  const toc = `<nav class="toc">
    <a href="#preflight">Pre-flight &mdash; thirty minutes before</a>
    <a href="#uc1">1 &middot; Is every identity who it appears to be?</a>
    <a href="#uc2">2 &middot; Is the endpoint being probed?</a>
    <a href="#uc3">3 &middot; Why did this identity score?</a>
    <a href="#uc4">4 &middot; Who changed something?</a>
    <a href="#landmines">Landmines</a>
    <a href="#qa">Likely questions</a>
  </nav>`;

  const html = `<title>Audit Suite Demo Runbook</title>
${CSS}
<div class="hero"><div class="wrap">
  <div class="kicker">Demo runbook &middot; presenter copy</div>
  <h1>Cloud Audit Dashboards</h1>
  <p class="aud"><strong>Audience:</strong> whoever owns and secures the Elastic Cloud project being shown. <strong>Driven live</strong> against the real audit stream at ${esc(WINDOW_LABEL)}.</p>
  <div class="thesis">4 use cases, ${mins} minutes, ${steps} steps. Every step is a link to click and a line to say. Every number below was read from the live stream when this page was generated &mdash; the walkthrough is driven at ${esc(WINDOW_LABEL)}, and findings about the estate are sourced over 24 hours and narrated as such.</div>
  <div class="stats">
    <div class="stat"><b>${compact(docs)}</b><span>events audited${days ? ` &middot; ${days} days` : ''}</span></div>
    <div class="stat"><b>${signalShare.toFixed(1)}%</b><span>survives the noise gate</span></div>
    <div class="stat"><b>${fmt(people)}</b><span>people active this hour</span></div>
    <div class="stat"><b>${fmt(denialTotal)}</b><span>unauthenticated requests denied &middot; 24h</span></div>
    <div class="stat"><b>${fmt(mutCount)}</b><span>Kibana state changes &middot; this hour</span></div>
    <div class="stat"><b>${DASHBOARDS.length}</b><span>dashboards, deployed as code</span></div>
  </div>
</div></div>

<div class="wrap">
${toc}

<h2 id="preflight">Pre-flight &mdash; thirty minutes before, not five</h2>
<p class="proves"><strong>Why this matters:</strong> the only two ways this walkthrough goes wrong are a cold panel spinning while you talk, and a leftover filter pill quietly scoping every number you show.</p>
${preflight}
${callout('warn', 'Drive at ' + WINDOW_LABEL, `${WINDOW_LABEL} is the readable view of right now: the identity-grouping panels are fastest there and it still carries mutations, denials and config changes. Do not widen the picker to reach history — **Identity 360**'s first band always shows the last seven days whatever the picker says, and with a person selected it is a baseline, a rank among the busiest identities and a weekly rhythm.${PV ? ' For raw volume over a longer window, use **Platform Volume**, whose panels are counts rather than groupings.' : ''}`)}

${body}

<h2 id="landmines">Landmines</h2>
${landmines}

<h2 id="qa">Likely questions</h2>
${qa}

<h2 id="close">Closing line</h2>
${talk(`${signalShare.toFixed(1)}% of the stream is signal, every score decomposes into the actions behind it, and any identity is one click from their entire footprint. Every panel is a query, so any of them can become an ES|QL alerting rule.`)}
<p class="muted">Generated from the live audit stream${newest ? ` &middot; newest event ${esc(String(newest).replace('T', ' ').replace('Z', ' UTC'))}` : ''} &middot; window ${esc(WINDOW_LABEL)}${redact ? ' &middot; identities redacted' : ''}</p>
</div>
${COPY_JS}
`;

  const file = join(out, 'DEMO-GUIDE.html');
  writeFileSync(file, html);
  success(`${mins} minutes, ${steps} steps -> ${file}`);
  info(`Open: file://${file}`);
  return file;
}
