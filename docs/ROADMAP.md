# Cloud Audit Suite Review

<!-- Generated from docs/roadmap.html by `node scripts/roadmap.mjs`. Edit the page, not this file. -->

How well the seven dashboards and twelve Discover sessions serve SOC analysts, compliance auditors, platform admins and security managers: where the design gets in their way, which of their questions it answers, and what comes next.

Reviewed **2026-11-10** against release **1.0.8**, updated for **1.0.8.1** · 136 use cases · 31 open design holes. The full page, with filters and every
use case's detail, is [`docs/roadmap.html`](roadmap.html): download it and open it in a browser.

## Investigation works; evidence and reporting lag

- **Most questions are partly answered.** Of 136 customer use cases, 35 (26%) are answered outright and 72 (53%) partly. The usual gap is the last step: a count no panel adds up, an export that loses its context, or a field the stream has but no panel shows.
- **Following an identity works.** The Identity type and Identity dropdowns reach every kind of credential, API keys included, and every identity table and treemap tile clicks through to Identity 360 with the identity pinned. Identity 360's drill-down walks one identity's credential, space, object type and operation down to the data Kibana read, and every record panel opens its records in Discover with the page's pills. What's left: Open in Discover leaves out the dropdowns, there is no picker for one index or one saved object, and the drill-down needs keyboard access, stated cuts and a render check.
- **Six alert rules watch the sharpest signals; behaviour alerts come later.** The starter pack raises failed-sign-in bursts, a sign-in after failed sign-ins, new API keys and role changes, security changes at an unusual hour, new identities, and audit events that stop arriving. The rules ship disabled with no delivery of their own, so each customer turns them on and routes them. 17 use cases still need a rule or longer retention: alerts against an identity's own baseline (1.2.0), checks that need months of history, and first access to a Kibana space (UC-112).
- **Evidence and reporting are the weakest area.** Row caps are stated only in titles, exports drop the query and the time range, and there is no one-page summary or scheduled report.
- **Managers are served least.** 13 of their 58 questions are answered outright. Headline tiles compare with the previous period, but there is no posture summary to share.

| Coverage | Use cases |
| --- | --- |
| Answered | 35 |
| Partly | 72 |
| Needs alerting or retention | 17 |
| Not in the data | 12 |

## Roadmap

Every open design hole and every use case not answered today, placed in the release that closes it. Patch releases add to the dashboards: a run of small ones on the 1.0.8 code, 1.0.8.2 to 1.0.8.5, then 1.0.9 for identities, keys and roles and 1.0.10 for evidence. 1.1.0 adds a dashboard; 2.0.0 brings in data from outside the audit stream.

### 1.0.8.2 — Identity 360 on the time picker; drill-down fixes

Identity 360 covers the time picked and says when it is showing everyone, and its drill-down works from the keyboard, states its cuts and is checked on every deploy.

- Identity 360's 7-day and 24-hour windows, and the session timeline, end at the time picker's end
- One time zone on the page, the drill-down included
- A prompt and "all identities" labels when nobody is selected, on the tiles and the drill-down
- Data-set chips, request list and Close reachable by keyboard
- A line when the drill-down's 6,000-row limit cuts objects or requests
- Element ids that work for every index name
- --verify fails when the drill-down renders empty; a Lens fallback kept ready

6 design holes · 0 use cases

Design holes:

- **medium** — Identity 360's 7-day and 24-hour windows, and the session timeline on Kibana Objects, end at the current moment, not at the time picker, and Identity 360 mixes UTC with local time
- **low** — With nobody selected, Identity 360 shows project-wide totals and an all-identities drill-down under the heading 'Everything one person did, on one page', and nothing on the panels says they cover all identities
- **medium** — The drill-down's data-set chips, request list and Close control work only with a mouse
- **medium** — The drill-down cuts its rows at 6,000 without saying so, and the deepest levels go first
- **low** — Data-set chips do nothing for index names with characters the id builder keeps
- **medium** — Identity 360's drill-down depends on a tech-preview panel, with no render check and no fallback

### 1.0.8.3 — Pivots and records

"Who else touched this?" is one click for a saved object, a space or an index family, and every way into Discover says what it carries.

- Clickable object id and space on the Kibana Objects tables and What they changed
- A clickable representative index on the index family tables
- Per-space activity, and the failed-change share on the Mutations tile
- Drill-down links keep the time range; request rows show their id and open the Kibana request trace
- Open in Discover writes the dropdowns into the session, or says on every page that it cannot
- A "Records in Discover" links panel under the nav bar in place of the intro links

4 design holes · 2 use cases

Design holes:

- **medium** — Object names and index families cannot be clicked, and there is no Object or Space dropdown, so finding who else touched an object or index family means typing a filter or leaving for Discover
- **medium** — The drill-down's links drop the time range, and its request rows lead nowhere
- **medium** — Open in Discover silently drops the page's dropdowns everywhere except Identity 360
- **low** — Discover sessions are reached through markdown 'Raw records' links that keep only the time range, and two sessions have no link at all

Use cases:

- UC-064 — What is our failed-change rate: what share of create and update attempts on saved objects and spaces failed?
- UC-113 — Which teams and spaces actually use Kibana: active users, object edits and risk per space, week over week?

### 1.0.8.4 — Sign-in and session panels

How people sign in and how long their sessions last, on Identity & Access.

- Failed sign-ins week over week, with names and addresses tried, and authentication methods
- Session durations, long-lived sessions and sessions that change IP or country
- Daily distinct people, and run_as use
- Platform principals that fail realm authentication, and whether to exclude them

0 design holes · 7 use cases

Use cases:

- UC-007 — Which internal or platform principals (autoscaling, elasticsearch-controller) fail realm authentication, and is that noise I should exclude?
- UC-005 — What is the failed-authentication rate (failed / all attempts), and how does it trend week over week?
- UC-010 — Which authentication methods are used (SAML SSO, API key, token, native realm), what share each has, and did any human authenticate other than through SSO?
- UC-013 — Was the same Kibana session id used from more than one public IP or country mid-session (possible cookie theft)?
- UC-014 — How many Kibana sessions were there, how long did they last on average, and which were long-lived (>12h), suggesting idle timeouts are not enforced?
- UC-015 — How many distinct humans logged into Kibana each day this month?
- UC-066 — Were any requests made with run_as or impersonation, and on whose behalf?

### 1.0.8.5 — Discovery against a baseline

Elasticsearch Data Access flags enumeration and index discovery that an identity does not normally do.

- Security enumeration and index listing by identity, against that identity's own baseline

0 design holes · 2 use cases

Use cases:

- UC-083 — Who enumerated security configuration (roles, users, API keys, privileges), and how often compared with their baseline?
- UC-084 — Which identities listed indices, mappings, cluster state or field caps across many indices they do not normally touch?

### 1.0.9 — Identities, keys and roles

Show what an identity may do, not only what it did: roles, key scope and hygiene, and the request ids that tie one run together.

- Roles column and privileged-role activity
- API key hygiene: stale, widely shared, never-expiring, rotation
- Key scope parsed from create and change records
- Request, opaque and trace ids in the raw tables
- First visit to a Kibana space by an identity: a rule beside New identity seen

4 design holes · 23 use cases

Design holes:

- **medium** — A Cloud API key has no name or owner anywhere in the suite, and nothing links to the Cloud console where they are kept
- **medium** — No table shows the request id, opaque id, trace id or span id, so one API-key script run cannot be followed across its events
- **medium** — User roles are never shown, so no panel says which roles did what or whether privileged roles are in use
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

### 1.0.10 — Evidence and completeness

An auditor can prove what the suite shows: complete exports, stated totals, a switchable noise gate, and retention guidance that unlocks the long-window questions.

- "Showing N of M" on every capped table, and an evidence export with query, range, count and hash
- A noise gate that can be switched off
- The suite's own traffic marked or folded: deploys in the change lists, and the Cloud API keys that run its rules
- A tested list of the denials the stream records and the ones it misses
- Retention guidance (90 days or more) and the panels it enables: dormant keys, idle spaces, logging gaps
- Data access, exfiltration and destruction panels

7 design holes · 22 use cases

Design holes:

- **medium** — The suite's own deploys fill the mutation lists, and no time chart marks when a deploy happened
- **high** — The noise gate can't be switched off from the dashboards, and it hides API-key listing
- **high** — Row caps cut evidence at 1,000 rows or fewer, in panels and their Discover sessions, and only the title says so
- **medium** — No evidence pack: nothing exports the query, time range, row count and a hash together
- **medium** — Data coverage and retention appear only on Command Center, and the README gives no retention guidance
- **medium** — The Cloud API keys that run the suite's alert rules count as identities on every page
- **medium** — Nobody has tested which denials the serverless audit stream records, yet panels and rules read empty as good

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
- Custom panels where they earn it: a posture board on Security & Anomalies, a prior-period KPI strip on Command Center, an identity card on Identity 360

7 design holes · 9 use cases

Design holes:

- **medium** — Security & Anomalies' posture tiles and the risk score have no previous-period comparison or longer trend
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

- **medium** — The suite installs only into the Default space. It has no named viewer role, no field-level guidance for emails and IPs, no page message for readers without read on the audit stream, and no alert when a suite dashboard is edited or deleted.
- **medium** — The Project dropdown lists and matches project names, so same-named projects merge. No panel compares risk or changes across projects.
- **low** — Nobody has measured what each dashboard view adds to the audit stream. Load times are published only up to 7 days, on one replica.

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

### 1. The suite's own deploys fill the mutation lists, and no time chart marks when a deploy happened

Severity **medium** · trust · SOC analyst, CISO, Compliance auditor · effort M · planned for 1.0.10

- **Impact:** After each release, Kibana Object Forensics' Mutations table, Security & Anomalies' Mutation feed (and its Discover session) and Identity 360's 'What they changed' fill with '[Audit] …' saved-object writes from the install. An analyst reviewing changes has to recognise them and skip past. Real changes in the same window drop down the list, or out of the 30-, 100- or 1,000-row cap.
- **Fix:** Tag SUITE_INSTALL rows in the three mutation lists and in searches/01 (a 'suite install' Outcome or verb). Then sort them below other changes, or leave them out with an 'excl. N suite installs' line as the Scoring events tile does. Draw deploy times as annotations on the volume and mutation time charts.
- **Evidence:** panels.mjs:622-628 SUITE_INSTALL (comment: 'It stays in CHANGE_PRED, so 02 Mutations, 04 Mutation feed and 07 What they changed still list it'). CHANGE_PRED panels.mjs:339-346 has no install test. MUTATION_FEED 04-security-anomalies.mjs:48 filters CHANGE_PRED and HOUSEKEEPING only. 02-kibana-objects.mjs:164-165 '⚠️ Mutations' and 07-actor-360.mjs:392-393 'What they changed' read CHANGED (shared.mjs:139 = CHANGE + parsing). Only 04's Scoring events tile leaves installs out (04-security-anomalies.mjs:165-169 'excl. N suite installs'). searches/01-all-mutations.json has no install filter. No annotations anywhere in scripts/lib.

### 2. The noise gate can't be switched off from the dashboards, and it hides API-key listing

Severity **high** · investigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.10

- **Impact:** No gated panel shows an attacker enumerating API keys (security/api_key/get and /query). No gated panel shows anyone reading the audit dashboards' own objects either. The only page-level view of what the gate removes is Command Center's 'All events' vs 'Signal events' pair. No gated KPI says how much it dropped. An auditor can't show completeness from gated panels. The ungated Platform Volume dashboard is opt-in, so a default deploy doesn't include it.
- **Fix:** Add a 'Noise' ES|QL variable control (signal / include routine) that gated queries read alongside IDENTITY_WHERE. Add an 'N hidden by the noise gate' secondary line to gated KPIs. Treat api_key/get and /query as signal when the caller isn't the key's owner, or when the rate is low.
- **Evidence:** panels.mjs:832 API_KEY_READS sits inside NOISE_ES_QUERY_INTERNALS (panels.mjs:833-841). NOISE (panels.mjs:895-898) also drops authentication_success/connection_granted (panels.mjs:842) and KIBANA_INTERNALS incl. SUITE_SELF (panels.mjs:882-893). controls.mjs:85-95 CONTROLS = Project, Identity type, Identity, Client IP; no noise control. 07-actor-360.mjs:86 drill-down excludes KIBANA_INTERNALS. 00-command-center.mjs:133-135 All vs Signal events tiles are the only gate-size view. suite.mjs:32 06-platform-volume optional: 'platform-volume'.

### 3. Row caps cut evidence at 1,000 rows or fewer, in panels and their Discover sessions, and only the title says so

Severity **high** · capability · Compliance auditor, SOC analyst · effort M · planned for 1.0.10

- **Impact:** A CSV exported from a capped panel, or from the Discover session it opens, looks complete and isn't. An auditor can't tell that from the export. Over a 7-day review, records older than the newest 1,000 (10,000 in All audit events) can't be reached from the suite.
- **Fix:** Add a 'showing N of M' line to capped feeds, using a sibling COUNT over the same filter as the KPI tiles do. Add an `./audit --evidence` command that pages matching events by time through ES|QL async and writes CSV/NDJSON.
- **Evidence:** withCut panels.mjs:1362-1371 only appends '· newest N at most' / '· top N at most' to titles. LIMIT 1000: FAILED_FEED 01-identity-access.mjs:144, key inventory 01:153, first/last seen 01:174, Cross-space 02-kibana-objects.mjs:117, OBJECT_ACTIVITY 02:125, Session reconstruction shared.mjs:187, Raw system index requests 03-data-access.mjs:247, MUTATION_FEED 04-security-anomalies.mjs:48, Config-change event feed 04:248. 'What they changed · up to 100' 07-actor-360.mjs:392-393. drilldowns.mjs:82-83 'the session keeps its own LIMIT'. searches/*.json mostly LIMIT 1000; 00-all-events LIMIT 10000; 10-raw-signal-feed LIMIT 200. No panel shows a total beside its cap. main.mjs:97-109 has no export command.

### 4. Identity 360's 7-day and 24-hour windows, and the session timeline on Kibana Objects, end at the current moment, not at the time picker, and Identity 360 mixes UTC with local time

Severity **medium** · navigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.8.2

- **Impact:** When you investigate an incident from 10 days ago, the baseline, rhythm, cohort and session timeline still show the last 7 days or 24 hours, not the days around the incident. On Identity 360, a UTC hour on the baseline sits beside local-time table rows, which invites off-by-hours mistakes in a report. The drill-down prints its times in UTC inside section ②, whose tables use the viewer's time zone.
- **Fix:** Anchor the windows to the picker's end: bound the ES|QL by ?_tend minus 7 days or 24 hours instead of a panel range that ends at now. Show the baseline and rhythm hours in the viewer's zone, or put the UTC offset on every time axis on the page. Format the drill-down's times in the viewer's zone, or label them UTC beside the section's local-time tables.
- **Evidence:** scripts/lib/panels.mjs:1639-1644 VEGA_WINDOWS sets 08, 09 and 12 to now-7d → now and 13-session-gantt to now-24h → now. windowMs (:1647-1650) throws on any 'to' other than now. Identity 360 copy: 07-actor-360.mjs:253 intro 'last 7 days in UTC … Table times are in your time zone'; :373 section 'fixed 7-day window in UTC (ignores the time picker)'; :375 'Is this normal for them? — hourly (UTC)'; :377 'Working rhythm — by hour (UTC)'; :380 and :440-441 'your time zone'. 02-kibana-objects.mjs:256-258 places the same 13-session-gantt on its fixed 24 hours. The drill-down formats its times in ES|QL (UTC) and sits in section ② beside tables in the browser's zone (07-actor-360.mjs:383-386, custom/11-identity-path.html).

### 5. Security & Anomalies' posture tiles and the risk score have no previous-period comparison or longer trend

Severity **medium** · capability · CISO · effort M · planned for 1.1.0

- **Impact:** A CISO can see whether total, failed, Kibana and Elasticsearch volume rose against the prior period. They cannot see whether Mean severity, Config changes, Failures, Anonymous denials or risk went up or down, and that is the posture question. 'Risk over time' covers only the picked range, so there is no weekly view over 30 or 90 days. The lookback is 15 days, so any range over 7.5 days shows 'no full prior' on every comparison tile.
- **Fix:** Add PREV_TILES entries for Anonymous denials (a plain filter) and for Failures (FAILED_OR_DENIED, which differs from the 00 'failed-events' filter). Config changes needs a tile that leaves out housekeeping. Risk needs a RISK-scored variant, which PREV_TILES rules out today because its spec takes plain filters only. Add a weekly risk-total trend panel with its own 90-day window. Raise PREV_LOOKBACK_DAYS only after stating the extra scan cost, since the prior read doubles the window.
- **Evidence:** PREV_TILES has six keys: total-events, failed-events, es-events, esql-queries, access-denied, kibana-events (scripts/lib/panels.mjs:1731-1738). PREV_LOOKBACK_DAYS = 15 (panels.mjs:1725). The comment 'Only plain filters are tiles: NOISE, RISK and COUNT_DISTINCT tiles stay Lens' is at panels.mjs:1719-1720. prevKpi is used at 00-command-center.mjs:132 and :151, 02-kibana-objects.mjs:151, and 03-data-access.mjs:172, :180 and :184. Security & Anomalies uses plain kpi() for Mean severity, Config changes, Key invalidations, Failures, Anonymous denials and Scoring events (04-security-anomalies.mjs:154-172). 'Risk over time' buckets only the picked range (04-security-anomalies.mjs:196-199).

### 6. No one-page summary or scheduled report exists

Severity **medium** · capability · CISO, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** There is no weekly posture page to email or put in a board pack. A manager has to screenshot long, scrolling dashboards by hand: Security & Anomalies is 137 grid rows and Identity 360 is 126. Kibana's own PNG/PDF export does not work on this project.
- **Fix:** Add a compact 'Executive summary' dashboard that fits on one screen: the prior-period tiles, the top 5 risky identities and the latest config changes. Add `./audit --report --range 7d`. It renders that dashboard through the Chromium path --verify already drives and writes a PDF plus a markdown digest from the same queries.
- **Evidence:** The CLI commands are --ingest, --ingest-check, --lint, --objects, --dashboards, --rules, --verify, --queries, --demo-guide, --synth, --perf, --deploy and --clean (scripts/main.mjs:97-109). None of them produces a report; --perf writes a timing report.json (main.mjs:55). verify.mjs already takes full-page Chromium screenshots (scripts/verify.mjs:196, :214). The built dashboards are 00, 01, 02, 03, 04, 05 and 07, with no summary dashboard. Height by max y+h: dashboards/04-security-anomalies.json is 137 rows and dashboards/07-actor-360.json is 126. README.md:612 says 'Reporting API rejects `pngV2` / `printablePdfV2`'.

### 7. No evidence pack: nothing exports the query, time range, row count and a hash together

Severity **medium** · capability · Compliance auditor · effort M · planned for 1.0.10

- **Impact:** An auditor can see full identifiers and can open the filtered query in Discover. They still can't hand over a self-describing, reproducible export that states which query ran, over what range, how many records it returned, and a checksum. Building one by hand from Discover is slow and easy to get wrong, and the session caps rows and renames fields.
- **Fix:** Add `./audit --evidence --from --to [--identity]`. It writes CSV or NDJSON with the raw fields and no row cap, plus a manifest holding the ES|QL text, the range, row counts and a SHA-256.
- **Evidence:** Full ids: Principal id column shared.mjs:102-103 (PIN_PRINCIPAL / PIN_PRINCIPAL_SHORT); full Cloud key id under 'Key ID (Cloud)' on Busiest API keys by name (01-identity-access.mjs:295 comment). RAW_RECORDS shared.mjs:59 links All audit events and Raw signal feed. searches/00-all-events.json: computed, renamed columns (Time, Identity, Identity type, Source, Action, Outcome, Object, Client IP, Message…), LIMIT 10000. identityLabel/ACTOR_LABEL panels.mjs:690-693 shorten Cloud key ids in Identity columns. drilldowns.mjs:82-111 Open in Discover keeps the session's LIMIT. main.mjs:97-109 has no export or evidence flag.

### 8. Data coverage and retention appear only on Command Center, and the README gives no retention guidance

Severity **medium** · trust · Compliance auditor, CISO · effort S · planned for 1.0.10

- **Impact:** A reader on Identity & Access or Security & Anomalies who sets a 90-day or 1-year range sees only what is retained. Nothing on those pages says how far back the data goes. An empty 'Identities by first appearance in range' can mean no new identities or no data. Admins get no steps for keeping audit data long enough to satisfy an audit.
- **Fix:** Put the coverage line (first stored event and retention) in the Identity & Access and Security & Anomalies intros, or reuse the 14-data-coverage tile on those pages. Add README steps for setting data_retention on the audit data stream and archiving to a snapshot repository.
- **Evidence:** The only coverage tile is on Command Center: scripts/lib/dashboards/00-command-center.mjs:166-167 (vega COVERAGE_REF, untitled). It is built by scripts/lib/panels.mjs:1906 coverageSpec and :1940 retentionText. The intros in scripts/lib/dashboards/01-identity-access.mjs:187 and 04-security-anomalies.mjs:136 say only 'set the time picker'. 04-security-anomalies.mjs:207-210 'Identities by first appearance in range' has no coverage line. README.md:613, :634 and :852-854 describe the tile only. README has no data_retention or snapshot guidance (grep finds none).

### 9. A Cloud API key has no name or owner anywhere in the suite, and nothing links to the Cloud console where they are kept

Severity **medium** · investigation · Cloud/platform admin, SOC analyst · effort S · planned for 1.0.9

- **Impact:** An admin can copy a key's full id, but has to search the Cloud console by hand for its name, owner or purpose before revoking or rotating it. API key inventory lists the owner as 'Cloud organization'. Identity cells show only the first five characters of the id, so to tell two similar keys apart a reader has to check the Principal id column. Two tables have no Principal id column: Denied requests by identity on Elasticsearch Data Access and Highest-volume identities on Platform Volume.
- **Fix:** Put a link to the Cloud Organization API keys page beside Cloud API key ids, as a How to read bullet or a URL-formatted column. Support an optional user-maintained lookup index (key id → name, owner, purpose) and join it into the identity tables with ES|QL LOOKUP JOIN.
- **Evidence:** Full ids appear in PIN_PRINCIPAL / PIN_PRINCIPAL_SHORT (scripts/lib/dashboards/shared.mjs:102-103), in 'Key ID (Cloud) / creator' on 'Busiest API keys by name' (01-identity-access.mjs:300-302) and in the Principal id column of 'API key inventory' (01:355-356). That table's Key ID column is api_key.id, which is empty for a Cloud key, and its owner is set to "Cloud organization" (01:155). Identity cells are shortened to '_4KEO… · Cloud API key' (panels.mjs:660-693). Tables with no Principal id: 03-data-access.mjs:233 and 06-platform-volume.mjs:217 (noPin). README.md:253 says the name and creator are in the Cloud console, but no page links there. scripts/lib, custom/ and searches/ contain no cloud.elastic.co link and no LOOKUP JOIN.

### 10. Risk weights are hard-coded and risk grows linearly with event count, so a repetitive job outranks rarer, more severe actions

Severity **medium** · trust · CISO, SOC analyst, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** An organisation cannot tune the weights without editing code and redeploying. The same CASE also feeds Identity 360, the shared fragments and the alert rules. Risk total is weight × events with no cap, so a bulk automated job tops the leaderboard over a handful of 50-weight config changes: 70 deletes at 30 score 2,100 against 5 config changes at 250. The page explains the model, and Mean severity is shown beside the total, but the sort order can still mislead.
- **Fix:** Move the weights into a config file, or into a small lookup index read with LOOKUP JOIN, so dashboards and rules share one table. Cap or log-scale each action's contribution per identity, for example weight × log2(1+events), so repetition cannot swamp severity. Keep the raw count and Risk total beside it. This changes what PMs see on the leaderboard, so confirm with them first.
- **Evidence:** The weights are a fixed CASE: 50/45/40/35/30/25/10, with housekeeping and suite_install at 0 (scripts/lib/panels.mjs:525-534). RISK_INDEX_STATS is risk_total = SUM(risk * n) (panels.mjs:549), and mean_severity is computed at panels.mjs:551. How to read this page lists the weights and says 'Risk total is weight × events' (04-security-anomalies.mjs:139-140). The Mean severity tile is at 04-security-anomalies.mjs:154. The Risk leaderboard runs SORT risk_total DESC, and its description says 'sustained behavior outranks one high-severity event' (04-security-anomalies.mjs:214-220). 'Why these identities scored' has a weight column (04-security-anomalies.mjs:221-225). RISK and riskScored are also used in rules.mjs, 07-actor-360.mjs and shared.mjs.

### 11. Titles and table values use builder jargon and raw action names

Severity **medium** · copy · CISO, Cloud/platform admin · effort M · planned for 1.1.0

- **Impact:** Managers and admins cannot tell what 'invalidate_apikeys 29' or 'saved_object_find 504' means for them. Titles like '√events', 'index family' and 'transport actions' add reading load without helping anyone act. Only the Live signal feed and the 01 failure tables carry a readable Request column. Most frequent actions, Top transport actions and the 04 action tables show raw names only.
- **Fix:** Add a plain-label column next to each raw Action column, from an ACTION_LABEL CASE in panels.mjs ('API keys revoked', 'Kibana object searched'). Keep the raw value clickable. Rewrite titles outcome-first, e.g. 'Most active identities, sized by activity, coloured by risk' and 'Who reads which indices'.
- **Evidence:** Titles: 'Identity footprint · area by √events, color by risk total' (00-command-center.mjs:173); `Signal vs noise over time${ALL}` (00:187); 'Live signal feed · repeats grouped · Kibana key clean-up left out' (00:230); 'Who reads which index family · up to 10 identities' (03-data-access.mjs:206); 'Top transport actions' (03:216); 'Proxy vs real client IP, by proxy' (05-geo-network.mjs:248); 'What they read, by index family' (07-actor-360.mjs:411). Raw action column: 'Most frequent actions' uses filterable('event.action', { label: 'Action' }) (00:191-193). Request column: requestCase (dashboards/shared.mjs:162), used at 00:103/232 and 01-identity-access.mjs:145, :338. Nothing in panels.mjs maps event.action to a plain label (grep finds no ACTION_LABEL).

### 12. Geo & Network gives prime space to proving source.ip is a proxy, and calls a country count 'impossible travel'

Severity **low** · copy · SOC analyst, CISO · effort M · planned for 1.1.0

- **Impact:** The Proxy IPs tile and the proxy table answer a builder's question, not an analyst's, and they use top-row and mid-page space. Labelling a distinct-country count 'impossible travel' flags every VPN user and misses fast moves within one country, so analysts learn to distrust it. Identity 360's map says plainly that it is not an impossible-travel detector, which makes the 05 wording look wrong.
- **Fix:** Move the Proxy IPs tile and the proxy table into a collapsed diagnostics section or to Platform Volume. Rename the tile and table 'People seen from several countries'. Drop 'impossible travel' from the tile tip, table title, table tip, reading note and dashboard description. Add a velocity table of consecutive locations with implied km/h, reusing the vega/10 calculation.
- **Evidence:** 05-geo-network.mjs: Proxy IPs kpi at :167 (tip :168); 'Multi-country people' tip 'the impossible-travel signal' at :177; table 'Countries per person (impossible travel) · no service credentials' at :208, a COUNT_DISTINCT of countries with no timing (:209), tip at :212; 'Proxy vs real client IP, by proxy' at :248-251; reading note 'Impossible travel lists people only' at :145; dashboard description 'Impossible-travel detection.' at :259. Speed logic: vega/10-actor-geography.json:144 (>300 / >900 km/h); its description at :3 says 'Not an impossible-travel detector.'

### 13. Colour-only encodings and emoji in titles hurt accessibility

Severity **medium** · other · SOC analyst, CISO, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** Colour-blind readers cannot rank severity on the treemap's smaller tiles, which print 'risk N' only when there is room. The same is true of the 05 rare-event scatter. Two heatmaps show counts only by shade, so those readers cannot read the cell values at all. Screen-reader users hear 'warning sign' or 'police light' before all eight dashboard titles and five panel titles.
- **Fix:** Replace SEVERITY_RAMP with a colour-blind-safe sequential ramp that varies in lightness (viridis-like) and have layout.mjs enforce it. Add a text mark with the count to vega/03 and vega/04, as vega/02 does. Replace panel-title emoji with a text marker such as 'Review:'. Drop emoji from dashboard titles, or confirm the screen-reader cost is acceptable for the dashboard list.
- **Evidence:** SEVERITY_RAMP ['#54B399','#D6BF57','#E7664C'] at panels.mjs:1091, used in vega/01-actor-risk-treemap.json:590-594, vega/05-rare-event-scatter.json:143 ('Highest-severity actions, by how rare', 04-security-anomalies.mjs:190) and vega/02-auth-matrix.json:99. The treemap prints risk only when it fits (vega/01:361, :451, :541). vega/03-object-verb-heatmap.json:239 ('Object type × operation', 02-kibana-objects.mjs:173) and vega/04-actor-index-matrix.json:110 (03-data-access.mjs:206) draw rect marks only, with no text mark. vega/02-auth-matrix.json:109 has one. layout.mjs:358-359 only checks that a ramp is MAGNITUDE_RAMP or SEVERITY_RAMP. Emoji dashboard titles: 00:242, 01:377, 02:272, 03:259, 04:270, 05:258, 06:224, 07:455. Emoji panel titles: 02-kibana-objects.mjs:164, 03-data-access.mjs:238, 04-security-anomalies.mjs:184, 07-actor-360.mjs:392, :415.

### 14. With nobody selected, Identity 360 shows project-wide totals and an all-identities drill-down under the heading 'Everything one person did, on one page', and nothing on the panels says they cover all identities

Severity **low** · other · SOC analyst, CISO · effort S · planned for 1.0.8.2

- **Impact:** A reader who opens Identity 360 without picking anyone can take the Events, Risk, Index families and Client IPs tiles, and the drill-down's credentials and spaces, for one person's footprint. The only hint that the page covers everyone is one clause in the intro.
- **Fix:** Show a short prompt when nothing is selected: 'Pick an identity in the Identity control, or click a Principal id in Who this is'. Add 'all identities' to the tile secondary lines and the drill-down header when the Identity control and pills are empty. 'Who this is' already works as the pick list and needs no change.
- **Evidence:** scripts/lib/dashboards/07-actor-360.mjs:250 heading 'Everything one person did, on one page'; :253 'with nobody selected, the page covers everyone'. The tiles keep fixed titles whatever is selected: :331 'Events', :335 'Risk', :347 'Index families', :351 'Client IPs'. Their secondary 'detail' strings never mention scope. :325 'Who this is — by identity and principal id'. The drill-down at :383-385 says only 'Pick a credential, space, object type and operation…'. custom/11-identity-path.html has no no-selection text (grep for nobody/everyone/pick an finds none).

### 15. No table shows the request id, opaque id, trace id or span id, so one API-key script run cannot be followed across its events

Severity **medium** · investigation · SOC analyst, Compliance auditor · effort S · planned for 1.0.9

- **Impact:** Most traffic comes from API keys, and those identities have no session timeline. An analyst cannot group the events of one script run without writing a query by hand. A request that went through Kibana can be followed in the 'Kibana request → Elasticsearch requests' session. A script that calls Elasticsearch directly cannot.
- **Fix:** Add filterable Request id (http.request.id) and Opaque id (x-opaque-id) columns to the All audit events and Raw signal feed sessions. Add an 'API run reconstruction' session that groups events by x-opaque-id, or by identity and client IP with gaps under 5 minutes, and makes the raw field click-to-filter.
- **Evidence:** Final KEEPs in searches/00-all-events.json, 10-raw-signal-feed.json and 09-session-reconstruction.json have no http.request.id, x-opaque-id, trace.id or span.id. searches/11-kibana-request-trace.json keys only Kibana-originated requests (KIBANA_REQUEST_FROM / kibana_request, panels.mjs:185-188). Caller is a client label (01-identity-access.mjs:139-146, column at :351). http.request.id is used only inside queries: 06-platform-volume.mjs:119, 07-actor-360.mjs:89 and :218 (CASCADE_KEY). The Request column in Command Center's Live signal feed (00-command-center.mjs:230-232) names what was touched, not an id. 07-actor-360.mjs:260: 'API-only identities have no sessions.'

### 16. User roles are never shown, so no panel says which roles did what or whether privileged roles are in use

Severity **medium** · investigation · Cloud/platform admin, Compliance auditor · effort S · planned for 1.0.9

- **Impact:** Admins cannot find activity by holders of superuser or admin roles. Access reviews that compare granted privilege with actual use have no data to work from.
- **Fix:** First check with a probe that user.roles is populated in the serverless audit stream. If it is, add a filterable Roles column (user.roles) to 'Who this is — by identity and principal id' on Identity 360 and to 'Busiest human identities' and 'Identity first and last seen' on Identity & Access. Then add a 'Privileged-role activity' table to Security Anomalies: events and actions by identity where user.roles includes a superuser or admin role.
- **Evidence:** user.roles appears only in docs/roadmap.html and docs/ROADMAP.md. It is not in scripts/lib, searches/, vega/, custom/, esql/ or README.md. user.full_name is left out on purpose (controls.mjs:6, README.md:276, 01-identity-access.mjs:304). Target tables: 07-actor-360.mjs:325, 01-identity-access.mjs:311 and :360. Command Center's Privileged ops tile (00-command-center.mjs:148-149) counts security-config changes, not activity by role holders.

### 17. Object names and index families cannot be clicked, and there is no Object or Space dropdown, so finding who else touched an object or index family means typing a filter or leaving for Discover

Severity **medium** · investigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.8.3

- **Impact:** An analyst who finds a suspicious dashboard, rule or index family cannot pivot to everyone who touched it in one click on the dashboard. On Identity 360, the Space in 'What they changed' cannot be clicked either.
- **Fix:** Add a filterable Object id (kibana.saved_object.id) column next to Object on the Kibana Objects tables and on 'What they changed', and make Space filterable there (kibana.space.id). Give 'Top index families by events' and 'What they read, by index family' a filterable representative index, as 'System and hidden index reads' has. Optionally add a Space dropdown to Kibana Object Forensics.
- **Evidence:** 02-kibana-objects.mjs: Space is filterable on '⚠️ Mutations' (:164-167) and on 'Kibana saved-object activity' (:248-250, with Action). Object type is filterable on 'Busiest objects' (:183, :199) and 'Object types' (:232-234). Object is a plain column on all of them. 03-data-access.mjs:212-214: Index family is plain on 'Top index families by events'. 07-actor-360.mjs:392 and :404: verb, type, name and space are plain on '⚠️ What they changed'. 07:411-413: 'What they read, by index family' is plain. Only '⚠️ System and hidden index reads' (07:415-426) has a filterable 'Index (one per family)'. controls.mjs:84-118 defines only Project, Identity type, Identity and Client IP.

### 18. There is no API key hygiene view: no list of stale keys, widely shared keys or rotation cadence.

Severity **medium** · capability · Cloud/platform admin, CISO · effort M · planned for 1.0.9

- **Impact:** Admins cannot find keys unused for 30 days or more, keys used from many IPs or countries, or keys whose creator no longer appears. 'API key inventory' lists only keys used in the picker's range, busiest first. A key that is never used never appears, and the page does not say so.
- **Fix:** Add a 'Key hygiene' table with a fixed 90-day panel window. Show days since last use, IP and country counts (flag keys over a threshold), create and invalidate events per key name (rotation cadence), and whether the creator has any activity in the window. Say in the panel description that the audit stream never shows a key that is never used.
- **Evidence:** scripts/lib/dashboards/01-identity-access.mjs:151-156: KEY_INVENTORY reads ${TIME} (the picker). It groups STATS events, first_seen, last_seen, ips = COUNT_DISTINCT(client.ip) and indices BY api_key.name, api_key.id, user.email, user.name, with SORT events DESC | LIMIT 1000. It has no fixed window, no country count, no IP threshold and no create/invalidate count. :355-359: the 'API key inventory' panel's description reads 'Every API key used in range…' and does not mention keys that are never used.

### 19. The suite installs only into the Default space. It has no named viewer role, no field-level guidance for emails and IPs, no page message for readers without read on the audit stream, and no alert when a suite dashboard is edited or deleted.

Severity **medium** · access · Cloud/platform admin, Compliance auditor, CISO · effort S · planned for 2.0.0

- **Impact:** Anyone with read on the audit stream and access to Default sees emails, client IPs and actions. Readers with dashboard access but no index read get failing panels and no explanation. Anyone with dashboard write in Default can edit or delete the suite. The edit appears on the change panels, but nothing alerts on it.
- **Fix:** Publish a minimal 'audit_viewer' role in the README: read on the stream and on the view, plus Kibana dashboard read. Offer an optional --space flag for a dedicated space, but keep the Default install and the elastic_cloud-audit-* ids as the default. Recommend field-level security on client.ip and user.email for readers outside security. Add one intro line per page saying it needs read on the audit stream. Ship a rule that alerts on changes to elastic_cloud-audit-* objects.
- **Evidence:** README.md:12, 19, 32: the suite installs into the Default space. README.md:1251: 'Dashboard viewers: read on the audit data stream and on logs-cloud-audit-events-view (a role on logs-* covers both)'. The README has no role definition, no field-level-security advice and no --space option. The page intros in scripts/lib/dashboards/*.mjs (e.g. 00-command-center.mjs:106-109, 07-actor-360.mjs:242) do not mention the read requirement. rules/*.json has api-key-or-role-change, audit-events-stopped, failed-signin-burst, first-seen-identity, signin-after-failures and unusual-hour-security-change, and none watches suite objects.

### 20. The Project dropdown lists and matches project names, so same-named projects merge. No panel compares risk or changes across projects.

Severity **medium** · navigation · Cloud/platform admin, CISO · effort S · planned for 2.0.0

- **Impact:** In an organisation with several projects, two projects called 'prod' read as one. A CISO cannot see which project carries the risk without picking each one in turn.
- **Fix:** Build each Project option as 'name (id prefix)' and match on project.id. Add a 'Risk and changes by project' table to Command Center with a filterable project.id column.
- **Evidence:** scripts/lib/controls.mjs:85-86: Project options come from optionsQuery('project', 'project.name', … EVAL project = project.name). scripts/lib/panels.mjs:241: PROJECT_WHERE = (unset('project') OR project.name == ?project). No query in scripts/lib/dashboards/*.mjs groups by project.name or project.id; grep finds only comments. Only vega/12-actor-cohort.json groups by project ('BY project = project.name, key = user.email').

### 21. Nobody has measured what each dashboard view adds to the audit stream. Load times are published only up to 7 days, on one replica.

Severity **low** · performance · CISO, Cloud/platform admin · effort M · planned for 2.0.0

- **Impact:** With a wide audience, every view adds audit events, storage and compute to the stream it reads. The noise gate hides these events from the signal panels, but they still cost money. Nobody knows the load times at 30 or 90 days on a busy organisation. The published timings leave out Identity 360's drill-down, which runs about 0.8s at 7 days, over the 0.7s budget, and is costliest on the page's default view with nobody selected.
- **Fix:** Measure and publish the audit events and bytes one view of each dashboard generates. Run ./audit --perf with 30d and 90d windows on a larger replica, and re-time Identity 360 with its drill-down, with nobody selected, at 30 and 90 days. Decide whether the executive and trend views should read a summary stream (a transform or an ES|QL rollup).
- **Evidence:** README.md:1115-1122: measured 2026-10-14 with --windows 1h,24h,7d on a 2,625,300-event replica, 117 queries per window, slowest load 3.2s (Platform Volume, 7d). README.md:1133-1134: the replica holds no more distinct values than the live stream. README.md:50: every panel view emits ES|QL sub-requests, field_caps, async_search and page-load events, which the gate marks as Query internals. The README has no events-or-bytes-per-view figure, no 30d or 90d timing and no summary stream.

### 22. Time charts carry no annotations for known events, and nothing links a panel to Cases.

Severity **low** · capability · SOC analyst, Compliance auditor · effort M · planned for 1.1.0

- **Impact:** Deploys, maintenance and declared incidents are not marked on the charts, so the same spike gets investigated again. Findings cannot be attached to a case from the dashboard.
- **Fix:** Add an annotation layer to the time charts, read from an 'audit-annotations' index, with an ./audit subcommand to add entries. Document 'Add to case' from Lens panels where the project type supports it, and ship a case template.
- **Evidence:** grep for 'annotation' in scripts/lib/*.mjs and scripts/lib/dashboards/*.mjs finds only in-memory lint markers (panels.mjs:1519, :2027). No xy() panel has an annotation layer. scripts/main.mjs has no annotations index or subcommand. README.md has no 'Cases' or 'add to case' entry; the only 'case' hits are ES|QL CASE().

### 23. The drill-down's data-set chips, request list and Close control work only with a mouse

Severity **medium** · other · SOC analyst, Compliance auditor · effort S · planned for 1.0.8.2

- **Impact:** A keyboard or screen-reader user can walk the first four drill-down levels but cannot open a data set's request list, close it, or use the breadcrumb. Screen readers never announce the chips.
- **Fix:** Keep the data-set radios in the tab order the way the level radios are (visually hidden, not display:none), give the chips, Close and the breadcrumb a visible focus ring, and check the panel with the keyboard alone.
- **Evidence:** custom/11-identity-path.html:78 .dsel{display:none} hides the data-set radios (:110), so they never take focus; Close is a label for d0 (:250); breadcrumb items are labels (.bc-n, :13, :128) with no focusable control. The level 1-4 radios stay focusable (opacity 0, :30).

### 24. The drill-down cuts its rows at 6,000 without saying so, and the deepest levels go first

Severity **medium** · trust · SOC analyst, Compliance auditor · effort S · planned for 1.0.8.2

- **Impact:** Over 7 days with nobody selected, a busy project can pass the limit. Objects and request lists then vanish with no sign, and the 'and N more' counts stop matching what is shown.
- **Fix:** Count the rows before the LIMIT and show 'some objects not shown, narrow the time or pick an identity' when it bites, or size the per-level caps so the total cannot reach it. Measure the row count at 7 and 30 days with nobody selected.
- **Evidence:** scripts/lib/dashboards/07-actor-360.mjs:164 '| SORT lvl, pid, acts DESC, k | LIMIT 6000', so level 6 (requests) and then level 5 (objects) rows are cut first. Each parent keeps its top 25 children and each data set its latest 25 requests; neither cut is stated on the panel.

### 25. Data-set chips do nothing for index names with characters the id builder keeps

Severity **low** · investigation · SOC analyst · effort S · planned for 1.0.8.2

- **Impact:** For an index whose name holds + @ = ( ) ' & or !, clicking its chip in the drill-down does nothing and shows no error, so that data set's requests cannot be seen.
- **Fix:** Build the element ids from the data set's position or a hash, as the level items already use nid, not from its name.
- **Evidence:** custom/11-identity-path.html:102, :110, :210, :220-224, :237 build ids by replacing only . : * space and / in the index name; the generated CSS then uses '#d<id>:checked' (:103-104). Elasticsearch allows + @ = ( ) ' & ! in index names, which make that selector invalid, so the browser drops the rule.

### 26. Identity 360's drill-down depends on a tech-preview panel, with no render check and no fallback

Severity **medium** · trust · SOC analyst, CISO, Compliance auditor · effort M · planned for 1.0.8.2

- **Impact:** If Kibana renames a custom_content setting, the deploy still succeeds and Identity 360's centre panel renders blank. If the panel type is withdrawn, or the suite meets a Kibana without it, the deploy fails or the panel is dropped.
- **Fix:** Make --verify fail when the drill-down renders no items. Keep a fallback ready: a Lens table of the same credential › space › object type › operation paths, switched in by a build flag.
- **Evidence:** docs/custom-panels.md:39-41: unknown config keys are dropped silently; custom_content is a serverless tech preview. scripts/lib/layout.mjs and the --verify checks have no custom_content-specific test. The drill-down is IDENTITY_PATH (07-actor-360.mjs) rendered by custom/11-identity-path.html.

### 27. The drill-down's links drop the time range, and its request rows lead nowhere

Severity **medium** · navigation · SOC analyst, Compliance auditor · effort S · planned for 1.0.8.3

- **Impact:** 'Open dashboard ↗' opens the dashboard on its own default 24 hours, so a reader investigating last Tuesday lands on today. Only dashboards get a link. A request row names the part of the page by panel id, which no reader can map to a panel, and has no request id or way into the Kibana request trace session.
- **Fix:** Carry the drill-down's time range (?_tstart, ?_tend) into each link as _g. Show the request id on each request row and link it to the 'Kibana request → Elasticsearch requests' session filtered to that request (custom panels may link to /app/discover).
- **Evidence:** custom/11-identity-path.html:198 '<a href="/app/dashboards#/view/{{ oid }}">Open dashboard ↗</a>' carries no time; scripts/lib/custom.mjs:12 links to /app/dashboards and /app/discover keep their href. The request rows hold the x-opaque-id but print no id and no link; searches/11-kibana-request-trace.json is reachable from no dashboard.

### 28. Open in Discover silently drops the page's dropdowns everywhere except Identity 360

Severity **medium** · navigation · SOC analyst, Compliance auditor · effort M · planned for 1.0.8.3

- **Impact:** With Project or Identity type set, Open in Discover opens every project's or every type's records under the same pills. Only Identity 360's menu entry warns, so on the other six pages a reader can take the session for the filtered set.
- **Fix:** Write the dropdown values into the session's ES|QL the way the pills are written, if the drilldown can read the ES|QL variables. Otherwise name the gap on every page's menu entry ('ignores the dropdowns') and in How to read.
- **Evidence:** scripts/lib/drilldowns.mjs:98-106: the dropdowns are ES|QL variables no session reads; only a panel given a discoverName (07's openInByTitle third argument) says so in its menu entry.

### 29. Discover sessions are reached through markdown 'Raw records' links that keep only the time range, and two sessions have no link at all

Severity **low** · navigation · SOC analyst, Compliance auditor · effort S · planned for 1.0.8.3

- **Impact:** A reader who wants a page's raw records has to find a link inside the intro text, and it opens without the page's pills. The Kibana request trace session cannot be reached from any dashboard.
- **Fix:** Add a thin full-width 'Records in Discover' Links panel under the nav bar on every dashboard, listing that page's sessions (from its openInByTitle map, plus the Kibana request trace on Kibana Object Forensics and Identity 360), and take 'Raw records' out of the intros.
- **Evidence:** scripts/lib/dashboards/shared.mjs:59 RAW_RECORDS puts the session links in each intro's markdown; no Links panel lists sessions. searches/11-kibana-request-trace.json is linked from no panel.

### 30. The Cloud API keys that run the suite's alert rules count as identities on every page

Severity **medium** · trust · SOC analyst, CISO, Cloud/platform admin · effort S · planned for 1.0.10

- **Impact:** Kibana mints a Cloud API key to run each enabled rule. Once a customer turns the alert pack on, those keys appear in the treemap, Busiest identities, the Identity dropdown, the Live signal feed and Risk as ordinary Cloud API keys, and an analyst has to learn to skip them.
- **Fix:** Recognise the rule runner's requests (the alerting_v2 rule_executor marker in x-opaque-id, as RULE_RUNNER does) in the shared identity fragments and treat them as the suite's own traffic, counted out with an 'excl. N' line as suite installs are.
- **Evidence:** scripts/lib/rules.mjs:67 RULE_RUNNER matches '*;kibana:task%20manager:run%20alerting_v2%3Arule_executor:*'; only the rules use it (rules/first-seen-identity.json). No fragment in scripts/lib/panels.mjs leaves these requests out of the dashboards.

### 31. Nobody has tested which denials the serverless audit stream records, yet panels and rules read empty as good

Severity **medium** · trust · SOC analyst, Compliance auditor, CISO · effort M · planned for 1.0.10

- **Impact:** Several failure tables say '(empty = good)' and two rules wait for denials. If the stream leaves out some kinds (an ES|QL query on an index the caller may not read, a request rejected before authorization, a revoked key), an empty panel means nothing and an auditor cannot say what the suite would miss.
- **Fix:** Add a synth persona that triggers each kind of denial (index, cluster, Kibana privilege, revoked or forged key, pre-authorization reject), record which ones reach the stream, and publish the table in the README.
- **Evidence:** '(empty = good)' titles on 01 Top failed or denied access, 04 Top failures and denials and the Config-change event feed; rules/failed-signin-burst.json and signin-after-failures.json. No synth persona exercises denials, and the README lists no recorded or missing denial kinds. elastic-audit-logs-awesome documents such gaps for the hosted audit log.

## Use cases

| Id | Personas | Question | Coverage | Planned for |
| --- | --- | --- | --- | --- |
| UC-001 | Admin, Analyst, Auditor | Which identities and source IPs had the most failed authentications in the last 24h, how many per user and per IP, and from where? | Answered |  |
| UC-002 | Admin, Analyst, Auditor, Manager | Alert when any IP or identity goes over N failed authentications in a short window (10 in 5 or 15 min, 6 in 30 min), including password spraying across many principals. | Answered |  |
| UC-003 | Admin, Analyst, Auditor | Did a successful login follow a burst of failures from the same IP or account (brute-force success)? | Answered |  |
| UC-004 | Admin, Analyst | Is one public IP failing authentication against many different usernames or API keys (spraying), not one account repeatedly? | Partly | Out of reach |
| UC-005 | Auditor, Manager | What is the failed-authentication rate (failed / all attempts), and how does it trend week over week? | Partly | 1.0.8.4 |
| UC-006 | Admin | Is a client hammering /_security/_authenticate or another endpoint with bad credentials, such as an integration holding a stale key? | Answered |  |
| UC-007 | Admin | Which internal or platform principals (autoscaling, elasticsearch-controller) fail realm authentication, and is that noise I should exclude? | Partly | 1.0.8.4 |
| UC-008 | Admin | Are any user accounts locked out after repeated failed logins? | Not in the data | 2.0.0 |
| UC-009 | Analyst, Manager | Who is generating anonymous_access_denied (scanners on the public endpoint): how many, from where, which paths, and is it rising? | Answered |  |
| UC-010 | Analyst, Auditor, Manager | Which authentication methods are used (SAML SSO, API key, token, native realm), what share each has, and did any human authenticate other than through SSO? | Partly | 1.0.8.4 |
| UC-011 | Analyst, Auditor, Manager | Can we prove MFA was used for every interactive (admin) login, and what share of human logins were MFA-protected? | Not in the data | 2.0.0 |
| UC-012 | Analyst, Auditor | Reconstruct a Kibana session, or list a user's sessions: when it started, from which IP, which spaces and objects it touched, and when it ended. | Answered |  |
| UC-013 | Admin, Analyst, Auditor | Was the same Kibana session id used from more than one public IP or country mid-session (possible cookie theft)? | Partly | 1.0.8.4 |
| UC-014 | Admin, Auditor, Manager | How many Kibana sessions were there, how long did they last on average, and which were long-lived (>12h), suggesting idle timeouts are not enforced? | Partly | 1.0.8.4 |
| UC-015 | Admin | How many distinct humans logged into Kibana each day this month? | Partly | 1.0.8.4 |
| UC-016 | Admin, Analyst, Auditor | Did any human identity authenticate from two locations too far apart for the elapsed time (impossible travel)? | Partly | 1.1.0 |
| UC-017 | Manager | Alert me on impossible travel: the same human identity seen from two countries within an hour. | Needs alerting or retention | 1.2.0 |
| UC-018 | Admin, Analyst, Manager | Which users logged in from a country, city or ASN they had not used in the previous 30 days (new country this week or month)? | Needs alerting or retention | 2.0.0 |
| UC-019 | Auditor, Manager | Which countries do we see access from in total, and how much from each? | Answered |  |
| UC-020 | Auditor, Manager | Which logins or admin actions came from countries outside our approved list, and what share of authentications is that? | Partly | 2.0.0 |
| UC-021 | Admin, Analyst, Auditor, Manager | List every public IP that reached the project and the identities behind each, and flag access from outside our corporate egress or CI ranges. | Partly | 2.0.0 |
| UC-022 | Admin, Analyst, Manager | Which requests came from Tor exits, hosting or VPS providers, cloud providers, or IPs on our threat-intel blocklist? | Not in the data | 2.0.0 |
| UC-023 | Analyst, Auditor, Manager | List every API key created in the period: who created it, its name, expiration and role descriptors. | Answered |  |
| UC-024 | Auditor, Manager | For keys created this quarter, which are still valid and which were invalidated (what fraction), and how many keys are active right now? | Partly | 1.0.10 |
| UC-025 | Admin, Analyst, Auditor | Which API keys were created with no expiration, or with an expiration beyond our 90-day rotation policy? | Partly | 1.0.9 |
| UC-026 | Admin, Analyst | Which new or changed API keys carry superuser-like role descriptors (cluster all, indices * with all/write/manage, run_as, or empty descriptors that inherit the creator's privileges), and who created them? | Partly | 1.0.9 |
| UC-027 | Admin, Analyst, Auditor, Manager | Which API keys created in the last 90 days have never been used to authenticate? | Partly | 1.0.10 |
| UC-028 | Auditor, Manager | Which API keys are older than our 90-day rotation policy and still in use? | Needs alerting or retention | 1.0.10 |
| UC-029 | Admin, Manager | Which API keys active last quarter have not been used in 30+ days (dormant), so I can expire them? | Needs alerting or retention | 1.0.10 |
| UC-030 | Analyst | Did any API key that was dormant for 30+ days suddenly become active? | Needs alerting or retention | 1.0.10 |
| UC-031 | Admin, Analyst, Auditor | Who invalidated API keys, how many and which ones, and were they their own keys or someone else's? | Partly | 1.0.9 |
| UC-032 | Auditor | Alert when API keys are invalidated in bulk, or by someone other than the owner (owned_by_authenticated_user=false). | Answered |  |
| UC-033 | Admin, Analyst | Which API keys had their role descriptors or metadata updated (change_apikey) and by whom, and did their privileges widen? | Partly | 1.0.10 |
| UC-034 | Admin, Auditor | Which API keys were minted by other API keys (key-creates-key chains) rather than by a person, and who ultimately owns them? | Partly | 1.0.9 |
| UC-035 | Admin | How many API keys does each person own and actively use (key sprawl per user)? | Partly | 1.0.9 |
| UC-036 | Admin | Which Cloud-console or org keys (_cloud_api_key) and which project-native Elasticsearch keys (_es_api_key) are touching this project? | Answered |  |
| UC-037 | Manager | Which human created the API keys that generate most of our traffic, and is that person still with the company? | Partly | 2.0.0 |
| UC-038 | Admin, Auditor | List the API keys a departing user created that are still active (used recently and not invalidated). | Partly | 1.0.9 |
| UC-039 | Admin, Manager | Is the same API key being used from many distinct public IPs or countries, suggesting it is shared or leaked? | Partly | 1.0.9 |
| UC-040 | Admin, Analyst | Alert when an API key that normally calls from known egress IPs is used from a public IP or country it has not used in the previous 30 days. | Needs alerting or retention | 1.2.0 |
| UC-041 | Admin | Is any API key used by more than one client application (different x-opaque-id values or URL patterns), suggesting a shared credential? | Partly | 1.0.10 |
| UC-042 | Auditor, Manager | Are API keys or service credentials being used interactively, for example by a human working in Kibana with a service key? | Partly | 1.0.9 |
| UC-043 | Analyst | An API key is confirmed leaked: which indices did it read or write, which actions did it take, and from which IPs, since it was created? | Partly | 1.0.9 |
| UC-044 | Analyst | Did the compromised identity mint further API keys or roles (child credentials) that must also be revoked, and have those been used? | Partly | 1.0.9 |
| UC-045 | Admin, Analyst, Auditor | Show every role create, update and delete (put_role, delete_role, put_privileges) in the last 30 days or quarter, with who, when, from where and the role definition, for the SOC 2 binder. | Partly | 1.0.9 |
| UC-046 | Admin, Analyst, Auditor | Show every role or API key change made outside business hours or at weekends last quarter. | Partly | 1.0.9 |
| UC-047 | Admin, Auditor, Manager | Did anyone change role mappings (SAML group to role), which silently change who is privileged? | Not in the data | 2.0.0 |
| UC-048 | Admin | Which roles were granted write or manage privileges on indices holding sensitive data (pii-*, billing-*)? | Partly | 1.0.9 |
| UC-049 | Auditor, Manager | Alert in real time when any role or API key grants run_as, cluster 'all' or index 'all', when a role is deleted, or when a superuser-level key is created. | Answered |  |
| UC-050 | Admin | Alert immediately on any security config change made by an API key rather than a human. | Answered |  |
| UC-051 | Admin, Analyst, Auditor, Manager | When were user profiles activated or updated (first-time users), by which IdP identity, and does that match the HR joiners list? | Answered |  |
| UC-052 | Manager | How many privileged security configuration changes happened this week, and by whom, compared with our weekly baseline? | Partly | 1.0.9 |
| UC-053 | Analyst, Auditor, Manager | Did any principal escalate itself: denied, then created a role or key, then succeeded on the same resource; or created a key or role and then used it for privileged changes (segregation-of-duties violation)? | Partly | 1.2.0 |
| UC-054 | Admin | Is an integration's API key repeatedly denied after a role change? Correlate denials with a recent put_role or change_apikey. | Partly | 1.0.9 |
| UC-055 | Admin, Analyst, Auditor, Manager | Which identities hold admin, superuser or billing-admin roles, how many are there, did the count change, and how often did each use them? | Partly | 2.0.0 |
| UC-056 | Auditor | Produce a log of every action performed by admin-role identities (human and API key) during the period, for PCI 10.2.1.2. | Partly | 1.0.9 |
| UC-057 | Manager | What share of our activity is done by admin-role identities rather than least-privilege roles, what share of admin activity happens after hours, and which admins account for most of it? | Partly | 1.0.9 |
| UC-058 | Analyst | Which identities' effective roles (user.roles) changed compared with last week? | Needs alerting or retention | 1.0.9 |
| UC-059 | Admin | Which identities have privileged-action capability but have not used it in 90 days, so least privilege can be applied? | Not in the data | 2.0.0 |
| UC-060 | Manager | Was the break-glass or built-in elastic superuser, or an Elastic operator account, used this month, and for what? | Partly | Out of reach |
| UC-061 | Manager | Did Elastic staff or any third-party or vendor identity access our project this quarter? | Partly | Out of reach |
| UC-062 | Admin, Analyst, Auditor, Manager | Which identities are hitting access_denied, on which actions and indices, how often, and is anyone probing for access they do not have? | Answered |  |
| UC-063 | Admin, Analyst | Which Kibana saved-object or space operations failed (outcome failure), and who tried them, for example repeated forbidden writes? | Answered |  |
| UC-064 | Manager | What is our failed-change rate: what share of create and update attempts on saved objects and spaces failed? | Partly | 1.0.8.3 |
| UC-065 | Admin | Has a newly onboarded user actually logged in and reached the spaces they need, or are they hitting access_denied? | Answered |  |
| UC-066 | Analyst, Auditor | Were any requests made with run_as or impersonation, and on whose behalf? | Not in the data | 1.0.8.4 |
| UC-067 | Admin, Auditor | Access review: list every identity with its roles, authentication type, first and last seen, event count and distinct IPs, and whether it was active in the last 90 days. | Partly | 2.0.0 |
| UC-068 | Admin, Manager | Who actually accessed this project in the last 30 days, humans and machines, and how did each authenticate? | Answered |  |
| UC-069 | Auditor, Manager | Which users with access, privileged ones especially, have not logged in for 30, 60 or 90 days, so we can deprovision them? | Not in the data | 2.0.0 |
| UC-070 | Analyst, Manager | Which identities (users or API keys) appeared in the audit stream for the first time this week, and how many? | Partly | 1.0.9 |
| UC-071 | Admin, Auditor | Did any terminated employee or leaver authenticate, or have their keys used, after their termination date? | Partly | 2.0.0 |
| UC-072 | Manager | How many distinct identities (people and API keys separately) were active in each project this month, and is the number growing? | Partly | 1.0.9 |
| UC-073 | Admin, Auditor | Which service accounts and other non-human identities are active, from where, and what do they access? | Partly | 1.0.9 |
| UC-074 | Admin, Analyst | Are service account tokens being used from anywhere other than the expected Kibana or internal workload, or against unexpected APIs? | Needs alerting or retention | 1.2.0 |
| UC-075 | Analyst | Which identities' hourly event volume today deviates most from their own 14-day baseline? | Partly | 1.1.0 |
| UC-076 | Analyst, Manager | Which human users were active between 22:00 and 06:00 or at weekends this month, and what did they change? | Partly | 1.1.0 |
| UC-077 | Manager | Did any single identity's risk score jump more than 3× compared with its own previous 4-week average? | Needs alerting or retention | 1.2.0 |
| UC-078 | Admin, Auditor, Manager | Which identities or integrations show a sudden spike in data reads or request volume against their baseline (3× over 7 days, 5× over 30 days), suggesting bulk export or a runaway client? | Needs alerting or retention | 1.2.0 |
| UC-079 | Admin | Which API keys or integrations generate the most audit events and requests per minute, and is any of them a runaway client? | Answered |  |
| UC-080 | Admin | Which clients poll health or monitor endpoints (cluster:monitor/main, _security/_authenticate) far more often than needed? | Answered |  |
| UC-081 | Manager | Who are the top 10 riskiest identities this month, and what share of total risk do they account for? | Partly | 1.1.0 |
| UC-082 | Manager | What was our average event severity or risk per day this month, and what were the three worst days and why? | Partly | 1.1.0 |
| UC-083 | Analyst | Who enumerated security configuration (roles, users, API keys, privileges), and how often compared with their baseline? | Partly | 1.0.8.5 |
| UC-084 | Analyst | Which identities listed indices, mappings, cluster state or field caps across many indices they do not normally touch? | Partly | 1.0.8.5 |
| UC-085 | Admin, Analyst, Auditor, Manager | Who read indices matching my sensitive patterns (pii*, customers-*, hr-*, .security*), how many times, through which API, and was it a human or an API key? | Partly | 1.0.10 |
| UC-086 | Admin | Who read sensitive indices this month through an API key whose owner has left or which has since been invalidated? | Partly | 2.0.0 |
| UC-087 | Admin, Analyst | Which identity read the most distinct indices, or ran unusually many search, scroll or PIT requests, in the last 24h, and which carries the most read and write load per index pattern (chargeback)? | Partly | 1.0.10 |
| UC-088 | Manager | Is the volume of reads on sensitive indices up or down compared with last month? | Needs alerting or retention | 1.0.10 |
| UC-089 | Auditor | Who accessed the audit log data stream itself (logs-elastic_cloud.serverless_audit*): reads, and any write or delete attempts? | Answered |  |
| UC-090 | Analyst, Auditor | Who wrote or bulk-indexed into indices they normally only read, or into system, security or regulated indices? | Partly | 1.0.10 |
| UC-091 | Auditor | Which specific documents or records of data subject X were accessed, and by whom (DSAR or breach scoping)? | Not in the data | Out of reach |
| UC-092 | Analyst | What exactly did the attacker search for: the ES\|QL or query DSL text they ran? | Not in the data | Out of reach |
| UC-093 | Analyst | Who viewed a specific sensitive dashboard or saved search (for example HR investigations) in the last 30 days? | Answered |  |
| UC-094 | Analyst | Has anyone used reindex (especially remote reindex), async search or similar bulk paths to pull large data sets out? | Partly | 1.0.10 |
| UC-095 | Analyst, Auditor | Who exported or imported Kibana saved objects (_export / _import), and which objects? | Partly | 1.0.10 |
| UC-096 | Analyst | Which users generated CSV or PDF reports or Discover CSV downloads, and of what data? | Partly | 2.0.0 |
| UC-097 | Admin, Analyst, Auditor, Manager | Who deleted indices or data streams, or ran delete_by_query, in the last 7 days or month, including denied attempts (and snapshots)? | Partly | 1.0.10 |
| UC-098 | Analyst | Alert me when a single identity deletes more than N saved objects or indices within 10 minutes. | Needs alerting or retention | 1.2.0 |
| UC-099 | Admin, Analyst | Who created indices, or changed mappings or index settings, in the last 7 days? | Partly | 1.0.10 |
| UC-100 | Admin, Analyst, Auditor, Manager | Which detection or alerting rules were disabled, deleted, snoozed or modified, by whom, and were they re-enabled? | Answered |  |
| UC-101 | Analyst, Auditor | Were alert connectors (Slack, email, PagerDuty, webhook) created, changed or deleted, so that alerts stop reaching the SOC or a webhook points to an external URL? | Partly | 2.0.0 |
| UC-102 | Admin, Analyst, Auditor | Did anyone tamper with audit logging: the enriching ingest pipeline, the audit data stream's lifecycle or settings, or deleting audit data? | Partly | 1.0.10 |
| UC-103 | Analyst | Which dashboards, saved searches or data views used by the SOC were modified or deleted, and what was the before and after? | Partly | 2.0.0 |
| UC-104 | Admin, Analyst, Auditor, Manager | Who created, changed, ran or deleted Kibana workflows, Agent Builder agents and tools, or scheduled rules that could run code or exfiltrate data? | Answered |  |
| UC-105 | Auditor, Manager | Kibana change log: who created, modified or deleted dashboards, rules, connectors and data views, with object names and spaces, and how many changes each person made this week? | Partly | 1.0.9 |
| UC-106 | Admin | Which saved objects (dashboards, data views, rules) were deleted in the last 7 days, and by whom? | Answered |  |
| UC-107 | Auditor | Show the full change history of a specific saved object (by id) across its lifetime. | Answered |  |
| UC-108 | Auditor | Who viewed the audit dashboards and Discover sessions, and when, as proof that the security team performs log review? | Answered |  |
| UC-109 | Manager | Who are the top 5 people making changes this month, and how does their change volume compare with last month? | Partly | 1.1.0 |
| UC-110 | Admin, Analyst, Auditor, Manager | Who created or deleted Kibana spaces, and when? | Answered |  |
| UC-111 | Auditor | Which users accessed which spaces, to confirm segregation (for example, only the finance team used the 'finance' space)? | Answered |  |
| UC-112 | Analyst | Did anyone access a Kibana space they had never used before? | Needs alerting or retention | 1.0.9 |
| UC-113 | Admin, Manager | Which teams and spaces actually use Kibana: active users, object edits and risk per space, week over week? | Partly | 1.0.8.3 |
| UC-114 | Admin | Are any spaces unused (no access in 60 days), so I can archive them? | Needs alerting or retention | 1.0.10 |
| UC-115 | Analyst | An alert fired on identity X: show everything it did in the hour before and after, across Elasticsearch and Kibana, in one timeline. | Answered |  |
| UC-116 | Analyst | Pivot from a suspicious IP: every identity, project and action seen from it in the last 30 days. | Partly | 1.0.10 |
| UC-117 | Analyst, Auditor | Tie a Kibana UI action to the exact Elasticsearch requests it triggered (end-to-end trace). | Answered |  |
| UC-118 | Analyst | Produce a minute-by-minute incident timeline for a fixed window (for example 14:00–16:00 yesterday), showing only changes and security events, for the post-incident report. | Answered |  |
| UC-119 | Auditor | Give me a random sample of 25 security-relevant changes from the quarter, with full event detail, to trace each to an approved change ticket. | Partly | 1.0.10 |
| UC-120 | Auditor | Export all security configuration change events for the period to CSV, with timestamps, actor and outcome, for the auditors' evidence binder. | Partly | 1.0.10 |
| UC-121 | Auditor | For any given event, can I see user identity, event type, date and time, success or failure, origin and affected resource (PCI 10.2.2 completeness)? | Answered |  |
| UC-122 | Analyst | Is the same human or API key active across multiple serverless projects, and did activity spread to a new project during the incident window? | Partly | 2.0.0 |
| UC-123 | Admin, Auditor, Manager | Across all our serverless projects, compare activity, privileged changes, API-key activity, failed-auth rate and distinct identities per project. | Partly | 2.0.0 |
| UC-124 | Admin, Analyst, Auditor, Manager | Who invited or removed Cloud organization members, changed their organization or project role assignments, or created and deleted projects? | Not in the data | 2.0.0 |
| UC-125 | Admin, Analyst | Alert me if audit events stop arriving from either the Elasticsearch or the Kibana source for more than 15 minutes. | Answered |  |
| UC-126 | Auditor, Manager | Are there gaps in audit logging: any hour or day with zero events from Elasticsearch or Kibana, any delivery gap over 15 minutes, or measurable ingest lag? | Partly | 1.0.10 |
| UC-127 | Auditor | Prove audit logs are retained for 12 months, with 3 months immediately available, and show we are audit-ready: oldest event, every project logging, all categories present. | Partly | 1.0.10 |
| UC-128 | Auditor | Provide evidence of daily review of security events: a daily summary of failures, denials and config changes. | Needs alerting or retention | 1.2.0 |
| UC-129 | Auditor | Notify the compliance channel within 15 minutes of any admin-role assignment, security config change or audit-index access. | Partly | 1.2.0 |
| UC-130 | Manager | What is our mean time to detect a privileged change, and what share of high-risk events did the SOC review within 24 hours? | Not in the data | 1.2.0 |
| UC-131 | Auditor | Which client tools (browser, curl, Terraform, SDK) were used for privileged changes? | Not in the data | Out of reach |
| UC-132 | Manager | Are we getting better? This week's signal events, failed authentications and privileged changes against last week, with a percentage change arrow for each. | Partly | 1.1.0 |
| UC-133 | Manager | A one-page monthly board summary (active identities, privileged changes, failed logins, access denials, new API keys, new countries), each with a month-over-month trend. | Needs alerting or retention | 1.1.0 |
| UC-134 | Manager | Is risk concentrated in a few API keys (automation) or spread across people? Show the human-versus-machine split of risk and activity. | Answered |  |
| UC-135 | Manager | What fraction of our audit volume is automation or noise rather than human signal, and is human signal trending up? | Answered |  |
| UC-136 | Manager | Show a 12-week trend of distinct active API keys against distinct active humans, to see whether automation sprawl is growing. | Needs alerting or retention | 1.1.0 |
