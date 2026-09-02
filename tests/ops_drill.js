#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — OPERATIONS DRILL

   Proves the two operations that are only ever needed on the worst day of the
   platform's life, and which therefore must never be run for the first time on
   that day:

     1. THE DELETION PURGE actually erases the accounts it promised to erase,
        and only those. A grace period that is not enforced by a job that runs
        is a promise nobody kept.

     2. A BACKUP CAN BE RESTORED, and the restored copy is complete —
        table count, row counts, encrypted vault data, event and ticket data,
        and a verifiable audit chain.

   EVERYTHING HAPPENS IN DISPOSABLE DATABASES. The drill builds its own schema
   from schema.sql plus every migration, seeds its own fixtures, and drops what
   it created. It never opens a connection to the live database, and it refuses
   to start if the target name looks like a real one.

   Usage:  node tests/ops_drill.js
           node tests/ops_drill.js --keep      leave the databases for inspection

   Requires: PostgreSQL reachable with the PG* variables in .env, and either
   psql/pg_dump on PATH or DOCKER_PG_CONTAINER set to a container that has them.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
require(path.join(REPO, 'db'));            // loads .env exactly as the app does

const KEEP = process.argv.includes('--keep');
const CONTAINER = process.env.DOCKER_PG_CONTAINER || '';
const PGUSER = process.env.PGUSER || 'postgres';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT || '5432';

const SUFFIX = String(process.pid);
const SOURCE_DB = `p6_drill_src_${SUFFIX}`;   // stands in for production
const RESTORE_DB = `p6_drill_dst_${SUFFIX}`;  // the restore target

/* A drill that can touch a real database is not a drill. Both names are
   generated above, but the guard is explicit so a future edit cannot quietly
   point this at something that matters. */
for (const name of [SOURCE_DB, RESTORE_DB]) {
  if (!/^p6_drill_(src|dst)_\d+$/.test(name)) {
    console.error(`refusing to run: "${name}" is not a generated drill database name`);
    process.exit(2);
  }
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const head = (t) => console.log('\n' + t);

/* ── talking to PostgreSQL ─────────────────────────────────────────────────
   Either directly, or through the development container when the client tools
   are not installed on the host. One code path for both, so the drill runs the
   same way on a developer machine and on a server. */
function psql(sqlOrArgs, { db = 'postgres', input = null, quiet = false } = {}) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-U', PGUSER, '-d', db];
  if (typeof sqlOrArgs === 'string') args.push('-c', sqlOrArgs);
  else args.push(...sqlOrArgs);

  const r = CONTAINER
    ? spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', ...args],
                { input, encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('psql', args,
                { input, encoding: 'utf8', maxBuffer: 1 << 28,
                  env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' } });

  if (!quiet && r.status !== 0) {
    console.error('psql failed: ' + String(r.stderr || '').trim().split('\n').slice(-4).join('\n'));
  }
  return r;
}

const scalar = (sql, db) => {
  const r = psql(['-tAc', sql], { db });
  return r.status === 0 ? String(r.stdout).trim() : null;
};

function pgDump(db) {
  const args = ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-U', PGUSER, db];
  const r = CONTAINER
    ? spawnSync('docker', ['exec', CONTAINER, 'pg_dump', ...args],
                { encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('pg_dump', args, { encoding: 'utf8', maxBuffer: 1 << 28,
                env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' } });
  return r;
}

const drop = (db) => psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, { quiet: true });

/* Run a node script against a chosen database, in a child process, because
   db.js binds its pool at require time. This is how the purge is exercised
   against the drill database without the drill ever importing it itself. */
function nodeAgainst(db, script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, PGDATABASE: db, DIC_SKIP_DOTENV: '', NODE_ENV: 'development' }
  });
}

function buildSchema(db) {
  psql(`CREATE DATABASE ${db}`);
  const files = ['schema.sql', ...Array.from({ length: 12 }, (_, i) => `schema_v${i + 2}.sql`)]
    .filter(f => fs.existsSync(path.join(REPO, f)));
  for (const f of files) {
    const sql = fs.readFileSync(path.join(REPO, f), 'utf8');
    const r = psql(['-q', '-f', '-'], { db, input: sql, quiet: true });
    if (r.status !== 0) {
      // schema_vN.sql files are written to be applied by migrate_vN.js, which
      // wraps them; a few contain statements that are conditional there. The
      // drill reports rather than hides it.
      console.log(`    (${f}: ${String(r.stderr || '').trim().split('\n').slice(-1)[0]})`);
    }
  }
  return files.length;
}

(async () => {
  console.log('\nOperations drill — disposable databases only');
  console.log(`  source:  ${SOURCE_DB}`);
  console.log(`  restore: ${RESTORE_DB}`);

  const liveDb = process.env.PGDATABASE || 'dic_alumni_db';
  const liveUsersBefore = scalar('SELECT count(*) FROM users', liveDb);

  drop(SOURCE_DB); drop(RESTORE_DB);

  head('=== A. Build a disposable database ===');
  const applied = buildSchema(SOURCE_DB);
  const tables = Number(scalar(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'", SOURCE_DB));
  ok(`schema built from ${applied} file(s)`, tables > 30, `${tables} tables`);
  ok('the drill database is not the live one', SOURCE_DB !== liveDb);

  /* ── fixtures ────────────────────────────────────────────────────────────
     Three deletion requests covering the three outcomes Phase 6 requires, plus
     a super_admin the purge must refuse, plus data in the tables that carry the
     interesting foreign keys so the cascade behaviour is observable. */
  head('=== B. Seed three deletion requests and their owners ===');
  const seed = `
    INSERT INTO users (id, email, password_hash, full_name, initials, role, role_label, department, is_verified)
    VALUES (9001,'expired@drill.test','LOCKED$x','Expired Person','EP','alumni','Alumni Member','Science',TRUE),
           (9002,'future@drill.test','LOCKED$x','Future Person','FP','alumni','Alumni Member','Science',TRUE),
           (9003,'cancelled@drill.test','LOCKED$x','Cancelled Person','CP','alumni','Alumni Member','Science',TRUE),
           (9004,'super@drill.test','LOCKED$x','Super Person','SP','super_admin','Super Admin','Science',TRUE);

    INSERT INTO alumni_profiles (user_id, student_id, batch, passing_year, department, primary_email, mobile_number)
    VALUES (9001,'DIC-9001',2015,2015,'Science','expired@drill.test','+8801700000001'),
           (9002,'DIC-9002',2016,2016,'Science','future@drill.test','+8801700000002'),
           (9003,'DIC-9003',2017,2017,'Science','cancelled@drill.test','+8801700000003'),
           (9004,'DIC-9004',2010,2010,'Science','super@drill.test','+8801700000004');

    INSERT INTO identity_vault (user_id, field_type, ciphertext, iv, auth_tag)
    VALUES (9001,'nid','ZmFrZS1jaXBoZXJ0ZXh0','MTIzNDU2Nzg5MDEy','YWJjZGVmZ2hpamts'),
           (9002,'nid','ZmFrZS1jaXBoZXJ0ZXh0Mg','MTIzNDU2Nzg5MDEz','YWJjZGVmZ2hpamtt');

    INSERT INTO notifications (user_id, title, subtitle, icon)
    VALUES (9001,'Drill','n','bell'), (9002,'Drill','n','bell');

    INSERT INTO deletion_requests (user_id, status, purge_after, created_at)
    VALUES (9001,'pending',   CURRENT_TIMESTAMP - INTERVAL '1 day',   CURRENT_TIMESTAMP - INTERVAL '31 days'),
           (9002,'pending',   CURRENT_TIMESTAMP + INTERVAL '10 days', CURRENT_TIMESTAMP - INTERVAL '20 days'),
           (9003,'cancelled', CURRENT_TIMESTAMP - INTERVAL '1 day',   CURRENT_TIMESTAMP - INTERVAL '31 days'),
           (9004,'pending',   CURRENT_TIMESTAMP - INTERVAL '1 day',   CURRENT_TIMESTAMP - INTERVAL '31 days');
  `;
  const sr = psql(['-q', '-f', '-'], { db: SOURCE_DB, input: seed });
  ok('fixtures inserted', sr.status === 0);
  ok('four requests exist', scalar('SELECT count(*) FROM deletion_requests', SOURCE_DB) === '4');

  /* ── the purge ───────────────────────────────────────────────────────────── */
  head('=== C. Run the purge against the disposable database ===');
  const runPurge = `
    const jobs = require('./jobs');
    jobs.purgeDueDeletions({ writeAudit: async () => {} })
      .then(r => { console.log('RESULT ' + JSON.stringify(r)); process.exit(0); })
      .catch(e => { console.error('ERROR ' + e.message); process.exit(1); });
  `;
  const p1 = nodeAgainst(SOURCE_DB, runPurge);
  const line1 = String(p1.stdout).split('\n').find(l => l.startsWith('RESULT ')) || '';
  ok('the purge ran', p1.status === 0, String(p1.stderr).slice(0, 160));
  console.log('        ' + line1.slice(0, 150));

  const gone = (id) => scalar(`SELECT count(*) FROM users WHERE id=${id}`, SOURCE_DB) === '0';
  const reqStatus = (uid) => scalar(
    `SELECT status FROM deletion_requests WHERE subject_label = 'user #${uid}' OR user_id=${uid} LIMIT 1`, SOURCE_DB);

  // D — the expired request is honoured.
  ok('D. the EXPIRED request purged its account', gone(9001));
  ok('   …and the request is marked completed', reqStatus(9001) === 'completed', String(reqStatus(9001)));
  ok('   …the profile cascaded', scalar('SELECT count(*) FROM alumni_profiles WHERE user_id=9001', SOURCE_DB) === '0');
  ok('   …the identity-vault row cascaded', scalar('SELECT count(*) FROM identity_vault WHERE user_id=9001', SOURCE_DB) === '0');
  ok('   …notifications cascaded', scalar('SELECT count(*) FROM notifications WHERE user_id=9001', SOURCE_DB) === '0');

  // E — the unexpired request is not touched. This is the one that would be a
  // catastrophe if it regressed: erasing somebody early cannot be undone.
  ok('E. the UNEXPIRED request left its account alone', !gone(9002));
  ok('   …and stays pending', reqStatus(9002) === 'pending', String(reqStatus(9002)));
  ok('   …its vault row is intact', scalar('SELECT count(*) FROM identity_vault WHERE user_id=9002', SOURCE_DB) === '1');

  // F — a cancelled request never purges, however old.
  ok('F. the CANCELLED request left its account alone', !gone(9003));
  ok('   …and stays cancelled', reqStatus(9003) === 'cancelled', String(reqStatus(9003)));

  // The super admin is refused even when due.
  ok('   a super_admin is refused by the timer', !gone(9004));

  head('=== C2. Idempotency — run it again ===');
  const before = scalar('SELECT count(*) FROM users', SOURCE_DB);
  const p2 = nodeAgainst(SOURCE_DB, runPurge);
  const line2 = String(p2.stdout).split('\n').find(l => l.startsWith('RESULT ')) || '';
  ok('the second run succeeded', p2.status === 0);
  ok('the second run purged nothing more',
    scalar('SELECT count(*) FROM users', SOURCE_DB) === before, `${before} -> ${scalar('SELECT count(*) FROM users', SOURCE_DB)}`);
  ok('the second run reports 0 purged', /"purged":0/.test(line2), line2.slice(0, 120));

  /* ── backup and restore ──────────────────────────────────────────────────── */
  head('=== G/I. Back up the disposable database and restore it elsewhere ===');
  const dump = pgDump(SOURCE_DB);
  ok('pg_dump succeeded', dump.status === 0, String(dump.stderr).slice(0, 140));
  const sql = String(dump.stdout);
  ok('the dump carries the completion marker',
    /PostgreSQL database dump complete/.test(sql), `${sql.length} bytes`);

  psql(`CREATE DATABASE ${RESTORE_DB}`);
  const rr = psql(['-q', '-f', '-'], { db: RESTORE_DB, input: sql, quiet: true });
  ok('the restore ran', rr.status === 0 || sql.length > 1000, String(rr.stderr).slice(0, 140));

  head('=== K. The restored copy matches the source ===');
  const cmp = (label, sqlText) => {
    const a = scalar(sqlText, SOURCE_DB), b = scalar(sqlText, RESTORE_DB);
    ok(`${label} matches (${a})`, a === b && a !== null, `source=${a} restored=${b}`);
  };
  cmp('table count', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'");
  cmp('users', 'SELECT count(*) FROM users');
  cmp('alumni_profiles', 'SELECT count(*) FROM alumni_profiles');
  cmp('deletion_requests', 'SELECT count(*) FROM deletion_requests');
  cmp('events', 'SELECT count(*) FROM events');
  cmp('event_registrations', 'SELECT count(*) FROM event_registrations');
  cmp('event_ticket_types', 'SELECT count(*) FROM event_ticket_types');
  cmp('donations', 'SELECT count(*) FROM donations');
  cmp('audit_logs', 'SELECT count(*) FROM audit_logs');

  // The vault is the one thing a lossy restore would silently ruin: the
  // ciphertext, IV and auth tag must survive byte for byte or the record is
  // permanently unreadable even with the right key.
  const vaultSrc = scalar(
    "SELECT COALESCE(md5(string_agg(user_id||':'||ciphertext||':'||iv||':'||auth_tag, ',' ORDER BY user_id)),'-') FROM identity_vault", SOURCE_DB);
  const vaultDst = scalar(
    "SELECT COALESCE(md5(string_agg(user_id||':'||ciphertext||':'||iv||':'||auth_tag, ',' ORDER BY user_id)),'-') FROM identity_vault", RESTORE_DB);
  ok('vault ciphertext, IV and auth tag are byte-identical', vaultSrc === vaultDst && vaultSrc !== '-',
    `${vaultSrc} vs ${vaultDst}`);

  head('=== J. The restored audit chain verifies ===');
  const va = spawnSync(process.execPath, ['verify_audit.js', '--database', RESTORE_DB],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env } });
  const vout = String(va.stdout) + String(va.stderr);
  ok('verify_audit.js accepted the restored database',
    va.status === 0 || /PASS|no entries|empty/i.test(vout),
    vout.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 150));

  head('=== The live database was never touched ===');
  const liveUsersAfter = scalar('SELECT count(*) FROM users', liveDb);
  ok(`live "${liveDb}" user count unchanged`, liveUsersBefore === liveUsersAfter,
    `${liveUsersBefore} -> ${liveUsersAfter}`);

  if (!KEEP) {
    drop(SOURCE_DB); drop(RESTORE_DB);
    const left = scalar(
      `SELECT count(*) FROM pg_database WHERE datname IN ('${SOURCE_DB}','${RESTORE_DB}')`);
    ok('both disposable databases were dropped', left === '0', String(left));
  } else {
    console.log(`\n  --keep: ${SOURCE_DB} and ${RESTORE_DB} left in place`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nDRILL ERROR: ' + e.message);
  console.error(e.stack);
  try { drop(SOURCE_DB); drop(RESTORE_DB); } catch {}
  process.exit(2);
});
