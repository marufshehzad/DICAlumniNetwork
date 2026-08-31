-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v8  (session revocation)
--
-- Additive only, IF NOT EXISTS throughout, so re-running is a no-op.
--
-- Sessions are stateless HMAC bearer tokens with a 12-hour life. That means
-- there has been no way to end one early: signing out dropped the browser's
-- copy and left the token itself valid, and a password reset did not stop the
-- old password's sessions.
--
-- token_version fixes that without a session table and without changing the
-- token format. Each token carries the version it was minted at; attachUser()
-- compares it to the row on every request, which it is already reading for the
-- role and status. Bumping the column invalidates every token issued before the
-- bump — on sign-out, password change, password reset and suspension.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;

-- Every existing session predates this column and carries no version, so it is
-- treated as version 1 and keeps working. See attachUser().
