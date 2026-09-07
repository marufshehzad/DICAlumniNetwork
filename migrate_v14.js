/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v14  (event, job and chapter location)

   v13 modelled the alumni location domain. This one models the other three,
   keeping them separate because they mean different things:

     events    address + optional venue coordinates. A venue is public by
               nature, so residential privacy does not apply to it.
     jobs      work_mode only — onsite / remote / hybrid. The free-text
               location column is left exactly as it is.
     chapters  place_id into location_places, so an institution's city has the
               same definition as an alumnus's.

   Like v13, it adds structure beside the existing data and rewrites none of
   it. Every new column is nullable with no default: an unknown location stays
   unknown rather than becoming a fabrication.

   Usage:  node migrate_v14.js            (apply)
           node migrate_v14.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v14 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v14 ===\n');

    const one = async (sql) => (await client.query(sql)).rows[0].n;

    const before = {
      events:   await one('SELECT COUNT(*)::int n FROM events'),
      jobs:     await one('SELECT COUNT(*)::int n FROM jobs'),
      chapters: await one('SELECT COUNT(*)::int n FROM chapters'),
      profiles: await one('SELECT COUNT(*)::int n FROM alumni_profiles'),
      places:   await one('SELECT COUNT(*)::int n FROM location_places'),
      audits:   await one('SELECT COUNT(*)::int n FROM audit_logs')
    };

    /* Fingerprints of the columns this migration must not touch. v13 proved
       the alumni location values were byte-identical afterwards; the same
       proof is owed to the venue, job location and chapter rows. */
    const venueFp = `SELECT md5(string_agg(id || '|' || COALESCE(venue,''), E'\\n' ORDER BY id)) AS fp FROM events`;
    const jobFp   = `SELECT md5(string_agg(id || '|' || COALESCE(location,'') || '|' || COALESCE(type,''), E'\\n' ORDER BY id)) AS fp FROM jobs`;
    const chapFp  = `SELECT md5(string_agg(id || '|' || COALESCE(name,'') || '|' || COALESCE(type,''), E'\\n' ORDER BY id)) AS fp FROM chapters`;
    const alumFp  = `SELECT md5(string_agg(id || '|' || COALESCE(city,'') || '|' || COALESCE(country,'') || '|' ||
                                COALESCE(place_id::text,''), E'\\n' ORDER BY id)) AS fp FROM alumni_profiles`;
    const beforeFps = {
      venue: (await client.query(venueFp)).rows[0].fp,
      job:   (await client.query(jobFp)).rows[0].fp,
      chap:  (await client.query(chapFp)).rows[0].fp,
      alum:  (await client.query(alumFp)).rows[0].fp
    };

    log(`[1/3] Before: ${before.events} events, ${before.jobs} jobs, ` +
        `${before.chapters} chapters, ${before.places} reference places`);

    log('\n[2/3] Applying schema_v14.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v14.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const col = (t, c) =>
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='${t}' AND column_name='${c}'`;
    const checks = [
      ['no event lost',    'SELECT COUNT(*)::int n FROM events', before.events],
      ['no job lost',      'SELECT COUNT(*)::int n FROM jobs', before.jobs],
      ['no chapter lost',  'SELECT COUNT(*)::int n FROM chapters', before.chapters],
      ['no profile lost',  'SELECT COUNT(*)::int n FROM alumni_profiles', before.profiles],
      ['no audit entry touched', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],
      ['no reference place added or removed', 'SELECT COUNT(*)::int n FROM location_places', before.places],

      ['events.address exists',   col('events', 'address'), 1],
      ['events.latitude exists',  col('events', 'latitude'), 1],
      ['events.longitude exists', col('events', 'longitude'), 1],
      ['jobs.work_mode exists',   col('jobs', 'work_mode'), 1],
      ['chapters.place_id exists', col('chapters', 'place_id'), 1],

      ['no event was given an invented address',
        `SELECT COUNT(*)::int n FROM events WHERE address IS NOT NULL`, 0],
      ['no event was given invented coordinates',
        `SELECT COUNT(*)::int n FROM events WHERE latitude IS NOT NULL OR longitude IS NOT NULL`, 0],
      ['no job was assigned a work mode it never declared',
        `SELECT COUNT(*)::int n FROM jobs WHERE work_mode IS NOT NULL`, 0],
      ['no chapter was auto-linked to a place',
        `SELECT COUNT(*)::int n FROM chapters WHERE place_id IS NOT NULL`, 0],

      ['a half coordinate is rejected',
        `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='events_coords_paired'`, 1],
      ['out-of-range latitude is rejected',
        `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='events_coords_range'`, 1],
      ['out-of-range longitude is rejected',
        `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='events_coords_range_lng'`, 1],
      ['work_mode is restricted to the three real answers',
        `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='jobs_work_mode_valid'`, 1],

      ['the chapter place index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='chapters' AND indexname='idx_chapters_place'`, 1],
      ['the district index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='location_places' AND indexname='idx_places_district'`, 1],

      ['NO coordinate column was added to alumni_profiles — a person is not a point',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='alumni_profiles' AND column_name IN ('latitude','longitude','lat','lng')`, 0],
      ['chapters carry no member-derived location',
        `SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='chapters' AND column_name IN ('member_city','member_country','home_city')`, 0]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(68)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    // The strongest check: not one existing value moved.
    const afterFps = {
      venue: (await client.query(venueFp)).rows[0].fp,
      job:   (await client.query(jobFp)).rows[0].fp,
      chap:  (await client.query(chapFp)).rows[0].fp,
      alum:  (await client.query(alumFp)).rows[0].fp
    };
    for (const k of Object.keys(beforeFps)) {
      const same = beforeFps[k] === afterFps[k];
      if (!same) bad++;
      log(`  ${same ? 'ok  ' : 'FAIL'} ${(k + ' rows unchanged, byte for byte').padEnd(68)} ${same ? 'identical' : 'CHANGED'}`);
    }

    if (bad) { failed = true; throw new Error(`${bad} verification check(s) failed`); }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN complete — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v14 complete ===\n');
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
