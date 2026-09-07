#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — RELEASE DRILL  (Phase 7E §2)

   install_drill.js proves the platform can be INSTALLED on an empty database
   and signed into. This goes on from there and proves it can be USED: the whole
   product, end to end, on a database that started the run with nothing in it.

   Empty database → migrations → first administrator → password change →
   department → alumni registration → verification → event → ticket types →
   registration → QR check-in → job → application → poll → vote → mentorship →
   donation pledge and manual settlement → reports → CSV → import with dry run →
   audit → chain verification.

   Nothing here is inserted with SQL. Every record is created through the API a
   real operator would use, because the point is to prove the product works and
   not that the tables accept rows. The only direct database statements are
   reads, plus the three the runbook itself documents (create the database,
   apply the schema, run the migrations).

   DISPOSABLE DATABASE ONLY. It creates its own, and drops it.

   Usage:  DOCKER_PG_CONTAINER=dic-alumni-pg node tests/phase7e_release_drill.js
           …--keep    to leave the database behind for inspection
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const CONTAINER = process.env.DOCKER_PG_CONTAINER || '';
const PGUSER = process.env.PGUSER || 'postgres';
const DB = `p7e_release_${process.pid}`;
const PORT = 8530 + (process.pid % 60);
const BASE = `http://127.0.0.1:${PORT}`;

if (!/^p7e_release_\d+$/.test(DB)) { console.error('refusing: bad drill db name'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 150) : ''))); };
const head = (t) => console.log('\n' + t);

function psql(args, { db = 'postgres', input = null } = {}) {
  const full = ['-v', 'ON_ERROR_STOP=1', '-U', PGUSER, '-d', db, ...args];
  return CONTAINER
    ? spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', ...full], { input, encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('psql', full, { input, encoding: 'utf8', maxBuffer: 1 << 28,
                env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' } });
}
const scalar = (sql) => (psql(['-tAc', sql], { db: DB }).stdout || '').trim();
const inDb = (args, extraEnv = {}) => spawnSync(process.execPath, args,
  { cwd: REPO, encoding: 'utf8', env: { ...process.env, PGDATABASE: DB, ...extraEnv } });
const drop = () => psql(['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}
const GET = (p, t) => req('GET', p, { token: t });
const POST = (p, b, t) => req('POST', p, { token: t, body: b });
const PUT = (p, b, t) => req('PUT', p, { token: t, body: b });

let srv = null;

(async () => {
 try {
  console.log(`\nRelease drill in ${DB} on port ${PORT}`);
  drop();

  /* ══ 1. install ══ */
  head('=== 1. A database with nothing in it ===');
  psql(['-c', `CREATE DATABASE ${DB}`]);
  const base = psql(['-q', '-f', '-'], { db: DB, input: fs.readFileSync(path.join(REPO, 'schema.sql'), 'utf8') });
  ok('schema.sql applied', base.status === 0, String(base.stderr).trim().split('\n').slice(-1)[0]);
  ok('it holds no users', scalar('SELECT count(*) FROM users') === '0');

  let stopped = null;
  for (let v = 2; v <= 19; v++) {
    const f = `migrate_v${v}.js`;
    if (!fs.existsSync(path.join(REPO, f))) continue;
    const r = inDb([f]);
    if (r.status !== 0) { stopped = v; console.log((String(r.stdout) + String(r.stderr)).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 3).join('\n')); break; }
  }
  ok('every migration v2..v19 applied', stopped === null, stopped ? `stopped at v${stopped}` : '');
  ok('the platform is still unseeded — no invented content',
    ['events', 'campaigns', 'polls', 'jobs', 'stories'].every(t => scalar(`SELECT count(*) FROM ${t}`) === '0'));
  ok('the department reference list is present', scalar('SELECT count(*) FROM departments') === '4');

  /* ══ 2. first administrator ══ */
  head('=== 2. The first administrator ===');
  const ADMIN_EMAIL = 'first.admin@drill.test';
  const BOOT_PW = 'Release-Drill-Boot-Pw1';
  const CHOSEN_PW = 'Release-Drill-Chosen-Pw1';
  const made = inDb(['rotate_credentials.js', '--create-super-admin', ADMIN_EMAIL, '--name', 'Drill Admin'],
                    { ADMIN_PW_SUPER_ADMIN: BOOT_PW });
  ok('bootstrapped', made.status === 0, (String(made.stderr) || String(made.stdout)).trim().split('\n').slice(-1)[0]);

  srv = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PGDATABASE: DB, PORT: String(PORT), NODE_ENV: 'development' }
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });
  await new Promise(r => setTimeout(r, 5000));
  ok('the server runs against it', /API Server running/.test(srvOut), srvOut.split('\n').slice(-2)[0]);

  const boot = await POST('/api/auth/login', { email: ADMIN_EMAIL, password: BOOT_PW });
  ok('the first administrator signs in', boot.status === 200, JSON.stringify(boot.body).slice(0, 90));
  ok('and is told the password must change', boot.body?.mustChangePassword === true);
  const changed = await POST('/api/auth/change-password',
    { currentPassword: BOOT_PW, newPassword: CHOSEN_PW }, boot.body.token);
  ok('it sets its own password', changed.status === 200);
  const SUPER = changed.body.token;
  ok('and now has full authority', (await GET('/api/audit-logs', SUPER)).status === 200);

  /* ══ 3. a department administrator ══ */
  head('=== 3. Staff provisioning and department scope ===');
  const depts = await GET('/api/departments', SUPER);
  ok('the department list is readable', depts.status === 200 && depts.body.departments.length === 4);
  const CSE = depts.body.departments.find(d => d.code === 'CSE');
  const BBA = depts.body.departments.find(d => d.code === 'BBA');

  const DA_PW = 'Release-Drill-Dept-Pw1';
  const mkAdmin = await POST('/api/admin/administrators', {
    email: 'cse.admin@drill.test', fullName: 'CSE Admin', designation: 'Head of CSE',
    role: 'dept_admin', department: 'CSE Department', password: DA_PW
  }, SUPER);
  ok('a department administrator is provisioned', mkAdmin.status === 200 || mkAdmin.status === 201,
    JSON.stringify(mkAdmin.body).slice(0, 140));
  const daId = mkAdmin.body?.administrator?.id || mkAdmin.body?.id;
  const daTemp = mkAdmin.body?.temporaryPassword || DA_PW;

  const scoped = await PUT(`/api/admin/administrators/${daId}`, { departmentId: CSE.id }, SUPER);
  ok('it is given a department', scoped.status === 200 && scoped.body.departmentCode === 'CSE',
    JSON.stringify(scoped.body?.departmentCode));

  const daLogin = await POST('/api/auth/login', { email: 'cse.admin@drill.test', password: daTemp });
  let DEPT = daLogin.body?.token;
  if (daLogin.body?.mustChangePassword) {
    const c = await POST('/api/auth/change-password',
      { currentPassword: daTemp, newPassword: DA_PW }, DEPT);
    DEPT = c.body?.token;
  }
  ok('the department administrator can sign in', !!DEPT, JSON.stringify(daLogin.body).slice(0, 100));

  /* ══ 4. alumni registration and verification ══ */
  head('=== 4. Alumni registration and verification ===');
  const ALUM_PW = 'Release-Drill-Alum-Pw1';
  const reg = await POST('/api/auth/register', {
    name: 'Drill Alumnus', email: 'alum.cse@drill.test', password: ALUM_PW,
    hscPassingYear: 2019, hscGroup: 'Science', departmentId: CSE.id
  });
  ok('an alumnus registers', reg.status === 200 || reg.status === 201, JSON.stringify(reg.body).slice(0, 110));
  ok('and starts unverified', reg.body?.user?.verified === false);
  ok('the department they chose was recorded',
    scalar(`SELECT d.code FROM users u JOIN departments d ON d.id=u.department_id WHERE u.email='alum.cse@drill.test'`) === 'CSE');
  const ALUM = reg.body.token;
  const alumId = reg.body.user.id;

  const reg2 = await POST('/api/auth/register', {
    name: 'Drill Alumnus Two', email: 'alum.bba@drill.test', password: ALUM_PW,
    hscPassingYear: 2018, hscGroup: 'Business Studies', departmentId: BBA.id
  });
  const ALUM2 = reg2.body.token;
  const alum2Id = reg2.body.user.id;
  ok('a second alumnus registers into another department', reg2.status < 300);

  ok('an unverified member is refused a verified-only action',
    (await POST('/api/jobs', { title: 'X', company: 'Y' }, ALUM)).status === 403);

  const q = await GET('/api/verification-queue', DEPT);
  ok('the department administrator sees its own department in the queue',
    q.status === 200 && q.body.some(u => u.id === alumId) && !q.body.some(u => u.id === alum2Id),
    q.body.map(u => u.id).join(','));
  ok('it cannot verify the other department\'s account',
    (await PUT(`/api/users/${alum2Id}/verify`, { verified: true }, DEPT)).status === 403);
  ok('it verifies its own', (await PUT(`/api/users/${alumId}/verify`, { verified: true }, DEPT)).status === 200);
  ok('the institution verifies the other', (await PUT(`/api/users/${alum2Id}/verify`, { verified: true }, SUPER)).status === 200);

  const relogin = await POST('/api/auth/login', { email: 'alum.cse@drill.test', password: ALUM_PW });
  const ALUMV = relogin.body.token;
  ok('a verified member may now act', (await GET('/api/alumni', ALUMV)).status === 200);

  /* ══ 5. events, tickets, QR ══ */
  head('=== 5. Event, tickets and check-in ===');
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const ev = await POST('/api/events', {
    title: 'Drill Reunion', venue: 'DIC Auditorium', startsOn: soon, startTime: '18:00',
    eventType: 'Reunion', capacity: 2, description: 'Release drill event',
    ticketTypes: [{ name: 'General', price: 0, quota: 2 }]
  }, SUPER);
  ok('an event is created', ev.status === 200 || ev.status === 201, JSON.stringify(ev.body).slice(0, 130));
  const evId = ev.body?.event?.id || ev.body?.id;
  ok('it is approved when an administrator creates it',
    scalar(`SELECT approval_status FROM events WHERE id=${evId}`) === 'approved');

  const types = await GET(`/api/events/${evId}/ticket-types`, SUPER);
  const ttId = (types.body?.ticketTypes || types.body || [])[0]?.id
            || Number(scalar(`SELECT id FROM event_ticket_types WHERE event_id=${evId} LIMIT 1`));
  ok('it has a ticket type', !!ttId, ttId);

  const r1 = await POST(`/api/events/${evId}/register`, { ticketTypeId: ttId }, ALUMV);
  ok('a verified member registers', r1.status === 200 || r1.status === 201, JSON.stringify(r1.body).slice(0, 120));
  const ticketCode = r1.body?.registration?.ticket_code || r1.body?.ticket_code;
  ok('a ticket code is issued', !!ticketCode, ticketCode);
  ok('registering twice is refused',
    (await POST(`/api/events/${evId}/register`, { ticketTypeId: ttId }, ALUMV)).status >= 400);

  const relogin2 = await POST('/api/auth/login', { email: 'alum.bba@drill.test', password: ALUM_PW });
  const ALUM2V = relogin2.body.token;
  const r2 = await POST(`/api/events/${evId}/register`, { ticketTypeId: ttId }, ALUM2V);
  ok('a second member takes the last seat', r2.status < 300, JSON.stringify(r2.body).slice(0, 110));
  ok('capacity is enforced from real rows',
    scalar(`SELECT count(*) FROM event_registrations WHERE event_id=${evId} AND status='confirmed'`) === '2');

  /* ticketCode, not code. The first version of this drill sent `code`, so the
     invalid and tampered scans were rejected for a MISSING FIELD and passed for
     the wrong reason — a green assertion proving nothing. Both now carry a
     well-formed field and are refused on their contents. */
  const badScan = await POST('/api/events/checkin', { ticketCode: 'NOT-A-REAL-CODE' }, SUPER);
  ok('an invalid ticket code is refused', badScan.status >= 400, JSON.stringify(badScan.body).slice(0, 90));
  const tampered = await POST('/api/events/checkin',
    { ticketCode: String(ticketCode).slice(0, -1) + 'X' }, SUPER);
  ok('a tampered ticket code is refused', tampered.status >= 400, JSON.stringify(tampered.body).slice(0, 90));
  const scan = await POST('/api/events/checkin', { ticketCode }, SUPER);
  ok('a real ticket checks in', scan.status === 200, JSON.stringify(scan.body).slice(0, 130));
  const again = await POST('/api/events/checkin', { ticketCode }, SUPER);
  ok('a second check-in of the same ticket is not silently accepted',
    again.status >= 400 || again.body?.alreadyCheckedIn === true, JSON.stringify(again.body).slice(0, 110));
  ok('the check-in is recorded against the registration',
    scalar(`SELECT count(*) FROM event_registrations WHERE event_id=${evId} AND checked_in`) === '1');

  /* ══ 6. jobs ══ */
  head('=== 6. Jobs ===');
  const job = await POST('/api/jobs', {
    title: 'Drill Engineer', company: 'Drill Ltd', location: 'Dhaka', type: 'Full-time',
    description: 'A role created by the release drill'
  }, ALUMV);
  ok('a verified member posts a job', job.status < 300, JSON.stringify(job.body).slice(0, 110));
  const jobId = job.body?.job?.id || job.body?.id;
  const applied = await POST(`/api/jobs/${jobId}/apply`, { coverNote: 'Please consider me' }, ALUM2V);
  ok('another member applies', applied.status < 300, JSON.stringify(applied.body).slice(0, 110));
  const mine = await GET('/api/my-applications', ALUM2V);
  ok('the applicant can see their own application', mine.status === 200 && mine.body.length === 1);
  const appId = Number(scalar(`SELECT id FROM job_applications WHERE job_id=${jobId} LIMIT 1`));
  ok('the poster moves it forward',
    (await PUT(`/api/job-applications/${appId}/status`, { status: 'shortlisted' }, ALUMV)).status === 200);
  ok('a stranger cannot',
    (await PUT(`/api/job-applications/${appId}/status`, { status: 'hired' }, ALUM2V)).status === 403);
  ok('the job closes and reopens',
    (await PUT(`/api/jobs/${jobId}`, { status: 'closed' }, ALUMV)).status === 200 &&
    (await PUT(`/api/jobs/${jobId}`, { status: 'open' }, ALUMV)).status === 200);

  /* ══ 7. polls ══ */
  head('=== 7. Polls ===');
  const poll = await POST('/api/polls', { question: 'Drill question?', options: ['Yes', 'No'] }, SUPER);
  ok('a poll is drafted', poll.status < 300, JSON.stringify(poll.body).slice(0, 110));
  const pollId = poll.body?.poll?.id || poll.body?.id;
  ok('a draft is not offered to members',
    !((await GET('/api/polls/active', ALUMV)).body || []).some(p => p.id === pollId));
  ok('it opens', (await PUT(`/api/polls/${pollId}/status`, { status: 'open' }, SUPER)).status === 200);
  ok('a member votes', (await POST(`/api/polls/${pollId}/vote`, { optionIndex: 0 }, ALUMV)).status < 300);
  /* Voting again REPLACES the vote — the endpoint uses ON CONFLICT DO UPDATE and
     the UNIQUE(poll_id, user_id) constraint is what guarantees one member, one
     vote. The first version of this drill expected a 4xx and called a member
     changing their mind a defect. The invariant to assert is the row count. */
  const revote = await POST(`/api/polls/${pollId}/vote`, { optionIndex: 1 }, ALUMV);
  ok('voting again is accepted as a change of mind', revote.status < 300, revote.status);
  ok('…and never adds a second vote',
    scalar(`SELECT count(*) FROM poll_votes WHERE poll_id=${pollId}`) === '1',
    scalar(`SELECT count(*) FROM poll_votes WHERE poll_id=${pollId}`));
  ok('it closes', (await PUT(`/api/polls/${pollId}/status`, { status: 'closed' }, SUPER)).status === 200);
  ok('a closed poll refuses a vote',
    (await POST(`/api/polls/${pollId}/vote`, { optionIndex: 1 }, ALUM2V)).status >= 400);

  /* ══ 8. donations ══ */
  head('=== 8. Donations — pledge and manual settlement only ===');
  const camp = await POST('/api/campaigns', {
    name: 'Drill Fund', description: 'Release drill campaign', goalAmount: 100000, tag: 'drill'
  }, SUPER);
  ok('a campaign is created', camp.status < 300, JSON.stringify(camp.body).slice(0, 110));
  const campId = camp.body?.campaign?.id || camp.body?.id;

  const pledge = await POST('/api/donations', { campaignId: campId, amount: 5000 }, ALUMV);
  ok('a member pledges', pledge.status < 300, JSON.stringify(pledge.body).slice(0, 130));
  const donId = pledge.body?.donation?.id || pledge.body?.id;
  ok('the pledge is NOT settled by the client',
    scalar(`SELECT status FROM donations WHERE id=${donId}`) === 'PLEDGED',
    scalar(`SELECT status FROM donations WHERE id=${donId}`));
  ok('a member cannot mark their own gift received',
    (await POST(`/api/donations/${donId}/record-payment`, { received: true }, ALUMV)).status === 403);
  const rec = await POST(`/api/donations/${donId}/record-payment`, { received: true, method: 'bank transfer' }, SUPER);
  ok('the alumni office records it manually', rec.status === 200, JSON.stringify(rec.body).slice(0, 110));
  ok('and only then is it settled',
    scalar(`SELECT status FROM donations WHERE id=${donId}`) === 'SUCCESS');
  ok('a receipt code exists', scalar(`SELECT COALESCE(receipt_code,'') FROM donations WHERE id=${donId}`).length > 0);

  /* ══ 9. mentorship ══ */
  head('=== 9. Mentorship ===');
  const ment = await POST('/api/mentorships', { mentorId: alumId, subject: 'Careers', message: 'Please mentor me' }, ALUM2V);
  ok('a mentorship is requested', ment.status < 300, JSON.stringify(ment.body).slice(0, 110));

  /* ══ 10. reports ══ */
  head('=== 10. Reports and exports ===');
  const cat = await GET('/api/reports', SUPER);
  ok('the report catalogue lists ten', cat.body.reports.length === 10);
  for (const slug of cat.body.reports.map(r => r.slug)) {
    ok(`${slug} runs on a freshly used database`, (await GET(`/api/reports/${slug}`, SUPER)).status === 200);
  }
  const campRep = await GET('/api/reports/campaign-summary', SUPER);
  const row = campRep.body.rows.find(r => r.campaign_id === campId);
  ok('the campaign report equals the database, not a counter',
    Number(row.settled_amount) === Number(scalar(
      `SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id=${campId} AND status='SUCCESS'`)),
    `${row.settled_amount} vs sql`);
  const evRep = await GET('/api/reports/event-attendance', SUPER);
  const evRow = evRep.body.rows.find(r => r.event_id === evId);
  ok('the event report counts the real registrations', evRow.registered === 2, evRow?.registered);
  ok('and the real check-in', evRow.checked_in === 1, evRow?.checked_in);

  const csvRes = await fetch(`${BASE}/api/reports/alumni-directory?format=csv`,
    { headers: { Authorization: 'Bearer ' + SUPER } });
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  ok('a CSV export carries a UTF-8 BOM',
    csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF);
  ok('…and CRLF line endings', /\r\n/.test(csvBuf.toString('utf8')));
  ok('…and no credential vocabulary',
    !/password|hash|token|secret/i.test(csvBuf.toString('utf8')));

  const deptRep = await GET('/api/reports/alumni-directory', DEPT);
  ok('the department administrator\'s report is scoped',
    deptRep.body.rows.every(r => r.department_code === 'CSE') && deptRep.body.rowCount === 1,
    `${deptRep.body.rowCount} rows`);

  /* ══ 11. import ══ */
  head('=== 11. Import, dry run and rollback ===');
  const rows = [
    { row: 1, name: 'Imported One', email: 'imp1@drill.test', hscPassingYear: 2017, department: 'CSE' },
    { row: 2, name: 'Imported Two', email: 'imp2@drill.test', hscPassingYear: 2017, department: 'SWE' },
    { row: 3, name: 'Bad Row', email: 'not-an-email', hscPassingYear: 2017 }
  ];
  const usersBefore = Number(scalar('SELECT count(*) FROM users'));
  const dry = await POST('/api/bulk-import', { records: rows, filename: 'drill.csv', dryRun: true }, SUPER);
  ok('a dry run reports what would happen', dry.status === 200 && dry.body.dryRun === true);
  ok('it creates two and rejects the malformed one',
    dry.body.created === 2 && dry.body.rejected === 1, `${dry.body.created}/${dry.body.rejected}`);
  ok('and writes absolutely nothing', Number(scalar('SELECT count(*) FROM users')) === usersBefore);

  const real = await POST('/api/bulk-import', { records: rows, filename: 'drill.csv' }, SUPER);
  ok('the real import matches the dry run',
    real.body.created === dry.body.created && real.body.rejected === dry.body.rejected);
  ok('the imported accounts carry their department, not their HSC group',
    scalar(`SELECT d.code FROM users u JOIN departments d ON d.id=u.department_id WHERE u.email='imp1@drill.test'`) === 'CSE');
  ok('every imported account is an ordinary alumni member',
    scalar(`SELECT count(*) FROM users WHERE email LIKE 'imp%@drill.test' AND role='alumni'`) === '2');

  const batchId = real.body.batchId;
  const rb = await POST(`/api/import-batches/${batchId}/rollback`, {}, SUPER);
  ok('the batch rolls back', rb.status === 200 && rb.body.deleted === 2, JSON.stringify(rb.body).slice(0, 110));
  ok('and only its own accounts went',
    scalar(`SELECT count(*) FROM users WHERE email LIKE 'imp%@drill.test'`) === '0' &&
    Number(scalar('SELECT count(*) FROM users')) === usersBefore);
  ok('the history row survives the rollback',
    scalar(`SELECT status FROM import_history WHERE id=${batchId}`) === 'rolled_back');

  /* ══ 12. compliance ══ */
  head('=== 12. Privacy and DSAR ===');
  const dsar = await GET('/api/dsar/export', ALUMV);
  ok('a member can export their own data', dsar.status === 200);
  /* Checked on the KEYS of the payload, not on its text. The first version
     searched the raw JSON and matched the export's own sentence explaining that
     passwords are never exported — a false positive that would have been read as
     a data leak in a data-protection export. What matters is whether any field
     IS a credential, so that is what this walks. */
  const dsarKeys = new Set();
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { dsarKeys.add(k); walk(v); }
  })(dsar.body);
  const SECRETISH = /password|passwd|hash|token|secret|salt|cipher|auth_tag|private_key|api_key/i;
  const leaked = [...dsarKeys].filter(k => SECRETISH.test(k));
  ok('no field in the export is a credential', leaked.length === 0, leaked.join(','));
  ok('…and it says so in words, so a reader knows it is deliberate',
    /never exported/i.test(JSON.stringify(dsar.body)));
  ok('it says which sections it includes', Array.isArray(dsar.body?.export?.includedSections));
  const del = await POST('/api/dsar/delete', { reason: 'drill' }, ALUMV);
  ok('a deletion can be requested', del.status < 300, JSON.stringify(del.body).slice(0, 110));
  ok('…and cancelled', (await req('DELETE', '/api/dsar/delete', { token: ALUMV })).status < 300);

  /* ══ 13. audit ══ */
  head('=== 13. Audit ===');
  const entries = Number(scalar('SELECT count(*) FROM audit_logs'));
  ok('the drill produced an audit trail', entries > 20, entries);
  for (const action of ['Signed In', 'Password Changed', 'Administrator Created', 'Alumni Verified',
                        'Alumni Self-Registered', 'Event Created', 'Job Created',
                        'Bulk Import Completed', 'Bulk Import Dry Run', 'Import Batch Rolled Back',
                        'Donation Payment Recorded']) {
    ok(`audited: ${action}`, scalar(`SELECT count(*) FROM audit_logs WHERE action='${action}'`) !== '0');
  }
  ok('no audit entry contains a password',
    scalar(`SELECT count(*) FROM audit_logs WHERE meta LIKE '%${CHOSEN_PW}%' OR meta LIKE '%${ALUM_PW}%'`) === '0');
  const chain = inDb(['verify_audit.js']);
  ok('the chain verifies on a database built entirely by this drill',
    /PASS/.test(String(chain.stdout) + String(chain.stderr)),
    (String(chain.stdout) + String(chain.stderr)).split('\n').filter(l => /PASS|FAIL/.test(l))[0]);

  console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n`);
 } catch (err) {
  console.error('\n  DRILL ERROR:', err.message);
  fail++;
 } finally {
  if (srv) { try { srv.kill(); } catch {} await new Promise(r => setTimeout(r, 800)); }
  if (!KEEP) {
    const d = drop();
    ok('the drill database was dropped', d.status === 0, String(d.stderr).trim().slice(0, 80));
  } else {
    console.log(`  kept: ${DB}`);
  }
  process.exit(fail ? 1 : 0);
 }
})();
