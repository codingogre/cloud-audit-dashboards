/** Tiny console logger — `i / ok / x` prefixes so every command reads the same. */
export function banner(title = 'Cloud Audit Dashboards') {
  console.log(title);
  console.log('-'.repeat(title.length));
}
export function info(msg)    { console.log(`i ${msg}`); }
export function success(msg) { console.log(`ok ${msg}`); }
export function fail(msg)    { console.error(`x ${msg}`); }
export function detail(msg)  { console.log(`  ${msg}`); }
export function warn(msg)    { console.log(`! ${msg}`); }
export const log = { info, success, detail, fail, warn };
