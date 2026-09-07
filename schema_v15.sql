-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v15  (job lifecycle, poll lifecycle)
--
-- Both modules had a workflow in the interface and no state behind it.
--
--   JOBS      could be created, edited and deleted, but never CLOSED. A role
--             that had been filled stayed indistinguishable from one still
--             hiring, and there was no deadline to expire against. The status
--             is stored; "expired" is derived from the deadline at read time,
--             because a date passing is not an event anything writes.
--
--   POLLS     had is_active, a boolean, which cannot express a draft. A poll
--             was therefore live the moment it existed. status replaces it —
--             draft / open / closed — and is_active is dropped rather than
--             kept in parallel, so there is exactly one answer to "is this
--             poll accepting votes".
--
--   APPLICATIONS and REFERRALS both had a status column with no vocabulary
--             and no way to change it. Both are now constrained to the states
--             the workflow actually has.
--
-- jobs.days_ago is dropped. It stored 2, 4 and 1 against three rows created
-- on the same day — a fabricated relative date, of the kind Phase 5B removed
-- from locations. Nothing has ever read it: the interface computes "2 days
-- ago" from created_at. It is removed rather than left for someone to trust.
-- ============================================================

-- ─── JOB LIFECYCLE ──────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deadline    DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status      VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_at   TIMESTAMP WITH TIME ZONE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_by   INT REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_status_valid') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_status_valid
      CHECK (status IN ('open', 'closed'));
  END IF;
END $$;

-- A fabricated relative date nothing reads. See the header.
ALTER TABLE jobs DROP COLUMN IF EXISTS days_ago;

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- ─── APPLICATION LIFECYCLE ──────────────────────────────────
-- The vocabulary is NOT changed. job_applications_status_check already allows
-- submitted / reviewing / shortlisted / rejected / hired, which covers the
-- workflow and adds a reviewing state besides. Renaming 'submitted' to
-- 'pending' would churn the schema to match a word rather than a behaviour;
-- the interface labels 'submitted' as "Pending" instead.
--
-- What was missing is who changed a status and when.
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS status_changed_by INT REFERENCES users(id) ON DELETE SET NULL;

-- ─── REFERRAL LIFECYCLE ─────────────────────────────────────
-- job_referrals_status_check already constrains this to pending / accepted /
-- declined — exactly the three states the workflow needs. Only the moment of
-- the answer was missing.
ALTER TABLE job_referrals ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP WITH TIME ZONE;

-- ─── POLL LIFECYCLE ─────────────────────────────────────────
ALTER TABLE polls ADD COLUMN IF NOT EXISTS status     VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE polls ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMP WITH TIME ZONE;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS closed_at  TIMESTAMP WITH TIME ZONE;

-- Carry the existing boolean over before it is dropped: a poll that was
-- active becomes open, one that was not becomes closed. No poll becomes a
-- draft retroactively — a draft is something an author chooses, and none of
-- these authors was offered the choice.
UPDATE polls SET status = CASE WHEN is_active THEN 'open' ELSE 'closed' END
 WHERE status = 'draft';
UPDATE polls SET opened_at = created_at WHERE status = 'open' AND opened_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'polls_status_valid') THEN
    ALTER TABLE polls ADD CONSTRAINT polls_status_valid
      CHECK (status IN ('draft', 'open', 'closed'));
  END IF;
END $$;

-- One answer to "is this poll accepting votes", not two that can disagree.
ALTER TABLE polls DROP COLUMN IF EXISTS is_active;

CREATE INDEX IF NOT EXISTS idx_polls_status ON polls(status);
