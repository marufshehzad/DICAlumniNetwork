-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v9  (honest donation states)
--
-- Additive only. One CHECK constraint is widened; no column is dropped, no
-- row is rewritten, no existing status value is invalidated.
--
-- Why:
-- The donation ledger had four states — PENDING, SUCCESS, FAILED, REFUNDED —
-- and a settlement endpoint that took the outcome from the browser. Any signed
-- in donor could POST {success:true} and move their own row to SUCCESS, so the
-- ledger recorded money the institution had never received, and every figure
-- built on it (campaign totals, the donor leaderboard, the analytics gateway
-- split) inherited that claim.
--
-- No payment gateway is connected to this platform, so there is nothing that
-- can honestly produce SUCCESS on its own. Two states are added to describe
-- what actually happens:
--
--   PLEDGED    a donor has recorded an intent to give. This is what the donate
--              form now creates. It is not money, and campaign totals must not
--              count it as money.
--   CANCELLED  a pledge withdrawn by the donor or written off by staff.
--
-- SUCCESS survives and keeps its meaning — funds actually received — but it is
-- now reachable only through POST /api/donations/:id/record-payment, which is
-- restricted to ADMIN_ROLES and audited with the staff member who confirmed it.
-- A browser cannot reach it at all.
--
-- The one pre-existing SUCCESS row was minted by the old self-attested flow.
-- It is deliberately left untouched: rewriting historical financial records to
-- suit a new policy is its own kind of dishonesty. It is called out in the
-- Phase 3 report so the college can reconcile it against its own bank records.
-- ============================================================

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS for CHECK, so drop-then-add.
-- Both statements are idempotent in effect: dropping a missing constraint is
-- tolerated by IF EXISTS, and the constraint is recreated identically each run.
ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_status_check;

ALTER TABLE donations ADD CONSTRAINT donations_status_check
  CHECK (status IN ('PLEDGED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CANCELLED'));

-- Who confirmed the money arrived, and when. NULL for every historical row and
-- for anything still pledged. Not a foreign key to users(id) with ON DELETE
-- CASCADE — a confirmation must survive the confirming administrator leaving.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP WITH TIME ZONE;

-- How the institution says it received the funds (bank transfer, cash at the
-- office, mobile wallet reconciled by hand). Free text on purpose: it records
-- what a human reports, not a gateway response code.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS recorded_method VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
