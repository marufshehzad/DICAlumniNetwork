# Production Deployment Runbook — DIC Alumni Platform

**Who this is for:** the engineer performing the first production deployment,
and anyone repeating it later. It is a sequence, not a reference — run the steps
in order and do not skip verification steps because the previous one looked
fine.

**What this document is not:** it is not the day-2 operations guide. Once the
platform is live, incidents, backups, job failures and account recovery are in
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md). It is also not a claim that a
deployment has happened. Nothing in this repository has ever run on a DIC
server; every command below is written to be run for the first time.

**Prerequisites that are not this repository's to supply** are listed in
[`PRODUCTION_DEPENDENCIES.md`](PRODUCTION_DEPENDENCIES.md) and summarised in
[`PRODUCTION_HANDOVER_CHECKLIST.md`](PRODUCTION_HANDOVER_CHECKLIST.md). Read
both before starting. If a domain, an SMTP account or a backup destination is
still unknown, stop at step 3 rather than inventing one.

Conventions below: `/srv/dic-alumni` is the application directory and
`dic-alumni` the service name. Substitute your own. Every destructive command
says so on the line above it.

---

## What is being deployed

| | |
|---|---|
| Runtime | Node.js — developed and tested on v24.15.0. Node 20 LTS or newer. |
| Dependencies | five: `express`, `body-parser`, `cors`, `pg`, `nodemailer`. No build step, no bundler, no framework. |
| Database | PostgreSQL — developed and tested against 16.14. |
| Process model | one long-lived Node process. No worker pool, no queue, no cache server. |
| Static assets | served by the application from the repository root through an allow-list. |
| Sessions | HMAC-SHA256 bearer tokens in the `Authorization` header. No cookies, no session store, so no sticky sessions are required — but see step 6 on `SESSION_SECRET`. |
| Scheduler | an HTTP endpoint the host's cron calls. No in-process timer. |

---

## Step 0 — Decide the two hostnames

Everything downstream depends on this and it cannot be deferred.

The platform serves two portals: the alumni site and the staff portal. They can
share one hostname (staff reach it at `/admin`) or use two:

| Layout | `PUBLIC_ORIGIN` | `ADMIN_ORIGIN` | Notes |
|---|---|---|---|
| Single host | `https://alumni.<domain>` | same value | The server detects the shared origin and routes the staff portal by path. |
| Two hosts | `https://alumni.<domain>` | `https://admin.alumni.<domain>` | Both must point at this deployment. |

Both variables are **required in production** either way. The staff portal is
not a security boundary — the API enforces roles server-side on every route
regardless of which HTML shell was served — so a single host is a legitimate
choice, not a compromise.

Record the decision. Step 6, step 9 and the TLS certificate all consume it.

---

## Step 1 — Get the code onto the server

```bash
sudo mkdir -p /srv/dic-alumni && sudo chown "$USER" /srv/dic-alumni
git clone <repository-url> /srv/dic-alumni
cd /srv/dic-alumni && git log -1 --format='%H %s'
```

Record the commit hash. It is the only thing that identifies what is running.

```bash
cd /srv/dic-alumni && npm ci --omit=dev
```

`npm ci` rather than `npm install`: it installs exactly what `package-lock.json`
pins. If the lockfile and `package.json` disagree it fails instead of quietly
resolving something else.

---

## Step 2 — Create the database and its role

**Destructive if the name already exists — check first.**

```bash
sudo -u postgres psql -c "SELECT datname FROM pg_database WHERE datname='dic_alumni_db'"
```

If that returns nothing, create it:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE dicalumni LOGIN PASSWORD 'PUT-A-GENERATED-PASSWORD-HERE';
CREATE DATABASE dic_alumni_db OWNER dicalumni;
SQL
```

Generate the password with a password manager, not by hand, and store it there
before you paste it. It goes into `.env` in step 6 and nowhere else.

The application does not need superuser. It needs to own its own database
because migrations create tables, indexes and constraints.

---

## Step 3 — Stop here if any dependency is still unknown

Do not continue past this line with a placeholder. Specifically:

- [ ] Both hostnames from step 0 exist in DNS and resolve to this server.
- [ ] A TLS certificate covers both hostnames.
- [ ] The SMTP decision is made — a real account, or a documented decision to
      run `MAIL_TRANSPORT=none` and recover accounts by hand (step 6).
- [ ] A backup destination exists that is **not** inside `/srv/dic-alumni` and
      is not served by any web server.
- [ ] Someone at DIC is named as the owner of the super-admin account.

Each of these is somebody's decision to make, and a guess here becomes a
production incident later. `PRODUCTION_DEPENDENCIES.md` records who owns which.

---

## Step 4 — Apply the schema

The base schema first:

```bash
cd /srv/dic-alumni && psql "$DATABASE_URL" -f schema.sql
```

Then every versioned migration, **in numeric order**, v2 through v13. They are
additive, idempotent and transactional: each one checks whether its change is
already present, and rolls back entirely on error.

Dry-run each first. `--dry-run` applies the migration, runs its own
verification, then rolls back — so it proves the migration works against *this*
database without keeping the result:

```bash
cd /srv/dic-alumni
for v in 2 3 4 5 6 7 8 9 10 11 12 13; do
  node "migrate_v$v.js" --dry-run || { echo "v$v FAILED — stop"; break; }
done
```

Read the output. A dry run that reports a failed verification is telling you
something about the database, not about the migration.

Then apply for real:

```bash
cd /srv/dic-alumni
for v in 2 3 4 5 6 7 8 9 10 11 12 13; do
  node "migrate_v$v.js" || { echo "v$v FAILED — stop and read the error"; break; }
done
```

Confirm the result:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public'"
psql "$DATABASE_URL" -c "SELECT count(*) AS places FROM location_places"
```

A complete v13 database has 47 tables and 99 rows in `location_places`.

**Do not run `seed.sql` on a production database.** It creates demo alumni and
demo administrators. Step 7 creates the real first account.

---

## Step 5 — Generate the secrets

Three values, each generated fresh for this deployment. Never reuse a
development value, never copy one from a document, never commit any of them.

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('CRON_SECRET='    + require('crypto').randomBytes(32).toString('hex'))"
```

| Secret | What it protects | What losing it costs |
|---|---|---|
| `SESSION_SECRET` | Signs session tokens. | Rotating it signs every user out. That is all — it is recoverable. |
| `ENCRYPTION_KEY` | AES-256-GCM key for the NID/BRC identity vault, and the signature on ticket QR codes. | **Not recoverable.** Lose it and every encrypted identity record is unreadable permanently. Store it in the institution's password manager before the first record is written, and treat it like a database backup. |
| `CRON_SECRET` | The scheduler's credential. | Rotating it is safe; update the cron entry in step 10. |

Put all three into the password manager now, while you have them on screen.

---

## Step 6 — Write `.env`

```bash
cd /srv/dic-alumni
cp .env.example .env
chmod 600 .env
```

Then edit it. `.env.example` documents every variable; this table is the
production-required subset. **The application refuses to start in production if
any of these is missing or malformed, and names the ones it is missing.** That
refusal is the feature — do not work around it.

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | yes | from step 2 — or a single `DATABASE_URL` instead |
| `PORT` | no | defaults to 8000 |
| `SESSION_SECRET` | yes | step 5, 64 hex characters |
| `ENCRYPTION_KEY` | yes | step 5, exactly 64 hex characters |
| `CRON_SECRET` | yes | step 5, 32 characters minimum |
| `PUBLIC_ORIGIN` | yes | step 0 |
| `ADMIN_ORIGIN` | yes | step 0 |
| `MAIL_TRANSPORT` | yes | `smtp`, or `none` — see below |
| `SMTP_HOST` `SMTP_FROM` | if `smtp` | from the mail provider |
| `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` | if `smtp` | from the mail provider |
| `BACKUP_DIR` | yes in practice | an absolute path outside the repository |
| `BACKUP_RETENTION_DAYS` | no | defaults to 14 |

On `MAIL_TRANSPORT` — it has no default on purpose. The three values are:

- `smtp` — send. The production setting.
- `none` — accept and discard. A deliberate choice for a deployment that
  recovers accounts only through `reset_link.js`, run by an operator. It does
  not scale past a handful of people, and users cannot reset their own
  passwords. Choose it knowingly.
- `console` — print the message to the log instead. **Development only.** It
  writes password-reset links into the log file in plaintext.

Never set `ALLOW_DB_RESEED` or `DIC_SKIP_DOTENV` on a production host.

---

## Step 7 — Create the real first administrator

The seeded accounts do not exist on a production database (you did not run
`seed.sql`). Create the super admin:

```bash
cd /srv/dic-alumni && node rotate_credentials.js --check
```

`--check` reports which accounts, if any, accept a weak password, and changes
nothing. On a fresh production database it should find no privileged account at
all — which means you provision one from the staff portal after step 9, or by
supplying a password through the environment:

```bash
cd /srv/dic-alumni && ADMIN_PW_SUPER_ADMIN='<from the password manager>' node rotate_credentials.js
```

Generated passwords are written once to `admin-credentials.local.txt`
(gitignored, restricted permissions) and never to stdout or a log. **Move them
into the password manager and delete that file** before you leave the server:

```bash
cd /srv/dic-alumni && shred -u admin-credentials.local.txt 2>/dev/null || rm -f admin-credentials.local.txt
```

---

## Step 8 — Start it under a process manager

Running `node server.js` in a shell is fine for the smoke test in step 9 and
wrong as a deployment: nothing restarts it after a crash or a reboot.

```ini
# /etc/systemd/system/dic-alumni.service
[Unit]
Description=DIC Alumni Platform
After=network.target postgresql.service

[Service]
Type=simple
User=dic-alumni
WorkingDirectory=/srv/dic-alumni
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# .env is read by the application itself; systemd does not need to load it.

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dic-alumni
sudo systemctl status dic-alumni
```

The startup banner names the database it actually connected to — it asks the
connection, rather than printing a configured name — so read it:

```bash
sudo journalctl -u dic-alumni -n 30 --no-pager
```

```
🚀 DIC Alumni Platform API Server running on http://localhost:8000
🐘 Connected to PostgreSQL database "dic_alumni_db" (PostgreSQL 16.14)
```

If it says `NOT connected to PostgreSQL`, the application is up and the
database is not. Fix that before continuing; nothing below will work.

---

## Step 9 — Put TLS in front of it

The application speaks plain HTTP and does not terminate TLS. It also does not
send `Strict-Transport-Security` — that belongs to whatever terminates TLS.
It does set `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`X-Frame-Options` and a `frame-ancestors` CSP itself.

**Set `TRUST_PROXY` in `.env` to the number of proxy hops you actually have —
`1` for the configuration below.** It defaults to unset, meaning no proxy, and
it is wrong in both directions:

- Left unset behind a proxy, every request appears to come from the proxy, so
  the per-IP login throttle treats the whole internet as one client and a
  handful of failed sign-ins locks everybody out.
- Set with no proxy in front, the value is a hop *count* rather than an address
  allow-list, so the peer is trusted unconditionally and `X-Forwarded-For`
  becomes the caller's to choose. Measured: 32 wrong passwords against one
  account with a rotating forged header produced zero refusals, and the forged
  address is what the audit trail recorded.

The rate limiter and the audit trail both read `req.ip`, so this one variable
decides whether either of them means anything.

```nginx
server {
  listen 443 ssl http2;
  server_name alumni.<domain> admin.alumni.<domain>;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass         http://127.0.0.1:8000;
    proxy_set_header   Host              $host;      # required: host routing reads it
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
  }
}
```

`proxy_set_header Host $host` is not optional. The server chooses which portal
to serve from the hostname; without it every request looks like `127.0.0.1` and
both hostnames serve the alumni site.

---

## Step 10 — Schedule the nightly jobs

There is no in-process timer. Three jobs — `event-maintenance`,
`deletion-purge`, `mentorship-expiry` — run when something calls the endpoint
with `CRON_SECRET`.

**`deletion-purge` is a promise to users who asked to be erased.** If nothing
calls this endpoint, that promise is silently broken and nothing in the UI will
say so.

```bash
sudo crontab -e
```

```cron
# DIC Alumni Platform — nightly maintenance, 02:15 local
15 2 * * * curl -fsS -X POST -H "Authorization: Bearer <CRON_SECRET>" \
             https://alumni.<domain>/api/internal/jobs/run >> /var/log/dic-alumni-jobs.log 2>&1
```

On Vercel, a `vercel.json` cron entry sends `Authorization: Bearer $CRON_SECRET`
automatically; the same endpoint also accepts an `X-Cron-Key` header.

Prove it works before you trust it — this is safe to run, the jobs are
idempotent:

```bash
curl -sS -X POST -H "Authorization: Bearer <CRON_SECRET>" \
  http://127.0.0.1:8000/api/internal/jobs/run
```

Then confirm from the staff portal (Operations panel) that the run is recorded.
A job that ran and a job that never ran look identical from the outside, which
is why the panel exists.

---

## Step 11 — Schedule backups, then prove a restore

```cron
# DIC Alumni Platform — nightly backup, 01:30 local
30 1 * * * cd /srv/dic-alumni && /usr/bin/node backup.js >> /var/log/dic-alumni-backup.log 2>&1
```

`backup.js` writes a `pg_dump` into `BACKUP_DIR` and prunes past
`BACKUP_RETENTION_DAYS`. It needs `pg_dump` on `PATH`, or `PG_DUMP` set to its
full path.

A backup nobody has restored is not a backup. Run the drill — it restores the
newest dump into a **disposable** database and drops it afterwards, and never
touches the live one:

```bash
cd /srv/dic-alumni && node restore.js --drill
```

Then verify the restored copy carries a verifiable audit chain, which is the
strongest available evidence that the dump is complete and unaltered:

```bash
cd /srv/dic-alumni && node verify_audit.js --database <drill-db-name>
```

**Copy backups off this machine.** A dump sitting on the server it was taken
from does not survive the failure it exists for. That destination is DIC's to
provide; it is an open item in the handover checklist.

---

## Step 12 — Smoke test, as a real user

Not `curl /api/health` — that only proves the process is alive. Do all of it:

1. Load `https://alumni.<domain>`. The alumni site renders.
2. Load `https://admin.alumni.<domain>` (or `/admin`). The **staff portal**
   renders — a different shell, not the alumni site with different buttons.
3. Sign in as the super admin from step 7.
4. Open the staff portal → Alumni. The directory loads.
5. Open Operations. Job state, backup state and email state all report.
6. Sign out. Confirm the session is actually dead: reloading does not restore it.
7. Open the browser console on both portals. **Zero errors.**

If step 2 shows the alumni site on the admin hostname, `Host` is not reaching
the application — go back to step 9.

---

## Step 13 — Verify the audit chain on the live database

```bash
cd /srv/dic-alumni && npm run verify-audit-chain
```

Expected: `PASS — chain verified through N entries`, exit code 0.

Entries written before the Phase 5A boundary are reported as historical and
**not** cryptographically verifiable. That is a stated, permanent property of
the pre-5A data, explained in [`AUDIT_CHAIN.md`](AUDIT_CHAIN.md) §1–2 — not a
failure and not something to fix. A fresh production database has no historical
segment at all.

---

## Step 14 — Confirm the web root is closed

The repository root is the web root, so confirm the allow-list is doing its job.
Every one of these must return **404**:

```bash
for p in /.env /.env.example /db.js /server.js /package.json /schema.sql \
         /seed.sql /admin-credentials.local.txt /.git/config /backups/; do
  printf '%-34s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://alumni.<domain>$p")"
done
```

Any `200` here is a stop-the-deployment finding. Re-run it after any change to
static file handling.

---

## Step 15 — Record what was deployed

In the deployment log or ticket, write down: the commit hash from step 1, the
date, who ran it, the two hostnames, the database name and host, where the
three secrets are stored (the password manager entry, never the values), where
backups go and where they are copied off-site to, and who holds the super-admin
account.

A deployment nobody recorded is a deployment nobody can roll back.

---

## Rollback

Decide which of two situations you are in. They have different answers, and
using the wrong one is how a bad deploy becomes lost data.

### The code is bad, the data is fine

Most rollbacks. The previous release is a commit away:

```bash
cd /srv/dic-alumni
git log --oneline -10
git checkout <previous-commit-hash>
npm ci --omit=dev
sudo systemctl restart dic-alumni
sudo journalctl -u dic-alumni -n 30 --no-pager
```

Migrations are additive — v13 adds `location_places`, `place_id` and
`location_needs_confirmation` and alters no existing value — so older code runs
against a newer schema. It ignores the columns it does not know about. **Do not
"roll back" a migration by dropping columns.** There is no down-migration, and
dropping a column destroys data the newer code wrote.

### The data is bad

Only reach for this when the database itself is wrong: a bad bulk import, a
mistaken destructive action, corruption.

**Restoring overwrites everything written since the dump was taken.** Do not run
it because a deploy went wrong. Do this first:

```bash
sudo systemctl stop dic-alumni
cd /srv/dic-alumni && node backup.js   # capture the CURRENT bad state first
```

You will want that even though it is bad — it is the only copy of whatever
happened between the last good backup and now.

Then restore into a **new** database and look at it before you switch:

```bash
cd /srv/dic-alumni
node restore.js --into dic_alumni_restore --file /var/backups/dic-alumni/<dump>
node verify_audit.js --database dic_alumni_restore
psql -d dic_alumni_restore -c "SELECT count(*) FROM users"
```

Only when that copy is verified, point `PGDATABASE` at it and restart. Keep the
damaged database — do not drop it — until someone has decided nothing in it was
needed.

### Rolling back a secret

`SESSION_SECRET` and `CRON_SECRET` can be rotated freely: rotating the first
signs everyone out, rotating the second needs the cron entry updated.

`ENCRYPTION_KEY` **cannot**. Every identity-vault record and every issued ticket
QR was written under the current key. Changing it makes them unreadable, and
changing it back is the only repair — which means the old value must never be
deleted from the password manager, even after a rotation.

---

## When it will not start

| Log line | Meaning |
|---|---|
| `Refusing to start in production: required secret(s) missing or malformed: …` | Exactly what it says, and it names them. Set them (step 6). This is correct behaviour. |
| `🐘 NOT connected to PostgreSQL: …` | The app is up, the database is not. Check `PG*`, that PostgreSQL is running, and that the role can log in. |
| `EADDRINUSE` | Something already holds `PORT`. Usually a previous instance started outside systemd. |
| Both hostnames serve the alumni site | `Host` is not reaching the app. Step 9. |
| Browser console: CORS error | `PUBLIC_ORIGIN` / `ADMIN_ORIGIN` do not match the hostnames actually in use, scheme included. |

For anything after go-live, use [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md).
