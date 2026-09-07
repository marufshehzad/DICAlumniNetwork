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

**Phase 5E had not been started when this entry was written.**

---

## Phase 5E — Production and handover readiness

**Status:** COMPLETE
**Date:** 2026-09-02
**Commit:** `e267ffb` (`e267ffb4597500514f5e7f24be0fd9055e745610`) — recorded by the follow-up commit, since a commit cannot contain its own hash
**Parent:** `5b0a5b8`

An audit of the production configuration path, the fixes it produced, and the
two documents a handover needs. No product feature was added, no UI redesigned,
no schema changed, no column dropped, no historical audit entry rewritten.

The method that mattered: **the production path was executed, not read.** Every
finding below was invisible in code review and obvious the moment a server was
booted with a production environment and asked what it did. Four of the six had
been in the repository across several phases of audit.

### Six production defects, found by running it

**1 · `MAIL_TRANSPORT` unset silently meant `console`.** The mailer treated an
absent variable as an explicit choice and fell through to the development
transport, which *prints password-reset links into the log*. A production
deployment that simply forgot the variable would have written single-use
account-recovery tokens in plaintext to its log file while the Operations panel
reported email as configured. It now has no default: production refuses to
start until one of `smtp` / `console` / `none` is chosen.

**2 · Production with no origins configured served
`Access-Control-Allow-Origin: *`.** `PUBLIC_ORIGIN` and `ADMIN_ORIGIN` were
optional, and unset they handed `cors()` an `undefined` origin — which is the
permissive wildcard, not "no CORS". The session is a bearer token rather than a
cookie, so this was not a one-click account takeover; it was still a production
API answering every origin on the internet. Both are now required.

**3 · The startup banner printed a database name it had not checked.** It
printed a hardcoded `"dic_alumni_db"` whether or not that database existed, and
whether or not the connection worked. Booted against a nonexistent database, it
cheerfully announced a successful connection. It now asks the connection:

```
🐘 Connected to PostgreSQL database "dic_alumni_db" (PostgreSQL 16.14)
🐘 NOT connected to PostgreSQL: <reason>
```

**4 · The public alumni domain served the staff portal.** Host routing used
`adminOrigin.includes(host)` — a substring test. Under the architecture this
project recommends, `alumni.dic.edu.bd` is a substring of
`https://admin.alumni.dic.edu.bd`, so a request to the **public** domain matched
the admin origin and was served `admin.html`. Verified:
`'https://admin.alumni.dic.edu.bd'.includes('alumni.dic.edu.bd') === true`.

The API enforces roles server-side regardless of which shell is served, so this
was the wrong page rather than an access-control failure — but the wrong page,
on the college's public alumni domain, for every visitor. Now compared as
hostnames, with an explicit fallback: when both origins share a hostname (the
single-host deployment) the server keeps routing by path, because treating a
shared host as "admin" would serve the staff portal for every request.

**5 · Campaign creation fabricated payment gateways.** `POST /api/campaigns`
defaulted `gateways` to `['bkash','nagad','card']` — three payment providers
this platform has never been connected to, written into the database as fact by
every campaign an administrator created. Nothing renders the column, so it was
never a visible lie; it was a fabrication at write time, and the same pattern as
the hardcoded `'Dhaka'` that Phase 5B removed. It now writes only what the
caller supplies, which today is nothing. **The column was not dropped** — that
belongs to a schema-cleanup phase.

**6 · `tests/run-all.js` referenced two variables that no longer existed.**
Left from a rename. The runner threw `ReferenceError` on any suite that produced
no summary line — exactly the case it exists to report.

### The restore drill

Run end to end, following the brief's sequence, into an **isolated** database
(`p5e_restore_verify`). Never over the live one.

- 47 tables restored.
- Location data intact: 99 reference places, 0 bad coordinates, and **0 personal
  coordinate columns** — the Phase 5B invariant re-checked on the restored copy.
- Privacy values preserved exactly.
- **Audit chain verified on the restored database through 1,417 entries, exit 0.**
  This is the strongest available evidence that a dump is complete and
  unaltered: any missing or modified row breaks the chain.
- The application was started against the restored copy and a real `super_admin`
  sign-in succeeded.
- The drill database was dropped; the live database was confirmed untouched
  (18 users, unchanged).

### Fail-closed testing, honestly

Testing "production refuses to start without X" on a machine that has a `.env`
is worthless: the file supplies X and the test passes for the wrong reason.
`.env` was moved aside twice and **restored byte-identical, md5-verified, both
times**. For the repeatable suite, `db.js` gained `DIC_SKIP_DOTENV=1`, which
makes the app ignore the file entirely. It can only ever make the configuration
smaller, never weaker-but-running — with a variable genuinely absent, production
refuses to start.

Two of that suite's first results were **false failures of my own making**, both
worth recording:

- Three source assertions of the form "this pattern is gone" matched the
  *comment explaining the fix*, which quotes the pattern. Comments are now
  stripped before source assertions — the third time this project has hit that
  trap.
- The host-routing test used `fetch` to send a `Host` header. `Host` is a
  forbidden header name in the fetch spec and undici drops it silently, so the
  test reported that the admin host served the alumni site **having never
  changed the host**. Rewritten with raw `http.request`, it passes.

### Secrets

No secret value is printed anywhere — by the refusal message, by a successful
boot, or by this log. That is asserted, not assumed: the suite boots a server
with known throwaway secrets and greps the entire output for them.

### Tests

`tests/phase5e_production.js` — **35 checks**, registered in `run-all.js`:
production fails closed on each of the six required variables and on three
malformed ones; no secret is printed; CORS is an allow-list and never a
wildcard; each hostname serves its own portal and `/admin` still works on any
host; the banner asks `current_database()`; no fabricated gateway anywhere,
including in `package.json`.

Two suites had expectations updated because **the contract genuinely changed** —
`PUBLIC_ORIGIN` and `ADMIN_ORIGIN` became required, so a "complete set of
secrets" now includes them. `tests/phase3.js` and `tests/phase4.js` were widened
accordingly, with the reason recorded in each file. Nothing was relaxed.

```
20 suites — 1,395 passed, 0 failed
npm run verify-audit-chain — PASS, 1,766 entries, exit 0
```

### Browser verification

Staff portal: sign-in, Super Admin dashboard, Operations panel — which reports
`No SMTP server configured · DEVELOPMENT — NOT SENDING`, the honest answer for
this environment. Alumni site: dashboard and the world map, which renders one
cluster and states plainly that 18 profiles carry a location recorded
automatically before it could be confirmed and are not shown. **Zero console
errors on every screen.**

### Documents

- **`PRODUCTION_DEPLOYMENT_RUNBOOK.md`** — the first-deployment sequence, step 0
  (choose the hostnames) through step 15 (record what was deployed), plus
  rollback. Step 3 is a hard stop: *do not continue past this line with a
  placeholder*. Rollback separates "the code is bad" from "the data is bad",
  because using the wrong one is how a bad deploy becomes lost data, and states
  that `ENCRYPTION_KEY` cannot be rolled back at all.
- **`PRODUCTION_HANDOVER_CHECKLIST.md`** — every item labelled READY IN CODE /
  REQUIRES DIC / REQUIRES HOSTING PROVIDER / REQUIRES THIRD-PARTY / FUTURE
  FEATURE, in four parts (college, technical, security, operations), ending in a
  GREEN/YELLOW/RED readiness matrix.
- `README.md` — the production-requirements table listed two variables and
  there are now six. Corrected.
- `.env.example` — origins and `MAIL_TRANSPORT` rewritten as required, with
  what went wrong when they were not; `DIC_SKIP_DOTENV` documented, with a
  warning never to set it on a real deployment.
- `PRODUCTION_DEPENDENCIES.md` — Part 4 added.

### Readiness — stated plainly

**This platform is not ready to go live today, and not because of the code.**

Nine items block go-live. Eight are inputs nobody in this repository can supply:
a domain, a server, TLS, three generated secrets and their escrow, an SMTP
account or a documented decision to do without one, a cron entry, an off-site
backup destination, and a named person who owns the super-admin account.

The ninth is the one genuine RED: **no independent security review has ever been
performed.** Every security property this project claims was verified by the
party that implemented it. That is worth something, and it is not the same
thing. Someone else should look before this is announced to alumni.

The engineering is finished to the standard this project has been held to. Six
production defects were found in this phase alone — all by executing the
production path rather than reading it — which is the argument for the review,
not against it.

### Intentional non-changes

- No feature added, no UI redesigned, no payment gateway, no map provider.
- Location and RBAC architecture untouched.
- `campaigns.gateways` left in the schema; no column dropped.
- No historical audit entry rewritten. No production data modified.
- No credentials, domains or deployments invented — every hostname in the new
  documents is a placeholder and says so.
- The deferred P2/P3 findings from Phase 5C were not opportunistically fixed.

### Next phase

**Phase 5F — independent security review preparation — followed this entry.**
It found and closed two P0 stored-XSS vulnerabilities that this phase, and the
three audits before it, had passed over.

---

## Phase 5F — Independent security review preparation and final hardening

**Status:** COMPLETE
**Date:** 2026-09-02
**Commits:** `6118638` (the phase) and `95fdbbf` (records the hash, since a commit cannot contain its own), then `1b77c86` for the corrections below
**Parent:** `146c3aa`

Phase 5E ended with one genuine RED: every security property this project claims
had been verified by the party that implemented it. This phase prepared the
system for somebody else to look — and, in doing so, found that the party who
implemented it had missed two P0s.

### The headline

**Two stored cross-site-scripting vulnerabilities, both confirmed executing in a
live `super_admin` session, both invisible to four previous audits.**

**P0-1 — `escapeHtml` is the wrong escaping inside an inline event handler.**
24 call sites across 11 files interpolated user text into a quoted JavaScript
string inside an `onclick` attribute. `escapeHtml` turns `'` into `&#39;`, and
an HTML attribute is decoded by the parser BEFORE the handler body is compiled
as JavaScript — so the entity became a live apostrophe and closed the string it
was supposed to be inside.

Eight of those sites also carried `.replace(/'/g, '&#39;')`, which did nothing
whatsoever: `escapeHtml` had already replaced every apostrophe. The code read as
though it had been thought about twice.

Proved end to end. An ordinary alumnus posted a job titled
`x');window.__P5F_ONCLICK=true;//` through the public API. The staff portal
rendered:

```
onclick="showJobApplicants(5, 'x');window.__P5F_ONCLICK=true;//')"
```

Two statements. Clicking Applicants ran the second one in the reviewing
administrator's session — the session that provisions administrators, reads the
audit log and reveals identity-vault records.

**P0-2 — the staff moderation queue rendered alumni-authored text raw.** Eight
fields (chapter name, type, description; story emoji, title, category, author
name, excerpt) went into `innerHTML` with no escaping at all, in the one function
in `js/admin.js` that never called `escapeHtml` while ~70 sites around it did.

**Submitting to the queue was the delivery mechanism.** No click, no
interaction: a moderator opening the queue to review the submission executed it.
Verified live in a `super_admin` session — four injected `<img onerror>`
elements, handler fired. After the fix, the same payloads: zero injected
elements, zero live handlers, the text rendered as text.

Phase 5D escaped the bulk-import preview because an uploaded file is obviously
untrusted. This table is fed by the API instead, and the trust level is
identical. That is the lesson worth carrying: the sink was missed because of
where the data *arrived*, not what it *was*.

### Method

Ten security dimensions audited in parallel against the real code, then every
finding that claimed real risk handed to an independent reviewer instructed to
refute it. **30 candidate findings, 18 refuted.** The refutations mattered as
much as the confirmations: the unkeyed audit chain, `dept_admin`'s
institution-wide scope, the register-returns-409 oracle and the missing SRI were
all correctly identified as documented, accepted positions rather than new
holes, and are recorded as such rather than padding a findings count.

### Fixed — twelve findings and one bug

| | Finding | Fix |
|---|---|---|
| P0-1 | `escapeHtml` in JS-string-in-attribute position, 24 sites | new `jsArg()` = `escapeHtml(JSON.stringify(String(v)))`, which supplies its own quotes |
| P0-2 | Moderation queue renders alumni text raw, 8 sinks | `escapeHtml` on all eight; emoji through `emojiIcon()` |
| P1-3 | Profile modal renders another member's job title and company raw | `escapeHtml` |
| P1-4 | Bulk import's shared batch password worked as a full credential | `must_change_password` made load-bearing server-side |
| P2-5 | Account lock checked after the password comparison | moved before it; counter restarts when a lock lapses |
| P3-6 | Profile hub: ~34 fields raw, three `href` accepting `javascript:` | `escapeHtml` throughout; new `safeUrl()` restricts the scheme |
| P3-7 | 41 sites returned raw PostgreSQL error text (CWE-209) | one `serverError()`; `app.param` numeric guards; `?batch` validated |
| P3-8 | Mentor suggestions leaked a private city | gated on `privacy.DIRECTORY_VISIBLE_SQL`, match flag included |
| P3-9 | Task assignees' mobile and WhatsApp numbers sent to non-staff | `TASK_SELECT` → `taskSelect(staff)`, so no call site can forget |
| P3-10 | `trust proxy` hardcoded to 1 | `TRUST_PROXY`, defaulting to off |
| P3-11 | Authentication events were not audited at all | `Signed In` / `Sign-In Failed` in the hash chain, by user id |
| P3-12 | `X-Powered-By: Express` | `app.disable('x-powered-by')` |
| BUG-13 | `renderNewsFeed()` called unconditionally from the staff portal | guarded |
| P3-14 | The alumni portal sent **no** `Content-Security-Policy` header at all — the portal every stored-XSS finding of this phase was reachable from | `frame-ancestors 'self'` alongside its existing `X-Frame-Options`. **Partial by design: see below.** |

**On the CSP — what was and was not done.** Both portals now send a
Content-Security-Policy: `frame-ancestors 'none'` on the staff portal,
`frame-ancestors 'self'` on the alumni site. That closes "no policy at all",
and it is **clickjacking protection, not an XSS mitigation**. There is no
`script-src` directive, and there cannot be one while the application renders
through 217 `innerHTML` assignments and 343 inline `on*=` handler attributes
(196 in `js/*.js`, 147 in the two HTML shells). Replacing those with delegated
listeners is the prerequisite, it is a real refactor, and it is deferred in
`FINAL_SECURITY_REVIEW_FOLLOWUPS.md` rather than half-done here.

The header is now asserted **on the wire** by `tests/security_smoke.js` §N,
not in the source — because the source was already correct while a stale
process was still serving responses without it, and nothing in the suite
noticed. A test that reads the file it is meant to be testing the behaviour of
is the same failure as the `crossref.js` stripper described below.

Two more were found while writing the review documents, both verified by
execution rather than by reading, and both fixed:

**Public sign-up returned 500 without an HSC year.** `alumni_profiles.batch` and
`.passing_year` are `NOT NULL`; the handler passed `parseInt(undefined) || null`
into them, and the form did not mark the field required. Absent, blank and
non-numeric all produced a constraint violation surfacing as a server error. Now
a 400 with a usable message — and the year is validated, never defaulted,
because a guessed batch is the same class of fabrication as the hardcoded
`'Dhaka'` that Phase 5B removed.

**One bad row failed an entire bulk import.** The same `NOT NULL` violation
aborted the transaction, so one line without a year lost a 200-row roster with a
500 and no indication of which line. Now an ordinary per-row rejection: verified
with a three-row roster — 2 created, 1 rejected by row number with the reason,
HTTP 200.

### The measurement that changed a fix

`app.set('trust proxy', 1)` was hardcoded. A numeric trust-proxy value is a hop
*count*, not an address allow-list, so with nothing in front the peer is trusted
and `X-Forwarded-For` is the caller's to choose. Measured before the fix:

```
same forged IP, 8 attempts     401 401 401 401 401 429 429 429   (throttle works)
rotating forged IP, 12 attempts 401 401 401 401 401 401 401 401 401 401 401 401
after 20 more, real client      401                              (never counted)
```

**32 wrong passwords against one account, zero refusals** — both throttles
evaded, and the forged address is what the audit trail recorded. After the fix,
every rotated attempt returns 429.

It is documented in both directions, because it is wrong both ways: set with no
proxy, the header is forgeable; left unset behind one, every request looks like
the proxy and a handful of failed sign-ins locks out everybody.

### What the enrolment gate actually changed

Making `must_change_password` load-bearing was the fix with the widest blast
radius, and it behaved exactly as designed the moment it shipped: **43 test
failures**, because twelve seeded accounts had been provisioned with generated
passwords and had never completed enrolment. They were correctly locked out.

The temptation was to narrow the gate. Instead each account completed enrolment
through the real endpoint — signing in and setting a password, as a human would
— which is what the credentials file had claimed was true all along. No test
expectation was weakened; the data was made true. Bulk-imported accounts keep
the flag, which is the population the fix protects.

### A test that had gone quiet

`tests/crossref.js` reported both portals self-contained while `js/admin.js`
called `renderNewsFeed()`, a function `admin.html` does not load — so approving
a story in the staff portal threw `ReferenceError`. It had been invisible
because the checker stripped quoted strings across the *whole file* at once: one
unbalanced apostrophe shifted every pair after it, and a single "string" spanned
hundreds of lines, blanking the call.

Editing an unrelated line elsewhere in `admin.js` shifted the pairing and
revealed it. The stripper now works one line at a time. **A test that goes
quiet when the source moves is worse than no test**, and it is worth asking
where else that shape exists.

### Deliverables

- **`SECURITY_REVIEW_PACKAGE.md`** — architecture, trust boundaries, sensitive
  data, controls, secrets. Says plainly what each control does *not* cover.
- **`SECURITY_THREAT_MODEL.md`** — fourteen actors, each with assets, attack
  surface, abuse, mitigation, residual risk and recommended control.
- **`SECURITY_AUTHORIZATION_MATRIX.md`** — all 138 routes, generated from source
  and then **verified by calling every one as all five roles and anonymously**:
  774 authorisation checks, **0 unexplained mismatches**, with the one
  environment-tightened exception named rather than tolerated.
- **`INDEPENDENT_SECURITY_REVIEW_CHECKLIST.md`** — scope, environment, test
  accounts (placeholders only, never real credentials), 40 attack scenarios with
  expected results, evidence requirements, severity definitions drawn from what
  this phase actually found, and retest procedure.
- **`FINAL_SECURITY_REVIEW_FOLLOWUPS.md`** — what was deliberately not fixed,
  with rationale, including four entries struck through because they were closed
  after the document was drafted.
- **`tests/security_smoke.js`** — 109 checks across 14 sections, self-contained:
  it registers its own accounts, promotes throwaway ones, deletes everything, and
  hands the login throttle back so it is safe in any position in the batch.
  Section A parses the route table **from source**, so a new unguarded route
  fails it without anyone remembering to add a case.

No real password and no cryptographic secret appears in any of the 17 markdown
files in this repository — checked mechanically against `.env` and the
credentials file, not by eye.

### Verification

```
21 suites                        1,525 passed, 0 failed
tests/security_smoke.js            114 passed, 0 failed
authorization matrix               774 checks, 0 mismatches
npm run verify-audit-chain       PASS, exit 0
browser                150 page-renders (10 alumni + 15 staff pages
                       × 360/390/430/768/1024/1280), zero console
                       errors, zero horizontal overflow
```

The audit-chain entry count is deliberately not quoted as a fixed number: the
chain grows every time the suites run, so a figure recorded here would be stale
by the next run and would read as a discrepancy rather than as growth. What
matters is that it verifies and exits 0. It read 3,565 entries at the close of
this phase.

No test expectation was weakened to pass. Two suites (`phase3`, `phase4`) had
already been widened in Phase 5E for a contract change; nothing was relaxed here.

Sign-out was verified as genuinely ending the session rather than clearing local
storage: the old token returns 401 from the server afterwards.

### Data integrity

Users **18**, profiles **14**, reference places **99**, and the privacy and
location fingerprints **byte-identical** to the pre-phase snapshot. The only
deltas are append-only audit growth — which now includes the sign-in events this
phase added — and `QA2 <hex>` event fixtures the qa2 suite has always left
behind. No business record was created, altered or destroyed.

Every XSS probe payload was seeded through the real API and removed afterwards.

### Intentional non-changes

- No feature added, no UI redesigned, no payment gateway, no map provider.
- No schema change, no migration, no column dropped.
- No historical audit entry rewritten.
- The 18 refuted findings were not written up as defects to inflate the count.
- The deferred items in `FINAL_SECURITY_REVIEW_FOLLOWUPS.md` were left alone —
  including the async-scrypt conversion, vendoring the three CDN scripts, and the
  delegated-listener refactor a `script-src` policy depends on.

### Readiness — three different questions

**ENGINEERING VERIFIED — yes.** 1,520 automated checks, 774 authorisation
probes, 150 browser renders, a verified audit chain, and two P0s found and
closed by this phase's own adversarial pass.

**INDEPENDENTLY REVIEWED — no. Still no.** That was the point of the phase and
it remains open. What changed is that a reviewer can now start on day one
instead of spending a week orienting: they get an architecture document, a
threat model, a verified authorisation matrix, 40 scenarios with expected
results, and an honest list of what the team already believes is wrong.

**PRODUCTION OPERATIONALLY READY — no**, and not for engineering reasons. The
eight external inputs from Phase 5E are unchanged: a domain, a server, TLS,
three generated secrets and their escrow, an SMTP account or a documented
decision to do without, a cron entry, an off-site backup destination, and a
named person who owns the super-admin account.

**The strongest argument for the external review is this phase's own result.**
Four prior audits had passed over both P0s. One found them in a day. Whatever
this phase missed, somebody else will have to find.

### Next phase

None defined. The next actions are DIC's: commission the review, and supply the
eight inputs.

---

## Phase 6 — Operations and production readiness

**Status:** COMPLETE
**Date:** 2026-09-03
**Commits:** `0f0a2f3` (the phase) and the follow-up that records this hash, since a commit cannot contain its own
**Parent:** `797f254`

### Scope, and why

Phase 5F left the software hardened and the *operation* untested. This phase was
meant to provision and prove the operational layer: scheduler, purge, backups,
off-site copy, restore, SMTP, monitoring, secrets, runbook.

It found something larger first.

### The platform had never been installed

Every previous phase worked against a development database created months ago
and migrated forward. Nobody had run `PRODUCTION_DEPLOYMENT_RUNBOOK.md` step 4
from an empty database. Phase 6 did, and it did not work — three independent
faults, each fatal on its own:

**1. The install aborted at `migrate_v5.js`.** It read `MIN(id) FROM events` and
threw *"No events exist — cannot anchor orphaned child rows"* unconditionally
when the table was empty — which is precisely every fresh database, and
precisely the case with no orphans to anchor. The documented sequence stopped
with **39 of 47 tables**. It now counts orphans first and only demands an anchor
when something needs anchoring.

**2. A "clean" install was not clean.** `migrate_v2.js` seeded invented content
into any database whose planner tables were empty — so, a fresh production
database. A live poll appeared on the public news feed, and the vendor list held
four fabricated firms with made-up Bangladeshi names and phone numbers
(*"Dhaka Grand Caterers / Mizanur Rahman / +880 1711-220011"*). The deployment
runbook tells the operator not to run `seed.sql` precisely to avoid demo data;
not running it did not help. Now behind `DIC_SEED_DEMO=1`, off by default.

Those two were the same bug twice over: the fabricated rows are written with
`event_id=1`, no event 1 exists on a fresh database, so they *became* the
orphans `migrate_v5` then aborted on.

**3. There was no way to create the first administrator.** A fresh install has
zero users. `rotate_credentials.js` only ever rotated rows that already existed
— it reported *"accounts: 0, nothing to rotate"*. Every provisioning route is
`requireRole(SUPER_ONLY)`. **The platform could be installed and then never
signed into by anybody.** New:
`node rotate_credentials.js --create-super-admin <email> [--name "..."]`, which
refuses when a super admin already exists, and creates the account with
`must_change_password` so the enrolment gate limits its first session to
changing that password.

`tests/install_drill.js` pins all three and goes further: it installs from
nothing, starts the application against the result, signs in as the new
administrator, confirms the enrolment gate blocks everything else, changes the
password and confirms full authority. **30 checks, passing.**

### Scheduler

Three jobs — `event-maintenance`, `deletion-purge`, `mentorship-expiry` — with
one registry in `jobs.js`. Four faults fixed:

**Two duplicate triggers, both firing on a page load.** `GET /api/mentorships`
carried a verbatim second copy of the expiry `UPDATE` and ran it for any member
who opened their list. The Events page ran the reminder sweep once per session
on render, under a comment reading *"There is no scheduler in this deployment"*
— true when written, untrue since `jobs.js` existed. Scheduled work that only
happens when somebody looks is not scheduled: statuses rolled forward on the
days staff opened the page and not on the days they did not, and none of it
appeared in `ops_runs`, so the run log could not distinguish a working timer
from an attentive colleague. Both removed. The mentorship list now *reports*
expiry as a projection and writes nothing; verified live — an expired request
reads as expired, a live one still reads pending, the database is untouched by
the read, and the nightly job is what writes it.

**A timezone bug that made the roll-forward a day late, every time.** Nothing
pinned the session timezone, so `CURRENT_DATE` was the database host's date —
UTC on a managed provider. Bangladesh is UTC+6, and `vercel.json` fires the jobs
at 20:10 UTC = **02:10 in Dhaka**, squarely inside the window where UTC is still
yesterday. `db.js` now pins `DB_TIMEZONE`, default `Asia/Dhaka`.

**Runs that died stayed "running" for ever.** One row had been stuck since
06:46 that morning with a NULL `finished_at`, indistinguishable from a run in
flight, and nothing reaped it. `reapStaleRuns()` now marks anything running
longer than `JOB_STALE_MINUTES` as failed, on the next run of the same job. The
Operations panel immediately began reporting *"1 job run(s) failed in the last 7
days"* — a failure that had been invisible.

**One entry point.** New `scheduler.js`: `node scheduler.js` runs every job,
`--list` shows the last run of each, `--status` exits non-zero when something
needs attention. It talks to the database directly, so jobs still run when the
web process is down — which is when the purge matters most. `ops/cron-dic.sh`
now calls it instead of the HTTP endpoint, and does backup → off-site → jobs →
Sunday restore drill in one entry. Vercel keeps using `vercel.json`'s crons.
Exactly one is enabled; `ops_runs.source` shows which fired, and
`scheduler.js --list` warns when it sees more than one.

### Deletion purge

The executor already existed and is better than expected: row-locked with
`FOR UPDATE`, predicate re-checked inside the transaction, `super_admin`
refused, donations anonymised before the delete, audited outside the transaction
so the entry survives the account. What was missing was proof.

`tests/ops_drill.js` builds a disposable database and drills the three outcomes
Phase 6 requires — **an expired request purges, an unexpired one does not, a
cancelled one does not** — plus a `super_admin` refused, cascade behaviour
observed, and a second run purging nothing more. **35 checks, passing.**

The classification, read from the schema's 38 foreign keys rather than from
intent:

| | |
|---|---|
| **PURGED** (`CASCADE`) | profile, chapter memberships, connections, consent logs, event people, registrations, task assignments, identity-vault rows, job applications and referrals, job posts, mentorships, notifications, poll votes, stories |
| **RETAINED, de-linked** (`SET NULL`) | audit entries, broadcasts, chapters created, the deletion request itself, donations, events created/updated/approved, tasks and notes, vault access logs |
| **ANONYMISED** | `donations.donor_name` — rewritten to *"Erased at the donor's request"* before the delete |

Two of those deserve a DIC policy decision rather than an engineering one:
`consent_logs` cascades, so proof that a person consented is destroyed with
them; and `stories` cascades, so published content disappears. Both are recorded
rather than changed.

### Backups and the off-site copy

**A real bug first.** `backup.js` computed `BACKUP_DIR` *before* `require('./db')`
loaded `.env`. Setting `BACKUP_DIR` in `.env` — exactly as `.env.example`
documents — had no effect whatsoever, and dumps kept landing in the application
directory. `restore.js` had the ordering right; this file did not.

Production now **refuses to boot** without `BACKUP_DIR`, and refuses one that
points inside the application directory. A full dump of every alumnus's personal
data belongs somewhere a redeploy, a `git clean` or a future change to the
static allow-list cannot reach.

New `offsite.js` ships the newest dump elsewhere. Provider-agnostic by design:
it runs `OFFSITE_CMD` with `{file}` and `{name}` substituted, so there is no
vendor SDK, no bucket name and no credential in the repository — worked
examples for S3-compatible storage, ssh and rclone are in `.env.example`.
Optional `OFFSITE_ENCRYPT_CMD` encrypts before sending. It writes a receipt the
monitor reads.

Proved end to end against a genuinely separate destination: **byte-identical
arrival (md5 matched), and a failing command recorded as failed rather than
swallowed.**

### Restore

`tests/ops_drill.js` backs up a disposable database, restores it into a second
one, and verifies what a lossy restore would ruin: table count, users, profiles,
deletion requests, events, registrations, ticket types, donations, audit
entries, and — the one that matters most — that the identity vault's
ciphertext, IV and auth tag are **byte-identical**, because a vault record that
loses a byte is permanently unreadable even with the right key. The restored
copy's audit chain verifies. The live database is confirmed untouched.

### SMTP

The mailer was already complete: real nodemailer, implicit TLS on 465 and
STARTTLS otherwise, auth, timeouts, masked logging, a plain-text template. What
was missing was proof.

`tests/mail_drill.js` stands up a real SMTP server — a few dozen lines of `net`
rather than a sixth dependency — points the application at it, and reads the
message that arrives. **26 checks:** the message is delivered, addressed
correctly, from the configured sender, with a subject identifying the platform
and a link on `PUBLIC_ORIGIN`; the token is stored hashed, expires in 30
minutes, resets the password, and **cannot be used twice**; it never appears in
a log; and the endpoint answers identically for a known and an unknown address.

One thing the drill taught, which is worth recording because it looked like a
product bug for twenty minutes: the template contains an em-dash, so nodemailer
encodes as quoted-printable, in which `?reset=` arrives as `?reset=3D` and the
long URL is soft-wrapped with a trailing `=`. A mail client undoes both. A test
reading the raw SMTP stream has to undo them itself, or it extracts a token
beginning `3D` and concludes the platform is broken when it is not.

### Monitoring

`/api/health` stays the thin unauthenticated liveness probe: **200** healthy,
**503** degraded, no answer at all means the application is down — which by
definition only something outside it can observe.

But `/api/health` returns 200 while the purge has been failing for a fortnight
and the backups stopped a week ago. New `GET /api/internal/monitor` answers
that. It is guarded by the **scheduler credential**, not an admin session, so an
uptime service can carry it in a header and the browser never sees it. It
reports the database, every job with age and outcome, the backup receipt, the
off-site receipt, overdue deletions and the mail mode, and returns 200 or 503 so
a monitor needs no JSON parsing.

It separates **problems** (503, wake someone) from **advisories** (200, worth
knowing). That distinction earns its place immediately: this deployment's
advisories are *"no off-site backup destination is configured — this deployment
keeps one copy of its data"* and *"MAIL_TRANSPORT=console — reset links are
written to the log, not sent"*. Both true, neither worth a 3am call.

Verified returning 503 for each failure mode independently: database
unreachable, jobs stale, no backup recorded.

### Secrets and logging

Production now requires seven variables: `SESSION_SECRET`, `ENCRYPTION_KEY`,
`CRON_SECRET`, `MAIL_TRANSPORT`, `PUBLIC_ORIGIN`, `ADMIN_ORIGIN` and
`BACKUP_DIR` — the last new in this phase — plus `SMTP_HOST` and `SMTP_FROM`
conditionally, only when `MAIL_TRANSPORT=smtp`. The rule the brief set is kept:
a value is required only when the feature that needs it is enabled, and
development is unaffected.

New `KEY_MANAGEMENT.md` documents all four secrets, and `ENCRYPTION_KEY` in the
detail it deserves: AES-256-GCM, a fresh 12-byte IV per record, the auth tag
verified on decryption — and **no key id or key version column on
`identity_vault`**, so there is no zero-downtime rotation path. The point most
often misunderstood is stated plainly: **a backup does not save you**, because
the backup holds the same ciphertext. Also: the two-person escrow procedure,
per-secret rotation with the consequence stated first, what to do when each is
exposed, and an annual recovery drill that verifies the escrow matches
production by comparing fingerprints rather than values.

Logging was already disciplined and is now asserted: no `console` line prints
any secret, the request logger excludes the `Authorization` header, bodies and
query strings, and a reset link never reaches a log. Checked mechanically
against the real values, not by eye.

### Runbook

`OPERATIONS_RUNBOOK.md` rewritten to the eighteen sections the brief specifies,
plus escalation contacts and a first-administrator bootstrap. The Phase 6 audit
found **70 defects** in the previous version; the ones worth naming:

- section M claimed migrations *"do not drop or rewrite"* and each *"runs in a
  single transaction"*. Both false — `schema_v12` rewrites `audit_logs` and
  resets the audit-chain head, and `v2`–`v4` have no transaction and **ignore
  `--dry-run` entirely**;
- section N listed migrations only to v10, so a new deployment following it
  would stop three versions short and never install the location system;
- section I offered `rotate_credentials.js --check` to *"seal the printed
  password"* — it prints none — and `reset_link.js` to *create* an account,
  which it cannot;
- `backup.js` and `ops/cron-dic.sh` both pointed operators at *"section 5"* of a
  document lettered A–O, at the exact moment the pointer fires;
- the first table an operator reads during an incident said *"Who to call — see
  section N"*, which is Migration;
- stop/restart, account lockout, administrator suspension, DNS and monitoring
  were **absent entirely**.

Every claim in the new document was checked against the code before it was
written: the 47-table count, the lockout thresholds and the 15-minute lapse, the
AES parameters, the health status codes, the `token_version` bump on suspension,
`reset_link.js`'s two refusals, and the `LOG_REQUESTS` gate on 2xx logging.

### CI

`.github/workflows/ci.yml` — GitHub Actions, because the repository is already
on GitHub and nothing here needs a paid platform or a stored secret. It installs
the schema **the way production installs it**, from `schema.sql` plus every
migration, asserts 47 tables, then runs the suites, the audit chain, all three
drills, and greps the server log for the throwaway secrets it generated. That
first step is the one that would have caught the `migrate_v5` abort.

### Files changed

25 files, +3,092 / −396. New: `scheduler.js`, `offsite.js`, `KEY_MANAGEMENT.md`,
`.github/workflows/ci.yml`, and four test files — `tests/install_drill.js`,
`tests/ops_drill.js`, `tests/mail_drill.js`, `tests/phase6_operations.js`.
Rewritten: `OPERATIONS_RUNBOOK.md`. Modified: `server.js`, `db.js`, `jobs.js`,
`backup.js`, `routes_v2.js`, `js/events.js`, `migrate_v2.js`, `migrate_v5.js`,
`rotate_credentials.js`, `ops/cron-dic.sh`, `.env.example`, `package.json`, and
four test files.

**Database changes: none.** No migration was added, no column altered, no data
rewritten. The timezone is a session setting, not a schema change.

**API changes: one addition.** `GET /api/internal/monitor`, guarded by
`requireScheduler`. Nothing was removed or altered.

### Tests

```
22 suites                     1,609 passed, 0 failed
  of which phase6_operations     68
  and phase4 rose 147 -> 161 (the runbook contract was re-specified, and the
  new assertion set is longer than the one it replaced)
drills                           91 passed, 0 failed
  install_drill 30 · ops_drill 35 · mail_drill 26
npm run verify-audit-chain    PASS, 4,235 entries, exit 0
```

No test expectation was weakened. `phase3`, `phase4` and `phase5e_production`
had their production boot environments widened because `BACKUP_DIR` genuinely
became required; `phase4`'s runbook assertions were re-specified because the
brief re-specified the runbook, and grew from 15 sections to 20 plus nine new
content checks.

### Browser verification

Both portals at 1280 — 10 alumni pages and 15 staff pages — **zero console
errors, zero horizontal overflow**. The two modules this phase touched were
checked specifically: the Events page no longer fires the sweep on render
(`evRunMaintenanceSweep` is gone and the network call never happens), and the
mentorship projection was exercised with a real expired request. The Operations
panel renders correctly and now surfaces the reaped run as a failure.

### Data integrity

Users **18**, profiles **14**, reference places **99**, and the privacy and
location fingerprints **byte-identical** to the Phase 5F baseline
(`c24e9a0a…`, `db6e2fc2…`). Every drill built and dropped its own disposable
database; none remained. Every probe account was removed. The live database was
never the target of a destructive operation.

### Incidents and regressions found during the phase

Three, all self-inflicted and all recorded because the reason matters:

- the first `ops_drill` run failed on `users.department NOT NULL` and a
  `requested_at` column that does not exist — my fixtures, not the product;
- the mail drill reported the reset link broken for twenty minutes before
  quoted-printable turned out to be the explanation;
- rewriting the runbook broke 17 `phase4` assertions pinned to the old section
  letters. The content was all still present; the contract had changed.

### Remaining limitations — stated plainly

**What is proven:** the code paths. Install from nothing, purge, backup,
off-site mechanism, restore, SMTP delivery, monitoring detection, boot
enforcement, scheduler authorisation and idempotency. All executed, all
repeatable, all in CI.

**What is not, and cannot be from here:**

| | |
|---|---|
| The hosting decision | Vercel and VPS are both shipped and DIC has chosen neither. Every runbook command is marked with which it applies to, and section F records that exactly one trigger is enabled — but the choice is not made. |
| A production scheduler that has actually fired | No deployment exists. The jobs have run thousands of times against the development database; no cron has ever triggered them on a server. |
| An off-site destination | The mechanism is proven against a separate local destination. `OFFSITE_CMD` is unset, so **this deployment keeps one copy of its data**, and the monitor says so. |
| Deliverability | A message leaves over SMTP and arrives. Whether a real provider accepts it — SPF, DKIM, DMARC, reputation — needs DIC's domain and mail account. |
| An external monitor | The endpoint works and returns 503 for every failure mode tested. Nothing is watching it. |
| Backups encrypted at rest | `OFFSITE_ENCRYPT_CMD` exists and is unset. The local dumps are unencrypted, mode 0600. |
| Vercel-specific limits | A serverless filesystem is ephemeral and has no `pg_dump`, so `backup.js` and `restore.js` cannot run there. A Vercel deployment must use the database provider's own backups. Recorded in the runbook; not solved, because it cannot be solved in application code. |

Deferred deliberately, not forgotten: `consent_logs` and `stories` cascading on
account deletion (a DIC policy decision), and `restore.js` ignoring
`DATABASE_URL` so it does not work against a connection-string deployment.

---

## CURRENT STATE SNAPSHOT — end of Phase 6

| Area | State |
|---|---|
| Core alumni system, events, tickets, admin portal | Working, 22 suites |
| Authentication, authorisation, session revocation | Working, adversarially reviewed in 5F |
| Privacy model | Working, server-enforced, single source of truth |
| Audit trail | Hash-chained, verifiable, **unkeyed** — not tamper-proof, and documented as such |
| Data honesty | No fabricated values anywhere; the last two were removed this phase |
| Fresh install | **Works** — 47 tables from nothing, first administrator creatable, drilled |
| Scheduler | One registry, one entry point, idempotent, timezone-correct, observable |
| Deletion purge | Correct and drilled against the three outcomes |
| Backup / restore | Working and drilled; **one copy, on one machine** |
| Off-site copy | Mechanism proven; **no destination configured** |
| SMTP | Delivery proven over real SMTP; **no provider account** |
| Monitoring | Endpoint working and proven to detect failures; **nothing watching it** |
| Secrets | Seven enforced at boot; escrow procedure written, **not performed** |
| Runbook | Rewritten, 18+ sections, every claim checked |
| CI | Configured; installs from scratch on every push |

## PRODUCTION READINESS SNAPSHOT — end of Phase 6

**GREEN** — done and verified. **YELLOW** — the code is done, an input is
missing. **RED** — blocks go-live and nothing has been done about it.

| Area | Status | Owner |
|---|---|---|
| Application code | GREEN | — |
| Fresh install and migrations | GREEN | — |
| Scheduler and jobs | GREEN in code | — |
| Deletion purge | GREEN | — |
| Backup and restore tooling | GREEN | — |
| Monitoring endpoint | GREEN | — |
| Secret enforcement | GREEN | — |
| Documentation | GREEN | — |
| Tests and CI | GREEN | — |
| **Hosting decision** | YELLOW | **DIC** |
| Domain, DNS, TLS | YELLOW | DIC + hosting |
| Production secrets and escrow | YELLOW | DIC + hosting |
| Off-site backup destination | YELLOW | hosting |
| SMTP account | YELLOW | third-party + DIC |
| Production cron actually firing | YELLOW | hosting |
| External uptime monitor | YELLOW | hosting |
| Named super-admin owner | YELLOW | DIC |
| **Independent security review** | RED | **DIC** |

The engineering is finished. **Nine items block go-live and eight of them are
inputs nobody in this repository can supply.** The ninth is unchanged from
Phase 5F: no independent security review has been performed.

### Next phase

None defined. The next actions are DIC's: choose the host, supply the eight
inputs, and commission the review. The one piece of engineering worth queueing
is a Vercel-compatible backup path, if Vercel is the answer to the first
question.

---

## Phase 6.5 — Production provisioning and deployment readiness

**Status:** **BLOCKED** — on external inputs, not on engineering
**Date:** 2026-09-03
**Commits:** `0ba95f2` (the phase) and the follow-up that records this hash
**Parent:** `52b4360`

Not COMPLETE, and deliberately so. The brief's own rule is *"do not mark
COMPLETE unless the actual production provisioning requirements have been
verified"*. Six of the twelve sections asked for real infrastructure — an
object-storage account, an SMTP provider, a monitoring service, a domain, a
server. None exists. What could be built and proved without them was; what
could not is named, with an owner.

### The deployment decision: **a VPS, not Vercel**

The recommendation follows from what the operations actually need, and the
evidence is in the code rather than in preference.

**Three of the platform's operational tools cannot run on Vercel at all.**
`backup.js`, `restore.js` and `offsite.js` need `pg_dump`, a writable directory
that persists, and minutes of runtime. A serverless function has none of those.
Six of the eleven npm scripts become unavailable.

**The monitoring built in Phase 6 would be permanently blind.**
`/api/internal/monitor` reads `last-backup.json` and `last-offsite.json` from
`BACKUP_DIR` (`server.js:2982`). On Vercel the backup happens at the database
provider and writes no receipt the application can read, so the monitor would
report *"no backup has ever been recorded"* every night for ever — and an
operator would learn to ignore it, which is worse than having no monitor.

**The login throttle is per-process.** `loginAttempts` is an in-memory `Map`
(`server.js:618`). Five failures per account and twenty per IP become 5×N and
20×N across N warm instances.

**Connection exhaustion.** `pg.Pool` is `max: 10` per process (`db.js:77`) and a
managed PostgreSQL typically allows 20–100 in total. Three or four instances
exhaust it.

**The bootstrap needs a shell.** `--create-super-admin` writes a credentials
file to disk.

**The scheduler loses its best property.** On a VPS, `scheduler.js` reaches the
database directly, so the nightly purge still runs when the web process is
unhealthy — which is precisely when nobody is watching.

Vercel would still give managed TLS, atomic deploys and a working cron. Those
are real, and they do not outweigh the six. `PRODUCTION_PROVISIONING.md`
section A carries the full argument, **and what it would cost to choose Vercel
anyway**, because that remains DIC's decision rather than this phase's.

### What was proved, by running it

**The encrypted off-site round trip, including the half nobody tests.**
`tests/offsite_drill.js` — **30 checks** — dumps the live database, gzips and
AES-256-encrypts it, ships it to a destination outside the application tree,
then **downloads it back to a third directory**, decrypts, decompresses,
restores into a disposable database and compares everything:

- 1.65 MB → 0.35 MB, **79% smaller**;
- the shipped object contains no readable SQL and begins `Salted__`;
- with the wrong passphrase, `openssl` exits 1 and what it does write is
  unreadable garbage that will not even decompress;
- with the right one, the recovered file is **byte-identical** to the original;
- the restored database matches on all 47 tables, every row count, the
  identity vault's ciphertext/IV/auth-tag fingerprint, and a verifying audit
  chain.

The transport is a local copy standing in for object storage. Substituting
`aws s3 cp` is one line of `OFFSITE_CMD`, and until DIC provides an account
that line cannot be exercised.

**Both production trigger paths, and no duplicate execution.** Three separate
triggers in succession — an operator's shell, the **Vercel path exactly as
Vercel sends it** (a GET with `Authorization: Bearer $CRON_SECRET`), and
`ops/cron-dic.sh` under a stripped `env -i` environment — gave:

```
reminder notifications  4 -> 4 -> 4 -> 4
completed purges        0 -> 0 -> 0 -> 0
runs left marked running                0
```

The cron-environment run earned its place immediately: under a minimal `PATH`
the backup failed with `pg_dump ENOENT`, and the script **correctly reported it
as an incident and exited 1**. That is the cron-specific failure class this test
exists for; a Linux server has `/usr/bin/pg_dump` on cron's default `PATH`, and
`PG_DUMP` exists for when it does not. With a complete environment the same
script finished cleanly, exit 0.

**A real alert path, fired for all three states.** `ops/healthcheck.sh` gained
`ALERT_CMD` — provider-agnostic like `OFFSITE_CMD`, substituting `{severity}`
and `{message}` — and now also consults `/api/internal/monitor` and the
off-site receipt rather than only `/api/health`. Measured:

| State | Exit | Alert |
|---|---|---|
| healthy | 0 | none, correctly silent |
| degraded (backup receipt says failed) | 2 | **delivered** — *"DEGRADED: last backup failed"* |
| unavailable (application not answering) | 1 | **delivered** — *"DOWN: application not responding"* |

And a broken alert path reports itself: with `ALERT_CMD='false'` the script logs
*"ALERT DELIVERY FAILED — the alert path itself is broken"*, because a monitor
whose alerting is silently broken is worse than none.

### Two corrections to the brief

The brief listed four scheduled jobs. There are three.

- **Task reminders are not a separate job** — they are half of
  `event-maintenance`, which rolls statuses forward *and* sends deadline
  reminders in one sweep.
- **There is no engagement-snapshot job**, and `server.js:2349` says why: the
  schema records no historical snapshot to compare a period against. Inventing
  one would have meant inventing the data it reports, which is the pattern this
  project has spent three phases removing.

Both are pinned in `tests/phase65_provisioning.js` so the discrepancy is not
rediscovered later as a missing feature.

### Deliverables

- **`PRODUCTION_PROVISIONING.md`** — the hosting recommendation with its
  evidence and its cost, the production architecture, exact server
  requirements, the prerequisites from DIC with owners, **the DNS records as
  records** (A, AAAA, CAA, and the SPF/DKIM/DMARC the mail provider will need),
  the environment-variable reference, a provisioning checklist, the database
  policy, and a production smoke test.
- **`tests/offsite_drill.js`** — the encrypted round trip, 30 checks.
- **`tests/phase65_provisioning.js`** — 64 checks pinning this phase's claims,
  including that no credential, bucket, token or domain was invented anywhere.
- `ops/healthcheck.sh` — rewritten with the alert path and the monitor check.
- `offsite.js` — encryption made tool-agnostic (`.enc`, not `.gpg`), and the
  plain dump made the only source so a stale encrypted copy can never be shipped.

### DNS records required

Nothing was configured — no DNS credentials or instructions exist, and the
brief is explicit about not guessing. The records are specified in
`PRODUCTION_PROVISIONING.md` section D: two `A` records (`alumni` and
`admin.alumni`), optional `AAAA`, an optional `CAA`, and the three `TXT`
records for SPF, DKIM and DMARC that the mail provider will supply.

### Tests

```
23 suites                     1,673 passed, 0 failed
  of which phase65_provisioning    64
4 drills                        121 passed, 0 failed
  install 30 · ops 35 · mail 26 · offsite 30
npm run verify-audit-chain    PASS, 4,454 entries, exit 0
```

**Production smoke test:** the alumni half 12/12, the staff half 18/18, both
portals rendering every page (10/10 and 15/15) with **zero console errors and
zero horizontal overflow**. The web root serves none of `.env`, `db.js`,
`server.js`, `package.json`, `schema.sql`, `admin-credentials.local.txt` or
`.git/config`.

Two smoke assertions failed on the first run and were my own errors, not the
platform's: `/api/profile/me` returns snake_case and I checked camelCase, and an
`openssl` wrong-passphrase check tested for an empty file when what matters is
that the bytes are unreadable. Both corrected to test the real property.

### Data integrity

Users **18**, profiles **14**, places **99**, privacy fingerprint
`c24e9a0a…` — byte-identical to the Phase 5F baseline. Every drill built and
dropped its own disposable database; none remained. No destructive operation
was performed against the live database.

### Remaining blockers

Thirteen, none of them engineering. `PRODUCTION_PROVISIONING.md` section C
carries them with owners; the ones that gate go-live:

| | Owner |
|---|---|
| **The hosting decision itself** — accept the VPS recommendation, or choose Vercel and accept its trade-offs | **DIC** |
| A Linux VM meeting the stated requirements | DIC / hosting |
| The domain, and one host or two | DIC |
| DNS records, and a TLS certificate covering both names | Whoever holds the zone |
| An SMTP account with a sender on a DIC-controlled domain | DIC + provider |
| An off-site storage destination | DIC / hosting |
| A backup encryption passphrase, generated and escrowed **separately from the backups** | DIC |
| An uptime monitoring service and an on-call address | DIC |
| The named owner of the super-admin account | DIC |
| Two named people who can reach the secret escrow | DIC |
| Retention policy sign-off | DIC's data-protection owner |
| **An independent security review** | **DIC** |

### What "BLOCKED" means here, precisely

Every mechanism this deployment depends on has been executed and proved: the
install, the purge, the backup, the **encrypted off-site round trip including
the restore**, the SMTP delivery, both scheduler trigger paths, the three
monitoring states and a real alert firing.

What has not happened is that any of it has run **on a server DIC owns, against
a domain DIC controls, with an account DIC pays for**. That is the entire
remaining gap, and no amount of further engineering closes it.

### Next phase

None. The next actions are DIC's: make the hosting decision, supply the
thirteen inputs, and commission the security review. Phase 7 has not been
started.

---

## PHASE 6.5 — HANDOVER ADDENDUM

**Status:** **BLOCKED**
**Date:** 2026-09-03
**Commit:** `d18fb27`
**Change:** documentation only. No application code was modified.

Adds `DIC_PRODUCTION_HANDOVER_CHECKLIST.md` — the single document DIC works
through before the platform serves real alumni. Twenty-six sections covering the
architecture, hosting, VPS, PostgreSQL, domain, DNS, TLS, the admin subdomain,
SMTP, backup destination and retention, monitoring, scheduler, environment
variables, secret management, encryption-key escrow, super-admin ownership,
emergency recovery ownership, DIC IT and developer responsibilities, and the
pre-deployment, smoke-test, rollback, security-review, UAT and final sign-off
checklists.

Every line is marked with an owner — **[ENG ✅]**, **[DIC]**, **[HOST]** or
**[3RD]** — so an unticked box says whose work it is rather than looking like an
oversight.

No domain name, credential, bucket, account or provider was invented. Every
value DIC must supply appears as a blank line to fill in.

---

# THE TWO COLUMNS

Everything about the platform's readiness reduces to this distinction. It is
restated here because it is the thing most easily lost.

## ENGINEERING READY — built, executed, measured

Not "written". Each line below was run, and the number beside it is what it
produced.

| | Evidence |
|---|---|
| Application, two portals, 138 API routes | 23 suites, **1,673 checks, 0 failures** |
| Authorisation on every route | **774 probes**, 0 unexplained mismatches |
| Fresh install from an empty database | `install_drill` — **30 checks**: 47 tables from nothing, first administrator created, signed in |
| Deletion purge | `ops_drill` — **35 checks**: expired purges, unexpired does not, cancelled does not, super_admin refused |
| Backup and restore | `ops_drill`: table counts, vault bytes, audit chain on the restored copy |
| **Encrypted off-site round trip** | `offsite_drill` — **30 checks**: 79% smaller, unreadable without the passphrase, **downloaded back**, byte-identical, restored and verified |
| Password-reset delivery | `mail_drill` — **26 checks**: delivered over real SMTP, link works once, token never logged |
| Scheduler, both trigger paths | Three triggers in succession: reminders 4→4→4→4, purges 0→0→0→0 |
| Monitoring and alerting | healthy exit 0 silent · degraded exit 2 **alert delivered** · unavailable exit 1 **alert delivered** · a broken alert path reports itself |
| Production fail-closed configuration | Refuses to boot without any of seven required variables |
| Hash-chained audit trail | `verify-audit-chain` PASS, **4,454 entries**, exit 0 |
| Continuous integration | Installs from `schema.sql` plus migrations on every push |
| Security review package | Architecture, threat model, authorisation matrix, 40 attack scenarios, known-gaps list |
| Documentation | Deployment runbook, operations runbook, key management, provisioning, and this handover checklist |

**Nothing in this column is waiting on anybody.**

## EXTERNAL / DIC PROVISIONING REQUIRED — no engineering closes these

| | Owner | Gates |
|---|---|---|
| The hosting decision — VPS or serverless | **DIC** | Everything |
| A Linux VM meeting the stated requirements | HOST | Everything |
| The domain, and one host or two | **DIC** | DNS, TLS, both origin variables |
| DNS records published | HOST | TLS, go-live |
| A TLS certificate covering both names | HOST | Go-live |
| An SMTP account and a sender on a DIC-controlled domain | 3RD + **DIC** | Self-service password reset |
| SPF, DKIM and DMARC records | 3RD | Whether reset mail is delivered or filed as spam |
| An off-site storage destination | 3RD | Disaster recovery |
| A backup encryption passphrase, escrowed separately from the backups | **DIC** | Encrypted off-site backups |
| Retention policy sign-off, including the historical-audit-PII disclosure | **DIC** | Backup configuration |
| An uptime monitoring service and an on-call address | 3RD + **DIC** | Knowing the site is down |
| Production secrets generated on the server | HOST | Go-live |
| Secret escrow, with **two named holders** | **DIC** | Disaster recovery |
| The named owner of the super-admin account | **DIC** | Go-live |
| Emergency-recovery contacts, all four named | **DIC** | Incident response |
| Scheduler installed and observed running | HOST | The deletion purge being kept |
| Production smoke test on the real deployment | HOST | Go-live |
| **An independent security review** | **DIC** | Public announcement |
| College UAT | **DIC** | Go-live |

**Nineteen items. Eighteen are provisioning. The nineteenth is the review.**

---

### Why the review is the one marked RED

Every security property this platform claims was verified by the party that
implemented it. Phase 5F's adversarial pass found **two P0 stored
cross-site-scripting vulnerabilities that four previous audits had passed
over**, both confirmed executing in a live super-admin session. That is the
argument for an outside reviewer, and it is made by this platform's own history
rather than by convention.

### What has not been claimed

No deployment has happened. No domain, credential, bucket, provider account or
DNS record has been created, assumed or invented. `DIC_PRODUCTION_HANDOVER_CHECKLIST.md`
carries a blank for every value DIC must supply, and the phrase "nothing in this
repository has ever run on a DIC server" appears at the top of it.

### Next phase

None. Phase 7 has not been started. The next actions are DIC's: decide the
hosting model, work through the checklist, and commission the review.

---

## Phase 7A — Final UI/UX, accessibility and mobile polish

**Status:** **COMPLETE**
**Date:** 2026-09-06
**Commit:** `b6d1e8c`
**Parent:** `e2d22b3`

Scope was the interface only. No route, guard, role, permission, event, ticket,
QR signature, task rule or audit behaviour was touched, and the API surface is
byte-identical. What changed is what a person sees.

### Tests

```
24 suites                     1,723 passed, 0 failed
  of which phase7a_ui               50   (new)
  the 23 pre-existing suites     1,673   unchanged, still 0 failed
```

The Phase 6.5 baseline was re-run before any edit and again after every set of
them. It never moved off 1,673/0, so nothing here was bought by weakening an
existing expectation.

### What the audit actually found, after the false positives were removed

The first mechanical pass reported 74 emoji rendered as UI, 95 untyped buttons,
107 unlabelled inputs and a modal system with "no role=dialog, no Escape
handler, no focus restoration". **Most of that was wrong**, and reading the
source rather than trusting the greps is what made the difference:

- `showModal()` already set `role="dialog"`, `aria-modal` and
  `aria-labelledby`, already normalised every `.modal-close` to
  `type="button"` with an accessible name, already trapped Tab, already
  restored focus and already made the backdrop **opt-in**. The regexes missed
  it because those attributes are applied with `setAttribute`, not written
  as literal markup.
- Of **112** emoji occurrences, only **13 actually reached the DOM**; the
  other 99 are lookup keys. `emojiIcon()` maps a glyph to a Lucide icon and
  `showToast()` strips a leading mapped glyph, swapping in an icon element.
  The navigation tables — the "priority" finding — were already compliant.
  The 13 that did render were ten `→`, two `←` and one `🕒`, and all are
  gone; Event v5, which the brief names as the quality bar, uses no
  decorative arrow in any call to action.
- All 166 untyped buttons sit **outside any `<form>`**, where the type
  attribute changes nothing. Zero were inside one. That whole class of "fix"
  would have been a large diff and no change in behaviour.

The counts below are what survived that filtering.

### Fixed, with the measurement beside it

**Contrast (WCAG 2.1 AA).** One shape accounted for nearly all of it: a badge
drawn as *a 10–20% tint of a colour as the ground, and that same colour at full
strength as the text*. For `--teal`, `--amber`, `--green` and `--red` that
lands between **2.30:1 and 2.90:1**. The grounds were fine and were left alone;
four text-weight variants were added and swapped in wherever a token inked its
own tint. Static analysis of the stylesheet went **54 failing rules → 6**, and
all six remaining are exempt: five are light-on-dark components the analyser
composites over white (the navy topbar and its controls), and one is a disabled
button, which 1.4.3 does not apply to. In the browser, across every page of
both portals: **25 pages, 0 failures**.

**The digital ID card was unreadable.** It was the last component still carrying
a dark ground from before the light theme, and its text never declared a colour,
so once the body ink turned dark the card became dark-on-dark: the member's name
measured **1.01:1**, the institution 1.15:1, the role badge 1.64:1. Section 2 of
the brief is explicit that the system stays light with no dark card, so the
ground was lightened rather than the ink. Its rows now measure **5.11:1 to
16.93:1**. It keeps its shape, its brand sweep, the hologram and the teal
accents.

**Four avatars left dark ink on a dark gradient.** `.user-avatar-sm`,
`.sis-avatar` and `.id-avatar` painted a blue-to-teal gradient and declared no
colour at all, so the initials inherited the dark body text — **1.71:1**. Their
sibling `.topbar-avatar` had always set white explicitly; the others were simply
never given one. `.news-author-avatar` had the same omission. Now white ink on a
darkened gradient, **5.39:1 to 10.44:1**.

**Member avatars inked themselves invisible.** The directory, news and
mentorship avatars use a member's own colour for both a 25% tint ground and the
initials on top, which for the lighter hues is **1.58:1**. A `readableInk()`
helper now darkens the ink — and only the ink — until it clears 4.5:1 against
that exact ground, so every hue in the palette keeps its identity: measured
4.57 to 6.50 across the seven colours in use. A colour already dark enough is
returned unchanged.

**Every loading state in the application was invisible.** `.skeleton-line` was
a white-on-white gradient, another pre-light-theme leftover, so
`renderSkeletonCards()` drew empty boxes at all **29 call sites**. It now uses
the same light shimmer as Event v5's `.ev-chrome-skeleton`, so the two read as
one system. Confirmed by rendering it and looking.

**The super admin's audit trail rendered unstyled.** The markup emitted
`audit-entry / audit-icon / audit-action / audit-meta / audit-hash`; the
stylesheet defines none of those. The complete design lives under
`audit-log-item / -icon / -body / -action / -meta / -hash`, so every row was
`display:block` instead of a flex row and the icon's green background stretched
the full card width as a bar. The JS was moved back onto the class names that
carry the style. Two further defects in the same six lines: the hash chip read
`l.hash`, which the endpoint always returns as `null` — the real column is
`entry_hash`, so the chip was permanently empty — and its background was
`rgba(255,255,255,0.04)`, a white film on a white card.

**A dialog could destroy an unrecoverable credential.** `showTemporaryPassword`
was `dismissable: true` while its own copy reads *"Shown once… closing this
dialog loses it"*, so a stray backdrop click discarded a password nothing can
retrieve. It is no longer dismissable. The other five opt-in dialogs were
checked and are correct: a detail view, two confirmations where the backdrop
means cancel, a ticket and a public preview — none holds anything to lose.

**A control that did nothing.** Both portals carried a "Voice Input" button with
`cursor: pointer` and a tooltip and no handler anywhere in the codebase.
Implementing voice search would be a new feature, which section 25 rules out, so
the affordance was removed — the same treatment `simulateOffline()` received
for the same reason.

**97 fields had no accessible name.** The house pattern put the label beside the
field rather than around it, with no `for`, so screen readers announced them
blank and clicking a label did not focus its input. **83** now carry a native
`for=`; the **14** that have no visible label to associate — the search boxes
and filter selects — carry `aria-label`. Native association was preferred over
ARIA everywhere it was possible, per section 7.

**Two loading idioms became one.** `renderSkeletonCards()` was already the house
style at 20 call sites, but nine places still wrote their own `Loading…` string,
so the same application showed two different things while waiting. All nine now
use the helper.

**Terminology.** `showBroadcastModal()` was labelled "New Broadcast" on one page
and "Open broadcast composer" on another — one action, two names; both are now
"Create Broadcast", matching the app's dominant *Create X* verb. `dept_admin`
rendered as "Dept Admin" in the badge map but "Department Admin Center" as a
page title; spelled out in both. One badge read "Verified Alumnus" where the
rest of the app says Alumni.

### The role label mapping, as required by section 14

The UI name for a role is **not** hardcoded — it is the per-user `role_label`
column, which an administrator can edit. What is seeded today:

| Backend role | Shown as | Note |
|---|---|---|
| `super_admin` | Super Admin | |
| `univ_admin` | **College Admin** | the deliberate rename; "univ" is never shown |
| `dept_admin` | Dept Admin (CSE) | data, not a constant — carries a department |
| `moderator` | Moderator | |
| `alumni` | Alumni Member | |

`js/admin.js` also holds a constant fallback map used for badges, which now
reads *Alumni · Moderator · Department Admin · College Admin · Super Admin*.
**No backend role name was changed**, and none of these labels affects a
permission check.

### Verified in a browser, not asserted

Five roles, both portals, seven widths — 360, 390, 430, 768, 1024, 1280, 1440.

| Role | Pages | Widths | Overflow | Console errors |
|---|---|---|---|---|
| alumni | 10 | 7 | 0 | 0 |
| super_admin | 15 | 7 | 0 | 0 |
| univ_admin | 14 | 3 | 0 | 0 |
| dept_admin | 7 | 2 | 0 | 0 |
| moderator | 6 | 2 | 0 | 0 |

Navigation scoping is right per role: administration is super-admin only, and
each role sees exactly the modules its permissions allow.

Dialog behaviour was exercised by dispatching real events rather than reading
the source. On the create-administrator form: typing a value and clicking the
backdrop **left the dialog open with the value intact**; Tab from the last of
its nine focusable elements wrapped to the first and Shift+Tab wrapped back;
the body scroll lock applied and released; Escape closed it; focus returned to
the element that opened it; and a dialog that *does* opt into dismissal closed
on a backdrop click, as it should.

### Honestly not verified

The initial move of focus **into** a dialog is scheduled inside
`requestAnimationFrame`, and this environment's browser pane runs with
`visibilityState: "hidden"`, where rAF never fires. Everything else about the
dialog was confirmed by dispatched events; that one step could not be, and is
not claimed. It is unchanged code that was already correct on inspection.

### What was deliberately left alone

- **Event v5** — no architecture or behaviour touched. The single change inside
  it is one hover text colour at 3.96:1, a value, not a behaviour. Its prose
  arrow in "Advanced → Budget" is typography in a sentence and stays.
- **Large accent figures** — seven rules where a KPI number is 22–48px. Large
  text needs 3:1, which the vivid accents clear, so the numbers keep their
  colour rather than being flattened for a threshold that does not apply.
- **`role_label` data** — a per-user column an administrator owns, not a
  constant to be rewritten from here.
- **Two "Icon Emoji" fields** — chapters and news let a user pick an emoji as
  content. That is a product feature, not UI chrome.

### Follow-up: the design hook's findings

A design-lint hook raised 54 findings after the phase commit. Triaged rather
than taken at face value — but unlike the emoji and modal reports earlier in
this phase, **most of the substantive ones were real**, and they were real for
a reason worth recording: the browser sweep measures what is *rendered and
visible*, so anything living in a state the sweep never reached was invisible
to it.

Fixed:

- **`.cipher-box` was a dark panel.** Teal ink on `rgba(0,0,0,0.4)` over a
  light card — about **1.06:1**, and a dark panel besides, which section 2
  rules out. It only renders once an identity value has been encrypted, which
  is why the Compliance page measured clean. Now a light panel at **4.92:1**.
- **The mobile bottom navigation was 9px, and 10px at two other breakpoints.**
  An earlier phase set a 12px mobile floor but exempted "nav labels … they
  carry no reading text". Home / Directory / Mentorship / Events / Profile are
  exactly reading text, and they are the primary navigation on a phone. All
  breakpoints now sit at the 11px functional floor; the five items still fit
  across 360px with nothing clipped. My own new test caught the two extra
  breakpoints after I had fixed only the one the hook rendered.
- **Every page skipped a heading level.** Both portals went `h1.page-title`
  straight to `h3.card-title`, with **no `<h2>` anywhere** — 68 card titles
  across six files. They are now `h2`. `.card-title` is styled by class, so
  nothing moved visually, and Event v5's own headings were left alone because
  `.ev-review-head h3` depends on the tag.
- **Nine infinite animations ignored `prefers-reduced-motion`.** The two
  existing blocks covered only Event v5 and the toast. Decorative motion — the
  login orbs, the ID hologram, the progress shimmer, three status dots — now
  stops. Spinners and skeletons deliberately keep moving: "this is working" is
  information, not decoration.
- **`--text-muted` (#64748B) failed on every off-white panel**: 4.47:1 on
  `#F6F8FB`, 4.34:1 on `--bg-deep`. Darkened to **#5D6B7F**, which clears 4.5:1
  on all four grounds in use. Event v5 had **already made this exact change**
  for itself — `--ev-ink-muted: #5B6B7F`, with the same 4.34:1 measurement in
  its comment — which is good evidence the token was the problem rather than
  any one rule. Two hardcoded copies (`.world-svg`, the Chart.js tick labels)
  were pointed at the token.
- **`--purple` as 11–12px ink** on the RBAC table ground, 4.44:1 →
  `--purple-text` at 5.76:1.
- **Four large accent figures cleared the 3:1 large-text bar by 0.01**
  (3.01:1). Earlier in this phase I argued they should keep their vivid colour
  because the 3:1 threshold applies and they pass. A 0.3% margin is not a pass
  worth defending, so they take the text-weight teal too. The same applies to
  the `.brand-name` wordmark's lighter gradient stop.

Both portals were re-measured afterwards: **25 pages, zero contrast failures,
zero horizontal overflow.** `tests/phase7a_ui.js` grew to **69 checks** pinning
all of the above, and the suite total is **1,742 passed, 0 failed across 24
suites**.

Recorded as sanctioned exceptions in `.impeccable/config.json`, each with its
reason: `tiny-text` (the house 12px-mobile / 11px-desktop-metadata policy,
with the stricter functional-text rule left active and now reporting zero),
`cramped-padding` (the topbar centres its children by height, not padding),
`clipped-overflow-container` (`overflow-x` only, plus the login orbs),
`gradient-text` (two brand wordmarks, not headings), `radial-spotlight-glow`,
`pulsing-dot` and `marquee` (all now reduced-motion aware), and
`layout-transition` (`scaleX` would distort the funnel bar's inner label).

Four findings were deliberately **not** suppressed, because they are judgements
about the app's established visual and prose identity rather than defects, and
changing them would mean redesigning it: `codex-grid-background`, `dark-glow`,
`gpt-thin-border-wide-shadow` and `em-dash-overuse`.

### Next phase

**Phase 7B.** Phase 7A's remit was consistency, accessibility, mobile and
interaction quality; it added no business feature and changed no permission.

---

## PHASE 7B — Real Location System + Location Privacy

**Status:** **COMPLETE**
**Date:** 2026-09-07
**Commit:** `d1adb59`
**Parent:** `d5a16ea`

### The audit was stale, and re-reading it was the point

`LOCATION_SYSTEM_AUDIT.md` opens with "no coordinates exist anywhere · no map
library exists · the user cannot enter their own city · both account-creation
paths hardcode 'Dhaka','Bangladesh' · the Share My Location toggle does
nothing". **None of that is true any more.** It is the audit that *commissioned*
Phase 5B, and Phase 5B answered it: `location_places` (99 cities with real
coordinates), `alumni_profiles.place_id`, a Country → City picker, three
privacy levels enforced in SQL, and a server-aggregated map with clustering.

§1 said not to assume the earlier findings still held. They did not, and taking
them at face value would have meant rebuilding a working system. What follows is
what was actually missing.

### Findings

**Three of the four location domains were never modelled.** Alumni location was
complete. Events had `venue VARCHAR(255)` and nothing else — no address, no
coordinates. Jobs had free-text `location` and no way to say whether attendance
was required. Chapters had **no location columns at all**, while three of the
five are `regional`.

**The job board still fabricated a city.** `POST /api/jobs` stored
`location || 'Dhaka'`. Phase 5A removed the same prefill from the form and left
a comment saying so — the *server* default survived, so a posting submitted with
the location blank recorded Dhaka anyway. Exactly the fabrication class v13
removed from alumni profiles, in the one place nobody re-checked.

**Dead code was still carrying invented location data.** A block in
`js/dashboard.js` held a hardcoded per-country alumni distribution — BD 8,241 ·
UK 1,240 · USA 987 · Canada 542 — labelled "Alumni Count", plus a 12,847 alumni
counter. None of it was on screen (`#kpi-alumni`, `#main-chart` and
`.chart-tabs` exist in neither portal, and `animateKPIs`,
`initDashboardChart` and `switchChart` were each referenced only by their own
definition), but it sat one wire-up away from being believed. The real figure is
1. **99 lines removed.** Found by this phase's own new test, not by reading.

**The test harness had been running against a stale server.** `npm test`
expects an application already listening on 8123; the process there had been
started before this phase's edits, so the first full run reported a 404 on a
route that answers 401 correctly. Restarting it — with `NODE_ENV=production`,
which two suites require — turned 2 failures into 0. Phase 7A's results were
unaffected: it changed no server code.

### The data, as it actually stands

| | |
|---|---|
| Alumni profiles | **14** |
| With a confirmed place | **1** |
| Flagged `location_needs_confirmation` | **13** |
| Location privacy: public / alumni (default) / private | **1 / 13 / 0** |
| Reference places | **99** cities, 45 countries |
| …carrying a division | 57 |
| …carrying a district | 30 |

The map therefore shows **one alumnus in Chattogram**, and says so: *"1 city
across 1 country, 1 alumni who chose to appear on the map. 13 profiles carry a
location recorded automatically before it could be confirmed; they are not shown
here."* That is §14's instruction — show the sparse real data — and it is Phase
5B's refusal to convert fabricated values into structured ones still holding.

### Database (`migrate_v14.js` / `schema_v14.sql`)

Applied in a transaction, dry-run first, with a fingerprint proving no existing
value moved.

- `events.address TEXT`, `events.latitude/longitude NUMERIC(9,6)`
- `jobs.work_mode VARCHAR(20)`
- `chapters.place_id INT REFERENCES location_places(id)`
- constraints: `events_coords_paired` (a half coordinate is not a place),
  `events_coords_range`, `events_coords_range_lng`, `jobs_work_mode_valid`
- indexes: `idx_chapters_place`, `idx_places_district`

Every column is nullable with no default. **Nothing was back-filled**: 0 events
gained an address, 0 jobs gained a work mode, 0 chapters gained a place. The
verification asserts each of those zeros.

No coordinate column was added to `alumni_profiles`, and the migration asserts
that too. A person is not a point; a city is.

### API

| Route | Change |
|---|---|
| `POST/PUT /api/events` | `address`, validated `latitude`/`longitude` |
| `POST/PUT /api/jobs` | `workMode`; the `'Dhaka'` default removed |
| `GET /api/jobs` | `?workMode=` filter |
| `GET /api/alumni` | `?division=`, `?district=`, each carrying the same privacy constraint as country and city |
| `GET /api/locations/filters` | now returns `divisions` and `districts` |
| `GET /api/chapters` | joins the chapter's place |
| **`PUT /api/chapters/:id/place`** | **new** — admin-only, audited, sets or clears |

Chapters had no update route at all, so the three regional chapters could never
have been placed. One focused route was added rather than a general chapter
editor.

### UI

- **Map:** a labelled search that filters what the server already sent (never
  re-queries, never recomputes a count), and a loading state so an empty canvas
  is never mistaken for "nobody has a location". "No locations yet" and "no
  match for your search" are now different messages.
- **Directory:** division and district chips, shown only when there is more than
  one to choose between — with a single division the chip selects exactly what
  the country chip already does. All four location filters are mutually
  exclusive.
- **Jobs:** a Work mode field defaulting to *Not specified*, and a card badge
  that appears only when a poster actually chose one.
- **Events:** an Address field in both the wizard and the edit form, and a
  **derived** Directions link — built at render time, so there is no stored URL
  to validate or poison.
- **Chapters:** the institution's city, with an admin-only picker. A chapter
  with no single city says "No location set" rather than guessing.

### Privacy behaviour

Unchanged, because it was already right: `privacy.js` defines three levels for
`location`, defaults to `alumni`, and has **no staff bypass** — a private
location is private for every role including super_admin. The map counts
`= 'public'`; the directory excludes `= 'private'`.

Verified per role rather than asserted. All five roles see the same map total
(1), and an anonymous caller gets 401 from all three location endpoints. No
role's directory response contains a coordinate, a street address or a postal
code. The division and district filters carry the same constraint as country and
city, so a member who hides their city cannot be found by filtering for their
division either.

### Map technology (§13)

Documented in **`MAP_TECHNOLOGY.md`**. The answer is unusual and worth stating:
**there is no map library and no tile provider.** No Leaflet, Mapbox, MapLibre,
OpenLayers, Google Maps, D3-geo or TopoJSON appears anywhere in the repository.
The map is an equirectangular projection, a graticule drawn into an inline
`<svg>`, and cluster badges positioned as ordinary DOM elements, over
coordinates that belong to cities.

Consequently: **no API key, no account, no quota, no billing, no attribution
obligation, no CSP change, and it works offline.** The one external map
reference is the event Directions link, which points at OpenStreetMap, loads
nothing, and sends only venue information that is already public.

### Data normalization (§6)

No new strategy was needed — `location.js` already implements one, and it is
the right one: explicit aliases only (`chittagong → Chattogram`,
`bogra → Bogura`, `usa → United States`), documented renames and spellings the
institution's own records use. Ambiguous input resolves to nothing rather than
to something confident and wrong, and an unresolved location stays unresolved
rather than defaulting to Dhaka. Existing values are still not rewritten; the
13 unconfirmed rows are flagged, not converted.

### Mobile (§16)

The map at 360 · 390 · 430 · 768 · 1024 · 1280 · 1440: **zero horizontal
overflow, zero clipped controls, the search visible at every width.** The
toolbar wraps to three rows on a phone — modes, then search, then zoom — and the
canvas tracks the viewport from 342px to 874px.

### Tests

```
25 suites                    1,826 passed, 0 failed
  of which phase7b_location        84   (new)
  the 24 pre-existing suites    1,742   unchanged, still 0 failed
```

`tests/phase7b_location.js` covers the four domains and their separation, that a
person is never a coordinate, privacy for all five roles plus anonymous, map
aggregation checked against its own SQL, every filter, event venue validation
and persistence, job work mode, chapter location and its refusals, and the empty
and loading states. `tests/install_drill.js` now applies migrations through v14.

### Limitations

- **The map has one point on it.** Nothing engineering can do about that: 13 of
  14 profiles carry a location that was fabricated before Phase 5B and is
  flagged for the member to confirm. The system is waiting on people, correctly.
- **Division and district chips are built but not currently shown**, because one
  division is not a choice. They appear as soon as alumni confirm cities in more
  than one.
- **Event coordinates must be typed.** There is no geocoder, so an organiser who
  wants a precise pin has to supply the numbers; the Directions link falls back
  to searching the address, which is the common case.
- **No reverse geocoding, no GPS, no live location** — deliberately, per §3.
- `location_places` covers 99 cities. A member in a city outside it cannot pick
  one; the reference table is extended by migration, not by users.

### Next phase

**Phase 7C.** Not started.

---

## PHASE 7C-1 — Alumni & Privacy Completeness

**Status:** **COMPLETE**
**Date:** 2026-09-07
**Commit:** `2df25c1`
**Parent:** `d06e09c`

### The audit, before anything was changed

Re-verified against the running system rather than read from the Master Audit,
because later phases had already closed several of its findings.

| § | Item | State |
|---|---|---|
| 2 | Verification lifecycle — unverified on signup, staff-only, audited, unforgeable | **READY** |
| 3 | Verification affects capability | **BROKEN** |
| 4 | Verification visible to the member | **MISSING** |
| 5 | Privacy settings persist UI → API → database → next session | **READY** |
| 6/7 | Privacy applied consistently, including location | **READY** |
| 8 | Consent history screen | **MISSING** (endpoint since day one, never a caller) |
| 9 | Consent management | **PARTIAL** |
| 10 | Data export scope | **PARTIAL** — 6 record types absent |
| 11 | Export declares what it omits | **MISSING** |
| 12 | Export security and ownership | **READY** |
| 13 | Deletion request → grace → cancel → purge | **READY** |
| 14 | Deletion explains what will happen | **PARTIAL** |
| 16/17 | Alumni lifecycle state | **READY** — nothing to build |
| 18 | Profile ownership, no IDOR | **READY** |
| 28 | No legal overclaiming | **BROKEN** |

Most of it was already right. Two things were not, and one of them mattered.

### is_verified was decorative

The Master Audit's finding still held, and this is what it looked like measured
rather than described. A freshly self-registered account — nobody had checked
who they were — could:

```
job application      200 ALLOWED        posting a job        200 ALLOWED
mentorship request   200 ALLOWED        submitting a story   200 ALLOWED
chapter join         200 ALLOWED        creating a chapter   200 ALLOWED
donation pledge      200 ALLOWED
```

`is_verified` drove a badge, a queue and two dashboard counts. It gated
nothing.

**The policy now enforced**, server-side, in `requireVerified`:

*Requires verification* — anything that reaches another member, commits the
institution, or publishes: registering for an event, applying for a job,
requesting a referral, posting a job, requesting mentorship, joining or
creating a chapter, pledging a donation, submitting a story, requesting a
connection. Ten routes.

*Deliberately not gated* — completing the profile (it is what verification is
judged on), browsing the directory, and **consent, data export and deletion**.
A member's rights over their own data cannot be conditional on the institution
getting round to them.

The refusal is `403 "Alumni verification is required for this action."` with a
`verification_required` code and nothing else: no queue position, no reviewer,
no estimated date. Staff are unaffected — accounts created by an administrator
and accounts from bulk import are both inserted `is_verified = TRUE`; only
self-signup starts unverified, which is the case the gate exists for.

`is_verified` is read from the row `attachUser` already fetches, so revoking a
verification takes effect on the next request rather than when the token
expires — the same reasoning the suspension check gives.

### Verification, made visible (§4)

An account status card on My DIC Profile naming the state — **Verified**,
**Verification pending**, or **Suspended** — carried by an icon and a sentence
rather than by colour. For a pending account it lists what they *can* do, the
eight things that are waiting, and how verification is decided: *"by DIC staff
against the institution's own records. A complete profile — full name, batch and
department — is what they check against."* Nothing about who is reviewing or
when.

### Privacy Centre (§20)

Replaces a card offering two export buttons and a delete button. Four sections:
the privacy settings as they currently stand, the **consent record** (§8 — the
endpoint had no caller since it was written), a data download that explains
itself, and deletion.

### The data export was incomplete and did not say so (§10, §11)

It returned eight sections and named none of the ones it left out — the shape
of export that reads as complete without being it. Absent: job applications,
referral requests, connections, notifications, identity-vault presence, and the
member's own deletion history.

Now **eighteen sections**, each with a record count, plus a named
`omittedSections` list with a reason for each:

- **credentials** — passwords, hashes, session and reset tokens are never
  exported. Authentication material, not personal data owed back.
- **identityVault.contents** — the encrypted value is withheld; its presence,
  type and last four characters are included. Releasing plaintext is an
  administrator action, separately authorised and separately audited, with no
  self-service route. §10's "metadata unless policy explicitly supports
  plaintext release" — and no such policy exists.
- **auditTrail** — an institutional record, hash-chained.
- **otherMembers** — only this account's side of a shared record.

A name-based scrub drops any key matching password/hash/token/secret/cipher/
auth_tag regardless of which table it came from, because `alumni_profiles` is
selected with `*` and a credential column added later would otherwise ride out
unnoticed. Privacy settings are passed through `privacy.effective()`: the
stored JSONB still carries `cgpa`, `github`, `address` and `linkedin` from an
older schema, and exporting them would show a member controls they do not have.

**A defect the widening exposed.** The new queries carried
`.catch(() => ({ rows: [] }))`. Removing those turned a silent empty section
into a 500 that named the cause: `column p.role does not exist`. In an export,
a broken query returning an empty array is indistinguishable from a member
having no records — the worst failure mode this endpoint has. There are now no
fallbacks; a failure is a 500 with a request id.

### Deletion, spelled out (§14, §15)

The purge job already implemented §15's taxonomy precisely. The dialog now says
so before the request is made, in three labelled groups:

- **Permanently removed** — profile, identity documents, consent records,
  notifications, connections, chapter memberships, event registrations, job
  applications and referrals, jobs posted, mentorships, poll votes, stories.
- **Kept, with your name removed** — donations are retained as financial
  records with `donor_name` overwritten; events created and messages sent
  survive, detached.
- **Kept as written** — the audit trail, because its entries are SHA-256
  chained and rewriting one invalidates every verification after it.

### Alumni status: nothing was built, deliberately (§16, §17)

`users.status` already exists with a CHECK constraint allowing exactly
`active` and `suspended`, defaulting to active, enforced both at login and in
`attachUser` on every request. The four states §17 asks to keep distinct
already are, in different places:

| State | Where it lives |
|---|---|
| Suspended | `users.status = 'suspended'` |
| Deletion requested | `deletion_requests.status = 'pending'` |
| Purged | the row is gone |
| Deactivated | **does not exist** |

§16 says not to add a taxonomy the model does not need. It does not need one,
so none was added. Documenting that was the work.

### Legal overclaiming, removed (§28)

*"PDPA 2026 Compliant"* sat in the login footer of every visit. Three more
places attributed application behaviour to a statute — the signup consent line,
the data-rights card and the deletion dialog — and an admin subtitle named two
acts. No legal assessment of this platform exists in the repository, so those
were claims the software was making on the institution's behalf. All replaced
with concrete descriptions of what the system does. An admin status pill
reading "Compliant" now reads "Active", which is what it measures.

Left alone: `consent_logs.policy_version`, which defaults to `'PDPA-2026.1'`.
Rewriting stored values would make old and new consent records incomparable for
no gain. **Institutional dependency:** DIC should supply the identifier of its
own published privacy policy, and the default should become that.

### Two regressions caused, and how

**The security smoke suite went red.** Its member fixture registers an account,
which now starts unverified, so a job-posting assertion and two XSS assertions
began failing on 403. The fixture — not the assertion — was wrong: the suite's
subject is an ordinary *verified* member, and those tests are about output
escaping, not verification. It now verifies its fixture the same way it
promotes roles. Its route parser also learned `requireVerified`, which it had
been reading as "unguarded".

**An unrelated acceptance assertion went red.** Two earlier runs of the new
suite threw part way through, and the error path exited before cleanup, leaving
probe accounts behind; `acceptance` picks a profile with
`SELECT ... LIMIT 1` and no `ORDER BY` and quietly picked one up. Cleanup now
runs on the error path too. The audit probe had also left a member's location
privacy on `private` — its "restore" read the value at the start of each run,
so re-running it restored the wrong thing. `phase7b_location` caught that one.

### Database

**No schema change.** Nothing this phase needed a column. `is_verified`,
`users.status`, `consent_logs` and `deletion_requests` all already existed;
what was missing was enforcement, an interface and honesty about scope.

### API

| Route | Change |
|---|---|
| 10 write routes | now behind `requireVerified` |
| `GET /api/dsar/export` | 8 → 18 sections; included/omitted manifest; credential scrub; effective privacy settings; no silent fallbacks |
| `attachUser` | carries `is_verified` on the session |

### Tests

```
26 suites                    1,951 passed, 0 failed
  of which phase7c1_privacy        125   (new)
  the 25 pre-existing suites     1,826   unchanged, still 0 failed
```

`tests/phase7c1_privacy.js` covers §24 A–M: the lifecycle and its unforgeability,
each of the ten gated actions and its message, the eight rights an unverified
member keeps, no over-reach on a verified one, privacy persistence and
validation, a private location absent from directory, map, mentor suggestions
and city filtering **for all five roles**, consent ownership across roles,
export completeness and credential-freedom, the 30-day grace period, the purge
predicate refusing both an in-grace and a cancelled request, suspension, and
IDOR.

### Browser verification

Privacy Centre, account status, consent history, data download and the deletion
dialog at 360 · 390 · 430 · 768 · 1024 · 1280 · 1440: **no overflow, nothing
clipped, no console errors.** The deletion dialog fits 360px with all three
groups readable. Verified and unverified states both checked in the interface.

### Limitations

- **The consent vocabulary is thin.** Three types exist in the data
  (`data_processing`, `marketing_email`, and one row of injection-test residue
  a dev database picked up). The screen shows what is there; it does not invent
  a catalogue. A real consent taxonomy is an institutional decision.
- **Consent is append-only.** History is complete because every grant and
  withdrawal is its own row, but there is no "current state" table — the latest
  row per type is the current state. Adequate, and worth knowing.
- **`policy_version` names a statute rather than a DIC policy document.** See
  above; DIC's own identifier is needed.
- **No legal assessment exists.** Nothing here claims one. The wording
  describes behaviour only.
- **Verification has no member-visible history.** The audit trail records every
  verify and revoke, but a member sees only their current state.

### Next phase

**Phase 7C-2.** Not started.

---

## PHASE 7C-2 — Jobs, Applications, Referrals & Polls

**Status:** **COMPLETE**
**Date:** 2026-09-07
**Commit:** `1de41f8`
**Parent:** `6b48421`

### Current state before implementation

Re-audited against the running system, since earlier phases had already closed
parts of the Master Audit.

| Item | State |
|---|---|
| Job create / edit / delete, with ownership | **READY** |
| Job close, reopen, deadline, description | **MISSING** |
| `jobs.days_ago` | **DEAD** — stored 2, 4 and 1 against three rows created the same day |
| Apply, and the poster's applicant list | **READY** |
| Change an application's status | **MISSING** — a column with a vocabulary and no route |
| Applicant seeing their own status | **MISSING** |
| Applicant list leaking contact data | **READY** — it returns none |
| Referral request and read | **READY** |
| Referral accept / decline | **MISSING** — every row ever written was still 'pending' |
| Referral list disclosing the requester's email | **BROKEN** |
| Poll admin CRUD | **MISSING** — the only poll in the database arrived by seed |
| Draft state, `created_by` | **MISSING** — `is_active` is a boolean and cannot express a draft |
| `closes_at` enforced | **BROKEN** |
| One vote per member | **READY** |
| Job search and location filters | **READY** |
| Audit for job/application/referral/poll actions | **MISSING** except Job Deleted |

### Two defects, found by looking rather than by being told

**A poll that had closed was still taking votes.** `GET /api/polls/active`
selected on `is_active` alone and the vote handler checked the same flag.
`closes_at` was written and never read, so the seeded poll — closing time
**19 August** — was still being offered on **7 September** and would still have
recorded a vote. A closing time that closes nothing is worse than none, because
the interface displays it.

**A referral disclosed an address its owner had hidden.** The list returned
`requester.email` unconditionally. A member who set email to 'private' had it
handed to whoever they asked for a referral — the one place nobody had checked
against the gate the directory and profile both honour. It now passes the same
gate: visible to the member, to staff (email carries a staff bypass), and
otherwise only while the member leaves it visible.

### Database — `migrate_v15.js` / `schema_v15.sql`

Dry-run first, applied in a transaction, with fingerprints proving the substance
of every job, poll and application was byte-identical afterwards.

Added: `jobs.description`, `jobs.deadline`, `jobs.status`, `jobs.closed_at`,
`jobs.closed_by`; `job_applications.status_changed_at` and `.status_changed_by`;
`job_referrals.responded_at`; `polls.status`, `.created_by`, `.opened_at`,
`.closed_at`. Constraints `jobs_status_valid` and `polls_status_valid`; indexes
on both status columns.

Dropped: **`jobs.days_ago`**, a fabricated relative date nothing read, and
**`polls.is_active`**, a second answer to "is this poll live" — its value
carried into `status` first, so an active poll became open and none became a
draft retroactively.

**No status vocabulary was changed.** The audit found
`job_applications_status_check` already allowing submitted / reviewing /
shortlisted / rejected / hired, and `job_referrals_status_check` already
allowing exactly pending / accepted / declined. Renaming 'submitted' to
'pending' would have churned the schema to match a word rather than a
behaviour; the interface labels it "Received" instead. The migration asserts
that no application status was rewritten.

Nothing was back-filled: 0 jobs gained a description, 0 gained a deadline, none
was closed, and no poll became a draft. Each asserted.

### API

| Route | Change |
|---|---|
| `GET /api/jobs` | `is_open` and `is_expired` derived; `?status=` filter; the caller's own application status |
| `POST /api/jobs` | description, validated deadline; **Job Created** audited |
| `PUT /api/jobs/:id` | description, deadline, open/close; audited as Created / Edited / Closed / Reopened |
| `POST /api/jobs/:id/apply` | refuses a closed or expired posting |
| **`GET /api/my-applications`** | **new** — the applicant's own applications and their state |
| **`PUT /api/job-applications/:id/status`** | **new** — poster or admin; notifies the applicant; audited |
| **`PUT /api/job-referrals/:id`** | **new** — accept or decline, once, by the addressee only |
| `GET /api/job-referrals` | the requester's email now passes the privacy gate |
| **`GET /api/polls`**, **`/:id/results`**, **`POST /api/polls`**, **`PUT /api/polls/:id`**, **`PUT /api/polls/:id/status`**, **`DELETE /api/polls/:id`** | **new** — the poll lifecycle, staff only |
| `GET /api/polls/active`, `POST /api/polls/:id/vote` | honour status **and** `closes_at` |

No endpoint was duplicated: the existing `PUT /api/jobs/:id` carries close and
reopen rather than a second route.

### Permissions

- A job is edited, closed and deleted by its **poster**, or by `ADMIN_ROLES` —
  the policy that already existed. A moderator is not automatically an owner.
- An application's status is changed by the **job's poster** or an
  administrator. Ownership is resolved from the job, never from the request.
- A referral is answered **only by the person it was addressed to**. An
  administrator is deliberately refused: accepting a referral is a personal
  vouching, and nobody should be able to vouch on someone else's behalf.
- Polls are created, edited, opened and closed by `MODERATOR_ROLES`; deleted by
  `ADMIN_ROLES` only, and only when nobody has voted.
- Every Phase 7C-1 `requireVerified` gate is untouched and re-asserted here.

### Notifications and audit

New application status → the applicant is told, naming the role and the state
and nothing about other candidates. Referral accepted or declined → the
requester is told. Both use the existing in-app notifications table.

Audited: Job Created, Job Edited, Job Closed, Job Reopened, Job Deleted,
Application Status Changed, Referral Accepted, Referral Declined, Poll Created,
Poll Edited, Poll Opened, Poll Closed, Poll Deleted. The suite asserts each is
present and that no entry carries a credential.

### Interface

Jobs gained a state badge that distinguishes **Open**, **Apply by <date>**,
**Deadline passed** and **Closed**; a Close / Reopen control for the poster;
description and deadline in the form; a status select on each applicant; and a
**My Applications** panel — a candidate could previously apply and never learn
what happened. Referrals gained **Accept** and **Decline**, shown only to the
addressee while the request is pending, and a state pill otherwise.

Polls gained a staff page — Draft / Open / Closed, with Edit, Open to members,
Close, Results and Delete. A poll whose closing time has passed reads *"Closed —
its closing time has passed"* even while its stored status is open, because
`is_live` is the server's answer and the badge follows it.

**A layout defect fixed on the way:** `.jobs-layout` was a grid whose column
sized itself to the job cards' min-content — 357.8px of track inside a 344px
container at 360px wide, clipped by the body's overflow guard rather than
scrolling. `minmax(0, 1fr)` plus `min-width: 0` on the children. Pre-existing;
found by the mobile sweep.

### Mobile and accessibility

Jobs and polls at 360 · 390 · 430 · 768 · 1024 · 1280 · 1440: **no overflow,
nothing clipped** after the grid fix. Every new control is a labelled
`type="button"`; the applicant status select carries a visually-hidden label
naming the applicant; state is carried by an icon and a word, never colour
alone; and the poll editor was checked against Phase 7A's modal rule — a
backdrop click leaves the form open with its typed value intact.

### Tests

```
27 suites                    2,065 passed, 0 failed
  of which phase7c2_jobs_polls     114   (new)
  the 26 pre-existing suites     1,951   unchanged, still 0 failed
```

`tests/phase7c2_jobs_polls.js` covers §23 A–T: the job lifecycle including a
deadline moved into the past to prove expiry is derived, ownership across all
five roles, application status transitions and their refusals, the applicant's
own view, the absence of ten contact fields from the employer's list, referral
accept and decline and the refusal to answer twice, the email privacy gate in
both directions, poll draft/open/closed, one-vote-per-member, a poll past its
closing time refusing a vote, staff-only administration, the refusal to delete a
poll holding votes, the Phase 7C-1 gate, and every audit action.

### Test cleanup

The suite removes every account, job, application, referral, poll and vote it
creates, and does so on the error path as well — a lesson from Phase 7C-1,
where two aborted runs left rows that an unrelated `acceptance` assertion
picked up through `LIMIT 1` with no `ORDER BY`. Confirmed afterwards: 3 jobs,
1 application, 0 referrals, 1 poll, 0 votes — the same as before the phase, and
18 users / 14 profiles / 99 places unchanged.

### Regressions

None. Nothing pre-existing was deleted and no assertion was weakened.

One defect in my own work, found by the §22 cross-check rather than by a test:
the admin poll list drew per-option bars from `p.counts`, which the list
endpoint did not return — every bar would have read zero. The list now carries
the tally, and `GET /api/polls/:id/results` is used by the Results action
rather than left as a capability with no interface.

### Limitations

- **A closed poll cannot be reopened.** Votes were cast under a stated closing;
  the correct move is a new poll. The server refuses it explicitly.
- **An open poll cannot be edited.** Votes are recorded against option
  positions, so changing the options would silently reassign them.
- **Job status has two values.** open and closed, plus expired derived from the
  deadline. No draft, because nothing in the workflow asked for one.
- **Referral notifications are in-app only.** There is no email path for them,
  in keeping with the rest of the platform.
- **The seeded poll remains open with a past closing time.** It now reads as
  closed everywhere and refuses votes; the stored status was left alone rather
  than rewritten, since that is a decision for whoever owns the poll.

### Next phase

**Phase 7C-3.** Not started.

---

## PHASE 7C-3 — Reports, Exports, Import Operations & Admin Audit

**Status:** **COMPLETE**
**Date:** 2026-09-07
**Commit:** `e409534`
**Parent:** `e2d22b3`

### Current state before implementation

Re-audited against the running system rather than trusted from the Master Audit.

| Item | State |
|---|---|
| A page called "Reports" | **DEAD** — the navigation label; the page is Executive Analytics, five charts |
| Any report producing rows | **MISSING** — all ten |
| CSV export | **MISSING** except `/api/events/:id/attendees.csv`, which had no interface |
| `GET /api/audit-logs` | **BROKEN** — `SELECT * … ORDER BY id DESC LIMIT 50` over 11,185 rows, no filters, no paging, no export |
| Import upload → map → validate → preview | **READY** |
| Import dry run | **MISSING** — validation was entirely in the browser, against the file alone |
| Import batch identity | **BROKEN** — `admin_name` was a string the client chose |
| Batch rollback | **MISSING** — nothing linked a created account to the batch that made it |
| `import_history` | **PARTIAL** — written, but with no actor, no status and no link to its accounts |
| Import ignoring role/verified/status from the file | **READY** — already literals in the INSERT |
| Notification when a bulk change lands | **MISSING** |

### Three things worth naming

**An audit log that could not be asked a question.** 11,185 entries behind
`LIMIT 50` with no filters. An administrator asking "what did this person do to
this account last March" had no way to ask it — which makes an audit trail a
decoration. It now filters by administrator, action, module, target and date
range, pages, and exports exactly the filtered set.

**An import that could be seen and not undone.** `import_history` recorded who
ran an import as free text the caller supplied, and nothing tied a created
account back to its batch. A roster imported by mistake was permanent.

**Validation that only ever looked at the file.** The wizard's "Confirm & Create
N Accounts" button acted on the browser's own opinion of the rows. It could not
see a duplicate of an account already in the database, so the number on the
button was not the number you would get.

### Database — `migrate_v16.js` / `schema_v16.sql`

Dry-run first, applied in a transaction, 23 checks, with fingerprints proving
user rows, import history and **the audit hash chain** were byte-identical
afterwards.

Added: `import_history.created_by`, `.status`, `.rolled_back_at`,
`.rolled_back_by`, `.rolled_back_count`; `users.import_batch_id`. Constraint
`import_history_status_valid`. Indexes on batch membership, import date, import
actor, and — for the newly filterable audit read — `audit_logs(created_at DESC)`
and `audit_logs(action)`.

Nothing dropped, nothing back-filled. The 322 existing batches keep
`created_by` NULL and have no linked accounts, which honestly says "we do not
know which accounts this made" — and the rollback endpoint refuses such a batch
rather than guessing which people to delete.

### One export mechanism — `csv.js`

Every export in the platform goes through it. RFC 4180 quoting, UTF-8 **with a
BOM** so Bengali names survive a double-click in Excel, CRLF, a server-defined
column order the client cannot widen, `no-store` and `nosniff`, and a
formula-injection guard that prefixes any cell beginning `=` `+` `-` `@` or a
control character.

It also **refuses to run** on a column whose key or header reads as a
credential. That guard caught one export during this phase — the audit log's own
`prev_hash` and `entry_hash`. A digest of an audit entry is not a secret, so
the columns were renamed *Previous entry digest* and *Entry digest* rather than
an exception being carved into the guard. A guard with an escape hatch is a
guard that will one day be escaped.

### Reports

Ten, as a registry rather than ten endpoints, so the permission check, the date
range, the row cap and the CSV writer each exist once:

Alumni Directory · Event Attendance · Ticket & Registration · Donation Ledger ·
Campaign Summary · Job & Application · Mentorship · Chapter · Verification ·
Administrator Activity.

`GET /api/reports` returns only what the caller's role may run, so the
interface builds itself from the server's answer and cannot offer a report that
would then be refused. `GET /api/reports/:slug` serves JSON or, with
`?format=csv`, the file — same query, same columns, one permission check.

**Every figure is counted from rows.** `campaigns.raised_amount`,
`campaigns.donors_count`, `chapters.members_count`, `chapters.events_count` and
`events.registered_count` are all deliberately unread: each was seeded far above
the rows behind it. The Campaign Summary reports **৳5,000 settled** where the
stored counter claims ৳18.45L, and the suite asserts the report disagrees with
the counter wherever the two differ.

**Location privacy survives the export.** `privacy.js` gives location no staff
bypass, so a member who set it to private exports with city, district, division
and country blank — to a super administrator — plus a column saying the blank is
a choice rather than a missing profile. Email and mobile do carry a staff
bypass and are exported.

**An anonymous gift stays anonymous** in the ledger, not merely in the public
list. The receipt code, transaction reference and amount remain, so finance can
still reconcile; only the identity is withheld, which is the thing the donor was
promised.

### Audit

`GET /api/audit-logs` now takes `actorId`, `action`, `module`, `targetType`,
`targetId`, `from`, `to`, `limit` and `offset`, and answers with
`{ entries, total, … }` so the interface can say "showing 1–50 of 11,226"
instead of leaving the reader to guess. `?format=csv` exports the filtered set.
Two companions — `/actors` and `/actions` — let the filters offer what is
actually in the log rather than asking an operator to type a guess.

Module classification lives in `audit_modules.js` and is compiled into SQL from
the same array the JavaScript uses, so the two cannot drift. An unrecognised
action classifies as **Other**, never dropped: a filter that silently hides rows
from an audit log is a defect with a security shape.

**The chain is untouched.** Every path here is a SELECT. `verify_audit.js`
passes through 12,157 entries after the phase.

### Import

The workflow is now Upload → Map → Validate → Preview → **Dry Run** → Confirm →
Result, and there is **no Confirm button until a dry run has run**.

The dry run is the same code as the import — every validation, every duplicate
decision, every INSERT — with `ROLLBACK` instead of `COMMIT` as the only
difference. A dry run written as a separate "validate" pass would be a second
implementation, and the two would disagree the first time one was edited. This
one cannot disagree with itself, and it sees duplicates against accounts already
in the database, which the browser never could. The suite asserts the dry run's
four counts equal the real import's four counts.

`POST /api/import-batches/:id/rollback` deletes the accounts a batch created —
only those, never one it merely enriched. It refuses if anyone has signed in to
one, or if any has a registration, donation, application, mentorship,
membership, vote or story against it. Rollback is for the case an operator
actually has: the wrong file, noticed within minutes. Past that, the accounts
have started accumulating a person's own activity, and deleting them destroys
that person's data rather than the operator's mistake. Audit history is never
deleted — `audit_logs.actor_id` is ON DELETE SET NULL — and the rollback is
itself audited and announced.

**Enrolment.** The wizard's "Initial Password Policy" was a `<select>` with one
option — a control that did nothing. It now offers a real second choice.
`generated` is the existing behaviour: one random credential per batch, hashed,
shown once, every account flagged `must_change_password`. `invite` generates
**no credential at all** — each account is created with the `LOCKED$` sentinel
that `verifyPassword` can never match, and its holder sets their own password
through the existing reset flow using their own address. That is a unique
credential per account, chosen by the person it belongs to, which never exists
anywhere an operator could see or forward.

### Notifications

A bulk import and a rollback now notify every administrator role. A bulk change
to the alumni body is something the people who administer it should be told
about, not something they should have to find in an audit log. The rollback
notice gives the count and the administrator's name, never a list of who was
deleted — that roster would outlive them.

### Interface

A **Reports** page: the report list, its filters, a table, and Export CSV. The
navigation entry that read "Reports" and opened Executive Analytics now reads
**Analytics**, and Reports is its own page.

The **Audit Logs** page gained seven filters, paging and an export.

The **import wizard** gained a fifth step, a dry-run panel showing the server's
own counts before anything is written, the enrolment choice, and a Roll back
control on each batch in the history — shown only when the server says that
batch can be rolled back, with the reason spelled out when it cannot.

**A layout defect fixed on the way:** a global `@media (max-width: 900px) { table
{ display: block } }` — there so the RBAC matrix can stack into cards — flattened
the report table, which then shrank to its container and clipped nineteen of its
twenty-one columns instead of scrolling. Scoped so the report table stays a
table; the stacking behaviour everywhere else is untouched. Pre-existing rule,
new interaction, found by the mobile sweep.

### Mobile and accessibility

360 · 390 · 430 · 768 · 1024 · 1280 · 1440: **no page overflow anywhere**. A
2,454px report table scrolls inside its own container at every width. No
unlabelled control on either new page, headings present, every button typed, and
the rollback confirmation was checked against the Phase 7A modal rule — a
backdrop click leaves it open.

### Tests

```
28 suites                    2,291 passed, 0 failed
  of which phase7c3_reports_import   226   (new)
  the 27 pre-existing suites       2,065   unchanged, still 0 failed
```

`tests/phase7c3_reports_import.js` covers A–T: all ten reports across five
roles, the CSV bytes including the BOM and CRLF, the credential guard in four
forms, formula neutralisation, date-range validation and inclusivity, location
privacy withheld from a super administrator, donor anonymity, every figure
checked against its own SQL, audit filtering on five dimensions plus paging,
the export being audited while an on-screen read is not, the dry run writing
nothing and predicting the import exactly, a hostile row that asks for
`super_admin` and gets `alumni`, batch linkage, rollback and its two refusals,
the notifications, and the credential appearing in no audit entry, no history
row and no account.

### Three suites adapted, no assertion weakened

`acceptance`, `phase2b` and `phase2c` read `/api/audit-logs` as a bare array.
The endpoint now answers with an envelope so it can carry a total and a page.
Only the accessor changed in each; every assertion is identical. A first attempt
also moved their filtering server-side, which looked like an improvement and was
not: it widened the set to include each account's own sign-in and
self-registration, which legitimately have no actor, and broke an assertion
about the administrator actions taken *on* that account. Reverted to the
original semantics.

`security_smoke` flagged "the import preview escapes every field it renders".
That heuristic looks for `${r.field}` interpolated into a template; my new
download handlers used `r` for a result passed to `showToast`, whose text is set
with `textContent` and cannot inject. The variable was renamed to `res` rather
than the heuristic relaxed.

### Regressions

None. Nothing pre-existing was deleted, no assertion was weakened, and the
database ends the phase at 18 users, 14 profiles, 21 events, 3 jobs, 1 poll and
99 places — exactly as it began.

### Limitations

- **Department scoping does not exist anywhere in this platform**, and this
  phase did not invent it. `ADMIN_ROLES` is super_admin and univ_admin only; a
  `dept_admin` has no department-limited view of anything. Rather than widen
  access to make a report available, reports carrying personal data are limited
  to those two roles, and `dept_admin` and `moderator` get only the two event
  reports they can already see the underlying data for. Genuine departmental
  scoping is a platform-wide change and is not in this phase.
- **The batch credential under `generated` is per batch, not per account.**
  Everyone in one import shares an initial password until they change it. That
  is the existing, deliberate design — it replaced a hardcoded `12345678` — and
  it stays because a per-account credential needs a distribution channel that
  does not exist and must not be a CSV. `invite` is the per-account answer where
  the addresses are ones people can read; it is offered, not forced.
- **Rollback cannot undo an enrichment.** A batch that updated an existing
  profile changed columns in place, and the previous values were not kept. Only
  account creation is undone.
- **The 322 batches imported before this phase cannot be rolled back**, and say
  so. Their accounts cannot be identified, and guessing means deleting somebody.
- **Reports are read into memory** — 5,000 rows on screen, 50,000 in a file, and
  a capped result says so rather than quietly ending early. Streaming would be
  the answer above that; nothing in this data is near it.
- **The mentorship report omits `health_score`.** The column exists and nothing
  computes it, so it would be a number with no method behind it. Days-to-answer,
  arithmetic on two real timestamps, is reported instead.
- **No report is scheduled or emailed.** They are run and exported by hand.

### Next phase

**Phase 7D.** Not started.

---

## PHASE 7D — Architecture, Schema, Legacy Cleanup & Department Scoping

**Status:** **COMPLETE**
**Date:** 2026-09-08
**Commit:** `62d318a`
**Parent:** `8b7a00e`

### Baseline before implementation

```
28 suites                   2,291 passed, 0 failed
audit chain                 PASS through 12,770 entries
47 tables · 18 users · 14 profiles · 21 events · 3 jobs · 1 poll · 99 places
```

One flake on the way in: `portal` exited 0xC0000409 once and passed on four
consecutive re-runs. A Windows process failure, not a code failure; the baseline
was re-established green before anything was changed.

### The finding that shaped the phase

`users.department` is `VARCHAR(150) NOT NULL` and holds four different kinds of
thing across 18 rows:

| Kind | Example | Rows |
|---|---|---|
| a department | Computer Science & Engineering | 7 |
| a programme | BSc CSE (2020) | 1 |
| an HSC group | Science | 1 |
| a staff org label | CSE Department, DIC Administration | 4 |

The platform's only `dept_admin` reads **'CSE Department'**. The alumni it should
govern read **'Computer Science & Engineering'**. Scoping on that string would
have matched **nothing** — and a scope that silently returns zero rows looks
exactly like a scope that works. That is the failure mode this phase existed to
avoid, and it was one string comparison away.

Two causes, both fixed:

- **Bulk import had no Department field at all.** It wrote
  `normalizeHscGroup(r.hscGroup)` into `users.department`, so an imported
  alumnus's department was their HSC group.
- **Registration did the same.** Every self-registered account belonged to no
  department, so a department administrator could never confirm their own
  graduates — the scope would have decayed to nothing as new accounts arrived.

### The department model

`scope.js` — one definition, no RBAC system, nothing configurable.

| Role | Scope |
|---|---|
| `super_admin` / `univ_admin` | Institution-wide |
| `dept_admin` | Its own department, and nothing else |
| `moderator` | **unscoped** — platform-wide, as §1 requires |
| `alumni` | unscoped — governed by privacy and ownership |

Two decisions carry the design:

**`unscoped` is not `none`.** Collapsing them is a bug in both directions, and
I nearly shipped it: the first version returned `none` for a moderator, which
would have emptied the moderation and event screens for the one role that exists
to work them. A moderator gets no clause; an unassigned `dept_admin` gets
`AND FALSE`.

**Fail closed.** A `dept_admin` with no department reaches nothing, not
everything, and the interface says so in words rather than showing an
inexplicably empty screen.

**A record with no department belongs to the institution.** The one alumnus whose
department was never captured is visible to institution-wide roles and to no
department admin.

### Migrations

All four are transactional, dry-run capable and idempotent, and each proves what
it did not change with md5 fingerprints.

| Migration | Change | Checks |
|---|---|---|
| **v17** | `departments` reference table; `users.department_id`; `alumni_profiles.department_id`; back-fill from the profile by exact match | 20 |
| **v18** | `events.department_id`, back-filled by exact organiser match | 12 |
| **v19** | Nine columns dropped, `event_proposals` retained under a new name, the seeded department administrator assigned | 34 |

v17 seeds **four** departments — only names that actually appear on alumni
profiles. **'Science' was deliberately not seeded**: it is an HSC group the
import wrote into a department column, and the one profile carrying it keeps
`department_id` NULL. "We do not know" is the truthful answer.

v17 also assigned **no** staff department, on purpose. v19 assigns exactly one —
the seeded `dept_admin`, matched on both its role and its `'CSE Department'`
label so it cannot catch another account. Every further assignment goes through
`PUT /api/admin/administrators/:id`, which audits it as
**Administrator Department Changed**, separately from the field list of an
ordinary edit, because an authorisation change should be findable by searching
for one.

### A defect in my own migration harness, introduced in Phase 7C-3

`schema_v16.sql` — written last phase — contained its own `BEGIN; … COMMIT;`.
Executed inside the migration script's transaction, that embedded `COMMIT` ends
**the script's** transaction from the inside, so **`--dry-run` was committing,
not rolling back**. I repeated it in v17 and v18.

It stayed invisible because v16, v17 and v18 are fully idempotent — the "real"
run after each dry run re-applied harmlessly and reported success. v19 exposed it
because a table rename is not idempotent: the dry run renamed the table and
committed, and the real run then failed with *relation "event_proposals" does not
exist*.

Fixed by removing `BEGIN`/`COMMIT` from all four schema files, and **proved**
with a throwaway migration: a dry run now leaves the column absent, a real run
creates it.

### Schema cleanup

Every column was verified unread before it was touched, and the code that wrote
each counter was deleted in the same commit.

**Five denormalised counters, all written by code and read by nothing:**

| Column | Claimed | Real |
|---|---|---|
| `campaigns.raised_amount` | ৳3,442,532 | ৳5,000 settled |
| `campaigns.donors_count` | — | never reconciled |
| `chapters.members_count` | 41,994 | **0** memberships |
| `chapters.events_count` | 57 | never written by any code |
| `events.registered_count` | 83 | 4 confirmed registrations |

Six `UPDATE` statements went with them, one of which —
`GREATEST(1, members_count - 1)` — could never reach zero, guaranteeing
permanent drift by construction.

**Superseded date columns:** `events.event_date` and `events.event_time`, both
`VARCHAR` and populated on 7 of 21 rows, against `starts_on`/`start_time` which
are typed and populated on all 21.

**A defect I introduced in Phase 7C-3, found here:** the Event Attendance and
Ticket & Registration reports were written against `event_date`. They showed a
blank date for two thirds of events and filtered a string as a date. Both now use
`starts_on`.

**Also dropped:** `events.planning_mode` (no reference anywhere),
`mentorships.health_score` (nothing computes it).

**`event_proposals`: retained, not deleted.** One historical row, no code path
— its only caller was `API.moderateProposal`, whose route does not exist.
Renamed to `legacy_event_proposals` with a `COMMENT` recording why. Deleting an
institutional record because no code reads it is a retention decision, and not
this migration's to make.

**Kept, and worth naming:** `event_committees.members_count` is a different
table and still live. `campaigns.days_left` is written once at creation and read
with `created_at` to give a real end date — a duration, not a stale relative
date.

### A latent bug the phase surfaced

`alumni_profiles.student_id` is UNIQUE, and both import and registration
generated `DIC-<year>-<user id>`. The **seed** occupies the same namespace:
`DIC-2018-1001` and `DIC-2018-1008` belong to users **7** and **14**. Safe only
while `users.id` stayed below 1001 — and every rolled-back dry run burns ids
without creating rows, so the sequence climbed to 1046 during this phase's
testing and an ordinary import produced an id the seed already owned. The whole
batch failed with a 500 and a constraint name.

Pre-existing, latent since the seed was written, and reproduced deliberately by
forcing the sequence to 1000. `uniqueStudentId()` now checks and suffixes:
the collision that produced a 500 imports as `DIC-2018-1001-1`, seed untouched.

### Dead code removed

**Ten API client methods** with no caller: `getMyEvents`, `getEvent`,
`deleteEvent`, `runReminderSweep`, `getAdministrator`, `updateCampaign`,
`getPlannerList`, `updatePlannerItem`, `getImportHistoryV2` (a duplicate), and
`moderateProposal` — whose route never existed.

**Four frontend functions:** `goToStep1/2/3` (the `step-2` and `step-3` elements
they address do not exist in either portal) and `toggleProgressiveDisclosure`.

**`onSessionExpired` was on the first candidate list and was NOT removed.**
`api.js` calls it through `typeof onSessionExpired === 'function'`, which the
first scan missed because it only searched `js/*.js`. Removing it would have
broken session expiry silently. The suite now asserts it survives.

**Three shadowed definitions in `js/profile.js`:** `showEditProfile` (a toast
stub) and an earlier `showEditProfileV2`/`handleSaveProfileV2` pair, both
shadowed by later definitions in the same file. Worth removing rather than
leaving: the shadowed pair mutated a local object and closed the modal without
calling the server, so had it ever won, a member's edits would have vanished.

**§15 found no duplicate helpers to consolidate.** `formatDate`, `escapeHtml`,
`showToast`, `showModal`, `jsArg` and the render helpers are each defined once,
in `js/core.js`; `apiRequest` and `fetchWithTimeout` once in `api.js`; the CSV
writer once per side. Earlier phases had already done that work.

**§12 verified clean.** `pendingEvents` exists only in a comment saying it was
removed; `pending_events` is a real count over `events.approval_status`. One
event moderation path.

### Documentation

- **`DEPARTMENT_SCOPE.md`** — every resource classified GLOBAL or
  DEPARTMENT-SCOPED with the reason, the audit visibility matrix, and §16's
  people-search strategy.
- **`STATUS_VOCABULARY.md`** — every status column, its permitted values, UI
  label, meaning and allowed transitions. **Nothing was renamed.** The one real
  inconsistency — donation statuses are the platform's only UPPERCASE values —
  is documented rather than migrated, because those are financial records named
  in queries, reports, tests and the ledger export.

### Interface

Only where scope had to be shown or a capability would otherwise be unreachable:

- The Reports page states **"Department: CSE — every report below covers
  Computer Science & Engineering only"**, or warns when no department is
  assigned. An administrator is never asked to pick their own department.
- The administrator profile gained a **Governs** line, distinct from the
  free-text department label, which says plainly when a department admin has
  none and what that costs them.
- The edit form gained a real department selector beside the label.
- Sign-up gained an optional **Department** field, without which no department
  administrator could ever confirm a new graduate.
- The import wizard's column vocabulary gained **Department**.
- **Audit Logs became reachable by `dept_admin`** — the server grants a scoped
  read and the navigation did not offer it, which would have left the capability
  granted and hidden.

### Tests

```
29 suites                    2,425 passed, 0 failed
  of which phase7d_architecture_scope   128   (new)
  the 28 pre-existing suites          2,297   still 0 failed
install drill (fresh DB, v2..v19)      32 passed, 0 failed
audit chain                            PASS through 15,967 entries
```

`tests/phase7d_architecture_scope.js` covers A–Q: the relation and what was
deliberately not seeded into it, assignment and who may do it, fail-closed before
assignment, `unscoped` vs `none`, cross-department IDOR on `?id=`, scope that no
query parameter widens, CSV exports scoped like their JSON, event management
scoped while reading is not, imports that cannot cross a boundary, audit
visibility with a platform-security deny-list, institution-wide authority
retained, every dropped column, the retained proposal archive, every removed
method and function, and the status vocabularies checked against the document
that records them.

### Six assertions updated, none weakened

Each replacement is stricter than what it replaced:

| Suite | Was | Now |
|---|---|---|
| `qa1` | legacy `event_date` values preserved | the VARCHAR columns are gone **and** every event has a typed date |
| `qa1` | `dept` cannot read the audit log | `dept` reads a log that is strictly narrower **and** contains no security action |
| `phase5a` | `dept` cannot read the audit log | same stricter pair |
| `phase5d` | counters are labelled NOT A SOURCE OF TRUTH | the columns are gone **and** no code writes them |
| `phase7c1` | `dept` may operate the verification queue | it may not, for an account outside its department — the refusal is now asserted |
| `phase7c3` | a `dept_admin` cannot export the alumni directory | it can, scoped, and sees strictly fewer rows from a single department |

`security_smoke` gained `GET /api/departments/public` to its public allow-list —
a declaration, not a relaxation. The endpoint returns id, code and name for
active departments and deliberately **not** the per-department alumni count the
staff endpoint carries.

### Two mistakes of my own, found and corrected

**I over-corrected a test.** Updating `phase2b`/`phase2c` for the audit
envelope, I also moved their filtering server-side. That looked like an
improvement and was not: it widened the set to include each account's own
sign-in and self-registration, which legitimately have no actor, and broke a real
assertion about administrator actions taken *on* that account. Reverted to the
original semantics — accessor only.

**My first scope model would have locked out moderators.** Caught before any
route used it, by writing out the truth table for all six role/department
combinations rather than trusting the code read correctly.

### Mobile and accessibility

360 · 390 · 430 · 768 · 1024 · 1280 · 1440 across Reports, Audit Logs,
Administration and Directory: **no page overflow at any width**. The
22-column alumni report scrolls inside its own 315px container at 360. The scope
banner fits every width, carries `role="status"`, and no control on either new
surface is unlabelled.

### Database verification

18 users · 14 profiles · 21 events · 8 registrations · 37 ticket types · 3 jobs ·
1 application · 1 poll · 4 donations · 3 campaigns · 7 chapters · 99 places ·
4 departments · 1 retained proposal — every figure identical to the baseline.

Orphan checks: 0 orphan profiles, 0 orphan registrations, 0 dangling department
references across users, profiles and events, 0 user/profile department
disagreements, 0 duplicate student ids, 0 duplicate emails, 0 audit entries
missing a digest, 0 dangling notification deep-links.

48 tables: `departments` added; the proposal rename is net zero.

### Regressions

None. Nothing pre-existing was deleted, and no assertion was weakened.

One caught by the suite rather than by me: my new tests created an event and
deleted it, but `notifications` has no foreign key to `events`, so its
"awaiting approval" notices survived as dangling deep-links — which `qa1`
correctly reported. The suite's cleanup now removes them first.

### Limitations

- **The free-text `department` columns remain**, beside the relation. They are
  `NOT NULL`, several hold text no department could represent, and they are what
  a person reads. `department_id` is the authority for authorisation and the
  free text governs nothing. Merging them would mean either inventing
  departments or discarding real strings.
- **One alumnus has no department** — the imported account whose department
  column holds an HSC group. Institution-wide roles see them; no department
  admin does. There is no correct value to infer.
- **20 of 21 events belong to no department**, because `organizer_department` was
  blank or a test label on all but one. They are institution-wide, which is the
  honest reading, and a department administrator manages none of them.
- **A department administrator still cannot import.** Import remains
  `ADMIN_ROLES`. The row-level department scope check is enforced regardless, so
  the boundary holds if that ever changes.
- **Jobs are not department-scoped.** A job is open to every graduate, and
  `dept_admin` has no administrative power over jobs in any case.
- **Donation statuses stay UPPERCASE.** Documented, not migrated.
- **The people searches were not merged.** They answer different questions over
  different tables, and a DIC system user is not an external event contact. A
  future consolidation needs `event_people.user_id` first — a data-model change,
  not a UI one.
- **`install_drill` needs `DOCKER_PG_CONTAINER` set** to run against the Docker
  database; without it it falls back to a local `psql` that is not installed on
  this host. Pre-existing, and it is not in the `npm test` suite list.

### Next phase

**Phase 7E.** Not started.

---

## PHASE 7E — Final Full-System QA & Release Candidate

**Status:** **COMPLETE**
**Date:** 2026-09-08
**Commit:** `0a4710a`
**Parent:** `e9703e1`

### Baseline

```
commit e9703e1 · 29 suites · 2,425 passed · 0 failed
audit chain PASS through 16,607 entries
48 tables · 18 users · 14 profiles · 21 events · 3 jobs · 1 poll · 99 places
```

A data fingerprint — row count plus an md5 over the substance of 28 tables —
was taken before any testing and compared again at the end.

`phase65_provisioning` was flagged once on the first run and passed on every
subsequent one, the same intermittent Windows process exit that `portal` showed
in Phase 7D. Recorded rather than chased: it is the harness, not the suite.

### The release drill — the strongest result in this phase

`tests/phase7e_release_drill.js` (**107 passed, 0 failed**) creates an empty
PostgreSQL database and proves the platform can be not merely installed but
**used**: migrations through v19 → first administrator → forced password change
→ department administrator provisioned and scoped → two alumni registered into
different departments → cross-department verification refused, own-department
allowed → event → ticket types → two registrations against a capacity of two →
invalid, tampered and duplicate check-in scans → job, application, status
change → poll drafted, opened, voted, closed → mentorship → donation pledged and
**manually** settled → all ten reports → CSV with a BOM → import with a dry run
that writes nothing, a real import that matches it, and a rollback → eleven
audited actions → chain verification.

Nothing in it is inserted with SQL. Every record is created through the API an
operator would use, because the point is to prove the product works and not that
the tables accept rows.

### Findings, and what was done about each

**1. The authorization matrix was stale.** SECURITY_AUTHORIZATION_MATRIX.md
still read *"There is **no department scoping**: a dept_admin has
institution-wide authority at the moderator tier"* — which Phase 7D changed. It
is now **generated by the test suite** from 152 parsed routes and 420 observed
verdicts, so it cannot drift from the code again.

**2. The CSP protected framing and nothing else.** `frame-ancestors 'none'` was
the entire policy. Added `object-src 'none'`, `base-uri 'self'` and
`form-action 'self'` — three directives with no compatibility cost here, since
neither portal uses `<object>`, `<embed>` or `<base>`, and every form submits
through JavaScript to its own origin. **`script-src` remains absent and is
recorded as the known gap**, not quietly added with `'unsafe-inline'`, which
would look like a defence without being one.

**3. Thirteen icon-only buttons had no accessible name.** The administrator
table's row actions carried a `title` attribute and nothing else — a
last-resort accessible name, unreliable across screen readers and absent on
touch. Worse, the name was identical on every row: a reader heard "View, View,
View" with no way to tell which administrator. Each now carries an
`aria-label` naming the action **and** the person, and an explicit
`type="button"`.

**4. Broadcast fan-out was one database round-trip per recipient.** A loop
issuing a sequential `INSERT` for every member of the audience. Invisible
against fourteen development accounts; against the alumni body DIC actually has
it is thousands of sequential round-trips inside one request — slow enough to
time out, and leaving a broadcast half-delivered when it does. Replaced with a
single set-based `INSERT … SELECT unnest(...)`, which is also atomic: every
recipient gets it or none does. Verified: 14 reported, 14 written, 60ms.

**5. Test suites cleaned up what they created but not what their actions
produced.** Registering a probe account fires a role-targeted notification with
no `user_id`, so deleting the account cannot cascade it away; running an import
writes an `import_history` row no suite removed. Across every phase that had
accumulated **5,345 orphaned notifications and 447 import batches** against a
database holding 18 users. Cleanup extended in three suites, and the historical
residue removed — but only rows whose subject provably no longer exists: 4 of
the 4,532 orphaned notices named a real current account and were kept, as was
the one genuine institutional import record.

**6. Five stale documents.** "47 tables" and "migrations v2–v13" in
DIC_PRODUCTION_HANDOVER_CHECKLIST, PRODUCTION_PROVISIONING, OPERATIONS_RUNBOOK,
PRODUCTION_DEPLOYMENT_RUNBOOK, PRODUCTION_HANDOVER_CHECKLIST and
INDEPENDENT_SECURITY_REVIEW_CHECKLIST — now 48 tables and v2–v19. Historical
documents (PHASE_LOG, the Master Audit, POST_PHASE5B) were **not** rewritten.

**7. One dead alias.** `showEditProfile` delegated to `showEditProfileV2` and
nothing called it — the remains of the shadowed-stub removal in Phase 7D.

### Four of my own assertions were wrong, not the product

Worth recording, because each would have been read as a defect:

| Assertion | What it actually was |
|---|---|
| "the DSAR export carries no credential" | Matched the export's own sentence *saying* passwords are never exported. Zero fields in the payload are credentials. Rewritten to walk the payload's KEYS. |
| "a real ticket checks in" | The drill sent `code`; the API takes `ticketCode`. The invalid and tampered scans had been passing **for the wrong reason** — rejected for a missing field. |
| "the same member cannot vote twice" | Re-voting is a change of mind by design (`ON CONFLICT DO UPDATE`); the UNIQUE constraint is what guarantees one vote. The invariant is the row count, which is what the existing 7C-2 suite already asserted correctly. |
| "no renderer interpolates a record field unescaped" | Flagged `${a.id}`, `${p.total}` — numbers the server computed. Then, narrowed, flagged three real sites that are all safe: a two-line `showToast` (textContent), a string escaped at its insertion point, and a hardcoded local badge array. |

The XSS scan is now a **reviewed allow-list**: every interpolation of
attacker-controllable text is compared against sites that have been read and
found safe, with the reason recorded. Anything new fails, and the allowance
itself is checked for staleness so a fixed site cannot sit there forever.

### Cross-reference inventory (§22)

| Category | Count | Disposition |
|---|---|---|
| API methods with no caller | **0** | — |
| Dead frontend functions | **0** | after removing `showEditProfile` |
| UI handlers with no function — a button that would throw | **0** | — |
| API methods whose route is gone | **0** | — |
| Tables with no code reference | 1 | `legacy_event_proposals` — **KEEP**, retained history by decision |
| Columns with no code reference | 6 real | **DEFER** — coherent fields with no screen yet |

Ten flagged columns were scan gaps, not dead: `audit_chain.head_hash`,
`entry_count`, `audit_logs.actor_ref` and `deletion_requests.subject_label` are
used heavily by `audit_chain.js` and `jobs.js`, which my first inventory did not
read.

### Security results

420 authorization checks — 70 routes × 6 callers — **every one matching its
declared guard**. No role escalation in any direction. Department scope held
against `?id=`, `?department=`, `?departmentId=`, `?limit=`, `?eventId=`,
`format=csv` and import fields. No account enumeration. Sessions revoked by a
password change and by suspension, mid-session. Eleven hostile CSV payloads
neutralised including a DDE payload and Bengali text. Six forced failure modes
disclosed no PostgreSQL internals, stack traces, paths or secrets.

### Data integrity

**25 of 28 tables byte-identical** before and after the whole QA run. The three
that moved: `audit_logs` (append-only, 16,841 → 19,065), `import_history`
(418 → 3, test batches purged), `notifications` (5,048 → 1,269, orphaned test
notices purged). No business table changed — users, profiles, events, ticket
types, registrations, tasks, jobs, applications, referrals, polls, votes,
donations, campaigns, chapters, memberships, mentorships, places and departments
are all identical.

Orphan checks after cleanup: 0 across the board.

### Browser matrix

Both portals, 28 pages, seven viewports (360 · 390 · 430 · 768 · 1024 · 1280 ·
1440): **no overflow, no clipping, zero JavaScript errors**. One CLIPPED report
at 1280 was my probe checking only an element's immediate parent instead of
walking up for a scrolling ancestor — the table was inside `.table-scroll` and
behaving correctly.

### Tests

```
30 suites                        2,515 passed   0 failed   0 skipped
  of which phase7e_full_qa            88   (new)
  the 29 pre-existing suites       2,427   still 0 failed
fresh install drill                 32 passed   0 failed
full release drill                 107 passed   0 failed
audit chain                            PASS through 18,191 entries
```

Skipped is counted as skipped. There are none.

### Documentation

**RELEASE_CANDIDATE.md** written: build, architecture, supported features,
intentionally unavailable features, test results, security results with the
exact CSP wording, data integrity, browser results, known limitations, and
production prerequisites separated into ENGINEERING READY and EXTERNAL/DIC
REQUIRED. It does not claim deployment and it makes no legal-compliance claim.

SECURITY_AUTHORIZATION_MATRIX.md is now generated by the suite. Six documents
had stale table and migration counts corrected. Historical records were not
rewritten.

### Regressions

None. Nothing pre-existing was deleted and no assertion was weakened. Two
assertions were updated because this phase's own work made them stale — the 7D
`showEditProfile` count after removing the alias, and `security_smoke`'s public
route allow-list after adding `/api/departments/public` in 7D.

### Known limitations

Recorded in full in RELEASE_CANDIDATE.md §9. The ones that matter most:

- **`script-src` is absent from the CSP.** Inline event-handler attributes are
  the prerequisite; closing it is an architecture change, not a header change.
- **No skip-to-content link** (WCAG 2.4.1, Level A). Not added: Phase 7E
  restricts UI changes to three specific cases and this is none of them.
- **`test_e2e_crud.js` would fail if run** — it references columns Phase 7D
  dropped. Retained per the Master Audit's decision to keep it as historical
  tooling; excluded from any production image.
- One alumnus and 20 of 21 events belong to no department, honestly.

### Production blockers — all external

Hosting, VPS, domain, DNS, TLS, PostgreSQL instance, SMTP credentials, backup
destination and retention decision, monitoring destination, the four production
secrets, encryption-key escrow, named super-admin and emergency-recovery owners,
an independent security review, and College UAT. **No infrastructure value was
invented.**

### Stop conditions

None met. No critical vulnerability, no data leak, no broken login, no role
escalation, no broken Event or Ticket/QR path, no financial-integrity issue, no
broken DSAR or purge, no unexplained data mutation, no major mobile or
accessibility failure, and no test failure.

### Next phase

**Production provisioning and UAT**, once DIC supplies the external inputs. No
further engineering phase is planned.

---

## PHASE 7F — Profile Photo, Camera Capture & Cropping

**Status:** **COMPLETE**
**Date:** 2026-09-08
**Commit:** `7d35a86`
**Parent:** `0f10c0c`

### Current support before the phase

Audited before writing anything.

| Item | State |
|---|---|
| `users.photo_url` (text) | existed, written by administrator provisioning, **0 of 18 set** |
| `alumni_profiles.photo_url` (varchar 500) | existed, an editable profile field, rendered by event people, **0 of 14 set** |
| Any upload endpoint | **none** — no multer, no busboy, no multipart handling anywhere |
| Body limit | `bodyParser.json()` at the default 100 kb |
| Static serving | an **allow-list**: only a fixed set of files and `/js/`, `/assets/`. An uploads directory would 404 by default |
| Image library | none installed |
| A `photo` privacy field | **none.** Privacy covers `email`, `mobile` and `location` only |
| Avatar rendering | initials everywhere; only `js/events.js` rendered a `photo_url` as an `<img>` |

### Data model — no column was added

Both photo columns already existed and both were empty. They are kept apart
rather than merged because they belong to different things: an alumnus's photo
is part of their alumni profile, a staff account's is part of the account, and a
staff account has no `alumni_profiles` row at all. `/api/profile/me` gained
`COALESCE(ap.photo_url, u.photo_url) AS effective_photo_url` so the client does
not have to know which. **No migration was needed and none was written.**

### API

| Route | Guard | What it does |
|---|---|---|
| `POST /api/profile/photo` | `requireAuth` | decode, re-encode, store, record, delete the previous file |
| `DELETE /api/profile/photo` | `requireAuth` | clear the record, delete the file |
| `GET /api/profile/photo/:id` | `requireAuth` | serve the current version only |

The subject is **always** `req.user.uid`. There is no route that accepts a
subject id for writing, so there is no id to tamper with.

### Storage

Local disk under `UPLOAD_DIR`, defaulting to `./uploads/profile-photos`,
gitignored, and added to the never-resolve list beside `backups` and
`node_modules` so every `/uploads/…` path is a 404 whatever its extension.
No object store and no provider-specific code — none exists to point at, and
inventing one was out of scope. The directory is now named in
RELEASE_CANDIDATE.md as something a VPS backup must include, because it is on
disk and not in the database.

### Image processing — why the server re-encodes

Checking magic numbers would tell us a file *looks* like a JPEG. It would not
stop a JPEG carrying a payload after its end marker, or a polyglot that is a
valid image and a valid something-else. So every upload is decoded to a pixel
buffer with **jimp** and a new file is written from those pixels: the stored
bytes are bytes this process produced, not attacker bytes that passed a test.
EXIF, colour profiles, comment segments and trailing data are gone because they
were never carried across, and orientation is normalised because it is applied
during decode and then simply not written out.

`jimp` was chosen over `sharp` deliberately: it is pure JavaScript, so there is
no native build to fail on the eventual VPS.

**Limits, all enforced server-side:** 10 MB source, 8000 px maximum edge,
512×512 stored, JPEG quality 82. A transparent PNG is composited onto white
first — un-composited transparency becomes a black square in JPEG.

### Camera

`getUserMedia` with `facingMode: { ideal: 'user' }` — *ideal*, not *exact*, so
a laptop with one camera does not throw `OverconstrainedError`. Take Photo is
only offered where `mediaDevices.getUserMedia` exists. Permission refusal shows
exactly the wording §16 asks for and falls back to the file picker.

**The stream is stopped on every exit**, each one verified: capture, cancel,
save, the close button, Escape, one modal replacing another, the tab being
hidden, and the page going away. `showModal` gained an `onClose` hook to make
that possible — a small general addition, and the reason it was needed is that a
camera light left on after a modal closes is the kind of thing people notice.

### Crop

A square frame with drag (mouse and touch), a zoom slider, rotate left and
right, and reset. Keyboard reachable: the canvas is focusable, arrows nudge,
`+`/`-` zoom, `r` rotates. **No face detection and no automatic framing** —
where the crop sits is the member's decision. Nothing uploads until Save Photo
is pressed, and what is sent is exactly the canvas the member is looking at, so
the preview and the stored photo are the same image.

The client downscales anything over 1600 px before cropping: a 4000-pixel phone
photo redrawn on every drag event is what makes a crop UI feel broken on a
mid-range Android.

### Privacy

A photo is **exactly as visible as the profile it belongs to**: readable by any
signed-in member, and by nobody who is not signed in. That is what the directory
already does. **No new privacy level was invented for photos**, and no existing
one was changed.

### The design problem this phase had to solve

Photos are served by a route that requires a session — and **an `<img>` tag
cannot send a bearer token.** It sends cookies, and this platform has none. The
first working version had every avatar 401 and vanish through its own
`onerror` fallback.

Three options, and why the third won:

- **A public directory.** Exactly what §10 warns against.
- **A session-free signed URL.** A forwardable capability link to somebody's
  face.
- **Fetch with the token, display as an object URL.** No authentication change,
  no public directory, no capability link.

So avatars render with `data-photo-src`, and `hydrateAvatars()` fetches the
bytes with the session and swaps in an object URL. Each URL is fetched once per
page and released on unload. The visible cost is that a photo appears a moment
after the initials; the initials are what shows until then, and permanently if
the fetch fails.

### Two defects found and fixed during the phase

**Reset did not reset rotation.** It restored zoom and position and left the
photo sideways, which is not what anyone pressing "Reset" is asking for.

**The avatar wrapper would have clipped the verified badge.** `.verified-badge-icon`
sits at `bottom:-2px; right:-2px` — outside the avatar's own box — so
`overflow:hidden` on the wrapper would have cut the badge off every verified
member in the directory. The **image** is rounded instead, which is what needed
clipping in the first place.

### Also fixed, on the way

`npm audit` reported a moderate `qs` advisory. It came from `express` and
`body-parser`, **not** from the new dependency — it predated this phase.
`npm audit fix` cleared it: **0 vulnerabilities**.

### Avatar fallback

One helper, `avatarHtml()`, so the photo and the initials cannot disagree
between screens. The initials sit underneath and the photo on top; an image that
fails to load removes itself and reveals them. The profile page, the digital ID
card and the alumni directory render photos; every other surface keeps the
initials it already had. **No broken-image icon appears anywhere** — verified in
the browser.

### Security

Refused, each verified: a script, an SVG, HTML and an executable renamed as an
image; an SVG declared as PNG; a GIF; a truncated JPEG; an empty payload; a
path instead of a data URL; a number; nothing at all; and an 11 MB upload. Path
traversal is refused by a name guard that accepts only the exact generated
shape, and filenames are generated with 96 bits of randomness rather than taken
from the client. No refusal leaks a stack trace, a path, a PostgreSQL message or
a secret.

The larger body limit is mounted on the photo route **alone**; every other
endpoint keeps the 100 kb default.

### Tests

```
31 suites                     2,623 passed, 0 failed, 0 skipped
  of which phase7f_profile_photo   108   (new)
  the 30 pre-existing suites     2,515   unchanged, still 0 failed
```

`tests/phase7f_profile_photo.js` covers A–O: upload, canonical dimensions,
replacement leaving exactly one file, removal deleting it, unauthenticated
refusal on all three routes, IDOR through four different id fields in the body,
twelve hostile payloads, oversize, EXIF stripping proven on a JPEG that really
carries an EXIF marker, transparency compositing, static unreachability,
visibility, the camera fallbacks and every teardown path, the crop controls, and
the avatar fallback.

### Browser verification

Both portals. Chooser, crop, zoom, rotate, reset, save, replace, remove, and the
no-photo fallback at **360 · 390 · 430 · 768 · 1024 · 1280 · 1440**: no
overflow, the crop stage square at every width, the modal fitting the viewport,
and zero JavaScript errors. The permission-denied path was verified by stubbing
`getUserMedia` to reject with `NotAllowedError`: the specified message appears
and the capture button is disabled.

### Real-device verification status

**Camera capture has NOT been tested against real camera hardware.**
`getUserMedia` needs a browser, a device and a person granting permission, and
none of those exist here. What was verified is everything around it — the
fallbacks, the permission-denied path, and every stream-teardown path, the last
using a **stubbed** MediaStream that records `stop()` on each track. Live
capture from a phone camera should be part of College UAT and is recorded as
such in RELEASE_CANDIDATE.md.

### Limitations

- **Camera capture unverified on real hardware** (above).
- **A photo appears a moment after the initials**, because it is fetched with
  the session rather than by `<img src>`.
- **Storage is local disk.** `UPLOAD_DIR` is configurable; there is no object
  store, and the directory must be included in a VPS backup.
- **Only profile photos are uploadable.** Event cover images and the imported
  photo field remain URLs; this phase added no general file upload.
- **The administrator form still sets an external photo URL** on staff
  accounts. That is the policy that already existed and nothing here widened it;
  such a URL is cleared from a profile on removal but never deleted from
  wherever it lives.
- **A pre-existing quirk, noticed but not changed:** `/api/profile/me` selects
  `u.id` and then `ap.*`, so `id` in that payload is the profile row id, not
  the user id. Nothing in this phase depends on it, and changing a response
  shape was out of scope.

### Next phase

**Production provisioning and UAT**, once DIC supplies the external inputs in
RELEASE_CANDIDATE.md §10. No further engineering phase is planned.

---

## PHASE 7G — Real Visible Map & Global Modal Reliability

**Status:** **COMPLETE**
**Date:** 2026-09-08
**Commit:** `dd2a098`
**Parent:** `fd2c8f1`

Two user-facing complaints, both fixed. The second turned out to be a single
CSS bug that broke every dialog in the application on a phone.

---

## PART A — THE MAP

### The original limitation

The map drew an equirectangular **graticule** — meridians and parallels — and
alumni badges on top. Every position was correct, and Phase 7B had recorded
honestly why there were no outlines: the project held no boundary dataset, and
*"a coastline drawn from memory would be inventing geography"*.

That was the right call at the time. It also left a reader looking at numbered
grid lines and asking which country a badge was in — a question almost nobody
can answer from meridians.

### Geometry: source and licence

**Natural Earth**, 1:110m and 1:10m Admin 0 – Countries. **Public domain** —
no attribution requirement, no share-alike, no redistribution restriction.
Obtained through `world-atlas@2.0.2` (ISC), which is a redistribution of
Natural Earth.

Rejected: **GADM** (forbids commercial redistribution) and **OSM-derived**
district boundaries (ODbL adds attribution and share-alike this project does not
otherwise carry).

`tools/build_geo.js` converts it once at build time to
`assets/geo/boundaries.json` — **78 KB**, 4,211 world points from 10,587 and a
737-point Bangladesh from 2,257, via rounding, ring filtering and
Douglas–Peucker. Both source packages are `devDependencies` and **never ship**.

### Implementation

The rings are plain longitude/latitude and are projected by the **same
`projectLatLng()`** that positions the alumni badges. Boundaries and markers
therefore cannot drift apart — one projection, not two that resemble each other.
Verified against five countries' independently known bounding boxes.

**No mapping library, no tiles, no API key, no external request.** Asserted.

**World view** — every country outlined and filled pale, badges on top, country
names from 2× zoom and only where the label fits inside the country. Rings whose
projected bounding box is entirely off-canvas are skipped, so a 16× pan builds
45 paths rather than 166.

**Bangladesh view** — a new control frames the country (at 8×; the closure
pass below raised this to 16×) on its real
geographic centre and swaps the coarse outline for the **1:10m** one: 737 points
instead of 18, which is the difference between a recognisable country and a
five-sided blob. Neighbours stay drawn and labelled, so the country sits in its
region.

`GET /api/stats/map` gained a **divisions** rollup behind the same privacy gate
as the city and country layers.

### Division boundaries are not drawn, deliberately

> **SUPERSEDED by the closure pass below.** The premise of this section — that
> no licensable division or district geometry existed — was **wrong**. It was
> reached after rejecting GADM and OSM/ODbL without examining geoBoundaries,
> which publishes both layers under CC0 and CC BY 3.0 IGO. Real boundaries now
> ship. The reasoning is left standing because the conclusion it reached was
> acted on, and because "we looked and found nothing" and "we did not look
> everywhere" are different statements and this was the second one.

No division or district polygon dataset was available under a licence this
project can carry. A division is therefore a **labelled badge at the
alumni-weighted mean of the real city coordinates** the database holds for it —
a statement about where a division's alumni are, not a claim about where its
border runs. Drawing one from memory would have been the exact defect the
location work exists to remove.

### Privacy — unchanged

`MAP_VISIBLE_SQL` is still `location = 'public'`, gating all three rollups.
Location still carries **no staff bypass**. The suite proves it: flipping one
member to private removes them from the city layer and the division rollup, and
the fixture is restored exactly. No exact home coordinate exists anywhere — a
member picks a city and the map plots the city.

The real data is one mapped alumnus, in Chattogram. The map says so.

---

## PART B — MODAL RELIABILITY

### The inventory

| | |
|---|---|
| Dialogs opened through `showModal`/`openModal` | 50 functions across 13 files |
| `.modal-close` buttons | 45, **none with an `onclick`** — all rely on one delegated handler |
| Separate close functions | `closeModal`, `closePhotoEditor`, `closeEventWorkspace`, `closeNotifications`, `closeMapDetail` |
| Modal systems | **One.** `openModal` is an alias for `showModal` |
| Overlays per portal | Exactly one |

### The bug, and why every X "did not work"

The delegated handler was fine. Every close button worked under a synthetic
click, at every desktop width. The report was still correct.

**Below 900px every dialog is a bottom sheet**, and its slide-up animation ran
`from { transform: translateY(100%) }` — the sheet began a **full sheet-height
below the viewport**, and the animation was the only thing that ever brought it
into view.

That made a decoration load-bearing. Whenever the animation did not complete —
a dialog opened while the tab was backgrounded, any engine that throttles or
freezes animation clocks, a compositor that never advances — the sheet stayed
parked off the bottom of the screen. Measured on a 390×844 viewport: dialog top
at **894px**, close button at **894px**, `elementFromPoint` at the button's
centre returning **nothing at all**. The dialog existed, the backdrop was dim,
and every X and Cancel was unreachable because it was not on the screen.

On a phone that is every dialog in the application, which is exactly what was
reported. Desktop was unaffected — the animation only exists below 900px —
which is why it survived every previous phase's testing.

**The fix.** The animation now travels **24px** and carries `both`, the resting
transform is declared rather than left to the animation to supply, and the
reduced-motion block states `transform: none !important` for `.modal-content`.
The dialog is in its correct place with no animation at all; the motion is a
garnish. A frozen animation now costs 24 pixels instead of the whole dialog.

Measured after the fix on the same viewport: dialog top **315px**, close button
**354px**, hit test resolves to the button, and clicking whatever is topmost at
its centre closes it. Confirmed at 360 and 390 across the poll editor, the
delete confirmation, the administrator dialogs and the photo chooser.

### Also fixed

- **Seven buttons** with no explicit `type` — two Cancels in
  `administration.js`, four action buttons in `events.js`, one in
  `profile.js`. None sat inside a `<form>` today, so none was submitting; all
  are now `type="button"` so none can start.
- **A heavy dark sheet shadow** — `rgba(0,0,0,0.8)`, a leftover from the dark
  era on a platform that has been light since Phase 7A.

### Verified, and left alone

The contract Phase 7A established still holds and is now asserted: one delegated
handler that survives every re-render and works on the icon inside the button;
Escape closes; the backdrop closes **only** dialogs that opt in, so a
data-entry form is never dismissed by a stray click; focus moves into the dialog
and returns to the opener; Tab is trapped; `role="dialog"` and `aria-modal`;
closing hides one overlay rather than removing every `.modal`; and a dialog's
`onClose` teardown runs however it is closed — which is what stops a camera
stream outliving its dialog.

---

## Tests

```
32 suites                     2,695 passed, 0 failed
  of which phase7g_modals          72   (new)
  the 31 pre-existing suites    2,623   still 0 failed
```

`tests/phase7g_modals.js` covers A1–A6 and B1–B7: the geometry's source,
licence, size and dev-only packaging; five countries checked against known
bounding boxes; the absence of every mapping library, tile URL and API key;
city and division counts compared against their own SQL; privacy proven by
flipping a member to private and back; and on the modal side the CSS invariant
that a dialog's resting position does not depend on an animation, every close
control typed and labelled, the delegated handler, Escape, the opt-in backdrop,
close scoping, and the teardown hook.

### Two assertions re-expressed, neither weakened

`phase7b_location` asserted the literal ternary
`${mapMode === 'countries' ? 'country' : 'city'}`, which this phase replaced
with `mapUnitName()` when a third level arrived. It now checks the property —
that an empty search and an empty map say different things — which is what it
was always for and is stricter for having a third level.

`phase7e_full_qa`'s reviewed-safe XSS allowance listed `dashboard.js:
${first.city}`; this phase removed that interpolation entirely, so the
staleness check fired exactly as designed and the entry was deleted.

## Browser verification

Alumni and staff portals at **360 · 390 · 430 · 768 · 1024 · 1280 · 1440**: no
page overflow, map canvas and controls within the viewport at every width,
legend and ranked list present, and **zero JavaScript errors**. The world view
draws 166 country paths; zoomed 4× it draws 45 and labels 24. The Bangladesh
view draws the detailed outline plus named neighbours — India, Nepal, Bhutan,
Myanmar, Pakistan — with the Chattogram badge in the correct place.

## Regressions

None. Nothing pre-existing was deleted and no assertion was weakened.

## Limitations

- ~~**No division or district boundaries**~~ — **resolved in the closure
  pass**: 8 divisions and 64 districts now ship as real geometry. What remains
  absent is the level below them, upazilas.
- **No satellite imagery, streets, routing or live GPS**, and none was asked
  for.
- **Equirectangular distorts area** toward the poles.
- **Only public locations appear on the map.** With the default of `alumni`,
  most members are absent until they choose otherwise; the note under the map
  says how many and why.
- **The world outline is 1:110m** — small islands are absent by design.
- **Country labels appear from 2× zoom** and only where they fit.

---

# PHASE 7G CLOSURE PASS

**Status:** **COMPLETE**
**Date:** 2026-09-08
**Commit:** `8d6c461`
**Scope:** verification of three surfaces the phase had claimed but not proven,
plus one conclusion it had reached wrongly. Not a new phase; no redesign.

Also recorded here: **`cf3aaad`**, a post-completion corrective commit that
removed four chromatic glow shadows left over from the dark theme. No ignores
were persisted; zero-blur focus rings and the crop-ring scrim were deliberately
left alone.

## 1. The notification drawer close button

**The user's screenshot was right, and the button was not broken.** It closed
correctly under a synthetic click at every width. It was **18×21px**, untyped
and unlabelled, in the corner of the screen — while `.notif-readall` beside it
already carried a 44px minimum on mobile. A target that small is one a finger
misses more often than it hits, and a control you cannot reliably hit is
indistinguishable from one that does not work.

Now **44×44**, `type="button"`, `aria-label="Close notifications"`, a visible
`:focus-visible` ring, `touch-action: manipulation`, in both portals. Escape
closes the drawer too, registered once behind `__notifEscapeWired` and
deferring to an open dialog so one key press never closes two things.

Verified by **`elementFromPoint` hit-testing at the target's centre** — not
`element.click()` — at **360 · 390 · 430 · 768 · 1024 · 1280 · 1440**, on first
open, second open, after navigation, after mark-all-read, by Escape, and by
keyboard focus and activation. One Escape produces exactly one close.

One intermediate reading of `reachable: false` at 1024 was traced to **test
residue** — a profile dialog left open by an earlier probe — not to a product
defect. `.hidden` is `display: none !important`, so a closed overlay cannot
intercept a click. The helper now closes any open dialog first.

## 2. Mouse wheel zoom

**The map had no wheel handler at all**, and no touch handler either. The
controls were the +/− buttons alone. Both gestures were implemented.

Wheel zoom is **stepped and anchored at the pointer**. Deltas accumulate to a
120-unit threshold so a trackpad flick steps once instead of racing from world
to 16×. The listener is non-passive and calls `preventDefault`, so the page
does not scroll while the pointer is over the map.

Verified: 1× → 2× → 4× → 2×; a trackpad flick steps exactly once;
`wheelPrevented: true` over the canvas; wheeling **outside** the map leaves the
zoom unchanged and prevents nothing; and after four page navigations one notch
is still exactly one step, which is what the `gesturesWired` guard exists for.

## 3. Touch / pinch zoom

Two-finger pinch steps in at a span ratio of 1.35 and out at 0.74, anchored
between the fingers, with the baseline reset after each step so a long pinch
keeps stepping. `touch-action: none` on the canvas stops the browser panning
the page mid-gesture.

Verified at **390, 430 and 768**: an instrumented trace shows 1× → 2× at ratio
2.33, → 4× at 1.43, and **no step** at 1.10 — one step per threshold crossing,
never a run. An earlier anomalous reading of 4× → 16× was traced to two
touchmoves on leftover state, not a defect.

**Touch zoom implementation verified in browser emulation; physical device not
yet verified.**

## 4. Bangladesh detail — the phase's conclusion was wrong

Phase 7G recorded that no licensable division or district geometry existed. It
had rejected **GADM** (no commercial redistribution) and **OSM/ODbL**
(attribution *and* share-alike) and stopped there.

**geoBoundaries gbOpen** publishes both layers openly, and now ships:

| Layer | Features | Licence | Authority | Year |
|---|---|---|---|---|
| ADM1 divisions | **8** | **CC0 1.0** | geoBoundaries / Wikimedia Commons | 2015 |
| ADM2 districts | **64** | **CC BY 3.0 IGO** | Bangladesh Bureau of Statistics / OCHA ROAP | 2020 |

Both allow commercial use and redistribution; **neither carries share-alike**,
which is what ruled the others out. Attribution is required and is rendered
under the map.

The licence was read from the **geoBoundaries API**, not from a repackager —
which mattered, because the npm package `bd-geojson` redistributes the same
data and gives three inconsistent answers about its licence (a blanket ODbL
file, metadata claiming CC BY 4.0, against the API's CC BY 3.0 IGO). It was not
used; `tools/build_geo.js` fetches from the pinned upstream commit `9469f09`.

**No district borders were faked, and none were drawn from memory.**

The build kept 1,027 of 2,060 division points and 3,400 of 38,112 district
points at a 0.015° tolerance — 0.6px at the deepest zoom step, so below a pixel.
The asset grew 78 KB → **149 KB**, against a pre-existing 250 KB budget that was
not relaxed.

Names were reconciled toward the data, never the reverse: Chittagong →
Chattogram, Barisal → Barishal, Comilla → Cumilla, Jessore → Jashore, Bogra →
Bogura, Maulvibazar → Moulvibazar, plus two source misspellings (`Rajshani`,
`Brahamanbaria`).

**The proof that the geometry is real**: all **30** Bangladeshi cities in
`location_places` fall geometrically **inside their own recorded district**.
The polygons and the alumni data come from unrelated sources, so agreement
between them is evidence rather than a restatement — and a rename that silently
never matched would surface here as a miss instead of a blank on the map.

A district is tinted only where alumni are actually recorded, from the same
server-counted rows that position the badges. The real data is one alumnus in
Chattogram; exactly one district is tinted.

**The view also had the wrong zoom.** The phase framed Bangladesh at 8× on the
stated grounds that at 16× the country is "wider than the canvas". Measured,
it is not: at 16× the projected bounding box sits fully inside the 900×450
viewBox at 20% width and 52% height, against 10% and 26% at 8×. Raised to 16×,
which is what makes 64 district boundaries legible.

## 5. The notification drawer sat on top of every dialog

Found while re-running the modal regression across all dialog families, which
is exactly what that sweep is for.

The drawer and the modal overlay **both sit at `z-index: 2000`**, and the
drawer comes second in the document — so it wins the tie and paints over any
dialog opened while it is showing. Below 900px the drawer is full-screen, so
the dialog underneath was not merely overlapped but **completely unreachable**:
at 390px, hit-testing the dialog's close button returned `notif-item-title`,
and the middle of the dialog body returned `notif-item-time`. A dialog nobody
can see or dismiss, over a page nobody can get back to.

At 1280px the drawer is a 360px right-hand panel and the dialog's close button
falls clear of it, which is why desktop testing never showed this.

Tapping a notification already called `closeNotifications()` on its way to a
deep link, so the common path was safe. Any other route that opened a dialog
while the drawer was up was not — a forced password change, or a session
expiry, would have produced a dead screen.

**Fix:** `showModal()` closes the drawer. A dialog is the topmost surface by
definition, so nothing else should be above it. One call, every path fixed.
Verified at 375px on both portals: the drawer closes, and the close button and
the dialog body are both hit-testable again.

## 6. Also fixed

- **Map control labels broke mid-word** at 375px — "Focu s", "Banglades h",
  "Worl d" — because the flex row had no `white-space` rule. Pre-existing, on
  the controls §7 covers, and fixed with `flex-wrap` on the row and
  `white-space: nowrap` on the buttons.
- **`tests/phase65_provisioning.js` aborted the process on Windows** after all
  57 of its assertions had passed — `process.exit()` ran while a pg socket was
  mid-close, tripping a libuv assertion, so `run-all` recorded a failure for a
  suite that had none. Confirmed pre-existing at `HEAD` before changing it.
  Fixed by closing the pool and letting the close settle.
- **Two comments in `/api/stats/map` asserted that the project holds no
  boundary geometry.** True when written, false once it did; corrected rather
  than left to drift.

## Tests

```
32 suites                     2,726 passed, 0 failed
  phase7g_modals                110   (was 72; +38 for the closure pass)
  phase65_provisioning           57   now exits 0, having always passed
```

The 38 new assertions cover the drawer's 44×44 typed and labelled control and
its guarded Escape; the wheel and pinch handlers, their non-passive
registration and the duplicate-listener guard; and the geometry's feature
counts, recorded licence, pinned upstream, rendered attribution, complete name
resolution against `location_places`, and the point-in-district check — plus
the drawer/dialog layering, asserted both ways: that `showModal` closes the
drawer, and that the two really do share a stacking layer, so the assertion
fails loudly if someone "fixes" the z-index instead and leaves the close in
place unexplained.

**Every dialog family in the closure brief was re-driven in a real browser** at
375px across both portals — photo chooser and editor, change password, edit
profile, delete account, donate, campaign, post job, referral, create chapter,
create news, poll editor, administrator creation, event wizard, broadcast and
the event planner forms. For each: the close control hit-tested at its centre,
the dialog on screen, Escape, reopen, and — for data-entry forms — that a
backdrop click does **not** dismiss them. Destructive openers
(`confirmAccountDeletion`, `confirmImportRollback`,
`confirmResetAdministratorPassword`, `showTemporaryPassword`) were
deliberately excluded rather than called; the account and the audit trail were
checked afterwards and nothing was modified.

`phase65_provisioning` reports **3 skipped**, which are not counted as passed.

**No assertion was weakened, and nothing pre-existing was deleted.**

## Limitations

- **Touch zoom is emulation-verified only**, as stated above.
- **No upazila boundaries.** geoBoundaries publishes ADM3, so this is a size
  and usefulness judgement, not a licensing one.
- **District boundaries are 2020 vintage**, divisions 2015. Administrative
  boundaries change; these are not live.
- The map now carries an **attribution obligation** it did not have before.
  It is rendered under the map and asserted by the suite, but it is a
  standing obligation rather than a one-off task.

## Next phase

**Production provisioning and UAT**, once DIC supplies the external inputs in
RELEASE_CANDIDATE.md §10. No further engineering phase is planned.
