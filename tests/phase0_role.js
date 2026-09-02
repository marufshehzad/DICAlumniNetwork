/* Confirms (1) super_admin's rotated password works on a clean throttle, and
   (2) role comes from the users row, not from the bearer token. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const db = require(path.join(REPO, 'db'));
const B = 'http://localhost:8123';
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? '  → ' + d : ''))); };

const creds = {};
for (const line of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
  const m = line.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
  if (m) creds[m[2]] = { role: m[1], password: m[3] };
}
const j = async (p, o = {}) => { const r = await fetch(B + p, o); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
const login = (e, p) => j('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) });
const auth = (t) => ({ headers: { Authorization: 'Bearer ' + t } });

(async () => {
  console.log('\n=== C(retry). SUPER_ADMIN ON A CLEAN THROTTLE ===');
  const sa = await login('admin@dic.edu.bd', creds['admin@dic.edu.bd'].password);
  ok('super_admin signs in with its rotated password', sa.status === 200 && !!sa.body?.token, 'status ' + sa.status);
  ok('server reports role=super_admin', sa.body?.user?.role === 'super_admin', sa.body?.user?.role);
  if (sa.body?.token) {
    const a = await j('/api/audit-logs', auth(sa.body.token));
    ok('super_admin CAN reach /api/audit-logs', a.status === 200, 'status ' + a.status);
  }

  console.log('\n=== D2. ROLE IS READ FROM THE DATABASE ROW, NOT FROM THE TOKEN ===');
  const al = await login('alumni@dic.edu.bd', creds['alumni@dic.edu.bd'].password);
  ok('alumni session obtained', al.status === 200, 'status ' + al.status);
  const tok = al.body.token;
  const before = (await db.query('SELECT role FROM users WHERE email = $1', ['alumni@dic.edu.bd'])).rows[0].role;
  try {
    const denied = await j('/api/audit-logs', auth(tok));
    ok('with role=alumni the token is denied /api/audit-logs', denied.status === 403, 'status ' + denied.status);

    await db.query("UPDATE users SET role = 'super_admin' WHERE email = $1", ['alumni@dic.edu.bd']);
    const me = await j('/api/auth/me', auth(tok));
    ok('the SAME token now reports the new DB role', me.body?.user?.role === 'super_admin', JSON.stringify(me.body?.user?.role));
    const allowed = await j('/api/audit-logs', auth(tok));
    ok('and authorisation follows the DB, not the token', allowed.status === 200, 'status ' + allowed.status);
  } finally {
    await db.query('UPDATE users SET role = $1 WHERE email = $2', [before, 'alumni@dic.edu.bd']);
  }
  const back = (await db.query('SELECT role FROM users WHERE email = $1', ['alumni@dic.edu.bd'])).rows[0].role;
  ok('role restored to its original value (' + before + ')', back === before, back);
  const after = await j('/api/audit-logs', auth(tok));
  ok('token is denied again once the DB role is restored', after.status === 403, 'status ' + after.status);

  console.log(`\n  passed ${pass}   failed ${fail}\n`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
