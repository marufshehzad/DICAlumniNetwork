# Production Dependencies — what is built, and what DIC must still provide

This document exists to keep two things apart that are easy to blur: work that
is finished and tested in the codebase, and decisions or accounts that only
Daffodil International College can supply. Nothing below is invented. Where a
value is the institution's to choose, it is a placeholder marked
**`REQUIRED FROM DIC`** — those are not oversights, and the platform cannot go
live until they are filled in by someone with the authority to decide them.

Last updated at the end of Phase 5A.

---

## Part 1 — Implemented and tested

Each line is backed by an automated test or a drill that has actually been run
against a real database.

| Capability | State | Evidence |
|---|---|---|
| 5-role RBAC, enforced server-side on every route | Done | Phase 0/2B suites |
| Two portals — alumni site and staff portal at `/admin`, host-routable | Done | Portal suite (56 checks) |
| Session revocation (`token_version`) on logout, password change, reset, suspension | Done | Phase 2C suite |
| Self-service password recovery — hashed single-use token, 30-minute expiry | Done | Phase 2C/3 suites |
| Password reset delivered by **SMTP** | Done | Phase 4 suite; needs an account (Part 2) |
| Events & ticketing — capacity, waitlist, signed QR, check-in | Done | Acceptance/QA suites |
| Identity vault — AES-256-GCM, fails closed without a key | Done | Compliance suite |
| Donation ledger — pledge model, admin-confirmed settlement only | Done | Phase 3 suite |
| Scheduler — event maintenance, deletion purge, mentorship expiry | Done | Phase 4 suite (147 checks) |
| 30-day account deletion purge, actually executed | Done | Purge drill (27 checks) |
| Nightly `pg_dump` backup, 14-day retention | Done | Phase 4 suite |
| Restore drill against a disposable database | Done, run | `node restore.js --drill` |
| **Verifiable audit chain** from the Phase 5A boundary | Done | Phase 5A suite + 49 tamper checks |
| **Independent audit verifier** (`npm run verify-audit-chain`) | Done | Detects every tampering type in the Phase 5A tamper suite; the limits it cannot detect are stated in `AUDIT_CHAIN.md` §4 |
| Field-privacy settings that persist and are enforced | Done | Phase 5A suite |
| Web root is an allow-list; `.env`, credentials and backups all 404 | Done | Phase 3/4 suites |
| Production refuses to boot without its required secrets | Done | Phase 3/4 suites |
| Structured request logging with a correlation id, no secrets | Done | Phase 4 suite |
| Operations panel — job, backup, email and deletion state | Done | Browser-verified |

---

## Part 2 — Required from DIC or the hosting provider before go-live

### 2.1 Domain and DNS

| Item | Needed | Status |
|---|---|---|
| Public alumni domain | e.g. `alumni.<dic-domain>` | **REQUIRED FROM DIC** |
| Staff portal subdomain | e.g. `admin.<dic-domain>` | **REQUIRED FROM DIC** |
| DNS zone ownership — who can create these records | Name and department | **REQUIRED FROM DIC** |
| DNS records created and pointing at the deployment | CNAME/A | **REQUIRED FROM DIC** |

The application needs both origins set as environment variables:

```bash
PUBLIC_ORIGIN=https://<the alumni domain>
ADMIN_ORIGIN=https://admin.<the domain>
```

No domain is hardcoded anywhere in the code. These two variables are also the
entire CORS allow-list, and `ADMIN_ORIGIN` is what makes a request for the staff
portal resolve to the staff portal.

### 2.2 Hosting

| Item | Needed | Status |
|---|---|---|
| Hosting account owner | Vercel team, or the VPS and who administers it | **REQUIRED FROM DIC** |
| Deployment shape | Vercel serverless, or `node server.js` behind a reverse proxy | **REQUIRED FROM DIC** |
| Who may deploy | Named people | **REQUIRED FROM DIC** |

Both shapes are supported and tested. The choice determines which scheduler is
enabled — the `crons` block in `vercel.json`, or `ops/cron-dic.sh` in a crontab.
**Exactly one of the two, never both.**

### 2.3 PostgreSQL and backups

| Item | Needed | Status |
|---|---|---|
| Database host | Managed (Neon/RDS/Supabase) or self-hosted | **REQUIRED FROM DIC** |
| `BACKUP_DIR` | A path outside the application directory and outside any web root | **REQUIRED FROM DIC** |
| Off-site backup destination | A backup on the same server does not survive losing that server | **REQUIRED FROM DIC** |
| Encryption at rest for the backup volume | A dump holds every alumnus's personal data | **REQUIRED FROM DIC** |
| Point-in-time recovery | Available? Enabled? Retention window? | **REQUIRED FROM DIC** |
| Retention period | Default 14 days; confirm this meets institutional policy | **REQUIRED FROM DIC** |
| Who is authorised to restore | Restoring discards everything since the backup | **REQUIRED FROM DIC** |

`pg_dump` and PITR are not equivalent and the runbook says so: a dump recovers
to last night, PITR recovers to a moment. If the institution cannot accept
losing up to 24 hours of registrations and profile edits, PITR is required and
`pg_dump` becomes the second line.

### 2.4 Email

| Item | Needed | Status |
|---|---|---|
| SMTP provider and account | Any standard provider | **REQUIRED FROM DIC** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Credentials | **REQUIRED FROM DIC** |
| `SMTP_FROM` | A sending address on a DIC domain | **REQUIRED FROM DIC** |
| SPF/DKIM for that domain | Or reset emails land in spam | **REQUIRED FROM DIC** |

Without this, `MAIL_TRANSPORT` must be set to `none`, and every password reset
requires an operator with server access to run `reset_link.js` by hand. That is
workable for the super admin and impractical for everyone else.

### 2.5 Secrets

| Secret | Purpose | Status |
|---|---|---|
| `SESSION_SECRET` | Signs session tokens | **REQUIRED FROM DIC** — generate and escrow |
| `ENCRYPTION_KEY` | Identity vault + ticket QR signing | **REQUIRED FROM DIC** — generate and escrow |
| `CRON_SECRET` | The scheduler's credential | **REQUIRED FROM DIC** — generate and store |

Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Production refuses to start if any is missing or malformed. See §2.6 for escrow.

### 2.6 `ENCRYPTION_KEY` escrow — the one that cannot be recovered

`ENCRYPTION_KEY` encrypts the identity vault (NID, BRC, passport) with
AES-256-GCM. **If it is lost, those records are unrecoverable by anyone,
including the developers.** They cannot be recovered from a backup either: the
backup holds ciphertext, and the key is not in the backup. It also signs event
ticket QR codes, so changing it invalidates every ticket already issued.

| Item | Needed | Status |
|---|---|---|
| Where the escrow copy is held | Institution password manager, or a sealed offline record with the institution's other critical credentials | **REQUIRED FROM DIC** |
| Who is authorised to retrieve it | Named roles, not named individuals who may leave | **REQUIRED FROM DIC** |
| How retrieval is authorised | Two-person rule? Written request? | **REQUIRED FROM DIC** |
| When escrow readability was last tested | Retrieve it and compare against the running value | **REQUIRED FROM DIC** |

**How recovery is performed** — the procedure, which DIC should rehearse once
before go-live:

1. Retrieve the escrowed value under whatever authorisation §2.6 defines.
2. Set `ENCRYPTION_KEY` in the deployment environment.
3. Start the application. It refuses to boot on a malformed key, which is the
   first confirmation the value is intact.
4. Confirm the vault decrypts: sign in as a `univ_admin` or `super_admin`, open
   Compliance → identity vault, and reveal one record with a stated reason. A
   wrong key fails the GCM authentication tag and reports a data-integrity
   failure rather than returning wrong data.
5. That reveal is itself audited, in `vault_access_logs` and the audit chain, so
   the rehearsal leaves its own evidence.

**How recovery is tested** — quarterly, or at each term end: retrieve the
escrowed copy, confirm it is readable and matches the running deployment, and
record the date in the runbook's appendix. An escrow nobody has ever opened is
an assumption, not a backup.

> **Verification status.** The escrow procedure above is written and testable,
> but it **cannot be verified from this development environment**: there is no
> institutional password manager here to read, and the development key is a
> local throwaway. This is an **institutional deployment dependency**, not a
> completed item. Marking it done would be false.

The application never prints these values: the startup error names a missing
variable, never its content, and this is asserted by test.

### 2.7 Monitoring and alerting

| Item | Needed | Status |
|---|---|---|
| External monitoring service | Any uptime service | **REQUIRED FROM DIC** |
| Alert destination | Email/SMS/on-call — who is woken | **REQUIRED FROM DIC** |
| Alert thresholds | Suggested: two consecutive failures at 60s | Suggested, confirm |

The contract for a monitor is fixed and documented:

```
GET  https://<domain>/api/health
200  {"status":"ok","database":"ok"}          healthy
503  {"status":"degraded","database":"unreachable"}   database down
no answer / other                              application down
```

A monitor on the same machine as the application cannot tell you the machine is
unreachable, so this must be external.

### 2.8 TLS

| Item | Needed | Status |
|---|---|---|
| Certificate for both origins | Including the admin subdomain | **REQUIRED FROM DIC** |
| Who owns renewal | Automatic on Vercel; manual or certbot on a VPS | **REQUIRED FROM DIC** |

### 2.9 People

The runbook's escalation table is unusable until these are filled in. An
escalation path written during an incident is not an escalation path.

| Role | Responsibility | Status |
|---|---|---|
| First responder (platform) | Site down, database down | **REQUIRED FROM DIC** |
| DIC IT contact | Anything touching alumni data | **REQUIRED FROM DIC** |
| Data-protection owner | Data exposure, deletion disputes, key loss | **REQUIRED FROM DIC** |
| Hosting provider support | Provider-side outage, PITR requests | **REQUIRED FROM DIC** |
| Database/restore authority | Who may authorise a restore | **REQUIRED FROM DIC** |
| Super admin emergency recovery | Who holds the sealed credential | **REQUIRED FROM DIC** |

### 2.10 Super admin emergency recovery

There is one `super_admin` account. If it is lost, nobody can provision
administrators, change roles, or reach the audit log. The runbook (section I)
sets out two options; the institution must choose one and record it:

- **A sealed backup credential** — a second `super_admin` whose password is
  generated once, sealed, and stored with the institution's constitutional
  documents. Never used for daily work; every sign-in audited.
- **A documented offline recovery procedure** using database access.

| Item | Status |
|---|---|
| Which option is in force | **REQUIRED FROM DIC** |
| Where the sealed record is kept | **REQUIRED FROM DIC** |
| Who may open it, and on whose authority | **REQUIRED FROM DIC** |

### 2.11 Retention and policy

| Item | Needed | Status |
|---|---|---|
| Audit log retention | Currently unbounded — entries are never deleted | **REQUIRED FROM DIC** |
| Backup retention | Default 14 days | **REQUIRED FROM DIC** to confirm |
| Deletion grace period | Currently 30 days, matching what the UI promises | **REQUIRED FROM DIC** to confirm |
| Historical audit PII | See below | **REQUIRED FROM DIC** to accept |

**A disclosure the institution must accept in writing.** Audit entries written
before the Phase 5A boundary contain some alumni names and email addresses in
their metadata. They cannot be scrubbed without destroying the hash chain that
protects every entry after them, and they cannot be verified either, because
the original digest input was never persisted. Entries written from the boundary
forward reference people by internal id only. The reasoning is in
`AUDIT_CHAIN.md` sections 1 and 4; DIC's data-protection owner should confirm
they accept preserving that history in exchange for keeping the evidence intact.

---

## Part 3 — Known limitations at this point

Neither is a defect; both are scope decisions the institution should know about.

1. **No payment gateway.** Donations are pledges confirmed by staff; paid event
   tickets cannot be sold online. This is stated in the UI, the README and the
   audit trail. Integrating bKash or another provider is a separate phase and
   needs merchant credentials from DIC.
2. **Legacy audit entries are not verifiable.** Everything before the Phase 5A
   boundary. Documented, reported honestly by the verifier, and impossible to
   fix retrospectively.
