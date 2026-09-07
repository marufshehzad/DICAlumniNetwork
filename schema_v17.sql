-- ════════════════════════════════════════════════════════════
-- DIC ALUMNI PLATFORM — SCHEMA v17
-- Phase 7D: a real department relation, so department scope can be enforced
--
-- The problem this exists to solve, stated precisely.
--
-- users.department is VARCHAR(150) NOT NULL and holds four different kinds of
-- thing at once:
--
--   a department      'Computer Science & Engineering'   (7 alumni)
--   a programme       'BSc CSE (2020)'                   (1 alumnus)
--   an HSC group      'Science'                          (1 alumnus, imported)
--   a staff org label 'CSE Department', 'DIC Administration',
--                     'System & Security', 'DIC Community'
--
-- The one dept_admin on the platform reads 'CSE Department'. The alumni it
-- ought to scope over read 'Computer Science & Engineering'. Scoping on the
-- string would therefore have matched NOTHING, and a scope that silently
-- returns zero rows looks exactly like a scope that works.
--
-- So: a reference table, and a foreign key from both users and alumni_profiles.
-- The free-text columns stay — they are the display label, they are NOT NULL,
-- and several hold text no department could represent. department_id is the
-- authority for authorisation; department is what a human reads.
--
-- What is deliberately NOT done here:
--
--   * No department is invented. The table is seeded only from department names
--     that actually appear on alumni profiles and that are actually departments.
--     'Science' is an HSC group the bulk import wrote into the department column
--     (it has no Department field at all — Phase 7D adds one); it is not seeded
--     as a department, and the one profile carrying it keeps department_id NULL.
--     "We do not know" is the truthful answer, and it is safer than a guess: a
--     NULL department is visible to institution-wide roles and to no department
--     admin.
--
--   * No staff account is assigned a department. Mapping 'CSE Department' to
--     CSE is obvious to a person and is still a guess by a migration. It is an
--     administrator's decision, made through PUT /api/admin/administrators/:id,
--     and it is recorded in the audit trail when it happens.
--
--   * Nothing is dropped. That is schema_v18.
-- ════════════════════════════════════════════════════════════

-- NOTE: this file deliberately contains no BEGIN/COMMIT. The migration script
-- that applies it owns the transaction. An embedded COMMIT would end THAT
-- transaction from the inside, which is exactly what schema_v16 through v19
-- did until this was fixed: --dry-run committed instead of rolling back, and
-- the bug hid behind the idempotency of the migrations it affected.

CREATE TABLE IF NOT EXISTS departments (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(16)  NOT NULL UNIQUE,
  name        VARCHAR(150) NOT NULL UNIQUE,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

/* Seeded from the department names that actually appear on alumni profiles.
   The code is the institution's short form; the name is what is already
   stored, character for character, so the back-fill below is an exact match
   and never a fuzzy one. */
INSERT INTO departments (code, name) VALUES
  ('CSE', 'Computer Science & Engineering'),
  ('SWE', 'Software Engineering'),
  ('EEE', 'Electrical & Electronic Engineering'),
  ('BBA', 'Business Administration')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE users           ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE alumni_profiles ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;

/* The profile is the alumni record of record, so the back-fill reads
   alumni_profiles.department — which is clean — rather than users.department,
   which holds 'BSc CSE (2020)' for one account whose profile correctly says
   'Computer Science & Engineering'. Exact match only. */
UPDATE alumni_profiles ap
   SET department_id = d.id
  FROM departments d
 WHERE d.name = ap.department
   AND ap.department_id IS NULL;

UPDATE users u
   SET department_id = ap.department_id
  FROM alumni_profiles ap
 WHERE ap.user_id = u.id
   AND u.role = 'alumni'
   AND ap.department_id IS NOT NULL
   AND u.department_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_department    ON users(department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_department ON alumni_profiles(department_id) WHERE department_id IS NOT NULL;

