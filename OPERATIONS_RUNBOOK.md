# DIC Alumni Platform — Operations Runbook

**Who this is for:** the person responsible for keeping the platform running. It
assumes you can open a terminal on the server and follow instructions. It does
not assume you can read the code.

This is the **day-2** guide: incidents, backups, jobs, accounts. The first
deployment is [`PRODUCTION_DEPLOYMENT_RUNBOOK.md`](PRODUCTION_DEPLOYMENT_RUNBOOK.md).
Secrets and the encryption key have their own document,
[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md).

---

## Read this first

| | |
|---|---|
| **Hosting** | _DIC to record: **Vercel** or **VPS**. Both are shipped and exactly one is enabled. Every command below is marked with the one it applies to._ |
| Where the application runs | _fill in: hostname, or the Vercel project name_ |
| Where backups are written | _fill in: the `BACKUP_DIR` path_ |
| Where the off-site copy goes | _fill in, or record that there is none — see section D_ |
| Who to call | _fill in: see **section S**_ |

Those blanks are tracked as owned items in
[`PRODUCTION_HANDOVER_CHECKLIST.md`](PRODUCTION_HANDOVER_CHECKLIST.md). A blank
here is a decision nobody has made yet, not an oversight in this document.

### What has and has not been executed

Be clear about this before you rely on anything below.

- **Run on a developer machine, repeatedly, and passing:** the full test suite,
  the fresh-install drill, the deletion-purge drill, the backup/restore drill,
  and the password-reset delivery drill.
- **Never run anywhere:** the systemd unit, the nginx configuration, the crontab
  entries, `ops/healthcheck.sh` against a real monitor, and any off-site backup
  destination. Nothing in this repository has ever run on a DIC server.

Every command below is written to be run for the first time.

---

## A. Start the system

**VPS:**

```bash
sudo systemctl start dic-alumni && sudo systemctl status dic-alumni
```

**Vercel:** the application starts on demand. There is nothing to start; a
deploy is the only "restart".

**If it refuses to start**, read the error. In production it deliberately
refuses to boot when a required variable is missing, and it names which:

```
Refusing to start in production: required secret(s) missing or malformed:
CRON_SECRET (32+ characters), BACKUP_DIR (an absolute path outside the application directory)
```

That is the application working correctly. Set the named variables and start
again. **Required in production:**

| Variable | Why it must be set |
|---|---|
| `SESSION_SECRET` | Signs session tokens. Missing ⇒ every user is signed out on each restart. |
| `ENCRYPTION_KEY` | 64 hex characters. Encrypts identity-vault records and signs ticket QR codes. **Cannot be recovered if lost** — see [`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md). |
| `CRON_SECRET` | 32+ characters. The scheduler's credential. Missing ⇒ the nightly jobs cannot run, including the deletion purge. |
| `MAIL_TRANSPORT` | `smtp`, `console` or `none`. **No default** — the deployment has to say which. |
| `PUBLIC_ORIGIN` | The alumni site's origin, and half the CORS allow-list. |
| `ADMIN_ORIGIN` | The staff portal's origin. Set it to the same value for a single-host deployment. |
| `BACKUP_DIR` | An absolute path **outside** the application directory. Refused if it points inside. |
| `SMTP_HOST`, `SMTP_FROM` | Only when `MAIL_TRANSPORT=smtp`. |

`TRUST_PROXY` is not required but is easy to get wrong in both directions, and
it decides whether the rate limiter and the audit trail mean anything:

- **Behind a proxy and left unset** — every request appears to come from the
  proxy, so the per-IP login throttle treats the whole internet as one client
  and a handful of failed sign-ins locks out everybody.
- **Set with no proxy in front** — the value is a hop *count*, not an address
  allow-list, so `X-Forwarded-For` becomes the caller's to choose. Measured: 32
  wrong passwords with a rotating forged header produced zero refusals, and the
  forged address is what the audit trail recorded.

Set it to the number of hops you actually have, usually `1`, or leave it unset
when the application is reached directly.

---

## B. Stop and restart

Stop before a restore (section E) and before a database migration (section C).
Nothing else requires it.

**VPS:**

```bash
sudo systemctl stop dic-alumni       # stop
sudo systemctl restart dic-alumni    # restart, picking up .env changes
sudo systemctl status dic-alumni     # confirm
```

A change to `.env` needs a **restart**, not a reload: the file is read once at
boot.

If you started it by hand rather than under systemd:

```bash
pkill -f "node server.js"            # then start it again as in section A
```

**Vercel:** you cannot stop it, and you do not need to. Redeploy to pick up a
code change; change an environment variable in the project settings and
redeploy to pick that up.

**Confirm it came back:**

```bash
curl -s https://alumni.<domain>/api/health
```

Expect `{"status":"ok","database":"ok","latencyMs":n}` with HTTP 200.

---

## C. Database migration

The schema is a base file plus numbered migrations. A new deployment applies
`schema.sql` **first**, then `migrate_v2.js` through `migrate_v19.js` in order.

```bash
cd /srv/dic-alumni
psql "$DATABASE_URL" -f schema.sql          # new deployments only
for v in 2 3 4 5 6 7 8 9 10 11 12 13; do
  node "migrate_v$v.js" || { echo "v$v FAILED — stop and read the error"; break; }
done
```

**Before you run any of it: stop the application (section B) and take a backup
(section D).**

What is true of these migrations, precisely — the previous version of this
section overstated it:

- They are **additive**: they add columns and tables. None drops a column that
  holds data.
- Some do **rewrite data**. `schema_v12.sql` updates `audit_logs` and resets the
  audit-chain head; `schema_v5.sql` sets a column `NOT NULL` and adds foreign
  keys; `schema_v13.sql` updates `alumni_profiles`. They are not purely
  structural.
- **`migrate_v2.js`, `migrate_v3.js` and `migrate_v4.js` have no transaction and
  ignore `--dry-run` entirely.** For those three the flag is silently accepted
  and does nothing, and a failure part-way leaves a partial result. `v5` onward
  are transactional and `--dry-run` genuinely applies, verifies and rolls back.

Verify afterwards:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
```

A complete v19 database has **48 tables**. Anything less means a migration
stopped; read its output.

**Demonstration data is off by default.** `migrate_v2.js` can seed a poll,
vendors and a planning timeline so a demo environment does not open on empty
screens. It only does so when `DIC_SEED_DEMO=1`. Never set that in production —
until Phase 6 it ran unconditionally, and fresh production databases were
getting invented vendors with made-up phone numbers and a live poll on the
public news feed.

---

## D. Backup

### What runs, and when

**VPS:** `ops/cron-dic.sh` is the single nightly entry. In order: backup →
off-site copy → scheduled jobs → a restore drill on Sundays.

```cron
15 2 * * *  cd /srv/dic-alumni && ./ops/cron-dic.sh >> /var/log/dic-alumni-cron.log 2>&1
```

**Vercel:** the serverless filesystem is ephemeral and has no `pg_dump`, so the
application cannot back itself up. Use the database provider's own automated
backups, and record here what their retention window is. This is not optional —
without it a Vercel deployment has no backup at all.

### By hand

```bash
cd /srv/dic-alumni
node backup.js              # dump + prune to BACKUP_RETENTION_DAYS
node offsite.js             # ship the newest dump off this machine
node offsite.js --check     # report configuration and last result
```

`backup.js` writes `dic_alumni_<timestamp>.sql` into `BACKUP_DIR` with mode
`0600`, checks the dump ends with PostgreSQL's completion marker before trusting
it, prunes past `BACKUP_RETENTION_DAYS` (default 14, and it never deletes the
newest file whatever its age), and leaves `last-backup.json` as a receipt.

### The off-site copy

**A backup that lives only on the machine it was taken from does not survive the
failure it exists for.** `offsite.js` runs whatever `OFFSITE_CMD` says, with
`{file}` and `{name}` substituted. No vendor SDK and no credential is in the
repository.

```bash
# S3-compatible (AWS, Backblaze B2, Wasabi, MinIO)
OFFSITE_CMD='aws s3 cp {file} s3://dic-alumni-backups/{name} --sse AES256'
# any host reachable over ssh
OFFSITE_CMD='scp -q {file} backups@offsite.example:/srv/dic/{name}'
# rclone, which speaks most institutional cloud storage
OFFSITE_CMD='rclone copyto {file} dic-remote:alumni-backups/{name}'
```

A dump holds every alumnus's personal data in plaintext, plus the identity
vault's ciphertext. Prefer encryption at the destination; where the destination
cannot provide it, set `OFFSITE_ENCRYPT_CMD` and the encrypted file is what
gets shipped.

**Retention.** 14 daily copies locally by default. Agree a longer off-site
retention with DIC and record it here — a weekly kept for a month and a monthly
kept for a year is a reasonable shape. _DIC to confirm._

### When a backup fails

A failed backup is an incident. The log line says so:

```
[backup] FAILED: <reason>
[backup] a failed backup is an incident — see OPERATIONS_RUNBOOK.md section D
```

1. Read the reason. The usual causes are a full disk, `pg_dump` missing from
   `PATH` (set `PG_DUMP` to its full path), or the database being unreachable.
2. Fix it and run `node backup.js` by hand. Do not wait for tomorrow night.
3. Check `last-backup.json` now says `"status": "ok"`.
4. If it failed for more than one night, say so in the incident record: the
   recovery point is now as old as the last good dump.

---

## E. Restore

**Restoring overwrites everything written since the dump was taken.** Do it
because the data is wrong, not because a deploy went wrong — for a bad deploy,
roll the code back instead (section N).

### Rehearse it — weekly, automatically

```bash
node restore.js --drill
```

Restores the newest dump into a **disposable** database, verifies it, and drops
it. It never touches the live database. `ops/cron-dic.sh` runs it every Sunday.

The deeper drill, which also exercises the deletion purge:

```bash
node tests/ops_drill.js
```

### A real restore

```bash
# 1. Stop the application.
sudo systemctl stop dic-alumni

# 2. Capture the CURRENT bad state first. You will want it even though it is bad.
cd /srv/dic-alumni && node backup.js

# 3. Restore into a NEW database and inspect it before switching.
node restore.js --into dic_alumni_restore --file "$BACKUP_DIR/<dump>"
node verify_audit.js --database dic_alumni_restore
psql -d dic_alumni_restore -c "SELECT count(*) FROM users"
psql -d dic_alumni_restore -c "SELECT count(*) FROM identity_vault"

# 4. Only when that copy is verified, point PGDATABASE at it and start.
```

**Keep the damaged database.** Do not drop it until somebody has decided nothing
in it was needed.

A verified restore means: the table count matches, the critical row counts
match, the audit chain verifies, and the identity vault's ciphertext, IV and
auth tag survived byte for byte. `tests/ops_drill.js` checks all four.

**Known limitation:** `restore.js` reads the `PG*` variables and **ignores
`DATABASE_URL` entirely**, so it does not work on a deployment that uses a
connection string. Set the `PG*` variables for the restore, or use the
provider's own restore tooling.

---

## F. Scheduler

Three jobs run on a timer rather than when somebody opens a page:

| Job | What it does |
|---|---|
| `event-maintenance` | Rolls event statuses forward by the calendar and sends task deadline reminders |
| `deletion-purge` | Erases accounts whose 30-day grace period has expired |
| `mentorship-expiry` | Expires mentorship requests older than five days |

**`deletion-purge` is a promise made to every user who asks to be erased.** If
nothing triggers it, that promise is silently broken and nothing in the UI says so.

### Exactly one trigger is enabled

| | |
|---|---|
| **Vercel** | `vercel.json`'s `crons` block calls `/api/internal/jobs/run?job=<name>` with `CRON_SECRET` as a bearer token. `scheduler.js` is unused. |
| **VPS** | `ops/cron-dic.sh` runs `node scheduler.js`. It talks to the database directly, so jobs still run when the web process is down — which is when the purge matters most. |

_DIC to record which one this deployment uses._ **Never enable both.** They are
idempotent so nothing breaks, but the run log becomes unreadable.

**How to tell if both are firing:** `ops_runs.source` records which trigger ran
each job. `node scheduler.js --list` prints a warning when recent runs came from
more than one source.

### Inspecting and running by hand

```bash
node scheduler.js --list       # last run of each job, with age and outcome
node scheduler.js --status     # same, but exits non-zero if anything needs attention
node scheduler.js              # run every job now
node scheduler.js deletion-purge
```

Every job is idempotent: running one twice is indistinguishable from running it
once. Retries are safe.

### When a job fails

```
[scheduler] deletion-purge: FAILED — <reason>
```

1. `node scheduler.js --list` — how long has it been failing?
2. Run the one job by hand and read the error.
3. The Operations panel in the staff portal shows the same information without
   shell access.

A job killed mid-run used to stay marked `running` for ever, indistinguishable
from one in flight. The next run of the same job now marks anything older than
`JOB_STALE_MINUTES` (default 30) as failed.

**Nothing triggers scheduled work as a side effect of a page load.** Two such
triggers existed and were removed; if you find another, it is a bug.

---

## G. SMTP and email

Email is used for exactly one thing: password-reset links. There is no
broadcast email, no SMS, no push.

`MAIL_TRANSPORT` has **no default** and production will not boot without it:

| Value | Behaviour |
|---|---|
| `smtp` | Send. Requires `SMTP_HOST` and `SMTP_FROM`; `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASSWORD` as the provider requires. Port 465 uses implicit TLS; anything else negotiates STARTTLS. |
| `none` | Accept and drop. A deliberate choice to keep section J as the only recovery route. Users cannot reset their own passwords. |
| `console` | **Development only.** Writes reset links into the log in plaintext. |

### Checking it

The Operations panel reports mail state. From a shell:

```bash
curl -s -H "X-Cron-Key: $CRON_SECRET" https://alumni.<domain>/api/internal/monitor | grep -o '"mail":{[^}]*}'
```

A failed send is logged and deliberately never surfaced to the user, because
telling them would reveal whether the address is registered:

```
[mail] FAILED "Reset your DIC Alumni Network password" to ab***@example.com: <reason>
```

The address is masked in the log on purpose — a mail log should not become a
member directory.

### If reset emails are not arriving

1. Confirm `MAIL_TRANSPORT=smtp` and the SMTP variables are set. `console` and
   `none` both look like success from the outside.
2. Look for `[mail] FAILED` in the log.
3. Check the provider's own dashboard for rejections, and check SPF/DKIM/DMARC
   for the sending domain. Delivery to a third party has never been tested from
   this repository — the drill proves the message leaves, not that a provider
   accepts it.
4. Meanwhile, use section J.

---

## H. Secret rotation

Full procedures, consequences and escrow are in
[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md). In brief:

| Secret | Safe to rotate? | Consequence |
|---|---|---|
| `SESSION_SECRET` | Yes | Everybody is signed out. |
| `CRON_SECRET` | Yes | Update the trigger too — the Vercel environment variable or the crontab. |
| Database password | Yes | Update `.env` and restart. |
| `ENCRYPTION_KEY` | **No** | Every identity-vault record becomes permanently unreadable. Restoring a backup does not help — the backup holds the same ciphertext. |

---

## I. Encryption-key recovery

See [`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md) sections 2 and 4. The short
version, because it is the thing most likely to be got wrong:

- `ENCRYPTION_KEY` is the only secret whose loss destroys data.
- `identity_vault` stores **no key id and no key version**, so there is no
  zero-downtime rotation path.
- The key must exist in two places before the first record is written: the
  hosting platform's environment store, and the institution's password manager
  or sealed escrow. Two named people must be able to reach the escrow.
- Production refuses to boot without it — a missing key is a startup failure,
  not a quiet degradation. (An earlier version of this document said the vault
  merely "refuses to operate"; that is only true in development.)

---

## J. Password-reset emergency procedure — **break-glass only**

Normal recovery is self-service: the user clicks "Forgot your password?". This
is for when SMTP is down, or `MAIL_TRANSPORT=none`, or the account in question
is the super admin and nobody can sign in.

```bash
cd /srv/dic-alumni
node reset_link.js --email person@dic.edu.bd
```

It prints a single-use link valid for 30 minutes. Read it to the person over a
channel you trust; do not paste it into a shared chat.

**It refuses in two cases, and says so:**

- **No account with that address** — it exits 1. It does not create accounts.
  To create the *first* administrator on a new deployment, see section T.
- **The account is not `active`** — a suspended or pending account is refused.
  Reactivate it first (section L).

**Watch the hostname.** Self-service reset builds its link from
`PUBLIC_ORIGIN` — the alumni site. `reset_link.js` builds it from
`ADMIN_ORIGIN` and points at `/admin`. On a two-hostname deployment a staff
member who uses "Forgot your password?" on the staff portal is sent to the
*alumni* site to complete it. That works, but it surprises people.

**Never** email a reset link from your own account, and never read one out of
the application log.

---

## K. Account lockout recovery

A member or administrator says they cannot sign in and are being told to try
again later.

### What is happening

Two independent limiters:

| | Threshold | Where it lives | Survives a restart? |
|---|---|---|---|
| Durable account lock | 5 failures ⇒ `users.locked_until` set 15 minutes ahead | The `users` row | Yes |
| In-process throttle | 5 per account and 20 per IP per 15 minutes | Memory | No |

Both answer with **HTTP 429** and the same message, deliberately, so neither
reveals which one tripped or whether the address exists.

The durable lock is checked **before** the password is compared, so it actually
throttles guessing. The counter restarts once a lapsed lock is seen, so windows
cannot be chained into an indefinite lockout: **the lock lapses on its own after
15 minutes**, and a successful sign-in clears it.

### What to do

1. **Wait 15 minutes.** This resolves most cases and is the right answer for an
   ordinary member.
2. **A password reset also clears it** — section J, or self-service.
3. **For a member of staff**, a super admin can clear it immediately by
   resetting their password from the staff portal
   (`POST /api/admin/administrators/:id/reset-password`). That route matches on
   staff roles only, so **it cannot unlock an ordinary alumnus.**
4. **Everybody locked out at once** is a different problem: check `TRUST_PROXY`
   (section A). Behind a proxy with it unset, every request looks like the
   proxy's address and the per-IP limiter counts the whole internet as one
   client.

To confirm a lock rather than a wrong password:

```bash
psql "$DATABASE_URL" -c \
  "SELECT email, failed_login_count, locked_until FROM users WHERE email='person@dic.edu.bd'"
```

---

## L. Administrator suspension

**This is the correct immediate response to a compromised staff account** —
faster and more complete than changing the password, because it ends every
session at once.

From the staff portal: Administration → the account → Suspend. Or:

```
PUT /api/admin/administrators/:id/status    {"status": "suspended"}
```

Super admin only. It refuses self-suspension, so you cannot lock yourself out.
It bumps `token_version`, which means **every session that account has open dies
on its next request** — not at token expiry.

Reactivate the same way with `{"status": "active"}`. Rotate their password
(section J) before reactivating if the account was compromised.

A suspended account gets a distinct message at sign-in so the holder knows to
ask an administrator rather than retrying their password.

---

## M. Incident response

### Severity

| | Meaning | Response |
|---|---|---|
| **P1** | The platform is down, or personal data is exposed | Immediately, at any hour |
| **P2** | A core function is broken for everyone — sign-in, the purge, backups | Same day |
| **P3** | Degraded or partial — one screen, one role, a stale job | Next working day |

### The first five minutes

```bash
curl -s -w ' [%{http_code}]\n' https://alumni.<domain>/api/health
curl -s -H "X-Cron-Key: $CRON_SECRET" https://alumni.<domain>/api/internal/monitor
sudo journalctl -u dic-alumni -n 200 --no-pager     # VPS
```

`/api/health` answers one question: is the application up and can it reach the
database. `/api/internal/monitor` answers the rest — jobs, backups, off-site
copy, overdue deletions, mail.

### Site is down

1. Is the process running? Section B.
2. Is the database running and reachable? `degraded` in the health response
   means the app is up and the database is not.
3. Did it refuse to boot? Read the log — it names the missing variable.
4. Both hostnames serving the alumni site ⇒ the `Host` header is not reaching
   the application. A browser CORS error ⇒ `PUBLIC_ORIGIN` / `ADMIN_ORIGIN` do
   not match the hostnames in use, scheme included.

### Suspected data exposure

1. **Suspend the accounts involved** (section L) before anything else.
2. Do not restore, do not delete, do not "tidy up". Preserve the state.
3. Export the relevant audit entries:
   ```bash
   psql "$DATABASE_URL" -c \
     "SELECT * FROM audit_logs WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY id" > incident.csv
   ```
4. `npm run verify-audit-chain` — record the result, whichever way it goes.
5. Escalate (section S). A personal-data exposure is DIC's to disclose, not
   yours.

**Note on the audit log:** it is hash-chained but **unkeyed**. It detects
accidental corruption and naive tampering. It does not stop somebody with
database write access recomputing the whole chain. Do not present it as
tamper-proof. `AUDIT_CHAIN.md` sets out exactly what it does and does not prove.

### Communications

_DIC to record who announces an outage to alumni, and through which channel._

---

## N. Rollback

Decide which situation you are in first. Using the wrong one is how a bad deploy
becomes lost data.

### The code is bad, the data is fine — most rollbacks

```bash
cd /srv/dic-alumni
git log --oneline -10
git checkout <previous-commit-hash>
npm ci --omit=dev
sudo systemctl restart dic-alumni
```

Migrations are additive, so older code runs against a newer schema and ignores
the columns it does not know about. **Do not "roll back" a migration by dropping
columns.** There is no down-migration, and dropping a column destroys data the
newer code wrote.

**Vercel:** promote the previous deployment from the dashboard.

### The data is bad

Section E. Restore into a new database, verify it, then switch.

---

## O. DNS and subdomains

The platform serves two portals, and which one you get is decided by the
hostname or the path:

| | `PUBLIC_ORIGIN` | `ADMIN_ORIGIN` |
|---|---|---|
| Two hosts | `https://alumni.<domain>` | `https://admin.alumni.<domain>` |
| Single host | `https://alumni.<domain>` | the same value; staff use `/admin` |

Both are required in production. They are also the entire CORS allow-list.

**The staff portal is not a security boundary.** The API enforces roles
server-side on every request regardless of which HTML shell was served, so a
single host is a legitimate choice.

Hostnames are compared as hostnames, not substrings. `alumni.<domain>` is a
substring of `admin.alumni.<domain>`, and a substring comparison used to serve
the staff shell on the public domain.

### Two symptoms worth recognising

- **Both hostnames serve the alumni site** — the reverse proxy is not passing
  `Host`. nginx needs `proxy_set_header Host $host;`.
- **The browser reports a CORS error** — `PUBLIC_ORIGIN` or `ADMIN_ORIGIN` does
  not exactly match the origin in use. The scheme counts: `https://` and
  `http://` are different origins.

TLS is terminated by the proxy or platform, not by the application. The
application does not send `Strict-Transport-Security`; whatever terminates TLS
should.

---

## P. Health check

```bash
curl -s -w ' [%{http_code}]\n' https://alumni.<domain>/api/health
```

| Response | HTTP | Meaning |
|---|---|---|
| `{"status":"ok","database":"ok","latencyMs":n}` | **200** | Healthy |
| `{"status":"degraded","database":"unreachable"}` | **503** | The application is up, the database is not |
| no answer, timeout, connection refused | — | The application is down |

It cannot report `ok` while the database is unreachable: it performs a real
`SELECT 1` on every call. The third state is only observable from outside,
which is why the monitor must not run on the same machine.

---

## Q. Monitoring

Two layers. Set up at least the first.

### 1. An external uptime service — prefer this

A monitor on the same box cannot tell you the box is unreachable. Any uptime
service will do; the contract is section P. **Alert on two consecutive failures
at a 60-second interval.**

_DIC to provide the monitoring service and the on-call address._

### 2. Operational health, which an HTTP probe cannot see

`/api/health` returns 200 while the purge has been failing for a fortnight and
the backups stopped a week ago. This endpoint answers that:

```bash
curl -s -w ' [%{http_code}]\n' -H "X-Cron-Key: $CRON_SECRET" \
  https://alumni.<domain>/api/internal/monitor
```

- **200** — everything is within its freshness window.
- **503** — something needs attention; `problems` says what.

It reports the database, every job with its age and outcome, the backup receipt,
the off-site receipt, overdue deletions, and the mail mode. It separates
`problems` (503, wake someone) from `advisories` (200, worth knowing — for
example that no off-site destination is configured).

It is authenticated with the **scheduler credential**, not an admin session, so
an uptime service can carry it in a header. It is never exposed to the browser.

There is also a local fallback that checks the same things from cron:

```cron
*/5 * * * *  /srv/dic-alumni/ops/healthcheck.sh || /usr/local/bin/alert-oncall
```

Exit codes: `0` healthy, `1` application or database down, `2` degraded.

No dashboard is provided or wanted. The Operations panel in the staff portal
shows the same state to a human.

---

## R. Where the logs are

**VPS:**

```bash
sudo journalctl -u dic-alumni -f              # live
sudo journalctl -u dic-alumni --since today
tail -f /var/log/dic-alumni-cron.log          # nightly backup, off-site, jobs
```

**Vercel:** the project's Logs tab. There is no file to tail.

### Reading a log line

```
[api] 2026-09-03T14:22:01.114Z a1b2c3d4e5f6 GET /api/alumni/42 200 18ms uid=7
```

Tag, timestamp, **correlation id**, method, path, status, duration, user id.
The correlation id also goes out on the `X-Request-Id` response header, so a
user's screenshot can be matched to a log line without either party quoting
anything sensitive.

**By default only failures are logged.** Successful requests appear only when
`LOG_REQUESTS=all` is set. If you are investigating "saving failed yesterday"
and find nothing, that is why — turn it on while diagnosing and turn it off
again, because it is noisy.

Other tags: `[mail]`, `[health]`, `[scheduler]`, `[ops]`, `[backup]`,
`[offsite]`, `[monitor]`.

### What is deliberately never logged

Passwords, session tokens, reset tokens, reset links, `ENCRYPTION_KEY`,
`SESSION_SECRET`, `CRON_SECRET`, database passwords, identity-vault plaintext,
request bodies, query strings, and the `Authorization` header. Email addresses
are masked in mail lines. **If you find any of these in a log, that is a
security incident** — section M.

### Rotation

The cron entries append to files that nothing rotates. Add logrotate before
they grow without limit:

```
/var/log/dic-alumni-*.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    create 0640 dic-alumni dic-alumni
}
```

---

## S. Escalation contacts

_DIC to fill in. Each of these is a named person, not a role._

| | Name | Contact | Hours |
|---|---|---|---|
| First responder | | | |
| Database / hosting | | | |
| Data protection owner | | | |
| Institutional escalation | | | |

Two people must be able to reach the secret escrow (`KEY_MANAGEMENT.md`), and
they must not both be unreachable at once.

---

## T. Provisioning the first administrator

Only needed on a new deployment. A fresh install has **no accounts at all** —
`seed.sql` is not run in production, and every provisioning route requires a
super-admin session, so there is a bootstrap problem this command exists to
solve.

```bash
cd /srv/dic-alumni
node rotate_credentials.js --create-super-admin admin@dic.edu.bd --name "Full Name"
```

- Supply `ADMIN_PW_SUPER_ADMIN` (12 characters minimum) to choose the password,
  or let it generate a 24-character one written **once** to
  `admin-credentials.local.txt`.
- It **refuses if a super admin already exists**. It is for the first one only.
- The account is created with `must_change_password` set, so its first session
  can do exactly three things: identify itself, change its password, and sign
  out. Everything else returns *"This account must set its own password before
  it can be used."*

Move any generated password into the password manager and delete the file:

```bash
shred -u admin-credentials.local.txt 2>/dev/null || rm -f admin-credentials.local.txt
```

### The enrolment gate — expect help-desk questions about this

Any account provisioned or reset by somebody else carries
`must_change_password`, and is restricted to those three routes until it sets
its own password. This is deliberate: bulk import gives an entire batch one
shared password, so until it is replaced that credential is an enrolment token
and nothing more.

Two other tools you may need:

```bash
node rotate_credentials.js --check     # which accounts accept a weak password; changes nothing
node rotate_credentials.js            # rotate privileged accounts that do
```

`--check` prints **no passwords** and changes nothing, despite what an earlier
version of this document implied.

---

## Appendix 1 — Pre-deploy verification

Run all of it before any deploy. It takes a few minutes.

```bash
cd /srv/dic-alumni
npm ci                          # exactly what the lockfile pins
npm test                        # 22 suites
npm run drills                  # fresh install, purge/backup/restore, mail delivery
npm run verify-audit-chain      # expect PASS and exit 0
```

`npm run preflight` runs the suites and the chain verification together. The
drills build their own disposable databases and drop them; they never touch the
live one. `.github/workflows/ci.yml` runs the same sequence on every push,
against a database installed from `schema.sql` plus the migrations.

## Appendix 2 — Every environment variable

| Variable | Required | When |
|---|---|---|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | yes | Or a single `DATABASE_URL` instead |
| `SESSION_SECRET` | yes | Production |
| `ENCRYPTION_KEY` | yes | Production. 64 hex characters |
| `CRON_SECRET` | yes | Production. 32+ characters |
| `MAIL_TRANSPORT` | yes | Production. No default |
| `PUBLIC_ORIGIN` `ADMIN_ORIGIN` | yes | Production |
| `BACKUP_DIR` | yes | Production. Absolute, outside the application directory |
| `SMTP_HOST` `SMTP_FROM` | conditional | When `MAIL_TRANSPORT=smtp` |
| `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` | conditional | As the provider requires |
| `PORT` | no | Defaults to 8000 |
| `TRUST_PROXY` | no | Set to the hop count when behind a proxy. Wrong in both directions — section A |
| `BACKUP_RETENTION_DAYS` | no | Defaults to 14 |
| `OFFSITE_CMD` | no | But a deployment without one keeps a single copy of its data |
| `OFFSITE_ENCRYPT_CMD` | no | When the destination cannot encrypt at rest |
| `DB_TIMEZONE` | no | Defaults to `Asia/Dhaka`. Business dates are local dates |
| `JOB_STALE_MINUTES` | no | Defaults to 30 |
| `MONITOR_JOB_MAX_HOURS` `MONITOR_BACKUP_MAX_HOURS` | no | Default 36 |
| `LOG_REQUESTS` | no | `all` logs successful requests too. Noisy |
| `PG_DUMP` | no | Full path, when `pg_dump` is not on `PATH` |
| `DOCKER_PG_CONTAINER` | no | Development only |
| `ALLOW_DB_RESEED` | no | **Never in production** |
| `DIC_SEED_DEMO` | no | **Never in production**. Seeds invented demonstration content |
| `DIC_SKIP_DOTENV` | no | Testing only. Never on a real deployment |
