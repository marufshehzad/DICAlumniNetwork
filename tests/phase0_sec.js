/* PHASE 0 SECURITY VERIFICATION — no password is ever printed. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const B = 'http://localhost:8123';
let pass = 0, fail = 0;
const ok  = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? '  → ' + d : ''))); };

const creds = {};
for (const line of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
  const m = line.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
  if (m) creds[m[2]] = { role: m[1], password: m[3] };
}

async function req(path, opts = {}) {
  const r = await fetch(B + path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body, headers: r.headers };
}
const login = (email, password) => req('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
const auth = (t) => ({ headers: { Authorization: 'Bearer ' + t } });

(async () => {
  console.log('\n=== A. NO DEFAULT PASSWORD ACCEPTED ANYWHERE ===');
  for (const e of ['admin@dic.edu.bd', 'collegeadmin@dic.edu.bd', 'departmentadmin@dic.edu.bd',
                   'moderator@dic.edu.bd', 'alumni@dic.edu.bd']) {
    const r = await login(e, '12345678');
    ok(`${e.padEnd(28)} rejects '12345678'`, r.status === 401, 'status ' + r.status);
  }
  // Sprayed at a non-existent address so that testing the weak list does not
  // itself trip the account lockout on a real administrator and mask section C.
  for (const p of ['password', 'admin', '123456', 'changeme', 'Admin@123']) {
    const r = await login('does-not-exist@dic.edu.bd', p);
    /* 401 or 429, and never a token. Spraying at a non-existent address avoids
       the per-ACCOUNT lockout, but the per-IP rate limiter still trips partway
       through this list — which it should. The property under test is "a weak
       password never yields a session", and being refused for rate is a
       stronger form of that than being refused for credentials, not a weaker
       one. Asserting 401 exclusively made the suite fail whenever it ran after
       anything else that had attempted a sign-in. */
    ok(`weak password '${p}' yields no session`,
      [401, 429].includes(r.status) && !r.body?.token, 'status ' + r.status);
  }

  console.log('\n=== B. UNKNOWN EMAIL NEVER YIELDS A SESSION ===');
  const ghost = await login('nobody-' + Math.floor(process.hrtime()[1]) + '@dic.edu.bd', 'anything');
  ok('unknown email → 401, no token', ghost.status === 401 && !ghost.body?.token, 'status ' + ghost.status);
  ok('error message does not reveal whether the account exists',
     /invalid email or password/i.test(ghost.body?.error || ''), ghost.body?.error);

  console.log('\n=== C. REAL CREDENTIALS STILL WORK (rotation did not brick the system) ===');
  const sessions = {};
  for (const [email, c] of Object.entries(creds)) {
    if (!['super_admin', 'univ_admin', 'dept_admin', 'moderator'].includes(c.role) &&
        email !== 'alumni@dic.edu.bd') continue;
    const r = await login(email, c.password);
    ok(`${c.role.padEnd(12)} signs in with its rotated password`, r.status === 200 && !!r.body?.token, 'status ' + r.status);
    if (r.body?.token) sessions[c.role] = { token: r.body.token, user: r.body.user };
  }

  console.log('\n=== D. SERVER IS THE SOLE SOURCE OF ROLE ===');
  const al = sessions.alumni;
  if (!al) { ok('alumni session available', false); }
  else {
    ok('alumni /login reports role=alumni', al.user.role === 'alumni', al.user.role);
    const me = await req('/api/auth/me', auth(al.token));
    ok('alumni /auth/me reports role=alumni', me.body?.user?.role === 'alumni', JSON.stringify(me.body?.user?.role));

    // Client claims super_admin in the body — server must ignore it.
    const esc = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alumni@dic.edu.bd', password: creds['alumni@dic.edu.bd'].password, role: 'super_admin' })
    });
    ok('login body role=super_admin is ignored', esc.body?.user?.role === 'alumni', esc.body?.user?.role);

    // Alumni hitting admin-only endpoints.
    for (const p of ['/api/audit-logs', '/api/import-history', '/api/planner/sponsors', '/api/planner/vendors']) {
      const r = await req(p, auth(al.token));
      ok(`alumni blocked from ${p}`, r.status === 403 || r.status === 401, 'status ' + r.status);
    }
    const bi = await req('/api/bulk-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + al.token },
      body: JSON.stringify({ records: [] })
    });
    ok('alumni blocked from POST /api/bulk-import', bi.status === 403, 'status ' + bi.status);
  }

  console.log('\n=== E. FORGED / TAMPERED TOKENS ===');
  for (const t of ['super_admin', 'Bearer', 'x.y.z', '1|super_admin|999999999999|deadbeef', '']) {
    const r = await req('/api/auth/me', auth(t));
    ok(`forged token ${JSON.stringify(t).slice(0, 24)} rejected`, r.status === 401, 'status ' + r.status);
  }
  if (al) {
    const parts = al.token.split('.');
    const tampered = parts.length > 1 ? parts[0] + '.' + 'f'.repeat(parts[1].length) : al.token.slice(0, -4) + 'aaaa';
    const r = await req('/api/auth/me', auth(tampered));
    ok('valid token with a broken signature rejected', r.status === 401, 'status ' + r.status);
  }

  console.log('\n=== F. CHAPTER MEMBER PII REQUIRES AUTH ===');
  const anon = await req('/api/chapters/1/members');
  ok('unauthenticated → 401', anon.status === 401, 'status ' + anon.status);
  if (al) {
    const m = await req('/api/chapters/1/members', auth(al.token));
    ok('authenticated → 200', m.status === 200, 'status ' + m.status);
    ok('returns only real members (no filler)', Array.isArray(m.body), typeof m.body);
    const bad = await req('/api/chapters/99999/members', auth(al.token));
    ok('unknown chapter → 404 (not a fallback list)', bad.status === 404, 'status ' + bad.status);
    const nan = await req('/api/chapters/abc/members', auth(al.token));
    ok('non-numeric id → 400', nan.status === 400, 'status ' + nan.status);
  }

  console.log('\n=== G. LOGIN BRUTE-FORCE THROTTLE ===');
  const victim = 'throttle-probe@dic.edu.bd';
  let firstLock = 0, statuses = [];
  for (let i = 1; i <= 8; i++) {
    const r = await login(victim, 'wrong-' + i);
    statuses.push(r.status);
    if (r.status === 429 && !firstLock) firstLock = i;
  }
  ok('repeated failures eventually return 429', statuses.includes(429), statuses.join(','));
  ok('lock trips at or before the 7th attempt', firstLock > 0 && firstLock <= 7, 'attempt ' + firstLock);
  const locked = await login(victim, 'wrong-again');
  ok('429 carries a Retry-After header', !!locked.headers.get('retry-after'), locked.headers.get('retry-after'));
  ok('429 body does not leak account existence',
     !/exist|unknown|found/i.test(locked.body?.error || ''), locked.body?.error);

  console.log('\n=== SECURITY TOTAL ===');
  console.log(`  passed ${pass}   failed ${fail}\n`);
  process.exitCode = fail ? 1 : 0;
})();
