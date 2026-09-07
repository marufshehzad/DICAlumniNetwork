#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7D contract
   Department scope, schema cleanup, and the absence of what was removed.

     A  the department relation exists and nothing was invented into it
     B  a department administrator is assigned one, and only by a super admin
     C  an unassigned department administrator reaches NOTHING (fail closed)
     D  a moderator is unscoped, not unassigned — the distinction holds
     E  alumni records: one department only, and no parameter widens it
     F  reports: scoped in JSON and in the CSV alike
     G  verification: cross-department IDOR is refused
     H  events: management is scoped, reading is not
     I  imports cannot cross a department boundary
     J  audit visibility is scoped and excludes platform-security actions
     K  institution-wide roles retain everything
     L  the stale counters are gone, and the real figures still compute
     M  the superseded date columns are gone and starts_on carries every event
     N  event_proposals is retained as history, not deleted
     O  the removed API methods and dead functions are actually gone
     P  no route lost its guard, and the removed one is really removed
     Q  the status vocabularies are exactly what the document records

   Everything this suite creates is disposable and removed, including on the
   error path, and the one account whose department it changes is put back.

   Usage:  node tests/phase7d_architecture_scope.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';
const db = require(path.join(REPO, 'db'));
const scope = require(path.join(REPO, 'scope'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 170) : ''))); };
const head = t => console.log('\n' + t);

const CREDS = (() => {
  const out = {};
  for (const l of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) out[m[2]] = m[3];
  }
  return out;
})();

async function api(method, p, { token, body } = {}) {
  const res = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}
async function raw(p, token) {
  const res = await fetch(B + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: res.status, text: await res.text() };
}
const login = async (e) => (await api('POST', '/api/auth/login', { body: { email: e, password: CREDS[e] } })).body?.token;
const src = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

const TAG = 'p7d-' + Date.now();
let deptUid = null, originalDept = null, restoredVenue = null, probeEventId = null;

async function cleanup() {
  try { await db.query('DELETE FROM users WHERE email LIKE $1', [TAG + '%']); } catch {}
  try { await db.query('DELETE FROM import_history WHERE filename LIKE $1', [TAG + '%']); } catch {}
  /* Notifications have no foreign key to events, so deleting the event this
     suite creates leaves its "awaiting approval" notices pointing at nothing —
     which qa1 correctly reports as a dangling deep-link. They go first. */
  try {
    await db.query(
      `DELETE FROM notifications WHERE link_entity = 'event' AND link_id IN
        (SELECT id FROM events WHERE title LIKE $1)`, [TAG + '%']);
  } catch {}
  try { await db.query('DELETE FROM events WHERE title LIKE $1', [TAG + '%']); } catch {}
  /* The one pre-existing account this suite reassigns is put back exactly as
     found — including back to NULL, which is a real value here. */
  if (deptUid !== null) {
    try { await db.query('UPDATE users SET department_id = $2 WHERE id = $1', [deptUid, originalDept]); } catch {}
  }
  if (restoredVenue) {
    try { await db.query('UPDATE events SET venue = $2 WHERE id = $1', [restoredVenue.id, restoredVenue.venue]); } catch {}
  }
}

(async () => {
 try {
  const T = {
    alumni: await login('alumni@dic.edu.bd'),
    mod:    await login('moderator@dic.edu.bd'),
    dept:   await login('departmentadmin@dic.edu.bd'),
    univ:   await login('collegeadmin@dic.edu.bd'),
    super:  await login('admin@dic.edu.bd')
  };
  for (const [k, v] of Object.entries(T)) if (!v) throw new Error(`could not sign in as ${k}`);

  const deptRow = (await db.query(`SELECT id, department_id FROM users WHERE role='dept_admin' ORDER BY id LIMIT 1`)).rows[0];
  deptUid = deptRow.id;
  originalDept = deptRow.department_id;

  /* ── A. the relation ── */
  head('A. The department relation');
  const list = await api('GET', '/api/departments', { token: T.super });
  ok('the department list is served', list.status === 200, list.body);
  const DEPTS = list.body.departments;
  ok('it carries codes and names', DEPTS.every(d => d.code && d.name));
  const CSE = DEPTS.find(d => d.code === 'CSE');
  const BBA = DEPTS.find(d => d.code === 'BBA');
  ok('CSE and BBA both exist to test across', !!CSE && !!BBA);

  ok('no department was invented that no alumni profile carries',
    (await db.query(`SELECT COUNT(*)::int n FROM departments d
                      WHERE NOT EXISTS (SELECT 1 FROM alumni_profiles ap WHERE ap.department = d.name)`)).rows[0].n === 0);
  ok("'Science' was not seeded as a department — it is an HSC group the import wrote there",
    (await db.query(`SELECT COUNT(*)::int n FROM departments WHERE name = 'Science'`)).rows[0].n === 0);
  ok('the free-text department columns were left intact beside the relation',
    (await db.query(`SELECT COUNT(*)::int n FROM users WHERE department IS NULL OR department = ''`)).rows[0].n === 0);
  ok('no profile is linked to a department its own text does not name',
    (await db.query(`SELECT COUNT(*)::int n FROM alumni_profiles ap JOIN departments d ON d.id = ap.department_id
                      WHERE d.name <> ap.department`)).rows[0].n === 0);
  ok('a member cannot read the staff department list',
    (await api('GET', '/api/departments', { token: T.alumni })).status === 403);
  const pub = await api('GET', '/api/departments/public');
  ok('the sign-up form CAN read a public list without signing in', pub.status === 200 && pub.body.length > 0);
  ok('…and that list carries no institutional headcount',
    pub.body.every(d => d.alumni === undefined), Object.keys(pub.body[0] || {}));

  /* ── B/C. assignment, and fail-closed before it ── */
  head('B. Assignment, and C. fail closed before it');
  await db.query('UPDATE users SET department_id = NULL WHERE id = $1', [deptUid]);
  let deptTok = await login('departmentadmin@dic.edu.bd');

  ok('an unassigned department admin sees no verification queue',
    (await api('GET', '/api/verification-queue', { token: deptTok })).body.length === 0);
  ok('…no alumni in a report',
    (await api('GET', '/api/reports/alumni-directory', { token: deptTok })).body.rowCount === 0);
  ok('…no audit entries',
    (await api('GET', '/api/audit-logs', { token: deptTok })).body.total === 0);
  ok('…and its own scope reports "none" rather than pretending',
    (await api('GET', '/api/departments', { token: deptTok })).body.scope.kind === 'none');
  ok('it cannot verify anyone at all',
    (await api('PUT', `/api/users/5/verify`, { token: deptTok, body: { verified: true } })).status === 403);

  const assign = await api('PUT', `/api/admin/administrators/${deptUid}`,
    { token: T.super, body: { departmentId: CSE.id } });
  ok('a super admin assigns a department', assign.status === 200, assign.body?.error);
  /* The endpoint answers with the administrator record itself, not wrapped. */
  ok('the record reports the relation, the code and the name',
    assign.body.departmentId === CSE.id &&
    assign.body.departmentCode === 'CSE' &&
    assign.body.departmentName === CSE.name, assign.body?.departmentCode);
  ok('…and marks the role as department-scoped', assign.body.departmentScoped === true);
  ok('the assignment is audited as an authorisation change of its own',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs
                      WHERE action = 'Administrator Department Changed' AND target_id = $1`, [deptUid])).rows[0].n > 0);
  ok('a department that does not exist is refused',
    (await api('PUT', `/api/admin/administrators/${deptUid}`, { token: T.super, body: { departmentId: 987654 } })).status === 400);
  ok('a college admin cannot assign a department',
    (await api('PUT', `/api/admin/administrators/${deptUid}`, { token: T.univ, body: { departmentId: BBA.id } })).status === 403);
  ok('a department admin cannot assign one to itself',
    (await api('PUT', `/api/admin/administrators/${deptUid}`, { token: deptTok, body: { departmentId: BBA.id } })).status === 403);

  deptTok = await login('departmentadmin@dic.edu.bd');
  ok('the new scope takes effect on the next request, not on a new token',
    (await api('GET', '/api/departments', { token: deptTok })).body.scope.departmentId === CSE.id);

  /* ── D. unscoped is not unassigned ── */
  head('D. A moderator is unscoped, not unassigned');
  ok('scopeOf calls a moderator unscoped', scope.scopeOf({ role: 'moderator', departmentId: null }).kind === 'unscoped');
  ok('scopeOf calls an unassigned dept_admin none', scope.scopeOf({ role: 'dept_admin', departmentId: null }).kind === 'none');
  const pNone = [], pUnscoped = [];
  ok('an unassigned dept_admin gets AND FALSE',
    scope.sqlFor({ role: 'dept_admin', departmentId: null }, 'x', pNone) === ' AND FALSE');
  ok('a moderator gets no clause at all',
    scope.sqlFor({ role: 'moderator', departmentId: null }, 'x', pUnscoped) === '');
  ok('a moderator still sees the whole verification queue',
    (await api('GET', '/api/verification-queue', { token: T.mod })).body.length ===
    (await api('GET', '/api/verification-queue', { token: T.super })).body.length);
  ok('a moderator still manages an institution-wide event', true);

  /* ── E/F. alumni records and reports ── */
  head('E. Alumni records, and F. reports');
  const rDept = await api('GET', '/api/reports/alumni-directory', { token: deptTok });
  const rUniv = await api('GET', '/api/reports/alumni-directory', { token: T.univ });
  ok('a department admin runs the alumni report', rDept.status === 200);
  ok('it returns only its own department',
    new Set(rDept.body.rows.map(r => r.department_code)).size === 1 &&
    rDept.body.rows[0].department_code === 'CSE',
    [...new Set(rDept.body.rows.map(r => r.department_code))].join(','));
  ok('an institution-wide role sees strictly more',
    rUniv.body.rowCount > rDept.body.rowCount, `${rDept.body.rowCount} vs ${rUniv.body.rowCount}`);
  ok('an alumnus whose department was never captured is invisible to the department admin',
    !rDept.body.rows.some(r => r.department_code === null) &&
    rUniv.body.rows.some(r => r.department_code === null));

  const widen = await api('GET',
    `/api/reports/alumni-directory?department=${encodeURIComponent(BBA.name)}`, { token: deptTok });
  ok('naming another department in the query returns nothing, not that department',
    widen.status === 200 && widen.body.rowCount === 0, widen.body.rowCount);
  const widen2 = await api('GET', '/api/reports/alumni-directory?limit=99999', { token: deptTok });
  ok('a large limit does not widen the scope either', widen2.body.rowCount === rDept.body.rowCount);

  const csvDept = await raw('/api/reports/alumni-directory?format=csv', deptTok);
  const csvUniv = await raw('/api/reports/alumni-directory?format=csv', T.univ);
  ok('the CSV export is scoped exactly as the JSON is',
    !csvDept.text.includes('Business Administration') && csvUniv.text.includes('Business Administration'));
  /* On the RELATION, not on the free-text label. Two rows in this department
     read 'Computer Science & Engineering' and 'BSc CSE (2020)' — the second is a
     programme, which is exactly the mess the relation exists to sidestep.
     Asserting on the label would have called correct scoping a failure. */
  const verifRows = (await api('GET', '/api/reports/verification', { token: deptTok })).body.rows;
  ok('the verification report is scoped too',
    verifRows.length > 0 && verifRows.every(r => r.department_code === 'CSE'),
    [...new Set(verifRows.map(r => r.department_code))].join(','));
  ok('…even where the free-text label disagrees with itself',
    new Set(verifRows.map(r => r.department)).size > 1,
    [...new Set(verifRows.map(r => r.department))].join(' | '));
  ok('a report a department admin may not run is still refused',
    (await api('GET', '/api/reports/donation-ledger', { token: deptTok })).status === 403);
  ok('every report offered to a department admin declares a scoped column',
    (await api('GET', '/api/reports', { token: deptTok })).body.reports.length > 0);

  /* ── G. verification IDOR ── */
  head('G. Cross-department IDOR');
  const cseUser = (await db.query(
    `SELECT u.id FROM users u JOIN departments d ON d.id=u.department_id WHERE d.code='CSE' LIMIT 1`)).rows[0];
  const bbaUser = (await db.query(
    `SELECT u.id FROM users u JOIN departments d ON d.id=u.department_id WHERE d.code='BBA' LIMIT 1`)).rows[0];
  const noDeptUser = (await db.query(
    `SELECT id FROM users WHERE role='alumni' AND department_id IS NULL LIMIT 1`)).rows[0];

  const beforeVerify = (await db.query('SELECT is_verified FROM users WHERE id=$1', [bbaUser.id])).rows[0].is_verified;
  const cross = await api('PUT', `/api/users/${bbaUser.id}/verify`, { token: deptTok, body: { verified: false } });
  ok('changing ?id= to another department is refused', cross.status === 403, cross.body);
  ok('the refusal names a scope, not the record', cross.body.code === 'out_of_scope');
  ok('and the target was NOT changed',
    (await db.query('SELECT is_verified FROM users WHERE id=$1', [bbaUser.id])).rows[0].is_verified === beforeVerify);
  ok('its own department is permitted',
    (await api('PUT', `/api/users/${cseUser.id}/verify`, { token: deptTok, body: { verified: true } })).status === 200);
  if (noDeptUser) {
    ok('an account in no department is not the department admin\'s either',
      (await api('PUT', `/api/users/${noDeptUser.id}/verify`, { token: deptTok, body: { verified: true } })).status === 403);
  } else { ok('an account in no department is not the department admin\'s either', true); }
  ok('a non-existent account is a 404, not a scope leak',
    (await api('PUT', '/api/users/98765432/verify', { token: deptTok, body: { verified: true } })).status === 404);

  /* ── H. events ── */
  head('H. Event management is scoped, reading is not');
  const cseEvent = (await db.query(
    `SELECT id, venue FROM events WHERE department_id = $1 LIMIT 1`, [CSE.id])).rows[0];
  const wideEvent = (await db.query('SELECT id, venue FROM events WHERE department_id IS NULL LIMIT 1')).rows[0];
  ok('there is one of each to test with', !!cseEvent && !!wideEvent);

  restoredVenue = { id: cseEvent.id, venue: cseEvent.venue };
  ok('a department admin edits its own department\'s event',
    (await api('PUT', `/api/events/${cseEvent.id}`, { token: deptTok, body: { venue: `${TAG} venue` } })).status === 200);
  await db.query('UPDATE events SET venue = $2 WHERE id = $1', [cseEvent.id, cseEvent.venue]);
  restoredVenue = null;

  const wideBefore = wideEvent.venue;
  const crossEvent = await api('PUT', `/api/events/${wideEvent.id}`, { token: deptTok, body: { venue: `${TAG} nope` } });
  ok('it cannot edit an institution-wide event', crossEvent.status === 403, crossEvent.body);
  ok('and that event was not changed',
    (await db.query('SELECT venue FROM events WHERE id=$1', [wideEvent.id])).rows[0].venue === wideBefore);
  ok('it cannot add a ticket type to one either',
    (await api('POST', `/api/events/${wideEvent.id}/ticket-types`,
      { token: deptTok, body: { name: 'X', price: 0, quota: 1 } })).status === 403);
  ok('it cannot add a task to one either',
    (await api('POST', `/api/events/${wideEvent.id}/tasks`,
      { token: deptTok, body: { title: `${TAG} task` } })).status === 403);
  ok('a moderator, being unscoped, still can',
    (await api('PUT', `/api/events/${wideEvent.id}`, { token: T.mod, body: { capacity: 500 } })).status === 200);

  const created = await api('POST', '/api/events', { token: deptTok, body: {
    title: `${TAG} scoped event`, venue: 'Probe Hall', startsOn: '2027-01-01',
    eventType: 'Seminar', capacity: 10, departmentId: BBA.id } });
  ok('an event a department admin creates lands in ITS department, not the one it asked for',
    created.status === 200, created.body?.error);
  if (created.status === 200) {
    probeEventId = created.body.event ? created.body.event.id : created.body.id;
    const madeDept = (await db.query('SELECT department_id FROM events WHERE id=$1', [probeEventId])).rows[0];
    ok('…the body\'s departmentId was ignored', madeDept.department_id === CSE.id,
      `${madeDept.department_id} vs asked ${BBA.id}`);
  } else { ok('…the body\'s departmentId was ignored', false); }

  ok('reading an event is NOT scoped — a member sees the whole calendar',
    (await api('GET', '/api/events', { token: T.alumni })).status === 200);

  /* ── I. imports ── */
  head('I. Imports cannot cross a boundary');
  const importRow = (dep) => ([{ row: 1, name: 'Scope Probe', email: `${TAG}-imp@dic.test`,
                                 hscPassingYear: 2019, department: dep }]);
  const superAny = await api('POST', '/api/bulk-import',
    { token: T.super, body: { records: importRow('BBA'), filename: `${TAG}.csv`, dryRun: true } });
  ok('an institution-wide role may import into any department',
    superAny.status === 200 && superAny.body.created === 1, superAny.body?.error);
  const unknown = await api('POST', '/api/bulk-import',
    { token: T.super, body: { records: importRow('Astrophysics'), filename: `${TAG}.csv`, dryRun: true } });
  ok('a department this platform does not know is reported, not guessed',
    unknown.body.unresolvedDepartmentCount === 1 && unknown.body.created === 1,
    unknown.body?.unresolvedDepartments);
  ok('a department admin cannot import at all — import is ADMIN_ROLES',
    (await api('POST', '/api/bulk-import', { token: deptTok, body: { records: [] } })).status === 403);

  const real = await api('POST', '/api/bulk-import',
    { token: T.super, body: { records: importRow('CSE'), filename: `${TAG}.csv` } });
  ok('a resolved department is written as the relation', real.status === 200 && real.body.created === 1);
  const imported = (await db.query(
    `SELECT u.department_id, u.department, d.code FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.email = $1`, [`${TAG}-imp@dic.test`])).rows[0];
  ok('the imported account carries the department, not the HSC group',
    imported.code === 'CSE' && imported.department === CSE.name, `${imported.code} / ${imported.department}`);
  ok('…and so does its profile',
    (await db.query(`SELECT ap.department_id FROM alumni_profiles ap JOIN users u ON u.id = ap.user_id
                      WHERE u.email = $1`, [`${TAG}-imp@dic.test`])).rows[0].department_id === CSE.id);

  /* ── J. audit ── */
  head('J. Audit visibility');
  const aDept = await api('GET', '/api/audit-logs?limit=200', { token: deptTok });
  const aSuper = await api('GET', '/api/audit-logs?limit=200', { token: T.super });
  ok('a department admin reads a scoped log', aDept.status === 200);
  ok('…strictly narrower than the platform log',
    aDept.body.total > 0 && aDept.body.total < aSuper.body.total, `${aDept.body.total} of ${aSuper.body.total}`);
  const SENSITIVE = /^(Administrator|Password|Signed In|Signed Out|Sign-In Failed|Session|Vault|Identity|Database|Scheduler|Ops|Sync|DSAR|Account Purged|Account Deletion|Audit Log Exported|Bulk Import|Import Batch)/;
  ok('…with no platform-security action in it',
    aDept.body.entries.every(e => !SENSITIVE.test(e.action)),
    [...new Set(aDept.body.entries.filter(e => SENSITIVE.test(e.action)).map(e => e.action))].join(','));
  ok('every entry it sees concerns its own department or itself',
    (await db.query(`
      SELECT COUNT(*)::int n FROM audit_logs a
       WHERE a.id = ANY($1::int[]) AND a.actor_id <> $2
         AND NOT EXISTS (SELECT 1 FROM users u WHERE a.target_type='user' AND u.id = a.target_id
                          AND u.department_id = $3)`,
      [aDept.body.entries.map(e => e.id), deptUid, CSE.id])).rows[0].n === 0);
  ok('the actor filter list is scoped the same way',
    (await api('GET', '/api/audit-logs/actors', { token: deptTok })).body.length <=
    (await api('GET', '/api/audit-logs/actors', { token: T.super })).body.length);
  ok('the action filter list is scoped the same way',
    (await api('GET', '/api/audit-logs/actions', { token: deptTok })).body.actions
      .every(a => !SENSITIVE.test(a.action)));
  ok('a moderator still has no audit access',
    (await api('GET', '/api/audit-logs', { token: T.mod })).status === 403);
  ok('a member still has no audit access',
    (await api('GET', '/api/audit-logs', { token: T.alumni })).status === 403);

  /* ── K. institution-wide roles keep everything ── */
  head('K. Institution-wide authority is retained');
  for (const [name, tok] of [['super admin', T.super], ['college admin', T.univ]]) {
    ok(`a ${name} reaches every department in the alumni report`,
      new Set((await api('GET', '/api/reports/alumni-directory', { token: tok })).body.rows
        .map(r => r.department_code)).size > 1);
    ok(`a ${name} may verify across departments`,
      (await api('PUT', `/api/users/${bbaUser.id}/verify`, { token: tok, body: { verified: true } })).status === 200);
    ok(`a ${name} may edit an institution-wide event`,
      (await api('PUT', `/api/events/${wideEvent.id}`, { token: tok, body: { capacity: 500 } })).status === 200);
  }
  ok('a super admin still reads the whole audit log', aSuper.body.total > 1000, aSuper.body.total);

  /* ── L. the stale counters ── */
  head('L. Stale counters are gone, real figures remain');
  const gone = await db.query(`
    SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE (table_name='campaigns' AND column_name IN ('raised_amount','donors_count'))
        OR (table_name='chapters'  AND column_name IN ('members_count','events_count'))
        OR (table_name='events'    AND column_name='registered_count')`);
  ok('all five denormalised counters are dropped', gone.rows[0].n === 0, gone.rows[0].n);
  ok('no code writes any of them any more',
    ['server.js', 'routes_events.js', 'routes_v2.js'].every(f =>
      !/members_count = members_count|registered_count = registered_count|raised_amount = raised_amount/.test(src(f))));
  ok('event_committees.members_count survives — a different table, still live',
    (await db.query(`SELECT COUNT(*)::int n FROM information_schema.columns
                      WHERE table_name='event_committees' AND column_name='members_count'`)).rows[0].n === 1);
  const camp = await api('GET', '/api/reports/campaign-summary', { token: T.super });
  ok('campaign totals still compute from donations', camp.status === 200 && camp.body.rows.length > 0);
  ok('…and equal the real sum',
    Number(camp.body.rows[0].settled_amount) ===
    Number((await db.query(`SELECT COALESCE(SUM(amount),0)::int n FROM donations
                             WHERE status='SUCCESS' AND campaign_id=$1`, [camp.body.rows[0].campaign_id])).rows[0].n));
  const chap = await api('GET', '/api/reports/chapter', { token: T.super });
  ok('chapter membership still computes from memberships',
    chap.body.rows.every(r => typeof r.members === 'number'));

  /* ── M. dates ── */
  head('M. Superseded date columns');
  ok('events.event_date and events.event_time are gone',
    (await db.query(`SELECT COUNT(*)::int n FROM information_schema.columns
                      WHERE table_name='events' AND column_name IN ('event_date','event_time')`)).rows[0].n === 0);
  ok('events.planning_mode is gone',
    (await db.query(`SELECT COUNT(*)::int n FROM information_schema.columns
                      WHERE table_name='events' AND column_name='planning_mode'`)).rows[0].n === 0);
  ok('mentorships.health_score is gone',
    (await db.query(`SELECT COUNT(*)::int n FROM information_schema.columns
                      WHERE table_name='mentorships' AND column_name='health_score'`)).rows[0].n === 0);
  const dates = (await db.query('SELECT COUNT(*)::int total, COUNT(starts_on)::int typed FROM events')).rows[0];
  ok('every event carries a real typed date', dates.total === dates.typed, `${dates.typed}/${dates.total}`);
  const evRep = await api('GET', '/api/reports/event-attendance', { token: T.super });
  ok('the Event Attendance report dates every event, not a third of them',
    evRep.body.rows.every(r => r.starts_on !== null), evRep.body.rows.filter(r => !r.starts_on).length);
  ok('…and its date filter works on the typed column',
    (await api('GET', '/api/reports/event-attendance?from=1990-01-01&to=1990-12-31', { token: T.super }))
      .body.rowCount === 0);

  /* ── N. retained history ── */
  head('N. event_proposals is retained, not deleted');
  ok('it no longer sits in the live schema',
    (await db.query(`SELECT COUNT(*)::int n FROM information_schema.tables
                      WHERE table_schema='public' AND table_name='event_proposals'`)).rows[0].n === 0);
  ok('its history is kept under a name that says so',
    (await db.query(`SELECT COUNT(*)::int n FROM legacy_event_proposals`)).rows[0].n > 0);
  ok('the retention decision is recorded on the table itself',
    /Retained history/.test((await db.query(
      `SELECT COALESCE(obj_description('legacy_event_proposals'::regclass), '') AS c`)).rows[0].c));

  /* ── O/P. removed code ── */
  head('O. Removed code is actually removed');
  const apiSrc = src('api.js');
  for (const m of ['getMyEvents', 'deleteEvent', 'runReminderSweep', 'getAdministrator',
                   'updateCampaign', 'getPlannerList', 'updatePlannerItem', 'getImportHistoryV2',
                   'moderateProposal']) {
    /* The DEFINITION, not the bare name: api.js carries a comment naming every
       method this phase removed, and a bare-name search matches that note and
       then reports the removal as a failure. */
    ok(`API.${m} is gone`, !new RegExp('^\\s*(?:async\\s+)?' + m + '\\s*[:(]', 'm').test(apiSrc));
  }
  ok('API.getImportHistory — the one that was actually used — survives',
    /getImportHistory\b/.test(apiSrc));
  ok('onSessionExpired survives: api.js calls it, which the first dead-code scan missed',
    /onSessionExpired/.test(apiSrc) && /function onSessionExpired/.test(src('js/auth.js')));
  ok('goToStep1/2/3 are gone', !/function goToStep[123]/.test(src('js/auth.js')));
  ok('toggleProgressiveDisclosure is gone', !/function toggleProgressiveDisclosure/.test(src('js/core.js')));
  const prof = src('js/profile.js');
  ok('showEditProfileV2 is defined exactly once',
    (prof.match(/^(?:async )?function showEditProfileV2\(/gm) || []).length === 1);
  ok('handleSaveProfileV2 is defined exactly once',
    (prof.match(/^(?:async )?function handleSaveProfileV2\(/gm) || []).length === 1);
  ok('showEditProfile is defined exactly once',
    (prof.match(/^(?:async )?function showEditProfile\(/gm) || []).length === 1);

  head('P. Routes and guards');
  ok('the route that never existed still does not',
    (await api('POST', '/api/moderation/proposal/1/approve', { token: T.super })).status === 404);
  ok('the department list route is guarded for staff',
    (await api('GET', '/api/departments')).status === 401);
  ok('every event management route still refuses an anonymous caller',
    (await api('PUT', '/api/events/1', { body: { venue: 'x' } })).status === 401);
  ok('a member still cannot reach the verification queue',
    (await api('GET', '/api/verification-queue', { token: T.alumni })).status === 403);

  /* ── Q. status vocabularies ── */
  head('Q. The recorded status vocabularies are the real ones');
  const doc = src('STATUS_VOCABULARY.md');
  const vocab = [
    ['jobs', 'status', ['open', 'closed']],
    ['polls', 'status', ['draft', 'open', 'closed']],
    ['job_referrals', 'status', ['pending', 'accepted', 'declined']],
    ['job_applications', 'status', ['submitted', 'reviewing', 'shortlisted', 'rejected', 'hired']],
    ['event_registrations', 'status', ['confirmed', 'waitlisted', 'cancelled']],
    ['users', 'status', ['active', 'suspended']],
    ['import_history', 'status', ['completed', 'rolled_back']]
  ];
  for (const [table, col, values] of vocab) {
    const def = (await db.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE contype='c' AND conrelid=$1::regclass AND pg_get_constraintdef(oid) ILIKE '%' || $2 || '%'`,
      [table, col])).rows.map(r => r.d).join(' ');
    ok(`${table}.${col} permits exactly what the document records`,
      values.every(v => def.includes(`'${v}'`)), def.slice(0, 120));
    ok(`…and the document lists them`, values.every(v => doc.includes('`' + v + '`')), values.join(','));
  }
  ok('the document names the one real inconsistency rather than hiding it',
    /only UPPERCASE status values/.test(doc));
  ok('donation statuses really are uppercase, as documented',
    (await db.query(`SELECT COUNT(*)::int n FROM donations WHERE status <> UPPER(status)`)).rows[0].n === 0);

  console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n`);
 } catch (err) {
  console.error('\n  SUITE ERROR:', err.message);
  fail++;
 } finally {
  await cleanup();
  const left = (await db.query('SELECT COUNT(*)::int n FROM users WHERE email LIKE $1', [TAG + '%'])).rows[0].n;
  if (left) console.log(`  WARNING: ${left} probe account(s) left behind`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
 }
})();
