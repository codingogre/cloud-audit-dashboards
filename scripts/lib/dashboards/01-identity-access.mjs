/** 01 Identity & Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ACTOR_RESOLVE, ORG, TIME, BUCKET, PALETTE, PALETTE_ID, dash, kpi, xy, table, sized, pie, vega, search, resetIds
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

/**
 * attributes.authentication.type in words. Applied AFTER the STATS that groups on the raw field, so it
 * runs once per bucket rather than once per event (QUERY SHAPE rule 2 in panels.mjs). vega/02 carries
 * the same CASE as literal text, so the matrix and the chart beside it name credentials identically.
 * "saml" is real on serverless (a SAML sign-in that has not yet been exchanged for a token): it was
 * missing here, so it reached the legend lowercase.
 */
const AUTH_LABEL =
  'EVAL auth = CASE(attributes.authentication.type == "api_key", "API key", ' +
  'attributes.authentication.type == "token", "Token", attributes.authentication.type == "realm", "Realm", ' +
  'attributes.authentication.type == "saml", "SAML", ' +
  'attributes.authentication.type == "anonymous", "Anonymous", attributes.authentication.type == "internal", "Internal", ' +
  'attributes.authentication.type)';

/**
 * Every AUTH_LABEL value pinned. An unpinned breakdown value takes PALETTE in order, starting at [0],
 * which API key already holds: unpinned, "saml" (one event in 30 days) rendered as a second green line
 * indistinguishable from API key. Pinning every label the CASE can produce leaves only a type
 * Elasticsearch has not documented able to collide.
 */
const AUTH_COLORS = { 'API key': PALETTE[0], Token: PALETTE[1], Realm: PALETTE[2], SAML: PALETTE[3], Anonymous: PALETTE[5], Internal: PALETTE[7] };

/**
 * An API key's owner, applied after the STATS that groups on `owner = attributes.user.email`.
 * Elasticsearch stamps the creator's email on events from a key a person created; a Cloud API key
 * carries no email at all. A bare "-" in every row read as a broken column, so the empty case says so.
 * Naming the key kind here as well ("Cloud API key") needed attributes.user.domain as a further group
 * key, which measured ~5ms slower on searches/07, so the descriptions say it instead. Same text as there.
 */
const KEY_OWNER = 'EVAL owner = COALESCE(owner, "none recorded")';

/**
 * A donut with a legend instead of callouts. pie()'s API defaults draw every slice name OUTSIDE the
 * ring, so the sub-1% realms stacked their leader lines in one corner and a long name was cut to
 * "_service_...". A right legend lists every slice in full; inside labels carry the percentage where a
 * slice is big enough to hold one and are dropped where it is not. The default legend width cut
 * "Elasticsearch API key" to "Elasticsearc…" (rendered), so it is `size: 'l'` (a size enum the 9.6
 * validator accepts only beside a left/right legend). The pie legend has no per-entry value option,
 * so the percentages have to stay on the slices. Every key was read back from a deployed panel
 * (GET /api/dashboards). Kept local until pie() grows the option.
 *
 * `colors` pins each slice to a PALETTE colour. Unpinned, colours follow slice ORDER, which follows
 * volume, so the same realm came out pink in one render and blue in the next.
 */
const keyed = (p, colors) => {
  p.config.legend = { visibility: 'visible', position: 'right', size: 'l' };
  p.config.styling = { ...p.config.styling, labels: { visible: true, position: 'inside' },
    values: { visible: true, mode: 'percentage', percent_decimals: 1 } };
  const mapping = Object.entries(colors).map(([v, hex]) => ({ values: [v], color: { type: 'color_code', value: hex } }));
  p.config.group_by = p.config.group_by.map((g) => ({ ...g, color: { mode: 'categorical', palette: PALETTE_ID, mapping } }));
  return p;
};

/**
 * A log y axis. API keys carry ~99.6% of credentialed requests, so as stacked bars every other type
 * was a 1px cap on the API-key bar and the mix the panel exists to show could not be read. Lines on a
 * log axis keep a type at 5 a minute as legible as one at 5,000. `axis.y.scale` was read back from a
 * deployed panel. Kept local until xy() grows the option.
 */
const logScale = (p) => {
  p.config.axis.y.scale = 'log';
  return p;
};

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS \`Identities\` = COUNT_DISTINCT(actor)`, 'Identities', 'All distinct identities, human and machine.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Humans\` = COUNT_DISTINCT(attributes.user.email)`, 'Humans', 'Distinct human identities by email address.'),
    // Counted by id, not name: the inventory below is one row per key id, and a re-issued key keeps its
    // name under a new id. Counting names made this tile disagree with the table under it (8 vs 10).
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.id IS NOT NULL | STATS \`API keys\` = COUNT_DISTINCT(attributes.api_key.id), names = COUNT_DISTINCT(attributes.api_key.name) | EVAL detail = CASE(names == 0, "none in range", CONCAT("under ", TO_STRING(names), CASE(names == 1, " name", " names"))) | KEEP \`API keys\`, detail`,
      'API keys', 'Distinct API key ids seen authenticating in range, and how many names they go by. A re-issued key keeps its name under a new id, so there can be fewer names than keys.',
      { secondary: 'detail' }),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain == "cloud-saml-kibana" | STATS \`SSO events\` = COUNT(*)`, 'SSO events', 'Events authenticated through the cloud-saml-kibana SAML realm — interactive human sign-in.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS \`Failed or denied\` = COUNT(*), signin = COUNT(*) WHERE attributes.event.action IN (${SIGNIN_FAILED}) | EVAL detail = CONCAT(TO_STRING(signin), CASE(signin == 1, " failed sign-in · ", " failed sign-ins · "), TO_STRING(\`Failed or denied\` - signin), " denied") | KEEP \`Failed or denied\`, detail`,
      'Failed or denied', 'Failed sign-ins (authentication_failed, realm_authentication_failed, anonymous_access_denied) plus requests refused or failed after sign-in (access_denied and any failed outcome). The line under the number splits the two: a denial is an authenticated identity hitting a permission wall, not someone guessing credentials. Same predicate as the Failed or denied access table, so the two always agree.',
      { secondary: 'detail' }),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Kibana sessions\` = COUNT_DISTINCT(attributes.kibana.session.id)`, 'Kibana sessions', 'Distinct Kibana browser sessions observed in range.'),
    logScale(xy(0, 5, 24, 12, 'Authentication method over time',
      `FROM ${IDX} | ${TIME} | WHERE attributes.authentication.type IS NOT NULL | STATS events = COUNT(*) BY ${BUCKET}, attributes.authentication.type | ${AUTH_LABEL}`,
      'events', 'Elasticsearch requests per interval by how they presented credentials: API key, token (SSO browser sessions and service accounts) or realm (username and password). Log scale, one line per credential type, so a type carrying a fraction of a percent of the traffic is as readable as the bulk. A shift in this mix is worth explaining.',
      { breakdown: 'auth', kind: 'line', colors: AUTH_COLORS })),
    vega(24, 5, 24, 12, '02-auth-matrix', 'Credential type by identity',
      'Which credential type each of the 12 busiest identities presents; the stronger the colour, the more events. Humans should authenticate by token (SSO); service identities by API key. Only Elasticsearch requests record a credential type, so identities seen only in Kibana or only anonymously are counted in Identities above but are not on this chart. A Cloud API key with no name is shown by its id.'),
    // Grouped on the raw email first, then classified: ORG reads only attributes.user.email, so the
    // CASE runs once per person instead of once per event, and ACTOR (which ORG never used) is gone.
    // The trailing CASE only fixes the case of ORG's labels for display, next to the realm donut's.
    keyed(pie(0, 17, 12, 11, 'Identity origin',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY attributes.user.email | ${ORG} | STATS events = SUM(events) BY actor_org | EVAL origin = CASE(actor_org == "machine", "Machine", actor_org == "tenant", "Tenant", actor_org)`,
      'origin', 'events', 'Traffic split by the email on the event: Elastic (@elastic.co), Tenant (any other address), or Machine (no email: service accounts, Cloud API keys, internal users and anonymous requests). An Elasticsearch API key carries its creator\'s email, so traffic from a key a person created counts under that person\'s origin.', { donut: 's' }),
      { Machine: PALETTE[0], Elastic: PALETTE[1], Tenant: PALETTE[2] }),
    keyed(pie(12, 17, 12, 11, 'Authentication realm',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain IS NOT NULL | STATS events = COUNT(*) BY attributes.user.domain | EVAL realm = CASE(attributes.user.domain == "cloud-saml-kibana", "SAML SSO", attributes.user.domain == "_es_api_key", "Elasticsearch API key", attributes.user.domain == "_cloud_api_key", "Cloud API key", STARTS_WITH(attributes.user.domain, "_service_account"), "Service account", STARTS_WITH(attributes.user.domain, "_"), "Other internal", attributes.user.domain) | STATS events = SUM(events) BY realm`,
      'realm', 'events', 'Which security realm authenticated the request. SAML SSO is interactive human sign-in (cloud-saml-kibana); Elasticsearch API key (_es_api_key) and Cloud API key (_cloud_api_key) are programmatic; Service account is Elastic\'s own components (_service_account). Any other realm is shown by its name.', { donut: 's' }),
      { 'Cloud API key': PALETTE[0], 'Elasticsearch API key': PALETTE[1], 'Service account': PALETTE[2], 'SAML SSO': PALETTE[3], 'Other internal': PALETTE[4] }),
    table(24, 17, 24, 11, 'Busiest API keys',
      `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.name IS NOT NULL | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY api_key = attributes.api_key.name, key_id = attributes.api_key.id, owner = attributes.user.email | ${KEY_OWNER} | SORT events DESC | LIMIT 15`,
      ['api_key', sized('key_id', 175), 'owner'], ['events', 'ips'],
      'The busiest API keys, one row per key id, with the owner (the creator\'s email, stamped on keys a person created; a Cloud API key records none), request volume and how many distinct client IPs used it. A key used from many IPs is worth investigating. A re-issued key keeps its name under a new id, so a name can appear twice. The full list, with first and last use, is API key inventory below.'),
    // Grouped on the email alone. user.full_name was a second key, but over 7 days it was empty on all
    // but 2 of ~11,600 events for the one SSO user, and on those 2 it held the email again — so it split
    // one person into two rows and otherwise filled a column with "-". The email is the person, and it
    // is the click filter.
    table(0, 28, 24, 12, 'Human identity footprint',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS events = COUNT(*), first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), ips = COUNT_DISTINCT(client.ip) BY attributes.user.email | SORT events DESC | LIMIT 15`,
      [WHO], ['events', 'first_seen', 'last_seen', 'ips'],
      'People by email, busiest first, with their first and last appearance in the selected range and how many client IPs they came from. Click an email to pin that person across the suite.'),
    // Grouped on the raw identity fields and resolved afterwards (QUERY SHAPE rule 2): the COALESCE then
    // runs once per group instead of once per failed event.
    table(24, 28, 24, 12, 'Failed or denied access',
      `FROM ${IDX} | ${TIME} | ${FAILED_OR_DENIED} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY attributes.user.email, attributes.api_key.name, attributes.user.name, action = attributes.event.action, ip = client.ip | ${ACTOR_RESOLVE} | STATS events = SUM(events), last_seen = MAX(last_seen) BY actor, action, ip | SORT events DESC | LIMIT 15`,
      ['actor', 'action', 'ip'], ['events', 'last_seen'],
      'Failed sign-ins and refused requests grouped by identity, action and source IP, most frequent first. authentication_failed, realm_authentication_failed and anonymous_access_denied are failed sign-ins; access_denied is an authenticated identity refused an action. Empty is good.'),
    // The sessions run full width. Side by side at 24 columns, seven and eight columns shared ~800px:
    // timestamps wrapped onto three lines and the last column was cut off at the panel edge. These are
    // the record-level evidence, so every column has to be readable without opening Discover.
    search(0, 40, 48, 12, '02-failed-authentications', 'Failed sign-ins and denied access',
      'Every failed sign-in and refused request, newest first. Read Action: authentication_failed, realm_authentication_failed and anonymous_access_denied are failed sign-ins; access_denied is an authenticated identity refused an action.'),
    search(0, 52, 48, 12, '07-api-key-activity', 'API key inventory',
      'Every API key id seen in range, busiest first, with owner, volume, IP spread, indices touched and first and last use.'),
    search(0, 64, 48, 14, '06-actor-first-seen', 'Identity first and last seen',
      'Every identity with its first and last appearance within the selected time range, its event count, and how many IPs, countries and actions it used. Newest first appearance on top. Widen the time range to tell a brand-new identity from one that was simply quiet. Noise gate applied, so counts run lower than on the panels above.'),
  ];
  return dash('cloud-audit-01-identity-access', '[Audit] 🔐 Identity & Access',
    'Who authenticated, how, from where, and what failed. Resolves the numeric user.name into real identities.', P);
}
