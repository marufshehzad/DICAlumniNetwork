-- ============================================================
-- Simple vs Full event planning mode
-- ============================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS planning_mode VARCHAR(20) NOT NULL DEFAULT 'full';
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_planning_mode_check;
ALTER TABLE events ADD CONSTRAINT events_planning_mode_check CHECK (planning_mode IN ('simple', 'full'));
