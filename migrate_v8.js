/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v8  (session revocation)

   Adds users.token_version so a session can be ended before its token expires.
   One column, one default, nothing else touched.

   Usage:  node migrate_v8.js            (apply)
           node migrate_v8.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v8 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v8 ===\n');

    const before = {
      users: (await client.query('SELECT COUNT(*)::int n FROM users')).rows[0].n,
      audits: (await client.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n
    };
    log(`[1/3] Before: ${before.users} users, ${before.audits} audit entries`);

    log('\n[2/3] Applying schema_v8.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v8.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const checks = [
      ['no user lost', 'SELECT COUNT(*)::int n FROM users', before.users],
      ['no audit entry lost', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['users.token_version exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='users' AND column_name='token_version'`, 1],
      ['every account starts at version 1',
        'SELECT COUNT(*)::int n FROM users WHERE token_version <> 1', 0],
      ['no account has a null version',
        'SELECT COUNT(*)::int n FROM users WHERE token_version IS NULL', 0],
      ['no password hash touched',
        `SELECT COUNT(*)::int n FROM users WHERE password_hash IS NULL OR password_hash = ''`, 0],
      ['no account suspended by the migration',
        `SELECT COUNT(*)::int n FROM users WHERE status <> 'active'`, 0],
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const ok = got === expected;
      if (!ok) bad++;
      log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} ${got}${ok ? '' : ' (expected ' + expected + ')'}`);
    }
    if (bad) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v8 COMPLETE ===\n');
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
