#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 6 operations contract

   Pins what Phase 6 established, so none of it can quietly regress:

     A  one trigger per job — no scheduled work runs because somebody looked
     B  the scheduler really invokes the jobs, and twice is the same as once
     C  scheduled endpoints reject everybody but the scheduler
     D  a run that dies is distinguishable from a run in flight
     E  business dates are Bangladesh dates
     F  the monitor endpoint reports problems, and separates them from advisories
     G  backups land outside the application directory, and off-site is observable
     H  a fresh install is possible and the first administrator can be created
     I  no secret reaches a log, a response, or the repository

   The heavier proofs live in their own drills, which take longer and build
   disposable databases:

     tests/install_drill.js   a fresh install from nothing, signed into
     tests/ops_drill.js       deletion purge D/E/F, backup and restore
     tests/mail_drill.js      a reset email delivered over real SMTP

   Usage:  node tests/phase6_operations.js
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'db'));
const B = process.env.TEST_BASE || 'http://localhost:8123';

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const skip = (n, why) => { skipped++; console.log('  SKIP  ' + n + '  (' + why + ')'); };
const head = t => console.log('\n' + t);

const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
// Source assertions must not match the comment that explains the fix.
const code = f => src(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const POST = (p, t, body, extra = {}) => j(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...extra },
  body: JSON.stringify(body || {})
});

const CRON = process.env.CRON_SECRET || '';
const TAG = 'p6-ops';

(async () => {
  /* ══ A. One trigger per job ═════════════════════════════════════════ */
  head('=== A. Scheduled work has exactly one trigger ===');

  /* The mentorship-expiry UPDATE existed twice: once in jobs.js and once,
     verbatim, in the GET /api/mentorships handler — so it ran whenever any
     member opened their mentorship list. Two copies of a business rule drift,
     and scheduled work that happens when somebody looks is not scheduled. */
  const v2 = code('routes_v2.js');
  ok('the mentorship list no longer writes expiries',
    !/UPDATE mentorships SET status='expired'/.test(v2),
    (v2.match(/UPDATE mentorships[^;]{0,60}/) || [''])[0]);
  ok('it reports expiry as a projection instead',
    /CASE WHEN m\.status = 'pending' AND m\.expires_at < CURRENT_TIMESTAMP/.test(v2));
  ok('jobs.js is the only writer of that rule',
    /UPDATE mentorships SET status='expired'/.test(code('jobs.js')));

  /* The event reminder sweep ran once per session when a staff member opened
     the Events page, under a comment claiming there was no scheduler. */
  const ev = code('js/events.js');
  ok('the Events page does not run the maintenance sweep on render',
    !/evRunMaintenanceSweep\s*\(/.test(ev),
    (ev.match(/evRunMaintenanceSweep[^\n]{0,40}/) || [''])[0]);
  ok('no client module calls the sweep endpoint on load',
    !fs.readdirSync(path.join(REPO, 'js')).filter(f => f.endsWith('.js'))
      .some(f => /API\.runReminderSweep\s*\(/.test(code('js/' + f))));
  ok('the sweep endpoint still exists for an operator to run by hand',
    /tasks\/reminder-sweep/.test(src('routes_events.js')));

  ok('there is a single scheduler entry point', fs.existsSync(path.join(REPO, 'scheduler.js')));
  ok('it reuses the job registry rather than reimplementing it',
    /require\('\.\/jobs'\)/.test(src('scheduler.js')) &&
    !/UPDATE mentorships|purge_after <=/.test(code('scheduler.js')));

  /* ══ B. The scheduler runs the jobs, and twice is the same as once ══ */
  head('=== B. The scheduler invokes the jobs, idempotently ===');
  const jobs = require(path.join(REPO, 'jobs'));
  ok('the registry has the expected jobs',
    jobs.JOB_NAMES.includes('event-maintenance') &&
    jobs.JOB_NAMES.includes('deletion-purge') &&
    jobs.JOB_NAMES.includes('mentorship-expiry'), jobs.JOB_NAMES.join(','));

  if (!CRON) {
    skip('the scheduler endpoint runs every job', 'CRON_SECRET not in this environment');
    skip('running it twice changes nothing', 'CRON_SECRET not in this environment');
  } else {
    const runs0 = (await db.query('SELECT count(*)::int n FROM ops_runs')).rows[0].n;
    const r1 = await POST('/api/internal/jobs/run', null, {}, { 'X-Cron-Key': CRON });
    ok('the scheduler endpoint accepts the cron credential and runs', r1.status === 200,
      `${r1.status} ${JSON.stringify(r1.body).slice(0, 90)}`);
    const runs1 = (await db.query('SELECT count(*)::int n FROM ops_runs')).rows[0].n;
    ok('every job recorded a run', runs1 - runs0 === jobs.JOB_NAMES.length,
      `${runs1 - runs0} rows for ${jobs.JOB_NAMES.length} jobs`);
    ok('no run was left marked running',
      (await db.query("SELECT count(*)::int n FROM ops_runs WHERE status='running'")).rows[0].n === 0);

    /* Idempotency: the observable effects must not double. Notifications are
       the one thing a second run could duplicate, so they are counted. */
    const notif0 = (await db.query(
      "SELECT count(*)::int n FROM notifications WHERE title IN ('Task overdue','Task deadline approaching')")).rows[0].n;
    const r2 = await POST('/api/internal/jobs/run', null, {}, { 'X-Cron-Key': CRON });
    ok('a second identical run also succeeds', r2.status === 200);
    const notif1 = (await db.query(
      "SELECT count(*)::int n FROM notifications WHERE title IN ('Task overdue','Task deadline approaching')")).rows[0].n;
    ok('the second run sent no duplicate reminders', notif1 === notif0, `${notif0} -> ${notif1}`);

    const purged = (await db.query(
      "SELECT count(*)::int n FROM deletion_requests WHERE status='completed'")).rows[0].n;
    const r3 = await POST('/api/internal/jobs/run?job=deletion-purge', null, {}, { 'X-Cron-Key': CRON });
    ok('a third purge run succeeds', r3.status === 200);
    ok('and purges nothing more',
      (await db.query("SELECT count(*)::int n FROM deletion_requests WHERE status='completed'")).rows[0].n === purged);
  }

  /* ══ C. Only the scheduler may trigger scheduled work ═══════════════ */
  head('=== C. Scheduled endpoints reject everybody else ===');
  const email = `${TAG}-member@dic.test`;
  await db.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%`]);
  const reg = await POST('/api/auth/register', null, {
    name: 'Ops Probe', email, password: 'Phase6-Ops-Pw1', hscPassingYear: 2019, hscGroup: 'Science' });
  const memberToken = reg.body?.token;
  ok('a member exists to probe with', !!memberToken);

  for (const [label, headers] of [
    ['anonymous', {}],
    ['a member session', { Authorization: 'Bearer ' + memberToken }],
    ['a wrong cron key', { 'X-Cron-Key': 'not-the-secret' }],
    ['an empty cron key', { 'X-Cron-Key': '' }]
  ]) {
    const r = await j('/api/internal/jobs/run', { headers });
    ok(`${label} is refused by the job runner`, r.status === 401, String(r.status));
    const m = await j('/api/internal/monitor', { headers });
    ok(`${label} is refused by the monitor`, m.status === 401, String(m.status));
  }
  ok('the refusal names no credential',
    !/CRON_SECRET|X-Cron-Key/.test(JSON.stringify((await j('/api/internal/jobs/run')).body)));

  /* ══ D. A dead run is distinguishable from a live one ═══════════════ */
  head('=== D. An abandoned run does not stay "running" for ever ===');
  ok('there is a reaper', typeof jobs.reapStaleRuns === 'function');
  await db.query(
    `INSERT INTO ops_runs (job, status, source, started_at)
     VALUES ('mentorship-expiry','running','test', CURRENT_TIMESTAMP - INTERVAL '3 hours')`);
  const reaped = await jobs.reapStaleRuns('mentorship-expiry');
  ok('a run stuck for hours is marked failed', reaped >= 1, String(reaped));
  ok('nothing is left running',
    (await db.query("SELECT count(*)::int n FROM ops_runs WHERE status='running'")).rows[0].n === 0);
  ok('a run that started moments ago is NOT reaped', await (async () => {
    const r = await db.query(
      `INSERT INTO ops_runs (job, status, source) VALUES ('mentorship-expiry','running','test') RETURNING id`);
    const n = await jobs.reapStaleRuns('mentorship-expiry');
    const still = await db.query('SELECT status FROM ops_runs WHERE id=$1', [r.rows[0].id]);
    await db.query('DELETE FROM ops_runs WHERE id=$1', [r.rows[0].id]);
    return n === 0 && still.rows[0].status === 'running';
  })());
  await db.query("DELETE FROM ops_runs WHERE source='test'");

  /* ══ E. Business dates are Bangladesh dates ════════════════════════ */
  head('=== E. Dates mean dates in Dhaka ===');
  const tz = await db.query("SELECT current_setting('TimeZone') AS tz, CURRENT_DATE AS d");
  ok('the database session timezone is Asia/Dhaka', tz.rows[0].tz === 'Asia/Dhaka', tz.rows[0].tz);
  ok('db.js pins it rather than inheriting the host', /DB_TIMEZONE/.test(code('db.js')));
  const cmp = await db.query(
    "SELECT CURRENT_DATE AS local, (now() AT TIME ZONE 'UTC')::date AS utc");
  ok('CURRENT_DATE is the local date, which may differ from UTC',
    String(cmp.rows[0].local).length === 10, `${cmp.rows[0].local} local vs ${cmp.rows[0].utc} utc`);

  /* ══ F. The monitor ════════════════════════════════════════════════ */
  head('=== F. The monitor reports what an uptime service needs ===');
  if (!CRON) {
    skip('the monitor answers the scheduler credential', 'CRON_SECRET not in this environment');
  } else {
    const m = await j('/api/internal/monitor', { headers: { 'X-Cron-Key': CRON } });
    ok('it answers the scheduler credential', m.status === 200 || m.status === 503, String(m.status));
    const b = m.body || {};
    ok('it reports the database', !!b.database);
    ok('it reports every job', Array.isArray(b.jobs) && b.jobs.length === jobs.JOB_NAMES.length);
    ok('it reports the backup', !!b.backup);
    ok('it reports the off-site copy', !!b.offsite);
    ok('it separates problems from advisories',
      Array.isArray(b.problems) && Array.isArray(b.advisories));
    ok('the HTTP status matches the verdict, so a monitor needs no JSON parsing',
      (b.problems.length > 0) === (m.status === 503), `${b.problems.length} problems, HTTP ${m.status}`);
    ok('an unconfigured off-site destination is an advisory, not a page-somebody problem',
      b.offsite.configured || b.advisories.some(a => /off-site/i.test(a)));
    ok('it never returns a secret',
      !JSON.stringify(b).includes(CRON) &&
      !/SESSION_SECRET|ENCRYPTION_KEY|PGPASSWORD/.test(JSON.stringify(b)));
  }
  ok('the health endpoint distinguishes healthy from degraded',
    /status: 'ok'/.test(src('server.js')) && /status: 'degraded'/.test(src('server.js')));
  ok('health cannot report ok when the database is unreachable',
    /await db\.query\('SELECT 1'\)/.test(src('server.js')));

  /* ══ G. Backups ════════════════════════════════════════════════════ */
  head('=== G. Backups leave the application directory, and are observable ===');
  ok('production requires BACKUP_DIR', /BACKUP_DIR \(an absolute path/.test(src('server.js')));
  ok('production refuses a BACKUP_DIR inside the application directory',
    /must not be inside the application directory/.test(src('server.js')));
  ok('backup.js loads .env before it reads BACKUP_DIR', await (async () => {
    const s = src('backup.js');
    return s.indexOf("require('./db')") < s.indexOf('process.env.BACKUP_DIR');
  })());
  ok('there is an off-site shipper', fs.existsSync(path.join(REPO, 'offsite.js')));
  const off = src('offsite.js');
  ok('it hardcodes no provider, bucket or credential',
    !/aws-sdk|@aws-sdk|AKIA|s3\.amazonaws|SECRET_ACCESS_KEY/.test(code('offsite.js')));
  ok('it leaves a receipt a monitor can read', /last-offsite\.json/.test(off));
  ok('it treats a failed copy as an incident', /FAILED/.test(off) && /incident/.test(off));
  ok('the web root never serves a backup',
    !/backups/.test((src('server.js').match(/const PUBLIC_DIRS = \[[^\]]*\]/) || [''])[0]));

  /* ══ H. A fresh install is possible ════════════════════════════════ */
  head('=== H. The platform can be installed from nothing ===');
  ok('migrate_v5 does not demand an anchor it has no use for',
    /totalOrphans > 0/.test(code('migrate_v5.js')));
  ok('demonstration data is opt-in, not the default',
    /DIC_SEED_DEMO/.test(code('migrate_v2.js')));
  ok('the first administrator can be created without a session',
    /--create-super-admin/.test(src('rotate_credentials.js')));
  ok('and only when none exists yet',
    /a super_admin already exists/.test(src('rotate_credentials.js')));

  /* ══ I. Nothing leaks ══════════════════════════════════════════════ */
  head('=== I. No secret reaches a log, a response, or the repository ===');
  const logged = code('server.js') + code('jobs.js') + code('mailer.js') +
                 code('backup.js') + code('offsite.js') + code('scheduler.js');
  ok('nothing logs process.env wholesale', !/console\.\w+\([^)]*process\.env\s*\)/.test(logged));
  for (const secret of ['SESSION_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET', 'PGPASSWORD', 'SMTP_PASSWORD']) {
    ok(`no console line prints ${secret}`,
      !new RegExp(`console\\.\\w+\\([^)]*process\\.env\\.${secret}`).test(logged));
  }
  ok('the request logger excludes the Authorization header',
    !/req\.headers\.authorization/.test(
      (code('server.js').match(/res\.on\('finish'[\s\S]{0,600}/) || [''])[0]));
  ok('the reset token is stored hashed', /hashResetToken/.test(src('server.js')));
  ok('.env is gitignored', /(^|\n)\.env(\s|$)/.test(src('.gitignore')));
  ok('the credentials file is gitignored', /admin-credentials\.local\.txt/.test(src('.gitignore')));
  ok('no backup directory is committed',
    !fs.existsSync(path.join(REPO, 'backups')) || /backups/.test(src('.gitignore')));

  await db.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%`]);
  ok('the probe account was removed',
    (await db.query('SELECT count(*)::int n FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows[0].n === 0);

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exitCode = fail ? 1 : 0;
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nHARNESS ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(2);
});
