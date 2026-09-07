/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v18  (event department relation)

   Completes the department relation begun in v17: events gain a foreign key so
   event management can be scoped on something other than a free-text label
   that 13 of 21 rows leave blank.

   Nothing is dropped, nothing is guessed. That is migration v19.

   Usage:  node migrate_v18.js            (apply)
           node migrate_v18.js --dry-run  (apply, verify, then roll back)
   ============================================================ */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...a) => console.log(...a);

(async () => {
  const client = await db.pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    log(DRY_RUN ? '\n=== MIGRATION v18 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v18 ===\n');

    const one = async (sql) => (await client.query(sql)).rows[0].n;

    const before = {
      events:        await one('SELECT COUNT(*)::int n FROM events'),
      registrations: await one('SELECT COUNT(*)::int n FROM event_registrations'),
      tickets:       await one('SELECT COUNT(*)::int n FROM event_ticket_types'),
      tasks:         await one('SELECT COUNT(*)::int n FROM event_tasks'),
      audits:        await one('SELECT COUNT(*)::int n FROM audit_logs')
    };

    /* Every event's substance, and the audit chain, must come through
       untouched — this adds a column beside the data, it does not edit it. */
    const eventFp = `SELECT md5(string_agg(id || '|' || title || '|' || COALESCE(starts_on::text,'') || '|' ||
                        COALESCE(venue,'') || '|' || COALESCE(organizer_department,''),
                        E'\\n' ORDER BY id)) AS fp FROM events`;
    const chainFp = `SELECT md5(string_agg(id || '|' || COALESCE(entry_hash,''), E'\\n' ORDER BY id)) AS fp FROM audit_logs`;
    const beforeFp = {
      'every event': (await client.query(eventFp)).rows[0].fp,
      'the audit hash chain': (await client.query(chainFp)).rows[0].fp
    };

    log(`[1/3] Before: ${before.events} events, ${before.registrations} registrations, ` +
        `${before.tickets} ticket types, ${before.tasks} tasks`);

    log('\n[2/3] Applying schema_v18.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v18.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const resolvable = await one(
      `SELECT COUNT(*)::int n FROM events e JOIN departments d ON d.name = e.organizer_department`);

    const checks = [
      ['no event lost',          'SELECT COUNT(*)::int n FROM events', before.events],
      ['no registration lost',   'SELECT COUNT(*)::int n FROM event_registrations', before.registrations],
      ['no ticket type lost',    'SELECT COUNT(*)::int n FROM event_ticket_types', before.tickets],
      ['no task lost',           'SELECT COUNT(*)::int n FROM event_tasks', before.tasks],
      ['no audit entry touched', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],

      ['events.department_id exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='events' AND column_name='department_id'`, 1],
      ['every event whose organiser names a real department was linked',
        'SELECT COUNT(*)::int n FROM events WHERE department_id IS NOT NULL', resolvable],
      ['no event was linked to a department its organiser does not name',
        `SELECT COUNT(*)::int n FROM events e JOIN departments d ON d.id = e.department_id
          WHERE d.name <> e.organizer_department`, 0],
      ['an event with no resolvable department stays institution-wide',
        `SELECT COUNT(*)::int n FROM events
          WHERE department_id IS NULL AND organizer_department IN (SELECT name FROM departments)`, 0],
      ['the event department index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='events' AND indexname='idx_events_department'`, 1]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(64)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    const afterFp = {
      'every event': (await client.query(eventFp)).rows[0].fp,
      'the audit hash chain': (await client.query(chainFp)).rows[0].fp
    };
    for (const k of Object.keys(beforeFp)) {
      const same = beforeFp[k] === afterFp[k];
      if (!same) bad++;
      log(`  ${same ? 'ok  ' : 'FAIL'} ${(k + ' unchanged, byte for byte').padEnd(64)} ` +
          `${same ? 'identical' : 'CHANGED'}`);
    }

    log('\n  Event ownership after the back-fill:');
    for (const r of (await client.query(`
      SELECT COALESCE(d.code, '—') AS code,
             COALESCE(d.name, '(institution-wide: no single department)') AS name,
             COUNT(e.id)::int AS events
      FROM events e LEFT JOIN departments d ON d.id = e.department_id
      GROUP BY d.code, d.name ORDER BY events DESC`)).rows) {
      log(`    ${String(r.code).padEnd(5)} ${r.name.padEnd(46)} ${r.events} events`);
    }

    if (bad) { failed = true; throw new Error(`${bad} verification check(s) failed`); }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN complete — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v18 complete ===\n');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log('\nMIGRATION FAILED — rolled back:', err.message, '\n');
    failed = true;
  } finally {
    client.release();
    await db.pool.end();
    process.exit(failed ? 1 : 0);
  }
})();
