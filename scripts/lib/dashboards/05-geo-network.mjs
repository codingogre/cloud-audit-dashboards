/** 05 Geo & Network — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, IP_GEO, TIME, BUCKET, dash, kpi, xy, table, vega, filterable, sized, resetIds
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
 * so the reason is spelled out instead. Expects the `country` and `city` columns of IP_GEO, from a
 * STATS grouped BY client.ip only: `country` is then null exactly when `placed == 0`, so an address
 * that resolved on any event is placed, and only one that never resolved is called unplaceable.
 * (Grouped by the geo fields too, 65.185.62.22 printed twice at 24h — as Powell, and as "Public, no
 * geoip match" for its 391 events from before enrichment.)
 */
const LOCATION =
  `EVAL location = CASE(country IS NOT NULL, CONCAT(COALESCE(city, "city unknown"), ", ", country), ` +
  `CONCAT("Not placeable — ", ${ADDRESS_CLASS}))`;

/**
 * The partition behind every geographic panel, one row per reason. Counted per ADDRESS (QUERY SHAPE
 * rule 2, and IP_GEO's rule that only `placed == 0` is unplaceable), because the three field counts
 * the old donut used put a placeable address's pre-enrichment events under "IP not geolocatable" —
 * which "Why client IPs do not resolve", counting addresses, could not reconcile with.
 *
 *   Resolved                 events with a country: the map, Top client locations, travel
 *   IP not geolocatable      events from addresses that never resolved: "Why client IPs do not resolve"
 *   Predates geo enrichment  unresolved events of an address that did resolve (enrichment is forward-only)
 *   No client IP             nothing forwarded, mostly Elasticsearch transport traffic
 *
 * A table, not the donut it replaces: Lens drew the second-largest slice's label inside the ring
 * whenever that slice was ~40% (its outside label had no room at the top), the legend order followed
 * volume and swapped between 1h and 24h, and a 0.05% slice is invisible on a ring. Here the order is
 * fixed and every number sits beside the panel that explains it. The EVALs run on four rows.
 */
const GEO_STATUS = ['Resolved', 'IP not geolocatable', 'Predates geo enrichment', 'No client IP'];
const GEO_SHOWN = ['Map, locations, travel', 'Why client IPs do not resolve', 'IP tables, at the IP\'s place', 'Nowhere: no address to place'];
const GEO_RESOLUTION =
  `FROM ${IDX} | ${TIME} | STATS n = COUNT(*), placed = COUNT(client.geo.country_iso_code) BY client.ip ` +
  `| EVAL never = CASE(placed == 0, n, 0), late = n - placed, no_ip = CASE(client.ip IS NULL, n, 0) ` +
  `| STATS total = SUM(n), resolved = SUM(placed), never = SUM(never), late = SUM(late), no_ip = SUM(no_ip) ` +
  `| EVAL unplaceable = never - no_ip, late = late - never ` +
  `| EVAL ord = [0, 1, 2, 3] | MV_EXPAND ord ` +
  `| EVAL events = CASE(ord == 0, resolved, ord == 1, unplaceable, ord == 2, late, no_ip) ` +
  `| WHERE events > 0 OR ord == 0 ` +
  `| EVAL geo_status = CASE(${GEO_STATUS.slice(0, 3).map((g, i) => `ord == ${i}, "${g}"`).join(', ')}, "${GEO_STATUS[3]}"), ` +
  `shown_in = CASE(${GEO_SHOWN.slice(0, 3).map((g, i) => `ord == ${i}, "${g}"`).join(', ')}, "${GEO_SHOWN[3]}"), ` +
  `pct = ROUND(events * 100.0 / total, 1) ` +
  `| EVAL share = CASE(events > 0 AND pct < 0.1, "<0.1%", CONCAT(TO_STRING(pct), "%")) ` +
  `| SORT ord | KEEP geo_status, events, share, shown_in`;

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
    // legend collapsed, and parked North America under its own zoom controls. See the spec. The spec's
    // subtitle carries what the "About this data" note beside it used to say (client.ip, not the proxy):
    // a markdown panel's title renders smaller than every other title and its body at 16px against 12px
    // tables, with no API setting for either, and a code chip cannot wrap, so the note never sat right.
    vega(0, 5, 24, 13, '06-geo-origin', 'Audited traffic by country',
      'Audited events by real client country: client.ip, which ingest takes from network.forwarded_ip and geo-resolves; source.ip is only the proxy hop. Color is volume on a log scale, green (few) to purple (most); hover a country for events, identities and its share. The title line states how much of the stream could be placed at all — absence on the map is not absence of traffic, and "Geo resolution of audited events" says where the rest went.'),
    // A table rather than a bar chart: with one location the old bar filled the panel as a solid
    // block, and at 5-10x the cities its 25 rows overprinted their labels. A table keeps the exact
    // count beside each place and stops at the rows that fit. Half the row since the note left: at 12
    // columns its location column was under 120px at a 1440px viewport (a --lint advisory).
    table(24, 5, 24, 13, 'Top client locations',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), ips = COUNT_DISTINCT(client.ip) BY city = client.geo.city_name, country = client.geo.country_name | EVAL location = CONCAT(COALESCE(city, "city unknown"), ", ", country) | SORT events DESC | LIMIT 25`,
      ['location'], ['events', 'actors', { column: 'ips', label: 'Client IPs' }],
      'The busiest resolved client locations in range; the rest are beyond the panel. Events sum to the Geo-resolved events tile when every location fits. City is often the ISP\'s point of presence rather than where the person sits; country is reliable.'),
    // Every person with geo-resolved traffic, ranked — not only those over the threshold. Filtering to
    // `countries > 1` left the whole panel at "No results found" under a warning title whenever the
    // estate was clean, which read as a broken alert; ranked, the clean state is visible as such and a
    // traveller still sorts to the top at any volume. No Countries or Cities count: "Countries seen" and
    // Reading already say both things a count would, and with them the email column was cut at a 1440px
    // viewport ("shawn.hooton@elast"). City is the ISP's point of presence, not evidence of travel.
    table(0, 18, 24, 12, 'Countries per person (impossible travel)',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL AND client.geo.country_iso_code IS NOT NULL | STATS countries = COUNT_DISTINCT(client.geo.country_iso_code), ips = COUNT_DISTINCT(client.ip), events = COUNT(*), names = VALUES(client.geo.country_name) BY attributes.user.email | EVAL verdict = CASE(countries > 1, "Check travel", "One country"), seen_from = MV_CONCAT(MV_SORT(names), ", ") | SORT countries DESC, events DESC | LIMIT 15`,
      [filterable('attributes.user.email'), sized('verdict', 115, { label: 'Reading', min: 100 }), { column: 'seen_from', label: 'Countries seen' }],
      [{ column: 'ips', label: 'Client IPs' }, 'events'],
      'People (identities with an email) whose traffic resolved to a country in range, most countries first. Two or more countries inside one window is the classic impossible-travel indicator — compare "Countries seen" with where the person actually is. "One country" on every row is the clean state. Service credentials are excluded, since multi-region is normal for machines, and a person whose every address is unplaceable (CGNAT, private egress) cannot appear here — see Geo coverage. Click an email to scope the suite to that person.'),
    // One row per address (IP_GEO): grouped by the geo fields too, an address with events from before
    // enrichment printed twice — placed, and "not placeable" — and the table outgrew the Client IPs tile.
    // No "First seen": it was the first event IN RANGE, so two busy addresses read as "first seen" 4ms
    // apart at the window's start — a discovery time that was not one — and its 190px cut the location
    // ("Not placeable — Carrier N") at a 1440px viewport. Actor 360 carries first-seen per identity.
    table(24, 18, 24, 12, 'Busiest client IPs',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), ${IP_GEO} BY client.ip | ${LOCATION} | SORT events DESC | LIMIT 15`,
      [filterable('client.ip'), 'location'], ['events', 'actors'],
      'Real client IPs, busiest first, with where each resolved; the Client IPs tile counts every one, and the rest are beyond the panel. An IP shared by many identities is usually a NAT gateway or CI runner. An address that resolved on any event shows that place, even if some of its events predate geo enrichment. "Not placeable" means no event from it ever resolved — not an enrichment error: no geoip database can place an address in a private or CGNAT range; "Why client IPs do not resolve" accounts for every one. Click an IP to scope the suite to it.'),
    table(0, 30, 24, 9, 'Geo resolution of audited events', GEO_RESOLUTION,
      ['geo_status', { column: 'shown_in', label: 'Where it shows' }], ['events', sized('share', 90, { label: 'Share' })],
      `Every audited event in range, by whether it could be placed on a map. The Resolved share is the Geo coverage tile, and only those events appear on any geographic panel. "IP not geolocatable" is events from addresses that never resolved — private or CGNAT ranges no geoip database can place; the table beside breaks them down. "Predates geo enrichment" is events from an address that did resolve, sent before enrichment was in place (enrichment is forward-only). "No client IP" is mostly Elasticsearch transport traffic, which forwards no address at all.`),
    // h=9 rather than 12: there are only five address classes, and fitRows(9) is 7, so every row the
    // query can return is visible and the panel no longer carries ~200px of blank under one row.
    // Addresses with placed == 0 only (IP_GEO): selecting unresolved EVENTS called a resolvable public
    // address "Public, no geoip match" for its pre-enrichment events.
    table(24, 30, 24, 9, 'Why client IPs do not resolve',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), placed = COUNT(client.geo.country_iso_code) BY client.ip | WHERE placed == 0 | EVAL address_class = ${ADDRESS_CLASS} | STATS events = SUM(events), addresses = COUNT(*) BY address_class | SORT events DESC`,
      ['address_class'], ['events', 'addresses'],
      'Every forwarded client IP that never resolved in range, by address class; the events add up to the "IP not geolocatable" row beside. Carrier NAT and RFC1918 rows are expected — clients reaching the project through a NAT or private egress, whose addresses no geoip database can place — and are not an enrichment failure. A "Public, no geoip match" row WOULD be a geoip problem worth chasing. An address that resolved on any event is not here, even if some of its events predate enrichment.',
      { empty: 'empty when every IP placed' }),
    // By name, not ISO code, so the legend reads "United States". Countries under 5% of resolved
    // traffic fold into "Other": that caps the split at 19 named series in theory and a handful in
    // practice, and the right-hand legend (one per line) cannot clip the way a bottom row does — which
    // is why it keeps its ~140px even when one country is all there is.
    // Aggregated on the raw keyword first, so the fold runs over buckets, not events.
    xy(0, 39, 24, 12, 'Geo-resolved traffic over time, by country',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS events = COUNT(*) BY ts = ${BUCKET}, c = client.geo.country_name | INLINE STATS ctot = SUM(events) BY c | INLINE STATS total = SUM(events) | EVAL country = CASE(ctot >= total * 0.05, c, "Other") | STATS events = SUM(events) BY ts, country | SORT country`,
      'events', 'Resolved client traffic over time, split by country: events per bar, where each bar is a round interval sized so the range holds at most 75 of them (1 minute at 1h, 30 minutes at 24h, 3 hours at 7d). Countries under 5% of resolved events in range are folded into "Other". Unresolved events are not drawn — see Geo coverage.',
      { breakdown: 'country', xcol: 'ts', legend: 'right', colors: { Other: '#B9A888' }, yTitle: 'Events per bar' }),
    // Pairs, not proxies: the Client IP column is the point. Grouped BY the two raw addresses only, with
    // IP_GEO, for the same reason as Busiest client IPs. The proxy column is the raw field, labelled, so
    // it is a click-to-filter link like the client IP beside it (an ES|QL alias would cost the pill).
    table(24, 39, 24, 12, 'Proxy vs real client IP · top pairs',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS events = COUNT(*), ${IP_GEO} BY attributes.source.ip, client.ip | ${LOCATION} | SORT events DESC | LIMIT 15`,
      [filterable('attributes.source.ip', { label: 'Proxy IP', width: 125 }), filterable('client.ip'), 'location'], ['events'],
      'Side-by-side proof that source.ip is the internal proxy and client.ip (from network.forwarded_ip) is the real origin: the busiest proxy/client pairs, with the rest beyond the panel. Analysing the wrong field would put every user in the datacentre. Only proxies that forwarded a client address appear here, which is why the Proxy IPs tile can count more; the line beneath it counts the ones that did. Click either address to scope the suite to it.'),
  ];
  return dash('cloud-audit-05-geo-network', '[Audit] 🌍 Geo & Network',
    'Real client geography from forwarded_ip, geo-resolved at ingest. Impossible-travel detection.', P);
}
