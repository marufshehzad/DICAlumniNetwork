/* Entry-point and portal-boundary checks. Static: no browser needed. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const B = 'http://localhost:8123';
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, text: await r.text() }; };

(async () => {
  console.log('\n=== G. entry points ===');
  const root = await get('/');
  const admin = await get('/admin');
  ok('/ serves the alumni site', /id="page-news"/.test(root.text));
  ok('/admin serves the staff portal', /DIC Staff Portal/.test(admin.text));
  ok('/admin/ also serves it', /DIC Staff Portal/.test((await get('/admin/')).text));
  ok('a deep alumni path still serves the alumni site', /id="page-news"/.test((await get('/directory')).text));

  console.log('\n=== J. the alumni site ships no admin frontend ===');
  ok('index.html does not load admin.js', !/js\/admin\.js/.test(root.text));
  ok('index.html does not load compliance.js', !/js\/compliance\.js/.test(root.text));
  ok('index.html does not load administration.js', !/js\/administration\.js/.test(root.text));
  ok('index.html carries no admin page markup', !/id="page-admin"/.test(root.text));
  ok('index.html carries no RBAC or vault markup',
    !/rbac-table|nid-vault-panel|admin-bulkimport/.test(root.text));
  ok('the alumni navigation offers no admin panel', !/DIC Admin Panel/.test(root.text));

  console.log('\n=== G. the staff portal loads what it needs ===');
  ok('admin.html loads admin.js', /js\/admin\.js/.test(admin.text));
  ok('admin.html loads administration.js', /js\/administration\.js/.test(admin.text));
  ok('admin.html loads compliance.js', /js\/compliance\.js/.test(admin.text));
  ok('admin.html loads events.js', /js\/events\.js/.test(admin.text));
  ok('admin.html does not load news.js', !/js\/news\.js/.test(admin.text));
  ok('admin.html does not load profile.js', !/js\/profile\.js/.test(admin.text));
  ok('admin.html sets the portal flag', /window\.DIC_PORTAL\s*=\s*'admin'/.test(admin.text));
  ok('admin.html has no self-registration', !/auth-panel-signup|auth-tab-signup/.test(admin.text));
  ok('admin.html asks not to be indexed', /noindex/.test(admin.text));
  for (const p of ['moderation', 'broadcasts', 'segmentation', 'compliance', 'administration', 'audit']) {
    ok(`admin.html has page-${p}`, admin.text.includes(`id="page-${p}"`));
  }
  for (const p of ['news', 'map', 'profile', 'admin']) {
    ok(`admin.html has no page-${p}`, !admin.text.includes(`id="page-${p}"`));
  }
  ok('the audit page has its own container, not the dashboard\'s',
    /id="audit-log-page"/.test(admin.text) && !/id="audit-log"/.test(admin.text));

  console.log('\n=== O. deployment configuration ===');
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
  const headerJson = JSON.stringify(vercel.headers);
  ok('no wildcard CORS header remains in vercel.json', !/Access-Control-Allow-Origin/.test(headerJson));
  ok('the staff portal is marked noindex', /X-Robots-Tag/.test(headerJson));
  const env = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
  ok('PUBLIC_ORIGIN documented', /PUBLIC_ORIGIN/.test(env));
  ok('ADMIN_ORIGIN documented', /ADMIN_ORIGIN/.test(env));
  ok('ALLOW_DB_RESEED documented', /ALLOW_DB_RESEED/.test(env));

  console.log('\n' + '='.repeat(56));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();

/* Phase 2C additions: host routing, headers, CORS shape, recovery surface. */
(async () => {
  const fs2 = require('fs');
  let p2 = 0, f2 = 0;
  const ok2 = (n, c, d) => { c ? (p2++, console.log('  PASS  ' + n)) : (f2++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
  const head = async (path, host) => {
    const r = await fetch(B + path, { headers: host ? { Host: host } : {} });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };

  console.log('\n=== 6. HOST ROUTING ===');
  const cases = [
    ['/', null, 'id="page-news"'], ['/admin', null, 'DIC Staff Portal'],
    ['/admin/', null, 'DIC Staff Portal'], ['/admin.html', null, 'DIC Staff Portal'],
    ['/directory', null, 'id="page-news"'],
  ];
  for (const [path, host, expect] of cases) {
    const r = await head(path, host);
    ok2(`${path} serves ${expect}`, r.text.includes(expect));
  }
  ok2('/api/health still returns JSON', (await head('/api/health')).text.startsWith('{'));

  console.log('\n=== 7. ROBOTS / CLICKJACKING (on the actual response) ===');
  const adminHead = await head('/admin');
  const siteHead = await head('/');
  ok2('admin: X-Robots-Tag noindex', /noindex/.test(adminHead.headers.get('x-robots-tag') || ''));
  ok2('admin: X-Frame-Options DENY', adminHead.headers.get('x-frame-options') === 'DENY');
  ok2('admin: frame-ancestors none', /frame-ancestors 'none'/.test(adminHead.headers.get('content-security-policy') || ''));
  ok2('alumni site is not marked noindex', !siteHead.headers.get('x-robots-tag'));
  ok2('both: X-Content-Type-Options nosniff',
    adminHead.headers.get('x-content-type-options') === 'nosniff' &&
    siteHead.headers.get('x-content-type-options') === 'nosniff');

  console.log('\n=== 1. RECOVERY SURFACE ===');
  const idx = (await head('/')).text, adm = (await head('/admin')).text;
  for (const [name, html] of [['alumni site', idx], ['staff portal', adm]]) {
    ok2(`${name} offers a forgot-password link`, /showForgotPassword\(\)/.test(html));
    ok2(`${name} has the reset panel`, /id="auth-panel-reset"/.test(html));
    ok2(`${name} shows one neutral message element`, /id="forgot-message"/.test(html));
  }

  console.log('\n=== 5/14. CONFIGURATION ===');
  const env = fs2.readFileSync(path.join(REPO, '.env.example'), 'utf8');
  ok2('PUBLIC_ORIGIN documented', /PUBLIC_ORIGIN/.test(env));
  ok2('ADMIN_ORIGIN documented', /ADMIN_ORIGIN/.test(env));
  ok2('no domain is hardcoded in server.js',
    !/dic\.edu\.bd/.test(fs2.readFileSync(path.join(REPO, 'server.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
  const gi = fs2.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  ok2('reset links are gitignored', /reset-link/.test(gi));

  console.log(`\n  Phase 2C portal additions: ${p2} passed, ${f2} failed`);
  if (f2) process.exitCode = 1;
})();
