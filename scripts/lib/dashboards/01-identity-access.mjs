/** 01 Identity & Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, ORG, CRED_TYPE_LABEL, CRED_TYPE_COLORS, TIME, BUCKET, PALETTE, dash, kpi, xy, table, sized, pie,
  vega, search, resetIds
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
  'api_key = COALESCE(attributes.api_key.name, "(no name)"), kind = CASE(attributes.api_key.id IS NULL, "Cloud", "Elasticsearch")';

/**
 * "N things" for a KPI's secondary line, in words when N is 0 or 1. A digit zero renders slashed in the
 * metric font, which read as a different typeface from the words beside it, so zero is spelt out.
 * A multi-branch CASE, but it runs once, on the single row a STATS without BY returns.
 */
const count = (x, one, many, zero) =>
  `CASE(${x} == 0, "${zero}", ${x} == 1, "1 ${one}", CONCAT(TO_STRING(${x}), " ${many}"))`;

export function build() {
  resetIds();
  const P = [
    // Counted on the actor COALESCE — the key Identity first and last seen groups by — over all traffic,
    // like that session, so the tile and the session's row count are the same number. A person is an
    // identity with an email (the COALESCE prefers it), so `human` is the Humans tile's number too.
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ACTOR_RESOLVE} | STATS \`Identities\` = COUNT_DISTINCT(actor), human = COUNT_DISTINCT(attributes.user.email), machine = COUNT_DISTINCT(actor) WHERE attributes.user.email IS NULL | EVAL detail = CONCAT(${count('human', 'human', 'humans', 'no humans')}, " · ", ${count('machine', 'machine', 'machine', 'no machine')}) | KEEP \`Identities\`, detail`,
      'Identities', 'Distinct identities in all traffic, resolved as email, then API key name, then user.name — one per row of Identity first and last seen. The line under the number splits them: humans have an email on their events (the Humans tile), machines do not (service accounts, API keys, internal and anonymous principals).',
      { secondary: 'detail' }),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Humans\` = COUNT_DISTINCT(attributes.user.email), sso = COUNT_DISTINCT(attributes.user.email) WHERE attributes.user.domain == "cloud-saml-kibana" | EVAL detail = CASE(sso == 0, "none signed in by SSO", CONCAT(TO_STRING(sso), " signed in by SSO")) | KEEP \`Humans\`, detail`,
      'Humans', 'Distinct email addresses in all traffic — the people Busiest human identities ranks. An Elasticsearch API key carries its creator\'s email, so a person can count here through a key they made without signing in; the line under the number says how many signed in through SAML SSO.',
      { secondary: 'detail' }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${KEYED} | STATS es = COUNT_DISTINCT(attributes.api_key.id), cloud = COUNT_DISTINCT(attributes.user.name) WHERE attributes.api_key.id IS NULL | EVAL \`API keys\` = es + cloud, detail = CASE(es + cloud == 0, "none in range", CONCAT(${count('cloud', 'Cloud', 'Cloud', 'no Cloud')}, " · ", ${count('es', 'ES', 'ES', 'no ES')})) | KEEP \`API keys\`, detail`,
      'API keys', 'Distinct API keys seen in range, of both kinds: Elastic Cloud API keys (recorded by id only) and Elasticsearch (ES) API keys (by id and name); the line under the number splits them. One per row of API key inventory. A re-issued Elasticsearch key keeps its name under a new id and counts again.',
      { secondary: 'detail' }),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain == "cloud-saml-kibana" | STATS \`SSO events\` = COUNT(*), logins = COUNT(*) WHERE attributes.event.action == "user_login" | EVAL detail = ${count('logins', 'new sign-in', 'new sign-ins', 'no new sign-ins')} | KEEP \`SSO events\`, detail`,
      'SSO events', 'Events authenticated through the cloud-saml-kibana SAML realm — a person in a browser. The line under the number counts Kibana user_login events: a session that began before the range shows events here but no new sign-in.',
      { secondary: 'detail' }),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS \`Failed or denied\` = COUNT(*), signin = COUNT(*) WHERE attributes.event.action IN (${SIGNIN_FAILED}) | EVAL after = \`Failed or denied\` - signin, detail = CONCAT(${count('signin', 'login', 'logins', 'no logins')}, " · ", CASE(after == 0, "none denied", CONCAT(TO_STRING(after), " denied"))) | KEEP \`Failed or denied\`, detail`,
      'Failed or denied', 'Failed sign-ins (authentication_failed, realm_authentication_failed, anonymous_access_denied) plus requests refused or failed after sign-in (access_denied and any failed outcome). The line under the number splits the two — failed logins, then denied (refused or failed after sign-in): a denial is an authenticated identity hitting a permission wall, not someone guessing credentials. Same predicate as the two failure panels below.',
      { secondary: 'detail' }),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.kibana.session.id IS NOT NULL | STATS \`Kibana sessions\` = COUNT_DISTINCT(attributes.kibana.session.id), people = COUNT_DISTINCT(attributes.user.email) | EVAL detail = CASE(\`Kibana sessions\` == 0, "none in range", ${count('people', 'person', 'people', 'no email recorded')}) | KEEP \`Kibana sessions\`, detail`,
      'Kibana sessions', 'Distinct Kibana browser sessions observed in range, and how many people (by email) they belong to.',
      { secondary: 'detail' }),
    // Bars, not a line. ES|QL returns no row for an interval without traffic, so a line ran straight
    // across a ten-minute gap as if requests had continued, and a type seen in one interval only (SAML,
    // Realm) was a single point with nothing to join — no mark at all. A bar is drawn where there is a
    // row and nowhere else. Grouped, not stacked: stacking on a log axis misstates every upper series.
    // The 0.5 floor gives a count of 1 a visible bar; log(1) is the axis floor otherwise.
    (() => {
      const p = xy(0, 5, 24, 12, 'Authentication method over time',
        `FROM ${IDX} | ${TIME} | WHERE attributes.authentication.type IS NOT NULL | STATS events = COUNT(*) BY ${BUCKET}, attributes.authentication.type | ${AUTH_LABEL} | SORT auth`,
        'events', 'Elasticsearch requests per interval by how they presented credentials: API key, token (SSO browser sessions and service accounts) or realm (username and password). One bar per credential type per interval, on a log scale, so a type carrying a fraction of a percent of the traffic is as readable as the bulk; an interval with no bar had no requests of that type. A shift in this mix is worth explaining.',
        { breakdown: 'auth', kind: 'bar', colors: CRED_TYPE_COLORS, yScale: 'log' });
      p.config.axis.y.domain = { type: 'custom', min: 0.5, max: 1000000, rounding: false };
      return p;
    })(),
    vega(24, 5, 24, 12, '02-auth-matrix', 'Credential type by identity',
      'Which credential type each of the 12 busiest identities presents; the stronger the fill, the more events (log scale; the legend lists the decades the chart spans). Humans should authenticate by token (SSO); service identities by API key. Only Elasticsearch requests record a credential type, so identities seen only in Kibana or only anonymously are counted in Identities above but are not on this chart. A Cloud API key has no name and is shown by its id.'),
    // Grouped on the raw email first, then classified: ORG reads only attributes.user.email, so the
    // CASE runs once per person instead of once per event.
    pie(0, 17, 12, 11, 'Events by identity origin',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY attributes.user.email | ${ORG} | STATS events = SUM(events) BY origin = actor_org`,
      'origin', 'events', 'Share of events, not of identities, by the email on the event: Elastic (@elastic.co), Tenant (any other address), or Machine (no email: service accounts, Cloud API keys, internal users and anonymous requests). One busy key can make Machine nearly all of it while most identities are people. An Elasticsearch API key carries its creator\'s email, so traffic from a key a person created counts under that person\'s origin.',
      { donut: 's', colors: { Machine: PALETTE[0], Elastic: PALETTE[1], Tenant: PALETTE[2] } }),
    pie(12, 17, 12, 11, 'Events by authentication realm',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain IS NOT NULL | STATS events = COUNT(*) BY attributes.user.domain | EVAL realm = CASE(attributes.user.domain == "cloud-saml-kibana", "SAML SSO", attributes.user.domain == "_es_api_key", "Elasticsearch API key", attributes.user.domain == "_cloud_api_key", "Cloud API key", STARTS_WITH(attributes.user.domain, "_service_account"), "Service account", STARTS_WITH(attributes.user.domain, "_"), "Other internal", attributes.user.domain) | STATS events = SUM(events) BY realm`,
      'realm', 'events', 'Share of events by the security realm that authenticated them. SAML SSO is interactive human sign-in (cloud-saml-kibana); Elasticsearch API key (_es_api_key) and Cloud API key (_cloud_api_key) are programmatic — an Elasticsearch key minted by a Cloud API key authenticates in the Cloud key\'s realm; Service account is Elastic\'s own components (_service_account). Any other realm is shown by its name.',
      { donut: 's', colors: { 'Cloud API key': PALETTE[0], 'Elasticsearch API key': PALETTE[1], 'Service account': PALETTE[2], 'SAML SSO': PALETTE[3], 'Other internal': PALETTE[4] } }),
    // Grouped on the raw key fields and derived afterwards; user.name is a group key because it IS the
    // id of a Cloud API key, and for an Elasticsearch key it is the one creator, so it never splits a key.
    table(24, 17, 24, 11, 'Busiest API keys',
      `FROM ${IDX} | ${TIME} | ${KEYED} | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY attributes.api_key.name, attributes.api_key.id, attributes.user.name | ${KEY_DERIVE} | SORT events DESC | LIMIT 15`,
      ['api_key', sized('key_id', 175), sized('kind', 105)], ['events', 'ips'],
      'The busiest API keys of both kinds, one row per key, with request volume and how many distinct client IPs used it. Kind is Cloud (an Elastic Cloud API key: no name, recorded by its id) or Elasticsearch (an Elasticsearch API key: id and name). A key used from many IPs is worth investigating. A re-issued key keeps its name under a new id, so a name can appear twice. The full list, with owner and first and last use, is API key inventory below.'),
    // Grouped on the email alone. user.full_name was a second key, but over 7 days it was empty on all
    // but 2 of ~11,600 events for the one SSO user, and on those 2 it held the email again — so it split
    // one person into two rows and otherwise filled a column with "-". The email is the person, and it
    // is the click filter. First and last seen are not repeated here: they are on Identity first and last
    // seen, for the same events. Without them this table fits 16 columns, and the failures beside it get
    // the 32 their identity and action columns need at a 1440px viewport.
    table(0, 28, 16, 12, 'Busiest human identities',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY attributes.user.email | SORT events DESC | LIMIT 15`,
      [WHO], ['events', 'ips'],
      'People by email, busiest first: the people the Humans tile counts, over all traffic, with the same event counts as Identity first and last seen, which also has when each was first and last seen. The panel shows the top rows; the rest are in that session. Click an email to pin that person across the suite.'),
    // Grouped on the raw identity fields and resolved afterwards (QUERY SHAPE rule 2): the COALESCE then
    // runs once per group instead of once per failed event. An action that is neither a failed sign-in
    // nor access_denied is here only because its outcome was failure, and without saying so a
    // saved_object_update row read as a normal operation — so it is labelled.
    table(16, 28, 32, 12, 'Most frequent failed or denied access',
      `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, action = attributes.event.action, ip = client.ip | ${ACTOR_RESOLVE} | STATS events = SUM(events), last_seen = MAX(last_seen) BY actor, action, ip | EVAL action = CASE(action IN (${SIGNIN_FAILED}, "access_denied"), action, CONCAT(COALESCE(action, "(no action)"), " · failed")) | SORT events DESC | LIMIT 15`,
      ['actor', sized('action', 200), 'ip'], ['events', 'last_seen'],
      'Failed sign-ins and refused requests grouped by identity, action and source IP, most frequent first; the top rows of what the Failed or denied tile counts. authentication_failed, realm_authentication_failed and anonymous_access_denied are failed sign-ins; access_denied is an authenticated identity refused an action; any other action is marked "· failed" — it is here because its outcome was failure.',
      { empty: 'good' }),
    // The sessions run full width. Side by side at 24 columns, seven and eight columns shared ~800px:
    // timestamps wrapped onto three lines and the last column was cut off at the panel edge. These are
    // the record-level evidence, so every column has to be readable without opening Discover.
    search(0, 40, 48, 12, '02-failed-authentications', 'Failed sign-ins and denied access, newest 1,000',
      'The newest failed sign-ins and refused requests, record by record. Discover stops at 1,000 rows, so on a busy range its result count is that cap and the Failed or denied tile is the total. Result names the kind: failed sign-in, denied (access_denied), or failed (any other failed outcome).',
      { empty: 'good' }),
    search(0, 52, 48, 12, '07-api-key-activity', 'API key inventory',
      'Every API key seen in range (up to 1,000), Cloud and Elasticsearch, busiest first — one row per key the API keys tile counts — with owner, volume, IP spread, indices touched and first and last use. Owner is the identity that created the key: a person\'s email, or for a key minted programmatically the id of the Cloud API key that minted it (its own row reads "(no name)"); a Cloud API key\'s own creator is not in the audit stream, so its Owner reads Cloud organisation.'),
    search(0, 64, 48, 14, '06-actor-first-seen', 'Identity first and last seen',
      'Every identity in range (up to 1,000), all traffic — one row per identity the Identities tile counts — with its first and last appearance, Events (everything it did, the same count as Busiest human identities) and Signal events (what is left after the noise gate, the count the gated panels across the suite use). Newest first appearance on top. Widen the time range to tell a brand-new identity from one that was simply quiet.'),
  ];
  return dash('cloud-audit-01-identity-access', '[Audit] 🔐 Identity & Access',
    'Who authenticated, how, from where, and what failed. Resolves the numeric user.name into real identities.', P);
}
