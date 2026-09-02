# DIC Alumni Platform — Security Review Package

**Repository:** `E:/Daffodil` · **Branch reviewed:** `feat/events-tickets-v5` · **Prepared:** September 2026

This is the orientation document. It describes what the system is, where the trust boundaries sit, what data it holds, which controls exist and what those controls do *not* cover. It is written for a reviewer who has never seen the codebase. Every claim below was read out of the source at the file and line references given; where the code does not do something, this document says so rather than describing an intention.

Nothing here asserts that the platform is secure. It states what is implemented, what is verified, and what is knowingly unfinished.

---

## A. ARCHITECTURE

### A.1 Frontend

A vanilla-JavaScript single-page application. No framework, no bundler, no build step, no transpiler. HTML pages load classic `<script>` tags in order and everything shares one global scope.

- Two shells: `index.html` (alumni site) and `admin.html` (staff portal), 52 KB and 37 KB respectively.
- Shared logic lives in `js/*.js` — `core`, `auth`, `navigation`, `dashboard`, `directory`, `profile`, `events`, `jobs`, `donations`, `mentorship`, `chapters`, `news`, `notifications`, `admin`, `administration`, `compliance`, `operations`. The two portals load *different subsets of the same files*; there is no second copy of the code.
- `api.js` is the HTTP client. It reads and writes the session token in `localStorage` (`api.js:11`, `api.js:14`), wrapped in `try/catch` for private-browsing mode.
- Rendering is `innerHTML` string templating throughout. There is no virtual DOM and no automatic escaping, so output encoding is entirely manual — see §D.5.
- Three third-party scripts are loaded from `cdn.jsdelivr.net` with **no Subresource Integrity attribute**: `chart.js@4.4.0`, `qrcodejs@1.0.0` and `lucide@0.474.0` (`index.html:30-31,908`; `admin.html:31-32,715`). Google Fonts is preconnected. See §G.3.

### A.2 Backend

Express 5 on Node, PostgreSQL 16.14. Five runtime dependencies only: `express`, `body-parser`, `cors`, `pg`, `nodemailer` (`package.json`).

| File | Lines | Responsibility |
|---|---|---|
| `server.js` | 2,901 | Middleware stack, auth, RBAC, alumni/profile/directory/import/stats/scheduler routes |
| `routes_events.js` | 1,493 | Events, ticket types, registrations, tasks, event people |
| `routes_v2.js` | 762 | Donations, mentorships, connections, identity-vault crypto, audit writer |
| `routes_compliance.js` | 315 | Consent, identity vault endpoints, DSAR export, deletion requests |
| `routes_planner.js` | 282 | Generic staff-only CRUD factory for eleven event planner sub-modules |
| `routes_admin_users.js` | 275 | Administrator provisioning and role changes |
| `audit_chain.js` | 340 | Canonical audit digest, append, verify |
| `jobs.js` | 257 | Three scheduled jobs and their run ledger |
| `restore.js` / `backup.js` | 193 / 183 | `pg_dump` backup, restore drill |
| `location.js`, `privacy.js`, `db.js`, `mailer.js`, `verify_audit.js`, `rotate_credentials.js` | 176 / 189 / 122 / 157 / 139 / 175 | Supporting modules |

Route modules are mounted at `server.js:2639-2665`, after the core middleware and the auth routes, and receive the guards (`requireAuth`, `requireRole`, role constants, `writeAudit`, `serverError`) by injection rather than re-implementing them.

### A.3 Database

PostgreSQL, connected through a single `pg.Pool` in `db.js`. One `query()` export; every caller goes through it. `db.js` also parses `.env` itself (there is no `dotenv` dependency) and honours `DIC_SKIP_DOTENV=1`, which exists so the production fail-closed behaviour can be tested on a machine that has a `.env` file.

Schema is a base file plus thirteen numbered migrations (`schema.sql`, `schema_v2.sql` … `schema_v13.sql`, each with a matching `migrate_vN.js`). Migrations are additive: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`. No migration drops a column that holds data.

**There are no database triggers and no `GRANT`/`REVOKE` statements anywhere in the schema files.** The application connects as one role with full rights to its own database. Every integrity property described in this document — audit append-only in particular — is an application convention, not a database constraint.

### A.4 Admin portal

One Express app serves both portals. `wantsAdminPortal(req)` (`server.js:2856`) decides which HTML shell to send:

1. path matches `/^\/admin(\/|$)/`, or
2. hostname begins `admin.`, or
3. hostname equals the hostname of `ADMIN_ORIGIN` — compared as a *hostname*, parsed with `new URL()` (`originHost`, `server.js:2846`). This was previously `adminOrigin.includes(host)`, a substring test that matched the public alumni domain against `admin.alumni.<domain>` and served the staff shell on the public site.
4. When `ADMIN_ORIGIN` and `PUBLIC_ORIGIN` resolve to the same hostname (single-host deployments), the host check is disabled and only the path distinguishes the portals.

The staff shell additionally receives `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (`server.js:82-100`). The alumni shell receives `X-Frame-Options: SAMEORIGIN`. Both receive `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

**Which shell is served is a routing decision, not an authorisation decision.** See §B.6.

### A.5 Authentication

HMAC-SHA256 bearer token in the `Authorization` header. **No cookies exist anywhere in this system** — `grep` for `cookie`/`Set-Cookie` across `server.js`, all route modules and the client returns only comments explaining their absence.

- Format: `base64url(JSON payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))` — `signToken`, `server.js:273`.
- Payload carries `uid`, `role`, `tv` (token version), `exp`. No JWT library; no `alg` field, therefore no algorithm-confusion surface.
- `verifyToken` (`server.js:279`) recomputes the MAC, compares with `crypto.timingSafeEqual` after a length check, then rejects on `exp < Date.now()`.
- `SESSION_TTL_MS = 12 hours` (`server.js:245`), stamped into `exp` at mint time and enforced on every verification.
- Passwords: `crypto.scryptSync(plain, salt, 64)` at Node's defaults (N=16384, r=8, p=1) with a 16-byte random hex salt, stored as `scrypt$<salt>$<derived>` (`hashPassword`, `server.js:250`). Comparison is `timingSafeEqual` (`verifyPassword`, `server.js:256`).
- A `LOCKED$` sentinel is rejected before any comparison, and is the column default (`schema.sql:17`), so a row inserted without an explicit hash can never be signed into. Seeded accounts ship unusable until `rotate_credentials.js` sets a real password.
- Legacy plaintext rows are still accepted once (constant-time compared) and transparently re-hashed on the next successful login (`server.js:756`).

**Revocation.** `users.token_version` (`schema_v8.sql:18`, default 1). The token carries the version it was minted at; `attachUser` compares it to the row on every request. The column is incremented on sign-out (`server.js:1053`), password change, password reset (`server.js:1027`) and suspension. A token minted at an older version fails and the caller receives 401 `STALE`.

**`attachUser` (`server.js:310`, mounted at `server.js:352`)** re-reads `id, role, status, token_version, must_change_password` from the `users` row on **every** request. Consequences:

- The role in the token is a hint only; the role used for authorisation is the one in the database.
- A deleted account's outstanding token is inert immediately (zero rows → `req.user = null`).
- A suspension takes effect on the next request, not at token expiry.
- On a database exception the `catch` sets `req.user = null` — it **fails closed** rather than falling back to the token's asserted role.

### A.6 Authorisation

Five roles, constrained by a `CHECK` on `users.role` (`schema.sql:20`): `super_admin`, `univ_admin`, `dept_admin`, `moderator`, `alumni`.

Three constants at `server.js:445-447` are the only place permissions are defined; `GET /api/stats/rbac` derives the displayed matrix from the same constants, so the screen cannot disagree with the middleware.

```
SUPER_ONLY      = [super_admin]
ADMIN_ROLES     = [super_admin, univ_admin]
MODERATOR_ROLES = [super_admin, univ_admin, dept_admin, moderator]
```

Route census, counted from source across `server.js` and the five route modules:

| Guard | Routes |
|---|---|
| `requireAuth` | 63 |
| `requireRole(...MODERATOR_ROLES)` | 41 |
| `requireRole(...ADMIN_ROLES)` | 20 |
| `requireRole(...SUPER_ONLY)` | 7 |
| `requireScheduler` | 2 |
| public by design | 5 |
| **Total route declarations** | **138** |

The five public routes are `GET /api/health`, `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` (`server.js:534, 656, 793, 948, 1003`). There are no others.

`dept_admin` is **institution-wide**: there is no department scoping anywhere in the query layer. See §G.4.

### A.7 Scheduler

`POST` and `GET /api/internal/jobs/run` (`server.js:2743-2744`), both behind `requireScheduler` (`server.js:2705`). Two acceptable credentials:

1. `CRON_SECRET`, presented as `X-Cron-Key` or `Authorization: Bearer <secret>`, compared with `timingSafeEqual` after a length check.
2. A live `super_admin` session, as resolved by `attachUser`.

Failure is a flat 401 with no indication of which credential was missing or whether the named job exists. Both verbs exist because Vercel Cron issues `GET` while a crontab `curl` line may issue either.

Three jobs (`jobs.js`): `event-maintenance` (advance event statuses, send task-deadline reminders), `deletion-purge` (erase accounts past the 30-day grace), `mentorship-expiry`. **There is no in-process timer.** If no external cron calls the endpoint, no job ever runs — including the deletion purge, which is the platform's erasure promise. Every run is written to `ops_runs` and surfaced at `GET /api/ops/status` (ADMIN_ROLES).

### A.8 Backups

`backup.js` shells out to `pg_dump` (`--no-owner --no-privileges --clean --if-exists`), captures stdout and writes `dic_alumni_<timestamp>.sql` into `BACKUP_DIR` (default `./backups`, which the documentation states must be moved outside the web root in production). Retention 14 days, `BACKUP_RETENTION_DAYS`. The directory is created `0o700` and the file `chmod`ed `0o600`, best-effort — both are no-ops on Windows.

The dump is **plain SQL: not compressed and not encrypted**. It contains every plaintext field in the database — names, emails, mobile numbers, home addresses — plus the identity-vault ciphertext, IVs and auth tags. It does not contain `ENCRYPTION_KEY`. A small `last-backup.json` receipt is written alongside and read back by `GET /api/ops/status`; an age over 36 hours is reported as `stale`.

`restore.js --drill` restores a dump into a disposable database so the restore path is exercised rather than assumed.

`.gitignore` excludes `.env`, `*.env`, `backups/`, `*.sql.gz`, `*.csv` (except the import template), `admin-credentials.local.txt`, `*credentials*.local.txt` and `*reset-link*.local.txt`.

### A.9 Audit chain

`audit_logs` is a hash chain. `audit_chain.js` is the single definition of the digest; both the writer and the standalone verifier consume it, so the two cannot drift.

- Canonical payload is a **JSON array** (no key ordering to get wrong) of: `CHAIN_VERSION`, `prevHash`, `canonicalTimestamp(createdAt)`, `action`, `meta`, `actorRef`, `targetType`, `targetId`, `ip`, `icon` (`audit_chain.js:79`).
- Digest is **`crypto.createHash('sha256')` — unkeyed** (`audit_chain.js:96`). This is the single most important honesty point in this package; see §G.1.
- Timestamps are generated by the application at millisecond precision and inserted explicitly, because a Postgres-generated `timestamptz` keeps microseconds that `toISOString()` would discard, making recomputation impossible.
- The digest hashes `actor_ref` (a plain integer column, `schema_v12.sql:33`), never `actor_id` (a foreign key declared `ON DELETE SET NULL`, which the database is entitled to rewrite when an account is erased). That distinction is what made chain version 1 unverifiable.
- Appends take `SELECT … FOR UPDATE` on the single-row `audit_chain` table before reading the head (`schema_v11.sql:52`), which serialises concurrent writes and keeps the head pointer in step with the last row.
- `writeAudit` swallows its own errors — an audit failure must never fail the request. Values are clamped to their column widths first (`clamp`, `audit_chain.js:70`) because a 65-character forged `X-Forwarded-For` used to overflow `audit_logs.ip VARCHAR(64)`, dropping the entry silently while the audited action succeeded.
- Two historical segments are permanently unverifiable and are reported as such rather than skipped: chain v0 (773 entries, digest consumed an in-memory timestamp that was never persisted) and chain v1 (101 entries, digest included the nullable `actor_id`). Documented in `AUDIT_CHAIN.md`.
- `verify_audit.js` reads rows directly from the database, needs no HTTP and no session, never writes, and can be pointed at a restored backup with `--database`. Exit 0 = chain holds, 1 = broken, 2 = could not run. The Phase 5F run passed through 2,832 entries, exit 0.

### A.10 Request lifecycle — one authenticated API call

What actually happens to `GET /api/events/42/tasks` with a valid bearer token, in the order the middleware is registered in `server.js`. This is the real order read from source; note in particular that CORS runs *before* the security headers and the correlation id, and that the correlation-id logger is scoped to `/api/`.

| # | Stage | Location | What it does |
|---|---|---|---|
| 0 | TLS terminator / reverse proxy | outside this codebase | Terminates TLS. Whether its `X-Forwarded-For` is believed is decided by `TRUST_PROXY` |
| 1 | `app.disable('x-powered-by')` | `server.js:22` | Removes the `X-Powered-By: Express` banner from every response |
| 2 | `app.set('trust proxy', TRUST_PROXY)` | `server.js:51` | **Defaults to `false`.** Unset means the socket peer is `req.ip` and no forwarded header is believed |
| 3 | `cors(...)` | `server.js:66` | Allow-list of `PUBLIC_ORIGIN` and `ADMIN_ORIGIN` when either is set; `credentials: false`. With neither set, permissive (development only — production refuses to boot without both) |
| 4 | `bodyParser.json()` | `server.js:74` | Parses the JSON body |
| 5 | Security headers | `server.js:82` | `nosniff`, `Referrer-Policy`; then the admin-portal or alumni framing headers per `wantsAdminPortal()` |
| 6 | Static allow-list | `server.js:121` | `/api/*` passes straight through. Otherwise: reject `..`, reject any dot-segment (so `/.env` 404s instead of falling through to the SPA), reject `/backups`, `/node_modules`, `/ops`, `/api/index`; extensionless paths fall through to the SPA; anything with an extension must be in `PUBLIC_FILES` or under `/js/` or `/assets/` with an allowed extension |
| 7 | `express.static(__dirname, { index:false, dotfiles:'deny' })` | `server.js:148` | Serves the allow-listed files only |
| 8 | Correlation id + request log | `server.js:160` | `/api/` only. 6 random bytes → `req.correlationId`, echoed as `X-Request-Id`. On `finish`, logs timestamp, id, method, **path only**, status, duration, uid-or-anon. Deliberately never logs the body, the `Authorization` header, or the query string (a reset link arrives as `?reset=<token>`) |
| 9 | `attachUser` | `server.js:352` | Verifies the MAC and `exp`, re-reads the user row, applies revocation / deletion / suspension, sets `req.user`, `req.mustChangePassword`. Never rejects; fails closed on a database error |
| 10 | `app.param` numeric guards | `server.js:420` | `id`, `userId`, `taskId`, `personId`, `ttId`, `eventId`, `itemId`, `vaultId` must match `/^\d+$/` or the request is 400. `id` is exempted on `/api/custom-fields` because `custom_fields.id` is a varchar key |
| 11 | `requireAuth` / `requireRole` | `server.js:423` / `431` | Suspended → 403; stale session → 401; no user → 401; enrolment-gated → 403; role not in the list → 403 |
| 12 | Handler | `routes_events.js:883` | Runs the query. Non-staff callers are narrowed to tasks they are assigned to, and `taskSelect(isStaff(req.user))` decides whether contact columns are selected at all |
| 13 | `serverError` on throw | `server.js:394` | Logs `[tag] <correlationId> <message>` server-side and returns a fixed string plus `requestId`. The exception text never reaches the browser |
| 14 | `/api` catch-all | `server.js:2810` | Unknown API paths 404 as JSON, never as the SPA shell |
| 15 | Static 404 / SPA fallback | `server.js:2818` / `2872` | A missing file with a known extension 404s; everything else gets the correct portal shell |

---

## B. TRUST BOUNDARIES

### B.1 Browser ↔ API

**Crosses:** JSON request bodies, query strings, route parameters, the `Authorization: Bearer` header, the `Origin` header.
**Trusted:** nothing from the client except a token whose HMAC verifies — and even then only the `uid` and `exp` fields. `role` in the token is discarded and re-read from the database.
**Validated:** MAC and expiry (`verifyToken`), token version and account status (`attachUser`), numeric route parameters (`app.param`), `?batch` numeric check, per-handler field validation, privacy levels against a whitelist (`privacy.validateSettings` — an unknown field or level is refused outright rather than stored and ignored).
**Not validated:** there is no global body schema validator and no request-size limit beyond `body-parser`'s default. Handlers validate the fields they use; a field a handler does not read is simply ignored.

### B.2 API ↔ Database

**Crosses:** parameterised SQL and its results.
**Trusted:** the database is trusted to return what was stored. The application holds one role with full rights over its own database.
**Validated:** all caller-supplied values travel as `$n` placeholders. The only string interpolation into SQL is of server-defined identifiers — the planner CRUD factory's `table` and `columns` map (`routes_planner.js:19`), `SELECT_ADMIN`, `EVENT_SELECT`, `TASK_JOINS`, `taskSelect(staff)`, the `sets` array built from an allow-list of column names in `routes_admin_users.js:152`, and the privacy SQL fragments. No caller-controlled string reaches an SQL identifier position.
**Boundary weakness to note:** because the application role can write anything, every guarantee about the audit chain is bounded by that fact (§G.1).

### B.3 API ↔ SMTP

**Crosses:** password-reset emails only (`mailer.js`). One provider, one template, no queue, no retry.
**Trusted:** the SMTP provider is trusted with the recipient address, the recipient's name and a live reset token.
**Validated:** `MAIL_TRANSPORT` must be explicitly `smtp`, `console` or `none` in production — silence is not accepted, because an unset value used to fall through to `console` and print every reset link into a log file while appearing healthy. Port 465 is implicit TLS, everything else negotiates STARTTLS. Connection, greeting and socket timeouts are set.
**Deliberate behaviour:** the send result is awaited but ignored, and `/api/auth/forgot-password` returns an identical acknowledgement in all cases. A mail outage must not become a way to test which addresses exist. The reset URL is built from `PUBLIC_ORIGIN`, not from the request's `Host` header, so a caller cannot have a link minted that points at their own server.

### B.4 API ↔ Filesystem

**Crosses:** `.env` (read at boot by `db.js`), `schema.sql`/`seed.sql` (read by the re-seed endpoint), `BACKUP_DIR/last-backup.json` (read by `/api/ops/status`), and the static files served to browsers.
**Trusted:** the filesystem is fully trusted. Anyone who can write `.env` owns the platform.
**Validated:** the static allow-list (§A.10 step 6) is the boundary that matters here. The repository root *is* the web root, so before that allow-list existed `express.static(__dirname)` served `.env`, `admin-credentials.local.txt`, `db.js`, every `routes_*.js` and the SQL schema to any anonymous caller. Today only an explicit file list plus `/js/` and `/assets/` with allowed extensions are reachable, dot-segments 404, and `/backups`, `/node_modules` and `/ops` 404 whether or not the path has an extension.

### B.5 Cron ↔ API

**Crosses:** a `CRON_SECRET` bearer or `X-Cron-Key` header and an optional `job` name.
**Trusted:** a caller holding the secret can run any of the three jobs, including `deletion-purge`, which erases accounts. There is no source-IP restriction.
**Validated:** constant-time secret comparison; production refuses to boot with a `CRON_SECRET` shorter than 32 characters. Jobs are idempotent by design, so a doubled cron or an operator retry causes no harm. Every run is recorded in `ops_runs` with its source (`cron` or `manual`).

### B.6 Staff portal ↔ alumni portal — *not* a security boundary

Both shells are served by the same Express app, call the same API on the same origin, and load **the same JavaScript files**; they differ only in which modules each HTML page includes. Serving `admin.html` grants nothing: every privileged route is guarded by `requireRole` server-side, and `attachUser` re-reads the role from the database on each request. A user who fetches `/admin` with an alumni token gets the staff shell and 403s from all 68 role-guarded routes.

The portal split is therefore a **product and exposure decision**, not an access-control one: it keeps staff functionality out of the alumni bundle's reach, lets the staff hostname be `noindex` and frame-denied, and allows the staff surface to be moved to `admin.<domain>` without touching authentication. The host-matching bug described in §A.4 was consequently the wrong page on the right domain, not an authorisation failure — which is exactly why it is worth stating plainly rather than filing as a vulnerability.

### B.7 Uploaded / imported data ↔ admin UI

**Crosses:** everything an alumnus authors — job titles, chapter names and descriptions, story titles, categories, excerpts and emoji, profile fields — plus bulk-import CSV content, all of which is later rendered inside a staff session.
**Trusted:** nothing. This is the boundary Phase 5F found broken in two places (P0-1 and P0-2), and it is the one a reviewer should probe hardest.
**Validated:** every value now passes through `escapeHtml()` before reaching `innerHTML`; values destined for an inline event-handler attribute pass through `jsArg()` instead; `href` values pass through `safeUrl()`; emoji route through `emojiIcon()`, which maps a known character to a Lucide icon name and silently drops anything unmapped. See §D.5 for why `escapeHtml` was the wrong tool in an attribute and why it looked like the right one.
**Not covered:** there is no Content-Security-Policy restricting `script-src` on either portal — only `frame-ancestors 'none'` on the staff portal. Inline `onclick` handlers are the dominant idiom, so a script-src CSP would require rewriting the event model. This means output encoding is the only layer standing between authored content and script execution.

### B.8 One member's data ↔ another member's session

**Crosses:** directory listings, profile views, the alumni map, mentorship suggestions, event task assignee lists, job applicant lists.
**Trusted:** nothing about the caller except their authenticated `uid` and their database-resident role.
**Validated:** `privacy.js` is the single source of truth and is enforced in SQL (`DIRECTORY_VISIBLE_SQL`, `MAP_VISIBLE_SQL` at `server.js:1137-1168, 1498-1505, 2384-2410` and `routes_v2.js:545-553`) and in JavaScript (`privacy.canSee`, `server.js:1252-1289`). `SELF_ONLY_FIELDS` are never selected for anyone but the owner. Ownership checks guard mutation on member-authored records — a second member editing, deleting or reading the applicants of another member's job is refused 403 (asserted in `tests/security_smoke.js` section D).
**Not covered — observed:** `taskSelect(staff)` (`routes_events.js:823`) correctly withholds a DIC member's `ap.mobile_number` and `ap.whatsapp_number` from non-staff callers, but the `UNION ALL` branch for **external** contacts returns `p.phone` and `p.whatsapp` unconditionally (`routes_events.js:856-857`). A non-staff alumnus assigned to a task therefore receives the phone and WhatsApp number of any external contact co-assigned to it, on the `requireAuth` routes `GET /api/events/:id/tasks` and `GET /api/events/tasks/:taskId`. This may be intended — a co-assignee plausibly needs to reach a vendor — but it is an asymmetry with the branch immediately above it, and a reviewer should decide rather than assume.

---

## C. SENSITIVE DATA

### C.1 Identity vault — national ID, birth registration, passport

| | |
|---|---|
| **Stored in** | `identity_vault` (`schema_v2.sql:237`): `user_id`, `field_type` CHECK-constrained to `nid`/`brc`/`passport`, `ciphertext`, `iv`, `auth_tag`, `last_four`, `UNIQUE (user_id, field_type)` |
| **Protected by** | AES-256-GCM under `ENCRYPTION_KEY` (64 hex). `encryptField`/`decryptField`, `routes_v2.js:24-40`. Fails closed: with no valid key, `POST /api/vault` returns 503 and refuses to store rather than silently saving plaintext |
| **Who can read it** | Any authenticated user may store their own (`POST /api/vault`, `requireAuth`). The masked list (`GET /api/vault`, ADMIN_ROLES) renders from `last_four` and never decrypts. Decryption is `POST /api/vault/:id/reveal`, ADMIN_ROLES only, and requires a stated reason of at least five characters |
| **Auditing** | Every reveal writes to `vault_access_logs` (vault id, accessor, reason) *and* to the hash chain. The chain entry deliberately omits the operator's free-text reason, which would otherwise put the data subject, the document category and the investigator's narrative into a table every administrator can read |
| **On backup / export** | Ciphertext, IV and auth tag all appear in the `pg_dump`. The key does not. A stolen backup without `ENCRYPTION_KEY` yields no identity numbers — but it does yield `last_four` and `field_type` for every subject |
| **Gap** | There is **no key id and no key version column**. See §G.2 |

### C.2 Mobile and phone numbers

`alumni_profiles.mobile_number`, `alt_mobile`, `whatsapp_number`, `emergency_phone`; `users.phone` (staff contact); `event_people.phone`/`whatsapp` (external contacts).

Privacy field `mobile` defaults to **`private`** and has `staffBypass: true`, so `super_admin`, `univ_admin` and `dept_admin` see it regardless of the member's setting — `moderator` does **not** (`privacy.js:86`, `STAFF_ROLES`). `emergency_phone` and `alt_mobile` are not exposed through the directory or another member's profile view. `event_people.phone` is described in §B.8.

Backups contain all of these in plaintext.

### C.3 Email addresses

`users.email` (unique, the login identifier), `alumni_profiles.primary_email`, `secondary_email`.

Privacy field `email` defaults to **`public`** — meaning visible to signed-in DIC members, since there is no anonymous access to any profile — with `staffBypass: true`. Registration returns 409 for an address that already exists (`server.js:809`), which is an enumeration signal; see §G.6. `POST /api/auth/login` and `POST /api/auth/forgot-password` deliberately do not distinguish.

### C.4 Location

`alumni_profiles.city`, `district`, `place_id`.

The `location` privacy field offers three levels — `public` (visible to members *and* counted on the alumni map), `alumni` (visible to members, not counted), `private` (owner only) — and defaults to `alumni`. **It has no staff bypass at all** (`privacy.js:64`): if a member marks their city private, it is private, and the answer is the same for every role including `super_admin`. The stated reasoning is that a regional view for administrators should be an explicit, role-scoped, audited report rather than an implicit exemption.

Enforced in SQL on the directory, the map aggregates and mentorship suggestions. Phase 5F found `GET /api/mentorships/suggestions` returning `city` ungated, and also had to gate the `matched_city` boolean and its score contribution — a bare "matches your city" discloses the city to any reader who knows their own.

### C.5 Home addresses

`alumni_profiles.present_address`, `permanent_address`, `postal_code`, `hometown` — the `SELF_ONLY_FIELDS` (`privacy.js:84`).

These are **not** user-settable privacy fields, deliberately. The reasoning recorded in `privacy.js` is that the only two levels that could be offered are "self only" and "share my home address with every member", the second has no legitimate use in a college alumni directory, and building a switch nobody should ever move is worse than not building it. No administrator role reads a home address through the API. They are returned only to the owner and in that owner's own DSAR export.

Backups contain them in plaintext.

### C.6 Passwords

`users.password_hash VARCHAR(255) NOT NULL DEFAULT 'LOCKED$no-password-set'`. Also `failed_login_count INTEGER NOT NULL DEFAULT 0`, `locked_until TIMESTAMPTZ`, `must_change_password BOOLEAN`, `last_password_changed_at`, `reset_token_hash VARCHAR(64)`, `reset_expires_at`.

scrypt with a per-row salt (§A.5). Nobody can read a password: there is no endpoint that returns `password_hash`, and `publicUser()` (`server.js:494`) — the only user serialiser — does not include it. Reset tokens are 32 random bytes base64url, stored **only as a SHA-256 hash**, valid 30 minutes, cleared in the same `UPDATE` that sets the new password so they cannot be replayed (`server.js:1010-1030`).

Backups contain the scrypt hashes and the reset-token hashes.

### C.7 Sessions

Stateless. There is no session table. A session exists only as a signed string in the holder's `localStorage` and as a `token_version` integer on the user row.

`localStorage` is readable by any script running on the origin — which is precisely why the XSS findings in §F are rated as severely as they are. There is no `HttpOnly` protection available for this design, because the token is not a cookie.

Backups contain `token_version`, which is not a credential.

### C.8 Audit data

`audit_logs`: `id`, `icon`, `bg_color`, `action`, `meta`, `hash` (the legacy 16-hex truncation, now nullable), `created_at`, plus `actor_id` (FK, `ON DELETE SET NULL`), `target_type`, `target_id`, `ip VARCHAR(64)` (`schema_v7.sql:64-67`), `chain_version`, `prev_hash`, `entry_hash` (`schema_v11.sql`), and `actor_ref` (`schema_v12.sql:33`). Plus the single-row `audit_chain` head table.

Readable at `GET /api/audit-logs`, **ADMIN_ROLES** — `dept_admin` and `moderator` are refused (asserted in the smoke suite). `meta` is free text written by the application; the vault-reveal entry was deliberately narrowed so the subject's document category and the operator's reason do not both sit in a table every administrator can read.

The `ip` column records whatever `clientIp(req)` returned, which is `req.ip` — and therefore reflects `X-Forwarded-For` when `TRUST_PROXY` is set. Backups contain the full audit history, which is exactly what makes an off-site backup the real defence for the chain (§G.1).

---

## D. SECURITY CONTROLS

### D.1 Authentication

**What it does:** HMAC-SHA256 bearer tokens with a 12-hour hard expiry, scrypt password hashing, constant-time comparison of both the signature and the derived key, database-backed revocation via `token_version`, and per-request re-reading of role/status from the users row.
**Where:** `server.js:250-352`.
**What it does not cover:** no multi-factor authentication of any kind. No per-device or per-session revocation — signing out bumps `token_version` and therefore ends *every* session for that account, which is stated as the right default for a staff portal but is a real usability trade. No password-strength policy beyond a minimum of 8 characters. `scryptSync` is synchronous and blocks the event loop (§G.6). Tokens live in `localStorage` and are readable by any script on the origin.

### D.2 Authorisation

**What it does:** three role constants, six guard variants, 133 of 138 routes guarded, role re-read from the database on every request, `SUPER_ONLY` separating platform authority from institutional authority so a `univ_admin` cannot provision other administrators. A `super_admin`'s role cannot be changed through `PUT /api/admin/administrators/:id` at all (`routes_admin_users.js:175`). Role assignment is validated against `ASSIGNABLE_ROLES`.
**Where:** `server.js:423-447`, `routes_admin_users.js`.
**What it does not cover:** roles are flat and institution-wide. There is no per-department, per-chapter or per-event scoping — a `dept_admin` sees every department (§G.4). Object-level ownership is checked inside individual handlers, not by a central policy layer, so each new handler must remember to do it.

### D.3 Rate limiting

**What it does:** two in-process counters keyed on `clientIp(req)` — five failures per (IP, email) pair and twenty failures per IP, both in a rolling 15-minute window with a 15-minute lock and a 10,000-entry cap with oldest-first eviction (`server.js:573-650`). The gate is consulted *before* the database is touched, so a locked-out attacker costs nothing. `POST /api/auth/forgot-password` shares the same counters.

A second, durable lock lives on the row: `failed_login_count` and `locked_until`. Phase 5F moved this check to *before* `verifyPassword` — below it, a guessing loop never reached it (guesses are wrong by definition) while the real owner with the correct password was denied service. The lock is **set, never extended**, and the counter restarts once a lapsed lock is observed, so 15-minute windows cannot be chained into a permanent lockout. A locked account answers identically to an unknown address.

**Where:** `server.js:571-745`.
**What it does not cover:** **only the login and forgot-password endpoints are rate-limited.** The other 136 routes have no throttle at all. The in-process map is per-process: on a restart it is lost, and on a serverless deployment each warm instance keeps its own, so a distributed attacker gets `attempts × instances` before the durable row lock becomes the only backstop. A shared store (a table or Redis) is explicitly out of scope for this pass.

### D.4 Input validation

**What it does:** `app.param` rejects any non-numeric value for eight integer route parameters before it can reach the database; `?batch` is numeric-checked; privacy settings are validated against a whitelist where an unknown key or level is *refused*, not stored-and-ignored; `field_type` on the vault is CHECK-constrained in the schema as well as validated in the handler; required fields are checked per handler; role values are checked against an assignable map; the `--database` flag on `verify_audit.js` must match `/^[A-Za-z0-9_]+$/`.
**Where:** `server.js:406-420`, `privacy.js:105`, handlers throughout.
**What it does not cover:** no declarative schema per route. Unknown body fields are ignored rather than rejected. There is no upload handling in this application at all — no file parser, no multipart — so that class of validation does not arise.

### D.5 Output encoding

**What it does:** three helpers in `js/core.js`, each for a distinct sink.

- `escapeHtml(value)` (`js/core.js:57`) — `& < > " '` for HTML text content.
- `jsArg(value)` (`js/core.js:89`) — `escapeHtml(JSON.stringify(String(v)))`, for a value that will be read back as a **JavaScript string literal inside an inline event-handler attribute**. This exists because `escapeHtml` is actively wrong there and looks right: an attribute value is HTML-decoded by the parser *before* the handler body is compiled as JavaScript, so `&#39;` becomes a live apostrophe and closes the string it was meant to be inside. `JSON.stringify` supplies its own double quotes, which `escapeHtml` then renders unable to close the attribute — hence there are deliberately **no quotes around `${jsArg(x)}`** in the templates. In use at 21 sites across 13 files under `js/`.
- `safeUrl(value)` (`js/core.js:97`) — parses with `new URL()` and returns the href only for `http:` or `https:`; anything else (notably `javascript:`) renders as inert text with no link.
- `emojiIcon(raw, fallback)` (`js/core.js:139`) — maps a stored emoji character to a Lucide icon name; unmapped input falls back silently and never reaches `innerHTML`.

**What it does not cover:** correctness depends on every author picking the right helper at every new call site. There is no linter, no template layer and no CSP `script-src` to catch a miss. `tests/crossref.js` cross-references source but is a text tool, not a taint analyser — and it had its own bug that hid a real defect for months (BUG-13 in §F).

### D.6 SQL parameterisation

**What it does:** every caller-supplied value is bound as `$n`. Verified by reading every interpolation site: the only `${}` inside a query string is a server-defined identifier — a table name from the planner's static column map, a `SELECT` fragment constant, `taskSelect(staff)`, a `sets` array built from an allow-list of column names, or a privacy SQL fragment built from `privacy.js` constants.
**Where:** all of `server.js` and the five route modules; dynamic-identifier sites at `routes_planner.js:27,47,61,67`, `routes_admin_users.js:86,130,188,200`, `routes_events.js:144,383,908+`, `routes_compliance.js:280`.
**What it does not cover:** the guarantee is by construction and convention, not by a query builder or an ORM. A future handler that concatenates a value into an identifier position would not be caught by anything but review. `tests/security_smoke.js` section E probes injection payloads against live routes.

### D.7 CORS

**What it does:** `PUBLIC_ORIGIN` and `ADMIN_ORIGIN` are the entire allow-list, normalised (trailing slash stripped, lower-cased) and compared exactly. Requests with no `Origin` header — same-origin navigation, `curl`, server-to-server — are allowed. `credentials: false`.
**Where:** `server.js:59-73`.
**What it does not cover:** with **neither** variable set, `cors(undefined)` is permissive and answers every origin with `Access-Control-Allow-Origin: *`. That is acceptable in development and is why production now refuses to boot without both. CORS is also not a defence for this platform's session model: the token is in a header, so a cross-origin page cannot cause the browser to attach it regardless of the CORS policy.

### D.8 Host routing

Described in §A.4. Hostname comparison via `new URL().hostname`, shared-origin deployments fall back to path routing, and the staff hostname gets `noindex` and frame-denial headers. It selects a shell; it does not authorise (§B.6).

### D.9 Cookies

**There are none.** No `Set-Cookie` is issued anywhere, no cookie parser is installed, `cors` runs with `credentials: false`, and the session is carried in `localStorage` and sent in an `Authorization` header. A reviewer looking for `Secure`, `HttpOnly` or `SameSite` attributes will find nothing to review, because there is nothing to attach them to.

### D.10 CSRF

**Why it is not applicable today.** CSRF requires the browser to attach a credential automatically to a cross-site request. This platform's credential is a bearer token that client JavaScript must read from `localStorage` and place in a header on each call. A cross-origin page cannot read `localStorage` for another origin and cannot set an `Authorization` header on a simple form post. There is no ambient authority to abuse, so there are no CSRF tokens and no `SameSite` posture — correctly.

**What would make it applicable again**, any one of these:

1. Moving the session into a cookie, for any reason — SSR, a subdomain-sharing requirement, "make refresh survive private mode". The moment a cookie carries the session, every state-changing route needs CSRF defence.
2. Enabling `credentials: true` on CORS in combination with any cookie or HTTP-auth credential.
3. Adding any route that authenticates from something the browser sends automatically — a client certificate, HTTP Basic, or an IP allow-list treated as identity.
4. Accepting the session token from a query parameter or a form field rather than only from the `Authorization` header.

The scheduler endpoint deserves a specific note: it accepts a secret in the `X-Cron-Key` header or a bearer, both of which a browser never sends on its own, so it is not CSRF-reachable either.

### D.11 XSS

**What it does:** manual encoding at every sink (§D.5); staff-portal framing headers; `nosniff`; the moderation queue — the highest-value target, since submitting to it *is* the delivery mechanism — now escapes all eight alumni-authored fields and routes emoji through `emojiIcon`.
**Where:** `js/core.js` plus 24 corrected call sites across the client (§F).
**What it does not cover:** no `Content-Security-Policy` constraining `script-src` on either portal, so a single missed sink is directly exploitable. Inline `onclick` is the codebase's dominant event idiom, and a script-src CSP would require rewriting it. The session token is in `localStorage`, so successful XSS is session theft, not merely defacement. Rendering is `innerHTML` everywhere; there is no framework auto-escaping to fall back on.

### D.12 IDOR protection

**What it does:** `app.param` blocks malformed ids before the database; handlers check ownership on member-authored records (jobs, notifications, profile writes, ticket ownership); task access is decided by `taskAccess()` (`routes_events.js:872`), which returns `canManage` (staff) and `canUpdate` (staff or assignee) and is consulted before a task is returned; non-staff callers on `GET /api/events/:id/tasks` are narrowed in SQL to tasks they are assigned to.
**Where:** per-handler, throughout.
**What it does not cover:** there is no central object-authorisation layer, so coverage is per-route and must be re-established by review whenever a route is added. `tests/security_smoke.js` section D walks the id-bearing routes it can reach as a second member and asserts 403 plus an unchanged row, which catches regressions but is not a proof of completeness.

### D.13 Audit logging

**What it does:** hash-chained entries with an application-generated canonical timestamp, a serialised append under a row lock, an immutable `actor_ref` in the digest, and a standalone verifier that needs nothing from the running application. Authentication events (`Signed In`, `Sign-In Failed`) are recorded as of Phase 5F — by user id, never by the address typed, so a failed attempt against an unknown address cannot turn the audit log into the enumeration oracle the 401 is careful not to be. Vault reveals, administrator provisioning, role changes, consent, password resets and deletion purges are all recorded.
**Where:** `audit_chain.js`, `routes_v2.js` (`writeAudit`), call sites throughout.
**What it does not cover:** the digest is unkeyed (§G.1). Append-only is a convention, not a trigger or a revoked grant. `writeAudit` swallows its own errors by design, so an audit write can fail silently while the audited action succeeds — clamping reduces the likelihood but does not eliminate it. Two historical segments (874 entries) are permanently unverifiable. Reads are not audited except for vault reveals.

### D.14 Encryption

**In transit:** TLS is terminated upstream; this codebase does not configure it. `db.js` sets `ssl: { rejectUnauthorized: false }` for connection-string deployments — that encrypts the database link but does **not** verify the server certificate, so it protects against passive observation and not against an active man-in-the-middle on the database path.
**At rest:** only the identity vault (AES-256-GCM). Everything else — names, emails, mobile numbers, home addresses, audit history — is stored in plaintext columns and relies on the database's own storage protections, which this codebase neither configures nor inspects. Backups are unencrypted (§G.5).
**Other cryptographic uses:** session tokens (HMAC-SHA256), ticket QR signatures (HMAC-SHA256 under `ENCRYPTION_KEY`, refused entirely rather than falling back to a hardcoded string when the key is absent — `routes_events.js:22-46`), reset tokens (SHA-256 of 32 random bytes), audit digests (SHA-256, unkeyed).

---

## E. SECRETS

**No value in this section is real. Every value shown is a placeholder.** No secret value, password or credential appears anywhere in this document.

| Secret | Purpose | Where used | How generated | Rotation | Escrow |
|---|---|---|---|---|---|
| `SESSION_SECRET` | HMAC key for session tokens | `signToken` / `verifyToken`, `server.js:244` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | **Freely rotatable.** Changing it invalidates every outstanding session; users sign in again. No data becomes unreadable. Rotate on any suspicion, on staff departure, and on a schedule | Not required. A lost value costs one round of forced re-authentication |
| `ENCRYPTION_KEY` | AES-256-GCM key for the identity vault; also the HMAC key for ticket QR signatures | `routes_v2.js:16`, `routes_events.js:31` | 64 hex characters (32 bytes), same generator | **Not rotatable without downtime and a migration.** There is no key id or key version column on `identity_vault`, so there is no way to run two keys concurrently — see §G.2. Rotating means decrypting and re-encrypting every row under a maintenance window, with the old key still available | **Escrow is mandatory.** If this value is lost, every vault row is permanently unreadable and every previously issued ticket QR fails validation. There is no recovery path, by design |
| `CRON_SECRET` | Scheduler credential for `/api/internal/jobs/run` | `requireScheduler`, `server.js:2705` | 32+ characters, same generator | **Freely rotatable.** Update the value in the environment and in the cron invocation. A `super_admin` session remains an alternative credential in the interim | Not required. A lost value means the jobs stop running until a new one is set — including the deletion purge, which must not be left stopped |
| `DATABASE_URL` / `PGPASSWORD` | Database connection | `db.js:49` | Issued by the database provider | Rotate at the database, then in the environment. `backup.js` reads the same variables, so it follows automatically | Held by whoever administers the database |
| `SMTP_PASSWORD` | Outbound mail authentication | `mailer.js:32` | Issued by the mail provider | Rotate at the provider, then in the environment. A stale value degrades self-service recovery only; it does not affect sign-in | Held by whoever administers the mail account |
| `ADMIN_PW_*` (optional) | One-off seeding of administrator passwords by `rotate_credentials.js` | `rotate_credentials.js` | Supplied by the operator, or generated (24 characters) and written to `admin-credentials.local.txt` | Not a persistent secret. Change the password through the application; delete the file | The generated file is gitignored. Move each value into a password manager and delete the file |

Non-secret configuration that is nonetheless required in production and refused at boot when absent (`server.js:200-236`): `PUBLIC_ORIGIN`, `ADMIN_ORIGIN`, `MAIL_TRANSPORT`. `BACKUP_DIR` is not enforced at boot but must be set to a path outside the web root.

`TRUST_PROXY` is a security-relevant setting and is **not documented in `.env.example` or in either runbook** — a `grep` across all documentation finds no mention of it. This is a documentation gap with an operational consequence: unset behind a reverse proxy, `req.ip` becomes the proxy's address for every caller, so the per-IP throttle (20 failures per 15 minutes) buckets the whole institution into one counter and the audit trail records the proxy for every action. Set incorrectly with nothing in front, `X-Forwarded-For` becomes the caller's to choose. The variable should be documented alongside the nginx configuration in the deployment runbook.

---

## F. WHAT PHASE 5F CHANGED

This is the freshest code in the repository and deserves the most attention. Several of these were proved in a live browser session before and after the fix.

| Ref | Severity | Finding | Fix |
|---|---|---|---|
| P0-1 | Critical | Stored XSS through `escapeHtml` in inline `onclick` handlers, 24 call sites in 11 files. An HTML attribute is decoded before the handler body compiles, so `&#39;` became a live apostrophe and closed the string literal. Eight sites also carried a `.replace(/'/g,'&#39;')` that was a total no-op, making the code *read* as defended. Proved live: a job titled `x');window.__P5F_ONCLICK=true;//` executed in a `super_admin` session on click | New `jsArg()` in `js/core.js`, applied at all 24 sites. Re-verified live: the attribute renders as a quoted JSON literal and does not execute |
| P0-2 | Critical | Stored XSS in the staff moderation queue (`js/admin.js`, `renderModerationPanel`). Eight alumni-authored fields — chapter name/type/description, story emoji/title/category/author/excerpt — went to `innerHTML` unescaped. **Submitting to the queue was the delivery mechanism**: no click needed, a moderator only had to open the queue. Proved live with four injected `<img onerror>` elements firing in a `super_admin` session | `escapeHtml` on all eight; emoji routed through `emojiIcon()`. Re-verified: zero injected elements, payload renders as literal text |
| P1-3 | High | Stored XSS at `js/profile.js:113` — another member's `job_title` / `current_company` rendered unescaped into the profile modal | `escapeHtml` |
| P1-4 | High | Bulk import gave every account in a batch **one shared password**, and `must_change_password` was advisory: the client prompted, the API did not care. Every recipient held a working credential for every other account in the batch, and dormant imported accounts stayed takeable indefinitely | The flag is now load-bearing server-side. `attachUser` selects it; `requireAuth` and `requireRole` return 403 while it is set, except for `/api/auth/change-password`, `/api/auth/me` and `/api/auth/logout`. The operator workflow is unchanged |
| P2-5 | Medium | The durable account lock was checked **after** `verifyPassword`, so it never throttled a guess and instead denied service to the real owner. `failed_login_count` was monotonic, so one wrong guess every 15 minutes re-armed the lock forever, with no admin unlock path | Lock checked before the password comparison, answering identically to an unknown address; the counter restarts once a lapsed lock is seen, so windows cannot be chained |
| P3-6 | Medium | `render10SectionProfile()` interpolated ~34 own-profile fields into `innerHTML` unescaped, including raw `href` on LinkedIn/GitHub/website, which accepted a `javascript:` URL | `escapeHtml` throughout; new `safeUrl()` restricts `href` to http/https |
| P3-7 | Medium | CWE-209: 41 sites returned raw `err.message` to any authenticated caller. `GET /api/alumni?batch=abc` returned PostgreSQL's own `invalid input syntax for type integer: "NaN"` | One `serverError()` helper (43 call sites today) logs against the existing correlation id and returns a fixed string plus that id; `app.param` numeric guards on eight parameters and a numeric check on `?batch` turn malformed input into 400 |
| P3-8 | Medium | `GET /api/mentorships/suggestions` returned `alumni_profiles.city` with no privacy gate | Gated on `privacy.DIRECTORY_VISIBLE_SQL`, including the `matched_city` boolean and its score contribution |
| P3-9 | Medium | The event-task assignee payload returned co-assignees' `mobile_number` and `whatsapp_number` to non-staff callers on three `requireAuth` routes | `TASK_SELECT` became `taskSelect(staff)`, so every call site must declare the caller's tier. (The external-contact branch remains ungated — see §B.8) |
| P3-10 | Medium | `app.set('trust proxy', 1)` was hardcoded. A numeric value is a hop **count**, not an allow-list, so with nothing in front the peer is trusted. Measured: 32 wrong passwords with a rotating forged `X-Forwarded-For` produced **zero** 429s, defeating both throttles, and the forged value is what the audit trail recorded | `TRUST_PROXY` environment variable, defaulting to **off**. Re-measured after the fix: every rotated attempt received 429 |
| P3-11 | Medium | Authentication events were not audited at all. An institution investigating a compromised administrator account could see what it *did* and not one attempt to reach it | `Signed In` and `Sign-In Failed` are written to the hash chain, by user id and never by the address typed |
| P3-12 | Low | `X-Powered-By: Express` on every response | `app.disable('x-powered-by')` |
| BUG-13 | Low (correctness) | `js/admin.js` called `renderNewsFeed()` unconditionally, but `admin.html` does not load `js/news.js`, so approving or rejecting a story in the staff portal threw `ReferenceError`. It stayed invisible because `tests/crossref.js` stripped quoted strings across the whole file at once, so one unbalanced apostrophe shifted every pair after it and a single "string" spanned hundreds of lines, blanking the call | Call guarded; the stripper now works one line at a time |

---

## G. KNOWN AND ACCEPTED LIMITATIONS

These are decisions, not oversights. Each is recorded with its reasoning and with the condition that would change the answer. An adversarial verification pass refuted eighteen candidate findings; the substantive ones are here, presented as what they are.

### G.1 The audit chain is unkeyed — it is NOT tamper-proof

`audit_chain.js:96` uses `crypto.createHash('sha256')`, **not** `createHmac`. Every input to the digest is a column on the row. Therefore anyone with database **write** access can alter an entry, recompute its hash, recompute every subsequent hash, update `audit_chain.head_hash`, and the verifier will report the chain clean. Append-only is enforced by application convention — there is no trigger and no revoked `INSERT`/`UPDATE`/`DELETE` grant anywhere in the schema.

**What it does give you:** detection of accidental corruption, of a partial or naive edit, of a truncated tail (the separately held head hash reveals deletions that linkage alone cannot), and of any change made by someone with application access but not database access. Combined with an off-site backup, it makes tampering *provable* — you can verify a restored copy against the live one — which is the actual defence.

**Accept because:** an HMAC key held by the same process that writes the log is available to anyone who compromises that process, so it raises the bar less than it appears to; and the honest framing has been documented rather than the reassuring one.

**What would change the answer:** a regulatory or contractual requirement for tamper-evidence against a database administrator; or the platform holding data whose integrity is contested in a dispute. The fix is not an HMAC alone — it is append-only enforcement in the database (a trigger plus a revoked `UPDATE`/`DELETE` grant for the application role) and periodic export of the head hash to a system the database administrator does not control.

### G.2 The identity vault key has no version

`identity_vault` has `ciphertext`, `iv`, `auth_tag` and no key-id column. Two keys cannot coexist, so there is no zero-downtime rotation: rotating means a maintenance window in which every row is decrypted with the old key and re-encrypted with the new one, and the old key must still be available when it starts.

**Accept because:** the vault holds a small number of rows for a college alumni association, and the operational simplicity was judged worth the constraint at this size.

**What would change the answer:** a key compromise, a compliance requirement for scheduled key rotation, or the vault growing to a size where a single-window re-encryption is no longer feasible. The fix is additive — a `key_id` column and a keyring — but it must be done before it is needed, not during an incident.

### G.3 No Subresource Integrity on the CDN scripts

Three scripts load from `cdn.jsdelivr.net` with no `integrity` attribute on either portal: `chart.js@4.4.0`, `qrcodejs@1.0.0`, `lucide@0.474.0`. If jsDelivr served altered content for those pinned versions, it would execute with full access to the page — including the session token in `localStorage` — on the staff portal as well as the alumni site.

**This is a real, open hardening gap.** It is classified as hardening rather than an exploitable defect because it requires compromising a third party, and because the versions are pinned rather than floating. It is cheap to close: add `integrity` and `crossorigin` attributes, or vendor the three files into `/js/` (which the static allow-list already serves) and remove the external dependency entirely. Vendoring would also make the pages work behind a network that blocks the CDN.

**What would change the answer:** nothing needs to change for this to be worth fixing. It is listed here for honesty about its current state, not to argue it should stay.

### G.4 `dept_admin` is institution-wide — there is no department scoping

The role name implies a scope that does not exist. No query filters by the acting administrator's department, and no route restricts a `dept_admin` to their own faculty's records.

**Accept because:** it is a documented, deliberate simplification for an institution of this size, where the small number of departmental administrators are all trusted institution-wide and the alternative — threading a scope through 138 routes and every join — would create many places to get it wrong. `dept_admin` is deliberately *below* `ADMIN_ROLES`: it cannot read the audit log, cannot provision administrators, cannot approve events.

**What would change the answer:** any expectation, contractual or cultural, that a departmental administrator cannot see another department's members. The role would then need renaming as well as scoping, because a name that overstates its own limits is itself a hazard.

### G.5 Backups are unencrypted at rest

`backup.js` writes plain SQL. The file is `chmod 0o600` in a `0o700` directory on POSIX, and both are no-ops on Windows. The dump contains every plaintext PII field in the database plus the vault ciphertext.

**Accept because:** the retention is short (14 days), the directory is required by documentation to sit outside the web root and is excluded by the static allow-list and by `.gitignore`, and the restore path is exercised by `restore.js --drill` rather than assumed. Adding encryption introduces a second key with its own escrow problem and a second way for a restore to fail at the worst moment.

**What would change the answer:** backups leaving the host — to object storage, an off-site copy, or any third party. At that point encryption before transfer stops being optional, and the key needs the same escrow discipline as `ENCRYPTION_KEY`.

### G.6 Other accepted positions

- **`scryptSync` blocks the event loop.** Password verification is synchronous at N=16384, so each login occupies the single Node thread for the duration of the derivation. Accepted because the login rate is low, the throttle refuses locked-out callers *before* reaching the hash, and the async variant complicates the constant-time comparison path. **Changes if** sign-in volume rises or an attacker can sustain enough concurrent unthrottled attempts to make derivation a denial-of-service lever — the per-IP counter is the thing to watch.
- **Registration returns 409 for an existing address** (`server.js:809`). This is an enumeration oracle in the strict sense. Accepted because every signed-in member can already browse the full directory, so membership is not a secret the platform keeps; and because the alternative — accepting the registration silently — is a materially worse user experience for the far more common honest case. `login` and `forgot-password`, where the population is not already public, do **not** distinguish. **Changes if** the directory ever becomes scoped so that membership stops being visible to all members.
- **No CSP `script-src`.** Discussed in §D.11. The inline-handler idiom would have to be rewritten first. Given that output encoding is the only layer between authored content and script execution, and that two critical XSS defects were found in one pass, this is the single highest-value structural hardening available to this codebase.
- **The in-process login throttle is per-process.** §D.3. Accepted for this pass; a shared store is the fix when the deployment becomes multi-instance.
- **`ssl: { rejectUnauthorized: false }` on the database connection.** §D.14. Encrypts but does not authenticate the database endpoint.

---

## Test position

21 suites, 1,520 checks, 0 failures (`npm test` → `tests/run-all.js`).

`tests/security_smoke.js` is new in Phase 5F: 598 lines, 109 checks across fourteen sections — A anonymous access to every route parsed from source, B staff-surface denial, C role escalation, D IDOR, E SQL injection, F the two stored-XSS classes, G CORS, H host routing, I rate limiting including the forged `X-Forwarded-For`, J session revocation, K privacy leakage between members, L bulk import and the enrolment gate, M scheduler authorisation, N error-text disclosure and headers.

It is self-contained: it registers its own accounts through the public endpoint, promotes throwaway ones to each staff role directly in the database for the duration of the run, and deletes everything at the end. It needs no credentials file and no seeded data. It never deletes an audit entry — the chain is append-only, and a test that pruned it would assert the opposite of what the platform is built on. It must be run against development or staging, never production: it writes rows and section I deliberately trips the login throttle.

`npm run verify-audit-chain` passes through 2,832 entries, exit 0, with 874 entries in the two legacy segments correctly reported as unverifiable rather than counted as verified.

---

## Suggested reading order for a reviewer

1. `server.js:1-500` — the entire middleware stack, auth primitives and RBAC constants.
2. `js/core.js:57-140` — the three output-encoding helpers and the reasoning behind `jsArg`.
3. `privacy.js` — the whole file; it is the single source of truth for field visibility.
4. `audit_chain.js` and `AUDIT_CHAIN.md` §3 — what the chain proves and what it does not.
5. `tests/security_smoke.js` — run it, then read the sections whose assertions surprise you.
6. `routes_events.js:823-880` — `taskSelect`, and decide the external-contact question in §B.8.
