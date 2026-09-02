#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — AUDIT CHAIN VERIFIER

   Reads audit rows straight from the database, recomputes every hash, and
   reports whether the chain holds. It needs nothing from the running
   application: no HTTP, no session, no admin UI. An operator — or an auditor
   who does not trust the application — can run it against a restored backup
   and reach their own conclusion.

     node verify_audit.js                verify the configured database
     node verify_audit.js --database X   verify a different database (a restore)
     node verify_audit.js --quiet        exit status only, for cron
     node verify_audit.js --json         machine-readable

   Exit status: 0 the chain holds · 1 the chain is broken · 2 it could not run.

   It never writes. It is safe to run against production at any time.

   What it can and cannot show is set out in AUDIT_CHAIN.md section 3. In short:
   entries written before the Phase 5A boundary are reported as legacy and are
   NOT verifiable, because the original digest input was never persisted. This
   tool will not pretend otherwise.
   ============================================================ */

const auditChain = require('./audit_chain');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const QUIET = flag('--quiet');
const JSON_OUT = flag('--json');
const DB_OVERRIDE = value('--database');

if (DB_OVERRIDE) {
  /* db.js prefers DATABASE_URL over the discrete PG* variables, so setting
     PGDATABASE alone would be silently ignored on a cloud deployment — the
     tool would report on the database named in the flag while actually reading
     production. Clearing the URL makes the flag mean what it says. */
  if (!/^[A-Za-z0-9_]+$/.test(DB_OVERRIDE)) {
    console.error('--database must be a plain database name');
    process.exit(2);
  }
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.PGDATABASE = DB_OVERRIDE;
}
const db = require('./db');

const say = (...a) => { if (!QUIET && !JSON_OUT) console.log(...a); };

(async () => {
  let result;
  try {
    result = await auditChain.verifyChain(db);
  } catch (e) {
    if (JSON_OUT) console.log(JSON.stringify({ status: 'error', error: e.message }));
    else console.error('verifier could not run: ' + e.message);
    await db.pool.end().catch(() => {});
    process.exit(2);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      status: result.ok ? 'pass' : 'fail',
      verified: result.verifiedCount,
      legacy: result.legacyCount,
      historical: result.historical,
      firstInvalid: result.firstInvalid,
      problems: result.problems
    }, null, 2));
    await db.pool.end().catch(() => {});
    process.exit(result.ok ? 0 : 1);
  }

  say('');
  say('  DIC Alumni Platform — audit chain verification');
  say('  database: ' + (process.env.PGDATABASE || process.env.DATABASE_URL ? 'configured' : 'default'));
  say('  ' + '─'.repeat(62));

  /* Reported first and separately, because conflating a verified segment with
     an unverifiable one is exactly the false assurance this release exists to
     remove. Each superseded scheme is listed with the reason it cannot be
     checked, rather than lumped together as "old". */
  for (const seg of (result.historical || [])) {
    say('');
    say(`  HISTORICAL SEGMENT — chain version ${seg.version}: ${seg.count} entries, up to id ${seg.lastId}`);
    say('    NOT cryptographically verifiable.');
    // Wrapped by hand so the reason reads as prose in a terminal.
    const words = seg.reason.split(' ');
    let line = '   ';
    for (const w of words) {
      if ((line + ' ' + w).length > 72) { say(line); line = '   '; }
      line += ' ' + w;
    }
    if (line.trim()) say(line);
    say('    Preserved unaltered as historical evidence.');
  }
  if ((result.historical || []).length) say('    See AUDIT_CHAIN.md sections 1 and 2.');

  say('');
  if (result.verifiedCount === 0) {
    say('  VERIFIABLE SEGMENT — empty');
    say('    No entries have been written since the boundary yet. Nothing to verify.');
  } else if (result.ok) {
    say(`  PASS — chain verified through ${result.verifiedCount} entries`);
    say('');
    say('    Every entry hashes to its stored entry_hash, every prev_hash matches');
    say('    the preceding entry, and the chain reaches the recorded head. Any');
    say('    change to an action, actor, target, address, metadata or timestamp');
    say('    would have broken it here.');
  } else {
    say(`  FAIL — the chain is broken`);
    say('');
    const f = result.firstInvalid;
    say(`    first invalid entry: ${f.id === null ? '(chain-level)' : 'id ' + f.id}`);
    say(`    reason: ${f.reason}`);
    say(`    ${f.detail}`);
    if (result.problems.length > 1) {
      say('');
      say(`    ${result.problems.length} problem(s) in total:`);
      for (const p of result.problems.slice(0, 12)) {
        say(`      ${(p.id === null ? 'chain' : 'id ' + p.id).padEnd(10)} ${p.reason}`);
      }
      if (result.problems.length > 12) say(`      … and ${result.problems.length - 12} more`);
    }
    say('');
    say('    A broken chain means an audit entry was altered, removed or inserted');
    say('    since it was written. Treat it as a security incident: see');
    say('    OPERATIONS_RUNBOOK.md section O for escalation.');
  }

  say('  ' + '─'.repeat(62));
  say('');

  await db.pool.end().catch(() => {});
  process.exit(result.ok ? 0 : 1);
})();
