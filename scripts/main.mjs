/**
 * Audit dashboards for Elastic Cloud Serverless. Command dispatch.
 *
 * Pipeline: --space -> --ingest -> --lint -> --objects -> --dashboards -> --verify
 *           (or run the lot with --deploy).
 *
 * Order matters: Vega visualizations and Discover sessions must exist before the
 * dashboards that reference them by id.
 */
import { banner, fail, success, info } from './lib/log.mjs';
import { cfg } from './lib/env.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

const HELP = `Usage: ./audit <command>

  Provision
    --space            Create the Kibana space (default: audit; override with AUDIT_SPACE)
    --ingest           Install the audit-scoped geoip pipeline, templates and client.* mappings
    --ingest-check     Assert enrichment is actually flowing on live data

  Kibana as code
    --lint             Execute every ES|QL query in the repo; fails the build on any error
    --objects          Deploy the data view, 13 Vega visualizations and 10 Discover sessions
    --dashboards       Generate dashboards/*.json and deploy every dashboard
    --verify           Render every dashboard in Chromium and inspect for broken panels
                       (AUDIT_VERIFY_THEME=light renders light mode; default dark)
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

  Lifecycle
    --deploy           Full pipeline: space -> ingest -> lint -> objects -> dashboards
    --clean <target>   Tear down: 'dashboards', 'ingest', or 'all'. No target deletes nothing.
    --help             This message
`;

async function runModule(file, fn = 'run') {
  const mod = await import(file);
  if (typeof mod[fn] !== 'function') throw new Error(`${file} has no export ${fn}()`);
  return mod[fn](rest);
}

async function doDeploy() {
  await runModule('./space.mjs');
  await runModule('./ingest.mjs');
  await runModule('./esql.mjs');
  await runModule('./objects.mjs');
  await runModule('./dashboards.mjs');
  success('Deploy complete. Run ./audit --verify to render and inspect.');
}

const table = {
  '--space': () => runModule('./space.mjs'),
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
info(`space=${cfg.space}  kibana=${new URL(cfg.kibana).host}`);
try {
  await handler();
} catch (err) {
  fail(err.message);
  if (process.env.AUDIT_DEBUG) console.error(err);
  process.exit(1);
}
