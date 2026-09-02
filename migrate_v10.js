/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v10  (operations ring)

   Adds the scheduler's run log, and lets a deletion request outlive the
   account it erased so the compliance evidence survives the purge.

   Usage:  node migrate_v10.js            (apply)
           node migrate_v10.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v10 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v10 ===\n');

    const before = {
      users: (await client.query('SELECT COUNT(*)::int n FROM users')).rows[0].n,
      requests: (await client.query('SELECT COUNT(*)::int n FROM deletion_requests')).rows[0].n,
      audits: (await client.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n,
      donations: (await client.query('SELECT COUNT(*)::int n FROM donations')).rows[0].n
    };
    log(`[1/3] Before: ${before.users} users, ${before.requests} deletion requests, ` +
        `${before.donations} donations, ${before.audits} audit entries`);

    log('\n[2/3] Applying schema_v10.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v10.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const checks = [
      ['no user lost', 'SELECT COUNT(*)::int n FROM users', before.users],
      ['no deletion request lost', 'SELECT COUNT(*)::int n FROM deletion_requests', before.requests],
      ['no donation lost', 'SELECT COUNT(*)::int n FROM donations', before.donations],
      ['no audit entry lost', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['ops_runs exists',
        `SELECT COUNT(*)::int n FROM information_schema.tables
          WHERE table_name='ops_runs'`, 1],
      ['ops_runs.job exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='ops_runs' AND column_name='job'`, 1],
      ['ops_runs.source exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='ops_runs' AND column_name='source'`, 1],
      ['ops_runs is indexed by job',
        `SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='ops_runs' AND indexname='idx_ops_runs_job'`, 1],
      ['deletion_requests.user_id is nullable',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='deletion_requests' AND column_name='user_id' AND is_nullable='YES'`, 1],
      ['no deletion_requests foreign key still cascades',
        `SELECT COUNT(*)::int n
           FROM information_schema.referential_constraints rc
           JOIN information_schema.table_constraints tc ON tc.constraint_name=rc.constraint_name
          WHERE tc.table_name='deletion_requests' AND rc.delete_rule='CASCADE'`, 0],
      ['deletion_requests now sets null instead',
        `SELECT COUNT(*)::int n
           FROM information_schema.referential_constraints rc
           JOIN information_schema.table_constraints tc ON tc.constraint_name=rc.constraint_name
          WHERE tc.table_name='deletion_requests' AND rc.delete_rule='SET NULL'`, 1],
      ['deletion_requests.purged_at exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='deletion_requests' AND column_name='purged_at'`, 1],
      ['deletion_requests.subject_label exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='deletion_requests' AND column_name='subject_label'`, 1],
      ['the audit trail still sets null rather than cascading',
        `SELECT COUNT(*)::int n
           FROM information_schema.referential_constraints rc
           JOIN information_schema.table_constraints tc ON tc.constraint_name=rc.constraint_name
          WHERE tc.table_name='audit_logs' AND rc.delete_rule='SET NULL'`, 1],
      ['no request was marked purged by the migration',
        'SELECT COUNT(*)::int n FROM deletion_requests WHERE purged_at IS NOT NULL', 0],
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const ok = got === expected;
      if (!ok) bad++;
      log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(48)} ${got}${ok ? '' : ' (expected ' + expected + ')'}`);
    }

    // The run log must actually accept a write, and the new FK must actually
    // preserve a request when its user goes. Both proved inside this
    // transaction so neither survives it.
    if (!bad) {
      await client.query(
        `INSERT INTO ops_runs (job, status, detail, items, source)
         VALUES ('migration-probe','ok','v10 verification',0,'manual')`);
      const n = (await client.query("SELECT COUNT(*)::int n FROM ops_runs WHERE job='migration-probe'")).rows[0].n;
      if (n !== 1) { bad++; log('  FAIL ops_runs did not accept a write'); }
      else log('  ok   ops_runs accepts a run record');
      await client.query("DELETE FROM ops_runs WHERE job='migration-probe'");
    }
    if (bad) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v10 COMPLETE ===\n');
    }
  } catch (err) {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    console.error('\n✗ Migration failed, rolled back:', err.message, '\n');
  } finally {
    client.release();
    await db.pool.end();
    process.exitCode = failed ? 1 : 0;
  }
})();
