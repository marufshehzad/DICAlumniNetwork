/* PHASE 2B verification. No password is printed except ones this test itself
   generated for accounts it also deletes. */
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
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const H = (t, extra = {}) => ({ headers: { Authorization: 'Bearer ' + t, ...extra } });
const POST = (p, t, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(body || {}) });
const PUT = (p, t, body) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify(body || {}) });
const login = (e, p) => POST('/api/auth/login', null, { email: e, password: p });

(async () => {
  const S = {};
  for (const [email, role] of [['admin@dic.edu.bd', 'super'], ['collegeadmin@dic.edu.bd', 'univ'],
                               ['departmentadmin@dic.edu.bd', 'dept'], ['moderator@dic.edu.bd', 'mod'],
                               ['alumni@dic.edu.bd', 'alum']]) {
    const r = await login(email, creds[email]);
    S[role] = r.body?.token;
  }

  console.log('\n=== A1. reminder-sweep is staff only ===');
  ok('alumni refused', (await POST('/api/events/tasks/reminder-sweep', S.alum)).status === 403);
  for (const r of ['mod', 'dept', 'univ', 'super']) {
    ok(`${r} permitted`, (await POST('/api/events/tasks/reminder-sweep', S[r])).status === 200);
  }

  console.log('\n=== A2. seed-db is super-only and refused in production ===');
  for (const r of ['alum', 'mod', 'dept', 'univ']) {
    ok(`${r} refused seed-db`, (await POST('/api/seed-db', S[r])).status === 403);
  }
  const seedProd = await POST('/api/seed-db', S.super);
  ok('super_admin refused in production mode', seedProd.status === 403 &&
     /production/i.test(seedProd.body?.error || ''), seedProd.status + ' ' + (seedProd.body?.error || ''));

  console.log('\n=== A3. administrator management is super_admin only ===');
  for (const r of ['alum', 'mod', 'dept', 'univ']) {
    ok(`${r} refused the administrator list`, (await j('/api/admin/administrators', H(S[r]))).status === 403);
    ok(`${r} refused administrator creation`,
      (await POST('/api/admin/administrators', S[r],
        { fullName: 'X', designation: 'Y', email: 'x' + r + '@dic.edu.bd', role: 'moderator' })).status === 403);
  }
  const list = await j('/api/admin/administrators', H(S.super));
  ok('super_admin lists administrators', list.status === 200 && Array.isArray(list.body.administrators));
  ok('list contains only staff', (list.body.administrators || []).every(a => a.role !== 'alumni'));
  ok('list exposes no password field',
    !JSON.stringify(list.body).match(/password_hash|reset_token_hash/));
  ok('list carries designation, status, last login and creator',
    (list.body.administrators || []).every(a =>
      'designation' in a && 'status' in a && 'lastLoginAt' in a && 'createdByName' in a));

  console.log('\n=== E. create an administrator ===');
  const email = 'p2b-test-admin@dic.edu.bd';
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  const bad = await POST('/api/admin/administrators', S.super, { fullName: 'A', email, role: 'moderator' });
  ok('designation is required', bad.status === 400 && /designation/i.test(bad.body?.error || ''));
  const badRole = await POST('/api/admin/administrators', S.super,
    { fullName: 'A', designation: 'D', email, role: 'super_admin' });
  ok('super_admin cannot be assigned through the form', badRole.status === 400);

  const created = await POST('/api/admin/administrators', S.super, {
    fullName: 'Phase 2B Test Officer', designation: 'Finance Officer',
    email, phone: '+880 1700-111222', department: 'Finance', role: 'dept_admin'
  });
  ok('administrator created', created.status === 200, created.status + ' ' + JSON.stringify(created.body).slice(0, 90));
  const newId = created.body?.administrator?.id;
  ok('designation stored', created.body?.administrator?.designation === 'Finance Officer');
  ok('permission role stored separately from designation',
    created.body?.administrator?.role === 'dept_admin' &&
    created.body?.administrator?.roleLabel === 'Department Admin');
  ok('flagged must_change_password', created.body?.administrator?.mustChangePassword === true);
  ok('created_by records the super admin', created.body?.administrator?.createdBy === 1);
  ok('temporary password returned once', typeof created.body?.temporaryPassword === 'string' &&
     created.body.temporaryPassword.length >= 16);
  const tempPw = created.body?.temporaryPassword;

  const dup = await POST('/api/admin/administrators', S.super,
    { fullName: 'A', designation: 'D', email, role: 'moderator' });
  ok('duplicate email refused', dup.status === 409);

  console.log('\n=== F. forced password change on first sign-in ===');
  const first = await login(email, tempPw);
  ok('new administrator can sign in', first.status === 200 && !!first.body.token);
  ok('server tells the client a change is required', first.body?.mustChangePassword === true);
  ok('publicUser marks them as staff', first.body?.user?.isStaff === true);
  ok('publicUser carries the designation', first.body?.user?.designation === 'Finance Officer');
  const newPw = 'Phase2B-Chosen-' + Date.now().toString(36);
  const chg = await POST('/api/auth/change-password', first.body.token,
    { currentPassword: tempPw, newPassword: newPw });
  ok('password change accepted', chg.status === 200);
  const after = await login(email, newPw);
  ok('flag cleared after the change', after.status === 200 && after.body.mustChangePassword === false);
  const stamped = (await db.query('SELECT last_password_changed_at, last_login_at FROM users WHERE id=$1', [newId])).rows[0];
  ok('last_password_changed_at recorded', !!stamped.last_password_changed_at);
  ok('last_login_at recorded', !!stamped.last_login_at);

  console.log('\n=== D. update, suspend, activate, reset ===');
  const upd = await PUT('/api/admin/administrators/' + newId, S.super,
    { designation: 'Senior Finance Officer', phone: '+880 1700-999888' });
  ok('update applies', upd.status === 200 && upd.body.designation === 'Senior Finance Officer');
  const roleChg = await PUT('/api/admin/administrators/' + newId, S.super, { role: 'moderator' });
  ok('role change applies', roleChg.status === 200 && roleChg.body.role === 'moderator');

  const susp = await PUT('/api/admin/administrators/' + newId + '/status', S.super, { status: 'suspended' });
  ok('suspend applies', susp.status === 200 && susp.body.status === 'suspended');
  /* 403 before Phase 2C, 401 after: suspension now bumps token_version too, so
     attachUser reaches the revoked-session check first. Both are refusals — what
     matters is that the token stops working, not which of the two it is. */
  const suspStatus = (await j('/api/auth/me', H(after.body.token))).status;
  ok('an existing token stops working immediately',
    suspStatus === 403 || suspStatus === 401, suspStatus);
  const reLogin = await login(email, newPw);
  ok('a suspended account cannot sign in', reLogin.status === 403 && /suspended/i.test(reLogin.body?.error || ''));
  ok('cannot suspend your own account',
    (await PUT('/api/admin/administrators/1/status', S.super, { status: 'suspended' })).status === 400);

  const act = await PUT('/api/admin/administrators/' + newId + '/status', S.super, { status: 'active' });
  ok('activate applies', act.status === 200 && act.body.status === 'active');
  /* Phase 2C changed this deliberately. Suspension revokes the account's
     sessions, so reactivating does not silently revive a token somebody was
     holding while the account was suspended — they sign in again. */
  ok('the suspended session is not revived by reactivation',
    (await j('/api/auth/me', H(after.body.token))).status === 401);
  ok('access is restored by signing in again',
    (await login(email, newPw)).status === 200);

  const reset = await POST('/api/admin/administrators/' + newId + '/reset-password', S.super, {});
  ok('password reset returns a new temporary password',
    reset.status === 200 && typeof reset.body.temporaryPassword === 'string');
  ok('the old password stops working', (await login(email, newPw)).status === 401);
  const afterReset = await login(email, reset.body.temporaryPassword);
  ok('the reset password works and forces a change',
    afterReset.status === 200 && afterReset.body.mustChangePassword === true);

  console.log('\n=== L. audit trail records actor and target ===');
  /* Phase 7C-3: the endpoint now answers with { entries, total, ... } so that
     it can be filtered and paged. Only the accessor changes here. Filtering
     stays in JavaScript over the same newest-fifty page this always examined:
     asking the server for every entry against this target instead widens the
     set to include the account's own sign-in and self-registration, which
     legitimately have no actor, and the assertion below is about the
     administrator actions taken ON it. */
  const audits = await j('/api/audit-logs', H(S.super));
  const mine = (audits.body.entries || []).filter(a => a.target_type === 'user' && a.target_id === newId);
  const actions = mine.map(a => a.action);
  for (const a of ['Administrator Created', 'Administrator Updated', 'Administrator Role Changed',
                   'Administrator Suspended', 'Administrator Activated', 'Administrator Password Reset']) {
    ok(`audited: ${a}`, actions.includes(a), actions.join(' | '));
  }
  /* Every entry names an actor, but not always the super admin: Phase 2C added
     self-initiated actions — a password change, a reset request, a sign-out —
     where the actor is the account itself. */
  ok('every administrator audit entry names an actor', mine.every(a => a.actor_id !== null),
    JSON.stringify(mine.filter(a => a.actor_id === null).map(a => ({id:a.id, action:a.action, actor_id:a.actor_id, actor_ref:a.actor_ref, target:a.target_id}))));
  ok('actions the super admin took are attributed to them',
    mine.filter(a => a.action.startsWith('Administrator ')).every(a => a.actor_id === 1));
  ok('no audit entry contains a password',
    !mine.some(a => /password[^ ]*\s*[:=]\s*\S/i.test(a.meta || '') ||
                    (reset.body.temporaryPassword && (a.meta || '').includes(reset.body.temporaryPassword))));

  console.log('\n=== cleanup ===');
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  const gone = await db.query('SELECT COUNT(*)::int n FROM users WHERE email = $1', [email]);
  ok('test administrator removed', gone.rows[0].n === 0);

  console.log('\n' + '='.repeat(56));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
