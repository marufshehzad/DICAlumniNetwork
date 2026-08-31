-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v5
-- Event & Tickets module redesign.
--
-- Additive and non-destructive by design. Nothing is dropped:
--   • events.event_date / event_time (VARCHAR) are kept for history but are
--     no longer written to. starts_on / start_time / end_time are the real
--     columns from now on. The NOT NULL on event_date is relaxed so new rows
--     do not have to carry a duplicate string date.
--   • events.price (VARCHAR) is kept for history. event_ticket_types is the
--     real pricing model from now on.
--   • event_tasks.assigned_to (free text) is kept. event_task_assignees is
--     the real assignment model from now on.
--   • event_proposals is NOT dropped. Its rows are migrated into events and
--     the table is left in place, read-only, as an archive.
--
-- Run with:  node migrate_v5.js
-- ============================================================

-- ─── 1. EVENTS: REAL TYPES, LIFECYCLE, ACCOUNTABILITY ───

-- Identity & description
ALTER TABLE events ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type VARCHAR(60);
ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_department VARCHAR(150);
ALTER TABLE events ADD COLUMN IF NOT EXISTS cover_image_url VARCHAR(500);

-- Proper date/time. The VARCHAR columns above them become historical only.
ALTER TABLE events ADD COLUMN IF NOT EXISTS starts_on DATE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE events ALTER COLUMN event_date DROP NOT NULL;

-- Visibility
ALTER TABLE events ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'alumni';
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_visibility_check;
ALTER TABLE events ADD CONSTRAINT events_visibility_check
  CHECK (visibility IN ('public', 'alumni', 'invite'));

-- Approval lifecycle (replaces the separate event_proposals workflow)
ALTER TABLE events ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) NOT NULL DEFAULT 'approved';
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_approval_status_check;
ALTER TABLE events ADD CONSTRAINT events_approval_status_check
  CHECK (approval_status IN ('draft', 'pending_approval', 'approved', 'rejected'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Run status. Previously an unconstrained free string that nothing ever advanced.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('upcoming', 'ongoing', 'past', 'cancelled'));

-- Cancellation
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Registration window & policy
ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_opens_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_closes_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS waitlist_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_paid BOOLEAN NOT NULL DEFAULT FALSE;

-- Accountability — the module's biggest previous gap.
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_events_starts_on ON events(starts_on);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, approval_status);
CREATE INDEX IF NOT EXISTS idx_events_created_by ON events(created_by);

-- ─── 2. TICKET TYPES ───
-- events.price (VARCHAR) supported exactly one price per event. A college
-- event normally needs Alumni / Student / Guest tiers with separate quotas.
CREATE TABLE IF NOT EXISTS event_ticket_types (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    quota INT CHECK (quota IS NULL OR quota >= 0),
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON event_ticket_types(event_id, position);

-- Existing registrations keep working: ticket_type_id is nullable, and a NULL
-- means "the single implicit ticket type this event had before v5".
ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS ticket_type_id INT REFERENCES event_ticket_types(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_registrations_ticket_type ON event_registrations(ticket_type_id);

-- ─── 3. TASKS: PROGRESS, CATEGORY, REAL DATES, ACCOUNTABILITY ───
-- status keeps its existing CHECK values (todo / in_progress / blocked /
-- completed) so no row has to be rewritten; the UI relabels them as
-- Not Started / In Progress / Blocked / Done.
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS progress INT NOT NULL DEFAULT 0;
ALTER TABLE event_tasks DROP CONSTRAINT IF EXISTS event_tasks_progress_check;
ALTER TABLE event_tasks ADD CONSTRAINT event_tasks_progress_check
  CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS category VARCHAR(60);
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS due_on DATE;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS verified_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_tasks ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_tasks_due ON event_tasks(event_id, due_on);

-- ─── 4. MULTIPLE ASSIGNEES (replaces assigned_to free text) ───
CREATE TABLE IF NOT EXISTS event_task_assignees (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by INT REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON event_task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON event_task_assignees(task_id);

-- ─── 5. TASK NOTES & CHECKLIST ───
CREATE TABLE IF NOT EXISTS event_task_notes (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON event_task_notes(task_id, created_at);

CREATE TABLE IF NOT EXISTS event_task_checklist (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
    label VARCHAR(255) NOT NULL,
    is_done BOOLEAN NOT NULL DEFAULT FALSE,
    position INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_checklist_task ON event_task_checklist(task_id, position);

-- ─── 6. PEOPLE (real users, replacing free-text committees/volunteers) ───
CREATE TABLE IF NOT EXISTS event_people (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_event VARCHAR(40) NOT NULL DEFAULT 'member',
    committee VARCHAR(100),
    note VARCHAR(255),
    added_by INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, user_id)
);
ALTER TABLE event_people DROP CONSTRAINT IF EXISTS event_people_role_check;
ALTER TABLE event_people ADD CONSTRAINT event_people_role_check
  CHECK (role_in_event IN ('coordinator', 'committee_lead', 'member', 'volunteer'));
CREATE INDEX IF NOT EXISTS idx_event_people_event ON event_people(event_id);
CREATE INDEX IF NOT EXISTS idx_event_people_user ON event_people(user_id);

-- ─── 7. NOTIFICATION DEEP LINKS ───
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_entity VARCHAR(50);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_id INT;

-- ─── 8. DIRECTORY: WHATSAPP + SEARCHABLE SECTION ───
ALTER TABLE alumni_profiles ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_profiles_section ON alumni_profiles(section_code);
CREATE INDEX IF NOT EXISTS idx_profiles_student_id ON alumni_profiles(student_id);

-- ─── 9. REFERENTIAL INTEGRITY ON EVENT CHILD TABLES ───
-- Every event_* table shipped with `event_id INT DEFAULT 1` and no foreign
-- key, so deleting an event silently orphaned its rows and any INSERT that
-- forgot event_id landed on event 1. migrate_v5.js re-points orphans at a
-- valid event before these constraints are applied.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'event_budgets', 'event_sponsors', 'event_committees', 'event_tasks',
    'event_procurement', 'event_volunteers', 'event_risks', 'event_vendors',
    'event_timeline', 'event_logistics', 'event_marketing', 'event_meetings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN event_id DROP DEFAULT', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN event_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS fk_%I_event', t, t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT fk_%I_event
         FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_event_id ON %I(event_id)', t, t);
  END LOOP;
END $$;
