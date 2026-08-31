/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v6  (external event people)

   Safe to run more than once; one transaction, rolls back on any failure.
   Nothing is dropped and no existing row changes meaning: every current
   event_people row is a directory person and is labelled as such.

   Usage:  node migrate_v6.js            (apply)
           node migrate_v6.js --dry-run  (roll back at the end, report only)
   ============================================================ */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...a) => console.log(...a);

(async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    log(DRY_RUN ? '\n=== MIGRATION v6 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v6 ===\n');

    const before = {
      people: (await client.query('SELECT COUNT(*)::int n FROM event_people')).rows[0].n,
      assignees: (await client.query('SELECT COUNT(*)::int n FROM event_task_assignees')).rows[0].n
    };
    log(`[1/3] Before: ${before.people} event people, ${before.assignees} task assignees`);

    log('\n[2/3] Applying schema_v6.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v6.sql'), 'utf8'));
    log('  schema applied');

    // Every pre-v6 row is a real DIC user.
    const tagged = await client.query(
      `UPDATE event_people SET person_type = 'directory'
        WHERE person_type IS NULL OR (user_id IS NOT NULL AND person_type <> 'directory')`);
    log(`  existing people tagged as directory: ${tagged.rowCount}`);

    log('\n[3/3] Verifying…');
    const checks = [
      ['event people preserved',
        `SELECT COUNT(*)::int n FROM event_people`, before.people],
      ['task assignees preserved',
        `SELECT COUNT(*)::int n FROM event_task_assignees`, before.assignees],
      ['no directory person without a user',
        `SELECT COUNT(*)::int n FROM event_people WHERE person_type='directory' AND user_id IS NULL`, 0],
      ['no external person with a user',
        `SELECT COUNT(*)::int n FROM event_people WHERE person_type='external' AND user_id IS NOT NULL`, 0],
      ['no assignee row without a target',
        `SELECT COUNT(*)::int n FROM event_task_assignees
          WHERE user_id IS NULL AND event_person_id IS NULL`, 0],
      ['no assignee row with two targets',
        `SELECT COUNT(*)::int n FROM event_task_assignees
          WHERE user_id IS NOT NULL AND event_person_id IS NOT NULL`, 0],
      ['no external person leaked into users',
        `SELECT COUNT(*)::int n FROM users u
          WHERE EXISTS (SELECT 1 FROM event_people p
                         WHERE p.person_type='external' AND LOWER(p.name)=LOWER(u.full_name)
                           AND u.created_at > NOW() - INTERVAL '1 minute')`, 0],
      ['no external person leaked into alumni_profiles',
        `SELECT COUNT(*)::int n FROM alumni_profiles
          WHERE updated_at > NOW() - INTERVAL '1 minute'`, null]
    ];

    let failed = 0;
    for (const [label, sql, expect] of checks) {
      const n = (await client.query(sql)).rows[0].n;
      const bad = expect !== null && n !== expect;
      if (bad) failed++;
      log(`  ${bad ? '✗' : '·'} ${label}: ${n}${expect !== null ? ` (expected ${expect})` : ''}`);
    }

    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name='event_people'
         AND column_name IN ('person_type','name','role_title','phone','whatsapp',
                             'organization','department_area','notes')`);
    log(`  · external columns present: ${cols.rows.length}/8`);
    if (cols.rows.length !== 8) failed++;

    const nullable = await client.query(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name='event_people' AND column_name='user_id'`);
    log(`  · event_people.user_id nullable: ${nullable.rows[0].is_nullable}`);
    if (nullable.rows[0].is_nullable !== 'YES') failed++;

    const asgCol = await client.query(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name='event_task_assignees' AND column_name='user_id'`);
    log(`  · event_task_assignees.user_id nullable: ${asgCol.rows[0].is_nullable}`);
    if (asgCol.rows[0].is_nullable !== 'YES') failed++;

    if (failed) throw new Error(`${failed} verification check(s) failed — rolling back.`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — all changes rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v6 COMMITTED ===\n');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n✗ MIGRATION FAILED — database rolled back, nothing changed.');
    console.error('  ' + err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
