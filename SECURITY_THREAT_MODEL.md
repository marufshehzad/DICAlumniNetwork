# DIC Alumni Platform — Security Threat Model

**Status:** current as of Phase 5F. Every control named below was read in the source
tree at `E:/Daffodil` while this document was written, and every file and line
reference is checkable against that tree.

**Audience:** an external security reviewer with no prior exposure to this codebase.

**What this document does not do.** It does not claim the platform is secure. It
models fourteen actors and describes, for each, what they can reach, what they
could attempt, what stops them, and what does not. Where a control is absent, the
absence is stated. Where a residual risk is real, it is written down rather than
softened.

---

## 0. The system in one page

A vanilla-JavaScript single-page application with no framework, no bundler and no
build step. Classic `<script>` tags load `js/*.js` into one global scope. Two
portals are served from one Express application: `index.html` (alumni) and
`admin.html` (staff). They share the same API and the same JavaScript files and
differ only in which modules each HTML file loads. Routing between them is by
path (`/admin`) or by hostname (`wantsAdminPortal()`, `server.js:2856`).

Runtime stack: Express 5 and PostgreSQL 16.14, with five runtime dependencies —
`express`, `body-parser`, `cors`, `pg`, `nodemailer`.

Backend files: `server.js` (2,901 lines), `routes_v2.js`, `routes_events.js`,
`routes_admin_users.js`, `routes_compliance.js`, `routes_planner.js`, `db.js`,
`privacy.js`, `location.js`, `audit_chain.js`, `jobs.js`, `mailer.js`,
`backup.js`, `restore.js`, `verify_audit.js`, `rotate_credentials.js`.

### Authentication

An HMAC-SHA256 bearer token in the `Authorization` header, format
`base64url(payload).base64url(signature)`. **There are no cookies anywhere on the
platform** and no JWT library. The payload carries `uid`, `role`, `tv` (token
version) and `exp`. `SESSION_TTL_MS` is 12 hours and is checked on every verify.
The signature is compared with `crypto.timingSafeEqual` (`server.js:277-292`).

`attachUser()` (`server.js:310-347`) re-reads `role`, `status`, `token_version`
and `must_change_password` from the `users` row on **every request**, so a
demotion, suspension or revocation takes effect on the caller's next request
rather than at token expiry. If the database is unreachable, `req.user` is set to
null — it fails closed rather than trusting the role asserted by the token.

Revocation is by `users.token_version`, bumped on sign-out, password change,
password reset and suspension. A token minted at an older version fails
verification.

### Passwords

`crypto.scryptSync` with N=16384, r=8, p=1, a 16-byte random salt, stored as
`scrypt$<salt>$<derived>` and compared with `timingSafeEqual`
(`server.js:246-270`). A `LOCKED$` sentinel can never match any input, so seeded
accounts ship with unusable credentials until `rotate_credentials.js` sets a real
password.

### Roles and guards

Five roles: `super_admin`, `univ_admin`, `dept_admin`, `moderator`, `alumni`.
Three tiers, defined once at `server.js:441-443`:

| Constant | Members |
|---|---|
| `SUPER_ONLY` | `super_admin` |
| `ADMIN_ROLES` | `super_admin`, `univ_admin` |
| `MODERATOR_ROLES` | `super_admin`, `univ_admin`, `dept_admin`, `moderator` |

`dept_admin` is **institution-wide**. There is no department scoping anywhere in
the codebase. This is a documented and accepted simplification for a
single-college deployment, not a defect — but a reviewer should read every
`dept_admin` permission as "over the whole institution".

138 `app.<verb>()` registrations exist across `server.js` and the five
`routes_*.js` modules. Guard distribution: `requireAuth` 63, `requireRole(...MODERATOR_ROLES)`
41, `requireRole(...ADMIN_ROLES)` 20, `requireRole(...SUPER_ONLY)` 7,
`requireScheduler` 2. Exactly **five routes are public by design**:

```
GET  /api/health
POST /api/auth/login
POST /api/auth/register
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

Note for the reviewer: four of the 138 registrations live inside the `crud()`
factory in `routes_planner.js`, which is invoked twelve times, so the running
application serves more distinct paths than the registration count implies. Every
one of those generated routes is `requireRole(...MODERATOR_ROLES)`.

### Privacy

`privacy.js` is the single source of truth and is served to the browser at
`GET /api/profile/privacy-schema`, so the interface is built from the same object
the server enforces.

| Field | Levels | Default | Staff bypass |
|---|---|---|---|
| `email` | public, private | public | yes |
| `mobile` | public, private | private | yes |
| `location` | public, alumni, private | alumni | **no — none, for any role** |

`SELF_ONLY_FIELDS` = `present_address`, `permanent_address`, `postal_code`,
`hometown`. These are never returned to anyone but the owner, staff included.
The staff bypass roles are `['super_admin', 'univ_admin', 'dept_admin']` —
`moderator` is **not** included (`privacy.js:83`).

### Identity vault

AES-256-GCM under `ENCRYPTION_KEY` (64 hex characters). Fails closed with no key
(`routes_v2.js:14-40`). Reveals require a stated reason of at least five
characters and are logged to `vault_access_logs` as well as to the audit chain
(`routes_compliance.js:120-155`). There is **no key id and no key version
column**, so there is no zero-downtime rotation path. That is an operational
constraint, stated as such.

`ENCRYPTION_KEY` is additionally the HMAC key for ticket QR signatures
(`routes_events.js:31-47`). One key serves two purposes; there is no key
separation.

### Audit

`audit_logs`, hash-chained by `audit_chain.js`. **The digest is an unkeyed
SHA-256** — `crypto.createHash`, not `createHmac` (`audit_chain.js:95-97`). This
is the single most important honesty point in this package:

> An unkeyed chain detects accidental corruption and naive tampering. Anyone with
> database **write** access can recompute the entire chain and the head pointer,
> and `verify_audit.js` will then report it clean. The chain is **not
> tamper-proof** and must never be described as such.

Append-only is enforced by application convention only. There is no database
trigger and no revoked `GRANT` — searching `schema*.sql` and `migrate_v*.js` for
`TRIGGER`, `REVOKE` or `GRANT` returns nothing.

Two historical segments are permanently unverifiable and are documented as such
in `AUDIT_CHAIN.md`: chain v0 (773 entries, digest consumed a timestamp that was
never persisted) and chain v1 (101 entries, digest included a foreign key the
database nulls on account deletion). `verify_audit.js` verifies the current
segment and reports the historical ones without counting them as verified.

### Scheduler

`POST` and `GET /api/internal/jobs/run`, guarded by `requireScheduler`
(`server.js:2705-2716`). Two credentials open it and nothing else does:
`CRON_SECRET` (as a bearer token or `X-Cron-Key`, compared with
`timingSafeEqual`), or a `super_admin` session. Three jobs: `event-maintenance`,
`deletion-purge`, `mentorship-expiry`. There is no in-process timer; an external
cron calls the endpoint.

### Backup

`backup.js` shells out to `pg_dump` into `BACKUP_DIR` (which must be outside the
web root), with 14-day retention. **The dump is not encrypted at rest** and
contains all plaintext PII plus the vault ciphertext. `restore.js --drill`
restores into a disposable database.

### Payments

There are none. No gateway, no SDK, no card data anywhere in the tree. Donations
are pledges that an administrator confirms
(`POST /api/donations/:id/record-payment`, `ADMIN_ROLES`). Priced event tickets
are refused with 409 (`routes_events.js:601-607`).

### Production configuration

The process refuses to boot in production without `SESSION_SECRET`,
`ENCRYPTION_KEY`, `CRON_SECRET`, a mail decision (`MAIL_TRANSPORT`),
`PUBLIC_ORIGIN` and `ADMIN_ORIGIN` (`server.js:200-233`). It throws rather than
calling `process.exit`, so the reason is visible in a serverless function log.

### Frontend supply chain

`index.html` and `admin.html` each load **three** scripts from
`cdn.jsdelivr.net` with **no Subresource Integrity attribute**: Chart.js 4.4.0,
qrcodejs 1.0.0 and Lucide 0.474.0 (`index.html:30-31, 908`;
`admin.html:31-32, 715`). This is a real, open hardening gap. It is reported
here, not excused.

### Why there is no CSRF section

Classic CSRF requires the browser to attach an ambient credential to a
cross-origin request. The session is a bearer token read from `localStorage` by
`api.js` and set explicitly on each call (`api.js:7-26`); `cors()` is configured
with `credentials: false` (`server.js:70`); no cookie is set or read anywhere in
the tree. There is nothing for a cross-site request to carry, so there is no
CSRF surface to defend. That is the whole of the CSRF analysis.

### Not modelled, because it does not exist

No file upload to disk, no payment gateway, no SSO or OAuth, no mobile
application, no message queue, no second server, no container orchestration, no
WebSocket. Threats against any of these would be invented, and inventing them
would waste a reviewer's attention.

---

## 1. Anonymous attacker

Someone with no account, reaching the deployment over the internet.

**ASSETS**
The five public endpoints; the static files the allow-list serves; the login and
recovery flows for every account on the platform, administrators included; the
choice of which portal shell is returned; whatever a misconfiguration would
expose.

**ATTACK SURFACE**
- `GET /api/health` (`server.js:534`)
- `POST /api/auth/login` (`server.js:656`)
- `POST /api/auth/register` (`server.js:793`)
- `POST /api/auth/forgot-password` (`server.js:948`)
- `POST /api/auth/reset-password` (`server.js:1003`)
- The static allow-list middleware (`server.js:113-146`) and `express.static`
- The SPA fallback (`server.js:2872-2874`)
- The three unpinned CDN script tags
- Every other `/api/*` path, as a target for a guard that might have been missed

**POSSIBLE ABUSE**
Credential stuffing and password spraying; account enumeration through login,
registration or password reset; reading source files, `.env`,
`admin-credentials.local.txt` or the SQL schema off the web root; forging a
session token; registering an account to convert themselves into actor 2;
minting a password-reset link that points at their own server; requesting the
staff portal shell.

**EXISTING MITIGATION**
- Static serving is an allow-list, not a directory. `PUBLIC_FILES` and
  `PUBLIC_DIRS` (`server.js:113-116`) name exactly what may be served; anything
  else with a file extension is a 404 before `express.static` sees it, dotfiles
  are refused by a segment check, `..` is refused, and `/backups`,
  `/node_modules`, `/ops` and `/api/index` are refused whether or not they carry
  an extension. Before this, a single unauthenticated `GET` could retrieve
  `SESSION_SECRET` and `ENCRYPTION_KEY`.
- Login answers one generic `401` for both an unknown address and a wrong
  password (`server.js:703`), and a locked account is answered identically to an
  unknown address (`server.js:684-693`).
- Two rate-limit counters, per-IP and per-account-per-IP, checked before the
  database is touched (`server.js:565-651`), plus a durable per-row lock in
  `users.locked_until` that survives a restart and a serverless cold start. Phase
  5F moved the durable lock **above** `verifyPassword` so it can actually stop a
  guess, and made the counter restart once a lapsed lock is seen so windows
  cannot be chained into a permanent lockout (P2-5).
- `POST /api/auth/forgot-password` always returns the same acknowledgement
  (`RESET_ACK`, `server.js:929`) whether the address exists, is suspended, or the
  mail send failed; database errors in that handler are deliberately swallowed
  so a failure cannot answer differently.
- The reset link's base URL comes from `PUBLIC_ORIGIN`, not from the `Host`
  header (`server.js:970-971`), so a reset link cannot be pointed at an
  attacker's server.
- Reset tokens are 32 random bytes; only the SHA-256 hash is stored, the token
  lives 30 minutes, is consumed in the same `UPDATE` that sets the password, and
  bumps `token_version` (`server.js:1013-1032`).
- Token forgery requires the HMAC key. Production refuses to boot without
  `SESSION_SECRET`.
- `GET /api/health` reports liveness only. It previously returned the database
  product and version, the deployment type and the exact user count.
- `X-Powered-By` is disabled (`server.js:21`, Phase 5F P3-12). Security headers
  are set in application middleware as well as at the edge
  (`server.js:78-93`), so they exist behind nginx or a bare `node server.js`,
  not only on Vercel.
- Self-registered accounts start `is_verified = FALSE` with role hardcoded to
  `'alumni'` (`server.js:817-822`).
- `tests/security_smoke.js` parses every route out of the source and asserts
  anonymous access to each one.

**RESIDUAL RISK**
- **The rate limiter is in-process.** `loginAttempts` is a `Map` in one Node
  process. On a serverless deployment each warm instance keeps its own counter,
  so a spread-out attacker gets *attempts × instances* before being refused. The
  durable per-row lock is the real ceiling, and it is per-account, not per-IP —
  a spray of one guess each against ten thousand accounts is not throttled by
  anything durable. The code says so at `server.js:558-563`.
- **Registration is an enumeration oracle.** `POST /api/auth/register` returns
  409 for an address that already exists (`server.js:809`). Accepted: every
  signed-in member can already see the whole directory, so the address of a
  member is not a secret this endpoint is protecting. It is still a difference
  an unauthenticated caller can observe.
- **Anyone can create an account.** Registration is open and unverified accounts
  can sign in immediately. Everything in section 2 is therefore reachable by an
  anonymous attacker who spends thirty seconds registering.
- **The three CDN scripts have no SRI.** A jsDelivr compromise, or DNS or TLS
  interception against a viewer, executes attacker JavaScript inside a
  `super_admin` session on `admin.html`. Nothing in the application detects this.
- No CAPTCHA, no proof of work, and no account-creation rate limit at all —
  registration is not covered by `loginRateCheck`.

**RECOMMENDED CONTROL**
Add SRI hashes to all three CDN tags, or vendor the three libraries into
`/assets` and serve them from the origin — the allow-list already permits `.js`
under `/assets/`. Move the login counters into PostgreSQL or Redis so the limit
is shared across instances and survives restart. Add a per-IP rate limit to
`POST /api/auth/register`. Consider a `Content-Security-Policy` with a
`script-src` allow-list on both portals — one is set today only for
`frame-ancestors` on the admin portal.

---

## 2. Registered alumnus

A verified or unverified member with a valid session and the `alumni` role. The
largest population and the origin of every stored-XSS finding in Phase 5F.

**ASSETS**
Their own profile including the self-only address fields; the directory of every
other member; other members' privacy-gated contact details; the jobs board, news
stories, chapters, mentorship, donations and event registrations; anything a
staff session renders that an alumnus authored.

**ATTACK SURFACE**
- The 63 `requireAuth` routes, notably `GET /api/alumni`, `GET /api/alumni/:id`,
  `GET /api/profile/me`, `PUT /api/profile`, `GET /api/mentorships/suggestions`,
  `GET /api/events/:id/tasks`, `GET /api/events/tasks/:taskId`,
  `POST /api/vault`, `GET/POST/DELETE /api/dsar/*`
- Every free-text field an alumnus can write: job title, company, chapter name,
  chapter type, chapter description, story title, story category, story excerpt,
  story emoji, author name, bio, skills, LinkedIn, GitHub, website
- The moderation queue, which is the delivery mechanism from an alumnus to a
  staff browser
- The 41 `MODERATOR_ROLES` and 20 `ADMIN_ROLES` routes, as escalation targets

**POSSIBLE ABUSE**
Storing JavaScript in a field that a staff browser will render, and waiting;
reading contact details of members who marked them private; reading another
member's home address; enumerating the directory wholesale; calling a staff route
directly; editing a record belonging to someone else by changing an id;
provoking a database error to read PostgreSQL's own words back.

**EXISTING MITIGATION**
- **Stored XSS through inline handlers is closed (P0-1).** `escapeHtml` turns
  `'` into `&#39;`, but an HTML attribute is decoded by the parser *before* the
  handler body is compiled as JavaScript, so `&#39;` became a live apostrophe
  and closed the string literal. Twenty-four call sites across eleven files were
  affected; eight of them also carried a `.replace(/'/g,'&#39;')` that was a
  total no-op — `escapeHtml` had already replaced every apostrophe — and made the
  code *read* as defended. Proved live: an alumnus posted a job titled
  `` x');window.__P5F_ONCLICK=true;// `` and the rendered attribute became
  `showJobApplicants(5, 'x');window.__P5F_ONCLICK=true;//')`, which executed on
  click in a `super_admin` session. The fix is `jsArg()` in `js/core.js:89-91` —
  `escapeHtml(JSON.stringify(String(v)))`, which supplies its own quotes — applied
  at all 24 sites. Re-verified live: the attribute is now
  `showJobApplicants(5, "x');window.__P5F_ONCLICK=true;//")` and does not execute.
- **Stored XSS in the staff moderation queue is closed (P0-2).** Eight
  alumni-authored fields were rendered into `innerHTML` with no escaping in
  `renderModerationPanel()` — chapter name, type and description, and story
  emoji, title, category, author name and excerpt. *Submitting to the queue was
  the delivery mechanism*: no click was needed, the moderator only had to open
  the queue to review it. Proved live in a `super_admin` session with four
  injected `<img onerror>` elements, all of which fired. The fix applies
  `escapeHtml` to all eight and routes the emoji through `emojiIcon()`
  (`js/admin.js:1136-1235`). Re-verified live: zero injected elements, zero
  `onerror` attributes, payload renders as literal text.
- **Stored XSS in the profile modal is closed (P1-3).** `js/profile.js:113`
  rendered another member's `job_title` and `current_company` unescaped;
  `escapeHtml` was applied.
- Privacy is enforced server-side, not by hiding a field in the browser.
  `GET /api/alumni/:id` gates `email`, `mobile` and `location` through
  `privacy.canSee()` (`server.js:1249-1290`), and returns no address, postal code
  or hometown to any role.
- Directory location filters (`?country=`, `?city=`, `?placeId=`) are each
  additionally constrained by `privacy.DIRECTORY_VISIBLE_SQL`
  (`server.js:1148-1163`), and city was removed from the free-text search
  predicate — a setting that hides a value while leaving it searchable is not a
  setting.
- **Mentorship suggestions no longer leak a private city (P3-8).**
  `GET /api/mentorships/suggestions` returned `alumni_profiles.city` with no
  privacy gate. It is now gated on `DIRECTORY_VISIBLE_SQL`, and so are the
  `matched_city` boolean and its score contribution — a bare "matches your city"
  discloses the city to a reader who knows their own.
- **Co-assignee contact numbers are no longer leaked (P3-9).** The event-task
  assignee payload returned `mobile_number` and `whatsapp_number` to non-staff
  callers on three `requireAuth` routes. `TASK_SELECT` became
  `taskSelect(staff)` (`routes_events.js:823-864`), so every present and future
  call site has to declare the caller's tier.
- **Error text no longer reaches the caller (P3-7).** Forty-one sites returned
  `err.message` verbatim to any authenticated caller — `GET /api/alumni?batch=abc`
  returned PostgreSQL's own `invalid input syntax for type integer: "NaN"`. One
  `serverError()` helper (`server.js:392-401`) logs the message against the
  existing correlation id (already returned as `X-Request-Id`) and returns a fixed
  string plus that id. `app.param()` numeric validation was added for `id`,
  `userId`, `taskId`, `personId`, `ttId`, `eventId`, `itemId` and `vaultId`
  (`custom_fields.id` is a varchar and is exempt), and a numeric check on
  `?batch`, so malformed input is a 400 rather than a 500.
- Profile writes are whitelisted by `EDITABLE_PROFILE_FIELDS`
  (`server.js:1326`), so a caller cannot set `role` or `is_verified` by adding
  keys to the payload.
- Every query uses parameterised `$n` placeholders; no user value is
  concatenated into SQL. The only interpolated fragments are constants from
  `privacy.js` and the `staff` boolean in `taskSelect`.
- `href` on `linkedin`, `github` and `website` goes through `safeUrl()`
  (`js/core.js:97-105`), which admits only `http:` and `https:` — `javascript:`
  needs no quote to run and `escapeHtml` does nothing about a scheme (P3-6).
- `tests/security_smoke.js` covers role escalation, IDOR, SQL injection and XSS
  from an alumnus session.

**RESIDUAL RISK**
- **XSS was found by audit, not prevented by architecture.** The application
  builds HTML by string concatenation into `innerHTML` across roughly twenty
  thousand lines of frontend JavaScript. Every one of the twenty-four `jsArg`
  sites and every `escapeHtml` call is a manual, per-call-site decision that a
  future edit can omit. There is no template engine, no auto-escaping, no
  `Content-Security-Policy` `script-src` to stop an injected handler from
  running, and no lint rule that would fail a build — there is no build. The
  class of bug is closed at every known site; the class is not structurally
  prevented.
- **`POST /api/vault` is `requireAuth`** (`routes_compliance.js:90`). Any member
  can store a national ID, birth certificate or passport number of their own.
  That is by design, but it means the encrypted vault grows with data supplied by
  the least-trusted actor on the platform, and its `last_four` is stored in
  plaintext alongside the ciphertext for the masked listing.
- An alumnus can read the full directory. Bulk scraping is not rate-limited;
  `GET /api/alumni` caps `limit` at 100 but nothing caps the number of requests.
- `dept_admin`'s lack of department scoping means an alumnus promoted to
  `dept_admin` for one department gains institution-wide moderator-plus reach.

**RECOMMENDED CONTROL**
Introduce a `Content-Security-Policy` with `script-src 'self'` plus the CDN
origin (or `'self'` alone once the libraries are vendored) and no
`'unsafe-inline'` — that would neutralise the entire inline-handler class rather
than each instance of it. Doing so requires converting inline `onclick`
attributes to delegated listeners, which is a substantial but mechanical change
and is the single highest-value frontend hardening available. Add a per-session
read quota or pagination-rate limit to `GET /api/alumni`.

---

## 3. Suspended alumnus

An account whose `users.status` is `'suspended'`, still holding a token that has
not yet expired.

**ASSETS**
Whatever a live session reaches — which is the whole point of suspension being
immediate rather than eventual.

**ATTACK SURFACE**
Any route, using the token minted before suspension; `POST /api/auth/login` to
obtain a fresh one; `POST /api/auth/forgot-password` to reset their way back in.

**POSSIBLE ABUSE**
Continuing to use the platform for up to twelve hours after being suspended;
signing in again; recovering the account through the reset flow.

**EXISTING MITIGATION**
- `attachUser()` reads `users.status` on every request and sets `req.user = null`
  with `req.suspended = true` when it is `'suspended'` (`server.js:337-341`).
  Both `requireAuth` and `requireRole` return `403 SUSPENDED` before any other
  check (`server.js:417, 426`). The session dies on the next request, not at
  token expiry.
- `POST /api/auth/login` refuses a suspended account with a distinct message so
  the holder asks an administrator rather than retrying (`server.js:752-754`).
- `POST /api/auth/forgot-password` issues a token only when
  `row.status === 'active'` (`server.js:962`), so a suspended account cannot
  self-recover.
- `PUT /api/admin/administrators/:id/status` also bumps `token_version` when
  suspending (`routes_admin_users.js:225-232`), so the tokens stay dead even if
  the account is later reactivated — reactivation does not silently revive
  somebody's old session.
- `tests/security_smoke.js` has a session-revocation section.

**RESIDUAL RISK**
- Suspension of an *alumnus* is set by whichever route writes `users.status`;
  the `token_version` bump is applied by the administrator-status route in
  `routes_admin_users.js`, which is scoped to staff rows
  (`WHERE ... role = ANY($3::text[])` with `STAFF_ROLES`). For an alumni row
  suspended by another path, `attachUser` is the control that stops the session
  — belt without braces. It is sufficient, because `attachUser` runs on every
  request; but a reviewer should note the two mechanisms are not applied
  uniformly.
- If the database is unreachable, `attachUser` fails closed and nobody gets in —
  correct behaviour, and worth stating because the alternative would have been to
  trust the role in the token.
- A suspended user's data remains fully present and readable to staff; there is
  no lock-out of their content.

**RECOMMENDED CONTROL**
Bump `token_version` in every code path that writes `users.status = 'suspended'`,
not only in the administrator route, so revocation does not depend solely on the
per-request status read.

---

## 4. Moderator

`role = 'moderator'`. In `MODERATOR_ROLES` but **not** in `privacy.STAFF_ROLES`,
which is the deliberate distinction that makes this role interesting.

**ASSETS**
The moderation queue for chapters and stories; every event, event task, event
team and planner sub-module; the staff directory search, which returns contact
details; broadcasts (read only); the alumni verification queue.

**ATTACK SURFACE**
- The 41 `requireRole(...MODERATOR_ROLES)` routes
- `GET /api/directory/search` (`routes_events.js:1381`) — staff-only, returns
  mobile numbers, student ids and section codes
- `GET /api/events/:id/people` (`routes_events.js:1237`) — returns phone and
  WhatsApp for directory and external people alike
- The twelve planner sub-modules generated by `crud()` in `routes_planner.js` —
  sponsor contacts, vendor contract values, budgets, meeting minutes, risks
- `GET /api/broadcasts` (`routes_v2.js:710`)
- The moderation queue, as a *victim* surface: this is where hostile
  alumni-authored content arrives

**POSSIBLE ABUSE**
Reading contact details of members who set `mobile` to private; approving hostile
content into the alumni-facing site; reading sponsor and vendor commercial data;
attempting to reach `ADMIN_ROLES` or `SUPER_ONLY` routes; deleting event people
or tasks maliciously.

**EXISTING MITIGATION**
- `privacy.STAFF_ROLES` is `['super_admin', 'univ_admin', 'dept_admin']` —
  moderator is excluded (`privacy.js:83`), so a moderator viewing
  `GET /api/alumni/:id` gets `null` for an email or mobile the member marked
  private, exactly as an ordinary alumnus does.
- `location` has no staff bypass at all, so a private city is private to a
  moderator too.
- `isStaff()` in `routes_events.js:82` is `MODERATOR_ROLES.includes(u.role)`, so
  `taskSelect(true)` does return co-assignee phone numbers to a moderator. That
  is the design: staff coordinating an event need to reach the team.
- The three tiers are the only place permissions are defined, and
  `GET /api/stats/rbac` derives the displayed matrix from the same constants
  (`server.js:2450` and surrounding), so the screen cannot disagree with the
  middleware.
- Moderator cannot reach `ADMIN_ROLES` routes (bulk import, broadcasts write,
  vault, donations payment recording, ops status) or `SUPER_ONLY` routes
  (administrator provisioning, re-seed, scheduler).
- Every moderation action writes to the hash-chained audit log.
- The moderation queue itself is now escaped (P0-2, above), so reviewing hostile
  content no longer executes it.
- `tests/security_smoke.js` has a staff-surface denial section and a role
  escalation section.

**RESIDUAL RISK**
- **`GET /api/directory/search` bypasses `privacy.js` entirely.** It is
  `MODERATOR_ROLES`-guarded and returns `ap.mobile_number` and `ap.student_id`
  with no privacy predicate (`routes_events.js:1381-1400`). A moderator who
  cannot see a private mobile through `GET /api/alumni/:id` can see it through
  this route. The two paths disagree about what a moderator may read. This is a
  genuine inconsistency and a reviewer should treat it as one.
- Similarly, `GET /api/events/:id/people` returns `COALESCE(ap.mobile_number,
  p.phone)` and `COALESCE(ap.whatsapp_number, p.whatsapp)` for every person on an
  event team, ungated by privacy settings.
- A moderator is institution-wide. There is no scoping by chapter, department or
  event — any moderator moderates everything.
- **`routes_planner.js:75-76` is a live defect.** `mountPlanner` destructures
  `{ requireAuth, requireRole, ADMIN_ROLES, MODERATOR_ROLES, writeAudit }` from
  `guards` but not `serverError`, and then defines
  `const ok = (res, fn) => fn().catch(err => serverError(res, err, 'planner'));`.
  If any of the three non-`crud` planner routes
  (`/api/planner/analytics/:eventId`, `/api/planner/report/:eventId`,
  `/api/planner/workspace/:eventId`) rejects, the rejection handler itself throws
  a `ReferenceError` and no response is ever sent — the request hangs until the
  client times out. Staff-only and availability-only, but it is a real bug found
  while writing this document, not a hypothetical.

**RECOMMENDED CONTROL**
Apply `privacy.canSee`/`DIRECTORY_VISIBLE_SQL` to `GET /api/directory/search` and
to the phone and WhatsApp columns of `GET /api/events/:id/people`, so that one
answer to "may this role see this member's mobile" holds across the whole API.
Destructure `serverError` in `mountPlanner`.

---

## 5. Department admin

`role = 'dept_admin'`. In `MODERATOR_ROLES` **and** in `privacy.STAFF_ROLES`.

**ASSETS**
Everything a moderator reaches, plus the private `email` and `mobile` of every
member on the platform through the privacy staff bypass.

**ATTACK SURFACE**
The same 41 `MODERATOR_ROLES` routes, plus `GET /api/alumni/:id` now returning
values a member marked private.

**POSSIBLE ABUSE**
Harvesting the private contact details of the entire alumni body one profile at a
time; the same content and event abuses available to a moderator.

**EXISTING MITIGATION**
- The bypass is narrow and explicit. `privacy.canSee` grants it only when
  `spec.staffBypass === true` and the viewer's role is in
  `privacy.STAFF_ROLES` (`privacy.js:139-147`). `email` and `mobile` have the
  flag; `location` does not, for any role.
- `SELF_ONLY_FIELDS` — present address, permanent address, postal code, hometown
  — are never returned to a `dept_admin`. `GET /api/alumni/:id` does not select
  them into the response at all; `GET /api/profile/me` is the owner's own route.
  `privacy.js:69-81` states the refusal and its reasoning: the only levels that
  could be offered are "self only" and "share my home address with every
  member", and the second has no legitimate use in a college alumni directory.
- No `ADMIN_ROLES` or `SUPER_ONLY` route is reachable: no bulk import, no vault
  reveal, no broadcast, no administrator provisioning, no scheduler, no ops
  status.
- Every read of a vault entry is separately gated and audited; `dept_admin`
  cannot reveal one.
- All actions are audited to the hash chain with the actor id and client
  address.

**RESIDUAL RISK**
- **`dept_admin` is institution-wide.** There is no department column consulted
  anywhere in the authorisation path — the name promises a scope the code does
  not implement. This is documented and accepted for a single-college deployment.
  A reviewer should still hold it in mind when reading every `MODERATOR_ROLES`
  guard: the effective blast radius of a `dept_admin` is the whole institution.
- The staff bypass on `email` and `mobile` is not rate-limited and not
  separately audited. Reading one member's private mobile writes no distinct
  audit entry — only the ordinary request log line
  (`timestamp id GET /api/alumni/:id 200 …ms uid=N`, `server.js:167-176`), which
  is `console` output, not the hash chain. Systematic harvesting by a
  `dept_admin` would leave a request log and no audit trail.
- The same `GET /api/directory/search` and `GET /api/events/:id/people` gaps
  described in section 4 apply here, though they matter less because this role
  has the bypass anyway.

**RECOMMENDED CONTROL**
Either implement real department scoping or rename the role to what it is. If
scoping is out of scope, add rate limiting and an audit entry to the privacy
staff bypass so that bulk harvesting of private contact details is visible in the
chain rather than only in `stdout`.

---

## 6. University admin

`role = 'univ_admin'`. In `ADMIN_ROLES`. Institutional authority, deliberately
separated from platform authority.

**ASSETS**
Everything below, plus: bulk import of accounts; the identity vault, including
decryption; broadcasts to the whole membership; donation payment recording;
operational status including the mail host, the last failed job's error text and
the backup state; the audit log as a reader.

**ATTACK SURFACE**
- The 20 `requireRole(...ADMIN_ROLES)` routes
- `POST /api/bulk-import` (`server.js:1942`)
- `GET /api/vault`, `POST /api/vault/:id/reveal`, `GET /api/vault/access-logs`
  (`routes_compliance.js:78, 120, 157`)
- `POST /api/broadcasts` (`routes_v2.js:718`)
- `POST /api/donations/:id/record-payment`
- `GET /api/ops/status` (`server.js:2748`)

**POSSIBLE ABUSE**
Decrypting national ID, birth certificate or passport numbers without cause;
importing a roster that overwrites existing profiles; broadcasting to the whole
membership; recording payments that were never made; provisioning themselves more
authority.

**EXISTING MITIGATION**
- **`SUPER_ONLY` exists precisely to stop this role provisioning administrators.**
  Before that tier, `super_admin` and `univ_admin` were interchangeable
  everywhere except `/api/seed-db`, so a college administrator could create
  further administrators. Every route in `routes_admin_users.js` is now
  `requireRole(...SUPER_ONLY)`, and the file says so in its header.
- A vault reveal requires a written reason of at least five characters, is
  written to `vault_access_logs` with the reason and the accessing user, and is
  separately written to the hash chain (`routes_compliance.js:120-155`). The
  chain entry deliberately omits the reason text, which lives in
  `vault_access_logs` — it was previously the most sensitive line in the log,
  naming the data subject and the document category in a table every
  administrator can read.
- `GET /api/vault` never decrypts. It renders from `last_four`, stored
  alongside the ciphertext for exactly that purpose.
- The vault fails closed with no `ENCRYPTION_KEY`: storing is refused with 503
  and production will not boot.
- Bulk import hardcodes `role` to `'alumni'` in both the INSERT and the update
  path (`server.js:2094-2100`) — see section 8.
- `POST /api/seed-db` is `SUPER_ONLY` *and* refuses outright in production unless
  `ALLOW_DB_RESEED=true` is set deliberately (`server.js:512-520`). The
  environment decides, not the caller.
- Priced ticket issuance is refused with 409 rather than silently marking a
  ticket paid (`routes_events.js:601-607`) — the previous code set `amount_paid`
  to the list price at INSERT and returned a confirmed ticket.
- Every action is audited, attributable, and carries the client address.

**RESIDUAL RISK**
- **A `univ_admin` can decrypt any identity document, for any member, at any
  time.** The only friction is a five-character reason string, which is free text
  and unvalidated beyond its length. There is no approval workflow, no
  two-person rule, no per-day limit and no alerting. The control is detective
  (`vault_access_logs` plus the chain), not preventive.
- **A `univ_admin` reads the audit log they appear in and can write to the
  database** if they also hold database credentials. The chain's unkeyed digest
  (section 10) means audit is not evidence against an actor who has both.
- Recording a donation payment is a single unreviewed click with financial
  meaning, in a system with no gateway to reconcile against.
- `GET /api/ops/status` returns the mail host and the last error text of a
  failed job. That is intended for operators, but it is more environmental detail
  than any other authenticated surface returns.
- `bodyParser.json()` is called with no `limit`, so the Express default of 100 kB
  applies. That bounds a single request but is also small enough that a large
  bulk import will be rejected at the body parser — a reviewer testing import at
  scale should expect this.

**RECOMMENDED CONTROL**
Add a rate limit and an alert on vault reveals (for example, more than N in a
rolling hour raises a notification to `super_admin`), and consider requiring the
reason to reference a ticket or case identifier. Neither is a preventive control,
but both raise the cost of quiet, systematic access.

---

## 7. Super admin

`role = 'super_admin'`. Platform authority. The most privileged actor the
application models, and the one for which the application provides the least
independent oversight.

**ASSETS**
Everything. Administrator provisioning and role changes; suspension and password
reset of any staff account; the scheduler; database re-seed; the vault; the audit
log; every member record.

**ATTACK SURFACE**
- The 7 `requireRole(...SUPER_ONLY)` routes, all of `routes_admin_users.js`, and
  `POST /api/seed-db`
- `POST`/`GET /api/internal/jobs/run` via the super-admin fallback in
  `requireScheduler` (`server.js:2711-2714`)
- Every `ADMIN_ROLES` and `MODERATOR_ROLES` route
- `admin.html`, which is where the P0-1 and P0-2 payloads were proved to execute

**POSSIBLE ABUSE**
Creating an administrator account for themselves under another name; resetting
another administrator's password and taking over the account; suspending every
other administrator; running `deletion-purge` early; re-seeding the database;
decrypting the vault at will.

**EXISTING MITIGATION**
- Administrator provisioning cannot mint a `super_admin`: `ASSIGNABLE_ROLES` is
  `{ moderator, dept_admin, univ_admin }` only, and `alumni` and `super_admin`
  are both deliberately absent (`routes_admin_users.js:41-46`). Platform
  authority is set in the database, not through a form.
- A `super_admin` role cannot be changed through the update endpoint
  (`routes_admin_users.js:175-178`).
- A `super_admin` cannot suspend their own account
  (`routes_admin_users.js:213-215`) — locking yourself out of the only account
  that can unlock anything is not a recoverable mistake.
- Generated passwords are shown exactly once in the creating response, hashed
  immediately, never persisted in plaintext and never written to a log or an
  audit entry (`routes_admin_users.js:22-31, 130-136, 262-274`).
- An administrator password reset bumps `token_version`, so the holder's
  existing sessions die — resetting a password because an account may be
  compromised is pointless if the attacker's token keeps working.
- `POST /api/seed-db` refuses in production regardless of role unless
  `ALLOW_DB_RESEED=true`.
- Every provisioning, role change, suspension and reset writes a distinct audit
  entry naming both the actor and the target.
- `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`
  are set for the admin portal (`server.js:85-90`) — the one place on the
  platform where a clickjacked click provisions accounts.

**RESIDUAL RISK**
- **There is no control that constrains a `super_admin` within the
  application.** Every guard admits them. The only limits are the two listed
  above (cannot self-suspend, cannot mint a peer through the form), and both are
  trivially bypassed by anyone who also holds database credentials — which in a
  small-college deployment is very likely the same person.
- **Audit is not evidence against this actor.** The chain is unkeyed and stored
  in the same database. See section 10.
- The number of `super_admin` accounts is an operational choice with no
  application-level minimum or maximum. A single `super_admin` is a single point
  of both failure and compromise; several is a wider blast radius.
- `super_admin` is a valid scheduler credential, so the same session that
  browses the admin portal can run `deletion-purge`.

**RECOMMENDED CONTROL**
Ship the audit chain off-box, continuously, to storage the `super_admin` cannot
write (see section 10). Keep the number of `super_admin` accounts to the minimum
the institution can operate with, and record who holds them in the handover
checklist. Application-level constraint of this role is not achievable and should
not be attempted; external constraint is.

---

## 8. Malicious CSV importer

Two shapes, both real: an administrator who deliberately imports a hostile roster,
and a well-meaning administrator handed a hostile file by a department. The second
is the likelier and is the one the controls are aimed at.

**ASSETS**
The `users` table; `alumni_profiles`, including the self-only address fields; the
shared batch password; `import_history`; the staff browser that renders the import
report.

**ATTACK SURFACE**
- `POST /api/bulk-import` (`server.js:1942`), `requireRole(...ADMIN_ROLES)`
- The `records` array, unbounded in length by the handler itself
- Every per-record field: `name`, `email`, `mobile`, `hscPassingYear`,
  `hscGroup`, `hscVersion`, `bloodGroup`, `presentAddress`, `permanentAddress`,
  `hometown`, `postalCode`, `city`, `district`, `country`, `occupation`,
  `organization`, `designation`, `photoUrl`, `facebook`
- `filename`, `adminName`, `dupResolution`, `failedCount`, `duplicateCount`,
  `processingTime` — all client-supplied
- The import report rendered back into the admin UI

**POSSIBLE ABUSE**
Smuggling an account with an elevated role; overwriting an existing member's
profile with attacker-controlled values; injecting a payload through a name or
company field that a staff browser will render; forging `import_history` entries;
poisoning the audit entry through `filename`; storing a `javascript:` URL in
`photoUrl` or `facebook`; taking over other accounts in the same batch using the
shared password.

**EXISTING MITIGATION**
- **Role is hardcoded.** The INSERT is
  `INSERT INTO users (…, role, role_label, …) VALUES ($1,$2,$3,$4,'alumni','Alumni Member',…)`
  (`server.js:2094-2100`). No field in the CSV reaches the `role` column. The
  update path touches `alumni_profiles` only and never `users`. A hostile roster
  cannot mint an administrator.
- **The shared batch password is now a one-time enrolment credential and nothing
  else (P1-4).** Bulk import gives every account in a batch one shared password,
  and `must_change_password` used to be advisory — the client prompted, the API
  did not care. Every recipient of that one password therefore held a working
  credential for every other account in the batch, and most bulk-imported alumni
  never sign in, so dormant accounts stayed takeable indefinitely. The flag is
  now load-bearing server-side: `attachUser` selects it (`server.js:322`), and
  both `requireAuth` and `requireRole` return 403 while it is set, except for
  exactly three paths — `/api/auth/change-password`, `/api/auth/me`,
  `/api/auth/logout` (`ENROLMENT_ALLOWED_PATHS`, `server.js:376-386`). The
  operator workflow is unchanged.
- The batch password is generated per import from `crypto.randomBytes`
  (`server.js:469-476`), returned once to the administrator who ran the import,
  and never stored in plaintext or logged. It used to be the constant `'12345678'`,
  which was also the label of the only option in the wizard's dropdown — the
  starting password of every imported alumnus was readable in the page source.
- Every insert and update is parameterised. SQL injection through a CSV field is
  not available.
- `filename` is bounded and stripped before it reaches the audit entry:
  `String(filename || 'import.csv').replace(/[^\w.\- ]+/g, '').slice(0, 60)`
  (`server.js:2140`), so it cannot impersonate the surrounding log structure and
  cannot carry personal data whole.
- Locations are resolved against reference places; unmatched values are stored
  as NULL and reported back to the administrator by row number, rather than
  silently replaced. The previous import wrote `'Dhaka','Bangladesh'` onto every
  row whatever the file said.
- The whole import runs in one transaction and rolls back on failure.
- Under the `skip` strategy an existing account is left entirely alone. Under
  `update`, `COALESCE` means a blank field never erases a stored value.
- Every imported field that later reaches the browser passes through
  `escapeHtml`, and every inline-handler argument through `jsArg` — the P0-1 and
  P0-2 fixes cover the import report and the moderation queue alike.
- `bodyParser.json()`'s 100 kB default bounds the size of a single import
  request.

**RESIDUAL RISK**
- **`photoUrl` and `facebook` are stored as free text with no scheme
  validation** (`server.js:2035, 2036`). `safeUrl()` exists in `js/core.js` and
  constrains `href` where it is applied, but the server accepts whatever the CSV
  contained. A reviewer should check every render site of `photo_url` and
  `facebook` rather than assuming the stored value is a URL.
- **`records` has no length cap in the handler.** The 100 kB body limit is the
  only bound, and it is incidental rather than intentional. A single import loop
  issues at least two queries per record inside one transaction.
- The import **can overwrite** existing profiles under the `update` strategy,
  matching on email *or* on the last ten digits of a normalised mobile number
  (`server.js:2011-2018`). A hostile file that guesses or knows a member's mobile
  number can rewrite that member's job title, company, addresses and hometown.
  Nothing notifies the affected member.
- `adminName`, `failedCount`, `duplicateCount` and `processingTime` are written
  into `import_history` unvalidated. That table is a record of what happened,
  and parts of it are the client's assertion rather than the server's
  observation.
- The batch password is distributed by whatever means the administrator chooses
   — commonly a spreadsheet or a group message. The enrolment gate limits what it
  can do; it does not make the distribution safe.

**RECOMMENDED CONTROL**
Validate `photoUrl` and `facebook` server-side to `http`/`https` at write time,
not only at render time. Cap `records.length` explicitly and reject with a clear
error rather than relying on the body parser. Derive `failedCount`,
`duplicateCount` and `processingTime` server-side instead of trusting the client,
and notify a member by email when an import overwrites their profile.

---

## 9. Compromised admin session

A legitimate staff session in the hands of someone else — an unlocked machine, a
token copied from `localStorage`, a device-level compromise, or the XSS that
Phase 5F closed.

**ASSETS**
Everything that role can reach, for up to twelve hours, with every action
attributed in the audit log to the legitimate holder.

**ATTACK SURFACE**
Every route the role's tier admits. For `super_admin` that is all 138
registrations.

**POSSIBLE ABUSE**
Provisioning a persistent administrator account; resetting another
administrator's password; suspending the real holder; exfiltrating the directory;
decrypting vault entries; running the deletion purge; leaving the audit trail
pointing at an innocent person.

**EXISTING MITIGATION**
- **The delivery route is closed.** P0-1 and P0-2 were exactly this: a stored
  payload authored by an alumnus, executing in a `super_admin` session. Both were
  proved live and both are fixed and re-verified live. The moderation queue, which
  needed no click at all, renders as literal text.
- Sessions are 12 hours, not indefinite, and `exp` is checked on every verify.
- `token_version` gives a real revocation mechanism. Signing out ends *every*
  session for the account, not just the current browser — the right default for a
  staff portal (`server.js:1049-1058`). A password change and an administrator
  reset do the same.
- Suspending an administrator takes effect on the next request and bumps
  `token_version` as well.
- Sign-in events are now in the hash chain (P3-11). `'Signed In'` and
  `'Sign-In Failed'` are written by user id and never by the address typed, so
  the log does not become the account-enumeration oracle the 401 is careful not
  to be. Before this, an institution investigating a compromised administrator
  account could see what it *did* and not one attempt to reach it.
- The request log records a correlation id, method, path, status, duration and
  `uid=` for every API call, and deliberately excludes the body (passwords and
  reset tokens), the `Authorization` header, and the query string (a reset link
  arrives as `?reset=<token>`) — `server.js:150-179`.
- `X-Frame-Options: DENY` and `frame-ancestors 'none'` on the admin portal
  prevent clickjacking a provisioning click.
- The admin portal is `X-Robots-Tag: noindex, nofollow`.

**RESIDUAL RISK**
- **The token is a bearer credential in `localStorage`** (`api.js:7-15`). Any
  script that runs in the origin can read it, and it is valid from any address —
  there is no binding to IP, user agent, or device. The 12-hour window is the
  whole of the containment.
- **Revocation is all-or-nothing per account.** There is no session table, so an
  administrator who suspects one session is compromised must end all of them.
  There is no "active sessions" list, no per-session identifier, and no way to
  see that a second session exists.
- **No anomaly detection.** Nothing notices that a session's source address
  changed mid-life, that a `super_admin` provisioned five accounts in a minute,
  or that vault reveals spiked. Detection is a human reading the audit log after
  the fact.
- **Actions are attributed to the legitimate holder.** The audit chain proves an
  entry has not been altered; it cannot show whose hands were on the keyboard.
  `AUDIT_CHAIN.md` states this directly: the chain proves integrity, not truth.
- No second factor exists anywhere on the platform.

**RECOMMENDED CONTROL**
The highest-value addition is a session table with per-session ids, so a holder
can see and end one session, and so the audit chain can record which session
performed each action. After that: a second factor for `STAFF_ROLES`, and an
alert to `super_admin` on the small set of genuinely high-consequence actions
(administrator created, role changed, vault revealed, purge run).

---

## 10. Database compromise

Treated as two distinct actors, because the difference is decisive for the audit
chain.

### 10a. Read-only database access

**ASSETS**
Every row: `users` (including `password_hash`, `reset_token_hash`,
`token_version`), `alumni_profiles` (including the self-only address fields),
`identity_vault` ciphertext and `last_four`, `audit_logs`, `vault_access_logs`,
`consent_logs`, `deletion_requests`, `event_people` contact details, donation
records, `import_history`.

**ATTACK SURFACE**
A direct PostgreSQL connection; a leaked `DATABASE_URL`; a `pg_dump` file in
`BACKUP_DIR`; a copy of the backup on someone's laptop; a managed-database
console.

**POSSIBLE ABUSE**
Reading the entire alumni body's personal data; offline cracking of password
hashes; correlating `audit_logs.meta` and `vault_access_logs` to learn who has
been investigated; reading identity ciphertext in the hope of obtaining the key
separately.

**EXISTING MITIGATION**
- Passwords are scrypt with N=16384, r=8, p=1 and a 16-byte per-row salt. A dump
  does not yield passwords directly, and the parameters are meaningfully costly.
- Seeded accounts carry a `LOCKED$` sentinel that can never match any input, so
  a fresh database ships with no usable default credential.
- Reset tokens are stored only as SHA-256 hashes, so a database reader — a
  backup, a log shipper, a leaked dump — cannot mint a reset from one
  (`server.js:906-920`).
- Identity documents are AES-256-GCM ciphertext. `ENCRYPTION_KEY` lives in the
  environment, not in the database, so a dump alone does not decrypt them.
- `BACKUP_DIR` is created `0o700`, is excluded by `.gitignore`, and `/backups` is
  explicitly refused by the static allow-list whether or not the path has an
  extension (`server.js:135-138`).
- The startup banner asks the database which database it is, and never prints the
  connection string, which carries the password.

**RESIDUAL RISK**
- **The `pg_dump` output is not encrypted at rest.** It contains every plaintext
  PII field on the platform plus the vault ciphertext. Its protection is entirely
  filesystem permissions and wherever the operator copies it to. This is stated in
  the runbook and is a deliberate current position, not an oversight — but it is
  the single largest concentration of personal data the platform produces.
- `identity_vault.last_four` is plaintext next to the ciphertext.
- `audit_logs.meta` in the historical segments (chain v0 and v1) contains names
  and email addresses. They cannot be rewritten without destroying the chain, and
  `AUDIT_CHAIN.md` §5 states this as a trade rather than a fix.
- Scrypt slows cracking; it does not stop it for weak passwords. The minimum
  password length is 8 characters with no complexity or breach-list check
  (`server.js:800`).

**RECOMMENDED CONTROL**
Encrypt the backup at rest (age, GPG, or the storage layer's own encryption) with
a key held separately from the dump. Add a breached-password check or raise the
minimum length. Both are ENGINEERING work; the storage decision is HOSTING
PROVIDER.

### 10b. Read-write database access

**ASSETS**
Everything above, plus the ability to change any of it — including the record of
what happened.

**ATTACK SURFACE**
`audit_logs` and the `audit_chain` head row; `users.role`, `users.status`,
`users.password_hash`, `users.token_version`; `identity_vault`; every content
table.

**POSSIBLE ABUSE**
Granting themselves `super_admin` by updating one row; setting a known password
hash on an existing administrator; deleting or rewriting audit entries and
recomputing the chain so that verification passes; inserting a plausible
historical entry; erasing a `vault_access_logs` row.

**EXISTING MITIGATION**
- The chain detects *naive* tampering. Altering one row's `action`, `meta`,
  `actor_ref`, `target`, `ip`, `icon`, `created_at` or `prev_hash` breaks that
  row's `entry_hash` and every subsequent `prev_hash` link
  (`audit_chain.js:238-262`).
- The verifier is unusually thorough for an unkeyed scheme. It checks the
  boundary anchor, every `prev_hash` link, every recomputed `entry_hash`, that
  `actor_id` either matches the hashed `actor_ref` or is NULL (so a visible
  attribution cannot be changed without touching the digest), that no
  unrecognised `chain_version` exists, that the segment counts reconcile against
  `COUNT(*)`, that the recorded head is the last entry, and that
  `audit_chain.entry_count` agrees. Truncating the tail is caught by the head
  pointer, which a successor row would not notice.
- `npm run verify-audit-chain` passes through 2,832 entries with exit 0 today.
- Historical segments are reported as unverifiable rather than silently skipped
  or counted as clean.
- `attachUser` re-reads `role` and `status` on every request, so a role escalated
  in the database takes effect immediately — which is a control working *for* the
  attacker here, and is worth naming as such rather than presenting the
  re-read as unambiguously protective.

**RESIDUAL RISK**
- **The chain is not tamper-proof against this actor, and must never be described
  as such.** `entry_hash` is a plain SHA-256 over values that all live in the
  same database (`audit_chain.js:95-97`). Anyone with write access can rewrite an
  entry, recompute every subsequent hash, update `audit_chain.head_hash` and
  `entry_count`, and `verify_audit.js` will then report the chain clean. The work
  required is a short script. `AUDIT_CHAIN.md` lines 177-183 say this in the
  project's own words and state that the guarantees are written on the assumption
  that no HMAC is in place.
- **Append-only is a convention, not a constraint.** There is no `BEFORE UPDATE`
  or `BEFORE DELETE` trigger on `audit_logs` and no revoked `GRANT` — a search of
  `schema*.sql` and `migrate_v*.js` for `TRIGGER`, `REVOKE` and `GRANT` returns
  nothing. The application never issues an UPDATE or DELETE against `audit_logs`;
  the database does not prevent one.
- **The historical segments accept insertions undetectably.** Chain v0 (773
  entries) and v1 (101 entries) have no integrity protection at all. A plausible
  entry can be inserted among them with a low id and nothing will object; the
  verifier can only report that the segment is unverifiable, which it does.
- The application runs as a single PostgreSQL role with full rights to every
  table. There is no separate append-only role for the audit writer.
- Detection therefore rests on an off-site copy disagreeing — that is, on the
  nightly backup and the weekly restore drill actually running.

**RECOMMENDED CONTROL**
Three things, in order of value:
1. Ship the chain head (or the whole chain) off-box on a schedule, to storage the
   database role cannot write. Detection of this actor is *only* possible by
   comparison against a copy they could not reach.
2. Key the digest: replace `crypto.createHash` with `crypto.createHmac` under a
   key held in the environment, not the database. That would be a chain version 3
   and a new segment, which the versioning scheme already anticipates. It raises
   the bar from "recompute the chain" to "also steal the key".
3. Run the application under a PostgreSQL role with `INSERT` but not `UPDATE` or
   `DELETE` on `audit_logs`, and enforce it with a trigger as well as a grant.

---

## 11. Stolen session token

The bearer token itself, without the browser it came from. Distinct from section
9 in that the attacker has the credential and not the machine.

**ASSETS**
Everything the account's role reaches, until the token expires or
`token_version` is bumped.

**ATTACK SURFACE**
Any route. The token is presented in the `Authorization` header and nothing else
about the caller is inspected.

**POSSIBLE ABUSE**
Full use of the account from anywhere, for the remainder of the 12-hour window.

**EXISTING MITIGATION**
- 12-hour `SESSION_TTL_MS`, checked in `verifyToken` on every request
  (`server.js:290`).
- `token_version` revocation: sign-out, password change, password reset and
  suspension all end every outstanding token for the account.
- Role, status and `must_change_password` are re-read from the database on every
  request, so a stolen token that predates a demotion carries no extra authority.
- The token is never logged. The request log deliberately excludes the
  `Authorization` header and the query string.
- The signature is HMAC-SHA256 over the payload, compared with `timingSafeEqual`.
  The token cannot be modified to change `uid`, `role`, `tv` or `exp` without the
  secret.
- Production refuses to boot without `SESSION_SECRET`; a development-only
  ephemeral secret would invalidate every session on each restart, and the
  process warns loudly when one is in use.
- An enrolment-state token (`must_change_password`) is confined to three paths,
  so a token stolen from a bulk-imported account that has not yet set a password
  can do nothing but set one, read itself, and sign out.

**RESIDUAL RISK**
- **The token is a pure bearer credential.** Nothing binds it to a device, an
  address, a user agent or a TLS session. Presenting it from anywhere works.
- **Nothing detects reuse.** Two simultaneous sessions on the same token from
  different continents look identical to one session to this application. There
  is no session table, no last-seen address per session, and no concurrent-use
  signal.
- **Revocation requires the legitimate holder to act, or an administrator to
  suspend.** A holder who does not know the token was taken will not sign out,
  and the token lives its full 12 hours.
- It is stored in `localStorage`, readable by any script running in the origin —
  which is why the P0-1 and P0-2 XSS findings were rated as they were, and why
  the absence of a `script-src` CSP matters beyond those two specific bugs.
- Whoever holds it acts as the legitimate user in the audit log.

**RECOMMENDED CONTROL**
A session table with per-session ids would allow selective revocation, a
"where you are signed in" screen, per-session last-seen address, and a concurrent-use
signal. That is the single change that most improves this actor's profile. The
architecture deliberately avoids one today, and the trade should be revisited
explicitly rather than by default.

---

## 12. Malicious external event or task contact

`event_people` rows with `person_type = 'external'` and `user_id IS NULL` — a
decorator, caterer or photographer with no account. They cannot call the API at
all; they are a *data* actor, and their record is written by staff on their
behalf.

**ASSETS**
Their own `event_people` row: `name`, `role_title`, `phone`, `whatsapp`,
`organization`, `department_area`, `notes`. That row is rendered in the staff
event UI and appears in task assignee lists.

**ATTACK SURFACE**
- `POST /api/events/:id/external-people` (`routes_events.js:1305`) and
  `PUT /api/events/external-people/:personId` (`routes_events.js:1345`), both
  `requireRole(...MODERATOR_ROLES)` — the external person does not call these; a
  moderator does, with values the external person supplied verbally, by email or
  on a form
- `GET /api/events/:id/people` (`routes_events.js:1237`), which renders those
  values back to staff
- `taskSelect()`'s external branch (`routes_events.js:849-861`), which puts
  `p.name`, `p.role_title`, `p.phone`, `p.whatsapp` and `p.organization` into a
  task's assignee JSON

**POSSIBLE ABUSE**
Supplying a name or organisation containing markup or a JavaScript payload, in
the expectation that a moderator will type it into the external-contact form and
a staff browser will render it; supplying a `notes` value designed to mislead;
impersonating an existing team member by name.

**EXISTING MITIGATION**
- **No account is created.** The route header states it deliberately does not
  create a `users` row and never touches the alumni directory: the record lives
  and dies with the event. An external contact has no credential, no session and
  no route they can call.
- Both write routes are `MODERATOR_ROLES`, so the value only enters the system
  through a staff action that is audited (`'External Contact Added'` with the
  person id, event id and actor).
- `name` and `roleTitle` are required and rejected when blank on both create and
  update; every field is `String(...).trim()` and stored parameterised.
- A duplicate external name on the same event is refused with 409.
- Rendering: the P0-1 `jsArg` fix and the P0-2 `escapeHtml` work cover the
  event and task UI along with everything else, so an external contact's name in
  an inline handler argument is a quoted JavaScript string literal and not code.
- `taskSelect(false)` returns `NULL` for the *directory* branch's phone and
  WhatsApp to non-staff callers; the external branch is only reachable through
  staff-guarded routes.

**RESIDUAL RISK**
- **The external branch of `taskSelect` returns `p.phone` and `p.whatsapp`
  unconditionally**, without the `staff` gate that the directory branch has
  (`routes_events.js:855-856`). `GET /api/events/:id/tasks` and
  `GET /api/events/tasks/:taskId` are `requireAuth`, and a non-staff assignee
  sees only tasks they are assigned to — so an ordinary alumnus assigned to a task
  reads the phone and WhatsApp number of any external contact assigned to the same
  task. External contacts have no privacy settings and no way to express a
  preference; the asymmetry is deliberate in the sense that it was written that
  way, but it is not stated anywhere as a decision.
- There is no length limit on `name`, `notes` or `organization` at the API
  boundary — the column widths are the only bound.
- An external contact's details persist after the event; nothing purges them, and
  they are not covered by the DSAR deletion flow, which is keyed on `user_id`.
- The 409 duplicate check matches on lowercased trimmed name within one event
  only, so the same person can be added to many events with inconsistent details.

**RECOMMENDED CONTROL**
Gate `p.phone` and `p.whatsapp` on the same `staff` flag the directory branch
uses, so `taskSelect(false)` redacts both branches. Add a retention rule for
`event_people` rows after an event closes.

---

## 13. Malicious uploaded or imported data reaching the admin UI

The class of attack that Phase 5F was largely about: content authored by a
low-privilege actor that executes, or misleads, in a high-privilege browser.
There is no file upload to disk on this platform — "uploaded" here means data
posted through the API and stored, principally the bulk-import payload and
alumni-authored content.

**ASSETS**
The `super_admin` and `univ_admin` browsers viewing `admin.html`; their session
tokens in `localStorage`; every action those sessions can perform.

**ATTACK SURFACE**
- The moderation queue: chapter `name`, `type`, `description`; story `emoji`,
  `title`, `category`, `author_name`, `excerpt` (`js/admin.js:1136-1235`)
- Inline `onclick` handler arguments across eleven frontend files — the 24 sites
  fixed by `jsArg`
- The bulk-import report, which renders rejected rows, unresolved locations and
  the supplied filename back to the administrator
- `js/profile.js` rendering another member's `job_title` and `current_company`
- The event and task UI rendering `event_people` values
- `href` attributes fed from `linkedin`, `github`, `website`, `photoUrl`,
  `facebook`
- `admin.html`'s three unpinned CDN scripts, which execute in the same context

**POSSIBLE ABUSE**
Executing JavaScript in a `super_admin` session to read the token from
`localStorage`, provision an administrator, or perform any privileged action
silently; rendering misleading content in the moderation queue so an approval
decision is made on a false basis; a `javascript:` URL on a profile link.

**EXISTING MITIGATION**
- **P0-1 and P0-2 are the two findings in this class, both proved live and both
  fixed and re-verified live.** Their detail is in section 2; the essential
  points are that `escapeHtml` was actively the *wrong* tool inside an inline
  handler attribute (the parser decodes `&#39;` back to `'` before JavaScript
  compiles the handler body), that eight sites carried a no-op `.replace()` that
  made the code read as defended, and that submitting to the moderation queue
  required no click from the moderator at all.
- `jsArg()` (`js/core.js:89-91`) is now the only correct way to place a value in
  an inline handler argument, and its comment block explains why `escapeHtml` is
  not — so the next person to add a call site has the reasoning in front of them.
- `emojiIcon()` (`js/core.js:139`) maps a stored emoji character to a Lucide icon
  name from a fixed table, with a silent fallback for anything unmapped, so an
  emoji field can never reflect arbitrary text into `innerHTML`.
- `safeUrl()` restricts `href` to `http:` and `https:`.
- `render10SectionProfile()` had ~34 own-profile fields interpolated into
  `innerHTML` unescaped, including raw `href` on `linkedin`, `github` and
  `website` which accepted a `javascript:` URL. All are escaped and the three
  links go through `safeUrl` (P3-6).
- The import filename is stripped to `[\w.\- ]` and capped at 60 characters
  before it reaches the audit log.
- **BUG-13** is worth stating here because of *why* it was invisible.
  `js/admin.js` called `renderNewsFeed()` unconditionally, but `admin.html` does
  not load `js/news.js` — so approving or rejecting a story in the staff portal
  threw a `ReferenceError`. The cross-portal test that exists to catch exactly
  this had been silently skipping the call, because `tests/crossref.js` stripped
  quoted strings across the *whole file* at once, so one unbalanced apostrophe
  shifted every quote pair after it and a single "string" spanned hundreds of
  lines, blanking the call from the analysis. The call is now guarded, and the
  stripper works one line at a time. A reviewer should read this as a lesson
  about the test harness, not only about the bug.
- `tests/security_smoke.js` includes an XSS section, and the fixes were verified
  in a live browser rather than only by unit assertion.

**RESIDUAL RISK**
- **There is no structural defence, only correct call sites.** No template
  engine, no auto-escaping, no CSP `script-src`, no build step that could carry a
  lint rule. Every future `innerHTML` template is a fresh opportunity to
  reintroduce the class. The audit found 24 + 8 + 1 + ~34 sites; the same audit
  would have to be repeated after any significant frontend change.
- **The three CDN scripts are the same threat with a different author.** A
  compromised jsDelivr response executes in `admin.html` with no SRI to stop it.
  Everything said about XSS consequences applies verbatim.
- `photo_url` and `facebook` accept any string at the API boundary; their render
  sites must be individually checked.
- Content that is merely *misleading* rather than executable is not addressed at
  all — a moderation queue entry crafted to look like an official notice will
  render exactly as written, escaped and harmless to the browser but not to the
  reader.

**RECOMMENDED CONTROL**
A `script-src` CSP without `'unsafe-inline'` is the structural fix and requires
migrating inline handlers to delegated listeners. Pin the three CDN scripts with
SRI or vendor them. Add a cross-portal render test that asserts every
`innerHTML` template in `js/*.js` passes user values through `escapeHtml`,
`jsArg`, `safeUrl` or `emojiIcon` — the source-parsing approach
`tests/security_smoke.js` already uses for routes would extend to this.

---

## 14. Attacker controlling Origin and Host headers

Anyone who can choose the headers on their own request, which is anyone with
`curl`. Grouped here because `Origin`, `Host` and `X-Forwarded-For` are all
caller-chosen strings that this application makes decisions with.

**ASSETS**
Which portal shell is served; whether a cross-origin response is readable by a
browser; which address the rate limiter and the audit log record; where a
password-reset link points.

**ATTACK SURFACE**
- The CORS middleware (`server.js:62-72`)
- `wantsAdminPortal()` and `originHost()` (`server.js:2846-2870`)
- The security-header middleware, which branches on `wantsAdminPortal(req)`
- `app.set('trust proxy', TRUST_PROXY)` and `clientIp()` (`server.js:44-50`,
  `server.js:611-614`)
- The reset-link base URL in `POST /api/auth/forgot-password`

**POSSIBLE ABUSE**
Reading an authenticated API response cross-origin from an attacker-controlled
page; being served the staff portal shell on the public alumni domain; forging
`X-Forwarded-For` to evade the login throttle and to poison the audit trail;
causing a reset link to be minted that points at the attacker's server;
suppressing the admin portal's `X-Frame-Options` by controlling the `Host`.

**EXISTING MITIGATION**
- **CORS is an allow-list when configured.** `ALLOWED_ORIGINS` is
  `[PUBLIC_ORIGIN, ADMIN_ORIGIN]`, normalised for trailing slash and case, and
  the origin callback returns a boolean membership test (`server.js:62-72`).
  Production refuses to boot without both variables, so the permissive
  `cors(undefined)` path — which answered every origin with
  `Access-Control-Allow-Origin: *`, verified — cannot be reached in production.
- `credentials: false` is set explicitly. Even a wildcard would not attach an
  ambient credential, because there is none: the session is a bearer token the
  page must add deliberately, and a cross-origin page cannot read another
  origin's `localStorage`.
- **The host comparison is a hostname equality test, not a substring test.**
  `originHost()` parses the configured origin with `new URL()` and compares
  hostnames. It used to be `adminOrigin.includes(host)`, and under the
  recommended architecture the alumni host is a substring of the admin origin —
  `'https://admin.alumni.dic.edu.bd'.includes('alumni.dic.edu.bd') === true` —
  so a request to the *public* domain matched and was served the staff portal
  shell. The API enforces roles server-side regardless of which shell is served,
  so this was the wrong page rather than an access-control failure; but it was
  the wrong page on the college's public domain.
- When `ADMIN_ORIGIN` and `PUBLIC_ORIGIN` resolve to the same host — the
  development and single-host case — the host cannot distinguish the portals and
  only the path can, so a shared host is never treated as admin.
- **`trust proxy` is now declared, not assumed (P3-10).** It was hardcoded to
  `1`. A numeric trust-proxy value is a hop *count*, not an address allow-list:
  `proxy-addr` compiles `1` to "trust the peer, unconditionally", so with nothing
  actually in front, the peer is the attacker and `X-Forwarded-For` is theirs to
  choose. **Measured**: 32 wrong passwords against one account with a rotating
  forged `X-Forwarded-For` produced **zero** 429 responses — both the per-IP and
  the per-account-per-IP throttles were evaded, and the forged value is what the
  audit trail recorded. The fix is a `TRUST_PROXY` environment variable
  defaulting to **off**, so `req.ip` is the socket address unless the operator
  declares the real hop count. **Re-measured after the fix**: every rotated
  attempt got 429.
- The reset link's base is `PUBLIC_ORIGIN`, falling back to
  `req.protocol`/`req.get('host')` only when it is unset — and production cannot
  start with it unset.
- Security headers are applied in application middleware as well as at the edge,
  so they exist on any hosting arrangement, not only on Vercel.
- `tests/security_smoke.js` has sections for CORS, host routing, and rate
  limiting including the forged `X-Forwarded-For` case.

**RESIDUAL RISK**
- **`TRUST_PROXY` correctness is an operator responsibility, and a wrong value is
  silent.** Setting it too high re-creates the forgery in full; setting it too
  low behind a proxy makes every request appear to come from the proxy, which
  collapses the per-IP limiter into one global counter and records the proxy's
  address in the audit log. Neither mistake produces an error or a warning.
  `PRODUCTION_DEPLOYMENT_RUNBOOK.md` and `OPERATIONS_RUNBOOK.md` are the only
  controls on getting it right.
- **A request with no `Origin` header is always allowed** (`server.js:67`) —
  correct, because same-origin browser requests, `curl` and server-to-server
  calls all omit it, and CORS is a browser control that offers nothing against a
  non-browser client. Worth stating so a reviewer does not read the allow-list as
  an access control. It is not one; the bearer token is.
- **Any host beginning `admin.` is served the staff portal** regardless of
  configuration (`server.js:2859`). On a deployment that answers to a wildcard
  DNS record, an attacker choosing that `Host` gets the staff shell. It contains
  no data and every API call still needs a staff token, but it is a rule wider
  than the `ADMIN_ORIGIN` it is meant to implement.
- CORS is not a defence for this application in any meaningful sense. The
  security of every endpoint rests on the bearer token and the role guards.

**RECOMMENDED CONTROL**
Log the effective `trust proxy` setting and the resolved `req.ip` for the first
request after boot, so a misconfiguration is visible in the startup output rather
than discovered during an incident. Consider narrowing the `admin.` prefix rule
to the configured `ADMIN_ORIGIN` hostname alone once DNS is settled.

---

## 15. Residual risk ranking

Highest first. "Owner" is who can actually fix it, not who is blamed for it.

| # | Residual risk | Where | Why it ranks here | Owner |
|---|---|---|---|---|
| 1 | The audit chain is unkeyed SHA-256 in the same database it protects, with no trigger or grant enforcing append-only. Anyone with database write access can rewrite history and pass verification. | `audit_chain.js:95-97`; no `TRIGGER`/`REVOKE` in `schema*.sql` | It is the control every other investigation depends on, and it does not hold against the actor most likely to need investigating. Documented and accepted, but the acceptance should be re-examined. | ENGINEERING (HMAC + grants), DIC (off-site copy policy) |
| 2 | No structural XSS defence: `innerHTML` string templates throughout ~20k lines of frontend JS, no CSP `script-src`, no auto-escaping, no build step to enforce a rule. | `js/*.js`, `index.html`, `admin.html` | Every known site is fixed and re-verified live, but the class is prevented only by author discipline. A single future omission in a staff-rendered field re-opens a path from an alumnus into a `super_admin` session. | ENGINEERING |
| 3 | Three CDN scripts with no Subresource Integrity, loaded into both portals including `admin.html`. | `index.html:30-31, 908`; `admin.html:31-32, 715` | Hardening rather than an exploitable defect today, but the consequence if it is exploited is identical to #2 and the fix is an afternoon's work. | ENGINEERING |
| 4 | `pg_dump` backups are not encrypted at rest and contain all plaintext PII plus vault ciphertext. | `backup.js` | The largest single concentration of personal data the platform produces, protected only by filesystem permissions and wherever it is copied. | HOSTING PROVIDER (storage), DIC (handling policy) |
| 5 | Bearer tokens with no session table: no selective revocation, no active-session list, no device or address binding, no reuse detection. 12 hours is the whole containment. | `server.js:272-347`, `api.js:7-15` | Makes a stolen token or a compromised session maximally useful and minimally visible. Deliberate architectural choice; the trade should be revisited explicitly. | ENGINEERING |
| 6 | `TRUST_PROXY` must be set to the true hop count; both a too-high and a too-low value fail silently, and too high restores full `X-Forwarded-For` forgery. | `server.js:44-50` | The measured pre-fix impact was total evasion of both login throttles plus a poisoned audit trail. The fix moved the risk from code to configuration. | HOSTING PROVIDER, DIC |
| 7 | `dept_admin` is institution-wide; there is no department scoping anywhere in the authorisation path. | `server.js:441-443`, `privacy.js:83` | Documented and accepted for one college. The role's name promises a scope the code does not implement, which is a comprehension risk for whoever grants it next. | DIC (grant policy), ENGINEERING (if scoping is ever wanted) |
| 8 | `ADMIN_ROLES` can decrypt any identity document at any time, gated only by a five-character free-text reason. Detective controls only. | `routes_compliance.js:120-155` | The most sensitive data on the platform behind the weakest friction. Fully audited, entirely unrestricted. | ENGINEERING (rate limit/alerting), DIC (who holds the role) |
| 9 | `GET /api/directory/search` and `GET /api/events/:id/people` return mobile and WhatsApp numbers with no privacy predicate, so a moderator sees through them what `privacy.js` denies them elsewhere. | `routes_events.js:1381-1400`, `1237-1272` | Two API paths disagree about what one role may read. Staff-only, but it makes the privacy model untrue as stated. | ENGINEERING |
| 10 | The login rate limiter is in-process, so it is per-instance on serverless and lost on restart; the durable lock is per-account only, so a one-guess spray across many accounts is unthrottled. | `server.js:552-651` | Meaningfully reduces but does not cap credential stuffing. Stated plainly in the code's own comments. | ENGINEERING |
| 11 | `identity_vault` has no key id or key version column, so `ENCRYPTION_KEY` cannot be rotated without downtime and a full re-encrypt. The same key also signs ticket QR codes. | `routes_v2.js:14-40`, `routes_events.js:31-47` | An operational constraint rather than a vulnerability, but it means a suspected key exposure has no clean remedy. | ENGINEERING (schema), DIC (key custody) |
| 12 | The external branch of `taskSelect` returns `phone` and `whatsapp` without the `staff` gate, so a non-staff co-assignee reads an external contact's numbers. | `routes_events.js:849-861` | Narrow, but it is the same class as P3-9 left unclosed on the other branch, and external contacts have no way to express a preference. | ENGINEERING |
| 13 | Bulk import can overwrite an existing member's profile by matching on the last ten digits of a mobile number, with no notification to the member; `photoUrl` and `facebook` accept any scheme; `records` has no explicit length cap. | `server.js:2011-2018, 2035-2036` | Requires an `ADMIN_ROLES` actor and a hostile file, which is the realistic supply-chain shape for a departmental roster. | ENGINEERING |
| 14 | `routes_planner.js:75-76` calls `serverError` without destructuring it, so a rejection on three staff-only planner routes throws in the handler and no response is sent. | `routes_planner.js:75-76` | Availability only, staff only, and it takes a database failure to trigger. Listed because it is a live defect found while writing this document. | ENGINEERING |
| 15 | Registration returns 409 for an existing address, and login/reset are careful not to; account creation is unrated-limited. | `server.js:809`, `server.js:793` | Accepted: every signed-in member can already see the entire directory, so a member's address is not a secret this endpoint protects. Listed for completeness, not as an open hole. | DIC (accepted) |

---

## 16. Test position

Twenty-one suites, 1,520 checks, 0 failures.

`tests/security_smoke.js` is new in Phase 5F: 109 checks across 14 sections —
anonymous access to every route parsed out of the source, staff-surface denial,
role escalation, IDOR, SQL injection, XSS, CORS, host routing, rate limiting
including the forged `X-Forwarded-For` case, session revocation, privacy, bulk
import and the enrolment gate, scheduler authorisation, and disclosure and
headers. It is self-contained: it registers its own accounts, promotes throwaway
ones to staff roles in the database, and deletes everything at the end.

`npm run verify-audit-chain` passes through 2,832 entries, exit 0.

A reviewer should read the test position as evidence that the fixed findings stay
fixed, not as evidence that the system is free of unfixed ones. The two P0
findings were both found by manual reading and proved in a live browser, not by
any test that existed before them — and BUG-13 shows that a test which appeared
to cover a case had been silently skipping it.

---

## 17. Explicitly known and accepted

An adversarial verification pass refuted 18 candidate findings during Phase 5F.
These five are the ones a reviewer is most likely to raise, and each is a
deliberate position with reasoning, not an oversight:

| Item | Position | Reasoning |
|---|---|---|
| Unkeyed audit chain | **Accepted design, documented limitation** — not presented as a vulnerability | `AUDIT_CHAIN.md` §4 states it in the project's own words, says an HMAC is the obvious next improvement, and says the stated guarantees assume it is absent. It is ranked #1 in the residual table because accepting a limitation does not make it small. |
| `dept_admin` is institution-wide | **Accepted simplification** | Single-college deployment; there is no second institution for a department scope to separate. Named honestly rather than implied by the role's name. |
| Registration returns 409 for an existing address | **Accepted** | An enumeration oracle only matters where membership is not already visible. Every signed-in member sees the full directory, so a member's address is not a secret. |
| Missing SRI on CDN scripts | **Hardening gap, not an exploitable defect today** | No known compromise of the served files; the risk is a third-party or transport compromise. Reported as an open gap and ranked #3 — a reviewer should expect it to be closed, not argued away. |
| `identity_vault` has no key version | **Operational constraint** | Rotation requires downtime and a full re-encrypt. The schema could carry a `key_id`; it does not, and no rotation runbook exists that avoids downtime. |
