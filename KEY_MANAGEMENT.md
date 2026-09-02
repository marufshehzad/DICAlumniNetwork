# Key and Secret Management — DIC Alumni Platform

**Who this is for:** whoever at DIC is accountable for the platform's secrets,
and the engineer who sets them up. One of the four secrets below cannot be
recovered if it is lost, and losing it destroys data permanently. That is the
reason this document exists as its own file rather than a section of a runbook.

**No secret value appears anywhere in this document, and none ever should.**

---

## 1. The four secrets

| Secret | Protects | Used by | Generated with | Rotation | If lost |
|---|---|---|---|---|---|
| `SESSION_SECRET` | Signs session tokens (HMAC-SHA256) | Every authenticated request | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | **Safe.** Signs everybody out. | Recoverable — generate a new one. Everybody signs in again. |
| `ENCRYPTION_KEY` | Encrypts identity-vault records (AES-256-GCM); signs ticket QR codes | Identity vault, ticketing | same, 32 bytes ⇒ 64 hex characters | **Not safe.** See section 2. | **Not recoverable.** Every vault record becomes permanently unreadable. |
| `CRON_SECRET` | The scheduler's credential and the monitor's | `/api/internal/jobs/run`, `/api/internal/monitor` | same, 32 characters minimum | **Safe.** Update the trigger too. | Recoverable — generate a new one and update the trigger. |
| Database password | The database | The application, backups, restores | A password manager, not by hand | **Safe.** Update `.env` and restart. | Recoverable by a database administrator. |

Production **refuses to boot** without the first three. That refusal is the
feature: it names which one is missing and never prints a value.

---

## 2. `ENCRYPTION_KEY` in detail — the one that cannot be recovered

### What it does

`routes_v2.js` encrypts each identity-vault field with **AES-256-GCM**:

- a **fresh 12-byte random IV per record** (`crypto.randomBytes(12)`), so two
  records holding the same national ID number produce different ciphertext;
- the **GCM authentication tag is stored and verified on decryption**, so a
  tampered record fails to decrypt rather than returning wrong plaintext;
- stored as three columns on `identity_vault`: `ciphertext` (base64), `iv`
  (hex), `auth_tag` (hex).

Without the key the application **fails closed**: the vault refuses to store
rather than silently saving plaintext, and in production the server refuses to
start at all.

### Why it cannot be rotated in place

**`identity_vault` carries no key id and no key version column.** Every row is
encrypted under whatever the current key is, and nothing records which key that
was. There is therefore no way to run two keys side by side, which is what a
zero-downtime rotation requires.

Rotating means, unavoidably:

1. a maintenance window with the application stopped,
2. reading every vault row, decrypting with the old key, re-encrypting with the
   new one, and writing it back — in one transaction,
3. verifying every row decrypts under the new key **before** the old key is
   discarded.

No tooling exists for this. It would need to be written, tested against a
disposable database, and rehearsed before being run against production.

### Why a backup does not save you

This is the point most often misunderstood. **A database backup contains the
same ciphertext.** Restoring it gives you the encrypted records back and no way
to read them. The key is not in the database and is not in the backup — by
design, because a backup that carried its own decryption key would offer no
protection at all.

**The key must exist in two places before the first vault record is written.**
After that, the only thing standing between DIC and permanent data loss is the
escrow in section 4.

---

## 3. Where secrets live in production

Two places, both, not either:

**1. The hosting platform's environment store.** Vercel project environment
variables, or a `.env` file on the VPS with mode `0600` owned by the service
account. This is what the running application reads.

**2. The institution's password manager or sealed escrow.** This is what
survives the server. Section 4.

### Where they must never be

Each of these is checked mechanically by `tests/phase6_operations.js` section I
and `tests/security_smoke.js` section N:

| | Status |
|---|---|
| Git | `.env` and `admin-credentials.local.txt` are gitignored. No secret appears in any of the repository's markdown files — verified against the real values, not by eye. |
| Logs | No `console` line prints any of them. The request logger excludes the `Authorization` header, request bodies and query strings. A reset link never reaches a log. |
| API responses | The production boot refusal names variables, never values. `/api/internal/monitor` is asserted not to return the credential it was authenticated with. |
| The browser | No secret is served to a page. The scheduler credential is server-side only. |
| Backup filenames | Timestamps only. |

`admin-credentials.local.txt` is written **once**, by
`rotate_credentials.js`, with mode `0600`, and the instruction inside it is to
move the values into the password manager and delete the file. Treat any copy
still on disk as compromised.

---

## 4. Escrow

### The rule

**Two named people must be able to reach the recovery material, and neither may
be the person who holds only the backups.** A single holder is a single point of
failure — illness, resignation, a lost phone. A backup holder who also holds the
key means one compromise yields both.

### What is escrowed

For each of `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` and the database
password:

- the value,
- the date it was generated,
- which environment it belongs to (production / staging),
- who generated it.

`ENCRYPTION_KEY` additionally records **every previous value with the dates it
was in use**. A superseded encryption key is never destroyed: if a rotation
turns out to have been incomplete, the old key is the only way to read what was
missed.

### How it is held

Either is acceptable; DIC picks one and records it here.

**Option A — institutional password manager.** A vault entry per secret, shared
with exactly the two named people, with access logging enabled. Simplest to
operate and easiest to audit.

**Option B — sealed envelope.** Printed, sealed, signed across the seal, stored
in the institution's safe. The register records who sealed it and when. Slower,
and appropriate where an institution's policy requires an offline copy.

Whichever is chosen, the *other* copy stays in the hosting platform's
environment store. Two places, different failure modes.

### Setup checklist

- [ ] Secrets generated on the deployment machine, never reused from development
- [ ] Stored in the hosting platform's environment store
- [ ] Stored in the escrow (Option A or B), including the generation dates
- [ ] Two people named, in writing, with access to the escrow
- [ ] Neither of them is solely the backup holder
- [ ] `admin-credentials.local.txt` moved to the password manager and deleted
- [ ] The register records who may open the escrow, and what is written down
      when they do
- [ ] A calendar entry for the annual recovery drill (section 7)
- [ ] Recorded in [`PRODUCTION_HANDOVER_CHECKLIST.md`](PRODUCTION_HANDOVER_CHECKLIST.md)

### Opening the escrow

Record, at the time: who opened it, when, why, and which values were read. If a
value was read because of a suspected compromise, rotate it afterwards
(section 6) — reading is not itself an incident, but an unrecorded read is.

---

## 5. Rotation procedures

### `SESSION_SECRET` — safe

**Consequence first: everybody is signed out immediately.** Do it outside
teaching hours.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

1. Set the new value in the environment store.
2. Restart (VPS) or redeploy (Vercel).
3. Confirm you can sign in.
4. Update the escrow with the new value and today's date.

### `CRON_SECRET` — safe, but update the trigger too

**Consequence: until the trigger is updated, the nightly jobs stop running.**
That includes the deletion purge.

1. Generate and set the new value in the environment store.
2. Restart or redeploy.
3. **Update the trigger:**
   - **Vercel** — the cron sends the project's `CRON_SECRET` automatically, so
     changing the environment variable is enough. Redeploy.
   - **VPS** — update `CRON_SECRET` wherever `ops/cron-dic.sh` reads it.
4. Verify:
   ```bash
   node scheduler.js --list           # VPS
   curl -s -w ' [%{http_code}]\n' -H "X-Cron-Key: $CRON_SECRET" \
     https://alumni.<domain>/api/internal/monitor
   ```
   Expect 200 or 503 — not 401. A 401 means the credential is wrong.
5. Update the escrow.

### Database password — safe

1. Change it in PostgreSQL.
2. Update `PGPASSWORD` (or `DATABASE_URL`) in the environment store.
3. Restart. Confirm the startup banner names the database.
4. Check the next backup succeeds — `backup.js` uses the same credential.
5. Update the escrow.

### `ENCRYPTION_KEY` — **not safe, and there is no procedure**

There is no supported rotation. What it would require, if DIC ever needs it:

1. A maintenance window with the application stopped.
2. A verified backup taken immediately before.
3. A migration script — **which does not exist and would have to be written** —
   that reads every `identity_vault` row, decrypts with the old key, re-encrypts
   with the new, and writes back in one transaction.
4. A verification pass confirming every row decrypts under the new key.
5. Only then, the new key into the environment store; the old key kept in escrow
   for ever.
6. Ticket QR codes signed with the old key stop verifying. Any event with
   outstanding tickets needs them reissued.

**Do not attempt this without rehearsing it against a disposable database
first.** If the re-encryption is interrupted part-way, some rows are readable
under the old key and some under the new, and nothing records which is which.

---

## 6. If a secret is exposed

In priority order. Assume exposure the moment a secret appears in a chat
message, a screenshot, a ticket, a shared document or a log.

### `ENCRYPTION_KEY` exposed — the worst case

**Blast radius:** anyone holding both the key and a database backup can decrypt
every national ID and birth-registration record the platform holds.

1. **Do not rotate first.** Rotating without the migration in section 5 destroys
   the data.
2. Secure the backups: whoever has the key can only use it with a copy of the
   data. Review who can reach `BACKUP_DIR` and the off-site destination.
3. Escalate to DIC's data-protection owner immediately. This is a reportable
   personal-data exposure, and that judgement is DIC's, not the operator's.
4. Plan the rotation properly, with a maintenance window.
5. Record it in the incident log.

### `SESSION_SECRET` exposed

**Blast radius:** anyone holding it can forge a session token for any user,
including a super admin, without a password.

1. Rotate it **now** (section 5). This invalidates every forged token along with
   every real one.
2. Review the audit log for the exposure window:
   ```sql
   SELECT * FROM audit_logs WHERE created_at > '<when>' ORDER BY id;
   ```
3. Suspend any account that behaved oddly (`OPERATIONS_RUNBOOK.md` section L).

### `CRON_SECRET` exposed

**Blast radius:** anyone holding it can trigger the scheduled jobs — including
the deletion purge — and read `/api/internal/monitor`. The jobs are idempotent
and only act on records already past their deadline, so the practical damage is
limited, but the purge is irreversible for anything genuinely due.

1. Rotate it and update the trigger (section 5).
2. Check `ops_runs` for runs you did not expect:
   ```sql
   SELECT * FROM ops_runs ORDER BY started_at DESC LIMIT 50;
   ```

### Database password exposed

**Blast radius:** everything, including the ability to rewrite the audit chain —
which is unkeyed and therefore recomputable by anyone with write access.

1. Rotate it (section 5).
2. Restrict network access to the database if it is reachable beyond the
   application host.
3. `npm run verify-audit-chain` and record the result. Note that a clean result
   does **not** prove the log was untouched, for the reason above.

---

## 7. Recovery drill

Run once before go-live, and once a year after. It answers one question: **if
the server disappeared tonight, could DIC bring the platform back?**

1. **Retrieve the escrowed material.** Time it. If it takes more than an hour to
   find, the escrow is not usable in an incident.
2. **Verify it matches production without printing it.** Compare fingerprints,
   not values:
   ```bash
   # On the server, and from the escrowed copy. Compare the two short hashes.
   node -e "console.log(require('crypto').createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('hex').slice(0,16))"
   ```
   Equal fingerprints mean the escrow is current. Unequal means the escrow is
   stale, which is the same as having none.
3. **Verify a backup restores**, using the escrowed database password:
   ```bash
   node restore.js --drill
   node tests/ops_drill.js
   ```
4. **Verify the vault decrypts** against the restored copy, with the escrowed
   `ENCRYPTION_KEY`. This is the only check that proves the key and the data
   still belong together.
5. **Record that the drill happened**, who ran it, how long each step took, and
   anything that did not work.

A drill that finds nothing wrong is still worth the hour. A drill nobody has run
is a plan, not a capability.
