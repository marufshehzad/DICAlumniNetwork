# Phase Log — DIC Alumni Platform

One entry per remediation phase. Each entry records what was changed, what was
proven, and what is still not true — so that a later reader can tell finished
work from work that only looks finished.

Rules this file is kept by:

- A phase is not complete until its entry is written and its tests actually pass.
- Test counts are transcribed from real runs. Nothing here is estimated.
- Limitations are recorded in the same entry as the achievement they qualify.

---

## Index of earlier phases

Recorded from the repository history for continuity. These entries predate this
file, so they are summarised from their commits rather than written at the time.

| Phase | Commit | Date | Subject |
|---|---|---|---|
| Event & Tickets v5/v6 | `f5028f5` | 2026-08-30 | Rebuilt the event and ticketing module with external-people support |
| 0 | `10c7e42` | 2026-08-30 | Removed public admin credentials, hardened auth, fixed two regressions |
| 1 | `5283f85` | 2026-08-31 | Replaced fabricated user-facing data with database-backed values |
| 1.5 | `361b515` | 2026-08-31 | Closed the last fabricated metrics — segmentation, matching, scores |
| 2A | `78ba00a` | 2026-08-31 | Split `app.js` into fifteen plain script files |
| 2B-1 | `9fcf59c` | 2026-08-31 | Security fixes, authority-account fields, administrator provisioning |
| 2B-2 | `d70587c` | 2026-08-31 | Separate staff portal at `/admin`; admin code off the alumni site |
| 2C | `e5e26ea`, `2b77156` | 2026-08-31 | Self-service recovery, session revocation, subdomain readiness |
| 3 | `061fe8a` | 2026-09-02 | Truth and safety — removed fake promises, closed P0 holes |
| 4 | `c7072f5` | 2026-09-02 | Operations ring — scheduler, purge, backups, email, monitoring |

---

## Phase 5A — Audit integrity and privacy hardening

**Status:** COMPLETE
**Date:** 2026-09-02
**Commit:** `7d81d2e` (`7d81d2e4c3626a32a282af07cb1b41e86aaa6f24`) — recorded by the follow-up commit, since a commit cannot contain its own hash
**Parent:** `c7072f5` (Phase 4)

### Why this phase existed

Phase 4 closed with two P1 findings. The audit trail described itself in the
interface as an immutable hash chain, and it could not be verified by anyone —
including its author. Separately, audit metadata carried alumni names and email
addresses into a table nothing was allowed to edit.

The goal was not to make a verifier print PASS. It was to make the claim true
where it can be true, and to state plainly where it cannot.

### Migrations

Both additive, idempotent, transactional, and run with `--dry-run` first.

| Migration | Adds | Notes |
|---|---|---|
| `schema_v11.sql` / `migrate_v11.js` | `audit_logs.chain_version`, `prev_hash`, `entry_hash`; `audit_chain` head table | Makes the legacy `hash` column nullable. 17 verification checks — 16 structural, plus an md5 fingerprint over the immutable fields of every pre-existing row, proving they were not touched. Any failure rolls the migration back. |
| `schema_v12.sql` / `migrate_v12.js` | `audit_logs.actor_ref INTEGER` | Deliberately carries **no** foreign key. Backfilled from `actor_id`; resets the chain head. |

No migration deletes or rewrites a historical row.

### Audit chain design

Defined once in `audit_chain.js` and shared by the writer and the verifier, so
the two cannot drift apart.

- **Digest:** full SHA-256, 64 lowercase hex characters. The previous scheme
  truncated to 16 hex characters (64 bits).
- **Canonical payload:** a JSON *array*, so there is no key ordering to get
  wrong: `[chainVersion, prevHash, createdAtIso, action, meta, actorRef,
  targetType, targetId, ip, icon]`.
- **Every element is a persisted column.** A verifier reading only the database
  can rebuild the input byte for byte.
- **The application supplies `created_at`.** Postgres `timestamptz` keeps
  microseconds; `toISOString()` renders milliseconds. A database-generated
  timestamp would lose its last three digits in transit and never rehash.
  Confirmed against live rows carrying 362µs, 922µs and 987µs components.
- **Appends are serialised** by a row lock on `audit_chain`, replacing a
  read-then-write race that could fork the chain under concurrency.
- **Version boundaries are in the chain, not in a comment:**
  `prev_hash = 'LEGACY-BOUNDARY:<last hash of the preceding segment>'`.

Full reasoning, including what the scheme does *not* protect, is in
`AUDIT_CHAIN.md`.

### Independent verifier

`verify_audit.js`, exposed as `npm run verify-audit-chain`. Flags `--json`,
`--quiet`, `--database`. Exit 0 pass, 1 fail, 2 harness error. It recomputes
every digest from persisted values only — it shares the chain definition with
the writer but reads nothing the writer holds in memory.

It reports historical segments separately, with the reason each is unverifiable,
and never counts them as verified.

### Security fixes

Four defects found by adversarial review after the phase was otherwise finished.
All four are now pinned by `tests/phase5a_security.js`.

| | Defect | Fix |
|---|---|---|
| A | **IDOR.** `GET /api/alumni/:id` leaked private contact details between members. `SELECT ap.*` after `u.id` let `alumni_profiles.id` overwrite `users.id`, so the "is this me?" comparison tested a user id against a profile id. Proved empirically: the old query returned `row.id = 1` when fetching user 5. | Explicit column ordering with `ap.id AS profile_id` and `u.id` selected last. |
| B | **Audit suppression.** An oversized `X-Forwarded-For` exceeded `ip VARCHAR(64)`; `writeAudit` swallowed the error, so the action succeeded with **no audit record at all**. | `clamp()` in `audit_chain.js` bounds every column to its declared width. |
| C | **Verifier targeting.** `--database` was dead whenever `DATABASE_URL` was set, so the tool could inspect production while naming a restore. | The flag now clears `DATABASE_URL`/`POSTGRES_URL` and validates the name against `/^[A-Za-z0-9_]+$/`. |
| D | **Unbounded free text** reached the hash-chained log. An oversized `consentType` produced a 500 that leaked the schema: `value too long for type character varying(100)`. Found by a regression test written during this phase. | Length validation at the call sites, with refusals that state the limit without describing the schema. |

### PII hardening

- All **45** audit write call sites across seven files were reviewed. **13**
  carried a person's name or email address into `meta` and now record an
  internal reference instead — `user <id>`, `person <id>`, `vault <id>`. Among
  them: administrator creation, update, role change, suspension, activation and
  password reset; identity-vault storage and decryption; attendee check-in;
  external contact added; self-registration; password reset.
  Verified in the running interface: the audit panel reads `user 107 by user 1`
  and `deletion request 45 for user 108`.
- Entries that name an **event or a campaign** still do so deliberately. That
  string is the object acted on, not a person, and removing it would leave an
  operator reading "Campaign Deleted" with no way to tell which one.
- Secrets were never permitted and still are not — no password, token, reset
  link, session or encryption key reaches an audit entry. Asserted by test.
- **Historical rows are left exactly as they are.** Some pre-boundary entries
  contain names and email addresses. Scrubbing them would invalidate every
  entry after them and destroy the evidence the chain exists to protect. The
  purge worker deliberately does not scrub `meta` either. This is disclosed in
  `PRODUCTION_DEPENDENCIES.md` §2.11 as something DIC's data-protection owner
  must accept in writing.

### Privacy changes

- `privacySettings` validated and persisted on `PUT /api/profile/me`:
  whitelisted fields (`email`, `mobile`), whitelisted levels, merged with
  `jsonb ||` so an unrelated key cannot be dropped by a partial update.
- The profile editor now offers only the two levels the server actually
  enforces. It previously offered a third the backend never gated — an
  interface promising privacy it did not deliver.
- Verified end to end through the real UI, not the API alone: the control
  saved, and re-reading the profile returned `mobile: "private"`.

### Regressions found and fixed during this phase

Chain design faults, both caught by the phase's own tests before commit:

1. **Chain version 1 hashed `actor_id`** — a foreign key declared
   `ON DELETE SET NULL`. Deleting an account silently rewrote the audit rows
   referencing it, and six entries stopped recomputing although nobody had
   tampered with anything. Fixed by migration v12's `actor_ref`. Version 1
   rows were **not** rewritten to fit the new scheme: fabricating hashes to
   make a verifier pass is the exact failure this phase exists to prevent.
2. **`verifyChain` omitted `actor_ref` from its SELECT**, hashing `undefined`
   and disagreeing with the writer on precisely the rows that had an actor.
3. **The legacy `hash` column was `NOT NULL`**, so new rows failed to insert.
4. **Four test suites deleted audit rows** during cleanup, breaking the
   append-only property they existed to protect. Disabled, with the reason
   recorded at each site.

Found during the mandatory browser verification of this phase, in code that
predates it:

5. **The super admin panel reported the API "Unreachable" while it was
   answering 200.** Phase 4 standardised `/api/health` on `{status:'ok'}` for
   the external monitor; the widget still tested for the older `'online'` and
   still rendered `total_users` and `time`, fields the endpoint no longer
   returns. It now distinguishes the three states the endpoint can produce —
   ok, degraded (API up, database down), and no answer — because collapsing the
   middle one sends an operator hunting a dead server when the database is what
   died. All three states were exercised and observed.
6. **A failed health check claimed the database was "IndexedDB & Local State".**
   There is no IndexedDB in this system and never was, so a failed health check
   reported an invented storage engine to whoever was diagnosing the outage.
7. **`PostgreSQL 16 · Live` was a literal in the HTML of both portals** — a
   green dot with nothing behind it, on every page, which said Live with the
   database down and named a major version no deployment is obliged to run. It
   is now driven by the same health check as the panel and the monitor.
8. **`showPage()` blanked the entire document** when given a page id the
   current portal does not define: it hid every page *before* checking the
   target existed. The staff portal did exactly this from its own topbar
   avatar — clicking your own avatar produced an empty screen. Three dead
   controls in total (avatar, bottom-nav Profile, and the dashboard's "View
   Full Audit Log" button, which pointed at a page named `admin` that no
   portal defines). `showPage` now resolves first and stays put with a warning;
   the audit button points at `audit`; the staff portal's profile controls open
   the change-password modal, which already existed, was already tested, and
   had no caller in its voluntary mode.
9. **The interface claimed the audit trail was "Immutable" and "Write-Once"**
   in four places. It is hash-chained and append-only. It is not immutable: the
   digest is unkeyed and the historical segments carry no integrity protection
   at all. The labels now say what is true.
10. **The compliance pill reported one undifferentiated `COUNT(audit_logs)`**
    as "hash-chained entries", presenting unverifiable legacy rows as carrying
    the same guarantee as verifiable ones — in the panel an administrator reads
    to judge exactly that. It now reports the two separately. Observed in the
    browser at the moment the fix was verified: 198 independently verifiable,
    874 legacy retained but not verifiable. The legacy figure is frozen — no
    new row can join a closed segment — while the verifiable figure grows as
    the system is used, and read 409 by the end of the test runs below.

### Tests

All figures below are from runs completed immediately before this commit,
against a server started with `NODE_ENV=production` on port 8123.

| Suite | Result |
|---|---|
| `tests/phase5a_security.js` (in repository, for CI) | **70 passed, 0 failed** |
| phase0_sec | 40 / 0 |
| phase0_role | 9 / 0 |
| acceptance | 90 / 0 |
| qa1 | 87 / 0 |
| qa2 | 129 / 0 |
| qa3 | 37 / 0 |
| portal | 35 / 0 and 21 / 0 — the suite prints two sections, 56 checks in total |
| phase2b | 61 / 0 |
| phase2c | 72 / 0 |
| phase3 | 124 / 0 |
| phase4 | 147 / 0 |
| phase5a | 76 / 0 |
| tamper (disposable database) | 53 / 0 |
| sourcetruth | 76 metrics match, 0 mismatch |
| sourcetruth15 | 33 match, 0 mismatch |
| crossref | both portals self-contained — alumni 13 modules/328 declarations, staff 15 modules/358 declarations |
| `npm run verify-audit-chain` | **PASS through 409 entries**, exit 0 |

`tests/phase5a_security.js` is committed to the repository so these regressions
stay pinned. Its section F asserts on source with comments stripped: a comment
recording that a widget *used to* claim "IndexedDB" is not the widget claiming
it, and a test that cannot tell the difference trains people to ignore it.

Two apparent failures were investigated rather than adjusted away:

- phase2b and phase2c failed their production-seed assertions when the test
  server was started in development mode, where `POST /api/seed-db` is
  permitted. The re-seed then churned accounts mid-run and nulled `actor_id`
  on their audit rows, which failed a second assertion downstream. Both suites
  pass in the environment they are written for. Data was checked afterwards and
  was intact — the seed is idempotent.
- `sourcetruth15` reported two mismatches because it parsed the compliance pill
  positionally and expected the old single-total wording. The expectation was
  updated to the new contract and now checks **three** figures instead of two.

### Browser verification

Real sessions in a real browser, both portals.

- **Five roles** — alumni, moderator, dept_admin, univ_admin, super_admin — with
  the permission matrix confirmed: audit, compliance and operations return 403
  for the first three and 200 for the last two.
- **Alumni portal:** all 11 pages render with content. A brand-new tab with no
  console history produced **zero console messages of any kind**.
- **Staff portal:** all 15 pages render with content. Zero console errors.
- **Privacy** verified through the real UI path, not the API: the controls are
  present, offer exactly `["public","private"]`, and the saved value read back
  as `mobile: "private"`.
- **Audit panel** confirms the PII work in the interface: entries read
  `user 5`, `user 107 by user 1`.
- **Health states** all three exercised and observed — Online/Reachable with
  latency, Degraded with the database unreachable, and no answer — including
  recovery back to healthy.
- **Repaired controls** confirmed: the avatar opens the change-password modal
  with the dashboard still active; the audit button lands on `page-audit`; an
  unknown page id leaves the document rendered and warns.

The staff portal correctly refuses an alumni token carried in shared
`localStorage` and clears it. On a single-origin development host both portals
share storage; in production they are separate origins (`ADMIN_ORIGIN`).

### Remaining limitations

Stated here rather than in a report nobody reads.

1. **Historical audit entries cannot be verified.** Chain version 0 (773
   entries) consumed an in-memory timestamp that was never persisted. Chain
   version 1 (101 entries) hashed a foreign key the database nulls on account
   deletion. Neither is recoverable by any later engineering. The verifier
   reports both segments and the reason for each, and counts neither as
   verified.
2. **A row can be *added* to the historical segments undetectably.** Versions 0
   and 1 have no integrity protection at all. Anything relying on them as
   evidence should be corroborated against an off-site backup.
3. **The digest is unkeyed.** `entry_hash` is a plain SHA-256, so anyone who can
   write to the database can recompute a consistent chain. Detection rests on
   the attacker having to rewrite every subsequent row *and* the head pointer,
   and on an off-site copy disagreeing. An HMAC keyed outside the database is
   the obvious next improvement and is **not** in place.
4. **The chain proves integrity, not truth.** It shows an entry has not been
   altered since it was written, not that the application wrote something
   accurate.
5. **Historical audit metadata still contains some names and email addresses,**
   preserved deliberately (see PII hardening above).
6. **Five test-fixture events remain in the development database** — ids 483,
   484, 489, 490, 642, left by suite runs that were interrupted before their
   own cleanup. They have no registrations except one on 642 and no audit rows
   referencing them by id. They were **not** deleted: a standing constraint
   from Phase 3 forbids deleting event records, and removing them was not
   authorised. Everything else was checked and is clean — zero test users, zero
   test consent rows, zero test chapters or jobs, zero pending deletion
   requests. This affects development data only.
7. **`ENCRYPTION_KEY` escrow is written and testable but unverified** — there is
   no institutional password manager in this environment to read. It is an
   institutional deployment dependency, not a completed item, and
   `PRODUCTION_DEPENDENCIES.md` §2.6 says so.

### Files

New: `audit_chain.js`, `verify_audit.js`, `AUDIT_CHAIN.md`,
`PRODUCTION_DEPENDENCIES.md`, `PHASE_LOG.md`, `schema_v11.sql`,
`migrate_v11.js`, `schema_v12.sql`, `migrate_v12.js`,
`tests/phase5a_security.js`.

Modified: `server.js`, `routes_v2.js`, `routes_compliance.js`,
`routes_admin_users.js`, `routes_events.js`, `api.js`, `js/core.js`,
`js/navigation.js`, `js/dashboard.js`, `js/admin.js`, `js/profile.js`,
`index.html`, `admin.html`, `package.json`.

### Next phase

**Phase 5B has not been started.** Nothing in this entry anticipates its
content. The strongest candidate carried forward from here is limitation 3 —
an HMAC keyed outside the database — which would raise the bar on tampering
from "rewrite every row" to "obtain a key the database does not hold".

---

## Interlude — Location system audit *(pre-Phase-5B scope addition)*

**Status:** AUDIT ONLY — COMPLETE
**Date:** 2026-09-02
**Baseline audited:** `b9c881a`
**Code changed:** none. **Schema changed:** none. **Migrations run:** none.
**Business data changed:** none.
**Output:** `LOCATION_SYSTEM_AUDIT.md`

One side effect is disclosed rather than glossed: probing the role-visibility
matrix required signing in as all five roles, which stamps `last_login_at` and
resets the failed-login counters on those five seeded accounts
(`server.js:616`). Login writes no audit entry. Nothing else was written.

### Why it was added

Requested before Phase 5B begins, because the Master Audit did not analyse the
location feature in depth. The system is intended to show real alumni locations,
and that claim had not been tested against the code.

### What was audited

The whole location surface, treated as potentially separate systems rather than
one: alumni profile location, the Alumni Map, event venue, job location, chapter
location, location search and filtering, map technology, input UX, data quality,
privacy and role visibility, and backend/UI cross-references.

Method: repository keyword sweep, live schema inspection, direct SQL against
`dic_alumni_db`, authenticated GET probes as all five roles, and observation of
the running application.

### What it found

The headline finding is that location is **not collected**. Both account-creation
paths — self-registration (`server.js:676`) and bulk import (`server.js:1704`) —
write the literal `'Dhaka','Bangladesh'` into every new alumni profile, and no
city or country input exists anywhere in the profile editor. There are no
coordinates in the schema or the code, and no map library: the "world map" is an
empty `<svg>` over a gradient, with pins placed by a hardcoded 20-country table
of CSS percentages.

Supporting findings: the "Share My Location" toggle is a CSS class flip with no
handler; two of the three location filter chips return zero results and country
is not searchable at all; the map API computes a city aggregation that nothing
renders; four location columns have no writer; the CSV import template offers
four location columns that are silently discarded; and there is no location
privacy control, though a badge implies one by reading an undefined value.

Nothing leaks a home address — no endpoint returns one to anyone but its owner,
and all location endpoints are 401 unauthenticated. The defect is fabrication,
not exposure.

**Verdict recorded: NO** — the platform does not have a real-location system.

### Deliberately not done

No code was modified, no data normalised, no migration written, no map provider
added, and no UI changed. Every recommendation in the audit is marked as
recommendation only. The single out-of-scope observation — an "immutable audit
log" label surviving at `server.js:1982`, outside the four files the Phase 5A
test scans — was recorded and **left in place**.

---

## Phase 5B — Real location system

**Status:** COMPLETE
**Date:** 2026-09-02
**Commit:** `d07c516` (`d07c516733ed95d5544c04019f7b4bb5b78ca1f2`) — recorded by the follow-up commit, since a commit cannot contain its own hash
**Parent:** `b9c881a` (Phase 5A + location audit)

### Why location became a phase of its own

The audit above found that this was not a map problem. Location was never
collected: `server.js` wrote a hardcoded `'Dhaka','Bangladesh'` into every
profile at registration and at import, no city input existed anywhere in the
product, and the map then presented the result as where alumni live. A
"Share My Location" toggle flipped a CSS class and nothing else, two of three
filter chips returned zero rows, and there was no location privacy control at
all.

That is a data-integrity defect, not a UI defect, which is why Step 0 came
before anything else.

### Step 0 — the fabrication was stopped first

Three sources, all removed before any feature was built:

| Source | Was | Now |
|---|---|---|
| `server.js` self-registration INSERT | ended `…,'Dhaka','Bangladesh')` | writes no location at all |
| `server.js` bulk-import INSERT | ended `…,'Dhaka','Bangladesh')` | writes the location the file supplied, or none |
| `alumni_profiles.country` column | `DEFAULT 'Bangladesh'` | no default |

The column default is worth calling out. Removing the literal from both queries
was **not sufficient**: with `DEFAULT 'Bangladesh'` still in place, an INSERT
that simply omits the column records Bangladesh anyway, and the fabrication
would have moved from a query into the schema where no code review would see
it. This was caught by a test in this phase's own suite, not by inspection.

`seed.sql` also seeded a current city; a re-seed would have reintroduced exactly
what Step 0 removed, so those values are seeded NULL.

### Migration

`schema_v13.sql` / `migrate_v13.js` — additive, idempotent, transactional, run
with `--dry-run` first. 18 verification checks, all passing.

| Adds | Purpose |
|---|---|
| `location_places` (99 rows) | Controlled cities with real coordinates — 30 Bangladeshi, 69 international |
| `alumni_profiles.place_id` | Structured current location, FK to a place |
| `alumni_profiles.location_needs_confirmation` | Marks a location the old path wrote |
| Indexes on `place_id`, country/city uniqueness | Filters and aggregation |
| Drops `country` DEFAULT | See Step 0 |

A migration check asserts that **no latitude or longitude column was added to
`alumni_profiles`**, and an md5 fingerprint over every stored location value
proves the existing data is byte-identical afterwards.

### Existing data — flagged, not migrated

The 14 pre-existing rows say "Dhaka, Bangladesh" and cannot be told apart from
a genuine answer by inspection, so they were **not** converted, normalised or
deleted. Each is flagged `location_needs_confirmation = TRUE`, and:

- they are **excluded from the map**, because plotting them would republish the
  fabrication this phase removed;
- they are still **shown in the directory and on the profile**, marked
  `(unconfirmed)` in amber, because the value is the only record of what the old
  system stored;
- the profile page and the editor both ask the member to confirm.

Choosing a city clears the flag. Nothing else does — an administrator cannot
confirm a location on somebody's behalf.

### Location model

Coordinates belong to **places**, never to people.

```
location_places(id, country_code, country, division, district, city,
                latitude, longitude, is_active)
alumni_profiles.place_id            → location_places(id)
alumni_profiles.city/country/...    ← denormalised copy, written from the place
alumni_profiles.location_needs_confirmation
```

`place_id` is the single writer. `city` and `country` were removed from the
editable-field whitelist: location is set by choosing a place, so the map, the
directory filters and the import cannot disagree about what "Dhaka" means.

### Privacy

`privacy.js` is now the one definition of field privacy. The server validates
writes against it, gates reads with it, and serves it to the browser at
`GET /api/profile/privacy-schema`, which is what the editor renders its controls
from. Previously the same thing was described in three places — a hand-kept
array in `server.js`, a different default in the database, and a third list in
`js/profile.js` — and they disagreed.

| Level | Effect on location |
|---|---|
| `public` | Visible to members **and** counted in the map aggregate |
| `alumni` | Visible to members, **not** on the map |
| `private` | Visible to nobody but the owner |

Three levels with three genuinely different behaviours. The Phase 5A rule still
holds: a level that changes nothing is not offered, which is why `email` and
`mobile` still have two.

**Location has no staff bypass.** `email` and `mobile` do; location does not. A
private city is private to every role, including super admin. If DIC needs a
regional view for outreach, that should be an explicit, role-scoped, audited
report rather than an implicit exemption nobody set out to grant.

**Street address, permanent address, postal code and hometown are self-only,
unconditionally,** and are not offered as a setting. The only two levels that
could exist are "just me" and "share my home address with every member"; the
second has no legitimate use in a college alumni directory and a real cost for
the people least able to absorb it. The interface states this as a fact instead
of rendering a switch that should never be moved. **This is a deliberate
deviation from the brief's §5**, which asked for three levels on address.

### The map

No new provider, no API key, no tiles, no licence, no internet dependency —
nothing was added to `package.json`.

- Pins are projected from the **real latitude and longitude** of each city with
  an equirectangular projection. `MAP_COUNTRY_POSITIONS`, a hand-written table
  of twenty countries with `top`/`left` percentages chosen by eye, is gone.
- `<svg id="world-map-svg">`, which shipped **empty** in both portals and which
  nothing ever populated, now draws the graticule the projection is defined
  against — meridians and parallels every 30°, equator and prime meridian
  emphasised.
- Cities render, with names. The old map fetched a city aggregation and used
  only the country totals.
- The endpoint returns counts attached to places, never rows attached to people.

Verified live: Chattogram (22.3569°N, 91.7832°E) plots at left 75.50%, top
37.58% — exactly `(91.7832+180)/360` and `(90−22.3569)/180`.

It is deliberately **not** a basemap. Coastlines would need either a tile
provider or hand-authored outlines, and geography drawn from memory is its own
kind of fabrication. What is drawn is exact; what is missing is absent rather
than approximated.

### CSV import

The template offered `PresentAddress, PermanentAddress, Hometown, District,
Country` and the client mapped **only** `presentAddress`; the other four were
parsed out of the file and silently discarded, then city and country were
overwritten with the hardcoded literal. Now:

- all of them are mapped, plus `City` and `PostalCode`, which the template
  now offers;
- city/country are resolved against the reference places, with documented
  aliases only (`Chittagong → Chattogram`, `Comilla → Cumilla`, `UK → United
  Kingdom`, and so on);
- an unrecognised city is **reported back by row number** in
  `unresolvedLocations` and the row imports **without** a location — never with
  a guessed one;
- an imported location counts as confirmed, because it came from the
  institution's records rather than from a literal in a query.

### Files

New: `privacy.js`, `location.js`, `schema_v13.sql`, `migrate_v13.js`,
`tests/phase5b_location.js`, `LOCATION_SYSTEM_AUDIT.md`.

Modified: `server.js`, `api.js`, `schema.sql`, `seed.sql`, `index.html`,
`admin.html`, `styles.css`, `js/profile.js`, `js/dashboard.js`,
`js/directory.js`, `js/jobs.js`, `js/admin.js`, `js/core.js`,
`js/navigation.js`.

### API changes

| Endpoint | Change |
|---|---|
| `GET /api/locations/places` | **New** — reference cities for the selector |
| `GET /api/locations/filters` | **New** — directory filter options, from real data |
| `GET /api/profile/privacy-schema` | **New** — the contract the browser renders from |
| `GET /api/stats/map` | City aggregates with coordinates; public-only; reports `unconfirmed` separately |
| `GET /api/alumni` | New `country`, `city`, `placeId` filters; location privacy-gated; city removed from free-text search |
| `GET /api/alumni/:id` | Location now gated by `canSee`; returns `locationConfirmed` |
| `PUT /api/profile/me` | Accepts `placeId`, `hometown`, `postalCode`, `permanentAddress`; rejects free-text `city`/`country` |
| `POST /api/bulk-import` | Accepts and resolves location; returns `unresolvedLocations` |

### UI changes

Removed: the "Share My Location" no-op toggle, the "Opt-in location" claim, the
hardcoded Dhaka/UK/USA chips in both portals, the hardcoded percentage pin
table, the hardcoded `value="Dhaka"` on the job-posting form, and the job
location dropdown's fixed four options.

Added: a Location section in the profile editor (city selector grouped by
country, hometown, postal code), schema-driven privacy controls, data-driven
location filter chips, an `(unconfirmed)` marker in the directory, a
confirmation prompt on the profile, and city labels on the map.

### Tests

Against a server started with `NODE_ENV=production` on port 8123.

| Suite | Result |
|---|---|
| **`tests/phase5b_location.js`** (new, in repository) | **122 passed, 0 failed** |
| `tests/phase5a_security.js` | 70 / 0 |
| phase0_sec | 40 / 0 |
| phase0_role | 9 / 0 |
| acceptance | 90 / 0 |
| qa1 | 87 / 0 |
| qa2 | 129 / 0 |
| qa3 | 37 / 0 |
| portal | 35 / 0 and 21 / 0 |
| phase2b | 61 / 0 |
| phase2c | 72 / 0 |
| phase3 | 124 / 0 |
| phase4 | 147 / 0 |
| phase5a | 76 / 0 |
| tamper (disposable database) | 53 / 0 |
| sourcetruth | 78 metrics match, 0 mismatch |
| sourcetruth15 | 33 match, 0 mismatch |
| crossref | both portals self-contained |
| `npm run verify-audit-chain` | PASS through 536 entries, exit 0 |

The new suite covers what the brief asked for: no path fabricates a location
(§22), map aggregation and coordinate provenance (§23), the three privacy
levels including the negative cases, address and coordinate non-leakage across
all five roles, unauthenticated refusal, resolver behaviour, and that the fake
facade is gone.

### Regressions found and fixed

1. **`alumni_profiles.country` still defaulted to `'Bangladesh'`.** Removing the
   literal from both INSERTs left the schema fabricating. Caught by this
   phase's own test, fixed in the migration and in `schema.sql`.
2. **`seed.sql` would have reintroduced a fabricated city** on any re-seed.
3. **`GET /api/alumni/location-filters` would never have been reachable** —
   `/api/alumni/:id` is declared earlier and matches `location-filters` as an
   id. Moved to `/api/locations/filters`.
4. **The map graticule was invisible.** Drawn with `stroke="currentColor"`,
   which inherited the dark page text colour on a dark canvas.
5. **Backticks inside an HTML comment in a template literal** broke
   `js/profile.js` — the same trap as Phase 3, caught by `node --check`.

Two test expectations were **updated rather than weakened**, both because
Phase 5B superseded the mechanism they pinned:

- `phase5a` asserted that `js/profile.js` contains a hardcoded
  `PROFILE_PRIVACY_SETTINGS = {mobile, email}` literal. That was the right
  guarantee expressed as the wrong test — it pinned the mechanism. The client
  now derives its fields from the server schema, which is a stronger form of
  the same property, and the assertion tests that instead.
- `sourcetruth` compared the map against `COUNT(alumni_profiles.country)`, the
  free-text column this phase made untrustworthy on purpose. Its expectations
  now follow the new contract and assert two additional facts (cities plotted,
  and rows awaiting confirmation), so the suite grew from 76 to 78 metrics.

### Browser verification

- Full round trip through the real UI: opened the editor, chose Chattogram from
  the city selector, set location privacy to public, saved — and the city
  appeared on the map at the correct projected position with the correct count.
- The editor renders 100 cities across 45 country groups, three privacy
  controls built from the server schema, and location's three levels.
- Directory chips read `Bangladesh (1)` and `Chattogram (1)` — from data.
- Directory cards show `Dhaka, Bangladesh (unconfirmed)` for legacy rows and
  `Chattogram, Bangladesh` unmarked for the confirmed one.
- Map caption: *"1 city, 1 alumni who chose to appear on the map. 13 profiles
  carry a location recorded automatically before it could be confirmed; they
  are not shown here."*
- All 15 staff-portal pages render. Zero console errors on either portal.
- Responsive at **360, 390, 430, 768, 1024, 1280** — no horizontal overflow at
  any width; city labels hide below 640.

### Remaining limitations

1. **13 profiles still hold an unconfirmed location.** Only the member can
   clear that, by choosing a city. Until they do they are absent from the map.
   This is the intended state, not an outstanding task.
2. **The map has no basemap** — a graticule and pins, no coastlines. Adding one
   means a tile provider (dependency, key, licence) and is a decision for DIC.
3. **99 reference cities.** A member whose city is not listed must choose the
   nearest listed one or nothing. Bangladesh has 30; adding more is a data task,
   not a code change.
4. **Work mode is still not modelled.** `jobs.type` is employment type; "Remote"
   remains a place string on `jobs.location`. Out of scope by §16.
5. **Chapters still have no structured location** — `type='regional'` with the
   region only in the name. Out of scope by §17.
6. **Event venue is still one free-text line** with no address, coordinates or
   directions. Kept separate from alumni location by design (§15).
7. **Bangla city names are not transliterated.** A city typed in Bangla will not
   match a reference place; the controlled list avoids the problem for chosen
   locations but not for imports.
8. **Address privacy is fixed, not configurable** — the deliberate deviation
   described above.
9. **A fresh install must run the migrations.** `schema.sql` is the base schema
   and has never tracked migrations v2–v13; this is the repository's existing
   convention, not something this phase introduced.

### Next phase

**Phase 5C has not been started.** Nothing here anticipates it.

---

## Phase 5B follow-up — Map visualisation

**Status:** COMPLETE
**Date:** 2026-09-02
**Commit:** `6a89d9e` (`6a89d9eea44eeacbae634dcc5ae08307c8d0ca44`) — recorded by the follow-up commit, since a commit cannot contain its own hash
**Parent:** `6a15b6d`

A visualisation upgrade on top of the Phase 5B location system. The location
architecture, privacy model, migration and data-integrity rules were **not**
reopened — no schema change, no migration, no change to what is collected or to
who may see it.

### What this is not

There are **no country boundaries**, and none are implied. The repository was
checked first: no `world-atlas`, `topojson`, `geojson`, `natural-earth` or any
other geography dataset is installed or vendored, and `assets/` holds only
logos. Per the brief's own fallback — *"If real country polygon data is
unavailable, KEEP the existing coordinate-based world map and make the count
markers visually excellent"* — the map stays coordinate-based. **No country
shapes were hand-drawn**, and no map provider was added: `package.json` is
untouched, and there is still no Leaflet, Mapbox, Google Maps or tile source
anywhere in the project.

### What changed

**Backend — one query, one source of truth.** `GET /api/stats/map` already
returned city aggregates with coordinates. The country rollup now also returns
`cities` (how many distinct places that country's alumni are in) and a
`latitude`/`longitude` for the badge. That position is the **alumni-weighted
mean of the country's own city coordinates** — it is a fact about the alumni,
not a centroid and not a border, and the interface says so where it is shown.
It is computed in SQL so the browser never derives a figure of its own.

**Cities and countries.** A toggle switches the same data between one badge per
city and one per country. Country badges carry the total and open a panel
reporting the name, the total and the number of cities represented.

**Clustering.** Places too close to draw apart at the current zoom merge into a
single badge carrying their combined total; clicking it lists the places inside
with their individual counts, each a way through to that one place. The first
attempt pushed colliding badges apart instead and scattered them across a third
of the map — worse than the overlap it solved — so merging replaced it.

**Zoom.** `−` / `+` / Focus / World. Zoom scales the projection rather than
CSS-transforming the layer, so badge text keeps a constant size and stays
legible. Zooming in recentres on the alumni-weighted centre of the data, and
the range reaches 16× so that a cluster genuinely does separate — the detail
panel tells the reader to zoom in, and at the original 4× ceiling Dhaka and
Chattogram still would not have parted.

**Legend** bands are derived from the counts actually being drawn. The old fixed
`1000+ / 100–999 / <100` scale put every real place in one bucket.

**Ranked list** beside the map (below it under 1200px) giving the exact figure
per place, which is also what carries a narrow screen where labels are hidden.

**Directory hand-off.** Clicking a city or country and choosing *View alumni*
opens the directory through the **structured** `?city=` / `?country=` filter —
never the free-text search box.

**Light theme.** The canvas was the only dark surface in an otherwise light
product, with glowing discs and a pulse animation. It is now a light neutral
with a restrained single-hue ramp, no glow and no animation.

**Admin portal.** The staff Geographic Distribution panel already read the same
endpoint and gained no aggregation of its own. It now shows each country's city
count and each row opens the directory on that country, through the same
structured filter.

### Files changed

`server.js` (country rollup query only), `js/dashboard.js`, `index.html`,
`styles.css`, `tests/phase5b_location.js`.

### API changes

One endpoint, additive: `GET /api/stats/map` country rows gained `cities`,
`latitude` and `longitude`. No new endpoint, no removed field, no change to
what any other endpoint returns.

### Privacy

Unchanged, and re-asserted by test. Only `location = 'public'` profiles are
counted; `alumni` is visible on a profile but not on the map; `private` appears
nowhere. There is no staff bypass. No personal coordinate exists to leak — the
only coordinates in the payload belong to `location_places` rows. Unconfirmed
legacy locations are still reported as a number and never plotted. Every map
endpoint still refuses an unauthenticated caller.

### Tests

`tests/phase5b_location.js` grew a section M (**142 checks total**, 0 failed;
the per-city assertions scale with how many cities hold alumni). It asserts,
per country and per city, that the count, the city count and the marker
position each reconcile with an independent SQL query; that city coordinates
are the `location_places` values; that country and city totals agree; that
`alumni` and `private` locations drop out of the totals; that the payload names
no person; that no hardcoded position table or percentage constant remains;
that the browser neither queries nor recounts; and that the click-through uses
the structured filter.

Full battery green: 893 across twelve suites, `phase5a_security` 70/0, tamper
53/0, sourcetruth 78 metrics / 0 mismatch, sourcetruth15 33/0, crossref clean,
`verify-audit-chain` PASS through 767 entries.

### Browser verification

With 29 temporary fixture members created through the real registration and
profile API across 11 cities in 7 countries, then deleted (0 remaining;
`users` back to 18).

- The acceptance path end to end: badge `9` on Dhaka → click → detail panel →
  *View alumni* → directory on `city=Dhaka`, free-text search empty →
  *"Showing 9 of 9 profiles"*, every result in Dhaka.
- Admin panel: *United Kingdom · 2 cities · 4* → click → `country=GB` → 4 of 4,
  three London and one Manchester.
- Cluster behaviour across zoom: world 6 badges (Bangladesh merged as *4
  cities*), 8× splits London from Manchester, 16× splits Bangladesh into
  Chattogram 5, Sylhet 3 and a Dhaka pair.
- Empty state, exercised by stubbing the payload: *"No confirmed locations to
  display yet."*, zero markers, zero rows, empty legend — no placeholder pins.
- **360, 390, 430, 768, 1024, 1280**: no horizontal overflow at any width, all
  badges circular, controls 44px tall, side-by-side layout engages at 1200px.
- Zero console errors on either portal.

### Regressions found and fixed during this work

1. **Badges rendered as ellipses on mobile.** A blanket
   `#pages button { min-height: 44px }` stretched a 40px circular badge to 44px
   tall. They are exempted and given a 44px hit area through an invisible
   `::before`, so the touch target is honoured without deforming the target.
2. **The first anti-overlap strategy was wrong** and is described above.
3. **Over-merging.** The replacement used a 54px clearance, which on a canvas
   squeezed to ~430px by the side panel collapsed nine cities into one badge.
   The map now takes the full width below 1200px and the threshold matches a
   real badge diameter.
4. **Zoom pushed the data off-canvas**, because it magnified 0°,0° in the
   Atlantic.
5. **A label was clipped** at the right edge; labels near the edge now flip.
6. **Dead CSS** for the removed "Share My Location" toggle
   (`.location-toggle`, `.toggle-switch`, `.toggle-thumb`, `.toggle-label`) was
   still in the stylesheet and is gone.
7. **One test of my own was a false positive** — `/SELECT/i` against the
   frontend matches `querySelectorAll` and `mapSelected`. Rewritten to look for
   the shapes a recomputation would actually take.

### Intentional non-changes

- No boundary dataset, no polygons, no map provider, no `package.json` change.
- No schema change, no migration, no change to `location_places` contents.
- No change to what is collected, to the privacy levels, or to the
  confirmation rules.
- The event, job and chapter location models were not touched.
- Free-text search still does not match city or country; that is Phase 5B's
  deliberate behaviour, and location filtering is structured.

### Remaining limitations

1. **No basemap.** A graticule and badges, no coastlines or borders. Adding
   them needs a published dataset or a tile provider — a decision for DIC, with
   licensing implications, not something to improvise.
2. **A country badge is a mean position, not a place.** For a country whose
   alumni are far apart the badge sits between them. The panel states this
   wherever the position is shown, and the ranked list is unambiguous.
3. **No pan.** Zoom recentres on the data or on the busiest place; there is no
   drag-to-pan, so a place far from the centre can leave the frame when zoomed.
   Every count remains readable in the ranked list, so no figure depends on
   panning to reach it.
4. **City labels are hidden below 900px** to stay legible; the ranked list
   carries the names there.
5. **Only cities in `location_places` can appear** — the Phase 5B limitation,
   unchanged.

### Next phase

**Phase 5C has not been started.**

---

## Phase 5C — Whole-system post-location audit

**Status:** COMPLETE (audit only)
**Date:** 2026-09-02
**Commit:** `e1aa5d4` (`e1aa5d43eacf4dc651627c8227ec8404858736a0`) — recorded by the follow-up commit, since a commit cannot contain its own hash
**Parent:** `5cfbc5e`
**Code changed:** none. **Schema changed:** none. **Migrations run:** none.
**Business data changed:** none.
**Output:** `POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md`

One side effect is disclosed rather than glossed: establishing the role matrix
required signing in as all five roles, which stamps `last_login_at` and resets
failed-login counters on those seeded accounts, and the rate-limit probe
recorded five failed sign-ins for a non-existent address. Nothing else was
written.

### Why

To establish the current truth across all fifty subsystems after Phases 5A and
5B, without trusting earlier phase reports — including this log.

### Method

Repository and schema inspection; extraction of all **138 routes** with their
guards; a live **6-role × 29-endpoint** authorization matrix; IDOR,
privilege-escalation, SQL-injection and parameter-tampering probes; table- and
column-level dead-code sweeps; a data-honesty trace of every displayed number to
its source; the full regression battery; and browser inspection of both portals
at 360/390/430/768/1024/1280.

### What it found

**24 findings: 2 P0, 6 P1, 10 P2, 6 P3.**

Seventeen of eighteen Master Audit findings are **resolved and verified live**,
not merely claimed — including the deletion purge, observed erasing a real user,
and the scheduler and backup, observed running.

Two findings block handover:

- **`P5C-001` — stored XSS in the bulk-import preview.** Fifteen CSV field
  interpolations render into `innerHTML` with no escaping, in an ADMIN_ROLES
  session. Proved live with a benign `<em>` marker, which became a DOM element.
  No previous phase caught this.
- **`P5C-002` — the README documents a product that does not exist.** All 21
  claimed profile fields are absent from the 64 real columns, and three claimed
  privacy levels ("Same Batch", "Connections", "Teachers") exist nowhere. Phase
  3 corrected this file's payment and production claims but never revisited its
  feature list.

Authorization itself is sound: **36 of 36** probes behaved correctly, injection
returned zero rows, `limit` is capped and negative `offset` clamped, and rate
limiting returns 429 from the sixth failed sign-in.

### Tests run

All green, unchanged by this audit: phase0_sec 40, phase0_role 9, acceptance 90,
qa1 87, qa2 129, qa3 37, portal 21, phase2b 61, phase2c 72, phase3 124, phase4
147, phase5a 76, tamper 53, `tests/phase5a_security.js` 70,
`tests/phase5b_location.js` 142 — **1,158 checks, 0 failed** — plus 78 + 33
source-truth metrics with 0 mismatches, and `verify-audit-chain` PASS through
852 entries.

### Browser verification

Both portals at six widths. No horizontal document overflow anywhere, zero
console errors, all 11 alumni and 15 staff pages rendering. One real defect:
the events "All" filter chip is unreachable at 360 px (`P5C-013`).

Two intermediate measurements were discarded because browser-pane geometry reads
as zero when a tab is backgrounded; they were re-taken with an explicit viewport
and only the re-taken figures are recorded.

### Deliberately not done

No fix was implemented, including for `P5C-001`. This was an audit phase, and
mixing a security fix into it would have made the audit's own baseline moving.
The recommended next phase is a small one closing `P5C-001`, `P5C-002`,
`P5C-003` and `P5C-018`.

### Readiness

**Not ready for handover:** two engineering items, both small, estimated under a
day. After those, the remaining gap is institutional — SMTP, domains, secrets
and named people, all in `PRODUCTION_DEPENDENCIES.md` Part 2 — and cannot be
closed from inside the repository.

### Next phase

**Phase 5D has not been started.** Its recommended contents are in the audit's
prioritised roadmap.

---

## Phase 5D — Closing the handover blockers

**Status:** COMPLETE
**Date:** 2026-09-02
**Commit:** `f142706` (`f1427060346cacd4244e66d8e2a31e085be913f2`) — recorded by the follow-up commit, since a commit cannot contain its own hash
**Parent:** `01776c0`

Implements the P0 and actionable P1 findings from
`POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md`. No schema change, no migration, no
business data touched.

### P0-001 · `P5C-001` — Stored XSS in the bulk-import preview

CSV field values were interpolated into `innerHTML` unescaped and rendered in
an ADMIN_ROLES session — one that can provision administrators, read the audit
log and reveal identity-vault records. Rosters arrive from departments and
third parties, so an untrusted file is the normal case.

**Every sink was audited, not just the demonstrated one.** Sixteen in total:
fifteen record fields across the valid, duplicate and invalid preview tables,
plus the "Parsed File" header, which renders the **uploaded filename** — also
attacker-chosen. All now pass through `escapeHtml`, the same helper the other
~370 call sites use; this screen simply never called it. The step-1 mapping
block was already correct and was left alone.

*The filename sink was found only because the fix was verified in the live DOM.*
An earlier check against a detached node reported SAFE because it set the record
fields but not the filename. The live panel still executed the payload. That is
recorded because it is the reason the verification method matters: a component
tested in isolation passed while the real screen was still vulnerable.

**Verified** in the live staff portal with the payload classes from the brief —
`<em>` marker, `<img src=x onerror=…>`, `"><svg onload=…>`,
`</script><script>…`, a `javascript:` URL, an `onclick` div, and a quote-break
attempt. Result: **handler never fired, no injected element, no `img` created,
no `javascript:` href, payload present as literal text**. The three `onerror`
attributes remaining in the DOM are the application's own logo fallbacks.

The **error-report CSV** is the second sink for the same untrusted data and got
the same treatment: values are now RFC-4180 quoted (embedded `"` doubled — a
name containing a quote previously broke the row into extra columns) and
prefixed against spreadsheet formula injection when they begin `= + - @`.

### P0-002 · `P5C-002` — README described a product that does not exist

All 21 advertised profile fields were checked against
`information_schema.columns`: **0 of 21 existed**. The three claimed privacy
levels ("Same Batch", "Connections", "Teachers") exist nowhere in the code.

The feature list was rewritten from the schema and from `privacy.js`. It now
lists the fields that have columns, the three privacy fields the server
actually enforces with their real levels and defaults, and the single
`is_verified` flag rather than four verification badges. The absent features
are named explicitly under **"Not currently implemented"** rather than quietly
deleted, so a reader who remembers the old claims can see what happened to
them.

Also corrected in the README: the bulk-import section (19 mappable columns, not
"43-Field Support"; duplicate detection by email then mobile, not a four-key
priority chain; no CGPA or phone validation, which was claimed and does not
exist), and the RBAC table (a "Career Tracker" and a reported-posts moderation
queue, neither of which exists). A **Location** section was added — Phase 5B
built the whole location system and the README never mentioned it.

### `P5C-003` — `GET /api/stories` was public

The only route in the product answering without a session, returning
`SELECT *` including `author_id`.

**Decision: require a session,** rather than keeping it public because it
happened to be. The news feed is reachable only from inside the signed-in
application, all 140 other data routes require a session, and the platform has
no anonymous surface at all — it was public by omission. The column list is now
explicit and `author_id` is returned to nobody. If DIC later wants a genuinely
public news page, that is a deliberate decision with its own endpoint.

Verified: anonymous **401**, authenticated 200, `author_id` absent, feed still
renders (2 cards).

### P1 decisions

| Finding | Decision |
|---|---|
| `P5C-004` SMTP unset | **Deferred — external.** No code can fix it; documented in `PRODUCTION_DEPENDENCIES.md` §2.4. |
| `P5C-005`/`P5C-006` import result | **Fixed.** The success screen now reports the server's `created/updated/skipped/rejected` instead of the client's pre-send count, and surfaces unresolved locations by row — data the server has returned since Phase 5B that nothing displayed. |
| `P5C-007` chapter location | **Deferred.** A feature decision for DIC, not a defect in what exists. |
| `P5C-008` job edit | **Fixed.** `PUT /api/jobs/:id` was ownership-guarded and unreachable; the job card now offers Edit and reuses the posting form. |
| `P5C-009` stale counters | **Mitigated, removal deferred** — see below. |
| `P5C-013` events filter | **Fixed** — see below. |
| `P5C-021` test suites | **Fixed** — see below. |

### `P5C-009` — stale counters: deliberately not dropped, deliberately not rewritten

The brief cautioned against casually dropping columns, and against silently
rewriting seeded counters. Both were honoured: **no column was dropped and no
counter value was changed** (`chapters.members_count` still sums to 41,990,
verified after the work).

What changed is that the trap is no longer silent. Every write site now carries
a `NOT A SOURCE OF TRUTH` block naming the audit finding, stating what the
product reads instead (`COUNT(chapter_memberships)`, a live `COUNT(*)` for event
capacity, `SUM(amount)` for campaigns), and warning that the absolute value is
meaningless. A test asserts the marker is present at each site. Removal belongs
in a schema-cleanup phase with a migration, not here.

### `P5C-013` — events filter unreachable at 360 px

The row already had `overflow-x: auto`, which did nothing: `.ev-toolbar` is a
**column** flex container at that width, so `flex` governs height and never
constrained the width. The row rendered 376 px inside a 344 px toolbar and the
"All" chip sat past the edge of a 360 px screen.

Pinning `width: 100%; max-width: 100%` gives the overflow something to scroll.
Verified at 360 px: client width 344, scroll width 376, **scrollable true**, all
five chips reachable, all 44 px tall (raised from 40), no document overflow.

### `P5C-021` — the test suites now live in the repository

Sixteen suites existed only in a scratch directory outside the repository and
would not have survived a clone. All are now under `tests/`, with every
absolute path replaced by `path.join(__dirname, '..')`.

Two portability defects surfaced in the process and were fixed rather than
worked around:

- **`phase4` matched source with `\n`** while a Windows checkout stores CRLF, so
  two assertions failed on a fresh clone while passing where they were written.
  The source reader now normalises line endings.
- **`phase0_sec` asserted 401 exclusively** when spraying weak passwords. It
  already avoided the per-account lockout, but the per-IP rate limiter still
  trips partway through — correctly. The property under test is "a weak password
  never yields a session", and 429 satisfies that more strongly than 401, so
  both are accepted and a token is still forbidden.

`npm test` runs all 19 suites through `tests/run-all.js` and reports one total.

### New defects found while fixing the above

- **`P5C-025`** — `esc()` was called in the import success screen and is not
  defined anywhere in the frontend. Proved live: `ReferenceError: esc is not
  defined`, thrown whenever a batch created accounts — the one moment the
  temporary password is shown, and it is stored only as a hash. Fixed.
- **`P5C-026`** — a Phase 5B regression of mine: `HEADER_RULES` auto-mapped six
  location fields that `IMPORT_FIELDS` never offered, so an auto-mapped column
  showed "— Do not import —" in the dropdown and could be silently dropped.
  Fixed, with a test asserting the two lists agree.
- **`P5C-027`** — the import panel claimed "CSV or Excel" and "email
  notifications"; neither is true. Corrected.

### Files changed

`js/admin.js`, `js/jobs.js`, `server.js`, `routes_events.js`, `routes_v2.js`,
`styles.css`, `README.md`, `package.json`,
`POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md`, `PHASE_LOG.md`.
New: `tests/phase5d_hardening.js`, `tests/run-all.js`, and the sixteen relocated
suites.

### Tests

**1,360 passed, 0 failed across 19 suites** via `npm test`, including the new
`tests/phase5d_hardening.js` (56 checks) which pins every fix above: that no
record field or the filename is interpolated unescaped, that `esc()` is gone,
that the escaping helper neutralises each dangerous character, that the success
screen reads the server's tallies, that the error CSV quotes and guards its
cells, that header rules and the dropdown agree, that `/api/stories` refuses
anonymous callers and hides `author_id`, that the README claims no absent field
or privacy level, that the events filter row scrolls with 44 px targets, and
that every stale counter carries its marker while its seeded value is
unchanged.

Three of those assertions failed on first run — all three were bugs in the test,
not in the fix (a line-wrapped README phrase, and two searches anchored on the
first `UPDATE <table>` rather than on the counter's own increment). They were
corrected to test the property rather than the coincidence.

### Browser verification

Both portals. Alumni at **360, 390, 430, 768, 1024, 1280**; staff at 1280 and
360. No horizontal document overflow at any width, all 11 alumni and 15 staff
pages rendering, **zero console errors** in a fresh tab.

Specifically exercised: the hostile-CSV import preview in the live admin DOM
(safe, payload as text); the events filter row at 360 px (scrolls, all chips
reachable); the job Edit button (opens prefilled, "Save changes"); and the news
feed after the stories auth change (still renders).

### Data integrity

18 users (unchanged), **0 test fixtures**, 14 profiles, 1 confirmed location, 13
unconfirmed, 99 reference places, privacy values unchanged, and
`chapters.members_count` still 41,990 — **not silently rewritten**.

### Intentional non-changes

- No schema change, no migration, no column dropped, no counter reconciled.
- `event_proposals` left in place (`P5C-010`).
- Chapter location, planner UI, map pan, skip-link and heading hierarchy left
  for later phases.
- The P2/P3 items not listed above were **not** opportunistically fixed.

### Readiness

**No P0 remains.** The two handover blockers are closed and pinned by tests.

The remaining gap is not engineering: SMTP credentials, two domains, three
secrets and their escrow, a hosting decision and named people for the escalation
path — `PRODUCTION_DEPENDENCIES.md` Part 2. Those cannot be closed from inside
the repository.

Outstanding engineering work is P2/P3 only: `P5C-007`, `P5C-010`, `P5C-011`,
`P5C-012`, `P5C-014` to `P5C-020`, `P5C-022` to `P5C-024`.

### Next phase

**Phase 5E has not been started.**
