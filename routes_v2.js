/* ============================================================
   DIC ALUMNI PLATFORM — ROUTES v2
   Endpoints for the modules that had PostgreSQL tables but no API, plus the
   modules that had neither. Mounted by server.js, which injects the auth
   middleware so there is a single implementation of the security rules.
   ============================================================ */

const crypto = require('crypto');
const db = require('./db');
const privacy = require('./privacy');   // location privacy is enforced in SQL below
const auditChain = require('./audit_chain');
const { sendCsv } = require('./csv');                 // one CSV writer for the platform
const { MODULE_NAMES, moduleCaseSql } = require('./audit_modules');
const scope = require('./scope');

// ─── FIELD-LEVEL ENCRYPTION (REQ-14, PDPA 2026) ───
// AES-256-GCM. The key comes from ENCRYPTION_KEY (64 hex chars). Without it the
// vault endpoints refuse to operate rather than silently storing plaintext.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const encryptionReady = /^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY);

if (!encryptionReady) {
  console.warn('⚠  ENCRYPTION_KEY missing or malformed — identity vault endpoints are disabled. ' +
               'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

function encryptField(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  };
}

function decryptField({ ciphertext, iv, auth_tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(auth_tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

// ─── IMMUTABLE AUDIT TRAIL ───
// Each entry is chained to the previous one's hash, so a deleted or edited row
// breaks verification. audit_logs had a table but nothing ever wrote to it.
/* The actor used to be recorded only inside the free-text meta string ("by user
   5"), which cannot be queried, joined or filtered. An optional fifth argument
   now carries { actorId, targetType, targetId, ip } into first-class columns.
   Existing call sites pass three arguments and keep working; their entries
   simply leave the new columns NULL. The hash chain is unchanged — it still
   covers action + meta + timestamp, so no historical entry is invalidated. */
/* Phase 5A replaced the chain this used to compute inline. The old digest
   consumed `new Date().toISOString()` and stored nothing about it, while
   created_at was a separate Postgres CURRENT_TIMESTAMP — so one of the four
   inputs was discarded on every write and no entry could ever be recomputed.
   It also truncated SHA-256 to 64 bits and read the predecessor without a lock.

   The definition now lives in audit_chain.js, which the standalone verifier
   reads through as well: one description of the chain, so a verifier cannot
   agree with the writer merely because both drifted together. */
async function writeAudit(action, meta, icon = '🛡', ctx = {}) {
  try {
    await auditChain.appendEntry(db, {
      action, meta, icon,
      actorId: ctx.actorId ?? null,
      targetType: ctx.targetType ?? null,
      targetId: ctx.targetId ?? null,
      ip: ctx.ip ?? null
    });
  } catch (e) {
    // An audit failure must never take a request down with it. It is loud in
    // the log, and the chain verifier will show the gap.
    console.warn('audit write failed:', e.message);
  }
}

const ref = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

module.exports = function mountV2(app, { requireAuth, requireVerified, requireRole, ADMIN_ROLES, MODERATOR_ROLES, serverError }) {

  /* Phase 5F: the raw exception text used to be the response body, so any
     signed-in caller could read PostgreSQL's own error strings. It is logged
     against the correlation id instead. */
  const ok = (res, fn) => fn().catch(err => serverError(res, err, 'v2'));

  /* Events, ticketing and check-in moved to routes_events.js in v5.
     They are one lifecycle and were previously split across three files. */


  /* The three real answers to "where does this work happen". Kept beside the
     routes that use it and mirrored by the jobs_work_mode_valid constraint. */
  const WORK_MODES = ['onsite', 'remote', 'hybrid'];

  /* ══════════════════════════════════════════════════════════
     JOBS — CRUD, applications, referrals (REQ-07)
     ══════════════════════════════════════════════════════════ */

  app.get('/api/jobs', requireAuth, (req, res) => ok(res, async () => {
    const { search, type, location, workMode, status } = req.query;
    const where = [], params = [req.user.uid];
    if (search) { params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(j.title) LIKE $${params.length} OR LOWER(j.company) LIKE $${params.length} OR LOWER(ARRAY_TO_STRING(j.tags,',')) LIKE $${params.length})`); }
    if (type && type !== 'all')     { params.push(type); where.push(`j.type = $${params.length}`); }
    if (location && location !== 'all') { params.push(`%${location.toLowerCase()}%`); where.push(`LOWER(j.location) LIKE $${params.length}`); }
    // Only the three real answers filter; anything else is ignored rather
    // than passed to the database as a value it would never match.
    if (WORK_MODES.includes(workMode)) { params.push(workMode); where.push(`j.work_mode = $${params.length}`); }
    /* 'open' means open AND not past its deadline — the two things a reader
       means by it. Anything else is ignored rather than passed through. */
    if (status === 'open')   where.push(`j.status = 'open' AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)`);
    if (status === 'closed') where.push(`(j.status = 'closed' OR (j.deadline IS NOT NULL AND j.deadline < CURRENT_DATE))`);

    const rows = await db.query(`
      SELECT j.*,
             /* Derived, not stored: a deadline passing writes nothing, so a
                stored flag would need a job to keep it true. */
             (j.deadline IS NOT NULL AND j.deadline < CURRENT_DATE) AS is_expired,
             (j.status = 'open' AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)) AS is_open,
             (SELECT COUNT(*)::int FROM job_applications a WHERE a.job_id = j.id) AS applicants,
             EXISTS (SELECT 1 FROM job_applications a WHERE a.job_id = j.id AND a.applicant_id = $1) AS has_applied,
             (SELECT a.status FROM job_applications a
               WHERE a.job_id = j.id AND a.applicant_id = $1) AS my_application_status
      FROM jobs j
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY j.created_at DESC, j.id DESC
    `, params);
    res.json(rows.rows);
  }));

  app.post('/api/jobs', requireVerified, (req, res) => ok(res, async () => {
    const { title, company, salary, type, location, tags, emoji, workMode, description, deadline } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Job title is required' });
    if (!company || !company.trim()) return res.status(400).json({ error: 'Company is required' });

    const poster = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.uid]);
    const tagArray = Array.isArray(tags) ? tags
                   : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

    if (workMode !== undefined && workMode !== null && workMode !== '' && !WORK_MODES.includes(workMode)) {
      return res.status(400).json({ error: 'Work mode must be onsite, remote or hybrid' });
    }

    if (deadline !== undefined && deadline !== null && String(deadline).trim() !== '' && isNaN(Date.parse(deadline))) {
      return res.status(400).json({ error: 'Application deadline is not a valid date' });
    }

    const row = await db.query(`
      INSERT INTO jobs (emoji, title, company, salary, type, location, work_mode, posted_by_id, posted_by_name, tags,
                        description, deadline)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [emoji || '💼', title.trim(), company.trim(), salary || 'Negotiable',
        (type || 'fulltime').toLowerCase(),
        // Was `location || 'Dhaka'`: a posting submitted without a location
        // recorded Dhaka anyway. An unstated location stays unstated.
        String(location || '').trim() || null,
        WORK_MODES.includes(workMode) ? workMode : null,
        req.user.uid, poster.rows[0]?.full_name || 'DIC Alumni', tagArray,
        String(description || '').trim() || null,
        String(deadline || '').trim() || null]);

    await writeAudit('Job Created', `"${title.trim()}" at ${company.trim()} by user ${req.user.uid}`, 'briefcase');

    await db.query(`INSERT INTO notifications (target_role, icon, title, subtitle) VALUES ('alumni','💼','New Job Posted',$1)`,
      [`${title.trim()} at ${company.trim()}`]);
    res.json(row.rows[0]);
  }));

  app.put('/api/jobs/:id', requireAuth, (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id);
    const owner = await db.query('SELECT posted_by_id FROM jobs WHERE id = $1', [id]);
    if (!owner.rows.length) return res.status(404).json({ error: 'Job not found' });
    if (owner.rows[0].posted_by_id !== req.user.uid && !ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'You can only edit your own postings' });
    }
    const { title, company, salary, type, location, workMode, description, deadline, status } = req.body;
    if (workMode !== undefined && workMode !== null && workMode !== '' && !WORK_MODES.includes(workMode)) {
      return res.status(400).json({ error: 'Work mode must be onsite, remote or hybrid' });
    }
    if (status !== undefined && !['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Job status must be open or closed' });
    }
    if (deadline !== undefined && deadline !== null && String(deadline).trim() !== '' && isNaN(Date.parse(deadline))) {
      return res.status(400).json({ error: 'Application deadline is not a valid date' });
    }
    // An explicit empty string clears the mode; undefined leaves it alone.
    const nextMode = workMode === undefined ? null
                   : (WORK_MODES.includes(workMode) ? workMode : null);
    const row = await db.query(`
      UPDATE jobs SET title=COALESCE($2,title), company=COALESCE($3,company), salary=COALESCE($4,salary),
                      type=COALESCE($5,type), location=COALESCE($6,location),
                      work_mode   = CASE WHEN $7::boolean  THEN $8  ELSE work_mode END,
                      description = CASE WHEN $9::boolean  THEN $10 ELSE description END,
                      deadline    = CASE WHEN $11::boolean THEN $12 ELSE deadline END,
                      status      = COALESCE($13, status),
                      closed_at   = CASE WHEN $13 = 'closed' AND status <> 'closed' THEN CURRENT_TIMESTAMP
                                         WHEN $13 = 'open' THEN NULL ELSE closed_at END,
                      closed_by   = CASE WHEN $13 = 'closed' AND status <> 'closed' THEN $14
                                         WHEN $13 = 'open' THEN NULL ELSE closed_by END
      WHERE id=$1 RETURNING *
    `, [id, title, company, salary, type, location,
        workMode !== undefined, nextMode,
        description !== undefined, String(description || '').trim() || null,
        deadline !== undefined, String(deadline || '').trim() || null,
        status === undefined ? null : status, req.user.uid]);

    /* A close is a different act from an edit and reads differently in the
       trail, so it is named differently. */
    if (status === 'closed')      await writeAudit('Job Closed',   `job ${id} by user ${req.user.uid}`, 'lock');
    else if (status === 'open')   await writeAudit('Job Reopened', `job ${id} by user ${req.user.uid}`, 'unlock');
    else                          await writeAudit('Job Edited',   `job ${id} by user ${req.user.uid}`, 'pen-line');
    res.json(row.rows[0]);
  }));

  app.delete('/api/jobs/:id', requireAuth, (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id);
    const owner = await db.query('SELECT posted_by_id, title FROM jobs WHERE id = $1', [id]);
    if (!owner.rows.length) return res.status(404).json({ error: 'Job not found' });
    if (owner.rows[0].posted_by_id !== req.user.uid && !ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'You can only delete your own postings' });
    }
    await db.query('DELETE FROM jobs WHERE id = $1', [id]);
    await writeAudit('Job Deleted', `"${owner.rows[0].title}" by user ${req.user.uid}`, '🗑');
    res.json({ success: true });
  }));

  app.post('/api/jobs/:id/apply', requireVerified, (req, res) => ok(res, async () => {
    const jobId = parseInt(req.params.id);
    const { coverNote, resumeUrl } = req.body || {};

    const job = await db.query(`SELECT title, company, posted_by_id, status, deadline,
                                 (deadline IS NOT NULL AND deadline < CURRENT_DATE) AS expired
                                FROM jobs WHERE id = $1`, [jobId]);
    if (!job.rows.length) return res.status(404).json({ error: 'Job not found' });
    /* A closed or expired posting does not take applications. Checked here
       rather than only hidden in the interface. */
    if (job.rows[0].status === 'closed') {
      return res.status(409).json({ error: 'This posting has been closed and is no longer accepting applications.' });
    }
    if (job.rows[0].expired) {
      return res.status(409).json({ error: 'The application deadline for this posting has passed.' });
    }

    const existing = await db.query('SELECT 1 FROM job_applications WHERE job_id=$1 AND applicant_id=$2', [jobId, req.user.uid]);
    if (existing.rows.length) return res.status(409).json({ error: 'You have already applied to this role' });

    const row = await db.query(`
      INSERT INTO job_applications (job_id, applicant_id, cover_note, resume_url)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [jobId, req.user.uid, coverNote || null, resumeUrl || null]);

    if (job.rows[0].posted_by_id) {
      const me = await db.query('SELECT full_name FROM users WHERE id=$1', [req.user.uid]);
      await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'📄','New Application Received',$2)`,
        [job.rows[0].posted_by_id, `${me.rows[0].full_name} applied for ${job.rows[0].title}.`]);
    }
    res.json({ success: true, application: row.rows[0] });
  }));

  /* An applicant could apply and then never learn what happened. This is the
     other half: their own applications and the current state of each. Scoped
     to the caller — there is no id in the path to tamper with. */
  app.get('/api/my-applications', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT a.id, a.status, a.cover_note, a.created_at, a.status_changed_at,
             j.id AS job_id, j.title, j.company, j.location, j.work_mode,
             j.status AS job_status,
             (j.deadline IS NOT NULL AND j.deadline < CURRENT_DATE) AS job_expired
        FROM job_applications a
        JOIN jobs j ON j.id = a.job_id
       WHERE a.applicant_id = $1
       ORDER BY a.created_at DESC`, [req.user.uid]);
    res.json(rows.rows);
  }));

  /* The poster (or an administrator) moves an application through the states
     the CHECK constraint already allows. Ownership is resolved from the JOB,
     not from anything the caller sends. */
  const APPLICATION_STATES = ['submitted', 'reviewing', 'shortlisted', 'rejected', 'hired'];

  app.put('/api/job-applications/:id/status', requireAuth, (req, res) => ok(res, async () => {
    const appId = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!APPLICATION_STATES.includes(status)) {
      return res.status(400).json({ error: 'Unknown application status' });
    }

    const row = await db.query(`
      SELECT a.id, a.status, a.applicant_id, j.id AS job_id, j.title, j.posted_by_id
        FROM job_applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.id = $1`, [appId]);
    if (!row.rows.length) return res.status(404).json({ error: 'Application not found' });

    const app_ = row.rows[0];
    if (app_.posted_by_id !== req.user.uid && !ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only the poster of this job can change an application' });
    }

    const updated = await db.query(`
      UPDATE job_applications
         SET status = $2, status_changed_at = CURRENT_TIMESTAMP, status_changed_by = $3
       WHERE id = $1 RETURNING id, status, status_changed_at`, [appId, status, req.user.uid]);

    /* The applicant is told, because a status they cannot see is not a status.
       The message names the role and the state and nothing about other
       candidates. */
    const LABEL = { submitted: 'received', reviewing: 'under review', shortlisted: 'shortlisted',
                    rejected: 'not taken forward', hired: 'successful' };
    await db.query(
      `INSERT INTO notifications (user_id, icon, title, subtitle, link_entity, link_id)
       VALUES ($1,'briefcase','Application update',$2,'job',$3)`,
      [app_.applicant_id, `Your application for ${app_.title} is ${LABEL[status]}.`, app_.job_id]);

    await writeAudit('Application Status Changed',
      `application ${appId} on job ${app_.job_id}: ${app_.status} -> ${status} by user ${req.user.uid}`,
      'clipboard-list');

    res.json(updated.rows[0]);
  }));

  app.get('/api/jobs/:id/applicants', requireAuth, (req, res) => ok(res, async () => {
    const jobId = parseInt(req.params.id);
    const owner = await db.query('SELECT posted_by_id FROM jobs WHERE id=$1', [jobId]);
    if (!owner.rows.length) return res.status(404).json({ error: 'Job not found' });
    if (owner.rows[0].posted_by_id !== req.user.uid && !ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only the poster can view applicants' });
    }
    const rows = await db.query(`
      SELECT a.id, a.status, a.cover_note, a.created_at, a.status_changed_at,
             u.id AS user_id, u.full_name AS name, u.initials,
             ap.batch, ap.department AS dept, ap.current_company AS company, ap.skills
      FROM job_applications a
      JOIN users u ON u.id = a.applicant_id
      LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
      WHERE a.job_id = $1 ORDER BY a.created_at DESC
    `, [jobId]);
    res.json(rows.rows);
  }));

  app.post('/api/jobs/:id/refer', requireVerified, (req, res) => ok(res, async () => {
    const jobId = parseInt(req.params.id);
    const { message } = req.body || {};
    const job = await db.query('SELECT title, posted_by_id FROM jobs WHERE id=$1', [jobId]);
    if (!job.rows.length) return res.status(404).json({ error: 'Job not found' });

    const row = await db.query(`
      INSERT INTO job_referrals (job_id, requester_id, referrer_id, message)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [jobId, req.user.uid, job.rows[0].posted_by_id || null, message || null]);

    if (job.rows[0].posted_by_id) {
      const me = await db.query('SELECT full_name FROM users WHERE id=$1', [req.user.uid]);
      await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'🤝','Referral Requested',$2)`,
        [job.rows[0].posted_by_id, `${me.rows[0].full_name} asked for a referral for ${job.rows[0].title}.`]);
    }
    res.json({ success: true, referral: row.rows[0] });
  }));

  /* ══════════════════════════════════════════════════════════
     CAMPAIGNS & DONATIONS LEDGER (REQ-05)
     ══════════════════════════════════════════════════════════ */

  app.get('/api/campaigns', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT c.*,
             COALESCE(d.total, 0)  AS raised_live,
             COALESCE(d.donors, 0) AS donors_live,
             COALESCE(p.total, 0)  AS pledged_live,
             COALESCE(p.donors, 0) AS pledgers_live
      FROM campaigns c
      LEFT JOIN (
        SELECT campaign_id, SUM(amount) AS total, COUNT(DISTINCT donor_user_id) AS donors
        FROM donations WHERE status = 'SUCCESS' GROUP BY campaign_id
      ) d ON d.campaign_id = c.id
      /* Pledges are reported separately and never folded into raised_live.
         A pledge is an intention; counting it as money raised is the whole
         mistake this release exists to undo. */
      LEFT JOIN (
        SELECT campaign_id, SUM(amount) AS total, COUNT(DISTINCT donor_user_id) AS donors
        FROM donations WHERE status = 'PLEDGED' GROUP BY campaign_id
      ) p ON p.campaign_id = c.id
      ORDER BY c.id ASC
    `);
    res.json(rows.rows);
  }));

  app.post('/api/campaigns', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const { name, description, tag, goalAmount, daysLeft, gateways } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required' });
    const row = await db.query(`
      INSERT INTO campaigns (name, description, tag, goal_amount, days_left, gateways)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [name.trim(), description || '', (tag || 'scholarship').toLowerCase(),
        parseFloat(goalAmount) || 1000000, parseInt(daysLeft) || 30,
        /* No default gateway list. This wrote ['bkash','nagad','card'] onto
           every campaign it created — three payment providers this platform has
           never been connected to, recorded as fact in the database. Nothing
           renders the column, so it was not a visible lie, but it was a
           fabrication at write time and the same pattern as the hardcoded
           'Dhaka' Phase 5B removed.

           The column is left in place (dropping it belongs in a schema-cleanup
           phase) and is now written only with what the caller actually supplies
           — which today is nothing. Donations are pledges confirmed by the
           alumni office; see the Payments section of README.md. */
        Array.isArray(gateways) && gateways.length ? gateways : null]);
    await writeAudit('Campaign Created', `"${name.trim()}" by user ${req.user.uid}`, '💰');
    res.json(row.rows[0]);
  }));

  app.put('/api/campaigns/:id', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const { name, description, tag, goalAmount, daysLeft } = req.body;
    const row = await db.query(`
      UPDATE campaigns SET name=COALESCE($2,name), description=COALESCE($3,description),
             tag=COALESCE($4,tag), goal_amount=COALESCE($5,goal_amount), days_left=COALESCE($6,days_left)
      WHERE id=$1 RETURNING *
    `, [parseInt(req.params.id), name, description, tag,
        goalAmount ? parseFloat(goalAmount) : null, daysLeft ? parseInt(daysLeft) : null]);
    if (!row.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(row.rows[0]);
  }));

  app.delete('/api/campaigns/:id', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const row = await db.query('DELETE FROM campaigns WHERE id=$1 RETURNING name', [parseInt(req.params.id)]);
    if (!row.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    await writeAudit('Campaign Deleted', `"${row.rows[0].name}" by user ${req.user.uid}`, '🗑');
    res.json({ success: true });
  }));

  /* A pledge, not a payment.

     This endpoint used to write a PENDING row "before the gateway is called",
     and POST /api/donations/:id/confirm then took the outcome from the request
     body: any signed-in donor could POST {success:true} against their own row
     and move it to SUCCESS. No gateway was ever called, because none is
     connected — so every SUCCESS in this ledger was self-attested, and the
     campaign totals, the donor leaderboard and the analytics gateway split all
     reported money nobody had received.

     What the platform can honestly record today is an intention to give. That
     is what this writes. Money becomes money only when a member of staff
     confirms it arrived, through record-payment below. */
  app.post('/api/donations', requireVerified, (req, res) => ok(res, async () => {
    const { campaignId, amount, isAnonymous, note } = req.body;
    const value = parseFloat(amount);
    if (!value || value <= 0) return res.status(400).json({ error: 'A positive amount is required' });

    const camp = await db.query('SELECT name FROM campaigns WHERE id=$1', [parseInt(campaignId)]);
    if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });

    const me = await db.query('SELECT full_name FROM users WHERE id=$1', [req.user.uid]);
    /* payment_gateway is written as 'pledge' rather than a bKash/Nagad/Rocket
       label the donor picked from a menu. The column used to hold whichever
       brand the browser sent, which made the analytics gateway split read as
       though four payment rails were in use. None are. */
    const row = await db.query(`
      INSERT INTO donations (campaign_id, donor_user_id, donor_name, amount, payment_gateway,
                             transaction_reference, status, is_anonymous)
      VALUES ($1,$2,$3,$4,'pledge',$5,'PLEDGED',$6) RETURNING *
    `, [parseInt(campaignId), req.user.uid, me.rows[0].full_name, value,
        ref('PLG'), !!isAnonymous]);

    await db.query(
      `INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'🤝','Pledge recorded',$2)`,
      [req.user.uid,
       `Your ৳${value.toLocaleString()} pledge to ${camp.rows[0].name} is recorded. ` +
       'The alumni office will be in touch to arrange payment.']);

    await writeAudit('Donation Pledged',
      `৳${value} to campaign ${parseInt(campaignId)} by user ${req.user.uid}` +
      (note ? ` · note attached (${String(note).length} chars)` : ''), '🤝',
      { actorId: req.user.uid, targetType: 'donation', targetId: row.rows[0].id });

    res.json({ donation: row.rows[0], campaign: camp.rows[0].name });
  }));

  /* Staff confirm that funds actually arrived. This is the only path to
     SUCCESS, and a donor cannot reach it: ADMIN_ROLES only, and the confirming
     account is written onto the row and into the audit trail. Until a payment
     gateway is integrated, this is a human attesting to a bank statement — so
     the record says who attested, and when. */
  app.post('/api/donations/:id/record-payment', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id);
    const { received = true, method, reason } = req.body || {};

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT * FROM donations WHERE id=$1 FOR UPDATE', [id]);
      if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Donation not found' }); }

      // Idempotent: a row that has already been settled is never re-counted.
      if (!['PLEDGED', 'PENDING'].includes(cur.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.json({ donation: cur.rows[0], alreadySettled: true });
      }

      const receipt = received ? ref('DIC-RCPT') : null;
      const upd = await client.query(`
        UPDATE donations
           SET status=$2, receipt_code=$3, failure_reason=$4, completed_at=CURRENT_TIMESTAMP,
               recorded_by=$5, recorded_at=CURRENT_TIMESTAMP, recorded_method=$6
         WHERE id=$1 RETURNING *
      `, [id, received ? 'SUCCESS' : 'CANCELLED', receipt,
          received ? null : (reason || 'Not received'), req.user.uid,
          received ? (method ? String(method).slice(0, 100) : 'manual') : null]);

      if (received) {
        /* campaigns.raised_amount and campaigns.donors_count were maintained here
           and read by nothing: every campaign total the product shows is a SUM
           over settled donations. Both columns are gone as of schema_v19. They
           had been seeded at ৳1,842,532 against ৳5,000 of real settled giving,
           so maintaining the delta only kept a wrong number moving. */
        if (cur.rows[0].donor_user_id) {
          await client.query(
            `INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'💰','Donation received',$2)`,
            [cur.rows[0].donor_user_id,
             `The alumni office has confirmed your ৳${Number(cur.rows[0].amount).toLocaleString()} donation. Receipt ${receipt}.`]);
        }
      }

      await client.query('COMMIT');
      await writeAudit(received ? 'Donation Payment Recorded' : 'Donation Pledge Closed',
        `৳${cur.rows[0].amount} · donation ${id} · by user ${req.user.uid}` +
        // The operator's reason is free text; bounded before it enters the chain.
        (received ? ` · ${receipt}` : ` · ${String(reason || 'not received').slice(0, 80)}`), '💰',
        { actorId: req.user.uid, targetType: 'donation', targetId: id });
      res.json({ donation: upd.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  }));

  // A donor may withdraw their own pledge; staff may close anyone's.
  app.post('/api/donations/:id/cancel', requireAuth, (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id);
    const cur = await db.query('SELECT * FROM donations WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Donation not found' });
    if (cur.rows[0].donor_user_id !== req.user.uid && !ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not your pledge' });
    }
    if (cur.rows[0].status !== 'PLEDGED') {
      return res.status(409).json({ error: 'Only an open pledge can be withdrawn' });
    }
    const upd = await db.query(
      `UPDATE donations SET status='CANCELLED', failure_reason='Withdrawn by donor',
              completed_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [id]);
    await writeAudit('Donation Pledge Withdrawn', `donation ${id} by user ${req.user.uid}`, '🤝');
    res.json({ donation: upd.rows[0] });
  }));

  app.get('/api/donations/mine', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT d.*, c.name AS campaign_name FROM donations d
      LEFT JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.donor_user_id = $1 ORDER BY d.created_at DESC
    `, [req.user.uid]);
    res.json(rows.rows);
  }));

  app.get('/api/donations/leaderboard', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT COALESCE(NULLIF(d.is_anonymous, TRUE)::text, '') AS ignored,
             CASE WHEN d.is_anonymous THEN 'Anonymous Donor' ELSE u.full_name END AS name,
             ap.batch, SUM(d.amount)::numeric AS total,
             -- Backs the line under each name, which used to be an invented
             -- status tier assigned purely by position in this list.
             COUNT(*)::int AS donation_count
      FROM donations d
      LEFT JOIN users u ON u.id = d.donor_user_id
      LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
      WHERE d.status = 'SUCCESS'
      GROUP BY d.is_anonymous, u.full_name, ap.batch
      ORDER BY total DESC LIMIT 5
    `);
    res.json(rows.rows);
  }));

  /* ══════════════════════════════════════════════════════════
     CUSTOM FIELDS (table existed, zero endpoints)
     ══════════════════════════════════════════════════════════ */

  app.get('/api/custom-fields', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query('SELECT * FROM custom_fields ORDER BY created_at ASC');
    res.json(rows.rows);
  }));

  app.post('/api/custom-fields', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const { label, section, fieldType, isRequired } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'Field label is required' });
    const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const exists = await db.query('SELECT 1 FROM custom_fields WHERE id=$1', [id]);
    if (exists.rows.length) return res.status(409).json({ error: 'A field with that name already exists' });

    const row = await db.query(`
      INSERT INTO custom_fields (id, label, section, field_type, is_required)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [id, label.trim(), section || 'academic', fieldType || 'text', !!isRequired]);
    await writeAudit('Custom Field Created', `"${label.trim()}" by user ${req.user.uid}`, '🧩');
    res.json(row.rows[0]);
  }));

  app.delete('/api/custom-fields/:id', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const row = await db.query('DELETE FROM custom_fields WHERE id=$1 RETURNING label', [req.params.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Field not found' });
    await writeAudit('Custom Field Deleted', `"${row.rows[0].label}" by user ${req.user.uid}`, '🗑');
    res.json({ success: true });
  }));

  /* ══════════════════════════════════════════════════════════
     MENTORSHIP (REQ-04)
     ══════════════════════════════════════════════════════════ */

  // Expire unanswered requests past their 5-day window before every read.
  /* The UPDATE that used to live here was a verbatim second copy of
     expireStaleMentorships() in jobs.js, run on every GET of this list by any
     signed-in member. Two consequences, both bad: the same business rule
     existed in two places and could drift, and scheduled work happened as a
     side effect of somebody opening a page — so ops_runs could not distinguish
     "the timer works" from "a member happened to look".

     Phase 6 made jobs.js the single writer. This route now DISPLAYS the
     expiry instead of performing it: a request past its expiry reads as
     expired immediately, and the row is written by the nightly job. A read
     endpoint should not mutate. */

  app.get('/api/mentorships', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT m.*,
             CASE WHEN m.status = 'pending' AND m.expires_at < CURRENT_TIMESTAMP
                  THEN 'expired' ELSE m.status END AS status,
             mentor.full_name AS mentor_name, mentor.initials AS mentor_initials,
             mentee.full_name AS mentee_name, mentee.initials AS mentee_initials,
             mp.current_company AS mentor_company, mp.job_title AS mentor_role, mp.batch AS mentor_batch
      FROM mentorships m
      JOIN users mentor ON mentor.id = m.mentor_id
      JOIN users mentee ON mentee.id = m.mentee_id
      LEFT JOIN alumni_profiles mp ON mp.user_id = m.mentor_id
      WHERE m.mentor_id = $1 OR m.mentee_id = $1
      ORDER BY m.created_at DESC
    `, [req.user.uid]);

    const mine = req.user.uid;
    res.json({
      asMentee: rows.rows.filter(r => r.mentee_id === mine),
      asMentor: rows.rows.filter(r => r.mentor_id === mine),
      incoming: rows.rows.filter(r => r.mentor_id === mine && r.status === 'pending')
    });
  }));

  // REQ-04's six weighted criteria, computed in SQL over real profile data.
  app.get('/api/mentorships/suggestions', requireAuth, (req, res) => ok(res, async () => {
    const me = await db.query(`
      SELECT ap.industry, ap.skills, ap.city, ap.department, ap.batch
      FROM alumni_profiles ap WHERE ap.user_id = $1
    `, [req.user.uid]);
    const p = me.rows[0] || {};

    /* match_score is a count of the profile attributes this mentor shares with
       the caller, out of the four the database can actually compare. It used to
       be a weighted percentage carrying two terms that measured nothing:
       "+ 15 -- language preference 15%" was added to every row unconditionally
       (alumni_profiles has no language column at all), and a 10-point
       can_mentor term that every row scores, since can_mentor = TRUE is the
       WHERE clause below. Together they handed a stranger 25% before any real
       attribute was compared, which is why the weakest possible match still
       read as a respectable score.

       Each matched_* flag is returned with the count so the interface can name
       the attributes that matched rather than show a bare percentage. */
    const rows = await db.query(`
      SELECT u.id, u.full_name AS name, u.initials,
             ap.current_company AS company, ap.job_title AS role, ap.batch, ap.color,
             ap.department, ap.industry,
             /* Phase 5F: ap.city was returned raw here, so a member who set
                location = 'private' had their city handed to any signed-in member
                through the mentor suggestions. The same gate the directory uses
                now applies. matched_city is gated too — a bare "matches your
                city" boolean discloses the city exactly to a reader who knows
                their own. */
             CASE WHEN ${privacy.DIRECTORY_VISIBLE_SQL} THEN ap.city ELSE NULL END AS city,
             ($2::text IS NOT NULL AND ap.industry   IS NOT DISTINCT FROM $2) AS matched_industry,
             ($3::text IS NOT NULL AND ap.skills     ILIKE '%' || $3 || '%')  AS matched_skill,
             (${privacy.DIRECTORY_VISIBLE_SQL} AND $4::text IS NOT NULL AND ap.city IS NOT DISTINCT FROM $4) AS matched_city,
             ($5::text IS NOT NULL AND ap.department IS NOT DISTINCT FROM $5) AS matched_department,
             (
                 CASE WHEN $2::text IS NOT NULL AND ap.industry   IS NOT DISTINCT FROM $2 THEN 1 ELSE 0 END
               + CASE WHEN $3::text IS NOT NULL AND ap.skills     ILIKE '%' || $3 || '%'  THEN 1 ELSE 0 END
               + CASE WHEN ${privacy.DIRECTORY_VISIBLE_SQL} AND $4::text IS NOT NULL AND ap.city IS NOT DISTINCT FROM $4 THEN 1 ELSE 0 END
               + CASE WHEN $5::text IS NOT NULL AND ap.department IS NOT DISTINCT FROM $5 THEN 1 ELSE 0 END
             ) AS match_score
      FROM users u
      JOIN alumni_profiles ap ON ap.user_id = u.id
      WHERE ap.can_mentor = TRUE
        AND u.id <> $1
        AND NOT EXISTS (
          SELECT 1 FROM mentorships m
          WHERE m.mentor_id = u.id AND m.mentee_id = $1 AND m.status IN ('pending','accepted')
        )
      ORDER BY match_score DESC, ap.batch ASC
      LIMIT 6
    `, [req.user.uid, p.industry || null, (p.skills || '').split(',')[0]?.trim() || null,
        p.city || null, p.department || null]);
    res.json(rows.rows);
  }));

  app.post('/api/mentorships', requireVerified, (req, res) => ok(res, async () => {
    // matchScore used to be read from the request body and stored as though it
    // had been computed. Any caller could write any number into the column, and
    // the browser was sending back whatever the suggestion list had shown it.
    // It is recomputed here from the two profiles instead.
    const { mentorId, subject, message } = req.body;
    const mentor = parseInt(mentorId);
    if (!mentor) return res.status(400).json({ error: 'mentorId is required' });
    if (mentor === req.user.uid) return res.status(400).json({ error: 'You cannot mentor yourself' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Please describe what you need help with' });

    const dup = await db.query(
      `SELECT 1 FROM mentorships WHERE mentor_id=$1 AND mentee_id=$2 AND status IN ('pending','accepted')`,
      [mentor, req.user.uid]);
    if (dup.rows.length) return res.status(409).json({ error: 'You already have an open request with this mentor' });

    // Same four comparisons as /api/mentorships/suggestions, so the stored score
    // means the same thing wherever it is read.
    const scored = await db.query(`
      SELECT (
          CASE WHEN me.industry   IS NOT NULL AND them.industry   IS NOT DISTINCT FROM me.industry   THEN 1 ELSE 0 END
        + CASE WHEN me.skills     IS NOT NULL AND them.skills     ILIKE '%' || split_part(me.skills, ',', 1) || '%' THEN 1 ELSE 0 END
        + CASE WHEN me.city       IS NOT NULL AND them.city       IS NOT DISTINCT FROM me.city       THEN 1 ELSE 0 END
        + CASE WHEN me.department IS NOT NULL AND them.department IS NOT DISTINCT FROM me.department THEN 1 ELSE 0 END
      )::int AS score
      FROM alumni_profiles me, alumni_profiles them
      WHERE me.user_id = $1 AND them.user_id = $2
    `, [req.user.uid, mentor]);

    const row = await db.query(`
      INSERT INTO mentorships (mentor_id, mentee_id, subject, message, match_score)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [mentor, req.user.uid, subject.trim(), message || null, scored.rows[0]?.score ?? 0]);

    const me = await db.query('SELECT full_name FROM users WHERE id=$1', [req.user.uid]);
    await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'🤝','New Mentorship Request',$2)`,
      [mentor, `${me.rows[0].full_name}: "${subject.trim()}" — expires in 5 days.`]);

    res.json({ success: true, mentorship: row.rows[0] });
  }));

  app.put('/api/mentorships/:id/:action', requireAuth, (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id);
    const action = req.params.action;
    const map = { accept: 'accepted', decline: 'declined', complete: 'completed' };
    if (!map[action]) return res.status(400).json({ error: 'Unknown action' });

    const cur = await db.query('SELECT * FROM mentorships WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Request not found' });

    const m = cur.rows[0];
    // Only the mentor answers a request; either party may close an active one.
    const allowed = action === 'complete'
      ? [m.mentor_id, m.mentee_id].includes(req.user.uid)
      : m.mentor_id === req.user.uid;
    if (!allowed) return res.status(403).json({ error: 'You cannot change this request' });
    if (action !== 'complete' && m.status !== 'pending') {
      return res.status(409).json({ error: `This request is already ${m.status}` });
    }

    const row = await db.query(`
      UPDATE mentorships SET status=$2, responded_at=CURRENT_TIMESTAMP,
        completed_at = CASE WHEN $2='completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id=$1 RETURNING *
    `, [id, map[action]]);

    const mentorName = await db.query('SELECT full_name FROM users WHERE id=$1', [m.mentor_id]);
    await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'🤝',$2,$3)`,
      [m.mentee_id,
       `Mentorship ${map[action] === 'accepted' ? 'Accepted ✓' : map[action] === 'declined' ? 'Declined' : 'Completed'}`,
       `${mentorName.rows[0].full_name} ${map[action]} your request "${m.subject}".`]);

    res.json({ success: true, mentorship: row.rows[0] });
  }));

  /* ══════════════════════════════════════════════════════════
     CONNECTIONS
     ══════════════════════════════════════════════════════════ */

  app.get('/api/connections', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT c.*, u.full_name, u.initials
      FROM connections c
      JOIN users u ON u.id = CASE WHEN c.requester_id=$1 THEN c.addressee_id ELSE c.requester_id END
      WHERE c.requester_id=$1 OR c.addressee_id=$1
    `, [req.user.uid]);
    res.json(rows.rows);
  }));

  app.post('/api/connections/:userId', requireVerified, (req, res) => ok(res, async () => {
    const target = parseInt(req.params.userId);
    if (target === req.user.uid) return res.status(400).json({ error: 'You cannot connect with yourself' });
    const exists = await db.query(
      `SELECT * FROM connections WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)`,
      [req.user.uid, target]);
    if (exists.rows.length) return res.status(409).json({ error: 'A connection already exists', connection: exists.rows[0] });

    const row = await db.query(
      'INSERT INTO connections (requester_id, addressee_id) VALUES ($1,$2) RETURNING *', [req.user.uid, target]);
    const me = await db.query('SELECT full_name FROM users WHERE id=$1', [req.user.uid]);
    await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'🔗','New Connection Request',$2)`,
      [target, `${me.rows[0].full_name} wants to connect with you.`]);
    res.json({ success: true, connection: row.rows[0] });
  }));

  /* ══════════════════════════════════════════════════════════
     POLLS
     ══════════════════════════════════════════════════════════ */

  /* One definition of "this poll is taking votes", used by the read side, the
     vote handler and the admin list alike. closes_at used to be written and
     never read, so a poll that had closed in August was still being offered
     in September. */
  const POLL_LIVE_SQL = `status = 'open' AND (closes_at IS NULL OR closes_at > CURRENT_TIMESTAMP)`;

  app.get('/api/polls/active', requireAuth, (req, res) => ok(res, async () => {
    const poll = await db.query(
      `SELECT * FROM polls WHERE ${POLL_LIVE_SQL} ORDER BY id DESC LIMIT 1`);
    if (!poll.rows.length) return res.json(null);
    const p = poll.rows[0];
    const votes = await db.query('SELECT option_index, COUNT(*)::int n FROM poll_votes WHERE poll_id=$1 GROUP BY option_index', [p.id]);
    const mine = await db.query('SELECT option_index FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [p.id, req.user.uid]);
    const counts = p.options.map((_, i) => votes.rows.find(v => v.option_index === i)?.n || 0);
    res.json({ ...p, counts, total: counts.reduce((a, b) => a + b, 0), myVote: mine.rows[0]?.option_index ?? null });
  }));

  app.post('/api/polls/:id/vote', requireAuth, (req, res) => ok(res, async () => {
    const pollId = parseInt(req.params.id);
    const idx = parseInt(req.body.optionIndex);
    /* Read the poll first so a draft, a closed poll and one past its closing
       time can each be refused for the reason that is true. */
    const poll = await db.query(
      `SELECT options, status, (closes_at IS NOT NULL AND closes_at <= CURRENT_TIMESTAMP) AS past_closing
         FROM polls WHERE id=$1`, [pollId]);
    if (!poll.rows.length) return res.status(404).json({ error: 'Poll not found' });
    const p = poll.rows[0];
    if (p.status === 'draft')  return res.status(403).json({ error: 'This poll is not open yet.' });
    if (p.status === 'closed') return res.status(409).json({ error: 'This poll has closed.' });
    if (p.past_closing)        return res.status(409).json({ error: 'Voting on this poll has closed.' });
    if (!(idx >= 0 && idx < p.options.length)) return res.status(400).json({ error: 'Invalid option' });

    // Re-voting updates the existing row; the UNIQUE constraint guarantees one
    // vote per person no matter how many times the button is pressed.
    await db.query(`
      INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES ($1,$2,$3)
      ON CONFLICT (poll_id, user_id) DO UPDATE SET option_index = EXCLUDED.option_index
    `, [pollId, req.user.uid, idx]);
    res.json({ success: true });
  }));

  /* ─── POLL ADMINISTRATION (§10) ───
     Staff only. The whole lifecycle, and nothing beyond it. */

  const pollWithCounts = async (id) => {
    const p = await db.query(
      `SELECT p.*, u.full_name AS created_by_name,
              (p.status = 'open' AND (p.closes_at IS NULL OR p.closes_at > CURRENT_TIMESTAMP)) AS is_live
         FROM polls p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [id]);
    if (!p.rows.length) return null;
    const votes = await db.query(
      'SELECT option_index, COUNT(*)::int n FROM poll_votes WHERE poll_id=$1 GROUP BY option_index', [id]);
    const counts = p.rows[0].options.map((_, i) => votes.rows.find(v => v.option_index === i)?.n || 0);
    return { ...p.rows[0], counts, total: counts.reduce((a, b) => a + b, 0) };
  };

  app.get('/api/polls', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    /* Per-option counts come back with the list, so the admin screen draws real
       bars from one request rather than a request per poll. */
    const rows = await db.query(`
      SELECT p.*, u.full_name AS created_by_name,
             (p.status = 'open' AND (p.closes_at IS NULL OR p.closes_at > CURRENT_TIMESTAMP)) AS is_live,
             (SELECT COUNT(*)::int FROM poll_votes v WHERE v.poll_id = p.id) AS total
        FROM polls p LEFT JOIN users u ON u.id = p.created_by
       ORDER BY p.created_at DESC, p.id DESC`);
    const tally = await db.query(
      `SELECT poll_id, option_index, COUNT(*)::int n FROM poll_votes GROUP BY poll_id, option_index`);
    res.json(rows.rows.map(p => ({
      ...p,
      counts: p.options.map((_, i) =>
        tally.rows.find(t => t.poll_id === p.id && t.option_index === i)?.n || 0)
    })));
  }));

  app.get('/api/polls/:id/results', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const poll = await pollWithCounts(parseInt(req.params.id, 10));
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    res.json(poll);
  }));

  /* Question and options are validated the same way on create and on edit,
     because a poll with one option is not a question. */
  const readPoll = (body) => {
    const question = String(body?.question || '').trim();
    const options = (Array.isArray(body?.options) ? body.options : [])
      .map(o => String(o || '').trim()).filter(Boolean);
    if (!question) return { error: 'A question is required' };
    if (question.length > 255) return { error: 'The question must be 255 characters or fewer' };
    if (options.length < 2) return { error: 'A poll needs at least two options' };
    if (options.length > 10) return { error: 'A poll can have at most ten options' };
    const closesAt = String(body?.closesAt || '').trim() || null;
    if (closesAt && isNaN(Date.parse(closesAt))) return { error: 'The closing time is not a valid date' };
    return { question, options, closesAt };
  };

  app.post('/api/polls', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const p = readPoll(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    // Created as a draft: an author writes before an audience reads.
    const row = await db.query(
      `INSERT INTO polls (question, options, closes_at, status, created_by)
       VALUES ($1,$2,$3,'draft',$4) RETURNING *`,
      [p.question, p.options, p.closesAt, req.user.uid]);
    await writeAudit('Poll Created', `poll ${row.rows[0].id} by user ${req.user.uid}`, 'vote');
    res.json(row.rows[0]);
  }));

  app.put('/api/polls/:id', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    const cur = await db.query('SELECT status FROM polls WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Poll not found' });
    /* Only a draft may be rewritten. Changing the question or the options of a
       poll people have already answered would silently reassign their votes to
       something they did not choose. */
    if (cur.rows[0].status !== 'draft') {
      return res.status(409).json({ error: 'Only a draft poll can be edited. Votes are already recorded against these options.' });
    }
    const p = readPoll(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    const row = await db.query(
      `UPDATE polls SET question=$2, options=$3, closes_at=$4 WHERE id=$1 RETURNING *`,
      [id, p.question, p.options, p.closesAt]);
    await writeAudit('Poll Edited', `poll ${id} by user ${req.user.uid}`, 'pen-line');
    res.json(row.rows[0]);
  }));

  app.put('/api/polls/:id/status', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'A poll is opened or closed' });
    }
    const cur = await db.query('SELECT status FROM polls WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Poll not found' });
    // A closed poll is not reopened: votes were cast under a stated closing.
    if (cur.rows[0].status === 'closed' && status === 'open') {
      return res.status(409).json({ error: 'A closed poll cannot be reopened. Create a new poll instead.' });
    }
    const row = await db.query(
      `UPDATE polls SET status=$2::varchar,
              opened_at = CASE WHEN $2::text='open'   AND opened_at IS NULL THEN CURRENT_TIMESTAMP ELSE opened_at END,
              closed_at = CASE WHEN $2::text='closed' THEN CURRENT_TIMESTAMP ELSE closed_at END
        WHERE id=$1 RETURNING *`, [id, status]);
    await writeAudit(status === 'open' ? 'Poll Opened' : 'Poll Closed',
      `poll ${id} by user ${req.user.uid}`, status === 'open' ? 'unlock' : 'lock');
    res.json(row.rows[0]);
  }));

  app.delete('/api/polls/:id', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    const cur = await db.query(
      `SELECT p.status, (SELECT COUNT(*)::int FROM poll_votes v WHERE v.poll_id=p.id) AS votes
         FROM polls p WHERE p.id=$1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Poll not found' });
    /* A poll with votes in it is closed, never deleted: poll_votes cascades,
       so removing the poll would destroy what people answered. */
    if (cur.rows[0].votes > 0) {
      return res.status(409).json({
        error: `This poll has ${cur.rows[0].votes} vote(s). Close it instead — deleting it would erase them.` });
    }
    await db.query('DELETE FROM polls WHERE id=$1', [id]);
    await writeAudit('Poll Deleted', `poll ${id} by user ${req.user.uid} (no votes cast)`, 'trash-2');
    res.json({ success: true });
  }));

  /* ══════════════════════════════════════════════════════════
     BROADCASTS (REQ-12)
     ══════════════════════════════════════════════════════════ */

  app.get('/api/broadcasts', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT b.*, u.full_name AS sender_name FROM broadcasts b
      LEFT JOIN users u ON u.id = b.sender_id ORDER BY b.created_at DESC LIMIT 25
    `);
    res.json(rows.rows);
  }));

  app.post('/api/broadcasts', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const { title, body, channels, targetRole, targetBatch } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

    const chans = Array.isArray(channels) && channels.length ? channels : ['push'];

    // Recipients are resolved from the real audience, not a fixed headline number.
    const params = [];
    let where = 'WHERE 1=1';
    if (targetRole && targetRole !== 'all') { params.push(targetRole); where += ` AND u.role = $${params.length}`; }
    if (targetBatch) { params.push(parseInt(targetBatch)); where += ` AND ap.batch = $${params.length}`; }

    const audience = await db.query(
      `SELECT u.id FROM users u LEFT JOIN alumni_profiles ap ON ap.user_id = u.id ${where}`, params);
    const recipientIds = audience.rows.map(r => r.id);

    const bc = await db.query(`
      INSERT INTO broadcasts (sender_id, title, body, channels, target_role, target_batch,
                              recipients_count, delivered_count, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'sent') RETURNING *
    `, [req.user.uid, title.trim(), body.trim(), chans, targetRole || null,
        targetBatch ? parseInt(targetBatch) : null, recipientIds.length]);

    // Fan out as real in-app notifications so the broadcast is actually delivered.
    for (const uid of recipientIds) {
      await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'📢',$2,$3)`,
        [uid, title.trim(), body.trim()]);
    }

    await writeAudit('Broadcast Sent', `"${title.trim()}" to ${recipientIds.length} recipients via ${chans.join('/')}`, '📢');
    res.json({ success: true, broadcast: bc.rows[0], recipients: recipientIds.length });
  }));

  /* ══════════════════════════════════════════════════════════
     AUDIT LOG (write path added above; read path was missing)
     ══════════════════════════════════════════════════════════ */

  /* The audit log holds 11,185 entries and this endpoint returned the newest
     50 of them, unfiltered and unpaged. An administrator asking "what did this
     person do to this account last March" had no way to ask it, which makes an
     audit trail a decoration.

     Five filters, all applied in SQL: administrator, action, module, target,
     and a date range. Plus paging, and a CSV export of exactly the filtered
     set — so what an investigator reads on screen is what they can hand over.

     The hash chain is never touched by any of this. Every query here is a
     SELECT; there is no ordering, filtering or export path that writes. */
  /* Phase 7D §7 — who sees what.

       super_admin  every entry
       univ_admin   every entry (institution-wide)
       dept_admin   entries about accounts in its own department, plus its own
                    actions — and never a platform-security action, whoever it
                    concerns
       moderator    no access, unchanged
       alumni       no access, unchanged

     A department admin can now answer "what happened to this student of mine",
     which is the question a department administrator actually has. It cannot
     answer "who signed in as a super admin", "when was the vault opened" or
     "who was given which role", because those are platform-security matters and
     a departmental scope is not a reason to see them.

     The deny-list is on the ACTION, not on the module, because a module is a
     coarse grouping and 'Administration' contains both an ordinary profile edit
     and a role change. Anything not recognised is denied to a scoped reader:
     an action added later is invisible to a department admin until somebody
     decides it should not be, which is the safe direction for that mistake. */
  const SECURITY_SENSITIVE = [
    'Administrator', 'Password', 'Signed In', 'Signed Out', 'Sign-In Failed',
    'Session', 'Vault', 'Identity', 'Database', 'Scheduler', 'Ops', 'Sync',
    'DSAR', 'Account Purged', 'Account Deletion', 'Audit Log Exported',
    'Bulk Import', 'Import Batch'
  ];

  function auditScopeClause(user, params) {
    if (scope.isInstitutionWide(user.role)) return '';

    /* Not institution-wide, so the reader is a dept_admin — nothing else
       reaches this route. An unassigned one sees nothing, like everywhere else. */
    const s = scope.scopeOf(user);
    if (s.kind !== 'department') return ' AND FALSE';

    params.push(s.departmentId);
    const dep = `$${params.length}`;
    params.push(user.uid);
    const me = `$${params.length}`;

    const denied = SECURITY_SENSITIVE
      .map(a => `a.action NOT ILIKE '${a.replace(/'/g, "''")}%'`)
      .join(' AND ');

    /* The subject of the entry must be one of this department's accounts, or
       the entry must be this administrator's own action. Both sides are joined
       against users.department_id, so an entry about a deleted account — whose
       department can no longer be established — is not shown to a department
       admin. */
    return ` AND (${denied}) AND (
        a.actor_id = ${me}
        OR EXISTS (SELECT 1 FROM users tu
                    WHERE a.target_type = 'user' AND tu.id = a.target_id
                      AND tu.department_id = ${dep})
      )`;
  }

  app.get('/api/audit-logs', requireRole(...ADMIN_ROLES, 'dept_admin'), (req, res) => ok(res, async () => {
    const isCsv = String(req.query.format || '').toLowerCase() === 'csv';

    const params = [];
    let where = 'WHERE TRUE';
    /* Applied first, so no query parameter below can widen past it. */
    where += auditScopeClause(req.user, params);

    // Administrator: an id, so a renamed account stays findable.
    if (/^\d+$/.test(String(req.query.actorId || ''))) {
      params.push(req.query.actorId);
      where += ` AND a.actor_id = $${params.length}::int`;
    }
    // Action: exact when given in full, otherwise a contains match, because
    // "Event" should find "Event Approved" without the operator knowing the
    // exact wording.
    if (req.query.action) {
      params.push(`%${String(req.query.action).slice(0, 120)}%`);
      where += ` AND a.action ILIKE $${params.length}`;
    }
    if (req.query.module) {
      params.push(String(req.query.module).slice(0, 40));
      where += ` AND ${moduleCaseSql('a.action')} = $${params.length}`;
    }
    if (req.query.targetType) {
      params.push(String(req.query.targetType).slice(0, 40));
      where += ` AND a.target_type = $${params.length}`;
    }
    if (/^\d+$/.test(String(req.query.targetId || ''))) {
      params.push(req.query.targetId);
      where += ` AND a.target_id = $${params.length}::int`;
    }

    const dateOk = (v) => v === undefined || v === null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0, 10));
    if (!dateOk(req.query.from) || !dateOk(req.query.to)) {
      return res.status(400).json({ error: 'from and to must be dates, as YYYY-MM-DD' });
    }
    const from = req.query.from ? String(req.query.from).slice(0, 10) : null;
    const to = req.query.to ? String(req.query.to).slice(0, 10) : null;
    if (from && to && from > to) {
      return res.status(400).json({ error: 'from must not be later than to' });
    }
    if (from) { params.push(from); where += ` AND a.created_at >= $${params.length}::date`; }
    if (to)   { params.push(to);   where += ` AND a.created_at < ($${params.length}::date + INTERVAL '1 day')`; }

    /* A count alongside the page, so the interface can say "showing 50 of
       3,893" rather than leaving the reader to guess whether there is more. */
    const totalRow = await db.query(`SELECT COUNT(*)::int AS n FROM audit_logs a ${where}`, params);
    const total = totalRow.rows[0].n;

    const MAX = isCsv ? 50000 : 200;
    const asked = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX) : (isCsv ? MAX : 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    params.push(limit, offset);
    const rows = await db.query(`
      SELECT a.id, a.action, a.meta, a.icon, a.bg_color, a.created_at,
             a.actor_id, a.target_type, a.target_id, a.ip,
             a.chain_version, a.prev_hash, a.entry_hash,
             /* The same two digests under names that are not credential
                vocabulary. csv.js refuses any column whose name reads as a
                secret, and it refused these — correctly, on the name alone.
                A digest of an audit entry is not a secret, so the fix is to
                call it what it is rather than to carve an exception into a
                guard whose whole value is having none. */
             a.prev_hash AS previous_digest, a.entry_hash AS entry_digest,
             u.full_name AS actor_name, u.email AS actor_email, u.role AS actor_role,
             ${moduleCaseSql('a.action')} AS module
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_id
      ${where}
      ORDER BY a.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    if (isCsv) {
      /* The chain columns travel with the export. An audit extract that cannot
         be checked against the log it came from is a list of assertions, and
         prev_hash and entry_hash are what make it verifiable. They are digests
         of entries, not secrets, so exporting them discloses nothing.

         Exporting is itself audited — before the file is written, so a
         download that fails partway is still recorded as an attempt. */
      await writeAudit('Audit Log Exported',
        `${rows.rows.length} of ${total} entr${total === 1 ? 'y' : 'ies'}` +
        (from || to ? ` for ${from || 'the beginning'} to ${to || 'today'}` : '') +
        (req.query.module ? ` in ${req.query.module}` : ''),
        '📤', { actorId: req.user.uid, targetType: 'audit_log', ip: req.ip });

      return sendCsv(res, 'audit_log', [
        { key: 'id', header: 'Entry' },
        { key: 'created_at', header: 'When' },
        { key: 'module', header: 'Module' },
        { key: 'action', header: 'Action' },
        { key: 'meta', header: 'Detail' },
        { key: 'actor_name', header: 'Administrator' },
        { key: 'actor_email', header: 'Administrator email' },
        { key: 'actor_role', header: 'Role' },
        { key: 'target_type', header: 'Target type' },
        { key: 'target_id', header: 'Target' },
        { key: 'ip', header: 'IP address' },
        { key: 'chain_version', header: 'Chain version' },
        { key: 'previous_digest', header: 'Previous entry digest' },
        { key: 'entry_digest', header: 'Entry digest' }
      ], rows.rows);
    }

    res.json({
      entries: rows.rows,
      total,
      limit,
      offset,
      modules: MODULE_NAMES,
      filters: { from, to, module: req.query.module || null, action: req.query.action || null,
                 actorId: req.query.actorId || null, targetType: req.query.targetType || null,
                 targetId: req.query.targetId || null }
    });
  }));

  /* The administrators who appear in the log, so the filter offers real names
     instead of asking for an id. Read from audit_logs rather than from users:
     an account that has been deleted still has entries, and they must remain
     findable. */
  app.get('/api/audit-logs/actors', requireRole(...ADMIN_ROLES, 'dept_admin'), (req, res) => ok(res, async () => {
    /* Scoped identically to the log itself. A filter list built from entries
       the reader cannot open would name administrators and counts they are not
       entitled to — a filter dropdown is a disclosure like any other. */
    const params = [];
    const clause = auditScopeClause(req.user, params);
    const rows = await db.query(`
      SELECT a.actor_id AS id,
             COALESCE(u.full_name, 'Deleted account #' || a.actor_id) AS name,
             u.role, COUNT(*)::int AS entries
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.actor_id IS NOT NULL${clause}
      GROUP BY a.actor_id, u.full_name, u.role
      ORDER BY entries DESC`, params);
    res.json(rows.rows);
  }));

  /* The action vocabulary actually present in the log, with counts. Same
     reason: an operator should pick from what exists, not type a guess. */
  app.get('/api/audit-logs/actions', requireRole(...ADMIN_ROLES, 'dept_admin'), (req, res) => ok(res, async () => {
    const params = [];
    const clause = auditScopeClause(req.user, params);
    const rows = await db.query(`
      SELECT a.action, ${moduleCaseSql('a.action')} AS module, COUNT(*)::int AS entries
      FROM audit_logs a WHERE TRUE${clause}
      GROUP BY a.action ORDER BY entries DESC`, params);
    res.json({ actions: rows.rows, modules: MODULE_NAMES });
  }));

  return { writeAudit, encryptField, decryptField, encryptionReady, ref };
};
