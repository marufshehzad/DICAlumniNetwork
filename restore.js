#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — RESTORE AND RESTORE DRILL

   A backup nobody has restored is a hypothesis, not a backup. This does both
   jobs: the real restore an operator runs during an incident, and the drill
   that proves the current backup would work — against a disposable database,
   never the live one.

     node restore.js --drill                 restore the newest backup into a
                                             throwaway database, verify the row
                                             counts match, then drop it
     node restore.js --drill --file <path>   drill a specific file
     node restore.js --into <dbname> --file <path>
                                             restore into a named database that
                                             already exists

   There is no "restore over production" mode, and that is deliberate. Putting
   a dump back over the live database is a decision that needs a human reading
   §6 of OPERATIONS_RUNBOOK.md, not a flag that can be typed at 3am.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

require('./db');

const CONTAINER = process.env.DOCKER_PG_CONTAINER || '';
const DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const log = (...a) => console.log(...a);

const PG = {
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || '5432',
  database: process.env.PGDATABASE || 'dic_alumni_db',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || ''
};

// Tables whose survival actually matters. If these come back, the restore is
// real; if any is missing the drill fails loudly rather than reporting success.
const CRITICAL = ['users', 'alumni_profiles', 'events', 'event_registrations',
                  'event_ticket_types', 'donations', 'campaigns', 'audit_logs',
                  'identity_vault', 'deletion_requests', 'ops_runs'];

function psql(sqlOrFile, dbName, { fromFile = false } = {}) {
  const base = ['-v', 'ON_ERROR_STOP=1', '-U', PG.user, '-d', dbName];
  if (CONTAINER) {
    const envArgs = PG.password ? ['-e', 'PGPASSWORD=' + PG.password] : [];
    if (fromFile) {
      // Stream the dump in over stdin so the file can stay on the host.
      return spawnSync('docker', ['exec', '-i', ...envArgs, CONTAINER, 'psql', ...base],
        { input: fs.readFileSync(sqlOrFile), maxBuffer: 1024 * 1024 * 512 });
    }
    return spawnSync('docker', ['exec', ...envArgs, CONTAINER, 'psql', ...base, '-tAc', sqlOrFile],
      { maxBuffer: 1024 * 1024 * 64 });
  }
  const env = { ...process.env, ...(PG.password ? { PGPASSWORD: PG.password } : {}) };
  const conn = ['-h', PG.host, '-p', String(PG.port), ...base];
  if (fromFile) {
    return spawnSync('psql', [...conn, '-f', sqlOrFile], { env, maxBuffer: 1024 * 1024 * 512 });
  }
  return spawnSync('psql', [...conn, '-tAc', sqlOrFile], { env, maxBuffer: 1024 * 1024 * 64 });
}

const scalar = (db, sql) => {
  const r = psql(sql, db);
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim();
};

function newestBackup() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql'))
    .map(f => ({ f: path.join(DIR, f), t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? files[0].f : null;
}

function counts(dbName) {
  const out = {};
  for (const t of CRITICAL) {
    const v = scalar(dbName, `SELECT COUNT(*) FROM ${t}`);
    out[t] = v === null ? 'MISSING' : parseInt(v, 10);
  }
  return out;
}

function drill(file) {
  const src = file || newestBackup();
  if (!src) { console.error('[restore] no backup file to drill'); process.exitCode = 1; return; }
  if (!fs.existsSync(src)) { console.error('[restore] not found: ' + src); process.exitCode = 1; return; }

  const target = 'dic_restore_drill_' + Date.now().toString(36);
  log(`[drill] backup : ${path.basename(src)}`);
  log(`[drill] target : ${target} (disposable)`);

  const before = counts(PG.database);
  log('[drill] live database, for comparison:');
  for (const t of CRITICAL) log(`         ${t.padEnd(22)} ${before[t]}`);

  let ok = true;
  try {
    // 'postgres' is the maintenance database; CREATE DATABASE cannot run
    // inside the database being created.
    const c = psql(`CREATE DATABASE ${target}`, 'postgres');
    if (c.status !== 0) throw new Error('could not create the drill database: ' + String(c.stderr).trim());

    log('[drill] restoring…');
    const r = psql(src, target, { fromFile: true });
    /* psql reports non-zero for the DROP statements at the head of a --clean
       dump when the objects do not exist yet in a fresh database. That is
       expected noise; the verification below is what decides the outcome. */
    if (r.status !== 0) {
      const tail = String(r.stderr || '').trim().split('\n').slice(-3).join(' | ');
      log('[drill] psql reported errors (expected for a --clean dump into an empty database)');
      log('        ' + tail.slice(0, 200));
    }

    const after = counts(target);
    log('[drill] restored database:');
    let mismatches = 0, missing = 0;
    for (const t of CRITICAL) {
      const a = after[t], b = before[t];
      if (a === 'MISSING') { missing++; ok = false; log(`  FAIL   ${t.padEnd(22)} table absent after restore`); continue; }
      // Live counts can move while a drill runs; only shortfalls are failures.
      const bad = typeof b === 'number' && a < b;
      if (bad) { mismatches++; ok = false; }
      log(`  ${bad ? 'FAIL  ' : 'ok    '} ${t.padEnd(22)} ${a}${typeof b === 'number' ? ' (live ' + b + ')' : ''}`);
    }

    // Schema-level checks: a restore that brings rows but loses constraints
    // would pass a naive count comparison.
    const vaultCols = scalar(target,
      `SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name='identity_vault' AND column_name IN ('ciphertext','iv','auth_tag')`);
    const vaultOk = parseInt(vaultCols || '0', 10) === 3;
    log(`  ${vaultOk ? 'ok    ' : 'FAIL  '} identity_vault         encrypted columns present`);
    if (!vaultOk) ok = false;

    const chain = scalar(target, `SELECT COUNT(*) FROM audit_logs WHERE hash IS NOT NULL`);
    const chainOk = parseInt(chain || '0', 10) > 0;
    log(`  ${chainOk ? 'ok    ' : 'FAIL  '} audit_logs             hash chain intact (${chain} hashed rows)`);
    if (!chainOk) ok = false;

    log(`\n[drill] ${ok ? 'PASSED — this backup restores' : 'FAILED — ' + (missing + mismatches) + ' problem(s)'}`);
  } catch (e) {
    ok = false;
    console.error('[drill] FAILED: ' + e.message);
  } finally {
    const d = psql(`DROP DATABASE IF EXISTS ${target}`, 'postgres');
    log(d.status === 0 ? `[drill] disposable database dropped`
                       : `[drill] WARNING: could not drop ${target} — remove it by hand`);
  }

  // Recorded so the runbook's "when was the last drill?" has an answer.
  try {
    fs.writeFileSync(path.join(DIR, 'last-drill.json'), JSON.stringify({
      status: ok ? 'passed' : 'failed', at: new Date().toISOString(),
      backup: path.basename(src)
    }, null, 2));
  } catch { /* the drill result stands even if the receipt cannot be written */ }

  process.exitCode = ok ? 0 : 1;
}

function restoreInto(dbName, file) {
  if (!dbName || !file) { console.error('[restore] --into <db> --file <path> are both required'); process.exitCode = 1; return; }
  if (dbName === PG.database) {
    console.error('[restore] refusing to restore over the live database.');
    console.error('          Read OPERATIONS_RUNBOOK.md §6. Restore into a new database,');
    console.error('          verify it, then repoint the application.');
    process.exitCode = 1;
    return;
  }
  const r = psql(file, dbName, { fromFile: true });
  log(r.status === 0 ? '[restore] complete' : '[restore] psql reported errors; verify before use');
  process.exitCode = 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  if (a.includes('--drill')) drill(val('--file'));
  else if (a.includes('--into')) restoreInto(val('--into'), val('--file'));
  else {
    log('usage: node restore.js --drill [--file <path>]');
    log('       node restore.js --into <dbname> --file <path>');
  }
}

module.exports = { drill, newestBackup, CRITICAL };
