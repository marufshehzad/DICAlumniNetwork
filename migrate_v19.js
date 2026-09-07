/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v19  (legacy cleanup)

   Drops nine columns and retires one table. Every one of them was verified
   unread first, and the code that wrote each counter was removed in the same
   commit — so this migration cannot break a running system by removing
   something it was still using.

   It also assigns the one department administrator its department: see
   schema_v19.sql, Part A, for why that is the single case where a migration may.

   The check that matters most here is the one that proves nothing was lost.
   Dropping a column is irreversible in the sense that the values are gone, so
   this migration records what each column held BEFORE dropping it, and asserts
   afterwards that the real figure — the COUNT or SUM the product actually
   shows — is unchanged. That is the point: the stored counters were wrong, the
   real figures were always computed, and removing the wrong ones must move
   nothing.

   Usage:  node migrate_v19.js            (apply)
           node migrate_v19.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v19 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v19 ===\n');

    const one = async (sql, p) => (await client.query(sql, p)).rows[0].n;
    const colExists = (t, c) =>
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='${t}' AND column_name='${c}'`;
    const tblExists = (t) =>
      `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}'`;

    /* Row counts for everything the drops touch, plus the REAL figures the
       counters were pretending to be. */
    const before = {
      users:         await one('SELECT COUNT(*)::int n FROM users'),
      events:        await one('SELECT COUNT(*)::int n FROM events'),
      registrations: await one('SELECT COUNT(*)::int n FROM event_registrations'),
      campaigns:     await one('SELECT COUNT(*)::int n FROM campaigns'),
      donations:     await one('SELECT COUNT(*)::int n FROM donations'),
      chapters:      await one('SELECT COUNT(*)::int n FROM chapters'),
      memberships:   await one('SELECT COUNT(*)::int n FROM chapter_memberships'),
      mentorships:   await one('SELECT COUNT(*)::int n FROM mentorships'),
      /* Read from whichever name the table currently carries, so this
         migration can be re-run against a database where it has already been
         applied. §19 asks for idempotency and this is the one statement that
         was not: it referenced event_proposals unconditionally and failed on a
         second run with "relation does not exist". */
      proposals:     await one(`SELECT COUNT(*)::int n FROM ${
        (await client.query(`SELECT COUNT(*)::int n FROM information_schema.tables
                              WHERE table_schema='public' AND table_name='event_proposals'`)).rows[0].n
          ? 'event_proposals' : 'legacy_event_proposals'}`),
      audits:        await one('SELECT COUNT(*)::int n FROM audit_logs'),
      // the real figures
      settled:       await one(`SELECT COALESCE(SUM(amount),0)::int n FROM donations WHERE status='SUCCESS'`),
      confirmedRegs: await one(`SELECT COUNT(*)::int n FROM event_registrations WHERE status='confirmed'`),
      startsOn:      await one('SELECT COUNT(starts_on)::int n FROM events')
    };

    /* What the counters claimed, recorded so the log states plainly what is
       being discarded rather than discarding it quietly. */
    const stillThere = async (t, c) =>
      (await client.query(`SELECT COUNT(*)::int n FROM information_schema.columns
                            WHERE table_name=$1 AND column_name=$2`, [t, c])).rows[0].n > 0;
    const sumIf = async (t, c) => (await stillThere(t, c))
      ? (await client.query(`SELECT COALESCE(SUM(${c}),0)::bigint s FROM ${t}`)).rows[0].s
      : null;
    const claimed = {
      campaign_raised:  await sumIf('campaigns', 'raised_amount'),
      chapter_members:  await sumIf('chapters', 'members_count'),
      chapter_events:   await sumIf('chapters', 'events_count'),
      event_registered: await sumIf('events', 'registered_count')
    };

    const eventFp = `SELECT md5(string_agg(id || '|' || title || '|' || COALESCE(starts_on::text,'') || '|' ||
                        COALESCE(venue,''), E'\\n' ORDER BY id)) AS fp FROM events`;
    const chainFp = `SELECT md5(string_agg(id || '|' || COALESCE(entry_hash,''), E'\\n' ORDER BY id)) AS fp FROM audit_logs`;
    const beforeFp = {
      'every event': (await client.query(eventFp)).rows[0].fp,
      'the audit hash chain': (await client.query(chainFp)).rows[0].fp
    };

    log(`[1/4] Before: ${before.events} events, ${before.campaigns} campaigns, ` +
        `${before.chapters} chapters, ${before.proposals} legacy proposal(s)`);
    if (claimed.campaign_raised === null) {
      /* A re-run against a database this has already been applied to. Saying
         so is better than reporting zeroes, which would read as counters that
         happened to agree with reality. */
      log(`\n[2/4] The counters are already gone — this migration has run before.`);
    } else {
      log(`\n[2/4] What the counters being dropped were claiming:`);
      log(`    campaigns.raised_amount    \u09f3${Number(claimed.campaign_raised).toLocaleString()}` +
          `   real settled: \u09f3${Number(before.settled).toLocaleString()}`);
      log(`    chapters.members_count     ${claimed.chapter_members}` +
          `   real memberships: ${before.memberships}`);
      log(`    chapters.events_count      ${claimed.chapter_events}   (never written by any code)`);
      log(`    events.registered_count    ${claimed.event_registered}` +
          `   real confirmed registrations: ${before.confirmedRegs}`);
    }

    log('\n[3/4] Applying schema_v19.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v19.sql'), 'utf8'));
    log('  schema applied');

    log('\n[4/4] Verifying…');
    const checks = [
      // nothing lost
      ['no user lost',            'SELECT COUNT(*)::int n FROM users', before.users],
      ['no event lost',           'SELECT COUNT(*)::int n FROM events', before.events],
      ['no registration lost',    'SELECT COUNT(*)::int n FROM event_registrations', before.registrations],
      ['no campaign lost',        'SELECT COUNT(*)::int n FROM campaigns', before.campaigns],
      ['no donation lost',        'SELECT COUNT(*)::int n FROM donations', before.donations],
      ['no chapter lost',         'SELECT COUNT(*)::int n FROM chapters', before.chapters],
      ['no membership lost',      'SELECT COUNT(*)::int n FROM chapter_memberships', before.memberships],
      ['no mentorship lost',      'SELECT COUNT(*)::int n FROM mentorships', before.mentorships],
      ['no audit entry touched',  'SELECT COUNT(*)::int n FROM audit_logs', before.audits],

      // the real figures are untouched — that is the whole argument for the drops
      ['settled giving is unchanged',
        `SELECT COALESCE(SUM(amount),0)::int n FROM donations WHERE status='SUCCESS'`, before.settled],
      ['confirmed registrations are unchanged',
        `SELECT COUNT(*)::int n FROM event_registrations WHERE status='confirmed'`, before.confirmedRegs],
      ['every event still has its real date',
        'SELECT COUNT(starts_on)::int n FROM events', before.startsOn],

      // the columns are gone
      ['campaigns.raised_amount is gone',    colExists('campaigns', 'raised_amount'), 0],
      ['campaigns.donors_count is gone',     colExists('campaigns', 'donors_count'), 0],
      ['chapters.members_count is gone',     colExists('chapters', 'members_count'), 0],
      ['chapters.events_count is gone',      colExists('chapters', 'events_count'), 0],
      ['events.registered_count is gone',    colExists('events', 'registered_count'), 0],
      ['events.event_date is gone',          colExists('events', 'event_date'), 0],
      ['events.event_time is gone',          colExists('events', 'event_time'), 0],
      ['events.planning_mode is gone',       colExists('events', 'planning_mode'), 0],
      ['mentorships.health_score is gone',   colExists('mentorships', 'health_score'), 0],

      // and the columns that stay, stay
      ['events.starts_on survives',          colExists('events', 'starts_on'), 1],
      ['events.start_time survives',         colExists('events', 'start_time'), 1],
      ['events.department_id survives',      colExists('events', 'department_id'), 1],
      ['mentorships.match_score survives',   colExists('mentorships', 'match_score'), 1],
      ['event_committees.members_count survives — a different table, still live',
        colExists('event_committees', 'members_count'), 1],

      // the retained table
      ['event_proposals no longer sits in the live schema', tblExists('event_proposals'), 0],
      ['…but its history is retained',                      tblExists('legacy_event_proposals'), 1],
      ['every proposal row survived the rename',
        'SELECT COUNT(*)::int n FROM legacy_event_proposals', before.proposals],

      // the department administrator
      /* Expressed as "none is left unassigned" rather than "exactly one is
         assigned", because a fresh install has no users at all and the seeded
         administrator this refers to does not exist there yet. */
      ['no dept_admin matching the seeded account is left unassigned',
        `SELECT COUNT(*)::int n FROM users
          WHERE role = 'dept_admin' AND department = 'CSE Department' AND department_id IS NULL`, 0],
      ['no other staff account was assigned a department',
        `SELECT COUNT(*)::int n FROM users
          WHERE role NOT IN ('alumni','dept_admin') AND department_id IS NOT NULL`, 0]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(62)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    const afterFp = {
      'every event': (await client.query(eventFp)).rows[0].fp,
      'the audit hash chain': (await client.query(chainFp)).rows[0].fp
    };
    for (const k of Object.keys(beforeFp)) {
      const same = beforeFp[k] === afterFp[k];
      if (!same) bad++;
      log(`  ${same ? 'ok  ' : 'FAIL'} ${(k + ' unchanged, byte for byte').padEnd(62)} ` +
          `${same ? 'identical' : 'CHANGED'}`);
    }

    if (bad) { failed = true; throw new Error(`${bad} verification check(s) failed`); }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN complete — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v19 complete ===\n');
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
