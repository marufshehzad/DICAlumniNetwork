/* Phase 1.5 additions to the source-of-truth check: segmentation, mentorship
   matching, and every compliance / vault figure. Each UI value is compared with
   a direct query. */
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
const check = (screen, metric, ui, dbv, sql) => {
  const ok = String(ui) === String(dbv);
  ok ? pass++ : fail++;
  rows.push({ screen, metric, ui: String(ui), dbv: String(dbv), sql, ok });
};

(async () => {
  const login = async (e) => (await (await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: creds[e] })
  })).json());
  const admin = await login('admin@dic.edu.bd');
  const alum = await login('alumni@dic.edu.bd');
  const get = async (p, t) => (await (await fetch(B + p, { headers: { Authorization: 'Bearer ' + t } })).json());
  const one = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];

  // ── Segmentation ──────────────────────────────────────────
  const opt = await get('/api/segment/options', admin.token);
  check('Admin / Segmentation', 'Profiles in scope', opt.total,
    await one('SELECT COUNT(*)::int FROM alumni_profiles'), 'COUNT(alumni_profiles)');
  check('Admin / Segmentation', 'Earliest batch', opt.min_batch,
    await one('SELECT MIN(batch)::int FROM alumni_profiles'), 'MIN(alumni_profiles.batch)');
  check('Admin / Segmentation', 'Latest batch', opt.max_batch,
    await one('SELECT MAX(batch)::int FROM alumni_profiles'), 'MAX(alumni_profiles.batch)');
  check('Admin / Segmentation', 'Offers mentoring', opt.mentors,
    await one('SELECT COUNT(*)::int FROM alumni_profiles WHERE can_mentor'), 'COUNT(can_mentor)');
  check('Admin / Segmentation', 'Accounts with a settled donation', opt.donors,
    await one("SELECT COUNT(DISTINCT donor_user_id)::int FROM donations WHERE status='SUCCESS'"),
    "COUNT(DISTINCT donor_user_id WHERE status='SUCCESS')");
  check('Admin / Segmentation', 'Department options', opt.departments.length,
    await one("SELECT COUNT(DISTINCT department)::int FROM alumni_profiles WHERE department IS NOT NULL AND department<>''"),
    'COUNT(DISTINCT department)');
  check('Admin / Segmentation', 'Industry options', opt.industries.length,
    await one("SELECT COUNT(DISTINCT industry)::int FROM alumni_profiles WHERE industry IS NOT NULL AND industry<>''"),
    'COUNT(DISTINCT industry)');

  const combos = [
    ['no filter', '', 'SELECT COUNT(*)::int FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id'],
    ['donor=donors', '?donor=donors',
      "SELECT COUNT(*)::int FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id WHERE EXISTS (SELECT 1 FROM donations d WHERE d.donor_user_id=u.id AND d.status='SUCCESS')"],
    ['donor=nondonors', '?donor=nondonors',
      "SELECT COUNT(*)::int FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id WHERE NOT EXISTS (SELECT 1 FROM donations d WHERE d.donor_user_id=u.id AND d.status='SUCCESS')"],
    ['batch 2018-2021', '?batchFrom=2018&batchTo=2021',
      'SELECT COUNT(*)::int FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id WHERE ap.batch>=2018 AND ap.batch<=2021'],
    ['industry=tech + mentor', '?industry=tech&mentor=true',
      "SELECT COUNT(*)::int FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id WHERE ap.industry='tech' AND ap.can_mentor"],
    ['department=CSE', '?department=' + encodeURIComponent('Computer Science & Engineering'),
      "SELECT COUNT(*)::int FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id WHERE ap.department='Computer Science & Engineering'"]
  ];
  for (const [label, qs, sql] of combos) {
    const r = await get('/api/segment/count' + qs, admin.token);
    check('Admin / Segmentation', 'Segment: ' + label, r.matched, await one(sql), sql.replace(/\s+/g, ' ').slice(0, 78));
  }

  // Determinism: the same request three times must give the same number.
  const a = await get('/api/segment/count?industry=tech', admin.token);
  const b = await get('/api/segment/count?industry=tech', admin.token);
  const c = await get('/api/segment/count?industry=tech', admin.token);
  check('Admin / Segmentation', 'Repeated query is stable',
    `${a.matched}/${b.matched}/${c.matched}`,
    `${a.matched}/${a.matched}/${a.matched}`, 'same filter, three calls');

  // ── Mentorship matching ───────────────────────────────────
  const sug = await get('/api/mentorships/suggestions', alum.token);
  check('Mentorship', 'Suggested mentors returned', sug.length,
    Math.min(6, await one(`SELECT COUNT(*)::int FROM alumni_profiles ap JOIN users u ON u.id=ap.user_id
      WHERE ap.can_mentor AND u.id <> $1 AND NOT EXISTS (SELECT 1 FROM mentorships m
        WHERE m.mentor_id=u.id AND m.mentee_id=$1 AND m.status IN ('pending','accepted'))`, [alum.user.id])),
    'COUNT(can_mentor, excluding self and open requests), LIMIT 6');

  for (const m of sug.slice(0, 4)) {
    const real = (await db.query(`
      SELECT (me.industry IS NOT NULL AND them.industry IS NOT DISTINCT FROM me.industry) AS ind,
             (me.skills IS NOT NULL AND them.skills ILIKE '%'||split_part(me.skills,',',1)||'%') AS skill,
             (me.city IS NOT NULL AND them.city IS NOT DISTINCT FROM me.city) AS city,
             (me.department IS NOT NULL AND them.department IS NOT DISTINCT FROM me.department) AS dept
      FROM alumni_profiles me, alumni_profiles them
      WHERE me.user_id=$1 AND them.user_id=$2`, [alum.user.id, m.id])).rows[0];
    const expected = [real.ind, real.skill, real.city, real.dept].filter(Boolean).length;
    check('Mentorship', `${m.name}: shared attributes`, m.match_score, expected,
      'industry + skills + city + department, each 0 or 1');
    check('Mentorship', `${m.name}: flags agree`,
      [m.matched_industry, m.matched_skill, m.matched_city, m.matched_department].join(','),
      [real.ind, real.skill, real.city, real.dept].join(','), 'matched_* flags vs SQL');
  }
  // The score must never exceed the number of comparable attributes.
  check('Mentorship', 'No score exceeds 4', sug.every(m => m.match_score <= 4), true, 'max 4 comparisons');

  // ── Compliance / vault ────────────────────────────────────
  const comp = await get('/api/compliance/status', admin.token);
  const find = (t) => comp.find(x => x.title.includes(t)) || {};
  const nIn = (s) => { const m = String(s).match(/(\d+)/); return m ? parseInt(m[1]) : null; };

  check('Admin / Compliance', 'Encrypted identity fields', nIn(find('Field Encryption').desc),
    await one('SELECT COUNT(*)::int FROM identity_vault'), 'COUNT(identity_vault)');
  check('Admin / Compliance', 'Consent events recorded', nIn(find('Consent Logging').desc),
    await one('SELECT COUNT(*)::int FROM consent_logs'), 'COUNT(consent_logs)');
  /* The pill used to report one undifferentiated COUNT(audit_logs) and call it
     all hash-chained. Phase 5A splits it, because entries written before the
     boundary cannot be recomputed by anyone (AUDIT_CHAIN.md 1-2) and showing
     them as equivalent overstated the guarantee in the very panel an admin
     reads to judge it. All three figures are now checked. */
  const auditDesc = find('Audit Trail').desc || '';
  const CV = require(path.join(REPO, 'audit_chain')).CHAIN_VERSION;
  check('Admin / Compliance', 'Independently verifiable audit entries',
    parseInt((auditDesc.match(/(\d+)\s+independently verifiable/) || [])[1]),
    await one(`SELECT COUNT(*)::int FROM audit_logs WHERE chain_version = ${CV}`),
    `COUNT(audit_logs WHERE chain_version=${CV})`);
  check('Admin / Compliance', 'Legacy audit entries, reported as unverifiable',
    parseInt((auditDesc.match(/(\d+)\s+legacy entries/) || [])[1]),
    await one(`SELECT COUNT(*)::int FROM audit_logs WHERE chain_version IS DISTINCT FROM ${CV}`),
    `COUNT(audit_logs WHERE chain_version<>${CV})`);
  check('Admin / Compliance', 'Vault access records',
    parseInt((auditDesc.match(/(\d+)\s+vault access/) || [])[1]),
    await one('SELECT COUNT(*)::int FROM vault_access_logs'), 'COUNT(vault_access_logs)');
  check('Admin / Compliance', 'Deletion requests pending', nIn(find('Data Subject Rights').desc),
    await one("SELECT COUNT(*)::int FROM deletion_requests WHERE status='pending'"),
    "COUNT(deletion_requests WHERE status='pending')");

  const vault = await get('/api/vault', admin.token);
  check('Admin / NID Vault', 'Vault entries listed', vault.entries.length,
    await one('SELECT COUNT(*)::int FROM identity_vault'), 'COUNT(identity_vault)');
  const vlogs = await get('/api/vault/access-logs', admin.token);
  check('Admin / NID Vault', 'Access log entries', vlogs.length,
    await one('SELECT COUNT(*)::int FROM vault_access_logs'), 'COUNT(vault_access_logs)');
  const consent = await get('/api/consent', alum.token);
  check('Profile / Consent', 'My consent records', consent.length,
    await one('SELECT COUNT(*)::int FROM consent_logs WHERE user_id=$1', [alum.user.id]),
    'COUNT(consent_logs WHERE user_id=me)');

  // ── Print ─────────────────────────────────────────────────
  console.log('\n| Screen | Metric | UI Value | DB Value | Match |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.screen} | ${r.metric} | ${r.ui} | ${r.dbv} | ${r.ok ? 'yes' : 'NO — ' + r.sql} |`);
  }
  console.log(`\n  ${pass} match, ${fail} mismatch`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
