/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v11  (verifiable audit chain)

   Adds the persisted chain columns and the chain head. Historical entries are
   preserved byte for byte and marked as the legacy segment; no replacement
   hash is invented for them.

   Usage:  node migrate_v11.js            (apply)
           node migrate_v11.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v11 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v11 ===\n');

    const before = {
      audits: (await client.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n,
      users: (await client.query('SELECT COUNT(*)::int n FROM users')).rows[0].n,
      minId: (await client.query('SELECT MIN(id)::int n FROM audit_logs')).rows[0].n,
      maxId: (await client.query('SELECT MAX(id)::int n FROM audit_logs')).rows[0].n
    };
    // Fingerprint the historical segment so the checks below can prove nothing
    // in it moved. md5 over the concatenated immutable fields of every row.
    const fingerprintSql = `
      SELECT md5(string_agg(
               id || '|' || COALESCE(action,'') || '|' || COALESCE(meta,'') || '|' ||
               COALESCE(hash,'') || '|' || created_at, E'\\n' ORDER BY id)) AS fp
        FROM audit_logs`;
    const beforeFp = (await client.query(fingerprintSql)).rows[0].fp;

    log(`[1/4] Before: ${before.audits} audit entries (ids ${before.minId}–${before.maxId}), ` +
        `${before.users} users`);
    log(`      historical fingerprint ${beforeFp}`);

    log('\n[2/4] Applying schema_v11.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v11.sql'), 'utf8'));
    log('  schema applied');

    /* The boundary. Every row that exists right now predates the verifiable
       scheme and is marked accordingly. This writes only chain_version, and
       only where it is still at its default — it never touches action, meta,
       hash or created_at. */
    log('\n[3/4] Marking the historical segment…');
    const marked = await client.query(
      `UPDATE audit_logs SET chain_version = 0
        WHERE chain_version IS DISTINCT FROM 0 RETURNING id`);
    log(`  ${marked.rowCount} row(s) needed the marker (the column defaults to 0, so this is usually 0)`);

    const lastLegacy = await client.query(
      `SELECT hash FROM audit_logs WHERE chain_version = 0 ORDER BY id DESC LIMIT 1`);
    const boundary = lastLegacy.rows[0]?.hash || 'NONE';
    log(`  boundary recorded at legacy hash ${boundary}`);
    log(`  the first verifiable entry will carry prev_hash = LEGACY-BOUNDARY:${boundary}`);

    log('\n[4/4] Verifying…');
    const checks = [
      ['no audit entry lost', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['no user lost', 'SELECT COUNT(*)::int n FROM users', before.users],
      ['lowest audit id unchanged', 'SELECT MIN(id)::int n FROM audit_logs', before.minId],
      ['highest audit id unchanged', 'SELECT MAX(id)::int n FROM audit_logs', before.maxId],
      ['every existing row is marked legacy',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version <> 0', 0],
      ['no legacy row was given a fabricated entry_hash',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version = 0 AND entry_hash IS NOT NULL', 0],
      ['no legacy row was given a fabricated prev_hash',
        'SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version = 0 AND prev_hash IS NOT NULL', 0],
      ['audit_logs.chain_version exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='chain_version'`, 1],
      ['audit_logs.prev_hash exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='prev_hash'`, 1],
      ['audit_logs.entry_hash exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='entry_hash'`, 1],
      ['the legacy hash column still exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='hash'`, 1],
      ['the legacy hash column is now optional',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='audit_logs' AND column_name='hash' AND is_nullable='YES'`, 1],
      ['no legacy hash was emptied',
        `SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=0 AND (hash IS NULL OR hash='')`, 0],
      ['audit_chain exists with exactly one row', 'SELECT COUNT(*)::int n FROM audit_chain', 1],
      ['the chain head starts empty',
        'SELECT COUNT(*)::int n FROM audit_chain WHERE head_hash IS NULL AND entry_count = 0', 1],
      ['the chain index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='audit_logs' AND indexname='idx_audit_chain'`, 1],
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(50)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    // The strongest check available: the historical segment must be bit-identical.
    const afterFp = (await client.query(fingerprintSql)).rows[0].fp;
    const fpOk = afterFp === beforeFp;
    if (!fpOk) bad++;
    log(`  ${fpOk ? 'ok  ' : 'FAIL'} ${'historical entries are untouched'.padEnd(50)} ${afterFp}`);

    if (bad) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v11 COMPLETE ===');
      log(`    ${before.audits} historical entries preserved and marked legacy.`);
      log('    They are NOT cryptographically verifiable — the original digest');
      log('    input was never persisted. See AUDIT_CHAIN.md section 1.');
      log('    Every entry written from now on is verifiable: node verify_audit.js\n');
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
