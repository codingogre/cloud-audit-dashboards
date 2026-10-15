/** 01 Identity & Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, ORG, CRED_TYPE_LABEL, CRED_TYPE_COLORS, TIME, BUCKET, dash, kpi, xy, table, sized,
  vega, search, resetIds, bar, cloudKeyLabel, grouped
} from '../panels.mjs';
import { WHO } from './shared.mjs';

/**
 * The three actions that mean "could not prove who they are". Everything else this page counts as a
 * failure (access_denied, and any action whose outcome is failure) is an AUTHENTICATED identity being
 * refused — measured, access_denied alone outnumbers all three of these together. The panels therefore
 * say "failed or denied", and the KPI splits the two so neither reads as the other.
 */
const SIGNIN_FAILED = '"authentication_failed","realm_authentication_failed","anonymous_access_denied"';
const FAILED_OR_DENIED = `WHERE attributes.event.action IN (${SIGNIN_FAILED}) OR attributes.event.outcome == "failure"`;

/** Credential types in words and colours, shared with vega/02 (panels.mjs CRED_TYPE_LABEL). */
const AUTH_LABEL = `EVAL ${CRED_TYPE_LABEL}`;

/**
 * Every API key, of both kinds, and the one key that names it. Measured on the live stream (24h):
 *
 *   Cloud API key          attributes.api_key.* absent; user.domain "_cloud_api_key" and user.name = the
 *                          key's id. It carried ~880k events a day — far the busiest credential — and the
 *                          old `api_key.name IS NOT NULL` filter left it off every API-key panel, so the
 *                          tile read "0 · none in range" beside a chart of thousands of API-key requests.
 *   Elasticsearch API key  api_key.id and .name; user.* is the principal that CREATED it — a person's
 *                          email, or (here) the Cloud API key that minted it, as user.name.
 *
 * So a key is `COALESCE(api_key.id, user.name)` under this filter, and the two kinds never collide: a
 * row with no api_key.id is a Cloud key by construction. Kibana logs a call made with an Elasticsearch
 * key as user.domain "_es_api_key" with no key id, so those calls cannot be put on a key and are not here.
 * 7d on the perf replica: Busiest API keys 50 → 260ms, the tile 43 → 90ms, the inventory 90 → 390ms —
 * the cost of the 1.7M Cloud-key events the panels used to skip.
 */
const KEYED = 'WHERE attributes.api_key.id IS NOT NULL OR attributes.user.domain == "_cloud_api_key"';
const KEY_DERIVE = 'EVAL key_id = COALESCE(attributes.api_key.id, attributes.user.name), ' +
  'kind = CASE(attributes.api_key.id IS NULL, "Cloud", "Elasticsearch")';

/**
 * "N things" for a KPI's secondary line, in words when N is 0 or 1. A digit zero renders slashed in the
 * metric font, which read as a different typeface from the words beside it, so zero is spelt out.
 * A multi-branch CASE, but it runs once, on the single row a STATS without BY returns.
 */
const count = (x, one, many, zero) =>
  `CASE(${x} == 0, "${zero}", ${x} == 1, "1 ${one}", CONCAT(${grouped(x)}, " ${many}"))`;

/**
 * A log-scale bar chart's value axis, from 0.5 so a count of 1 still draws a bar (log(1) is the floor
 * otherwise). The API takes a custom domain only with both ends (a min alone is a 400), so the top is
 * set with room to spare. Measured live: one Cloud API key sends ~1.4M events a day, so a 7-day
 * range's ~2.2h intervals peak near 130k and a 30-day total is ~42M. The time chart's 10M is 10x a
 * busy 7-day interval; the whole-range bars' 1B is 10x a 30-day total.
 */
const logBar = (p, max) => { p.config.axis.y.domain = { type: 'custom', min: 0.5, max, rounding: false }; return p; };

export function build() {
  resetIds();
  const P = [
    // Counted on the actor COALESCE — the key Identity first and last seen groups by — over all traffic,
    // like that session, so the tile and the session's row count are the same number. A person is an
    // identity with an email (the COALESCE prefers it), so `human` is the Humans tile's number too.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ACTOR_RESOLVE} | STATS \`Identities\` = COUNT_DISTINCT(actor), human = COUNT_DISTINCT(attributes.user.email), machine = COUNT_DISTINCT(actor) WHERE attributes.user.email IS NULL | EVAL detail = CONCAT(${count('human', 'human', 'humans', 'no humans')}, " · ", ${count('machine', 'machine', 'machine', 'no machine')}) | KEEP \`Identities\`, detail`,
      'Identities', 'Distinct identities in all traffic, resolved as email, then API key name, then user.name — one per row of Identity first and last seen. The line under the number splits them: humans have an email on their events (the Humans tile), machines do not (service accounts, API keys, internal and anonymous principals).',
      { secondary: 'detail' }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Humans\` = COUNT_DISTINCT(attributes.user.email), sso = COUNT_DISTINCT(attributes.user.email) WHERE attributes.user.domain == "cloud-saml-kibana" | EVAL detail = CASE(sso == 0, "none signed in by SSO", CONCAT(${grouped('sso')}, " signed in by SSO")) | KEEP \`Humans\`, detail`,
      'Humans', 'Distinct email addresses in all traffic — the people Busiest human identities ranks. An Elasticsearch API key carries its creator\'s email, so a person can count here through a key they made without signing in; the line under the number says how many signed in through SAML SSO.',
      { secondary: 'detail' }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KEYED} | STATS es = COUNT_DISTINCT(attributes.api_key.id), cloud = COUNT_DISTINCT(attributes.user.name) WHERE attributes.api_key.id IS NULL | EVAL \`API keys\` = es + cloud, detail = CASE(es + cloud == 0, "none in range", CONCAT(${count('cloud', 'Cloud', 'Cloud', 'no Cloud')}, " · ", ${count('es', 'ES', 'ES', 'no ES')})) | KEEP \`API keys\`, detail`,
      'API keys', 'Distinct API keys seen in range, of both kinds: Elastic Cloud API keys (recorded by id only) and Elasticsearch (ES) API keys (by id and name); the line under the number splits them. One per row of API key inventory. A re-issued Elasticsearch key keeps its name under a new id and counts again.',
      { secondary: 'detail' }),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain == "cloud-saml-kibana" | STATS \`SSO events\` = COUNT(*), logins = COUNT(*) WHERE attributes.event.action == "user_login" | EVAL detail = ${count('logins', 'new sign-in', 'new sign-ins', 'no new sign-ins')} | KEEP \`SSO events\`, detail`,
      'SSO events', 'Events authenticated through the cloud-saml-kibana SAML realm — a person in a browser. The line under the number counts Kibana user_login events: a session that began before the range shows events here but no new sign-in.',
      { secondary: 'detail' }),
    // The line under the number names ONE part, the failed sign-ins; the title says the rest is denied.
    // "N logins · M denied" read as N successful logins beside SSO events' "no new sign-ins", and
    // "539 failed sign-ins · 628 denied" was cut to "… · 62" in an 8-column tile at a 1440px viewport.
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS \`Failed or denied\` = COUNT(*), signin = COUNT(*) WHERE attributes.event.action IN (${SIGNIN_FAILED}) | EVAL detail = CASE(signin == 0, "no failed sign-ins", signin == 1, "1 failed sign-in", signin == \`Failed or denied\`, "all failed sign-ins", CONCAT(${grouped('signin')}, " failed sign-ins")) | KEEP \`Failed or denied\`, detail`,
      'Failed or denied', 'Failed sign-ins (authentication_failed, realm_authentication_failed, anonymous_access_denied) plus requests refused or failed after sign-in (access_denied and any failed outcome). The line under the number counts the failed sign-ins (nobody signed in: these are not logins); the rest of the number is denied — refused or failed after sign-in. A denial is an authenticated identity hitting a permission wall, not someone guessing credentials. Same predicate as the two failure panels below.',
      { secondary: 'detail' }),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.session.id IS NOT NULL | STATS \`Kibana sessions\` = COUNT_DISTINCT(attributes.kibana.session.id), people = COUNT_DISTINCT(attributes.user.email) | EVAL detail = CASE(\`Kibana sessions\` == 0, "none in range", ${count('people', 'person', 'people', 'no email recorded')}) | KEEP \`Kibana sessions\`, detail`,
      'Kibana sessions', 'Distinct Kibana browser sessions observed in range, and how many people (by email) they belong to.',
      { secondary: 'detail' }),
    // Bars, not a line. ES|QL returns no row for an interval without traffic, so a line ran straight
    // across a ten-minute gap as if requests had continued, and a type seen in one interval only (SAML,
    // Realm) was a single point with nothing to join — no mark at all. A bar is drawn where there is a
    // row and nowhere else. Grouped, not stacked: stacking on a log axis misstates every upper series.
    // The 0.5 floor gives a count of 1 a visible bar (logBar).
    logBar(xy(0, 5, 24, 12, 'Authentication method over time',
        `FROM ${IDX} | ${TIME} | WHERE attributes.authentication.type IS NOT NULL | STATS events = COUNT(*) BY ${BUCKET}, attributes.authentication.type | ${AUTH_LABEL} | SORT auth`,
        'events', 'Elasticsearch requests per interval by how they presented credentials: API key, token (SSO browser sessions and service accounts) or realm (username and password). One bar per credential type per interval, on a log scale, so a type carrying a fraction of a percent of the traffic is as readable as the bulk; an interval with no bar had no requests of that type. A shift in this mix is worth explaining.',
        { breakdown: 'auth', kind: 'bar', colors: CRED_TYPE_COLORS, yScale: 'log' }), 1e7),
    vega(24, 5, 24, 12, '02-auth-matrix', 'Credential type by identity',
      'Which credential type each of the 12 busiest identities presents; colour runs teal → blue → purple → pink as events grow (log scale; the legend lists the decades the chart spans). Humans should authenticate by token (SSO); service identities by API key. Only Elasticsearch requests record a credential type, so identities seen only in Kibana or only anonymously are counted in Identities above but are not on this chart. A Cloud API key has no name and is shown as “_4KEO… · Cloud API key”, the first five characters of its id.'),
    // Bars on a log axis, not the donuts they replace. A donut rounds a share: in an hour where a Cloud
    // API key sent ~450k events and one person 33, the only slice label read "Machine 100%" beside a
    // legend listing Elastic and a Humans tile reading 1 — the label contradicted the page. Here the
    // category name carries the count ("Elastic · 33"), and on a log axis its bar is visible beside one
    // of 450k. (The donut labels also set name and percentage in two fonts, and wrapped "Cloud API
    // key".) The count is in the axis label, not a Lens value label: Lens prints a value label only
    // where it fits inside the bar, so at a 1440px viewport "SAML SSO" (37 events) had no number at
    // all and "Elastic 37" sat half outside its bar; an axis label is always drawn. The 0.5 floor gives
    // a count of 1 a visible bar, as on the time chart above.
    // Grouped on the raw email first, then classified: ORG reads only attributes.user.email, so the
    // CASE runs once per person instead of once per event.
    logBar(bar(0, 17, 12, 11, 'Events by identity origin',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY attributes.user.email | ${ORG} | STATS events = SUM(events) BY origin = actor_org | EVAL origin = CONCAT(origin, " · ", ${grouped('events')}) | SORT events DESC`,
      'origin', 'events', 'Events, not identities, by the email on the event: Elastic (@elastic.co), Tenant (any other address), or Machine (no email: service accounts, Cloud API keys, internal users and anonymous requests). Each origin\'s name carries its count, and the bars are on a log scale so a person\'s few dozen events are visible beside a key\'s hundreds of thousands: read the count, not the length. An origin with no bar had no events in range. One busy key can make Machine nearly all of the traffic while most identities are people. An Elasticsearch API key carries its creator\'s email, so traffic from a key a person created counts under that person\'s origin.',
      { yScale: 'log' }), 1e9),
    logBar(bar(12, 17, 12, 11, 'Events by authentication realm',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain IS NOT NULL | STATS events = COUNT(*) BY attributes.user.domain | EVAL realm = CASE(attributes.user.domain == "cloud-saml-kibana", "SAML SSO", attributes.user.domain == "_es_api_key", "Elasticsearch API key", attributes.user.domain == "_cloud_api_key", "Cloud API key", STARTS_WITH(attributes.user.domain, "_service_account"), "Service account", STARTS_WITH(attributes.user.domain, "_"), "Other internal", attributes.user.domain) | STATS events = SUM(events) BY realm | EVAL realm = CONCAT(realm, " · ", ${grouped('events')}) | SORT events DESC`,
      'realm', 'events', 'Events by the security realm that authenticated them. Each realm\'s name carries its count, and the bars are on a log scale so a small realm is visible beside the bulk: read the count, not the length. SAML SSO is interactive human sign-in (cloud-saml-kibana); Elasticsearch API key (_es_api_key) and Cloud API key (_cloud_api_key) are programmatic — an Elasticsearch key minted by a Cloud API key authenticates in the Cloud key\'s realm; Service account is Elastic\'s own components (_service_account). Any other realm is shown by its name. Anonymous and unauthenticated requests record no realm and are not counted, so the bars can sum to less than Events by identity origin beside it.',
      { yScale: 'log' }), 1e9),
    // Grouped on the raw key fields and derived afterwards; user.name is a group key because it IS the
    // id of a Cloud API key, and for an Elasticsearch key it is the one creator, so it never splits a key.
    // The API key column is assigned in ES|QL so a Cloud key reads "_4KEO… · Cloud API key", the form the
    // matrix, the failure table and API key inventory use; as a plain alias of api_key.name it read "-"
    // on the busiest row, which looked like missing data. The cost: Lens refuses click-to-filter on a
    // column assigned in ES|QL, so a key name no longer pins a filter from this table (a decision left
    // open for review: no control or drilldown in the suite keys on api_key.name; the person behind a
    // key is pinned from the Person controls, and API key inventory below has every key). Key ID is
    // derived as before. The label runs on grouped rows (one per key), never per event.
    table(24, 17, 24, 11, 'Busiest API keys',
      `FROM ${IDX} | ${TIME} | ${KEYED} | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY api_key = attributes.api_key.name, attributes.api_key.id, attributes.user.name | ${KEY_DERIVE}, api_key = COALESCE(api_key, ${cloudKeyLabel('attributes.user.name', '"(no name)"')}) | SORT events DESC | LIMIT 15`,
      ['api_key', sized('key_id', 175), sized('kind', 105)], ['events', 'ips'],
      'The busiest API keys of both kinds, one row per key, with request volume and how many distinct client IPs used it. Kind is Cloud (an Elastic Cloud API key: it has no name and is recorded by its id, so it reads “_4KEO… · Cloud API key”, the first five characters of the id in Key ID) or Elasticsearch (an Elasticsearch API key: id and name). A key used from many IPs is worth investigating. A re-issued key keeps its name under a new id, so a name can appear twice. The full list, with owner and first and last use, is API key inventory below.'),
    // Grouped on the email alone. user.full_name was a second key, but over 7 days it was empty on all
    // but 2 of ~11,600 events for the one SSO user, and on those 2 it held the email again — so it split
    // one person into two rows and otherwise filled a column with "-". The email is the person, and it
    // is the click filter. First and last seen and IPs are not repeated here: they are on Identity first
    // and last seen, for the same events. Without them this table fits 12 columns (an email keeps ~215px
    // at a 1440px viewport), and the failures beside it get the 36 that six columns need there: at 32 the
    // Result column cut "<unauthenticated-cloud-access-token>" in Identity (rendered at 1440).
    table(0, 28, 12, 12, 'Busiest human identities',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS events = COUNT(*) BY attributes.user.email | SORT events DESC | LIMIT 15`,
      [WHO], ['events'],
      'People by email, busiest first: the people the Humans tile counts, over all traffic, with the same event counts as Identity first and last seen, which also has when each was first and last seen and from how many IPs. The panel shows the top rows; the rest are in that session. Click an email to pin that person across the suite.'),
    // Grouped on the raw identity fields and resolved afterwards (QUERY SHAPE rule 2): the COALESCE then
    // runs once per group instead of once per failed event. An action that is neither a failed sign-in
    // nor access_denied is here only because its outcome was failure, and without saying so a
    // saved_object_update row read as a normal operation — so a Result column names the kind, with the
    // same words as the Failed sign-ins session. It is a separate column, not a suffix on Action: Lens
    // refuses click-to-filter on a column assigned in ES|QL, and Action is a STATS BY alias that keeps it.
    table(12, 28, 36, 12, 'Most frequent failed or denied access',
      `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, action = attributes.event.action, ip = client.ip | ${ACTOR_RESOLVE} | STATS events = SUM(events), last_seen = MAX(last_seen) BY actor, action, ip | EVAL result = CASE(action IN (${SIGNIN_FAILED}), "failed sign-in", action == "access_denied", "denied", "failed") | SORT events DESC | LIMIT 15`,
      ['actor', sized('action', 175), 'result', 'ip'], ['events', 'last_seen'],
      'Failed sign-ins and refused requests grouped by identity, action and source IP, most frequent first; the top rows of what the Failed or denied tile counts. Result names the kind, as in the session below: failed sign-in (authentication_failed, realm_authentication_failed, anonymous_access_denied), denied (access_denied: an authenticated identity refused an action), or failed (any other action, here because its outcome was failure).',
      { empty: 'good' }),
    // The sessions run full width. Side by side at 24 columns, seven and eight columns shared ~800px:
    // timestamps wrapped onto three lines and the last column was cut off at the panel edge. These are
    // the record-level evidence, so every column has to be readable without opening Discover.
    search(0, 40, 48, 12, '02-failed-authentications', 'Failed sign-ins and denied access · newest 1,000 at most',
      'The newest failed sign-ins and refused requests, record by record. Discover stops at 1,000 rows, so on a busy range its result count is that cap and the Failed or denied tile is the total. Result names the kind: failed sign-in, denied (access_denied), or failed (any other failed outcome). Credential is the credential type, or the realm on a Kibana event, and reads “not authenticated” on a failed sign-in; Country reads “internal” for a private or carrier-NAT address, which is Kibana or the platform calling on someone\'s behalf.',
      { empty: 'good' }),
    search(0, 52, 48, 12, '07-api-key-activity', 'API key inventory',
      'Every API key seen in range (up to 1,000), Cloud and Elasticsearch, busiest first — one row per key the API keys tile counts — with owner, volume, IP spread, indices touched and first and last use. Owner is the identity that created the key: a person\'s email, or, for a key minted programmatically, the Cloud API key that minted it, shown as “_4KEO… · Cloud API key” like that key\'s own row; a Cloud API key\'s own creator is not in the audit stream, so its Owner reads Cloud organization.'),
    search(0, 64, 48, 14, '06-actor-first-seen', 'Identity first and last seen',
      'Every identity in range (up to 1,000), all traffic — one row per identity the Identities tile counts — with its first and last appearance, Events (everything it did, the same count as Busiest human identities) and Signal events (what is left after the noise gate, the count the gated panels across the suite use). Newest first appearance on top. Widen the time range to tell a brand-new identity from one that was simply quiet.'),
  ];
  return dash('cloud-audit-01-identity-access', '[Audit] 🔐 Identity & Access',
    'Who authenticated, how, from where, and what failed. Resolves the numeric user.name into real identities.', P);
}
