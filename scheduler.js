#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — SCHEDULED WORK, ONE ENTRY POINT

   Everything the platform must do on a timer rather than when somebody happens
   to open a page. There is one job registry (jobs.js) and one way in (this
   file, or the HTTP endpoint it mirrors), so a job cannot drift into two
   implementations.

   HOW IT IS TRIGGERED IS A DEPLOYMENT CHOICE, AND EXACTLY ONE IS ENABLED:

     Vercel      vercel.json's "crons" block calls
                 GET /api/internal/jobs/run?job=<name> with the CRON_SECRET as
                 a bearer token. Nothing else is needed and this file is unused.

     VPS         a crontab or systemd timer runs this file. It talks to the
                 database directly and needs no HTTP server, so a job still runs
                 when the web process is down — which is when the deletion purge
                 matters most.

   Running both would double every job. They are idempotent, so nothing breaks,
   but the run log becomes unreadable and the reason for a failure becomes
   ambiguous. OPERATIONS_RUNBOOK.md section F states which one this deployment
   uses; the `source` column in ops_runs shows which one actually fired.

   Usage:
     node scheduler.js                 run every job, in order
     node scheduler.js event-maintenance
     node scheduler.js deletion-purge
     node scheduler.js --list          show the registry and last run of each
     node scheduler.js --status        exit non-zero if anything needs attention

   Exit codes:  0 everything ran · 1 a job failed · 2 bad usage
   ============================================================ */

const db = require('./db');
const jobs = require('./jobs');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const STATUS = args.includes('--status');
const names = args.filter(a => !a.startsWith('--'));

/* The event sweep lives in routes_events.js so there is one copy of it, and
   that module is mounted onto an Express app. Loading server.js here would
   start an HTTP listener, which a cron job must not do — so the module is
   mounted onto a throwaway stub that records the routes and discards them.
   The exported sweep function is what we are after. */
function loadEventSweep() {
  try {
    const noop = () => {};
    const stub = { get: noop, post: noop, put: noop, patch: noop, delete: noop, use: noop };
    const guards = {
      requireAuth: noop, requireRole: () => noop,
      ADMIN_ROLES: [], MODERATOR_ROLES: [],
      writeAudit: async () => {}, serverError: noop
    };
    const mod = require('./routes_events')(stub, guards);
    return mod && mod.runReminderSweep;
  } catch (e) {
    console.error('[scheduler] event sweep unavailable: ' + e.message);
    return null;
  }
}

/* The audit writer, without the HTTP layer. A scheduled action is still an
   action somebody may need to account for later — an account erased by the
   purge is written into the same hash chain as one erased by an administrator,
   with no actor, because no human did it. */
function loadAuditWriter() {
  try {
    const auditChain = require('./audit_chain');
    return async (action, meta, icon, ctx = {}) => {
      try {
        await auditChain.appendEntry(db, {
          action, meta, icon,
          actorId: ctx.actorId ?? null,
          targetType: ctx.targetType ?? null,
          targetId: ctx.targetId ?? null,
          ip: 'scheduler'
        });
      } catch (e) {
        console.error('[scheduler] audit write failed: ' + e.message);
      }
    };
  } catch {
    return null;
  }
}

async function showList() {
  const runs = await db.query(`
    SELECT DISTINCT ON (job) job, status, started_at, finished_at, items, source, detail
      FROM ops_runs ORDER BY job, started_at DESC`);
  console.log('\n=== SCHEDULED JOBS ===\n');
  let attention = 0;
  for (const name of jobs.JOB_NAMES) {
    const r = runs.rows.find(x => x.job === name);
    if (!r) {
      console.log(`  ${name.padEnd(20)} never run`);
      attention++;
      continue;
    }
    const ageH = (Date.now() - new Date(r.started_at).getTime()) / 3600000;
    const flag = r.status === 'failed' ? 'FAILED' : r.status;
    if (r.status === 'failed' || ageH > 36) attention++;
    console.log(`  ${name.padEnd(20)} ${String(flag).padEnd(8)} ${ageH.toFixed(1)}h ago ` +
                `via ${String(r.source).padEnd(8)} ${r.items} item(s)`);
    if (r.detail) console.log(`  ${' '.repeat(20)} ${String(r.detail).slice(0, 90)}`);
  }

  /* Two triggers firing is not an error, and it is worth seeing. If the last
     runs came from different sources, both a Vercel cron and a crontab are
     probably installed, and OPERATIONS_RUNBOOK.md section F says only one
     should be. */
  const sources = [...new Set(runs.rows.map(r => r.source).filter(Boolean))];
  if (sources.length > 1) {
    console.log(`\n  Note: recent runs came from more than one source (${sources.join(', ')}).`);
    console.log('  Exactly one trigger should be enabled — see OPERATIONS_RUNBOOK.md section F.');
  }
  console.log('');
  return attention;
}

(async () => {
  if (STATUS || LIST) {
    const attention = await showList();
    await db.pool.end();
    process.exit(STATUS && attention ? 1 : 0);
  }

  const unknown = names.filter(n => !jobs.JOB_NAMES.includes(n));
  if (unknown.length) {
    console.error(`\n  Unknown job(s): ${unknown.join(', ')}`);
    console.error(`  Known jobs: ${jobs.JOB_NAMES.join(', ')}\n`);
    await db.pool.end();
    process.exit(2);
  }

  const deps = { runReminderSweep: loadEventSweep(), writeAudit: loadAuditWriter() };
  const started = Date.now();
  let failed = 0;

  const toRun = names.length ? names : jobs.JOB_NAMES;
  console.log(`[scheduler] running ${toRun.length} job(s) at ${new Date().toISOString()}`);

  for (const name of toRun) {
    try {
      const r = await jobs.runJob(name, deps, 'cron');
      console.log(`[scheduler] ${name}: ok — ${r.detail || 'nothing to do'}`);
    } catch (e) {
      failed++;
      console.error(`[scheduler] ${name}: FAILED — ${e.message}`);
      console.error('[scheduler] a failed job is an incident — see OPERATIONS_RUNBOOK.md section F');
    }
  }

  console.log(`[scheduler] finished in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
              `${failed} failure(s)`);
  await db.pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async e => {
  console.error('[scheduler] fatal: ' + e.message);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
