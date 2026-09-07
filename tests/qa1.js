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

/* QA pass 1 — permissions matrix, database integrity, dates & status. */
const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const db = require(path.join(REPO, 'db.js'));

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
  tok[key] = r.body.token;
  return r.body.user;
}

(async () => {
  const users = (await db.query(
    `SELECT id, email, role FROM users WHERE role <> 'alumni' ORDER BY id`)).rows;
  const byRole = Object.fromEntries(users.map(u => [u.role, u]));
  const alum = (await db.query(`SELECT id, email FROM users WHERE role='alumni' ORDER BY id LIMIT 1`)).rows[0];

  await login('alumni', alum.email);
  await login('moderator', byRole.moderator.email);
  await login('dept', byRole.dept_admin.email);
  await login('univ', byRole.univ_admin.email);
  await login('super', byRole.super_admin.email);

  const evId = (await db.query(`SELECT id FROM events ORDER BY id LIMIT 1`)).rows[0].id;
  const taskId = (await db.query(`SELECT id FROM event_tasks ORDER BY id LIMIT 1`)).rows[0].id;

  /* ════════ 8. PERMISSION MATRIX ════════ */
  section('8. PERMISSIONS — ordinary alumni must be shut out of internal data');

  const alumniDenied = [
    ['internal planner workspace', 'GET',  `/api/planner/workspace/${evId}`],
    ['planner analytics',          'GET',  `/api/planner/analytics/${evId}`],
    ['internal CSV report',        'GET',  `/api/planner/report/${evId}`],
    ['vendors',                    'GET',  `/api/planner/vendors?eventId=${evId}`],
    ['committees',                 'GET',  `/api/planner/committees?eventId=${evId}`],
    ['volunteers',                 'GET',  `/api/planner/volunteers?eventId=${evId}`],
    ['risks',                      'GET',  `/api/planner/risks?eventId=${evId}`],
    ['marketing',                  'GET',  `/api/planner/marketing?eventId=${evId}`],
    ['meetings',                   'GET',  `/api/planner/meetings?eventId=${evId}`],
    ['timeline',                   'GET',  `/api/planner/timeline?eventId=${evId}`],
    ['logistics',                  'GET',  `/api/planner/logistics?eventId=${evId}`],
    ['event overview (staff)',     'GET',  `/api/events/${evId}/overview`],
    ['attendee list',              'GET',  `/api/events/${evId}/attendees`],
    ['attendee CSV',               'GET',  `/api/events/${evId}/attendees.csv`],
    ['event people',               'GET',  `/api/events/${evId}/people`],
    ['manage-scope event list',    'GET',  `/api/events?scope=manage`],
    ['directory lookup',           'GET',  `/api/directory/search?q=a`],
    ['audit log',                  'GET',  `/api/audit-logs`]
  ];
  for (const [label, m, p] of alumniDenied) {
    const r = await api(m, p, { as: 'alumni' });
    check(`alumni blocked from ${label}`, r.status === 403 || r.status === 404, `got ${r.status}`);
  }

  const alumniWrites = [
    ['create an event',   'POST',   '/api/events', { title: 'x', venue: 'y', startsOn: '2027-01-01' }],
    ['create a task',     'POST',   `/api/events/${evId}/tasks`, { title: 'x' }],
    ['add ticket type',   'POST',   `/api/events/${evId}/ticket-types`, { name: 'x' }],
    ['add people',        'POST',   `/api/events/${evId}/people`, { userIds: [1] }],
    ['approve an event',  'PUT',    `/api/events/${evId}/approve`],
    ['cancel an event',   'PUT',    `/api/events/${evId}/cancel`, { reason: 'x' }],
    ['delete an event',   'DELETE', `/api/events/${evId}`],
    ['check someone in',  'POST',   '/api/events/checkin', { ticketCode: 'x' }],
    ['add a budget line', 'POST',   '/api/planner/budgets', { eventId: evId, category: 'x' }]
  ];
  for (const [label, m, p, b] of alumniWrites) {
    const r = await api(m, p, { as: 'alumni', body: b });
    check(`alumni cannot ${label}`, r.status === 403, `got ${r.status}`);
  }

  // Alumni CAN see the public list and register.
  const pub = await api('GET', '/api/events', { as: 'alumni' });
  check('alumni CAN read the public event list', pub.status === 200 && Array.isArray(pub.body));
  check('public list hides revenue',
    !pub.body.some(e => Object.prototype.hasOwnProperty.call(e, 'revenue')));
  check('public list hides unapproved / cancelled / invite-only events',
    pub.body.every(e => e.approval_status === 'approved' && e.status !== 'cancelled' && e.visibility !== 'invite'),
    JSON.stringify(pub.body.map(e => `${e.approval_status}/${e.status}/${e.visibility}`)));

  section('8b. PERMISSIONS — moderator & dept_admin');
  for (const role of ['moderator', 'dept']) {
    const mine = await api('GET', `/api/events?scope=manage`, { as: role });
    check(`${role} can use the manage list`, mine.status === 200, `got ${mine.status}`);
    const ws = await api('GET', `/api/planner/workspace/${evId}`, { as: role });
    check(`${role} can read the planner`, ws.status === 200, `got ${ws.status}`);
    const dir = await api('GET', '/api/directory/search?q=a', { as: role });
    check(`${role} can use the directory lookup`, dir.status === 200, `got ${dir.status}`);
    const t = await api('POST', `/api/events/${evId}/tasks`, { as: role, body: { title: `qa-${role}-task` } });
    check(`${role} can create a task`, t.status === 200, `got ${t.status}`);
    if (t.status === 200) await db.query('DELETE FROM event_tasks WHERE id=$1', [t.body.id]);
    const ap = await api('PUT', `/api/events/${evId}/approve`, { as: role });
    check(`${role} CANNOT approve an event`, ap.status === 403, `got ${ap.status}`);
    const cn = await api('PUT', `/api/events/${evId}/cancel`, { as: role, body: { reason: 'x' } });
    check(`${role} CANNOT cancel an event`, cn.status === 403, `got ${cn.status}`);
    const au = await api('GET', '/api/audit-logs', { as: role });
    if (role === 'dept') {
      /* Phase 7D §7: a department admin reads a SCOPED audit log — its own
         department's accounts and its own actions, never a platform-security
         action. Asserted here as a narrower read rather than as no read. */
      check(`${role} reads a SCOPED audit log`, au.status === 200, `got ${au.status}`);
      const wide = await api('GET', '/api/audit-logs', { as: 'super' });
      check(`${role}'s audit view is strictly narrower`,
        au.body.total < wide.body.total, `${au.body.total} of ${wide.body.total}`);
      check(`${role} sees no platform-security action`,
        (au.body.entries || []).every(e =>
          !/^(Administrator|Password|Signed In|Signed Out|Sign-In Failed|Database|Vault|DSAR|Bulk Import|Account Purged)/.test(e.action)),
        'security actions leaked');
    } else {
      check(`${role} CANNOT read the audit log`, au.status === 403, `got ${au.status}`);
    }
  }

  section('8c. PERMISSIONS — univ_admin & super_admin');
  for (const role of ['univ', 'super']) {
    const au = await api('GET', '/api/audit-logs', { as: role });
    check(`${role} CAN read the audit log`, au.status === 200, `got ${au.status}`);
    const ov = await api('GET', `/api/events/${evId}/overview`, { as: role });
    check(`${role} CAN read the event overview`, ov.status === 200, `got ${ov.status}`);
    check(`${role} sees creator + approver on the event`,
      ov.status === 200 && 'created_by_name' in ov.body.event && 'approved_by_name' in ov.body.event);
    const csv = await api('GET', `/api/events/${evId}/attendees.csv`, { as: role });
    check(`${role} CAN export attendees`, csv.status === 200, `got ${csv.status}`);
  }

  // Approval routing by creator role.
  section('8d. approval routing follows the creator\'s role');
  const made = [];
  for (const [role, expected] of [['moderator','pending_approval'], ['dept','pending_approval'],
                                  ['univ','approved'], ['super','approved']]) {
    const r = await api('POST', '/api/events', { as: role, body: {
      title: `qa-approval-${role}`, eventType: 'Seminar', venue: 'QA Room',
      startsOn: '2027-03-01', capacity: 10 } });
    check(`${role} creates -> ${expected}`, r.status === 200 && r.body.approval_status === expected,
      `${r.status} ${r.body && r.body.approval_status}`);
    if (r.status === 200) made.push(r.body.id);
  }
  // A pending event must be invisible to alumni.
  const pendingId = made[0];
  if (pendingId) {
    const peek = await api('GET', `/api/events/${pendingId}`, { as: 'alumni' });
    check('pending event hidden from alumni', peek.status === 403, `got ${peek.status}`);
    const rej = await api('PUT', `/api/events/${pendingId}/reject`, { as: 'super', body: { reason: 'QA reject' } });
    check('super_admin can reject with a reason', rej.status === 200 && rej.body.approval_status === 'rejected');
    const rejNoReason = await api('PUT', `/api/events/${made[1]}/reject`, { as: 'super', body: {} });
    check('reject requires a reason', rejNoReason.status === 400, `got ${rejNoReason.status}`);
    const app = await api('PUT', `/api/events/${made[1]}/approve`, { as: 'univ' });
    check('univ_admin can approve', app.status === 200 && app.body.approval_status === 'approved');
    check('approver recorded on the event', !!app.body.approved_by && !!app.body.approved_at);
  }

  /* ════════ 13. DATABASE INTEGRITY ════════ */
  section('13. DATABASE INTEGRITY');

  const CHILD = ['event_budgets','event_sponsors','event_committees','event_tasks',
    'event_procurement','event_volunteers','event_risks','event_vendors',
    'event_timeline','event_logistics','event_marketing','event_meetings'];

  const fks = await db.query(`
    SELECT tc.table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
     WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name = ANY($1)
       AND tc.constraint_name LIKE 'fk_%_event'`, [CHILD]);
  check(`all ${CHILD.length} child tables have an event FK`, fks.rows.length === CHILD.length,
    `${fks.rows.length} found`);
  check('every child FK cascades on delete',
    fks.rows.every(r => r.delete_rule === 'CASCADE'),
    JSON.stringify(fks.rows.filter(r => r.delete_rule !== 'CASCADE')));

  const defaults = await db.query(`
    SELECT table_name, column_default FROM information_schema.columns
     WHERE column_name='event_id' AND table_name = ANY($1) AND column_default IS NOT NULL`, [CHILD]);
  check('no event_id DEFAULT remains', defaults.rows.length === 0, JSON.stringify(defaults.rows));

  const nulls = await db.query(`
    SELECT table_name, is_nullable FROM information_schema.columns
     WHERE column_name='event_id' AND table_name = ANY($1) AND is_nullable='YES'`, [CHILD]);
  check('event_id is NOT NULL everywhere', nulls.rows.length === 0, JSON.stringify(nulls.rows));

  const orphans = [];
  for (const t of CHILD) {
    const r = await db.query(
      `SELECT COUNT(*)::int n FROM ${t} c WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id=c.event_id)`);
    if (r.rows[0].n) orphans.push(`${t}:${r.rows[0].n}`);
  }
  check('no orphaned child rows', orphans.length === 0, orphans.join(', '));

  // New relations resolve.
  const rel = await db.query(`
    SELECT
      /* v6: an assignee targets EITHER a DIC user OR an external event person,
         never both and never neither. */
      (SELECT COUNT(*)::int FROM event_task_assignees a
        WHERE NOT EXISTS (SELECT 1 FROM event_tasks t WHERE t.id=a.task_id)
           OR (a.user_id IS NULL AND a.event_person_id IS NULL)
           OR (a.user_id IS NOT NULL AND a.event_person_id IS NOT NULL)
           OR (a.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=a.user_id))
           OR (a.event_person_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM event_people p WHERE p.id=a.event_person_id))) AS bad_assignees,
      (SELECT COUNT(*)::int FROM event_registrations r
        WHERE r.ticket_type_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM event_ticket_types t WHERE t.id=r.ticket_type_id)) AS bad_tickets,
      /* v6: a directory person must resolve to a user; an external person must
         have no user but must carry its own name and role. */
      (SELECT COUNT(*)::int FROM event_people p
        WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id=p.event_id)
           OR (p.person_type='directory'
               AND (p.user_id IS NULL
                    OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p.user_id)))
           OR (p.person_type='external'
               AND (p.user_id IS NOT NULL
                    OR p.name IS NULL OR btrim(p.name)=''
                    OR p.role_title IS NULL OR btrim(p.role_title)=''))) AS bad_people,
      (SELECT COUNT(*)::int FROM events e
        WHERE e.created_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=e.created_by)) AS bad_creator,
      (SELECT COUNT(*)::int FROM events e
        WHERE e.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=e.approved_by)) AS bad_approver,
      (SELECT COUNT(*)::int FROM notifications n
        WHERE n.link_entity='task' AND NOT EXISTS (SELECT 1 FROM event_tasks t WHERE t.id=n.link_id)) AS dangling_task_links,
      (SELECT COUNT(*)::int FROM notifications n
        WHERE n.link_entity IN ('event','ticket') AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id=n.link_id)) AS dangling_event_links
  `);
  const R = rel.rows[0];
  check('task assignee relations resolve', R.bad_assignees === 0, String(R.bad_assignees));
  check('ticket_type_id relations resolve', R.bad_tickets === 0, String(R.bad_tickets));
  check('event people relations resolve', R.bad_people === 0, String(R.bad_people));
  check('created_by resolves to a user', R.bad_creator === 0, String(R.bad_creator));
  check('approved_by resolves to a user', R.bad_approver === 0, String(R.bad_approver));
  check('no dangling task deep-links', R.dangling_task_links === 0, String(R.dangling_task_links));
  check('no dangling event/ticket deep-links', R.dangling_event_links === 0, String(R.dangling_event_links));

  // Cascade proof on a throwaway event.
  const tmp = await db.query(
    `INSERT INTO events (title, venue, capacity, starts_on, event_type, type, status, approval_status)
     VALUES ('qa-cascade-probe','QA',5,CURRENT_DATE,'Other','Other','upcoming','draft') RETURNING id`);
  const tmpId = tmp.rows[0].id;
  await db.query(`INSERT INTO event_tasks (event_id,title,priority,status) VALUES ($1,'probe','low','todo')`, [tmpId]);
  const probeTask = (await db.query('SELECT id FROM event_tasks WHERE event_id=$1', [tmpId])).rows[0].id;
  await db.query(`INSERT INTO event_task_assignees (task_id,user_id) VALUES ($1,$2)`, [probeTask, alum.id]);
  await db.query(`INSERT INTO event_task_notes (task_id,user_id,body) VALUES ($1,$2,'probe note')`, [probeTask, alum.id]);
  await db.query(`INSERT INTO event_ticket_types (event_id,name,price) VALUES ($1,'probe',0)`, [tmpId]);
  await db.query(`INSERT INTO event_people (event_id,user_id,role_in_event) VALUES ($1,$2,'member')`, [tmpId, alum.id]);
  await db.query(`INSERT INTO event_budgets (event_id,category) VALUES ($1,'probe')`, [tmpId]);
  await db.query('DELETE FROM events WHERE id=$1', [tmpId]);
  const left = await db.query(`
    SELECT (SELECT COUNT(*)::int FROM event_tasks WHERE event_id=$1)
         + (SELECT COUNT(*)::int FROM event_ticket_types WHERE event_id=$1)
         + (SELECT COUNT(*)::int FROM event_people WHERE event_id=$1)
         + (SELECT COUNT(*)::int FROM event_budgets WHERE event_id=$1)
         + (SELECT COUNT(*)::int FROM event_task_assignees WHERE task_id=$2)
         + (SELECT COUNT(*)::int FROM event_task_notes WHERE task_id=$2) AS n`, [tmpId, probeTask]);
  check('deleting an event cascades tasks, assignees, notes, tickets, people, budget',
    left.rows[0].n === 0, `${left.rows[0].n} rows survived`);

  /* Phase 7D removed the superseded VARCHAR date columns. This used to assert
     that events.event_date was preserved; it now asserts the stronger thing
     that replaced it — the legacy column is gone AND every event carries a real
     typed date, which is what the old column was only ever a partial copy of.
     It was populated on 7 of 21 rows; starts_on is populated on all of them. */
  const legacy = await db.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(starts_on)::int AS typed_date,
           COUNT(*) FILTER (WHERE price IS NOT NULL)::int AS kept_price FROM events`);
  const goneCols = await db.query(`
    SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE table_name='events' AND column_name IN ('event_date','event_time')`);
  check('the superseded VARCHAR date columns are gone', goneCols.rows[0].n === 0, String(goneCols.rows[0].n));
  check('every event carries a real typed date instead',
    legacy.rows[0].typed_date === legacy.rows[0].total,
    `${legacy.rows[0].typed_date}/${legacy.rows[0].total}`);
  check('legacy price values preserved', legacy.rows[0].kept_price > 0, String(legacy.rows[0].kept_price));
  /* The proposal archive is retained under a name that says it is history —
     renamed, not deleted. The row count assertion is unchanged. */
  const props = await db.query('SELECT COUNT(*)::int n FROM legacy_event_proposals');
  check('the event_proposals archive is still intact, retained as legacy', props.rows[0].n > 0, String(props.rows[0].n));

  /* ════════ 12. DATES & STATUS ════════ */
  section('12. DATES & STATUS');

  const dt = await db.query(`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name='events' AND column_name IN ('starts_on','start_time','end_time')
     ORDER BY column_name`);
  // ORDER BY column_name -> end_time, start_time, starts_on
  const types = Object.fromEntries(dt.rows.map(r => [r.column_name, r.data_type]));
  check('starts_on is a DATE', types.starts_on === 'date', types.starts_on);
  check('start_time / end_time are TIME',
    types.start_time === 'time without time zone' && types.end_time === 'time without time zone',
    `${types.start_time} / ${types.end_time}`);

  const noDate = await db.query('SELECT COUNT(*)::int n FROM events WHERE starts_on IS NULL');
  check('every event has a real starts_on', noDate.rows[0].n === 0, String(noDate.rows[0].n));

  const tz = await db.query(`SELECT CURRENT_DATE AS db_date, now() AS db_now, current_setting('TimeZone') AS tz`);
  lines.push(`  info Postgres TimeZone=${tz.rows[0].tz}  CURRENT_DATE=${String(tz.rows[0].db_date).slice(0,15)}`);
  lines.push(`  info Node local date=${new Date().toString().slice(0,15)}`);

  const statuses = await db.query(`SELECT status, COUNT(*)::int n FROM events GROUP BY status ORDER BY 1`);
  lines.push(`  info status spread: ${statuses.rows.map(r => r.status + '=' + r.n).join(', ')}`);

  const wrong = await db.query(`
    SELECT COUNT(*)::int n FROM events
     WHERE status <> 'cancelled'
       AND ((starts_on < CURRENT_DATE AND status <> 'past')
         OR (starts_on = CURRENT_DATE AND status <> 'ongoing')
         OR (starts_on > CURRENT_DATE AND status <> 'upcoming'))`);
  check('run status agrees with the calendar after a sweep', wrong.rows[0].n === 0,
    `${wrong.rows[0].n} event(s) out of step`);

  for (const s of ['upcoming', 'ongoing', 'past', 'cancelled']) {
    const r = await api('GET', `/api/events?scope=manage&status=${s}`, { as: 'univ' });
    const okFilter = r.status === 200 && r.body.every(e => e.status === s);
    check(`status filter "${s}" returns only ${s} events`, okFilter,
      r.status === 200 ? JSON.stringify(r.body.map(e => e.status)) : String(r.status));
  }

  const chk = await db.query(`
    SELECT COUNT(*)::int n FROM information_schema.check_constraints
     WHERE constraint_name IN ('events_status_check','events_approval_status_check','events_visibility_check')`);
  check('status/approval/visibility CHECK constraints exist', chk.rows[0].n === 3, String(chk.rows[0].n));

  const badStatus = await api('PUT', `/api/events/${evId}`, { as: 'univ', body: { status: 'nonsense' } });
  check('database rejects an invalid status', badStatus.status >= 400, `got ${badStatus.status}`);

  /* cleanup QA events */
  await db.query(`DELETE FROM events WHERE title LIKE 'qa-approval-%' OR title = 'qa-cascade-probe'`);
  await db.query(`DELETE FROM notifications WHERE subtitle LIKE '%qa-approval-%'`);
  await db.query(`DELETE FROM event_tasks WHERE title LIKE 'qa-%-task'`);

  console.log(lines.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
