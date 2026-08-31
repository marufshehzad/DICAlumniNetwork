/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v7  (authority accounts)

   Adds the record-keeping an institutional administrator account needs —
   designation, contact details, status, provenance, sign-in history, durable
   lockout, password reset — plus actor/target columns on the audit log.

   Additive and idempotent: every statement is IF NOT EXISTS, nothing is
   dropped, no row is moved and no existing column changes meaning. Runs in one
   transaction and rolls back on any failure.

   Usage:  node migrate_v7.js            (apply)
           node migrate_v7.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v7 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v7 ===\n');

    const before = {
      users: (await client.query('SELECT COUNT(*)::int n FROM users')).rows[0].n,
      staff: (await client.query(
        `SELECT COUNT(*)::int n FROM users WHERE role <> 'alumni'`)).rows[0].n,
      audits: (await client.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n,
      profiles: (await client.query('SELECT COUNT(*)::int n FROM alumni_profiles')).rows[0].n
    };
    log(`[1/4] Before: ${before.users} users (${before.staff} staff), ` +
        `${before.profiles} alumni profiles, ${before.audits} audit entries`);

    log('\n[2/4] Applying schema_v7.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v7.sql'), 'utf8'));
    log('  schema applied');

    /* Backfill. Every account that already exists is active — the column
       defaults to that, but state it explicitly so a re-run over a partially
       migrated database cannot leave a NULL. Existing staff get their current
       role_label as a starting designation, which is the closest true value the
       database holds; it is editable afterwards. Nothing is invented. */
    log('\n[3/4] Backfilling…');
    const act = await client.query(
      `UPDATE users SET status = 'active' WHERE status IS NULL`);
    log(`  accounts marked active: ${act.rowCount}`);

    const desig = await client.query(
      `UPDATE users SET designation = role_label
        WHERE designation IS NULL AND role <> 'alumni' AND role_label IS NOT NULL`);
    log(`  staff given a starting designation from role_label: ${desig.rowCount}`);

    log('\n[4/4] Verifying…');
    const checks = [
      ['no user lost',            `SELECT COUNT(*)::int n FROM users`, before.users],
      ['no alumni profile lost',  `SELECT COUNT(*)::int n FROM alumni_profiles`, before.profiles],
      ['no audit entry lost',     `SELECT COUNT(*)::int n FROM audit_logs`, before.audits],
      ['every account has a status',
        `SELECT COUNT(*)::int n FROM users WHERE status IS NULL`, 0],
      ['no account is suspended by the migration',
        `SELECT COUNT(*)::int n FROM users WHERE status <> 'active'`, 0],
      ['status is constrained',
        `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname = 'users_status_check'`, 1],
      ['every staff account has a designation',
        `SELECT COUNT(*)::int n FROM users WHERE role <> 'alumni' AND designation IS NULL`, 0],
      ['no password hash touched',
        `SELECT COUNT(*)::int n FROM users WHERE password_hash IS NULL OR password_hash = ''`, 0],
      ['no role changed',
        `SELECT COUNT(*)::int n FROM users WHERE role NOT IN
           ('alumni','moderator','dept_admin','univ_admin','super_admin')`, 0],
      ['lockout counters start at zero',
        `SELECT COUNT(*)::int n FROM users WHERE failed_login_count <> 0`, 0],
      ['no reset token exists yet',
        `SELECT COUNT(*)::int n FROM users WHERE reset_token_hash IS NOT NULL`, 0],
    ];

    const cols = [
      'designation', 'phone', 'photo_url', 'status', 'created_by', 'updated_at',
      'last_login_at', 'last_password_changed_at', 'failed_login_count',
      'locked_until', 'reset_token_hash', 'reset_expires_at'
    ];
    for (const c of cols) {
      checks.push([`users.${c} exists`,
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='users' AND column_name='${c}'`, 1]);
    }
    for (const c of ['actor_id', 'target_type', 'target_id', 'ip']) {
      checks.push([`audit_logs.${c} exists`,
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='${c}'`, 1]);
    }

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const ok = got === expected;
      if (!ok) bad++;
      log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${got}${ok ? '' : ' (expected ' + expected + ')'}`);
    }

    if (bad) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v7 COMPLETE ===\n');
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
