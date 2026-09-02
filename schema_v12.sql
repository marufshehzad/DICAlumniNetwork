-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v12  (immutable actor reference)
--
-- Additive. No row is rewritten; the v1 segment is preserved exactly as it is.
--
-- Why:
-- Chain version 1 included audit_logs.actor_id in the digest. That column is a
-- foreign key declared ON DELETE SET NULL, so when an account is deleted — by
-- the 30-day purge, or by an administrator — Postgres silently rewrites every
-- audit row that referenced it. The entry is unchanged in every way that
-- matters and yet no longer hashes to its stored value.
--
-- That was caught by the Phase 5A suite itself: six entries stopped
-- recomputing, and all six were exactly the rows whose actor had since been
-- deleted. It is not tampering; it is a field in the digest that the database
-- is entitled to change, which is precisely what a hash input must never be.
--
-- The fix is a second, plain integer column holding the same value with no
-- foreign key attached. actor_id keeps its FK and stays useful for joins and
-- for the "who did this" display; actor_ref is immutable and is what the digest
-- consumes. When an account is erased, actor_id becomes NULL and actor_ref
-- still records which internal id acted — which is also better for the audit
-- trail, since "some deleted account did this" is a weaker record than
-- "account 79, since erased, did this".
--
-- Chain version becomes 2. Version 1 entries are preserved and reported by the
-- verifier as a superseded segment, with the reason stated. They are not
-- rewritten to fit the new scheme: fabricating hashes to make a verifier pass
-- is the failure this whole phase exists to prevent.
-- ============================================================

-- Deliberately NOT a foreign key. That is the entire point.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_ref INTEGER;

-- Backfill from actor_id where it still survives, so historical entries keep
-- whatever attribution is left. Rows whose actor was already deleted have
-- nothing to recover — that information is gone and is not invented here.
UPDATE audit_logs SET actor_ref = actor_id
 WHERE actor_ref IS NULL AND actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_actor_ref ON audit_logs(actor_ref);

-- The head pointer tracks the tail of the CURRENT chain version. Version 2
-- starts empty, so the pointer is cleared; leaving it aimed at the last version
-- 1 entry would make the verifier report a head that belongs to a segment it no
-- longer checks. The version 1 rows themselves are untouched.
UPDATE audit_chain SET head_hash = NULL, entry_count = 0, updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
