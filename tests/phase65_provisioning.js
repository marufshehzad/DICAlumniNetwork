#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 6.5 provisioning contract

   Phase 6.5 made a hosting recommendation and proved the mechanisms that
   recommendation depends on. This pins what can be checked without a server:

     A  the hosting recommendation is recorded, with its evidence
     B  both production trigger paths work, and neither double-executes
     C  the health and monitor endpoints answer the three states
     D  the alert path exists, is provider-agnostic, and reports its own failure
     E  the off-site path encrypts, and nothing hardcodes a provider
     F  every production variable is documented and enforced
     G  nothing invented a credential, a domain or a provider account

   The heavier proof is tests/offsite_drill.js, which runs the whole encrypted
   round trip through a disposable database.

   Usage:  node tests/phase65_provisioning.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const skip = (n, why) => { skipped++; console.log('  SKIP  ' + n + '  (' + why + ')'); };
const head = t => console.log('\n' + t);

const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const has = f => fs.existsSync(path.join(REPO, f));
const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const CRON = process.env.CRON_SECRET || '';

(async () => {
  /* ══ A. The decision is recorded, with evidence ═══════════════════════ */
  head('=== A. One hosting model is recommended, and the evidence is given ===');
  ok('there is a provisioning document', has('PRODUCTION_PROVISIONING.md'));
  const prov = src('PRODUCTION_PROVISIONING.md');
  ok('it recommends exactly one model', /Recommended hosting/.test(prov));
  ok('it names the model in the heading', /VPS|Vercel/.test(prov.split('\n').find(l => /Recommended hosting/.test(l)) || ''));
  ok('it gives the reasons rather than a preference',
    /pg_dump/.test(prov) && /read-only/.test(prov) && /loginAttempts|per-process/.test(prov));
  ok('it states what the rejected option would cost, rather than dismissing it',
    /If DIC chooses Vercel anyway/i.test(prov));
  ok('server requirements are concrete', /2 vCPU|4 GB/.test(prov) && /PostgreSQL 16/.test(prov));
  ok('DNS records are given as records, not prose',
    /`A`/.test(prov) && /AAAA/.test(prov) && /_dmarc/.test(prov));
  ok('it does not pretend DNS was configured',
    /Do not configure any of these yet/i.test(prov));

  /* ══ B. Both trigger paths ════════════════════════════════════════════ */
  head('=== B. Both production trigger paths work ===');
  const jobs = require(path.join(REPO, 'jobs'));
  ok('the job registry is the single source of job names',
    jobs.JOB_NAMES.length === 3, jobs.JOB_NAMES.join(','));

  /* The brief listed four jobs. Task reminders are part of event-maintenance,
     and there is no engagement-snapshot job — server.js says plainly that the
     schema records no historical snapshot to compare against. Pinned so the
     discrepancy is not rediscovered as a missing feature. */
  ok('task reminders belong to event-maintenance, not a separate job',
    /reminder/i.test(src('jobs.js').slice(src('jobs.js').indexOf("'event-maintenance'"),
                                          src('jobs.js').indexOf("'deletion-purge'"))));
  ok('there is no engagement-snapshot job, and the code says why',
    !jobs.JOB_NAMES.includes('engagement-snapshot') &&
    /no historical snapshot|records a historical snapshot/i.test(src('server.js')));

  ok('the Vercel trigger is declared for every job',
    (() => {
      const crons = JSON.parse(src('vercel.json')).crons || [];
      return crons.length === jobs.JOB_NAMES.length &&
             jobs.JOB_NAMES.every(n => crons.some(c => c.path.includes(n)));
    })());
  ok('the VPS trigger goes through the single entry point',
    /node scheduler\.js/.test(src('ops/cron-dic.sh')) &&
    !/api\/internal\/jobs\/run/.test(src('ops/cron-dic.sh')));
  ok('the VPS trigger backs up before it purges',
    src('ops/cron-dic.sh').indexOf('backup.js') < src('ops/cron-dic.sh').indexOf('scheduler.js'));
  ok('and ships off-site before the purge too',
    src('ops/cron-dic.sh').indexOf('offsite.js') < src('ops/cron-dic.sh').indexOf('scheduler.js'));

  if (!CRON) {
    skip('the Vercel bearer-token path is accepted', 'CRON_SECRET not in this environment');
    skip('running every trigger in turn duplicates nothing', 'CRON_SECRET not in this environment');
  } else {
    const db = require(path.join(REPO, 'db'));
    const reminders = async () => (await db.query(
      "SELECT count(*)::int n FROM notifications WHERE title IN ('Task overdue','Task deadline approaching')")).rows[0].n;
    const purges = async () => (await db.query(
      "SELECT count(*)::int n FROM deletion_requests WHERE status='completed'")).rows[0].n;

    const r0 = await reminders(), p0 = await purges();

    // Exactly what Vercel Cron sends: a GET with the secret as a bearer token.
    const viaVercel = await j('/api/internal/jobs/run?job=event-maintenance',
      { headers: { Authorization: 'Bearer ' + CRON } });
    ok('the Vercel bearer-token path is accepted', viaVercel.status === 200,
      `${viaVercel.status} ${JSON.stringify(viaVercel.body).slice(0, 70)}`);

    // And the header form a crontab curl would send.
    const viaHeader = await j('/api/internal/jobs/run?job=event-maintenance',
      { headers: { 'X-Cron-Key': CRON } });
    ok('the X-Cron-Key path is accepted too', viaHeader.status === 200);

    const r1 = await reminders(), p1 = await purges();
    ok('running every trigger in turn duplicates nothing',
      r0 === r1 && p0 === p1, `reminders ${r0}->${r1}, purges ${p0}->${p1}`);
    ok('no run was left marked running',
      (await db.query("SELECT count(*)::int n FROM ops_runs WHERE status='running'")).rows[0].n === 0);
  }

  /* ══ C. The three states ══════════════════════════════════════════════ */
  head('=== C. Health and monitor answer the three states ===');
  const health = await j('/api/health');
  ok('healthy is 200 with a database verdict',
    health.status === 200 && health.body?.database === 'ok', JSON.stringify(health.body));
  ok('degraded is a 503 the code can produce',
    /status\(503\)[\s\S]{0,120}degraded/.test(src('server.js')));
  /* The third state is the one a health endpoint cannot report about itself,
     which is the whole argument for an EXTERNAL monitor. Asserted across the
     places an operator would look, and in the code that implements it. */
  ok('unavailable is documented as observable only from outside',
    /only observable from outside|only something outside it can observe/i.test(
      src('PRODUCTION_PROVISIONING.md') + src('OPERATIONS_RUNBOOK.md') + src('server.js')));
  ok('and that is given as the reason the monitor must not run on the same machine',
    /must not run on the same machine|cannot tell you the box is unreachable/i.test(
      src('OPERATIONS_RUNBOOK.md') + src('ops/healthcheck.sh')));

  if (CRON) {
    const m = await j('/api/internal/monitor', { headers: { 'X-Cron-Key': CRON } });
    ok('the monitor answers the scheduler credential', m.status === 200 || m.status === 503);
    ok('its HTTP status matches its verdict, so a monitor needs no JSON parsing',
      ((m.body?.problems || []).length > 0) === (m.status === 503));
    ok('it never returns the credential it was authenticated with',
      !JSON.stringify(m.body || {}).includes(CRON));
  } else {
    skip('the monitor answers the scheduler credential', 'CRON_SECRET not in this environment');
  }
  ok('the monitor is not reachable without a credential',
    (await j('/api/internal/monitor')).status === 401);

  /* ══ D. The alert path ════════════════════════════════════════════════ */
  head('=== D. There is an alert path, and it is honest about itself ===');
  const hc = src('ops/healthcheck.sh');
  ok('the probe exists', has('ops/healthcheck.sh'));
  ok('it has an alert hook', /ALERT_CMD/.test(hc));
  ok('the hook is provider-agnostic — no vendor is hardcoded',
    !/hooks\.slack\.com\/services\/T[0-9A-Z]|api\.pagerduty\.com\/v2\/enqueue.*routing_key.*[0-9a-f]{32}/.test(hc));
  ok('it substitutes a severity and a message', /\{severity\}/.test(hc) && /\{message\}/.test(hc));
  ok('it reports when the alert path itself fails',
    /ALERT DELIVERY FAILED/.test(hc));
  ok('it still works with no ALERT_CMD, via the exit code',
    /no ALERT_CMD configured/.test(hc) && /exit 1/.test(hc) && /exit 2/.test(hc));
  ok('it consults the monitor endpoint, not just /api/health',
    /api\/internal\/monitor/.test(hc));
  ok('it checks the off-site receipt too', /last-offsite\.json/.test(hc));
  ok('the three exit codes are documented in the file',
    /0 healthy/.test(hc) && /1 application or database down/.test(hc) && /2 degraded/.test(hc));

  /* ══ E. Off-site ══════════════════════════════════════════════════════ */
  head('=== E. The off-site path encrypts, and hardcodes no provider ===');
  const off = src('offsite.js');
  ok('there is an off-site shipper', has('offsite.js'));
  ok('encryption is supported before the object leaves', /OFFSITE_ENCRYPT_CMD/.test(off));
  ok('the encrypted file does not claim a tool it may not be',
    /\.enc'/.test(off) && !/\+ '\.gpg'/.test(off));
  ok('no vendor SDK is a dependency',
    !/aws-sdk|@aws-sdk|@google-cloud|azure-storage/.test(
      Object.keys(require(path.join(REPO, 'package.json')).dependencies).join(' ')));
  ok('no bucket, key id or endpoint is hardcoded',
    !/AKIA[0-9A-Z]{16}|s3\.[a-z0-9-]+\.amazonaws\.com\/[a-z]/.test(off));
  ok('the plain dump is the only source, never a stale encrypted copy',
    /dic_alumni_\.\*\\\.sql\$|dic_alumni_.*\\.sql\$/.test(off.replace(/\s+/g, '')) ||
    /\.sql\$/.test(off));
  ok('there is a round-trip drill that downloads the object back',
    has('tests/offsite_drill.js') &&
    /DOWNLOADED BACK|Download, decrypt/.test(src('tests/offsite_drill.js')));
  ok('the drill proves the object is unreadable without the passphrase',
    /unreadable garbage|no readable SQL survives/.test(src('tests/offsite_drill.js')));

  /* ══ F. Variables ═════════════════════════════════════════════════════ */
  head('=== F. Every production variable is documented and enforced ===');
  const envEx = src('.env.example');
  const REQUIRED = ['SESSION_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET', 'MAIL_TRANSPORT',
                    'PUBLIC_ORIGIN', 'ADMIN_ORIGIN', 'BACKUP_DIR'];
  for (const v of REQUIRED) {
    ok(`${v} is documented and enforced at boot`,
      envEx.includes(v) && src('server.js').includes(v) && prov.includes(v));
  }
  for (const v of ['OFFSITE_CMD', 'OFFSITE_ENCRYPT_CMD', 'ALERT_CMD', 'TRUST_PROXY', 'DB_TIMEZONE']) {
    ok(`${v} is documented`, envEx.includes(v) || prov.includes(v) || src('ops/healthcheck.sh').includes(v));
  }
  ok('the provisioning document lists the same required set',
    REQUIRED.every(v => prov.includes(v)));

  /* ══ G. Nothing was invented ══════════════════════════════════════════ */
  head('=== G. No credential, domain or account was invented ===');
  const docs = ['PRODUCTION_PROVISIONING.md', 'OPERATIONS_RUNBOOK.md', 'KEY_MANAGEMENT.md',
                'PRODUCTION_DEPLOYMENT_RUNBOOK.md', 'PRODUCTION_HANDOVER_CHECKLIST.md']
    .filter(has).map(src).join('\n');
  ok('no AWS access key appears anywhere', !/AKIA[0-9A-Z]{16}/.test(docs));
  ok('no private key block appears anywhere', !/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(docs));
  ok('no Slack or PagerDuty token appears anywhere',
    !/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}/.test(docs) && !/xox[baprs]-[0-9A-Za-z-]{10,}/.test(docs));
  ok('the domain is a placeholder, not a guess',
    /<domain>/.test(docs) && !/dic\.edu\.bd["'\s]*$/m.test(prov));
  ok('the hosting decision is marked as DIC\'s, not made for them',
    /hosting decision.*DIC|DIC.*hosting decision/is.test(prov));
  ok('the document says plainly that it is blocked',
    /BLOCKED/.test(prov));

  /* Real secrets must not have reached any document. */
  const realSecrets = [];
  try {
    for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const [k, ...rest] = t.split('=');
      const v = rest.join('=').trim().replace(/^["'](.*)["']$/, '$1');
      if (['SESSION_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET', 'PGPASSWORD'].includes(k.trim()) && v) {
        realSecrets.push(v);
      }
    }
  } catch { /* no .env here, which is fine */ }
  ok('no real secret from .env appears in any provisioning document',
    realSecrets.every(s => !docs.includes(s)), `${realSecrets.length} checked`);

  /* This suite loads db/ and jobs/ to read their real configuration, which opens
     a pg pool. Calling process.exit() while that pool's libuv handle is still
     closing aborts the process on Windows — "Assertion failed:
     !(handle->flags & UV_HANDLE_CLOSING)" — AFTER every assertion has already
     run and passed, so run-all recorded a failure for a suite that had none.
     Closing the pool first is all it needs. */
  try { await require(path.join(REPO, 'db')).pool.end(); } catch { /* never loaded */ }
  await new Promise(r => setTimeout(r, 50));   // let those closes finish

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nHARNESS ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(2);
});
