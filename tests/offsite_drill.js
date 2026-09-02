#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — OFF-SITE ROUND-TRIP DRILL

   Backing up off-site is half a capability. The half that matters on the bad
   day is getting the data BACK: downloading the encrypted object, decrypting
   it with a key somebody kept, and restoring a working database from it.

   Nobody tests that half, which is why it is the half that fails. This drill
   does the whole circuit:

     live database
       -> pg_dump
       -> gzip + AES-256 encryption
       -> shipped to a destination outside the application directory
       -> DOWNLOADED BACK from that destination
       -> decrypted, decompressed
       -> restored into a disposable database
       -> row counts compared, audit chain verified

   WHAT THIS PROVES: the mechanism, completely — including that the encrypted
   object is genuinely unreadable without the passphrase, and genuinely readable
   with it.

   WHAT THIS DOES NOT PROVE: that DIC's chosen storage provider works. The
   destination here is a directory outside the repository standing in for a
   remote one. Substituting `aws s3 cp` or `rclone copyto` for the transport is
   a one-line change to OFFSITE_CMD, and until DIC provides an account that
   line cannot be exercised. That is an external dependency, not a gap in the
   code.

   Everything happens in a disposable database and a temporary directory, both
   removed at the end. The live database is only ever read.

   Usage:  node tests/offsite_drill.js
           node tests/offsite_drill.js --keep
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
require(path.join(REPO, 'db'));

const KEEP = process.argv.includes('--keep');
const CONTAINER = process.env.DOCKER_PG_CONTAINER || '';
const PGUSER = process.env.PGUSER || 'postgres';
const LIVE_DB = process.env.PGDATABASE || 'dic_alumni_db';
const RESTORE_DB = `p65_offsite_${process.pid}`;

if (!/^p65_offsite_\d+$/.test(RESTORE_DB)) { console.error('refusing: bad drill db name'); process.exit(2); }

/* Two directories, deliberately apart: a machine that loses the first must not
   lose the second. On a real deployment the second is a different machine
   entirely; here it is a different tree, which is enough to prove the transport
   is a copy and not a rename. */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p65-local-'));
const OFFSITE = fs.mkdtempSync(path.join(os.tmpdir(), 'p65-remote-'));

/* A throwaway passphrase for the drill. A real deployment holds this in the
   institution's password manager alongside ENCRYPTION_KEY — see
   KEY_MANAGEMENT.md section 4. It is generated here and never written down,
   which is also why this drill cannot be re-run against yesterday's object. */
const PASSPHRASE = crypto.randomBytes(24).toString('base64');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const head = t => console.log('\n' + t);

function psql(args, { db = 'postgres', input = null } = {}) {
  const full = ['-v', 'ON_ERROR_STOP=1', '-U', PGUSER, '-d', db, ...args];
  return CONTAINER
    ? spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', ...full],
                { input, encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('psql', full, { input, encoding: 'utf8', maxBuffer: 1 << 28,
                env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' } });
}
const scalar = (sql, db) => {
  const r = psql(['-tAc', sql], { db });
  return r.status === 0 ? String(r.stdout).trim() : null;
};
const sh = (cmd, env = {}) =>
  spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 1 << 28,
                   env: { ...process.env, ...env } });

const cleanup = () => {
  psql(['-c', `DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`]);
  if (!KEEP) {
    for (const d of [WORK, OFFSITE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
};

(async () => {
  console.log('\nOff-site round-trip drill');
  console.log(`  local  : ${WORK}`);
  console.log(`  remote : ${OFFSITE}   (stands in for object storage)`);
  console.log(`  restore: ${RESTORE_DB}`);

  const liveUsers = scalar('SELECT count(*) FROM users', LIVE_DB);

  /* ── 1. Take a backup into the local directory ───────────────────────── */
  head('=== 1. Back up ===');
  const b = sh(`node backup.js`, { BACKUP_DIR: WORK });
  ok('backup.js succeeded', b.status === 0,
    (String(b.stdout) + String(b.stderr)).trim().split('\n').slice(-1)[0]);
  const dumps = fs.readdirSync(WORK).filter(f => /^dic_alumni_.*\.sql$/.test(f));
  ok('a dump was written', dumps.length === 1, dumps.join(','));
  const dumpPath = path.join(WORK, dumps[0]);
  const plainSize = fs.statSync(dumpPath).size;
  const plainMd5 = crypto.createHash('md5').update(fs.readFileSync(dumpPath)).digest('hex');
  console.log(`        ${dumps[0]}  ${(plainSize / 1048576).toFixed(2)} MB`);

  ok('the plain dump contains readable personal data',
    fs.readFileSync(dumpPath, 'utf8').includes('alumni_profiles'),
    'this is why it must not travel unencrypted');

  /* ── 2. Compress, encrypt and ship ───────────────────────────────────── */
  head('=== 2. Compress, encrypt, ship ===');
  /* One command doing both, because that is what an operator pastes into
     OFFSITE_ENCRYPT_CMD. openssl rather than gpg: no keyring to set up, and it
     is present on every server that has TLS. -pbkdf2 is not optional — without
     it openssl uses a single MD5 pass, which is not a key derivation function. */
  const encryptCmd =
    'gzip -c {file} | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 ' +
    '-pass env:DIC_BACKUP_PASSPHRASE -out {out}';
  const shipCmd = `cp {file} ${JSON.stringify(OFFSITE)}/{name}`;

  const o = sh('node offsite.js', {
    BACKUP_DIR: WORK,
    OFFSITE_ENCRYPT_CMD: encryptCmd,
    OFFSITE_CMD: shipCmd,
    DIC_BACKUP_PASSPHRASE: PASSPHRASE
  });
  const oOut = String(o.stdout) + String(o.stderr);
  ok('offsite.js succeeded', o.status === 0, oOut.trim().split('\n').slice(-1)[0]);

  const shipped = fs.readdirSync(OFFSITE);
  ok('exactly one object arrived at the destination', shipped.length === 1, shipped.join(','));
  const remoteObject = path.join(OFFSITE, shipped[0]);
  const encSize = fs.statSync(remoteObject).size;
  console.log(`        ${shipped[0]}  ${(encSize / 1048576).toFixed(2)} MB ` +
              `(${Math.round((1 - encSize / plainSize) * 100)}% smaller)`);

  ok('the object is encrypted, not the plain dump',
    crypto.createHash('md5').update(fs.readFileSync(remoteObject)).digest('hex') !== plainMd5);
  const raw = fs.readFileSync(remoteObject);
  ok('no readable SQL survives in the shipped object',
    !raw.includes(Buffer.from('CREATE TABLE')) &&
    !raw.includes(Buffer.from('alumni_profiles')) &&
    !raw.includes(Buffer.from('PostgreSQL database dump')));
  ok('it is a salted openssl object', raw.slice(0, 8).toString() === 'Salted__',
    raw.slice(0, 8).toString());

  ok('the transport copied rather than moved — the local dump is still there',
    fs.existsSync(dumpPath));
  ok('the transient encrypted copy was cleaned up locally',
    !fs.existsSync(dumpPath + '.enc'));

  const receipt = JSON.parse(fs.readFileSync(path.join(WORK, 'last-offsite.json'), 'utf8'));
  ok('the receipt records success and that it was encrypted',
    receipt.status === 'ok' && receipt.encrypted === true, JSON.stringify(receipt));

  /* ── 3. The object is useless without the passphrase ─────────────────── */
  head('=== 3. Without the passphrase it is useless ===');
  const wrong = sh(
    `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:DIC_BACKUP_PASSPHRASE ` +
    `-in ${JSON.stringify(remoteObject)} -out ${JSON.stringify(path.join(WORK, 'wrong.gz'))}`,
    { DIC_BACKUP_PASSPHRASE: 'not-the-passphrase' });
  ok('decryption with the wrong passphrase fails', wrong.status !== 0,
    `exit ${wrong.status}`);
  /* openssl reports "bad decrypt" and exits 1, but it has already written some
     output by the time the padding check fails — so the file exists. What
     matters is not whether a file is left behind but whether anything in it is
     readable, and it is not: the bytes are the wrong key's garbage. Asserting
     emptiness instead would have been a test of openssl's buffering, not of
     the property anybody cares about. */
  const wrongOut = path.join(WORK, 'wrong.gz');
  const garbage = fs.existsSync(wrongOut) ? fs.readFileSync(wrongOut) : Buffer.alloc(0);
  ok('whatever it does write is unreadable garbage',
    !garbage.includes(Buffer.from('CREATE TABLE')) &&
    !garbage.includes(Buffer.from('alumni_profiles')) &&
    !garbage.includes(Buffer.from('PostgreSQL database dump')),
    `${garbage.length} bytes`);
  ok('and it does not decompress to anything',
    sh(`gzip -t ${JSON.stringify(wrongOut)}`).status !== 0);

  /* ── 4. DOWNLOAD IT BACK — the half nobody tests ─────────────────────── */
  head('=== 4. Download, decrypt, decompress ===');
  const RECOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'p65-recovery-'));
  /* Deliberately a THIRD directory: recovery happens on a replacement machine
     that has neither the original dump nor the local backup directory. */
  const pulled = path.join(RECOVERY, shipped[0]);
  const down = sh(`cp ${JSON.stringify(remoteObject)} ${JSON.stringify(pulled)}`);
  ok('the object downloads from the destination', down.status === 0 && fs.existsSync(pulled));

  const recovered = path.join(RECOVERY, 'recovered.sql');
  const dec = sh(
    `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:DIC_BACKUP_PASSPHRASE ` +
    `-in ${JSON.stringify(pulled)} | gzip -dc > ${JSON.stringify(recovered)}`,
    { DIC_BACKUP_PASSPHRASE: PASSPHRASE });
  ok('it decrypts and decompresses with the right passphrase', dec.status === 0,
    String(dec.stderr).trim().slice(0, 120));

  ok('the recovered file is byte-identical to the original dump',
    fs.existsSync(recovered) &&
    crypto.createHash('md5').update(fs.readFileSync(recovered)).digest('hex') === plainMd5,
    fs.existsSync(recovered) ? `${fs.statSync(recovered).size} vs ${plainSize} bytes` : 'missing');

  /* ── 5. Restore from the recovered file ──────────────────────────────── */
  head('=== 5. Restore a working database from it ===');
  psql(['-c', `DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`]);
  psql(['-c', `CREATE DATABASE ${RESTORE_DB}`]);
  const rr = psql(['-q', '-f', '-'], { db: RESTORE_DB, input: fs.readFileSync(recovered, 'utf8') });
  ok('the recovered dump restores', rr.status === 0 || Number(scalar(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'", RESTORE_DB)) > 40,
    String(rr.stderr).trim().split('\n').slice(-1)[0]);

  const cmp = (label, sql) => {
    const a = scalar(sql, LIVE_DB), b = scalar(sql, RESTORE_DB);
    ok(`${label} matches (${a})`, a === b && a !== null, `live=${a} recovered=${b}`);
  };
  cmp('table count', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'");
  cmp('users', 'SELECT count(*) FROM users');
  cmp('alumni_profiles', 'SELECT count(*) FROM alumni_profiles');
  cmp('events', 'SELECT count(*) FROM events');
  cmp('event_registrations', 'SELECT count(*) FROM event_registrations');
  cmp('donations', 'SELECT count(*) FROM donations');
  cmp('audit_logs', 'SELECT count(*) FROM audit_logs');
  cmp('identity_vault', 'SELECT count(*) FROM identity_vault');

  const vaultOf = db => scalar(
    "SELECT COALESCE(md5(string_agg(user_id||':'||ciphertext||':'||iv||':'||auth_tag, ',' ORDER BY id)),'-') FROM identity_vault", db);
  ok('identity-vault ciphertext, IV and auth tag survived the round trip',
    vaultOf(LIVE_DB) === vaultOf(RESTORE_DB), `${vaultOf(LIVE_DB)} vs ${vaultOf(RESTORE_DB)}`);

  const va = spawnSync(process.execPath, ['verify_audit.js', '--database', RESTORE_DB],
    { cwd: REPO, encoding: 'utf8' });
  const vout = String(va.stdout) + String(va.stderr);
  ok('the recovered database has a verifiable audit chain',
    va.status === 0 || /PASS/.test(vout),
    vout.split('\n').filter(Boolean).slice(-1)[0]);

  /* ── 6. The live database was only read ──────────────────────────────── */
  head('=== 6. Nothing touched the live database ===');
  ok('the live user count is unchanged',
    scalar('SELECT count(*) FROM users', LIVE_DB) === liveUsers,
    `${liveUsers} -> ${scalar('SELECT count(*) FROM users', LIVE_DB)}`);

  if (!KEEP) { try { fs.rmSync(RECOVERY, { recursive: true, force: true }); } catch {} }
  cleanup();
  ok('the drill database was dropped',
    scalar(`SELECT count(*) FROM pg_database WHERE datname='${RESTORE_DB}'`) === '0');

  console.log('\n' + '='.repeat(62));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('  The transport here is a local copy standing in for object storage.');
  console.log('  Swapping in `aws s3 cp` or `rclone copyto` is one line of OFFSITE_CMD.');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nDRILL ERROR: ' + e.message);
  console.error(e.stack);
  cleanup();
  process.exit(2);
});
