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

/* QA pass 2 — task lifecycle & field permissions, status/progress transitions,
   notifications, ticketing, empty & error states. Cleans up after itself. */
const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const db = require(path.join(REPO, 'db.js'));
const crypto = require('crypto');

let pass = 0, fail = 0; const lines = [];
const check = (label, cond, detail) => {
  if (cond) { pass++; lines.push(`  ok   ${label}`); }
  else { fail++; lines.push(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => lines.push(`\n── ${t} ──`);

const tok = {};
async function api(method, path, { as, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as && tok[as]) headers.Authorization = `Bearer ${tok[as]}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(key, email) {
  const r = await api('POST', '/api/auth/login', { body: { email, password: PW(email) } });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  tok[key] = r.body.token; return r.body.user;
}
const notifCount = async (uid, title, entity, id) => (await db.query(
  `SELECT COUNT(*)::int n FROM notifications
    WHERE ($1::int IS NULL OR user_id=$1) AND title=$2 AND link_entity=$3 AND link_id=$4`,
  [uid, title, entity, id])).rows[0].n;

const QA_TAG = 'QA2 ' + crypto.randomBytes(3).toString('hex');

(async () => {
  const staff = Object.fromEntries((await db.query(
    `SELECT role, email FROM users WHERE role<>'alumni'`)).rows.map(r => [r.role, r.email]));
  const alumni = (await db.query(
    `SELECT u.id, u.email, u.full_name, ap.student_id, ap.mobile_number
       FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id ORDER BY u.id LIMIT 6`)).rows;

  const admin = await login('admin', staff.univ_admin);
  await login('super', staff.super_admin);
  await login('mod', staff.moderator);
  for (const a of alumni) await login('u' + a.id, a.email);
  const [A, B, C, D] = alumni;

  /* ════════ 3. CREATE EVENT ════════ */
  section('3. CREATE EVENT');
  const startsOn = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const opens = new Date(Date.now() - 1 * 864e5).toISOString().slice(0, 16); // already open
  const closes = new Date(Date.now() + 50 * 864e5).toISOString().slice(0, 16);

  const bad = [
    ['no title',   { venue: 'V', startsOn }],
    ['no venue',   { title: QA_TAG, startsOn }],
    ['no date',    { title: QA_TAG, venue: 'V' }],
    ['bad date',   { title: QA_TAG, venue: 'V', startsOn: 'not-a-date' }],
    ['paid with no ticket types', { title: QA_TAG, venue: 'V', startsOn, isPaid: true, ticketTypes: [] }],
    ['ticket type with no name',  { title: QA_TAG, venue: 'V', startsOn, isPaid: true, ticketTypes: [{ name: '', price: 1 }] }]
  ];
  for (const [label, body] of bad) {
    const r = await api('POST', '/api/events', { as: 'admin', body });
    check(`validation rejects: ${label}`, r.status === 400, `got ${r.status} ${JSON.stringify(r.body).slice(0,80)}`);
  }

  const created = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} Gala`, description: 'QA description.', eventType: 'Gala',
    startsOn, startTime: '18:00', endTime: '22:00', venue: 'QA Hall',
    capacity: 4, organizerDepartment: 'QA Dept', visibility: 'alumni', isPaid: true,
    waitlistEnabled: true, registrationOpensAt: opens, registrationClosesAt: closes,
    // Free: Phase 3 blocks registration for priced tickets (no gateway exists),
    // and this section tests the ticket lifecycle, not pricing. A priced type
    // is added below purely to assert that the refusal fires.
    ticketTypes: [{ name: 'Alumni', price: 0, quota: 2 }, { name: 'Student', price: 0, quota: 1 },
                  { name: 'Paid', price: 750, quota: 5 }]
  }});
  check('event created', created.status === 200, JSON.stringify(created.body).slice(0, 120));
  const ev = created.body, eventId = ev.id;

  check('created_by is the caller', ev.created_by === admin.id, String(ev.created_by));
  check('created_at populated', !!ev.created_at);
  check('initial run status is upcoming', ev.status === 'upcoming', ev.status);
  check('univ_admin creation is auto-approved', ev.approval_status === 'approved', ev.approval_status);
  check('approved_by / approved_at set on auto-approval', !!ev.approved_by && !!ev.approved_at);
  check('capacity honoured', ev.capacity === 4, String(ev.capacity));
  check('registration window stored',
    !!ev.registration_opens_at && !!ev.registration_closes_at);
  check('three ticket types created', (ev.ticket_types || []).length === 3);
  check('start/end time stored', ev.start_time === '18:00:00' && ev.end_time === '22:00:00',
    `${ev.start_time}/${ev.end_time}`);
  check('no emoji column written', !ev.emoji || ev.emoji === '🎓', String(ev.emoji));

  const capOverride = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} QuotaSum`, venue: 'V', startsOn, isPaid: true,
    ticketTypes: [{ name: 'A', price: 1, quota: 7 }, { name: 'B', price: 1, quota: 3 }] }});
  check('capacity falls back to the sum of quotas', capOverride.body.capacity === 10,
    String(capOverride.body.capacity));

  /* ════════ 4/5. TASK LIFECYCLE ════════ */
  section('4/5. TASKS — fields, assignees, permissions, transitions');

  const t = await api('POST', `/api/events/${eventId}/tasks`, { as: 'admin', body: {
    title: 'QA task', description: 'QA task description', category: 'Venue',
    priority: 'high', dueOn: startsOn } });
  check('task created', t.status === 200, JSON.stringify(t.body).slice(0, 100));
  const taskId = t.body.id;
  check('title stored', t.body.title === 'QA task');
  check('description stored', t.body.description === 'QA task description');
  check('category stored', t.body.category === 'Venue');
  check('deadline stored as a date', String(t.body.due_on).slice(0, 10) === startsOn, String(t.body.due_on));
  check('priority stored', t.body.priority === 'high');
  check('initial status is todo', t.body.status === 'todo');
  check('initial progress is 0', t.body.progress === 0);
  check('created_by recorded', !!t.body.created_by_name);

  // three assignees
  const three = [A.id, B.id, C.id];
  const asg = await api('POST', `/api/events/tasks/${taskId}/assignees`, { as: 'admin', body: { userIds: three } });
  check('three assignees attached', asg.body.added === 3, JSON.stringify(asg.body).slice(0, 80));
  check('task reports three assignees', asg.body.task.assignees.length === 3);
  for (const uid of three) {
    check(`assignee ${uid} got an individual notification`,
      (await notifCount(uid, 'You were assigned a task', 'task', taskId)) === 1);
  }
  const detail = await api('GET', `/api/events/tasks/${taskId}`, { as: 'u' + A.id });
  check('deep link opens the exact task', detail.status === 200 && detail.body.id === taskId);
  check('assignee sees contact fields on co-assignees',
    detail.body.assignees.every(x => 'phone' in x && 'whatsapp' in x));

  // notes & checklist
  const note = await api('POST', `/api/events/tasks/${taskId}/notes`, { as: 'u' + A.id, body: { body: 'QA note' } });
  check('assignee can add a note', note.status === 200 && note.body.body === 'QA note');
  check('note records its author', !!note.body.author, String(note.body.author));
  const emptyNote = await api('POST', `/api/events/tasks/${taskId}/notes`, { as: 'u' + A.id, body: { body: '  ' } });
  check('empty note rejected', emptyNote.status === 400);
  const cl = await api('POST', `/api/events/tasks/${taskId}/checklist`, { as: 'admin', body: { label: 'QA item' } });
  check('checklist item added', cl.status === 200);
  const clToggle = await api('PUT', `/api/events/tasks/checklist/${cl.body.id}`, { as: 'u' + A.id, body: { isDone: true } });
  check('assignee can tick a checklist item', clToggle.status === 200 && clToggle.body.is_done === true);

  // field-level permissions
  const denied = [
    ['title', { title: 'hacked' }], ['deadline', { dueOn: '2030-01-01' }],
    ['priority', { priority: 'low' }], ['category', { category: 'Budget' }]
  ];
  for (const [f, body] of denied) {
    const r = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body });
    check(`assignee cannot change ${f}`, r.status === 403, `got ${r.status}`);
  }
  const notAssignee = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + D.id, body: { progress: 50 } });
  check('a non-assignee alumnus cannot touch the task', notAssignee.status === 403, `got ${notAssignee.status}`);
  const noAssignRights = await api('POST', `/api/events/tasks/${taskId}/assignees`, { as: 'u' + A.id, body: { userIds: [D.id] } });
  check('assignee cannot modify the assignee list', noAssignRights.status === 403, `got ${noAssignRights.status}`);

  // transitions
  const s1 = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { status: 'in_progress', progress: 25 } });
  check('Not Started -> In Progress', s1.body.status === 'in_progress' && s1.body.progress === 25);
  const noReason = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { status: 'blocked' } });
  check('Blocked requires a reason', noReason.status === 400, `got ${noReason.status}`);
  const s2 = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { status: 'blocked', blockedReason: 'QA blocker' } });
  check('In Progress -> Blocked with a reason', s2.body.status === 'blocked' && s2.body.blocked_reason === 'QA blocker');
  check('organiser notified of the block',
    (await notifCount(admin.id, 'Task marked blocked', 'task', taskId)) === 1);
  const s3 = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { status: 'in_progress' } });
  check('Blocked -> In Progress', s3.body.status === 'in_progress');
  check('blocked reason cleared on resume', !s3.body.blocked_reason);
  const s4 = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { status: 'completed' } });
  check('In Progress -> Done', s4.body.status === 'completed');
  check('Done forces progress to 100', s4.body.progress === 100, String(s4.body.progress));
  check('completed_at populated', !!s4.body.completed_at);
  check('organiser notified of completion',
    (await notifCount(admin.id, 'Task marked done', 'task', taskId)) === 1);
  check('updated_by recorded', !!s4.body.updated_by_name, String(s4.body.updated_by_name));

  const reopen = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'admin', body: { status: 'in_progress' } });
  check('reopening a done task clears completed_at', !reopen.body.completed_at);
  await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { progress: 100 } });
  const auto = await api('GET', `/api/events/tasks/${taskId}`, { as: 'admin' });
  check('setting progress to 100 marks it done', auto.body.status === 'completed', auto.body.status);

  const badProgress = await api('PUT', `/api/events/tasks/${taskId}`, { as: 'u' + A.id, body: { progress: 150 } });
  check('progress above 100 rejected', badProgress.status === 400, `got ${badProgress.status}`);

  // verification
  const selfVerify = await api('PUT', `/api/events/tasks/${taskId}/verify`, { as: 'u' + A.id });
  check('assignee cannot verify', selfVerify.status === 403, `got ${selfVerify.status}`);
  const ver = await api('PUT', `/api/events/tasks/${taskId}/verify`, { as: 'admin' });
  check('organiser can verify a completed task', ver.status === 200 && !!ver.body.verified_at);
  check('verifier recorded', ver.body.verified_by === admin.id && !!ver.body.verified_by_name);
  for (const uid of three) {
    check(`assignee ${uid} notified of verification`,
      (await notifCount(uid, 'Task verified', 'task', taskId)) === 1);
  }
  const t2 = await api('POST', `/api/events/${eventId}/tasks`, { as: 'admin', body: { title: 'QA unfinished' } });
  const verOpen = await api('PUT', `/api/events/tasks/${t2.body.id}/verify`, { as: 'admin' });
  check('an unfinished task cannot be verified', verOpen.status === 409, `got ${verOpen.status}`);

  // moderator can manage
  const modEdit = await api('PUT', `/api/events/tasks/${t2.body.id}`, { as: 'mod', body: { priority: 'critical', dueOn: startsOn } });
  check('moderator can re-scope a task', modEdit.status === 200 && modEdit.body.priority === 'critical');
  const modDel = await api('DELETE', `/api/events/tasks/${t2.body.id}`, { as: 'mod' });
  check('moderator can delete a task', modDel.status === 200);

  /* ════════ 7. TICKETING ════════ */
  section('7. TICKETING');
  const types = (await api('GET', `/api/events/${eventId}/ticket-types`, { as: 'admin' })).body;
  const alumniT = types.find(x => x.name === 'Alumni'), studentT = types.find(x => x.name === 'Student');

  const r1 = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + A.id, body: { ticketTypeId: alumniT.id } });
  check('registration confirmed', r1.body.status === 'confirmed', JSON.stringify(r1.body).slice(0, 90));
  check('ticket code issued', /^DIC-TKT-/.test(r1.body.registration.ticket_code));
  check('signed QR payload issued', !!r1.body.registration.qr_payload);
  check('a free ticket records no amount', Number(r1.body.registration.amount_paid) === 0);
  check('ticket_type_id recorded', r1.body.registration.ticket_type_id === alumniT.id);
  check('registration notification sent',
    (await notifCount(A.id, 'Ticket confirmed', 'ticket', eventId)) === 1);

  const paidT = types.find(x => x.name === 'Paid');
  const paidReg = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + B.id, body: { ticketTypeId: paidT.id } });
  check('a priced ticket is refused while no gateway exists', paidReg.status === 409, `got ${paidReg.status}`);
  check('the refusal is machine-readable', paidReg.body.reason === 'online_payment_unavailable');

  const dup = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + A.id, body: {} });
  check('duplicate registration blocked', dup.status === 409, `got ${dup.status}`);

  const r2 = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + B.id, body: { ticketTypeId: studentT.id } });
  check('second ticket type works', r2.body.status === 'confirmed');
  const r3 = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + C.id, body: { ticketTypeId: studentT.id } });
  check('per-type quota enforced -> waitlisted', r3.body.status === 'waitlisted', r3.body.status);

  const r4 = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + D.id, body: { ticketTypeId: alumniT.id } });
  check('alumni quota consumed', r4.body.status === 'confirmed', r4.body.status);
  const fifth = alumni[4];
  const r5 = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + fifth.id, body: { ticketTypeId: alumniT.id } });
  check('event capacity enforced -> waitlisted', r5.body.status === 'waitlisted', r5.body.status);

  const wrongType = await api('POST', `/api/events/${eventId}/register`, { as: 'u' + alumni[5].id, body: { ticketTypeId: 999999 } });
  check('unknown ticket type rejected', wrongType.status === 400, `got ${wrongType.status}`);

  const cancel = await api('DELETE', `/api/events/${eventId}/register`, { as: 'u' + A.id });
  check('cancellation promotes from the waitlist', cancel.body.promoted === true, JSON.stringify(cancel.body));
  check('promoted person notified',
    (await notifCount(null, 'A seat opened up — you are in', 'ticket', eventId)) >= 1);

  const mine = await api('GET', `/api/events/${eventId}/my-ticket`, { as: 'u' + B.id });
  check('my-ticket returns the ticket with event context',
    mine.status === 200 && !!mine.body.ticket_code && !!mine.body.event_title);

  const payload = JSON.parse(mine.body.qr_payload);
  const expectSig = crypto.createHmac('sha256', process.env.ENCRYPTION_KEY || 'dic-ticket')
    .update(`${payload.t}:${payload.e}:${payload.u}`).digest('hex').slice(0, 16);
  check('QR signature is valid', payload.s === expectSig);

  const tampered = await api('POST', '/api/events/checkin', { as: 'admin',
    body: { ticketCode: JSON.stringify({ ...payload, s: '0000000000000000' }) } });
  check('tampered QR refused at check-in', tampered.status === 400, `got ${tampered.status}`);
  const scan = await api('POST', '/api/events/checkin', { as: 'admin', body: { ticketCode: mine.body.qr_payload } });
  check('scanned QR checks in', scan.status === 200 && scan.body.success);
  const again = await api('POST', '/api/events/checkin', { as: 'admin', body: { ticketCode: mine.body.ticket_code } });
  check('double check-in refused', again.status === 409, `got ${again.status}`);

  // pre-v5 tickets still validate
  const legacy = (await db.query(
    `SELECT ticket_code, qr_payload FROM event_registrations
      WHERE event_id <> $1 AND qr_payload IS NOT NULL ORDER BY id LIMIT 1`, [eventId])).rows[0];
  if (legacy) {
    const lp = JSON.parse(legacy.qr_payload);
    const sig = crypto.createHmac('sha256', process.env.ENCRYPTION_KEY || 'dic-ticket')
      .update(`${lp.t}:${lp.e}:${lp.u}`).digest('hex').slice(0, 16);
    check('pre-v5 QR ticket still validates', lp.s === sig, `${lp.s} vs ${sig}`);
  } else {
    check('pre-v5 QR ticket still validates (none present)', true);
  }

  const att = await api('GET', `/api/events/${eventId}/attendees`, { as: 'admin' });
  check('attendee list returns confirmed + waitlisted + cancelled',
    att.status === 200 && att.body.length >= 5, String(att.body.length));
  check('attendee rows carry ticket type and contact',
    att.body.every(a => 'ticket_type_name' in a && 'phone' in a));
  const csv = await api('GET', `/api/events/${eventId}/attendees.csv`, { as: 'admin' });
  check('attendee CSV exports', csv.status === 200 && String(csv.body).startsWith('name,email,phone'));
  check('CSV has one row per attendee',
    String(csv.body).trim().split('\n').length === att.body.length + 1,
    `${String(csv.body).trim().split('\n').length - 1} vs ${att.body.length}`);

  // registration window
  const closedEv = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} Closed`, venue: 'V', startsOn, capacity: 5,
    registrationClosesAt: new Date(Date.now() - 864e5).toISOString().slice(0, 16) } });
  const tooLate = await api('POST', `/api/events/${closedEv.body.id}/register`, { as: 'u' + A.id, body: {} });
  check('registration refused after the window closes', tooLate.status === 409, `got ${tooLate.status}`);

  const notOpenEv = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} NotOpen`, venue: 'V', startsOn, capacity: 5,
    registrationOpensAt: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 16) } });
  const tooEarly = await api('POST', `/api/events/${notOpenEv.body.id}/register`, { as: 'u' + A.id, body: {} });
  check('registration refused before the window opens', tooEarly.status === 409, `got ${tooEarly.status}`);

  const noWaitEv = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} NoWait`, venue: 'V', startsOn, capacity: 1, waitlistEnabled: false } });
  await api('POST', `/api/events/${noWaitEv.body.id}/register`, { as: 'u' + A.id, body: {} });
  const full = await api('POST', `/api/events/${noWaitEv.body.id}/register`, { as: 'u' + B.id, body: {} });
  check('waitlist off -> full event refuses registration', full.status === 409, `got ${full.status}`);

  const freeEv = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} Free`, venue: 'V', startsOn, capacity: 5, isPaid: false } });
  const freeReg = await api('POST', `/api/events/${freeEv.body.id}/register`, { as: 'u' + A.id, body: {} });
  check('free registration works and costs nothing',
    freeReg.body.status === 'confirmed' && Number(freeReg.body.registration.amount_paid) === 0);
  check('a free event still gets a default ticket type',
    (await api('GET', `/api/events/${freeEv.body.id}/ticket-types`, { as: 'admin' })).body.length === 1);

  const soldType = await api('DELETE', `/api/events/ticket-types/${alumniT.id}`, { as: 'admin' });
  check('a ticket type with issued tickets cannot be deleted', soldType.status === 409, `got ${soldType.status}`);

  /* ════════ 6. NOTIFICATION COVERAGE ════════ */
  section('6. NOTIFICATIONS — all eight kinds, in-app only');
  const pend = await api('POST', '/api/events', { as: 'mod', body: {
    title: `${QA_TAG} Pending`, venue: 'V', startsOn, capacity: 5 } });
  const modUser = (await db.query(`SELECT id FROM users WHERE role='moderator'`)).rows[0].id;
  await api('PUT', `/api/events/${pend.body.id}/approve`, { as: 'super' });
  check('event approved notification', (await notifCount(modUser, 'Event approved', 'event', pend.body.id)) === 1);

  const pend2 = await api('POST', '/api/events', { as: 'mod', body: {
    title: `${QA_TAG} Pending2`, venue: 'V', startsOn, capacity: 5 } });
  await api('PUT', `/api/events/${pend2.body.id}/reject`, { as: 'super', body: { reason: 'QA' } });
  check('event rejected notification', (await notifCount(modUser, 'Event sent back', 'event', pend2.body.id)) === 1);

  const cancelEv = await api('PUT', `/api/events/${freeEv.body.id}/cancel`, { as: 'super', body: { reason: 'QA cancel' } });
  check('event cancelled notification reaches ticket holders',
    cancelEv.status === 200 && (await notifCount(A.id, 'Event cancelled', 'event', freeEv.body.id)) === 1);

  const all = await db.query(
    `SELECT DISTINCT title, link_entity FROM notifications WHERE link_entity IS NOT NULL ORDER BY 1`);
  const kinds = all.rows.map(r => r.title);
  for (const k of ['You were assigned a task', 'Task marked blocked', 'Task marked done',
                   'Task verified', 'Event approved', 'Event sent back', 'Event cancelled',
                   'Ticket confirmed', 'A seat opened up — you are in']) {
    check(`notification kind exists: "${k}"`, kinds.includes(k), kinds.join(' | ').slice(0, 200));
  }
  const linked = await db.query(
    `SELECT COUNT(*)::int n FROM notifications WHERE link_entity IS NOT NULL AND link_id IS NULL`);
  check('every deep-linked notification has a target id', linked.rows[0].n === 0, String(linked.rows[0].n));

  const chans = await db.query(`SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE table_name='notifications' AND column_name IN ('email','sms','push')`);
  check('no email/sms/push columns introduced', chans.rows[0].n === 0, String(chans.rows[0].n));

  /* ════════ 11. EMPTY & ERROR STATES ════════ */
  section('11. EMPTY & ERROR STATES');
  const bare = await api('POST', '/api/events', { as: 'admin', body: {
    title: `${QA_TAG} Bare`, venue: 'V', startsOn, capacity: 5 } });
  const bareId = bare.body.id;

  const ov = await api('GET', `/api/events/${bareId}/overview`, { as: 'admin' });
  check('overview of an empty event returns zeros, not an error',
    ov.status === 200 && ov.body.tasks.total === 0 && ov.body.revenue === 0 && ov.body.peopleCount === 0);
  check('completionRate is 0 not NaN on an empty event',
    ov.body.tasks.completionRate === 0 && Number.isFinite(ov.body.tasks.completionRate));
  for (const [label, path] of [
    ['tasks', `/api/events/${bareId}/tasks`], ['attendees', `/api/events/${bareId}/attendees`],
    ['people', `/api/events/${bareId}/people`], ['ticket types', `/api/events/${bareId}/ticket-types`]]) {
    const r = await api('GET', path, { as: 'admin' });
    check(`empty ${label} returns an array`, r.status === 200 && Array.isArray(r.body), `${r.status}`);
  }
  const ws = await api('GET', `/api/planner/workspace/${bareId}`, { as: 'admin' });
  check('planner workspace on an empty event returns empty arrays',
    ws.status === 200 && ws.body.budgets.length === 0 && ws.body.sponsors.length === 0 &&
    ws.body.vendors.length === 0 && !!ws.body.event);
  const an = await api('GET', `/api/planner/analytics/${bareId}`, { as: 'admin' });
  check('analytics on an empty event returns zeros',
    an.status === 200 && an.body.budget.estimated === 0 && an.body.tasks.total === 0);
  const csvEmpty = await api('GET', `/api/events/${bareId}/attendees.csv`, { as: 'admin' });
  check('CSV of an empty event is a header row only',
    csvEmpty.status === 200 && String(csvEmpty.body).trim().split('\n').length === 1);

  const missing = await api('GET', '/api/events/99999', { as: 'admin' });
  check('missing event -> 404 with a message', missing.status === 404 && !!missing.body.error);
  const missingOv = await api('GET', '/api/events/99999/overview', { as: 'admin' });
  check('missing event overview -> 404', missingOv.status === 404);
  const missingTask = await api('GET', '/api/events/tasks/99999', { as: 'admin' });
  check('missing task -> 404', missingTask.status === 404);
  const badRoute = await api('GET', '/api/events/nope/nothing', { as: 'admin' });
  check('unknown API path -> JSON 404', badRoute.status === 404 && !!badRoute.body.error);
  const noAuth = await fetch(`${BASE}/api/events`);
  check('unauthenticated request -> 401', noAuth.status === 401, String(noAuth.status));
  const emptyUpdate = await api('PUT', `/api/events/${bareId}`, { as: 'admin', body: {} });
  check('update with no fields -> 400', emptyUpdate.status === 400, `got ${emptyUpdate.status}`);

  /* cleanup */
  await db.query(`DELETE FROM notifications WHERE link_id IN (
                    SELECT id FROM events WHERE title LIKE $1) AND link_entity IN ('event','ticket')`, [QA_TAG + '%']);
  await db.query(`DELETE FROM notifications WHERE link_entity='task' AND link_id IN (
                    SELECT t.id FROM event_tasks t JOIN events e ON e.id=t.event_id WHERE e.title LIKE $1)`, [QA_TAG + '%']);
  const gone = await db.query(`DELETE FROM events WHERE title LIKE $1 RETURNING id`, [QA_TAG + '%']);
  /* Audit entries are append-only from Phase 5A: each is hash-linked to the
     previous one, so deleting any row breaks verification for every entry
     after it. Test rows are left in place deliberately. */
  // (removed) await db.query(`DELETE FROM audit_logs WHERE meta LIKE $1`, ['%' + QA_TAG + '%']);
  lines.push(`\n  cleanup: removed ${gone.rowCount} QA event(s) and their rows`);

  console.log(lines.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(lines.join(String.fromCharCode(10)));
  console.error('HARNESS ERROR: ' + e.message);
  console.error(String(e.stack).split(String.fromCharCode(10))[1]);
  try { await db.pool.end(); } catch (x) {}
  process.exit(2);
});
