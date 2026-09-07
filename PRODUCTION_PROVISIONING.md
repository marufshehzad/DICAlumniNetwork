# Production Provisioning — DIC Alumni Platform

**Purpose.** Phase 6 finished the engineering. This document answers the
questions that remain before the platform can serve real alumni: *where does it
run, what must DIC supply, and how do we know it works.*

It makes one recommendation and shows the evidence for it. It does not
provision anything — the accounts, the domain and the server are DIC's to
obtain, and no credential is invented anywhere in this repository.

**Status: BLOCKED on external inputs.** The engineering is done and the
mechanisms are proven. Section F lists exactly what is missing and who owns it.

---

## A. Recommended hosting: **a VPS (or any ordinary Linux VM)**

Not Vercel. The recommendation follows from what this platform's operations
actually require, not from preference.

### The evidence

**1. Three of the platform's operational tools cannot run on Vercel at all.**

| Script | Needs | On Vercel |
|---|---|---|
| `backup.js` | `pg_dump`, a writable directory that persists | No `pg_dump` binary; the filesystem is read-only apart from `/tmp`, which is discarded when the invocation ends |
| `restore.js` | `psql`, a dump on disk, minutes of runtime | Same, plus the execution time limit |
| `offsite.js` | A dump on disk to read and ship | Nothing to read — the dump never persisted |

`npm run backup`, `npm run restore-drill`, `npm run offsite`, `npm run drills`,
`npm run drill-install` and `npm run drill-ops` are all unavailable.

**2. The monitoring built in Phase 6 would be permanently blind.**
`/api/internal/monitor` and `/api/ops/status` read `last-backup.json` and
`last-offsite.json` from `BACKUP_DIR` (`server.js:2982`). On Vercel the backup
runs somewhere else entirely — the database provider — and writes no receipt the
application can read. The monitor would report *"no backup has ever been
recorded"* for ever, so the operator would learn to ignore it, which is worse
than having no monitor.

**3. The login throttle is per-process, and serverless multiplies processes.**
`loginAttempts` is an in-memory `Map` (`server.js:618`). Thresholds of 5 failures
per account and 20 per IP become 5×N and 20×N across N warm instances. The
durable `users.locked_until` column is the compensating control and it only
counts failures against accounts that exist — so an attacker spraying addresses
gets N times the budget.

**4. Connection exhaustion.** `pg.Pool` is configured `max: 10` per process
(`db.js:77`). A managed PostgreSQL typically allows 20–100 connections in total.
Three or four concurrent serverless instances exhaust it. A VPS runs one process
with one pool of ten.

**5. The first-administrator bootstrap needs a shell.**
`rotate_credentials.js --create-super-admin` writes `admin-credentials.local.txt`
to disk. There is no shell on Vercel and no disk to write to.

**6. The scheduler loses its best property.** On a VPS, `scheduler.js` talks to
the database directly, so the nightly deletion purge still runs when the web
process is unhealthy — which is exactly when nobody is watching. On Vercel the
only path is HTTP into the application, so an application that is failing takes
the purge down with it.

### What Vercel would still give

Managed TLS, atomic deploys with instant rollback, and a cron that works. Those
are real. They do not outweigh losing backup, restore, off-site, monitoring
fidelity, rate-limiting integrity and the bootstrap path.

### If DIC chooses Vercel anyway

It is a defensible choice for an institution with no server administrator, and
this is what it costs. Everything in this box must be arranged before go-live:

- **Backups** become the database provider's responsibility entirely (Neon,
  Supabase and Render all offer automated backups with point-in-time recovery).
  Record the retention window, and **test a restore through their console** —
  `restore.js` cannot do it for you.
- **`/api/internal/monitor` will always report the backup as missing.** Either
  accept that and monitor backups through the provider's own alerting, or
  disable that check. Do not leave a monitor that cries wolf nightly.
- **Set `TRUST_PROXY=1`** — Vercel is one hop.
- **Use a connection pooler** (PgBouncer, Neon's pooled endpoint, Supabase's
  transaction pooler) and lower `max` in `db.js`, or the pool exhausts.
- **Create the first administrator** by connecting to the database from a local
  machine with the production credentials and running
  `rotate_credentials.js --create-super-admin` there.
- **Keep `vercel.json`'s crons** and delete `ops/cron-dic.sh` from the
  deployment so there is no chance of both.
- Accept that the rate-limit thresholds are per-instance.

The rest of this document assumes the VPS recommendation. Where it differs for
Vercel, it says so.

---

## B. The production architecture

```
                     alumni.<domain>          admin.alumni.<domain>
                            │                          │
                            └───────────┬──────────────┘
                                        │  TLS terminated here
                              ┌─────────▼─────────┐
                              │  nginx (one hop)  │  HSTS, Host preserved
                              └─────────┬─────────┘
                                        │  http://127.0.0.1:8000
                              ┌─────────▼─────────┐
                              │  node server.js   │  systemd, Restart=on-failure
                              │  one process      │  TRUST_PROXY=1
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │   PostgreSQL 16   │  localhost or private network
                              └─────────┬─────────┘
                                        │
   cron 02:10 ──► ops/cron-dic.sh ──────┤
                    │                   │
                    ├─ backup.js ───────┘  pg_dump → BACKUP_DIR (outside the app)
                    ├─ offsite.js ─────────► encrypted object → off-site storage
                    ├─ scheduler.js ───────► the three jobs, direct to the database
                    └─ Sundays: restore.js --drill

   cron */5   ──► ops/healthcheck.sh ──► ALERT_CMD on DOWN or DEGRADED
   external monitor ──► GET /api/health         (200 / 503 / no answer)
   external monitor ──► GET /api/internal/monitor  (jobs, backups, off-site)
```

**One process, one pool, one scheduler, one place the data lives.** Every
operational script runs on the same machine as the database, which is what makes
`pg_dump`, the receipts, and the direct-to-database scheduler work.

### Server requirements

| | |
|---|---|
| OS | Any current Linux with systemd. Ubuntu LTS or Debian stable is the least surprising choice. |
| CPU / RAM | 2 vCPU, 4 GB. The platform is not compute-heavy, but `scryptSync` blocks the event loop during sign-in and PostgreSQL wants headroom. 2 GB would work; 4 GB avoids thinking about it. |
| Disk | 40 GB. The database is small (a 1.7 MB dump today); the space is for 14 days of local backups and log growth. |
| Node.js | 20 LTS or newer. Developed and tested on v24.15.0. |
| PostgreSQL | 16. Developed and tested against 16.14. |
| Required binaries | `pg_dump`, `psql`, `curl`, `gzip`, `openssl` — all present on a default install with the PostgreSQL client package |
| Network | Ports 80 and 443 inbound. **Port 8000 must not be reachable from outside** — see the note on `TRUST_PROXY` below. |
| Backups | `BACKUP_DIR` on a path outside `/srv/dic-alumni`, ideally a separate volume |

**The port matters.** `TRUST_PROXY=1` tells the application to believe
`X-Forwarded-For`. If port 8000 is reachable directly, a client bypassing nginx
can forge that header and evade the login throttle entirely — measured in Phase
5F: 32 wrong passwords, zero refusals. Bind the application to `127.0.0.1` or
firewall the port.

---

## C. Exact prerequisites from DIC

Nothing below can be done from this repository. Each line needs a person with
authority to decide or an account somebody must open.

| # | What | Owner | Blocks |
|---|---|---|---|
| 1 | **The hosting decision** — accept the VPS recommendation, or choose Vercel and accept section A's trade-offs | DIC | Everything |
| 2 | A Linux VM meeting section B | DIC / hosting provider | Everything |
| 3 | The domain, and the decision on one host or two | DIC | DNS, TLS, `PUBLIC_ORIGIN`, `ADMIN_ORIGIN` |
| 4 | DNS records (section D) | Whoever holds the DNS zone | TLS, go-live |
| 5 | A TLS certificate covering both names | Hosting provider (Let's Encrypt is free and automatable) | Go-live |
| 6 | An **SMTP account** — host, port, username, password, and a sender address on a domain DIC controls | DIC + a mail provider | Self-service password reset |
| 7 | An **off-site storage destination** — an S3-compatible bucket, an ssh target, or an rclone remote | DIC / hosting provider | Disaster recovery |
| 8 | A **backup encryption passphrase**, generated and escrowed | DIC | Encrypted off-site backups |
| 9 | An **uptime monitoring service** and an on-call address | DIC | Knowing the site is down |
| 10 | The **named owner of the super-admin account** | DIC | Go-live |
| 11 | **Two named people** who can reach the secret escrow | DIC | Disaster recovery |
| 12 | An **independent security review** | DIC | Public announcement |
| 13 | Retention policy sign-off: 14 days local, and the off-site schedule | DIC's data-protection owner | Backup configuration |

---

## D. DNS records required

Two hostnames is the recommended shape. Replace `<domain>` with DIC's domain and
`<server-ipv4>` / `<server-ipv6>` with the VM's addresses.

| Type | Name | Value | TTL | Notes |
|---|---|---|---|---|
| `A` | `alumni` | `<server-ipv4>` | 3600 | The alumni site |
| `A` | `admin.alumni` | `<server-ipv4>` | 3600 | The staff portal |
| `AAAA` | `alumni` | `<server-ipv6>` | 3600 | Only if the VM has IPv6 |
| `AAAA` | `admin.alumni` | `<server-ipv6>` | 3600 | Only if the VM has IPv6 |
| `CAA` | `alumni` | `0 issue "letsencrypt.org"` | 3600 | Optional; restricts who may issue certificates |

A `CNAME` from `admin.alumni` to `alumni` also works and is easier to move
later. Use `A` records if the certificate tooling is simpler that way.

**For the single-host option**, only the first record is needed; staff reach the
portal at `alumni.<domain>/admin`.

### Records the mail provider will require

Supplied by whichever provider DIC chooses; the shapes are standard. Without
these, reset emails will be rejected or filed as spam.

| Type | Name | Purpose |
|---|---|---|
| `TXT` | `<domain>` | SPF — authorises the provider to send as `<domain>` |
| `TXT` | `<selector>._domainkey.<domain>` | DKIM — the provider's signing key |
| `TXT` | `_dmarc.<domain>` | DMARC policy, e.g. `v=DMARC1; p=quarantine; rua=mailto:postmaster@<domain>` |

**Do not configure any of these yet.** No DNS credentials or instructions exist,
and §8 of the phase brief is explicit that they should not be guessed at.

---

## E. Environment variables required

`.env` on the server, mode `0600`, owned by the service account. Full reference
in `.env.example`; this is the production subset.

### Required — production refuses to boot without these

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | From section I — or a single `DATABASE_URL` |
| `SESSION_SECRET` | 64 hex characters, generated on the server |
| `ENCRYPTION_KEY` | Exactly 64 hex characters. **Escrow before the first vault record is written** |
| `CRON_SECRET` | 32+ characters |
| `MAIL_TRANSPORT` | `smtp` — or `none`, as a recorded decision |
| `PUBLIC_ORIGIN` | `https://alumni.<domain>` |
| `ADMIN_ORIGIN` | `https://admin.alumni.<domain>`, or the same as `PUBLIC_ORIGIN` for one host |
| `BACKUP_DIR` | An absolute path **outside** `/srv/dic-alumni` |

### Required when the corresponding feature is on

| Variable | When |
|---|---|
| `SMTP_HOST` `SMTP_FROM` | `MAIL_TRANSPORT=smtp` |
| `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` | As the provider requires |
| `TRUST_PROXY=1` | Behind nginx. **Wrong in both directions** — see section B |
| `OFFSITE_CMD` | To have an off-site copy at all |
| `OFFSITE_ENCRYPT_CMD` | When the destination cannot encrypt at rest |
| `ALERT_CMD` | To have `ops/healthcheck.sh` raise anything |
| `PG_DUMP` | Only if `pg_dump` is not on the cron `PATH` |

### Generating the three secrets, on the server

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('CRON_SECRET='    + require('crypto').randomBytes(32).toString('hex'))"
```

Never reuse a development value, never copy one from a document, never commit
any of them. Put all three into the escrow (`KEY_MANAGEMENT.md` section 4)
while they are still on screen.

---

## F. The production environment checklist

Tick each against the real deployment. Nothing here is ticked yet.

### Server
- [ ] VM provisioned to section B
- [ ] `dic-alumni` service account, not root
- [ ] Node 20+ and PostgreSQL 16 client tools installed
- [ ] Application at `/srv/dic-alumni`, `npm ci --omit=dev`
- [ ] systemd unit installed, enabled, `Restart=on-failure`
- [ ] Application bound to `127.0.0.1` **or** port 8000 firewalled

### PostgreSQL
- [ ] 16.x running
- [ ] Application database and its own non-superuser role
- [ ] `schema.sql` then `migrate_v2.js` … `migrate_v19.js` applied in order
- [ ] `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'` returns **47**
- [ ] `seed.sql` **not** run; `DIC_SEED_DEMO` **not** set
- [ ] Connections restricted to the application host

### Domain and TLS
- [ ] Both hostnames resolve (section D)
- [ ] Certificate covers both, and renews automatically
- [ ] nginx passes `Host` and `X-Forwarded-For`, sends HSTS
- [ ] `https://alumni.<domain>` serves the alumni site
- [ ] `https://admin.alumni.<domain>` serves the **staff** portal

### Secrets
- [ ] Three secrets generated on the server, never reused
- [ ] In `.env`, mode `0600`
- [ ] In the escrow, with generation dates
- [ ] Two named people can reach the escrow
- [ ] `admin-credentials.local.txt` moved to the password manager and deleted

### Scheduler
- [ ] `ops/cron-dic.sh` in the deploy user's crontab at 02:10
- [ ] `vercel.json`'s crons **not** in play
- [ ] `node scheduler.js --list` shows all three jobs having run
- [ ] `ops_runs.source` shows one trigger only

### Backup and off-site
- [ ] `BACKUP_DIR` outside the application directory, mode `0700`
- [ ] A dump appears overnight; `last-backup.json` says `ok`
- [ ] `OFFSITE_CMD` configured and an object arrives at the destination
- [ ] `OFFSITE_ENCRYPT_CMD` configured, or the destination encrypts at rest
- [ ] The backup passphrase is escrowed **separately from the backups**
- [ ] A restore has been performed from the off-site copy, not just the local one

### SMTP
- [ ] Provider account, sender on a domain DIC controls
- [ ] SPF, DKIM, DMARC published (section D)
- [ ] `MAIL_TRANSPORT=smtp`
- [ ] A real reset email received at a real external mailbox
- [ ] Credentials in `.env` only

### Monitoring
- [ ] External uptime monitor on `GET /api/health`, alerting on two consecutive failures at 60s
- [ ] A second check on `GET /api/internal/monitor` with the `X-Cron-Key` header
- [ ] `ops/healthcheck.sh` in cron every five minutes
- [ ] `ALERT_CMD` configured, and **an alert has been received by a human**
- [ ] On-call address recorded

### Logs
- [ ] `journalctl -u dic-alumni` shows the application
- [ ] `/var/log/dic-alumni-cron.log` shows the nightly run
- [ ] logrotate configured (`OPERATIONS_RUNBOOK.md` section R)
- [ ] No secret appears in any log

---

## G. What has been verified, and what has not

The distinction matters more than the checklist. Everything below was executed;
nothing was assumed.

### Proven, repeatably, in this repository

| | Evidence |
|---|---|
| A fresh install works | `tests/install_drill.js` — 48 tables from nothing, first administrator created, signed in |
| The whole product works on a fresh install | `tests/phase7e_release_drill.js` — registration, verification, event, ticket, check-in, job, poll, donation, reports, import, rollback and audit, all on a database that started empty |
| Deletion purge is correct | `tests/ops_drill.js` — expired purges, unexpired does not, cancelled does not |
| Backup and restore work | `tests/ops_drill.js` — counts, vault bytes, audit chain on the restored copy |
| **Encrypted off-site round trip** | `tests/offsite_drill.js` — compress, encrypt, ship, **download back**, decrypt, restore, verify. 79% smaller; unreadable without the passphrase; byte-identical with it |
| Password reset really sends | `tests/mail_drill.js` — delivered over real SMTP, link works once, token never logged |
| The scheduler works from both trigger paths | Verified: an operator's shell, the Vercel HTTP path with a bearer token, and `ops/cron-dic.sh` under a stripped cron environment |
| No duplicate execution | Three separate triggers in succession: reminder notifications 4 → 4 → 4 → 4, completed purges 0 → 0 → 0 → 0 |
| The alert path fires | `ops/healthcheck.sh` — healthy (exit 0, silent), degraded (exit 2, alert delivered), unavailable (exit 1, alert delivered), and a broken alert path reports itself |
| Production fails closed | Refuses to boot without any of the seven required variables |
| No secret leaks | Checked mechanically against the real values in every markdown file, every log, every API response |

### Not proven, and honestly cannot be from here

| | Why | Owner |
|---|---|---|
| A production scheduler that has actually fired | No server exists | DIC |
| An off-site copy reaching real storage | The transport is proven; `aws s3 cp` needs an account. One line of `OFFSITE_CMD` | DIC |
| Deliverability to a real mailbox | A message leaves over SMTP and arrives. Whether Gmail accepts it needs DIC's domain, SPF, DKIM and reputation | DIC |
| An alert reaching a human | The alert path fires and delivers to its command. The command needs a real webhook or address | DIC |
| TLS, DNS, the reverse proxy | No domain, no server | DIC |

---

## H. Production database

| | |
|---|---|
| Version | PostgreSQL 16 (tested against 16.14) |
| Role | A dedicated non-superuser owning its own database. It creates tables during migration, so it needs ownership — not superuser |
| Connection | Localhost or a private network. If it must cross a network, `PGSSL=true` and verify the certificate |
| Credentials | `.env` only, mode `0600`. Rotatable safely — `KEY_MANAGEMENT.md` section 5 |
| Timezone | The application pins `Asia/Dhaka` per connection (`DB_TIMEZONE`). The server's own clock should be UTC or local; either works |

**Migration.** `schema.sql` first, then `migrate_v2.js` … `migrate_v19.js` in
order. Stop the application and take a backup first. `v5` onward are
transactional and support `--dry-run`; **`v2`, `v3` and `v4` are not and silently
ignore the flag.** Expect 48 tables.

**Backup policy.**

| | |
|---|---|
| Local | Nightly `pg_dump`, 14 days retained, mode `0600`, outside the application directory |
| Off-site | Nightly, gzipped and AES-256 encrypted before it leaves the machine |
| Off-site retention | _DIC to confirm._ A reasonable shape: 7 daily, 4 weekly, 12 monthly |
| Verification | `restore.js --drill` every Sunday; `tests/offsite_drill.js` before go-live and after any change to the backup path |

**Restore.** `OPERATIONS_RUNBOOK.md` section E. Never over the live database:
restore into a new one, verify it, then switch. Note that `restore.js` reads the
`PG*` variables and **ignores `DATABASE_URL`**.

**Rollback.** Two different situations with two different answers. Bad code:
check out the previous commit, `npm ci --omit=dev`, restart — migrations are
additive so older code runs against a newer schema. Bad data: restore. **Never
"roll back" a migration by dropping columns**; there is no down-migration and
dropping a column destroys what the newer code wrote.

---

## I. Production smoke test

Run every line after deploying, before announcing anything. Sign in as each role
where the row says so.

### Authentication
- [ ] Alumni signs in at `https://alumni.<domain>`
- [ ] Staff signs in at `https://admin.alumni.<domain>` and gets the **staff** shell
- [ ] Wrong password is refused with a generic message
- [ ] Six wrong passwords trip the throttle (HTTP 429)
- [ ] Sign out; the old token is dead server-side, not merely cleared locally
- [ ] **Password reset**: request one, receive the email, follow the link, set a new password, sign in with it
- [ ] The same reset link cannot be used twice
- [ ] A newly provisioned account can only change its password until it does

### Alumni-facing
- [ ] Directory lists members; search and filters work
- [ ] A member's profile opens; private fields are absent for a peer
- [ ] Own profile edits save and persist
- [ ] Privacy settings save, and a peer's view changes accordingly
- [ ] Map renders and counts only members who opted in
- [ ] Events list; a free ticket registers and issues a QR code
- [ ] A priced ticket is refused with a clear message (no gateway exists)
- [ ] Jobs: post, edit own, cannot edit another's
- [ ] Mentorship: request, accept, and an expired request reads as expired
- [ ] Chapters: browse and join
- [ ] News feed renders
- [ ] Donations: pledge recorded as a pledge, not a payment

### Staff portal
- [ ] Dashboard, directory, events, moderation, broadcasts, segmentation, compliance, administration, operations, audit all render
- [ ] Moderation queue shows submissions and renders hostile text as text
- [ ] Bulk import: preview, import, and the result counts match
- [ ] Administrator provisioning; the new account is in enrolment state
- [ ] Suspending an account ends its sessions immediately
- [ ] Audit log renders and `npm run verify-audit-chain` passes
- [ ] Identity vault: a reveal is recorded in the access log
- [ ] Operations panel shows jobs, backup and mail state

### Operations
- [ ] `node scheduler.js --list` — all three jobs ran recently, from one source
- [ ] Overnight: a dump appears and `last-backup.json` says `ok`
- [ ] An object arrives at the off-site destination
- [ ] `node restore.js --drill` passes
- [ ] `ops/healthcheck.sh` exits 0
- [ ] Stop the application; the external monitor alerts; start it again
- [ ] `curl -H "X-Cron-Key: …" .../api/internal/monitor` returns 200
- [ ] No secret appears in `journalctl -u dic-alumni`

### The web root is closed
- [ ] `/.env`, `/db.js`, `/server.js`, `/package.json`, `/schema.sql`,
      `/admin-credentials.local.txt`, `/.git/config` all return **404**

**Zero console errors on every screen, in both portals.**

---

## J. Where the rest is written

| | |
|---|---|
| First deployment, step by step | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` |
| Day-2 operations and incidents | `OPERATIONS_RUNBOOK.md` |
| Secrets, escrow, key recovery | `KEY_MANAGEMENT.md` |
| What DIC owes, with owners | `PRODUCTION_HANDOVER_CHECKLIST.md` |
| Security review package | `SECURITY_REVIEW_PACKAGE.md`, `SECURITY_THREAT_MODEL.md`, `SECURITY_AUTHORIZATION_MATRIX.md`, `INDEPENDENT_SECURITY_REVIEW_CHECKLIST.md` |
| Known deferred items | `FINAL_SECURITY_REVIEW_FOLLOWUPS.md` |
