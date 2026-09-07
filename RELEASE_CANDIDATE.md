# Release Candidate — DIC Alumni Platform

**Status: RELEASE CANDIDATE — engineering complete, not deployed.**

Recorded 2026-09-08 at the close of Phase 7E, the final engineering quality gate.

This document states what the platform is, what it does, what it deliberately
does not do, and what DIC must supply before it can run in production. It does
**not** claim the platform is deployed, and it does not claim legal compliance.

---

## 1. Build

| | |
|---|---|
| Commit | `0a4710a` (Phase 7E) · parent `e9703e1` |
| Phases complete | 0 through 7E |
| Database schema | v19 · **48 tables** |
| Runtime | Node.js, Express 5, PostgreSQL 16.14 |
| Dependencies | `express`, `pg`, `cors`, `body-parser`, `nodemailer` — five, all first-order |
| Front end | Vanilla JavaScript, no framework, no bundler, no build step |
| Portals | `index.html` (alumni) · `admin.html` (staff) |

There is no build pipeline. The files served are the files in the repository.

---

## 2. Architecture

Two HTML shells load the same JavaScript modules and talk to one Express API
over `fetch`. **The staff portal is not a security boundary**: `admin.html` and
`index.html` differ only in which modules they load, and every authorisation
decision is made by the API on every request, from the role re-read out of the
`users` row — not from the token, and not from which shell was served.

Sessions are HMAC-SHA256 bearer tokens in `localStorage`, revocable through
`token_version`. The audit trail is a SHA-256 hash chain; any edit to a
historical entry breaks verification.

---

## 3. Supported features

| Area | What works |
|---|---|
| Accounts | Self-registration, administrator provisioning, forced first-login password change, suspension, password reset by email, session revocation |
| Verification | Administrator-verified alumni; unverified accounts are refused verified-only actions server-side |
| Departments | Reference table; `dept_admin` scoped to its own department across alumni, events, reports, imports and audit |
| Directory | Search, filters, privacy-filtered fields, division/district filters |
| Privacy | Per-field levels (public / alumni / private); email and mobile carry a documented staff bypass, **location does not** |
| Location | 99 reference places, alumni map aggregation, event venues, chapter locations, job work modes |
| Events (v5) | Create, edit, approve, reject, cancel, tasks, committees, people, external contacts, budget, sponsors, vendors, logistics, marketing, meetings, risks, timeline, volunteers, procurement |
| Tickets | Multiple ticket types, quotas, capacity from live counts, waitlist, signed QR codes, check-in, attendee export |
| Jobs | Post, edit, close, reopen, deadline, apply, applicant management, application status workflow, referrals with accept/decline |
| Polls | Draft → open → closed, one member one vote, closing times enforced, results |
| Donations | Pledge and **manual** settlement by the alumni office, receipts, campaign totals |
| Mentorship | Request, accept, decline, complete |
| Chapters | Create, moderate, join, locations |
| Reports | Ten reports, department-scoped, CSV export |
| Imports | Upload → map → validate → preview → **dry run** → confirm → result → history → rollback |
| Compliance | Privacy centre, consent history, DSAR export, deletion request and cancellation, scheduled purge |
| Audit | Hash-chained, filterable by administrator/action/module/target/date, exportable |
| Operations | Scheduler, backup, restore, off-site copy, monitoring endpoints |

---

## 4. Intentionally unavailable

These are **not** defects. Each is a deliberate decision recorded in PHASE_LOG.md.

| Not available | Why |
|---|---|
| **Online payment** | No gateway is integrated. Donations are pledged and settled **manually** by the alumni office. The interface says so. There is no simulated gateway, no fake PIN entry and no client-declared settlement. |
| File uploads | No storage backend is provisioned. Photos are URLs. |
| Email delivery beyond password reset | SMTP is wired for reset links; broadcasts are in-app only. |
| A map library or tile provider | The map is drawn from `location_places` coordinates. No API key, no tile provider, no attribution obligation — see MAP_TECHNOLOGY.md. |
| Employment-outcome analytics | The schema stores no outcome data, so no chart claims to show it. |
| Mentorship health scoring | Nothing computes it; the report shows days-to-answer, which is arithmetic on two real timestamps. |
| Department scoping for jobs | A job is open to every graduate; `dept_admin` has no administrative authority over jobs at all. |
| XLSX import | CSV only. |

---

## 5. Test results

```
30 suites                        2,515 passed   0 failed   0 skipped
  fresh install drill               32 passed   0 failed
  full release drill               107 passed   0 failed
  audit chain verification            PASS through 18,191 entries
```

The **release drill** is the strongest single result: an empty PostgreSQL
database is created, migrated through v19, bootstrapped with a first
administrator, and then the entire product is exercised through the API a real
operator would use — registration, verification, event, ticket types,
registration, QR check-in, job, application, poll, vote, mentorship, donation
pledge and manual settlement, all ten reports, CSV export, an import with a dry
run and a rollback, and audit chain verification — on a database that started
the run with nothing in it.

Skipped is counted as skipped. There are none.

---

## 6. Security results

| Check | Result |
|---|---|
| Authorization matrix | 152 routes; 70 probed as all five roles and anonymous — **420 checks, every one matching its declared guard**. Regenerated mechanically into SECURITY_AUTHORIZATION_MATRIX.md |
| Role escalation | None. No member reaches an administrator route; no moderator reaches an `ADMIN_ROLES` route; no department admin reaches a `SUPER_ONLY` route |
| Department scope bypass | Attempted through `?id=`, `?department=`, `?departmentId=`, `?limit=`, `?eventId=`, `format=csv` and import fields — **scope held in every case** |
| Account enumeration | A wrong password and an unknown address return the same response |
| Session revocation | A password change invalidates every session opened under the old one; a suspension takes effect mid-session |
| Brute force | Rate limited |
| Stored XSS | No unreviewed interpolation of attacker-controllable text reaches a template; three sites reviewed and recorded as safe with reasons |
| CSV injection | `=`, `+`, `-`, `@` and control-character leads are neutralised; verified against eleven hostile payloads including Bengali text and a DDE payload |
| Credential export | `csv.js` refuses any column whose name reads as a credential; no DSAR field is a credential |
| Error disclosure | Six forced failure modes disclose no PostgreSQL internals, no stack traces, no paths, no secrets |
| Audit chain | Verifies through 18,191 entries after the full QA run |

### What the Content-Security-Policy actually protects

Read off the wire:

```
staff:  frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
alumni: frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

- **frame-ancestors** — clickjacking. The staff portal refuses to be framed.
- **object-src** — plugin-based injection.
- **base-uri** — `<base>` injection, which would silently re-point every relative URL including the API calls.
- **form-action** — a hijacked form posting elsewhere.

**`script-src` is absent, and that is the known gap.** The application uses
inline event-handler attributes throughout, so any workable `script-src` would
have to include `'unsafe-inline'` — a directive that looks like a defence
without being one. Moving to delegated listeners is the prerequisite; it is an
architecture change, not a header change. Tracked in
FINAL_SECURITY_REVIEW_FOLLOWUPS.md.

Also set: `X-Frame-Options`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and `X-Robots-Tag: noindex,
nofollow` on the staff portal only.

---

## 7. Data integrity

A fingerprint — row count plus an md5 over the substance of each table — was
taken before the QA run and again after.

**25 of 28 tables are byte-identical.** The three that moved:

| Table | Before | After | Why |
|---|---|---|---|
| `audit_logs` | 16,841 | 19,065 | Append-only growth from the test runs. Chain verifies. |
| `import_history` | 418 | 3 | 447 test batches from phases 2–7D removed. Only batches with no surviving accounts were deleted; the one genuine institutional record survives. |
| `notifications` | 5,048 | 1,269 | 4,528 orphaned test notices removed — role-targeted notices naming probe accounts that no longer exist. The 4 naming real accounts were kept. |

No business table changed: users, profiles, events, ticket types,
registrations, tasks, jobs, applications, referrals, polls, votes, donations,
campaigns, chapters, memberships, mentorships, places and departments are all
identical, byte for byte.

Orphan checks after cleanup: 0 orphaned notification references, 0 users
pointing at a deleted import batch, 0 orphan profiles or registrations, 0
duplicate emails or student ids, 0 audit entries missing a digest.

---

## 8. Browser results

Both portals, every major page, seven viewports — 360, 390, 430, 768, 1024,
1280, 1440.

| Portal | Pages | Widths | Result |
|---|---|---|---|
| Staff (`admin.html`) | 17 | all seven | No overflow, no clipping |
| Alumni (`index.html`) | 11 | all seven | No overflow, no clipping |

Zero JavaScript errors on either portal. Wide tables scroll inside their own
containers; the page body never scrolls sideways.

Accessibility: no unlabelled control on any page checked, every button typed,
`lang` set, live regions present, `prefers-reduced-motion` honoured, and the
Phase 7A modal rule holds — a backdrop click leaves a data-entry form open with
its typed value intact.

---

## 9. Known limitations

| Limitation | Detail |
|---|---|
| `script-src` absent from the CSP | Inline event-handler attributes are the prerequisite. Tracked. |
| No skip-to-content link | WCAG 2.4.1 (Level A). With a 17-item sidebar a keyboard user tabs through the navigation on every page. Not added here: Phase 7E restricts UI changes to three specific cases and this is none of them. |
| One alumnus has no department | Their department was never captured — the import wrote an HSC group there. Institution-wide roles see them; no department admin does. There is no correct value to infer. |
| 20 of 21 events belong to no department | `organizer_department` was blank or a test label on all but one. They are institution-wide. |
| The free-text `department` columns remain | Beside the relation. They are `NOT NULL` and several hold text no department could represent. `department_id` is the authority. |
| Donation statuses are UPPERCASE | The only such column. Documented in STATUS_VOCABULARY.md rather than migrated: they are financial records named across queries, reports, tests and the ledger export. |
| Batch import credential is per batch | Everyone in one import shares an initial password until they change it. The `invite` strategy generates none at all and is the per-account answer where addresses are readable. |
| Rollback cannot undo an enrichment | A batch that updated an existing profile changed columns in place; previous values were not kept. Only account creation is undone. |
| Reports are read into memory | 5,000 rows on screen, 50,000 in a file. A capped result says so. |
| `test_e2e_crud.js` | A legacy development script the Master Audit says to keep as historical tooling. It references columns Phase 7D dropped and **would fail if run**. Excluded from any production image. Tracked as INFO-1. |
| `install_drill.js` and `phase7e_release_drill.js` need `DOCKER_PG_CONTAINER` | They create and drop their own databases and are not part of `npm test`. |
| Backend without UI | `alumni_profiles.collaboration`, `looking_for_job`, `looking_for_mentor`; `broadcasts.read_count`; `event_sponsors.logo_url`; `event_task_assignees.assigned_at`. Coherent fields with no screen yet. Deferred, not removed — Phase 7E forbids both adding features and changing schema for tidiness. |

---

## 10. Production prerequisites

### ENGINEERING READY — nothing further is required from the developer

- Application code, both portals, and the API
- Database schema and migrations v2–v19, transactional and dry-run capable
- First-administrator bootstrap (`rotate_credentials.js --create-super-admin`)
- Scheduler, backup, restore, off-site copy and monitoring endpoints
- Secret validation: the server refuses to start in production without the required secrets
- Origin pinning through `PUBLIC_ORIGIN` and `ADMIN_ORIGIN`
- Documentation: PRODUCTION_PROVISIONING, OPERATIONS_RUNBOOK, DIC_PRODUCTION_HANDOVER_CHECKLIST, KEY_MANAGEMENT, AUDIT_CHAIN, DEPARTMENT_SCOPE, STATUS_VOCABULARY, MAP_TECHNOLOGY

### EXTERNAL — DIC must supply these; the platform cannot proceed without them

| Blocker | Needed for |
|---|---|
| A hosting decision and a VPS | Everything |
| A domain and DNS control | Origins, TLS, the admin subdomain |
| TLS certificates | HTTPS |
| A PostgreSQL instance (managed or self-hosted) with credentials | Everything |
| SMTP credentials | Password reset delivery |
| A backup destination and retention decision | Backup and restore |
| Monitoring destination | Alerting |
| Production secrets: `SESSION_SECRET`, `ENCRYPTION_KEY`, `TICKET_SIGNING_KEY`, `CRON_SECRET` | The server refuses to start without them |
| Encryption-key escrow procedure and owner | Identity vault recovery |
| Named super-admin owner and emergency recovery owner | Accountability |
| An independent security review | DIC's own gate |
| College UAT | DIC's own gate |

**No infrastructure value has been invented.** Every placeholder in the
provisioning documents is marked as a placeholder.

---

## 11. Legal position

The platform implements consent logging, a data-subject export, deletion
requests with a scheduled purge, field-level privacy and an immutable audit
trail.

**No claim of GDPR, PDPA or any other legal compliance is made anywhere in the
product or in this document.** Whether these mechanisms satisfy a particular
statute is a legal assessment DIC must obtain; it has not been performed and
nothing here substitutes for it.

---

## 12. Recommendation

The platform is **engineering-complete and ready for DIC provisioning and
UAT**. It is not deployed, and this document does not claim it is.

The three things worth doing before real users arrive, in order:

1. Obtain the external inputs in §10 — nothing can proceed without them.
2. Commission the independent security review (§10) — the platform's own tests
   cannot substitute for an adversarial reader.
3. Plan the `script-src` work (§6). It is the one security gap that is
   understood, tracked, and not closed.
