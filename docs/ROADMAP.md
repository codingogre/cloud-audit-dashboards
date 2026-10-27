# Cloud Audit Suite Review

<!-- Generated from docs/roadmap.html by `node scripts/roadmap.mjs`. Edit the page, not this file. -->

How well the seven dashboards and eleven Discover sessions serve SOC analysts, compliance auditors, platform admins and security managers: where the design gets in their way, which of their questions it answers, and what comes next.

Reviewed **2026-10-26** against release **1.0.7** · 136 use cases · 26 open design holes. The full page, with filters and every
use case's detail, is [`docs/roadmap.html`](roadmap.html): download it and open it in a browser.

## Investigation works; evidence and reporting lag

- **Most questions are partly answered.** Of 136 customer use cases, 32 (24%) are answered outright and 74 (54%) partly. The usual gap is the last step: a count no panel adds up, an export that loses its context, or a field the stream has but no panel shows.
- **Following an identity works.** The Identity type and Identity dropdowns reach every kind of credential, API keys included, and every identity table and treemap tile clicks through to Identity 360 with the identity pinned. What's left: a session-bar zoom has no way back, the raw-event links don't carry the page's filters, and there is no picker for one index or one saved object.
- **Six alert rules watch the sharpest signals; behaviour alerts come later.** The starter pack raises failed-sign-in bursts, a sign-in after failed sign-ins, new API keys and role changes, security changes at an unusual hour, new identities, and audit events that stop arriving. The rules ship disabled with no delivery of their own, so each customer turns them on and routes them. 17 use cases still need a rule or longer retention: alerts against an identity's own baseline (1.2.0), checks that need months of history, and first access to a Kibana space (UC-112).
- **Evidence and reporting are the weakest area.** Row caps are stated only in titles, exports drop the query and the time range, and there is no one-page summary or scheduled report.
- **Managers are served least.** 12 of their 58 questions are answered outright. Headline tiles compare with the previous period, but there is no posture summary to share.

| Coverage | Use cases |
| --- | --- |
| Answered | 32 |
| Partly | 74 |
| Needs alerting or retention | 17 |
| Not in the data | 13 |

## Roadmap

Every open design hole and every use case not answered today, placed in the release that closes it. Patch releases add to the dashboards, and 1.0.7 continues as a run of small ones, 1.0.7.1 to 1.0.7.7; 1.1.0 adds a dashboard; 2.0.0 brings in data from outside the audit stream.

### 1.0.7.1 — Live signal feed and failed access

One burst cannot fill the Live signal feed, and a failed request says what it was calling and who called.

- Live signal feed grouped by identity, action and request, with count, first and last time
- Request path and calling client (x-opaque-id) on the failed-access tables
- An API key column on Top failed and Failed sign-ins, so a named key's row pins the key, not its owner

1 design holes · 3 use cases

Design holes:

- **medium** — The Live signal feed is the newest 200 events, one row each, so one automated burst fills it

Use cases:

- UC-006 — Is a client hammering /_security/_authenticate or another endpoint with bad credentials, such as an integration holding a stale key?
- UC-007 — Which internal or platform principals (autoscaling, elasticsearch-controller) fail realm authentication, and is that noise I should exclude?
- UC-009 — Who is generating anonymous_access_denied (scanners on the public endpoint): how many, from where, which paths, and is it rising?

### 1.0.7.2 — Discover links and a way back

Every panel can open its own records, and a session-bar zoom can be undone.

- Per-panel Open in Discover links that carry the page's filters and time range
- A way back to the previous time range after a session-bar click

2 design holes · 1 use cases

Design holes:

- **medium** — The 'Raw records' links open Discover without the page's filters or time range, and no panel links to its own search
- **medium** — A session-bar click overwrites the time range with no way back

Use cases:

- UC-117 — Tie a Kibana UI action to the exact Elasticsearch requests it triggered (end-to-end trace).

### 1.0.7.3 — State the window

Every intro says which time window the page opens on; 24 hours stays the default everywhere.

- The default window (24 hours) stated in each intro
- How to read points weekly reviewers to the time picker

1 design holes · 0 use cases

Design holes:

- **low** — No page says which time window it opens on, and the overview pages have no weekly view

### 1.0.7.4 — Identity 360 on the time picker

Identity 360 covers the time picked, and says when it is showing everyone.

- Identity 360's 7-day and 24-hour windows end at the time picker's end
- A prompt and "all identities" labels when nobody is selected

2 design holes · 0 use cases

Design holes:

- **medium** — Identity 360's 7-day and 24-hour windows end at the current moment, not at the time picker, and the page mixes UTC with local time
- **low** — With nobody selected, Identity 360 shows project-wide totals under the heading 'Everything one person did, on one page', and nothing labels them as covering all identities.

### 1.0.7.5 — Object, space and index family pivots

"Who else touched this?" is one click for a saved object, a space or an index family.

- Clickable object id and space on the Kibana Objects tables and What they changed
- A clickable representative index on the index family tables
- Per-space activity, and the failed-change share on the Mutations tile

1 design holes · 2 use cases

Design holes:

- **medium** — Object names and computed index families cannot be clicked, and there is no Object or Space dropdown, so 'who else touched this object or index family' means typing a filter by hand.

Use cases:

- UC-064 — What is our failed-change rate: what share of create and update attempts on saved objects and spaces failed?
- UC-113 — Which teams and spaces actually use Kibana: active users, object edits and risk per space, week over week?

### 1.0.7.6 — Sign-in and session panels

How people sign in and how long their sessions last, on Identity & Access.

- Failed sign-ins week over week, with names and addresses tried, and authentication methods
- Session durations, long-lived sessions and sessions that change IP or country
- Daily distinct people, and run_as use

0 design holes · 6 use cases

Use cases:

- UC-005 — What is the failed-authentication rate (failed / all attempts), and how does it trend week over week?
- UC-010 — Which authentication methods are used (SAML SSO, API key, token, native realm), what share each has, and did any human authenticate other than through SSO?
- UC-013 — Was the same Kibana session id used from more than one public IP or country mid-session (possible cookie theft)?
- UC-014 — How many Kibana sessions were there, how long did they last on average, and which were long-lived (>12h), suggesting idle timeouts are not enforced?
- UC-015 — How many distinct humans logged into Kibana each day this month?
- UC-066 — Were any requests made with run_as or impersonation, and on whose behalf?

### 1.0.7.7 — Discovery against a baseline

Elasticsearch Data Access flags enumeration and index discovery that an identity does not normally do.

- Security enumeration and index listing by identity, against that identity's own baseline

0 design holes · 2 use cases

Use cases:

- UC-083 — Who enumerated security configuration (roles, users, API keys, privileges), and how often compared with their baseline?
- UC-084 — Which identities listed indices, mappings, cluster state or field caps across many indices they do not normally touch?

### 1.0.8 — Identities, keys and roles

Show what an identity may do, not only what it did: roles, key scope and hygiene, and the request ids that tie one run together.

- Roles column and privileged-role activity
- API key hygiene: stale, widely shared, never-expiring, rotation
- Key scope parsed from create and change records
- Request, opaque and trace ids in the raw tables
- First visit to a Kibana space by an identity: a rule beside New identity seen

4 design holes · 23 use cases

Design holes:

- **medium** — A Cloud API key has no name or owner anywhere in the suite, and nothing links it to the Cloud console
- **medium** — No table or saved search shows the request id, opaque id, trace id or span id, so one script run or one Kibana request cannot be followed across its events.
- **medium** — User roles are never shown, so no panel answers which roles did what or whether privileged roles are used.
- **medium** — There is no API key hygiene view: no list of stale keys, widely shared keys or rotation cadence.

Use cases:

- UC-025 — Which API keys were created with no expiration, or with an expiration beyond our 90-day rotation policy?
- UC-026 — Which new or changed API keys carry superuser-like role descriptors (cluster all, indices * with all/write/manage, run_as, or empty descriptors that inherit the creator's privileges), and who created them?
- UC-031 — Who invalidated API keys, how many and which ones, and were they their own keys or someone else's?
- UC-034 — Which API keys were minted by other API keys (key-creates-key chains) rather than by a person, and who ultimately owns them?
- UC-035 — How many API keys does each person own and actively use (key sprawl per user)?
- UC-038 — List the API keys a departing user created that are still active (used recently and not invalidated).
- UC-039 — Is the same API key being used from many distinct public IPs or countries, suggesting it is shared or leaked?
- UC-042 — Are API keys or service credentials being used interactively, for example by a human working in Kibana with a service key?
- UC-043 — An API key is confirmed leaked: which indices did it read or write, which actions did it take, and from which IPs, since it was created?
- UC-044 — Did the compromised identity mint further API keys or roles (child credentials) that must also be revoked, and have those been used?
- UC-045 — Show every role create, update and delete (put_role, delete_role, put_privileges) in the last 30 days or quarter, with who, when, from where and the role definition, for the SOC 2 binder.
- UC-046 — Show every role or API key change made outside business hours or at weekends last quarter.
- UC-048 — Which roles were granted write or manage privileges on indices holding sensitive data (pii-*, billing-*)?
- UC-052 — How many privileged security configuration changes happened this week, and by whom, compared with our weekly baseline?
- UC-054 — Is an integration's API key repeatedly denied after a role change? Correlate denials with a recent put_role or change_apikey.
- UC-056 — Produce a log of every action performed by admin-role identities (human and API key) during the period, for PCI 10.2.1.2.
- UC-057 — What share of our activity is done by admin-role identities rather than least-privilege roles, what share of admin activity happens after hours, and which admins account for most of it?
- UC-058 — Which identities' effective roles (user.roles) changed compared with last week?
- UC-070 — Which identities (users or API keys) appeared in the audit stream for the first time this week, and how many?
- UC-072 — How many distinct identities (people and API keys separately) were active in each project this month, and is the number growing?
- UC-073 — Which service accounts and other non-human identities are active, from where, and what do they access?
- UC-105 — Kibana change log: who created, modified or deleted dashboards, rules, connectors and data views, with object names and spaces, and how many changes each person made this week?
- UC-112 — Did anyone access a Kibana space they had never used before?

### 1.0.9 — Evidence and completeness

An auditor can prove what the suite shows: complete exports, stated totals, a switchable noise gate, and retention guidance that unlocks the long-window questions.

- "Showing N of M" on every capped table, and an evidence export with query, range, count and hash
- A noise gate that can be switched off
- Suite deploys marked or folded in the change lists
- Retention guidance (90 days or more) and the panels it enables: dormant keys, idle spaces, logging gaps
- Data access, exfiltration and destruction panels

5 design holes · 22 use cases

Design holes:

- **medium** — The suite's own deploys fill the mutation lists and show no deploy markers on time charts
- **high** — The noise gate can't be switched off from the dashboards, and it hides API-key listing
- **high** — Row caps cut evidence at 1,000 rows or fewer, and only the title says so
- **medium** — No evidence pack: nothing exports the query, time range, row count and a hash together
- **medium** — Data coverage and retention appear only on Command Center, and the README gives no retention guidance

Use cases:

- UC-024 — For keys created this quarter, which are still valid and which were invalidated (what fraction), and how many keys are active right now?
- UC-027 — Which API keys created in the last 90 days have never been used to authenticate?
- UC-028 — Which API keys are older than our 90-day rotation policy and still in use?
- UC-029 — Which API keys active last quarter have not been used in 30+ days (dormant), so I can expire them?
- UC-030 — Did any API key that was dormant for 30+ days suddenly become active?
- UC-033 — Which API keys had their role descriptors or metadata updated (change_apikey) and by whom, and did their privileges widen?
- UC-041 — Is any API key used by more than one client application (different x-opaque-id values or URL patterns), suggesting a shared credential?
- UC-085 — Who read indices matching my sensitive patterns (pii*, customers-*, hr-*, .security*), how many times, through which API, and was it a human or an API key?
- UC-087 — Which identity read the most distinct indices, or ran unusually many search, scroll or PIT requests, in the last 24h, and which carries the most read and write load per index pattern (chargeback)?
- UC-088 — Is the volume of reads on sensitive indices up or down compared with last month?
- UC-090 — Who wrote or bulk-indexed into indices they normally only read, or into system, security or regulated indices?
- UC-094 — Has anyone used reindex (especially remote reindex), async search or similar bulk paths to pull large data sets out?
- UC-095 — Who exported or imported Kibana saved objects (_export / _import), and which objects?
- UC-097 — Who deleted indices or data streams, or ran delete_by_query, in the last 7 days or month, including denied attempts (and snapshots)?
- UC-099 — Who created indices, or changed mappings or index settings, in the last 7 days?
- UC-102 — Did anyone tamper with audit logging: the enriching ingest pipeline, the audit data stream's lifecycle or settings, or deleting audit data?
- UC-114 — Are any spaces unused (no access in 60 days), so I can archive them?
- UC-116 — Pivot from a suspicious IP: every identity, project and action seen from it in the last 30 days.
- UC-119 — Give me a random sample of 25 security-relevant changes from the quarter, with full event detail, to trace each to an approved change ticket.
- UC-120 — Export all security configuration change events for the period to CSV, with timestamps, actor and outcome, for the auditors' evidence binder.
- UC-126 — Are there gaps in audit logging: any hour or day with zero events from Elasticsearch or Kibana, any delivery gap over 15 minutes, or measurable ingest lag?
- UC-127 — Prove audit logs are retained for 12 months, with 3 months immediately available, and show we are audit-ready: oldest event, every project logging, all categories present.

### 1.1.0 — Reporting and posture

A manager can read and share the posture in one page, and the risk model can be tuned and explained.

- Executive summary dashboard and a scheduled report
- Trends against the previous period on posture tiles
- Configurable risk weights
- Plain labels for actions, accessible colours, annotations and Cases links

7 design holes · 9 use cases

Design holes:

- **medium** — Security & Anomalies' posture tiles and the risk score have no previous-period comparison or trend
- **medium** — No one-page summary or scheduled report exists
- **medium** — Risk weights are hard-coded and risk grows linearly with event count, so a repetitive job outranks rarer, more severe actions
- **medium** — Titles and table values use builder jargon and raw action names
- **low** — Geo & Network gives prime space to proving source.ip is a proxy, and calls a country count 'impossible travel'
- **medium** — Colour-only encodings and emoji in titles hurt accessibility
- **low** — Time charts carry no annotations for known events, and nothing links a panel to Cases.

Use cases:

- UC-016 — Did any human identity authenticate from two locations too far apart for the elapsed time (impossible travel)?
- UC-075 — Which identities' hourly event volume today deviates most from their own 14-day baseline?
- UC-076 — Which human users were active between 22:00 and 06:00 or at weekends this month, and what did they change?
- UC-081 — Who are the top 10 riskiest identities this month, and what share of total risk do they account for?
- UC-082 — What was our average event severity or risk per day this month, and what were the three worst days and why?
- UC-109 — Who are the top 5 people making changes this month, and how does their change volume compare with last month?
- UC-132 — Are we getting better? This week's signal events, failed authentications and privileged changes against last week, with a percentage change arrow for each.
- UC-133 — A one-page monthly board summary (active identities, privileged changes, failed logins, access denials, new API keys, new countries), each with a month-over-month trend.
- UC-136 — Show a 12-week trend of distinct active API keys against distinct active humans, to see whether automation sprawl is growing.

### 1.2.0 — Behaviour and anomaly alerts

Rules that compare an identity with its own history once enough data is retained, and the rules the starter pack leaves out.

- Risk and read-volume spikes against an identity's baseline
- Key or service account used from a new place
- Self-escalation chains and mass deletes
- Daily review evidence and time to detect
- Writes and deletes on the audit stream itself

0 design holes · 10 use cases

Use cases:

- UC-017 — Alert me on impossible travel: the same human identity seen from two countries within an hour.
- UC-040 — Alert when an API key that normally calls from known egress IPs is used from a public IP or country it has not used in the previous 30 days.
- UC-053 — Did any principal escalate itself: denied, then created a role or key, then succeeded on the same resource; or created a key or role and then used it for privileged changes (segregation-of-duties violation)?
- UC-074 — Are service account tokens being used from anywhere other than the expected Kibana or internal workload, or against unexpected APIs?
- UC-077 — Did any single identity's risk score jump more than 3× compared with its own previous 4-week average?
- UC-078 — Which identities or integrations show a sudden spike in data reads or request volume against their baseline (3× over 7 days, 5× over 30 days), suggesting bulk export or a runaway client?
- UC-098 — Alert me when a single identity deletes more than N saved objects or indices within 10 minutes.
- UC-128 — Provide evidence of daily review of security events: a daily summary of failures, denials and config changes.
- UC-129 — Notify the compliance channel within 15 minutes of any admin-role assignment, security config change or audit-index access.
- UC-130 — What is our mean time to detect a privileged change, and what share of high-risk events did the SOC review within 24 hours?

### 2.0.0 — Beyond the audit stream

Join the audit stream with what it cannot see: who has access, who has left, where an address comes from, and the organisation's own changes. A major version because it adds data sources, lookup indices and a new install model.

- Elastic Cloud organisation audit: members, roles, role mappings
- Identity provider sign-in logs: lockouts and MFA
- Lookup indices: leavers, approved countries, office and CI ranges, key owners
- ASN and threat-intel enrichment
- Multi-project naming and comparison, a dedicated space and viewer role, measured cost

3 design holes · 20 use cases

Design holes:

- **medium** — The suite installs only into the Default space with no named viewer role, no field-level guidance for emails and IPs, and no message on the pages for readers who lack read on the audit stream.
- **medium** — The Project dropdown lists and matches project names, so same-named projects merge, and no panel compares risk or changes across projects.
- **low** — The cost each dashboard view adds to the audit stream is unmeasured, and load times are published only up to 7 days on one replica.

Use cases:

- UC-008 — Are any user accounts locked out after repeated failed logins?
- UC-011 — Can we prove MFA was used for every interactive (admin) login, and what share of human logins were MFA-protected?
- UC-018 — Which users logged in from a country, city or ASN they had not used in the previous 30 days (new country this week or month)?
- UC-020 — Which logins or admin actions came from countries outside our approved list, and what share of authentications is that?
- UC-021 — List every public IP that reached the project and the identities behind each, and flag access from outside our corporate egress or CI ranges.
- UC-022 — Which requests came from Tor exits, hosting or VPS providers, cloud providers, or IPs on our threat-intel blocklist?
- UC-037 — Which human created the API keys that generate most of our traffic, and is that person still with the company?
- UC-047 — Did anyone change role mappings (SAML group to role), which silently change who is privileged?
- UC-055 — Which identities hold admin, superuser or billing-admin roles, how many are there, did the count change, and how often did each use them?
- UC-059 — Which identities have privileged-action capability but have not used it in 90 days, so least privilege can be applied?
- UC-067 — Access review: list every identity with its roles, authentication type, first and last seen, event count and distinct IPs, and whether it was active in the last 90 days.
- UC-069 — Which users with access, privileged ones especially, have not logged in for 30, 60 or 90 days, so we can deprovision them?
- UC-071 — Did any terminated employee or leaver authenticate, or have their keys used, after their termination date?
- UC-086 — Who read sensitive indices this month through an API key whose owner has left or which has since been invalidated?
- UC-096 — Which users generated CSV or PDF reports or Discover CSV downloads, and of what data?
- UC-101 — Were alert connectors (Slack, email, PagerDuty, webhook) created, changed or deleted, so that alerts stop reaching the SOC or a webhook points to an external URL?
- UC-103 — Which dashboards, saved searches or data views used by the SOC were modified or deleted, and what was the before and after?
- UC-122 — Is the same human or API key active across multiple serverless projects, and did activity spread to a new project during the incident window?
- UC-123 — Across all our serverless projects, compare activity, privileged changes, API-key activity, failed-auth rate and distinct identities per project.
- UC-124 — Who invited or removed Cloud organization members, changed their organization or project role assignments, or created and deleted projects?

### Out of reach on serverless

- UC-004 — Is one public IP failing authentication against many different usernames or API keys (spraying), not one account repeatedly? (impossible-on-serverless)
- UC-060 — Was the break-glass or built-in elastic superuser, or an Elastic operator account, used this month, and for what? (impossible-on-serverless)
- UC-061 — Did Elastic staff or any third-party or vendor identity access our project this quarter? (impossible-on-serverless)
- UC-091 — Which specific documents or records of data subject X were accessed, and by whom (DSAR or breach scoping)? (impossible-on-serverless)
- UC-092 — What exactly did the attacker search for: the ES\|QL or query DSL text they ran? (impossible-on-serverless)
- UC-131 — Which client tools (browser, curl, Terraform, SDK) were used for privileged changes? (impossible-on-serverless)

## Design holes

### 1. The suite's own deploys fill the mutation lists and show no deploy markers on time charts

Severity **medium** · trust · SOC analyst, CISO, Compliance auditor · effort M · planned for 1.0.9

- **Impact:** After each release, Kibana Object Forensics' Mutations table, Security & Anomalies' Mutation feed and Identity 360's 'What they changed' fill with '[Audit] …' saved-object writes from the install. An analyst reviewing changes has to recognise and skip them, and real changes in the same window get pushed down or out of the 1,000-row cap.
- **Fix:** Mark SUITE_INSTALL rows in the three mutation lists (a 'suite install' value in Outcome or verb) and sort or fold them below other changes, or leave them out with an 'excl. N suite installs' line as the Scoring events tile does. Draw install times as annotations on the volume and mutation time charts.
- **Evidence:** panels.mjs:608-614 SUITE_INSTALL (suite object touched with no browser session) scores 0 in RISK and is counted out on the 'Scoring events' tile (04-security-anomalies.mjs:168-169), but stays in CHANGE_PRED (panels.mjs:316). MUTATION_FEED (04:48) filters on CHANGE_PRED and HOUSEKEEPING only; '⚠️ Mutations' (02-kibana-objects.mjs:164) and '⚠️ What they changed' (07-actor-360.mjs:251) read CHANGED. No dashboard draws annotations.

### 2. The noise gate can't be switched off from the dashboards, and it hides API-key listing

Severity **high** · investigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.9

- **Impact:** An attacker enumerating API keys (security/api_key/get and /query), or anyone reading the audit dashboards' own objects, doesn't appear on any gated panel. An auditor can't show completeness from gated panels, and the ungated Platform Volume dashboard is opt-in and absent from a default deploy.
- **Fix:** Add a 'Noise' ES|QL variable control (signal / include routine) that gated queries read alongside IDENTITY_WHERE. Add an 'N hidden by the noise gate' secondary line to gated KPIs. Classify api_key/get and /query as signal when the caller isn't the key's owner or when the rate is low.
- **Evidence:** panels.mjs:818 API_KEY_READS is in NOISE_ES_QUERY_INTERNALS; NOISE (panels.mjs:881) also drops authentication_success/connection_granted and SUITE_SELF reads. controls.mjs:85-94: the bar is Project, Identity type, Identity, Client IP, with no noise control. Gated KPIs show no count of events the gate removed. suite.mjs:32 marks 06-platform-volume optional.

### 3. The Live signal feed is the newest 200 events, one row each, so one automated burst fills it

Severity **medium** · investigation · SOC analyst, CISO · effort S · planned for 1.0.7.1

- **Impact:** During any automated run, the Command Center feed shows a single identity repeating, and rare events (a config change, a failure) drop out of the 200 rows within minutes. The workaround, picking an identity in the dropdown, needs the analyst to already know what to look for.
- **Fix:** Group by identity, action and request into one row with count, first and last time (as the Mutations table does), sorted by last time. Or keep one row per event but cap each identity+action to a few rows, so a burst can't take the whole feed.
- **Evidence:** 00-command-center.mjs:65 LIVE_FEED: NOISE, NOT HOUSEKEEPING, SORT @timestamp DESC, LIMIT 200, no STATS. Panel 'Live signal feed · Kibana key clean-up left out' (00:194); its description tells the reader to use the Identity dropdown to read a run of near-identical rows.

### 4. Row caps cut evidence at 1,000 rows or fewer, and only the title says so

Severity **high** · capability · Compliance auditor, SOC analyst · effort M · planned for 1.0.9

- **Impact:** A CSV exported from a capped panel looks complete and isn't, and an auditor can't tell from the export. Over a 7-day review, records older than the newest 1,000 can't be reached from the dashboard.
- **Fix:** Add a 'showing N of M' line to capped feeds (a sibling COUNT over the same filter, as the KPI tiles do). Add an `./audit --evidence` command that pages the matching events by time through ES|QL async and writes CSV/NDJSON.
- **Evidence:** withCut (panels.mjs:1348) appends '· newest 1,000 at most' / '· top N at most' to titles. LIMIT 1000 in FAILED_FEED (01-identity-access.mjs:109), key inventory and first/last seen (01:120, 01:141), Cross-space (02-kibana-objects.mjs:117), OBJECT_ACTIVITY (02:125), Raw system index requests (03-data-access.mjs:245), MUTATION_FEED and Config-change event feed (04-security-anomalies.mjs:48, :248). 'What they changed … up to 100' (07-actor-360.mjs:251). No panel shows a total beside its cap; main.mjs:97-109 has no export command.

### 5. The 'Raw records' links open Discover without the page's filters or time range, and no panel links to its own search

Severity **medium** · navigation · SOC analyst, Compliance auditor · effort S · planned for 1.0.7.2

- **Impact:** An analyst who clicks 'All audit events' or 'Raw signal feed' from a filtered page lands on the unfiltered stream at the search's own time and has to rebuild the filter by hand. A panel with a matching saved search (failed authentications, config changes, system index access) offers no direct path to it.
- **Fix:** Build the Discover link with the dashboard's time and filters (Kibana's dashboard-to-URL drilldown with useCurrentFilters/useCurrentDateRange on the record tables), and add a per-panel 'Open in Discover' URL drilldown pointing to the matching searches/* session.
- **Evidence:** shared.mjs:59 RAW_RECORDS; discoverUrl (panels.mjs:2021-2024) writes a bare '/app/discover#/view/<id>' with no _g time or filters. searches/01-09 (mutations, failed authentications, config changes, system index access, first seen, API key activity, cross-space, session reconstruction) aren't linked from any panel. The nav bar lists the seven dashboards only.

### 6. Identity 360's 7-day and 24-hour windows end at the current moment, not at the time picker, and the page mixes UTC with local time

Severity **medium** · navigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.7.4

- **Impact:** Investigating an incident from 10 days ago, the baseline, rhythm, cohort and session timeline show the last 7 days or 24 hours, not the period around the incident. Comparing a UTC hour on the baseline with a local-time row in a table invites off-by-hours mistakes in a report.
- **Fix:** Anchor the windows to the picker's end: bound the ES|QL by ?_tend - 7 days / 24 hours instead of a panel range ending at now. Show the baseline and rhythm hours in the viewer's zone, or put the UTC offset on every time axis on the page.
- **Evidence:** panels.mjs:1619-1624 VEGA_WINDOWS: 08, 09, 12 at now-7d → now, 13-session-gantt at now-24h → now; windowMs (:1606-1608) rejects any other 'to'. 07-actor-360.mjs:237 section '① Is this normal?' says 'fixed 7-day window in UTC (ignores the time picker)'; :239 'Is this normal for them? — hourly (UTC)', :241 'Working rhythm — by hour (UTC)'; :244 and :300 say 'your time zone'.

### 7. No page says which time window it opens on, and the overview pages have no weekly view

Severity **low** · navigation · CISO, SOC analyst, Cloud/platform admin · effort S · planned for 1.0.7.3

- **Impact:** A manager doing a weekly review on Command Center or Security & Anomalies has to set 7 days by hand each time, and no intro says the page opened on 24 hours. Panels that read empty over a quiet day give no hint that a wider range would help.
- **Fix:** Keep 24 hours as the default on every page: a 7-day default would make every Command Center query scan a week (the prior-period tiles two), which is too much load to impose on every viewer. Say the default window in each intro, and point weekly reviewers to the time picker.
- **Evidence:** panels.mjs:2172 DEFAULT_FROM = 'now-24h', :2144 TIME_TO = 'now-1m' (a recorded user decision); no dashboard passes timeFrom. No timepicker:quickRanges setting in the repo. Command Center intro (00-command-center.mjs:75-91) says 'set the time picker' but not what range is in effect. Empty-state titles such as 'empty when only internals' (02-kibana-objects.mjs:205, :219).

### 8. Security & Anomalies' posture tiles and the risk score have no previous-period comparison or trend

Severity **medium** · capability · CISO · effort M · planned for 1.1.0

- **Impact:** A CISO can see whether total, failed, Kibana and Elasticsearch volume rose against the prior period, but not whether Mean severity, Config changes, Failures or risk went up or down, which is the posture question. Ranges over 7.5 days show 'no full prior' on every comparison tile.
- **Fix:** Add PREV_TILES entries for Config changes, Failures and Anonymous denials and a risk-total tile, reusing the prevKpi spec. Add a weekly risk-total trend panel with its own 90-day VEGA_WINDOWS range, and raise PREV_LOOKBACK_DAYS if 30-day comparisons are wanted.
- **Evidence:** prevKpi tiles: 00-command-center.mjs:100, :119; 02-kibana-objects.mjs:151; 03-data-access.mjs:172, :180, :184. Security & Anomalies uses plain kpi() for 'Mean severity (of 50)', 'Config changes', 'Key invalidations', 'Failures', 'Anonymous denials', 'Scoring events' (04-security-anomalies.mjs:154-170). PREV_LOOKBACK_DAYS = 15 (panels.mjs:1689). No 30- or 90-day weekly risk trend panel.

### 9. No one-page summary or scheduled report exists

Severity **medium** · capability · CISO, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** There's no weekly posture page to email or put in a board pack. A manager has to screenshot long scrolling dashboards by hand.
- **Fix:** Add a compact 'Executive summary' dashboard: the prior-period tiles, top 5 risky identities, latest config changes, fitting one screen. Add `./audit --report --range 7d` that renders it through the same Chromium path --verify uses and writes a PDF plus a markdown digest from the same queries.
- **Evidence:** main.mjs:97-109 commands: --ingest, --ingest-check, --lint, --objects, --dashboards, --rules, --verify, --queries, --demo-guide, --synth, --perf, --deploy, --clean; none produces a report. --demo-guide writes a presenter runbook. Security & Anomalies runs to 137 grid rows and Identity 360 to 115 (dashboards/04-security-anomalies.json, 07-actor-360.json). README.md:436: 'Reporting API rejects pngV2 / printablePdfV2', which blocks Kibana's own PNG/PDF export.

### 10. No evidence pack: nothing exports the query, time range, row count and a hash together

Severity **medium** · capability · Compliance auditor · effort M · planned for 1.0.9

- **Impact:** An auditor can see full identifiers, but cannot hand over a self-describing, reproducible export that states which query ran, over what range, how many records it returned and a checksum. Building one by hand from Discover is slow and easy to get wrong.
- **Fix:** Add `./audit --evidence --from --to [--identity]` that writes CSV or NDJSON with the raw fields (no row cap), the ES|QL text, the range, row counts and a SHA-256 manifest.
- **Evidence:** Full ids appear in the click-to-filter Principal id column (scripts/lib/dashboards/shared.mjs:102-103) and in 'Key ID (Cloud) / creator' on Busiest API keys by name (01-identity-access.mjs:269); every intro links the 'All audit events' and 'Raw signal feed' Discover sessions (shared.mjs:59 RAW_RECORDS). 'All audit events' returns computed, renamed columns (Time, Identity, Source, Action, Outcome, Object, Client IP, Message) and stops at the newest 10,000 rows (searches/00-all-events.json). Dashboard Identity columns show a Cloud API key as '_4KEO… · Cloud API key' (panels.mjs:676-679 identityLabel/ACTOR_LABEL). scripts/main.mjs has no export or evidence option.

### 11. Data coverage and retention appear only on Command Center, and the README gives no retention guidance

Severity **medium** · trust · Compliance auditor, CISO · effort S · planned for 1.0.9

- **Impact:** A reader on Identity & Access or Security & Anomalies who sets a 90-day or 1-year range gets only what is retained, with nothing on that page saying how far back data goes. An empty 'Identities by first appearance in range' can mean no new identities or no data. Admins get no instructions for keeping audit data long enough to satisfy an audit.
- **Fix:** Put the same coverage line (first stored event and retention) in the Identity & Access and Security & Anomalies intros, or reuse the 14-data-coverage tile there. Add README steps for setting data_retention on the audit data stream and archiving to a snapshot repository.
- **Evidence:** Command Center has an untitled 'Audit data held' tile (scripts/lib/dashboards/00-command-center.mjs:131-135; panels.mjs:1870 coverageSpec, 1904 retentionText) showing the first stored event, the days covered and the retention read at --objects time. Neither 01-identity-access.mjs nor 04-security-anomalies.mjs shows coverage or retention; 04's 'Identities by first appearance in range' (04-security-anomalies.mjs:207) has no coverage line beside it. README.md:648-649 describes the tile only, with nothing on setting data_retention or archiving to snapshots.

### 12. A Cloud API key has no name or owner anywhere in the suite, and nothing links it to the Cloud console

Severity **medium** · investigation · Cloud/platform admin, SOC analyst · effort S · planned for 1.0.8

- **Impact:** An admin can copy a key's full id, but must then search the Cloud console by hand to learn the key's name, owner or purpose before revoking or rotating it. Identity columns show only the first five characters, so a reader must look across to Principal id to tell two similar keys apart.
- **Fix:** Add a link to the Cloud Organization API keys page beside Cloud API key ids (How to read bullet or a URL-formatted column). Support an optional user-maintained lookup index (key id → name, owner, purpose) joined with ES|QL LOOKUP JOIN in the identity tables.
- **Evidence:** Full 20-character ids show in Principal id columns (shared.mjs:102-103; on every identity table except 03 Denied requests by identity and 06 Highest-volume identities), in Key ID on API key inventory (01-identity-access.mjs:309) and in 'Key ID (Cloud) / creator' (01:270). Identity cells shorten a Cloud API key to '_4KEO… · Cloud API key' (panels.mjs:676-679). scripts/lib contains no cloud.elastic.co link and no LOOKUP JOIN.

### 13. Risk weights are hard-coded and risk grows linearly with event count, so a repetitive job outranks rarer, more severe actions

Severity **medium** · trust · CISO, SOC analyst, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** An organisation cannot tune the weights without editing code and redeploying. Because Risk total is weight × events with no cap, a bulk automated job (say 70 deletes at 30) tops the leaderboard over a handful of 50-weight config changes. The model is explained on the page, but the ranking it produces can mislead.
- **Fix:** Move the weights into a config file or a small lookup index read with LOOKUP JOIN. Cap or log-scale each action's contribution per identity (for example weight × log2(1+events)) so repetition cannot swamp severity, and keep the raw count beside it.
- **Evidence:** Weights are a fixed CASE (panels.mjs:502-511: 50/45/40/35/30/25/10, housekeeping and suite install 0); risk_total = SUM(risk * n) (panels.mjs:526). Security & Anomalies lists the weights and 'Risk total is weight × events' in How to read this page (04-security-anomalies.mjs:139-140), shows 'Mean severity (of 50)' (166) and a weight column in 'Why these identities scored' (233-236). 'Risk leaderboard — top identities by total severity' sorts by risk_total DESC (226-227).

### 14. Titles and table values use builder jargon and raw action names

Severity **medium** · copy · CISO, Cloud/platform admin · effort M · planned for 1.1.0

- **Impact:** Managers and admins cannot tell what 'invalidate_apikeys 29' or 'saved_object_find 504' means for them, and titles like '√events' or 'index family' add reading load without helping anyone act.
- **Fix:** Add a plain-label column next to the raw Action column (from an ACTION_LABEL CASE or lookup index: 'API keys revoked', 'Kibana object searched'), keeping the raw value clickable. Rewrite titles outcome-first, e.g. 'Most active identities, sized by activity, coloured by risk' and 'Who reads which indices'.
- **Evidence:** Titles: 'Identity footprint · area by √events, color by risk total' (00-command-center.mjs:138), 'Signal vs noise over time · all traffic' (00:151), 'Live signal feed · Kibana key clean-up left out' (00:194), 'Who reads which index family · up to 10 identities' (03-data-access.mjs:206), 'Top transport actions' (03:216), 'Proxy vs real client IP, by proxy' (05-geo-network.mjs:248), 'What they read, by index family' (07-actor-360.mjs:270). Action columns show raw event.action values so they can be clicked to filter (e.g. 'Most frequent actions', 00:155-157); panels.mjs has no plain-label lookup for actions. The Live signal feed's Request column is the one readable description of an action.

### 15. Geo & Network gives prime space to proving source.ip is a proxy, and calls a country count 'impossible travel'

Severity **low** · copy · SOC analyst, CISO · effort M · planned for 1.1.0

- **Impact:** The proxy-proof tile and table answer a builder's question, not an analyst's, and take space on the page. Labelling a distinct-country count 'impossible travel' flags every VPN user and misses fast moves within one country, so analysts learn to distrust it.
- **Fix:** Move the proxy tile and table into a collapsed diagnostics section or to Platform Volume. Rename the table and tile 'People seen from several countries' and drop 'impossible travel' from the description. Add a velocity table of consecutive locations with implied km/h, reusing the vega/10 calculation.
- **Evidence:** 05-geo-network.mjs: 'Proxy IPs' tile (167-169) and 'Proxy vs real client IP, by proxy' table (248-251); 'Multi-country people' tile tip calls it 'the impossible-travel signal' (177); 'Countries per person (impossible travel) · no service credentials' is COUNT_DISTINCT of countries with no timing (208-212); the dashboard description reads 'Impossible-travel detection.' (254). Speed logic exists in Identity 360's map: vega/10-actor-geography.json:144 classes consecutive locations as >300 km/h or >900 km/h.

### 16. Colour-only encodings and emoji in titles hurt accessibility

Severity **medium** · other · SOC analyst, CISO, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** Colour-blind readers cannot rank severity on the treemap's smaller tiles (only tiles with room print 'risk N') or read cell values on two heatmaps, which show counts only by shade. Screen-reader users hear 'warning sign' or 'police light' before dashboard and panel titles.
- **Fix:** Replace SEVERITY_RAMP with a colour-blind-safe sequential ramp that varies in lightness (viridis-like) and let layout.mjs enforce it. Add a text mark with the count to the two heatmaps, as vega/02 does. Replace panel-title emoji with a text marker such as 'Review:' and drop emoji from dashboard titles, or confirm the screen-reader cost is acceptable for the dashboard list.
- **Evidence:** SEVERITY_RAMP is green → yellow → orange (#54B399, #D6BF57, #E7664C; panels.mjs:1077), used by the Identity footprint treemap and 'Highest-severity actions, by how rare' (04-security-anomalies.mjs:190). vega/03-object-verb-heatmap.json ('Object type × operation', 02-kibana-objects.mjs:173) and vega/04-actor-index-matrix.json ('Who reads which index family', 03-data-access.mjs:206) draw rects only, with values in the tooltip; vega/02-auth-matrix.json prints values. Emoji open every dashboard title ('[Audit] 🎛️ Command Center' … '[Audit] 👤 Identity 360') and panel titles '⚠️ Mutations…' (02:164), '⚠️ Who touched system and hidden indices' (03:236), '🚨 Config changes…' (04:184), '⚠️ What they changed…' (07:251), '⚠️ System and hidden index reads' (07:274). layout.mjs:353 checks only that ramps are MAGNITUDE_RAMP or SEVERITY_RAMP.

### 17. With nobody selected, Identity 360 shows project-wide totals under the heading 'Everything one person did, on one page', and nothing labels them as covering all identities.

Severity **low** · other · SOC analyst, CISO · effort S · planned for 1.0.7.4

- **Impact:** A reader who opens Identity 360 without picking an identity can take the Events, Risk, Index families and Client IPs tiles for one person's footprint. The only hint that the page covers everyone is one clause in the intro.
- **Fix:** Add a short 'Pick an identity in the Identity dropdown, or click a Principal id in Who this is' prompt that appears when nothing is selected, and add 'all identities' to the tile secondary lines (or titles) when the Identity dropdown and pills are empty.  'Who this is' already serves as the pick list, so it needs no change.
- **Evidence:** scripts/lib/dashboards/07-actor-360.mjs:114 heading 'Everything one person did, on one page'; :117 intro 'with nobody selected, the page covers everyone'; :193-212 tiles titled 'Events', 'Risk', 'Index families', 'Client IPs' whose titles do not change with the selection. 'Who this is — by identity and principal id' (:189-192) lists the 10 busiest identities with a clickable Principal id.

### 18. A session-bar click overwrites the time range with no way back

Severity **medium** · navigation · SOC analyst · effort M · planned for 1.0.7.2

- **Impact:** Clicking a session bar changes the investigation's time range, and getting back means removing the pill and setting the range by hand.
- **Fix:** Have the session-gantt spec keep the previous range and show a 'Back to previous range' mark after a zoom. Drilldowns stay in the same tab, as Kibana's own dashboard links do; Cmd/Ctrl-click opens a new tab.
- **Evidence:** vega/13-session-gantt.json:33 calls kibanaSetTimeFilter with no saved previous range; scripts/lib/dashboards/02-kibana-objects.mjs:141 and 07-actor-360.mjs:124 how-to: 'remove the pill and reset the time to return'.

### 19. No table or saved search shows the request id, opaque id, trace id or span id, so one script run or one Kibana request cannot be followed across its events.

Severity **medium** · investigation · SOC analyst, Compliance auditor · effort S · planned for 1.0.8

- **Impact:** Most traffic comes from API keys, and those identities have no session timeline. An analyst cannot group the events of one script run, or tie a Kibana request to the Elasticsearch events it caused, without writing a query by hand.
- **Fix:** Add filterable Request id (http.request.id) and Opaque id (x-opaque-id) columns to the All audit events and Raw signal feed searches. Add an 'API run reconstruction' search grouped by x-opaque-id, or by identity and client IP with gaps under 5 minutes, with click-to-filter on the raw field.
- **Evidence:** Columns of searches/00-all-events.json, 10-raw-signal-feed.json and 09-session-reconstruction.json include no http.request.id, http.request.header.x-opaque-id, trace.id or span.id. http.request.id appears only inside queries: 06-platform-volume.mjs:119 (COUNT_DISTINCT on 'All events') and 07-actor-360.mjs:82 (CASCADE_KEY). Command Center's 'Live signal feed' Request column (00-command-center.mjs:196) names what was touched, not an id. 07-actor-360.mjs:124: 'API-only identities have no sessions.'

### 20. User roles are never shown, so no panel answers which roles did what or whether privileged roles are used.

Severity **medium** · investigation · Cloud/platform admin, Compliance auditor · effort S · planned for 1.0.8

- **Impact:** Admins cannot find activity by holders of superuser or admin roles, and access reviews that compare granted privilege with actual use have nothing to work from.
- **Fix:** Add a Roles column (user.roles, filterable) to 'Who this is — by identity and principal id' on Identity 360 and to 'Busiest human identities' and 'Identity first and last seen' on Identity & Access. Add a 'Privileged-role activity' table on Security Anomalies: events and actions by identity where user.roles includes a superuser or admin role.
- **Evidence:** A grep for user.roles in scripts/lib, searches/, vega/ and README.md finds nothing. user.full_name is left out on purpose because it is empty for some identities (controls.mjs:6, README.md:219, 01-identity-access.mjs:271). Command Center's 'Privileged ops' tile (00-command-center.mjs:116) counts privileged actions, not role holders.

### 21. Object names and computed index families cannot be clicked, and there is no Object or Space dropdown, so 'who else touched this object or index family' means typing a filter by hand.

Severity **medium** · investigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.7.5

- **Impact:** An analyst who finds a suspicious dashboard, rule or index family cannot pivot to everyone who touched it in one click. On Identity 360, the Space in 'What they changed' is not clickable either.
- **Fix:** Add a filterable Object id (kibana.saved_object.id) column next to Object on the Kibana Objects tables and on 'What they changed', and make Space filterable there (kibana.space.id). Give 'Top index families by events' and 'What they read, by index family' a filterable representative index, as 'System and hidden index reads' does. Optionally add a Space dropdown to Kibana Object Forensics.
- **Evidence:** 02-kibana-objects.mjs: Space is filterable on 'Mutations' (:167) and on 'Kibana saved-object activity' (:245, with Action); Object type is filterable on 'Busiest objects' (:199) and 'Object types' (:232); the Object column is plain on all of them. 03-data-access.mjs:212-214 'Top index families by events' shows Index family as a plain column. 07-actor-360.mjs:261 'What they changed' columns verb/type/name/space are all plain; :270-272 'What they read, by index family' is plain. Only '⚠️ System and hidden index reads' (:284) offers a filterable 'Index (one per family)'. controls.mjs defines Project, Identity type, Identity and Client IP only.

### 22. There is no API key hygiene view: no list of stale keys, widely shared keys or rotation cadence.

Severity **medium** · capability · Cloud/platform admin, CISO · effort M · planned for 1.0.8

- **Impact:** Admins cannot find keys unused for 30 days or more, keys used from many IPs or countries, or keys whose creator no longer appears. 'API key inventory' only lists keys that were used in the picker's range, ranked by volume.
- **Fix:** Add a 'Key hygiene' table on a fixed 90-day panel window: days since last use, IP and country counts with keys over a threshold flagged, create and invalidate events per key name (rotation cadence), and whether the creator has any activity in the window. State in the panel description that keys never used do not appear in the audit stream.
- **Evidence:** 01-identity-access.mjs:118-124 KEY_INVENTORY reads TIME (the picker) and keeps api_key, api_key.id, user.name, owner, first_seen, last_seen, events, ips, indices; no fixed window, no IP threshold, no create/invalidate count per key. Key ID and Principal id are click-to-filter. Nothing on the page says that a key never used is absent from the audit stream.

### 23. The suite installs only into the Default space with no named viewer role, no field-level guidance for emails and IPs, and no message on the pages for readers who lack read on the audit stream.

Severity **medium** · access · Cloud/platform admin, Compliance auditor, CISO · effort S · planned for 2.0.0

- **Impact:** Anyone with read on the audit stream and access to Default sees emails, client IPs and actions. Readers with dashboard access but no index read get failing panels with no explanation. Anyone with dashboard write in Default can edit or delete the suite, and nothing alerts on it.
- **Fix:** Publish a minimal 'audit_viewer' role (read on the stream and the view, Kibana dashboard read) in the README. Offer an optional --space flag for a dedicated space. Recommend field-level security on client.ip and user.email for non-security readers. Add one intro line on each page saying it needs read on the audit stream, and alert on changes to elastic_cloud-audit-* objects.
- **Evidence:** README.md:12, 17, 30: installs into Default. README.md:1001: 'Dashboard viewers: read on the audit data stream and on logs-cloud-audit-events-view (a role on logs-* covers both)'; README.md:442 view privileges. No viewer-role definition, field-level-security advice or dedicated-space option in README.md; no page intro in scripts/lib/dashboards/*.mjs mentions the read requirement.

### 24. The Project dropdown lists and matches project names, so same-named projects merge, and no panel compares risk or changes across projects.

Severity **medium** · navigation · Cloud/platform admin, CISO · effort S · planned for 2.0.0

- **Impact:** In an organisation with several projects, two projects called 'prod' read as one. A CISO cannot see which project carries the risk without picking each one in turn.
- **Fix:** Build the Project option as 'name (id prefix)' and match on project.id. Add a 'Risk and changes by project' table on Command Center with a filterable project.id column.
- **Evidence:** controls.mjs:85-86 Project options from project.name; :210 PROJECT_WHERE = project.name == ?project. No panel in scripts/lib/dashboards/*.mjs groups by project or shows project.id; only vega/12-actor-cohort.json groups by project.

### 25. The cost each dashboard view adds to the audit stream is unmeasured, and load times are published only up to 7 days on one replica.

Severity **low** · performance · CISO, Cloud/platform admin · effort M · planned for 2.0.0

- **Impact:** With a wide audience, every view adds audit events, storage and compute to the stream it reads. Load times at 30 or 90 days on a busy organisation are unknown.
- **Fix:** Measure and publish the audit events and bytes one view of each dashboard generates. Run ./audit --perf with 30d and 90d windows on a larger replica. Decide whether the executive and trend views should read a summary stream (transform or ES|QL rollup).
- **Evidence:** README.md:881-905 Performance: 117 queries per window, windows 1h, 24h and 7d on a 2,625,300-event replica; slowest load 3.2s (Platform Volume, 7d). README.md:46 notes that viewers' own queries are audited. No measurement of events or bytes per view, no 30- or 90-day timings, no summary stream.

### 26. Time charts carry no annotations for known events, and nothing links a panel to Cases.

Severity **low** · capability · SOC analyst, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** Known deploys, maintenance and declared incidents are not marked on the charts, so the same spike gets investigated again. Findings cannot be attached to a case from the dashboard.
- **Fix:** Add an annotation layer to the time charts from an 'audit-annotations' index, with an ./audit subcommand to add entries. Document 'Add to case' from Lens panels where the project type supports it, and ship a case template.
- **Evidence:** No annotation layer in any xy() panel in scripts/lib/dashboards/*.mjs; no audit-annotations index or CLI; grep for 'annotation', 'Cases' and 'add to case' in scripts/lib and README.md finds only unrelated hits (ES|QL CASE, lint annotations in panels.mjs).

## Use cases

| Id | Personas | Question | Coverage | Planned for |
| --- | --- | --- | --- | --- |
| UC-001 | Admin, Analyst, Auditor | Which identities and source IPs had the most failed authentications in the last 24h, how many per user and per IP, and from where? | Answered |  |
| UC-002 | Admin, Analyst, Auditor, Manager | Alert when any IP or identity goes over N failed authentications in a short window (10 in 5 or 15 min, 6 in 30 min), including password spraying across many principals. | Answered |  |
| UC-003 | Admin, Analyst, Auditor | Did a successful login follow a burst of failures from the same IP or account (brute-force success)? | Answered |  |
| UC-004 | Admin, Analyst | Is one public IP failing authentication against many different usernames or API keys (spraying), not one account repeatedly? | Partly | Out of reach |
| UC-005 | Auditor, Manager | What is the failed-authentication rate (failed / all attempts), and how does it trend week over week? | Partly | 1.0.7.6 |
| UC-006 | Admin | Is a client hammering /_security/_authenticate or another endpoint with bad credentials, such as an integration holding a stale key? | Partly | 1.0.7.1 |
| UC-007 | Admin | Which internal or platform principals (autoscaling, elasticsearch-controller) fail realm authentication, and is that noise I should exclude? | Partly | 1.0.7.1 |
| UC-008 | Admin | Are any user accounts locked out after repeated failed logins? | Not in the data | 2.0.0 |
| UC-009 | Analyst, Manager | Who is generating anonymous_access_denied (scanners on the public endpoint): how many, from where, which paths, and is it rising? | Partly | 1.0.7.1 |
| UC-010 | Analyst, Auditor, Manager | Which authentication methods are used (SAML SSO, API key, token, native realm), what share each has, and did any human authenticate other than through SSO? | Partly | 1.0.7.6 |
| UC-011 | Analyst, Auditor, Manager | Can we prove MFA was used for every interactive (admin) login, and what share of human logins were MFA-protected? | Not in the data | 2.0.0 |
| UC-012 | Analyst, Auditor | Reconstruct a Kibana session, or list a user's sessions: when it started, from which IP, which spaces and objects it touched, and when it ended. | Answered |  |
| UC-013 | Admin, Analyst, Auditor | Was the same Kibana session id used from more than one public IP or country mid-session (possible cookie theft)? | Partly | 1.0.7.6 |
| UC-014 | Admin, Auditor, Manager | How many Kibana sessions were there, how long did they last on average, and which were long-lived (>12h), suggesting idle timeouts are not enforced? | Partly | 1.0.7.6 |
| UC-015 | Admin | How many distinct humans logged into Kibana each day this month? | Partly | 1.0.7.6 |
| UC-016 | Admin, Analyst, Auditor | Did any human identity authenticate from two locations too far apart for the elapsed time (impossible travel)? | Partly | 1.1.0 |
| UC-017 | Manager | Alert me on impossible travel: the same human identity seen from two countries within an hour. | Needs alerting or retention | 1.2.0 |
| UC-018 | Admin, Analyst, Manager | Which users logged in from a country, city or ASN they had not used in the previous 30 days (new country this week or month)? | Needs alerting or retention | 2.0.0 |
| UC-019 | Auditor, Manager | Which countries do we see access from in total, and how much from each? | Answered |  |
| UC-020 | Auditor, Manager | Which logins or admin actions came from countries outside our approved list, and what share of authentications is that? | Partly | 2.0.0 |
| UC-021 | Admin, Analyst, Auditor, Manager | List every public IP that reached the project and the identities behind each, and flag access from outside our corporate egress or CI ranges. | Partly | 2.0.0 |
| UC-022 | Admin, Analyst, Manager | Which requests came from Tor exits, hosting or VPS providers, cloud providers, or IPs on our threat-intel blocklist? | Not in the data | 2.0.0 |
| UC-023 | Analyst, Auditor, Manager | List every API key created in the period: who created it, its name, expiration and role descriptors. | Answered |  |
| UC-024 | Auditor, Manager | For keys created this quarter, which are still valid and which were invalidated (what fraction), and how many keys are active right now? | Partly | 1.0.9 |
| UC-025 | Admin, Analyst, Auditor | Which API keys were created with no expiration, or with an expiration beyond our 90-day rotation policy? | Partly | 1.0.8 |
| UC-026 | Admin, Analyst | Which new or changed API keys carry superuser-like role descriptors (cluster all, indices * with all/write/manage, run_as, or empty descriptors that inherit the creator's privileges), and who created them? | Partly | 1.0.8 |
| UC-027 | Admin, Analyst, Auditor, Manager | Which API keys created in the last 90 days have never been used to authenticate? | Partly | 1.0.9 |
| UC-028 | Auditor, Manager | Which API keys are older than our 90-day rotation policy and still in use? | Needs alerting or retention | 1.0.9 |
| UC-029 | Admin, Manager | Which API keys active last quarter have not been used in 30+ days (dormant), so I can expire them? | Needs alerting or retention | 1.0.9 |
| UC-030 | Analyst | Did any API key that was dormant for 30+ days suddenly become active? | Needs alerting or retention | 1.0.9 |
| UC-031 | Admin, Analyst, Auditor | Who invalidated API keys, how many and which ones, and were they their own keys or someone else's? | Partly | 1.0.8 |
| UC-032 | Auditor | Alert when API keys are invalidated in bulk, or by someone other than the owner (owned_by_authenticated_user=false). | Answered |  |
| UC-033 | Admin, Analyst | Which API keys had their role descriptors or metadata updated (change_apikey) and by whom, and did their privileges widen? | Partly | 1.0.9 |
| UC-034 | Admin, Auditor | Which API keys were minted by other API keys (key-creates-key chains) rather than by a person, and who ultimately owns them? | Partly | 1.0.8 |
| UC-035 | Admin | How many API keys does each person own and actively use (key sprawl per user)? | Partly | 1.0.8 |
| UC-036 | Admin | Which Cloud-console or org keys (_cloud_api_key) and which project-native Elasticsearch keys (_es_api_key) are touching this project? | Answered |  |
| UC-037 | Manager | Which human created the API keys that generate most of our traffic, and is that person still with the company? | Partly | 2.0.0 |
| UC-038 | Admin, Auditor | List the API keys a departing user created that are still active (used recently and not invalidated). | Partly | 1.0.8 |
| UC-039 | Admin, Manager | Is the same API key being used from many distinct public IPs or countries, suggesting it is shared or leaked? | Partly | 1.0.8 |
| UC-040 | Admin, Analyst | Alert when an API key that normally calls from known egress IPs is used from a public IP or country it has not used in the previous 30 days. | Needs alerting or retention | 1.2.0 |
| UC-041 | Admin | Is any API key used by more than one client application (different x-opaque-id values or URL patterns), suggesting a shared credential? | Partly | 1.0.9 |
| UC-042 | Auditor, Manager | Are API keys or service credentials being used interactively, for example by a human working in Kibana with a service key? | Partly | 1.0.8 |
| UC-043 | Analyst | An API key is confirmed leaked: which indices did it read or write, which actions did it take, and from which IPs, since it was created? | Partly | 1.0.8 |
| UC-044 | Analyst | Did the compromised identity mint further API keys or roles (child credentials) that must also be revoked, and have those been used? | Partly | 1.0.8 |
| UC-045 | Admin, Analyst, Auditor | Show every role create, update and delete (put_role, delete_role, put_privileges) in the last 30 days or quarter, with who, when, from where and the role definition, for the SOC 2 binder. | Partly | 1.0.8 |
| UC-046 | Admin, Analyst, Auditor | Show every role or API key change made outside business hours or at weekends last quarter. | Partly | 1.0.8 |
| UC-047 | Admin, Auditor, Manager | Did anyone change role mappings (SAML group to role), which silently change who is privileged? | Not in the data | 2.0.0 |
| UC-048 | Admin | Which roles were granted write or manage privileges on indices holding sensitive data (pii-*, billing-*)? | Partly | 1.0.8 |
| UC-049 | Auditor, Manager | Alert in real time when any role or API key grants run_as, cluster 'all' or index 'all', when a role is deleted, or when a superuser-level key is created. | Answered |  |
| UC-050 | Admin | Alert immediately on any security config change made by an API key rather than a human. | Answered |  |
| UC-051 | Admin, Analyst, Auditor, Manager | When were user profiles activated or updated (first-time users), by which IdP identity, and does that match the HR joiners list? | Answered |  |
| UC-052 | Manager | How many privileged security configuration changes happened this week, and by whom, compared with our weekly baseline? | Partly | 1.0.8 |
| UC-053 | Analyst, Auditor, Manager | Did any principal escalate itself: denied, then created a role or key, then succeeded on the same resource; or created a key or role and then used it for privileged changes (segregation-of-duties violation)? | Partly | 1.2.0 |
| UC-054 | Admin | Is an integration's API key repeatedly denied after a role change? Correlate denials with a recent put_role or change_apikey. | Partly | 1.0.8 |
| UC-055 | Admin, Analyst, Auditor, Manager | Which identities hold admin, superuser or billing-admin roles, how many are there, did the count change, and how often did each use them? | Partly | 2.0.0 |
| UC-056 | Auditor | Produce a log of every action performed by admin-role identities (human and API key) during the period, for PCI 10.2.1.2. | Partly | 1.0.8 |
| UC-057 | Manager | What share of our activity is done by admin-role identities rather than least-privilege roles, what share of admin activity happens after hours, and which admins account for most of it? | Partly | 1.0.8 |
| UC-058 | Analyst | Which identities' effective roles (user.roles) changed compared with last week? | Needs alerting or retention | 1.0.8 |
| UC-059 | Admin | Which identities have privileged-action capability but have not used it in 90 days, so least privilege can be applied? | Not in the data | 2.0.0 |
| UC-060 | Manager | Was the break-glass or built-in elastic superuser, or an Elastic operator account, used this month, and for what? | Partly | Out of reach |
| UC-061 | Manager | Did Elastic staff or any third-party or vendor identity access our project this quarter? | Partly | Out of reach |
| UC-062 | Admin, Analyst, Auditor, Manager | Which identities are hitting access_denied, on which actions and indices, how often, and is anyone probing for access they do not have? | Answered |  |
| UC-063 | Admin, Analyst | Which Kibana saved-object or space operations failed (outcome failure), and who tried them, for example repeated forbidden writes? | Answered |  |
| UC-064 | Manager | What is our failed-change rate: what share of create and update attempts on saved objects and spaces failed? | Partly | 1.0.7.5 |
| UC-065 | Admin | Has a newly onboarded user actually logged in and reached the spaces they need, or are they hitting access_denied? | Answered |  |
| UC-066 | Analyst, Auditor | Were any requests made with run_as or impersonation, and on whose behalf? | Not in the data | 1.0.7.6 |
| UC-067 | Admin, Auditor | Access review: list every identity with its roles, authentication type, first and last seen, event count and distinct IPs, and whether it was active in the last 90 days. | Partly | 2.0.0 |
| UC-068 | Admin, Manager | Who actually accessed this project in the last 30 days, humans and machines, and how did each authenticate? | Answered |  |
| UC-069 | Auditor, Manager | Which users with access, privileged ones especially, have not logged in for 30, 60 or 90 days, so we can deprovision them? | Not in the data | 2.0.0 |
| UC-070 | Analyst, Manager | Which identities (users or API keys) appeared in the audit stream for the first time this week, and how many? | Partly | 1.0.8 |
| UC-071 | Admin, Auditor | Did any terminated employee or leaver authenticate, or have their keys used, after their termination date? | Partly | 2.0.0 |
| UC-072 | Manager | How many distinct identities (people and API keys separately) were active in each project this month, and is the number growing? | Partly | 1.0.8 |
| UC-073 | Admin, Auditor | Which service accounts and other non-human identities are active, from where, and what do they access? | Partly | 1.0.8 |
| UC-074 | Admin, Analyst | Are service account tokens being used from anywhere other than the expected Kibana or internal workload, or against unexpected APIs? | Needs alerting or retention | 1.2.0 |
| UC-075 | Analyst | Which identities' hourly event volume today deviates most from their own 14-day baseline? | Partly | 1.1.0 |
| UC-076 | Analyst, Manager | Which human users were active between 22:00 and 06:00 or at weekends this month, and what did they change? | Partly | 1.1.0 |
| UC-077 | Manager | Did any single identity's risk score jump more than 3× compared with its own previous 4-week average? | Needs alerting or retention | 1.2.0 |
| UC-078 | Admin, Auditor, Manager | Which identities or integrations show a sudden spike in data reads or request volume against their baseline (3× over 7 days, 5× over 30 days), suggesting bulk export or a runaway client? | Needs alerting or retention | 1.2.0 |
| UC-079 | Admin | Which API keys or integrations generate the most audit events and requests per minute, and is any of them a runaway client? | Answered |  |
| UC-080 | Admin | Which clients poll health or monitor endpoints (cluster:monitor/main, _security/_authenticate) far more often than needed? | Answered |  |
| UC-081 | Manager | Who are the top 10 riskiest identities this month, and what share of total risk do they account for? | Partly | 1.1.0 |
| UC-082 | Manager | What was our average event severity or risk per day this month, and what were the three worst days and why? | Partly | 1.1.0 |
| UC-083 | Analyst | Who enumerated security configuration (roles, users, API keys, privileges), and how often compared with their baseline? | Partly | 1.0.7.7 |
| UC-084 | Analyst | Which identities listed indices, mappings, cluster state or field caps across many indices they do not normally touch? | Partly | 1.0.7.7 |
| UC-085 | Admin, Analyst, Auditor, Manager | Who read indices matching my sensitive patterns (pii*, customers-*, hr-*, .security*), how many times, through which API, and was it a human or an API key? | Partly | 1.0.9 |
| UC-086 | Admin | Who read sensitive indices this month through an API key whose owner has left or which has since been invalidated? | Partly | 2.0.0 |
| UC-087 | Admin, Analyst | Which identity read the most distinct indices, or ran unusually many search, scroll or PIT requests, in the last 24h, and which carries the most read and write load per index pattern (chargeback)? | Partly | 1.0.9 |
| UC-088 | Manager | Is the volume of reads on sensitive indices up or down compared with last month? | Needs alerting or retention | 1.0.9 |
| UC-089 | Auditor | Who accessed the audit log data stream itself (logs-elastic_cloud.serverless_audit*): reads, and any write or delete attempts? | Answered |  |
| UC-090 | Analyst, Auditor | Who wrote or bulk-indexed into indices they normally only read, or into system, security or regulated indices? | Partly | 1.0.9 |
| UC-091 | Auditor | Which specific documents or records of data subject X were accessed, and by whom (DSAR or breach scoping)? | Not in the data | Out of reach |
| UC-092 | Analyst | What exactly did the attacker search for: the ES\|QL or query DSL text they ran? | Not in the data | Out of reach |
| UC-093 | Analyst | Who viewed a specific sensitive dashboard or saved search (for example HR investigations) in the last 30 days? | Answered |  |
| UC-094 | Analyst | Has anyone used reindex (especially remote reindex), async search or similar bulk paths to pull large data sets out? | Partly | 1.0.9 |
| UC-095 | Analyst, Auditor | Who exported or imported Kibana saved objects (_export / _import), and which objects? | Partly | 1.0.9 |
| UC-096 | Analyst | Which users generated CSV or PDF reports or Discover CSV downloads, and of what data? | Partly | 2.0.0 |
| UC-097 | Admin, Analyst, Auditor, Manager | Who deleted indices or data streams, or ran delete_by_query, in the last 7 days or month, including denied attempts (and snapshots)? | Partly | 1.0.9 |
| UC-098 | Analyst | Alert me when a single identity deletes more than N saved objects or indices within 10 minutes. | Needs alerting or retention | 1.2.0 |
| UC-099 | Admin, Analyst | Who created indices, or changed mappings or index settings, in the last 7 days? | Partly | 1.0.9 |
| UC-100 | Admin, Analyst, Auditor, Manager | Which detection or alerting rules were disabled, deleted, snoozed or modified, by whom, and were they re-enabled? | Answered |  |
| UC-101 | Analyst, Auditor | Were alert connectors (Slack, email, PagerDuty, webhook) created, changed or deleted, so that alerts stop reaching the SOC or a webhook points to an external URL? | Partly | 2.0.0 |
| UC-102 | Admin, Analyst, Auditor | Did anyone tamper with audit logging: the enriching ingest pipeline, the audit data stream's lifecycle or settings, or deleting audit data? | Partly | 1.0.9 |
| UC-103 | Analyst | Which dashboards, saved searches or data views used by the SOC were modified or deleted, and what was the before and after? | Partly | 2.0.0 |
| UC-104 | Admin, Analyst, Auditor, Manager | Who created, changed, ran or deleted Kibana workflows, Agent Builder agents and tools, or scheduled rules that could run code or exfiltrate data? | Answered |  |
| UC-105 | Auditor, Manager | Kibana change log: who created, modified or deleted dashboards, rules, connectors and data views, with object names and spaces, and how many changes each person made this week? | Partly | 1.0.8 |
| UC-106 | Admin | Which saved objects (dashboards, data views, rules) were deleted in the last 7 days, and by whom? | Answered |  |
| UC-107 | Auditor | Show the full change history of a specific saved object (by id) across its lifetime. | Answered |  |
| UC-108 | Auditor | Who viewed the audit dashboards and Discover sessions, and when, as proof that the security team performs log review? | Answered |  |
| UC-109 | Manager | Who are the top 5 people making changes this month, and how does their change volume compare with last month? | Partly | 1.1.0 |
| UC-110 | Admin, Analyst, Auditor, Manager | Who created or deleted Kibana spaces, and when? | Answered |  |
| UC-111 | Auditor | Which users accessed which spaces, to confirm segregation (for example, only the finance team used the 'finance' space)? | Answered |  |
| UC-112 | Analyst | Did anyone access a Kibana space they had never used before? | Needs alerting or retention | 1.0.8 |
| UC-113 | Admin, Manager | Which teams and spaces actually use Kibana: active users, object edits and risk per space, week over week? | Partly | 1.0.7.5 |
| UC-114 | Admin | Are any spaces unused (no access in 60 days), so I can archive them? | Needs alerting or retention | 1.0.9 |
| UC-115 | Analyst | An alert fired on identity X: show everything it did in the hour before and after, across Elasticsearch and Kibana, in one timeline. | Answered |  |
| UC-116 | Analyst | Pivot from a suspicious IP: every identity, project and action seen from it in the last 30 days. | Partly | 1.0.9 |
| UC-117 | Analyst, Auditor | Tie a Kibana UI action to the exact Elasticsearch requests it triggered (end-to-end trace). | Not in the data | 1.0.7.2 |
| UC-118 | Analyst | Produce a minute-by-minute incident timeline for a fixed window (for example 14:00–16:00 yesterday), showing only changes and security events, for the post-incident report. | Answered |  |
| UC-119 | Auditor | Give me a random sample of 25 security-relevant changes from the quarter, with full event detail, to trace each to an approved change ticket. | Partly | 1.0.9 |
| UC-120 | Auditor | Export all security configuration change events for the period to CSV, with timestamps, actor and outcome, for the auditors' evidence binder. | Partly | 1.0.9 |
| UC-121 | Auditor | For any given event, can I see user identity, event type, date and time, success or failure, origin and affected resource (PCI 10.2.2 completeness)? | Answered |  |
| UC-122 | Analyst | Is the same human or API key active across multiple serverless projects, and did activity spread to a new project during the incident window? | Partly | 2.0.0 |
| UC-123 | Admin, Auditor, Manager | Across all our serverless projects, compare activity, privileged changes, API-key activity, failed-auth rate and distinct identities per project. | Partly | 2.0.0 |
| UC-124 | Admin, Analyst, Auditor, Manager | Who invited or removed Cloud organization members, changed their organization or project role assignments, or created and deleted projects? | Not in the data | 2.0.0 |
| UC-125 | Admin, Analyst | Alert me if audit events stop arriving from either the Elasticsearch or the Kibana source for more than 15 minutes. | Answered |  |
| UC-126 | Auditor, Manager | Are there gaps in audit logging: any hour or day with zero events from Elasticsearch or Kibana, any delivery gap over 15 minutes, or measurable ingest lag? | Partly | 1.0.9 |
| UC-127 | Auditor | Prove audit logs are retained for 12 months, with 3 months immediately available, and show we are audit-ready: oldest event, every project logging, all categories present. | Partly | 1.0.9 |
| UC-128 | Auditor | Provide evidence of daily review of security events: a daily summary of failures, denials and config changes. | Needs alerting or retention | 1.2.0 |
| UC-129 | Auditor | Notify the compliance channel within 15 minutes of any admin-role assignment, security config change or audit-index access. | Partly | 1.2.0 |
| UC-130 | Manager | What is our mean time to detect a privileged change, and what share of high-risk events did the SOC review within 24 hours? | Not in the data | 1.2.0 |
| UC-131 | Auditor | Which client tools (browser, curl, Terraform, SDK) were used for privileged changes? | Not in the data | Out of reach |
| UC-132 | Manager | Are we getting better? This week's signal events, failed authentications and privileged changes against last week, with a percentage change arrow for each. | Partly | 1.1.0 |
| UC-133 | Manager | A one-page monthly board summary (active identities, privileged changes, failed logins, access denials, new API keys, new countries), each with a month-over-month trend. | Needs alerting or retention | 1.1.0 |
| UC-134 | Manager | Is risk concentrated in a few API keys (automation) or spread across people? Show the human-versus-machine split of risk and activity. | Answered |  |
| UC-135 | Manager | What fraction of our audit volume is automation or noise rather than human signal, and is human signal trending up? | Answered |  |
| UC-136 | Manager | Show a 12-week trend of distinct active API keys against distinct active humans, to see whether automation sprawl is growing. | Needs alerting or retention | 1.1.0 |
