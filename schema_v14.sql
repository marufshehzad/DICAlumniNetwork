-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v14  (event, job and chapter location)
--
-- Phase 5B (v13) built the ALUMNI location domain: location_places as shared
-- reference data, alumni_profiles.place_id, and a confirmation flag rather
-- than a silent rewrite of the old hardcoded values.
--
-- Three location domains were left unmodelled, and they are deliberately kept
-- separate here because their business meaning differs:
--
--   EVENT VENUE   a building, on a date, that people are invited to. It is
--                 public by its nature — an event nobody can find is not an
--                 event — so residential privacy rules do NOT apply to it and
--                 exact venue coordinates are legitimate.
--
--   JOB           where the work happens, which is increasingly not a place at
--                 all. The missing fact was never the city; it was whether
--                 attendance is required. work_mode records that and nothing
--                 else, leaving the existing free-text location alone.
--
--   CHAPTER       an institution-level location, shared by an organisation
--                 rather than owned by a person. It reuses location_places, so
--                 a chapter's city, country and coordinates have exactly one
--                 definition in this database. A chapter that is not a single
--                 city — "DIC UK & Europe Alumni" — simply has no place, which
--                 is the honest answer rather than a nearest-city guess.
--
-- Nothing here is back-filled. Every column added is nullable with no default,
-- so an unknown location stays unknown instead of becoming a fabrication that
-- looks deliberate. That is the same rule v13 applied to alumni.
-- ============================================================

-- ─── EVENT VENUE ────────────────────────────────────────────
ALTER TABLE events ADD COLUMN IF NOT EXISTS address   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9,6);
ALTER TABLE events ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);

DO $$
BEGIN
  -- A coordinate is either absent or real. Half a coordinate is not a place.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_coords_paired') THEN
    ALTER TABLE events ADD CONSTRAINT events_coords_paired
      CHECK ((latitude IS NULL) = (longitude IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_coords_range') THEN
    ALTER TABLE events ADD CONSTRAINT events_coords_range
      CHECK (latitude  IS NULL OR latitude  BETWEEN  -90 AND  90);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_coords_range_lng') THEN
    ALTER TABLE events ADD CONSTRAINT events_coords_range_lng
      CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
  END IF;
END $$;

-- ─── JOB WORK MODE ──────────────────────────────────────────
-- Nullable on purpose: every existing posting predates the field, and guessing
-- "onsite" for a row whose poster never said so would invent an answer.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS work_mode VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_work_mode_valid') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_work_mode_valid
      CHECK (work_mode IS NULL OR work_mode IN ('onsite', 'remote', 'hybrid'));
  END IF;
END $$;

-- ─── CHAPTER LOCATION ───────────────────────────────────────
-- Institution-level, and pointed at the same reference table the alumni map
-- reads, so a chapter's city cannot drift from a member's city spelling.
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS place_id INT
  REFERENCES location_places(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chapters_place ON chapters(place_id);

-- The directory can already filter by country and city. Division and district
-- live in location_places and are queried through the same join, so filtering
-- on them needs an index on the columns rather than any new column.
CREATE INDEX IF NOT EXISTS idx_places_district ON location_places(country_code, district);
