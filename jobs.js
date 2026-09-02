/* ============================================================
   DIC ALUMNI PLATFORM — SCHEDULED JOBS

   Everything the platform must do on a timer rather than when somebody
   happens to open a page. Until this existed, event statuses rolled forward
   only if a staff member visited the Events tab that day, and the 30-day
   deletion purge — a promise made to every user who asks to be erased — had
   no executor at all.

   There is one job runner. How it is triggered is a deployment choice
   (Vercel Cron, system cron, or an operator running scheduler.js by hand);
   all of them arrive at runJob() below, so a job cannot drift into two
   implementations.

   Every job is idempotent. Running one twice on the same day must be
   indistinguishable from running it once, because retries happen: a cron
   fires late, a serverless invocation times out and is replayed, an operator
   re-runs a job they were not sure completed.
   ============================================================ */

const db = require('./db');

/* ─── RUN LOG ───────────────────────────────────────────────
   A scheduler nobody can inspect is a scheduler nobody trusts. Each run
   opens a row, and closes it with an outcome, so "did last night's purge
   run?" is answerable from the admin portal without shell access — and a
   monitor has something to alert on when a job stops reporting. */

/* How long a run may stay 'running' before it is presumed dead. A job that is
   killed mid-flight — a serverless invocation timing out, a VPS rebooting, an
   operator pressing Ctrl-C — never reaches closeRun, so its row stays 'running'
   for ever. A monitor then cannot tell a job that is working from one that died
   months ago, and the failure is invisible precisely when it matters.

   Reaped on the next run of the same job rather than by a separate sweeper, so
   there is nothing extra to schedule and nothing extra to fail. */
const RUN_STALE_MINUTES = parseInt(process.env.JOB_STALE_MINUTES || '30', 10);

async function reapStaleRuns(job) {
  const r = await db.query(
    `UPDATE ops_runs
        SET status='failed',
            finished_at=CURRENT_TIMESTAMP,
            detail=COALESCE(detail,'') ||
                   'abandoned: still marked running after ' || $2 || ' minutes, presumed killed mid-run'
      WHERE job=$1 AND status='running'
        AND started_at < CURRENT_TIMESTAMP - ($2 || ' minutes')::interval
      RETURNING id`, [job, RUN_STALE_MINUTES]);
  return r.rowCount;
}

async function openRun(job, source) {
  const reaped = await reapStaleRuns(job);
  if (reaped) console.warn(`[scheduler] ${job}: marked ${reaped} abandoned run(s) as failed`);
  const r = await db.query(
    `INSERT INTO ops_runs (job, status, source) VALUES ($1, 'running', $2) RETURNING id, started_at`,
    [job, source || 'cron']);
  return r.rows[0];
}

async function closeRun(id, status, detail, items, startedAt) {
  await db.query(
    `UPDATE ops_runs
        SET status=$2, detail=$3, items=$4,
            finished_at=CURRENT_TIMESTAMP,
            duration_ms=EXTRACT(MILLISECONDS FROM (CURRENT_TIMESTAMP - $5::timestamptz))::int
                        + EXTRACT(SECONDS FROM (CURRENT_TIMESTAMP - $5::timestamptz))::int * 1000
      WHERE id=$1`,
    [id, status, String(detail || '').slice(0, 500), items || 0, startedAt]);
}

/* ─── JOB: 30-DAY DELETION PURGE ────────────────────────────

   deletion_requests.purge_after has been written since schema v2 and read by
   nothing. The platform told people their account would be erased after a
   30-day grace period and then never erased it.

   What gets destroyed and what survives is decided by the foreign keys, and
   they were checked one by one before this was written:

     CASCADE  (destroyed with the user, which is what erasure means)
              alumni_profiles, identity_vault (the encrypted NID/BRC),
              consent_logs, notifications, connections, chapter_memberships,
              event_registrations, event_task_assignees, event_people,
              job_applications, job_referrals, jobs, mentorships, poll_votes,
              stories

     SET NULL (the record survives, detached from the person)
              audit_logs.actor_id, donations.donor_user_id, events.created_by,
              broadcasts.sender_id, and sixteen others

   Two things that survive need help, because a null foreign key does not
   erase a name stored alongside it:

     donations.donor_name is plain text. A financial record may have to be
     retained, but it must not keep naming the person. It is overwritten.

     audit_logs.meta is deliberately NOT touched. Entries are SHA-256
     hash-chained to each other, so rewriting one would invalidate every
     verification after it — the chain is the tamper-evidence, and destroying
     it to tidy a name would trade a large protection for a small one. The
     entries reference people by numeric id ('by user 41'), which is exactly
     why that convention is worth keeping.
*/
async function purgeDueDeletions({ writeAudit } = {}) {
  const due = await db.query(
    `SELECT id, user_id, purge_after FROM deletion_requests
      WHERE status = 'pending'
        AND user_id IS NOT NULL
        AND purge_after <= CURRENT_TIMESTAMP
      ORDER BY purge_after ASC`);

  let purged = 0;
  const notes = [];

  for (const req of due.rows) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      /* Re-read inside the transaction and lock. Between the scan above and
         this line the user may have cancelled, or a concurrent run may have
         taken this request. The predicate is repeated rather than trusted. */
      const live = await client.query(
        `SELECT id, user_id, purge_after FROM deletion_requests
          WHERE id=$1 AND status='pending' AND user_id IS NOT NULL
            AND purge_after <= CURRENT_TIMESTAMP
          FOR UPDATE`, [req.id]);
      if (!live.rows.length) { await client.query('ROLLBACK'); continue; }

      const userId = live.rows[0].user_id;

      /* A super admin cannot be erased by a timer. If the only account that
         can provision administrators deletes itself, nobody can recover the
         platform — that has to be a deliberate act with a human present. */
      const who = await client.query('SELECT role FROM users WHERE id=$1', [userId]);
      if (!who.rows.length) {
        // The account is already gone; close the request as done rather than
        // leaving it pending for ever.
        await client.query(
          `UPDATE deletion_requests SET status='completed', purged_at=CURRENT_TIMESTAMP,
                  subject_label=COALESCE(subject_label, $2) WHERE id=$1`,
          [req.id, `user #${userId}`]);
        await client.query('COMMIT');
        notes.push(`request ${req.id}: account already absent`);
        continue;
      }
      if (who.rows[0].role === 'super_admin') {
        await client.query('ROLLBACK');
        notes.push(`request ${req.id}: refused, super_admin must be erased by hand`);
        continue;
      }

      // Detach the name from financial records that outlive the account.
      await client.query(
        `UPDATE donations SET donor_name='Erased at the donor''s request'
          WHERE donor_user_id=$1`, [userId]);

      // The cascades do the rest.
      await client.query('DELETE FROM users WHERE id=$1', [userId]);

      await client.query(
        `UPDATE deletion_requests
            SET status='completed', purged_at=CURRENT_TIMESTAMP, subject_label=$2
          WHERE id=$1`, [req.id, `user #${userId}`]);

      await client.query('COMMIT');
      purged++;
      notes.push(`request ${req.id}: user #${userId} erased`);

      /* Audited outside the transaction: writeAudit chains on the latest row,
         and it must not be holding this transaction's lock when it reads.
         The entry survives the account because actor_id is SET NULL. */
      if (writeAudit) {
        await writeAudit('Account Purged',
          `deletion request ${req.id} for user ${userId}, grace period expired ${String(live.rows[0].purge_after).slice(0, 10)}`,
          '🗑', { targetType: 'user', targetId: userId });
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      notes.push(`request ${req.id}: FAILED ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }

  return { eligible: due.rows.length, purged, detail: notes.join('; ') || 'nothing due' };
}

/* ─── JOB: MENTORSHIP EXPIRY ────────────────────────────────
   Requests expire after five days. That sweep currently runs only when
   somebody loads their mentorship list, so a request can sit "pending" past
   its expiry indefinitely if neither party looks. Same statement, on a timer.
   Idempotent: once expired, the WHERE clause no longer matches. */
async function expireStaleMentorships() {
  const r = await db.query(
    `UPDATE mentorships SET status='expired'
      WHERE status='pending' AND expires_at < CURRENT_TIMESTAMP
      RETURNING id`);
  return { expired: r.rowCount, detail: r.rowCount ? `${r.rowCount} request(s) expired` : 'none due' };
}

/* ─── REGISTRY ──────────────────────────────────────────────
   deps carries what a job needs from the app: the sweep function exported by
   routes_events (so there is one copy of that logic, not two) and the audit
   writer. */
function buildJobs(deps = {}) {
  return {
    'event-maintenance': {
      description: 'Roll event statuses forward and send task deadline reminders',
      run: async () => {
        if (typeof deps.runReminderSweep !== 'function') {
          throw new Error('event sweep unavailable');
        }
        const r = await deps.runReminderSweep();
        return {
          items: (r.sent || 0) + (r.statusAdvanced || 0),
          detail: `${r.statusAdvanced} event status(es) advanced, ${r.sent} reminder(s) sent, ${r.scanned} task(s) scanned`
        };
      }
    },
    'deletion-purge': {
      description: 'Erase accounts whose 30-day deletion grace period has expired',
      run: async () => {
        const r = await purgeDueDeletions({ writeAudit: deps.writeAudit });
        return { items: r.purged, detail: `${r.eligible} due, ${r.purged} purged — ${r.detail}` };
      }
    },
    'mentorship-expiry': {
      description: 'Expire mentorship requests nobody answered within five days',
      run: async () => {
        const r = await expireStaleMentorships();
        return { items: r.expired, detail: r.detail };
      }
    }
  };
}

/* Runs one job and records the attempt either way. A job that throws is still
   a run that happened, and the failure is what a monitor needs to see. */
async function runJob(name, deps, source) {
  const registry = buildJobs(deps);
  const job = registry[name];
  if (!job) {
    const err = new Error(`Unknown job "${name}"`);
    err.status = 400;
    throw err;
  }

  const run = await openRun(name, source);
  try {
    const out = await job.run();
    await closeRun(run.id, 'ok', out.detail, out.items, run.started_at);
    return { job: name, status: 'ok', runId: run.id, items: out.items, detail: out.detail };
  } catch (e) {
    // The message is stored for an operator; it is never returned to a caller
    // that has not authenticated as the scheduler.
    await closeRun(run.id, 'failed', e.message, 0, run.started_at);
    e.runId = run.id;
    throw e;
  }
}

async function runAllJobs(deps, source) {
  const names = Object.keys(buildJobs(deps));
  const results = [];
  for (const n of names) {
    try {
      results.push(await runJob(n, deps, source));
    } catch (e) {
      results.push({ job: n, status: 'failed', detail: e.message });
    }
  }
  return results;
}

module.exports = {
  buildJobs, runJob, runAllJobs, reapStaleRuns,
  purgeDueDeletions, expireStaleMentorships,
  JOB_NAMES: Object.keys(buildJobs({}))
};
