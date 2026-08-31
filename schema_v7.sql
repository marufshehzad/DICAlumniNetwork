-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v7  (authority accounts)
--
-- Additive only. Every statement is IF NOT EXISTS, so re-running is a no-op.
-- No column is dropped, no row is moved, and no existing column changes
-- meaning. Institutional administrators live in `users` alongside alumni:
-- one identity, one login, one token format, one audit trail. What is added
-- here is the record-keeping an authority account needs and an alumni account
-- never did.
-- ============================================================

-- ─── AUTHORITY ACCOUNT FIELDS ───────────────────────────────

-- Display title, deliberately separate from `role`. "Principal",
-- "Vice Principal", "Finance Officer" are what a person is called; `role` is
-- what the middleware checks. Nothing reads designation for authorisation, and
-- nothing ever should.
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(120);

-- Contact details for staff. alumni_profiles carries these for alumni, but an
-- administrator has no alumni profile, so there was nowhere to put them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone     VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Account state. Checked in attachUser() on every request, so suspending an
-- account takes effect immediately rather than when its 12-hour token expires.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

-- Provenance and change tracking.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Written by the login handler; previously nothing recorded a sign-in against
-- the account at all.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_password_changed_at TIMESTAMPTZ;

-- Durable lockout counters. The existing throttle is an in-process Map: it is
-- lost on restart and, on a serverless deployment, is per-instance. These
-- columns let the lock survive both. The in-memory limiter stays as the cheap
-- first line of defence.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Single-use, time-limited administrator password reset. Stored as a SHA-256
-- hash so a database reader cannot mint a reset; the plaintext token is shown
-- once to the super admin who issued it and never persisted or logged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('active', 'suspended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);

-- ─── AUDIT TRAIL: WHO DID WHAT TO WHOM ──────────────────────
-- audit_logs recorded the actor only inside the free-text `meta` string
-- ("by user 5"), which cannot be queried, joined or filtered. These columns
-- make the actor and the target first-class without changing any existing row:
-- old entries simply have them NULL, and the hash chain is untouched.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_type VARCHAR(40);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id   INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip          VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
