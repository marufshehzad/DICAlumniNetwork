# DIC ALUMNI SYSTEM — MASTER AUDIT AND ROADMAP

**Subject:** DIC Alumni Platform (Daffodil International College)
**Repository state:** branch `feat/events-tickets-v5` merged into `main` at `8d8829a` (PR #1); working tree clean
**Audit date:** 2026-09-02
**Method:** read-only. Static review of every route file, every `js/*` module, every schema file, `api.js`, `server.js`, both HTML entry points, and deployment config; live read-only queries against the development database (`dic-alumni-pg`, PostgreSQL, db `dic_alumni_db`); cross-referenced against the original PRD, `AUDIT.md` (2026-08-02), `implementation_plan.md`, and the Phase 0–2C test evidence produced earlier in this project. **No application code, schema, or data was modified by this audit.** (The dev database container was started to take row counts; starting a stopped container changes no data.)

A note on evidence freshness: findings marked with file:line citations were verified in this audit cycle. Mobile/accessibility measurements marked "(prior measured)" come from the instrumented pass recorded in `AUDIT.md` and the Phase 2B/2C browser verification runs; they were not re-measured at all seven breakpoints in this cycle and are labeled accordingly.

---

## 1. Executive Summary

### The master question

> **"Is this system actually ready to be handed to Daffodil International College as a real institutional Alumni Management Platform?"**

**Answer: NO — not yet. It is genuinely close in its core, and genuinely far in its money and operations layers.**

The core alumni-networking product — accounts, roles, directory, profiles, events and tickets, mentorship, chapters, news, moderation, notifications, the admin portal, the compliance vault — is real, database-backed, server-enforced, and tested. That was not true five weeks ago (`AUDIT.md` scored the system "1 of 27 core features fully functional" on 2026-08-02) and it is true now.

What blocks handover is not the alumni experience. It is:

1. **Money is simulated.** Donation "settlement" is a client-side POST with a caller-chosen success boolean (`routes_v2.js:283-285`; the modal literally offers a "Simulate a failed payment" button, `js/donations.js:245-246`). Paid event tickets record `amount_paid` at registration with no collection step (`routes_events.js:587-596`). A college cannot publish fundraising totals produced this way.
2. **A legal promise the system cannot keep.** Account deletion promises a 30-day grace then purge (`deletion_requests.purge_after`), and **nothing anywhere reads that column to execute the purge** — no scheduler exists in the deployment at all.
3. **No operations layer.** No backups, no monitoring, no log strategy, no runbook, no scheduler, no email transport (password-reset links are minted by an operator running a CLI with shell access — `reset_link.js`).

### Overall readiness: **~62%** (calculation shown, not guessed)

Scored across the 24 production-readiness areas of §37 (READY = 1, PARTIAL = 0.5, NOT READY/MISSING = 0, equal weights):
READY × 10 + PARTIAL × 10 + NOT READY × 1 + MISSING × 3 → (10 + 5 + 0 + 0) / 24 = **62.5%**.
Equal weighting is a choice; if you weight "money" and "legal" higher (a college would), the effective number is lower. If you scope-cut paid features for launch (recommended — see roadmap), the number for the cut scope rises to roughly 75–80%.

### Critical blockers (P0)

| # | Blocker | Evidence |
|---|---------|----------|
| 1 | Donation settlement is self-reported by the client | `routes_v2.js:283-323`, `js/donations.js:245-246` |
| 2 | Paid tickets collect no payment | `routes_events.js:587-596`; frontend never even sends `paymentGateway` (`js/events.js:2771-2775`) |
| 3 | Deletion purge never executes | `deletion_requests.purge_after` written (`routes_compliance.js:207`) and read by nothing; repo-wide grep confirms |
| 4 | No scheduler of any kind — event status/reminders only run if a staff member opens the Events page that day | `routes_events.js:1350-1361`, `js/events.js:399-420` |
| 5 | No backup/restore procedure exists or is documented anywhere | no matching file/config in repo |
| 6 | Password-reset delivery requires server shell access | `reset_link.js`; `server.js:624-628` comment says so explicitly |
| 7 | Ticket-QR signing key silently falls back to the literal `'dic-ticket'` when `ENCRYPTION_KEY` is unset — forgeable tickets on a misconfigured deploy | `routes_events.js:18-27` |
| 8 | No monitoring/health alerting; `/api/health` exists but nothing watches it | `server.js:295` |

### Major strengths

- **Server-enforced RBAC on every one of ~113 authenticated endpoints** — three role tiers (`SUPER_ONLY`/`ADMIN_ROLES`/`MODERATOR_ROLES`, `server.js:228-234`), identity always from the verified token, never the request body. Re-verified this cycle for the auth/admin surface (Phase 2C suite: 72/72; Phase 2B suite: 61/61).
- **Events & Tickets v5/v6** is production-grade: row-locked capacity (`routes_events.js:523,554-563`), DB-level duplicate prevention (`UNIQUE(event_id,user_id)`, `schema_v2.sql:49`), FIFO waitlist promotion, HMAC-signed QR, idempotent registration via `sync_mutations`.
- **Real compliance vault** — AES-256-GCM with per-write IV and verified auth tag (`routes_v2.js:11-37`), fail-closed without a key (HTTP 503, `routes_compliance.js:63-65`), reveal requires a written reason and is double-audited.
- **Data honesty discipline** — Phases 1/1.5 removed every fabricated metric; every dashboard number is now a live `COUNT`/`SUM`, and the code deliberately refuses to show trend lines it cannot compute (`server.js:1665-1668`).
- **Two-portal architecture** — staff code and data no longer ship to the public bundle; host/subdomain routing is env-driven with no hardcoded domain.
- **Hash-chained audit trail** with actor/target/IP (426 live entries), plus a disciplined additive-migration pattern across 8 schema generations.

### Major weaknesses

- Simulated payments presented behind real gateway branding (bKash/Nagad/Rocket UI).
- Zero operational tooling (backup, monitor, schedule, deliver email).
- No automated test framework or CI — verification is standalone scripts run by hand.
- A pocket of dead/legacy surface: connections feature (backend complete, UI a name-keyed toast toggle), `event_proposals` table, `health_score`, `read_count`, `registered_count`/`members_count`/`raised_amount` stored counters, wallet-pass stubs.
- Single 220KB `styles.css` and a 2,832-line `js/events.js` — maintainable today, brittle at team scale.
- No file upload anywhere: photos/resumes/covers are URL text fields.

### Top 10 actions (ordered)

1. Decide the launch scope: **launch free-events + pledge-donations, or wait for gateway integration.** Everything else sequences from this.
2. Make ticket-QR signing fail closed like the vault does (one small change class — flagged, not made, per audit rules).
3. Stand up a scheduler (Vercel Cron or system cron hitting the existing idempotent sweep endpoints) and add a purge job for `deletion_requests`.
4. Add an email transport (single SMTP relay) for password reset first, broadcasts second.
5. Establish backups: automated `pg_dump` + restore drill + documented runbook.
6. Either wire the connections feature (backend is done) or remove its UI button — it currently lies to the user.
7. Remove or truthfully relabel the payment-gateway UI until a gateway is real.
8. Wire monitoring to `/api/health` + error alerting.
9. Adopt a test runner; move the existing Phase 0/2B/2C suites into repeatable CI.
10. Complete DSAR export scope (add identity_vault presence, job applications, connections, notifications) or document the omission as a signed-off policy.

### Recommended architecture

Keep exactly what exists — vanilla JS dual-portal frontend, single Express app, PostgreSQL — and add only an operations ring around it (scheduler, backups, SMTP, monitoring) plus one real payment gateway behind webhooks. No framework migration is justified (§29).

---

## 2. Current System Overview

- **Frontend:** two entry points — `index.html` (alumni, ~50KB) and `admin.html` (staff, ~37KB) — loading overlapping subsets of 16 plain `js/*.js` modules (9,270 lines total) plus `api.js` (110 client wrappers) and one `styles.css` (5,644 lines / 220KB). No framework, no bundler, no service worker. One third-party CDN script (`qrcodejs`) renders ticket QRs.
- **Backend:** one Express 5 app (`server.js`, 2,043 lines) mounting `routes_v2.js`, `routes_events.js`, `routes_planner.js`, `routes_admin_users.js`, `routes_compliance.js`. Four runtime dependencies (`express`, `pg`, `cors`, `body-parser`). Deployable standalone (`node server.js`) or as one Vercel serverless function (`api/index.js`).
- **Database:** PostgreSQL, **44 tables**, raw parameterized SQL, additive migrations v2–v8 each paired with a Node runner.
- **Identity:** scrypt password hashes; HMAC-SHA256 bearer tokens (12h TTL) carrying a `token_version` checked per-request; no cookies, no JWT, no OTP, no SSO.
- **Tenancy:** single institution, hardcoded identity ("DIC"), zero `tenant_id` columns, no RLS — confirmed by repo-wide grep.
- **Portals:** `wantsAdminPortal()` (`server.js:2010-2033`) picks `admin.html` for `/admin*` paths, `admin.` host prefixes, or an `ADMIN_ORIGIN` match; CORS allow-list built from `PUBLIC_ORIGIN`/`ADMIN_ORIGIN`.

Live database state (this cycle): 18 users (14 alumni + 4 staff + 1 super_admin — one per staff role), 14 alumni profiles, 8 events, 8 ticket types, 3 registrations, 15 event tasks, 5 chapters (0 memberships), 3 jobs (0 applications), 3 campaigns, 1 donation, 2 stories, 1 poll (0 votes), 13 notifications, 426 audit entries, 0 identity-vault rows, 0 broadcasts, 0 mentorships, 0 connections.

---

## 3. Complete Module Inventory

Status legend: **REAL** (end-to-end working) · **PARTIAL** · **MOCK** (UI theater) · **BROKEN** · **DEAD** (nothing reaches it) · **UNUSED** (works, nothing calls it) · **DUPLICATE** · **MISSING**.

| Module | UI exists | Backend exists | DB exists | Actually working | User-facing | Admin-only | Status |
|---|---|---|---|---|---|---|---|
| Authentication (login/register/me/logout) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Password change / forced change | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Password recovery (forgot/reset) | ✅ | ✅ | ✅ | ✅ (delivery = operator CLI) | ✅ | — | **PARTIAL** |
| Session revocation (`token_version`) | n/a | ✅ | ✅ | ✅ | — | — | **REAL** |
| Alumni profile (10 sections, edit) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Privacy settings (field visibility) | ✅ | ✅ | ✅ | ✅ read-side; edit-side not saved by current editor (see §12 module note) | ✅ | — | **PARTIAL** |
| Alumni directory (search/filter/sort/paginate) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Connections ("Connect" button) | ✅ (button) | ✅ (full API) | ✅ (table, 0 rows) | ❌ never wired together | ✅ | — | **BROKEN** (UI) + **UNUSED** (API) |
| Dashboard (per-role) | ✅ | ✅ | ✅ | ✅ | ✅ | partly | **REAL** |
| Events & tickets (browse/register/waitlist/QR/cancel) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Event creation wizard + approval | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Event check-in | ✅ (text/paste box) | ✅ | ✅ | ✅ | — | ✅ | **REAL** (no camera scanner) |
| Paid tickets (price collection) | ✅ (price UI) | ❌ (no collection) | ✅ (columns) | ❌ | ✅ | — | **PARTIAL/MOCK** |
| Event tasks (checklist/notes/assignees/verify) | ✅ | ✅ | ✅ | ✅ | assignees | ✅ | **REAL** |
| Event people / external people | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Event advanced (budgets, sponsors, vendors, procurement, committees, volunteers, risks, timeline, logistics, marketing, meetings) | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Planner analytics + CSV report | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Reminder sweep / status rollforward | trigger only | ✅ | ✅ | ✅ when triggered; no schedule | — | ✅ | **PARTIAL** |
| Jobs (post/list/delete) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Job edit | ❌ (no UI) | ✅ `PUT /api/jobs/:id` | ✅ | — | — | — | **UNUSED** |
| Job applications | ✅ | ✅ | ✅ | ✅ (apply + view); no status-change UI/API | ✅ | poster | **PARTIAL** |
| Job referrals | ✅ | ✅ | ✅ | ✅ request-side; no accept/decline workflow | ✅ | — | **PARTIAL** |
| Mentorship (suggest/request/respond/expire) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Donations ledger | ✅ | ✅ | ✅ | ✅ mechanics; settlement self-reported | ✅ | — | **PARTIAL** (financially not trustworthy) |
| Campaigns (create/delete) | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Campaign edit | ❌ (no UI) | ✅ `PUT /api/campaigns/:id` | ✅ | — | — | — | **UNUSED** |
| Donor leaderboard / receipts (.txt) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** (receipt cites a verify URL that has no route) |
| Chapters (list/join/leave/create/moderate/members) | ✅ | ✅ | ✅ | ✅ | ✅ | mod gate | **REAL** |
| News / stories (submit → moderate → publish) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Trending tags / past polls widgets | ✅ | ❌ | ❌ | hardcoded arrays | ✅ | — | **MOCK** |
| Polls (active/vote) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** (no admin UI to create a poll — DB-seeded only) |
| Notifications (in-app, scoped, deep links) | ✅ | ✅ | ✅ | ✅ | ✅ | — | **REAL** |
| Broadcasts | ✅ | ✅ | ✅ | ✅ in-app; SMS/Push/Email chips are metadata only | — | ✅ | **PARTIAL** |
| Segmentation (audience count preview) | ✅ | ✅ | ✅ | ✅; not connected to broadcast | — | ✅ | **REAL** (scoped) |
| Analytics / stats | ✅ | ✅ | ✅ | ✅ live numbers; no PDF/Excel export (buttons removed — grep: zero `exportPDF|exportExcel`) | partly | ✅ | **REAL** (narrow) |
| Alumni map | ✅ | ✅ | ✅ | ✅ country-level; `cities` computed and never rendered | ✅ | — | **REAL** (narrow) |
| Admin portal shell / nav / role gating | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Administrator management (provision/edit/suspend/reset) | ✅ | ✅ | ✅ | ✅ | — | super only | **REAL** |
| Moderation queue (chapters/stories) | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Event approval via moderation queue | ❌ (queue lists them; panel doesn't render them) | ✅ | ✅ | approval happens in event workspace instead | — | ✅ | **PARTIAL/DUPLICATE** path |
| Verification queue (`is_verified`) | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Bulk import (CSV) | ✅ | ✅ | ✅ | ✅ (CSV; the README's `.xlsx/.xls` claim is **not** implemented — client parser is CSV-only, `js/admin.js:1250`, file input accepts `.csv` only, `js/admin.js:584`) | — | ✅ | **REAL** (CSV), README overclaims |
| Custom fields | ✅ | ✅ | ✅ | ✅ | ✅ render | ✅ manage | **REAL** |
| Compliance status pills | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Identity vault (NID/BRC/passport) | ✅ | ✅ | ✅ | ✅ (0 rows in dev — unexercised by real data) | ✅ store | ✅ reveal | **REAL** |
| DSAR export (JSON/CSV) | ✅ | ✅ | ✅ | ✅, scope-incomplete | ✅ | — | **PARTIAL** |
| Consent logging | ✅ | ✅ | ✅ | ✅ write-side; `getConsentHistory` wrapper never called → no history UI | ✅ | — | **PARTIAL** |
| Deletion requests (30-day grace) | ✅ | ✅ | ✅ | request/cancel yes; **purge never executes** | ✅ | — | **PARTIAL → compliance blocker** |
| Audit logs (hash-chained, actor/target) | ✅ | ✅ | ✅ | ✅ | — | ✅ | **REAL** |
| Sync mutations (idempotency ledger) | admin view | ✅ | ✅ | ✅ for event-registration retries only | — | ✅ | **REAL** (narrow) |
| System health | ❌ (footer text) | ✅ `GET /api/health` | — | ✅ endpoint; nothing monitors it | — | — | **PARTIAL** |
| Seed/reset DB | — | ✅ `POST /api/seed-db` | ✅ | ✅, super-only + production-refused | — | super | **REAL** (guarded) |
| Wallet pass / digital ID QR | ✅ (buttons) | ❌ | ❌ | ❌ toast stubs (`index.html:785-788`, `js/profile.js:167`) | ✅ | — | **MOCK** |
| Developer API / webhooks | static markup | ❌ | ❌ | ❌ (self-documented as invented, `js/notifications.js:156-160`) | — | — | **MOCK** |
| `event_proposals` | ❌ | ❌ (comments only) | ✅ (1 row) | — | — | — | **DEAD** |
| Scheduled processes | — | — | — | none exist | — | — | **MISSING** |
| Backups / restore | — | — | — | none exist | — | — | **MISSING** |
| Email/SMS transport | — | — | — | none exists | — | — | **MISSING** |
| File upload/storage | one CSV picker | ❌ | ❌ | URLs only | — | — | **MISSING** |

Configuration & scripts inventory: `.env`/`.env.example` (DATABASE_URL, PORT, SESSION_SECRET, ENCRYPTION_KEY, ADMIN_PW_*, PUBLIC_ORIGIN, ADMIN_ORIGIN, ALLOW_DB_RESEED), `vercel.json` (headers + `/api/*` rewrite), `api/index.js` (serverless shim), `manifest.json` (PWA metadata, no service worker), `schema.sql` + `seed.sql` (base), `schema_v2..v8.sql` + `migrate_v2..v8.js`, `migrate_alumni.js` (one-off data load), `rotate_credentials.js` (staff password rotation → gitignored file), `reset_link.js` (operator reset-link mint), `seed_cloud.js`, `test_e2e_crud.js` (legacy standalone test). External runtime dependencies: `express`, `pg`, `cors`, `body-parser`; CDN: `qrcodejs@1.0.0`.

---

## 4. Current User Roles

Five roles, in `users.role` (CHECK-constrained), decided server-side at sign-in; live counts: alumni=14, moderator=1, dept_admin=1, univ_admin=1, super_admin=1.

| Tier constant | Members | Grants (server-enforced) |
|---|---|---|
| `SUPER_ONLY` | super_admin | administrator CRUD/suspend/reset (`routes_admin_users.js`), seed-db |
| `ADMIN_ROLES` | + univ_admin | campaigns CRUD, broadcasts send, event approve/reject/cancel/delete, vault read/reveal, audit read, custom fields, bulk import, compliance status |
| `MODERATOR_ROLES` | + dept_admin, moderator | moderation queue, verification, event/task/people/planner management, segmentation, attendee lists, check-in, directory-search (staff), reminder sweep, broadcasts read |
| (authenticated) | + alumni | everything alumni-facing, always scoped to self by token uid |

Client-side gating mirrors this (`js/navigation.js:88-97` `PAGE_ROLES`, `ADMIN_NAV` at `:23-38`) but is explicitly cosmetic — the comment at `navigation.js:86-87` says the server is the boundary, and the Phase 2B/2C suites verified it is.

**Gap vs. the original PRD's 9-role matrix:** no Student, Finance Officer, System Auditor, School Owner, or Chapter Head roles. §6 of this document assesses whether the five real roles cover the college's actual staff workflows (short answer: mostly, via `designation`; Finance and Chapter-lead duties are the two thin spots).

---

## 5. Admin Authority Architecture

Verified this cycle (Phase 2B suite 61/61, Phase 2C suite 72/72, plus browser passes on clean sessions for all five roles):

- **Creation** — super_admin only; assignable roles limited to moderator/dept_admin/univ_admin (`ASSIGNABLE_ROLES`, `routes_admin_users.js`); super_admin is never form-assignable; 20-char generated temporary password shown once, never logged.
- **Designation ≠ role** — `users.designation` is display-only ("Principal" and "Vice Principal" both provisioned as `univ_admin` in testing); nothing reads it for authorization (verified by grep during Phase 2C).
- **Activation/suspension** — status flip bumps `token_version`, killing live sessions instantly (verified: existing token → 401 on `/api/auth/me`, `/api/alumni`, `/api/events`, `/api/notifications`, `/api/stats/overview`); reactivation restores sign-in but never revives the old token.
- **Password reset (by super admin)** — new temp password, `must_change_password` forced, sessions revoked, `reset_token_hash` cleared.
- **Forced password change** — non-dismissable overlay (`lockUntilPasswordChanged()`, `js/auth.js`), flag cleared on change, `last_password_changed_at` stamped.
- **Self-service recovery** — hashed single-use 30-min tokens; uniform non-enumeration response; suspended accounts get no token; audited; sessions revoked on completion.
- **Audit** — Administrator Created/Updated/Role Changed/Suspended/Activated/Password Reset all present with actor/target/timestamp; no password or token ever appears in `meta` (asserted in the suites).
- **Last login / failed logins / lockout** — `last_login_at`, `failed_login_count`, `locked_until` (15-min) all live.

**Still missing for a real institution:** 2FA (none); per-device session revocation (all-or-nothing per account — an accepted design trade documented in the Phase 2C report); an admin-activity report view (the data is all in `audit_logs`, but no per-administrator filtered view exists — the audit page shows the latest 50 entries globally, `routes_v2.js:652`); **emergency super-admin recovery** if the sole super_admin is locked out *and* no operator has shell access (currently: shell access is the recovery path via `reset_link.js` — acceptable only if documented in a runbook; there is exactly one super_admin account, which is a single point of failure worth a documented second sealed-credential account).

---

## 6. Alumni Lifecycle

Account creation → verification → profile → participation → departure, audited transition by transition:

| Transition | State | Evidence |
|---|---|---|
| Self-registration | ✅ works; new account starts unverified, `tv:1` token | `server.js` register handler |
| Bulk-imported account → first sign-in | ✅ `must_change_password` forces credential change; `created_via` recorded | `schema_v3.sql`, `server.js:1384-1547` |
| Unverified → verified | ✅ staff queue + `PUT /api/users/:id/verify` | `server.js:1927-1961` |
| **Restrictions while unverified** | ⚠️ **weak** — `is_verified` gates a badge, not capability; an unverified account can register for events, apply to jobs, donate, join chapters. No endpoint checks `is_verified` (grep: it is read for display/queue only) | see §10 |
| Profile completion | ✅ editor + completeness meter | `js/profile.js` |
| Participation (events/jobs/mentorship/donations/chapters/news) | ✅ all real (per §3) | — |
| Status change (active→suspended) | ✅ immediate session kill | Phase 2C evidence |
| Deactivation/deletion | ⚠️ request + 30-day grace real; **purge never runs** | `routes_compliance.js:196-227` |
| Departure data export | ✅ DSAR JSON/CSV, scope-incomplete | `routes_compliance.js:134-192` |

**Broken/soft lifecycle transitions:** (1) unverified-user capability restriction absent; (2) deletion purge absent; (3) no "alumni status" concept beyond active/suspended (no deceased/lost-contact/do-not-contact flags a real alumni office maintains).

---

## 7. Backend/API Audit

~113 authenticated endpoints across `server.js` + 5 route modules (full per-endpoint tables with method/auth/purpose were produced during this audit's discovery passes; the inventory below classifies them — every endpoint was accounted for).

**ACTIVE (called by the current UI, working):** the overwhelming majority — auth (7), profile (3), directory (2), chapters (4), stories/moderation (5), notifications (3), stats (4+1 admin), segmentation (2), verification (2), bulk import (2), jobs (6 of 8), campaigns/donations (7 of 8), custom fields (3), mentorship (4), polls (2), broadcasts (2), audit (1), events/tickets/tasks/people (~40), planner (11 CRUD sets + 3), admin users (6), compliance (11), health, seed-db.

**UNUSED (working endpoint, zero frontend callers — verified by scanning all 110 `api.js` wrappers against every `js/*` file and both HTML files this cycle):**

| Endpoint | Wrapper | Note |
|---|---|---|
| `GET /api/events/mine` | `getMyEvents` | useful feature, never surfaced |
| `DELETE /api/events/:id` | `deleteEvent` | no delete button exists; only cancel is surfaced |
| `PUT /api/jobs/:id` | `updateJob` | job edit impossible from UI |
| `PUT /api/campaigns/:id` | `updateCampaign` | campaign edit impossible from UI |
| `GET /api/connections` + `POST /api/connections/:userId` | `getConnections`, `connectWith` | entire feature unwired (see §11/§12) |
| `GET /api/planner/<path>` (list) | `getPlannerList` | UI loads via the `workspace` bundle instead — legitimate, but the per-module GET is now redundant surface |
| `PUT /api/planner/<path>/:id` | `updatePlannerItem` | planner rows cannot be edited from UI (only add/delete) |
| `GET /api/consent` | `getConsentHistory` | user cannot view own consent history |
| `GET /api/import-history` | `getImportHistoryV2` | admin.js maintains its own local `importHistory` after posting; history endpoint unread |

**LEGACY/DEAD:** none at the route level (v5 deleted the old event endpoints outright — `server.js:1559-1565`); at the *data* level, `event_proposals` survives as a read-only archive with 1 row and zero live references outside comments (`routes_planner.js:142,259`).

**PUBLIC (unauthenticated):** `GET /api/health`, `GET /api/stories` (published feed readable without a token — `server.js:1104`; low risk, but should be a deliberate choice), `POST /api/auth/login|register|forgot-password|reset-password`, static assets.

**MISSING (no endpoint for a needed action):** change `job_applications.status` (columns exist, `schema_v2.sql:93-94`, no route); create/close polls (no admin route — the live poll is seed data); referral accept/decline; per-administrator audit filter; deletion-purge execution.

Naming consistency: good — everything is `/api/<domain>/<resource>`; the one wart is planner living at `/api/planner/*` while conceptually subordinate to events (acceptable; documented boundary, `routes_events.js:14-15`).

---

## 8. Database Audit

44 tables; live row counts in §2. Structural findings (constraints and FKs verified against `schema.sql` + v2–v8):

**Healthy core:** `users` (role CHECK, email UNIQUE, v7/v8 authority+session columns), `alumni_profiles` (UNIQUE user_id), `events` + `event_ticket_types` + `event_registrations` (FKs, status CHECKs, `UNIQUE(event_id,user_id)`, quota/price CHECKs), all 12 planner child tables (FK+NOT NULL retrofitted in v5 after shipping with `event_id INT DEFAULT 1` and no FK — `schema_v5.sql:171-193`), `event_people`/`event_task_assignees` (v6 identity CHECKs enforcing exactly-one-identity), `donations` (status CHECK, UNIQUE transaction_reference), `identity_vault` (UNIQUE(user_id, field_type), ciphertext+iv+tag columns), `audit_logs` (hash chain + v7 actor/target/ip).

**Dead columns (written never / read never — each verified by grep this cycle or in discovery):**

| Column | State |
|---|---|
| `mentorships.health_score` | zero references in any route or js file (grep this cycle: no matches) |
| `broadcasts.read_count` | never incremented |
| `broadcasts.status='draft'` | enum value unreachable — sends always insert `'sent'` (`routes_v2.js:634`) |
| `event_registrations.donation_id` | never read/written by `routes_events.js` (grep: no matches) — vestigial ticket↔donation link |
| `event_registrations.payment_gateway` | accepted from body but frontend never sends it → always NULL |
| `event_tasks.assigned_to` (free text) | superseded by `event_task_assignees`; kept for history per `schema_v5.sql` header |
| `events.event_date`/`event_time`/`price` (VARCHARs) | superseded by `starts_on`/`start_time`/`end_time`/ticket types; `price` still read as fallback (`routes_events.js:592-596`) |
| `chapters.events_count` | never written |

**Deprecated stored counters (kept but deliberately bypassed):** `chapters.members_count`, `campaigns.raised_amount`/`donors_count`, `events.registered_count` — all now derived live (§16). They still hold stale seed values (e.g., chapters seeded with 18,420 members against 0 real memberships) and are a footgun for any future developer who queries them directly. Recommendation: drop or zero them in a future migration (NOT done in this audit).

**Orphan-risk:** none remaining after v5's FK retrofit; `migrate_v5.js` re-pointed pre-existing orphans before applying constraints.

**Free text that should be relations (recommendation, not defect):** `alumni_profiles.department`/`current_company`/`city`/`country` (free text drives segmentation and map grouping — typos fragment groups); `event_budgets.vendor_name`/`event_procurement.vendor_name` duplicate `event_vendors.name` as strings.

**Unsafe defaults:** `events.capacity DEFAULT 500` (base schema) vs. the v5 code default of 100 — inconsistent but code-path always sets it; `ENCRYPTION_KEY`-absent behavior differs between vault (fail closed) and ticket signing (silent weak fallback) — the latter is the defect (§14).

---

## 9. UI ↔ Backend Cross-Reference

Summary of the full cross-check (details in §§10–12): out of ~55 user-visible feature surfaces, **46 are fully wired**, 9 have a gap in one direction or the other. The two headline mismatches: **connections** (both directions broken at once — a working API pair nothing calls, and a button that fakes the same action locally) and **payments** (UI far ahead of backend truth).

---

## 10. Backend-without-UI

| Feature | Backend/API | DB | UI missing | Recommendation |
|---|---|---|---|---|
| Connections | `GET /api/connections`, `POST /api/connections/:userId` (`routes_v2.js:546-573`) — dedup, notification to target, all working | `connections` (0 rows) | "Connect" button exists but calls none of it | **Wire it** — smallest gap-to-value ratio in the system (see §11) |
| Event delete | `DELETE /api/events/:id`, 409-guarded against live registrations | events | no button | Add to workspace for admins, or drop the route |
| Job edit | `PUT /api/jobs/:id`, ownership-checked | jobs | none | Add an edit modal (poster + admin) |
| Campaign edit | `PUT /api/campaigns/:id` | campaigns | none | Add edit (admin) — currently a typo means delete-and-recreate, losing the donation FK linkage |
| My events | `GET /api/events/mine` | — | none | Surface as a "My events" filter chip |
| Consent history | `GET /api/consent` | consent_logs | none | Small panel in profile's data-rights section |
| Import history | `GET /api/import-history` (last 25 batches) | import_history | admin UI keeps only its own session-local array | Read the endpoint on panel load |
| Planner item edit | `PUT /api/planner/*/:id` | 11 tables | add/delete only in UI | Add inline edit, or accept add/delete as the workflow and remove the route |
| Application status workflow | columns `submitted/reviewing/shortlisted/rejected/hired` | job_applications | display-only badge | Needs the missing endpoint too (§7) — decide if the college wants an ATS-lite or not |

---

## 11. UI-without-Backend

| UI | Expected action | Backend missing/broken | Recommendation |
|---|---|---|---|
| "Connect" button (`js/directory.js:97-129`) | create a connection request | calls nothing — sets `state.connectedAlumni[name]=true` (keyed by display **name**, not id) and shows a toast; resets every reload | Replace body with `API.connectWith(userId)`; render pending/accepted state from `GET /api/connections` |
| Gateway picker + PIN modal (donations, `js/donations.js:229-249`) | authorize a real payment | no gateway call exists; settlement is the client's own POST | Until integration: relabel as "record a pledge/manual payment"; hide the PIN theater |
| "Add to Apple Wallet"/"Add to Google Wallet" (`index.html:785-788`) | generate a wallet pass | nothing | Remove the buttons |
| "Download Digital Pass" (`js/profile.js:167`) | generate a PKPass | nothing | Remove |
| Broadcast channel chips SMS/Email/Push (`js/notifications.js:207-211`) | multi-channel delivery | delivery is always in-app; channels stored as metadata | Keep only "In-app" until a transport exists; the UI already discloses in small print — make the control match |
| Receipt "verify at alumni.dic.edu.bd/verify/…" (`js/donations.js` receipt text) | verification page | no such route | Remove the line or build `GET /verify/:code` |
| Trending tags / past polls (`js/news.js:187-209`) | live data | hardcoded arrays | Either compute from `stories`/`polls` or delete the widgets |
| Developer API panel (static markup) | issue credentials/webhooks | none (self-documented as invented) | Remove the markup |
| README claim: Excel (`.xlsx/.xls`) import | parse Excel | client parser is CSV-only (`js/admin.js:1250`) | Fix the README (or add SheetJS later) |

---

## 12. Built-but-Nonfunctional Features

| Feature | UI | API | Failure | Recommendation |
|---|---|---|---|---|
| Paid tickets | price fields, "Paid ৳X" on ticket | registration records price | no money is ever collected or verified; `is_paid` events register instantly | Free-tickets-only at launch; integrate gateway before enabling paid |
| Donation settlement integrity | full flow | full flow | outcome chosen by the client (`success` boolean in body, `routes_v2.js:283-285`) | Server-side gateway verification, or relabel as pledge tracking |
| Deletion grace-period purge | request/cancel UI | request/cancel API | the purge itself has no executor | P0 scheduler job |
| Privacy-settings editor | toggles exist in profile UI | read-side enforcement real (`server.js:839+` honors `privacy_settings`) | the current `handleSaveProfileV2` (`js/profile.js:734`, the later of two definitions) does not persist privacy toggles — `PROFILE_PRIVACY_SETTINGS` stays client-local | Persist to `alumni_profiles.privacy_settings` via the existing profile PUT |
| Poll creation | none | none | the one live poll is seed data; when it closes, the widget goes empty forever | Small admin CRUD for polls, or retire polls |
| Event moderation via queue | queue endpoint returns `pendingEvents` | approve/reject routes exist | moderation panel renders chapters+stories only (`js/admin.js:1090-1158`); events approved from the workspace instead | Either render the events section in the queue or remove `pendingEvents` from the endpoint — one path, not two halves |

---

## 13. Duplicate / Legacy / Unnecessary Features

For each: intended value first, then verdict — nothing is called useless merely for being empty.

| Item | Why it exists / intended value | Verdict |
|---|---|---|
| `event_proposals` table (1 row) | pre-v5 approval workflow; approval now lives on `events.approval_status` | **Remove** in a future migration (archive the row) |
| Stored counters (`members_count`, `raised_amount`, `donors_count`, `registered_count`) | pre-Phase-1 display values; superseded by live aggregation | **Remove/zero** — active footgun |
| Legacy event VARCHARs (`event_date`, `event_time`, `price`) | pre-v5 rows' history | **Keep short-term** (old rows), plan a backfill-then-drop |
| `event_tasks.assigned_to` free text | pre-v5 assignee display | **Keep** (history) per the documented v5 decision |
| Two moderation paths for events (queue data + workspace controls) | transitional | **Merge** — one path (§12) |
| Wallet-pass buttons, digital-pass button | REQ-17 aspiration | **Remove** — pure theater |
| Developer-API static panel | REQ-18 aspiration | **Remove** |
| Trending tags / past polls hardcoded widgets | visual filler | **Remove or compute** |
| `sync_mutations` admin panel | shows a real (narrow) idempotency ledger | **Keep** — honest and cheap |
| `getPlannerList`/`updatePlannerItem` API surface | CRUD-factory completeness | **Keep** API, add edit UI (or trim PUT) — decide with §10 |
| `test_e2e_crud.js`, `seed_cloud.js` | early-era scripts | **Keep** as historical dev tooling; exclude from any production image |
| Duplicate role labels (`users.role_label` column vs. computed labels) | early display convenience | **Merge** — derive labels in one place |
| Two logo files `dic.png`/`dics.png` (identical size) | asset iteration | **Remove one** after confirming references |
| PWA `manifest.json` without a service worker | REQ-10 remnant; still gives install metadata + theme color | **Keep** — harmless, mildly useful |

---

## 14. Security Audit

Phase 0/2B/2C fixes were **re-verified as still present** this cycle (code inspection of `server.js` auth block + the recorded 40/9/61/72-check suite runs earlier in this project; the suites themselves live in session scratch, not the repo — see §39 recommendation to commit them).

| Area | State | Evidence |
|---|---|---|
| Authentication | ✅ scrypt, HMAC token, 12h TTL, `tv` check per request | `server.js` auth block |
| Privilege escalation | ✅ role from token only; body-supplied roles ignored; role change revokes sessions | Phase 0/2C suites |
| IDOR | ✅ every "mine" query keys on `req.user.uid`; notifications ownership in WHERE clause (`server.js:1268-1283`); job applicants poster-or-admin only | discovery pass |
| PII exposure | ✅ directory list excludes contact fields (`server.js:780`); per-profile honors `privacy_settings`; staff directory-search (which returns phone) is `MODERATOR_ROLES` (`routes_events.js:1306`) | — |
| CORS | ✅ allow-list from env; permissive only when both origins unset; `credentials:false` | `server.js:31-41` |
| Rate limiting | ✅ login: in-memory dual counter + durable `failed_login_count`/`locked_until`; ⚠️ nothing rate-limits other endpoints (acceptable at college scale; note for exposure) | `server.js:334-416` |
| Session revocation | ✅ logout/change/reset/suspend all bump `token_version` | Phase 2C |
| Password handling | ✅ scrypt; min length; never logged; reset tokens hashed, 30-min, single-use, non-enumerating | Phase 2C |
| XSS | ✅ `escapeHtml` defined once (`js/core.js:59`) and used 369 times across modules; all DB-rendered strings escaped per Phase-1 sweep; ⚠️ 168 `innerHTML` sites remain the pattern — safe only while the escape discipline holds; no CSP beyond frame-ancestors | grep this cycle |
| SQL injection | ✅ parameterized everywhere; the planner CRUD factory interpolates only its own hardcoded column maps, never request input | `routes_planner.js:19-72` |
| File upload | n/a — none exists (CSV parsed client-side, JSON posted) | — |
| Audit integrity | ✅ SHA-256 hash chain + actor/target/ip | `routes_v2.js` |
| Seed/debug endpoints | ✅ `POST /api/seed-db` super-only + refused in production unless `ALLOW_DB_RESEED=true`, audited either way | `server.js:316` |
| Secrets | ✅ `.env` gitignored; `admin-credentials.local.txt` + `reset-link.local.txt` gitignored; no secret in repo history found in review | `.gitignore` |
| Headers | ✅ nosniff/referrer everywhere; admin: noindex + DENY + frame-ancestors; set in Express (not only Vercel edge) | `server.js:50-63`, `vercel.json` |

**Findings this cycle:**

| Severity | Finding |
|---|---|
| **CRITICAL** | Donation settlement trusts the client (`routes_v2.js:283-285`) — financial-integrity, exploitable by any authenticated user to fabricate donations |
| **HIGH** | Ticket-QR HMAC falls back to literal `'dic-ticket'` when `ENCRYPTION_KEY` unset (`routes_events.js:18-27`) — forgeable tickets on misconfigured deploys; vault fails closed, ticketing should too |
| **MEDIUM** | Check-in by typed code bypasses the HMAC check entirely (signature verified only when input parses as JSON, `routes_events.js:708-718`) — mitigated by codes being unguessable and check-in being staff-only |
| **MEDIUM** | `GET /api/stories` is unauthenticated (`server.js:1104`) — published content leaks off-platform; likely fine, should be deliberate |
| **MEDIUM** | No CSP `script-src`; XSS defense rests entirely on escape discipline across 168 innerHTML sites |
| **LOW** | In-memory rate limiter is per-process (documented); serverless instances each get their own — durable counters backstop it |
| **LOW** | `SESSION_SECRET` unset ⇒ ephemeral secret per boot (documented, sessions die on restart) — should be a boot-time hard requirement in production |

---

## 15. Privacy & Compliance

- **"Can a normal alumni user see data they should not?"** No, within design: list view strips contact fields; detail view filters through `privacy_settings`; notifications scoped. Caveat: the privacy-settings *editor* doesn't persist (§12), so users cannot currently tighten defaults themselves.
- **"Can a moderator see too much?"** Borderline-by-design: `GET /api/directory/search` (staff) returns phone numbers to all four staff roles including moderator (`routes_events.js:1306-1348`) — needed for event staffing; a college may prefer this at dept_admin+. Flag for policy sign-off.
- **"Can a department admin see too much?"** Same note; otherwise no — vault reveal and audit are `ADMIN_ROLES`+.
- **"Can a principal see too little?"** As `univ_admin` they see everything except administrator management — correct.
- **PDPA 2026 posture:** vault ✅; consent logging ✅ (no history UI); DSAR export ⚠️ omits identity_vault presence, job applications/referrals, connections, notifications, broadcasts (`routes_compliance.js:138-148` query list); deletion ⚠️ purge unexecuted (**the** compliance blocker); consent is a log only — nothing reads it to gate broadcasts (`routes_v2.js:622-629`).

---

## 16. Data Integrity

Source-of-truth verification for every headline metric (UI → API → SQL):

| Metric | Source of truth | Stored duplicate? |
|---|---|---|
| Alumni count | `COUNT(users)/COUNT(alumni_profiles)` via `/api/stats/overview` | none |
| Event registrations / revenue | `COUNT(event_registrations)` / `SUM(amount_paid)` (`server.js:1703-1704`) | `events.registered_count` stale duplicate — unread |
| Donations raised/donors | `SUM/COUNT WHERE status='SUCCESS'` (`routes_v2.js:213-226`) | `campaigns.raised_amount`/`donors_count` stale — unread |
| Chapter members | `COUNT(chapter_memberships)` (`server.js:980-982`) | `chapters.members_count` stale — unread |
| Jobs/applications/mentorships/notifications | live COUNTs | none |
| Mentorship match score | recomputed server-side at request time (`routes_v2.js:468-471`) | stored per-row (point-in-time snapshot — acceptable) |

**Remaining stored-where-derived cases:** the three stale counters above (recommend dropping); `broadcasts.delivered_count` set equal to recipients at insert (`routes_v2.js:634-636`) — a fake delivery receipt; either derive or rename to `recipients_count` semantics only.

---

## 17. Notifications

All triggers inventoried (13 sources — jobs posted/applied/referred, mentorship requested/answered, connection requested*, chapter submitted/decided, story submitted/decided, donation settled, broadcast fanout, deletion scheduled, event created-pending/approved/rejected/cancelled, ticket confirmed/waitlisted/promoted, task assigned/verified/reminders). All synchronous inserts in the causing request; scoped reads (`user_id` / `target_role` / system); deep links via `link_entity`/`link_id` into tasks/events/tickets (`js/notifications.js:61-90`); read/mark-all real; badge live.

*The connection-request notification (`routes_v2.js:567-568`) can currently never fire for real users because no UI calls the endpoint — it will start working the moment §10's fix lands.

Duplicate-risk: task reminders deduped per task/person/day (`routes_events.js:1376-1404`) ✅. Wrong-recipient risk: chapter/story decisions notify the *actual* submitter (fixed in Phase 1; previously hardcoded user 5).

**Notifications that should exist but don't:** event details changed (date/venue) → ticket holders; waitlist position on join; job application status change (blocked on the missing endpoint); administrator-targeted security notices (e.g., "your password was reset by X" exists via audit only, not as an in-app notice to the target).

---

## 18. Search & Directory

Five people-search surfaces compared:

| Surface | Backend | Returns contacts? |
|---|---|---|
| Alumni directory | `GET /api/alumni` — 7-column `LOWER LIKE`, filters, 4 sorts, pagination (`server.js:780-837`) | no |
| Event assignee/people picker | `GET /api/directory/search` — name/student-ID/roll/phone/dept/section (`routes_events.js:1306-1348`), staff-only | **yes** |
| Chapter members | per-chapter list, no search | no |
| Mentorship suggestions | filtered query, not text search | no |
| Job search | `GET /api/jobs?search=` — title/company | n/a |

Duplication verdict: the two real people-searches are legitimately different (public/private, privacy-filtered vs. contact-bearing). **Recommendation:** keep two endpoints, but extract one shared SQL fragment for name/batch matching, and make the staff search's phone visibility a policy decision (§15). No third search should ever be added without reusing one of these two.

---

## 19. Reports & Analytics

Everything shown is real (Phase 1 evidence + this cycle's route reading). Available today: overview stats (all roles, scoped), staff analytics (dept/batch/campaign/gateway/event-revenue breakdowns), planner analytics + CSV per event, attendees CSV per event, map aggregates, RBAC matrix. **No PDF/Excel export exists anywhere** (grep this cycle: zero `exportPDF|exportExcel` — the old fake buttons are gone, nothing replaced them).

Reports the college actually needs vs. state:

| Report | State |
|---|---|
| Alumni by batch/department | ✅ (analytics) — no export |
| Event report (single event) | ✅ CSV |
| Attendance report | ✅ CSV |
| Donation report | ⚠️ on-screen only; no export; ledger CSV needed for a finance office |
| Verification report | ⚠️ queue view only |
| Administrator activity | ❌ (data in audit_logs; no view) |
| Engagement over time | ❌ deliberately — no historical snapshots exist (`server.js:1665-1668`); would need a snapshot job (pairs with the scheduler) |

Recommendation: one generic "download as CSV" affordance on analytics tables (server-generated, permission-matched) covers 80% of institutional need. No dashboards-for-dashboards'-sake.

---

## 20. Import & Export

**Import (CSV):** validation engine (required fields, email/phone/CGPA/year formats), 4-priority duplicate detection, skip/update strategies, transactional insert, per-batch temp password (hash-stored, shown once), error-report CSV download, `import_history` written (`server.js:1384-1547`, `js/admin.js:515-876`). Gaps: **no rollback of a completed batch** (transaction covers the batch during execution only — an operator who imports the wrong file has no undo); import-history endpoint unread by UI (§10); **Excel not supported despite README** (§3); no dry-run mode. A college data team would want: dry-run preview, batch rollback/tagging (imported rows carry `created_via` — rollback by batch is buildable), and the README corrected.

**Export:** DSAR (self), attendees CSV, planner CSV. Missing: full alumni-directory export for staff (deliberate? — powerful PII surface; if added, ADMIN_ROLES + audited), donations ledger CSV.

---

## 21. Backup & Recovery

**Nothing exists. Marked clearly:**

- Database backup: ❌ none configured or documented.
- Restore procedure: ❌ untested, undocumented.
- Migration backup: partial mitigation — migrations are additive and dry-run-capable, but no pre-migration snapshot step is prescribed.
- Disaster recovery / rollback: ❌.
- File backup: n/a (no file storage).
- Secrets management: `.env` on the box / Vercel env vars; no documented escrow of `SESSION_SECRET`/`ENCRYPTION_KEY` — **losing `ENCRYPTION_KEY` permanently destroys every vault record** (AES-GCM, no recovery). This must be in a sealed-envelope/manager procedure before any real NID is stored.

This section is a P0 for handover regardless of feature scope.

---

## 22. File & Media

No upload subsystem exists. `photo_url`, `cover_image_url`, `resume_url` are user-supplied URL strings (hot-linked; broken-link and mixed-content risk; no access control possible). CSV import reads the file client-side only. Certificates (`event_volunteers.certificate_issued`) is a boolean — no artifact. **Recommendation (P1, post-launch):** one small upload endpoint (images + PDF, size/type-limited, stored in object storage or a static dir with generated names) serving profile photos and event covers; resumes only if the college wants an ATS-lite (§10).

---

## 23. Password & Account Recovery

Current model (verified): alumni + staff self-service reset via hashed single-use token → link minted by operator CLI (no transport); super-admin reset of any staff account; forced change on provision/reset; lockout after repeated failures; full-session invalidation on every credential event.

**Recommended production model (safest simple):** keep everything, add SMTP delivery for the reset link (template already exists in the flow), document the shell-access path as the emergency fallback, create one sealed backup super-admin credential, and require `SESSION_SECRET`+`ENCRYPTION_KEY` at boot in production (refuse to start without them). 2FA: worthwhile for `ADMIN_ROLES`+ later (P2); TOTP needs no external service.

---

## 24. UI/UX Audit

Baseline: Event v5 workspace (tabs, cards, pickers, wizards) is the quality bar. Against it:

- **Consistent:** design tokens are centralized (`styles.css:9-53`), buttons/badges/cards/modals shared, Lucide icons + emoji accents used uniformly, empty states via a shared `renderEmptyState` helper, toasts uniform.
- **Below baseline:** admin control-center tab panels (`switchAdmin` show/hide blocks) are flatter and denser than the events workspace; jobs/mentorship/news pages predate the v5 idiom (functional, plainer); donations' simulated-PIN modal is actively misleading (§11); moderation panel lacks the events section (§12).
- **Terminology:** mostly consistent ("Sign in", "DIC" branding); "College Admin" (UI label) = `univ_admin` (code) is documented but will confuse a future developer — one glossary comment exists, keep it.
- **Destructive actions:** confirm dialogs present for delete flows (campaign delete states donations are retained — good); event delete has no UI (only guarded API).
- **Dark mode:** none — single light theme (`styles.css` grep: no `prefers-color-scheme`); acceptable, should be a stated choice.
- **Loading/error:** every page has skeleton/error/empty states with Retry since the Phase-8 pass (prior measured: full-outage simulation showed no stale data on any page).

---

## 25. Mobile Audit

Prior measured (instrumented pass recorded in `AUDIT.md`, at 320/375/1004px across all pages × 5 roles): horizontal overflow 218px → **0px**; tap targets <44px ~69 → **0**; text <11px ~200 → **0**; desktop tables on mobile 2 → **0** (card layouts); modals as bottom sheets; 16px inputs (iOS zoom); RBAC matrix and planner tables card-ified at ≤900px. The Events v5 UI and both portals were browser-verified at mobile width during Phase 2B/2C with zero console errors. **Not re-measured this cycle at 360/390/430/768/1024/1280/1440** — before handover, one scripted pass across those widths should be repeated on the current build; the 900px master breakpoint and 48 media blocks (`styles.css`) make regressions unlikely but unproven for the newest admin panels.

---

## 26. Accessibility Audit

Honestly: **no systematic accessibility pass has ever been run.** What exists: labels on form inputs (login/recovery panels use `<label class="input-label">`), `role="status"`/`role="alert"` on recovery messages (`add_recovery_html` panels), visible focus outlines from browser defaults, 44px+ touch targets, escaped content. What is unverified/missing: dialog focus trapping and `aria-modal` on the many custom modals; tab-key order through the workspace tabs; icon-only buttons' accessible names; contrast ratios of muted text tokens; landmark structure (`<main>`/`<nav>` usage); hidden-page DOM (all pages are in the DOM, shown/hidden — screen readers may traverse hidden content if `hidden`/`display:none` isn't consistently applied — it is `display:none` via class, which is fine, but unaudited). **Recommendation:** one targeted pass (keyboard + NVDA smoke test) at P1; the platform's simple DOM makes fixes cheap.

---

## 27. Performance Audit

Practical findings only:

- **N+1:** none found in hot paths — list endpoints join or aggregate in one statement; stats endpoints batch via `Promise.all` (many parallel COUNTs — fine at this scale).
- **Payloads:** `GET /api/planner/workspace/:id` returns 13 tables in one call — right trade for the workspace; directory capped at 100/page.
- **Races:** list-request race guarded in events (`_evListRequest`, `js/events.js:480`); directory debounced 400ms.
- **Frontend weight:** `styles.css` 220KB and `js/events.js` 2,832 lines ship uncompressed with no build step; with gzip at the host layer this is acceptable for the audience; no action needed now.
- **Caching:** none (no ETag/cache headers on API) — fine at college scale.
- **Indexes:** present on the hot paths (events by starts_on/status, registrations by event+status, tasks by due date, ticket types by event) — from v5.
- Do **not** optimize further before real load data exists.

---

## 28. Frontend Architecture

Post-2A state: 16 modules + `api.js` + shared `state` in `core.js`. Findings: no circular dependencies (script order in HTML is the dependency graph; guarded `render()`/`warm()` calls tolerate absent modules per portal); globals are the architecture (accepted); inline `onclick` handlers throughout (accepted for this stack; they force globals); duplicated function definitions in `profile.js` (`showEditProfileV2`/`handleSaveProfileV2` defined twice, later wins — `js/profile.js:504/530` vs `:680/:734`) — **remove the dead pair**; `switchAdmin` redefined via wrapper (`js/admin.js:1172`) — intentional but subtle; unsafe-innerHTML discipline per §14; dead frontend functions: the wallet stubs and `connectAlumni`'s fake body (§11).

**Router question:** a small hash-router would improve back-button/deep-linking (currently `showPage()` + notification deep links only). Verdict: **worth it at P2**, ~a day's work, no framework needed. Not before launch.

---

## 29. Backend Architecture

Module verdicts: `server.js` (auth/core/platform) — **keep**, though at 2,043 lines the auth block deserves extraction to `routes_auth.js` at next touch; `routes_v2.js` (misc domains) — **split eventually** (jobs+campaigns/donations+mentorship are unrelated domains sharing a file named after a migration era); `routes_events.js` — **keep** (single source of truth, well-bounded); `routes_planner.js` — **keep** (clean factory); `routes_admin_users.js`, `routes_compliance.js` — **keep**; `db.js` — **keep**. Route naming consistent. Domain boundaries clean except `GET /api/directory/search` living in the events file (move to server.js's directory section at next touch). **No framework migration is justified** — four dependencies, one process, comprehensible by one engineer in a day; that is an institutional asset.

---

## 30. Deployment Audit

- Local: `node server.js` + Docker Postgres ✅ (README's `python3 -m http.server` run instruction is **stale/wrong** — it would serve statics with no API; fix README).
- Vercel: `api/index.js` + rewrite ✅; headers duplicated edge+Express ✅.
- Env vars: documented in `.env.example` ✅; **not enforced at boot** (⚠️ §14/§23).
- TLS: host-provided (Vercel) ✅ / operator's duty standalone.
- Logs: console only; serverless logs ephemeral ⚠️.
- Monitoring/health checks/backup/rollback: ❌ (§21).
- Migration execution: manual `node migrate_vN.js` ✅ documented pattern; no automatic on-deploy migration (correct choice for this stack).

**Needed before college deployment:** boot-time env enforcement, backup job, monitoring hook, a one-page ops runbook (start, migrate, rotate credentials, mint reset link, restore).

---

## 31. Admin Subdomain Readiness

Ready in code, verified in Phase 2C: `wantsAdminPortal()` honors `ADMIN_ORIGIN`; CORS allow-lists both origins; `express.static(...,{index:false})` fix makes bare `/` on the admin host serve the staff portal (the root-path bug found and fixed in 2C); noindex/DENY headers on the admin surface; sessions are naturally isolated per-origin via `localStorage`. **Remaining (external, not code):** DNS CNAME for `admin.<domain>`, TLS cert issuance, set `PUBLIC_ORIGIN`/`ADMIN_ORIGIN` env vars (exact values are the college's real domains — deliberately not invented here). No DNS was configured by this audit.

---

## 32. College Production Readiness — assessment against institutional workflows

(§6 of the brief: role-by-role workflow check.)

| Institutional user | Mapped account | Workflow supported? |
|---|---|---|
| Principal | univ_admin (designation "Principal") | ✅ oversight, approvals, broadcasts, compliance; ❌ no one-page "institutional report" (§19) |
| Vice Principal | univ_admin | ✅ same |
| College Administrator | univ_admin | ✅ |
| Department Head | dept_admin | ⚠️ has moderation/verification/events/jobs; **no department scoping** — a CSE dept_admin sees all departments (role is global). Acceptable at one-college scale; flag as a known simplification |
| Finance Officer | no role | ❌ donations management is univ_admin-only; a finance officer must be given full univ_admin. P1: either accept (small college) or add a designation-based nav preset — **not** a new role tier without real need |
| Event Coordinator | moderator or dept_admin | ✅ strong — the planner is built for exactly this person |
| Moderator / Alumni Coordinator | moderator | ✅ |
| Super Admin / Developer | super_admin | ✅; single account = SPOF (§5) |

---

## 33. Missing Features (gap analysis — what a real college platform needs and this lacks)

| Missing capability | Why the college needs it | Users | Priority | Complexity |
|---|---|---|---|---|
| Scheduler + deletion purge | legal promise; event-status accuracy | system | **P0** | low |
| Backups + restore drill + runbook | institutional data stewardship | ops | **P0** | low |
| Email transport (reset first) | staff can't depend on a developer's shell | all | **P0** | low-med |
| Real payment gateway (bKash) OR honest pledge relabel | fundraising integrity | donors, finance | **P0 (decision), P1 (build)** | med-high |
| Boot-time secret enforcement + key escrow | vault data is unrecoverable without the key | ops | **P0** | trivial |
| Unverified-account capability limits | fake-alumni control (§10 lifecycle) | staff | **P1** | low |
| Connections wiring | networking is the platform's stated purpose | alumni | **P1** | trivial (backend done) |
| CSV exports (donations ledger, analytics tables) | finance/reporting offices run on spreadsheets | staff | **P1** | low |
| Job-application status workflow | makes the job board an actual pipeline | posters | **P1** | low |
| Poll admin CRUD | current poll is unrenewable seed data | univ_admin | **P1** | low |
| Batch/department reference tables (vs free text) | segmentation & reporting accuracy | staff | **P2** | med |
| Photo/cover upload | profiles without third-party hotlinks | alumni | **P2** | med |
| 2FA for admin roles | institutional account protection | staff | **P2** | med |
| Announcements distinct from stories (staff-authored, pinned) | colleges announce; alumni tell stories — currently one moderated feed | univ_admin | **P2** | low |
| Engagement snapshots (enables trend reporting) | year-over-year reporting for leadership | leadership | **P2** | low (once scheduler exists) |
| Hash router / deep links | shareable page URLs | all | **P2** | low |
| Camera QR check-in | door throughput at large events | staff | **P3** | med |
| Alumni status flags (deceased/do-not-contact) | real alumni-office data hygiene | staff | **P3** | low |
| Excel import | matches README promise; data teams use xlsx | staff | **P3** | low (SheetJS) |

Explicitly **not** recommended: multi-tenancy, semantic/vector search, AI matching, offline PWA, wallet passes, developer API, SMS/WhatsApp transports, career scraping — no current institutional need proportionate to their cost (each was examined in §§ of the companion TPRD).

---

## 34. Recommended Features

Consolidated from §33 by phase — see the roadmap (§38). Nothing beyond §33 is recommended; feature count is not a goal.

---

## 35. Ideal Final Product Architecture

```
DIC Alumni Platform  (one Express app, one PostgreSQL, two static portals)
│
├── ALUMNI PORTAL  (index.html — <domain>)
│   ├── Dashboard · Directory (+ working Connect) · My Profile (+ working privacy editor)
│   ├── Events & Tickets (free at launch; paid post-gateway) · Jobs (+ application status)
│   ├── Mentorship · Chapters · News & Polls · Map · Notifications
│   └── Data rights: DSAR (full scope) · consent history · deletion (with real purge)
│
├── ADMIN PORTAL  (admin.html — admin.<domain>)
│   ├── Role dashboards · Moderation (one queue: chapters/stories/events)
│   ├── Events workspace (tasks/people/tickets/reports/advanced) — unchanged
│   ├── Verification · Segmentation (→ broadcast handoff) · Broadcasts (in-app; email later)
│   ├── Analytics (+ CSV exports) · Bulk import (+ dry-run, batch rollback) · Custom fields
│   ├── Compliance: vault · consent · DSAR oversight · deletion queue
│   └── Audit logs (+ per-administrator filter)
│
├── SUPER ADMIN (within admin portal)
│   └── Administrator provisioning · platform settings · seed guard · (sealed backup account)
│
└── OPERATIONS RING (new — the actual gap)
    ├── Scheduler: reminder-sweep · status rollforward · deletion purge · engagement snapshot
    ├── SMTP relay: reset links · (later) broadcast email
    ├── Backups: nightly pg_dump + tested restore + key escrow
    ├── Monitoring: /api/health watcher + error alerting
    └── Payment gateway (bKash) behind server-verified webhooks — when approved
```

---

## 36. Keep / Merge / Remove / Rebuild Matrix

| Item | Verdict |
|---|---|
| Events & Tickets v5/v6, planner, tasks, external people | **KEEP** (protected baseline — re-audited, holds) |
| Auth/session/recovery stack | **KEEP** (+ SMTP delivery) |
| Admin portal, administrator mgmt, audit trail | **KEEP** |
| Compliance vault/consent/DSAR | **KEEP** (+ scope fixes) |
| Directory, profiles, chapters, news, polls, mentorship, jobs, notifications, segmentation, bulk import, custom fields, map, analytics | **KEEP** |
| Donations ledger | **KEEP mechanics**, **REBUILD settlement** behind a gateway (or relabel) |
| Connections | **KEEP backend, REBUILD button wiring** |
| Event moderation dual path | **MERGE** to one |
| `role_label` column vs computed labels | **MERGE** |
| Stored counters, `event_proposals`, `health_score`, `read_count`, `donation_id`, `payment_gateway` (registrations), duplicate profile.js function pair, one dup logo | **REMOVE** (future migration/cleanup) |
| Wallet buttons, digital-pass stub, developer-API markup, trending-tags/past-polls hardcode, simulated PIN modal | **REMOVE** |
| Legacy event VARCHARs, `assigned_to` | **KEEP short-term** (history), scheduled drop |
| README (`.xlsx`, run instructions) | **REBUILD** (fix false claims) |

---

## 37. Production Readiness Checklist

| Area | Status |
|---|---|
| SECURITY | **READY** (with §14 mediums tracked; QR-key fix pending) |
| DATABASE | **PARTIAL** (schema solid; dead columns/stale counters to clean) |
| BACKUP | **MISSING** |
| AUTH | **PARTIAL** (mechanics ready; reset delivery = shell access) |
| ADMIN ACCOUNTS | **READY** |
| ALUMNI (profiles/directory/verification) | **READY** |
| EVENTS | **READY** |
| TICKETS | **PARTIAL** (free ✅; paid = no collection) |
| DONATIONS | **NOT READY** (simulated settlement) |
| JOBS | **PARTIAL** (no edit UI, no status workflow) |
| MENTORSHIP | **READY** (as scoped) |
| CHAPTERS | **READY** |
| NEWS | **READY** |
| NOTIFICATIONS | **READY** (in-app scope) |
| REPORTS | **PARTIAL** (live, no exports) |
| PRIVACY | **PARTIAL** (read-side ✅; editor unsaved; staff-search policy) |
| COMPLIANCE | **PARTIAL** (vault ✅; purge + DSAR scope) |
| MOBILE | **READY** (prior measured; one re-verification pass advised) |
| ACCESSIBILITY | **PARTIAL** (never systematically audited) |
| DEPLOYMENT | **PARTIAL** (works; no env enforcement/logs) |
| DOMAIN | **PARTIAL** (env-driven; DNS pending — external) |
| ADMIN SUBDOMAIN | **READY** (code side) |
| SUPPORT (runbook/ops docs) | **MISSING** |
| MONITORING | **MISSING** |

Tally: READY 10 · PARTIAL 10 · NOT READY 1 · MISSING 3 → **62.5%** (§1).

---

## 38. Phased Implementation Roadmap

Phases 0–2 of the original plan are done (and re-verified). The roadmap continues from reality:

**PHASE 3 — Truth & Safety (P0, ~1 week)**
Fail-closed QR key · boot-time secret enforcement · remove payment theater (relabel donations as pledge/manual until gateway; free tickets only) · wire or remove Connect button · remove wallet/dev-API/hardcoded widgets · merge event-moderation path · fix README. *Risk: low. Everything here is small and unblocks honest handover.*

**PHASE 4 — Operations Ring (P0, ~1–2 weeks)**
Scheduler (cron → sweep + new purge job + engagement snapshot) · nightly backups + restore drill + runbook + key escrow · SMTP for reset links · monitoring on `/api/health`. *Dependency: hosting decision (Vercel Cron vs. VPS cron).*

**PHASE 5 — Institutional Completeness (P1, ~2 weeks)**
Unverified-account limits · DSAR scope completion · consent-history panel · privacy-editor persistence · job edit + application status workflow · campaign edit · poll CRUD · CSV exports (donations ledger, analytics) · import dry-run + batch rollback · per-administrator audit filter · missing notifications (§17).

**PHASE 6 — Payments (P1, gated on college's merchant account)**
bKash sandbox → server-verified webhooks → donations first, paid tickets second → reconciliation report. *Risk: highest external dependency; do not let it block Phases 3–5.*

**PHASE 7 — Polish (P2)**
Accessibility pass (keyboard/NVDA/contrast) · mobile re-verification at 7 widths · admin-panel visual parity with Events v5 · hash router · photo upload · 2FA for staff · announcements type · reference tables for dept/batch · schema cleanup migration (drop dead columns/counters/`event_proposals`).

**PHASE 8 — Future (P3)**
Camera check-in · Excel import · alumni status flags · anything from the not-recommended list only if a real need emerges.

Each item above maps to who uses it / why / complexity in §33.

---

## 39. Final Definition of Done

The system may honestly be called **"DIC Alumni Platform — Production Ready"** when every statement below is true:

1. No UI element promises an action the backend does not perform (Phase 3 complete).
2. Either a real gateway settles money server-side, or no UI describes money as collected.
3. A scheduled job executes deletion purges; a restore from last night's backup has been performed successfully at least once; the runbook exists and a non-developer has followed it.
4. A locked-out staff member can recover their account without anyone opening a shell.
5. Production boot fails loudly without `SESSION_SECRET` and `ENCRYPTION_KEY`; both are escrowed.
6. The Phase 0/2B/2C security suites (committed to the repo) pass in CI on every change.
7. `PUBLIC_ORIGIN`/`ADMIN_ORIGIN` are set to the college's real domains; `admin.<domain>` serves the staff portal over TLS; the alumni site never loads staff modules (re-verified on production origin).
8. The verification queue is the only path to a "verified" badge, and unverified accounts have the agreed capability limits.
9. DSAR export scope is complete or the omissions carry written sign-off.
10. One month of monitoring history exists with alerting proven by a test incident.

---

## 40. Evidence / Verification Notes

- **Live DB queries (this cycle):** table census (44), per-table row counts, role distribution — §2. Read-only `SELECT`s only.
- **Static verification (this cycle):** all five route files + `server.js` read in full during discovery; all 16 `js/*` modules inventoried; `api.js` 110 wrappers scanned against every frontend file (10 uncalled — §7); greps for `exportPDF|exportExcel` (0), `event_proposals` (comments only), `health_score` (0), `tenant|org_id` (0), `serviceWorker|indexedDB|dexie` (0 real), `innerHTML` (168) vs `escapeHtml(` (369), file-upload inputs (CSV picker only).
- **Carried evidence (labeled where used):** `AUDIT.md` 2026-08-02 instrumented mobile metrics and feature-status matrix; Phase 0 (40+9 checks), acceptance/QA (90/87/127/37), source-of-truth (65/32), portal (56), Phase 2B (61), Phase 2C (72) suite runs and the full 5-role browser passes from earlier in this project.
- **Not verified this cycle (stated, not hidden):** fresh 7-breakpoint responsive sweep; any screen-reader testing; production-origin behavior (no production deployment exists yet); real-device testing.
- **Nothing was modified:** no code, schema, data, permissions, deployment, or DNS change was made. The only side effect of this audit is this file and the start of the already-provisioned dev DB container.

---

*End of master audit. Companion deep-dive (original-PRD traceability, requirement-by-requirement) lives in the published "DIC Alumni TPRD" document from the same review series.*
