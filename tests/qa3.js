const path = require('path');
const REPO = path.join(__dirname, '..');
// PHASE 0: the shared demo password no longer exists. Credentials now come from
// the gitignored file written by rotate_credentials.js.
const __CREDS = (() => {
  const out = {};
  for (const l of require('fs').readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) out[m[2]] = m[3];
  }
  return out;
})();
const PW = (email) => __CREDS[email] || 'no-such-password';

/* QA pass 3 — external people, mixed task assignment, notification rule.
   Creates its own event so nothing existing is disturbed; cleans up in a
   finally block so a mid-run failure cannot leak rows. */
const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const db = require(path.join(REPO, 'db.js'));
const crypto = require('crypto');

let pass = 0, fail = 0; const lines = [];
const check = (l, c, d) => { if (c) { pass++; lines.push('  ok   ' + l); }
  else { fail++; lines.push('  FAIL ' + l + (d ? ' — ' + d : '')); } };
const section = (t) => lines.push('\n── ' + t + ' ──');

const tok = {};
async function api(method, path, { as, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as && tok[as]) headers.Authorization = 'Bearer ' + tok[as];
  const res = await fetch(BASE + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(k, e) {
  const r = await api('POST', '/api/auth/login', { body: { email: e, password: PW(e) } });
  if (r.status !== 200) throw new Error('login ' + e + ': ' + r.status);
  tok[k] = r.body.token; return r.body.user;
}
const TAG = 'QA3 ' + crypto.randomBytes(3).toString('hex');
let eventId = null, otherEventId = null;

(async () => {
  const staff = Object.fromEntries((await db.query(
    "SELECT role, email FROM users WHERE role<>'alumni'")).rows.map(r => [r.role, r.email]));
  const alumni = (await db.query(
    'SELECT u.id, u.email, u.full_name FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id ORDER BY u.id LIMIT 3')).rows;

  const admin = await login('admin', staff.univ_admin);
  await login('alumni', alumni[0].email);
  for (const a of alumni) await login('u' + a.id, a.email);

  const startsOn = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  eventId = (await api('POST', '/api/events', { as: 'admin', body: {
    title: TAG + ' Event', venue: 'QA Venue', startsOn, capacity: 50, eventType: 'Gala' } })).body.id;
  otherEventId = (await api('POST', '/api/events', { as: 'admin', body: {
    title: TAG + ' Other', venue: 'QA Venue 2', startsOn, capacity: 20 } })).body.id;

  /* ── 12/13. EXTERNAL PERSON ── */
  section('12/13. EXTERNAL PERSON — creation, validation, isolation');

  const usersBefore = (await db.query('SELECT COUNT(*)::int n FROM users')).rows[0].n;
  const profBefore  = (await db.query('SELECT COUNT(*)::int n FROM alumni_profiles')).rows[0].n;

  const noName = await api('POST', `/api/events/${eventId}/external-people`,
    { as: 'admin', body: { roleTitle: 'Decorator' } });
  check('full name is required', noName.status === 400, 'got ' + noName.status);
  const noRole = await api('POST', `/api/events/${eventId}/external-people`,
    { as: 'admin', body: { name: 'Someone' } });
  check('role on event is required', noRole.status === 400, 'got ' + noRole.status);

  const ext = await api('POST', `/api/events/${eventId}/external-people`, { as: 'admin', body: {
    name: 'Rahim Decorators', roleTitle: 'Event Decorator', phone: '01711223344',
    whatsapp: '01711223344', organization: 'Rahim Decor Ltd',
    departmentArea: 'Stage & Decor', notes: 'Bring extra lighting.' } });
  check('external person created', ext.status === 200, JSON.stringify(ext.body).slice(0, 100));
  const extId = ext.body.id;
  check('stored as external with no user account',
    ext.body.person_type === 'external' && ext.body.user_id === null);
  check('all external fields stored',
    ext.body.name === 'Rahim Decorators' && ext.body.role_title === 'Event Decorator' &&
    ext.body.phone === '01711223344' && ext.body.whatsapp === '01711223344' &&
    ext.body.organization === 'Rahim Decor Ltd' && ext.body.department_area === 'Stage & Decor' &&
    !!ext.body.notes);
  check('created_by recorded on the external row', ext.body.added_by === admin.id, String(ext.body.added_by));
  check('scoped to this event', ext.body.event_id === eventId);

  const usersAfter = (await db.query('SELECT COUNT(*)::int n FROM users')).rows[0].n;
  const profAfter  = (await db.query('SELECT COUNT(*)::int n FROM alumni_profiles')).rows[0].n;
  check('NO fake user account created', usersAfter === usersBefore, `${usersBefore} -> ${usersAfter}`);
  check('NOT inserted into the alumni directory', profAfter === profBefore, `${profBefore} -> ${profAfter}`);

  const dirSearch = await api('GET', '/api/directory/search?q=Rahim', { as: 'admin' });
  check('external person does not appear in the DIC directory search',
    !(dirSearch.body.results || []).some(r => /Rahim Decorators/.test(r.name)));

  const dup = await api('POST', `/api/events/${eventId}/external-people`,
    { as: 'admin', body: { name: 'Rahim Decorators', roleTitle: 'Other' } });
  check('duplicate external name on the same event refused', dup.status === 409, 'got ' + dup.status);

  const ext2 = await api('POST', `/api/events/${eventId}/external-people`, { as: 'admin', body: {
    name: 'Karim Catering', roleTitle: 'Caterer', phone: '01822334455' } });
  check('a second external contact can be added', ext2.status === 200);
  const ext2Id = ext2.body.id;

  const alumniTry = await api('POST', `/api/events/${eventId}/external-people`,
    { as: 'alumni', body: { name: 'X', roleTitle: 'Y' } });
  check('alumni cannot add external people', alumniTry.status === 403, 'got ' + alumniTry.status);

  const edit = await api('PUT', `/api/events/external-people/${ext2Id}`,
    { as: 'admin', body: { roleTitle: 'Head Caterer', whatsapp: '01822334455' } });
  check('external contact can be edited',
    edit.status === 200 && edit.body.role_title === 'Head Caterer' && edit.body.whatsapp === '01822334455');
  const blankName = await api('PUT', `/api/events/external-people/${ext2Id}`,
    { as: 'admin', body: { name: '  ' } });
  check('external name cannot be blanked', blankName.status === 400, 'got ' + blankName.status);

  /* ── 17. PEOPLE LIST ── */
  section('17. PEOPLE — both kinds in one list, correctly typed');
  await api('POST', `/api/events/${eventId}/people`,
    { as: 'admin', body: { userIds: [alumni[0].id], roleInEvent: 'coordinator' } });

  const people = (await api('GET', `/api/events/${eventId}/people`, { as: 'admin' })).body;
  const dic = people.filter(p => p.person_type === 'directory');
  const externals = people.filter(p => p.person_type === 'external');
  check('list contains both kinds', dic.length === 1 && externals.length === 2,
    `${dic.length} dic / ${externals.length} external`);
  check('DIC person is flagged notifiable', dic[0].notifiable === true);
  check('external people are flagged not notifiable', externals.every(p => p.notifiable === false));
  check('DIC person resolves name from the account', !!dic[0].name && !!dic[0].student_id);
  check('external person carries its own name, role, phone, organization',
    externals.some(p => p.name === 'Rahim Decorators' && p.role_label === 'Event Decorator' &&
                        p.phone === '01711223344' && p.organization === 'Rahim Decor Ltd'));

  /* ── 14/16. MIXED TASK ASSIGNMENT & NOTIFICATION RULE ── */
  section('14/16. TASK ASSIGNMENT — DIC + external, notifications for DIC only');

  const task = (await api('POST', `/api/events/${eventId}/tasks`,
    { as: 'admin', body: { title: 'QA mixed task', category: 'Venue' } })).body;

  const nBefore = (await db.query('SELECT COUNT(*)::int n FROM notifications')).rows[0].n;
  const asg = await api('POST', `/api/events/tasks/${task.id}/assignees`,
    { as: 'admin', body: { userIds: [alumni[0].id, alumni[1].id], eventPersonIds: [extId] } });
  const nAfter = (await db.query('SELECT COUNT(*)::int n FROM notifications')).rows[0].n;

  check('mixed assignment succeeds', asg.status === 200 && asg.body.added === 3,
    JSON.stringify({ s: asg.status, added: asg.body.added }));
  check('reports how many were notified vs external',
    asg.body.notified === 2 && asg.body.externalAdded === 1,
    `notified=${asg.body.notified} external=${asg.body.externalAdded}`);
  check('exactly 2 notifications sent — one per DIC user, none for the external contact',
    nAfter - nBefore === 2, `delta=${nAfter - nBefore}`);

  const extNotif = (await db.query(
    "SELECT COUNT(*)::int n FROM notifications WHERE subtitle LIKE '%Rahim%' OR title LIKE '%Rahim%'")).rows[0].n;
  check('no notification row references the external contact', extNotif === 0, String(extNotif));

  const list = asg.body.task.assignees;
  check('task reports three assignees', list.length === 3, String(list.length));
  check('each assignee carries a person_type badge',
    list.filter(a => a.person_type === 'directory').length === 2 &&
    list.filter(a => a.person_type === 'external').length === 1);
  const extA = list.find(a => a.person_type === 'external');
  check('external assignee exposes contact details for Call/WhatsApp',
    extA.phone === '01711223344' && extA.whatsapp === '01711223344');
  check('external assignee is marked not notifiable', extA.notifiable === false);
  check('external assignee carries its event_person_id, not a user_id',
    extA.event_person_id === extId && extA.user_id === null);
  check('DIC assignees are marked notifiable',
    list.filter(a => a.person_type === 'directory').every(a => a.notifiable === true));

  const again = await api('POST', `/api/events/tasks/${task.id}/assignees`,
    { as: 'admin', body: { eventPersonIds: [extId] } });
  check('re-assigning the same external is a no-op', again.body.added === 0, String(again.body.added));

  const otherTask = (await api('POST', `/api/events/${otherEventId}/tasks`,
    { as: 'admin', body: { title: 'QA other-event task' } })).body;
  const cross = await api('POST', `/api/events/tasks/${otherTask.id}/assignees`,
    { as: 'admin', body: { eventPersonIds: [extId] } });
  check("an external contact cannot be assigned to another event's task",
    cross.body.added === 0, String(cross.body.added));

  const rm = await api('DELETE', `/api/events/tasks/${task.id}/assignees/person/${extId}`, { as: 'admin' });
  check('external assignee can be removed',
    rm.status === 200 && rm.body.assignees.filter(a => a.person_type === 'external').length === 0);
  check('removing the external leaves the DIC assignees intact',
    rm.body.assignees.length === 2, String(rm.body.assignees.length));

  /* deleting an external person removes their assignments */
  await api('POST', `/api/events/tasks/${task.id}/assignees`,
    { as: 'admin', body: { eventPersonIds: [ext2Id] } });
  const delPerson = await api('DELETE', `/api/events/people/${ext2Id}`, { as: 'admin' });
  check('deleting an external contact succeeds', delPerson.status === 200);
  const orphan = (await db.query(
    'SELECT COUNT(*)::int n FROM event_task_assignees WHERE event_person_id=$1', [ext2Id])).rows[0].n;
  check('their task assignments cascade away', orphan === 0, String(orphan));

  /* deleting the event removes external people with it */
  const extCountBefore = (await db.query(
    "SELECT COUNT(*)::int n FROM event_people WHERE person_type='external' AND event_id=$1", [eventId])).rows[0].n;
  check('external contact still attached to its event before deletion', extCountBefore === 1, String(extCountBefore));

  console.log(lines.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
})()
.catch(e => { console.log(lines.join('\n')); console.error('\nHARNESS ERROR: ' + e.message); fail++; })
.finally(async () => {
  // Always clean up, even if an assertion threw.
  try {
    const ids = [eventId, otherEventId].filter(Boolean);
    if (ids.length) {
      await db.query("DELETE FROM notifications WHERE link_entity IN ('event','ticket') AND link_id = ANY($1)", [ids]);
      await db.query(`DELETE FROM notifications WHERE link_entity='task' AND link_id IN
                        (SELECT id FROM event_tasks WHERE event_id = ANY($1))`, [ids]);
      await db.query('DELETE FROM events WHERE id = ANY($1)', [ids]);
    }
    await db.query("DELETE FROM event_people WHERE person_type='external' AND name IN ('Rahim Decorators','Karim Catering')");
  /* Audit entries are append-only from Phase 5A: the chain links each entry
     to the previous one, so deleting any row breaks verification for every
     entry after it. Test rows are left in place deliberately — an audit trail
     that tests can prune is not an audit trail. */
  // (removed) await db.query("DELETE FROM audit_logs WHERE meta LIKE '%QA3 %' OR meta LIKE '%Rahim Decorators%' OR meta LIKE '%Karim Catering%'");
    console.log('cleanup: QA3 events and external contacts removed');
  } catch (e) { console.error('cleanup failed:', e.message); }
  await db.pool.end();
  process.exit(fail ? 1 : 0);
});
