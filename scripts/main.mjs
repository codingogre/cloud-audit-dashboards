/**
 * Audit dashboards for Elastic Cloud Serverless. Command dispatch.
 *
 * Pipeline: --ingest -> --lint -> --objects -> --dashboards -> --verify
 *           Everything installs into Kibana's Default space.
 *           (or run the lot with --deploy).
 *
 * Order matters: Vega visualizations and Discover sessions must exist before the
 * dashboards that reference them by id.
 */
import { banner, fail, success, info } from './lib/log.mjs';
import { cfg } from './lib/env.mjs';
import { optIns, takeWith } from './lib/suite.mjs';

// --with may sit before or after the command; it is folded into AUDIT_WITH first (see lib/suite.mjs).
let argv;
try { argv = takeWith(process.argv.slice(2)); optIns(); } catch (err) { fail(err.message); process.exit(1); }
const cmd = argv[0];
const rest = argv.slice(1);

const HELP = `Usage: ./audit <command>

  Provision
    --ingest           Install the audit-scoped geoip pipeline, templates and client.* mappings
    --ingest-check     Assert enrichment is actually flowing on live data

  Kibana as code
    --lint             Execute every ES|QL query in the repo; fails the build on any error
    --objects          Deploy the data view, 20 Vega visualizations, 11 Discover sessions and the
                       ES|QL view the prior-period tiles read (cloud-audit-events-view)
    --dashboards       Generate dashboards/*.json and deploy every dashboard. Removes a suite
                       dashboard left from an earlier deploy that is not in this run's set
    --verify           Render every dashboard in Chromium and inspect for broken panels
                       (AUDIT_VERIFY_THEME=light renders light mode; default dark.
                       AUDIT_VERIFY_RANGE=now-1h sets the window; default now-24h, the
                       dashboards' saved range; every range ends at now-1m, as theirs does.
                       AUDIT_VERIFY_WIDTH=1440 narrows the viewport; default 1920)
    --queries          List the ES|QL queries running on the project right now. Check this before
                       trusting any timing: an abandoned query cannot be cancelled on serverless

  Synthetic activity
    --synth <sub>      Drive real API traffic as a cast of personas so the platform emits audit
                       events, then prove they landed and score as the dashboards expect.
                       run [--only ids] [--no-verify] [--keep] | loop [--minutes n] | schema |
                       list | clean [--dry-run]

  Performance
    --perf <sub>       Time every dashboard query at production volume, on a replica of the stream.
                       seed [--copies 30] [--days 7] [--slices 4] [--max-minutes 25] [--force-append]
                         replicate the live stream into logs-<dataset>-perf, re-stamped over D days
                       run [--windows 1h,24h,7d] [--budget 30000] [--only name,...] [--anchor data|now]
                         per-query and per-page-load timings -> build/perf-<stamp>/report.json
                       clean   delete the -perf replica (never the live stream)

  Walkthrough
    --demo-guide       Generate the presenter runbook from live data (add --redact to mask identities)

  Optional dashboards
    --with <name>      Add an opt-in dashboard to any command (comma-separate several). Known:
                       platform-volume (06 Platform Volume, the unfiltered firehose; off by
                       default). AUDIT_WITH=platform-volume in the environment or .env does the
                       same for every command, so --objects, --dashboards, --verify, --perf and
                       --lint agree on the set. Example: ./audit --dashboards --with platform-volume

  Lifecycle
    --deploy           Full pipeline: ingest -> lint -> objects -> dashboards (Default space)
    --clean <target>   Tear down: 'dashboards' (with the ES|QL view), 'ingest', or 'all'. No target
                       deletes nothing.
    --help             This message
`;

async function runModule(file, fn = 'run') {
  const mod = await import(file);
  if (typeof mod[fn] !== 'function') throw new Error(`${file} has no export ${fn}()`);
  return mod[fn](rest);
}

async function doDeploy() {
  await runModule('./ingest.mjs');
  // The lint's prior-period queries read the events view, which a first install (production included) does not
  // have yet. putView is create-or-replace, so --objects creating it again below is harmless.
  const { putView } = await import('./lib/view.mjs');
  const v = await putView();
  success(`ES|QL view ${v.name} ready for the lint`);
  await runModule('./esql.mjs');
  await runModule('./objects.mjs');
  await runModule('./dashboards.mjs');
  success('Deploy complete. Run ./audit --verify to render and inspect.');
}

const table = {
  '--ingest': () => runModule('./ingest.mjs'),
  '--ingest-check': () => runModule('./ingest.mjs', 'check'),
  '--lint': () => runModule('./esql.mjs'),
  '--objects': () => runModule('./objects.mjs'),
  '--dashboards': () => runModule('./dashboards.mjs'),
  '--verify': () => runModule('./verify.mjs'),
  '--queries': () => runModule('./queries.mjs'),
  '--demo-guide': () => runModule('./demo-guide.mjs'),
  '--synth': () => runModule('./synth.mjs'),
  '--perf': () => runModule('./perf.mjs'),
  '--deploy': doDeploy,
  '--clean': () => runModule('./clean.mjs'),
};

banner('Cloud Audit Dashboards');
if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
const handler = table[cmd];
if (!handler) { fail(`Unknown command: ${cmd}`); console.log(HELP); process.exit(1); }
info(`space=default  kibana=${new URL(cfg.kibana).host}${optIns().size ? `  with=${[...optIns()].join(',')}` : ''}`);
try {
  await handler();
} catch (err) {
  fail(err.message);
  if (process.env.AUDIT_DEBUG) console.error(err);
  process.exit(1);
}
