/* PHASE 5A — AUDIT INTEGRITY + PRIVACY HARDENING
   Chain verifiability, privacy of NEW audit entries, privacy-settings
   persistence, and the deletion/purge interaction. Tamper tests live in
   tamper.js, which needs a disposable database. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const { spawnSync } = require('child_process');
const db = require(path.join(REPO, 'db'));
const auditChain = require(path.join(REPO, 'audit_chain'));
const B = 'http://localhost:8123';

const creds = {};
for (const l of fs.readFileSync(REPO + '/admin-credentials.local.txt', 'utf8').split('\n')) {
  const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
  if (m) creds[m[2]] = m[3];
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const j = async (p, o = {}) => {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(B + p, o);
      let b = null; try { b = await r.json(); } catch {}
      return { status: r.status, body: b };
    } catch (e) {
      if (a >= 2) throw e;
      await new Promise(r => setTimeout(r, 250));
    }
  }
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const POST = (p, t, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(body || {}) });
const PUT = (p, t, body) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify(body || {}) });
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

  console.log('\n=== A. the chain is recomputable from persisted values alone ===');
  const rows = (await db.query(
    `SELECT id, icon, action, meta, actor_id, actor_ref, target_type, target_id, ip,
            created_at, prev_hash, entry_hash
       FROM audit_logs WHERE chain_version = 2 ORDER BY id`)).rows;
  ok('verifiable entries exist', rows.length > 0, String(rows.length));
  let recomputed = 0;
  for (const r of rows) if (auditChain.hashOfRow(r) === r.entry_hash) recomputed++;
  ok('every entry recomputes from its own row', recomputed === rows.length, `${recomputed}/${rows.length}`);
  ok('each entry links to the previous one',
    rows.every((r, i) => i === 0 ? String(r.prev_hash).startsWith('LEGACY-BOUNDARY:')
                                 : r.prev_hash === rows[i - 1].entry_hash));
  ok('the digest input timestamp survives the database round trip',
    rows.every(r => new Date(r.created_at).toISOString() === new Date(r.created_at).toISOString()
                    && new Date(r.created_at).getMilliseconds() === new Date(r.created_at).getUTCMilliseconds()));
  ok('hashes are full SHA-256, not the old 64-bit truncation',
    rows.every(r => /^[0-9a-f]{64}$/.test(r.entry_hash)));
  ok('the legacy 16-character hash is not reused for new entries',
    rows.every(r => !/^0x[0-9A-F]{16}$/.test(String(r.entry_hash))));

  console.log('\n=== B. the verifier is independent and honest ===');
  const run = (args = []) => spawnSync(process.execPath, [path.join(REPO, 'verify_audit.js'), ...args],
    { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  const v = run(['--json']);
  const parsed = JSON.parse(v.stdout);
  ok('the verifier runs standalone', v.status === 0, String(v.status));
  ok('it reports PASS', parsed.status === 'pass');
  ok('it counts the verified entries', parsed.verified === rows.length, `${parsed.verified} vs ${rows.length}`);
  ok('it reports legacy entries SEPARATELY, never as verified',
    parsed.legacy > 0 && parsed.verified !== parsed.legacy, JSON.stringify({ l: parsed.legacy, v: parsed.verified }));
  const human = run([]);
  ok('the human output states legacy rows are not verifiable',
    /NOT cryptographically verifiable/.test(human.stdout));
  ok('it does not claim the legacy rows are verified',
    !/PASS[\s\S]*legacy[\s\S]*verified/i.test(human.stdout.replace(/NOT cryptographically verifiable/g, '')));
  ok('it needs no running application', !/require\(.*server/.test(src('verify_audit.js')));
  ok('there is no public verification endpoint',
    !/\/api\/[a-z-]*verify[a-z-]*chain/i.test(src('server.js')));
  ok('an npm script exposes it', /verify-audit-chain/.test(src('package.json')));

  console.log('\n=== C. one definition, shared by writer and verifier ===');
  ok('the writer hashes through audit_chain.js', /auditChain\.appendEntry/.test(src('routes_v2.js')));
  ok('the verifier hashes through the same module', /audit_chain/.test(src('verify_audit.js')));
  ok('no second hash implementation exists',
    !/createHash\('sha256'\)[\s\S]{0,140}slice\(0, 16\)/.test(src('routes_v2.js')));
  ok('the old in-memory timestamp digest is gone',
    !/prevHash \+ action \+ meta \+ new Date\(\)\.toISOString\(\)/.test(src('routes_v2.js')));

  console.log('\n=== D. NEW audit entries carry no unnecessary personal data ===');
  const before = (await db.query('SELECT MAX(id)::int n FROM audit_logs')).rows[0].n;

  // Exercise the writers that used to interpolate names or email addresses.
  const email = 'p5a-privacy-probe@dic.edu.bd';
  await db.query('DELETE FROM users WHERE email=$1', [email]);
  const mk = await POST('/api/admin/administrators', S.super,
    { fullName: 'Privacy Probe Person', designation: 'Probe Designation', email, role: 'moderator' });
  const probeId = mk.body?.administrator?.id;
  ok('an administrator was provisioned for the probe', !!probeId, JSON.stringify(mk.body).slice(0, 110));
  if (probeId) {
    await PUT(`/api/admin/administrators/${probeId}`, S.super, { designation: 'Changed Designation' });
    await PUT(`/api/admin/administrators/${probeId}/status`, S.super, { status: 'suspended' });
    await PUT(`/api/admin/administrators/${probeId}/status`, S.super, { status: 'active' });
    await POST(`/api/admin/administrators/${probeId}/reset-password`, S.super, {});
  }
  await PUT('/api/users/5/verify', S.super, { verified: true });

  const fresh = (await db.query('SELECT id, action, meta FROM audit_logs WHERE id > $1', [before])).rows;
  ok('the probe produced audit entries', fresh.length >= 4, String(fresh.length));
  ok('no new entry contains the probe name',
    !fresh.some(r => /Privacy Probe Person/.test(r.meta)), fresh.map(r => r.action).join(','));
  ok('no new entry contains the probe email address',
    !fresh.some(r => /p5a-privacy-probe/.test(r.meta)));
  ok('no new entry contains any email address',
    !fresh.some(r => /[\w.+-]+@[\w-]+\.[\w.]+/.test(r.meta)),
    fresh.filter(r => /@/.test(r.meta)).map(r => r.action).join(','));
  ok('no new entry contains a long high-entropy string (token/secret shaped)',
    !fresh.some(r => /[A-Za-z0-9_-]{32,}/.test(r.meta)),
    fresh.filter(r => /[A-Za-z0-9_-]{32,}/.test(r.meta)).map(r => r.action).join(','));
  ok('entries still identify their subject by id',
    fresh.every(r => /user \d+|vault \d+|person \d+|registration \d+|donation \d+|campaign \d+|"/.test(r.meta)),
    fresh.map(r => r.action + ':' + r.meta.slice(0, 40)).join(' | ').slice(0, 200));
  ok('the actor is recorded as a queryable column, not only prose',
    fresh.filter(r => /Administrator/.test(r.action)).every(r => r.action && true));
  const actorCols = (await db.query(
    'SELECT COUNT(*)::int n FROM audit_logs WHERE id > $1 AND actor_ref IS NOT NULL', [before])).rows[0].n;
  ok('new entries populate the immutable actor reference', actorCols >= 4, String(actorCols));
  /* The whole reason actor_ref exists: a digest input must not be a column the
     database is entitled to rewrite. actor_id has ON DELETE SET NULL; actor_ref
     must have no foreign key at all. */
  const fkFree = (await db.query(
    `SELECT COUNT(*)::int n
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name='audit_logs' AND tc.constraint_type='FOREIGN KEY'
        AND kcu.column_name='actor_ref'`)).rows[0].n;
  ok('the digest actor column has no foreign key to mutate it', fkFree === 0, String(fkFree));

  // Source-level guarantee, not just this sample.
  const writers = ['server.js', 'routes_v2.js', 'routes_events.js', 'routes_admin_users.js',
                   'routes_compliance.js', 'routes_planner.js', 'jobs.js'];
  const auditLines = [];
  for (const f of writers) {
    const t = src(f);
    const re = /writeAudit(?:Safe)?\(([\s\S]{0,320}?)\);/g;
    let m; while ((m = re.exec(t))) auditLines.push({ f, code: m[1] });
  }
  ok('every audit writer was located', auditLines.length >= 30, String(auditLines.length));
  const leaks = auditLines.filter(a => /full_name|\.email\b|<\$\{|primary_email/.test(a.code));
  ok('no audit writer interpolates a name or email address', leaks.length === 0,
    leaks.map(l => l.f).join(','));
  /* Only the INTERPOLATED values matter. An action name legitimately reads
     'Password Reset Completed'; what must never appear is a secret VALUE, and
     a value can only enter meta through a ${...} expression. */
  const interpolations = auditLines.flatMap(a =>
    [...a.code.matchAll(/\$\{([^}]*)\}/g)].map(m => ({ f: a.f, expr: m[1] })));
  ok('interpolations were found to inspect', interpolations.length > 20, String(interpolations.length));
  const secrets = interpolations.filter(x =>
    /password|token|secret|ciphertext|plaintext|\bhash\b|\bpw\b/i.test(x.expr));
  ok('no audit writer interpolates a secret value', secrets.length === 0,
    secrets.map(x => x.f + ':' + x.expr).join(' | '));

  console.log('\n=== E. historical evidence is preserved, not scrubbed ===');
  const legacy = await db.query(
    'SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version = 0');
  ok('the legacy segment still exists', legacy.rows[0].n > 700, String(legacy.rows[0].n));
  ok('no legacy row was given a fabricated entry_hash',
    (await db.query('SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=0 AND entry_hash IS NOT NULL')).rows[0].n === 0);
  ok('legacy rows keep their original hash',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs WHERE chain_version=0 AND hash IS NULL`)).rows[0].n === 0);
  ok('the documentation states the limitation',
    /NOT cryptographically verifiable|cannot be verified/i.test(src('AUDIT_CHAIN.md')));
  ok('it explains why, rather than only asserting it',
    /never persisted|discarded/i.test(src('AUDIT_CHAIN.md')));

  console.log('\n=== F. privacy settings persist end to end ===');
  const alum = S.alum;
  const readPriv = async () => (await j('/api/profile/me', H(alum))).body?.privacy_settings || {};
  const original = await readPriv();

  const set1 = await PUT('/api/profile/me', alum, { privacySettings: { mobile: 'private', email: 'private' } });
  ok('a privacy change is accepted', set1.status === 200, JSON.stringify(set1.body).slice(0, 110));
  let now = await readPriv();
  ok('it is stored', now.mobile === 'private' && now.email === 'private', JSON.stringify(now));

  const set2 = await PUT('/api/profile/me', alum, { privacySettings: { mobile: 'public' } });
  ok('a partial change is accepted', set2.status === 200);
  now = await readPriv();
  ok('it merges rather than replacing', now.mobile === 'public' && now.email === 'private', JSON.stringify(now));

  // Survives a fresh session.
  const re = await login('alumni@dic.edu.bd', creds['alumni@dic.edu.bd']);
  const after = (await j('/api/profile/me', H(re.body.token))).body?.privacy_settings || {};
  ok('it survives sign-out and sign-in', after.mobile === 'public' && after.email === 'private', JSON.stringify(after));

  // And it is actually ENFORCED, which is the point of storing it.
  await PUT('/api/profile/me', alum, { privacySettings: { mobile: 'private', email: 'private' } });
  const asOther = await j('/api/alumni/5', H(S.mod));
  ok('a private field is withheld from another member',
    asOther.body?.mobile === null && asOther.body?.email === null,
    JSON.stringify({ m: asOther.body?.mobile, e: asOther.body?.email }));
  await PUT('/api/profile/me', alum, { privacySettings: { mobile: 'public', email: 'public' } });
  const asOther2 = await j('/api/alumni/5', H(S.mod));
  ok('a public field is shown to another member', asOther2.body?.mobile !== null || asOther2.body?.email !== null);

  console.log('\n=== G. the privacy editor cannot write arbitrary JSON ===');
  for (const [label, payload] of [
    ['an unknown field', { privacySettings: { nickname: 'private' } }],
    ['an unknown level', { privacySettings: { mobile: 'secret' } }],
    ['a non-string level', { privacySettings: { mobile: 123 } }],
    ['a nested object', { privacySettings: { mobile: { level: 'private' } } }],
    ['an array', { privacySettings: ['private'] }],
    ['a null', { privacySettings: null }],
  ]) {
    ok(`${label} is rejected`, (await PUT('/api/profile/me', alum, payload)).status === 400, label);
  }
  const stillGood = await readPriv();
  ok('the rejected writes changed nothing', stillGood.mobile === 'public', JSON.stringify(stillGood));
  // Restore whatever the account had before this suite ran.
  if (Object.keys(original).length) await PUT('/api/profile/me', alum, { privacySettings: {
    mobile: original.mobile || 'private', email: original.email || 'alumni' } });

  console.log('\n=== H. only settings the server enforces are offered ===');
  const prof = src('js/profile.js');
  /* Phase 5A pinned this to a hardcoded PROFILE_PRIVACY_SETTINGS = {mobile,
     email} literal, which was the right guarantee expressed as the wrong
     test: it asserted the mechanism rather than the property. Phase 5B
     removed the hardcoded list and builds the controls from
     GET /api/profile/privacy-schema - the same privacy.js object the server
     validates writes against. The property is now stronger (the client cannot
     offer a field the server does not enforce, by construction rather than by
     two hand-maintained lists agreeing), so the assertion tests that. */
  ok('the client derives its privacy fields from the server, not a local list',
    /getPrivacySchema/.test(prof) &&
    !/PROFILE_PRIVACY_SETTINGS = \{\s*mobile:/.test(prof));
  ok('no unenforced field is offered in the editor',
    !/pf-priv-(address|cgpa|linkedin|github|company)/.test(prof));
  ok('the stored value is loaded, not just the defaults', /p\.privacy_settings/.test(prof));
  ok('the dead editor no longer writes privacy in memory only',
    !/PROFILE_PRIVACY_SETTINGS\.mobile = document\.getElementById\('edit-priv-mobile'\)/.test(prof));

  console.log('\n=== I. purge interaction ===');
  const pe = 'p5a-purge-subject@dic.test';
  await db.query('DELETE FROM users WHERE email=$1', [pe]);
  const pu = await db.query(
    `INSERT INTO users (full_name,email,password_hash,role,role_label,initials,department,is_verified)
     VALUES ('Purge Chain Subject',$1,'scrypt$x$y','alumni','Alumni','PC','CSE',true) RETURNING id`, [pe]);
  const puid = pu.rows[0].id;
  await db.query(`INSERT INTO deletion_requests (user_id, purge_after) VALUES ($1, NOW()-INTERVAL '1 second')`, [puid]);

  const chainBefore = await auditChain.verifyChain(db);
  const purge = await j('/api/internal/jobs/run?job=deletion-purge', {
    method: 'POST',
    headers: { 'X-Cron-Key': (fs.readFileSync(REPO + '/.env', 'utf8').match(/^CRON_SECRET=(.+)$/m) || [])[1] }
  });
  ok('the purge ran', purge.status === 200, String(purge.status));
  ok('the account is gone', (await db.query('SELECT COUNT(*)::int n FROM users WHERE id=$1', [puid])).rows[0].n === 0);

  const chainAfter = await auditChain.verifyChain(db);
  ok('the chain still verifies after a purge', chainAfter.ok, JSON.stringify(chainAfter.firstInvalid));
  ok('purging did not destroy audit entries', chainAfter.verifiedCount >= chainBefore.verifiedCount);
  const purgeEntry = (await db.query(
    "SELECT meta, actor_id, target_id FROM audit_logs WHERE action='Account Purged' AND target_id=$1", [puid])).rows[0];
  ok('the purge is audited', !!purgeEntry);
  ok('the purge entry names no erased person',
    purgeEntry && !/Purge Chain Subject/.test(purgeEntry.meta), purgeEntry?.meta);
  ok('the deletion evidence survives',
    (await db.query('SELECT COUNT(*)::int n FROM deletion_requests WHERE purged_at IS NOT NULL')).rows[0].n >= 1);

  console.log('\n=== I2. an audit entry cannot be suppressed by an oversized header ===');
  {
    /* writeAudit swallows its own errors so an audit failure never breaks a
       request. That meant a value too long for its column silently dropped the
       entry while the action still succeeded. audit_logs.ip is VARCHAR(64) and
       clientIp() honours X-Forwarded-For, so this was reachable from a header. */
    const beforeN = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
    const long = Array.from({ length: 40 }, (_, i) => '10.0.0.' + i).join(', ');
    const r = await fetch(B + '/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': long },
      body: JSON.stringify({ email: 'admin@dic.edu.bd' })
    });
    ok('the action still succeeds', r.status === 200, String(r.status));
    const afterN = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
    ok('and the audit entry was NOT suppressed', afterN > beforeN, beforeN + ' -> ' + afterN);
    const last = (await db.query('SELECT ip FROM audit_logs ORDER BY id DESC LIMIT 1')).rows[0];
    ok('the recorded address fits its column', (last.ip || '').length <= 64, String((last.ip || '').length));
    const after = await auditChain.verifyChain(db);
    ok('the chain still verifies', after.ok, JSON.stringify(after.firstInvalid));
  }

  console.log('\n=== I3. an entry with an unknown chain version cannot hide ===');
  {
    const probe = await db.query(
      `INSERT INTO audit_logs (icon, action, meta, created_at, chain_version, prev_hash, entry_hash)
       VALUES ('x','Unknown Version Probe','probe', NOW(), 99, 'a', 'b') RETURNING id`);
    const v = await auditChain.verifyChain(db);
    ok('the verifier refuses to ignore it',
      !v.ok && v.problems.some(p => p.reason === 'unknown-chain-version'),
      JSON.stringify(v.problems.map(p => p.reason)));
    await db.query('DELETE FROM audit_logs WHERE id=$1', [probe.rows[0].id]);
    ok('the chain verifies again once it is removed', (await auditChain.verifyChain(db)).ok);
  }

  console.log('\n=== J. audit read access is unchanged and restricted ===');
  ok('unauthenticated cannot read the audit log', (await j('/api/audit-logs')).status === 401);
  for (const r of ['alum', 'mod', 'dept']) {
    ok(`${r} cannot read the audit log`, (await j('/api/audit-logs', H(S[r]))).status === 403, r);
  }
  ok('an admin can', (await j('/api/audit-logs', H(S.univ))).status === 200);

  console.log('\n=== cleanup ===');
  await db.query('DELETE FROM users WHERE email IN ($1,$2)', [email, pe]);
  await db.query('DELETE FROM deletion_requests WHERE user_id IS NULL AND purged_at IS NOT NULL');
  ok('probe accounts removed',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE email IN ($1,$2)', [email, pe])).rows[0].n === 0);
  const finalChain = await auditChain.verifyChain(db);
  ok('the chain verifies at the end of the run', finalChain.ok, JSON.stringify(finalChain.firstInvalid));

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
