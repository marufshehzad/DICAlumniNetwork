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

/* Acceptance test for the v5 Event & Tickets module — scenario A..V.
   Runs against a live server on PORT. Creates its own event and cleans up. */
const BASE = process.env.BASE || 'http://127.0.0.1:8123';

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail) {
  if (cond) { pass++; results.push(`  PASS  ${label}`); }
  else { fail++; results.push(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

const tokens = {};
async function api(method, path, { body, as } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as && tokens[as]) headers.Authorization = `Bearer ${tokens[as]}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function login(key, email) {
  const r = await api('POST', '/api/auth/login', { body: { email, password: PW(email) } });
  if (r.status !== 200 || !r.body.token) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  tokens[key] = r.body.token;
  return r.body.user;
}

(async () => {
  const db = require(path.join(REPO, 'db.js'));

  // Resolve real logins from the database.
  const u = await db.query(`SELECT id, email, role, full_name FROM users
                             WHERE role IN ('super_admin','univ_admin','dept_admin','alumni')
                             ORDER BY id`);
  const byRole = {};
  u.rows.forEach(r => { if (!byRole[r.role]) byRole[r.role] = r; });
  const alumniPool = u.rows.filter(r => r.role === 'alumni');

  const admin = await login('admin', byRole.univ_admin.email);      // College Admin
  const superA = await login('super', byRole.super_admin.email);
  const dept = await login('dept', byRole.dept_admin.email);
  const al1 = await login('al1', alumniPool[0].email);
  const al2 = await login('al2', alumniPool[1].email);

  console.log(`Logged in: ${admin.name} (${admin.role}), ${superA.name}, ${dept.name}, ${al1.name}, ${al2.name}\n`);

  /* ── A/B. College Admin creates a full event ───────────────── */
  const startsOn = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  const create = await api('POST', '/api/events', { as: 'admin', body: {
    title: 'DIC Winter Alumni Meet (acceptance)',
    description: 'End of year alumni gathering with dinner and cultural night.',
    eventType: 'Reunion',
    startsOn, startTime: '17:00', endTime: '21:00',
    venue: 'DIC Main Campus Auditorium',
    capacity: 5,
    organizerDepartment: 'DIC Alumni Relations',
    visibility: 'alumni',
    isPaid: true,
    waitlistEnabled: true,
    ticketTypes: [
      // Free: Phase 3 refuses registration for any priced ticket, because no
      // payment gateway exists to collect it. This suite covers the ticket
      // lifecycle - quota, capacity, waitlist, check-in - which is unchanged.
      { name: 'Alumni', price: 0, quota: 3 },
      { name: 'Student', price: 0, quota: 1 },
      { name: 'Guest', price: 0, quota: 1 }
    ]
  }});
  check('A. admin can create an event', create.status === 200, JSON.stringify(create.body));
  const ev = create.body;
  const eventId = ev.id;

  check('B1. description stored', ev.description && ev.description.length > 10);
  check('B2. starts_on is a real date', /^\d{4}-\d{2}-\d{2}/.test(String(ev.starts_on)));
  check('B3. start/end time stored', !!ev.start_time && !!ev.end_time, `${ev.start_time}/${ev.end_time}`);
  check('B4. venue + capacity stored', ev.venue && ev.capacity === 5);
  check('B5. organizer stored', ev.organizer_department === 'DIC Alumni Relations');
  check('B6. visibility stored', ev.visibility === 'alumni');
  check('B7. three ticket types created', (ev.ticket_types || []).length === 3, JSON.stringify(ev.ticket_types));
  check('B8. admin creation is auto-approved', ev.approval_status === 'approved', ev.approval_status);
  check('B9. created_by recorded', ev.created_by === admin.id);

  // dept_admin creation must require approval
  const deptEv = await api('POST', '/api/events', { as: 'dept', body: {
    title: 'CSE Seminar (acceptance)', eventType: 'Seminar',
    startsOn, venue: 'Lab 401', capacity: 40 }});
  check('B10. dept_admin event needs approval',
    deptEv.status === 200 && deptEv.body.approval_status === 'pending_approval', deptEv.body.approval_status);

  /* ── C. Standard checklist ─────────────────────────────────── */
  const chk = await api('POST', `/api/events/${eventId}/tasks/standard-checklist`, { as: 'admin' });
  check('C. standard checklist creates tasks', chk.status === 200 && chk.body.created === 8, JSON.stringify(chk.body));

  const taskList = await api('GET', `/api/events/${eventId}/tasks`, { as: 'admin' });
  check('C2. tasks readable', taskList.status === 200 && taskList.body.length === 8);
  const withDates = taskList.body.filter(t => t.due_on).length;
  check('C3. deadlines derived from event date', withDates === 8, `${withDates}/8 have due_on`);

  /* ── D/E. Open a task, search the directory ────────────────── */
  const task = taskList.body.find(t => t.title === 'Confirm venue booking');
  check('D. task detail opens', !!task);

  const alumniProfile = await db.query(
    `SELECT u.id, u.full_name, ap.student_id, ap.mobile_number, ap.department, ap.section_code
       FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id
      WHERE ap.student_id IS NOT NULL AND ap.mobile_number IS NOT NULL LIMIT 1`);
  const probe = alumniProfile.rows[0];

  const sName = await api('GET', `/api/directory/search?q=${encodeURIComponent(probe.full_name.split(' ')[0])}`, { as: 'admin' });
  check('E1. search by name', sName.status === 200 && sName.body.results.some(r => r.id === probe.id));

  const sId = await api('GET', `/api/directory/search?q=${encodeURIComponent(probe.student_id)}`, { as: 'admin' });
  check('E2. search by student ID', sId.body.results?.some(r => r.id === probe.id), JSON.stringify(sId.body).slice(0, 160));

  const digits = String(probe.mobile_number).replace(/\D/g, '').slice(-6);
  const sPhone = await api('GET', `/api/directory/search?q=${encodeURIComponent(digits)}`, { as: 'admin' });
  check('E3. search by phone', sPhone.body.results?.some(r => r.id === probe.id), `digits=${digits}`);

  const sDept = await api('GET', `/api/directory/search?dept=${encodeURIComponent(probe.department)}`, { as: 'admin' });
  check('E4. search by department', sDept.body.results?.length > 0);

  if (probe.section_code) {
    const sSec = await api('GET', `/api/directory/search?section=${encodeURIComponent(probe.section_code)}`, { as: 'admin' });
    check('E5. search by section', sSec.body.results?.length > 0);
  } else {
    check('E5. search by section (no seeded section data — endpoint responds)',
      (await api('GET', '/api/directory/search?section=A', { as: 'admin' })).status === 200);
  }

  check('E6. directory returns contact fields',
    sName.body.results[0] && 'phone' in sName.body.results[0] && 'whatsapp' in sName.body.results[0]);
  const alumniProbe = await api('GET', '/api/directory/search?q=a', { as: 'al1' });
  check('E7. alumni CANNOT use the directory lookup', alumniProbe.status === 403, String(alumniProbe.status));

  /* ── F/G/H. Assign three people ────────────────────────────── */
  const three = alumniPool.slice(0, 3).map(r => r.id);
  const notifBefore = await db.query(
    `SELECT COUNT(*)::int n FROM notifications WHERE link_entity='task' AND user_id = ANY($1)`, [three]);

  const assign = await api('POST', `/api/events/tasks/${task.id}/assignees`, {
    as: 'admin', body: { userIds: three } });
  check('F/G. three assignees attached', assign.status === 200 && assign.body.added === 3, JSON.stringify(assign.body).slice(0, 160));
  check('G2. task reports all three assignees', assign.body.task?.assignees?.length === 3);

  const notifAfter = await db.query(
    `SELECT COUNT(*)::int n FROM notifications WHERE link_entity='task' AND user_id = ANY($1)`, [three]);
  check('H. all three received an in-app notification',
    notifAfter.rows[0].n - notifBefore.rows[0].n === 3,
    `delta=${notifAfter.rows[0].n - notifBefore.rows[0].n}`);

  /* ── I. Assignee opens the notification (deep link) ────────── */
  const assigneeKey = alumniPool[0].id === three[0] ? 'al1' : 'al1';
  const notifs = await api('GET', '/api/notifications', { as: assigneeKey });
  const deep = notifs.body.find(n => n.link_entity === 'task' && n.link_id === task.id);
  check('I. notification carries a deep link to the task', !!deep, JSON.stringify(notifs.body.slice(0, 1)));

  const openTask = await api('GET', `/api/events/tasks/${task.id}`, { as: assigneeKey });
  check('I2. assignee can open their task', openTask.status === 200, String(openTask.status));

  /* ── J/K. Assignee sets progress 50, admin sees it ─────────── */
  const prog = await api('PUT', `/api/events/tasks/${task.id}`, {
    as: assigneeKey, body: { status: 'in_progress', progress: 50 } });
  check('J. assignee can update progress without moderator role',
    prog.status === 200 && prog.body.progress === 50, `${prog.status} ${JSON.stringify(prog.body).slice(0,120)}`);

  const adminSees = await api('GET', `/api/events/${eventId}/tasks`, { as: 'admin' });
  const seen = adminSees.body.find(t => t.id === task.id);
  check('K. admin sees 50%', seen && seen.progress === 50 && seen.status === 'in_progress');

  // An assignee must NOT be able to re-scope the task.
  const escalate = await api('PUT', `/api/events/tasks/${task.id}`, {
    as: assigneeKey, body: { priority: 'low' } });
  check('J2. assignee cannot change priority', escalate.status === 403, String(escalate.status));

  /* ── L/M. Blocked with a reason notifies the organiser ─────── */
  const noReason = await api('PUT', `/api/events/tasks/${task.id}`, {
    as: assigneeKey, body: { status: 'blocked' } });
  check('L1. blocking without a reason is rejected', noReason.status === 400, String(noReason.status));

  const blocked = await api('PUT', `/api/events/tasks/${task.id}`, {
    as: assigneeKey, body: { status: 'blocked', blockedReason: 'Auditorium double-booked with the convocation.' } });
  check('L2. blocked with a reason succeeds',
    blocked.status === 200 && blocked.body.status === 'blocked' && !!blocked.body.blocked_reason);

  const ownerNotif = await db.query(
    `SELECT title FROM notifications WHERE user_id=$1 AND link_entity='task' AND link_id=$2
      ORDER BY id DESC LIMIT 1`, [admin.id, task.id]);
  check('M. organiser notified of the block',
    ownerNotif.rows[0]?.title === 'Task marked blocked', JSON.stringify(ownerNotif.rows));

  /* ── N. Resume and mark done ───────────────────────────────── */
  const done = await api('PUT', `/api/events/tasks/${task.id}`, {
    as: assigneeKey, body: { status: 'completed' } });
  check('N1. assignee marks done', done.status === 200 && done.body.status === 'completed');
  check('N2. done forces progress to 100', done.body.progress === 100, String(done.body.progress));
  check('N3. completed_at stamped', !!done.body.completed_at);
  check('N4. blocked reason cleared', !done.body.blocked_reason);

  /* ── O. Admin verifies ─────────────────────────────────────── */
  const verified = await api('PUT', `/api/events/tasks/${task.id}/verify`, { as: 'admin' });
  check('O1. admin verifies the task',
    verified.status === 200 && !!verified.body.verified_at && verified.body.verified_by === admin.id);
  const vnotif = await db.query(
    `SELECT COUNT(*)::int n FROM notifications
      WHERE link_entity='task' AND link_id=$1 AND title='Task verified'`, [task.id]);
  check('O2. assignees notified of verification', vnotif.rows[0].n === 3, String(vnotif.rows[0].n));

  const alumniVerify = await api('PUT', `/api/events/tasks/${task.id}/verify`, { as: 'al2' });
  check('O3. non-staff cannot verify', alumniVerify.status === 403, String(alumniVerify.status));

  /* ── P/Q/R. Tickets, capacity, waitlist ────────────────────── */
  const types = ev.ticket_types;
  const student = types.find(t => t.name === 'Student');
  const guest = types.find(t => t.name === 'Guest');
  const alumniT = types.find(t => t.name === 'Alumni');

  const r1 = await api('POST', `/api/events/${eventId}/register`, {
    as: 'al1', body: { ticketTypeId: student.id } });
  check('P1. registration succeeds', r1.status === 200 && r1.body.status === 'confirmed', JSON.stringify(r1.body).slice(0,160));
  check('P2. ticket code issued', /^DIC-TKT-/.test(r1.body.registration.ticket_code));
  check('P3. ticket type recorded', r1.body.registration.ticket_type_id === student.id);

  const dup = await api('POST', `/api/events/${eventId}/register`, { as: 'al1', body: {} });
  check('P4. duplicate registration blocked', dup.status === 409, String(dup.status));

  // Student quota is 1 and now used -> second student ticket must waitlist.
  const r2 = await api('POST', `/api/events/${eventId}/register`, {
    as: 'al2', body: { ticketTypeId: student.id } });
  check('Q1. per-ticket-type quota enforced (waitlisted)',
    r2.status === 200 && r2.body.status === 'waitlisted', JSON.stringify(r2.body).slice(0,160));

  // Fill overall capacity (5) to prove the total cap still holds.
  const extra = alumniPool.slice(2, 8);
  const codes = [];
  for (const a of extra) {
    await login('x' + a.id, a.email);
    const r = await api('POST', `/api/events/${eventId}/register`, {
      as: 'x' + a.id, body: { ticketTypeId: alumniT.id } });
    if (r.body?.registration) codes.push({ uid: a.id, key: 'x' + a.id, ...r.body });
  }
  const conf = codes.filter(c => c.status === 'confirmed').length;
  const wait = codes.filter(c => c.status === 'waitlisted').length;
  check('Q2. alumni quota (3) enforced across registrations', conf === 3, `confirmed=${conf} waitlisted=${wait}`);

  const overview = await api('GET', `/api/events/${eventId}/overview`, { as: 'admin' });
  check('Q3. counts computed live from registrations',
    overview.body.event.registered === 4, `registered=${overview.body.event?.registered}`);

  // R. waitlist promotion on cancellation
  const firstWait = codes.find(c => c.status === 'waitlisted');
  if (firstWait) {
    const cancelKey = codes.find(c => c.status === 'confirmed').key;
    const canc = await api('DELETE', `/api/events/${eventId}/register`, { as: cancelKey });
    check('R1. cancellation promotes a waitlisted person', canc.status === 200 && canc.body.promoted === true,
      JSON.stringify(canc.body));
    const promoNotif = await db.query(
      `SELECT COUNT(*)::int n FROM notifications WHERE title='A seat opened up — you are in'
        AND link_entity='ticket' AND link_id=$1`, [eventId]);
    check('R2. promoted person is notified', promoNotif.rows[0].n >= 1, String(promoNotif.rows[0].n));
  } else {
    check('R1. waitlist promotion (no waitlisted row to promote)', false, 'setup produced no waitlist entry');
  }

  /* ── S/T. QR validity and check-in ─────────────────────────── */
  const myTicket = await api('GET', `/api/events/${eventId}/my-ticket`, { as: 'al1' });
  check('S1. ticket retrievable with signed QR payload',
    myTicket.status === 200 && !!myTicket.body.qr_payload);
  const payload = JSON.parse(myTicket.body.qr_payload);
  check('S2. QR payload carries code, event, user and signature',
    payload.t && payload.e === eventId && payload.u && payload.s);

  // A pre-v5 ticket must still validate.
  const legacy = await db.query(
    `SELECT ticket_code, qr_payload FROM event_registrations
      WHERE created_at < NOW() - INTERVAL '1 minute' AND status='confirmed' LIMIT 1`);
  if (legacy.rows.length) {
    const lp = JSON.parse(legacy.rows[0].qr_payload);
    const crypto = require('crypto');
    const expect = crypto.createHmac('sha256', process.env.ENCRYPTION_KEY || 'dic-ticket')
      .update(`${lp.t}:${lp.e}:${lp.u}`).digest('hex').slice(0, 16);
    check('S3. pre-v5 QR signature still validates', lp.s === expect, `${lp.s} vs ${expect}`);
  } else {
    check('S3. pre-v5 QR signature still validates (none present to test)', true);
  }

  const badSig = await api('POST', '/api/events/checkin', {
    as: 'admin', body: { ticketCode: JSON.stringify({ ...payload, s: 'deadbeefdeadbeef' }) } });
  check('T1. tampered QR is rejected', badSig.status === 400, String(badSig.status));

  const scan = await api('POST', '/api/events/checkin', {
    as: 'admin', body: { ticketCode: myTicket.body.qr_payload } });
  check('T2. moderator can check in by scanning the QR payload',
    scan.status === 200 && scan.body.success, JSON.stringify(scan.body).slice(0,160));

  const rescan = await api('POST', '/api/events/checkin', {
    as: 'admin', body: { ticketCode: myTicket.body.ticket_code } });
  check('T3. double check-in blocked', rescan.status === 409, String(rescan.status));

  const alumniCheckin = await api('POST', '/api/events/checkin', {
    as: 'al2', body: { ticketCode: myTicket.body.ticket_code } });
  check('T4. alumni cannot check people in', alumniCheckin.status === 403, String(alumniCheckin.status));

  /* ── U. Alumni cannot reach internal planner data ──────────── */
  const leaks = [
    ['workspace',  `/api/planner/workspace/${eventId}`],
    ['analytics',  `/api/planner/analytics/${eventId}`],
    ['csv report', `/api/planner/report/${eventId}`],
    ['sponsors',   `/api/planner/sponsors?eventId=${eventId}`],
    ['vendors',    `/api/planner/vendors?eventId=${eventId}`],
    ['budgets',    `/api/planner/budgets?eventId=${eventId}`],
    ['meetings',   `/api/planner/meetings?eventId=${eventId}`],
    ['attendees',  `/api/events/${eventId}/attendees`],
    ['csv attend', `/api/events/${eventId}/attendees.csv`],
    ['overview',   `/api/events/${eventId}/overview`],
    ['people',     `/api/events/${eventId}/people`],
    ['manage list',`/api/events?scope=manage`]
  ];
  for (const [label, path] of leaks) {
    const r = await api('GET', path, { as: 'al1' });
    // 403 = gated, 404 = no such route (budgets/sponsors are read only through
    // the staff-gated workspace bundle). Either way the data is unreachable;
    // what must never happen is a 200 with rows in it.
    check(`U. alumni blocked from ${label}`, r.status === 403 || r.status === 404, `got ${r.status}`);
  }
  const staffOk = await api('GET', `/api/planner/workspace/${eventId}`, { as: 'admin' });
  check('U2. staff still reach the planner', staffOk.status === 200, String(staffOk.status));

  const legacyGone = await api('GET', `/api/events/planner/${eventId}`, { as: 'al1' });
  check('U3. legacy planner endpoint removed', legacyGone.status === 404, String(legacyGone.status));
  const aiGone = await api('POST', '/api/events/ai-estimate', { as: 'admin', body: { attendance: 100 } });
  check('U4. EventAI endpoint removed', aiGone.status === 404, String(aiGone.status));
  const propGone = await api('POST', '/api/events/proposals', { as: 'al1', body: { name: 'x' } });
  check('U5. proposal endpoint removed', propGone.status === 404, String(propGone.status));

  // Pending event must be invisible to alumni until approved.
  const pendingId = deptEv.body.id;
  const pendPeek = await api('GET', `/api/events/${pendingId}`, { as: 'al1' });
  check('U6. unapproved event hidden from alumni', pendPeek.status === 403, String(pendPeek.status));
  const alumniList = await api('GET', '/api/events', { as: 'al1' });
  check('U7. unapproved event absent from the alumni list',
    !alumniList.body.some(e => e.id === pendingId));

  /* ── V. Super Admin audit visibility ───────────────────────── */
  const full = await api('GET', `/api/events/${eventId}`, { as: 'super' });
  check('V1. creator visible', full.body.created_by_name === admin.name, full.body.created_by_name);
  check('V2. creation time visible', !!full.body.created_at);
  check('V3. approval status visible', full.body.approval_status === 'approved');
  check('V4. approver visible', !!full.body.approved_by_name, String(full.body.approved_by_name));

  const vTasks = await api('GET', `/api/events/${eventId}/tasks`, { as: 'super' });
  const vt = vTasks.body.find(t => t.id === task.id);
  check('V5. task ownership visible', vt.assignees.length === 3 && !!vt.created_by_name);
  check('V6. task progress visible', vt.progress === 100);
  check('V7. verifier visible', !!vt.verified_by_name, String(vt.verified_by_name));

  /* Phase 7C-3 gave this endpoint filters and paging, so it answers with
     { entries, total, ... } rather than a bare array. The assertion below is
     unchanged — only the way it reaches the same newest-fifty entries. */
  const audit = await api('GET', '/api/audit-logs', { as: 'super' });
  check('V8. audit trail records the event creation',
    (audit.body.entries || []).some(a => a.action === 'Event Created' && a.meta.includes('acceptance')));

  // Approval flow on the pending event
  const approve = await api('PUT', `/api/events/${pendingId}/approve`, { as: 'super' });
  check('V9. super admin approves a pending event',
    approve.status === 200 && approve.body.approval_status === 'approved');
  const approvalNotif = await db.query(
    `SELECT COUNT(*)::int n FROM notifications
      WHERE link_entity='event' AND link_id=$1 AND title='Event approved'`, [pendingId]);
  check('V10. creator notified of approval', approvalNotif.rows[0].n === 1, String(approvalNotif.rows[0].n));

  const alumniApprove = await api('PUT', `/api/events/${eventId}/approve`, { as: 'al1' });
  check('V11. alumni cannot approve events', alumniApprove.status === 403, String(alumniApprove.status));

  /* ── Extra: cancellation & CSV ─────────────────────────────── */
  const csv = await api('GET', `/api/events/${eventId}/attendees.csv`, { as: 'admin' });
  check('X1. attendee CSV export works',
    csv.status === 200 && String(csv.body).startsWith('name,email,phone'), String(csv.body).slice(0, 60));

  const cancel = await api('PUT', `/api/events/${pendingId}/cancel`, {
    as: 'super', body: { reason: 'Venue unavailable.' } });
  check('X2. event cancellation works',
    cancel.status === 200 && cancel.body.status === 'cancelled' && !!cancel.body.cancelled_at);
  const noReasonCancel = await api('PUT', `/api/events/${eventId}/cancel`, { as: 'super', body: {} });
  check('X3. cancellation requires a reason', noReasonCancel.status === 400, String(noReasonCancel.status));

  const delLive = await api('DELETE', `/api/events/${eventId}`, { as: 'super' });
  check('X4. deleting an event with live tickets is refused', delLive.status === 409, String(delLive.status));

  const sweep = await api('POST', '/api/events/tasks/reminder-sweep', { as: 'admin' });
  check('X5. deadline reminder sweep runs', sweep.status === 200 && typeof sweep.body.sent === 'number');

  /* ── Cleanup ───────────────────────────────────────────────── */
  await db.query('DELETE FROM events WHERE title LIKE $1', ['%(acceptance)%']);
  await db.query(`DELETE FROM notifications WHERE link_entity IN ('task','event','ticket')
                   AND created_at > NOW() - INTERVAL '10 minutes'`);
  /* Audit entries are append-only from Phase 5A: each is hash-linked to the
     previous one, so deleting any row breaks verification for every entry
     after it. Test rows are left in place deliberately. */
  // (removed) await db.query(`DELETE FROM audit_logs WHERE meta LIKE '%acceptance%'`);

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
