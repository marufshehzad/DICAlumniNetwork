# Status vocabularies — the canonical mapping

Phase 7D, §17. Recorded 2026-09-07.

Every status column in the platform, the values its `CHECK` constraint permits,
what each one means, the label the interface shows, and which transitions the
server actually allows.

**Nothing here was renamed for consistency.** The vocabularies differ between
modules because they were written at different times, and a rename would churn
the schema, invalidate stored rows and break every query and test that names a
value — in exchange for tidiness. Where two modules disagree in *wording* but
agree in *meaning*, that is noted rather than corrected. Only one value was ever
migrated in this platform (`polls.is_active` → `polls.status`, Phase 7C-2) and
that was because a boolean could not express a third state.

One inconsistency is real and is called out at the end.

---

## Alumni accounts

### `users.status`
| DB value | UI label | Meaning |
|---|---|---|
| `active` | Active | Can sign in and use the platform |
| `suspended` | Suspended | Cannot sign in; an administrator's decision |

Transitions: `active ⇄ suspended`, by a super administrator only
(`routes_admin_users.js`). Suspension also blocks password reset — recovering a
suspended account is an administrator's decision, not the holder's.

### `users.is_verified` (boolean, not a status column)
Verified means an administrator has confirmed the person is a DIC alumnus.
Unverified accounts sign in but are refused every action behind `requireVerified`
(Phase 7C-1). Set by `PUT /api/users/:id/verify`, which as of Phase 7D is
department-scoped.

---

## Events

### `events.status` — where the event is in time
| DB value | UI label | Meaning |
|---|---|---|
| `upcoming` | Upcoming | Starts in the future |
| `ongoing` | Ongoing | Running today |
| `past` | Past | Finished |
| `cancelled` | Cancelled | Called off; distinct from past |

`upcoming`/`ongoing`/`past` are **derived from `starts_on`** by a scheduled sweep,
not set by hand. `cancelled` is set by an administrator and the sweep never
overwrites it.

### `events.approval_status` — whether it may be seen
| DB value | UI label | Meaning |
|---|---|---|
| `draft` | Draft | Not submitted |
| `pending_approval` | Pending approval | Awaiting an administrator |
| `approved` | Approved | Visible to members |
| `rejected` | Rejected | Refused, with a reason |

Transitions: a moderator or department administrator creating an event produces
`pending_approval`; an administrator creating one produces `approved` directly.
`pending_approval → approved | rejected` by `ADMIN_ROLES` only. There is **one**
event approval path — the Event workspace — verified in Phase 7D §12.

### `event_registrations.status`
| DB value | UI label | Meaning |
|---|---|---|
| `confirmed` | Confirmed | Holds a ticket |
| `waitlisted` | Waitlisted | Capacity reached |
| `cancelled` | Cancelled | Given up by the holder |

Only `confirmed` counts toward capacity and toward every attendance figure.

### `event_tasks.status`
`todo` → To do · `in_progress` → In progress · `blocked` → Blocked ·
`completed` → Completed. Any transition is allowed; a task can go back.

### Event planner sub-modules
Each carries its own small vocabulary, all of them live:
`event_timeline.status` (`pending`/`in_progress`/`done`/`delayed`),
`event_logistics.status` (`planned`/`arranged`/`on_site`/`returned`),
`event_marketing.status` (`planned`/`live`/`completed`/`paused`),
`event_meetings.status` (`scheduled`/`held`/`cancelled`),
`event_vendors.status` (`shortlisted`/`contracted`/`paid`/`rejected`),
`event_sponsors.pipeline_status` (`proposed`/`agreed`/`received`/`rejected`),
`event_procurement.delivery_status` (`requested`/`ordered`/`delivered`),
`event_volunteers.attendance_status` (`assigned`/`checked_in`/`absent`).

---

## Jobs

### `jobs.status`
| DB value | UI label | Meaning |
|---|---|---|
| `open` | Open | Accepting applications |
| `closed` | Closed | Deliberately closed by the poster |

**Expired is not a stored value.** A posting past its `deadline` is derived as
expired at read time and shown as *Deadline passed*. Storing it would need a job
to run and would be wrong between runs.

Transitions: `open ⇄ closed`, by the poster or `ADMIN_ROLES`.

### `job_applications.status`
| DB value | UI label | Meaning |
|---|---|---|
| `submitted` | Received | The applicant has applied |
| `reviewing` | Reviewing | Being read |
| `shortlisted` | Shortlisted | Under serious consideration |
| `rejected` | Not proceeding | Declined |
| `hired` | Hired | Offer accepted |

`submitted` is labelled **Received** rather than renamed to `pending`: the label
is what a person reads, and churning a constrained column to match a word is not
worth a migration.

Transitions: any state to any state, by the job's poster or an administrator.
Deliberately not a one-way pipeline — an employer who shortlists by mistake must
be able to undo it.

### `job_referrals.status`
| DB value | UI label | Meaning |
|---|---|---|
| `pending` | Awaiting a reply | Asked, not yet answered |
| `accepted` | Accepted | The referrer agreed to vouch |
| `declined` | Declined | The referrer said no |

Transitions: `pending → accepted | declined`, **once**, and **only by the person
it was addressed to**. An administrator is deliberately refused: accepting a
referral is a personal vouching.

---

## Polls

### `polls.status`
| DB value | UI label | Meaning |
|---|---|---|
| `draft` | Draft | Written, not yet open |
| `open` | Open | Members may vote |
| `closed` | Closed | Voting finished |

Transitions: `draft → open → closed`. **`closed → open` is refused** — votes were
cast under a stated closing, and the correct move is a new poll. An `open` poll
cannot be edited, because votes are recorded against option positions.

A poll whose `closes_at` has passed reads as closed and refuses votes even while
its stored status is `open`; `is_live` is the server's answer and the interface
follows it.

---

## Donations

### `donations.status` — **the one real inconsistency**
| DB value | UI label | Meaning |
|---|---|---|
| `PLEDGED` | Pledged | Promised, no money received |
| `PENDING` | Pending | In flight at a gateway |
| `SUCCESS` | Settled | Money received |
| `FAILED` | Failed | The payment did not go through |
| `REFUNDED` | Refunded | Returned to the donor |
| `CANCELLED` | Cancelled | Withdrawn |

**These are the only UPPERCASE status values in the platform.** Every other
column is lowercase. This is a genuine inconsistency and it was **not migrated**:
`donations` holds real financial records, the values are named in queries,
reports, tests and the ledger export, and rewriting them would gain consistency
in exchange for touching money data. It is recorded here so the next person
meets it as a documented decision rather than as a surprise.

Only `SUCCESS` counts as settled giving. Every campaign total in the platform is
`SUM(amount) WHERE status = 'SUCCESS'`.

---

## Mentorship

### `mentorships.status`
`pending` → Awaiting a reply · `accepted` → Active · `declined` → Declined ·
`expired` → Expired · `completed` → Completed.

Transitions: `pending → accepted | declined | expired`; `accepted → completed`.
`expired` is set by the scheduled sweep from `expires_at`.

---

## Moderation and content

### `chapters.status` and `stories.status`
Chapters: `pending_review` → Awaiting review · `approved` → Approved ·
`rejected` → Rejected.
Stories: `pending_review` → Awaiting review · `published` → Published ·
`rejected` → Rejected.

Same shape, one different word: a chapter is *approved*, a story is *published*.
That reads correctly in both places and is left alone.

### `connections.status`
`pending` / `accepted` / `declined` — the same three words as `job_referrals`,
and they mean the same thing. Consistent already.

---

## Operations and compliance

| Column | Values |
|---|---|
| `broadcasts.status` | `draft` / `sent` / `failed` |
| `deletion_requests.status` | `pending` / `cancelled` / `completed` |
| `import_history.status` | `completed` / `rolled_back` (Phase 7C-3) |
| `ops_runs.status` | `running` / `ok` / `failed` / `skipped` |

---

## Retained history

`legacy_event_proposals.status` (`draft` / `pending_approval` / `approved` /
`in_planning` / `completed` / `rejected`) belongs to the pre-v5 proposal
workflow. No code reads it. Retained, read-only — see `schema_v19.sql`.

---

## Summary of what was and was not changed

| Decision | Outcome |
|---|---|
| Rename `submitted` → `pending` on applications | **No.** Labelled *Received* instead. |
| Lowercase the donation statuses | **No.** Real financial records; documented instead. |
| Unify `approved` / `published` across chapters and stories | **No.** Both read correctly. |
| Add `expired` to `jobs.status` | **No.** Derived from `deadline` at read time. |
| Allow `closed → open` on polls | **No.** Refused deliberately. |
