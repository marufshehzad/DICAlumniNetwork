-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v10  (operations ring)
--
-- Additive. One foreign key is relaxed; no column is dropped and no row is
-- rewritten.
--
-- Two things this release needs from the database.
--
-- 1. A record of what the scheduler actually did.
--    Until now nothing ran on a timer at all: event statuses rolled forward
--    only when a staff member happened to open the Events page, and the
--    30-day deletion purge had no executor whatsoever. A scheduler without a
--    run log is not much better — "did last night's job run?" has to be
--    answerable without SSH access, and a monitor needs something to alert on.
--
-- 2. Deletion requests that survive the deletion.
--    deletion_requests.user_id was ON DELETE CASCADE, so the moment the purge
--    deleted the user it also deleted the record proving the request had been
--    honoured on time. That is precisely the evidence a data-protection
--    enquiry asks for. The column becomes nullable with ON DELETE SET NULL:
--    the row survives the account, marked 'completed', with the timestamp.
-- ============================================================

-- ─── 1. SCHEDULER / OPERATIONS RUN LOG ───
CREATE TABLE IF NOT EXISTS ops_runs (
    id           SERIAL PRIMARY KEY,
    job          VARCHAR(60) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
    started_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at  TIMESTAMP WITH TIME ZONE,
    duration_ms  INTEGER,
    -- A short, operator-readable summary. Never an error stack, never a secret.
    detail       TEXT,
    -- How many things the run acted on, so "ran but did nothing" is
    -- distinguishable from "ran and processed 40".
    items        INTEGER NOT NULL DEFAULT 0,
    -- Which trigger fired it: 'cron', 'manual', or 'client' for the legacy
    -- on-page-load sweep, so the run log shows whether the timer is working.
    source       VARCHAR(20) NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS idx_ops_runs_job ON ops_runs(job, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_runs_started ON ops_runs(started_at DESC);

-- ─── 2. DELETION REQUESTS SURVIVE THE PURGE ───
-- Idempotent: re-running finds the constraint already in its new shape and the
-- DO block simply does nothing.
DO $$
BEGIN
  -- Drop NOT NULL so the row can outlive the account it referred to.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'deletion_requests' AND column_name = 'user_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE deletion_requests ALTER COLUMN user_id DROP NOT NULL;
  END IF;

  -- Re-point the foreign key from CASCADE to SET NULL.
  IF EXISTS (
    SELECT 1
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc
        ON tc.constraint_name = rc.constraint_name
     WHERE tc.table_name = 'deletion_requests'
       AND rc.delete_rule = 'CASCADE'
  ) THEN
    ALTER TABLE deletion_requests
      DROP CONSTRAINT IF EXISTS deletion_requests_user_id_fkey;
    ALTER TABLE deletion_requests
      ADD CONSTRAINT deletion_requests_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- When the purge actually ran, and a copy of who it was for. The label is
-- written at purge time from data about to be destroyed, so the compliance
-- record can still say which account was erased once the row itself is gone.
-- It is deliberately not the person's name or e-mail: 'user #57' is enough to
-- match against the original request without re-storing what was just erased.
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS purged_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS subject_label VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_deletion_requests_due
  ON deletion_requests(status, purge_after);
