/** 05 Geo & Network — see scripts/lib/definitions.mjs for how the suite is assembled. */
import {
  IDX, ACTOR_RESOLVE, ACTOR_KEYS, IP_GEO, TIME, BUCKET, dash, kpi, xy, table, vega, filterable, sized, resetIds, grouped,
  INTERNAL_NET
} from '../panels.mjs';
import { rawId } from '../suite.mjs';
import { RAW_RECORDS, IDENTITY_HOW_TO } from './shared.mjs';

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
const INTERNAL = 'Platform-internal (100.64/10)';
const NOT_PLACED = 'Not placed';
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
 * into two rows. The second row's Addresses is null (Lens prints "-"): its addresses are Resolved's
 * own, so counting them again made the column add up to 3 under a Client IPs tile reading 2 (round-4
 * review). Null rather than 0, because "391 events from 0 addresses" is false, and the column now
 * partitions the tile exactly as Events partitions the stream. "No client IP" is null too: printed as
 * 0 it read "30,854 events from 0 addresses" beside the other row's "-", two notations for one thing
 * (round-5 review), so "-" in this column always means no address of the row's own. A table rather than the donut it replaced: Lens drew a ~40% slice's label inside the
 * ring, the legend order swapped between 1h and 24h, and a 0.05% slice was invisible.
 */
const GEO_RESOLUTION =
  `FROM ${IDX} | ${TIME} | STATS n = COUNT(*), placed = COUNT(client.geo.country_iso_code) BY client.ip ` +
  `| EVAL kind = CASE(client.ip IS NULL, "No client IP", placed > 0, "Resolved", ${ADDRESS_CLASS}) ` +
  `| STATS events = SUM(n), resolved = SUM(placed), addresses = COUNT(client.ip) BY kind ` +
  `| INLINE STATS total = SUM(events) ` +
  `| EVAL part = [1, 2] | MV_EXPAND part | WHERE part == 1 OR kind == "Resolved" ` +
  `| EVAL geo_status = CASE(part == 2, "Predates geo enrichment", kind), ` +
  `events = CASE(part == 2, events - resolved, kind == "Resolved", resolved, events), ` +
  `addresses = CASE(part == 2 OR kind == "No client IP", null, addresses) ` +
  `| WHERE events > 0 OR geo_status == "Resolved" ` +
  `| EVAL ord = CASE(geo_status == "Resolved", 0, part == 2, 2, kind == "No client IP", 3, 1), ` +
  `shown_in = CASE(geo_status == "Resolved", "Map, locations, travel", part == 2, "IP tables, under its Resolved IP", ` +
  `kind == "No client IP", "Nowhere: no address", kind == "${INTERNAL}", "IP tables, as internal", "IP tables, not placeable"), ` +
  `pct = ROUND(${SHARE('events', 'total')} * 100, 1) ` +
  `| EVAL share = CASE(events > 0 AND pct < 0.1, "<0.1%", CONCAT(TO_STRING(pct), "%")) ` +
  `| SORT ord, events DESC | KEEP geo_status, events, addresses, share, shown_in`;

/**
 * One row per proxy that forwarded a client address — exactly the set the Proxy IPs tile's line counts,
 * so the two reconcile row for row. As top PAIRS the table could not: 8 forwarding proxies × 2 clients
 * made 16+ pairs, and the 10 that fit held only 6 distinct proxies under a tile reading 8.
 *
 * The platform-internal hop is split OUT of the client list, into its own count. Listed among the
 * clients with an "(internal)" tag, it made every row read "2 client IPs" when each proxy carried one
 * real client (round-4 review), under a title that promises the real client and on a page that says
 * elsewhere the hop is not one. Its events stay on the row, in their own column, so the two event
 * columns still add up to the proxy's whole share of Busiest client IPs. A proxy that carried only the
 * hop says so in words rather than printing an empty list.
 *
 * Counted by the two raw addresses first (QUERY SHAPE rule 2); CIDR_MATCH and the one-condition CASE
 * run on those pairs, the list is in address order, capped at three with a "+N more", and every EVAL
 * sits before the trailing SORT/KEEP/LIMIT so table() can set the LIMIT. 7d on the replica: 85–127ms
 * against 75–99ms for the tagged list it replaced.
 *
 * Ranked by Client events, the first column a reader compares, then Internal-hop events. Ranked by the
 * proxy's total, which KEEP drops, neither visible column was in order (291,314 above 309,038 at 24h,
 * round-5 review) and nothing on the panel said why one proxy outranked another.
 */
const PROXIES =
  `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS n = COUNT(*) BY source.ip, client.ip ` +
  `| EVAL hop = ${INTERNAL_NET}, real = CASE(hop, null, TO_STRING(client.ip)) ` +
  `| STATS events = SUM(n), hop_events = SUM(n) WHERE hop, clients = COUNT(real), cs = VALUES(real) BY source.ip ` +
  `| EVAL hop_events = COALESCE(hop_events, 0), client_events = events - hop_events, ` +
  `forwarded_for = CASE(clients == 0, "none, only the internal hop", ` +
  `CONCAT(MV_CONCAT(MV_SLICE(MV_SORT(cs), 0, 2), ", "), CASE(clients > 3, CONCAT(" +", TO_STRING(clients - 3), " more"), ""))) ` +
  `| SORT client_events DESC, hop_events DESC | KEEP source.ip, forwarded_for, client_events, hop_events | LIMIT 10`;

/**
 * "Placed events" is one measure printed in two tables (Top client locations, Busiest client IPs), so it
 * has one name and one width in both: as "Placed events" beside "Placed" the reconciliation between them
 * was there but not visible (round-4 review). 105px holds the header at compact density.
 */
const PLACED_W = 105;

/** The intro (draft 7 of the 1.0.3 customer copy; INTRO TEXT in panels.mjs). */
const INTRO = {
  h: 6,
  heading: "Where your users and API keys connect from",
  paragraphs: [
    `See activity by country and city, your busiest client addresses, and anyone seen in more than one country, a sign of a shared or stolen credential. ${RAW_RECORDS}`,
    "Locations come from each client's real address, not Elastic's own network hops. Country is reliable; city is often your internet provider's nearest hub. Private network addresses cannot be placed on a map.",
    "**How to use it:** choose a Project, Identity type, Identity or Client IP in the controls and set the time picker. Click an address or email in a table to add a filter pill, which every page in the suite keeps.",
  ],
  howTo: [
    'Every address is the real client, forwarded by Elastic Cloud’s proxy; the proxy’s own address is never used for location.',
    'Only placed events appear on maps; “Geo resolution of audited events” accounts for the rest.',
    'Platform-internal (100.64/10) is Kibana calling Elasticsearch for a user, not a failed lookup; private and no-IP events cannot be placed.',
    'Location lookup applies only to events after it was switched on, so an address’s older events count in All events, not Placed events.',
    'Impossible travel lists people only; machines are multi-region by design.',
    IDENTITY_HOW_TO,
  ],
};

export function build() {
  resetIds();
  const P = [
    kpi(0, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS \`Geo-resolved events\` = COUNT(*)`, 'Geo-resolved events', 'Events whose client location could be resolved: the Resolved row of “Geo resolution of audited events”.'),
    kpi(8, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS total = COUNT(*), resolved = COUNT(client.geo.country_iso_code) | EVAL \`Geo coverage\` = ${SHARE('resolved', 'total')} | KEEP \`Geo coverage\``, 'Geo coverage',
      'Share of events placed in a country: the honest denominator for every geographic panel here. It can be low, because events with no forwarded IP, Elastic’s internal hops and private addresses cannot be placed.',
      { fmt: 'percent', dec: 1 }),
    kpi(16, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Cities\` = COUNT_DISTINCT(client.geo.city_name)`, 'Cities', 'Distinct client cities. City is often the internet provider’s nearest hub rather than the user’s location.'),
    // The secondary names the addresses that are platform hops rather than clients, so the count
    // reconciles with Busiest client IPs, which lists them under that label.
    // Grouped by the address first, then counted: exact, and as fast as the bare COUNT_DISTINCT
    // (164–188ms at 7d against 181–195ms), where two COUNT_DISTINCTs took 406–429ms.
    kpi(24, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS BY client.ip | STATS \`Client IPs\` = COUNT(client.ip), internal = COUNT(client.ip) WHERE ${INTERNAL_NET} | EVAL detail = CASE(internal > 0, CONCAT(${grouped('internal')}, " platform-internal"), "none internal") | KEEP \`Client IPs\`, detail`, 'Client IPs',
      'Distinct real client IPs. The line above the number counts Elastic’s internal-network addresses: not clients but a hop inside Elastic Cloud, such as Kibana calling Elasticsearch for a user. Busiest client IPs labels them Platform-internal.',
      { secondary: 'detail' }),
    // The secondary reconciles this tile with "Proxy vs real client IP", which has one row per proxy
    // that forwarded a client address: without it the tile said 7 and the table showed 4.
    kpi(32, 0, 8, 5, `FROM ${IDX} | ${TIME} | STATS \`Proxy IPs\` = COUNT_DISTINCT(source.ip), fwd = COUNT_DISTINCT(source.ip) WHERE client.ip IS NOT NULL | EVAL detail = CONCAT(${grouped('fwd')}, " forwarded a client IP") | KEEP \`Proxy IPs\`, detail`, 'Proxy IPs',
      'Distinct proxy addresses: Elastic Cloud’s own network hops, not clients, shown to make the difference explicit. The line above the number counts the proxies that forwarded a client address.',
      { secondary: 'detail' }),
    // A bare 0 here meant either "nobody travelled" or "only one country is visible at all", and those
    // need opposite readings — so the secondary says which. Grouped on the raw email rather than the
    // actor COALESCE: the WHERE already requires an email, so they are the same identity, and the raw
    // keyword groups faster (QUERY SHAPE rule 2). STATS over zero rows still returns one row (maxc null), which is
    // what lets the first CASE branch fire on an empty window. The phrases stay ~16 characters: at a
    // 1440px viewport the tile is ~210px wide and "everyone from one country" was cut mid-word.
    kpi(40, 0, 8, 5, `FROM ${IDX} | ${TIME} | WHERE user.email IS NOT NULL AND client.geo.country_iso_code IS NOT NULL | STATS c = COUNT_DISTINCT(client.geo.country_iso_code) BY user.email | STATS \`Multi-country people\` = COUNT(*) WHERE c > 1, maxc = MAX(c) | EVAL detail = CASE(maxc IS NULL, "no person placed", maxc < 2, "one country each", "in 2+ countries") | KEEP \`Multi-country people\`, detail`, 'Multi-country people',
      'People seen from more than one country in range: the impossible-travel signal. Service credentials are excluded, since multi-region is normal for machines. The line above the number says whether 0 is clean or just one country in view.',
      { secondary: 'detail' }),
    // The map is a Vega choropleth, not Lens region_map: region_map takes no palette, legend or extent
    // through the Dashboards API. See the spec. Its subtitle carries what an "About this data" note
    // used to say (client.ip, not the proxy). 17 units tall so the two tables beside it — the places
    // it shows (h=8, six rows) and where the rest of the stream went (h=9, up to seven rows, every
    // resolution class) — stack in its height instead of one table holding one row in a 13-unit card.
    // The unit this row gained is the one the proxy table gave up: the page needs ~42 units to clear
    // verify.mjs's 1400px floor at 1920px, and here it buys a sixth location and a taller map.
    vega(0, 5, 24, 17, '06-geo-origin', 'Audited traffic by country',
      'Events by real client country, shaded teal (few) to pink (most) on a log scale. Hover a country for details. The title line says how much traffic could be placed: a blank country is not proof of no traffic.'),
    // A table rather than a bar chart: with one location the old bar filled the panel as a solid
    // block, and at 5-10x the cities its 25 rows overprinted their labels. A table keeps the exact
    // count beside each place and stops at the rows that fit.
    table(24, 5, 24, 8, 'Top client locations',
      `FROM ${IDX} | ${TIME} | WHERE client.geo.country_iso_code IS NOT NULL | STATS n = COUNT(*) BY city = client.geo.city_name, country = client.geo.country_name, client.ip, ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS events = SUM(n), actors = COUNT_DISTINCT(actor), ips = COUNT_DISTINCT(client.ip) BY city, country | EVAL location = CONCAT(COALESCE(city, "city unknown"), ", ", country) | SORT events DESC | LIMIT 6`,
      ['location'], [{ column: 'events', label: 'Placed events', width: PLACED_W }, 'actors', { column: 'ips', label: 'Client IPs' }],
      'The busiest client locations in range, counting only events that could be placed (the ones the map shades). Country is reliable; city is often the internet provider’s nearest hub rather than where the person sits.'),
    table(24, 13, 24, 9, 'Geo resolution of audited events', GEO_RESOLUTION,
      [sized('geo_status', 190, { label: 'Resolution', min: 175 }), { column: 'shown_in', label: 'Where it shows' }],
      ['events', 'addresses', sized('share', 70, { label: 'Share' })],
      'Every event in range, by whether it could be placed on a map, with the addresses behind each row. Platform-internal, private and no-IP rows are expected; a “Public, no geoip match” row is a real problem worth chasing.',
      { cut: false }),
    // Every person with geo-resolved traffic, ranked — not only those over the threshold. Filtering to
    // `countries > 1` left the whole panel at "No results found" under a warning title whenever the
    // estate was clean, which read as a broken alert; ranked, the clean state is visible as such and a
    // traveller still sorts to the top at any volume. No Countries or Cities count: "Countries seen" and
    // Reading already say both things a count would, and with them the email column was cut at a 1440px
    // viewport ("shawn.hooton@elast"). City is the ISP's point of presence, not evidence of travel.
    // h=8 (6 rows) for this and Busiest client IPs beside it: at 12 units each held 1–2 rows over
    // ~250px of blank card on a one-person, two-address project; six still leads with any traveller.
    table(0, 22, 24, 8, 'Countries per person (impossible travel) · no service credentials',
      `FROM ${IDX} | ${TIME} | WHERE user.email IS NOT NULL AND client.geo.country_iso_code IS NOT NULL | STATS countries = COUNT_DISTINCT(client.geo.country_iso_code), ips = COUNT_DISTINCT(client.ip), events = COUNT(*), names = VALUES(client.geo.country_name) BY user.email | EVAL verdict = CASE(countries > 1, "Check travel", "One country"), seen_from = MV_CONCAT(MV_SORT(names), ", ") | SORT countries DESC, events DESC | LIMIT 6`,
      [filterable('user.email'), sized('verdict', 115, { label: 'Reading', min: 100 }), { column: 'seen_from', label: 'Countries seen' }],
      [{ column: 'ips', label: 'Client IPs' }, 'events'],
      'People whose traffic resolved to a country, most countries first. Two or more countries in one window is the classic impossible-travel sign; “One country” on every row is clean. Click an email to scope the suite.'),
    // One row per address (IP_GEO): grouped by the geo fields too, an address with events from before
    // enrichment printed twice — placed, and "not placeable" — and the table outgrew the Client IPs tile.
    // "Placed" is IP_GEO's own count, shown so the row reconciles with Top client locations above: the
    // same place read 658,852 events there and 659,243 here, 391 apart with nothing on the panel to say why.
    // No "First seen": it was the first event IN RANGE, a discovery time that was not one.
    table(24, 22, 24, 8, 'Busiest client IPs',
      `FROM ${IDX} | ${TIME} | WHERE client.ip IS NOT NULL | STATS n = COUNT(*), ${IP_GEO} BY client.ip, ${ACTOR_KEYS} | ${ACTOR_RESOLVE} | STATS events = SUM(n), actors = COUNT_DISTINCT(actor), country = MAX(country), city = MAX(city), placed = SUM(placed) BY client.ip | ${LOCATION} | SORT events DESC | LIMIT 6`,
      [filterable('client.ip'), 'location'], [{ column: 'events', label: 'All events' }, { column: 'placed', label: 'Placed events', width: PLACED_W }, 'actors'],
      'Real client addresses, busiest first, with where each resolved. An address shared by many identities is usually a NAT gateway or CI runner. “Platform-internal” is Elastic’s own network hop, not a client. Click an IP to scope the suite.'),
    // By name, not ISO code, so the legend reads "United States". Countries under 5% of PLACED traffic
    // fold into "Other": that caps the split at 19 named series in theory and a handful in practice, and
    // the right-hand legend (one per line) cannot clip the way a bottom row does — which is why it
    // keeps its ~140px even when one country is all there is.
    // "Not placed" is drawn too, in grey, on top. Without it the 24h render was blank for its left 45%
    // with nothing to say why (round-4 review): the stream simply began then, but a geo-only chart
    // cannot tell "no events" from "events nobody could place", and the second is half the stream on
    // this project. With it each bar is the whole audited volume, the coloured part is the Geo coverage
    // tile over time, and a blank stretch can only mean no audit events at all.
    // Aggregated on the raw keyword first, so the fold runs over buckets, not events (no country filter
    // any more, so it reads every event: 7d on the replica 224–277ms, against 139–155ms geo-only).
    xy(0, 30, 24, 13, 'Audited traffic over time, by client country',
      `FROM ${IDX} | ${TIME} | STATS events = COUNT(*) BY ts = ${BUCKET}, c = client.geo.country_name | INLINE STATS ctot = SUM(events) BY c | INLINE STATS placed = SUM(events) WHERE c IS NOT NULL | EVAL country = CASE(c IS NULL, "${NOT_PLACED}", ctot >= placed * 0.05, c, "Other") | STATS events = SUM(events) BY ts, country | EVAL ord = CASE(country == "${NOT_PLACED}", 2, country == "Other", 1, 0) | SORT ord, country, ts | KEEP ts, country, events`,
      'events', `Audited events over time by the client’s country. Grey “${NOT_PLACED}” is events with no resolvable location, so the colored part is geo coverage over time. Countries under 5% of placed events fold into “Other”.`,
      { breakdown: 'country', xcol: 'ts', legend: 'right', colors: { Other: '#B9A888', [NOT_PLACED]: '#98A2B3' }, yTitle: 'Events per bar' }),
    // The proxy column is the raw field, labelled, so it is a click-to-filter link (an ES|QL alias
    // would cost the pill). See PROXIES for why one row per proxy, and why the internal hop has its own
    // column. "Platform proxy" says on the panel face why every proxy is a 100.64/10 address, the range
    // the page calls platform-internal. h=13 (12 rows) holds every forwarding proxy seen so far (8 at
    // 24h). Not 12: the data grid sizes its first render by an estimated ~34px row, not the 24px compact
    // row it draws, so at 8 rows in a 10-row card it decided it had a scrollbar and drew its bottom
    // border ~70px under the last row, a stray hairline across the card (round-5 review; a window resize
    // clears it, which is how it was pinned down). At 13 that needs 9+ rows. The cost is a little more
    // empty card at 1h, where 2 proxies forward. 12 is also the floor: at 11 the page fell to
    // verify.mjs's 1400px "did the measurement work" limit at a 1920px viewport and every render was
    // flagged TRUNCATED.
    table(24, 30, 24, 13, 'Proxy vs real client IP, by proxy', PROXIES,
      [filterable('source.ip', { label: 'Platform proxy', width: 125 }), { column: 'forwarded_for', label: 'Real client IPs it forwarded' }],
      [{ column: 'client_events', label: 'Client events', width: 100 }, { column: 'hop_events', label: 'Internal-hop events', width: 130 }],
      'Proof that the source address is an Elastic Cloud proxy and the forwarded address is the real client: one row per proxy, with the client addresses it carried. Click a proxy to scope the suite to it.'),
  ];
  return dash(rawId('05-geo-network'), '[Audit] 🌍 Geo & Network',
    'Real client geography from forwarded_ip, geo-resolved at ingest. Impossible-travel detection.', P, { intro: INTRO });
}
