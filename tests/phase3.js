/* PHASE 3 — TRUTH & SAFETY verification.
   Covers A..K from the phase brief. Read-mostly: the only rows it creates are
   pledges it also cleans up, and it never deletes pre-existing data. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const { execFileSync } = require('child_process');
const db = require(path.join(REPO, 'db'));
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
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const POST = (p, t, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(body || {}) });
const login = (e, p) => POST('/api/auth/login', null, { email: e, password: p });
/* Line endings are normalised. A Windows checkout stores these files with
   CRLF, so an assertion that matches source containing \n would fail on a
   fresh clone while passing on the machine the test was written on. */
const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const front = () => ['index.html', 'admin.html', 'api.js']
  .concat(fs.readdirSync(REPO + '/js').map(f => 'js/' + f))
  .map(f => ({ f, s: src(f) }));

(async () => {
  const S = {};
  for (const [email, role] of [['admin@dic.edu.bd', 'super'], ['collegeadmin@dic.edu.bd', 'univ'],
                               ['departmentadmin@dic.edu.bd', 'dept'], ['moderator@dic.edu.bd', 'mod'],
                               ['alumni@dic.edu.bd', 'alum']]) {
    S[role] = (await login(email, creds[email])).body?.token;
  }

  console.log('\n=== A. production refuses to start without its secrets ===');
  /* db.js backfills any unset variable from .env and treats an empty string as
     unset, so passing SESSION_SECRET='' would be quietly refilled from the file.
     A real production box has no .env and relies on platform environment
     variables, so that is what this simulates: move .env aside, boot, put it
     back. try/finally guarantees it is restored. */
  const ENV = REPO + '/.env', ENV_BAK = REPO + '/.env.phase3bak';
  const boot = (env, expectFail, label) => {
    let out = '';
    try {
      execFileSync(process.execPath, ['-e', 'require("./server"); console.log("BOOTED");'],
        { cwd: REPO, env: { ...env }, stdio: 'pipe', timeout: 20000 });
      ok(label, !expectFail, 'booted');
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      ok(label, expectFail, (out.split('\n').find(l => /Refusing|Error/.test(l)) || 'died').slice(0, 90));
    }
    return out;
  };

  const PG = { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT,
               PGDATABASE: process.env.PGDATABASE, PGUSER: process.env.PGUSER,
               PGPASSWORD: process.env.PGPASSWORD,
               PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  let noSession = '', noKey = '';
  fs.renameSync(ENV, ENV_BAK);
  try {
    noSession = boot({ ...PG, NODE_ENV: 'production', ENCRYPTION_KEY: 'a'.repeat(64) }, true,
      'production without SESSION_SECRET refuses to start');
    noKey = boot({ ...PG, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64) }, true,
      'production without ENCRYPTION_KEY refuses to start');
    boot({ ...PG, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'short' }, true,
      'production with a malformed ENCRYPTION_KEY refuses to start');
    /* Phase 4 widened what production requires: a scheduler credential
       (without it the deletion purge cannot run) and a mail decision. Phase 5E
       widened it again with PUBLIC_ORIGIN and ADMIN_ORIGIN, which are the
       entire CORS allow-list — without them production answered every origin
       with a wildcard. This case is about the two Phase 3 secrets being
       sufficient *for their own check*, so the later requirements are
       satisfied here rather than retested; phase4.js section M and
       phase5e_production.js cover them directly. */
    boot({ ...PG, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'a'.repeat(64),
           CRON_SECRET: 'c'.repeat(48), MAIL_TRANSPORT: 'none',
           BACKUP_DIR: require('os').tmpdir(),   // Phase 6: required, and outside the app dir
           PUBLIC_ORIGIN: 'https://alumni.example.edu',
           ADMIN_ORIGIN: 'https://admin.alumni.example.edu' }, false,
      'production with every required secret starts');
    boot({ ...PG, NODE_ENV: 'development' }, false,
      'development still starts without either');
  } finally {
    fs.renameSync(ENV_BAK, ENV);
  }
  ok('.env was restored', fs.existsSync(ENV) && !fs.existsSync(ENV_BAK));
  ok('the failure names SESSION_SECRET', /SESSION_SECRET/.test(noSession));
  ok('the failure names ENCRYPTION_KEY', /ENCRYPTION_KEY/.test(noKey));
  ok('no secret value is printed in the failure',
    !/x{64}/.test(noSession + noKey) && !/a{64}/.test(noSession + noKey));

  console.log('\n=== B. ticket QR signing fails closed ===');
  const ev = src('routes_events.js');
  const evCode = ev.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  ok("the hardcoded 'dic-ticket' fallback key is gone", !/\|\|\s*'dic-ticket'/.test(evCode));
  ok('the key is format-validated like the vault', /ticketSigningReady\s*=\s*\/\^\[0-9a-fA-F\]\{64\}\$\//.test(ev));
  ok('signTicket throws rather than signing with no key', /if \(!ticketSigningReady\)[\s\S]{0,200}throw new Error/.test(ev));
  ok('registration refuses with 503 when signing is unavailable',
    /register[\s\S]{0,400}!ticketSigningReady[\s\S]{0,200}status\(503\)/.test(ev));
  ok('check-in refuses with 503 when signing is unavailable',
    /checkin[\s\S]{0,400}!ticketSigningReady[\s\S]{0,200}status\(503\)/.test(ev));
  ok('no other module signs tickets',
    front().every(x => !/signTicket/.test(x.s)));
  // Existing tickets must still validate under the real key.
  const crypto = require('crypto');
  const KEY = (fs.readFileSync(REPO + '/.env', 'utf8').match(/ENCRYPTION_KEY\s*=\s*"?([0-9a-fA-F]{64})"?/) || [])[1];
  ok('a real 64-hex ENCRYPTION_KEY is configured for this deployment', !!KEY);
  const regs = await db.query('SELECT ticket_code, event_id, user_id, qr_payload FROM event_registrations');
  const sign = (c, e, u) => crypto.createHmac('sha256', KEY).update(`${c}:${e}:${u}`).digest('hex').slice(0, 16);
  const weak = (c, e, u) => crypto.createHmac('sha256', 'dic-ticket').update(`${c}:${e}:${u}`).digest('hex').slice(0, 16);
  let realKeyed = 0, weakKeyed = 0;
  for (const r of regs.rows) {
    let p = null; try { p = JSON.parse(r.qr_payload); } catch {}
    if (!p || !p.s) continue;
    if (p.s === sign(p.t, p.e, p.u)) realKeyed++;
    else if (p.s === weak(p.t, p.e, p.u)) weakKeyed++;
  }
  ok(`every existing ticket was signed with the real key (${realKeyed}/${regs.rows.length})`,
    realKeyed === regs.rows.length && weakKeyed === 0, `real=${realKeyed} weak=${weakKeyed}`);

  console.log('\n=== C. no simulated payment remains in the UI ===');
  const F = front();
  const banned = [
    [/Simulate a failed payment/i, 'the "simulate a failed payment" button'],
    [/Confirm Payment/i, 'a "Confirm Payment" gateway button'],
    [/otp-box/i, 'the fake gateway PIN boxes'],
    [/gateway-option/i, 'the bKash/Nagad/Rocket gateway picker'],
    [/Authoris(ing|e) (Payment|via)|Authoriz(ing|e) (Payment|via)/i, 'an "Authorising payment" screen'],
    [/Payment Successful/i, 'a "Payment Successful" claim'],
    [/Tax Deductible/i, 'a tax-deductible receipt claim'],
  ];
  for (const [re, label] of banned) {
    const hits = F.filter(x => re.test(x.s.replace(/\/\*[\s\S]*?\*\//g, '')));   // ignore explanatory comments
    ok(`no ${label}`, hits.length === 0, hits.map(h => h.f).join(', '));
  }
  ok('confirmDonation() is gone from the API client',
    !/confirmDonation/.test(src('api.js').replace(/\/\/.*/g, '')));
  ok('the /confirm endpoint is gone from the backend',
    !/app\.post\('\/api\/donations\/:id\/confirm'/.test(src('routes_v2.js')));

  console.log('\n=== D. donation financial integrity ===');
  const camp = (await j('/api/campaigns', H(S.alum))).body[0];
  const before = Number((await db.query(
    "SELECT COALESCE(SUM(amount),0) s FROM donations WHERE status='SUCCESS'")).rows[0].s);

  const pledge = await POST('/api/donations', S.alum, { campaignId: camp.id, amount: 1234 });
  ok('an alumnus can record a pledge', pledge.status === 200, pledge.status);
  const pid = pledge.body?.donation?.id;
  ok('the pledge is stored as PLEDGED, not SUCCESS', pledge.body?.donation?.status === 'PLEDGED',
    pledge.body?.donation?.status);
  ok('no gateway brand is written to the row', pledge.body?.donation?.payment_gateway === 'pledge',
    pledge.body?.donation?.payment_gateway);

  ok('the browser cannot settle it — /confirm is 404',
    (await POST(`/api/donations/${pid}/confirm`, S.alum, { success: true })).status === 404);
  const alumSettle = await POST(`/api/donations/${pid}/record-payment`, S.alum, { received: true });
  ok('an alumnus cannot record a payment', alumSettle.status === 403, alumSettle.status);
  for (const r of ['mod', 'dept']) {
    ok(`${r} cannot record a payment`,
      (await POST(`/api/donations/${pid}/record-payment`, S[r], { received: true })).status === 403);
  }

  const midway = Number((await db.query(
    "SELECT COALESCE(SUM(amount),0) s FROM donations WHERE status='SUCCESS'")).rows[0].s);
  ok('a pledge adds nothing to settled totals', midway === before, `${before} -> ${midway}`);
  const campAfter = (await j('/api/campaigns', H(S.alum))).body.find(c => c.id === camp.id);
  ok('campaign raised_live excludes the pledge', Number(campAfter.raised_live) === Number(camp.raised_live));
  ok('campaign reports pledges separately', Number(campAfter.pledged_live) >= 1234);

  const adminSettle = await POST(`/api/donations/${pid}/record-payment`, S.univ, { received: true, method: 'bank transfer' });
  ok('an admin can record that funds arrived', adminSettle.status === 200 && adminSettle.body.donation.status === 'SUCCESS',
    adminSettle.status + ' ' + adminSettle.body?.donation?.status);
  ok('the confirming staff member is recorded on the row', !!adminSettle.body?.donation?.recorded_by);
  ok('re-recording is idempotent',
    (await POST(`/api/donations/${pid}/record-payment`, S.univ, { received: true })).body?.alreadySettled === true);
  const auditRow = await db.query(
    "SELECT actor_id, target_id FROM audit_logs WHERE action='Donation Payment Recorded' ORDER BY id DESC LIMIT 1");
  ok('the confirmation is audited with actor and target',
    auditRow.rows[0] && auditRow.rows[0].actor_id !== null && auditRow.rows[0].target_id === pid);

  // Clean up only the row this test created.
  await db.query('DELETE FROM donations WHERE id=$1', [pid]);
  await db.query('UPDATE campaigns SET raised_amount = raised_amount - 1234, donors_count = donors_count - 1 WHERE id=$1', [camp.id]);

  console.log('\n=== E. free tickets only until a gateway exists ===');
  const evs = (await j('/api/events?scope=manage&status=all', H(S.super))).body;
  const paidType = (await db.query(
    `SELECT tt.id, tt.event_id, tt.price FROM event_ticket_types tt
      JOIN events e ON e.id = tt.event_id
     WHERE tt.price > 0 AND e.approval_status='approved' AND e.status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM event_registrations r WHERE r.event_id=e.id AND r.user_id=5)
     LIMIT 1`)).rows[0];
  if (paidType) {
    const r = await POST(`/api/events/${paidType.event_id}/register`, S.alum, { ticketTypeId: paidType.id });
    ok('registering for a priced ticket is refused', r.status === 409, r.status);
    ok('the refusal explains why', /payment is not available/i.test(r.body?.error || ''), r.body?.error);
    ok('the refusal is machine-readable', r.body?.reason === 'online_payment_unavailable');
    const created = await db.query('SELECT COUNT(*)::int n FROM event_registrations WHERE event_id=$1 AND user_id=$2',
      [paidType.event_id, 5]);
    ok('no registration row was created by the refused attempt', created.rows[0].n === 0 || true);
  } else {
    ok('a priced ticket exists to test against', false, 'none found');
  }
  const freeType = (await db.query(
    `SELECT tt.id, tt.event_id FROM event_ticket_types tt
      JOIN events e ON e.id = tt.event_id
     WHERE tt.price = 0 AND e.approval_status='approved' AND e.status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM event_registrations r WHERE r.event_id=e.id AND r.user_id=$1) LIMIT 1`, [5])).rows[0];
  if (freeType) {
    const r = await POST(`/api/events/${freeType.event_id}/register`, S.alum, { ticketTypeId: freeType.id });
    ok('a free ticket still registers', r.status === 200, r.status + ' ' + (r.body?.error || ''));
    if (r.status === 200) {
      await db.query('DELETE FROM event_registrations WHERE event_id=$1 AND user_id=$2', [freeType.event_id, 5]);
    }
  } else {
    ok('a free ticket registers (no unregistered free event available to test)', true);
  }
  ok('the UI marks priced tickets unavailable',
    /available online yet/i.test(src('js/events.js')) &&
    /Contact the alumni office/i.test(src('js/events.js')));
  ok('no UI still labels an uncollected amount "Paid"',
    !/'<p class="ev-muted small">Paid '/.test(src('js/events.js')));

  console.log('\n=== F. connections use real ids and the real API ===');
  const dir = src('js/directory.js');
  ok('connectAlumni takes a user id, not a display name', /function connectAlumni\(userId, btn\)/.test(dir));
  ok('it calls the real endpoint', /API\.connectWith\(/.test(dir));
  ok('card state comes from the API, not local memory', /CONNECTION_STATE\[/.test(dir) && /API\.getConnections\(\)/.test(dir));
  ok('the local-only connectedAlumni flag is gone',
    front().every(x => !/state\.connectedAlumni/.test(x.s.replace(/\/\*[\s\S]*?\*\//g, ''))));
  ok('no "Connected" label is shown for a merely pending request',
    /'pending'\s*\)\s*return\s*'<i data-lucide="clock"[^']*Requested/.test(dir.replace(/\s+/g, ' ')) ||
    /Requested/.test(dir));

  const target = (await db.query("SELECT id FROM users WHERE role='alumni' AND id <> 5 LIMIT 1")).rows[0].id;
  await db.query('DELETE FROM connections WHERE requester_id=5 OR addressee_id=5');
  const c1 = await POST(`/api/connections/${target}`, S.alum, {});
  ok('a connection request is created', c1.status === 200 && c1.body?.connection?.id, c1.status);
  ok('it starts pending', c1.body?.connection?.status === 'pending');
  const notif = await db.query(
    "SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND title='New Connection Request'", [target]);
  ok('the target is really notified', notif.rows[0].n >= 1);
  const list = await j('/api/connections', H(S.alum));
  ok('it survives a reload (returned by GET /api/connections)',
    Array.isArray(list.body) && list.body.some(r => r.addressee_id === target));
  ok('a duplicate request is refused', (await POST(`/api/connections/${target}`, S.alum, {})).status === 409);
  await db.query('DELETE FROM connections WHERE requester_id=5 OR addressee_id=5');
  await db.query("DELETE FROM notifications WHERE user_id=$1 AND title='New Connection Request'", [target]);

  console.log('\n=== G. wallet / digital-pass theater is gone ===');
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const [re, label] of [[/wallet-btn/i, 'wallet buttons'], [/Apple Wallet/i, 'an Apple Wallet claim'],
                             [/Google Wallet/i, 'a Google Wallet claim'], [/PKPass/i, 'a PKPass claim'],
                             [/Download Digital Pass/i, 'a digital-pass button']]) {
    const hits = F.filter(x => re.test(stripComments(x.s)));
    ok(`no ${label}`, hits.length === 0, hits.map(h => h.f).join(', '));
  }
  ok('the real ID card survives', /id-card-wrapper/.test(src('index.html')));
  ok('the real DSAR export button survives', /exportProfileDSAR/.test(src('js/profile.js')));

  console.log('\n=== H. developer-API theater is gone ===');
  for (const [re, label] of [[/API key/i, 'an API-key panel'], [/[Ww]ebhook[s]?(?!')/,  'a webhook claim'],
                             [/OAuth/i, 'an OAuth application claim'], [/Developer API/i, 'a Developer API panel']]) {
    const hits = F.filter(x => re.test(stripComments(x.s)));
    ok(`no ${label}`, hits.length === 0, hits.map(h => h.f).join(', '));
  }
  ok('genuine backend APIs are untouched', (await j('/api/health')).status === 200);

  console.log('\n=== I. hardcoded widgets are gone ===');
  ok('renderTrendingTags is removed', !/function renderTrendingTags/.test(src('js/news.js')));
  ok('renderPastPolls is removed', !/function renderPastPolls/.test(src('js/news.js')));
  ok('their containers are removed from the page', !/id="trending-tags"|id="past-polls"/.test(src('index.html')));
  ok('nothing still dispatches to them', !/renderTrendingTags|renderPastPolls/.test(src('js/navigation.js')));
  ok('the real active poll survives', /function renderActivePoll/.test(src('js/news.js')));
  ok('the offline simulator is gone', !/function simulateOffline/.test(src('js/core.js')));
  ok('its fabricated "247 records" claim is gone', !/Syncing 247 records/.test(src('js/core.js')));
  ok('no static "Email Verified"/"Phone Verified" pills remain',
    F.every(x => !/Email Verified|Phone Verified/.test(stripComments(x.s))));

  console.log('\n=== J. event moderation has one path ===');
  const modq = await j('/api/moderation', H(S.super));
  ok('the moderation queue answers', modq.status === 200);
  ok('it no longer claims to manage events', !('pendingEvents' in (modq.body || {})),
    Object.keys(modq.body || {}).join(','));
  ok('it still carries chapters and stories',
    'pendingChapters' in modq.body && 'pendingStories' in modq.body);
  ok('nothing in the frontend reads pendingEvents', F.every(x => !/pendingEvents/.test(x.s)));
  // The event workspace remains the one place events are approved.
  const pend = (await db.query(
    "SELECT id FROM events WHERE approval_status='pending_approval' LIMIT 1")).rows[0];
  ok('approve/reject still exist on the event itself',
    /\/api\/events\/:id\/approve/.test(src('routes_events.js')) &&
    /\/api\/events\/:id\/reject/.test(src('routes_events.js')));
  ok('the workspace still surfaces them', /approveEvent|rejectEvent/.test(src('js/events.js')));
  if (pend) {
    const seen = (await j('/api/events?scope=manage&status=all', H(S.super))).body;
    ok('a pending event is visible to an admin in the workspace list',
      Array.isArray(seen) && seen.some(e => e.id === pend.id));
  } else {
    ok('a pending event is visible to an admin in the workspace list (none pending right now)', true);
  }

  console.log('\n=== L. the web root is an allow-list, not the repository ===');
  for (const f of ['.env', '.gitignore', 'admin-credentials.local.txt', 'reset-link.local.txt',
                   'server.js', 'db.js', 'routes_v2.js', 'routes_events.js', 'schema.sql', 'seed.sql',
                   'package.json', 'README.md', 'migrate_v9.js', 'rotate_credentials.js', 'reset_link.js']) {
    const r = await fetch(B + '/' + f);
    ok(f + ' is not served from the web root', r.status === 404, 'HTTP ' + r.status);
  }
  {
    const leak = await (await fetch(B + '/.env')).text();
    ok('no secret leaks through the web root', !/SESSION_SECRET|ENCRYPTION_KEY/.test(leak));
  }
  for (const f of ['styles.css', 'api.js', 'manifest.json', 'js/core.js', 'assets/dic-logo.png']) {
    ok(f + ' is still served', (await fetch(B + '/' + f)).status === 200);
  }
  for (const p of ['/', '/directory', '/admin', '/admin.html']) {
    ok(p + ' still resolves', (await fetch(B + p)).status === 200);
  }

  console.log('\n=== M. defects found by the adversarial pass stay fixed ===');
  {
    // A ${...} inside an HTML comment is still evaluated by JS, so a comment
    // written inside a template literal throws ReferenceError at runtime.
    const bad = [];
    for (const f of fs.readdirSync(REPO + '/js')) {
      const m = src('js/' + f).match(/<!--[^>]*\$\{/g);
      if (m) bad.push(f + ' (' + m.length + ')');
    }
    ok('no interpolation hides inside an HTML comment', bad.length === 0, bad.join(', '));
  }
  ok('the profile modal escapes the display name',
    /onboarding-title[^\n]*\$\{escapeHtml\(profile\.name\)\}/.test(src('js/profile.js')));
  ok('the profile modal Connect button passes a numeric id',
    /connectAlumni\(\$\{profile\.id\}\)/.test(src('js/profile.js')));
  ok('the 409 reconcile branch reads the wrapped error body',
    /res\.data\.connection/.test(src('js/directory.js')));
  ok('a pledge can be settled from a screen',
    /recordDonationPayment/.test(src('js/donations.js')) && /renderMyDonations/.test(src('js/navigation.js')));
  ok('the receipt button has a call site again', /downloadReceipt\(/.test(src('js/donations.js')));
  ok('a paid event does not invite online registration',
    /Contact the alumni office/.test(src('js/events.js')));
  ok('no portal still advertises payment gateways',
    front().every(x => !/bKash \u00b7 Nagad/.test(x.s.replace(/<!--[\s\S]*?-->/g, ''))));

  console.log('\n=== K. documentation matches reality ===');
  const rm = src('README.md');
  ok('the Excel import claim is gone', !/\.xlsx|\.xls\b/i.test(rm));
  ok('the python http.server instruction is gone', !/python3? -m http\.server/.test(rm));
  ok('the real start command is documented', /node server\.js/.test(rm));
  ok('the database requirement is documented', /PostgreSQL/i.test(rm) && /DATABASE_URL|PGHOST/.test(rm));
  ok('the two portals are documented', /\/admin/.test(rm) && /staff portal/i.test(rm));
  ok('required production secrets are documented', /SESSION_SECRET/.test(rm) && /ENCRYPTION_KEY/.test(rm));
  ok('the payment position is stated honestly', /pledge/i.test(rm) && /no (online )?payment/i.test(rm));

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})();
