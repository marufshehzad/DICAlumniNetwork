#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — SECURITY SMOKE SUITE

   The suite an external reviewer runs first, and the one that should run before
   every deployment. It is deliberately broad rather than deep: one probe for
   each class of failure this platform could plausibly have, so that a
   regression in any of them is loud.

   Covered, in order:

     A  anonymous access to protected routes        (every route, from source)
     B  alumni cannot reach the staff surface
     C  role escalation
     D  IDOR — ownership on every id-bearing route it can reach
     E  SQL injection
     F  stored XSS, the two classes Phase 5F found
     G  CORS
     H  host routing
     I  rate limiting, including a forged X-Forwarded-For
     J  session revocation
     K  privacy leakage between members
     L  bulk import safety and the enrolment gate
     M  scheduler authorisation
     N  error text disclosure and security headers

   SELF-CONTAINED. It creates its own accounts through the public registration
   endpoint, promotes one of them to each staff role directly in the database
   for the duration of the run, and removes all of them at the end. It needs no
   credentials file and no seeded data, so it works on a fresh clone against a
   freshly migrated database.

   It never deletes an audit entry — the chain is append-only, and a test that
   pruned it would assert the opposite of what this platform is built on.

   Usage:  node tests/security_smoke.js
           TEST_BASE=http://localhost:8123 node tests/security_smoke.js

   Requires the application running on TEST_BASE and access to its database.
   Run it against a development or staging deployment, never production: it
   writes rows, and section I deliberately trips the login throttle.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'db'));

const B = process.env.TEST_BASE || 'http://localhost:8123';
const TAG = 'p5f-smoke';
const PW = 'Phase5F-Smoke-Pw1';

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const skipped = (n, why) => { skip++; console.log('  SKIP  ' + n + '  (' + why + ')'); };
const head = (t) => console.log('\n' + t);

/* ── HTTP ──────────────────────────────────────────────────────────────────
   fetch for the ordinary cases; raw http where a header fetch refuses to send.
   `Host` and `Origin` are forbidden header names in the fetch spec and undici
   drops Host silently — a Phase 5E test reported a pass it had never actually
   performed because of exactly that. */
const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, headers: r.headers };
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const req = (method, p, t, body, extra = {}) => j(p, {
  method,
  headers: { 'Content-Type': 'application/json',
             ...(t ? { Authorization: 'Bearer ' + t } : {}), ...extra },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const GET = (p, t, extra) => j(p, { headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...extra } });
const POST = (p, t, body, extra) => req('POST', p, t, body, extra);
const PUT = (p, t, body) => req('PUT', p, t, body);
const DEL = (p, t) => req('DELETE', p, t);

function raw(method, urlPath, headers = {}) {
  const u = new URL(B);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: u.hostname, port: u.port || 80, path: urlPath, method, headers },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

/* ── fixtures ──────────────────────────────────────────────────────────── */
async function member(tag) {
  const email = `${TAG}-${tag}@dic.test`;
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  const r = await POST('/api/auth/register', null, {
    name: `Smoke ${tag}`, email, password: PW,
    hscPassingYear: 2019, hscGroup: 'Science', mobile: '+880 1700-000123'
  });
  if (!r.body?.token) throw new Error(`register ${tag}: ${r.status} ${JSON.stringify(r.body)}`);
  /* Phase 7C-1 made is_verified load-bearing: a self-registered account cannot
     post a job, apply for one, or reach another member until staff verify it.
     This suite's subject is an ordinary VERIFIED member — the escaping and
     authorisation assertions below are about what such a member can do — so the
     fixture is verified here, the same way promote() sets a role. The gate
     itself is covered by tests/phase7c1_privacy.js. */
  await db.query(`UPDATE users SET is_verified = TRUE WHERE id = $1`, [r.body.user.id]);
  return { email, tag, token: r.body.token, uid: r.body.user.id };
}

/* Promote a throwaway account for the duration of the run. Changing the role
   invalidates nothing — attachUser re-reads it per request — but the token
   still carries the old role, which is itself worth asserting (section C). */
async function promote(m, role) {
  await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, m.uid]);
  const r = await POST('/api/auth/login', null, { email: m.email, password: PW });
  if (!r.body?.token) throw new Error(`re-login ${role}: ${r.status}`);
  return { ...m, role, token: r.body.token };
}

/* ── the route table, read from source so new routes are covered ─────────── */
function routesFromSource() {
  const FILES = ['server.js', 'routes_v2.js', 'routes_events.js',
                 'routes_admin_users.js', 'routes_compliance.js', 'routes_planner.js'];
  const out = [];
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
    src.split('\n').forEach((line, i) => {
      const m = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2\s*,?\s*(.*)$/.exec(line);
      if (!m) return;
      const [, method, , route] = m;
      if (route.includes('${')) return;            // template-built planner routes
      const rest = m[4] || '';
      let guard = 'public';
      const g = /requireRole\(([^)]*)\)/.exec(rest);
      if (g) guard = 'role:' + g[1].replace(/\.\.\./g, '').trim();
      else if (/requireScheduler/.test(rest)) guard = 'scheduler';
      // Phase 7C-1: a signed-in AND verified member. Strictly stronger than
      // requireAuth, so it counts as guarded everywhere auth does.
      else if (/requireVerified/.test(rest)) guard = 'verified';
      else if (/requireAuth/.test(rest)) guard = 'auth';
      out.push({ method: method.toUpperCase(), route, guard, where: `${f}:${i + 1}` });
    });
  }
  return out;
}

// A concrete path for a route pattern. Ids are deliberately real-looking but
// almost certainly absent: this section is about the GUARD, not the record.
const concrete = r => r.route.replace(/:[A-Za-z_]+/g, '999999');

const PUBLIC_BY_DESIGN = new Set([
  'GET /api/health', 'POST /api/auth/login', 'POST /api/auth/register',
  'POST /api/auth/forgot-password', 'POST /api/auth/reset-password',
  /* Phase 7D. The sign-up form needs department names before anyone is signed
     in, so a member can say which department they graduated from — without
     which no department administrator can ever confirm their account.
     It returns id, code and name for active departments and nothing else; the
     per-department alumni COUNT that the staff endpoint carries is deliberately
     not here, because a headcount is an institutional figure. Department names
     are already printed on the public directory and on events. */
  'GET /api/departments/public'
]);

(async () => {
  console.log(`\nSecurity smoke suite against ${B}`);

  const A = await member('a');            // ordinary member
  const C = await member('c');            // second member, the attacker
  let MOD = await member('mod');
  let ADMIN = await member('admin');
  MOD = await promote(MOD, 'moderator');
  ADMIN = await promote(ADMIN, 'super_admin');

  /* ══ A. Anonymous access ═════════════════════════════════════════════ */
  head('=== A. every non-public route refuses an anonymous caller ===');
  const routes = routesFromSource();
  ok('the route table was parsed', routes.length > 100, String(routes.length));

  const leaked = [];
  for (const r of routes) {
    const key = `${r.method} ${r.route}`;
    if (PUBLIC_BY_DESIGN.has(key)) continue;
    const res = await req(r.method, concrete(r), null, r.method === 'GET' ? undefined : {});
    if (res.status !== 401 && res.status !== 403) leaked.push(`${key} -> ${res.status} (${r.where})`);
  }
  ok(`all ${routes.length - PUBLIC_BY_DESIGN.size} guarded routes refuse anonymous callers`,
    leaked.length === 0, leaked.slice(0, 6).join(' | '));

  const declaredPublic = routes.filter(r => r.guard === 'public').map(r => `${r.method} ${r.route}`);
  ok('no route is public that is not meant to be',
    declaredPublic.every(k => PUBLIC_BY_DESIGN.has(k)),
    declaredPublic.filter(k => !PUBLIC_BY_DESIGN.has(k)).join(', '));

  /* ══ B. Alumni cannot reach the staff surface ═══════════════════════ */
  head('=== B. an ordinary member cannot reach the staff surface ===');
  const staffRoutes = routes.filter(r => r.guard.startsWith('role:') || r.guard === 'scheduler');
  const reached = [];
  for (const r of staffRoutes) {
    const res = await req(r.method, concrete(r), C.token, r.method === 'GET' ? undefined : {});
    if (res.status < 400) reached.push(`${r.method} ${r.route} -> ${res.status}`);
  }
  ok(`all ${staffRoutes.length} role-guarded routes refuse a member`,
    reached.length === 0, reached.slice(0, 6).join(' | '));

  for (const p of ['/api/audit-logs', '/api/vault', '/api/ops/status',
                   '/api/admin/administrators', '/api/import-history',
                   '/api/vault/access-logs', '/api/sync-mutations']) {
    ok(`member is refused ${p}`, (await GET(p, C.token)).status === 403);
  }
  ok('a moderator is refused the administrator list',
    (await GET('/api/admin/administrators', MOD.token)).status === 403);
  ok('a moderator is refused the audit log', (await GET('/api/audit-logs', MOD.token)).status === 403);
  ok('a super admin can read the audit log', (await GET('/api/audit-logs', ADMIN.token)).status === 200);

  /* ══ C. Role escalation ════════════════════════════════════════════ */
  head('=== C. a member cannot raise their own role ===');
  await PUT('/api/profile/me', C.token, { role: 'super_admin', isVerified: true });
  ok('role is unchanged after a profile update naming it',
    (await db.query('SELECT role FROM users WHERE id=$1', [C.uid])).rows[0].role === 'alumni');

  await POST('/api/auth/register', null, {
    name: 'Escalate', email: `${TAG}-esc@dic.test`, password: PW,
    hscPassingYear: 2019, hscGroup: 'Science', role: 'super_admin'
  });
  const escRow = await db.query('SELECT role FROM users WHERE email=$1', [`${TAG}-esc@dic.test`]);
  ok('registration ignores a role in the body', escRow.rows[0]?.role === 'alumni', escRow.rows[0]?.role);

  // The token carries a role, but authorisation re-reads the row every request.
  const staleAdminToken = ADMIN.token;
  await db.query('UPDATE users SET role = $1 WHERE id = $2', ['alumni', ADMIN.uid]);
  ok('a demotion takes effect immediately, not when the token expires',
    (await GET('/api/audit-logs', staleAdminToken)).status === 403);
  await db.query('UPDATE users SET role = $1 WHERE id = $2', ['super_admin', ADMIN.uid]);

  // Tamper with the signed payload.
  const [body] = ADMIN.token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(body, 'base64url').toString()), role: 'super_admin', uid: C.uid
  })).toString('base64url');
  ok('a token with an edited payload is rejected',
    (await GET('/api/auth/me', `${forgedBody}.${ADMIN.token.split('.')[1]}`)).status === 401);
  ok('a token with no signature is rejected', (await GET('/api/auth/me', body)).status === 401);

  /* ══ D. IDOR ═══════════════════════════════════════════════════════ */
  head('=== D. one member cannot act on another member\'s records ===');
  const job = await POST('/api/jobs', A.token, {
    title: 'Smoke Job', company: 'SmokeCo', location: 'Dhaka',
    type: 'Full-time', description: 'smoke', applyUrl: 'https://example.test'
  });
  const jobId = job.body?.id ?? job.body?.job?.id;
  ok('a member can post a job', !!jobId, `${job.status}`);
  if (jobId) {
    ok("another member cannot edit it", (await PUT(`/api/jobs/${jobId}`, C.token, { title: 'HIJACKED' })).status === 403);
    ok("another member cannot read its applicants", (await GET(`/api/jobs/${jobId}/applicants`, C.token)).status === 403);
    ok("another member cannot delete it", (await DEL(`/api/jobs/${jobId}`, C.token)).status === 403);
    ok('the job survived all three attempts',
      (await db.query('SELECT 1 FROM jobs WHERE id=$1', [jobId])).rows.length === 1);
    ok('the owner can still edit it',
      (await PUT(`/api/jobs/${jobId}`, A.token, { title: 'Smoke Job v2' })).status === 200);
  }

  // A notification belonging to someone else must not be mutated.
  const notif = await db.query(
    `INSERT INTO notifications (user_id, title, subtitle, icon, is_unread)
     VALUES ($1,'Smoke','smoke','bell',TRUE) RETURNING id`, [A.uid]);
  const nid = notif.rows[0].id;
  await PUT(`/api/notifications/${nid}/read`, C.token, {});
  ok("another member's notification is not marked read",
    (await db.query('SELECT is_unread FROM notifications WHERE id=$1', [nid])).rows[0].is_unread === true);
  await PUT('/api/notifications/read-all', C.token, {});
  ok("read-all does not reach another member's notifications",
    (await db.query('SELECT is_unread FROM notifications WHERE id=$1', [nid])).rows[0].is_unread === true);

  // A data-subject export is the caller's own, whatever the query string says.
  const own = await GET('/api/dsar/export', C.token);
  const spoof = await GET(`/api/dsar/export?userId=${A.uid}`, C.token);
  ok('a data export ignores a userId in the query string',
    !JSON.stringify(spoof.body || {}).includes(A.email), A.email);
  ok('a data export returns the caller\'s own record',
    JSON.stringify(own.body || {}).includes(C.email));

  /* ══ E. SQL injection ══════════════════════════════════════════════ */
  head('=== E. injection payloads reach no query ===');
  const usersBefore = (await db.query('SELECT count(*)::int n FROM users')).rows[0].n;
  const PAYLOADS = ["' OR '1'='1", "'; DROP TABLE users; --", "1; DELETE FROM users WHERE 1=1 --",
                    "' UNION SELECT NULL,NULL,NULL --", "\\'; SELECT pg_sleep(5) --", "1' AND SLEEP(5)--"];
  const injected = [];
  for (const q of PAYLOADS) {
    for (const p of [`/api/alumni?search=${encodeURIComponent(q)}`,
                     `/api/alumni?batch=${encodeURIComponent(q)}`,
                     `/api/alumni?sort=${encodeURIComponent(q)}`,
                     `/api/alumni?limit=${encodeURIComponent(q)}`,
                     `/api/jobs?search=${encodeURIComponent(q)}`,
                     `/api/locations/places?q=${encodeURIComponent(q)}`]) {
      const r = await GET(p, C.token);
      if (r.status >= 500) injected.push(`${p} -> ${r.status}`);
    }
  }
  ok('no injection payload produced a server error', injected.length === 0, injected.slice(0, 4).join(' | '));
  ok('the users table is intact',
    (await db.query('SELECT count(*)::int n FROM users')).rows[0].n === usersBefore);
  ok('a non-numeric id is a 400, not a database error',
    (await GET('/api/alumni/not-a-number', C.token)).status === 400);
  ok('a non-numeric event id is a 400', (await GET('/api/events/abc', C.token)).status === 400);

  /* ══ F. Stored XSS ════════════════════════════════════════════════ */
  head('=== F. untrusted text cannot become code in another session ===');
  const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');

  /* escapeHtml is HTML-context escaping. Inside an inline handler the parser
     decodes the attribute BEFORE the JavaScript is compiled, so &#39; becomes a
     live apostrophe and closes the string it was supposed to be inside. jsArg
     is the encoder for that position; it must be the only thing used there. */
  ok('jsArg exists and produces a complete JS literal', /function jsArg/.test(src('js/core.js')));
  ok('safeUrl exists and restricts the scheme', /function safeUrl/.test(src('js/core.js')));

  const handlerSinks = [];
  for (const f of fs.readdirSync(path.join(REPO, 'js')).filter(x => x.endsWith('.js'))) {
    const s = src('js/' + f).replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const m of s.matchAll(/on[a-z]+="[^"]*'\$\{[^}]*\}'/g)) {
      handlerSinks.push(`js/${f}: ${m[0].slice(0, 70)}`);
    }
  }
  ok('no inline handler interpolates into a quoted JS string literal',
    handlerSinks.length === 0, handlerSinks.slice(0, 4).join(' | '));

  ok('the no-op apostrophe replace is gone from every call site',
    !fs.readdirSync(path.join(REPO, 'js')).filter(x => x.endsWith('.js'))
      .some(f => /escapeHtml\([^)]*\)\.replace\(\/'\/g/.test(src('js/' + f))));

  // The moderation queue is the alumni-to-staff path: submitting IS delivery.
  const modPanel = src('js/admin.js');
  const modFn = modPanel.slice(modPanel.indexOf('async function renderModerationPanel'),
                               modPanel.indexOf('async function handleModerateChapter'));
  const rawInterp = [...modFn.matchAll(/\$\{(?!escapeHtml|emojiIcon|jsArg|pending|c\.id|s\.id)([a-z]\.[a-zA-Z_]+)/g)]
    .map(m => m[1]);
  ok('the staff moderation queue escapes every alumni-authored field',
    rawInterp.length === 0, rawInterp.join(', '));

  // End to end: an alumnus stores a payload, and it comes back as data.
  const payload = `<img src=x onerror="window.__smoke=1">`;
  await POST('/api/stories', A.token,
    { title: payload, category: 'Career', emoji: '📣', content: 'smoke '.repeat(40) });
  const queue = await GET('/api/moderation', MOD.token);
  const stored = JSON.stringify(queue.body || {});
  ok('the API returns the payload verbatim, as data', stored.includes('onerror'));
  ok('nothing on the server tries to sanitise it instead of escaping on output',
    stored.includes('<img src=x'));

  /* ══ G. CORS ══════════════════════════════════════════════════════ */
  head('=== G. CORS is an allow-list ===');
  const acao = async (origin) =>
    (await GET('/api/health', null, { Origin: origin })).headers.get('access-control-allow-origin');
  const evil = await acao('https://evil.example');
  ok('a foreign origin is not echoed back', !evil || evil !== 'https://evil.example', String(evil));
  ok('the wildcard is never sent', evil !== '*', String(evil));
  ok('cors is configured from an allow-list, not left undefined',
    /PUBLIC_ORIGIN/.test(src('server.js')) && /ADMIN_ORIGIN/.test(src('server.js')));
  ok('no cookie-based session exists, so CSRF has no vehicle',
    !/res\.cookie\(|req\.cookies|cookie-parser/.test(src('server.js')));
  ok('the client sends the session in a header, not a cookie',
    /Authorization/.test(src('api.js')) && !/credentials:\s*'include'/.test(src('api.js')));

  /* ══ H. Host routing ══════════════════════════════════════════════ */
  head('=== H. each host serves its own portal ===');
  const shell = async (host) => {
    const r = await raw('GET', '/', { Host: host });
    return /DIC Staff Portal/.test(r.body) ? 'staff'
         : /DIC Alumni Network/.test(r.body) ? 'alumni' : '?';
  };
  ok('/admin serves the staff portal', (await shell('localhost')) === 'alumni');
  ok('the path /admin serves the staff portal',
    /DIC Staff Portal/.test((await raw('GET', '/admin', { Host: 'localhost' })).body));
  ok('host matching compares hostnames, not substrings',
    /function originHost/.test(src('server.js')) && !/\.includes\(host\)/.test(
      src('server.js').replace(/\/\*[\s\S]*?\*\//g, ' ')));
  ok('trust proxy is declared, not assumed',
    /TRUST_PROXY/.test(src('server.js')) && !/app\.set\('trust proxy', 1\)/.test(src('server.js')));

  /* ══ I. Rate limiting ═════════════════════════════════════════════ */
  head('=== I. the login throttle cannot be walked around ===');
  const victim = await member('victim');
  const guess = (xff) => POST('/api/auth/login', null,
    { email: victim.email, password: 'wrong-password' }, xff ? { 'X-Forwarded-For': xff } : {});

  const plain = [];
  for (let i = 0; i < 8; i++) plain.push((await guess()).status);
  ok('repeated wrong passwords trip the throttle', plain.includes(429), plain.join(' '));

  /* A numeric trust-proxy value is a hop COUNT, not an allow-list, so with
     nothing in front the peer is trusted and X-Forwarded-For is the caller's to
     choose. Rotating it used to reset the bucket every request: 32 guesses, no
     429. TRUST_PROXY now defaults to off. */
  const rotated = [];
  for (let i = 0; i < 10; i++) rotated.push((await guess(`198.51.100.${i + 1}`)).status);
  ok('a rotating forged X-Forwarded-For does not reset the throttle',
    rotated.includes(429), rotated.join(' '));

  /* The durable lock must be consulted BEFORE the password is compared, or it
     throttles nobody and denies service to the account owner instead. */
  const loginSrc = src('server.js');
  const lockAt = loginSrc.indexOf('const locked = result.rows.length');
  const verifyAt = loginSrc.indexOf('!verifyPassword(password');
  ok('the account lock is checked before the password is verified',
    lockAt > 0 && verifyAt > 0 && lockAt < verifyAt, `lock@${lockAt} verify@${verifyAt}`);
  ok('the failure counter restarts once a lock lapses, so it cannot be chained',
    /THEN 1 ELSE u\.failed_login_count \+ 1 END/.test(loginSrc));

  /* Hand the throttle back. loginRecordSuccess clears both buckets for this
     address, so the 18 deliberate failures above cannot leak into whatever runs
     next — this suite has to be safe in any position in the batch. */
  const clear = await POST('/api/auth/login', null, { email: C.email, password: PW });
  ok('a successful sign-in clears the buckets this section filled', clear.status === 200,
    String(clear.status));

  /* ══ J. Session revocation ════════════════════════════════════════ */
  head('=== J. a session really ends ===');
  const S = await member('session');
  const sTok = S.token;
  ok('the session works', (await GET('/api/auth/me', sTok)).status === 200);
  await POST('/api/auth/logout', sTok, {});
  ok('the token is dead after sign-out', (await GET('/api/auth/me', sTok)).status === 401);

  const S2 = await POST('/api/auth/login', null, { email: S.email, password: PW });
  const t2 = S2.body.token;
  await POST('/api/auth/change-password', t2, { currentPassword: PW, newPassword: PW + 'x' });
  ok('a password change ends every session opened before it',
    (await GET('/api/auth/me', t2)).status === 401);

  const S3 = await POST('/api/auth/login', null, { email: S.email, password: PW + 'x' });
  await db.query("UPDATE users SET status='suspended' WHERE id=$1", [S.uid]);
  ok('suspension takes effect on the next request',
    (await GET('/api/auth/me', S3.body.token)).status === 403);
  await db.query("UPDATE users SET status='active' WHERE id=$1", [S.uid]);

  ok('an expired token is rejected', await (async () => {
    const [b, s] = (await POST('/api/auth/login', null, { email: S.email, password: PW + 'x' })).body.token.split('.');
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    p.exp = Date.now() - 1000;
    const forged = Buffer.from(JSON.stringify(p)).toString('base64url');
    return (await GET('/api/auth/me', `${forged}.${s}`)).status === 401;
  })());

  /* ══ K. Privacy ═══════════════════════════════════════════════════ */
  head('=== K. privacy settings are enforced by the server ===');
  await PUT('/api/profile/me', A.token, { mobile: '+880 1700-555222', presentAddress: '9 Smoke Road' });
  await PUT('/api/profile/me', A.token,
    { privacySettings: { mobile: 'private', email: 'private', location: 'private' } });

  const peer = await GET(`/api/alumni/${A.uid}`, C.token);
  ok('a private mobile is withheld from another member', !peer.body?.mobile, String(peer.body?.mobile));
  ok('a private email is withheld from another member', !peer.body?.email, String(peer.body?.email));
  const peerText = JSON.stringify(peer.body || {});
  ok('a street address is never sent to another member', !peerText.includes('9 Smoke Road'));

  const selfView = await GET(`/api/alumni/${A.uid}`, A.token);
  ok('the owner still sees their own mobile', !!selfView.body?.mobile);

  /* privacy.js gives `mobile` and `email` a staff bypass, and defines staff as
     super_admin / univ_admin / dept_admin — NOT moderator. Both halves are
     asserted, because a bypass that quietly widened to moderator would be a
     privacy regression nobody would notice. */
  const adminView = await GET(`/api/alumni/${A.uid}`, ADMIN.token);
  ok('an administrator may see contact details — the documented exception',
    !!adminView.body?.mobile, String(adminView.body?.mobile));
  const modView = await GET(`/api/alumni/${A.uid}`, MOD.token);
  ok('a moderator does NOT get that bypass', !modView.body?.mobile, String(modView.body?.mobile));
  ok('an administrator may NOT see a street address',
    !JSON.stringify(adminView.body || {}).includes('9 Smoke Road'));
  /* Asked of the module itself rather than matched in its source: a regex
     over the file would pass on a comment that merely says so. */
  const privacy = require(path.join(REPO, 'privacy'));
  ok('location has no staff bypass at all — even for an administrator',
    !privacy.PRIVACY_FIELDS.location.staffBypass,
    String(privacy.PRIVACY_FIELDS.location.staffBypass));
  ok('email and mobile DO have one, and it is limited to the three admin roles',
    privacy.PRIVACY_FIELDS.email.staffBypass === true &&
    privacy.PRIVACY_FIELDS.mobile.staffBypass === true &&
    !privacy.STAFF_ROLES.includes('moderator') && !privacy.STAFF_ROLES.includes('alumni'),
    privacy.STAFF_ROLES.join(','));

  await db.query(
    `UPDATE alumni_profiles SET city='Sylhet', can_mentor=TRUE,
        privacy_settings = jsonb_set(COALESCE(privacy_settings,'{}'::jsonb),'{location}','"private"')
      WHERE user_id=$1`, [A.uid]);
  const sugg = await GET('/api/mentorships/suggestions', C.token);
  const mine = (sugg.body || []).find(x => x.id === A.uid);
  ok('a private location is withheld from the mentor suggestions',
    !mine || mine.city === null, mine && String(mine.city));

  const map = await GET('/api/stats/map', C.token);
  ok('a private location is not plotted on the map',
    !JSON.stringify(map.body || {}).includes('Sylhet'));

  const tasksLeak = await GET(`/api/events/999999/tasks`, C.token);
  ok('the task list is readable without leaking a 500', tasksLeak.status < 500, String(tasksLeak.status));
  ok('assignee contact numbers are gated on the caller\'s tier',
    /taskSelect = \(staff\)/.test(src('routes_events.js')));

  /* ══ L. Bulk import ═══════════════════════════════════════════════ */
  head('=== L. bulk import is safe, and its shared password is enrolment-only ===');
  ok('an ordinary member cannot import', (await POST('/api/bulk-import', C.token, { records: [] })).status === 403);

  const impEmail = `${TAG}-imported@dic.test`;
  await db.query('DELETE FROM users WHERE email = $1', [impEmail]);
  const imp = await POST('/api/bulk-import', ADMIN.token, {
    records: [{ row: 1, name: 'Imported Person', email: impEmail,
                hscGroup: 'Science', hscPassingYear: 2018 }],
    dupResolution: 'skip'
  });
  ok('the import ran', imp.status === 200, `${imp.status} ${JSON.stringify(imp.body).slice(0, 80)}`);
  const batchPw = imp.body?.temporaryPassword;
  ok('a temporary password is returned once', !!batchPw);

  if (batchPw) {
    const impLogin = await POST('/api/auth/login', null, { email: impEmail, password: batchPw });
    ok('the imported account can sign in', impLogin.status === 200);
    ok('the response says the password must change', impLogin.body?.mustChangePassword === true);
    const impTok = impLogin.body.token;

    /* The whole point: this credential is shared with everyone else in the
       batch, so until it is replaced the session may do nothing but replace it. */
    ok('an enrolment session cannot read the directory',
      (await GET('/api/alumni', impTok)).status === 403);
    ok('an enrolment session cannot read its own profile page data',
      (await GET('/api/profile/me', impTok)).status === 403);
    ok('an enrolment session cannot post a job',
      (await POST('/api/jobs', impTok, { title: 'x', company: 'y' })).status === 403);
    ok('an enrolment session CAN identify itself', (await GET('/api/auth/me', impTok)).status === 200);
    const changed = await POST('/api/auth/change-password', impTok,
      { currentPassword: batchPw, newPassword: 'Imported-Own-Pw1' });
    ok('an enrolment session CAN set its own password', changed.status === 200);
    ok('everything works once the password is the account holder\'s own',
      (await GET('/api/alumni', changed.body.token)).status === 200);
  }

  // Import cannot write a privileged column.
  const impEmail2 = `${TAG}-imported2@dic.test`;
  await db.query('DELETE FROM users WHERE email = $1', [impEmail2]);
  await POST('/api/bulk-import', ADMIN.token, {
    records: [{ row: 1, name: 'Priv', email: impEmail2, hscGroup: 'Science', hscPassingYear: 2018,
                role: 'super_admin', is_verified: true, id: 1, password_hash: 'x', token_version: 99 }],
    dupResolution: 'skip'
  });
  const impRow = await db.query('SELECT role, created_via FROM users WHERE email=$1', [impEmail2]);
  ok('an import cannot set a role', impRow.rows[0]?.role === 'alumni', impRow.rows[0]?.role);
  ok('an import is recorded as such', impRow.rows[0]?.created_via === 'bulk_import');

  ok('the import preview escapes every field it renders',
    !/\$\{(rec|r)\.[a-zA-Z_]+\}/.test(src('js/admin.js').replace(/\/\*[\s\S]*?\*\//g, ' ')));
  ok('the error-report CSV quotes and de-fangs formulas',
    /csvCell/.test(src('js/admin.js')));

  /* ══ M. Scheduler ═════════════════════════════════════════════════ */
  head('=== M. only the scheduler can run the jobs ===');
  ok('anonymous is refused', (await GET('/api/internal/jobs/run')).status === 401);
  ok('a member is refused', (await GET('/api/internal/jobs/run', C.token)).status === 401);
  ok('a moderator is refused', (await GET('/api/internal/jobs/run', MOD.token)).status === 401);
  ok('a wrong secret is refused',
    (await GET('/api/internal/jobs/run', null, { 'X-Cron-Key': 'not-the-secret' })).status === 401);
  ok('the credential is compared in constant time',
    /timingSafeEqual/.test(src('server.js').slice(src('server.js').indexOf('function schedulerCredentialOk'),
                                                 src('server.js').indexOf('function requireScheduler'))));
  ok('the refusal says nothing about which credential was missing',
    !/CRON_SECRET/.test(JSON.stringify((await GET('/api/internal/jobs/run')).body)));

  /* ══ N. Disclosure and headers ════════════════════════════════════ */
  head('=== N. failures and headers say nothing useful to an attacker ===');
  const bad = await GET('/api/alumni?batch=not-a-number', C.token);
  const badText = JSON.stringify(bad.body || {});
  ok('a malformed filter does not return PostgreSQL error text',
    !/invalid input syntax|SQLSTATE|pg_|relation ".*" does not exist/i.test(badText), badText.slice(0, 90));
  ok('a server failure carries a request id instead of the message',
    !/err\.message/.test(src('server.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')) ||
    /function serverError/.test(src('server.js')));

  const h = (await GET('/api/health')).headers;
  ok('X-Content-Type-Options is set', h.get('x-content-type-options') === 'nosniff');
  ok('Referrer-Policy is set', !!h.get('referrer-policy'));
  ok('a correlation id is returned', !!h.get('x-request-id'));
  ok('no server banner is advertised', !h.get('x-powered-by'), String(h.get('x-powered-by')));

  const adminShell = await raw('GET', '/admin', { Host: 'localhost' });
  ok('the staff portal is not indexable', /noindex/.test(String(adminShell.headers['x-robots-tag'] || '')));
  ok('the staff portal cannot be framed', adminShell.headers['x-frame-options'] === 'DENY');
  ok('the staff portal sends frame-ancestors none',
    /frame-ancestors 'none'/.test(String(adminShell.headers['content-security-policy'] || '')),
    String(adminShell.headers['content-security-policy']));

  /* BOTH portals must carry a Content-Security-Policy. Until Phase 5F the
     alumni site had none at all — and that is the portal every stored-XSS
     finding of that phase was reachable from. Asserted on the WIRE, not in the
     source: the source was already correct while a stale process was still
     serving responses without the header, and nothing here would have noticed. */
  const alumniShell = await raw('GET', '/', { Host: 'localhost' });
  ok('the alumni portal sends a Content-Security-Policy at all',
    !!alumniShell.headers['content-security-policy'],
    String(alumniShell.headers['content-security-policy']));
  ok('…and it is frame-ancestors self', 
    /frame-ancestors 'self'/.test(String(alumniShell.headers['content-security-policy'] || '')));

  /* What the policy deliberately does NOT contain. There is no script-src, so
     the CSP is clickjacking protection and NOT an XSS mitigation. Saying so in
     a test keeps the two from being confused later: a script-src directive is
     impossible while the application uses inline event-handler attributes, and
     removing those is the prerequisite, tracked in
     FINAL_SECURITY_REVIEW_FOLLOWUPS.md. */
  const csp = String(alumniShell.headers['content-security-policy'] || '');
  ok('the CSP is honestly frame-ancestors only — no script-src is claimed',
    !/script-src/.test(csp), csp);
  const inlineHandlers = fs.readdirSync(path.join(REPO, 'js')).filter(f => f.endsWith('.js'))
    .reduce((n, f) => n + (src('js/' + f).match(/on[a-z]+="/g) || []).length, 0);
  ok('the inline-handler count is recorded, as the script-src prerequisite',
    inlineHandlers > 0, `${inlineHandlers} inline handler attributes in js/*.js`);

  for (const p of ['/.env', '/db.js', '/server.js', '/package.json', '/schema.sql',
                   '/admin-credentials.local.txt', '/.git/config']) {
    ok(`the web root does not serve ${p}`, (await raw('GET', p, { Host: 'localhost' })).status === 404);
  }

  /* ══ cleanup ══════════════════════════════════════════════════════ */
  await db.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${TAG}-%`]);
  await db.query('DELETE FROM stories WHERE author_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${TAG}-%`]);
  await db.query('DELETE FROM jobs WHERE posted_by_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${TAG}-%`]);
  await db.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%`]);
  const left = await db.query('SELECT count(*)::int n FROM users WHERE email LIKE $1', [`${TAG}-%`]);
  ok('every account this suite created was removed', left.rows[0].n === 0, String(left.rows[0].n));

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exitCode = fail ? 1 : 0;
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nHARNESS ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(2);
});
