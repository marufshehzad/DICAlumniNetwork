# Security Authorization Matrix — DIC Alumni Platform

Every route the application registers, the guard it declares, and who that guard
admits. Generated from the source, then **verified empirically** against a
running deployment: each non-template route was called as all five roles and as
an anonymous caller, and the observed result compared against the declared one.

**Method.** "Allowed" means the guard let the request reach the handler — not
that the handler succeeded. A permitted call against a nonexistent id returns
404 or 400, and that still counts as allowed, because this table is about
authorisation and nothing else. Denials are 401 (no session, stale session) or
403 (wrong role, suspended account, enrolment incomplete).

**Roles.** `SUPER_ONLY` = super_admin. `ADMIN_ROLES` = super_admin,
univ_admin. `MODERATOR_ROLES` = those two plus dept_admin and moderator.
`AUTH` = any signed-in account. There is **no department scoping**: a
dept_admin has institution-wide authority at the moderator tier. That is a
documented, accepted simplification of the role model, not a defect.

**The staff portal is not a security boundary.** `admin.html` and
`index.html` differ only in which JavaScript modules they load. Every
authorisation decision below is made by the API, on every request, from the
role re-read out of the `users` row — not from the token, and not from which
HTML shell the browser was served.

| Guard | Routes |
|---|---|
| `AUTH` | 63 |
| `MODERATOR_ROLES` | 41 |
| `ADMIN_ROLES` | 20 |
| `SUPER_ONLY` | 7 |
| `public` | 5 |
| `SCHEDULER` | 2 |
| **total** | **138** |

## Verification result

- Routes parsed from source: **138**
- Routes probed as all six callers: **129**. The remainder are either built from a template (the planner routes, covered by their generated instances) or would destroy the probe's own session as a side effect of being called — sign-out, password change, password reset and account erasure. Those five are verified directly in `tests/security_smoke.js` sections C, J and L.
- Authorisation checks performed: **774**
- Mismatches between declared and observed: **0**

Every route admitted exactly the callers its guard declares, and no others.

Expected exceptions — the environment tightens a guard further, so the denial is
the system working rather than a discrepancy:

- POST /api/seed-db — refused outright when NODE_ENV=production unless ALLOW_DB_RESEED=true

## The five public routes

These are unauthenticated by design. Everything else refuses an anonymous caller.

| Route | Why it is public | What limits it |
|---|---|---|
| `GET /api/health` | Liveness probe for the load balancer and the operations panel | Returns only `{status, database, latencyMs}`; no version, no configuration |
| `POST /api/auth/login` | The sign-in endpoint | Per-IP and per-account throttling; a durable account lock checked *before* the password comparison; identical response for an unknown address and a wrong password |
| `POST /api/auth/register` | Alumni self-registration | Role in the body is ignored; the account is created as `alumni`, unverified |
| `POST /api/auth/forgot-password` | Self-service recovery | Throttled; the same neutral response whether or not the address exists |
| `POST /api/auth/reset-password` | Consumes a reset token | Token is stored hashed, single-use, 30-minute expiry; bumps `token_version` |

## Full matrix

Ownership column: what the handler checks *beyond* the role. `—` means the
guard is the only check, which is correct for routes that do not address one
person's record.

| Route | Method | Anon | Alumni | Mod | Dept | Univ | Super | Ownership | Sensitive data | Expected denial | Source |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|---|---|---|---|
| `/api/admin/administrators` | GET | — | — | — | — | — | ✅ | — | credentials | 401 anon · 403 wrong role | `routes_admin_users.js:76` |
| `/api/admin/administrators` | POST | — | — | — | — | — | ✅ | — | credentials | 401 anon · 403 wrong role | `routes_admin_users.js:93` |
| `/api/admin/administrators/:id` | GET | — | — | — | — | — | ✅ | — | credentials | 401 anon · 403 wrong role | `routes_admin_users.js:83` |
| `/api/admin/administrators/:id` | PUT | — | — | — | — | — | ✅ | — | — | 401 anon · 403 wrong role | `routes_admin_users.js:140` |
| `/api/admin/administrators/:id/reset-password` | POST | — | — | — | — | — | ✅ | — | credentials | 401 anon · 403 wrong role | `routes_admin_users.js:245` |
| `/api/admin/administrators/:id/status` | PUT | — | — | — | — | — | ✅ | — | credentials | 401 anon · 403 wrong role | `routes_admin_users.js:205` |
| `/api/alumni` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | location | 401 anon | `server.js:1091` |
| `/api/alumni/:id` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon | `server.js:1211` |
| `/api/audit-logs` | GET | — | — | — | — | ✅ | ✅ | — | audit trail | 401 anon · 403 wrong role | `routes_v2.js:756` |
| `/api/auth/change-password` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | credentials | 401 anon | `server.js:870` |
| `/api/auth/forgot-password` | POST | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | credentials | 200 | `server.js:948` |
| `/api/auth/login` | POST | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | credentials | 200 | `server.js:656` |
| `/api/auth/logout` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | credentials | 401 anon | `server.js:1056` |
| `/api/auth/me` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon | `server.js:1070` |
| `/api/auth/register` | POST | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | contact/address | 200 | `server.js:793` |
| `/api/auth/reset-password` | POST | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | credentials | 200 | `server.js:1003` |
| `/api/broadcasts` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | audit trail | 401 anon · 403 wrong role | `routes_v2.js:710` |
| `/api/broadcasts` | POST | — | — | — | — | ✅ | ✅ | — | audit trail | 401 anon · 403 wrong role | `routes_v2.js:718` |
| `/api/bulk-import` | POST | — | — | — | — | ✅ | ✅ | — | contact/address | 401 anon · 403 wrong role | `server.js:1942` |
| `/api/campaigns` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon | `routes_v2.js:225` |
| `/api/campaigns` | POST | — | — | — | — | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_v2.js:249` |
| `/api/campaigns/:id` | DELETE | — | — | — | — | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_v2.js:285` |
| `/api/campaigns/:id` | PUT | — | — | — | — | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_v2.js:273` |
| `/api/chapters` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `server.js:1516` |
| `/api/chapters` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `server.js:1541` |
| `/api/chapters/:id/join` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `server.js:1582` |
| `/api/chapters/:id/members` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon | `server.js:1623` |
| `/api/compliance/status` | GET | — | — | — | — | ✅ | ✅ | — | identity vault | 401 anon · 403 wrong role | `routes_compliance.js:269` |
| `/api/connections` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `routes_v2.js:650` |
| `/api/connections/:userId` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `routes_v2.js:660` |
| `/api/consent` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon | `routes_compliance.js:70` |
| `/api/consent` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon | `routes_compliance.js:28` |
| `/api/custom-fields` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | party to the record | — | 401 anon | `routes_v2.js:453` |
| `/api/custom-fields` | POST | — | — | — | — | ✅ | ✅ | party to the record | — | 401 anon · 403 wrong role | `routes_v2.js:458` |
| `/api/custom-fields/:id` | DELETE | — | — | — | — | ✅ | ✅ | scoped to req.user.uid | location | 401 anon · 403 wrong role | `routes_v2.js:473` |
| `/api/directory/search` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon · 403 wrong role | `routes_events.js:1382` |
| `/api/donations` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon | `routes_v2.js:305` |
| `/api/donations/:id/cancel` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | financial | 401 anon | `routes_v2.js:405` |
| `/api/donations/:id/record-payment` | POST | — | — | — | — | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_v2.js:344` |
| `/api/donations/leaderboard` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon | `routes_v2.js:431` |
| `/api/donations/mine` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | financial | 401 anon | `routes_v2.js:422` |
| `/api/dsar/delete` | DELETE | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon | `routes_compliance.js:257` |
| `/api/dsar/delete` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon | `routes_compliance.js:251` |
| `/api/dsar/delete` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon | `routes_compliance.js:233` |
| `/api/dsar/export` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | financial | 401 anon | `routes_compliance.js:171` |
| `/api/events` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | financial | 401 anon | `routes_events.js:173` |
| `/api/events` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:260` |
| `/api/events/:id` | DELETE | — | — | — | — | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:458` |
| `/api/events/:id` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | financial | 401 anon | `routes_events.js:204` |
| `/api/events/:id` | PUT | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:352` |
| `/api/events/:id/approve` | PUT | — | — | — | — | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:391` |
| `/api/events/:id/attendees` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_events.js:740` |
| `/api/events/:id/attendees.csv` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_events.js:744` |
| `/api/events/:id/cancel` | PUT | — | — | — | — | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:435` |
| `/api/events/:id/external-people` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:1307` |
| `/api/events/:id/my-ticket` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | contact/address | 401 anon | `routes_events.js:711` |
| `/api/events/:id/overview` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_events.js:223` |
| `/api/events/:id/people` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon · 403 wrong role | `routes_events.js:1237` |
| `/api/events/:id/people` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:1277` |
| `/api/events/:id/register` | DELETE | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | contact/address | 401 anon | `routes_events.js:683` |
| `/api/events/:id/register` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `routes_events.js:527` |
| `/api/events/:id/reject` | PUT | — | — | — | — | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:411` |
| `/api/events/:id/tasks` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon | `routes_events.js:883` |
| `/api/events/:id/tasks` | POST | — | — | ✅ | ✅ | ✅ | ✅ | staff-tier branch | — | 401 anon · 403 wrong role | `routes_events.js:917` |
| `/api/events/:id/tasks/standard-checklist` | POST | — | — | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon · 403 wrong role | `routes_events.js:962` |
| `/api/events/:id/ticket-types` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon | `routes_events.js:476` |
| `/api/events/:id/ticket-types` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:480` |
| `/api/events/checkin` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:757` |
| `/api/events/external-people/:personId` | PUT | — | — | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon · 403 wrong role | `routes_events.js:1347` |
| `/api/events/mine` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `routes_events.js:161` |
| `/api/events/people/:personId` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon · 403 wrong role | `routes_events.js:1371` |
| `/api/events/tasks/:taskId` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | staff-tier branch | — | 401 anon · 403 wrong role | `routes_events.js:1109` |
| `/api/events/tasks/:taskId` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon | `routes_events.js:901` |
| `/api/events/tasks/:taskId` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon | `routes_events.js:991` |
| `/api/events/tasks/:taskId/assignees` | POST | — | — | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon · 403 wrong role | `routes_events.js:1120` |
| `/api/events/tasks/:taskId/assignees/:userId` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon · 403 wrong role | `routes_events.js:1173` |
| `/api/events/tasks/:taskId/assignees/person/:personId` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon · 403 wrong role | `routes_events.js:1180` |
| `/api/events/tasks/:taskId/checklist` | POST | — | — | ✅ | ✅ | ✅ | ✅ | taskAccess() | contact/address | 401 anon · 403 wrong role | `routes_events.js:1203` |
| `/api/events/tasks/:taskId/notes` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | taskAccess() | — | 401 anon | `routes_events.js:1188` |
| `/api/events/tasks/:taskId/verify` | PUT | — | — | ✅ | ✅ | ✅ | ✅ | staff-tier branch | — | 401 anon · 403 wrong role | `routes_events.js:1086` |
| `/api/events/tasks/checklist/:itemId` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon · 403 wrong role | `routes_events.js:1228` |
| `/api/events/tasks/checklist/:itemId` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | taskAccess() | contact/address | 401 anon | `routes_events.js:1215` |
| `/api/events/tasks/reminder-sweep` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_events.js:1489` |
| `/api/events/ticket-types/:ttId` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon · 403 wrong role | `routes_events.js:508` |
| `/api/events/ticket-types/:ttId` | PUT | — | — | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon · 403 wrong role | `routes_events.js:494` |
| `/api/health` | GET | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 200 | `server.js:534` |
| `/api/import-history` | GET | — | — | — | — | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `server.js:2175` |
| `/api/internal/jobs/run` | GET | — | — | — | — | — | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2744` |
| `/api/internal/jobs/run` | POST | — | — | — | — | — | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2743` |
| `/api/job-referrals` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon | `server.js:2497` |
| `/api/jobs` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | poster only | — | 401 anon | `routes_v2.js:92` |
| `/api/jobs` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | poster only | — | 401 anon | `routes_v2.js:111` |
| `/api/jobs/:id` | DELETE | — | ✅ | ✅ | ✅ | ✅ | ✅ | poster only | — | 401 anon | `routes_v2.js:148` |
| `/api/jobs/:id` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | poster only | — | 401 anon | `routes_v2.js:132` |
| `/api/jobs/:id/applicants` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | poster only | financial | 401 anon | `routes_v2.js:183` |
| `/api/jobs/:id/apply` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | poster only | — | 401 anon | `routes_v2.js:160` |
| `/api/jobs/:id/refer` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon | `routes_v2.js:202` |
| `/api/locations/filters` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | location | 401 anon | `server.js:1491` |
| `/api/locations/places` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | location | 401 anon | `server.js:1449` |
| `/api/mentorships` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | location | 401 anon | `routes_v2.js:492` |
| `/api/mentorships` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `routes_v2.js:571` |
| `/api/mentorships/:id/:action` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | party to the record | — | 401 anon | `routes_v2.js:612` |
| `/api/mentorships/suggestions` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | location | 401 anon | `routes_v2.js:516` |
| `/api/moderation` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:1715` |
| `/api/moderation/chapter/:id/:action` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:1734` |
| `/api/moderation/story/:id/:action` | POST | — | — | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon · 403 wrong role | `server.js:1768` |
| `/api/notifications` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `server.js:1805` |
| `/api/notifications/:id/read` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `server.js:1826` |
| `/api/notifications/read-all` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `server.js:1843` |
| `/api/ops/status` | GET | — | — | — | — | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2750` |
| `/api/planner/${path}` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_planner.js:24` |
| `/api/planner/${path}` | POST | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_planner.js:31` |
| `/api/planner/${path}/:id` | DELETE | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_planner.js:66` |
| `/api/planner/${path}/:id` | PUT | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_planner.js:53` |
| `/api/planner/analytics/:eventId` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_planner.js:146` |
| `/api/planner/report/:eventId` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `routes_planner.js:211` |
| `/api/planner/workspace/:eventId` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `routes_planner.js:254` |
| `/api/polls/:id/vote` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon | `routes_v2.js:690` |
| `/api/polls/active` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | — | 401 anon | `routes_v2.js:680` |
| `/api/profile/me` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | contact/address | 401 anon | `server.js:1305` |
| `/api/profile/me` | PUT | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | location | 401 anon | `server.js:1357` |
| `/api/profile/privacy-schema` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | location | 401 anon | `server.js:1478` |
| `/api/seed-db` | POST | — | — | — | — | — | ✅ | — | — | 401 anon · 403 wrong role | `server.js:553` |
| `/api/segment/count` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2562` |
| `/api/segment/options` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2532` |
| `/api/stats/analytics` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | financial | 401 anon · 403 wrong role | `server.js:2295` |
| `/api/stats/map` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | location | 401 anon | `server.js:2375` |
| `/api/stats/overview` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | scoped to req.user.uid | financial | 401 anon | `server.js:2213` |
| `/api/stats/rbac` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon | `server.js:2441` |
| `/api/stories` | GET | — | ✅ | ✅ | ✅ | ✅ | ✅ | party to the record | — | 401 anon | `server.js:1664` |
| `/api/stories` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | party to the record | — | 401 anon | `server.js:1676` |
| `/api/sync-mutations` | GET | — | — | — | — | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2473` |
| `/api/users/:id/verify` | PUT | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2599` |
| `/api/vault` | GET | — | — | — | — | ✅ | ✅ | — | identity vault | 401 anon · 403 wrong role | `routes_compliance.js:78` |
| `/api/vault` | POST | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | identity vault | 401 anon | `routes_compliance.js:90` |
| `/api/vault/:id/reveal` | POST | — | — | — | — | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon · 403 wrong role | `routes_compliance.js:121` |
| `/api/vault/access-logs` | GET | — | — | — | — | ✅ | ✅ | scoped to req.user.uid | identity vault | 401 anon · 403 wrong role | `routes_compliance.js:157` |
| `/api/verification-queue` | GET | — | — | ✅ | ✅ | ✅ | ✅ | — | — | 401 anon · 403 wrong role | `server.js:2618` |

## Notes on individual rows

- `GET|POST /api/internal/jobs/run` — guarded by `CRON_SECRET`, compared with
  `timingSafeEqual`. A `super_admin` session is an accepted alternative
  credential so an operator can run a job by hand from the operations panel. The
  refusal is a bare 401 that says nothing about which credential was missing.
- `POST /api/vault` is `requireAuth` because a member submits their own
  identity document. Reading (`GET /api/vault`) and revealing
  (`POST /api/vault/:id/reveal`) are `ADMIN_ROLES`, and every reveal is
  written to `vault_access_logs`.
- `PUT /api/events/tasks/:taskId` and `GET /api/events/tasks/:taskId` are
  `requireAuth` but call `taskAccess()`, which resolves the caller's
  relationship to the task. A member who is not an assignee gets 403.
- `PUT /api/jobs/:id`, `DELETE /api/jobs/:id` and
  `GET /api/jobs/:id/applicants` are `requireAuth` and ownership-checked
  against `posted_by_id`. Verified: another member gets 403 on all three.
- `GET /api/dsar/export` and `DELETE /api/dsar/delete` act on the caller's own
  record only. A `?userId=` in the query string is ignored — verified.
- `GET /api/mentorships/suggestions` returns `city` only for members whose
  location privacy is not `private`, and gates the "matches your city" flag on
  the same condition.
- Every route taking `:id`, `:userId`, `:taskId`, `:personId`, `:ttId`,
  `:eventId`, `:itemId` or `:vaultId` rejects a non-numeric value with 400
  before the handler runs. `/api/custom-fields/:id` is exempt because
  `custom_fields.id` is a varchar key.

## What this table does not tell you

It shows who may *call* a route. It does not show what the response *contains* —
field-level privacy is enforced separately, in `privacy.js` and in the SQL of
each handler, and is covered by section K of `tests/security_smoke.js` and by
`tests/phase5a_security.js`. A reviewer should treat "may call" and "may see"
as two different questions.
