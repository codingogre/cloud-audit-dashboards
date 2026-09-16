/** 05 Geo & Network — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR, TIME, BUCKET, dash, kpi, xy, table, pie, regionMap, vega, md, resetIds
} from '../panels.mjs';
import {
  GEO_NOTE
} from './shared.mjs';

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS \`Geo-resolved events\` = COUNT(*)`, 'Geo-resolved events', 'Events with a resolved client location.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS total = COUNT(*), resolved = COUNT(client.geo.country_iso_code) | EVAL \`Geo coverage\` = ROUND(resolved * 1.0 / total, 4) | KEEP \`Geo coverage\``, 'Geo coverage',
      'Share of audited events that resolve to a country — the honest denominator for every geographic panel here. It can be low: events with no forwarded IP, and forwarded addresses in private or CGNAT ranges, cannot be placed by any geoip database. "Why client IPs do not resolve" breaks it down.',
      { fmt: 'percent', dec: 1 }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Cities\` = COUNT_DISTINCT(client.geo.city_name)`, 'Cities', 'Distinct client cities.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Client IPs\` = COUNT_DISTINCT(client.ip)`, 'Client IPs', 'Distinct real client IPs, taken from network.forwarded_ip.'),
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Proxy IPs\` = COUNT_DISTINCT(attributes.source.ip)`, 'Proxy IPs', 'Distinct source.ip values — these are internal proxies, not clients. Shown to make the difference explicit.'),
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL AND attributes.user.email IS NOT NULL | ${ACTOR} | STATS c = COUNT_DISTINCT(client.geo.country_iso_code) BY actor | WHERE c > 1 | STATS \`Multi-country people\` = COUNT(*)`, 'Multi-country people', 'Human identities seen from more than one country in range — the impossible-travel signal. Service credentials are excluded: for machine credentials, multi-region is the normal case, not an anomaly.'),
    regionMap(0, 5, 24, 13, 'Audited traffic by country',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS events = COUNT(*) BY country = client.geo.country_iso_code | SORT events DESC`,
      'country', 'events', 'Choropleth of audited events by client country, joined to Elastic Maps world boundaries on ISO country code.'),
    vega(24, 5, 12, 13, '06-geo-origin', 'Client origin by city', 'Where audited traffic actually comes from, resolved from the real client IP at ingest.'),
    md(36, 5, 12, 13, GEO_NOTE),
    table(0, 18, 24, 12, '⚠️ Multi-country identities (impossible travel)',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL AND attributes.user.email IS NOT NULL | ${ACTOR} | STATS countries = COUNT_DISTINCT(client.geo.country_iso_code), cities = COUNT_DISTINCT(client.geo.city_name), ips = COUNT_DISTINCT(client.ip), events = COUNT(*) BY actor | WHERE countries > 1 | SORT countries DESC, events DESC | LIMIT 15`,
      ['actor'], ['countries', 'cities', 'ips', 'events'],
      'Identities observed from more than one country inside the selected window. For a human identity this is the classic impossible-travel indicator; for a service key it usually means multi-region infrastructure.'),
    table(24, 18, 24, 12, 'Client IP footprint',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | ${ACTOR} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), first_seen = MIN(@timestamp) BY ip = client.ip, city = client.geo.city_name, country = client.geo.country_iso_code | SORT events DESC | LIMIT 15`,
      ['ip', 'city', 'country'], ['events', 'actors', 'first_seen'],
      'Real client IPs with their resolved location. An IP shared by many actors is usually a NAT gateway or CI runner. A null city and country is not necessarily an error — no geoip database can place an address in a private or CGNAT range; "Why client IPs do not resolve" below accounts for every one of them.'),
    pie(0, 30, 24, 12, 'Geo resolution of audited events',
      `FROM ${IDX} | ${TIME} | EVAL geo_status = CASE(client.ip IS NULL, "No client IP on the event", client.geo.country_iso_code IS NOT NULL, "Resolved to a country", "Client IP present, not resolvable") | STATS events = COUNT(*) BY geo_status | SORT events DESC`,
      'geo_status', 'events',
      'The denominator behind the map: only the "Resolved to a country" slice appears on any geographic panel. "No client IP" is mostly Elasticsearch transport traffic, which carries no forwarded address at all.'),
    table(24, 30, 24, 12, 'Why client IPs do not resolve',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL AND client.geo.country_iso_code IS NULL | EVAL kind = CASE(CIDR_MATCH(client.ip, "100.64.0.0/10"), "CGNAT 100.64/10 (carrier NAT)", CIDR_MATCH(client.ip, "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"), "RFC1918 private", CIDR_MATCH(client.ip, "127.0.0.0/8"), "loopback", CIDR_MATCH(client.ip, "169.254.0.0/16"), "link-local", "public, unresolved") | STATS events = COUNT(*), addresses = COUNT_DISTINCT(client.ip) BY kind | SORT events DESC`,
      ['kind'], ['events', 'addresses'],
      'Every lifted client IP that did not resolve, bucketed by address class. CGNAT and RFC1918 rows are expected — clients reaching the project through a NAT or private egress, whose addresses no geoip database can place — and are not an enrichment failure. A "public, unresolved" row appearing here WOULD be a geoip problem worth chasing.'),
    xy(0, 42, 24, 12, 'Traffic by country over time',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS events = COUNT(*) BY ${BUCKET}, country = client.geo.country_iso_code`,
      'events', 'Client country mix over time.', { breakdown: 'country' }),
    table(24, 42, 24, 12, 'Proxy vs real client IP',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*) BY proxy = attributes.source.ip, client_ip = client.ip, city = client.geo.city_name | SORT events DESC | LIMIT 15`,
      ['proxy', 'client_ip', 'city'], ['events'],
      'Side-by-side proof that source.ip is the internal proxy and client.ip (from network.forwarded_ip) is the real origin. Analysing the wrong field would put every user in the datacentre.'),
  ];
  return dash('cloud-audit-05-geo-network', '[Audit] 🌍 Geo & Network',
    'Real client geography from forwarded_ip, geo-resolved at ingest. Impossible-travel detection.', P);
}
