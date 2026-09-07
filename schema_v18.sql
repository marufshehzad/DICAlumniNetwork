-- ════════════════════════════════════════════════════════════
-- DIC ALUMNI PLATFORM — SCHEMA v18
-- Phase 7D: the second half of the department relation — events.
--
-- events.organizer_department is VARCHAR and, like users.department before it,
-- holds four different kinds of thing across 21 rows:
--
--   NULL or empty                     13   organised by no single department
--   'QA Dept'                          6   test fixtures
--   'DIC Administration'               1   an institution-wide organiser
--   'Computer Science & Engineering'   1   an actual department
--
-- Scoping event management on that string would mean a CSE department admin
-- matching one event and a typo matching none. department_id is the authority;
-- organizer_department stays as the free-text label, unchanged.
--
-- Nothing is dropped here and nothing is guessed: only the exact name match is
-- back-filled. An event with no resolvable department belongs to the
-- institution, which is what NULL already means.
-- ════════════════════════════════════════════════════════════

-- NOTE: this file deliberately contains no BEGIN/COMMIT. The migration script
-- that applies it owns the transaction. An embedded COMMIT would end THAT
-- transaction from the inside, which is exactly what schema_v16 through v19
-- did until this was fixed: --dry-run committed instead of rolling back, and
-- the bug hid behind the idempotency of the migrations it affected.

ALTER TABLE events ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;

UPDATE events e
   SET department_id = d.id
  FROM departments d
 WHERE d.name = e.organizer_department
   AND e.department_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_department ON events(department_id) WHERE department_id IS NOT NULL;

