/* ============================================================
   DIC ALUMNI PLATFORM — MIGRATION v15  (job and poll lifecycle)

   Adds the state both modules were operating without: jobs can be closed and
   carry a deadline, polls have draft/open/closed instead of a boolean, and
   applications and referrals have a constrained vocabulary.

   Two columns are removed, both because they cannot be trusted:
     jobs.days_ago   fabricated relative dates (2, 4, 1) on rows created the
                     same day; never read by anything.
     polls.is_active a second answer to "is this poll live", replaced by
                     status. Its value is carried across first.

   No status vocabulary is changed: job_applications and job_referrals already
   carry CHECK constraints covering the states the workflow needs.

   Usage:  node migrate_v15.js            (apply)
           node migrate_v15.js --dry-run  (apply, verify, then roll back)
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
    log(DRY_RUN ? '\n=== MIGRATION v15 (DRY RUN — will roll back) ===\n'
                : '\n=== MIGRATION v15 ===\n');

    const one = async (sql) => (await client.query(sql)).rows[0].n;

    const before = {
      jobs: await one('SELECT COUNT(*)::int n FROM jobs'),
      applications: await one('SELECT COUNT(*)::int n FROM job_applications'),
      referrals: await one('SELECT COUNT(*)::int n FROM job_referrals'),
      polls: await one('SELECT COUNT(*)::int n FROM polls'),
      votes: await one('SELECT COUNT(*)::int n FROM poll_votes'),
      audits: await one('SELECT COUNT(*)::int n FROM audit_logs'),
      activePolls: await one('SELECT COUNT(*)::int n FROM polls WHERE is_active')
    };

    /* What must survive untouched: the substance of every job, application,
       referral and poll. Status columns are expected to change; nothing else
       may. */
    const jobFp = `SELECT md5(string_agg(id || '|' || COALESCE(title,'') || '|' || COALESCE(company,'') || '|' ||
                       COALESCE(location,'') || '|' || COALESCE(salary,'') || '|' || COALESCE(work_mode,''),
                       E'\\n' ORDER BY id)) AS fp FROM jobs`;
    const pollFp = `SELECT md5(string_agg(id || '|' || question || '|' || array_to_string(options, ','),
                        E'\\n' ORDER BY id)) AS fp FROM polls`;
    const appFp = `SELECT md5(string_agg(id || '|' || job_id || '|' || applicant_id || '|' ||
                       COALESCE(cover_note,''), E'\\n' ORDER BY id)) AS fp FROM job_applications`;
    const beforeFp = {
      job: (await client.query(jobFp)).rows[0].fp,
      poll: (await client.query(pollFp)).rows[0].fp,
      app: (await client.query(appFp)).rows[0].fp
    };

    log(`[1/3] Before: ${before.jobs} jobs, ${before.applications} applications, ` +
        `${before.referrals} referrals, ${before.polls} polls (${before.activePolls} active), ${before.votes} votes`);

    log('\n[2/3] Applying schema_v15.sql…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema_v15.sql'), 'utf8'));
    log('  schema applied');

    log('\n[3/3] Verifying…');
    const col = (t, c) =>
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='${t}' AND column_name='${c}'`;
    const con = (name) => `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='${name}'`;

    const checks = [
      ['no job lost',         'SELECT COUNT(*)::int n FROM jobs', before.jobs],
      ['no application lost', 'SELECT COUNT(*)::int n FROM job_applications', before.applications],
      ['no referral lost',    'SELECT COUNT(*)::int n FROM job_referrals', before.referrals],
      ['no poll lost',        'SELECT COUNT(*)::int n FROM polls', before.polls],
      ['no vote lost',        'SELECT COUNT(*)::int n FROM poll_votes', before.votes],
      ['no audit entry touched', 'SELECT COUNT(*)::int n FROM audit_logs', before.audits],

      ['jobs.description exists', col('jobs', 'description'), 1],
      ['jobs.deadline exists',    col('jobs', 'deadline'), 1],
      ['jobs.status exists',      col('jobs', 'status'), 1],
      ['jobs.closed_at exists',   col('jobs', 'closed_at'), 1],
      ['job_applications.status_changed_by exists', col('job_applications', 'status_changed_by'), 1],
      ['job_referrals.responded_at exists', col('job_referrals', 'responded_at'), 1],
      ['polls.status exists',     col('polls', 'status'), 1],
      ['polls.created_by exists', col('polls', 'created_by'), 1],

      ['the fabricated days_ago column is gone', col('jobs', 'days_ago'), 0],
      ['the duplicate is_active flag is gone',   col('polls', 'is_active'), 0],

      ['every job is open — none was closed by this migration',
        `SELECT COUNT(*)::int n FROM jobs WHERE status <> 'open'`, 0],
      ['no job was given an invented deadline',
        'SELECT COUNT(*)::int n FROM jobs WHERE deadline IS NOT NULL', 0],
      ['no job was given an invented description',
        'SELECT COUNT(*)::int n FROM jobs WHERE description IS NOT NULL', 0],
      ['the previously active poll is open, not a draft',
        `SELECT COUNT(*)::int n FROM polls WHERE status = 'open'`, before.activePolls],
      ['no poll became a draft retroactively',
        `SELECT COUNT(*)::int n FROM polls WHERE status = 'draft'`, 0],
      ['no application status was rewritten',
        `SELECT COUNT(*)::int n FROM job_applications WHERE status = 'submitted'`, before.applications],

      ['job status is constrained',         con('jobs_status_valid'), 1],
      ['the existing application vocabulary is untouched', con('job_applications_status_check'), 1],
      ['the existing referral vocabulary is untouched',    con('job_referrals_status_check'), 1],
      ['poll status is constrained',        con('polls_status_valid'), 1],

      ['the job status index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='jobs' AND indexname='idx_jobs_status'`, 1],
      ['the poll status index exists',
        `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='polls' AND indexname='idx_polls_status'`, 1]
    ];

    let bad = 0;
    for (const [label, sql, expected] of checks) {
      const got = (await client.query(sql)).rows[0].n;
      const okRow = got === expected;
      if (!okRow) bad++;
      log(`  ${okRow ? 'ok  ' : 'FAIL'} ${label.padEnd(62)} ${got}${okRow ? '' : ' (expected ' + expected + ')'}`);
    }

    const afterFp = {
      job: (await client.query(jobFp)).rows[0].fp,
      poll: (await client.query(pollFp)).rows[0].fp,
      app: (await client.query(appFp)).rows[0].fp
    };
    for (const k of Object.keys(beforeFp)) {
      const same = beforeFp[k] === afterFp[k];
      if (!same) bad++;
      log(`  ${same ? 'ok  ' : 'FAIL'} ${(k + ' substance unchanged, byte for byte').padEnd(62)} ${same ? 'identical' : 'CHANGED'}`);
    }

    if (bad) { failed = true; throw new Error(`${bad} verification check(s) failed`); }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log('\n=== DRY RUN complete — every change rolled back ===\n');
    } else {
      await client.query('COMMIT');
      log('\n=== MIGRATION v15 complete ===\n');
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
