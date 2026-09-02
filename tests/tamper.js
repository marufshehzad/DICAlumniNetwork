/* PHASE 5A — AUDIT TAMPER TESTS  (§5 and §9)

   Every test runs against a DISPOSABLE database restored from a real backup.
   Production is never modified: the only statements issued against the live
   database are reads.

   The sequence per test: restore a clean copy, confirm the verifier PASSES,
   apply one specific tampering, confirm it FAILS for the right reason and
   names the right row. A test that fails to detect its own tampering is a
   failure of the verifier, which is the whole point of running these. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');

const CONTAINER = process.env.DOCKER_PG_CONTAINER || 'dic-alumni-pg';
const BDIR = path.join(REPO, 'backups');
require(REPO + '/db');   // loads .env exactly as the application does
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD || '';

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const envArgs = PGPASSWORD ? ['-e', 'PGPASSWORD=' + PGPASSWORD] : [];

function psql(sql, dbName) {
  return spawnSync('docker', ['exec', ...envArgs, CONTAINER, 'psql',
    '-v', 'ON_ERROR_STOP=1', '-U', PGUSER, '-d', dbName, '-tAc', sql],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}
function psqlFile(file, dbName) {
  return spawnSync('docker', ['exec', '-i', ...envArgs, CONTAINER, 'psql',
    '-v', 'ON_ERROR_STOP=1', '-U', PGUSER, '-d', dbName],
    { input: fs.readFileSync(file), maxBuffer: 1024 * 1024 * 512 });
}

// Runs the standalone verifier against a named database, exactly as an
// operator would. Its exit code is the verdict.
function verify(dbName) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'verify_audit.js'), '--json', '--database', dbName],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, PGDATABASE: dbName }, timeout: 120000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* non-JSON means it could not run */ }
  return { code: r.status, out: parsed, raw: String(r.stdout || '') + String(r.stderr || '') };
}

const DB = 'dic_tamper_' + Date.now().toString(36);
let backupFile = null;

function freshCopy() {
  psql(`DROP DATABASE IF EXISTS ${DB}`, 'postgres');
  const c = psql(`CREATE DATABASE ${DB}`, 'postgres');
  if (c.status !== 0) throw new Error('could not create the disposable database: ' + c.stderr);
  psqlFile(backupFile, DB);   // --clean dumps report noise on an empty DB; the verify below is the check
}

(async () => {
  console.log('\n=== 0. take a backup that contains the live chain ===');
  try {
    execFileSync(process.execPath, [path.join(REPO, 'backup.js')],
      { cwd: REPO, env: { ...process.env, DOCKER_PG_CONTAINER: CONTAINER }, stdio: 'pipe', timeout: 300000 });
  } catch (e) { console.error('backup failed: ' + e.message); process.exit(2); }
  backupFile = fs.readdirSync(BDIR).filter(f => f.endsWith('.sql')).sort().slice(-1)[0];
  backupFile = path.join(BDIR, backupFile);
  ok('a backup containing the chain exists', fs.existsSync(backupFile), backupFile);

  console.log('\n=== J. a restored backup verifies (§9 steps 1-6) ===');
  freshCopy();
  const baseline = verify(DB);
  ok('the restored chain passes', baseline.code === 0 && baseline.out?.status === 'pass',
    JSON.stringify(baseline.out || baseline.raw).slice(0, 160));
  const chainLen = baseline.out?.verified || 0;
  ok('it verified a non-empty chain', chainLen >= 5, String(chainLen));
  ok('legacy entries are reported separately, not as verified',
    (baseline.out?.legacy || 0) > 0, String(baseline.out?.legacy));

  // The row the tamper tests operate on: the middle of the verifiable chain,
  // so both linkage directions are exercised.
  const targetId = parseInt(psql(
    `SELECT id FROM audit_logs WHERE chain_version=2 ORDER BY id OFFSET 2 LIMIT 1`, DB).stdout.trim(), 10);
  ok('a target row inside the chain was located', Number.isInteger(targetId), String(targetId));

  const cases = [
    ['A. an action is changed',
     `UPDATE audit_logs SET action='Tampered Action' WHERE id=${targetId}`, 'entry-hash-mismatch', targetId],
    /* Re-attributing an action to a DIFFERENT REAL user, which is the
       realistic forgery. A non-existent id is rejected by the foreign key
       before the verifier is even reached — the database refuses it outright. */
    ['B. an actor reference is changed to another real user',
     `UPDATE audit_logs SET actor_id=(SELECT id FROM users WHERE id <> COALESCE((SELECT actor_id FROM audit_logs WHERE id=${targetId}), -1) ORDER BY id LIMIT 1) WHERE id=${targetId}`,
     'actor-mismatch', targetId],
    /* COALESCE because the target row's actor may be NULL, and NULL + 1 is NULL
       — a tamper test that changes nothing proves nothing. actor_id is nulled at
       the same time so the actor-mismatch rule stays quiet and this case tests
       exactly one thing: that the HASHED actor reference is protected. */
    ['B2. the hashed actor reference is changed',
     `UPDATE audit_logs SET actor_ref = COALESCE(actor_ref, 0) + 1, actor_id = NULL WHERE id=${targetId}`,
     'entry-hash-mismatch', targetId],
    ['C. a target resource is changed',
     `UPDATE audit_logs SET target_type='forged', target_id=4242 WHERE id=${targetId}`, 'entry-hash-mismatch', targetId],
    ['D. a timestamp is changed',
     `UPDATE audit_logs SET created_at = created_at + INTERVAL '1 second' WHERE id=${targetId}`, 'entry-hash-mismatch', targetId],
    ['E. metadata is changed',
     `UPDATE audit_logs SET meta='rewritten after the fact' WHERE id=${targetId}`, 'entry-hash-mismatch', targetId],
    ['F. a prev_hash is changed',
     `UPDATE audit_logs SET prev_hash=repeat('0',64) WHERE id=${targetId}`, 'prev-hash-mismatch', targetId],
    ['G. an entry_hash is changed',
     `UPDATE audit_logs SET entry_hash=repeat('f',64) WHERE id=${targetId}`, 'entry-hash-mismatch', targetId],
    ['H. an entry is deleted',
     `DELETE FROM audit_logs WHERE id=${targetId}`, 'prev-hash-mismatch', null],
    ['I. an entry is inserted',
     `INSERT INTO audit_logs (icon, action, meta, actor_id, created_at, chain_version, prev_hash, entry_hash)
      VALUES ('x','Forged Entry','inserted by an attacker',1, NOW(), 2, repeat('a',64), repeat('b',64))`,
     'prev-hash-mismatch', null],
    ['K. the newest entries are truncated',
     `DELETE FROM audit_logs WHERE id = (SELECT MAX(id) FROM audit_logs WHERE chain_version=2)`,
     'head-mismatch', null],
    ['L. a legacy row is back-dated after the boundary',
     `UPDATE audit_logs SET chain_version=0 WHERE id=${targetId}`, null, null],
  ];

  for (const [label, sql, expectedReason, expectedId] of cases) {
    console.log(`\n=== ${label} ===`);
    freshCopy();

    const clean = verify(DB);
    if (clean.code !== 0) { ok('the copy started clean', false, JSON.stringify(clean.out).slice(0, 120)); continue; }

    const t = psql(sql, DB);
    if (t.status !== 0) { ok('the tampering could be applied', false, String(t.stderr).slice(0, 140)); continue; }

    const after = verify(DB);
    ok('the verifier detects it', after.code === 1 && after.out?.status === 'fail',
      `exit=${after.code} ${JSON.stringify(after.out?.status)}`);
    if (expectedReason) {
      const reasons = (after.out?.problems || []).map(p => p.reason);
      ok(`it is reported as ${expectedReason}`, reasons.includes(expectedReason), reasons.join(','));
    }
    if (expectedId !== null && expectedId !== undefined) {
      ok('it names the tampered row',
        after.out?.firstInvalid?.id === expectedId,
        `first invalid was ${after.out?.firstInvalid?.id}, expected ${expectedId}`);
    }
    ok('it exits non-zero', after.code === 1, String(after.code));
  }

  console.log('\n=== §9 steps 7-9: tamper the RESTORED copy, verifier fails ===');
  freshCopy();
  ok('restored copy passes before tampering', verify(DB).code === 0);
  psql(`UPDATE audit_logs SET meta='changed in the restored copy'
         WHERE id=(SELECT MIN(id) FROM audit_logs WHERE chain_version=2)`, DB);
  const t2 = verify(DB);
  ok('restored copy fails after tampering', t2.code === 1 && t2.out?.status === 'fail');
  ok('and it names the first invalid entry', !!t2.out?.firstInvalid?.id, JSON.stringify(t2.out?.firstInvalid));

  console.log('\n=== production was never touched ===');
  const live = verify(process.env.PGDATABASE || 'dic_alumni_db');
  ok('the live chain still verifies', live.code === 0 && live.out?.status === 'pass',
    JSON.stringify(live.out).slice(0, 140));

  console.log('\n=== cleanup ===');
  const d = psql(`DROP DATABASE IF EXISTS ${DB}`, 'postgres');
  ok('the disposable database is dropped', d.status === 0);

  console.log('\n' + '='.repeat(54));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
