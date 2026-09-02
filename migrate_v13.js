/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v13  (real location system)

   Adds location_places, alumni_profiles.place_id and
   alumni_profiles.location_needs_confirmation, and flags every location that
   predates this migration as unconfirmed.

   It does NOT rewrite, normalise or delete a single existing city or country
   value. Those values were written by hardcoded literals in the registration
   and bulk-import paths, so they are untrustworthy — but they are also the
   only record of what the old system stored, and converting them would turn a
   fabrication into structured data that looks deliberate.

   Usage:  node migrate_v13.js            (apply)
           node migrate_v13.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v13 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v13 ===\n');

    const one = async (sql) => (await client.query(sql)).rows[0].n;

    const before = {
      profiles: await one('SELECT COUNT(*)::int n FROM alumni_profiles'),
      withCity: await one(`SELECT COUNT(*)::int n FROM alumni_profiles WHERE COALESCE(city,'') <> ''`),
      withCountry: await one(`SELECT COUNT(*)::int n FROM alumni_profiles WHERE COALESCE(country,'') <> ''`),
      audits: await one('SELECT COUNT(*)::int n FROM audit_logs')
    };

    /* Fingerprint of every stored location value. It must be byte-identical
       afterwards: this migration adds structure alongside the old data, it
       does not touch the old data. */
    const locFp = `
      SELECT md5(string_agg(
               id || '|' || COALESCE(city,'') || '|' || COALESCE(country,'') || '|' ||
               COALESCE(district,'') || '|' || COALESCE(division,'') || '|' ||
               COALESCE(hometown,'') || '|' || COALESCE(postal_code,'') || '|' ||
               COALESCE(present_address,'') || '|' || COALESCE(permanent_address,''),
               E'\\n' ORDER BY id)) AS fp FROM alumni_profiles`;
    const beforeFp = (await client.query(locFp)).rows[0].fp;

    log(`[1/3] Before: ${before.profiles} profiles — ${before.withCity} with a city, ` +
        `${before.withCountry} with a country (all of them written by a hardcoded literal)`);

    log('\n[2/3] Applying schema_v13.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v13.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const checks = [
      ['no profile lost', 'SELECT COUNT(*)::int n FROM alumni_profiles', before.profiles],
      ['no audit entry touched', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['location_places exists',
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='location_places'`, 1],
      ['alumni_profiles.place_id exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='alumni_profiles' AND column_name='place_id'`, 1],
      ['alumni_profiles.location_needs_confirmation exists',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='alumni_profiles' AND column_name='location_needs_confirmation'`, 1],
      ['NO latitude column was added to alumni_profiles — coordinates belong to places',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='alumni_profiles' AND column_name IN ('latitude','longitude','lat','lng')`, 0],
      ['alumni_profiles.country no longer defaults to Bangladesh',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='alumni_profiles' AND column_name='country'
            AND column_default IS NOT NULL`, 0],
      ['every place carries real coordinates',
        'SELECT COUNT(*)::int n FROM location_places WHERE latitude IS NULL OR longitude IS NULL', 0],
      ['coordinates are inside the valid range',
        `SELECT COUNT(*)::int n FROM location_places
          WHERE latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180`, 0],
      ['no duplicate city within a country',
        `SELECT COUNT(*)::int n FROM (
           SELECT country_code, LOWER(city) FROM location_places
            GROUP BY 1,2 HAVING COUNT(*) > 1) d`, 0],
      ['no profile was auto-linked to a place — confirmation is the alumnus’s to give',
        'SELECT COUNT(*)::int n FROM alumni_profiles WHERE place_id IS NOT NULL', 0],
      ['every pre-existing location is flagged unconfirmed',
        `SELECT COUNT(*)::int n FROM alumni_profiles
          WHERE (COALESCE(city,'') <> '' OR COALESCE(country,'') <> '')
            AND location_needs_confirmation = FALSE`, 0],
      ['a profile with no location is NOT flagged — there is nothing to confirm',
        `SELECT COUNT(*)::int n FROM alumni_profiles
          WHERE COALESCE(city,'') = '' AND COALESCE(country,'') = ''
            AND location_needs_confirmation = TRUE`, 0],
      ['the flag matches the rows that carry a location', 'SELECT COUNT(*)::int n FROM alumni_profiles WHERE location_needs_confirmation', before.withCity],
      ['the place index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='alumni_profiles' AND indexname='idx_profiles_place'`, 1],
      ['the country/city uniqueness index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='location_places' AND indexname='idx_places_country_city'`, 1],
      ['Bangladesh reference places were seeded',
        `SELECT COUNT(*)::int n FROM location_places WHERE country_code='BD'`, 30]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    // The strongest check: not one stored location value moved.
    const afterFp = (await client.query(locFp)).rows[0].fp;
    const fpOk = afterFp === beforeFp;
    if (!fpOk) bad++;
    log(`  ${fpOk ? 'ok  ' : 'FAIL'} ${'existing location values are byte-identical'.padEnd(66)} ${afterFp}`);

    const placeCount = await one('SELECT COUNT(*)::int n FROM location_places');
    log(`\n  ${placeCount} reference places available.`);

    if (bad) throw new Error(`${bad} verification check(s) failed — rolling back`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN COMPLETE — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v13 COMPLETE ===');
      log(`    ${before.withCity} profile(s) carry a location written by the old hardcoded`);
      log('    path. They are preserved unchanged and flagged for confirmation by');
      log('    the alumnus. Nothing was converted, normalised or deleted.\n');
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
