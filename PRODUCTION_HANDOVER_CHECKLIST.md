# Production Handover Checklist — DIC Alumni Platform

**Purpose.** One list, showing for every item whether it is finished in the
codebase or waiting on somebody outside it. It exists so that "is this ready?"
has a checkable answer instead of an opinion.

**Status of the platform as a whole:** the software is complete and tested;
the deployment is not, because several of its inputs are Daffodil International
College's to supply and have not been supplied yet. Nothing in this repository
has ever run on a DIC server. See the readiness matrix at the end.

## How to read the ownership column

| Label | Meaning |
|---|---|
| **READY IN CODE** | Implemented, tested, and verifiable from this repository today. No further engineering. |
| **REQUIRES DIC** | An institutional decision, account, name or person. No amount of code closes it. |
| **REQUIRES HOSTING PROVIDER** | Server, TLS, DNS, cron, off-site storage. Whoever hosts it provides it. |
| **REQUIRES THIRD-PARTY** | An external service account — today that means SMTP, and nothing else. |
| **FUTURE FEATURE** | Deliberately not built. Recorded so it is a decision, not an omission. |

A checkbox is for the person doing the handover to tick against the real
deployment. Everything marked READY IN CODE is already ticked, because the
evidence column says how it was verified.

---

## Part 1 — College and business

| # | Item | Ownership | Status |
|---|---|---|---|
| 1.1 | Public alumni hostname decided and in DNS | REQUIRES DIC + HOSTING PROVIDER | ☐ open |
| 1.2 | Staff portal hostname decided — separate subdomain, or `/admin` on the same host | REQUIRES DIC | ☐ open |
| 1.3 | Named owner of the super-admin account, at DIC, by name | REQUIRES DIC | ☐ open |
| 1.4 | Named second person who can reach the server if 1.3 is unavailable | REQUIRES DIC | ☐ open |
| 1.5 | Who may hold `univ_admin`, `dept_admin`, `moderator` — the policy, not the accounts | REQUIRES DIC | ☐ open |
| 1.6 | Departments and batches the directory should offer | REQUIRES DIC | ☐ open |
| 1.7 | Privacy notice / data-retention statement published to alumni | REQUIRES DIC | ☐ open |
| 1.8 | Decision on whether donations are collected at all in v1 | REQUIRES DIC | ☐ open |
| 1.9 | Payment gateway — **not built.** The ledger records admin-confirmed pledges only; no gateway, no SDK, no card data. | FUTURE FEATURE | n/a |
| 1.10 | Five-role RBAC, enforced server-side on every route | READY IN CODE | ☑ Phase 0/2B suites, 110 checks |
| 1.11 | Alumni directory, profiles, events, ticketing, jobs, mentorship, stories, campaigns | READY IN CODE | ☑ acceptance/QA suites, 343 checks |
| 1.12 | Structured location model — normalised places, real coordinates, no fabricated defaults | READY IN CODE | ☑ `phase5b_location`, 142 checks |

**On 1.9.** The word "donation" appears throughout the product and no money can
move through it. `campaigns.gateways` exists as a column and is now written only
with what a caller supplies — which today is nothing. Until 1.8 is decided,
whoever announces this platform should not describe it as accepting payments.

---

## Part 2 — Technical

| # | Item | Ownership | Status |
|---|---|---|---|
| 2.1 | Node.js 20 LTS or newer on the server (developed on v24.15.0) | REQUIRES HOSTING PROVIDER | ☐ open |
| 2.2 | PostgreSQL 16 or newer (tested against 16.14) | REQUIRES HOSTING PROVIDER | ☐ open |
| 2.3 | Application database and its own role created | REQUIRES HOSTING PROVIDER | ☐ open |
| 2.4 | Base schema plus migrations v2–v19 applied in order | READY IN CODE | ☑ each migration is additive, idempotent, transactional, and has `--dry-run` |
| 2.5 | Process manager (systemd or equivalent) so it restarts after a crash or reboot | REQUIRES HOSTING PROVIDER | ☐ open |
| 2.6 | Reverse proxy passing `Host`, with exactly one proxy hop | REQUIRES HOSTING PROVIDER | ☐ open |
| 2.7 | TLS certificate covering both hostnames | REQUIRES HOSTING PROVIDER | ☐ open |
| 2.8 | Production refuses to boot when a required variable is missing, and names it | READY IN CODE | ☑ `phase5e_production` A, 15 checks |
| 2.9 | Startup banner reports the database actually connected to | READY IN CODE | ☑ `phase5e_production` E |
| 2.10 | No build step, no bundler; five runtime dependencies | READY IN CODE | ☑ `package.json` |
| 2.11 | Full test suite — 1,395 checks across 20 suites | READY IN CODE | ☑ `npm test`, 0 failed |
| 2.12 | Suites live in the repository and survive a clone | READY IN CODE | ☑ `tests/run-all.js` |
| 2.13 | Staging environment separate from production | REQUIRES HOSTING PROVIDER | ☐ open |

---

## Part 3 — Security

| # | Item | Ownership | Status |
|---|---|---|---|
| 3.1 | `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` generated fresh for production | REQUIRES HOSTING PROVIDER | ☐ open |
| 3.2 | All three stored in the institution's password manager | REQUIRES DIC | ☐ open |
| 3.3 | `ENCRYPTION_KEY` recognised as unrecoverable — losing it destroys every identity-vault record permanently | REQUIRES DIC | ☐ open |
| 3.4 | Seeded demo accounts and the shared password absent from production | READY IN CODE | ☑ `rotate_credentials.js --check`; production is not seeded |
| 3.5 | `admin-credentials.local.txt` deleted from the server after provisioning | REQUIRES HOSTING PROVIDER | ☐ open |
| 3.6 | CORS is an allow-list; the wildcard is never sent | READY IN CODE | ☑ `phase5e_production` C — was a wildcard before Phase 5E |
| 3.7 | Each hostname serves its own portal; hostname equality, not substring matching | READY IN CODE | ☑ `phase5e_production` D — the public domain served the staff shell before Phase 5E |
| 3.8 | Session revocation on logout, password change, reset and suspension | READY IN CODE | ☑ `phase2c`, 72 checks |
| 3.9 | Identity vault AES-256-GCM, fails closed without a key | READY IN CODE | ☑ compliance suite |
| 3.10 | Field privacy enforced server-side, not by hiding UI | READY IN CODE | ☑ `phase5a_security`, 70 checks |
| 3.11 | Bulk-import preview escapes every interpolated field | READY IN CODE | ☑ `phase5d_hardening` — a stored XSS reached administrator sessions before Phase 5D |
| 3.12 | CSV export quoted per RFC-4180 with formula-injection guards | READY IN CODE | ☑ `phase5d_hardening` |
| 3.13 | Web root is an allow-list — `.env`, source, dumps and credentials all 404 | READY IN CODE | ☑ verified live, 8 paths |
| 3.14 | Security headers set by the app: nosniff, Referrer-Policy, X-Frame-Options, frame-ancestors | READY IN CODE | ☑ `server.js` |
| 3.15 | `Strict-Transport-Security` — **not** set by the app; belongs to the TLS terminator | REQUIRES HOSTING PROVIDER | ☐ open |
| 3.16 | Per-IP rate limiting on authentication | READY IN CODE | ☑ `phase0_sec`; depends on 2.6 being correct |
| 3.17 | Hash-chained audit trail, independently verifiable | READY IN CODE | ☑ `npm run verify-audit-chain`, 1,766 entries, exit 0 |
| 3.18 | Pre-Phase-5A audit entries are **not** cryptographically verifiable — a stated permanent property, not a defect | READY IN CODE | ☑ `AUDIT_CHAIN.md` §1–2 |
| 3.19 | Independent security review by someone who did not build it | REQUIRES DIC | ☐ open |
| 3.20 | Penetration test before public announcement | REQUIRES DIC | ☐ open |

**On 3.19 and 3.20.** Every security property above was verified by the same
party that implemented it. That is worth something and it is not a substitute
for an outside review. Neither is a code fix; both are DIC's to commission.

---

## Part 4 — Operations

| # | Item | Ownership | Status |
|---|---|---|---|
| 4.1 | `MAIL_TRANSPORT` explicitly chosen — no default any more | READY IN CODE | ☑ `phase5e_production` A — an unset value silently meant `console` before Phase 5E |
| 4.2 | SMTP account for password-reset email | REQUIRES THIRD-PARTY | ☐ open |
| 4.3 | If SMTP is declined: `MAIL_TRANSPORT=none` recorded as a decision, and an operator briefed on `reset_link.js` | REQUIRES DIC | ☐ open |
| 4.4 | Nightly job trigger scheduled (`event-maintenance`, `deletion-purge`, `mentorship-expiry`) | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.5 | `deletion-purge` confirmed to have actually run once | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.6 | Nightly `pg_dump` backup scheduled, `BACKUP_DIR` outside the web root | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.7 | Backups copied to a second machine or off-site | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.8 | Restore drill performed against the production backup | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.9 | Restore tooling — drill into a disposable database, restore into a named one | READY IN CODE | ☑ `restore.js --drill` run: 47 tables, 99 places, audit chain verified on the restored copy |
| 4.10 | Scheduler, backup, email and deletion state visible in the Operations panel | READY IN CODE | ☑ browser-verified |
| 4.11 | Health endpoint reporting database reachability | READY IN CODE | ☑ `GET /api/health` |
| 4.12 | Uptime monitoring / alerting | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.13 | Log retention and rotation | REQUIRES HOSTING PROVIDER | ☐ open |
| 4.14 | Structured request logging with a correlation id, no secrets | READY IN CODE | ☑ `phase4` |
| 4.15 | Deployment runbook | READY IN CODE | ☑ `PRODUCTION_DEPLOYMENT_RUNBOOK.md` |
| 4.16 | Day-2 operations runbook | READY IN CODE | ☑ `OPERATIONS_RUNBOOK.md` |
| 4.17 | A person at DIC trained on both runbooks | REQUIRES DIC | ☐ open |

**On 4.5.** Deletion purge is the only item on this list that breaks a promise
made to a person if it silently never runs. It is scheduled by cron, not by the
application, so nothing inside the platform can guarantee it. Verify it once by
hand and check the Operations panel afterwards.

---

## Part 5 — Deliberately not built

Recorded so none of these is mistaken for an oversight or for something that
exists. Each is a decision, and each is reversible by a future phase.

| Item | Why |
|---|---|
| Payment gateway | Nobody has decided whether money is collected (1.8). Building it first would be building the wrong thing. |
| Map tiles / a map provider | The world map projects real coordinates from `location_places`. No provider, no key, no per-view cost, no third party receiving alumni locations. |
| Per-person latitude and longitude | Coordinates belong to a city record. The platform holds where somebody says they live, not where they are. |
| Mobile applications | Web only. |
| SSO against a DIC identity provider | No identity provider was specified. |
| Deferred P2/P3 findings — `P5C-007`, `P5C-010`, `P5C-011`, `P5C-012`, `P5C-014`–`P5C-020`, `P5C-022`–`P5C-024` | Enumerated with rationale in `POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md`. None blocks handover. |

---

## Readiness matrix

**GREEN** — done and verified. **YELLOW** — the code is done, something outside
it is not. **RED** — blocks go-live and nothing has been done about it.

| Area | Status | Evidence | Owner | Blocking? |
|---|---|---|---|---|
| Application code | GREEN | 1,395 checks, 20 suites, 0 failed | — | no |
| Database schema & migrations | GREEN | v2–v19; additive except the Phase 7D legacy drops, idempotent, `--dry-run`; 48 tables verified on a fresh install | — | no |
| RBAC & authorisation | GREEN | Phase 0/2B/2C suites | — | no |
| Privacy model | GREEN | `privacy.js` single source of truth; 70 checks | — | no |
| Location system | GREEN | 142 checks; no fabricated values, no personal coordinates | — | no |
| Audit trail | GREEN | verified through 1,766 entries, exit 0; historical boundary stated | — | no |
| Production fail-closed config | GREEN | 35 checks; six defects found and fixed in Phase 5E | — | no |
| Backup & restore tooling | GREEN | drill run end to end, audit chain verified on the restored database | — | no |
| Documentation | GREEN | deployment runbook, operations runbook, dependencies, handover checklist, audit reports | — | no |
| Domain & DNS | YELLOW | nothing chosen | DIC + hosting | **yes** |
| TLS & reverse proxy | YELLOW | configuration written, never applied to a real host | hosting | **yes** |
| Server & process manager | YELLOW | systemd unit written, never installed | hosting | **yes** |
| Production secrets | YELLOW | generation and storage documented; not generated | hosting + DIC | **yes** |
| Email delivery | YELLOW | code done and tested; no SMTP account exists | third-party + DIC | **yes** — unless `none` is chosen deliberately (4.3) |
| Scheduled jobs in production | YELLOW | endpoint and jobs done; nothing calls them yet | hosting | **yes** — `deletion-purge` |
| Off-site backup copies | YELLOW | backup and restore done; no second location exists | hosting | **yes** |
| Uptime monitoring | YELLOW | health endpoint exists; nothing watches it | hosting | no |
| Super-admin ownership | YELLOW | provisioning tooling done; no person named | DIC | **yes** |
| Independent security review | RED | never performed | DIC | **yes**, before a public announcement |
| Payment collection | — | not built, by decision | DIC | no — unless 1.8 says yes, and then it is a new phase |

### The honest summary

The engineering is finished to the standard this project has been held to: every
claim above is backed by a test that runs, a drill that was performed, or a
document that says plainly what was not done. Six production-configuration
defects were found in Phase 5E by testing the production path rather than
reading it, and all six are fixed.

**This platform is not ready to go live today, and not because of the code.**
Eight of the nine blocking items are inputs — a domain, a server, TLS, secrets,
an SMTP account, a cron entry, an off-site backup destination, and a named
person. They cannot be closed from inside this repository, and the deployment
runbook stops at step 3 and says so rather than proceeding with placeholders.

The ninth, the independent security review, is the one genuine RED. Everything
in Part 3 was verified by the party that wrote it. Before this is announced to
alumni, somebody else should look.
