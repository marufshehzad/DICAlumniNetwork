/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v16  (import identity, rollback, audit reads)

   An import could be seen and not undone. It recorded who ran it as a name the
   client supplied, and nothing tied a created account back to the batch that
   created it. This adds both, plus the two indexes a filtered audit read needs
   now that /api/audit-logs is more than ORDER BY id DESC LIMIT 50 over 11,185
   rows.

   Nothing is dropped and nothing is back-filled. Existing import batches keep
   created_by NULL and have no linked accounts, which honestly says "we do not
   know which users this batch made" — and the rollback endpoint refuses such a
   batch rather than guessing.

   Usage:  node migrate_v16.js            (apply)
           node migrate_v16.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v16 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v16 ===\n');

    const one = async (sql) => (await client.query(sql)).rows[0].n;

    const before = {
      users:    await one('SELECT COUNT(*)::int n FROM users'),
      profiles: await one('SELECT COUNT(*)::int n FROM alumni_profiles'),
      imports:  await one('SELECT COUNT(*)::int n FROM import_history'),
      audits:   await one('SELECT COUNT(*)::int n FROM audit_logs')
    };

    /* What must survive untouched. The audit chain matters most: §13 of this
       phase says never break it, and adding an index must not disturb a single
       stored hash. */
    const userFp = `SELECT md5(string_agg(id || '|' || email || '|' || full_name || '|' || role || '|' ||
                        status || '|' || password_hash, E'\\n' ORDER BY id)) AS fp FROM users`;
    const importFp = `SELECT md5(string_agg(id || '|' || batch_code || '|' || filename || '|' ||
                          COALESCE(total_records,0) || '|' || COALESCE(success_count,0) || '|' || admin_name,
                          E'\\n' ORDER BY id)) AS fp FROM import_history`;
    const chainFp = `SELECT md5(string_agg(id || '|' || COALESCE(prev_hash,'') || '|' || COALESCE(entry_hash,''),
                         E'\\n' ORDER BY id)) AS fp FROM audit_logs`;
    const beforeFp = {
      user:   (await client.query(userFp)).rows[0].fp,
      import: (await client.query(importFp)).rows[0].fp,
      chain:  (await client.query(chainFp)).rows[0].fp
    };

    log(`[1/3] Before: ${before.users} users, ${before.profiles} profiles, ` +
        `${before.imports} import batches, ${before.audits} audit entries`);

    log('\n[2/3] Applying schema_v16.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v16.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const col = (t, c) =>
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='${t}' AND column_name='${c}'`;
    const idx = (t, i) =>
      `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='${t}' AND indexname='${i}'`;

    const checks = [
      ['no user lost',            'SELECT COUNT(*)::int n FROM users', before.users],
      ['no profile lost',         'SELECT COUNT(*)::int n FROM alumni_profiles', before.profiles],
      ['no import batch lost',    'SELECT COUNT(*)::int n FROM import_history', before.imports],
      ['no audit entry touched',  'SELECT COUNT(*)::int n FROM audit_logs', before.audits],

      ['import_history.created_by exists',        col('import_history', 'created_by'), 1],
      ['import_history.status exists',            col('import_history', 'status'), 1],
      ['import_history.rolled_back_at exists',    col('import_history', 'rolled_back_at'), 1],
      ['import_history.rolled_back_by exists',    col('import_history', 'rolled_back_by'), 1],
      ['import_history.rolled_back_count exists', col('import_history', 'rolled_back_count'), 1],
      ['users.import_batch_id exists',            col('users', 'import_batch_id'), 1],

      ['import status is constrained',
        `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='import_history_status_valid'`, 1],

      ['every existing batch reads as completed',
        `SELECT COUNT(*)::int n FROM import_history WHERE status = 'completed'`, before.imports],
      ['no batch was invented a rollback',
        'SELECT COUNT(*)::int n FROM import_history WHERE rolled_back_at IS NOT NULL', 0],
      ['no batch was invented an actor — history predating this cannot know one',
        'SELECT COUNT(*)::int n FROM import_history WHERE created_by IS NOT NULL', 0],
      ['no user was retroactively attributed to a batch',
        'SELECT COUNT(*)::int n FROM users WHERE import_batch_id IS NOT NULL', 0],

      ['the batch-membership index exists',  idx('users', 'idx_users_import_batch'), 1],
      ['the import date index exists',       idx('import_history', 'idx_import_history_created'), 1],
      ['the audit date index exists',        idx('audit_logs', 'idx_audit_created_at'), 1],
      ['the audit action index exists',      idx('audit_logs', 'idx_audit_action'), 1],
      ['the existing audit chain index is untouched', idx('audit_logs', 'idx_audit_chain'), 1]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(62)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    const afterFp = {
      user:   (await client.query(userFp)).rows[0].fp,
      import: (await client.query(importFp)).rows[0].fp,
      chain:  (await client.query(chainFp)).rows[0].fp
    };
    const fpLabel = { user: 'user rows', import: 'import history', chain: 'the audit hash chain' };
    for (const k of Object.keys(beforeFp)) {
      const same = beforeFp[k] === afterFp[k];
      if (!same) bad++;
      log(`  ${same ? 'ok  ' : 'FAIL'} ${(fpLabel[k] + ' unchanged, byte for byte').padEnd(62)} ` +
          `${same ? 'identical' : 'CHANGED'}`);
    }

    if (bad) { failed = true; throw new Error(`${bad} verification check(s) failed`); }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN complete — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v16 complete ===\n');
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
