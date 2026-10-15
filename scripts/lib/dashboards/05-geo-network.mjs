/** 05 Geo & Network — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, IP_GEO, TIME, BUCKET, dash, kpi, xy, table, vega, filterable, sized, resetIds
} from '../panels.mjs';

/**
 * Why an address that reached the audit stream could not be placed, by address class. One CASE, used
 * by the resolution table and by the Location column of both IP tables, so a class means the same
 * rows wherever it is printed. It reads only `client.ip`, so it runs AFTER a STATS grouped on that raw
 * field — once per address rather than once per event (QUERY SHAPE rule 2 in panels.mjs).
 *
 * 100.64.0.0/10 is "Platform-internal", not "Carrier NAT". It is RFC 6598 shared address space, which
 * no internet-facing proxy receives from outside the provider's network — a client behind carrier NAT
 * reaches the ingress from the carrier's PUBLIC address — and every proxy hop (source.ip) is in the
 * same /10. Measured live (24h, 2026-10-14): the one such forwarded address, 100.64.234.34, is on
 * Elasticsearch events only (744,706 by the Cloud API key, 7,611 by SAML users), behind the same
 * proxies as the real client, and every one of those events carries an x-opaque-id that is the
 * http.request.id of a Kibana request whose own audit event carries the user's public address. It is
 * Kibana's server calling Elasticsearch for that user. Labelled "Carrier NAT (CGNAT)", 51–62% of the
 * stream was explained away as expected clients.
 */
const INTERNAL_NET = 'CIDR_MATCH(client.ip, "100.64.0.0/10")';
const INTERNAL = 'Platform-internal (100.64/10)';
const ADDRESS_CLASS =
  `CASE(${INTERNAL_NET}, "${INTERNAL}", ` +
  'CIDR_MATCH(client.ip, "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"), "Private (RFC1918)", ' +
  'CIDR_MATCH(client.ip, "127.0.0.0/8", "169.254.0.0/16"), "Loopback / link-local", ' +
  '"Public, no geoip match")';

/**
 * One readable place for an address. Lens prints a null cell as "-", which reads as missing data,
 * when for these rows it is a finding in its own right — an address no geoip database can place —
 * so the reason is spelled out instead. Expects the `country` and `city` columns of IP_GEO, from a
 * STATS grouped BY client.ip only: `country` is then null exactly when `placed == 0`, so an address
 * that resolved on any event is placed, and only one that never resolved is called unplaceable.
 * (Grouped by the geo fields too, 65.185.62.22 printed twice at 24h — as Powell, and as "Public, no
 * geoip match" for its 391 events from before enrichment.) A platform-internal hop is not a client
 * that failed to resolve, so it is named as what it is rather than prefixed "Not placeable".
 */
const LOCATION =
  `EVAL location = CASE(country IS NOT NULL, CONCAT(COALESCE(city, "city unknown"), ", ", country), ` +
  `${INTERNAL_NET}, "${INTERNAL}", CONCAT("Not placeable — ", ${ADDRESS_CLASS}))`;

/**
 * A share, rounded ONCE, in ES|QL, to the tenth of a percent every panel prints: the Geo coverage
 * tile, the map's title line (vega/06 embeds the same ROUND) and the Resolved row below all show this
 * value. Rounded twice — the tile to 4 places and then by Lens to one decimal, the table straight to
 * one — 37.349% printed as 37.4% on the tile and the map but 37.3% in the table.
 */
const SHARE = (num, den) => `ROUND(${num} * 1.0 / ${den}, 3)`;

/**
 * The partition behind every geographic panel, one row per reason, with the unplaceable addresses
 * broken out by address class. This replaces the separate "Why client IPs do not resolve" table, whose
 * rows had to add up to one row here, whose 1–4 rows sat in a 9-unit panel, and whose empty-state
 * suffix contradicted its rows. Counted per ADDRESS (QUERY SHAPE rule 2, and IP_GEO's rule that only
 * `placed == 0` is unplaceable): the classifying CASE runs once per address, and everything after the
 * second STATS runs on at most six rows.
 *
 *   Resolved                  events with a country: the map, Top client locations, travel
 *   <address class>           events from addresses that never resolved, one row per class
 *   Predates geo enrichment   unresolved events of an address that did resolve (enrichment is forward-only)
 *   No client IP              nothing forwarded, mostly Elasticsearch transport traffic
 *
 * The Resolved class carries both its placed and its pre-enrichment events, so MV_EXPAND splits it
 * into two rows. A table rather than the donut it replaced: Lens drew a ~40% slice's label inside the
 * ring, the legend order swapped between 1h and 24h, and a 0.05% slice was invisible.
 */
const GEO_RESOLUTION =
  `FROM ${IDX} | ${TIME} | STATS n = COUNT(*), placed = COUNT(client.geo.country_iso_code) BY client.ip ` +
  `| EVAL kind = CASE(client.ip IS NULL, "No client IP", placed > 0, "Resolved", ${ADDRESS_CLASS}), ` +
  `late_ip = CASE(placed > 0 AND n > placed, 1, 0) ` +
  `| STATS events = SUM(n), resolved = SUM(placed), addresses = COUNT(client.ip), late_ips = SUM(late_ip) BY kind ` +
  `| INLINE STATS total = SUM(events) ` +
  `| EVAL part = [1, 2] | MV_EXPAND part | WHERE part == 1 OR kind == "Resolved" ` +
  `| EVAL geo_status = CASE(part == 2, "Predates geo enrichment", kind), ` +
  `events = CASE(part == 2, events - resolved, kind == "Resolved", resolved, events), ` +
  `addresses = CASE(part == 2, late_ips, addresses) ` +
  `| WHERE events > 0 OR geo_status == "Resolved" ` +
  `| EVAL ord = CASE(geo_status == "Resolved", 0, part == 2, 2, kind == "No client IP", 3, 1), ` +
  `shown_in = CASE(geo_status == "Resolved", "Map, locations, travel", part == 2, "IP tables, at the IP's place", ` +
  `kind == "No client IP", "Nowhere: no address", kind == "${INTERNAL}", "IP tables, as internal", "IP tables, not placeable"), ` +
  `pct = ROUND(${SHARE('events', 'total')} * 100, 1) ` +
  `| EVAL share = CASE(events > 0 AND pct < 0.1, "<0.1%", CONCAT(TO_STRING(pct), "%")) ` +
  `| SORT ord, events DESC | KEEP geo_status, events, addresses, share, shown_in`;

/**
 * One row per proxy that forwarded a client address — exactly the set the Proxy IPs tile's line counts,
 * so the two reconcile row for row. As top PAIRS the table could not: 8 forwarding proxies × 2 clients
 * made 16+ pairs, and the 10 that fit held only 6 distinct proxies under a tile reading 8. Each row
 * still shows the point of the panel — the proxy beside the real client addresses it carried. Counted
 * by the two raw addresses first (QUERY SHAPE rule 2); the one-condition CASE that tags an internal
 * hop runs on those pairs, and the list is in address order, capped at three with a "+N more".
 */
const PROXIES =
  `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS n = COUNT(*) BY attributes.source.ip, client.ip ` +
  `| EVAL c = CASE(${INTERNAL_NET}, CONCAT(TO_STRING(client.ip), " (internal)"), TO_STRING(client.ip)) ` +
  `| STATS events = SUM(n), clients = COUNT(*), cs = VALUES(c) BY attributes.source.ip ` +
  `| EVAL forwarded_for = CONCAT(MV_CONCAT(MV_SLICE(MV_SORT(cs), 0, 2), ", "), CASE(clients > 3, CONCAT(" +", TO_STRING(clients - 3), " more"), "")) ` +
  `| KEEP attributes.source.ip, forwarded_for, clients, events | SORT events DESC | LIMIT 15`;

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS \`Geo-resolved events\` = COUNT(*)`, 'Geo-resolved events', 'Events with a resolved client location — the Resolved row of "Geo resolution of audited events", and the sum of Top client locations when every location fits.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS total = COUNT(*), resolved = COUNT(client.geo.country_iso_code) | EVAL \`Geo coverage\` = ${SHARE('resolved', 'total')} | KEEP \`Geo coverage\``, 'Geo coverage',
      `Share of audited events that resolve to a country — the honest denominator for every geographic panel here, and the same number as the map's title line and the Resolved share in "Geo resolution of audited events". It can be low: events with no forwarded IP, Kibana's own server-side calls into Elasticsearch (forwarded from a platform-internal 100.64/10 address), and private addresses cannot be placed by any geoip database. "Geo resolution of audited events" breaks it down.`,
      { fmt: 'percent', dec: 1 }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Cities\` = COUNT_DISTINCT(client.geo.city_name)`, 'Cities', 'Distinct client cities.'),
    // The secondary names the addresses that are platform hops rather than clients, so the count
    // reconciles with Busiest client IPs, which lists them under that label.
    // Grouped by the address first, then counted: exact, and as fast as the bare COUNT_DISTINCT
    // (164–188ms at 7d against 181–195ms), where two COUNT_DISTINCTs took 406–429ms.
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS BY client.ip | STATS \`Client IPs\` = COUNT(client.ip), internal = COUNT(client.ip) WHERE ${INTERNAL_NET} | EVAL detail = CASE(internal > 0, CONCAT(TO_STRING(internal), " platform-internal"), "none internal") | KEEP \`Client IPs\`, detail`, 'Client IPs',
      'Distinct forwarded client IPs, taken from network.forwarded_ip. The line beneath counts those in the platform-internal 100.64/10 range: not clients but a hop inside Elastic Cloud — on this project, Kibana\'s server calling Elasticsearch for a user whose real address is on the Kibana event. Busiest client IPs lists them as "Platform-internal (100.64/10)".',
      { secondary: 'detail' }),
    // The secondary reconciles this tile with "Proxy vs real client IP", which has one row per proxy
    // that forwarded a client address: without it the tile said 7 and the table showed 4.
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Proxy IPs\` = COUNT_DISTINCT(attributes.source.ip), fwd = COUNT_DISTINCT(attributes.source.ip) WHERE client.ip IS NOT NULL | EVAL detail = CONCAT(TO_STRING(fwd), " forwarded a client IP") | KEEP \`Proxy IPs\`, detail`, 'Proxy IPs',
      'Distinct source.ip values — these are internal proxies, not clients. Shown to make the difference explicit. The line beneath counts the ones that forwarded a real client IP: the rows of "Proxy vs real client IP, by proxy".',
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
    // through the Dashboards API. See the spec. Its subtitle carries what an "About this data" note
    // used to say (client.ip, not the proxy). 16 units tall so the two tables beside it — the places
    // it shows and where the rest of the stream went — stack in its height instead of one table
    // holding one row in a 13-unit card.
    vega(0, 5, 24, 16, '06-geo-origin', 'Audited traffic by country',
      'Audited events by real client country: client.ip, which ingest takes from network.forwarded_ip and geo-resolves; source.ip is only the proxy hop. Color is volume on a log scale, teal (few) through blue and purple to pink (most); the legend appears once two or more countries are shaded, since one country has no range to read. Hover a country for events, identities and its share. The title line states how much of the stream could be placed at all — the same number as the Geo coverage tile, computed the same way (the map fetches on its own, so in a busy last hour it can be a tenth of a point apart while new events land) — and "Geo resolution of audited events" beside it says where the rest went: absence on the map is not absence of traffic.'),
    // A table rather than a bar chart: with one location the old bar filled the panel as a solid
    // block, and at 5-10x the cities its 25 rows overprinted their labels. A table keeps the exact
    // count beside each place and stops at the rows that fit.
    table(24, 5, 24, 7, 'Top client locations',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), ips = COUNT_DISTINCT(client.ip) BY city = client.geo.city_name, country = client.geo.country_name | EVAL location = CONCAT(COALESCE(city, "city unknown"), ", ", country) | SORT events DESC | LIMIT 25`,
      ['location'], [{ column: 'events', label: 'Placed events' }, 'actors', { column: 'ips', label: 'Client IPs' }],
      'The busiest resolved client locations in range, counting placed events only — the events the map shades. They sum to the Geo-resolved events tile when every location fits. An address\'s events from before geo enrichment are not here; Busiest client IPs counts them at the address\'s place, so its Events can be higher by the "Predates geo enrichment" row, and its "Placed" column is this one. City is often the ISP\'s point of presence rather than where the person sits; country is reliable.'),
    table(24, 12, 24, 9, 'Geo resolution of audited events', GEO_RESOLUTION,
      [sized('geo_status', 190, { label: 'Resolution', min: 175 }), { column: 'shown_in', label: 'Where it shows' }],
      ['events', 'addresses', sized('share', 70, { label: 'Share' })],
      `Every audited event in range, by whether it could be placed on a map, with the addresses behind each row. The Resolved share is the Geo coverage tile and the map's title line, and only those events appear on any geographic panel. "Platform-internal (100.64/10)" is not a client that failed to resolve: the address is a hop inside Elastic Cloud — on this project, Kibana's server calling Elasticsearch on behalf of a user, whose real address is on the Kibana event for the same request. "Private (RFC1918)" and "Loopback / link-local" are clients reaching the project over a private network, which no geoip database can place; a "Public, no geoip match" row WOULD be a geoip problem worth chasing. "Predates geo enrichment" is events from an address that did resolve, sent before enrichment was in place (enrichment is forward-only). "No client IP" is mostly Elasticsearch transport traffic, which forwards no address at all. Shares are rounded one by one, so they can sum to 99.9% or 100.1%.`,
      { cut: false }),
    // Every person with geo-resolved traffic, ranked — not only those over the threshold. Filtering to
    // `countries > 1` left the whole panel at "No results found" under a warning title whenever the
    // estate was clean, which read as a broken alert; ranked, the clean state is visible as such and a
    // traveller still sorts to the top at any volume. No Countries or Cities count: "Countries seen" and
    // Reading already say both things a count would, and with them the email column was cut at a 1440px
    // viewport ("shawn.hooton@elast"). City is the ISP's point of presence, not evidence of travel.
    // h=8 (6 rows) for this and Busiest client IPs beside it: at 12 units each held 1–2 rows over
    // ~250px of blank card on a one-person, two-address project; six still leads with any traveller.
    table(0, 21, 24, 8, 'Countries per person (impossible travel)',
      `FROM ${IDX} | ${TIME} | WHERE attributes.user.email IS NOT NULL AND client.geo.country_iso_code IS NOT NULL | STATS countries = COUNT_DISTINCT(client.geo.country_iso_code), ips = COUNT_DISTINCT(client.ip), events = COUNT(*), names = VALUES(client.geo.country_name) BY attributes.user.email | EVAL verdict = CASE(countries > 1, "Check travel", "One country"), seen_from = MV_CONCAT(MV_SORT(names), ", ") | SORT countries DESC, events DESC | LIMIT 15`,
      [filterable('attributes.user.email'), sized('verdict', 115, { label: 'Reading', min: 100 }), { column: 'seen_from', label: 'Countries seen' }],
      [{ column: 'ips', label: 'Client IPs' }, 'events'],
      'People (identities with an email) whose traffic resolved to a country in range, most countries first. Two or more countries inside one window is the classic impossible-travel indicator — compare "Countries seen" with where the person actually is. "One country" on every row is the clean state. Service credentials are excluded, since multi-region is normal for machines, and a person whose every address is unplaceable (private egress) cannot appear here — see Geo coverage. Click an email to scope the suite to that person.'),
    // One row per address (IP_GEO): grouped by the geo fields too, an address with events from before
    // enrichment printed twice — placed, and "not placeable" — and the table outgrew the Client IPs tile.
    // "Placed" is IP_GEO's own count, shown so the row reconciles with Top client locations above: the
    // same place read 658,852 events there and 659,243 here, 391 apart with nothing on the panel to say why.
    // No "First seen": it was the first event IN RANGE, a discovery time that was not one.
    table(24, 21, 24, 8, 'Busiest client IPs',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | ${ACTOR_RESOLVE} | STATS events = COUNT(*), actors = COUNT_DISTINCT(actor), ${IP_GEO} BY client.ip | ${LOCATION} | SORT events DESC | LIMIT 15`,
      [filterable('client.ip'), 'location'], ['events', { column: 'placed', label: 'Placed', width: 90 }, 'actors'],
      'Forwarded client IPs, busiest first, with where each resolved; the Client IPs tile counts every one. Events is every event from the address; Placed is the ones geoip resolved, which is what Top client locations and the map count — the difference is the address\'s events from before geo enrichment. An IP shared by many identities is usually a NAT gateway or CI runner. "Platform-internal (100.64/10)" is not a client: it is a hop inside Elastic Cloud — on this project, Kibana\'s server calling Elasticsearch for a user whose real address is on the Kibana event. "Not placeable" means no event from the address ever resolved: a private address no geoip database can place, not an enrichment error. "Geo resolution of audited events" accounts for every one. Click an IP to scope the suite to it.'),
    // By name, not ISO code, so the legend reads "United States". Countries under 5% of resolved
    // traffic fold into "Other": that caps the split at 19 named series in theory and a handful in
    // practice, and the right-hand legend (one per line) cannot clip the way a bottom row does — which
    // is why it keeps its ~140px even when one country is all there is.
    // Aggregated on the raw keyword first, so the fold runs over buckets, not events.
    xy(0, 29, 24, 13, 'Geo-resolved traffic over time, by country',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS events = COUNT(*) BY ts = ${BUCKET}, c = client.geo.country_name | INLINE STATS ctot = SUM(events) BY c | INLINE STATS total = SUM(events) | EVAL country = CASE(ctot >= total * 0.05, c, "Other") | STATS events = SUM(events) BY ts, country | SORT country`,
      'events', 'Resolved client traffic over time, split by country: events per bar, where each bar is a round interval sized so the range holds at most 75 of them (1 minute at 1h, 30 minutes at 24h, 3 hours at 7d). Countries under 5% of resolved events in range are folded into "Other". Unresolved events are not drawn — see Geo coverage.',
      { breakdown: 'country', xcol: 'ts', legend: 'right', colors: { Other: '#B9A888' }, yTitle: 'Events per bar' }),
    // The proxy column is the raw field, labelled, so it is a click-to-filter link (an ES|QL alias
    // would cost the pill). See PROXIES for why one row per proxy rather than per pair. h=13 (12 rows)
    // holds every forwarding proxy seen so far (8 at 24h) with room at volume; it also keeps the page
    // above verify.mjs's 1400px "did the measurement work" floor at a 1920px viewport.
    table(24, 29, 24, 13, 'Proxy vs real client IP, by proxy', PROXIES,
      [filterable('attributes.source.ip', { label: 'Proxy IP', width: 125 }), { column: 'forwarded_for', label: 'Real client IPs it forwarded' }],
      [{ column: 'clients', label: 'Client IPs', width: 90 }, 'events'],
      'Side-by-side proof that source.ip is the internal proxy and client.ip (from network.forwarded_ip) is the real origin: one row per proxy that forwarded a client address — the proxies the Proxy IPs tile\'s line counts — with the client addresses it carried (in address order, up to three, then "+N more"). Analysing the wrong field would put every user in the datacentre. An address marked "(internal)" is a platform-internal 100.64/10 hop, not a client: on this project, Kibana\'s server calling Elasticsearch. Click a proxy to scope the suite to it; Busiest client IPs filters by client.'),
  ];
  return dash('cloud-audit-05-geo-network', '[Audit] 🌍 Geo & Network',
    'Real client geography from forwarded_ip, geo-resolved at ingest. Impossible-travel detection.', P);
}
