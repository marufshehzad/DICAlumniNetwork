#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 5A security regressions

   Four defects found by adversarial review after the Phase 5A work was
   otherwise finished. Each is pinned here so it cannot come back:

     A  GET /api/alumni/:id leaked private contact details between members,
        because alumni_profiles.id shadowed users.id in the SELECT and the
        "is this me?" test then compared a user id against a profile id.
     B  An oversized X-Forwarded-For header suppressed the audit entry
        entirely — the action succeeded and nothing was recorded.
     C  verify_audit.js --database was a dead flag whenever DATABASE_URL was
        set, so the tool could inspect production while naming a restore.
     D  Caller-supplied free text reached the hash-chained audit log unbounded.

   Usage:  node tests/phase5a_security.js
           (needs the application running on TEST_BASE, default :8123)

   It creates its own accounts and removes them. It never deletes an audit
   entry — the chain is append-only, and a test that prunes it would be
   asserting the opposite of what this phase built.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'db'));
const auditChain = require(path.join(REPO, 'audit_chain'));

const B = process.env.TEST_BASE || 'http://localhost:8123';
const CREDS_FILE = path.join(REPO, 'admin-credentials.local.txt');

const creds = {};
if (fs.existsSync(CREDS_FILE)) {
  for (const l of fs.readFileSync(CREDS_FILE, 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) creds[m[2]] = m[3];
  }
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
const POST = (p, t, body, extra = {}) => j(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...extra },
  body: JSON.stringify(body || {})
});
const PUT = (p, t, body) => j(p, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
  body: JSON.stringify(body || {})
});

const PW = 'Phase5A-Regression-Pw1';

async function makeMember(tag) {
  const email = `p5a-sec-${tag}@dic.test`;
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  // The self-registration endpoint takes hscPassingYear, from which it derives
  // the batch — see POST /api/auth/register in server.js.
  const r = await POST('/api/auth/register', null, {
    name: `Phase5A ${tag}`, email, password: PW,
    hscPassingYear: 2019, hscGroup: 'Science', mobile: '+880 1700-000001'
  });
  if (!r.body?.token) throw new Error(`could not create ${tag}: ${JSON.stringify(r.body)}`);
  const uid = r.body.user.id;
  return { email, token: r.body.token, uid };
}

(async () => {
  const S = {};
  for (const [email, role] of [['admin@dic.edu.bd', 'super'], ['moderator@dic.edu.bd', 'mod']]) {
    if (creds[email]) S[role] = (await POST('/api/auth/login', null, { email, password: creds[email] })).body?.token;
  }

  /* ══════════════════════════════════════════════════════════
     A. Profile privacy is enforced per USER, not per profile row
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== A. GET /api/alumni/:id does not leak private contact details ===');

  const A = await makeMember('alpha');
  const Bm = await makeMember('bravo');

  // The precondition for the original bug: the profile's own primary key is a
  // different number from the user id, so confusing the two is observable.
  const profRows = await db.query(
    'SELECT id AS profile_id, user_id FROM alumni_profiles WHERE user_id = ANY($1::int[])',
    [[A.uid, Bm.uid]]);
  ok('the two members have profile ids distinct from their user ids',
    profRows.rows.length === 2 && profRows.rows.every(r => r.profile_id !== r.user_id),
    JSON.stringify(profRows.rows));

  // B marks contact details private; A must not see them.
  await PUT('/api/profile/me', Bm.token, { mobile: '+880 1700-555111' });
  const setPriv = await PUT('/api/profile/me', Bm.token,
    { privacySettings: { mobile: 'private', email: 'private' } });
  ok('the private setting is accepted', setPriv.status === 200, JSON.stringify(setPriv.body).slice(0, 90));

  const selfView = await j(`/api/alumni/${Bm.uid}`, H(Bm.token));
  ok('a member still sees their own contact details',
    selfView.status === 200 && selfView.body.email !== null,
    JSON.stringify({ e: selfView.body?.email, m: selfView.body?.mobile }));
  ok('the response identifies the USER, not the profile row',
    selfView.body?.id === Bm.uid, `${selfView.body?.id} vs user ${Bm.uid}`);

  const peerView = await j(`/api/alumni/${Bm.uid}`, H(A.token));
  ok('a peer cannot read a private email address', peerView.body?.email === null,
    JSON.stringify(peerView.body?.email));
  ok('a peer cannot read a private mobile number', peerView.body?.mobile === null,
    JSON.stringify(peerView.body?.mobile));
  ok('the peer still gets the public part of the profile', peerView.status === 200 && !!peerView.body?.name);

  /* The original defect exposed the member whose PROFILE id equalled the
     reader's USER id. Walk every profile as A and assert none of them is
     mistaken for A's own. */
  const everyone = await db.query(
    'SELECT user_id, id AS profile_id FROM alumni_profiles ORDER BY id');
  let leaked = [];
  for (const row of everyone.rows) {
    if (row.user_id === A.uid) continue;
    const seen = await j(`/api/alumni/${row.user_id}`, H(A.token));
    if (seen.status !== 200) continue;
    if (seen.body.id !== row.user_id) leaked.push(`id ${seen.body.id} for user ${row.user_id}`);
  }
  ok('no profile is returned under another member\'s identifier', leaked.length === 0,
    leaked.slice(0, 4).join(', '));

  // Direct numeric guessing must not reveal anything either.
  for (const guess of [1, 2, 3, 4, A.uid, Bm.uid, 99999, -1]) {
    const g = await j(`/api/alumni/${guess}`, H(A.token));
    if (g.status !== 200) continue;
    const isSelf = g.body.id === A.uid;
    if (!isSelf && (g.body.email !== null || g.body.mobile !== null)) {
      // Only a failure if that member had asked for privacy.
      const pv = await db.query(
        'SELECT privacy_settings FROM alumni_profiles WHERE user_id = $1', [g.body.id]);
      const p = pv.rows[0]?.privacy_settings || {};
      if (p.email === 'private' && g.body.email !== null) leaked.push(`email of ${g.body.id}`);
      if (p.mobile === 'private' && g.body.mobile !== null) leaked.push(`mobile of ${g.body.id}`);
    }
  }
  ok('guessing ids does not expose anything marked private', leaked.length === 0, leaked.join(', '));

  ok('staff may still see contact details, which is the intended exception',
    S.mod ? (await j(`/api/alumni/${Bm.uid}`, H(S.mod))).status === 200 : true);

  /* ══════════════════════════════════════════════════════════
     B. An audit entry cannot be suppressed by a header
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== B. an oversized X-Forwarded-For cannot suppress the audit entry ===');

  const headers = {
    'a 65-character forwarded address': 'x'.repeat(65),
    'a long proxy chain': Array.from({ length: 40 }, (_, i) => `10.0.0.${i}`).join(', '),
    'a malformed forwarded value': 'not-an-ip, ' + 'y'.repeat(200),
    'unicode in the forwarded value': 'é'.repeat(80)
  };

  for (const [label, value] of Object.entries(headers)) {
    const before = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
    const r = await POST('/api/auth/forgot-password', null, { email: 'admin@dic.edu.bd' },
      { 'X-Forwarded-For': value });
    const after = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
    // 429 means the rate limiter answered first; that is not a suppression.
    if (r.status === 429) { ok(`${label}: rate limited, retrying is not this test's job`, true); continue; }
    ok(`${label}: the request still succeeds`, r.status === 200, String(r.status));
    ok(`${label}: the audit entry is written, not dropped`, after > before, `${before} -> ${after}`);
  }

  const widest = await db.query(
    `SELECT MAX(LENGTH(ip))::int n FROM audit_logs WHERE chain_version = $1`, [auditChain.CHAIN_VERSION]);
  ok('every recorded address fits its column', (widest.rows[0].n || 0) <= 64, String(widest.rows[0].n));
  ok('the chain still verifies after those requests',
    (await auditChain.verifyChain(db)).ok);

  /* ══════════════════════════════════════════════════════════
     C. --database actually selects the database
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== C. the verifier inspects the database it names ===');

  const verifier = path.join(REPO, 'verify_audit.js');
  const runVerifier = (args, env = {}) => spawnSync(process.execPath, [verifier, ...args],
    { cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });

  const src = fs.readFileSync(verifier, 'utf8');
  ok('the flag clears a connection string that would otherwise win',
    /delete process\.env\.DATABASE_URL/.test(src) && /delete process\.env\.POSTGRES_URL/.test(src));
  ok('the flag rejects anything that is not a plain database name',
    /\^\[A-Za-z0-9_\]\+\$/.test(src));

  // A database that does not exist must be reported as an error, not silently
  // answered from whatever connection happened to be configured.
  const missing = runVerifier(['--json', '--database', 'dic_definitely_not_here'],
    { DATABASE_URL: '' });
  ok('naming a database that does not exist fails loudly', missing.status === 2,
    `exit ${missing.status}`);

  // The same, with a connection string present — the case that used to be
  // ignored entirely and answered from production.
  const shadowed = runVerifier(['--json', '--database', 'dic_definitely_not_here'],
    { DATABASE_URL: `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
                    `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/` +
                    `${process.env.PGDATABASE || 'dic_alumni_db'}` });
  ok('a DATABASE_URL no longer overrides the flag', shadowed.status === 2,
    `exit ${shadowed.status} — a 0 or 1 here means it read the URL's database instead`);

  const rejected = runVerifier(['--json', '--database', 'bad;name']);
  ok('an unsafe database name is refused', rejected.status === 2, `exit ${rejected.status}`);

  /* ══════════════════════════════════════════════════════════
     D. Caller free text is bounded before it reaches the chain
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== D. free text cannot flood or break an audit entry ===');

  const nasty = [
    ['an oversized consent type', 'z'.repeat(5000)],
    ['quotes and backslashes', 'a"b\\c\'d`e'],
    ['text shaped like the canonical payload', '","forged","'],
    ['newlines and control characters', 'line1\nline2\tline3\r\n'],
    ['unicode and emoji', 'তথদ🎓'.repeat(50)]
  ];

  for (const [label, value] of nasty) {
    const before = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
    const r = await POST('/api/consent', A.token, { consentType: value, granted: true });
    const after = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
    /* 200 (accepted and bounded) or 400 (refused with a reason) are both fine.
       A 500 is not: it means the value reached Postgres, and the driver's
       message — which names the column type and width — came back to the
       caller. */
    ok(`${label}: the request is handled safely, not a 500`,
      r.status === 200 || r.status === 400, String(r.status) + ' ' + JSON.stringify(r.body).slice(0, 80));
    if (r.status === 400) {
      ok(`${label}: the refusal explains the limit without describing the schema`,
        /characters or fewer|required/i.test(r.body?.error || '') &&
        !/character varying|violates|constraint|relation/i.test(r.body?.error || ''),
        r.body?.error);
    }
    if (r.status === 200) {
      ok(`${label}: the audit entry is written`, after > before, `${before} -> ${after}`);
      const last = (await db.query('SELECT action, meta FROM audit_logs ORDER BY id DESC LIMIT 1')).rows[0];
      ok(`${label}: the entry stays bounded`, last.meta.length <= 4000, String(last.meta.length));
    }
  }

  const chainAfterText = await auditChain.verifyChain(db);
  ok('the chain verifies after every hostile string', chainAfterText.ok,
    JSON.stringify(chainAfterText.firstInvalid));

  // Source-level: the three sites the review named are bounded.
  const bounded = [
    ['consent type', 'routes_compliance.js', /String\(consentType\)\.slice\(0, ?\d+\)/],
    ['bulk import filename', 'server.js', /String\(filename[\s\S]{0,40}\)\.replace\([\s\S]{0,40}\)\.slice\(0, ?\d+\)/],
    ['donation reason', 'routes_v2.js', /String\(reason[\s\S]{0,30}\)\.slice\(0, ?\d+\)/]
  ];
  for (const [label, file, re] of bounded) {
    ok(`${label} is bounded at its call site`, re.test(fs.readFileSync(path.join(REPO, file), 'utf8')), file);
  }
  ok('the audit writer clamps every column to its declared width',
    /function clamp\(/.test(fs.readFileSync(path.join(REPO, 'audit_chain.js'), 'utf8')));

  /* ══════════════════════════════════════════════════════════
     Chain-level guarantees these fixes must not have weakened
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== E. the chain is still whole ===');
  const final = await auditChain.verifyChain(db);
  ok('the chain verifies', final.ok, JSON.stringify(final.firstInvalid));
  ok('every row belongs to a known segment',
    !final.problems.some(p => p.reason === 'count-reconciliation'),
    JSON.stringify(final.problems.map(p => p.reason)));
  ok('historical segments are reported, never counted as verified',
    (final.historical || []).length > 0 && final.verifiedCount !== final.legacyCount);

  /* ══════════════════════════════════════════════════════════
     F. What the operator is told matches what is true

     Found by the Phase 5A browser verification, not by any suite: the super
     admin panel reported the API "Unreachable" while it was answering 200,
     because Phase 4 standardised /api/health on {status:'ok'} for the external
     monitor and this widget still tested for the older 'online'. A dashboard
     that cries outage during an outage-free day is the same class of defect as
     an audit trail that cannot be verified — the operator cannot trust it.
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== F. operator-facing status tells the truth ===');

  /* These assertions are about what executes and what a user reads, so the
     source is stripped of comments first. Without this the suite fails on its
     own explanatory prose — a comment recording that a widget *used to* claim
     "IndexedDB" is not the widget claiming it, and a test that cannot tell the
     difference trains people to ignore it. */
  const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
  const readJs = (...p) => stripJs(fs.readFileSync(path.join(REPO, ...p), 'utf8'));
  const readHtml = f => stripHtml(fs.readFileSync(path.join(REPO, f), 'utf8'));

  const health = await j('/api/health');
  ok('GET /api/health answers 200', health.status === 200, String(health.status));
  ok('…with the documented contract {status:ok, database:ok}',
    health.body?.status === 'ok' && health.body?.database === 'ok', JSON.stringify(health.body));
  ok('…and a numeric latency', Number.isFinite(health.body?.latencyMs), JSON.stringify(health.body));

  const dashSrc = readJs('js', 'dashboard.js');
  ok('the status widget reads the status the server actually sends',
    /h\.status\s*!==\s*'ok'/.test(dashSrc) && !/status\s*!==\s*'online'/.test(dashSrc));
  ok('…and distinguishes a degraded database from an unanswered API',
    /Degraded/.test(dashSrc) && /did not answer a health check/.test(dashSrc));
  ok('…and no longer renders fields /api/health stopped returning',
    !/h\.total_users/.test(dashSrc) && !/new Date\(h\.time\)/.test(dashSrc));

  const apiSrc = readJs('api.js');
  ok('a failed health check does not invent a storage engine',
    !/IndexedDB/.test(apiSrc), 'api.js still claims IndexedDB');

  /* The topbar chip asserted "PostgreSQL 16 · Live" as a literal in the HTML of
     both portals — a green dot with nothing behind it, which said Live with the
     database down and named a major version no deployment is obliged to run. */
  for (const shell of ['index.html', 'admin.html']) {
    ok(`${shell} ships no hardcoded database status claim`,
      !/PostgreSQL[^<]*·[^<]*Live/.test(readHtml(shell)));
  }
  ok('the chip is driven by the health check instead',
    /refreshConnectionChip/.test(readJs('js', 'core.js')));

  /* Navigation. showPage() hid every page before checking the target existed,
     so any id the current portal does not define blanked the whole document.
     The staff portal did exactly that from its own topbar avatar. */
  const navSrc = readJs('js', 'navigation.js');
  const resolveIdx = navSrc.indexOf("getElementById('page-' + page)");
  const hideIdx = navSrc.indexOf(".forEach(p => p.classList.add('hidden'))");
  ok('showPage resolves the target BEFORE hiding anything',
    resolveIdx > -1 && hideIdx > -1 && resolveIdx < hideIdx,
    `resolve@${resolveIdx} hide@${hideIdx}`);
  ok('…and returns without blanking when the portal lacks that page',
    /if \(!target\)[\s\S]{0,400}?return;/.test(navSrc));

  for (const shell of ['index.html', 'admin.html']) {
    const html = readHtml(shell);
    const defined = new Set([...html.matchAll(/id="page-([a-z-]+)"/g)].map(m => m[1]));
    const missing = [...new Set([...html.matchAll(/showPage\('([a-z-]+)'\)/g)].map(m => m[1]))]
      .filter(t => !defined.has(t));
    ok(`every showPage target inside ${shell} exists in ${shell}`,
      missing.length === 0, missing.join(','));
  }
  ok('the dashboard audit button opens the audit page that exists',
    /showPage\('audit'\)">View Full Audit Log/.test(readJs('js', 'admin.js')));

  /* The trail is hash-chained and append-only. It is not immutable: the digest
     is unkeyed and the historical segments carry no protection at all
     (AUDIT_CHAIN.md §4). Claiming otherwise in the UI is the exact overstatement
     this phase was opened to remove. */
  for (const f of ['admin.html', 'index.html', 'js/admin.js', 'routes_compliance.js']) {
    const src = f.endsWith('.html') ? readHtml(f) : readJs(...f.split('/'));
    ok(`${f} does not claim the audit trail is immutable or write-once`,
      !/Immutable|Write-Once/i.test(src));
  }

  if (S.super) {
    const comp = await j('/api/compliance/status', H(S.super));
    const trail = (comp.body || []).find(c => /Audit Trail/.test(c.title || ''));
    ok('the compliance pill exists', !!trail, JSON.stringify(comp.body?.map?.(c => c.title)));
    ok('…and separates verifiable entries from unverifiable legacy ones',
      !!trail && /independently verifiable/.test(trail.desc) &&
      (/not verifiable/.test(trail.desc) || !/legacy/.test(trail.desc)), trail?.desc);
    ok('…rather than presenting one undifferentiated total',
      !!trail && !/^\d+ hash-chained entries/.test(trail.desc), trail?.desc);
  } else {
    ok('super admin session available for the compliance check', false, 'no credentials file');
  }

  console.log('\n=== cleanup ===');
  /* Only the accounts this file created. Audit entries are deliberately left
     alone: the chain is append-only and deleting from it would break exactly
     the property these tests exist to protect. */
  await db.query('DELETE FROM users WHERE email LIKE $1', ['p5a-sec-%@dic.test']);
  const left = (await db.query(
    'SELECT COUNT(*)::int n FROM users WHERE email LIKE $1', ['p5a-sec-%@dic.test'])).rows[0].n;
  ok('test accounts removed', left === 0, String(left));
  ok('the chain survives their deletion — the whole point of actor_ref',
    (await auditChain.verifyChain(db)).ok);

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})().catch(async (e) => {
  console.error('\nHARNESS ERROR: ' + e.message);
  try { await db.pool.end(); } catch {}
  process.exit(2);
});
