/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v17  (department relation)

   Adds the reference table and the two foreign keys that make department scope
   enforceable, and back-fills alumni from their own profile by exact match.

   Nothing is dropped, no department is invented, and no staff account is
   assigned one — see schema_v17.sql for why each of those is deliberate.

   Usage:  node migrate_v17.js            (apply)
           node migrate_v17.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v17 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v17 ===\n');

    const one = async (sql, p) => (await client.query(sql, p)).rows[0].n;

    const before = {
      users:    await one('SELECT COUNT(*)::int n FROM users'),
      profiles: await one('SELECT COUNT(*)::int n FROM alumni_profiles'),
      audits:   await one('SELECT COUNT(*)::int n FROM audit_logs'),
      alumni:   await one(`SELECT COUNT(*)::int n FROM users WHERE role = 'alumni'`)
    };

    /* The free-text department columns must come through untouched: this
       migration adds an authority beside them, it does not rewrite them. */
    const userDeptFp = `SELECT md5(string_agg(id || '|' || department, E'\\n' ORDER BY id)) AS fp FROM users`;
    const profDeptFp = `SELECT md5(string_agg(id || '|' || COALESCE(department,''), E'\\n' ORDER BY id)) AS fp FROM alumni_profiles`;
    const chainFp    = `SELECT md5(string_agg(id || '|' || COALESCE(entry_hash,''), E'\\n' ORDER BY id)) AS fp FROM audit_logs`;
    const beforeFp = {
      'users.department':           (await client.query(userDeptFp)).rows[0].fp,
      'alumni_profiles.department': (await client.query(profDeptFp)).rows[0].fp,
      'the audit hash chain':       (await client.query(chainFp)).rows[0].fp
    };

    log(`[1/3] Before: ${before.users} users (${before.alumni} alumni), ` +
        `${before.profiles} profiles, ${before.audits} audit entries`);

    log('\n[2/3] Applying schema_v17.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v17.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const col = (t, c) =>
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='${t}' AND column_name='${c}'`;

    /* What the back-fill should have reached, computed from the data rather
       than hardcoded, so this stays true on a different database. */
    const resolvable = await one(
      `SELECT COUNT(*)::int n FROM alumni_profiles ap JOIN departments d ON d.name = ap.department`);
    const unresolved = await one(
      `SELECT COUNT(*)::int n FROM alumni_profiles ap
        WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.name = ap.department)`);

    const checks = [
      ['no user lost',           'SELECT COUNT(*)::int n FROM users', before.users],
      ['no profile lost',        'SELECT COUNT(*)::int n FROM alumni_profiles', before.profiles],
      ['no audit entry touched', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],

      ['the departments table exists',
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='departments'`, 1],
      ['four departments are seeded, and only four',
        'SELECT COUNT(*)::int n FROM departments', 4],
      ['every seeded department is active',
        'SELECT COUNT(*)::int n FROM departments WHERE is_active', 4],
      /* Only meaningful where there ARE profiles. On a fresh install there are
         none, and the four rows this seeds are the institution's reference list
         rather than data invented from anything — the fresh-install drill
         caught this check asserting otherwise and failing an empty database. */
      ['no department was invented that no profile carries',
        `SELECT COUNT(*)::int n FROM departments d
          WHERE EXISTS (SELECT 1 FROM alumni_profiles)
            AND NOT EXISTS (SELECT 1 FROM alumni_profiles ap WHERE ap.department = d.name)`, 0],
      ["'Science' was NOT seeded as a department — it is an HSC group",
        `SELECT COUNT(*)::int n FROM departments WHERE name = 'Science'`, 0],

      ['users.department_id exists',           col('users', 'department_id'), 1],
      ['alumni_profiles.department_id exists', col('alumni_profiles', 'department_id'), 1],

      ['every resolvable profile was linked',
        'SELECT COUNT(*)::int n FROM alumni_profiles WHERE department_id IS NOT NULL', resolvable],
      ['every unresolvable profile was left NULL rather than guessed',
        'SELECT COUNT(*)::int n FROM alumni_profiles WHERE department_id IS NULL', unresolved],
      ['no profile was linked to a department its text does not name',
        `SELECT COUNT(*)::int n FROM alumni_profiles ap JOIN departments d ON d.id = ap.department_id
          WHERE d.name <> ap.department`, 0],

      ['each linked alumni account matches its own profile',
        `SELECT COUNT(*)::int n FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id
          WHERE u.role = 'alumni' AND u.department_id IS DISTINCT FROM ap.department_id`, 0],
      ['no staff account was assigned a department by this migration',
        `SELECT COUNT(*)::int n FROM users WHERE role <> 'alumni' AND department_id IS NOT NULL`, 0],

      ['the user department index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='users' AND indexname='idx_users_department'`, 1],
      ['the profile department index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='alumni_profiles' AND indexname='idx_profiles_department'`, 1]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(64)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    const afterFp = {
      'users.department':           (await client.query(userDeptFp)).rows[0].fp,
      'alumni_profiles.department': (await client.query(profDeptFp)).rows[0].fp,
      'the audit hash chain':       (await client.query(chainFp)).rows[0].fp
    };
    for (const k of Object.keys(beforeFp)) {
      const same = beforeFp[k] === afterFp[k];
      if (!same) bad++;
      log(`  ${same ? 'ok  ' : 'FAIL'} ${(k + ' unchanged, byte for byte').padEnd(64)} ` +
          `${same ? 'identical' : 'CHANGED'}`);
    }

    /* What an operator will actually want to see: who ended up where. */
    log('\n  Department assignment after the back-fill:');
    for (const r of (await client.query(`
      SELECT COALESCE(d.code, '—') AS code, COALESCE(d.name, '(no department resolved)') AS name,
             COUNT(ap.id)::int AS alumni
      FROM alumni_profiles ap LEFT JOIN departments d ON d.id = ap.department_id
      GROUP BY d.code, d.name ORDER BY alumni DESC, name`)).rows) {
      log(`    ${String(r.code).padEnd(5)} ${r.name.padEnd(40)} ${r.alumni} alumni`);
    }
    const staff = (await client.query(
      `SELECT role, department FROM users WHERE role <> 'alumni' ORDER BY id`)).rows;
    log('\n  Staff accounts, all left unassigned for an administrator to decide:');
    for (const s of staff) log(`    ${s.role.padEnd(12)} ${s.department}`);

    if (bad) { failed = true; throw new Error(`${bad} verification check(s) failed`); }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN complete — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v17 complete ===\n');
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
