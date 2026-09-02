/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v12  (immutable actor reference)

   Adds audit_logs.actor_ref and backfills it. Chain version 2 begins with the
   next audit entry written; version 1 entries are preserved unchanged.

   Usage:  node migrate_v12.js            (apply)
           node migrate_v12.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v12 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v12 ===\n');

    const before = {
      audits: (await client.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n,
      v0: (await client.query('SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=0')).rows[0].n,
      v1: (await client.query('SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=1')).rows[0].n,
      withActor: (await client.query('SELECT COUNT(*)::int n FROM audit_logs WHERE actor_id IS NOT NULL')).rows[0].n
    };
    const fingerprintSql = `
      SELECT md5(string_agg(
               id || '|' || COALESCE(action,'') || '|' || COALESCE(meta,'') || '|' ||
               COALESCE(entry_hash,'') || '|' || COALESCE(prev_hash,'') || '|' || created_at,
               E'\\n' ORDER BY id)) AS fp FROM audit_logs`;
    const beforeFp = (await client.query(fingerprintSql)).rows[0].fp;

    log(`[1/3] Before: ${before.audits} entries — ${before.v0} legacy (v0), ${before.v1} superseded (v1), ` +
        `${before.withActor} with a surviving actor`);

    log('\n[2/3] Applying schema_v12.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v12.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const checks = [
      ['no audit entry lost', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['legacy segment unchanged in size',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=0', before.v0],
      ['v1 segment preserved',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=1', before.v1],
      ['audit_logs.actor_ref exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='actor_ref'`, 1],
      ['actor_ref carries NO foreign key — the entire point of it',
        `SELECT COUNT(*)::int n
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name='audit_logs' AND tc.constraint_type='FOREIGN KEY'
            AND kcu.column_name='actor_ref'`, 0],
      ['every surviving actor was backfilled',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE actor_id IS NOT NULL AND actor_ref IS NULL', 0],
      ['no attribution was invented for rows whose actor is gone',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE actor_id IS NULL AND actor_ref IS NOT NULL AND chain_version=0', 0],
      ['actor_id still has its foreign key, for joins',
        `SELECT COUNT(*)::int n
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name='audit_logs' AND tc.constraint_type='FOREIGN KEY'
            AND kcu.column_name='actor_id'`, 1],
      ['no v1 entry_hash was rewritten to fit the new scheme',
        `SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=1 AND entry_hash IS NULL`, 0],
      ['the chain head is reset for version 2',
        'SELECT COUNT(*)::int n FROM audit_chain WHERE id=1 AND head_hash IS NULL AND entry_count=0', 1],
      ['the actor_ref index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='audit_logs' AND indexname='idx_audit_actor_ref'`, 1],
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    // Nothing inside the digest of any existing entry may have moved.
    const afterFp = (await client.query(fingerprintSql)).rows[0].fp;
    const fpOk = afterFp === beforeFp;
    if (!fpOk) bad++;
    log(`  ${fpOk ? 'ok  ' : 'FAIL'} ${'existing entries are untouched'.padEnd(54)} ${afterFp}`);

    if (bad) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v12 COMPLETE ===');
      log(`    Chain version 2 begins with the next entry written.`);
      log(`    ${before.v0} legacy and ${before.v1} superseded entries are preserved`);
      log('    and reported honestly by the verifier, not rewritten.\n');
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
