# Post-Phase-5B whole-system audit (Phase 5C)

**Type:** read-only audit. No application code, schema, migration or business
data was changed. The only files written are this document and `PHASE_LOG.md`.
**Date:** 2026-09-02
**Baseline audited:** commit `5cfbc5e` (Phase 5B + map follow-up)
**Method:** repository and schema inspection; a 138-route guard extraction; a
live 6-role × 29-endpoint authorization matrix; IDOR, injection and parameter
tampering probes; a table- and column-level dead-code sweep; a data-honesty
sweep against the database; the full regression battery; and browser inspection
of both portals at six widths.

**One disclosed side effect.** Establishing the role matrix required signing in
as all five roles, which stamps `last_login_at` and resets failed-login counters
on those seeded accounts. The rate-limit probe recorded five failed sign-ins for
a non-existent address. Nothing else was written.

---

## Executive summary

The platform is in materially better condition than the Master Audit described.
Every headline defect that audit raised — client-chosen donation success, fake
paid tickets, an unimplemented deletion purge, an absent scheduler, missing
backups, undelivered password resets, fail-open QR signing, a disconnected
Connections feature, unsaved privacy settings, a fake Developer API, wallet
theatre, hardcoded metrics, duplicated event moderation — is **resolved and
verified live**, not merely claimed. Authorization is genuinely sound: 36 of 36
IDOR, privilege-escalation, injection and tampering probes behaved correctly,
and no endpoint leaked data across a role boundary.

That said, this audit found **one P0 security defect that no previous phase
caught**, and it is serious: the bulk-import preview renders CSV field values as
live HTML in the administrator's session. A malicious roster file executes
script with administrator privileges. Nothing in the codebase escapes those
fifteen interpolations.

It also found that the **README describes a substantially different product**
than the one that exists — twenty-one profile fields and three privacy levels
that have no columns and no code. Phase 3 corrected the README's payment and
production claims; its feature list was never revisited.

**Readiness: NOT READY for handover — two blocking items.** Fix the import XSS,
correct the README, and the remaining gap is the set of institutional
dependencies DIC must supply (SMTP, domains, secrets, hosting), which are
already documented and are not engineering work.

| | Count |
|---|---|
| Total findings | **24** |
| P0 — production/security blocker | **2** |
| P1 — major correctness/functionality | **6** |
| P2 — important UX/maintainability | **10** |
| P3 — optional improvement | **6** |
| Security blockers | 1 (`P5C-001`) |
| Production blockers | 2 (`P5C-001`, `P5C-002`) |
| Fake / misleading systems | 2 |
| Dead / unused | 4 |
| Missing (backend without UI) | 4 |
| Old Master Audit findings resolved | 17 of 18 |
| Newly discovered | 12 |

---

## Current architecture (verified, not assumed)

| Layer | Reality |
|---|---|
| Frontend | Vanilla JS, no framework or bundler. 17 modules in `js/`, one shared global scope, classic `<script>` tags. Two shells: `index.html` (alumni), `admin.html` (staff). |
| Backend | Express 5, six route files, **138 routes**. |
| Auth | HMAC-SHA256 bearer tokens with `token_version` revocation. No cookies, no JWT. |
| Database | PostgreSQL 16, **47 tables**, `alumni_profiles` at 64 columns. |
| Migrations | `schema.sql` base + v2–v13, additive, idempotent, each with a `--dry-run`. |
| Guards | 62 `requireAuth`, 41 `requireRole(MODERATOR_ROLES)`, 20 `ADMIN_ROLES`, 7 `SUPER_ONLY`, 2 `requireScheduler`, 6 intentionally public. |
| Audit | Hash-chained, verifiable from the database; 852 entries verified at audit time. |
| Location | `location_places` (99 cities with coordinates) + `place_id`; coordinates never on a person. |
| Scheduler | One, `vercel.json` crons or `ops/cron-dic.sh`. Three jobs, all observed running. |
| External deps | `body-parser, cors, express, nodemailer, pg`. Browser: chart.js, qrcodejs, lucide, Google Fonts. **No map provider.** |

---

## Subsystem status

| # | Subsystem | Status | Evidence |
|---|---|---|---|
| 1 | Authentication & authorization | **REAL / WORKING** | 6×29 role matrix behaved correctly throughout |
| 2 | Session/token security | **REAL / WORKING** | `token_version` revocation; Phase 2C suite 72/0 |
| 3 | Password recovery/change | **REAL / PARTIAL** | Hashed single-use token, 30-min expiry. Delivery depends on SMTP, unset in dev (`mail.mode = "console"`) |
| 4 | Suspension/deactivation | **REAL / WORKING** | Suspended account refused at login and in `attachUser` |
| 5 | RBAC & admin boundaries | **REAL / WORKING** | `ADMIN_ACCOUNTS` super-only; moderator correctly refused audit/compliance/ops |
| 6 | Alumni profiles | **REAL / WORKING** | 64 columns; `GET /api/profile/me` self-only |
| 7 | Location & privacy | **REAL / WORKING** | Phase 5B; 142-check suite; three levels genuinely differ |
| 8 | Alumni directory | **REAL / WORKING** | Structured filters; `limit` capped at 100, negative `offset` clamped |
| 9 | Connections | **REAL / WORKING** | Real rows; 409 reconcile path present |
| 10 | Events | **REAL / WORKING** | Capacity enforced by live `COUNT(*)`, not the stale counter |
| 11 | Event approval/moderation | **REAL / WORKING** | Single path; duplication resolved |
| 12 | Event tasks/planning | **REAL / WORKING** | `routes_planner.js`; partial UI (see `P5C-011`) |
| 13 | Tickets/registration/check-in | **REAL / WORKING** | HMAC QR, fails closed without a key |
| 14 | Payments/donations | **REAL / PARTIAL** | Pledge ledger only, honestly labelled. No gateway — a scope decision, not a defect |
| 15 | Jobs | **REAL / PARTIAL** | No edit UI (`P5C-008`) |
| 16 | Mentorship | **REAL / WORKING** | Real rows, expiry job runs |
| 17 | Chapters | **REAL / PARTIAL** | No structured location; stale counter (`P5C-009`) |
| 18 | Polls | **REAL / WORKING** | `polls_active` from the database |
| 19 | Notifications | **REAL / WORKING** | Live badge; placeholder flash (`P5C-018`) |
| 20 | Broadcasts | **REAL / WORKING** | Audience size from a real count |
| 21 | Search/filtering | **REAL / WORKING** | Parameterised; injection probes returned 0 rows |
| 22 | Reports/analytics | **REAL / WORKING** | 78 source-truth metrics reconcile |
| 23 | CSV import/export | **SECURITY RISK** | `P5C-001` |
| 24 | Audit logs | **REAL / WORKING** | Chain verified through 852 entries |
| 25 | Compliance/privacy | **REAL / WORKING** | Vault AES-256-GCM, fails closed; consent logged |
| 26 | Retention/deletion | **REAL / WORKING** | Purge observed erasing user #172 |
| 27 | Scheduled jobs | **REAL / WORKING** | 3 jobs, `source: "cron"`, 0 failures in 7 days |
| 28 | Backups/restore | **REAL / WORKING** | 630 KB dump, 0.5 h old, not stale; restore drill exists |
| 29 | Monitoring/health | **REAL / WORKING** | `/api/health` contract; panel honest in all three states |
| 30 | Production configuration | **REAL / PARTIAL** | Refuses to boot without secrets; DIC inputs outstanding |
| 31 | CORS/host/origin | **REAL / WORKING** | Allow-list from `PUBLIC_ORIGIN`/`ADMIN_ORIGIN` |
| 32 | API authorization / IDOR | **REAL / WORKING** | 36/36 probes correct |
| 33 | Input validation | **REAL / PARTIAL** | Server-side solid; client render unescaped (`P5C-001`) |
| 34 | Rate limiting | **REAL / WORKING** | 429 from the 6th failed sign-in, verified live |
| 35 | CSRF/XSS/injection | **SECURITY RISK** | SQL safe; **XSS present** (`P5C-001`) |
| 36 | Database integrity | **REAL / WORKING** | FKs correct; `actor_ref` deliberately unconstrained |
| 37 | Stale/dead columns | **DEAD / UNUSED** | `P5C-009` |
| 38 | Duplicate systems | **REAL / WORKING** | None found; moderation and map both single-path |
| 39 | Fake/mock/demo | **REAL / WORKING** | `Math.random` only in removal comments; no tickers |
| 40 | Frontend without backend | **REAL / WORKING** | None found |
| 41 | Backend without UI | **MISSING** | `P5C-008`, `P5C-010`, `P5C-011`, `P5C-012` |
| 42 | Broken/dead buttons | **REAL / WORKING** | None; every `showPage` target resolves |
| 43 | Mobile responsiveness | **REAL / PARTIAL** | No overflow at any width; one unreachable chip (`P5C-013`) |
| 44 | Accessibility | **REAL / PARTIAL** | `P5C-014`, `P5C-015`, `P5C-016` |
| 45 | UI consistency | **REAL / WORKING** | One design system; map now light like the rest |
| 46 | Admin portal | **REAL / WORKING** | 15 pages, no overflow at 1280 or 360, zero console errors |
| 47 | Alumni portal | **REAL / WORKING** | 11 pages, same |
| 48 | Cross-portal authorization | **REAL / WORKING** | Alumni token refused at `/admin` and cleared |
| 49 | Documentation accuracy | **FAKE / MISLEADING** | `P5C-002` |
| 50 | Deployment readiness | **REAL / PARTIAL** | Blocked by `P5C-001`, `P5C-002` and DIC inputs |

---

## Findings

### P0 — production / security blockers

#### P5C-001 — Stored XSS in the bulk-import preview (admin session)
- **Status:** SECURITY RISK · **Severity:** Critical
- **Current behavior:** `renderWizardStepContent()` renders CSV field values
  directly into `innerHTML` with no escaping. **Fifteen** interpolations across
  the valid, duplicate and invalid preview tables; **zero** use `escapeHtml`.
- **Evidence:** `js/admin.js:717-722` (valid), `729-736` (duplicate), `741-748`
  (invalid). Proved live in the staff portal: a record whose `name` was
  `<em id="p5c-marker">INJECTED</em>` produced a **live DOM element**, not text.
  (`markerBecameElement: true`.) A benign `<em>` was used deliberately; no
  script was executed.
- **User impact:** An administrator previewing a roster runs whatever markup the
  file contains.
- **Security impact:** Script executes in an ADMIN_ROLES session holding a
  bearer token that can provision administrators, read the audit log, reveal
  identity-vault records and export alumni data. Rosters routinely arrive from
  departments and third parties, so an untrusted CSV is the normal case, not an
  exotic one.
- **Recommended action:** Wrap every record field in `escapeHtml`, and add a
  regression test asserting that markup in an imported field renders as text.
- **Disposition:** **FIXED** — immediately, ahead of any other work.
- **Dependency:** None.

#### P5C-002 — README documents a product that does not exist
- **Status:** FAKE / MISLEADING · **Severity:** High
- **Current behavior:** `README.md` §2 advertises Cover Photo, Resume/CV Upload,
  Portfolio, Previous Companies, Instagram, YouTube, Behance, Dribbble, Medium,
  Kaggle, Stack Overflow, Soft Skills, Languages, Hobbies, Sports, Volunteer
  Work, Areas of Interest, and four separate verification badges. It also claims
  privacy levels **"Same Batch", "Connections", "Teachers"**.
- **Evidence:** All 21 claimed columns checked against
  `information_schema.columns` — **0 of 21 exist** among the 64 real columns.
  `privacy.js` defines three fields (`email`, `mobile`, `location`) and levels
  `public`/`alumni`/`private`; no batch, connection or teacher scoping exists
  anywhere.
- **User impact:** DIC evaluates and accepts the platform against this document.
- **Security impact:** Indirect but real — a reader concludes granular privacy
  scoping exists and plans data handling around it.
- **Recommended action:** Rewrite §2 and §9 to the fields and levels that exist.
  Phase 3 corrected this file's payment and production claims; the feature list
  was not revisited and should have been.
- **Disposition:** **FIXED**.
- **Dependency:** None.

### P1 — major correctness / functionality

#### P5C-003 — `GET /api/stories` is unauthenticated and exposes author identity
- **Status:** SECURITY RISK · **Severity:** Moderate
- **Current behavior:** The only data endpoint reachable without a session. It
  runs `SELECT *`, returning `author_id` and `author_name`.
- **Evidence:** `server.js:1482`; live probe returned 200 anonymously with
  `"author_id"` and `"author_name"` present. Every other data route returns 401.
- **Security impact:** Internal user ids and names published to the internet —
  contrary to the PII discipline Phase 5A established everywhere else.
- **Recommended action:** Either require auth (consistent with the rest of the
  product) or select an explicit column list excluding `author_id`, if a public
  news feed is intended. **The intent should be stated, not inferred.**
- **Disposition:** **FIXED**.

#### P5C-004 — SMTP unconfigured, so password reset cannot reach a user
- **Status:** REAL / PARTIAL (production blocker, external) · **Severity:** High
- **Evidence:** `/api/ops/status` → `mail: { mode: "console", host: null }`.
- **Impact:** Self-service recovery is inert until DIC supplies credentials; an
  operator must run `reset_link.js` by hand.
- **Recommended action:** None in code. Already documented in
  `PRODUCTION_DEPENDENCIES.md` §2.4.
- **Disposition:** **DEFERRED** — institutional dependency, not engineering.

#### P5C-005 — Import wizard trusts client-side validation classification
- **Status:** REAL / PARTIAL · **Severity:** Moderate
- **Current behavior:** `validateImportRows()` decides valid/invalid/duplicate
  in the browser; the server re-validates name and email but accepts the
  records array as posted.
- **Evidence:** `js/admin.js` wizard state; `server.js` `/api/bulk-import`
  re-checks `name` and `isValidEmail` and rejects only those.
- **Impact:** The preview counts an administrator sees are computed client-side
  and may disagree with what the server stores.
- **Recommended action:** Treat the server's response as the source of truth for
  the result screen (it already returns `created/updated/rejected`).
- **Disposition:** **FIXED**.

#### P5C-006 — Import preview counts are not reconciled against the result
- **Status:** REAL / PARTIAL · **Severity:** Low-moderate
- **Evidence:** Step 3 renders `currentImportState.validRecords.length` as
  "Successfully created N User Accounts" (`js/admin.js:770`) rather than the
  server's `created`.
- **Impact:** If the server rejects a row the client thought valid, the success
  screen overstates what happened.
- **Disposition:** **FIXED** — same change as `P5C-005`.

#### P5C-007 — `chapters` have no structured location
- **Status:** MISSING · **Severity:** Low-moderate
- **Evidence:** `chapters` columns: no country/city; `type='regional'` with the
  region only in the free-text `name` ("DIC UK & Europe Alumni").
- **Impact:** Regional chapters cannot be joined to the location model, filtered
  or mapped.
- **Disposition:** **DEFERRED** — a Phase 5B follow-on if DIC wants regional
  chapter targeting. Not a defect in what exists.

#### P5C-008 — `PUT /api/jobs/:id` has no UI
- **Status:** MISSING (backend without UI) · **Severity:** Moderate
- **Evidence:** `api.js:423` defines `updateJob`; no caller in `js/` or either
  shell. The job card offers Applicants and Delete only (`js/jobs.js:179-181`).
- **Impact:** A poster who mistypes a job must delete and repost, losing its
  applicants.
- **Disposition:** **FIXED** — small, high-value.

### P2 — important UX / maintainability

#### P5C-009 — Denormalised counters hold seeded fiction
- **Status:** DEAD / UNUSED · **Severity:** Moderate
- **Evidence:** `chapters.members_count` sums to **41,990** against **0** rows
  in `chapter_memberships`; `events.registered_count` sums to **27** against
  **4** actual registrations; `campaigns.raised_amount`/`donors_count` likewise.
- **Mitigating fact:** **Nothing displays them.** Chapters render
  `COUNT(chapter_memberships)`, campaigns sum settled donations, and event
  capacity uses a live `COUNT(*)` (`routes_events.js:611`) — verified.
- **Risk:** They are still *written* on every join and registration, so they
  look maintained. Any future query that reads one inherits a 41,990-member
  phantom.
- **Recommended action:** Drop them, or reconcile once and add a check
  constraint. Removal is cleaner — no reader exists.
- **Disposition:** **REMOVED**.

#### P5C-010 — `event_proposals` is a dead table
- **Status:** DEAD / UNUSED · **Severity:** Low
- **Evidence:** Table-usage sweep across all live code with comments stripped:
  1 of 47 tables unreferenced. Holds 1 row. `routes_planner.js:142,259` mention
  it only in comments explaining its removal.
- **Disposition:** **REMOVED** — with its row archived to a backup first.

#### P5C-011 — Planner list/update helpers have no UI
- **Status:** MISSING · **Evidence:** `getPlannerList`, `updatePlannerItem`
  (`api.js:504,506`) uncalled. **Disposition:** DEFERRED.

#### P5C-012 — Four further API helpers have no caller
- **Status:** DEAD / UNUSED · **Severity:** Low
- **Evidence:** Of 139 helpers, 11 are uncalled: `deleteEvent`,
  `getAdministrator`, `getConsentHistory`, `getEvent`, `getImportHistoryV2`,
  `getMyEvents`, `getPlannerList`, `moderateProposal`, `updateCampaign`,
  `updateJob`, `updatePlannerItem`.
- **Notes:** `deleteEvent` is superseded by cancel (which preserves history) —
  reasonable. `getConsentHistory` means a member cannot see their own consent
  record. `updateCampaign` means campaigns cannot be edited after creation.
- **Disposition:** **MERGED/REMOVED** case by case; `getConsentHistory` and
  `updateCampaign` are worth wiring, the rest removed.

#### P5C-013 — Events "All" filter chip is unreachable at 360 px
- **Status:** BROKEN · **Severity:** Moderate (mobile)
- **Evidence:** At 360 px the chip occupies x 342–384 against a 360 px viewport,
  and `.ev-filters` reports `scrollWidth === clientWidth === 376` — it does not
  scroll. Resolves at 390 px and above.
- **Impact:** Mobile users cannot clear the events filter.
- **Recommended action:** Give `.ev-filters` a real horizontal scroll, as
  `.profile-hub-tabs` already has.
- **Disposition:** **FIXED**.

#### P5C-014 — One form control has no accessible name
#### P5C-015 — Two icon-only buttons lack `aria-label`
#### P5C-016 — No skip-to-content link
- **Status:** REAL / PARTIAL · **Severity:** Low
- **Evidence:** Directory page audit: 1 of 3 visible controls unlabelled, 2 of
  33 visible buttons icon-only without a label, no skip link. `lang="en"`
  present; all images carry `alt`.
- **Disposition:** **FIXED** (small), `P5C-016` DEFERRED.

#### P5C-017 — Heading hierarchy is shallow
- **Status:** REAL / PARTIAL · Only `H1` on the directory page; card titles are
  `div`s. **Disposition:** DEFERRED.

#### P5C-018 — `notif-count` renders a literal `7` before data arrives
- **Status:** FAKE / MISLEADING (transient) · **Severity:** Low
- **Evidence:** `index.html:243`, `admin.html:179`. Overwritten by
  `js/notifications.js:52` at load, so it is a flash, not a persistent lie.
- **Disposition:** **FIXED** — render an empty badge until the count arrives.

### P3 — optional

| ID | Finding | Disposition |
|---|---|---|
| P5C-019 | `schema.sql` has never tracked migrations v2–v13; a fresh install must run all of them in order | DEFERRED — existing convention, documented |
| P5C-020 | `test_e2e_crud.js` is a legacy standalone harness outside `tests/` | REMOVED |
| P5C-021 | Only 2 of ~15 suites live in the repository; the rest are in a scratchpad and would not survive a clone | **FIXED** — move them into `tests/` |
| P5C-022 | `days_left` on campaigns is a creation-time integer, not an end date | DEFERRED |
| P5C-023 | No pan control on the map; distant places can leave the frame when zoomed | DEFERRED |
| P5C-024 | `event_logistics.location`, `event_meetings.location`, `event_proposals.venue` are three unrelated free-text location fields in the planner | DEFERRED |

---

## Security findings summary

| Area | Result |
|---|---|
| Unauthenticated access | 1 endpoint (`P5C-003`); all others 401 |
| Privilege escalation | None. 36/36 probes correct |
| IDOR | None. `profile/me`, `notifications`, `donations/mine` all self-scoped |
| SQL injection | None. Injection strings returned 0 rows; fully parameterised |
| Parameter tampering | `limit` capped at 100, negative `offset` clamped |
| XSS | **Present — `P5C-001`**, admin session |
| CSRF | Bearer tokens in a header, not cookies — not exploitable cross-site |
| Rate limiting | Working: 429 from the 6th failed sign-in |
| Cross-portal | Alumni token refused at `/admin` and cleared |
| Location privacy | `public`/`alumni`/`private` enforced server-side, no staff bypass |
| Personal coordinates | None exist anywhere in the system |

---

## Data-honesty findings

Every user-visible number was traced to a source.

| Displayed value | Source | Verdict |
|---|---|---|
| Dashboard stat cards | `/api/stats/overview` | Real |
| Analytics metrics | `/api/stats/analytics` | Real |
| Map counts | `/api/stats/map`, privacy-filtered | Real |
| Directory count | `COUNT(*)` with the same filter | Real |
| Chapter members | `COUNT(chapter_memberships)` | Real (stored column ignored) |
| Campaign raised | `SUM(amount WHERE status='SUCCESS')` | Real (stored column ignored) |
| Event capacity/registrations | live `COUNT(*)` | Real |
| Donor leaderboard | settled donations | Real |
| Audit entry count | `COUNT(audit_logs)` split by chain version | Real |
| Compliance pills | live counts | Real |
| Ops panel | `ops_runs`, real backup file stats | Real |
| Notification badge | `/api/notifications` | Real, after a `7` flash (`P5C-018`) |
| Import success screen | **client-side count** | **`P5C-006`** |

Cross-checked by suite: 78 source-truth metrics and 33 screen-level metrics
reconcile against the database with 0 mismatches. `Math.random` appears in
application code only inside comments describing what was removed.

---

## UX findings

Tested at **360, 390, 430, 768, 1024, 1280** on both portals.

- **No horizontal document overflow at any width on either portal.**
- **Zero console errors** on either portal across all pages.
- All 11 alumni pages and all 15 staff pages render with content.
- Wide tables are inside `.table-scroll` (`overflow-x: auto`) and scroll.
- `.profile-hub-tabs` overflows its container but scrolls correctly.
- Map badges are circular at every width with a 44 px hit area.
- Sub-40 px buttons appear only at ≥1024 px, where the touch minimum does not
  apply.
- One genuine defect: `P5C-013`.

*Measurement caveat:* browser-pane geometry reads as zero when a tab is
backgrounded or the pane is hidden. Two intermediate readings were discarded for
this reason and re-taken with an explicit viewport; only the re-taken figures
are reported here.

---

## Comparison with the Master Audit

### Resolved (17)

| Master Audit finding | Verified how |
|---|---|
| Donation success chosen by the client | Server writes `'PLEDGED'`; only ADMIN_ROLES can settle (`routes_v2.js:306,329`) |
| Paid ticket fake payment | No payment path; tickets are pledge/free only |
| Deletion purge never executed | Observed: *"1 due, 1 purged — request 68: user #172 erased"* |
| No scheduler | 3 jobs, `source: "cron"`, 0 failures in 7 days |
| No backups | 630 KB dump, 0.5 h old, not stale |
| Password reset undeliverable | Mechanism real; delivery awaits SMTP (`P5C-004`) |
| QR signing fail-open | Refuses to operate without a key (`routes_events.js:34-44`) |
| Connections UI not wired | Real rows and endpoints, wired |
| Privacy settings not persisted | Persisted and enforced; 142-check suite |
| Fake Developer API | Removed |
| Wallet/digital-pass theatre | Removed |
| Hardcoded metrics | 111 metrics reconcile; no `Math.random` |
| Event moderation duplicated | Single path |
| Public admin credentials | Removed in Phase 0 |
| `express.static` serving `.env` | Allow-list; dotfiles 404 |
| Audit trail unverifiable | Chain verified through 852 entries |
| Audit metadata carrying PII | Internal ids only from the Phase 5A boundary |

### Still open (2)

- **Stale columns** — narrowed to `P5C-009`; harmless today, unread, still written.
- **Documentation accuracy** — *worsened in scope*: the Master Audit flagged
  README production claims (fixed); this audit finds the **feature list**
  fabricated (`P5C-002`).

### Obsolete (2)

- *"Alumni map is country-level, cities computed and never rendered"* — the map
  was rebuilt; the underlying finding was also **understated**, corrected in the
  Master Audit's Location Addendum.
- *"`event_proposals` referenced in comments only"* — still true, now classified
  as a dead table with a disposition (`P5C-010`).

### Newly discovered (12)

`P5C-001`, `P5C-002`, `P5C-003`, `P5C-005`, `P5C-006`, `P5C-008`, `P5C-012`,
`P5C-013`, `P5C-014`, `P5C-015`, `P5C-018`, `P5C-021`.

---

## Dependency graph

```
P5C-001 (import XSS) ─── independent, blocks handover
P5C-002 (README)     ─── independent, blocks handover
P5C-005 ──┬── P5C-006      (same import-result change)
P5C-003   │                 needs a decision: is the news feed public?
P5C-009 ──┴── P5C-010      (same cleanup migration, v14)
P5C-021 ─── prerequisite for any CI pipeline
P5C-007 ─── depends on the Phase 5B location model (already in place)
P5C-013, P5C-014, P5C-015, P5C-018 ─── independent, small
P5C-004 ─── external: DIC must supply SMTP
```

---

## Prioritised roadmap

**Phase 5D — Security and honesty (recommended next, small)**
1. `P5C-001` escape every import-preview field + regression test
2. `P5C-002` rewrite the README feature list
3. `P5C-003` decide and enforce the stories endpoint's intent
4. `P5C-018` empty notification badge until loaded

**Phase 5E — Correctness and cleanup**
5. `P5C-005`/`P5C-006` report the server's import result
6. `P5C-008` job edit UI; `P5C-012` wire consent history and campaign edit
7. `P5C-013` scrollable events filter row
8. `P5C-009`/`P5C-010` migration v14: drop the dead counters and table
9. `P5C-021` move the suites into `tests/`

**Phase 5F — Accessibility** — `P5C-014`, `P5C-015`, `P5C-016`, `P5C-017`

**Deferred** — `P5C-007`, `P5C-011`, `P5C-019`, `P5C-022`, `P5C-023`, `P5C-024`

**External to engineering** — `P5C-004` and the rest of
`PRODUCTION_DEPENDENCIES.md` Part 2.

---

## Readiness assessment

**Not ready for handover today. Two engineering items block it, and both are
small.**

What is genuinely strong: authorization, the audit chain, the location and
privacy model, the operations ring, and data honesty in the running product.
These were tested, not taken on trust: **1,158 automated checks across fifteen
suites pass, plus 111 source-truth metrics reconciled against the database**,
with zero failures.

What blocks handover: an administrator-session XSS reachable through the normal
act of importing a roster (`P5C-001`), and a README that promises a product
substantially larger than the one that exists (`P5C-002`). The first is a real
vulnerability; the second is the kind of overstatement this whole remediation
series was opened to eliminate, surviving in the one file an evaluator reads
first.

After those two, the remaining gap to production is not engineering at all — it
is the institutional inputs in `PRODUCTION_DEPENDENCIES.md` Part 2: SMTP
credentials, two domains, three secrets and their escrow, a hosting decision,
and named people for the escalation path. Those cannot be closed from inside the
repository.

**Estimated engineering effort to unblock: under a day.**
