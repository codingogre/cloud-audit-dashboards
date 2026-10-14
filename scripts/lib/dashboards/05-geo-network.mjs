/** 05 Geo & Network — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, TIME, BUCKET, PALETTE, dash, kpi, xy, table, pie, vega, md, filterable, sized, resetIds
} from '../panels.mjs';

/**
 * Why an address that reached the audit stream could not be placed, by address class. One CASE, used
 * by the breakdown table and by the Location column of both IP tables, so "carrier NAT" means the
 * same rows wherever it is printed. It reads only `client.ip`, so it runs AFTER a STATS grouped on
 * that raw field — once per address rather than once per event (QUERY SHAPE rule 2 in panels.mjs).
 */
const ADDRESS_CLASS =
  'CASE(CIDR_MATCH(client.ip, "100.64.0.0/10"), "Carrier NAT (CGNAT)", ' +
  'CIDR_MATCH(client.ip, "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"), "Private (RFC1918)", ' +
  'CIDR_MATCH(client.ip, "127.0.0.0/8"), "Loopback", CIDR_MATCH(client.ip, "169.254.0.0/16"), "Link-local", ' +
  '"Public, no geoip match")';

/**
 * One readable place for an address. Lens prints a null cell as "-", which reads as missing data,
 * when for these rows it is a finding in its own right — an address no geoip database can place —
 * so the reason is spelled out instead. Expects `city` and `country` columns from the STATS.
 */
const LOCATION =
  `EVAL location = CASE(country IS NOT NULL, CONCAT(COALESCE(city, "city unknown"), ", ", country), ` +
  `CONCAT("Not placeable — ", ${ADDRESS_CLASS}))`;

/**
 * The note beside the map. Kept short on purpose: at 1920px a longer draft already filled the panel,
 * at 1440px it is ~320px wide (rendered: a three-paragraph draft's last line sat on the border), and a
 * code span (the full pipeline name used to be one) cannot wrap, so a longer note scrolls or clips. The NAT sentence is about `client.ip`, because the tables beside
 * it show real client IPs in 100.64/10 — the old "100.64 is the proxy" wording read as contradicting them.
 */
const GEO_NOTE = `**Location is \`client.ip\`**, the real client from \`network.forwarded_ip\`,
geo-resolved at ingest, so older events have none. \`source.ip\` is only a proxy hop.

**Unplaceable IPs are expected:** clients behind carrier or private NAT forward
\`100.64.x.x\` or \`10.x.x.x\` addresses no geoip database can place.`;

/**
 * Slice names, pinned to PALETTE hues so resolved and unplaceable read as different things on both
 * themes (the default palette drew them as two tints of one teal). "No client IP" is a ~2% sliver
 * whose outside label Lens drops at this height, so pie()'s legend is what names it.
 */
const RESOLVED = 'Resolved';
const UNPLACEABLE = 'IP not geolocatable';
const NO_IP = 'No client IP';
const GEO_COLORS = { [RESOLVED]: PALETTE[0], [UNPLACEABLE]: PALETTE[5], [NO_IP]: PALETTE[1] };

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS \`Geo-resolved events\` = COUNT(*)`, 'Geo-resolved events', 'Events with a resolved client location.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS total = COUNT(*), resolved = COUNT(client.geo.country_iso_code) | EVAL \`Geo coverage\` = ROUND(resolved * 1.0 / total, 4) | KEEP \`Geo coverage\``, 'Geo coverage',
      `Share of audited events that resolve to a country — the honest denominator for every geographic panel here. It can be low: events with no forwarded IP, and forwarded addresses in private or CGNAT ranges, cannot be placed by any geoip database. "Geo resolution of audited events" and "Why client IPs do not resolve" break it down.`,
      { fmt: 'percent', dec: 1 }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Cities\` = COUNT_DISTINCT(client.geo.city_name)`, 'Cities', 'Distinct client cities.'),
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Client IPs\` = COUNT_DISTINCT(client.ip)`, 'Client IPs', 'Distinct real client IPs, taken from network.forwarded_ip.'),
    // The secondary reconciles this tile with "Proxy vs real client IP", which lists only the proxies
    // that forwarded a client address: without it the tile said 7 and the table showed 4.
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Proxy IPs\` = COUNT_DISTINCT(attributes.source.ip), fwd = COUNT_DISTINCT(attributes.source.ip) WHERE client.ip IS NOT NULL | EVAL detail = CONCAT(TO_STRING(fwd), " forwarded a client IP") | KEEP \`Proxy IPs\`, detail`, 'Proxy IPs',
      'Distinct source.ip values — these are internal proxies, not clients. Shown to make the difference explicit. The line beneath counts the ones that forwarded a real client IP, which are the proxies "Proxy vs real client IP" can list.',
      { secondary: 'detail' }),
    // A bare 0 here meant either "nobody travelled" or "only one country is visible at all", and those
    // need opposite readings — so the secondary says which. Grouped on the raw email rather than the
    // actor COALESCE: the WHERE already requires an email, so they are the same identity, and the raw
    // keyword groups faster (QUERY SHAPE rule 2). STATS over zero rows still returns one row (maxc null), which is
    // what lets the first CASE branch fire on an empty window. The phrases stay ~16 characters: at a
    // 1440px viewport the tile is ~210px wide and "everyone from one country" was cut mid-word.
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL AND client.geo.country_iso_code IS NOT NULL | STATS c = COUNT_DISTINCT(client.geo.country_iso_code) BY attributes.user.email | STATS \`Multi-country people\` = COUNT(*) WHERE c > 1, maxc = MAX(c) | EVAL detail = CASE(maxc IS NULL, "no person placed", maxc < 2, "one country each", "in 2+ countries") | KEEP \`Multi-country people\`, detail`, 'Multi-country people',
      'Human identities seen from more than one country in range — the impossible-travel signal. Service credentials are excluded: for machine credentials, multi-region is the normal case, not an anomaly. The line beneath says whether a 0 is a clean reading or just one country in view.',
      { secondary: 'detail' }),
    // The map is a Vega choropleth, not Lens region_map: region_map takes no palette, legend or extent
    // through the Dashboards API, so it drew one alert-red fill over the basemap's labels, kept its
    // legend collapsed, and parked North America under its own zoom controls. See the spec.
    vega(0, 5, 24, 13, '06-geo-origin', 'Audited traffic by country',
      'Audited events by real client country (client.ip, geo-resolved at ingest). Shade is volume on a log scale; hover a country for events, identities and its share. The title line states how much of the stream could be placed at all — absence on the map is not absence of traffic.'),
    // A table rather than a bar chart: with one location the old bar filled the panel as a solid
    // block, and at 5-10x the cities its 25 rows overprinted their labels. A table keeps the exact
    // count beside each place and stops at the rows that fit.
    table(24, 5, 12, 13, 'Top client locations',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), ips = COUNT_DISTINCT(client.ip) BY city = client.geo.city_name, country = client.geo.country_name | EVAL location = CONCAT(COALESCE(city, "city unknown"), ", ", country) | SORT events DESC | LIMIT 25`,
      ['location'], ['events', 'actors', { column: 'ips', label: 'Client IPs' }],
      'The busiest resolved client locations in range. City is often the ISP\'s point of presence rather than where the person sits; country is reliable.'),
    md(36, 5, 12, 13, GEO_NOTE, { title: 'About this data' }),
    // Every person with geo-resolved traffic, ranked — not only those over the threshold. Filtering to
    // `countries > 1` left the whole panel at "No results found" under a warning title whenever the
    // estate was clean, which read as a broken alert; ranked, the clean state is visible as such and a
    // traveller still sorts to the top at any volume.
    table(0, 18, 24, 12, 'Countries per person (impossible travel)',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL AND client.geo.country_iso_code IS NOT NULL | STATS countries = COUNT_DISTINCT(client.geo.country_iso_code), cities = COUNT_DISTINCT(client.geo.city_name), ips = COUNT_DISTINCT(client.ip), events = COUNT(*), names = VALUES(client.geo.country_name) BY attributes.user.email | EVAL verdict = CASE(countries > 1, "Check travel", "One country"), seen_from = MV_CONCAT(MV_SORT(names), ", ") | SORT countries DESC, events DESC | LIMIT 15`,
      [filterable('attributes.user.email'), sized('verdict', 115, { label: 'Reading', min: 100 }), { column: 'seen_from', label: 'Countries seen' }],
      ['countries', 'cities', { column: 'ips', label: 'Client IPs' }, 'events'],
      'People (identities with an email) whose traffic resolved to a country in range, most countries first. Two or more countries inside one window is the classic impossible-travel indicator — compare "Countries seen" with where the person actually is. "One country" on every row is the clean state. Service credentials are excluded, since multi-region is normal for machines, and a person whose every address is unplaceable (CGNAT, private egress) cannot appear here — see Geo coverage. Click an email to scope the suite to that person.'),
    table(24, 18, 24, 12, 'Client IP footprint',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), first_seen = MIN(@timestamp) BY client.ip, city = client.geo.city_name, country = client.geo.country_name | ${LOCATION} | SORT events DESC | LIMIT 15`,
      [filterable('client.ip'), 'location'], ['events', 'actors', 'first_seen'],
      'Real client IPs with their resolved location. An IP shared by many identities is usually a NAT gateway or CI runner. "Not placeable" is not an enrichment error — no geoip database can place an address in a private or CGNAT range; "Why client IPs do not resolve" accounts for every one of them. Click an IP to scope the suite to it.'),
    // Three field counts, then one row per slice. The per-event CASE this replaces took ~1.9s at 1h;
    // COUNT(field) is answered from doc values and costs what the Geo coverage tile does (~40ms).
    // The slices are the same partition: an event with no client IP cannot have a country.
    pie(0, 30, 24, 9, 'Geo resolution of audited events',
      `FROM ${IDX} | ${TIME} | STATS total = COUNT(*), with_ip = COUNT(client.ip), resolved = COUNT(client.geo.country_iso_code) | EVAL geo_status = ["${RESOLVED}", "${UNPLACEABLE}", "${NO_IP}"] | MV_EXPAND geo_status | EVAL events = CASE(geo_status == "${RESOLVED}", resolved, geo_status == "${NO_IP}", total - with_ip, with_ip - resolved) | KEEP geo_status, events | SORT events DESC`,
      'geo_status', 'events',
      `The denominator behind the map: only the "${RESOLVED}" slice appears on any geographic panel. "${UNPLACEABLE}" means a client IP was forwarded but sits in a range no geoip database can place (see the table beside). "${NO_IP}" is mostly Elasticsearch transport traffic, which carries no forwarded address at all.`,
      { labels: 'outside', colors: GEO_COLORS }),
    // h=9 rather than 12: there are only five address classes, and fitRows(9) is 7, so every row the
    // query can return is visible and the panel no longer carries ~200px of blank under one row.
    table(24, 30, 24, 9, 'Why client IPs do not resolve',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL AND client.geo.country_iso_code IS NULL | STATS events = COUNT(*) BY client.ip | EVAL address_class = ${ADDRESS_CLASS} | STATS events = SUM(events), addresses = COUNT(*) BY address_class | SORT events DESC`,
      ['address_class'], ['events', 'addresses'],
      'Every forwarded client IP that did not resolve, by address class. Carrier NAT and RFC1918 rows are expected — clients reaching the project through a NAT or private egress, whose addresses no geoip database can place — and are not an enrichment failure. A "Public, no geoip match" row WOULD be a geoip problem worth chasing.'),
    // By name, not ISO code, so the legend reads "United States". Countries under 5% of resolved
    // traffic fold into "Other": that caps the split at 19 named series in theory and a handful in
    // practice, and the right-hand legend (one per line) cannot clip the way a bottom row does.
    // Aggregated on the raw keyword first, so the fold runs over buckets, not events.
    xy(0, 39, 24, 12, 'Geo-resolved traffic over time, by country',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS events = COUNT(*) BY ts = ${BUCKET}, c = client.geo.country_name | INLINE STATS ctot = SUM(events) BY c | INLINE STATS total = SUM(events) | EVAL country = CASE(ctot >= total * 0.05, c, "Other") | STATS events = SUM(events) BY ts, country`,
      'events', 'Resolved client traffic over time, split by country. Countries under 5% of resolved events in range are folded into "Other". Unresolved events are not drawn — see Geo coverage.',
      { breakdown: 'country', xcol: 'ts', legend: 'right', colors: { Other: '#B9A888' } }),
    table(24, 39, 24, 12, 'Proxy vs real client IP',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*) BY proxy = attributes.source.ip, client.ip, city = client.geo.city_name, country = client.geo.country_name | ${LOCATION} | SORT events DESC | LIMIT 15`,
      ['proxy', filterable('client.ip'), 'location'], ['events'],
      'Side-by-side proof that source.ip is the internal proxy and client.ip (from network.forwarded_ip) is the real origin; the busiest proxy/client pairs first. Analysing the wrong field would put every user in the datacentre. Only proxies that forwarded a client address appear here, which is why the Proxy IPs tile can count more.'),
  ];
  return dash('cloud-audit-05-geo-network', '[Audit] 🌍 Geo & Network',
    'Real client geography from forwarded_ip, geo-resolved at ingest. Impossible-travel detection.', P);
}
