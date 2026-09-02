#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — DATABASE BACKUP

   A nightly logical backup with pg_dump. Small on purpose: a backup script
   that needs its own maintenance is a backup script that stops running.

     node backup.js                 take a backup
     node backup.js --verify        take one, then prove it restores (below)
     node backup.js --list          show what is on disk and how old it is
     node backup.js --prune         apply the retention policy and stop

   Where pg_dump comes from:
     PG_DUMP=/path/to/pg_dump       explicit, wins over everything
     DOCKER_PG_CONTAINER=name       run it inside a container (development —
                                    the client tools are often not on the host)
     otherwise                      pg_dump from PATH

   Output: BACKUP_DIR (default ./backups), which .gitignore excludes and the
   web root's allow-list will not serve. Read §5 and §19 of OPERATIONS_RUNBOOK.md
   before pointing this anywhere shared.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10);
const CONTAINER = process.env.DOCKER_PG_CONTAINER || '';

// Loaded the same way the app loads it, so one .env drives both.
require('./db');

const PG = {
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || '5432',
  database: process.env.PGDATABASE || 'dic_alumni_db',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  url: process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (...a) => console.log(...a);

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // Best effort on Windows, which ignores the mode; documented in the runbook.
  try { fs.chmodSync(DIR, 0o700); } catch { /* not POSIX */ }
}

/* pg_dump writes to stdout and we capture it, rather than passing -f, because
   inside a container -f would write the file into the container's filesystem
   where nothing on the host can retain it. */
function dumpArgs() {
  const common = ['--no-owner', '--no-privileges', '--clean', '--if-exists'];
  if (PG.url) return { cmd: 'pg_dump', args: [...common, PG.url], env: {} };
  return {
    cmd: 'pg_dump',
    args: [...common, '-h', PG.host, '-p', String(PG.port), '-U', PG.user, '-d', PG.database],
    env: PG.password ? { PGPASSWORD: PG.password } : {}
  };
}

function runDump() {
  const { cmd, args, env } = dumpArgs();

  if (process.env.PG_DUMP) {
    return spawnSync(process.env.PG_DUMP, args,
      { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 * 512 });
  }
  if (CONTAINER) {
    /* Inside the container the server is local, so the host/port the app uses
       (often a mapped port like 5433) is wrong there. */
    const inner = PG.url
      ? ['--no-owner', '--no-privileges', '--clean', '--if-exists', PG.url]
      : ['--no-owner', '--no-privileges', '--clean', '--if-exists',
         '-h', 'localhost', '-p', '5432', '-U', PG.user, '-d', PG.database];
    const envArgs = PG.password ? ['-e', 'PGPASSWORD=' + PG.password] : [];
    return spawnSync('docker', ['exec', ...envArgs, CONTAINER, 'pg_dump', ...inner],
      { maxBuffer: 1024 * 1024 * 512 });
  }
  return spawnSync(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 * 512 });
}

function writeReceipt(state) {
  // Read by GET /api/ops/status so the admin portal can say when the last
  // backup ran, and by the monitor so a silent failure is still visible.
  fs.writeFileSync(path.join(DIR, 'last-backup.json'), JSON.stringify(state, null, 2));
}

function backup() {
  ensureDir();
  const started = new Date();
  const file = path.join(DIR, `dic_alumni_${stamp()}.sql`);
  log(`[backup] dumping ${PG.database} -> ${path.basename(file)}`);

  const r = runDump();
  if (r.error || r.status !== 0) {
    const why = (r.error && r.error.message) ||
                String(r.stderr || '').trim().split('\n').slice(-3).join(' ') ||
                `pg_dump exited ${r.status}`;
    writeReceipt({ status: 'failed', startedAt: started.toISOString(),
                   finishedAt: new Date().toISOString(), error: why.slice(0, 300) });
    console.error('[backup] FAILED: ' + why);
    console.error('[backup] a failed backup is an incident — see OPERATIONS_RUNBOOK.md §5');
    process.exitCode = 1;
    return null;
  }

  fs.writeFileSync(file, r.stdout);
  try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
  const size = fs.statSync(file).size;

  /* A pg_dump that "succeeds" with a truncated file is the failure mode that
     ruins restores, so the output is sanity-checked before it is trusted. */
  const head = r.stdout.slice(0, 4096).toString();
  const tail = r.stdout.slice(-2048).toString();
  const looksComplete = head.includes('PostgreSQL database dump') &&
                        tail.includes('PostgreSQL database dump complete');
  if (!looksComplete || size < 1024) {
    writeReceipt({ status: 'failed', startedAt: started.toISOString(),
                   finishedAt: new Date().toISOString(), sizeBytes: size,
                   error: 'dump did not end with the expected completion marker' });
    console.error('[backup] FAILED: the dump is incomplete — refusing to record it as good');
    process.exitCode = 1;
    return null;
  }

  writeReceipt({ status: 'ok', startedAt: started.toISOString(),
                 finishedAt: new Date().toISOString(), sizeBytes: size,
                 file: path.basename(file) });
  log(`[backup] ok — ${(size / 1024).toFixed(0)} KB`);
  return file;
}

function list() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  if (!files.length) { log('[backup] no backups on disk'); return []; }
  for (const f of files) {
    const st = fs.statSync(path.join(DIR, f));
    const ageH = ((Date.now() - st.mtimeMs) / 3600000).toFixed(1);
    log(`  ${f}  ${(st.size / 1024).toFixed(0)} KB  ${ageH}h old`);
  }
  return files;
}

/* Retention: keep RETENTION_DAYS of dailies. Deliberately never deletes the
   newest file, whatever its age — a stale backup is still better than none,
   and a clock skew must not be able to empty the directory. */
function prune() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql'))
    .map(f => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let removed = 0;
  files.slice(1).forEach(({ f, t }) => {
    if (t < cutoff) { fs.unlinkSync(path.join(DIR, f)); removed++; log('  pruned ' + f); }
  });
  log(`[backup] retention ${RETENTION_DAYS}d — ${removed} removed, ${files.length - removed} kept`);
  return removed;
}

if (require.main === module) {
  const arg = process.argv[2] || '';
  if (arg === '--list') list();
  else if (arg === '--prune') prune();
  else {
    const f = backup();
    if (f) prune();
    if (f && arg === '--verify') {
      log('\n[backup] verifying by restore…');
      const rr = spawnSync(process.execPath, [path.join(__dirname, 'restore.js'), '--drill', '--file', f],
        { stdio: 'inherit' });
      process.exitCode = rr.status === 0 ? 0 : 1;
    }
  }
}

module.exports = { backup, list, prune, DIR };
