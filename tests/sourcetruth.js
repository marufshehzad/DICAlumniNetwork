/* Checks every metric the interface shows against a direct query on the
   database. The API value and the SQL value must agree exactly. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const db = require(path.join(REPO, 'db'));
const B = 'http://localhost:8123';

const creds = {};
for (const l of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
  const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
  if (m) creds[m[2]] = m[3];
}

let pass = 0, fail = 0;
const rows = [];
function check(screen, label, shown, sql, expected) {
  const ok = String(shown) === String(expected);
  ok ? pass++ : fail++;
  rows.push({ screen, label, shown: String(shown), sql, expected: String(expected), ok });
}

(async () => {
  const login = async (email, pw) => (await (await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw })
  })).json());

  const admin = await login('admin@dic.edu.bd', creds['admin@dic.edu.bd']);
  const alum = await login('alumni@dic.edu.bd', creds['alumni@dic.edu.bd']);
  const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
  const get = async (p, t) => (await (await fetch(B + p, H(t))).json());

  const one = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];

  const ov = await get('/api/stats/overview', admin.token);
  const an = await get('/api/stats/analytics', admin.token);
  const mp = await get('/api/stats/map', admin.token);
  const camps = await get('/api/campaigns', admin.token);
  const chaps = await get('/api/chapters', admin.token);
  const myOv = await get('/api/stats/overview', alum.token);

  // ── Dashboards ────────────────────────────────────────────
  check('Dashboard (College/Super)', 'Verified accounts', ov.users_verified,
    'COUNT(users WHERE is_verified)', await one('SELECT COUNT(*)::int FROM users WHERE is_verified'));
  check('Dashboard (College)', 'Donations settled', ov.donations_total,
    "SUM(donations.amount WHERE status='SUCCESS')",
    Number(await one("SELECT COALESCE(SUM(amount),0) FROM donations WHERE status='SUCCESS'")));
  check('Dashboard (College)', 'Active mentorships', ov.mentorships_active,
    "COUNT(mentorships WHERE status='accepted')",
    await one("SELECT COUNT(*)::int FROM mentorships WHERE status='accepted'"));
  check('Dashboard (College)', 'Upcoming events', ov.events_upcoming,
    "COUNT(events WHERE status<>'cancelled' AND starts_on >= CURRENT_DATE)",
    await one("SELECT COUNT(*)::int FROM events WHERE status<>'cancelled' AND starts_on >= CURRENT_DATE"));
  check('Dashboard (College)', 'Alumni profiles', ov.profiles_total,
    'COUNT(alumni_profiles)', await one('SELECT COUNT(*)::int FROM alumni_profiles'));
  check('Dashboard (College)', 'Event registrations', ov.registrations_total,
    'COUNT(event_registrations)', await one('SELECT COUNT(*)::int FROM event_registrations'));
  check('Dashboard (College)', 'Job postings', ov.jobs_total,
    'COUNT(jobs)', await one('SELECT COUNT(*)::int FROM jobs'));
  check('Dashboard (College)', 'Chapter memberships', ov.chapter_memberships_total,
    'COUNT(chapter_memberships)', await one('SELECT COUNT(*)::int FROM chapter_memberships'));
  check('Dashboard (Super)', 'User accounts', ov.users_total,
    'COUNT(users)', await one('SELECT COUNT(*)::int FROM users'));
  check('Dashboard (Super)', 'Events', ov.events_total,
    'COUNT(events)', await one('SELECT COUNT(*)::int FROM events'));
  check('Dashboard (Super)', 'Audit log entries', ov.audit_entries,
    'COUNT(audit_logs)', await one('SELECT COUNT(*)::int FROM audit_logs'));
  check('Dashboard (Super)', 'Custom fields', ov.custom_fields_total,
    'COUNT(custom_fields)', await one('SELECT COUNT(*)::int FROM custom_fields'));
  check('Dashboard (Super)', 'Tasks completed', ov.tasks_completed,
    "COUNT(event_tasks WHERE status='completed')",
    await one("SELECT COUNT(*)::int FROM event_tasks WHERE status='completed'"));
  check('Dashboard (Super)', 'Tasks total', ov.tasks_total,
    'COUNT(event_tasks)', await one('SELECT COUNT(*)::int FROM event_tasks'));

  // ── Moderator dashboard ───────────────────────────────────
  check('Dashboard (Moderator)', 'Unverified accounts', ov.pending_verifications,
    'COUNT(users WHERE NOT is_verified)', await one('SELECT COUNT(*)::int FROM users WHERE NOT is_verified'));
  check('Dashboard (Moderator)', 'Stories awaiting review', ov.pending_stories,
    "COUNT(stories WHERE status='pending_review')",
    await one("SELECT COUNT(*)::int FROM stories WHERE status='pending_review'"));
  check('Dashboard (Moderator)', 'Chapters awaiting review', ov.pending_chapters,
    "COUNT(chapters WHERE status='pending_review')",
    await one("SELECT COUNT(*)::int FROM chapters WHERE status='pending_review'"));
  check('Dashboard (Moderator)', 'Events awaiting approval', ov.pending_events,
    "COUNT(events WHERE approval_status='pending_approval')",
    await one("SELECT COUNT(*)::int FROM events WHERE approval_status='pending_approval'"));

  // ── Alumni dashboard (per-user) ───────────────────────────
  const uid = alum.user.id;
  check('Dashboard (Alumni)', 'My event registrations', myOv.my_registrations,
    'COUNT(event_registrations WHERE user_id=me)',
    await one('SELECT COUNT(*)::int FROM event_registrations WHERE user_id=$1', [uid]));
  check('Dashboard (Alumni)', 'My connections', myOv.my_connections,
    "COUNT(connections WHERE status='accepted' AND me in (requester,addressee))",
    await one("SELECT COUNT(*)::int FROM connections WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1)", [uid]));
  check('Dashboard (Alumni)', 'My chapters', myOv.my_chapters,
    'COUNT(chapter_memberships WHERE user_id=me)',
    await one('SELECT COUNT(*)::int FROM chapter_memberships WHERE user_id=$1', [uid]));
  check('Dashboard (Alumni)', 'Unread notifications', myOv.my_unread_notifications,
    'COUNT(notifications WHERE user_id=me AND is_unread)',
    await one('SELECT COUNT(*)::int FROM notifications WHERE user_id=$1 AND is_unread', [uid]));

  // ── Donations page ────────────────────────────────────────
  const raised = camps.reduce((a, c) => a + Number(c.raised_live || 0), 0);
  const donors = camps.reduce((a, c) => a + Number(c.donors_live || 0), 0);
  check('Donations', 'Total settled (tile)', raised,
    "SUM(donations.amount WHERE status='SUCCESS')",
    Number(await one("SELECT COALESCE(SUM(amount),0) FROM donations WHERE status='SUCCESS'")));
  check('Donations', 'Donors (tile)', donors,
    "COUNT(DISTINCT donor_user_id WHERE status='SUCCESS')",
    await one("SELECT COUNT(DISTINCT donor_user_id)::int FROM donations WHERE status='SUCCESS'"));
  check('Donations', 'Active campaigns (tile)', camps.length,
    'COUNT(campaigns)', await one('SELECT COUNT(*)::int FROM campaigns'));
  for (const c of camps) {
    check('Donations', `Campaign #${c.id} raised`, Number(c.raised_live),
      `SUM(donations WHERE campaign_id=${c.id} AND status='SUCCESS')`,
      Number(await one("SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id=$1 AND status='SUCCESS'", [c.id])));
  }

  // ── Chapters page ─────────────────────────────────────────
  for (const ch of chaps) {
    check('Chapters', `"${ch.name}" members`, ch.member_rows,
      `COUNT(chapter_memberships WHERE chapter_id=${ch.id})`,
      await one('SELECT COUNT(*)::int FROM chapter_memberships WHERE chapter_id=$1', [ch.id]));
  }

  /* ── Alumni map ────────────────────────────────────────────
     These four used to compare the map against COUNT(alumni_profiles.country),
     the free-text column. Phase 5B made that column untrustworthy on purpose:
     every value in it was written by a hardcoded 'Dhaka','Bangladesh' in the
     registration and import paths, so the map now aggregates only profiles
     that reference a structured place AND whose owner set their location to
     'public'. The expectations follow the new contract — they are stricter,
     not looser, because they now also assert that unconfirmed and non-public
     locations are excluded. */
  const MAP_PUBLIC = `ap.place_id IS NOT NULL
    AND COALESCE(ap.privacy_settings ->> 'location', 'alumni') = 'public'`;
  check('Alumni Map', 'Countries plotted', mp.countries.length,
    'COUNT(DISTINCT country) over public, place-linked profiles',
    await one(`SELECT COUNT(DISTINCT lp.country)::int FROM alumni_profiles ap
                 JOIN location_places lp ON lp.id = ap.place_id WHERE ${MAP_PUBLIC}`));
  check('Alumni Map', 'Cities plotted', mp.cities.length,
    'COUNT(DISTINCT place_id) over public, place-linked profiles',
    await one(`SELECT COUNT(DISTINCT ap.place_id)::int FROM alumni_profiles ap WHERE ${MAP_PUBLIC}`));
  check('Alumni Map', 'Alumni on the map', mp.mapped,
    'COUNT(public, place-linked profiles)',
    await one(`SELECT COUNT(*)::int FROM alumni_profiles ap WHERE ${MAP_PUBLIC}`));
  check('Alumni Map', 'Awaiting confirmation (not plotted)', mp.unconfirmed,
    'COUNT(alumni_profiles WHERE location_needs_confirmation)',
    await one('SELECT COUNT(*)::int FROM alumni_profiles WHERE location_needs_confirmation'));
  check('Alumni Map', 'In Bangladesh', mp.in_bangladesh,
    "COUNT(public, place-linked profiles WHERE country_code='BD')",
    await one(`SELECT COUNT(*)::int FROM alumni_profiles ap
                 JOIN location_places lp ON lp.id = ap.place_id
                WHERE ${MAP_PUBLIC} AND lp.country_code = 'BD'`));
  check('Alumni Map', 'International', mp.international,
    "COUNT(public, place-linked profiles WHERE country_code<>'BD')",
    await one(`SELECT COUNT(*)::int FROM alumni_profiles ap
                 JOIN location_places lp ON lp.id = ap.place_id
                WHERE ${MAP_PUBLIC} AND lp.country_code <> 'BD'`));
  check('Alumni Map', 'Approved chapters', mp.chapters,
    "COUNT(chapters WHERE status='approved')",
    await one("SELECT COUNT(*)::int FROM chapters WHERE status='approved'"));

  // ── Executive analytics ───────────────────────────────────
  check('Analytics', 'User accounts', an.totals.users, 'COUNT(users)', await one('SELECT COUNT(*)::int FROM users'));
  check('Analytics', 'Alumni profiles', an.totals.profiles, 'COUNT(alumni_profiles)', await one('SELECT COUNT(*)::int FROM alumni_profiles'));
  check('Analytics', 'Job applications', an.totals.job_applications, 'COUNT(job_applications)', await one('SELECT COUNT(*)::int FROM job_applications'));
  check('Analytics', 'Accepted connections', an.totals.connections,
    "COUNT(connections WHERE status='accepted')", await one("SELECT COUNT(*)::int FROM connections WHERE status='accepted'"));
  check('Analytics', 'Amount settled', an.totals.donations_amount,
    "SUM(donations WHERE status='SUCCESS')",
    Number(await one("SELECT COALESCE(SUM(amount),0) FROM donations WHERE status='SUCCESS'")));
  for (const d of an.byDepartment) {
    check('Analytics', `Dept "${d.department}"`, d.n,
      'COUNT(alumni_profiles WHERE department=…)',
      await one('SELECT COUNT(*)::int FROM alumni_profiles WHERE department=$1', [d.department]));
  }

  // ── Event ROI (the events module must be untouched) ───────
  for (const e of an.events) {
    check('Analytics / Event ROI', `Event #${e.id} registrations`, e.registrations,
      `COUNT(event_registrations WHERE event_id=${e.id})`,
      await one('SELECT COUNT(*)::int FROM event_registrations WHERE event_id=$1', [e.id]));
    check('Analytics / Event ROI', `Event #${e.id} ticket revenue`, e.revenue,
      `SUM(event_registrations.amount_paid WHERE event_id=${e.id})`,
      Number(await one('SELECT COALESCE(SUM(amount_paid),0) FROM event_registrations WHERE event_id=$1', [e.id])));
  }

  // ── Verification queue ────────────────────────────────────
  const vq = await get('/api/verification-queue', admin.token);
  check('Moderation', 'Verification queue length', vq.length,
    'COUNT(users WHERE NOT is_verified)', await one('SELECT COUNT(*)::int FROM users WHERE NOT is_verified'));

  // ── Sync ledger ───────────────────────────────────────────
  const sm = await get('/api/sync-mutations', admin.token);
  check('Admin / Offline Sync', 'Recorded mutations', sm.total,
    'COUNT(sync_mutations)', await one('SELECT COUNT(*)::int FROM sync_mutations'));

  // ── Print ─────────────────────────────────────────────────
  console.log('\nSCREEN'.padEnd(28) + 'DISPLAYED VALUE'.padEnd(20) + 'DATABASE SOURCE');
  console.log('-'.repeat(120));
  let last = '';
  for (const r of rows) {
    if (r.screen !== last) { console.log(''); last = r.screen; }
    console.log((r.ok ? '  ' : '! ') + r.screen.padEnd(26) +
      (r.label + ': ' + r.shown).padEnd(46) + r.sql +
      (r.ok ? '' : '   << MISMATCH, db says ' + r.expected));
  }
  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} metric(s) match the database, ${fail} mismatch`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
