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
**Commit:** `PHASE_5A_COMMIT`
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
