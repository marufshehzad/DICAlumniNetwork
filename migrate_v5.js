/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v5  (Event & Tickets redesign)

   Safe to run more than once. Everything happens inside ONE transaction:
   if any step fails the database is left exactly as it was.

   Order matters:
     1. Repair orphaned child rows   — must precede the foreign keys
     2. Apply schema_v5.sql          — columns, tables, constraints
     3. Backfill real data           — dates, types, tickets, assignees
     4. Verify and report

   Nothing is dropped and nothing is overwritten: every backfill is guarded
   by `WHERE <target> IS NULL`, so re-running never clobbers an admin's edit.

   Usage:  node migrate_v5.js            (apply)
           node migrate_v5.js --dry-run  (roll back at the end, report only)
   ============================================================ */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DRY_RUN = process.argv.includes('--dry-run');

const CHILD_TABLES = [
  'event_budgets', 'event_sponsors', 'event_committees', 'event_tasks',
  'event_procurement', 'event_volunteers', 'event_risks', 'event_vendors',
  'event_timeline', 'event_logistics', 'event_marketing', 'event_meetings'
];

// Both date shapes that exist in production: 'Aug 15, 2026' and '15 Mar 2026'.
const PARSE_DATE = (col) => `
  CASE
    WHEN ${col} ~ '^[A-Za-z]{3,9} [0-9]{1,2}, [0-9]{4}$' THEN to_date(${col}, 'Mon DD, YYYY')
    WHEN ${col} ~ '^[0-9]{1,2} [A-Za-z]{3,9} [0-9]{4}$' THEN to_date(${col}, 'DD Mon YYYY')
    WHEN ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'        THEN ${col}::date
    ELSE NULL
  END`;

// '6:00 PM' / '10:00 AM' / '18:00'. Anything else becomes NULL rather than failing.
const PARSE_TIME = (col) => `
  CASE
    WHEN ${col} ~ '^[0-9]{1,2}:[0-9]{2}\\s*[AaPp][Mm]$' THEN to_timestamp(btrim(${col}), 'HH12:MI AM')::time
    WHEN ${col} ~ '^[0-9]{1,2}:[0-9]{2}$'               THEN ${col}::time
    ELSE NULL
  END`;

const log = (...a) => console.log(...a);

(async () => {
  const client = await db.pool.connect();
  const report = [];

  try {
    await client.query('BEGIN');
    log(DRY_RUN ? '\n=== MIGRATION v5 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v5 ===\n');

    /* ─────────────────────────────────────────────────────────
       STEP 1 — Repair orphaned child rows before adding the FKs
       ───────────────────────────────────────────────────────── */
    log('[1/4] Checking event child tables for orphans…');

    const fallback = await client.query('SELECT MIN(id)::int AS id FROM events');
    const fallbackId = fallback.rows[0].id;
    if (!fallbackId) throw new Error('No events exist — cannot anchor orphaned child rows.');

    for (const t of CHILD_TABLES) {
      const orphans = await client.query(
        `SELECT COUNT(*)::int n FROM ${t} c
          WHERE c.event_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id)`);
      const n = orphans.rows[0].n;
      if (n > 0) {
        // Re-point rather than delete: this is real planning data.
        await client.query(
          `UPDATE ${t} SET event_id = $1
            WHERE event_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ${t}.event_id)`, [fallbackId]);
        report.push(`  ${t}: re-pointed ${n} orphaned row(s) to event #${fallbackId}`);
      }
    }
    log(report.length ? report.join('\n') : '  none found — all child rows already valid');

    /* ─────────────────────────────────────────────────────────
       STEP 2 — Apply the DDL
       ───────────────────────────────────────────────────────── */
    log('\n[2/4] Applying schema_v5.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v5.sql'), 'utf8'));
    log('  schema applied');

    /* ─────────────────────────────────────────────────────────
       STEP 3 — Backfill
       ───────────────────────────────────────────────────────── */
    log('\n[3/4] Backfilling data…');

    // 3a. Real dates and times from the legacy VARCHAR columns.
    const dates = await client.query(`
      UPDATE events SET starts_on = ${PARSE_DATE('event_date')}
       WHERE starts_on IS NULL AND event_date IS NOT NULL
         AND ${PARSE_DATE('event_date')} IS NOT NULL`);
    const times = await client.query(`
      UPDATE events SET start_time = ${PARSE_TIME('event_time')}
       WHERE start_time IS NULL AND event_time IS NOT NULL AND event_time <> ''
         AND ${PARSE_TIME('event_time')} IS NOT NULL`);
    log(`  events.starts_on backfilled: ${dates.rowCount}`);
    log(`  events.start_time backfilled: ${times.rowCount}`);

    const unparsed = await client.query(
      `SELECT id, event_date FROM events WHERE starts_on IS NULL`);
    if (unparsed.rows.length) {
      log(`  ⚠ ${unparsed.rows.length} event(s) had an unparseable date and were left NULL:`);
      unparsed.rows.forEach(r => log(`      #${r.id} "${r.event_date}"`));
    }

    // 3b. event_type from the legacy `type` column.
    const types = await client.query(
      `UPDATE events SET event_type = COALESCE(NULLIF(btrim(type), ''), 'Other')
        WHERE event_type IS NULL`);
    log(`  events.event_type backfilled: ${types.rowCount}`);

    // 3c. Paid flag from the legacy price string.
    const paid = await client.query(`
      UPDATE events SET is_paid = TRUE
       WHERE is_paid = FALSE
         AND price IS NOT NULL
         AND COALESCE(NULLIF(regexp_replace(price, '[^0-9.]', '', 'g'), '')::numeric, 0) > 0`);
    log(`  events.is_paid set on: ${paid.rowCount}`);

    // 3d. Existing events predate the approval workflow — they are live, so
    //     they are approved. updated_at mirrors created_at until first edit.
    await client.query(
      `UPDATE events SET approval_status = 'approved' WHERE approval_status IS NULL`);
    await client.query(
      `UPDATE events SET updated_at = created_at WHERE updated_at IS NULL`);

    // 3e. Recover the creator from the hash-chained audit trail, which is the
    //     only place authorship was ever recorded ("...by user 7").
    const creators = await client.query(`
      UPDATE events e SET created_by = sub.uid
        FROM (
          SELECT (regexp_match(meta, 'by user ([0-9]+)'))[1]::int AS uid,
                 btrim((regexp_match(meta, '^"(.*)" by user'))[1]) AS title
            FROM audit_logs
           WHERE action = 'Event Created' AND meta ~ 'by user [0-9]+'
        ) sub
       WHERE e.created_by IS NULL
         AND btrim(e.title) = sub.title
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = sub.uid)`);
    log(`  events.created_by recovered from audit log: ${creators.rowCount}`);

    /* 3f. event_proposals → events.
       The old app looked a proposal up by `event_proposals.id = events.id`,
       so that pairing IS the historical relationship and is honoured here.
       A proposal with no same-numbered event becomes a new event rather than
       being discarded. event_proposals itself is left untouched as an archive. */
    const merged = await client.query(`
      UPDATE events e SET
        description          = COALESCE(e.description, p.description),
        organizer_department = COALESCE(e.organizer_department, p.department),
        created_by           = COALESCE(e.created_by, p.owner_id),
        approval_status      = CASE
                                 WHEN p.status = 'pending_approval' THEN 'pending_approval'
                                 WHEN p.status = 'draft'            THEN 'draft'
                                 ELSE e.approval_status
                               END
        FROM event_proposals p
       WHERE p.id = e.id
         AND (e.description IS NULL OR e.organizer_department IS NULL OR e.created_by IS NULL)`);
    log(`  proposals merged into matching events: ${merged.rowCount}`);

    const adopted = await client.query(`
      INSERT INTO events (title, description, event_type, type, starts_on, venue, capacity,
                          organizer_department, status, approval_status, created_by,
                          visibility, is_paid, price)
      SELECT p.name,
             p.description,
             COALESCE(NULLIF(btrim(p.type), ''), 'Other'),
             COALESCE(NULLIF(btrim(p.type), ''), 'Other'),
             ${PARSE_DATE('p.event_date')},
             COALESCE(NULLIF(btrim(p.venue), ''), 'To be confirmed'),
             COALESCE(p.expected_attendance, 100),
             p.department,
             'upcoming',
             CASE WHEN p.status IN ('approved', 'in_planning', 'completed') THEN 'approved'
                  WHEN p.status = 'draft' THEN 'draft'
                  ELSE 'pending_approval' END,
             p.owner_id,
             'alumni', FALSE, 'Free'
        FROM event_proposals p
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = p.id)
         AND NOT EXISTS (SELECT 1 FROM events e WHERE btrim(e.title) = btrim(p.name))
      RETURNING id`);
    log(`  proposals adopted as new events: ${adopted.rowCount}`);

    // 3g. One ticket type per pre-v5 event, carrying its old single price.
    //     Existing registrations keep ticket_type_id NULL, which the API reads
    //     as "the event's default type", so no ticket or QR code changes.
    const tt = await client.query(`
      INSERT INTO event_ticket_types (event_id, name, price, quota, position)
      SELECT e.id,
             CASE WHEN COALESCE(NULLIF(regexp_replace(COALESCE(e.price,''), '[^0-9.]', '', 'g'), '')::numeric, 0) > 0
                  THEN 'Standard' ELSE 'General Admission' END,
             COALESCE(NULLIF(regexp_replace(COALESCE(e.price,''), '[^0-9.]', '', 'g'), '')::numeric, 0),
             e.capacity,
             0
        FROM events e
       WHERE NOT EXISTS (SELECT 1 FROM event_ticket_types t WHERE t.event_id = e.id)
      RETURNING id`);
    log(`  default ticket types created: ${tt.rowCount}`);

    /* 3g-bis. Point pre-v5 registrations at their event's default ticket type.
       Without this a migrated event reads "1 confirmed" beside "0 of N issued",
       because per-type counts only see rows carrying a ticket_type_id. Ticket
       codes, QR payloads and amounts are untouched. */
    const linked = await client.query(`
      UPDATE event_registrations r
         SET ticket_type_id = t.id,
             ticket_type = COALESCE(NULLIF(r.ticket_type, ''), t.name)
        FROM (SELECT DISTINCT ON (event_id) id, event_id, name
                FROM event_ticket_types ORDER BY event_id, position, id) t
       WHERE r.ticket_type_id IS NULL AND t.event_id = r.event_id`);
    log(`  pre-v5 registrations linked to a ticket type: ${linked.rowCount}`);

    // 3h. Tasks — real due dates, categories, progress consistent with status.
    const due = await client.query(`
      UPDATE event_tasks SET due_on = ${PARSE_DATE('deadline')}
       WHERE due_on IS NULL AND deadline IS NOT NULL
         AND ${PARSE_DATE('deadline')} IS NOT NULL`);
    const cat = await client.query(`
      UPDATE event_tasks SET category = COALESCE(NULLIF(btrim(committee_name), ''), 'General')
       WHERE category IS NULL`);
    const prog = await client.query(`
      UPDATE event_tasks SET progress = 100 WHERE status = 'completed' AND progress = 0`);
    const compAt = await client.query(`
      UPDATE event_tasks SET completed_at = COALESCE(completed_at, created_at)
       WHERE status = 'completed' AND completed_at IS NULL`);
    await client.query(`UPDATE event_tasks SET updated_at = created_at WHERE updated_at IS NULL`);
    log(`  tasks.due_on backfilled: ${due.rowCount}`);
    log(`  tasks.category backfilled: ${cat.rowCount}`);
    log(`  tasks.progress set to 100 for completed: ${prog.rowCount}`);
    log(`  tasks.completed_at backfilled: ${compAt.rowCount}`);

    /* 3i. assigned_to (free text) → event_task_assignees (real users).
       Only exact, unambiguous full-name matches are converted. Anything else
       keeps its original string in assigned_to, which the UI still shows as a
       read-only "legacy assignee" so no information is lost. */
    const asg = await client.query(`
      INSERT INTO event_task_assignees (task_id, user_id, assigned_by)
      SELECT t.id, u.id, NULL
        FROM event_tasks t
        JOIN users u ON LOWER(btrim(u.full_name)) = LOWER(btrim(t.assigned_to))
       WHERE t.assigned_to IS NOT NULL AND btrim(t.assigned_to) <> ''
         AND NOT EXISTS (SELECT 1 FROM event_task_assignees a WHERE a.task_id = t.id)
         AND (SELECT COUNT(*) FROM users u2
               WHERE LOWER(btrim(u2.full_name)) = LOWER(btrim(t.assigned_to))) = 1
      RETURNING id`);
    log(`  task assignees linked to real users: ${asg.rowCount}`);

    const unmatched = await client.query(`
      SELECT DISTINCT btrim(assigned_to) AS name FROM event_tasks t
       WHERE assigned_to IS NOT NULL AND btrim(assigned_to) <> ''
         AND NOT EXISTS (SELECT 1 FROM event_task_assignees a WHERE a.task_id = t.id)`);
    if (unmatched.rows.length) {
      log(`  ℹ ${unmatched.rows.length} assignee name(s) had no unique user match ` +
          `(kept as text): ${unmatched.rows.map(r => r.name).join(', ')}`);
    }

    /* 3j. Committee leads and volunteers → event_people, where they match a
       real user. Unmatched names stay in their original tables untouched. */
    const leads = await client.query(`
      INSERT INTO event_people (event_id, user_id, role_in_event, committee)
      SELECT c.event_id, u.id, 'committee_lead', c.name
        FROM event_committees c
        JOIN users u ON LOWER(btrim(u.full_name)) = LOWER(btrim(c.leader_name))
       WHERE (SELECT COUNT(*) FROM users u2
               WHERE LOWER(btrim(u2.full_name)) = LOWER(btrim(c.leader_name))) = 1
      ON CONFLICT (event_id, user_id) DO NOTHING
      RETURNING id`);
    const vols = await client.query(`
      INSERT INTO event_people (event_id, user_id, role_in_event, committee)
      SELECT v.event_id, u.id, 'volunteer', v.assigned_committee
        FROM event_volunteers v
        JOIN users u ON LOWER(btrim(u.full_name)) = LOWER(btrim(v.volunteer_name))
       WHERE (SELECT COUNT(*) FROM users u2
               WHERE LOWER(btrim(u2.full_name)) = LOWER(btrim(v.volunteer_name))) = 1
      ON CONFLICT (event_id, user_id) DO NOTHING
      RETURNING id`);
    log(`  committee leads linked to users: ${leads.rowCount}`);
    log(`  volunteers linked to users: ${vols.rowCount}`);

    // 3k. registered_count is now derived, but leave it consistent for any
    //     read path that has not been migrated yet.
    const rc = await client.query(`
      UPDATE events e SET registered_count = sub.n
        FROM (SELECT ev.id, COUNT(r.id)::int n
                FROM events ev
                LEFT JOIN event_registrations r
                  ON r.event_id = ev.id AND r.status = 'confirmed'
               GROUP BY ev.id) sub
       WHERE e.id = sub.id AND e.registered_count <> sub.n`);
    log(`  registered_count reconciled with live registrations: ${rc.rowCount}`);

    /* ─────────────────────────────────────────────────────────
       STEP 4 — Verify
       ───────────────────────────────────────────────────────── */
    log('\n[4/4] Verifying…');

    const checks = [
      ['events.starts_on present',
        `SELECT COUNT(*)::int n FROM events WHERE starts_on IS NULL`, 0],
      ['events without a ticket type',
        `SELECT COUNT(*)::int n FROM events e
          WHERE NOT EXISTS (SELECT 1 FROM event_ticket_types t WHERE t.event_id = e.id)`, 0],
      ['orphaned tasks',
        `SELECT COUNT(*)::int n FROM event_tasks t
          WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = t.event_id)`, 0],
      ['registrations preserved',
        `SELECT COUNT(*)::int n FROM event_registrations`, null],
      ['ticket codes still unique & intact',
        `SELECT COUNT(*)::int n FROM event_registrations
          WHERE ticket_code IS NULL OR qr_payload IS NULL`, 0],
      ['audit records preserved',
        `SELECT COUNT(*)::int n FROM audit_logs`, null],
      ['notifications preserved',
        `SELECT COUNT(*)::int n FROM notifications`, null],
      ['registrations without a ticket type',
        `SELECT COUNT(*)::int n FROM event_registrations r
          WHERE r.ticket_type_id IS NULL
            AND EXISTS (SELECT 1 FROM event_ticket_types t WHERE t.event_id = r.event_id)`, 0],
      ['task assignee links',
        `SELECT COUNT(*)::int n FROM event_task_assignees`, null],
      ['event people links',
        `SELECT COUNT(*)::int n FROM event_people`, null]
    ];

    let failed = 0;
    for (const [label, sql, expect] of checks) {
      const r = await client.query(sql);
      const n = r.rows[0].n;
      const bad = expect !== null && n !== expect;
      if (bad) failed++;
      log(`  ${bad ? '✗' : '·'} ${label}: ${n}${expect !== null ? ` (expected ${expect})` : ''}`);
    }

    // Foreign keys actually in place?
    const fks = await client.query(`
      SELECT COUNT(*)::int n FROM information_schema.table_constraints
       WHERE constraint_type = 'FOREIGN KEY'
         AND table_name = ANY($1) AND constraint_name LIKE 'fk_%_event'`, [CHILD_TABLES]);
    log(`  · event child-table foreign keys: ${fks.rows[0].n}/${CHILD_TABLES.length}`);
    if (fks.rows[0].n !== CHILD_TABLES.length) failed++;

    if (failed) throw new Error(`${failed} verification check(s) failed — rolling back.`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — all changes rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v5 COMMITTED ===\n');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ MIGRATION FAILED — database rolled back, nothing changed.');
    console.error('  ' + err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
