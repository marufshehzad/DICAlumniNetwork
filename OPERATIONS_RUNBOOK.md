# DIC Alumni Platform — Operations Runbook

**Who this is for:** the person responsible for keeping the platform running. It
assumes you can open a terminal on the server and follow instructions. It does
not assume you can read the code.

**Before an incident, know these three things:**

| | |
|---|---|
| Where the application runs | _fill in: hostname, or the Vercel project name_ |
| Where the backups are | _fill in: `BACKUP_DIR`, and the off-site copy_ |
| Who to call | _fill in: see section N_ |

Every command below is run from the application directory (`/srv/dic-alumni` in
these examples). Anything that could destroy data says so before the command.

---

## A. Start the service

**Standalone server (VPS):**

```bash
cd /srv/dic-alumni && node server.js
```

Under a process manager, which is what a real deployment should use so the app
restarts after a crash or reboot:

```bash
sudo systemctl start dic-alumni
sudo systemctl status dic-alumni
```

**Vercel:** the application starts on demand. There is nothing to start; a
deploy is the only "restart".

**If it refuses to start**, read the error. In production it deliberately
refuses to boot when a required secret is missing, and it names which one:

```
Refusing to start in production: required secret(s) missing or malformed:
SESSION_SECRET, CRON_SECRET (32+ characters)
```

That is the application working correctly, not a bug. Set the named variables
(section G) and start again. Required in production:

| Variable | Why it must be set |
|---|---|
| `SESSION_SECRET` | Signs session tokens. Missing ⇒ every user is signed out on each restart. |
| `ENCRYPTION_KEY` | Encrypts NID/BRC records and signs ticket QR codes. Missing ⇒ the identity vault and ticketing both refuse to operate. |
| `CRON_SECRET` | The scheduler's credential. Missing ⇒ nightly jobs cannot run, including the account-deletion purge. |
| `SMTP_HOST`, `SMTP_FROM` | Password-reset email. Not required if `MAIL_TRANSPORT=none`, which is a deliberate choice to keep section H as the only recovery route. |

---

## B. Check health

```bash
curl -s https://alumni.<domain>/api/health
```

| Response | Meaning | Do |
|---|---|---|
| `{"status":"ok","database":"ok",...}` | Healthy | Nothing |
| `{"status":"degraded","database":"unreachable"}` | App up, database down | Section J |
| No response / timeout / 502 | Application down | Section L |

This endpoint is public and intentionally says nothing else — no version, no
host, no user count. The detail you need during an incident is in the admin
portal under **Operations**, which requires an administrator sign-in.

---

## C. Check the scheduler

**In the browser:** sign in to the staff portal → **Operations**. Each job
shows when it last ran and whether it succeeded. A job marked **stale** has not
run in over 36 hours, which usually means the scheduler stopped, not that the
job failed.

**From the terminal:**

```bash
# Last run of each job
psql "$DATABASE_URL" -c \
  "SELECT DISTINCT ON (job) job, status, started_at, items, detail
     FROM ops_runs ORDER BY job, started_at DESC;"
```

**To run a job by hand** (safe — every job is idempotent, so running one twice
does nothing the first run did not already do):

```bash
curl -X POST "https://alumni.<domain>/api/internal/jobs/run?job=deletion-purge" \
     -H "X-Cron-Key: $CRON_SECRET"
```

Job names: `event-maintenance`, `deletion-purge`, `mentorship-expiry`. Omit
`?job=` to run all three.

**Where the schedule lives — exactly one of these is active:**

- **Vercel:** the `crons` block in `vercel.json`. Vercel calls the endpoint with
  the `CRON_SECRET` as a bearer token. Check the Cron tab in the Vercel
  dashboard for run history.
- **VPS:** `ops/cron-dic.sh`, installed in the deploy user's crontab. It also
  takes the nightly backup and runs a weekly restore drill.

  ```bash
  crontab -l                       # confirm the entry exists
  tail -50 /var/log/dic-alumni-cron.log
  ```

**Never enable both.** Two schedulers pointed at the same jobs is how nobody
can say which one ran.

---

## D. Check the latest backup

```bash
node backup.js --list
cat "$BACKUP_DIR/last-backup.json"
```

`last-backup.json` says `"status": "ok"` and when it finished. The admin
portal's Operations page shows the same thing. A backup older than 36 hours is
flagged as stale — treat that as an incident, not a warning: it means the
nightly job stopped and nobody noticed.

**Take one right now:**

```bash
node backup.js
```

---

## E. Restore

> **Read this whole section before typing anything.** Restoring is how data gets
> lost, not how it gets saved. There is no "restore over production" command,
> deliberately.

**E1. Prove the backup is good — do this first, always:**

```bash
node restore.js --drill
```

This restores the newest backup into a throwaway database, checks that users,
events, tickets, registrations, donations, audit logs and the identity vault
all came back, then drops the throwaway. It never touches the live database.

**E2. Restore for real.** The safe order is: restore beside production, verify,
then repoint the application. Never overwrite the live database in place.

```bash
# 1. Back up what is there now, however broken — you may need it.
node backup.js

# 2. Create a new, empty database.
createdb dic_alumni_restored

# 3. Load the backup into it.
node restore.js --into dic_alumni_restored --file "$BACKUP_DIR/<chosen-file>.sql"

# 4. Look at it before trusting it.
psql -d dic_alumni_restored -c "SELECT COUNT(*) FROM users;"
psql -d dic_alumni_restored -c "SELECT COUNT(*) FROM audit_logs;"

# 5. Point the application at it: change PGDATABASE (or DATABASE_URL) in .env
#    and restart. Keep the old database until you are certain.
```

**What a restore costs you:** everything written between the backup and now.
Logical backups run nightly, so the worst case is roughly 24 hours of new
registrations, pledges and profile edits. If the institution cannot accept that,
it needs a managed database with point-in-time recovery — see section F.

---

## F. Backup policy

| | |
|---|---|
| **Method** | `pg_dump` logical backup, full schema + data |
| **Schedule** | Nightly, before the scheduled jobs run |
| **Retention** | 14 days of dailies (`BACKUP_RETENTION_DAYS`) |
| **Location** | `BACKUP_DIR` — must be outside the application directory and outside any web root |
| **Permissions** | Directory `0700`, files `0600`, owned by the deploy user |
| **Encryption at rest** | Provided by the disk/volume. A dump contains every alumnus's personal data — if the volume is not encrypted, this is not adequate. |
| **Off-site copy** | _fill in._ A backup on the same server as the database does not survive losing that server. |
| **Verification** | Weekly automated restore drill (`ops/cron-dic.sh`, Sundays) |

The newest backup is never pruned, whatever its age — a stale backup is still
better than none.

**If the provider offers managed point-in-time recovery** (Neon, RDS, Supabase),
document it here and treat `pg_dump` as the second line rather than the first.
They are not equivalent: PITR recovers to a moment, `pg_dump` recovers to last
night.

_Provider PITR status: **fill in** — enabled/not enabled, retention window._

---

## G. Rotate credentials

**Seeded staff account passwords:**

```bash
node rotate_credentials.js --all      # generate new ones
node rotate_credentials.js --check    # find accounts still on a weak password
```

New passwords are written once to `admin-credentials.local.txt`, which is
gitignored and is **not** served by the web server. Move them into the password
manager and delete the file.

**`SESSION_SECRET`** — changing it signs everybody out immediately. Do it during
a quiet hour, and only if you believe it has leaked.

**`ENCRYPTION_KEY`** — see section K first. Rotating it without re-encrypting
makes every existing vault record permanently unreadable.

**`CRON_SECRET`** — change it in the application environment and in whichever
scheduler is active, in that order. The jobs simply fail to authenticate in
between; nothing is lost.

---

## H. Administrator password recovery

**Normal route:** the person clicks "Forgot your password?" on the sign-in
screen and receives a link by email. It works once and expires in 30 minutes.

**If email is not configured or is broken** (emergency only — needs server
access):

```bash
node reset_link.js --email someone@dic.edu.bd
```

The link is written to `reset-link.local.txt` (gitignored, mode 0600) and
deliberately **not** printed to the terminal, so it cannot end up in a shell
history or a screen recording. Send it to the person over a channel you trust,
and delete the file afterwards.

**A super admin can also reset any staff account** from the staff portal:
Administration → the person → Reset password. They are given a temporary
password and must change it at next sign-in.

---

## I. Emergency super admin recovery

There is **one** super admin account. If it is lost, nobody can provision
administrators, change roles, or reach the audit log.

**Prepare for this before it happens** — the institution should do exactly one
of the following, and record which:

**Option 1 — sealed backup credential (recommended).**
Create a second `super_admin` whose password is generated, written down once,
sealed in an envelope, and stored wherever the institution keeps its
constitutional documents. It is never used for daily work and its sign-ins are
audited like any other. Review the audit log for its use at every term end.

```bash
# One-time, run by a super admin, then seal the printed password:
node rotate_credentials.js --check     # confirm the account exists and is strong
```

**Option 2 — documented offline recovery.**
Accept a single super admin, and record here the exact procedure for creating a
replacement with database access:

```bash
# Requires database credentials. Every use must be reported to the
# institution's IT authority and recorded below.
node reset_link.js --email <the super admin's address>
```

_Which option is in force, and where the sealed record is kept: **fill in**._

**Every use of an emergency credential is audited.** After any use, check:

```bash
psql "$DATABASE_URL" -c \
  "SELECT created_at, action, meta, actor_id FROM audit_logs
    ORDER BY id DESC LIMIT 40;"
```

---

## J. The database is unavailable

Symptom: `/api/health` returns `{"status":"degraded","database":"unreachable"}`.

1. **Is the database running?**
   ```bash
   sudo systemctl status postgresql        # or: docker ps
   ```
2. **Can this machine reach it?**
   ```bash
   psql "$DATABASE_URL" -c "SELECT 1;"
   ```
3. **Is it out of disk?** This is the most common cause.
   ```bash
   df -h
   ```
4. **Is it out of connections?** The application uses a pool; a leak elsewhere
   can exhaust the server's limit.
   ```bash
   psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity;"
   ```

The application does not need restarting once the database returns — the pool
reconnects. Restart it only if health stays degraded after the database is
confirmed up.

**Do not restore from backup** because the database is unreachable. It is
almost never the answer, and it discards everything since last night. Fix the
connection first.

---

## K. `ENCRYPTION_KEY` is lost

**Read this before doing anything.**

`ENCRYPTION_KEY` encrypts the identity vault — the NID, BRC and passport
records — with AES-256-GCM. **If it is lost, those records cannot be recovered
by anyone, including us.** They are not recoverable from a backup either: the
backup contains ciphertext, and the key is not in the backup.

It also signs event ticket QR codes. A changed key invalidates every ticket
already issued.

**If the key is lost:**

1. Do not rotate anything else yet.
2. The application will refuse to start in production. That is correct — it
   protects you from silently writing new records under a new key while old
   ones become unreadable.
3. Decide, with the institution's data-protection owner:
   - Generate a new key, accept that existing vault records are gone, and clear
     them so the vault does not appear to hold data it cannot read.
   - Restore the key from escrow (below) if a copy exists.
4. Re-issue any outstanding event tickets.

**Escrow — do this now if it has not been done.** Both `ENCRYPTION_KEY` and
`SESSION_SECRET` must exist in exactly two places:

1. The deployment environment (Vercel environment variables, or `.env` on the
   server with mode `0600`).
2. The institution's approved password manager, or a sealed offline record held
   with the institution's other critical credentials.

They must **never** be in: git, this runbook, the README, any frontend file,
any public file, the database, a support ticket, or a chat message. The
application never prints them — the startup error names a missing variable, not
its value.

_Where escrow is held: **fill in**. Last verified readable: **fill in**._

---

## L. The site is down

1. **Confirm it is not just you.**
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://alumni.<domain>/api/health
   ```
2. **Is the process running?**
   ```bash
   sudo systemctl status dic-alumni
   sudo journalctl -u dic-alumni -n 100 --no-pager
   ```
   On Vercel: check the deployment's function logs.
3. **Did a deploy just happen?** If so, section M.
4. **Did it fail to start on a missing secret?** The log says which one; see
   section A.
5. **Is the database down?** Section J.
6. **Restart it.**
   ```bash
   sudo systemctl restart dic-alumni
   ```

Log lines for API requests look like this, and are safe to paste into a ticket
— they contain no tokens, no passwords, and no query strings:

```
2026-09-02T03:22:11.001Z 8f3a91c2d40e POST /api/auth/login 401 42ms anon
```

The 12-character value is the request id, also returned to the browser as
`X-Request-Id`. If a user can give you that, it will find their exact request.

---

## M. Rollback

**Code:**

```bash
cd /srv/dic-alumni
git log --oneline -10
git checkout <previous-good-commit>
sudo systemctl restart dic-alumni
```

On Vercel, use *Instant Rollback* in the deployment list — it does not rebuild.

**Database:** migrations in this project are additive and idempotent. They add
columns and tables; they do not drop or rewrite. That means **rolling the code
back does not require rolling the database back** — an older application simply
ignores the newer columns. This is deliberate, and it is why the migration
procedure below never needs a "down" script.

If a migration itself failed, it rolled itself back — each one runs in a single
transaction and verifies before committing. Nothing partial is left behind.

---

## N. Migration procedure

> Migrations are **not** run automatically during deployment. That is a
> deliberate choice: a schema change should have a human watching it.

1. **Verify a current backup exists.**
   ```bash
   cat "$BACKUP_DIR/last-backup.json"
   ```
2. **Take a fresh one anyway.**
   ```bash
   node backup.js
   ```
3. **Prove it restores.**
   ```bash
   node restore.js --drill
   ```
4. **Dry-run the migration** — applies it, verifies it, rolls it back.
   ```bash
   node migrate_v10.js --dry-run
   ```
5. **Apply it.**
   ```bash
   node migrate_v10.js
   ```
6. **Confirm.** Each migration prints its own verification checks; every line
   must read `ok`. If any reads `FAIL` the migration rolled itself back and the
   database is unchanged.
7. **If something is wrong afterwards**, section E for the data and section M
   for the code.

Migrations to date: `migrate_v2.js` … `migrate_v10.js`. Run them in order on a
new deployment.

---

## O. Contacts and escalation

_Fill this in before go-live. An escalation path written during an incident is
not an escalation path._

| Role | Name | Contact | When |
|---|---|---|---|
| First responder (platform) | | | Site down, database down |
| Institution IT authority | | | Anything touching alumni data |
| Data-protection owner | | | Suspected data exposure, deletion disputes, key loss |
| Database/hosting provider | | | Provider-side outage, PITR requests |

**Escalate immediately, do not wait for business hours:**

- Any suspicion that alumni personal data has been exposed.
- `ENCRYPTION_KEY` lost or believed leaked.
- The credentials file or `.env` believed to have been read by someone else.
- A backup that cannot be restored.

**Can wait until morning:** a single failed scheduled job, a stale backup with a
good one behind it, a slow page.

---

## Appendix — daily and weekly checks

**Daily (2 minutes):** open the staff portal → Operations. All jobs green and
recent, backup green and under 36 hours old.

**Weekly:** confirm the restore drill passed.
```bash
cat "$BACKUP_DIR/last-drill.json"
```

**Each term:** review the audit log for use of the emergency super admin
credential; confirm the escrowed secrets are still readable; re-check that the
contacts above are still the right people.
