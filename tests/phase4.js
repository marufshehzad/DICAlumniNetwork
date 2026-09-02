/* PHASE 4 — OPERATIONS RING verification.
   Scheduler authorization and idempotency, deletion purge, backup/restore,
   SMTP recovery, health, logging safety, backup security, boot enforcement. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const db = require(path.join(REPO, 'db'));
const jobs = require(path.join(REPO, 'jobs'));
const B = 'http://localhost:8123';

const creds = {};
for (const l of fs.readFileSync(REPO + '/admin-credentials.local.txt', 'utf8').split('\n')) {
  const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
  if (m) creds[m[2]] = m[3];
}
const CRON = (fs.readFileSync(REPO + '/.env', 'utf8').match(/^CRON_SECRET=(.+)$/m) || [])[1] || '';

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

/* Sections F-H spend ~30 seconds taking a backup and running a restore drill
   without touching HTTP. Node's fetch keeps the connection pooled while the
   server's keep-alive timeout closes it, so the next request writes to a dead
   socket and gets ECONNRESET. One retry on a connection-level error; a real
   HTTP failure still surfaces normally. */
const j = async (p, o = {}) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(B + p, o);
      let b = null; try { b = await r.json(); } catch {}
      return { status: r.status, body: b, headers: r.headers };
    } catch (e) {
      const reset = /ECONNRESET|socket hang up|other side closed/i.test(
        String(e.cause?.code || e.cause?.message || e.message));
      if (!reset || attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 250));
    }
  }
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const POST = (p, t, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(body || {}) });
const login = (e, p) => POST('/api/auth/login', null, { email: e, password: p });
/* Line endings are normalised. A Windows checkout stores these files with
   CRLF, so an assertion that matches source containing \n would fail on a
   fresh clone while passing on the machine the test was written on. */
const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const S = {};
  for (const [email, role] of [['admin@dic.edu.bd', 'super'], ['collegeadmin@dic.edu.bd', 'univ'],
                               ['departmentadmin@dic.edu.bd', 'dept'], ['moderator@dic.edu.bd', 'mod'],
                               ['alumni@dic.edu.bd', 'alum']]) {
    S[role] = (await login(email, creds[email])).body?.token;
  }

  console.log('\n=== A. scheduler authorization ===');
  const JOB = '/api/internal/jobs/run?job=mentorship-expiry';
  ok('unauthenticated is refused', (await POST(JOB, null)).status === 401);
  ok('a wrong secret is refused',
    (await j(JOB, { method: 'POST', headers: { 'X-Cron-Key': 'wrong-value-entirely' } })).status === 401);
  ok('an empty secret is refused',
    (await j(JOB, { method: 'POST', headers: { 'X-Cron-Key': '' } })).status === 401);
  for (const r of ['alum', 'mod', 'dept', 'univ']) {
    ok(`${r} cannot trigger a job`, (await POST(JOB, S[r])).status === 401, r);
  }
  ok('the scheduler secret works',
    (await j(JOB, { method: 'POST', headers: { 'X-Cron-Key': CRON } })).status === 200);
  ok('a bearer secret works (the shape Vercel Cron sends)',
    (await j(JOB, { method: 'GET', headers: { Authorization: 'Bearer ' + CRON } })).status === 200);
  ok('a super admin may run a job by hand', (await POST(JOB, S.super)).status === 200);
  ok('the refusal reveals nothing about the job',
    !/mentorship|job|exist/i.test((await POST(JOB, null)).body?.error || ''),
    (await POST(JOB, null)).body?.error);
  ok('the secret is nowhere in frontend code',
    !['index.html', 'admin.html', 'api.js'].concat(fs.readdirSync(REPO + '/js').map(f => 'js/' + f))
      .some(f => src(f).includes(CRON)));
  // The variable NAME appears in operator help text on the Operations panel,
  // which is correct; what must never reach a browser is its value or a read of it.
  ok('no frontend file reads the scheduler secret',
    !/process.env.CRON_SECRET/.test(src('api.js')) &&
    !fs.readdirSync(REPO + '/js').some(f => /process.env.CRON_SECRET/.test(src('js/' + f))));

  console.log('\n=== B. scheduler idempotency and the run log ===');
  const before = (await db.query("SELECT COUNT(*)::int n FROM ops_runs")).rows[0].n;
  const r1 = await j(JOB, { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  const r2 = await j(JOB, { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  ok('running twice is safe', r1.status === 200 && r2.status === 200);
  ok('both runs are recorded',
    (await db.query("SELECT COUNT(*)::int n FROM ops_runs")).rows[0].n >= before + 2);
  ok('a run records its outcome',
    (await db.query("SELECT status FROM ops_runs ORDER BY id DESC LIMIT 1")).rows[0].status === 'ok');
  ok('a run records where it came from',
    (await db.query("SELECT source FROM ops_runs ORDER BY id DESC LIMIT 1")).rows[0].source === 'cron');
  ok('an unknown job is rejected',
    (await j('/api/internal/jobs/run?job=does-not-exist',
      { method: 'POST', headers: { 'X-Cron-Key': CRON } })).status === 400);
  const all = await j('/api/internal/jobs/run', { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  ok('running every job at once works', all.status === 200 && all.body.ran === 3, JSON.stringify(all.body).slice(0, 90));
  ok('no job failed in the combined run', all.body.failed === 0, String(all.body.failed));

  console.log('\n=== C. the maintenance sweep is not duplicated ===');
  ok('the sweep exists once, as a named function',
    (src('routes_events.js').match(/async function runReminderSweep/g) || []).length === 1);
  ok('the HTTP endpoint delegates to it rather than repeating it',
    /reminder-sweep'[\s\S]{0,160}await runReminderSweep\(\)/.test(src('routes_events.js')));
  ok('the scheduler calls the same function',
    /runReminderSweep/.test(src('jobs.js')) && /runReminderSweep/.test(src('server.js')));
  ok('the roll-forward lives in exactly one function',
    (src('routes_events.js').match(/UPDATE events SET status = CASE/g) || []).length === 1);
  ok('no other module contains the roll-forward',
    !['server.js','routes_v2.js','routes_planner.js','jobs.js']
      .some(f => /UPDATE events SET status = CASE/.test(src(f))));

  console.log('\n=== D. deletion purge ===');
  const EMAIL = 'phase4-suite-subject@dic.test';
  await db.query('DELETE FROM users WHERE email=$1', [EMAIL]);
  const u = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role, role_label, initials, department, is_verified)
     VALUES ('Phase4 Suite Subject',$1,'scrypt$x$y','alumni','Alumni','PS','CSE',true) RETURNING id`, [EMAIL]);
  const uid = u.rows[0].id;
  await db.query(
    `INSERT INTO alumni_profiles (user_id,batch,passing_year,department,primary_email)
     VALUES ($1,2019,2019,'CSE',$2)`, [uid, EMAIL]);

  // not yet due
  const rq = await db.query(
    `INSERT INTO deletion_requests (user_id, purge_after) VALUES ($1, NOW() + INTERVAL '30 days') RETURNING id`, [uid]);
  await j(JOB.replace('mentorship-expiry', 'deletion-purge'), { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  ok('an account inside its grace period is untouched',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE id=$1', [uid])).rows[0].n === 1);

  // cancelled and overdue
  await db.query("UPDATE deletion_requests SET status='cancelled', purge_after=NOW()-INTERVAL '1 day' WHERE id=$1", [rq.rows[0].id]);
  await j(JOB.replace('mentorship-expiry', 'deletion-purge'), { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  ok('a cancelled request is never acted on',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE id=$1', [uid])).rows[0].n === 1);

  // due
  const rq2 = await db.query(
    `INSERT INTO deletion_requests (user_id, purge_after) VALUES ($1, NOW() - INTERVAL '1 second') RETURNING id`, [uid]);
  const purgeRes = await j(JOB.replace('mentorship-expiry', 'deletion-purge'),
    { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  ok('a due request is purged', purgeRes.status === 200 && purgeRes.body.items >= 1, JSON.stringify(purgeRes.body).slice(0, 110));
  ok('the account is gone',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE id=$1', [uid])).rows[0].n === 0);
  ok('the profile went with it',
    (await db.query('SELECT COUNT(*)::int n FROM alumni_profiles WHERE user_id=$1', [uid])).rows[0].n === 0);
  const ev = await db.query('SELECT status, purged_at, user_id FROM deletion_requests WHERE id=$1', [rq2.rows[0].id]);
  ok('the compliance record survives the account', ev.rows.length === 1);
  ok('it is marked completed', ev.rows[0]?.status === 'completed');
  ok('it is detached rather than cascaded away', ev.rows[0]?.user_id === null);
  ok('the purge is in the audit trail',
    (await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='Account Purged' AND target_id=$1", [uid])).rows[0].n >= 1);
  const again = await j(JOB.replace('mentorship-expiry', 'deletion-purge'), { method: 'POST', headers: { 'X-Cron-Key': CRON } });
  ok('a second purge run finds nothing to do', again.body.items === 0, JSON.stringify(again.body).slice(0, 90));
  await db.query('DELETE FROM deletion_requests WHERE id IN ($1,$2)', [rq.rows[0].id, rq2.rows[0].id]);

  console.log('\n=== E. the purge refuses to erase the platform ===');
  const sa = (await db.query("SELECT id FROM users WHERE role='super_admin' LIMIT 1")).rows[0].id;
  const saReq = await db.query(
    `INSERT INTO deletion_requests (user_id, purge_after) VALUES ($1, NOW()-INTERVAL '1 day') RETURNING id`, [sa]);
  const saRun = await jobs.purgeDueDeletions({});
  ok('a super admin is never purged by the timer',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE id=$1', [sa])).rows[0].n === 1);
  ok('and the run says why', /super_admin/.test(saRun.detail), saRun.detail);
  await db.query('DELETE FROM deletion_requests WHERE id=$1', [saReq.rows[0].id]);

  console.log('\n=== F. backup ===');
  const BDIR = path.join(REPO, 'backups');
  const env = { ...process.env, DOCKER_PG_CONTAINER: 'dic-alumni-pg' };
  let backupOk = true;
  try {
    execFileSync(process.execPath, [path.join(REPO, 'backup.js')], { cwd: REPO, env, stdio: 'pipe', timeout: 180000 });
  } catch { backupOk = false; }
  ok('a backup runs to completion', backupOk);
  const files = fs.existsSync(BDIR) ? fs.readdirSync(BDIR).filter(f => f.endsWith('.sql')) : [];
  ok('it produced a dump file', files.length >= 1, String(files.length));
  const receiptPath = path.join(BDIR, 'last-backup.json');
  ok('it left a receipt', fs.existsSync(receiptPath));
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : {};
  ok('the receipt records success', receipt.status === 'ok', receipt.status);
  ok('the dump is a real dump, not an empty file', (receipt.sizeBytes || 0) > 10000, String(receipt.sizeBytes));
  const newest = files.sort().slice(-1)[0];
  const dump = fs.readFileSync(path.join(BDIR, newest), 'utf8');
  ok('the dump contains the schema', /CREATE TABLE public\.users/.test(dump));
  ok('the dump contains data', /COPY public\.users/.test(dump));
  ok('the dump contains the migration-era tables', /CREATE TABLE public\.ops_runs/.test(dump));
  ok('the dump ends with the completion marker', /PostgreSQL database dump complete/.test(dump.slice(-2000)));

  console.log('\n=== G. backup security ===');
  for (const p of ['/backups/' + newest, '/backups/last-backup.json', '/backups/']) {
    ok(`${p} is not served`, (await j(p)).status === 404 || (await fetch(B + p)).status === 404);
  }
  ok('the backup directory is gitignored',
    /^backups\/$/m.test(fs.readFileSync(REPO + '/.gitignore', 'utf8')));
  const tracked = spawnSync('git', ['ls-files', 'backups'], { cwd: REPO, encoding: 'utf8' });
  ok('no backup is tracked by git', !String(tracked.stdout || '').trim());
  ok('the web root allow-list does not include backups',
    !/backups/.test(src('server.js').match(/const PUBLIC_DIRS = \[[^\]]*\]/)?.[0] || ''));

  console.log('\n=== H. restore drill ===');
  let drillOk = true;
  let drillOut = '';
  try {
    drillOut = execFileSync(process.execPath, [path.join(REPO, 'restore.js'), '--drill'],
      { cwd: REPO, env, encoding: 'utf8', timeout: 300000 });
  } catch (e) { drillOk = false; drillOut = String(e.stdout || '') + String(e.stderr || ''); }
  ok('the restore drill passes', drillOk && /PASSED/.test(drillOut),
    drillOut.split('\n').filter(l => /FAIL/.test(l)).join(' | ').slice(0, 140));
  for (const t of ['users', 'events', 'event_registrations', 'donations', 'audit_logs', 'identity_vault']) {
    ok(`${t} restored`, new RegExp('ok\\s+' + t + '\\s').test(drillOut));
  }
  ok('the vault keeps its encrypted columns after restore', /identity_vault\s+encrypted columns present/.test(drillOut));
  ok('the audit hash chain survives restore', /audit_logs\s+hash chain intact/.test(drillOut));
  ok('the disposable database is dropped', /disposable database dropped/.test(drillOut));
  ok('the drill never touches the live database', !/DROP DATABASE .*dic_alumni_db\b/.test(src('restore.js')));
  ok('there is no restore-over-production path',
    /refusing to restore over the live database/i.test(src('restore.js')));
  ok('the drill result is recorded', fs.existsSync(path.join(BDIR, 'last-drill.json')));

  console.log('\n=== I. password reset by email ===');
  const ack1 = await POST('/api/auth/forgot-password', null, { email: 'admin@dic.edu.bd' });
  const ack2 = await POST('/api/auth/forgot-password', null, { email: 'nobody-here@dic.edu.bd' });
  ok('a real address is acknowledged', ack1.status === 200);
  ok('an unknown address gets the identical answer',
    ack1.status === ack2.status && JSON.stringify(ack1.body) === JSON.stringify(ack2.body));
  ok('no token is returned over HTTP', !/token/i.test(JSON.stringify(ack1.body)));
  const stored = await db.query(
    "SELECT reset_token_hash, reset_expires_at FROM users WHERE email='admin@dic.edu.bd'");
  ok('only a hash of the token is stored', /^[0-9a-f]{64}$/.test(stored.rows[0].reset_token_hash || ''));
  const mins = (new Date(stored.rows[0].reset_expires_at) - Date.now()) / 60000;
  ok('it expires in about 30 minutes', mins > 25 && mins <= 31, mins.toFixed(1));
  ok('the request is audited',
    (await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='Password Reset Requested'")).rows[0].n >= 1);
  ok('no audit entry contains a reset token',
    (await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE meta ~ '[A-Za-z0-9_-]{40,}'")).rows[0].n === 0);
  ok('the mailer never logs the token alongside the address',
    !/console\.log\([^)]*token/i.test(src('mailer.js')));
  ok('the mailer masks addresses in its logs', /maskEmail/.test(src('mailer.js')));
  {
    const fp = src('server.js');
    const i = fp.indexOf("app.post('/api/auth/forgot-password'");
    const handler = fp.slice(i, i + 2600);
    ok('the reset link is built from PUBLIC_ORIGIN, not the Host header alone',
      /process\.env\.PUBLIC_ORIGIN/.test(handler) && /\?reset=/.test(handler));
  }
  ok('the operator CLI still exists as the emergency fallback', fs.existsSync(REPO + '/reset_link.js'));

  console.log('\n=== J. health endpoint ===');
  const h = await j('/api/health');
  ok('health answers 200 when the database is reachable', h.status === 200, String(h.status));
  ok('it reports database state', h.body?.database === 'ok');
  const hs = JSON.stringify(h.body);
  for (const leak of [/PostgreSQL \d/, /is_cloud/, /total_users/, /password/i, /secret/i,
                      /localhost/i, /5433/, /at .*\.js:\d/]) {
    ok(`health leaks nothing matching ${leak}`, !leak.test(hs), hs.slice(0, 120));
  }

  console.log('\n=== K. operational status is administrator-only ===');
  ok('unauthenticated is refused', (await j('/api/ops/status')).status === 401);
  for (const r of ['alum', 'mod', 'dept']) {
    ok(`${r} cannot read operational status`, (await j('/api/ops/status', H(S[r]))).status === 403, r);
  }
  const ops = await j('/api/ops/status', H(S.univ));
  ok('an admin can read it', ops.status === 200);
  ok('it reports every job', (ops.body?.jobs || []).length === 3, String((ops.body?.jobs || []).length));
  ok('it reports backup state', !!ops.body?.backup);
  ok('it reports mail state', !!ops.body?.mail);
  ok('it reports pending deletions', ops.body?.deletions !== undefined);
  ok('it never exposes the SMTP password', !/SMTP_PASSWORD|password/i.test(JSON.stringify(ops.body)));
  ok('it never exposes the scheduler secret', !JSON.stringify(ops.body).includes(CRON));

  console.log('\n=== L. request logging is safe ===');
  const withId = await fetch(B + '/api/health');
  ok('a correlation id is returned to the caller', !!withId.headers.get('x-request-id'));
  const logSrc = src('server.js');
  /* Start at the middleware, not at the words "REQUEST LOG" — those sit inside
     the comment above it, so slicing there leaves an unclosed /* that no
     comment-stripper can match, and the comment's own prose then reads as
     code. */
  const logStart = logSrc.indexOf("app.use((req, res, next) => {\n  if (!req.path.startsWith('/api/'))");
  const logBlock = logSrc.slice(logStart, logStart + 1400)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  ok('the logging middleware was located', logStart > 0);
  ok('the log records the path, not the query string',
    /req\.path/.test(logBlock) && !/originalUrl/.test(logBlock));
  ok('the log never records the request body', !/req\.body/.test(logBlock));
  ok('the log never records the authorization header', !/authorization/i.test(logBlock));
  ok('the log never records a cookie header', !/cookie/i.test(logBlock));
  const srvLog = fs.existsSync(path.join(path.dirname(__filename), 'srv.log'))
    ? fs.readFileSync(path.join(path.dirname(__filename), 'srv.log'), 'utf8') : '';
  ok('no session token appears in the server log', !new RegExp(String(S.super).slice(0, 30)).test(srvLog));
  ok('no secret appears in the server log',
    !srvLog.includes(CRON) && !new RegExp((process.env.ENCRYPTION_KEY || 'zzzz').slice(0, 32)).test(srvLog));

  console.log('\n=== M. production boot enforcement ===');
  const ENV = REPO + '/.env', BAK = REPO + '/.env.p4bak';
  const PG = { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGDATABASE: process.env.PGDATABASE,
               PGUSER: process.env.PGUSER, PGPASSWORD: process.env.PGPASSWORD,
               PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const boot = (extra, expectFail, label) => {
    let out = '';
    try {
      execFileSync(process.execPath, ['-e', 'require("./server");'],
        { cwd: REPO, env: { ...PG, ...extra }, stdio: 'pipe', timeout: 20000 });
      ok(label, !expectFail, 'booted');
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      ok(label, expectFail, (out.split('\n').find(l => /Refusing|Error/.test(l)) || 'died').slice(0, 100));
    }
    return out;
  };
  const GOOD = { SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'a'.repeat(64),
                 CRON_SECRET: 'c'.repeat(48), MAIL_TRANSPORT: 'none' };
  fs.renameSync(ENV, BAK);
  let noCron = '', noSmtp = '';
  try {
    boot({ ...GOOD, NODE_ENV: 'production' }, false, 'production starts with every secret present');
    boot({ ...GOOD, NODE_ENV: 'production', SESSION_SECRET: '' }, true, 'still refuses without SESSION_SECRET');
    boot({ ...GOOD, NODE_ENV: 'production', ENCRYPTION_KEY: '' }, true, 'still refuses without ENCRYPTION_KEY');
    noCron = boot({ ...GOOD, NODE_ENV: 'production', CRON_SECRET: '' }, true, 'refuses without CRON_SECRET');
    boot({ ...GOOD, NODE_ENV: 'production', CRON_SECRET: 'short' }, true, 'refuses a too-short CRON_SECRET');
    noSmtp = boot({ SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'a'.repeat(64), CRON_SECRET: 'c'.repeat(48),
                    ...PG, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp' }, true,
                   'refuses when SMTP is required but unconfigured');
    boot({ ...GOOD, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp',
           SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'a@b.test' }, false,
         'starts once SMTP is configured');
    boot({ ...PG, NODE_ENV: 'development' }, false, 'development still starts with nothing set');
  } finally {
    fs.renameSync(BAK, ENV);
  }
  ok('.env was restored', fs.existsSync(ENV) && !fs.existsSync(BAK));
  ok('the failure names CRON_SECRET', /CRON_SECRET/.test(noCron));
  ok('the failure names the missing SMTP variables', /SMTP_HOST/.test(noSmtp), noSmtp.slice(0, 120));
  ok('no secret value is printed in any failure',
    !/x{64}|a{64}|c{48}/.test(noCron + noSmtp));

  console.log('\n=== N. failure modes fail safely ===');
  ok('an unreachable mail server does not change the reset response',
    JSON.stringify((await POST('/api/auth/forgot-password', null, { email: 'admin@dic.edu.bd' })).body)
      === JSON.stringify(ack2.body));
  const badJob = await j('/api/internal/jobs/run?job=deletion-purge',
    { method: 'POST', headers: { 'X-Cron-Key': CRON.slice(0, -1) + 'x' } });
  ok('a tampered scheduler secret is refused', badJob.status === 401);
  ok('a failed job is recorded rather than lost',
    /closeRun\(run\.id, 'failed'/.test(src('jobs.js')));
  ok('backup.js refuses to record an incomplete dump as good',
    /refusing to record it as good/.test(src('backup.js')));
  ok('the health probe degrades rather than crashing',
    /status\(503\)[\s\S]{0,80}degraded/.test(src('server.js')));

  console.log('\n=== O. documentation ===');
  const rb = src('OPERATIONS_RUNBOOK.md');
  for (const [label, re] of [
    ['start the service', /## A\. Start the service/],
    ['check health', /## B\. Check health/],
    ['check the scheduler', /## C\. Check the scheduler/],
    ['check the latest backup', /## D\. Check the latest backup/],
    ['restore', /## E\. Restore/],
    ['backup policy with retention', /## F\. Backup policy/],
    ['rotate credentials', /## G\. Rotate credentials/],
    ['administrator password recovery', /## H\. Administrator password recovery/],
    ['emergency super admin recovery', /## I\. Emergency super admin recovery/],
    ['database unavailable', /## J\. The database is unavailable/],
    ['ENCRYPTION_KEY is lost', /## K\. `ENCRYPTION_KEY` is lost/],
    ['the site is down', /## L\. The site is down/],
    ['rollback', /## M\. Rollback/],
    ['migration procedure', /## N\. Migration procedure/],
    ['contacts and escalation', /## O\. Contacts and escalation/],
  ]) ok(`the runbook covers ${label}`, re.test(rb));
  ok('the runbook states the retention period', /14 days/.test(rb));
  ok('the runbook documents secret escrow', /escrow/i.test(rb) && /password manager/i.test(rb));
  ok('the runbook says backups must not sit in a web root', /web root/i.test(rb));
  ok('the runbook requires a backup before migrating', /Verify a current backup exists/i.test(rb));
  ok('the runbook contains no actual secret',
    !rb.includes(CRON) && !new RegExp((process.env.ENCRYPTION_KEY || 'zzzz').slice(0, 32)).test(rb));
  ok('.env.example documents the new variables',
    ['CRON_SECRET', 'SMTP_HOST', 'MAIL_TRANSPORT', 'BACKUP_DIR', 'BACKUP_RETENTION_DAYS']
      .every(v => src('.env.example').includes(v)));
  ok('exactly one scheduler is configured for Vercel',
    JSON.parse(src('vercel.json')).crons.length === 3);
  ok('a VPS crontab script exists as the alternative', fs.existsSync(REPO + '/ops/cron-dic.sh'));
  ok('the two schedulers are documented as mutually exclusive',
    /[Nn]ever enable both|Only one of the two/.test(rb + src('ops/cron-dic.sh') + src('vercel.json')));

  console.log('\n=== cleanup ===');
  await db.query('DELETE FROM users WHERE email=$1', [EMAIL]);
  ok('test artifacts removed',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE email=$1', [EMAIL])).rows[0].n === 0);

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
