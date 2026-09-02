# DIC Alumni Platform — Production Handover Checklist

**For Daffodil International College.** This is the document to work through
before the platform serves real alumni. It states what has been built and
verified, what DIC must supply, and who owns each line.

**Nothing in this repository has ever run on a DIC server.** No domain, no
account and no credential is assumed anywhere in this document, and none has
been created on DIC's behalf.

---

## How to read this document

Every line is marked with who owns it.

| Mark | Meaning |
|---|---|
| **[ENG ✅]** | Engineering complete and verified. Nothing further is needed from anybody. |
| **[DIC]** | Daffodil International College must decide, buy, or name somebody. |
| **[HOST]** | The hosting provider or server administrator must configure it. |
| **[3RD]** | A third-party account is required — mail, storage or monitoring. |

A checkbox that is not ticked is not an oversight. It is work that has not
happened yet, and the mark says whose it is.

### The one distinction that matters

> **ENGINEERING READY** means the code does the thing and it has been executed
> and measured in this repository.
>
> **EXTERNAL / DIC PROVISIONING REQUIRED** means no amount of further
> engineering will close it, because it needs a server, a domain, an account or
> a person.
>
> Phase 6.5 finished the first column. The second column is untouched.

### Related documents

| | |
|---|---|
| The hosting recommendation and its evidence | `PRODUCTION_PROVISIONING.md` |
| First deployment, step by step | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` |
| Day-2 operations and incidents | `OPERATIONS_RUNBOOK.md` |
| Secrets, escrow and key recovery | `KEY_MANAGEMENT.md` |
| Security review package for an external reviewer | `SECURITY_REVIEW_PACKAGE.md` and its companions |
| Per-item engineering status from Phase 5E | `PRODUCTION_HANDOVER_CHECKLIST.md` |

---

## 1. Exact production architecture

```
              alumni.<dic-domain>          admin.alumni.<dic-domain>
                      │                              │
                      └──────────────┬───────────────┘
                                     │   TLS terminated here
                        ┌────────────▼────────────┐
                        │   nginx — exactly one   │  HSTS
                        │   proxy hop             │  passes Host + X-Forwarded-For
                        └────────────┬────────────┘
                                     │  http://127.0.0.1:8000
                        ┌────────────▼────────────┐
                        │   node server.js        │  systemd, Restart=on-failure
                        │   one process, one pool │  TRUST_PROXY=1
                        └────────────┬────────────┘
                                     │
                        ┌────────────▼────────────┐
                        │   PostgreSQL 16         │  localhost / private network
                        └────────────┬────────────┘
                                     │
  cron 02:10 ─► ops/cron-dic.sh ─────┤
                  ├─ backup.js ──────┘  pg_dump ─► BACKUP_DIR (outside the app)
                  ├─ offsite.js ────────► gzip + AES-256 ─► off-site storage
                  ├─ scheduler.js ──────► the three jobs, direct to the database
                  └─ Sundays: restore.js --drill

  cron */5   ─► ops/healthcheck.sh ─► ALERT_CMD on DOWN or DEGRADED
  external monitor ─► GET /api/health              200 / 503 / no answer
  external monitor ─► GET /api/internal/monitor    jobs, backups, off-site
```

**One process, one connection pool, one scheduler, one place the data lives.**
Every operational script runs on the same machine as the database, which is what
makes `pg_dump`, the receipts and the direct-to-database scheduler work.

- [ ] **[DIC]** This architecture is accepted, or a documented alternative is chosen

---

## 2. Hosting requirements

**Recommendation: an ordinary Linux VPS or VM. Not serverless.**

The reasoning is in `PRODUCTION_PROVISIONING.md` section A, with the evidence.
In short: on a serverless platform, `backup.js`, `restore.js` and `offsite.js`
cannot run at all; the monitoring built in Phase 6 would report "no backup has
ever been recorded" every night for ever; the login throttle multiplies by the
number of warm instances; and the connection pool exhausts a managed database.

Choosing serverless anyway is defensible for an institution with no server
administrator. `PRODUCTION_PROVISIONING.md` section A lists exactly what must be
arranged instead. **That decision is DIC's.**

- [ ] **[DIC]** The hosting model is decided and recorded here: ☐ VPS  ☐ Serverless
- [ ] **[DIC]** If serverless, every compensating item in `PRODUCTION_PROVISIONING.md` §A is arranged
- [ ] **[HOST]** A named person is responsible for the server

---

## 3. VPS requirements

| | Requirement |
|---|---|
| Operating system | Any current Linux with systemd. Ubuntu LTS or Debian stable is the least surprising. |
| CPU | 2 vCPU |
| RAM | 4 GB (2 GB works; 4 GB removes the need to think about it) |
| Disk | 40 GB — the database is small; the space is for 14 days of local backups and log growth |
| Node.js | 20 LTS or newer. Built and tested on v24.15.0 |
| Required binaries | `pg_dump`, `psql`, `curl`, `gzip`, `openssl` |
| Inbound ports | 80 and 443 only |
| **Port 8000** | **Must not be reachable from outside** |

**Why port 8000 matters.** `TRUST_PROXY=1` tells the application to believe the
`X-Forwarded-For` header. If the application port is reachable without passing
through nginx, a client can forge that header and evade the login throttle
entirely — measured in Phase 5F at 32 wrong passwords with zero refusals. Bind
the application to `127.0.0.1`, or firewall the port.

- [ ] **[HOST]** VM provisioned to the above
- [ ] **[HOST]** A `dic-alumni` service account, not root
- [ ] **[HOST]** Node 20+ and the PostgreSQL client tools installed
- [ ] **[HOST]** Application deployed to `/srv/dic-alumni`, installed with `npm ci --omit=dev`
- [ ] **[HOST]** systemd unit installed and enabled with `Restart=on-failure`
- [ ] **[HOST]** Application bound to `127.0.0.1`, **or** port 8000 firewalled
- [ ] **[HOST]** Automatic security updates enabled

---

## 4. PostgreSQL requirements

| | Requirement |
|---|---|
| Version | PostgreSQL 16 (built and tested against 16.14) |
| Role | A dedicated non-superuser that **owns** its own database — migrations create tables |
| Location | Localhost or a private network |
| Encryption in transit | If it crosses any network, `PGSSL=true` and verify the certificate |
| Timezone | The application pins `Asia/Dhaka` per connection. The server clock may be UTC |
| Connections | The application uses one pool of 10 |

**Installation sequence.** `schema.sql` first, then `migrate_v2.js` through
`migrate_v13.js` **in numeric order**. A complete database has **47 tables**.

Two things to know before running it:

- **`migrate_v2.js`, `migrate_v3.js` and `migrate_v4.js` have no transaction and
  silently ignore `--dry-run`.** From `v5` onward the flag genuinely applies,
  verifies and rolls back.
- **Do not run `seed.sql`, and do not set `DIC_SEED_DEMO`.** Both create
  demonstration content. Production is installed empty and its first account is
  created in section 17.

- [ ] **[HOST]** PostgreSQL 16 running
- [ ] **[HOST]** Application database and its own role created
- [ ] **[HOST]** `schema.sql` applied, then migrations v2–v13 in order
- [ ] **[HOST]** `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'` returns **47**
- [ ] **[HOST]** `seed.sql` was **not** run and `DIC_SEED_DEMO` is **not** set
- [ ] **[HOST]** Database connections restricted to the application host

---

## 5. Domain requirements

The platform serves two portals. They may share one hostname or use two.

| Layout | Alumni site | Staff portal |
|---|---|---|
| **Two hosts (recommended)** | `alumni.<dic-domain>` | `admin.alumni.<dic-domain>` |
| Single host | `alumni.<dic-domain>` | the same host, at `/admin` |

`<dic-domain>` is DIC's to choose. **No domain name has been assumed anywhere in
this repository.**

The staff portal is **not** a security boundary — the API enforces roles on
every request regardless of which HTML shell was served — so a single host is a
legitimate choice, not a compromise.

- [ ] **[DIC]** The domain is decided and recorded here: `________________`
- [ ] **[DIC]** One host or two is decided: ☐ two  ☐ one
- [ ] **[DIC]** The institution controls the domain and can publish DNS records for it

---

## 6. DNS records required

Replace `<dic-domain>` and the addresses with the real values. **Do not
configure these until DIC has confirmed the domain and the server exists.**

### The platform

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `alumni` | `<server-ipv4>` | 3600 |
| `A` | `admin.alumni` | `<server-ipv4>` | 3600 |
| `AAAA` | `alumni` | `<server-ipv6>` | 3600 — only if the VM has IPv6 |
| `AAAA` | `admin.alumni` | `<server-ipv6>` | 3600 — only if the VM has IPv6 |
| `CAA` | `alumni` | `0 issue "letsencrypt.org"` | 3600 — optional, restricts who may issue certificates |

A `CNAME` from `admin.alumni` to `alumni` is equally valid and easier to move
later. For the single-host layout only the first record is needed.

### Mail — supplied by whichever provider DIC chooses

Without these, password-reset email will be rejected or filed as spam.

| Type | Name | Purpose |
|---|---|---|
| `TXT` | `<dic-domain>` | **SPF** — authorises the provider to send as the domain |
| `TXT` | `<selector>._domainkey.<dic-domain>` | **DKIM** — the provider's signing key |
| `TXT` | `_dmarc.<dic-domain>` | **DMARC** policy, e.g. `v=DMARC1; p=quarantine; rua=mailto:postmaster@<dic-domain>` |

- [ ] **[DIC]** Whoever holds the DNS zone is identified: `________________`
- [ ] **[HOST]** The `A` (and `AAAA`) records are published and resolve
- [ ] **[3RD]** SPF, DKIM and DMARC published from the mail provider's values
- [ ] **[HOST]** Both hostnames resolve to the server from outside the campus network

---

## 7. TLS requirements

- [ ] **[HOST]** A certificate covering **both** hostnames
- [ ] **[HOST]** Automatic renewal configured and tested (Let's Encrypt is free and automatable)
- [ ] **[HOST]** HTTP redirects to HTTPS
- [ ] **[HOST]** `Strict-Transport-Security` sent by nginx — **the application does not send it**
- [ ] **[HOST]** nginx sets `proxy_set_header Host $host` — without it both hostnames serve the alumni site
- [ ] **[HOST]** nginx sets `X-Forwarded-For`, and `TRUST_PROXY=1` matches the single hop
- [ ] **[HOST]** Renewal alerts go somewhere a human reads

The application sets `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options` and a `frame-ancestors` CSP itself. HSTS and TLS belong to the
terminator.

---

## 8. Admin subdomain

- [ ] **[DIC]** `admin.alumni.<dic-domain>` is agreed, or the single-host layout is chosen
- [ ] **[HOST]** `ADMIN_ORIGIN` matches it exactly, scheme included
- [ ] **[HOST]** The certificate covers it
- [ ] **[HOST]** Verified: the admin host serves the **staff** portal, the alumni host serves the **alumni** site

Hostnames are compared as hostnames, not substrings — `alumni.<domain>` is a
substring of `admin.alumni.<domain>`, and a substring comparison once served the
staff shell on the public domain. Set both origins to the same value for the
single-host layout and the server routes by path instead.

---

## 9. SMTP requirements

Email is used for exactly one thing: **password-reset links**. There is no
broadcast email, no SMS and no push notification, and none is implied.

`MAIL_TRANSPORT` has no default and production will not start without it:

| Value | Behaviour |
|---|---|
| `smtp` | Send. Requires `SMTP_HOST` and `SMTP_FROM` |
| `none` | Accept and drop. A deliberate choice — users then cannot reset their own passwords and every reset is issued by an operator |
| `console` | **Development only.** Writes reset links into the log in plaintext |

- [ ] **[3RD]** An SMTP account exists — host, port, username, password
- [ ] **[DIC]** A sender address on a domain DIC controls: `________________`
- [ ] **[3RD]** TLS: port 465 for implicit TLS, or 587 for STARTTLS
- [ ] **[3RD]** SPF, DKIM and DMARC published (section 6)
- [ ] **[HOST]** `MAIL_TRANSPORT=smtp` and the credentials are in `.env` only
- [ ] **[DIC]** **A real reset email has been received at a real external mailbox**
- [ ] **[DIC]** If `none` is chosen instead, that decision is recorded and an operator is briefed on `reset_link.js`

**What is already proven:** the delivery path works. A message is composed, sent
over a real SMTP connection, and arrives with a link that resets the password
once and never appears in a log. **What is not proven:** that a real provider
accepts it. Deliverability depends on DIC's domain and reputation.

---

## 10. Backup destination requirements

A backup that lives only on the machine it was taken from does not survive the
failure it exists for.

The platform ships the newest dump using a command DIC supplies, so there is no
vendor SDK, no bucket name and no credential in the repository:

```bash
# S3-compatible (AWS, Backblaze B2, Wasabi, MinIO)
OFFSITE_CMD='aws s3 cp {file} s3://<bucket>/{name} --sse AES256'
# any host reachable over ssh
OFFSITE_CMD='scp -q {file} backups@<host>:/srv/dic/{name}'
# rclone, which speaks most institutional cloud storage
OFFSITE_CMD='rclone copyto {file} <remote>:<path>/{name}'
```

Where the destination cannot encrypt at rest, encrypt before sending:

```bash
OFFSITE_ENCRYPT_CMD='gzip -c {file} | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -pass env:DIC_BACKUP_PASSPHRASE -out {out}'
```

- [ ] **[3RD]** An off-site destination exists, on different infrastructure from the server
- [ ] **[HOST]** `OFFSITE_CMD` configured and an object has arrived at it
- [ ] **[HOST]** Encryption at rest at the destination, **or** `OFFSITE_ENCRYPT_CMD` configured
- [ ] **[DIC]** A backup passphrase is generated and escrowed **separately from the backups themselves**
- [ ] **[HOST]** Access to the destination is restricted and audited
- [ ] **[HOST]** The destination is not publicly readable and is not in any repository
- [ ] **[HOST]** **A restore has been performed from the off-site copy**, not only the local one

**Whoever holds the decryption passphrase must not be the same person who holds
only the backups**, or the pair is useless.

---

## 11. Backup retention policy

| | Setting | Owner |
|---|---|---|
| Local dumps | Nightly, **14 days** retained, mode `0600`, outside the application directory | ENG ✅ |
| Off-site | Nightly | HOST |
| Off-site retention | _DIC to confirm._ A reasonable shape: **7 daily, 4 weekly, 12 monthly** | DIC |
| Verification | `restore.js --drill` every Sunday | ENG ✅ |
| Audit-log retention | Currently unbounded — entries are never deleted | DIC to confirm |
| Deletion grace period | 30 days, matching what the interface promises | DIC to confirm |

- [ ] **[DIC]** Off-site retention agreed and recorded: `________________`
- [ ] **[DIC]** Audit-log retention agreed
- [ ] **[DIC]** The data-protection owner has signed off on all three
- [ ] **[HOST]** Retention is actually enforced at the destination, not just intended

**A disclosure DIC must accept in writing:** audit entries written before the
Phase 5A boundary contain some alumni names and email addresses in their
metadata. They cannot be scrubbed without destroying the hash chain that
protects every entry after them. The reasoning is in `AUDIT_CHAIN.md` §1 and §4.

---

## 12. Monitoring requirements

Two layers. The first is not optional.

**1. An external uptime service.** A monitor running on the same machine cannot
tell you the machine is unreachable.

```
GET https://alumni.<dic-domain>/api/health
  200  {"status":"ok","database":"ok","latencyMs":n}    healthy
  503  {"status":"degraded","database":"unreachable"}   the database is down
  no answer at all                                      the application is down
```

Alert on **two consecutive failures at a 60-second interval**.

**2. Operational health, which an HTTP probe cannot see.** `/api/health` returns
200 while the deletion purge has been failing for a fortnight and the backups
stopped a week ago.

```
GET https://alumni.<dic-domain>/api/internal/monitor
Header: X-Cron-Key: <CRON_SECRET>
  200  everything within its freshness window
  503  something needs attention; "problems" says what
```

It reports the database, every job with its age and outcome, the backup receipt,
the off-site receipt, overdue deletions and the mail mode. It uses the scheduler
credential rather than an administrator session, so a monitoring service can
carry it in a header and the browser never sees it.

- [ ] **[3RD]** An uptime monitoring service account exists
- [ ] **[3RD]** A check on `/api/health`, alerting on two consecutive failures
- [ ] **[3RD]** A second check on `/api/internal/monitor` with the `X-Cron-Key` header
- [ ] **[HOST]** `ops/healthcheck.sh` in cron every five minutes
- [ ] **[HOST]** `ALERT_CMD` configured — Slack webhook, `mail`, or a paging command
- [ ] **[DIC]** An on-call address or rota: `________________`
- [ ] **[DIC]** **A test alert has been received by a human**

The alert path itself has been verified: healthy is silent, degraded and
unavailable each deliver an alert, and a broken alert command reports its own
failure rather than failing quietly.

---

## 13. Scheduler requirements

Three jobs run on a timer. **Task reminders are part of `event-maintenance`, not
a separate job, and there is no engagement-snapshot job** — the schema records
no historical snapshot to compare a period against.

| Job | What it does |
|---|---|
| `event-maintenance` | Rolls event statuses forward by the calendar **and sends task deadline reminders** |
| `deletion-purge` | Erases accounts whose 30-day grace period has expired |
| `mentorship-expiry` | Expires mentorship requests older than five days |

**`deletion-purge` is a promise to every user who asks to be erased.** If nothing
triggers it, that promise is silently broken and nothing in the interface says so.

**Exactly one trigger is enabled.**

| | |
|---|---|
| **VPS** | `ops/cron-dic.sh` at 02:10 local, which runs backup → off-site → jobs → a Sunday restore drill |
| **Serverless** | `vercel.json`'s `crons` block calls the HTTP endpoint |

- [ ] **[HOST]** One trigger installed, and only one
- [ ] **[HOST]** `node scheduler.js --list` shows all three jobs having run recently
- [ ] **[HOST]** `ops_runs.source` shows a single source
- [ ] **[HOST]** The deletion purge has been observed running at least once
- [ ] **[HOST]** A failing job produces an alert (section 12)

Every job is idempotent — verified across three separate trigger paths in
succession with no duplicated reminder and no duplicated purge.

---

## 14. Required environment variables

`.env` on the server, mode `0600`, owned by the service account. The full
reference is `.env.example`.

### The application refuses to start in production without these

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | From section 4 — or a single `DATABASE_URL` |
| `SESSION_SECRET` | 64 hex characters |
| `ENCRYPTION_KEY` | Exactly 64 hex characters |
| `CRON_SECRET` | 32 characters minimum |
| `MAIL_TRANSPORT` | `smtp`, `none` or `console` — no default |
| `PUBLIC_ORIGIN` | `https://alumni.<dic-domain>` |
| `ADMIN_ORIGIN` | `https://admin.alumni.<dic-domain>`, or the same value for one host |
| `BACKUP_DIR` | An absolute path **outside** the application directory |

### Required when the feature is enabled

| Variable | When |
|---|---|
| `SMTP_HOST` `SMTP_FROM` | `MAIL_TRANSPORT=smtp` |
| `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` | As the provider requires |
| `TRUST_PROXY=1` | Behind nginx — **wrong in both directions**, see section 3 |
| `OFFSITE_CMD` | To have an off-site copy at all |
| `OFFSITE_ENCRYPT_CMD` | When the destination cannot encrypt at rest |
| `ALERT_CMD` | For `ops/healthcheck.sh` to raise anything |
| `PG_DUMP` | Only if `pg_dump` is not on cron's `PATH` |

### Never set in production

`ALLOW_DB_RESEED` · `DIC_SEED_DEMO` · `DIC_SKIP_DOTENV`

- [ ] **[HOST]** Every required variable set
- [ ] **[HOST]** `.env` is mode `0600` and owned by the service account
- [ ] **[HOST]** The application starts and the banner names the correct database
- [ ] **[HOST]** None of the three "never" variables is set

---

## 15. Secret-management procedure

Full procedure in `KEY_MANAGEMENT.md`.

| Secret | Rotation | If lost |
|---|---|---|
| `SESSION_SECRET` | **Safe** — signs everybody out | Recoverable |
| `ENCRYPTION_KEY` | **Not safe** — see section 16 | **Not recoverable** |
| `CRON_SECRET` | **Safe** — update the trigger too | Recoverable |
| Database password | **Safe** — update `.env` and restart | Recoverable by a DBA |

Generate all three **on the server**, never reused from development:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- [ ] **[HOST]** All three generated fresh on the server
- [ ] **[HOST]** Stored in the hosting platform's environment store **and** in `.env`
- [ ] **[DIC]** Stored in the institution's password manager, with the generation date
- [ ] **[HOST]** `admin-credentials.local.txt` moved to the password manager and deleted from the server
- [ ] **[DIC]** A rotation schedule agreed, or a decision recorded that rotation is on demand only

**Verified already:** no secret appears in the repository, in any log, in any API
response, or in the browser. Production refuses to boot without them, and the
refusal names the variable and never the value.

---

## 16. Encryption-key escrow procedure

**`ENCRYPTION_KEY` is the only secret whose loss destroys data.**

It encrypts the identity vault with AES-256-GCM. `identity_vault` stores **no key
id and no key version**, so there is no zero-downtime rotation path. And the
point most often misunderstood:

> **A database backup does not save you.** The backup contains the same
> ciphertext. The key is not in the database and is not in the backup — by
> design, because a backup carrying its own decryption key would offer no
> protection at all.

**The key must exist in two places before the first identity record is written.**

### The rule

**Two named people must be able to reach the recovery material, and neither may
be the person who holds only the backups.**

### What is escrowed

For each secret: the value, the date it was generated, the environment it
belongs to, and who generated it. For `ENCRYPTION_KEY`, **every previous value
with the dates it was in use** — a superseded key is never destroyed.

### How it is held

Either an institutional password manager entry shared with exactly those two
people and access logging enabled, or a sealed envelope in the institution's
safe with a signed register. The other copy stays in the hosting platform's
environment store.

- [ ] **[DIC]** Escrow method chosen: ☐ password manager  ☐ sealed envelope
- [ ] **[DIC]** First named holder: `________________`
- [ ] **[DIC]** Second named holder: `________________`
- [ ] **[DIC]** Neither is solely the backup holder
- [ ] **[DIC]** `ENCRYPTION_KEY` escrowed **before** the first identity-vault record exists
- [ ] **[DIC]** The backup passphrase escrowed separately from the backups
- [ ] **[DIC]** A register records who may open the escrow and what is written down when they do
- [ ] **[DIC]** An annual recovery drill is scheduled (`KEY_MANAGEMENT.md` §7)

---

## 17. Super-admin ownership

A fresh production install has **no accounts at all**. The first administrator is
created deliberately:

```bash
node rotate_credentials.js --create-super-admin <email> --name "Full Name"
```

It refuses if a super admin already exists. The account is created in an
enrolment state: until it sets its own password it may do exactly three things —
identify itself, change its password, and sign out.

- [ ] **[DIC]** The super-admin account owner is named: `________________`
- [ ] **[DIC]** Their institutional email address is agreed
- [ ] **[HOST]** The account is created and the password changed at first sign-in
- [ ] **[HOST]** Any generated password is moved to the password manager and the file deleted
- [ ] **[DIC]** A second administrator exists, so one person leaving is not a lockout
- [ ] **[DIC]** The policy for who may hold `univ_admin`, `dept_admin` and `moderator` is agreed

**Note:** a `super_admin` cannot be erased by the deletion timer — that has to be
a deliberate act with a human present.

---

## 18. Emergency recovery ownership

Who does what when it goes wrong at 3am.

| Situation | Procedure | Owner |
|---|---|---|
| Site down | `OPERATIONS_RUNBOOK.md` §M | **[DIC]** name: `__________` |
| Database unreachable | §M | **[HOST]** |
| Restore needed | §E | **[HOST]** |
| Everyone locked out of sign-in | §K — check `TRUST_PROXY` first | **[HOST]** |
| A staff account is compromised | §L — suspend first, it ends every session at once | **[DIC]** |
| Nobody can sign in as super admin | §J and §T | **[DIC]** escrow holders |
| `ENCRYPTION_KEY` lost or exposed | `KEY_MANAGEMENT.md` §6 | **[DIC]** data-protection owner |
| Personal data exposed | §M — suspend, preserve, escalate. **Disclosure is DIC's decision** | **[DIC]** |

- [ ] **[DIC]** First responder named: `________________`
- [ ] **[DIC]** Database / hosting escalation named: `________________`
- [ ] **[DIC]** Data-protection owner named: `________________`
- [ ] **[DIC]** Institutional escalation named: `________________`
- [ ] **[DIC]** Contact details recorded in `OPERATIONS_RUNBOOK.md` §S
- [ ] **[DIC]** All four know the documents exist and where to find them

---

## 19. DIC IT responsibilities

Ongoing, after go-live.

- [ ] Read `OPERATIONS_RUNBOOK.md` before go-live, not during the first incident
- [ ] Check the Operations panel weekly — jobs, backup, mail state
- [ ] Respond to monitoring alerts
- [ ] Confirm the nightly backup and off-site copy are happening
- [ ] Review the weekly restore drill result
- [ ] Apply operating-system security updates
- [ ] Renew or confirm auto-renewal of the TLS certificate
- [ ] Provision and de-provision staff accounts as people join and leave
- [ ] Suspend accounts promptly when somebody leaves
- [ ] Keep the escrow current when a secret is rotated
- [ ] Run the annual recovery drill
- [ ] Hold the incident log

---

## 20. Developer responsibilities

What was delivered, and what remains available.

**Delivered and verified:**

- The application, its two portals and 138 API routes
- 23 automated test suites — **1,673 checks**
- Four operational drills — **121 checks**: fresh install, deletion purge and
  restore, password-reset delivery, and the encrypted off-site round trip
- A verifiable hash-chained audit trail
- Backup, restore, off-site, scheduler, monitoring and alerting mechanisms
- Continuous integration that installs from scratch on every push
- The documentation set listed at the top of this file

**Not delivered, because it cannot be:** any server, domain, account or
credential. Those are sections 2 to 12.

**Available on request:**

- [ ] Deployment support during the first install
- [ ] Handover session on the runbooks with DIC IT
- [ ] Response to findings from the independent security review
- [ ] Fixes for defects found during UAT

---

## 21. Pre-deployment checklist

Run every line before deploying. It takes a few minutes and it is the difference
between a deployment and a hope.

```bash
cd /srv/dic-alumni
npm ci                       # exactly what the lockfile pins
npm test                     # 23 suites
npm run drills               # install, purge/restore, mail, encrypted off-site
npm run verify-audit-chain   # expect PASS and exit 0
```

- [ ] **[HOST]** `npm test` — 23 suites, **0 failures**
- [ ] **[HOST]** `npm run drills` — all four pass
- [ ] **[HOST]** `npm run verify-audit-chain` — PASS, exit 0
- [ ] **[HOST]** Every checkbox in sections 3 to 14 is ticked
- [ ] **[HOST]** The commit hash being deployed is recorded: `________________`
- [ ] **[HOST]** A backup exists from **before** the deployment
- [ ] **[HOST]** The rollback procedure (section 23) has been read

---

## 22. Production smoke-test checklist

After deploying, before announcing anything to alumni.

### Authentication
- [ ] An alumnus signs in at `https://alumni.<dic-domain>`
- [ ] A staff member signs in at the admin host and gets the **staff** shell
- [ ] A wrong password is refused with a generic message
- [ ] Six wrong passwords trip the throttle (HTTP 429)
- [ ] Sign out — the old session is dead server-side, not merely cleared locally
- [ ] **Password reset end to end**: request, receive the email, follow the link, set a new password, sign in
- [ ] The same reset link cannot be used twice
- [ ] A newly provisioned account can only change its password until it does

### Alumni-facing
- [ ] Directory lists members; search and filters work
- [ ] A member's profile opens; private fields are absent for a peer
- [ ] Own profile edits save and persist
- [ ] Privacy settings save, and a peer's view changes accordingly
- [ ] The map renders and counts only members who opted in
- [ ] Events list; a **free ticket** registers and issues a QR code
- [ ] A **priced ticket is refused** with a clear message — no payment gateway exists
- [ ] Tasks: an assignee sees their own tasks
- [ ] Notifications appear
- [ ] Jobs: post one, edit your own, cannot edit another's
- [ ] Mentorship: request, accept, and an expired request reads as expired
- [ ] Chapters: browse and join
- [ ] News feed renders
- [ ] Donations: a pledge is recorded **as a pledge**, and settlement is admin-confirmed

### Staff portal
- [ ] Every page renders: dashboard, directory, events, jobs, mentorship, donations, chapters, analytics, moderation, broadcasts, segmentation, compliance, administration, operations, audit
- [ ] The moderation queue shows submissions and renders hostile text **as text**
- [ ] Bulk import: preview, import, and the result counts match
- [ ] Administrator provisioning; the new account is in enrolment state
- [ ] Suspending an account ends its sessions immediately
- [ ] Compliance: identity vault reveal is recorded in the access log
- [ ] Audit log renders and `npm run verify-audit-chain` passes

### Operations
- [ ] `node scheduler.js --list` — all three jobs ran recently, from one source
- [ ] Overnight: a dump appears and the receipt says `ok`
- [ ] An object arrives at the off-site destination
- [ ] `node restore.js --drill` passes
- [ ] `ops/healthcheck.sh` exits 0
- [ ] Stop the application — **the external monitor alerts** — start it again
- [ ] `/api/internal/monitor` returns 200 with the `X-Cron-Key` header

### The web root is closed
- [ ] `/.env`, `/db.js`, `/server.js`, `/package.json`, `/schema.sql`,
      `/admin-credentials.local.txt` and `/.git/config` all return **404**

- [ ] **Zero console errors on every screen, in both portals**

---

## 23. Rollback checklist

Decide which situation you are in first. Using the wrong one is how a bad deploy
becomes lost data.

### The code is bad, the data is fine — most rollbacks

- [ ] Identify the previous commit: `git log --oneline -10`
- [ ] `git checkout <previous-commit>` and `npm ci --omit=dev`
- [ ] Restart, and confirm health returns 200
- [ ] Record what was rolled back and why

**Do not "roll back" a migration by dropping columns.** There is no
down-migration, and dropping a column destroys data the newer code wrote.
Migrations are additive, so older code runs against a newer schema and ignores
what it does not know about.

### The data is bad

- [ ] **Stop the application first**
- [ ] Take a backup of the current bad state — it is the only copy of what happened
- [ ] Restore into a **new** database, never over the live one
- [ ] Verify: table count, row counts, `verify_audit.js --database <name>`
- [ ] Only then point `PGDATABASE` at it and restart
- [ ] **Keep the damaged database** until somebody has decided nothing in it was needed

### A secret was exposed

- [ ] `KEY_MANAGEMENT.md` §6, per secret, in priority order
- [ ] **`ENCRYPTION_KEY`: do not rotate first** — that destroys the data

---

## 24. Independent security review requirement

**This is the one item marked RED, and it has been RED since Phase 5F.**

Every security property this platform claims was verified by the party that
implemented it. That is worth something, and it is not the same as an
independent review.

The argument for commissioning one is the platform's own history: an adversarial
pass in Phase 5F found **two P0 stored cross-site-scripting vulnerabilities that
four previous audits had passed over**, both confirmed executing in a live
super-admin session. Whatever that pass missed, somebody else will have to find.

A reviewer can start on day one. The package is prepared:

| | |
|---|---|
| `SECURITY_REVIEW_PACKAGE.md` | Architecture, trust boundaries, sensitive data, controls, secrets |
| `SECURITY_THREAT_MODEL.md` | Fourteen actors with assets, attack surface, mitigations and residual risk |
| `SECURITY_AUTHORIZATION_MATRIX.md` | All 138 routes, verified by 774 authorisation probes |
| `INDEPENDENT_SECURITY_REVIEW_CHECKLIST.md` | Environment, test accounts, 40 attack scenarios with expected results, severity definitions, retest procedure |
| `FINAL_SECURITY_REVIEW_FOLLOWUPS.md` | What the team already believes is wrong |

- [ ] **[DIC]** A reviewer is commissioned: `________________`
- [ ] **[DIC]** A staging deployment is provided — **never production**
- [ ] **[DIC]** The reviewer creates their own test accounts; **no real credentials are shared**
- [ ] **[DIC]** Findings are triaged and P0/P1 items fixed
- [ ] **[DIC]** A retest confirms the fixes
- [ ] **[DIC]** **Completed before any public announcement to alumni**

---

## 25. College UAT checklist

Acceptance testing by the people who will actually use it — not by the
developer, and not by IT alone.

### Who should test

- [ ] **[DIC]** An alumni-relations staff member — the daily user of the staff portal
- [ ] **[DIC]** A department administrator
- [ ] **[DIC]** Three to five real alumni from different graduating years
- [ ] **[DIC]** Somebody who is not confident with computers
- [ ] **[DIC]** Somebody testing on a phone over mobile data, not campus wifi

### What they should try

- [ ] Register an account and complete a profile without help
- [ ] Find a specific classmate in the directory
- [ ] Set privacy so a phone number is hidden, then confirm another member cannot see it
- [ ] Register for an event and find the ticket again afterwards
- [ ] Reset a forgotten password, unaided, on a phone
- [ ] Post a job and apply for someone else's
- [ ] Request a mentor
- [ ] Read the news feed and submit a story
- [ ] Record a donation pledge and confirm it is described honestly as a pledge
- [ ] Staff: import a real roster and check the result counts
- [ ] Staff: moderate a submission
- [ ] Staff: provision another administrator

### What to record

- [ ] Anything that needed explaining
- [ ] Anything that looked wrong on a phone
- [ ] Any Bengali or English wording that reads oddly
- [ ] Anything that felt slow
- [ ] Anything a user expected that is not there

- [ ] **[DIC]** UAT findings triaged into: must-fix, should-fix, future
- [ ] **[DIC]** Must-fix items resolved before go-live

**Note for testers:** paid ticketing and online donation payment **do not
exist**. Tickets that cost money are refused, and donations are pledges an
administrator confirms. That is the intended behaviour, not a defect.

---

## 26. Final handover checklist

Sign-off. Every line needs a date and a name.

### Engineering — complete

- [x] Application, both portals, 138 routes
- [x] 23 test suites, 1,673 checks, 0 failures
- [x] 4 operational drills, 121 checks, 0 failures
- [x] Fresh install from an empty database, verified
- [x] Deletion purge, verified against expired, unexpired and cancelled requests
- [x] Backup, restore and the encrypted off-site round trip, verified
- [x] Password-reset delivery over SMTP, verified
- [x] Scheduler on both trigger paths, no duplicate execution, verified
- [x] Monitoring and alerting for healthy, degraded and unavailable, verified
- [x] Production fail-closed configuration, verified
- [x] Verifiable hash-chained audit trail
- [x] Security review package prepared
- [x] Documentation set complete

### External provisioning — outstanding

- [ ] **[DIC]** Hosting model decided (section 2)
- [ ] **[HOST]** Server provisioned (section 3)
- [ ] **[HOST]** PostgreSQL installed and migrated (section 4)
- [ ] **[DIC]** Domain decided (section 5)
- [ ] **[HOST]** DNS published (section 6)
- [ ] **[HOST]** TLS configured (section 7)
- [ ] **[3RD]** SMTP account and a delivered test email (section 9)
- [ ] **[3RD]** Off-site backup destination, with a restore performed from it (section 10)
- [ ] **[DIC]** Retention policy signed off (section 11)
- [ ] **[3RD]** Monitoring and a test alert received by a human (section 12)
- [ ] **[HOST]** Scheduler installed and observed running (section 13)
- [ ] **[HOST]** All environment variables set (section 14)
- [ ] **[DIC]** Secrets escrowed with two named holders (sections 15 and 16)
- [ ] **[DIC]** Super-admin owner named (section 17)
- [ ] **[DIC]** Emergency contacts named (section 18)
- [ ] **[HOST]** Pre-deployment checks pass (section 21)
- [ ] **[HOST]** Production smoke test passes (section 22)
- [ ] **[DIC]** Independent security review completed (section 24)
- [ ] **[DIC]** College UAT completed (section 25)

### Sign-off

| | Name | Signature | Date |
|---|---|---|---|
| DIC IT — accepts operational responsibility | | | |
| DIC — accepts the data-protection disclosures (section 11) | | | |
| DIC — confirms the security review is complete | | | |
| DIC — authorises go-live | | | |

---

## The honest summary

**The engineering is finished** and every mechanism it depends on has been
executed and measured: installing from nothing, erasing an account when its
grace period expires, taking a backup and getting the data back out of an
encrypted off-site copy, delivering a password-reset email, running the
scheduler without duplicating work, and raising an alert when something breaks.

**Not one of those has run on a server DIC owns, against a domain DIC controls,
with an account DIC pays for.** That is the whole of what remains, and no
further engineering closes it.

Nineteen items above are outstanding. Eighteen are provisioning. The nineteenth
is the independent security review — and the reason to insist on it is that this
platform's own history shows internal review is not enough.
