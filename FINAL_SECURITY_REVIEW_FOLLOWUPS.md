# Deferred Items — Security Review Follow-Ups

**DIC Alumni Platform · post-Phase 5F · 2 September 2026**

Phase 5F fixed security vulnerabilities, correctness bugs, production blockers and
security-review prerequisites. Everything it deliberately did not fix is recorded here, so that
each one is a decision on the record rather than an omission a reviewer has to discover.

Every item below was re-read in the source before it was written up. Where a claim carried into
this phase turned out not to match the code, that is stated plainly rather than repeated —
see **INFO-3**, which is a refutation, not a finding.

## How to read this list

| Severity | Meaning here |
|---|---|
| **P2** | Affects availability, data integrity, or a recovery capability the institution would need in an incident. Should be scheduled, not carried indefinitely. |
| **P3** | Hardening, defence in depth, or a usability/robustness gap with a security dimension. |
| **INFO** | Recorded for accuracy. No action strictly required. |
| **(accepted)** | A deliberate design decision, already documented. Listed so a reviewer sees the limitation and the reasoning together, not so it can be re-litigated. |

A reader should not treat "deferred" as "harmless". Three of the P2 items below (**P2-1**,
**P2-2**, **P2-4**) are live defects in code that is running, not future risks.

---

## Summary

| ID | Item | Severity | Suggested phase |
|---|---|---|---|
| ~~P2-1~~ | ~~`batch INT NOT NULL` breaks self-registration and fails whole bulk imports~~ | **CLOSED in 5F** | — |
| P2-2 | `scryptSync` blocks the event loop on two unauthenticated, unthrottled routes | P2 | 6A |
| P2-3 | `restore.js` ignores `DATABASE_URL` — no working restore on a cloud deployment | P2 | 6A |
| ~~P2-4~~ | ~~`TRUST_PROXY` is undocumented~~ | **CLOSED in 5F** | — |
| P2-5 | Backups are unencrypted at rest and hold all plaintext PII | P2 | 6B |
| P2-6 | Audit chain is unkeyed SHA-256, append-only by convention | P2 (accepted) | 6B |
| P3-1 | No Subresource Integrity on three jsDelivr scripts | P3 | 6A |
| P3-2 | `identity_vault` has no key id — `ENCRYPTION_KEY` cannot be rotated live | P3 (accepted) | 6B |
| P3-3 | No administrator unlock path for a locked **alumnus** (staff can be unlocked by a super admin) | P3 | 6A |
| P3-4 | Bulk import: 10-digit mobile suffix matching, and the preview hides updates | P3 | 6B |
| P3-5 | CSP is `frame-ancestors` only — no `script-src` (the alumni portal now has a CSP; see the note below) | P3 | 6C |
| P3-6 | `dept_admin` is institution-wide; there is no department scoping | P3 (accepted) | 6C |
| P3-7 | Role- and broadcast-targeted notifications are shared rows | P3 | 6B |
| INFO-1 | `test_e2e_crud.js` still present although recorded as REMOVED | INFO | 6A |
| INFO-2 | Payments are absent by design; priced tickets refuse with 409 | INFO (accepted) | — |
| INFO-3 | `PUT /api/notifications/:id/read` — carried-forward claim, refuted | INFO | — |

## Corrections applied after this document was drafted

This list was written while Phase 5F was still in progress, and four of its
entries were acted on rather than deferred. They are struck through above and
recorded here so the two documents cannot disagree.

**P2-1 — CLOSED.** The claim was verified by reading the code but not by running
it, and the document said so. It was then executed: `POST /api/auth/register`
returned **500** for an absent, blank or non-numeric `hscPassingYear`, three
ways out of three, because `alumni_profiles.batch` and `.passing_year` are both
`NOT NULL` and the handler passed `parseInt(undefined) || null` into them. The
sign-up form did not mark the field required either. Now:

- the handler validates the year and returns **400** with a usable message
  (verified: absent, blank, `'abcd'` and `1800` all give 400; a real year gives
  200), and the field is `required` in `index.html`;
- bulk import rejects **that row** rather than aborting the transaction —
  verified with a three-row roster: 2 created, 1 rejected by row number with the
  reason, HTTP 200. `hscPassingYear` was also removed from `OPTIONAL_FIELDS`,
  where it should never have been: it *is* the batch.

The year is validated, never defaulted. A guessed batch would be the same class
of fabrication as the hardcoded `'Dhaka'` that Phase 5B removed.

**P2-4 — CLOSED.** `TRUST_PROXY` was introduced by Phase 5F itself, so leaving
it undocumented was that phase's own debt rather than a deferral. It is now in
`.env.example` and in step 9 of `PRODUCTION_DEPLOYMENT_RUNBOOK.md`, with the
failure mode stated in **both** directions — set with no proxy in front, the
header is the caller's to choose; left unset behind one, every request looks
like the proxy and a handful of failed sign-ins locks out everybody.

**P3-5 — REDUCED.** The observation that the alumni portal received *no*
`Content-Security-Policy` header at all was correct, and that is the portal every
stored-XSS finding in this phase was reachable from. It now sends
`frame-ancestors 'self'` alongside its existing `X-Frame-Options: SAMEORIGIN`.
The substance of the item stands: there is still no `script-src` directive, and
there cannot be one until the inline event-handler attributes are replaced with
delegated listeners. That is the real work, and it is still deferred.

**P3-3 — REDUCED, not closed.** A super admin can unlock a member of staff via
`POST /api/admin/administrators/:id/reset-password`, which clears
`failed_login_count` and `locked_until` — but that route matches on
`role = ANY(STAFF_ROLES)`, so it cannot reach an ordinary alumnus. What changed
in Phase 5F is that the lock now lapses on its own: the failure counter restarts
once a lapsed lock is seen, so a locked-out member waits fifteen minutes instead
of being held out indefinitely. The missing unlock path is now an inconvenience
rather than a denial of service.

---

# P2

## P2-1 · `alumni_profiles.batch` is `NOT NULL` but HSC passing year is optional

**FINDING.** `schema.sql:35-36` declares:

```sql
batch INT NOT NULL,
passing_year INT NOT NULL,
```

No later migration relaxes either constraint. `schema_v3.sql:44` drops `NOT NULL` from
`student_id` and nothing else. Both columns are still mandatory.

Two call sites insert `NULL` into them.

**Call site A — public self-registration.** `server.js:815` computes
`const year = parseInt(hscPassingYear) || null;` and `server.js:836-839` inserts that value into
`batch` and `passing_year` (parameter `$3` is used twice). The signup form does not require the
field: `index.html:138` is

```html
<input type="number" id="signup-hsc-year" class="form-input" inputmode="numeric"
       min="1960" max="2100" placeholder="e.g. 2015" />
```

— no `required` attribute, unlike name, email and password on the same form. An applicant who
leaves HSC Passing Year blank sends `''`, which becomes `null`, which violates the constraint.
The handler's `catch` rolls back and calls `serverError`, so the applicant receives a generic
500 and no account. **Public sign-up fails for anyone who skips an optional field.**

**Call site B — bulk import.** `server.js:2017` computes the same `year`, and `server.js:2110-2125`
inserts it into `batch` and `passing_year`. The entire import runs inside one
`BEGIN`/`COMMIT` (`server.js:1951`, `server.js:2138`), and the `catch` at `server.js:2166` issues a
single `ROLLBACK`. One row with no passing year therefore discards the whole batch and returns a
500, instead of rejecting that row and importing the rest — which is precisely what the
import's own stated policy says should happen (`server.js:1977-1980`: *"Maximum retention: only
reject when the row cannot be saved at all"*). The row-level rejection path exists and is used for
a missing name and an unrecoverable email; passing year is not on that list because the constraint
was not accounted for.

**Verification status.** Established by reading the schema, both handlers and the form. It was not
executed against a live database in this phase, so the failure is derived, not observed. The
derivation has no branches in it: the column is `NOT NULL`, the value is `null`, the insert is
inside the transaction.

**SEVERITY.** P2. Call site A is a public-route correctness failure on the platform's own
onboarding path. Call site B destroys an administrator's work with no partial result.

**RATIONALE FOR DEFERRAL.** Found while verifying the bulk-import half of this item, late in 5F,
and the fix is a schema change (`ALTER TABLE alumni_profiles ALTER COLUMN batch DROP NOT NULL`,
same for `passing_year`) plus a decision about what an alumnus with no recorded HSC year should
look like in the directory, which filters and groups by batch. Dropping a `NOT NULL` on a column
the directory sorts on is not a change to make without a migration, a data pass over existing
rows, and its own test. The alternative — making the field mandatory on both paths — is a product
decision for DIC, not one to take unilaterally: some genuine alumni will not know the year.

**SUGGESTED PHASE.** 6A. This should be the first item taken, and it needs DIC to answer one
question: is HSC passing year mandatory, or is a profile without one valid?

---

## P2-2 · `scryptSync` blocks the event loop on two unauthenticated, unthrottled routes

**FINDING.** Password hashing is synchronous. `server.js:250` and `server.js:267`:

```js
const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
```

Measured on the development machine: **30.9 ms per call**, averaged over 20 iterations at the
default parameters (N=16384, r=8, p=1). Node runs one event loop; `scryptSync` occupies it
entirely for that time. Nothing else — no other request, no query callback, no timer — progresses.

`loginRateCheck` is defined at `server.js:613` and called from exactly two places, `server.js:664`
(login) and `server.js:953` (forgot-password). Neither of the two routes that call `hashPassword`
on unauthenticated input is among them:

| Route | Rate-limited | Hashes before deciding anything |
|---|---|---|
| `POST /api/auth/login` | yes | no — verifies against a stored hash |
| `POST /api/auth/forgot-password` | yes | no |
| `POST /api/auth/register` (`server.js:793`) | **no** | one duplicate-check query first, then hashes |
| `POST /api/auth/reset-password` (`server.js:1003`) | **no** | **hashes unconditionally** |

At roughly 33 hashes per second the process has no idle event loop left. An unauthenticated
caller can hold the entire platform — both portals, every API route, the scheduler endpoint —
by posting to either route in a loop. No credential is needed and nothing is stored, so it leaves
almost no trace beyond request logs.

**The cheaper half was also not done.** In `reset-password`, `hashPassword(newPassword)` is passed
as an *argument* to `db.query` (`server.js:1029`):

```js
      [hashPassword(newPassword), hashResetToken(String(token))]);
```

JavaScript evaluates arguments before the call, so scrypt runs **before** the statement that
checks whether the reset token is valid, unexpired and belongs to an active account. A caller
with a garbage token — the overwhelmingly common case for an attacker, since tokens are 30-minute
single-use values — still pays the platform 31 ms. Reordering so the token is looked up first
would make invalid tokens nearly free. That reordering was not done either, and belongs with the
same change.

**SEVERITY.** P2. Unauthenticated denial of service against the whole platform, no precondition.

**RATIONALE FOR DEFERRAL.** The correct fix is to convert both helpers to the asynchronous
`crypto.scrypt` and await them, which changes `hashPassword`/`verifyPassword` from synchronous to
promise-returning. Every call site — registration, login, change-password, reset-password, bulk
import, `rotate_credentials.js` — has to change with them, and `verifyPassword` sits on the
sign-in path where a mistake is a silent authentication failure or, worse, a silent
authentication *success*. That is not a change to make in the closing hours of a hardening phase
with no time for its own test pass. Adding `loginRateCheck` to the two routes is a smaller
mitigation but not a fix — a throttle bounds one caller, not the aggregate — and adding a throttle
to `register` needs thought about legitimate registration bursts around a reunion announcement.

**SUGGESTED PHASE.** 6A, as one change: async KDF, the reset-password reordering, `loginRateCheck`
on both routes, and a test that asserts the event loop stays responsive under concurrent
registration.

---

## P2-3 · `restore.js` ignores `DATABASE_URL`, so there is no working restore on a cloud deployment

**FINDING.** `db.js:49` establishes how the application connects:

```js
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
```

`backup.js` honours that. `backup.js:41` reads `url: process.env.DATABASE_URL ||
process.env.POSTGRES_URL || ''`, and `backup.js:58` passes it straight to `pg_dump`:

```js
  if (PG.url) return { cmd: 'pg_dump', args: [...common, PG.url], env: {} };
```

`restore.js` does not. It contains **no reference to `DATABASE_URL` or `POSTGRES_URL` anywhere**.
It `require`s `./db` at line 27 — which loads the pool and therefore reads the connection string —
and then ignores it, building its own connection from discrete variables at `restore.js:34-38`:

```js
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || '5432',
  database: process.env.PGDATABASE || 'dic_alumni_db',
  user: process.env.PGUSER || 'postgres',
```

Those defaults are assembled into every `psql` invocation at `restore.js:61-64`.

On a managed deployment configured the way the application itself is configured — a single
`DATABASE_URL`, with `PGHOST`/`PGUSER`/`PGDATABASE` unset — `restore.js` connects to
`localhost:5432/dic_alumni_db` as `postgres`. That is not the production database. In the best
case `psql` cannot reach anything and the operator sees a connection error. The failure mode that
matters is the other one: on a host that happens to run a local Postgres, `--drill` will
`CREATE DATABASE`, load the dump into it, find the eleven tables listed in `restore.js:42-44`, and
**report a successful restore drill of a database that is not production**.

So the platform takes backups it has never demonstrated it can restore, while a green drill result
says otherwise. `npm run restore-drill` is in `package.json` and referenced in the operations
documentation, which makes the false assurance worse, not better.

**SEVERITY.** P2. The restore path is the one control that makes every other data-loss risk
survivable, and on the intended deployment topology it does not work. A drill that passes against
the wrong database is worse than no drill.

**RATIONALE FOR DEFERRAL.** The fix itself is small — mirror `backup.js`'s `PG.url` branch into
`restore.js`'s `psql()` helper. What cannot be done at a desk is the part that gives the fix its
value: proving a restore against a real managed instance, with the `--drill` path creating and
dropping a disposable database on a provider that may not permit `CREATE DATABASE` from the
application role at all. A restore script that has not been run against the real target is
the same untested assurance in a new form. This needs a scheduled window and a provider account,
not a code change.

**SUGGESTED PHASE.** 6A for the code, with an operator-witnessed drill against the actual
production provider as the acceptance criterion. Until that drill passes, the runbook should say
plainly that restore is unverified on cloud.

---

## P2-4 · `TRUST_PROXY` is documented nowhere, and the safe default self-throttles behind a proxy

**FINDING.** *(Found during this review; not on the list carried into it.)*

Phase 5F correctly replaced the hardcoded `app.set('trust proxy', 1)` with a declared value
(`server.js:44-50`), defaulting to `false` when the variable is unset. That default is right: a
numeric trust-proxy value is a hop *count*, not an allow-list, so trusting a hop that is not there
hands `X-Forwarded-For` to the caller.

The variable is not documented. It appears in `.env.example` **zero** times, and in none of
`README.md`, `PRODUCTION_DEPLOYMENT_RUNBOOK.md`, `PRODUCTION_HANDOVER_CHECKLIST.md` or
`OPERATIONS_RUNBOOK.md`. The only explanation of it is the comment above the code.

The consequence is symmetrical and both halves are bad:

- An operator who deploys behind a load balancer or Vercel's edge and does not know to set it gets
  `req.ip` = the proxy's address for **every** request. Both throttles in `loginRateCheck` that key
  on IP then treat the entire internet as one client. A handful of failed logins from anywhere
  locks sign-in for everybody, and the audit entries record the proxy's address for every event.
- An operator who over-sets it re-opens exactly the forgery that Phase 5F measured and closed.

The production config gate refuses to boot without `SESSION_SECRET`, `ENCRYPTION_KEY`,
`CRON_SECRET`, `MAIL_TRANSPORT`, `PUBLIC_ORIGIN` and `ADMIN_ORIGIN`. `TRUST_PROXY` is not on that
list, and unlike those six it has no safe universal value — it depends on the topology, which is
the argument for making the operator state it rather than for leaving it silent.

**SEVERITY.** P2. A correct security control that the person deploying it cannot discover is a
control with a coin-flip outcome.

**RATIONALE FOR DEFERRAL.** Documentation and deployment-gate changes were frozen once the
handover documents were finalised in Phase 5E; adding a seventh mandatory variable to the boot
gate after those documents were signed off would make them wrong in a different way. This wants
to be done as one edit across `.env.example`, the deployment runbook and the handover checklist,
with the topology question stated explicitly ("how many proxies are in front of this?").

**SUGGESTED PHASE.** 6A. Add `TRUST_PROXY` to `.env.example` with the hop-count explanation and
both failure modes; add it to the handover checklist as a question the operator must answer;
consider promoting it to the boot gate.

---

## P2-5 · Backups are unencrypted at rest and contain all plaintext PII

**FINDING.** `backup.js` runs `pg_dump` and writes the result into `BACKUP_DIR`
(`backup.js:28`, default `./backups`), with `BACKUP_RETENTION_DAYS` defaulting to 14
(`backup.js:29`). There is no encryption step anywhere in the file — no `gpg`, no `cipher`, no
key handling. The dump is compressed and written, and nothing else.

`.gitignore` excludes `backups/` and `*.sql.gz`, and the deployment runbook requires `BACKUP_DIR`
to be outside the web root. Both are correct and both are about *placement*. Neither is
encryption.

The dump contains every column of every table: full names, email addresses, mobile and WhatsApp
numbers, present and permanent addresses, postal codes, hometowns, dates of birth, blood groups,
employment history, and the `SELF_ONLY_FIELDS` that the API refuses to disclose even to staff. It
also contains `identity_vault` — those rows stay encrypted under `ENCRYPTION_KEY`, so the vault
ciphertext is the one part of the dump that is protected, and only for as long as the key is not
in the same backup location.

The practical shape of the risk: fourteen days of complete unprotected alumni PII sitting on
whatever filesystem or object store the operator points `BACKUP_DIR` at, protected by that
store's access control alone. Anyone who can read that directory has the whole institution's
records, and no audit entry is written because reading a file is not an application event.

**SEVERITY.** P2. The backup is the largest single concentration of personal data the platform
produces, and it is the copy with the fewest controls on it.

**RATIONALE FOR DEFERRAL.** Encrypting the dump is straightforward. Managing the key is not, and
doing it badly is worse than not doing it: a backup encrypted under a key stored next to the
backup buys nothing, and a backup encrypted under a key nobody can find during an incident is a
lost backup. The decision that has to come first is DIC's — where the backup key lives, who holds
it, how a restore under pressure gets it, and whether the retention copy goes off-host at all.
Choosing that unilaterally at the end of a hardening phase would embed a key-custody model the
institution never agreed to.

**SUGGESTED PHASE.** 6B, opened with DIC's answer on key custody. In the meantime the runbook
should state, as an operational requirement, that `BACKUP_DIR` must be on encrypted storage with
access restricted to the operator account.

---

## P2-6 · The audit chain is unkeyed SHA-256, append-only by application convention *(accepted)*

**FINDING.** `audit_chain.js:99` is the whole of the chain's integrity:

```js
  return crypto.createHash('sha256').update(canonicalPayload(entry), 'utf8').digest('hex');
```

`createHash`, not `createHmac`. No key is involved. Each entry's hash covers the previous entry's
hash, so the chain links, but every input to the computation is present in the row itself.

**This is the most important honesty point in the package, and it must not be softened.** An
unkeyed hash chain is not tamper-proof and must never be described as such. Anyone with `UPDATE`
or `INSERT` privilege on `audit_logs` can alter or delete an entry and recompute every subsequent
hash from the altered data. `verify_audit.js` will then confirm the rewritten chain as intact,
because it is intact — it is a valid chain over false data. The chain does not detect a
knowledgeable adversary with database write access; it detects accidental corruption, a partial
write, and an unsophisticated edit made without recomputing the tail.

Append-only is likewise a convention, not a constraint. `schema.sql:231-239` defines `audit_logs`
as an ordinary table. Grepping every `schema*.sql` for `TRIGGER`, `GRANT` and `REVOKE` returns
**nothing**. There is no `BEFORE UPDATE OR DELETE` trigger, and the application role's privileges
are never narrowed. The application only ever inserts; the database does not require that.

**What each available strengthening would actually change:**

| Change | What it stops | What it does not stop |
|---|---|---|
| `createHmac` under a key held outside the database | An attacker with database write access can no longer forge a chain that verifies — recomputation needs the key. | An attacker who also reaches the key, or who has the application process. Verification now depends on the key surviving; lose it and the whole history becomes unverifiable. |
| `BEFORE UPDATE OR DELETE` trigger raising an exception on `audit_logs` | Modification and deletion through ordinary SQL, including an application bug or a mistaken operator. | A superuser, who can drop the trigger. It raises the bar and creates a distinct, noisy step. |
| `REVOKE UPDATE, DELETE ON audit_logs` from the application role | The application — or anything using its credentials, which is the realistic compromise — from editing history at all. | The owning/superuser role. |

**What the unkeyed chain still buys.** It is not nothing. Sequence is fixed, so an entry cannot be
quietly reordered or dropped from the middle without recomputing everything after it. Partial
corruption, a truncated restore and a botched migration are all caught. Casual editing —
the realistic insider action, a `DELETE` on one embarrassing row — is caught immediately.
`npm run verify-audit-chain` currently passes 2,832 entries with exit 0. Two historical segments
(chain v0, 773 entries; chain v1, 101 entries) are permanently unverifiable and are documented as
such in `AUDIT_CHAIN.md`; `verify_audit.js` verifies the current segment only.

**SEVERITY.** P2 (accepted). Recorded as a known limitation of a documented design, not as an
open vulnerability. The reviewer should judge whether the limitation is acceptable for this
institution's threat model — it may well be — but should judge it knowing exactly what the
control does and does not do.

**RATIONALE FOR DEFERRAL.** Accepted design, recorded in `AUDIT_CHAIN.md`. Moving to HMAC is not
a drop-in: existing entries were computed unkeyed, so either the chain is re-based (which
destroys the property the chain exists to provide) or the verifier learns to switch algorithm at a
boundary — a third permanently-special segment on top of the two already there. It also introduces
a second long-lived secret with the same custody problem as **P2-5** and a harsher failure mode:
lose the audit key and the entire history is unverifiable forever.

**SUGGESTED PHASE.** 6B, and the cheap half should be taken first regardless of the HMAC decision:
the `BEFORE UPDATE OR DELETE` trigger and the `REVOKE` are a migration and a grant. They do not
touch the hash, cannot invalidate existing entries, and close the "convention only" gap on their
own.

---

# P3

## P3-1 · No Subresource Integrity on three jsDelivr scripts

**FINDING.** Both portals load third-party JavaScript from `cdn.jsdelivr.net` with no `integrity`
attribute and no `crossorigin` attribute. The exact tags:

**`index.html`**
```html
30:  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" defer></script>
31:  <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js" defer></script>
908: <script src="https://cdn.jsdelivr.net/npm/lucide@0.474.0/dist/umd/lucide.js"></script>
```

**`admin.html`**
```html
31:  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" defer></script>
32:  <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js" defer></script>
715: <script src="https://cdn.jsdelivr.net/npm/lucide@0.474.0/dist/umd/lucide.js"></script>
```

Six tags, three distinct packages, identical in both portals:

| Package | Version | Purpose |
|---|---|---|
| `chart.js` | 4.4.0 | dashboard charts |
| `qrcodejs` | 1.0.0 | event ticket QR codes |
| `lucide` | 0.474.0 | icon set |

**`lucide` is a third external script that earlier inventories did not record.** The Phase 5C
inventory in `DIC_ALUMNI_SYSTEM_MASTER_AUDIT_AND_ROADMAP.md:163` lists the CDN dependency as
`qrcodejs@1.0.0` alone. A reviewer working from that line would be missing two of the three. This
list is the accurate one.

All three versions are pinned, which prevents a version bump from silently changing behaviour but
does nothing about the delivered bytes: jsDelivr serves whatever it serves for that path. Without
`integrity`, a compromise or misdirection of that host executes attacker-controlled JavaScript in
both portals — including the staff portal, in a `super_admin` session, on the same origin as the
bearer token in `localStorage`. That is the same capability as the stored-XSS findings Phase 5F
proved and fixed (P0-1, P0-2), reached through a different door.

`lucide` is loaded **without `defer`**, so it is render-blocking and executes before the
application's own scripts — the earliest possible point in page lifecycle for injected code.

**RECOMMENDATION: vendor the three libraries into the repository rather than adding integrity
hashes.** SRI is the smaller edit, but vendoring is the better answer here specifically:

- The platform has **no other external runtime dependency at all**. Five npm packages
  (`express`, `body-parser`, `cors`, `pg`, `nodemailer`), no bundler, no build step, no analytics,
  no fonts, no telemetry. These six tags are the entire third-party attack surface and the entire
  external availability dependency. Removing them makes the deployed artifact genuinely
  self-contained — a property worth more than a hash, and one a reviewer can confirm by reading
  `grep -r "https://" index.html admin.html` and getting nothing back.
- SRI fails **closed**: if jsDelivr is unreachable or the bytes shift, the script does not load and
  the feature silently disappears — QR codes stop rendering at an event gate, charts vanish from
  the dashboard. Vendored files cannot be unreachable while the application itself is reachable.
- Vendored files are diffable, reviewable and version-controlled. An SRI hash tells you the bytes
  did not change; it never tells you what the bytes do.
- There is no build step to complicate. Three files into `assets/vendor/`, three `src` attributes
  changed, done — with the licence files alongside them.

**SEVERITY.** P3. Real hardening gap, correctly categorised as hardening rather than an
exploitable defect: exploiting it requires compromising a major public CDN.

**RATIONALE FOR DEFERRAL.** Not a vulnerability in this codebase, and swapping the delivery path
for three libraries at the end of a hardening phase means re-testing every chart, every icon and
the event check-in QR flow in both portals — verification work with no time budgeted for it.
Deferred as hardening, on the explicit understanding that it is a genuine gap and not excused.

**SUGGESTED PHASE.** 6A. Small, self-contained, and it removes the platform's last external
runtime dependency.

---

## P3-2 · `identity_vault` has no key id, so `ENCRYPTION_KEY` has no live rotation path *(accepted)*

**FINDING.** `schema_v2.sql:237-247`:

```sql
CREATE TABLE IF NOT EXISTS identity_vault (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    field_type VARCHAR(20) NOT NULL CHECK (field_type IN ('nid', 'brc', 'passport')),
    ciphertext TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    last_four VARCHAR(8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, field_type)
);
```

Everything AES-256-GCM needs per row is there — ciphertext, IV, auth tag — except any indication
of **which key** encrypted it. There is no `key_id` and no `key_version` column, so the schema can
express exactly one key at a time.

The cryptography itself is sound: AES-256-GCM under `ENCRYPTION_KEY` (64 hex), fails closed with
no key, and every decrypt is audited to `vault_access_logs` (`schema_v2.sql:250-256`).

The consequence is operational and absolute. Rotating `ENCRYPTION_KEY` means every row must be
decrypted under the old key and re-encrypted under the new one in a single pass, with the
application stopped. There is no dual-key window and no gradual migration, because a row cannot
say which key it belongs to. If the pass fails partway, the table holds rows under two keys with
no way to tell them apart, and the application — which knows one key — cannot decrypt half of it.

That means: no zero-downtime rotation, no routine scheduled rotation, and an emergency rotation
after a suspected key exposure requires planned downtime at exactly the moment nobody wants to
schedule downtime.

**SEVERITY.** P3 (accepted). An operational constraint on a correct implementation, not a flaw in
the encryption.

**RATIONALE FOR DEFERRAL.** Fixing it is a schema change (`ALTER TABLE identity_vault ADD COLUMN
key_id`), a backfill of every existing row to key id 1, and a change to both the encrypt and
decrypt paths to record and honour it — after which a real rotation utility becomes possible.
That is a migration plus a data pass plus new code on the most sensitive read path on the
platform, and it needs its own test pass and a rehearsed rotation drill. Adding the column
without the rotation tooling would only look like progress.

**SUGGESTED PHASE.** 6B, together with the backup-key custody decision in **P2-5** — both are the
same question about who holds the institution's keys and how they are changed. Until then, the
runbook must state that changing `ENCRYPTION_KEY` requires downtime and a full re-encryption pass,
and that a partial pass is unrecoverable without the old key.

---

## P3-3 · No administrator unlock path for a locked account

**FINDING.** Phase 5F fixed the durable lock's ordering bug (P2-5 in that phase): the lock is now
checked before the password comparison, answers identically to an unknown address, and the counter
restarts once a lapsed lock is seen, so windows cannot be chained. The lock now works.

What still does not exist is a way for staff to clear one on request. Every path that clears
`locked_until` is tied to a password change:

| Location | Route | Clears the lock as a side effect of |
|---|---|---|
| `server.js:769` | successful sign-in | the correct password being entered |
| `server.js:1021` | `POST /api/auth/reset-password` | the holder completing an emailed reset |
| `routes_admin_users.js:261` | `POST /api/admin/administrators/:id/reset-password` | a `SUPER_ONLY` reset — **staff accounts only** |

The third is the only staff-initiated path, and `routes_admin_users.js:249-250` restricts it to
rows whose `role = ANY(STAFF_ROLES)`. An **alumni** account cannot be unlocked by anyone. There is
no route that clears `locked_until` and `failed_login_count` on their own, for any role.

So a locked-out alumnus has one recovery route: complete an email password reset. That is usually
fine and usually enough. It is not enough when the reason they are calling the office is that they
no longer control the address on file, or never received the mail, or the mail transport is the
thing that is broken. In those cases the account is unreachable by design and the office has no
answer, while `routes_admin_users.js:57` and `:71` cheerfully surface `lockedUntil` and
`failedLoginCount` in the administrator view — so staff can see the lock and cannot do anything
about it.

**SEVERITY.** P3. A support and availability gap, not a security hole. The absence is
fail-secure; it just has no release valve.

**RATIONALE FOR DEFERRAL.** This is a new privileged route, and a new privileged route is exactly
what a security review should not be handed unannounced at the end of a phase. It needs its
guard decided (`ADMIN_ROLES`, or `MODERATOR_ROLES` for the help desk?), its audit entry, its
rate-limit interaction, and a check that it cannot become a way to strip the protection off an
account under active attack. It also needs DIC's answer on who in the institution is trusted to
clear a lock, which is a policy question and not one to guess at.

**SUGGESTED PHASE.** 6A. Small, but it needs the role decision from DIC before it is written.

---

## P3-4 · Bulk import: 10-digit mobile suffix matching, and the preview does not flag updates

Two related weaknesses in the same feature. Neither is a security defect; both affect the accuracy
of a bulk operation on personal data.

**FINDING (a) — duplicate matching on a 10-digit mobile suffix.** Client and server agree on the
key, and both truncate. `js/admin.js:1470`:

```js
    const mobileKey = (rec.mobile || '').replace(/\D/g, '').slice(-10);
```

`server.js:1912-1918`:

```js
function normalizeMobile(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Bangladeshi numbers: keep the last 10 significant digits as the match key.
  return digits.slice(-10);
}
```

and `server.js:2010` matches with `RIGHT(REGEXP_REPLACE(COALESCE(ap.mobile_number,''), '\D', '',
'g'), 10) = $2`.

For a well-formed Bangladeshi mobile the truncation is deliberate and correct: `+8801712345678`
and `01712345678` both reduce to `1712345678`, which is the point. The problem is what happens to
input that is not a well-formed mobile. `slice(-10)` and `RIGHT(..., 10)` return the *whole
string* when it is shorter than ten digits, so a six-digit extension, a truncated cell, or a
landline entered in the mobile column becomes a match key in its own right — and two unrelated
alumni who both have `123456` in that column are treated as the same person.

The consequence depends on the strategy the administrator picked. Under `skip`
(`server.js:2065`) the second person is silently not imported. Under `update` or `merge`
(`server.js:2074-2094`) their data is `COALESCE`d **onto the first person's profile** — one
alumnus's employer, address and blood group written into another's record, with no warning, inside
a committed transaction. The `COALESCE` pattern means it cannot be undone by re-importing, because
the overwritten values are no longer blank.

**FINDING (b) — the preview does not flag rows that will update an existing profile.** The
client-side validation pass (`js/admin.js:1434-1490`) builds `seenEmail` and `seenMobile` from
**the rows in the file only**. It never asks the server what already exists. Its `duplicates`
bucket, surfaced as "Duplicates Found" in the wizard (`js/admin.js:690`, `:697`), means
*"appeared twice in this spreadsheet"* — nothing more. `js/admin.js:1474` says so:

```js
      duplicates.push({ ...rec, errorMsg: 'Same person as an earlier row (merged, not discarded)' });
```

The check against existing accounts happens only on the server, per row, at import time
(`server.js:2006-2013`). So a file of 400 rows in which 150 match existing alumni previews as
**400 valid, 0 duplicates**. The administrator then chooses a duplicate strategy — and under
`update`, which `js/admin.js:464` sets as the default state, presses the button on what the screen
described as 400 clean new records and in fact performs 150 profile overwrites. The count of
updates is only visible afterwards, in the result summary (`js/admin.js:798`).

The two combine badly: (b) means the administrator cannot see which rows will be treated as
existing people, and (a) means some of that set may be the wrong people.

**SEVERITY.** P3 for both. Data-integrity and operator-comprehension defects in an
`ADMIN_ROLES`-guarded feature. No privilege boundary is crossed — an administrator may legitimately
edit these profiles — but the operator is shown one thing and another thing happens.

**RATIONALE FOR DEFERRAL.** (a) is not a one-line fix. Requiring a minimum digit length before a
mobile is used as a match key is easy; deciding what the key should actually be is a data-quality
question about how DIC's existing records are formatted, and getting it wrong in the other
direction — matching too little — creates duplicate accounts instead of merged ones. (b) needs a
new server-side preview endpoint that takes the parsed rows and reports which already exist,
which is new API surface plus a wizard step, i.e. a feature, not a hardening change. Both were
out of scope for a phase whose rule was security, correctness and blockers.

**SUGGESTED PHASE.** 6B, as one piece of work, with (b) first: showing the administrator what will
be updated is worth more than refining the key, and it makes (a)'s failures visible in the preview
instead of after the commit. In the interim the runbook should say that `skip` is the safe default
and `update`/`merge` should be run only on a file the operator has reconciled by hand.

---

## P3-5 · CSP is `frame-ancestors` only — and there is no CSP at all on the alumni portal

**FINDING.** The security-header middleware is `server.js:82-95`. In full:

```js
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (wantsAdminPortal(req)) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
  } else {
    res.set('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});
```

Two things are true here, and the second is sharper than the item as it was carried in:

1. The only CSP directive anywhere on the platform is `frame-ancestors 'none'`. There is no
   `script-src`, no `object-src`, no `base-uri`, no `default-src`. As an anti-XSS control the CSP
   does nothing; it is an anti-clickjacking control that happens to be delivered via the CSP header.
2. **The alumni portal receives no `Content-Security-Policy` header at all.** The `res.set` for it
   is inside the `wantsAdminPortal(req)` branch. The alumni portal gets `X-Frame-Options:
   SAMEORIGIN` and nothing else. Every stored-XSS finding Phase 5F fixed (P0-1, P1-3, P3-6) was on
   surfaces reachable from that portal.

**A `script-src` policy is not currently possible, and the reason is structural.** The application
uses inline event-handler attributes pervasively. Counted across `js/*.js`, `index.html` and
`admin.html`:

| Attribute | `js/*.js` | Both HTML files |
|---|---|---|
| `onclick` | 153 | |
| `onsubmit` | 19 | |
| `onchange` | 17 | |
| `oninput` | 6 | |
| `onkeydown` | 1 | |
| `onerror` | 1 | |
| **Subtotal** | **197** | **134** |

**Roughly 330 inline handler attributes in total.** Any `script-src` policy that omits
`'unsafe-inline'` disables every one of them, and the application stops working — no navigation,
no forms, no buttons. A policy *with* `'unsafe-inline'` provides no XSS protection, which is the
only reason to add `script-src` in the first place.

**The prerequisite is therefore migrating to delegated event listeners**: a small number of
listeners bound at a container, dispatching on `data-action` attributes, replacing all ~330 inline
handlers. Those same inline handlers are what made P0-1 possible — 24 sites where a value crossed
from HTML-attribute context into JavaScript-string context, where `escapeHtml` was the wrong
escaper. The `jsArg()` helper (`js/core.js:89`) closes that correctly and was applied at all 24
sites, but it is a fix at the boundary; delegation removes the boundary. The two changes are the
same change viewed from either end.

**SEVERITY.** P3. Defence in depth. Note what the ordering means: CSP would have been a *second*
line of defence behind the escaping. The escaping is now correct at every site Phase 5F found and
proved. This is the missing second line, not a missing first one.

**RATIONALE FOR DEFERRAL.** Rewriting ~330 event handlers across seventeen frontend files is the
largest single refactor available in this codebase, it touches every interactive surface in both
portals, and it has no test harness behind it beyond `tests/crossref.js` — which Phase 5F had to
repair, because its string-stripping was blanking whole regions of file (BUG-13). Attempting it
in the closing phase would have been reckless in precisely the way a security review should
object to. Adding `script-src 'unsafe-inline'` in the meantime was rejected as a header that
looks like a control and is not one.

**SUGGESTED PHASE.** 6C, as its own phase: delegated listeners first, then `script-src 'self'`,
then the remaining directives. Two things worth doing sooner and cheaply, in 6A: move the
`Content-Security-Policy` line out of the `wantsAdminPortal` branch so both portals get
`frame-ancestors`, and add `base-uri 'self'` and `object-src 'none'` — neither is affected by
inline handlers, so both can ship today.

---

## P3-6 · `dept_admin` is institution-wide; there is no department scoping *(accepted)*

**FINDING.** `dept_admin` sits in `MODERATOR_ROLES` (`server.js:456`):

```js
const MODERATOR_ROLES = ['super_admin', 'univ_admin', 'dept_admin', 'moderator'];
```

and in the privacy staff-bypass list (`privacy.js:87`):

```js
const STAFF_ROLES = ['super_admin', 'univ_admin', 'dept_admin'];
```

There is no scoping anywhere. `users.department` exists as a column and is selected once, at
`server.js:1309`, purely as display data (`u.department AS user_department`). It is referenced in
**no** authorisation decision, in **no** `WHERE` clause on a guarded route, and in **no** guard —
grepping every route file for `req.user.department` returns nothing. The role name says
"department"; the permission is the institution.

Practically, a `dept_admin` reaches all 41 `MODERATOR_ROLES` routes across every department, and
carries the privacy staff bypass for `email` and `mobile` on every member. Note the boundary that
is enforced: `moderator` is **not** in `STAFF_ROLES`, so the bypass genuinely distinguishes the
tiers, and `location` has no staff bypass at all — `dept_admin` cannot see a member who set
`location: private`. `SELF_ONLY_FIELDS` (`present_address`, `permanent_address`, `postal_code`,
`hometown`) are never disclosed to any staff role.

**SEVERITY.** P3 (accepted). A documented simplification. A reviewer should read the role name as
a label rather than as a boundary, and should assume any `dept_admin` account has
institution-wide moderator reach.

**RATIONALE FOR DEFERRAL.** Accepted, documented, and deliberately so. Real department scoping is
not a guard change: it needs a department dimension on the data model, a decision about what
happens to alumni with no department or several, and a scoping clause on all 41 moderator routes —
where a route missed is a silent authorisation hole, the worst possible failure mode for a change
made in a hurry. It also depends on whether DIC actually intends to delegate administration per
department, which is an organisational question, not a technical one.

**SUGGESTED PHASE.** 6C, and only if DIC confirms it wants per-department delegation. If it does
not, the honest fix is smaller and better: rename the role so the name stops implying a boundary
that does not exist.

---

## P3-7 · Role- and broadcast-targeted notifications are shared rows

**FINDING.** *(Found during this review; not on the list carried into it.)*

`server.js:1826-1841`, `PUT /api/notifications/:id/read`:

```js
      UPDATE notifications SET is_unread = FALSE
      WHERE id = $1
        AND (user_id = $2 OR target_role = $3 OR (user_id IS NULL AND target_role IS NULL))
```

The first disjunct is per-user and correct. The other two are not per-user rows at all:

- `target_role = $3` — one row serves every holder of that role. Registration notifications are
  written this way: `server.js:843-848` inserts one row per role in `MODERATOR_ROLES`, not one per
  staff member. When any single moderator marks it read, `is_unread` goes false on the shared row
  and it disappears for **every** moderator, including those who never saw it.
- `user_id IS NULL AND target_role IS NULL` — a platform-wide broadcast. The first member to open
  it clears it for the entire alumni body.

`PUT /api/notifications/read-all` (`server.js:1843`) has the same shape, so one user's
"mark all read" clears every shared row they can see.

The security impact is limited — nothing is disclosed, and this is a read-state flag, not data.
But "a new alumnus is awaiting verification" is an operational signal, and one moderator glancing
at their bell silently removes it from every other moderator's queue. A registration can go
unverified because the notification was dismissed by someone who did not action it, and nothing
records that it happened.

**SEVERITY.** P3. Correctness and operational-reliability defect with no confidentiality impact.

**RATIONALE FOR DEFERRAL.** The fix is a schema change: a `notification_reads` join table, or
fan-out to per-user rows at write time. Either changes how every notification is written and read,
and fan-out has a cost question attached (a broadcast to every alumnus becomes one row per
alumnus). Not a security fix, and not something to change under a schema migration at the end of
a hardening phase.

**SUGGESTED PHASE.** 6B, with the read-state model decided first.

---

# INFO

## INFO-1 · `test_e2e_crud.js` is still in the repository, recorded as REMOVED

**FINDING.** `POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md:373` records:

```
| P5C-020 | `test_e2e_crud.js` is a legacy standalone harness outside `tests/` | REMOVED |
```

The file is still there. `ls` shows it in the repository root (7,154 bytes, dated 6 August),
`git ls-files test_e2e_crud.js` returns it as tracked, and its last commit is `e63b8d3` — the
original Neon integration commit. **It has never been removed and never been modified since it was
added.** The Phase 5C audit's status column is wrong.

A second document contradicts the first. `DIC_ALUMNI_SYSTEM_MASTER_AUDIT_AND_ROADMAP.md:347`
records the same file as:

```
| `test_e2e_crud.js`, `seed_cloud.js` | early-era scripts | **Keep** as historical dev tooling; exclude from any production image |
```

So one audit says REMOVED, another says KEEP, and the repository agrees with neither — the file is
present and nothing excludes it from a production image, since there is no build step and no
`.dockerignore`/`.vercelignore` covering it.

The file itself is inert with respect to the running application: it is not in `tests/`, is not
referenced by `tests/run-all.js`, is not in `package.json` scripts, and is never required by
server code. It runs only if a person runs it deliberately. It is a standalone harness that
exercises CRUD against a configured database.

**Reporting this honestly matters more than the file does.** A reviewer who trusts a status column
that says REMOVED, on a file that is present, will discount the rest of the audit's status
columns — correctly. The defect is in the record-keeping, and it is worth the reviewer knowing
that at least one status line in the Phase 5C audit was not verified against the tree.

**SEVERITY.** INFO. No runtime impact. The finding is documentation drift.

**RATIONALE FOR DEFERRAL.** Not a security issue, and there is an unresolved contradiction between
two documents about whether the file should exist at all. Deleting it during a hardening phase
would have resolved that contradiction by fiat rather than by decision, and would also have made a
third document wrong.

**SUGGESTED PHASE.** 6A, as a five-minute cleanup: decide keep or delete, then make all three of
the file, `POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md:373` and
`DIC_ALUMNI_SYSTEM_MASTER_AUDIT_AND_ROADMAP.md:347` agree.

---

## INFO-2 · No payment processing exists *(accepted)*

**FINDING.** Recorded so a reviewer does not spend time looking for a payment surface. There is no
gateway, no payment SDK, no card data, and no such field anywhere in the schema. The five runtime
dependencies are `express`, `body-parser`, `cors`, `pg` and `nodemailer` (`package.json`) — none
of them is a payment library.

Donations are pledges. An administrator confirms receipt out of band via
`POST /api/donations/:id/record-payment`, guarded by `ADMIN_ROLES`. Priced event tickets are
refused with a 409 rather than being sold.

**SEVERITY.** INFO (accepted). Deliberate scope decision. The platform is out of PCI scope
entirely, and stays there only for as long as this remains true — introducing payments later is a
change of the platform's entire risk category, not a feature addition.

**SUGGESTED PHASE.** None. Re-scope the security review if payments are ever introduced.

---

## INFO-3 · `PUT /api/notifications/:id/read` returning 200 for another user's notification — **refuted**

**FINDING.** This item was carried into this phase as a finding: that the route returns 200 for a
notification belonging to someone else, that the `UPDATE` is a no-op because it is scoped by
`user_id`, and that reporting success for an action that did not happen is wrong.

**The first half does not match the code.** `server.js:1826-1841` returns **404**, not 200:

```js
    `, [parseInt(req.params.id), req.user.uid, req.user.role]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json(result.rows[0]);
```

The `UPDATE ... RETURNING *` yields no rows when the `WHERE` clause excludes the caller, and the
handler converts that to a 404. `git log -S"Notification not found" -- server.js` returns a single
commit, `02063a4` — the route has behaved this way since it was written, and Phase 5F did not
change it. The scoping described in the item is real and correct; the response code described is
not.

**No fix was made, because nothing here is broken.** The item is recorded as refuted rather than
dropped, so that a reviewer comparing this document against the phase's working notes can see why
it does not appear as a deferred item.

One genuine defect *was* found in this route while checking the claim — the shared-row behaviour of
`target_role` and broadcast notifications. It is written up separately as **P3-7**.

**SEVERITY.** INFO. Recorded for accuracy.

---

# What a reviewer should make of this list

This list is not a set of things that were too hard to fix; it is the set of things where fixing
them at speed would have been worse than recording them. Four of the P2 items — the `NOT NULL`
constraint that breaks public sign-up and can fail an entire import, the synchronous KDF on two
unauthenticated routes, the restore script that silently targets the wrong database on the
intended deployment, and the trust-proxy variable no operator is told about — are live defects in
running code, and a reviewer should treat them as work outstanding rather than as risk accepted.
The remaining items divide into two honest categories. Some are accepted design with the
limitation stated in full: the audit chain is an unkeyed SHA-256 chain that any adversary with
database write access can recompute cleanly, and it must never be described as tamper-proof;
`dept_admin` carries institution-wide moderator reach whatever its name suggests; the identity
vault's encryption is sound but cannot be rotated without downtime. Others are genuine hardening
that was not attempted because doing it properly is larger than a phase: three CDN scripts without
integrity checks, and a Content-Security-Policy that cannot constrain scripts until roughly 330
inline event handlers become delegated listeners. Two items were found during this write-up rather
than carried into it, and one item carried into it was refuted by the code and is recorded as
refuted rather than quietly dropped. Nothing here should be read as a claim that the platform is
secure. It should be read as an accurate statement of what is fixed, what is known and accepted
with reasons, and what is still open — which is the only basis on which a reviewer can form their
own judgement.
