/** 01 Identity & Access — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, ORG, TIME, BUCKET, dash, kpi, xy, table, pie, vega, search, resetIds
} from '../panels.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | ${ACTOR} | STATS \`Identities\` = COUNT_DISTINCT(actor)`, 'Identities', 'All distinct identities, human and machine.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Humans\` = COUNT_DISTINCT(attributes.user.email)`, 'Humans', 'Distinct human identities by email address.'),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Named API keys\` = COUNT_DISTINCT(attributes.api_key.name)`, 'Named API keys', 'Distinct named API keys seen authenticating in range.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain == "cloud-saml-kibana" | STATS \`SSO events\` = COUNT(*)`, 'SSO events', 'Events authenticated through the cloud-saml-kibana SAML realm — interactive human sign-in.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.event.outcome == "failure" OR attributes.event.action IN ("authentication_failed","realm_authentication_failed","anonymous_access_denied") | STATS \`Auth failures\` = COUNT(*)`, 'Auth failures', 'Failed authentications, denied access and any failed outcome — the same predicate as the Authentication failures table below, so the two always agree.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Kibana sessions\` = COUNT_DISTINCT(attributes.kibana.session.id)`, 'Kibana sessions', 'Distinct Kibana browser sessions observed in range.'),
    xy(0, 5, 24, 12, 'Authentication method over time',
      `FROM ${IDX} | ${TIME} | WHERE attributes.authentication.type IS NOT NULL | STATS events = COUNT(*) BY ${BUCKET}, auth = attributes.authentication.type`,
      'events', 'How credentials are presented over time: api_key, token or realm. A shift in this mix is worth explaining.', { breakdown: 'auth' }),
    vega(24, 5, 24, 12, '02-auth-matrix', 'Credential type by identity',
      'Matrix of which credential type each identity uses. Humans should authenticate via token/SAML; service identities via api_key.'),
    pie(0, 17, 12, 11, 'Identity origin',
      `FROM ${IDX} | ${TIME} | ${ACTOR} | ${ORG} | STATS events = COUNT(*) BY actor_org`,
      'actor_org', 'events', 'Traffic split by the email on the event: Elastic (@elastic.co), tenant (any other address, including API-key traffic, which carries the key creator’s email), or machine (no email at all).'),
    pie(12, 17, 12, 11, 'Authentication realm',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.domain IS NOT NULL | EVAL realm = CASE(attributes.user.domain == "cloud-saml-kibana", "SAML SSO", attributes.user.domain == "_es_api_key", "API key", attributes.user.domain) | STATS events = COUNT(*) BY realm`,
      'realm', 'events', 'Which security realm authenticated the request. SAML SSO is interactive human sign-in (cloud-saml-kibana); API key is programmatic (_es_api_key).'),
    table(24, 17, 24, 11, 'API key inventory',
      `FROM ${IDX} | ${TIME} | WHERE attributes.api_key.name IS NOT NULL | STATS events = COUNT(*), ips = COUNT_DISTINCT(client.ip) BY api_key = attributes.api_key.name, key_id = attributes.api_key.id, owner = attributes.user.email | SORT events DESC | LIMIT 15`,
      ['api_key', 'key_id', 'owner'], ['events', 'ips'],
      'Every named API key, the human it is attributed to, its request volume and how many distinct client IPs used it. A key appearing from many IPs is worth investigating.'),
    table(0, 28, 24, 12, 'Human identity footprint',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL | STATS events = COUNT(*), first_seen = MIN(@timestamp), last_seen = MAX(@timestamp), ips = COUNT_DISTINCT(client.ip) BY user = attributes.user.email, name = attributes.user.full_name | SORT events DESC | LIMIT 15`,
      ['user', 'name'], ['events', 'first_seen', 'last_seen', 'ips'],
      'Human users with first/last seen and client IP spread. attributes.user.name is a numeric id, so the display name comes from user.full_name.'),
    table(24, 28, 24, 12, 'Authentication failures',
      `FROM ${IDX} | ${TIME} | WHERE attributes.event.action IN ("authentication_failed","realm_authentication_failed","anonymous_access_denied") OR attributes.event.outcome == "failure" | ${ACTOR} | STATS events = COUNT(*), last_seen = MAX(@timestamp) BY actor, action = attributes.event.action, ip = client.ip | SORT events DESC | LIMIT 15`,
      ['actor', 'action', 'ip'], ['events', 'last_seen'],
      'Failed authentication and denied access grouped by identity and source IP. Empty is good.'),
    search(0, 40, 24, 14, '07-api-key-activity', 'API key activity', 'Named API keys with ownership and volume, as a pivotable Discover session.'),
    search(24, 40, 24, 14, '02-failed-authentications', 'Failed authentications', 'Every failed or denied authentication event, newest first.'),
    search(0, 54, 48, 14, '06-actor-first-seen', 'Actor first-seen and footprint',
      'Every identity with when it first and last appeared, its event count, and how many IPs and countries it came from. A brand-new identity near the top is worth a question.'),
  ];
  return dash('cloud-audit-01-identity-access', '[Audit] 🔐 Identity & Access',
    'Who authenticated, how, from where, and what failed. Resolves the numeric user.name into real identities.', P);
}
