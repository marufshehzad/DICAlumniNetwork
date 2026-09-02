# Independent Security Review Checklist — DIC Alumni Platform

This document is written for an external reviewer who has been handed the repository and a staging
deployment, and who has never seen this codebase before. It tells you what the system is, how to
stand it up, what to attack first, what the engineering team already knows is wrong, and how to
retest a fix.

It is deliberately not a claim that the platform is secure. It is a description of what is built,
what was fixed in the most recent hardening pass (Phase 5F), and where the honest gaps are. Where a
control does not exist, this document says so.

Companion documents in the same review package:

| Document | What it holds |
|---|---|
| `SECURITY_AUTHORIZATION_MATRIX.md` | The full route-by-route guard table (all 138 routes) |
| `AUDIT_CHAIN.md` | The audit chain design, its segments, and what the verifier can and cannot prove |
| `OPERATIONS_RUNBOOK.md` | Day-to-day operational procedures |
| `PRODUCTION_DEPLOYMENT_RUNBOOK.md` | Deployment, environment variables, proxy topology |
| `PHASE_LOG.md` | The change history, including the Phase 5F findings quoted below |

If `SECURITY_AUTHORIZATION_MATRIX.md` is missing from your copy, you can regenerate an equivalent
table yourself: `tests/security_smoke.js` parses the route table straight out of the source files
(see `routesFromSource()` at `tests/security_smoke.js:122`). That parser is the authority the smoke
suite uses, so a route added without a guard shows up in it.

---

## 1. Scope

### In scope

**The Express application and its API.** `server.js` (~2,900 lines) plus the route modules
`routes_v2.js`, `routes_events.js`, `routes_admin_users.js`, `routes_compliance.js`,
`routes_planner.js`. 138 routes in total. This is where authentication, authorisation, privacy
gating, the identity vault, the audit chain and the scheduler live.

**Both browser portals.** One Express app serves two front-ends: `index.html` (alumni) and
`admin.html` (staff). They share the same API and the same `js/*.js` files but load different module
sets, and are routed either by path (`/admin`) or by hostname (`ADMIN_ORIGIN`). The front-end is
vanilla JavaScript — no framework, no bundler, no build step, classic `<script>` tags, one global
scope. Every `js/*.js` file is served to the browser verbatim, so what you read in the repository is
exactly what runs.

**Cross-site scripting in the rendering layer.** The front-end builds HTML with template literals and
`innerHTML`. This is the area where Phase 5F found the most serious defects, and it is the area most
likely to contain more of them. Treat every `innerHTML` assignment and every inline event-handler
attribute as a candidate.

**Authentication, session handling and revocation.** HMAC-SHA256 bearer tokens, `users.token_version`
revocation, the 12-hour TTL, the login throttle, the durable account lock, password reset.

**Authorisation.** The five roles, the three role constants, and the 138 route guards.

**Privacy enforcement.** `privacy.js` and every read path that is supposed to consult it.

**The identity vault.** AES-256-GCM encryption of NID/BRC/passport fields, the reveal endpoint, and
`vault_access_logs`.

**The audit chain.** `audit_chain.js`, `verify_audit.js`, and what they actually prove.

**The scheduler endpoint.** `POST` and `GET /api/internal/jobs/run`.

**Backup and restore.** `backup.js`, `restore.js`, and the handling of the resulting dump files.

**Operational scripts.** `rotate_credentials.js`, `reset_link.js`, the twelve migration scripts.

**Frontend supply chain.** Three third-party scripts are loaded from `cdn.jsdelivr.net` in both
portals, with **no Subresource Integrity attribute on any of them**:

```
chart.js@4.4.0        index.html:30   admin.html:31
qrcodejs@1.0.0        index.html:31   admin.html:32
lucide@0.474.0        index.html:908  admin.html:715
```

This is in scope as a supply-chain question. A compromise of jsDelivr, or of any of those three
packages, executes attacker JavaScript inside a signed-in `super_admin` session on the staff portal.
It is an open hardening gap, not a defended position — see section 10.

### Explicitly not in scope, because it does not exist

- **No payment gateway.** There is no Stripe, no PayPal, no SSLCommerz, no card data, no PCI surface
  of any kind. Donations are *pledges* that an administrator marks as received
  (`POST /api/donations/:id/record-payment`, restricted to `ADMIN_ROLES`). Priced event tickets are
  refused at registration with a 409 and the reason `online_payment_unavailable`
  (`routes_events.js:601`). If you find a code path that accepts money, that is a finding in itself.
- **No mobile application.** There is a `manifest.json` and the site is responsive; there is no
  native app, no app-specific API and no mobile token flow.
- **No SSO, no OAuth, no SAML, no LDAP.** Authentication is email and password against the local
  `users` table, full stop. There is no identity provider integration to test.
- **No cookies anywhere.** The session is a bearer token in an `Authorization` header. `cors` is
  configured with `credentials: false` (`server.js:72`). There is no cookie for a browser to attach
  automatically, so classical CSRF has no vehicle. Please do confirm this rather than take it on
  trust — a single `res.cookie` or `credentials: true` would change the answer.
- **No file upload to the server.** Photos are stored as URLs. There is no multipart handler and no
  uploaded-file directory. CSV import is parsed **in the browser** and posted as JSON.
- **No WebSocket, no server-sent events, no long polling.**
- **Third-party infrastructure** (the hosting provider, the managed PostgreSQL instance, the SMTP
  provider) is out of scope except where the application's configuration of it is at fault.

---

## 2. Environment setup

**Review against a staging deployment. Never against production.** Several of the scenarios below
create accounts, promote them to staff roles directly in the database, submit deliberately malformed
input, and trip rate limiters. `tests/security_smoke.js` does all of that by design.

**Never restore a production backup over a live database.** `restore.js` has a `--drill` mode that
restores into a disposable database precisely so that you never have to point it at anything you care
about. Use it.

### Prerequisites

- Node.js 20 or later (the code uses `??`, optional catch binding, and `base64url` encoding).
- PostgreSQL 16 (developed against 16.14).
- No build step. There is nothing to compile, bundle or transpile.

### Install

```bash
npm ci
```

Five runtime dependencies: `express` (5.x), `body-parser`, `cors`, `pg`, `nodemailer`. Confirm that
`npm ci` installs nothing else — the small dependency tree is a deliberate property of this codebase
and worth verifying rather than assuming.

### Database

Apply the base schema, then each migration in order:

```bash
psql "$DATABASE_URL" -f schema.sql

node migrate_v2.js
node migrate_v3.js
node migrate_v4.js
node migrate_v5.js
node migrate_v6.js
node migrate_v7.js
node migrate_v8.js
node migrate_v9.js
node migrate_v10.js
node migrate_v11.js
node migrate_v12.js
node migrate_v13.js
```

Each migration reads its DDL from the matching `schema_vN.sql`. **Migrations v5 through v13 support
`--dry-run`**, which applies the change inside a transaction, verifies it, and rolls back. **v2, v3
and v4 do not** — they have no dry-run flag. That is a documentation correction worth carrying into
your notes: the claim "each migration has `--dry-run`" is true of nine of the twelve, not all of
them.

Optionally seed demonstration data with `seed.sql`. Note that seeded accounts ship with a `LOCKED$`
sentinel in `password_hash`, which `verifyPassword` refuses unconditionally
(`server.js:257`) — a fresh database therefore has **no working default credential**. You must run
`rotate_credentials.js` (section 3) before you can sign in as staff.

### Required environment variables

In production mode the server **refuses to boot** without these six (`server.js:204-227`):

| Variable | Purpose | Constraint enforced at boot |
|---|---|---|
| `SESSION_SECRET` | HMAC key for session tokens | Must be present |
| `ENCRYPTION_KEY` | AES-256-GCM key for the identity vault | Must match `/^[0-9a-fA-F]{64}$/` |
| `CRON_SECRET` | Scheduler credential | Must be present and 32+ characters |
| `MAIL_TRANSPORT` | Declares how mail is sent | Must be present |
| `PUBLIC_ORIGIN` | Alumni portal origin; also the CORS allow-list | Must be present |
| `ADMIN_ORIGIN` | Staff portal origin and hostname routing | Must be present |

All values below are **placeholders**. Generate your own; never reuse a value from any document.

```bash
DATABASE_URL="postgresql://REVIEWER:PLACEHOLDER@localhost:5432/dic_staging"
PORT=8123

# Generate each of these yourself:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET="<PLACEHOLDER — 64 hex characters>"
ENCRYPTION_KEY="<PLACEHOLDER — exactly 64 hex characters>"
CRON_SECRET="<PLACEHOLDER — 64 hex characters>"

MAIL_TRANSPORT="console"          # writes mail to stdout instead of sending it
PUBLIC_ORIGIN="http://localhost:8123"
ADMIN_ORIGIN="http://localhost:8123"

# Leave TRUST_PROXY UNSET unless there is a real reverse proxy in front of the
# port you are testing. See scenario 26 — this variable is load-bearing.
# TRUST_PROXY=1

BACKUP_DIR="/var/backups/dic-staging"   # must be outside the repository/web root
```

Copy `.env.example` as your starting point — it documents each variable and why it exists. Do not
commit your `.env`; `.gitignore` already excludes `.env` and `*.env`.

### Start

```bash
node server.js
```

Health check: `GET /api/health` returns `{"status":"ok","database":"ok","latencyMs":N}` and is one of
the five routes that is public by design.

The staff portal is reachable at `/admin` on the same host, or at `ADMIN_ORIGIN` if you point a
second hostname at the deployment.

---

## 3. Test accounts

**This document contains no real credentials and none will be supplied.** Provision your own.

### The role accounts you will need

Register five accounts through `POST /api/auth/register` (or through the alumni sign-up UI), then
promote four of them in the database. Registration always creates an `alumni` account regardless of
what the request body says — that is itself worth testing (scenario 5).

| Account | Role to set | What it is for |
|---|---|---|
| `reviewer-super@<your-domain>` | `super_admin` | Platform authority: audit log, re-seed, scheduler, administrator provisioning |
| `reviewer-univ@<your-domain>` | `univ_admin` | Institutional authority: everything except the `SUPER_ONLY` seven |
| `reviewer-dept@<your-domain>` | `dept_admin` | Staff privacy bypass, moderation; **institution-wide, not department-scoped** |
| `reviewer-mod@<your-domain>` | `moderator` | Moderation only; explicitly *excluded* from the privacy bypass |
| `reviewer-alumni@<your-domain>` | `alumni` | The baseline attacker: a legitimate signed-in member |

Plus a second ordinary member (`reviewer-alumni2@<your-domain>`) — most IDOR scenarios need two peers.

Promote with:

```sql
UPDATE users SET role = 'super_admin' WHERE email = 'reviewer-super@<your-domain>';
```

Every promotion you make by hand is itself a thing to test: after changing the row, the *existing*
token must reflect the new role on the very next request, because `attachUser` re-reads `role`,
`status`, `token_version` and `must_change_password` from the `users` row on every request
(`server.js:315-320`). Confirm that.

### The bulk-imported account (for the enrolment gate)

Sign in as `reviewer-univ@` and `POST /api/bulk-import` with one record. The response carries a
generated 12-character batch password (`generateImportPassword`, `server.js:469`) shared by every
account in that batch, and every created account gets `must_change_password = TRUE`.

Sign in as that imported account. The resulting session must be able to reach exactly three paths and
nothing else (`ENROLMENT_ALLOWED_PATHS`, `server.js:379`):

```
POST /api/auth/change-password
GET  /api/auth/me
POST /api/auth/logout
```

Everything else must be `403` with `{"mustChangePassword": true}`. This is scenario 10.

### `rotate_credentials.js`

This is how privileged accounts get real passwords. It exists because every seeded account once
accepted a shared weak password that was also published in the README.

```bash
node rotate_credentials.js --check    # report which accounts still accept a weak password
node rotate_credentials.js            # rotate the four privileged roles
node rotate_credentials.js --all      # also rotate seeded alumni demo accounts
node rotate_credentials.js --lock     # write a LOCKED$ sentinel instead of a password
```

`--check` tests each account against a small list of known-weak values
(`WEAK_PASSWORDS`, `rotate_credentials.js:38`) and reports which ones match. It does not change
anything.

You may supply your own passwords through `ADMIN_PW_SUPER_ADMIN`, `ADMIN_PW_UNIV_ADMIN`,
`ADMIN_PW_DEPT_ADMIN`, `ADMIN_PW_MODERATOR` (minimum 12 characters). Any role without an environment
variable gets a generated 24-character password from an unambiguous alphabet.

**Generated passwords are written once to `admin-credentials.local.txt`.** That file:

- is gitignored, along with `*credentials*.local.txt` (`.gitignore`);
- is excluded from the static-file allow-list, so the web root will not serve it (verify this
  yourself — scenario 28);
- **must be transferred to a password manager and then deleted.** It is a plaintext credential file
  sitting in the repository directory. Note that a copy of it currently exists in the working tree of
  the repository you have been given; treat any values in it as compromised and rotate them before
  the deployment is exposed to anyone.

`reset_link.js` similarly writes password-reset links to `reset-link.local.txt`. Same handling: it is
a live credential for 30 minutes (`RESET_TTL_MS`, `server.js:924`).

---

## 4. Roles and expected authority

Five roles. The authority tiers are defined once, in `server.js`, and every guard spreads one of the
three constants — `GET /api/stats/rbac` derives the displayed matrix from the same constants, so the
admin screen cannot disagree with the middleware.

```
SUPER_ONLY      = [super_admin]
ADMIN_ROLES     = [super_admin, univ_admin]
MODERATOR_ROLES = ADMIN_ROLES + [dept_admin, moderator]
```

| Role | Guard count | May do | May not do |
|---|---|---|---|
| `super_admin` | 7 routes are `SUPER_ONLY` | Everything. Provision and demote administrators, read the audit log, trigger the scheduler by session, re-seed the database on non-production | — |
| `univ_admin` | 20 routes are `ADMIN_ROLES` | Institution-wide administration: bulk import, identity vault read and reveal, donation payment recording, event and content administration, staff privacy bypass | The seven `SUPER_ONLY` routes: administrator provisioning, audit-log read, database re-seed |
| `dept_admin` | 41 routes are `MODERATOR_ROLES` | Moderation, event operations, attendee lists. **Included** in the privacy staff bypass for `email` and `mobile` | Vault, bulk import, donation payment recording, audit log, administrator management |
| `moderator` | same 41 | Moderation queue, event operations, attendee lists | Everything `dept_admin` cannot do, **and** the privacy staff bypass — `moderator` is deliberately absent from `privacy.STAFF_ROLES` |
| `alumni` | 63 routes are `requireAuth` | Own profile, directory (privacy-gated), events, jobs, mentorship, chapters, news, notifications, own DSAR export and deletion request | Every staff route |

Two things to hold onto:

- **`dept_admin` is institution-wide.** There is no department scoping anywhere in the codebase — a
  `dept_admin` sees every department. This is a documented, accepted simplification for a
  single-institution deployment, not a defect. Please judge whether you agree with that acceptance
  rather than reporting it as a discovery.
- **`moderator` is not a privacy-bypass role.** `privacy.STAFF_ROLES = ['super_admin', 'univ_admin',
  'dept_admin']` (`privacy.js:88`). A moderator sees a private email or mobile number no more than an
  ordinary member does. Test this — it is an easy thing to get wrong in a new read path.

---

## 5. Endpoints

The full table of all 138 routes and their guards is in `SECURITY_AUTHORIZATION_MATRIX.md`. Read that
first, then come back here.

Exactly **five routes are public by design**. Anything else answering an anonymous caller is a
finding:

```
GET  /api/health
POST /api/auth/login
POST /api/auth/register
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

### The twelve worth attacking first

| # | Endpoint | Guard | Why it is interesting |
|---|---|---|---|
| 1 | `POST /api/auth/login` | public | Mints every session. Holds the throttle, the durable account lock, the enumeration-resistant single error message, and the password comparison. The lock ordering here was a live P2 defect until Phase 5F |
| 2 | `POST /api/bulk-import` | `ADMIN_ROLES` | Creates whole batches of accounts sharing **one** password. The enrolment gate that makes that safe is only five months old and is enforced in `requireAuth`/`requireRole`, not at the route. Accepts an unbounded `records` array and arbitrary free text that ends up in exports |
| 3 | `POST /api/vault/:id/reveal` | `ADMIN_ROLES` | Decrypts a national ID or birth certificate number. Requires a stated reason, writes `vault_access_logs`, and is the single most sensitive read on the platform |
| 4 | `POST` / `GET /api/internal/jobs/run` | `requireScheduler` | Runs `deletion-purge`, which *permanently deletes accounts*. Guarded by a shared secret compared with `timingSafeEqual`, with a `super_admin` session as an alternative credential. A `GET` variant exists for cron providers that only issue GETs — so it is reachable from a browser address bar with the right credential |
| 5 | `GET /api/alumni` | `requireAuth` | The directory. Every privacy decision for `email`, `mobile` and `location` has to be right here, for every role, on every column |
| 6 | `GET /api/alumni/:id` | `requireAuth` | Single-profile read. `SELF_ONLY_FIELDS` (`present_address`, `permanent_address`, `postal_code`, `hometown`) must never appear for anyone but the owner — staff included |
| 7 | `GET /api/mentorships/suggestions` | `requireAuth` | Leaked `city` past the location privacy setting until Phase 5F, including via a `matched_city` boolean and its score contribution. A good place to check whether the *derived* fields are gated as tightly as the raw ones |
| 8 | `GET /api/moderation/queue` (and the staff moderation panel it feeds) | `MODERATOR_ROLES` | Renders alumni-authored text into the staff portal. This is where the Phase 5F P0-2 stored XSS lived: submitting to the queue *was* the delivery mechanism |
| 9 | `GET /api/jobs/:id/applicants` | `requireAuth` | Owner-scoped, not role-scoped. The natural place to test horizontal escalation, and the route whose title field carried the proof-of-concept for P0-1 |
| 10 | `GET /api/dsar/export` | `requireAuth` | Dumps everything the platform holds about the caller, in JSON or CSV. Check the scoping (`uid` must be the caller's) and the CSV construction |
| 11 | `GET /api/events/:id/attendees.csv` | `MODERATOR_ROLES` | Exports names, emails, phone numbers and ticket codes to a spreadsheet file. See scenario 22 on formula injection |
| 12 | `GET /api/audit-logs` | `SUPER_ONLY` | The record of what everyone did. Both a confidentiality target and an integrity target — see scenario 29 |

---

## 6. Attack scenarios

Thirty-two concrete things to try. Each gives the action, the expected result, and how to tell a pass
from a fail. **Use inert markers throughout.** Never write an exfiltration payload, never point a
payload at a collaborator domain, never use a real person's data as test input.

Throughout, `$ALUMNI`, `$ALUMNI2`, `$MOD`, `$DEPT`, `$UNIV`, `$SUPER` are the bearer tokens for the
accounts from section 3, and `$BASE` is your staging origin.

---

### Authentication and session

**1. Anonymous sweep of every route.**
*Do:* enumerate every route from source (`tests/security_smoke.js:122` shows how) and issue each one
with no `Authorization` header.
*Expect:* `401` from everything except the five public routes. `403` is also acceptable where a
role guard fires first, but `200` is not.
*Pass/fail:* any `200`, or any response body containing data, from a non-public route is a **P0**.
Section A of the smoke suite automates exactly this.

**2. The public five behave as documented.**
*Do:* call each of the five public routes anonymously.
*Expect:* `/api/health` returns status only — no version string, no hostname, no connection details.
`/api/auth/login` returns one generic message for both an unknown address and a wrong password.
`/api/auth/forgot-password` returns an identical acknowledgement whether or not the address exists,
including when mail delivery fails (the send result is deliberately ignored, `server.js:981`).
*Pass/fail:* any difference in status code, body or *timing* between an existing and a non-existent
address on `forgot-password` is a finding. Note that `register` **does** return `409` for an existing
address — see section 10 for why that is an accepted position rather than an oversight.

**3. Vertical escalation: member to staff.**
*Do:* replay every `requireRole` route with `$ALUMNI`.
*Expect:* `403` with `{"error":"Insufficient permissions for this action"}`.
*Pass/fail:* any `200` is **P0**. Pay particular attention to routes added since the last review — a
route registered without a guard defaults to public.

**4. Vertical escalation: moderator to administrator.**
*Do:* with `$MOD`, call `GET /api/audit-logs`, `GET /api/admin/administrators`, `GET /api/vault`,
`POST /api/bulk-import`, `POST /api/donations/:id/record-payment`.
*Expect:* `403` on all of them.
*Pass/fail:* a `200` on any is **P0**. Repeat with `$DEPT` — `dept_admin` shares
`MODERATOR_ROLES` with `moderator`, so the same set must be refused.

**5. Role injection through the body.**
*Do:* `POST /api/auth/register` with `"role":"super_admin"` in the body. Then, as `$ALUMNI`,
`PUT /api/profile` (and every other self-service write) with `"role":"super_admin"`.
*Expect:* the account is created and remains `alumni`; the profile update either ignores the field or
rejects it.
*Pass/fail:* check the database, not the response —
`SELECT role FROM users WHERE email = ...`. Anything other than `alumni` is **P0**.

**6. Token forgery.**
*Do:* take a valid token `base64url(payload).base64url(sig)`. Decode the payload, change `uid` to a
`super_admin`'s id and `role` to `super_admin`, re-encode, keep the original signature. Also try: an
empty signature, no signature at all, a signature from a different token, the `alg:none` trick (there
is no `alg` field — the format is not JWT, so this should simply fail to parse).
*Expect:* `401` in every case. Verification is `crypto.createHmac('sha256', SESSION_SECRET)` compared
with `timingSafeEqual` after a length check (`server.js:280-285`).
*Pass/fail:* any `200`, or any error that distinguishes "bad signature" from "malformed token", is a
finding. Note that `role` inside the token is only a hint — `attachUser` re-reads the real role from
the database — so a forged role would still need a valid signature to get that far.

**7. Expiry.**
*Do:* mint a session, then set the system clock forward, or craft a payload with `exp` in the past
and (if you have `SESSION_SECRET` on your own staging box) sign it correctly.
*Expect:* `401`. `SESSION_TTL_MS` is 12 hours and `exp` is checked on every verify
(`server.js:288`).
*Pass/fail:* a token that outlives its `exp` is **P1**.

**8. Revocation by sign-out.**
*Do:* sign in, confirm `GET /api/auth/me` returns `200`, `POST /api/auth/logout`, then reuse the same
token.
*Expect:* `401` with `{"error":"This session has ended. Please sign in again."}`.
*Pass/fail:* a token that still works after sign-out is **P1**. The mechanism is
`users.token_version`: the token carries the version it was minted at, `attachUser` compares it to
the current column value (`server.js:325`). Repeat for the other three bumps — password change,
password reset, and suspension.

**9. Revocation by demotion and suspension.**
*Do:* sign in as `$SUPER`. In the database, `UPDATE users SET role='alumni'` for that account. Reuse
the token immediately. Then set `status='suspended'` and reuse it again.
*Expect:* the demoted token is refused from staff routes **on the next request**, not at token
expiry. The suspended token gets `403` with the suspension message on every route.
*Pass/fail:* if either takes effect only after the token expires, that is **P1** — it means an
administrator whose account has been compromised cannot be locked out for up to twelve hours.

**10. The enrolment gate.**
*Do:* import a batch of two accounts. Note the single shared batch password. Sign in as imported
account A. With that token, attempt: `GET /api/alumni`, `PUT /api/profile`, `POST /api/jobs`,
`GET /api/events`. Then attempt the three allowed paths. Separately, sign in to imported account B
using the *same* batch password and confirm what that session can do.
*Expect:* every route except `/api/auth/change-password`, `/api/auth/me` and `/api/auth/logout`
returns `403` with `{"mustChangePassword": true}`. After a successful password change, the account
behaves normally.
*Pass/fail:* any other route returning `200` for a session in this state is **P1** — it would mean
the shared batch password is once again a working credential for every account in the batch. Check
that the gate is in `requireAuth` *and* `requireRole` (`server.js:427` and `server.js:436`), not just
one of them.

**11. Password reset flow.**
*Do:* request a reset for `$ALUMNI`. Capture the token (with `MAIL_TRANSPORT=console` it appears on
stdout). Use it. Then try: using it a second time; using it after 30 minutes; using a token for a
`suspended` account; supplying a `newPassword` shorter than 8 characters; requesting a reset with a
forged `Host` header.
*Expect:* single use only (the token hash is cleared in the same `UPDATE` that sets the password,
`server.js:1015-1024`); expired tokens rejected; suspended accounts get no reset at all; one identical
error message for unknown, expired and already-used tokens; the reset **link** is built from
`PUBLIC_ORIGIN`, not from the `Host` header (`server.js:972`).
*Pass/fail:* a reset link that points at a host you supplied is **P1** — it is a credential sent to
an attacker-chosen server.

---

### Horizontal escalation (IDOR)

**12. Another member's job posting.**
*Do:* as `$ALUMNI`, create a job. As `$ALUMNI2`, attempt `PUT /api/jobs/:id`,
`DELETE /api/jobs/:id`, `GET /api/jobs/:id/applicants`.
*Expect:* `403` on all three, and the row unchanged in the database.
*Pass/fail:* confirm in SQL, not from the response body — a route that returns `403` after having
already written is still a finding.

**13. Another member's notifications.**
*Do:* as `$ALUMNI2`, attempt to mark `$ALUMNI`'s notification as read, and to read the list.
*Expect:* refused; `is_unread` unchanged.
*Pass/fail:* verify with `SELECT is_unread FROM notifications WHERE id = ...`.

**14. Another member's DSAR export and deletion request.**
*Do:* as `$ALUMNI2`, try to reach `$ALUMNI`'s export — by id in the path, by `?userId=`, by a `uid`
in the body, by any parameter the route accepts.
*Expect:* the export is scoped to `req.user.uid` with no caller-supplied override.
*Pass/fail:* a bundle for anyone but the caller is **P0** — it is the entire record for a person.
Try the same against `POST /api/dsar/delete`: making someone else's deletion request would be a
denial-of-service on a real account.

**15. Numeric parameter probing.**
*Do:* walk `/api/alumni/1..N`, `/api/events/:id`, `/api/vault/:id`, `/api/tasks/:taskId` as
`$ALUMNI`. Try negative ids, `0`, very large ids, `1e3`, `01`, `1 OR 1=1`, `../1`.
*Expect:* non-numeric values give a `400` before touching the database
(`app.param` validation, `server.js:408-419`; `custom_fields.id` is a varchar and is deliberately
exempt). Valid-but-unauthorised ids give `403` or `404` — consistently.
*Pass/fail:* a `500` is a finding on its own (see scenario 27). An inconsistency between `403` and
`404` across ids is an enumeration oracle worth reporting as **P3**.

---

### Cross-site scripting

Both classes below were live defects fixed in Phase 5F. Re-verify both, then go looking for a third.
**Use an inert marker only.** The two payload shapes below set a global variable or produce a broken
image; neither exfiltrates anything.

**16. Inline event-handler attribute injection (the P0-1 class).**
*Do:* as `$ALUMNI`, post a job whose title is exactly:

```
x');window.__REVIEW_MARKER_1=true;//
```

Sign in as `$SUPER`, open the staff view that lists jobs, and click the applicants button for that
row. Inspect the rendered attribute in DevTools and check `window.__REVIEW_MARKER_1` in the console.
*Expect:* the attribute renders as `showJobApplicants(5, "x');window.__REVIEW_MARKER_1=true;//")` —
double-quoted, the apostrophe inert — and `window.__REVIEW_MARKER_1` is `undefined` after clicking.
*Why it broke:* `escapeHtml` turns `'` into `&#39;`, and an HTML attribute is decoded by the parser
**before** the handler body is compiled as JavaScript. So `&#39;` became a live apostrophe and closed
the string literal. Eight of the call sites additionally carried
`.replace(/'/g, '&#39;')`, which was a total no-op because `escapeHtml` had already replaced every
apostrophe — code that *read* as defended and was not.
*The fix:* `jsArg()` in `js/core.js:89` — `escapeHtml(JSON.stringify(String(v)))` — which supplies its
own quotes. Applied across fourteen files; count the current call sites with
`grep -rc "jsArg(" js/*.js`.
*Pass/fail:* the marker being set is **P0**. Also grep for any *remaining* site that interpolates a
value into an `on*=` attribute without `jsArg` — that is the real test, not the one payload.

**17. Moderation-queue injection (the P0-2 class).**
*Do:* as `$ALUMNI`, submit a chapter and a success story with these inert markers in the free-text
fields — chapter `name`, `type`, `description`, and story `emoji`, `title`, `category`,
`author_name`, `excerpt`:

```
<img src=x onerror="window.__REVIEW_MARKER_2=true">
```

Sign in as `$SUPER` or `$MOD` and **simply open the moderation queue**. Do not click anything.
*Expect:* the payload renders as literal text. `document.querySelectorAll('img[onerror]').length`
is `0` and `window.__REVIEW_MARKER_2` is `undefined`.
*Why it matters:* submitting to the queue *is* the delivery mechanism. No click, no social
engineering — a moderator doing their job by reviewing the item is the trigger, and the queue is
only ever opened in a staff session.
*The fix:* `escapeHtml` on all eight fields in `renderModerationPanel` (`js/admin.js`), with the
emoji field routed through `emojiIcon()` (`js/core.js:139`) so it can never reflect arbitrary text.
*Pass/fail:* any injected element in the staff DOM is **P0**.

**18. Profile rendering.**
*Do:* as `$ALUMNI`, set `job_title` and `current_company` to the marker from scenario 17. As
`$ALUMNI2`, open that member's profile modal from the directory. Separately, on your **own** profile,
set `linkedin`, `github` and `website` to `javascript:window.__REVIEW_MARKER_3=true` and to
`data:text/html,<script>...</script>`, then reload your own profile and click each link.
*Expect:* text renders escaped; the links are either absent or inert.
*Pass/fail:* `safeUrl()` (`js/core.js:97`) resolves the value with `new URL` and returns `''` for
anything that is not `http:` or `https:`. A rendered `href="javascript:..."` is **P1** —
`render10SectionProfile()` interpolated ~34 own-profile fields unescaped before Phase 5F, including
raw `href`, so this area has form.

**19. Go looking for a fourth sink.**
*Do:* grep the front-end for the pattern rather than testing known payloads:
`grep -rn "innerHTML" js/*.js` and `grep -rn "on[a-z]*=\"\${" js/*.js`. For each hit, trace whether
the interpolated value can be set by a non-staff user.
*Expect:* every user-controlled value passes through `escapeHtml`, `jsArg`, `safeUrl` or
`emojiIcon`.
*Pass/fail:* a raw interpolation of a user-settable field is a finding whose severity depends on
who renders it — a staff-portal sink is **P0**, an alumni-portal sink rendered to other members is
**P1**.

---

### Injection

**20. SQL injection.**
*Do:* push classic payloads (`' OR 1=1--`, `'; DROP TABLE users;--`, `1 UNION SELECT ...`,
`%27`, a null byte, a very long string) through every query parameter and every JSON body field you
can reach: `?batch=`, `?search=`, `?dept=`, `?status=`, sort and order parameters, and the free-text
fields of every `POST`/`PUT`.
*Expect:* parameterised queries throughout (`db.query(sql, [params])`), so payloads are stored and
echoed as literal text and nothing executes.
*Pass/fail:* two tells. (a) `SELECT count(*) FROM users` before and after must be unchanged.
(b) A `500` carrying PostgreSQL's own words is a disclosure finding even when injection itself
failed. Pay particular attention to any place a value is interpolated into SQL rather than bound —
`privacy.js` builds `MAP_VISIBLE_SQL` and `DIRECTORY_VISIBLE_SQL` as string fragments, but from
module constants, not from input. Verify that no request-derived value reaches a fragment like those.

**21. Sort- and column-name injection.**
*Do:* any parameter that selects a column or a direction (`?sort=`, `?order=`) is the usual place a
parameterised codebase still concatenates. Try `?order=id; DROP TABLE`, `?sort=(SELECT ...)`.
*Expect:* an allow-list, or a `400`.
*Pass/fail:* a `500` naming a column, or any change in row ordering that implies the value reached
the query, is a finding.

---

### Privacy

Test each of these as **five different viewers**: the owner, another `alumni`, `moderator`,
`dept_admin`, `univ_admin`.

**22. `email` — default `public`, staff bypass true.**
*Do:* set `privacySettings.email = 'private'` on `$ALUMNI`. Read that profile from every viewer, via
`GET /api/alumni`, `GET /api/alumni/:id`, search results, mentorship suggestions, event attendee
lists, chapter member lists, and the DSAR export of a *different* user.
*Expect:* owner sees it; `super_admin`, `univ_admin`, `dept_admin` see it (bypass); `moderator` and
other `alumni` do **not**.
*Pass/fail:* a moderator seeing a private email is **P1** — `moderator` is deliberately absent from
`privacy.STAFF_ROLES`.

**23. `mobile` — default `private`, staff bypass true.**
*Do:* as above, but note the default is already `private`, so an account that has never touched its
settings is the interesting case. Include `GET /api/events/:id/tasks` and the task-assignee payload
specifically: co-assignees' `mobile_number` and `whatsapp_number` leaked to non-staff callers on
three `requireAuth` routes before Phase 5F. The fix made `TASK_SELECT` into `taskSelect(staff)`, so
every call site has to declare the caller's tier.
*Pass/fail:* a phone number reaching a non-staff caller is **P3** at minimum, higher if it is
reachable in bulk.

**24. `location` — three levels, and **no staff bypass at all**.**
*Do:* set `privacySettings.location = 'private'`. Then check: the directory city column; the alumni
map aggregate; `GET /api/mentorships/suggestions`; and any derived signal — in particular the
`matched_city` boolean and its contribution to the match score.
*Expect:* the city is absent for **every** viewer including `super_admin`. `MAP_VISIBLE_SQL` counts
only `location = 'public'`; `DIRECTORY_VISIBLE_SQL` admits anything but `private`.
*Pass/fail:* a bare "matches your city" badge is a disclosure even without the city string, because a
reader who knows their own city learns the other person's. This exact leak was P3-8. An administrator
seeing a private city is a finding *even though* they are staff — the absence of a bypass here is
deliberate (`privacy.js:62-66`).

**25. `SELF_ONLY_FIELDS` — never anyone but the owner.**
*Do:* populate `present_address`, `permanent_address`, `postal_code`, `hometown`. Read the profile as
every other role, and diff the JSON against the owner's view. Check the directory list, the CSV
exports, the attendee export, the planner reports and the vault responses.
*Expect:* those four keys are absent from every response except the owner's own.
*Pass/fail:* a home address reaching any other account — including `super_admin` — is **P1**. There
is no setting that is supposed to expose them and no staff bypass; the API is simply not meant to
return them.

**26. Privacy write-side validation.**
*Do:* `PUT` a privacy settings object containing an unknown field name, an unknown level
(`"email":"friends-only"`), a non-string value, an array, `null`.
*Expect:* `400` with a specific message. The write side is a whitelist by design, because the read
side fails **open** — a gate asking "is this value `'private'`?" reveals the field for any value it
does not recognise.
*Pass/fail:* an unknown key or level being stored is **P2**: it becomes an unrecognised value that
the read gate will treat as visible.

---

### Import, export and file handling

**27. CSV import abuse.**
*Do:* as `$UNIV`, `POST /api/bulk-import` with: 50,000 records; records containing `role`,
`is_admin`, `password_hash`, `token_version` fields; a record whose `email` is another existing
user's address; deeply nested objects; 1 MB strings in each field; the two XSS markers from scenarios
16 and 17 in `name`, `organization` and `designation`.
*Expect:* only the mapped fields are read; `role` is never taken from the file; the duplicate
strategy (`skip` or `update`) behaves as documented; rejected rows are reported rather than silently
dropped; nothing in the payload reaches SQL unparameterised.
*Pass/fail:* an imported account with a role other than `alumni` is **P0**. No request size limit or
record-count cap is a **P3** availability finding — check whether `body-parser`'s default limit is the
only thing standing in the way, and say so if it is.

**28. CSV formula injection.**
*Do:* set a profile field — `full_name`, `organization`, or any free-text field that reaches an
export — to each of:

```
=1+1
+1+1
-1+1
@SUM(1+1)
```

Then export via `GET /api/events/:id/attendees.csv`, `GET /api/dsar/export?format=csv`,
`GET /api/events/:eventId/reports/:type.csv`, and the client-side exports in `js/admin.js`. Open the
result in Excel or LibreOffice.
*Expect (what the code actually does):* the escaping in all three server-side exporters is
`` `"${String(v ?? '').replace(/"/g, '""')}"` `` — RFC 4180 quoting only
(`routes_compliance.js:211`, `routes_events.js:749`, `routes_planner.js`). **There is no
formula-injection neutralisation**: no leading apostrophe, no tab prefix, no allow-list of first
characters. The client-side exports in `js/admin.js:500` and `js/admin.js:869` do not even quote —
they `join(",")` raw values.
*Pass/fail:* this is a known open gap, listed in section 10. Report it, and give your own view on
severity: the consumer is a staff member opening a spreadsheet on a workstation, and the content is
supplied by any member who can edit their own profile.

**29. Web-root exposure.**
*Do:* request, with no authentication: `/.env`, `/db.js`, `/server.js`, `/package.json`,
`/schema.sql`, `/seed.sql`, `/admin-credentials.local.txt`, `/reset-link.local.txt`, `/.git/config`,
`/backups/`, `/routes_v2.js`, `/privacy.js`, and the same paths with `%2e%2e`, double URL-encoding,
`..%2f`, trailing dots, mixed case and a trailing `%00`.
*Expect:* `404` for all of them. Static serving is an **allow-list** (`PUBLIC_FILES` and
`PUBLIC_DIRS`, `server.js:114-117`): only `index.html`, `admin.html`, `styles.css`, `api.js`,
`manifest.json`, two PNGs, `favicon.ico`, and anything under `/js/` and `/assets/`. Dotfiles are
explicitly rejected before the SPA fallback, because `path.extname('/.env')` is `''` and would
otherwise fall through to a `200` app shell.
*Pass/fail:* any `200` here is **P0**. `.env` alone contains `SESSION_SECRET` (forge any session) and
`ENCRYPTION_KEY` (decrypt the identity vault and forge ticket QR codes). Confirm separately that
`BACKUP_DIR` is outside the web root on the deployment you are reviewing.

---

### Infrastructure and configuration

**30. Scheduler authorisation.**
*Do:* call `POST /api/internal/jobs/run` and `GET /api/internal/jobs/run` with: no credential; a
wrong `X-Cron-Key`; a `CRON_SECRET` that is correct but one byte short and one byte long; the
`$ALUMNI`, `$MOD`, `$DEPT` and `$UNIV` tokens; and finally the `$SUPER` token.
*Expect:* `401` with `{"error":"Scheduler credentials required"}` for everything except the correct
secret and a live `super_admin` session. The compare is `timingSafeEqual` after a length check
(`server.js:2700-2702`). Note that `univ_admin` is refused — these jobs delete accounts.
*Pass/fail:* a `univ_admin` or `moderator` being able to run `deletion-purge` is **P1**. Also check
that a *suspended* or *stale-session* `super_admin` is refused (`requireScheduler` checks
`req.staleSession` and `req.suspended` explicitly, `server.js:2708`).

**31. CORS.**
*Do:* send `Origin: https://evil.example` to an API route and inspect
`Access-Control-Allow-Origin`. Then try: `PUBLIC_ORIGIN` with a trailing slash, with different case,
with a `null` origin, with `https://alumni.your-domain.evil.example` (suffix attack), and with no
`Origin` header at all.
*Expect:* the allow-list is exactly `[PUBLIC_ORIGIN, ADMIN_ORIGIN]`, lowercased with a trailing slash
stripped, compared by equality (`server.js:63-73`). A request with no `Origin` is allowed — that is
curl and same-origin traffic, not a browser cross-origin request. `credentials` is `false`.
*Pass/fail:* a reflected arbitrary origin is **P1**. A wildcard `*` in a production configuration is
**P1** — this was the pre-Phase-5E behaviour when the origin variables were unset, which is why the
server now refuses to boot without them.

**32. Host header and portal routing.**
*Do:* request `/` with `Host: <ADMIN_ORIGIN hostname>` and with an arbitrary host. Request `/admin`.
Request `/anything-else` on both hosts. Check which shell is returned and which security headers come
with it.
*Expect:* the admin host and `/admin` serve `admin.html` with `X-Robots-Tag: noindex, nofollow`,
`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. The public host serves
`index.html` with `X-Frame-Options: SAMEORIGIN`.
*Pass/fail:* the staff portal being framable is a real risk here — it is the one surface where a
clickjacked click provisions accounts. Also confirm no security decision anywhere depends on `Host`:
the reset-link builder was changed to use `PUBLIC_ORIGIN` for exactly this reason.

**33. Rate-limit evasion via `X-Forwarded-For`.**
*Do:* against a deployment with **`TRUST_PROXY` unset** (the default), send 32 wrong passwords for one
account, rotating `X-Forwarded-For` on each request. Then set `TRUST_PROXY=1` with nothing actually in
front of the port and repeat.
*Expect:* with `TRUST_PROXY` unset, `req.ip` is the socket address and the throttle holds — the
per-account limit is 5 failures per IP per 15 minutes and the per-IP limit is 20
(`server.js:582-585`). With `TRUST_PROXY=1` and no real proxy, the rotation evades both.
*Why:* a numeric trust-proxy value is a hop **count**, not an allow-list. `proxy-addr` compiles `1`
to "trust the peer, unconditionally", and with nothing in front the peer *is* the attacker. This was
hardcoded to `1` until Phase 5F, and measured: 32 attempts produced **zero** `429` responses, and the
forged address is what the audit trail recorded.
*Pass/fail:* the finding to look for is not the code — it is the **staging and production
configuration**. Check what `TRUST_PROXY` is actually set to on the deployment you were given, and
whether the reverse proxy in front of it appends the real peer (nginx's
`$proxy_add_x_forwarded_for` does). A mismatch between the declared hop count and the real topology
is **P2**.

**34. Durable account lock.**
*Do:* trip the lock on `$ALUMNI` with 5 wrong passwords. Then, from a *different* IP, sign in with the
**correct** password. Wait for the window to lapse and send one more wrong guess, then immediately try
the correct password.
*Expect:* the lock is consulted **before** `verifyPassword` (`server.js:1013` region), answers
identically to an unknown address, and is *set* rather than *extended*. Once a window lapses the
counter restarts, so a wrong guess every 15 minutes cannot chain windows into a permanent lockout.
*Pass/fail:* the owner being unable to sign in with the correct password after the window has lapsed
is **P2** — a denial-of-service on a real account with no administrator unlock path. That was the
pre-Phase-5F behaviour.

**35. Error-text disclosure.**
*Do:* provoke failures: `GET /api/alumni?batch=abc`, malformed JSON bodies, wrong types on every
field, an id far beyond the table, a deliberately broken filter.
*Expect:* a fixed string plus a request id —
`{"error":"Something went wrong handling that request.","requestId":"..."}` — and the same id in the
`X-Request-Id` response header. The real message is logged server-side against that id
(`serverError()`, `server.js:395`).
*Pass/fail:* any PostgreSQL text (`invalid input syntax for type integer`, a relation name, a
SQLSTATE), any stack frame, any file path, any column name reaching the client is **P3** (CWE-209).
41 sites returned raw `err.message` before Phase 5F; check whether any remain, and whether any route
added since bypasses `serverError`.

**36. Response headers and banners.**
*Do:* inspect headers on `/api/health` and on both portal shells.
*Expect:* `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Request-Id` present, and **no `X-Powered-By`** (`app.disable('x-powered-by')`).
*Pass/fail:* note what is *missing* as well: there is no `Content-Security-Policy` beyond
`frame-ancestors 'none'` on the admin shell, no `Strict-Transport-Security` set by the application,
and no `Permissions-Policy`. Given the three un-pinned CDN scripts, the absence of a script-src CSP
is worth its own finding.

---

### Identity vault and audit

**37. Vault behaviour.**
*Do:* with `ENCRYPTION_KEY` unset, attempt `POST /api/vault` and `POST /api/vault/:id/reveal`. With
the key set, reveal a field with no `reason`, with a 3-character reason, and with a valid reason. Then
change `ENCRYPTION_KEY` and try to reveal the same row.
*Expect:* with no key, `503` — the vault refuses to store rather than silently saving plaintext. A
reveal requires a reason of at least 5 characters, writes a row to `vault_access_logs`, and writes an
audit entry that names the vault id, field type and user id but **not** the plaintext or the reason.
Changing the key produces a GCM auth-tag failure and a `500` with a generic integrity message.
*Pass/fail:* plaintext appearing in `audit_logs`, or a reveal succeeding without a
`vault_access_logs` row, is **P1**. Confirm that `dept_admin` and `moderator` cannot reach `/api/vault`
at all — it is `ADMIN_ROLES`.

**38. Vault key rotation.**
*Do:* look for a key id or key version column on `identity_vault`.
*Expect:* there is none. Every row is encrypted under the single current `ENCRYPTION_KEY`.
*Pass/fail:* this is an **operational constraint**, not a vulnerability: there is no zero-downtime
rotation path. Rotating the key requires decrypting and re-encrypting every row in a maintenance
window, with a real risk of losing data if it is done wrong. Assess it as such and say whether you
think the risk is being carried appropriately.

**39. Audit-chain tampering — and what the verifier will not catch.**

*Do, part one (what it does catch):* run `npm run verify-audit-chain` and note the clean baseline (it
passed through 2,832 entries at Phase 5F; the verifier prints the current count). Then, with direct
database access, modify the `description` of one entry in the current segment — do not touch its
hash. Re-run the verifier.
*Expect:* the verifier fails with a non-zero exit and names the first entry whose recomputed hash does
not match. It never writes, and is safe to run against any database including production.

*Do, part two (what it does NOT catch):* modify the same entry, then recompute the hash for that
entry **and every entry after it**, updating `audit_chain.head_hash` to match. Re-run the verifier.
*Expect:* **it verifies clean.**

*Why:* the chain is hashed with **unkeyed SHA-256** —
`crypto.createHash('sha256')` at `audit_chain.js:99`, not `createHmac`. The digest input is public
information, so anyone with database WRITE access can recompute the whole chain. It detects accidental
corruption and naive single-row tampering. **It is not tamper-proof and must never be described as
such.** Append-only is enforced by application convention — every writer appends — and *not* by a
database trigger, a rule, or a revoked `UPDATE`/`DELETE` grant on `audit_logs`.

*Also expect:* two historical segments (chain versions 0 and 1, roughly 773 and 101 entries) are
permanently unverifiable, because the original digest input was never persisted. The verifier reports
them as superseded segments with a stated reason rather than pretending otherwise. `AUDIT_CHAIN.md`
sets out exactly this, including that a row can be *added* to a historical segment undetectably.

*Pass/fail:* the honest question for you is not "can the chain be forged" — the team already says yes.
It is: **is anything in the deployment relying on the audit log as though it were tamper-proof?** A
compliance claim, a DSAR response, a disciplinary process. If so, that reliance is the finding.
Related: check that database credentials in production are least-privilege, and whether an application
role with only `INSERT` and `SELECT` on `audit_logs` would be a proportionate fix.

**40. Authentication events in the audit log.**
*Do:* sign in successfully, fail a sign-in, and sign in to a non-existent address. Read
`GET /api/audit-logs` as `$SUPER`.
*Expect:* `Signed In` (`server.js:772`) and `Sign-In Failed` (`server.js:738`) entries, recorded **by
user id and never by the address typed**.
*Pass/fail:* if the typed address appears, the audit log has become the account-enumeration oracle
that the `401` response deliberately avoids being — report it. Also confirm the recorded IP: with a
misconfigured `TRUST_PROXY`, that field is attacker-chosen (scenario 33).

---

## 7. Evidence collection

For every finding, capture all of the following. A finding without a reproduction a developer can run
will be triaged slowly, or not at all.

**1. The request, in full.** Method, path, every header including `Authorization` (redact the token
body, keep the first 8 characters so it can be correlated), and the exact body. A `curl` command is
ideal because it is directly runnable.

**2. The response, in full.** Status line, all headers, and the body. **Always include
`X-Request-Id`.** Every response carries one, and the server logs failures against it
(`serverError()` writes `[tag] <correlationId> <message>`), so a request id lets an engineer find
your exact failure in the server log without guessing from a timestamp.

**3. The code path.** File and line for the route handler, the guard, and the specific line you
believe is wrong — for example `server.js:1942` for `POST /api/bulk-import`, or
`js/admin.js:renderModerationPanel` for a rendering sink. Quote no more than the few lines that
matter.

**4. The account used.** Which of the section 3 accounts, its role at the time, and whether the
session was fresh, stale, suspended, or in the `must_change_password` state. If you promoted an
account in SQL to get there, include the statement.

**5. Timestamps.** UTC, to the second, for the request and for any resulting database or log change.
Say which timezone the deployment's `NOW()` is returning.

**6. A reproduction.** A numbered sequence starting from a clean database:
register → promote → seed the data → send the request → observe. Where the effect is in the browser,
give the exact DevTools check (`document.querySelectorAll('img[onerror]').length`,
`window.__REVIEW_MARKER_1`) and the rendered HTML snippet, not just a screenshot.

**7. The database state, where relevant.** A `SELECT` before and after. Several of the scenarios above
turn on this: a route that returns `403` after already writing is still a finding, and only SQL shows
it.

**8. Inert proof-of-concept payloads only.** Markers that set a variable, produce a broken image, or
write a distinctive literal string. **No exfiltration** — no `fetch()` to any host, no image beacon,
no DNS callback, no collaborator domain, no cookie or token read. No payload that deletes, encrypts or
corrupts data. No real person's data as test input. If you believe a finding is only demonstrable with
an exfiltrating payload, describe the mechanism in prose and say why, rather than running it.

**9. Your own severity and your reasoning.** Use section 8, and say plainly where you disagree with
the team's stated position in section 10.

---

## 8. Severity classification

Defined for this system specifically, with an example of each drawn from what Phase 5F actually
found.

### P0 — Fix before the platform is exposed to real users

Complete loss of confidentiality or integrity, or execution in a privileged context. Any of:
code execution in a `super_admin` session; unauthenticated access to member data; any path to a role
the caller was not granted; disclosure of `SESSION_SECRET`, `ENCRYPTION_KEY` or `CRON_SECRET`;
bulk disclosure of identity-vault plaintext.

*Example (P0-2):* stored XSS in the staff moderation queue. Eight alumni-authored fields — chapter
name, type and description, and story emoji, title, category, author name and excerpt — were rendered
into `innerHTML` with no escaping. **Submitting to the queue was the delivery mechanism.** No click
was needed; a moderator opening the queue to review the item executed the payload, in a session that
can provision administrators. Proved live in a `super_admin` session: four injected `<img onerror>`
elements, handler executed.

### P1 — Fix before the next release

Serious disclosure or a broken control, but bounded: it needs a valid session, or a specific action by
a specific role, or it exposes one person's data rather than everyone's.

*Example (P1-4):* the bulk-import shared password. Every account in an import batch got the same
initial password, and `must_change_password` was advisory only — the client prompted, the API did not
care. So every recipient of that one password held a working credential for **every other account in
the batch**, and dormant imported accounts (most bulk-imported alumni never sign in) stayed takeable
indefinitely. The fix made the flag load-bearing server-side, in `requireAuth` and `requireRole`, with
exactly three permitted paths.

### P2 — Fix on the current work plan

A control that does not do what it claims, a denial-of-service against legitimate users, or a
configuration that is only safe by accident of the current topology.

*Example (P2-5):* the durable account lock was checked **after** `verifyPassword`. A guessing loop
only ever produces wrong passwords, so it never reached the check — the counter climbed past 400 and
every attempt still got a full scrypt verification. Meanwhile `failed_login_count` was monotonic, so
once an account was locked, one wrong guess every fifteen minutes re-armed the lock forever, with no
administrator unlock path. It throttled nobody and denied service to the real owner.

### P3 — Fix when the area is next touched

Information disclosure that assists an attacker without being one; hardening gaps; defence in depth;
inconsistencies that will become defects later.

*Example (P3-7):* 41 sites returned raw exception text to any authenticated caller.
`GET /api/alumni?batch=abc` returned PostgreSQL's own words —
`invalid input syntax for type integer: "NaN"`. Nothing is directly exploitable from that string, but
it maps the schema and the driver for anyone probing.

### Notes on applying these

- **Who renders it decides the class for XSS.** A sink in the staff portal is P0 because the viewing
  session is privileged. The same code in the alumni portal, rendered to peers, is usually P1.
- **Aggregate disclosures escalate.** One member's private mobile number is P3. A directory endpoint
  returning every private mobile number is P1.
- **Configuration counts.** A control that is correct in code but disabled or misconfigured on the
  deployment you were given is a finding against the deployment, at the severity the missing control
  warrants. Say which it is.

---

## 9. Retest procedure

Run all four steps for every fix. A fix that passes the reviewer's own proof of concept but breaks a
suite is not a fix.

### 1. The full suite

```bash
node server.js &                      # or against your staging origin
TEST_BASE=http://localhost:8123 npm test
```

Runs 21 suites in sequence (`tests/run-all.js`) and reports one total. The baseline at Phase 5F is
**1,520 checks, 0 failures**. Every suite needs a running server and the development database; suites
that create accounts remove them, and none deletes an audit entry.

Any non-zero failure count, or a suite reporting `NO SUMMARY LINE`, is a regression. Note that
`tests/crossref.js` is a source-consistency checker, not an HTTP suite — it caught BUG-13, an
unconditional `renderNewsFeed()` call in `js/admin.js` that threw `ReferenceError` in the staff
portal because `admin.html` does not load `js/news.js`. It had been invisible because the checker
stripped quoted strings across the whole file at once, so one unbalanced apostrophe shifted every
pair after it and a single "string" spanned hundreds of lines. The stripper now works one line at a
time — worth knowing, because a tool that silently blanks the code it is checking is a category of
failure you should look for elsewhere.

### 2. The security smoke suite

```bash
TEST_BASE=http://localhost:8123 node tests/security_smoke.js
```

**109 checks across 14 sections** (A through N):

| | Section |
|---|---|
| A | Every non-public route refuses an anonymous caller — routes parsed from source, so new routes are covered automatically |
| B | An ordinary member cannot reach the staff surface |
| C | A member cannot raise their own role; token forgery |
| D | One member cannot act on another member's records (IDOR) |
| E | Injection payloads reach no query |
| F | Untrusted text cannot become code in another session |
| G | CORS is an allow-list |
| H | Each host serves its own portal |
| I | The login throttle cannot be walked around — including the forged `X-Forwarded-For` |
| J | A session really ends — sign-out, revocation, forgery |
| K | Privacy settings are enforced by the server |
| L | Bulk import is safe, and its shared password is enrolment-only |
| M | Only the scheduler can run the jobs |
| N | Failures and headers say nothing useful to an attacker; web-root exposure |

It is self-contained: it registers its own accounts, promotes throwaway ones to staff roles directly
in the database, and deletes everything at the end — the last check confirms the cleanup
(`every account this suite created was removed`). Exit status is `0` on success, `1` on any failed
check, `2` on a harness error.

**If you write a new proof of concept, the right home for it is a new section in this file.** A
finding that ends up as a permanent check is worth more than one that ends up in a PDF.

### 3. The audit chain

```bash
npm run verify-audit-chain
```

Exit `0` means the current segment holds. Baseline: 2,832 entries at Phase 5F. Remember what this does
and does not prove — see scenario 39. Run it *after* any fix that touches `audit_chain.js`,
`writeAudit`, or any migration, because a schema change that alters the canonical payload silently
breaks every recomputation from that point on. That is exactly how chain version 1 came to exist.

`node verify_audit.js --database <name>` verifies a restored copy instead, and `--json` gives
machine-readable output for a cron.

### 4. Your own proof of concept

Re-run the exact reproduction from your finding, unchanged, against the fixed build. Then vary it: if
the fix escapes one field, try the other seven; if it validates one parameter, try the ones next to
it. Several Phase 5F fixes were structural for this reason — `jsArg()` rather than escaping one
string, `taskSelect(staff)` rather than removing one column — and a fix that only neutralises your
specific payload should be reported back as insufficient.

### 5. Backup and restore drill

If your finding touched the schema, data handling, or the vault:

```bash
npm run backup
node restore.js --drill
```

The drill restores into a disposable database. Never point it at anything live.

---

## 10. What the engineering team already believes is wrong

These are known. They are listed so you do not spend your time rediscovering them, and so you can
instead judge whether the severity the team has assigned is right. Disagreeing with an acceptance
here is a legitimate and useful finding.

### Open gaps — acknowledged, not fixed

**1. No Subresource Integrity on three CDN scripts.** `chart.js@4.4.0`, `qrcodejs@1.0.0` and
`lucide@0.474.0` are loaded from `cdn.jsdelivr.net` in both portals with no `integrity` attribute and
no `crossorigin`. A compromise of jsDelivr or of any of those packages executes attacker code inside a
`super_admin` session. There is also no `script-src` Content-Security-Policy to limit the damage. The
team's position is that this is *hardening* rather than an exploitable defect in the application —
which is true as far as it goes, and does not make the exposure smaller. Fixing it is cheap: pin the
hashes, or vendor the three files into `/assets/` and drop the external origin entirely. **Note that
the team's own documentation refers to two CDN dependencies; there are three.**

**2. The audit chain is unkeyed and append-only by convention.**
`crypto.createHash('sha256')`, not `createHmac`. Anyone with database WRITE access can recompute the
entire chain and the verifier will pass it clean. There is no database trigger and no revoked grant
enforcing append-only. Two historical segments (chain versions 0 and 1) are permanently unverifiable
and documented as such in `AUDIT_CHAIN.md`. This is a **documented, accepted design position** — the
team's own documentation is explicit that the chain is not tamper-proof and says so in the verifier's
header comment. Judge whether that acceptance is compatible with whatever the audit log is being
relied upon for.

**3. The identity vault has no key version.** No key id column on `identity_vault`, so there is no
zero-downtime rotation path. Rotating `ENCRYPTION_KEY` means a maintenance window and a
decrypt-re-encrypt pass over every row. Accepted as an operational constraint.

**4. `dept_admin` is institution-wide.** There is no department scoping in the schema or the guards. A
`dept_admin` sees every department's data. Documented and accepted as a simplification for a
single-institution deployment. It becomes a real defect the moment a second institution is onboarded.

**5. CSV exports carry no formula-injection neutralisation.** All three server-side exporters
(`routes_compliance.js`, `routes_events.js`, `routes_planner.js`) apply RFC 4180 quoting only. The two
client-side exports in `js/admin.js` do not quote at all. A member who sets a profile field to
`=1+1` gets that formula into a spreadsheet a staff member opens. Not yet fixed. See scenario 28.

**6. No request size or record-count cap on `POST /api/bulk-import`.** The route accepts whatever
`body-parser`'s default limit allows, and iterates every record inside a single transaction. Assess
this as an availability question.

**7. No application-level `Strict-Transport-Security`, `Permissions-Policy`, or general CSP.** The only
CSP set is `frame-ancestors 'none'` on the staff portal. TLS termination and HSTS are assumed to be
the proxy's job; verify that assumption against the actual deployment.

**8. The rate limiter is in-process.** `loginAttempts` is a `Map` capped at 10,000 entries. It is lost
on restart and, on a serverless deployment, is per-instance. The durable `locked_until` column on
`users` is the compensating control, and it only counts failures against accounts that exist —
counting against a missing address would leak which addresses are real. Whether that compensation is
adequate on a multi-instance deployment is a fair question to raise.

**9. `admin-credentials.local.txt` exists in the working tree.** It is gitignored and is not served by
the static allow-list, but it is a plaintext credential file living next to the code. The documented
procedure is to transfer the values to a password manager and delete it; that has not happened in the
copy you were given. Treat any values in it as compromised.

### Positions the team holds deliberately — argue with them if you disagree

**10. `POST /api/auth/register` returns `409` for an existing address.** This is an account-enumeration
oracle. The team's position is that it is an oracle only in a system that already shows every
signed-in member the full directory — the information is not secret in this product — and that a
silent "we've sent you an email" flow on a college alumni portal produces more support load than it
prevents attacks. `login` and `forgot-password` are both enumeration-resistant; `register` is not, on
purpose. Contrast this with the audit log, which records sign-in failures by **user id and never by
the typed address**, specifically so it does not become the oracle the `401` avoids being.

**11. `location` has no staff bypass, and this is intentional.** `email` and `mobile` can be seen by
`super_admin`, `univ_admin` and `dept_admin` regardless of the member's setting. `location` cannot be
seen by anyone but the owner when set to `private` — no exceptions, no role. The reasoning
(`privacy.js:62-66`) is that an administrator who needs a regional view should get an explicit,
role-scoped, audited report rather than an implicit exemption nobody set out to grant.

**12. Street address, permanent address, postal code and hometown are not user-settable privacy
fields.** Not an omission — a refusal. The only levels that could be offered are "self only" and
"share my home address with every member", and the second has no legitimate use in an alumni directory.
They are self-only unconditionally, with no staff bypass either.

**13. There are no cookies, so there is no CSRF defence.** The session is a bearer token in a header
and `cors` runs with `credentials: false`. This is the correct conclusion *given the premise*; the
thing worth testing is the premise, not the conclusion.

**14. `GET /api/internal/jobs/run` exists alongside the `POST`.** A `GET` that deletes accounts is
unusual, and it is there because some cron providers only issue GETs. It is guarded identically. If
you think the GET should go, say so.

**15. Seeded accounts ship with a `LOCKED$` sentinel.** A fresh database has no working credential at
all until `rotate_credentials.js` runs. This is deliberate — the predecessor shipped a shared weak
password that was also printed in the README — and it means a first-time deployment appears broken
until the operator runs the script. That trade is accepted.

---

*Prepared as part of the DIC Alumni Platform security-review package. Every code reference in this
document is to the repository as delivered; line numbers will drift as the code changes, so treat them
as pointers rather than addresses.*
