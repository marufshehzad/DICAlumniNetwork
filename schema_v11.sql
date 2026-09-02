-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v11  (verifiable audit chain)
--
-- Additive. No historical row is rewritten, no column is dropped, and the
-- legacy `hash` column is left exactly as it is on every existing entry.
--
-- Why:
-- The audit trail described itself as an immutable hash chain and could not be
-- verified by anyone. The digest consumed `new Date().toISOString()` from the
-- application's memory and stored nothing about it; `created_at` is a separate
-- Postgres CURRENT_TIMESTAMP taken at a different instant and at microsecond
-- precision. One of the four digest inputs was therefore discarded on every
-- write, and the predecessor hash was never recorded either.
--
-- That is unrecoverable for existing rows. This migration does NOT invent
-- replacement hashes for them — fabricating a hash to make a verifier pass
-- would be worse than the problem it hides. Instead it establishes an explicit
-- boundary: everything already written is marked chain_version 0 and reported
-- by the verifier as legacy and not recomputable; everything from the boundary
-- forward carries a full, persisted, independently checkable chain.
--
-- See AUDIT_CHAIN.md for the canonical payload and the guarantees.
-- ============================================================

-- ─── 1. THE VERIFIABLE CHAIN COLUMNS ───
-- 0 = written before the boundary, cannot be recomputed.
-- 1 = the scheme documented in AUDIT_CHAIN.md.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_version SMALLINT NOT NULL DEFAULT 0;

-- The predecessor's entry_hash, persisted. Its absence is what made the old
-- chain uncheckable: nothing recorded which hash had been consumed.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(90);

-- Full SHA-256, 64 lowercase hex characters. The legacy `hash` column held a
-- 16-character truncation — 64 bits, which is not a tamper-evidence claim.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entry_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_audit_chain ON audit_logs(chain_version, id);

-- ─── 2. THE CHAIN HEAD ───
-- One row. It serves two purposes.
--
-- Serialisation: every audit write takes a row lock here before reading the
-- head, so two concurrent writes cannot both build on the same predecessor.
-- The old code did SELECT-then-INSERT with no lock, which could fork the chain.
--
-- Tail detection: linkage alone cannot notice that the newest entries were
-- deleted, because the successor that would have pointed at them is gone too.
-- Holding the expected head separately means a truncated tail is visible. An
-- attacker with write access to the whole database can of course update this
-- as well; what defeats that is the off-site backup, not another column.
CREATE TABLE IF NOT EXISTS audit_chain (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    head_hash   VARCHAR(90),
    entry_count INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO audit_chain (id, head_hash, entry_count)
VALUES (1, NULL, 0)
ON CONFLICT (id) DO NOTHING;

-- ─── 3. THE LEGACY HASH COLUMN BECOMES OPTIONAL ───
-- `hash` held the old 16-character truncated digest and was NOT NULL. New
-- entries do not use it — they carry entry_hash instead — so a new row would
-- violate the constraint. Relaxing it is additive: every historical value is
-- left exactly where it is, and the verifier still reads them to describe the
-- legacy segment. Dropping the column outright would have destroyed the only
-- record of what the old chain claimed.
ALTER TABLE audit_logs ALTER COLUMN hash DROP NOT NULL;
