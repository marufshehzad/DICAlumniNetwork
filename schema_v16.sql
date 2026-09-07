-- ════════════════════════════════════════════════════════════
-- DIC ALUMNI PLATFORM — SCHEMA v16
-- Phase 7C-3: import batch identity, rollback, and audit filtering
--
-- Three problems this closes.
--
-- 1. An import recorded WHO ran it as free text (import_history.admin_name,
--    supplied by the client) and nothing else. A name a caller can choose is
--    not an actor. created_by records the authenticated user id.
--
-- 2. Nothing linked a created account back to the batch that created it, so a
--    bad import could be seen in the history and not undone. users.import_batch_id
--    is that link, and it is set only on accounts the batch CREATED — never on
--    accounts it merely enriched, which existed before and must survive a rollback.
--
-- 3. audit_logs holds 11,185 rows and was read by ORDER BY id DESC LIMIT 50
--    with no filters. Two indexes make a filtered, date-ranged read cheap.
--
-- Nothing is dropped. Nothing is back-filled: rows that predate this migration
-- keep created_by NULL and import_batch_id NULL, which honestly says "we do not
-- know", and a batch with no linked accounts refuses to roll back rather than
-- guessing which users were its.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ─── import_history: a real actor, a lifecycle, and a rollback record ───
ALTER TABLE import_history ADD COLUMN IF NOT EXISTS created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE import_history ADD COLUMN IF NOT EXISTS status         VARCHAR(20) NOT NULL DEFAULT 'completed';
ALTER TABLE import_history ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;
ALTER TABLE import_history ADD COLUMN IF NOT EXISTS rolled_back_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE import_history ADD COLUMN IF NOT EXISTS rolled_back_count INTEGER;

DO $$ BEGIN
  ALTER TABLE import_history ADD CONSTRAINT import_history_status_valid
    CHECK (status IN ('completed', 'rolled_back'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── users: which batch created this account, if any ───
ALTER TABLE users ADD COLUMN IF NOT EXISTS import_batch_id INTEGER REFERENCES import_history(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_import_batch      ON users(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_import_history_created  ON import_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_history_actor    ON import_history(created_by);

-- ─── audit_logs: make a filtered, date-ranged read cheap ───
-- The endpoint could only ever return the newest 50 rows, so nothing needed
-- these. Filtering by administrator, action and date range does.
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_logs(action);

COMMIT;
