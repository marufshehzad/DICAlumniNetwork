#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — FRESH INSTALL DRILL

   Answers the question no previous phase had asked: can this platform be
   installed on an empty database and signed into?

   Every phase before Phase 6 worked against a development database created
   long ago and migrated forward. Nobody had run PRODUCTION_DEPLOYMENT_RUNBOOK
   step 4 from nothing. When Phase 6 did, three separate faults stopped it:

     · migrate_v5.js aborted on an empty events table, so the install stopped
       with 39 of 47 tables — on EVERY fresh database
     · migrate_v2.js seeded invented vendors, phone numbers and a live poll
       into a database the runbook explicitly says not to seed
     · nothing could create the first administrator: the users table was empty,
       rotate_credentials.js only ever rotated rows that already existed, and
       every provisioning route requires a super_admin session

   This drill pins all three, and then goes further: it starts the application
   against the freshly installed database and signs in.

   DISPOSABLE DATABASE ONLY. It creates its own, and drops it.

   Usage:  node tests/install_drill.js
           node tests/install_drill.js --keep
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
require(path.join(REPO, 'db'));

const KEEP = process.argv.includes('--keep');
const CONTAINER = process.env.DOCKER_PG_CONTAINER || '';
const PGUSER = process.env.PGUSER || 'postgres';
const DB = `p6_install_${process.pid}`;
const PORT = 8460 + (process.pid % 60);

if (!/^p6_install_\d+$/.test(DB)) { console.error('refusing: bad drill db name'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const head = (t) => console.log('\n' + t);

function psql(args, { db = 'postgres', input = null } = {}) {
  const full = ['-v', 'ON_ERROR_STOP=1', '-U', PGUSER, '-d', db, ...args];
  return CONTAINER
    ? spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', ...full],
                { input, encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('psql', full, { input, encoding: 'utf8', maxBuffer: 1 << 28,
                env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' } });
}
const scalar = (sql, db) => {
  const r = psql(['-tAc', sql], { db });
  return r.status === 0 ? String(r.stdout).trim() : null;
};
const drop = () => psql(['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
const inDb = (args, extraEnv = {}) => spawnSync(process.execPath, args, {
  cwd: REPO, encoding: 'utf8',
  env: { ...process.env, PGDATABASE: DB, NODE_ENV: 'development', ...extraEnv }
});

const api = async (p, o = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const post = (p, body, token) => api(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body || {})
});

(async () => {
  console.log(`\nFresh install drill in ${DB}`);
  drop();

  head('=== 1. The documented install sequence, from nothing ===');
  psql(['-c', `CREATE DATABASE ${DB}`]);
  const base = psql(['-q', '-f', '-'], { db: DB, input: fs.readFileSync(path.join(REPO, 'schema.sql'), 'utf8') });
  ok('schema.sql applied', base.status === 0, String(base.stderr).trim().split('\n').slice(-1)[0]);
  ok('a fresh database has no users', scalar('SELECT count(*) FROM users', DB) === '0');

  let stoppedAt = null;
  for (let v = 2; v <= 16; v++) {
    const f = `migrate_v${v}.js`;
    if (!fs.existsSync(path.join(REPO, f))) continue;
    const r = inDb([f]);
    if (r.status !== 0) {
      stoppedAt = v;
      const why = (String(r.stdout) + String(r.stderr)).split('\n')
        .filter(l => /Error|error|FAIL/.test(l)).slice(0, 1).join(' ');
      ok(`migrate_v${v}.js`, false, why.slice(0, 160));
      break;
    }
  }
  ok('every migration v2..v13 applied without stopping', stoppedAt === null,
    stoppedAt ? `aborted at v${stoppedAt}` : '');
  const tables = scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'", DB);
  ok('the installed schema has the full 47 tables', tables === '47', `${tables} tables`);

  head('=== 2. Nothing was fabricated into a database nobody seeded ===');
  /* PRODUCTION_DEPLOYMENT_RUNBOOK step 4 says not to run seed.sql, precisely so
     production contains no invented content. Until Phase 6, migrate_v2 seeded
     demo rows anyway — a live poll on the public news feed and four catering
     and security vendors with made-up names and phone numbers. */
  for (const t of ['polls', 'event_vendors', 'event_timeline', 'event_marketing',
                   'event_meetings', 'event_logistics', 'events', 'campaigns']) {
    ok(`${t} is empty on a clean install`, scalar(`SELECT count(*) FROM ${t}`, DB) === '0',
      scalar(`SELECT count(*) FROM ${t}`, DB));
  }

  head('=== 3. The first administrator can be created ===');
  const noAdmin = inDb(['rotate_credentials.js', '--check']);
  ok('the credential audit runs on an empty database', noAdmin.status === 0);

  const EMAIL = 'first.admin@drill.test';
  const PW = 'Install-Drill-First-Pw1';
  const made = inDb(['rotate_credentials.js', '--create-super-admin', EMAIL, '--name', 'Drill Admin'],
                    { ADMIN_PW_SUPER_ADMIN: PW });
  ok('--create-super-admin succeeded', made.status === 0,
    (String(made.stderr) || String(made.stdout)).trim().split('\n').slice(-1)[0]);
  ok('exactly one super_admin now exists',
    scalar("SELECT count(*) FROM users WHERE role='super_admin'", DB) === '1');
  ok('it is flagged must_change_password',
    scalar(`SELECT must_change_password FROM users WHERE email='${EMAIL}'`, DB) === 't');
  ok('it is recorded as created_via=bootstrap',
    scalar(`SELECT created_via FROM users WHERE email='${EMAIL}'`, DB) === 'bootstrap');
  ok('the supplied password was NOT written to disk',
    !fs.existsSync(path.join(REPO, 'admin-credentials.local.txt')) ||
    !fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').includes(PW));

  const again = inDb(['rotate_credentials.js', '--create-super-admin', 'second@drill.test'],
                     { ADMIN_PW_SUPER_ADMIN: PW });
  ok('a second bootstrap is refused once one exists', again.status !== 0,
    `exit ${again.status}`);

  head('=== 4. The application runs against the fresh install and can be signed into ===');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PGDATABASE: DB, PORT: String(PORT), NODE_ENV: 'development' }
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });
  await new Promise(r => setTimeout(r, 4500));

  ok('the server started against the fresh database', /API Server running/.test(srvOut),
    srvOut.split('\n')[0]);
  const health = await api('/api/health');
  ok('health reports the database is reachable',
    health.status === 200 && health.body?.database === 'ok', JSON.stringify(health.body));

  const login = await post('/api/auth/login', { email: EMAIL, password: PW });
  ok('the first administrator can sign in', login.status === 200, JSON.stringify(login.body).slice(0, 90));
  ok('the response says the password must change', login.body?.mustChangePassword === true);
  const t0 = login.body?.token;

  /* The enrolment gate: the bootstrap password was seen by whoever ran the
     command, so it is an enrolment credential and nothing more until replaced. */
  ok('the enrolment session cannot read the audit log',
    (await api('/api/audit-logs', { headers: { Authorization: 'Bearer ' + t0 } })).status === 403);
  ok('the enrolment session cannot provision administrators',
    (await post('/api/admin/administrators', { email: 'x@y.test' }, t0)).status === 403);
  ok('the enrolment session CAN identify itself',
    (await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + t0 } })).status === 200);

  const changed = await post('/api/auth/change-password',
    { currentPassword: PW, newPassword: 'Install-Drill-Chosen-Pw1' }, t0);
  ok('it can set its own password', changed.status === 200, JSON.stringify(changed.body).slice(0, 80));
  const t1 = changed.body?.token;
  ok('and then has full super_admin authority',
    (await api('/api/audit-logs', { headers: { Authorization: 'Bearer ' + t1 } })).status === 200);
  ok('the staff portal is served', /DIC Staff Portal/.test(
    await (await fetch(`http://127.0.0.1:${PORT}/admin`)).text()));

  try { srv.kill('SIGKILL'); } catch {}
  await new Promise(r => setTimeout(r, 300));

  head('=== 5. Cleanup ===');
  if (!KEEP) {
    drop();
    ok('the drill database was dropped',
      scalar(`SELECT count(*) FROM pg_database WHERE datname='${DB}'`) === '0');
  } else {
    console.log(`  --keep: ${DB} left in place`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nDRILL ERROR: ' + e.message);
  console.error(e.stack);
  try { drop(); } catch {}
  process.exit(2);
});
