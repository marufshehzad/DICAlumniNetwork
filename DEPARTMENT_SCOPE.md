# Department scope — what is scoped, what is not, and why

Phase 7D, §2 and §16. Recorded 2026-09-07.

## The model

One question, three answers, decided by the role and one foreign key. There is
no permission table, no policy engine and nothing configurable. The whole
definition is `scope.js`.

| Role | Scope |
|---|---|
| `super_admin` | Every department, and records belonging to none |
| `univ_admin` | Every department, and records belonging to none |
| `dept_admin` | Its own department, and nothing else |
| `moderator` | Not department-scoped — moderation is a platform-wide queue |
| `alumni` | Not department-scoped — governed by privacy and ownership |

Two rules make the rest follow:

**Fail closed.** A `dept_admin` with no `department_id` reaches *nothing*, not
everything. `scope.sqlFor` emits `AND FALSE` for that case, and the difference
between that and an empty string is the entire security property.

**A record with no department belongs to the institution.** An alumnus whose
department was never captured, an event organised by no single department:
institution-wide roles see them, no department admin does. That is the honest
reading of "we do not know" and the safe one — an unknown record is never handed
to the wrong department by default.

`moderator` is `unscoped`, which is deliberately **not** the same as `none`.
Collapsing the two would have silently emptied the moderation and event screens
for the one role that exists to work them.

---

## Resource classification

### DEPARTMENT-SCOPED

| Resource | Scoped on | Enforced in |
|---|---|---|
| Verification queue | `users.department_id` | `server.js` — `GET /api/verification-queue` |
| Verifying an account | `users.department_id` of the target | `server.js` — `PUT /api/users/:id/verify` |
| Alumni Directory report | `u.department_id` | `routes_reports.js` |
| Verification report | `u.department_id` | `routes_reports.js` |
| Event Attendance report | `e.department_id` | `routes_reports.js` |
| Ticket & Registration report | `e.department_id` | `routes_reports.js` |
| Event editing | `events.department_id` | `routes_events.js` — `guardEventScope` |
| Event ticket types, tasks, checklist, people, external people | the parent event's `department_id` | `routes_events.js` |
| Event creation | the creator's own scope | `routes_events.js` |
| Bulk import rows | the row's resolved department | `server.js` — `POST /api/bulk-import` |
| Audit log read | target account's department, plus the reader's own actions | `routes_v2.js` — `auditScopeClause` |

### GLOBAL — and why

| Resource | Why not scoped |
|---|---|
| Alumni directory browsing (`/api/alumni`) | A member browses the whole alumni body; that is the product. Privacy settings govern what they see, not department. |
| Job board, applications, referrals | A job is open to every graduate. Scoping the board by the poster's department would hide CSE jobs from BBA alumni for no reason. `dept_admin` has no administrative power over jobs in any case — job administration is `ADMIN_ROLES`. |
| Chapters | A chapter is geographic, not departmental. A Dhaka chapter has members from every department. |
| Polls, broadcasts, news | Addressed to the whole alumni body. |
| Donations and campaigns | Institutional fundraising. `dept_admin` has no access at all (`ADMIN_ROLES`). |
| Moderation queue | Platform-wide by definition, and `moderator` is the role that works it. |
| Mentorship | Cross-department matching is the point of it. |
| Platform security, audit chain verification, operations, scheduler | Platform matters. Never departmental. |
| Notifications | Addressed to a person or a role, not a department. |
| Platform configuration, `.env`, provisioning | Not data. |

### Explicitly NOT scoped, per §2's own instruction

Platform-wide audit *as a whole*, security, system settings, public content,
global notifications and platform configuration are not department-scoped. What
Phase 7D added is a *narrower* audit read for `dept_admin` — its own
department's accounts and its own actions — with every platform-security action
denied whatever the department. It is a restriction on a role that previously had
no audit access at all, not a widening of the platform log.

---

## Audit visibility (§7)

| Role | Sees |
|---|---|
| `super_admin` | Every entry |
| `univ_admin` | Every entry |
| `dept_admin` | Entries whose target is an account in its own department, plus its own actions — and never a platform-security action |
| `moderator` | No access |
| `alumni` | No access |

The deny-list is on the **action**, not the module, because a module is a coarse
grouping: `Administration` contains both an ordinary profile edit and a role
change. Anything unrecognised is denied to a scoped reader, so an action added
later is invisible to a department admin until somebody decides it should not be.

Denied prefixes: `Administrator`, `Password`, `Signed In`, `Signed Out`,
`Sign-In Failed`, `Session`, `Vault`, `Identity`, `Database`, `Scheduler`,
`Ops`, `Sync`, `DSAR`, `Account Purged`, `Account Deletion`,
`Audit Log Exported`, `Bulk Import`, `Import Batch`.

---

## People search (§16)

The platform has several ways to find a person, and they are **not** duplicates
of one another. The distinction that matters, and which Phase 7D preserves:

> **A DIC system user is not an external event contact.**

| Search | Searches | Returns |
|---|---|---|
| Alumni Directory | `users` + `alumni_profiles`, privacy-filtered | Members, as profiles |
| Event assignee picker | `users` with a staff or member role | Accounts that can be assigned work |
| Event external people | `event_people` | Contacts with no account — a caterer, a guest speaker |
| Chapter member search | `chapter_memberships` | Members of one chapter |
| Mentorship search | `alumni_profiles` filtered on `can_mentor` | Members offering to mentor |
| Connections | `connections` | A member's own network |

**No UI was redesigned and no search was merged.** They answer different
questions over different tables, and consolidating them into one endpoint would
mean either returning external contacts where an account is required — the
assignee picker would offer a caterer as a task owner — or dropping external
contacts from the one place they exist.

What Phase 7D established instead is the shared *strategy* they all now follow:

1. **Identity comes from the row, never from the request.** Every one of these
   resolves a person by id against the database.
2. **Privacy is applied in SQL** (`privacy.js`), not by the caller.
3. **Department scope, where it applies, is applied by `scope.js`** and by
   nothing else.

A future consolidation, if it is ever wanted, has one prerequisite: `event_people`
would need a nullable `user_id` link so a single query could return both kinds
with a flag distinguishing them. That is a data-model change, not a UI one, and
it was not in this phase's scope.
