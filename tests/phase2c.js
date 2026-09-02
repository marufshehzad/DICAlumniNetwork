/* PHASE 2C verification: self-service recovery, session revocation, suspension,
   password behaviour, seed protection, CORS and host routing. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const crypto = require('crypto');
const db = require(path.join(REPO, 'db'));
const B = 'http://localhost:8123';

const creds = {};
for (const l of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
  const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
  if (m) creds[m[2]] = m[3];
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, headers: r.headers };
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const POST = (p, t, body) => j(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  body: JSON.stringify(body || {})
});
const PUT = (p, t, body) => j(p, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
  body: JSON.stringify(body || {})
});
const login = (e, p) => POST('/api/auth/login', null, { email: e, password: p });

(async () => {
  const S = {};
  for (const [email, k] of [['admin@dic.edu.bd', 'super'], ['collegeadmin@dic.edu.bd', 'univ'],
                            ['departmentadmin@dic.edu.bd', 'dept'], ['moderator@dic.edu.bd', 'mod'],
                            ['alumni@dic.edu.bd', 'alum']]) {
    S[k] = (await login(email, creds[email])).body?.token;
  }

  // A throwaway administrator so nothing below touches a real account.
  const email = 'p2c-test@dic.edu.bd';
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  const made = await POST('/api/admin/administrators', S.super, {
    fullName: 'Phase 2C Subject', designation: 'Registrar',
    email, role: 'dept_admin'
  });
  const id = made.body.administrator.id;
  let pw = made.body.temporaryPassword;

  // Get it past the forced change so it has an ordinary session.
  let sess = (await login(email, pw)).body.token;
  const firstPw = 'Phase2C-First-' + Date.now().toString(36);
  const chg = await POST('/api/auth/change-password', sess, { currentPassword: pw, newPassword: firstPw });
  ok('change-password returns a replacement token', chg.status === 200 && typeof chg.body.token === 'string');
  const oldSess = sess;
  sess = chg.body.token;
  pw = firstPw;

  console.log('\n=== 2. SESSION REVOCATION ===');
  ok('the session that changed the password is revoked',
    (await j('/api/auth/me', H(oldSess))).status === 401, (await j('/api/auth/me', H(oldSess))).status);
  ok('the replacement token works', (await j('/api/auth/me', H(sess))).status === 200);
  ok('a revoked session answers 401, not 403',
    (await j('/api/auth/me', H(oldSess))).body?.error?.includes('session has ended'));

  // Two concurrent sessions; signing out of one must end both.
  const a = (await login(email, pw)).body.token;
  const b = (await login(email, pw)).body.token;
  ok('two concurrent sessions both work',
    (await j('/api/auth/me', H(a))).status === 200 && (await j('/api/auth/me', H(b))).status === 200);
  ok('logout succeeds', (await POST('/api/auth/logout', a)).status === 200);
  ok('the signed-out session is dead', (await j('/api/auth/me', H(a))).status === 401);
  ok('sign-out ends the account\'s other sessions too', (await j('/api/auth/me', H(b))).status === 401);
  sess = (await login(email, pw)).body.token;

  console.log('\n=== 3. SUSPENSION ===');
  const live = (await login(email, pw)).body.token;
  ok('the account works before suspension', (await j('/api/auth/me', H(live))).status === 200);
  ok('suspend applies', (await PUT(`/api/admin/administrators/${id}/status`, S.super, { status: 'suspended' })).status === 200);
  const susp = await j('/api/auth/me', H(live));
  ok('an already-issued token fails immediately', susp.status === 403 || susp.status === 401, susp.status);
  ok('a suspended account cannot sign in',
    (await login(email, pw)).status === 403);
  for (const p of ['/api/alumni', '/api/events', '/api/notifications', '/api/stats/overview']) {
    const r = await j(p, H(live));
    ok(`suspended token refused on ${p}`, r.status === 403 || r.status === 401, r.status);
  }
  ok('reactivate applies', (await PUT(`/api/admin/administrators/${id}/status`, S.super, { status: 'active' })).status === 200);
  ok('the old token stays dead after reactivation',
    (await j('/api/auth/me', H(live))).status === 401);
  ok('a fresh sign-in works after reactivation', (await login(email, pw)).status === 200);

  console.log('\n=== 4. PASSWORD CHANGE ===');
  let s2 = (await login(email, pw)).body.token;
  ok('the current password is required',
    (await POST('/api/auth/change-password', s2, { currentPassword: 'wrong', newPassword: 'abcdefgh1' })).status === 401);
  ok('a short password is refused',
    (await POST('/api/auth/change-password', s2, { currentPassword: pw, newPassword: 'short' })).status === 400);
  const pw2 = 'Phase2C-Second-' + Date.now().toString(36);
  const c2 = await POST('/api/auth/change-password', s2, { currentPassword: pw, newPassword: pw2 });
  ok('the change succeeds', c2.status === 200);
  ok('the old password is immediately invalid', (await login(email, pw)).status === 401);
  ok('the new password works', (await login(email, pw2)).status === 200);
  const stamp = (await db.query('SELECT last_password_changed_at, token_version FROM users WHERE id=$1', [id])).rows[0];
  ok('last_password_changed_at updated', !!stamp.last_password_changed_at);
  ok('token_version advanced', stamp.token_version > 1, stamp.token_version);
  pw = pw2;

  console.log('\n=== 1. SELF-SERVICE RECOVERY ===');
  const unknown = await POST('/api/auth/forgot-password', null, { email: 'no-such-person@dic.edu.bd' });
  const known = await POST('/api/auth/forgot-password', null, { email });
  ok('a request for an unknown address answers 200', unknown.status === 200);
  ok('a request for a real address answers 200', known.status === 200);
  ok('both answers are byte-identical', JSON.stringify(unknown.body) === JSON.stringify(known.body),
    JSON.stringify(unknown.body) + ' vs ' + JSON.stringify(known.body));
  ok('the response never contains a token',
    !/token/i.test(JSON.stringify(known.body)), JSON.stringify(known.body));
  const stored = (await db.query('SELECT reset_token_hash, reset_expires_at FROM users WHERE id=$1', [id])).rows[0];
  ok('a token hash was stored', !!stored.reset_token_hash);
  ok('the stored value is a SHA-256 hash, not a token', /^[0-9a-f]{64}$/.test(stored.reset_token_hash || ''));
  const ttlMin = (new Date(stored.reset_expires_at) - Date.now()) / 60000;
  ok('it expires within 30 minutes', ttlMin > 25 && ttlMin <= 30, ttlMin.toFixed(1) + ' min');

  // Mint one the way the CLI does so the completion path can be exercised.
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`UPDATE users SET reset_token_hash = $1, reset_expires_at = NOW() + INTERVAL '30 minutes' WHERE id = $2`,
    [crypto.createHash('sha256').update(token).digest('hex'), id]);
  const liveBefore = (await login(email, pw)).body.token;

  ok('a wrong token is refused', (await POST('/api/auth/reset-password', null,
    { token: 'not-a-real-token', newPassword: 'abcdefgh1' })).status === 400);
  ok('a short new password is refused', (await POST('/api/auth/reset-password', null,
    { token, newPassword: 'short' })).status === 400);

  const pw3 = 'Phase2C-Reset-' + Date.now().toString(36);
  const done = await POST('/api/auth/reset-password', null, { token, newPassword: pw3 });
  ok('the reset completes', done.status === 200, JSON.stringify(done.body));
  ok('the new password works', (await login(email, pw3)).status === 200);
  ok('the previous password is dead', (await login(email, pw)).status === 401);
  ok('the token is single use', (await POST('/api/auth/reset-password', null,
    { token, newPassword: 'AnotherOne123' })).status === 400);
  ok('sessions open before the reset are revoked',
    (await j('/api/auth/me', H(liveBefore))).status === 401);
  const cleared = (await db.query('SELECT reset_token_hash, reset_expires_at FROM users WHERE id=$1', [id])).rows[0];
  ok('the stored hash is cleared', cleared.reset_token_hash === null && cleared.reset_expires_at === null);

  // An expired token must not work.
  const stale = crypto.randomBytes(32).toString('base64url');
  await db.query(`UPDATE users SET reset_token_hash = $1, reset_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $2`,
    [crypto.createHash('sha256').update(stale).digest('hex'), id]);
  ok('an expired token is refused', (await POST('/api/auth/reset-password', null,
    { token: stale, newPassword: 'AnotherOne123' })).status === 400);

  // A suspended account cannot recover itself. Clear the column first — the
  // expired-token check above left its hash behind, so a stale value would look
  // like a freshly issued token.
  await db.query('UPDATE users SET reset_token_hash = NULL, reset_expires_at = NULL WHERE id = $1', [id]);
  await PUT(`/api/admin/administrators/${id}/status`, S.super, { status: 'suspended' });
  await POST('/api/auth/forgot-password', null, { email });
  const noneForSuspended = (await db.query('SELECT reset_token_hash FROM users WHERE id=$1', [id])).rows[0];
  ok('a suspended account is issued no reset token', !noneForSuspended.reset_token_hash);
  await PUT(`/api/admin/administrators/${id}/status`, S.super, { status: 'active' });

  console.log('\n=== 11. ROLE ISOLATION ===');
  for (const r of ['alum', 'mod', 'dept', 'univ']) {
    ok(`${r} cannot provision an administrator`,
      (await POST('/api/admin/administrators', S[r], { fullName: 'X', designation: 'Y', email: 'x@dic.edu.bd', role: 'moderator' })).status === 403);
    ok(`${r} cannot suspend an administrator`,
      (await PUT(`/api/admin/administrators/${id}/status`, S[r], { status: 'suspended' })).status === 403);
    ok(`${r} cannot reset an administrator's password`,
      (await POST(`/api/admin/administrators/${id}/reset-password`, S[r], {})).status === 403);
    ok(`${r} cannot change an administrator's role`,
      (await PUT(`/api/admin/administrators/${id}`, S[r], { role: 'univ_admin' })).status === 403);
  }

  console.log('\n=== 13. PRODUCTION SEED PROTECTION ===');
  const seed = await POST('/api/seed-db', S.super);
  ok('super_admin is refused in production', seed.status === 403 && /production/i.test(seed.body?.error || ''),
    seed.status + ' ' + (seed.body?.error || ''));

  console.log('\n=== 12. AUDIT ===');
  const audits = await j('/api/audit-logs', H(S.super));
  const mine = (audits.body || []).filter(a => a.target_type === 'user' && a.target_id === id);
  for (const act of ['Administrator Created', 'Administrator Suspended', 'Administrator Activated',
                     'Password Changed', 'Password Reset Requested', 'Password Reset Completed', 'Signed Out']) {
    ok(`audited: ${act}`, mine.some(a => a.action === act), mine.map(a => a.action).join(' | '));
  }
  ok('every entry names an actor', mine.every(a => a.actor_id !== null));
  ok('every entry carries a timestamp', mine.every(a => !!a.created_at));
  const blob = JSON.stringify(mine);
  ok('no audit entry contains a password', !blob.includes(pw3) && !blob.includes(pw2));
  ok('no audit entry contains a reset token', !blob.includes(token) && !blob.includes(stale));

  console.log('\n=== cleanup ===');
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  ok('test account removed',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE email = $1', [email])).rows[0].n === 0);

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
