-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v6
-- External (non-system) people on events.
--
-- A college event is run by more than its alumni: decorators, caterers,
-- photographers, sound engineers, venue staff. They have no DIC account and
-- must not be given a fake one, yet an organiser still needs to assign them
-- work and phone them.
--
-- Additive and non-destructive:
--   • event_people gains a person_type; user_id becomes nullable so an
--     external contact can exist without a users row.
--   • event_task_assignees gains event_person_id so a task can be assigned to
--     either a DIC user or an external contact.
--   • Nothing is dropped. Existing rows become person_type = 'directory'.
--
-- Run with:  node migrate_v6.js
-- ============================================================

-- ─── 1. EVENT PEOPLE: DIRECTORY USER *OR* EXTERNAL CONTACT ───

ALTER TABLE event_people ADD COLUMN IF NOT EXISTS person_type VARCHAR(20) NOT NULL DEFAULT 'directory';
ALTER TABLE event_people DROP CONSTRAINT IF EXISTS event_people_person_type_check;
ALTER TABLE event_people ADD CONSTRAINT event_people_person_type_check
  CHECK (person_type IN ('directory', 'external'));

-- External contacts have no account, so user_id must be allowed to be empty.
ALTER TABLE event_people ALTER COLUMN user_id DROP NOT NULL;

-- Details an external contact carries in its own right. A directory person
-- keeps reading these from users / alumni_profiles.
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS name VARCHAR(150);
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS role_title VARCHAR(120);
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(50);
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS organization VARCHAR(150);
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS department_area VARCHAR(150);
ALTER TABLE event_people ADD COLUMN IF NOT EXISTS notes TEXT;

-- Exactly one identity: a directory row points at a user, an external row
-- carries its own name and role.
ALTER TABLE event_people DROP CONSTRAINT IF EXISTS event_people_identity_check;
ALTER TABLE event_people ADD CONSTRAINT event_people_identity_check CHECK (
  (person_type = 'directory' AND user_id IS NOT NULL)
  OR
  (person_type = 'external'  AND user_id IS NULL
   AND name IS NOT NULL AND btrim(name) <> ''
   AND role_title IS NOT NULL AND btrim(role_title) <> '')
);

-- The old UNIQUE (event_id, user_id) tolerates NULLs, so many external rows
-- can coexist on one event while a DIC member still cannot be added twice.

CREATE INDEX IF NOT EXISTS idx_event_people_type ON event_people(event_id, person_type);

-- ─── 2. TASK ASSIGNEES: USER *OR* EVENT PERSON ───

ALTER TABLE event_task_assignees
  ADD COLUMN IF NOT EXISTS event_person_id INT REFERENCES event_people(id) ON DELETE CASCADE;

ALTER TABLE event_task_assignees ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE event_task_assignees DROP CONSTRAINT IF EXISTS event_task_assignees_target_check;
ALTER TABLE event_task_assignees ADD CONSTRAINT event_task_assignees_target_check CHECK (
  (user_id IS NOT NULL AND event_person_id IS NULL)
  OR
  (user_id IS NULL AND event_person_id IS NOT NULL)
);

-- The original UNIQUE (task_id, user_id) would treat every external row as
-- distinct because user_id is NULL, so each target gets its own partial index.
ALTER TABLE event_task_assignees DROP CONSTRAINT IF EXISTS event_task_assignees_task_id_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_assignee_user
  ON event_task_assignees(task_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_assignee_person
  ON event_task_assignees(task_id, event_person_id) WHERE event_person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_assignees_person ON event_task_assignees(event_person_id);
