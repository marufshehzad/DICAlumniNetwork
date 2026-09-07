-- ════════════════════════════════════════════════════════════
-- DIC ALUMNI PLATFORM — SCHEMA v19
-- Phase 7D: legacy cleanup, and the one department assignment a migration
-- may honestly make.
--
-- Everything removed here was verified unread before it was touched: the
-- reference count is in PHASE_LOG.md and the code that wrote each counter was
-- deleted in the same commit, so this drops nothing the running system uses.
--
-- ─── PART A. THE SEEDED DEPARTMENT ADMINISTRATOR ────────────
--
-- v17 deliberately assigned no staff department, because a migration guessing
-- which department an administrator governs is a migration handing out
-- authority. This is the one case where it is not a guess: there is exactly one
-- dept_admin, its department column reads 'CSE Department', its role label
-- reads 'Dept Admin (CSE)', and leaving it unassigned leaves the platform's
-- only department administrator unable to do anything at all — which is
-- correct behaviour for an unknown scope and useless behaviour for a known one.
--
-- It is matched on both of those fields, so it applies to that account and
-- cannot silently catch another. Any further dept_admin is assigned through
-- PUT /api/admin/administrators/:id, which audits the change.
--
-- ─── PART B. DENORMALISED COUNTERS ──────────────────────────
--
-- Five columns, all written by code and read by none, all seeded with figures
-- the underlying rows never supported:
--
--   campaigns.raised_amount     ৳1,842,532 stored vs ৳5,000 settled
--   campaigns.donors_count      never reconciled with donations
--   chapters.members_count      18,422 stored vs 0 memberships
--   chapters.events_count       never written by any code at all
--   events.registered_count     drifted from the real count on 5 of 21 events
--
-- Every figure the product shows is already a COUNT or SUM over the rows that
-- exist. These columns were a second answer to questions that already had one.
--
-- ─── PART C. SUPERSEDED DATE COLUMNS ────────────────────────
--
--   events.event_date  VARCHAR, populated on 7 of 21 rows; starts_on is a DATE
--                      populated on all 21 and is what qa1 already asserts is
--                      authoritative
--   events.event_time  VARCHAR, populated on 7; start_time/end_time are TIME
--
-- ─── PART D. OTHER DEAD COLUMNS ─────────────────────────────
--
--   events.planning_mode      no reference in any server, client or frontend file
--   mentorships.health_score  a score nothing computes; the Mentorship report
--                             reports days-to-answer instead, which is
--                             arithmetic on two real timestamps
--
-- ─── PART E. event_proposals — RETAINED, NOT DELETED ────────
--
-- The table holds one historical row and no code path reaches it: the only
-- caller was API.moderateProposal, whose route /api/moderation/proposal/:id/:action
-- does not exist. Event approval has lived in the Event workspace since v5.
--
-- It is RENAMED rather than dropped. Deleting an institutional record because
-- no code happens to read it is a retention decision, and it is not this
-- migration's to make. Renamed to legacy_event_proposals, it is unmistakably
-- historical, it is out of the way of anyone reading the live schema, and the
-- row is still there if the institution wants it.
-- ════════════════════════════════════════════════════════════

-- NOTE: this file deliberately contains no BEGIN/COMMIT. The migration script
-- that applies it owns the transaction. An embedded COMMIT would end THAT
-- transaction from the inside, which is exactly what schema_v16 through v19
-- did until this was fixed: --dry-run committed instead of rolling back, and
-- the bug hid behind the idempotency of the migrations it affected.

-- ─── A. the seeded department administrator ───
UPDATE users u
   SET department_id = (SELECT id FROM departments WHERE code = 'CSE')
 WHERE u.role = 'dept_admin'
   AND u.department = 'CSE Department'
   AND u.department_id IS NULL;

-- ─── B. denormalised counters ───
ALTER TABLE campaigns DROP COLUMN IF EXISTS raised_amount;
ALTER TABLE campaigns DROP COLUMN IF EXISTS donors_count;
ALTER TABLE chapters  DROP COLUMN IF EXISTS members_count;
ALTER TABLE chapters  DROP COLUMN IF EXISTS events_count;
ALTER TABLE events    DROP COLUMN IF EXISTS registered_count;

-- ─── C. superseded date columns ───
ALTER TABLE events DROP COLUMN IF EXISTS event_date;
ALTER TABLE events DROP COLUMN IF EXISTS event_time;

-- ─── D. other dead columns ───
ALTER TABLE events      DROP COLUMN IF EXISTS planning_mode;
ALTER TABLE mentorships DROP COLUMN IF EXISTS health_score;

-- ─── E. event_proposals: retained under a name that says what it is ───
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'event_proposals')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'public' AND table_name = 'legacy_event_proposals')
  THEN
    ALTER TABLE event_proposals RENAME TO legacy_event_proposals;
  END IF;
END $$;

COMMENT ON TABLE legacy_event_proposals IS
  'Retained history. The pre-v5 event proposal workflow, replaced by the Event '
  'workspace. No code reads this table; it is kept because deleting an '
  'institutional record is a retention decision, not a cleanup. Read-only.';

