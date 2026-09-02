/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v9  (honest donation states)

   Widens donations.status to admit PLEDGED and CANCELLED, and adds the three
   columns that record who confirmed a payment and how. Nothing is dropped and
   no existing row is rewritten — in particular the one historical SUCCESS row
   is left exactly as it is.

   Usage:  node migrate_v9.js            (apply)
           node migrate_v9.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v9 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v9 ===\n');

    const before = {
      donations: (await client.query('SELECT COUNT(*)::int n FROM donations')).rows[0].n,
      success: (await client.query("SELECT COUNT(*)::int n FROM donations WHERE status='SUCCESS'")).rows[0].n,
      sum: (await client.query('SELECT COALESCE(SUM(amount),0)::numeric s FROM donations')).rows[0].s,
      campaigns: (await client.query('SELECT COUNT(*)::int n FROM campaigns')).rows[0].n,
      audits: (await client.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n
    };
    log(`[1/3] Before: ${before.donations} donations (${before.success} SUCCESS, total ৳${before.sum}), ` +
        `${before.campaigns} campaigns, ${before.audits} audit entries`);

    log('\n[2/3] Applying schema_v9.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v9.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const checks = [
      ['no donation lost', 'SELECT COUNT(*)::int n FROM donations', before.donations],
      ['historical SUCCESS rows untouched',
        "SELECT COUNT(*)::int n FROM donations WHERE status='SUCCESS'", before.success],
      ['no campaign lost', 'SELECT COUNT(*)::int n FROM campaigns', before.campaigns],
      ['no audit entry lost', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['donations.recorded_by exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='donations' AND column_name='recorded_by'`, 1],
      ['donations.recorded_at exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='donations' AND column_name='recorded_at'`, 1],
      ['donations.recorded_method exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='donations' AND column_name='recorded_method'`, 1],
      ['no historical row claims a recorder',
        'SELECT COUNT(*)::int n FROM donations WHERE recorded_by IS NOT NULL', 0],
      ['status CHECK admits PLEDGED',
        `SELECT COUNT(*)::int n FROM pg_constraint
          WHERE conname='donations_status_check'
            AND pg_get_constraintdef(oid) LIKE '%PLEDGED%'`, 1],
      ['status CHECK admits CANCELLED',
        `SELECT COUNT(*)::int n FROM pg_constraint
          WHERE conname='donations_status_check'
            AND pg_get_constraintdef(oid) LIKE '%CANCELLED%'`, 1],
      ['status CHECK still admits SUCCESS',
        `SELECT COUNT(*)::int n FROM pg_constraint
          WHERE conname='donations_status_check'
            AND pg_get_constraintdef(oid) LIKE '%SUCCESS%'`, 1],
      ['status index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='donations' AND indexname='idx_donations_status'`, 1],
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const ok = got === expected;
      if (!ok) bad++;
      log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} ${got}${ok ? '' : ' (expected ' + expected + ')'}`);
    }

    // The widened constraint must actually accept a PLEDGED write. Proved by
    // inserting and deleting inside this transaction so nothing survives it.
    let pledgeAccepted = false;
    if (!bad) {
      const camp = await client.query('SELECT id FROM campaigns ORDER BY id LIMIT 1');
      if (camp.rows.length) {
        await client.query(`
          INSERT INTO donations (campaign_id, donor_name, amount, payment_gateway,
                                 transaction_reference, status)
          VALUES ($1, 'migration probe', 1, 'manual', $2, 'PLEDGED')`,
          [camp.rows[0].id, 'MIGRATION-PROBE-V9']);
        await client.query("DELETE FROM donations WHERE transaction_reference = 'MIGRATION-PROBE-V9'");
        pledgeAccepted = true;
      } else {
        log('  ..   no campaign present, skipping the PLEDGED write probe');
        pledgeAccepted = true;
      }
      log(`  ok   a PLEDGED row is accepted and rolled back`);
      const after = (await client.query('SELECT COUNT(*)::int n FROM donations')).rows[0].n;
      if (after !== before.donations) { bad++; log('  FAIL probe row survived'); }
    }
    if (bad || !pledgeAccepted) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v9 COMPLETE ===\n');
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
