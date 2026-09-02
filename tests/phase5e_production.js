#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 5E production configuration

   Pins the production-safety contract established in Phase 5E:

     · production refuses to start unless every required variable is present
     · no secret value is ever printed, even while refusing
     · CORS is an allow-list, never a wildcard
     · each configured host serves its own portal
     · the startup banner reports the database it is actually connected to
     · no fabricated payment gateway is written anywhere

   Each case spawns a real server with a controlled environment and kills it.
   Nothing here touches the live database — every boot is read-only, and the
   host tests only fetch static HTML.

   Usage:  node tests/phase5e_production.js
   ============================================================ */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');

/* Source assertions must not match the comment that explains the fix. Every
   one of these checks is of the form "this pattern is gone from the code", and
   the commit that removed each pattern also wrote a comment quoting it. */
const code = f => src(f)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* Database credentials are NOT part of the contract under test — the contract
   is about secrets, origins and mail transport. But DIC_SKIP_DOTENV (below)
   removes *everything* in .env, and the startup banner can only name a
   database if it can actually reach one. So read the PG* keys back, and only
   those. Absent a .env this yields nothing and the banner check is skipped. */
function pgFromDotenv() {
  const p = path.join(REPO, '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (!/^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|DATABASE_URL)$/.test(k)) continue;
    out[k] = t.slice(i + 1).trim().replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}
const PG = pgFromDotenv();
const HAVE_DB = !!(PG.PGPASSWORD || PG.DATABASE_URL || process.env.PGPASSWORD);

/* A complete production environment. Values are throwaway and never real: the
   point is shape, not secrecy. `.env` is bypassed with DIC_SKIP_DOTENV so a
   developer machine's file cannot silently supply the very variable a case is
   trying to remove and make the test pass for the wrong reason. */
const FULL = {
  NODE_ENV: 'production',
  DIC_SKIP_DOTENV: '1',
  SESSION_SECRET: 's'.repeat(64),
  ENCRYPTION_KEY: 'a'.repeat(64),
  CRON_SECRET: 'c'.repeat(48),
  MAIL_TRANSPORT: 'none',
  BACKUP_DIR: require('os').tmpdir(),   // Phase 6: required, outside the app dir
  PUBLIC_ORIGIN: 'https://alumni.example.edu',
  ADMIN_ORIGIN: 'https://admin.alumni.example.edu',
  ...PG
};
const REQUIRED = ['SESSION_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET',
                  'MAIL_TRANSPORT', 'PUBLIC_ORIGIN', 'ADMIN_ORIGIN', 'BACKUP_DIR'];

let port = 8390;

/* Boot a server, let it settle, hand it to `probe`, then kill it. */
function boot(overrides = {}, { drop = [], waitMs = 4200, probe = null } = {}) {
  return new Promise(resolve => {
    const env = { ...process.env, ...FULL, ...overrides, PORT: String(port++) };
    for (const k of drop) delete env[k];
    const p = spawn(process.execPath, ['server.js'], { cwd: REPO, env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    let settled = false;
    const finish = async () => {
      if (settled) return; settled = true;
      let probed = null;
      if (probe && /API Server running/.test(out)) {
        try { probed = await probe(Number(env.PORT)); } catch (e) { probed = { error: e.message }; }
      }
      try { p.kill('SIGKILL'); } catch {}
      resolve({
        out, probed,
        port: env.PORT,
        refused: /Refusing to start in production/.test(out),
        started: /API Server running/.test(out)
      });
    };
    setTimeout(finish, waitMs);
    p.on('exit', () => setTimeout(finish, 150));
  });
}

/* Raw http, not fetch: `Host` and `Origin` are forbidden header names in the
   fetch spec, and undici drops `Host` silently. The first version of this file
   used fetch and reported that the admin host served the alumni site — it had
   never actually changed the host. */
function request(portNum, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: portNum, path: urlPath, method: 'GET', headers },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  console.log('\n=== A. production fails closed on every required variable ===');

  const full = await boot({}, {
    probe: async (p) => {
      const grab = async (origin) =>
        (await request(p, '/api/health', origin ? { Origin: origin } : {}))
          .headers['access-control-allow-origin'] ?? null;
      const shell = async (host) => {
        const r = await request(p, '/', { Host: host });
        return /DIC Staff Portal/.test(r.body) ? 'staff'
             : /DIC Alumni Network/.test(r.body) ? 'alumni' : '?';
      };
      return {
        evil: await grab('https://evil.example'),
        good: await grab(FULL.PUBLIC_ORIGIN),
        admin: await grab(FULL.ADMIN_ORIGIN),
        alumniShell: await shell('alumni.example.edu'),
        adminShell: await shell('admin.alumni.example.edu'),
        pathShell: (await request(p, '/admin')).body.match(/DIC Staff Portal/) ? 'staff' : 'alumni'
      };
    }
  });
  ok('with every variable present, production starts', full.started, full.out.slice(0, 160));

  for (const v of REQUIRED) {
    const r = await boot({}, { drop: [v] });
    ok(`without ${v}, production refuses to start`, r.refused && !r.started);
    ok(`  …and names ${v} in the refusal`, new RegExp(v).test(r.out));
  }

  // Malformed, not merely absent.
  for (const [label, ov] of [
    ['ENCRYPTION_KEY that is not 64 hex', { ENCRYPTION_KEY: 'abc123' }],
    ['ENCRYPTION_KEY of the right length but not hex', { ENCRYPTION_KEY: 'z'.repeat(64) }],
    ['CRON_SECRET shorter than 32 characters', { CRON_SECRET: 'short' }]
  ]) {
    const r = await boot(ov);
    ok(`a malformed ${label} is refused`, r.refused && !r.started);
  }

  console.log('\n=== B. no secret is ever printed ===');
  const leak = await boot({}, { drop: ['SESSION_SECRET'] });
  ok('the refusal prints no secret value',
    !leak.out.includes('s'.repeat(64)) && !leak.out.includes('a'.repeat(64)) &&
    !leak.out.includes('c'.repeat(48)));
  ok('…and prints no database password',
    !/PGPASSWORD/.test(leak.out) && !(PG.PGPASSWORD && leak.out.includes(PG.PGPASSWORD)));
  ok('a successful boot prints no secret value',
    !full.out.includes('s'.repeat(64)) && !full.out.includes('a'.repeat(64)) &&
    !(PG.PGPASSWORD && full.out.includes(PG.PGPASSWORD)));

  console.log('\n=== C. CORS is an allow-list, never a wildcard ===');
  const c = full.probed || {};
  ok('the running server answered the CORS probe', !!full.probed && !full.probed.error,
    full.probed && full.probed.error);
  ok('a foreign origin gets no Access-Control-Allow-Origin', !c.evil, String(c.evil));
  ok('the wildcard is never sent', c.evil !== '*' && c.good !== '*', String(c.good));
  ok('the public origin is echoed back exactly', c.good === FULL.PUBLIC_ORIGIN, String(c.good));
  ok('the admin origin is allowed too', c.admin === FULL.ADMIN_ORIGIN, String(c.admin));

  console.log('\n=== D. each host serves its own portal ===');
  /* Under the recommended architecture the alumni host is a SUBSTRING of the
     admin origin, and host matching used to be a substring test — so the
     public domain served the staff portal. */
  ok('the alumni host serves the alumni site', c.alumniShell === 'alumni', c.alumniShell);
  ok('the admin host serves the staff portal', c.adminShell === 'staff', c.adminShell);
  ok('/admin still serves the staff portal on any host', c.pathShell === 'staff', c.pathShell);
  const server = code('server.js');
  ok('host matching compares hostnames, not substrings',
    /function originHost/.test(server) && !/\.includes\(host\)/.test(server));
  ok('a shared origin falls back to path routing', /adminHost === publicHost/.test(server));

  console.log('\n=== E. the startup banner reports reality ===');
  ok('the banner asks the connection which database it is on',
    /current_database\(\)/.test(server));
  ok('…rather than printing a hardcoded database name',
    !/PostgreSQL Database "dic_alumni_db"/.test(server));
  if (HAVE_DB) {
    ok('the successful boot named the database it reached',
      /Connected to PostgreSQL database "/.test(full.out),
      full.out.split('\n').find(l => /PostgreSQL/.test(l)));
  } else {
    console.log('  SKIP  the successful boot named the database  (no PG credentials available)');
  }

  console.log('\n=== F. no fabricated payment gateway ===');
  const v2 = code('routes_v2.js');
  ok('campaign creation writes no default gateway list',
    !/\['bkash',\s*'nagad',\s*'card'\]/.test(v2));
  ok('donations are created as a pledge by the server', /'PLEDGED'/.test(v2));
  ok('no payment SDK is a dependency',
    !/bkash|nagad|stripe|razorpay|sslcommerz/i.test(
      Object.keys(require(path.join(REPO, 'package.json')).dependencies).join(' ')));

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error('\nHARNESS ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(2);
});
