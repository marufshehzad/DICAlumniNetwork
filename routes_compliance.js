/* ============================================================
   DIC ALUMNI PLATFORM — COMPLIANCE ROUTES (REQ-14)
   PDPA 2026 & Cybersecurity Act 2023.

   The UI previously displayed green "compliant" pills over features that did
   not exist: decryptVaultField() revealed a hardcoded string, there was no
   consent log, and DSAR export/delete were toast messages. These endpoints
   implement the behaviour those claims describe.
   ============================================================ */

const db = require('./db');
const auditChain = require('./audit_chain');
const privacy = require('./privacy');

module.exports = function mountCompliance(app, {
  requireAuth, requireRole, ADMIN_ROLES,
  encryptField, decryptField, encryptionReady, writeAudit, serverError
}) {

  const ok = (res, fn) => fn().catch(err => serverError(res, err, 'compliance'));

  const clientIp = (req) =>
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';

  /* ─── CONSENT LOGGING ───
     PDPA 2026 requires IP, timestamp and policy version behind each consent. */

  app.post('/api/consent', requireAuth, (req, res) => ok(res, async () => {
    const { consentType, granted, policyVersion } = req.body || {};
    if (!consentType) return res.status(400).json({ error: 'consentType is required' });

    /* Bounded before the insert, not after it. consent_logs.consent_type is
       VARCHAR(100) and policy_version VARCHAR(50), so an oversized value used
       to reach Postgres and come back as a 500 carrying the raw driver
       message — "value too long for type character varying(100)" — which tells
       a caller the column type and width. A caller's mistake should be a 400
       that names the limit, not a server error that describes the schema.

       ip_address is VARCHAR(64) and comes from X-Forwarded-For, so it is
       clamped rather than rejected: the caller does not control it on purpose,
       and a long proxy chain is not a client error. Same reasoning as the
       audit writer's clamp. */
    if (String(consentType).length > 100) {
      return res.status(400).json({ error: 'consentType must be 100 characters or fewer' });
    }
    if (policyVersion !== undefined && String(policyVersion).length > 50) {
      return res.status(400).json({ error: 'policyVersion must be 50 characters or fewer' });
    }
    const clampTo = (v, n) => v === null || v === undefined ? null : String(v).slice(0, n);

    const row = await db.query(`
      INSERT INTO consent_logs (user_id, consent_type, granted, policy_version, ip_address, user_agent)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.user.uid, String(consentType), granted !== false,
        clampTo(policyVersion || 'PDPA-2026.1', 50), clampTo(clientIp(req), 64),
        clampTo(req.headers['user-agent'], 500)]);

    /* consentType is supplied by the member, so it is bounded before it reaches
       the audit trail. Unbounded caller text in a hash-chained log is a way to
       flood it, and — because writeAudit swallows its own errors — an
       oversized value used to make the entry vanish while the consent itself
       was still recorded. */
    await writeAudit('Consent Recorded',
      `user ${req.user.uid} ${granted !== false ? 'granted' : 'withdrew'} ` +
      `"${String(consentType).slice(0, 60)}"`, '📜',
      { actorId: req.user.uid, targetType: 'consent', targetId: row.rows[0].id, ip: clientIp(req) });
    res.json({ success: true, consent: row.rows[0] });
  }));

  app.get('/api/consent', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(
      'SELECT * FROM consent_logs WHERE user_id=$1 ORDER BY created_at DESC', [req.user.uid]);
    res.json(rows.rows);
  }));

  /* ─── ENCRYPTED IDENTITY VAULT (AES-256-GCM) ─── */

  app.get('/api/vault', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    // Masked view: never decrypts. last_four is stored alongside the ciphertext
    // so the list can render without touching the key.
    const rows = await db.query(`
      SELECT v.id, v.field_type, v.last_four, v.created_at,
             u.id AS user_id, u.full_name AS owner_name
      FROM identity_vault v JOIN users u ON u.id = v.user_id
      ORDER BY v.created_at DESC LIMIT 50
    `);
    res.json({ encryptionEnabled: encryptionReady, entries: rows.rows });
  }));

  app.post('/api/vault', requireAuth, (req, res) => ok(res, async () => {
    if (!encryptionReady) {
      return res.status(503).json({ error: 'Encryption key not configured — refusing to store identity data.' });
    }
    const { fieldType, value } = req.body || {};
    if (!['nid', 'brc', 'passport'].includes(fieldType)) {
      return res.status(400).json({ error: 'fieldType must be nid, brc or passport' });
    }
    if (!value || !String(value).trim()) return res.status(400).json({ error: 'A value is required' });

    const plain = String(value).trim();
    const { ciphertext, iv, authTag } = encryptField(plain);

    const row = await db.query(`
      INSERT INTO identity_vault (user_id, field_type, ciphertext, iv, auth_tag, last_four)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id, field_type) DO UPDATE
        SET ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
            auth_tag=EXCLUDED.auth_tag, last_four=EXCLUDED.last_four
      RETURNING id, field_type, last_four, created_at
    `, [req.user.uid, fieldType, ciphertext, iv, authTag, plain.slice(-4)]);

    // The vault id is sufficient for operations; identity_vault.field_type
    // remains queryable by anyone with cause to look.
    await writeAudit('Identity Field Encrypted',
      `vault ${row.rows[0].id} stored for user ${req.user.uid} (AES-256-GCM)`, '🔐',
      { actorId: req.user.uid, targetType: 'identity_vault', targetId: row.rows[0].id, ip: clientIp(req) });
    res.json({ success: true, entry: row.rows[0] });
  }));

  // Decryption is privileged, requires a stated reason, and is itself logged.
  app.post('/api/vault/:id/reveal', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    if (!encryptionReady) return res.status(503).json({ error: 'Encryption key not configured' });

    const { reason } = req.body || {};
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'A reason (min 5 characters) is required to decrypt identity data' });
    }

    const row = await db.query(`
      SELECT v.*, u.full_name FROM identity_vault v
      JOIN users u ON u.id = v.user_id WHERE v.id = $1
    `, [parseInt(req.params.id)]);
    if (!row.rows.length) return res.status(404).json({ error: 'Vault entry not found' });

    let plaintext;
    try {
      plaintext = decryptField(row.rows[0]);
    } catch {
      // GCM auth tag mismatch means the ciphertext or key changed.
      return res.status(500).json({ error: 'Decryption failed — data integrity check did not pass' });
    }

    await db.query('INSERT INTO vault_access_logs (vault_id, accessed_by, reason) VALUES ($1,$2,$3)',
      [row.rows[0].id, req.user.uid, reason.trim()]);
    /* This was the most sensitive audit line in the codebase: it named the data
       subject and the identity-document category in one string, in a table every
       administrator can read. The operator's stated reason is written to
       vault_access_logs on the line above, so nothing is lost by keeping it out
       of here as well. */
    await writeAudit('Identity Field Decrypted',
      `vault ${row.rows[0].id} (${row.rows[0].field_type}) of user ${row.rows[0].user_id} by user ${req.user.uid}`, '🔓',
      { actorId: req.user.uid, targetType: 'identity_vault', targetId: row.rows[0].id, ip: clientIp(req) });

    res.json({ value: plaintext, owner: row.rows[0].full_name, fieldType: row.rows[0].field_type });
  }));

  app.get('/api/vault/access-logs', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT l.*, u.full_name AS accessed_by_name, v.field_type, o.full_name AS owner_name
      FROM vault_access_logs l
      LEFT JOIN users u ON u.id = l.accessed_by
      LEFT JOIN identity_vault v ON v.id = l.vault_id
      LEFT JOIN users o ON o.id = v.user_id
      ORDER BY l.created_at DESC LIMIT 50
    `);
    res.json(rows.rows);
  }));

  /* ─── DSAR: STRUCTURED EXPORT (JSON / CSV) ─── */

  app.get('/api/dsar/export', requireAuth, (req, res) => ok(res, async () => {
    const uid = req.user.uid;
    const format = (req.query.format || 'json').toLowerCase();

    /* Phase 7C-1 widened this. It previously returned eight sections and named
       none of the ones it left out, which is the shape of export that reads as
       complete without being it: job applications, referrals, connections,
       notifications, the identity vault and the member's own deletion history
       were all absent and unmentioned. */
    const [user, profile, donations, registrations, mentorships, memberships,
           consents, stories, applications, referrals, connections, notifications,
           vault, deletions, eventPeople, taskWork] =
      await Promise.all([
        db.query(`SELECT id, email, full_name, role, role_label, department, designation,
                         phone, status, is_verified, created_via, created_at, last_login_at
                    FROM users WHERE id=$1`, [uid]),
        db.query('SELECT * FROM alumni_profiles WHERE user_id=$1', [uid]),
        db.query('SELECT amount, currency, payment_gateway, status, receipt_code, created_at FROM donations WHERE donor_user_id=$1', [uid]),
        db.query('SELECT ticket_code, status, checked_in, created_at FROM event_registrations WHERE user_id=$1', [uid]),
        db.query('SELECT subject, status, created_at FROM mentorships WHERE mentor_id=$1 OR mentee_id=$1', [uid]),
        db.query('SELECT chapter_id, joined_at FROM chapter_memberships WHERE user_id=$1', [uid]),
        db.query('SELECT consent_type, granted, policy_version, created_at FROM consent_logs WHERE user_id=$1 ORDER BY created_at DESC', [uid]),
        db.query('SELECT title, status, created_at FROM stories WHERE author_id=$1', [uid]),
        db.query(`SELECT j.title, j.company, a.status, a.cover_note, a.created_at
                    FROM job_applications a JOIN jobs j ON j.id = a.job_id
                   WHERE a.applicant_id=$1 ORDER BY a.created_at DESC`, [uid]),
        db.query(`SELECT j.title, j.company, r.status, r.created_at
                    FROM job_referrals r JOIN jobs j ON j.id = r.job_id
                   WHERE r.requester_id=$1 ORDER BY r.created_at DESC`, [uid]),
        db.query(`SELECT CASE WHEN requester_id=$1 THEN 'sent' ELSE 'received' END AS direction,
                         status, created_at
                    FROM connections WHERE requester_id=$1 OR addressee_id=$1
                   ORDER BY created_at DESC`, [uid]),
        db.query('SELECT title, subtitle, is_unread, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC', [uid]),
        /* Presence and metadata only — never ciphertext, iv or auth tag. See
           the omittedSections note below for the reasoning. */
        db.query('SELECT field_type, last_four, created_at FROM identity_vault WHERE user_id=$1', [uid]),
        db.query('SELECT status, reason, created_at, purge_after, purged_at FROM deletion_requests WHERE user_id=$1 ORDER BY created_at DESC', [uid]),
        db.query(`SELECT e.title AS event, p.role_in_event, p.committee, p.created_at
                    FROM event_people p JOIN events e ON e.id = p.event_id
                   WHERE p.user_id=$1`, [uid]),
        db.query(`SELECT e.title AS event, t.title AS task, t.status
                    FROM event_task_assignees a
                    JOIN event_tasks t ON t.id = a.task_id
                    JOIN events e ON e.id = t.event_id
                   WHERE a.user_id=$1`, [uid])
      ]);

    /* No query above carries a .catch fallback. In an export, a broken query
       returning an empty array is indistinguishable from a member having no
       records — the worst possible failure mode for this endpoint. A failure
       here becomes a 500 with a request id, which is honest.

       A defence rather than a description: alumni_profiles is selected with *,
       so a column added later that happens to hold a credential would ride out
       in this bundle without anyone noticing. Anything whose NAME looks like a
       secret is dropped here regardless of which table it came from. */
    const SECRET_KEY = /password|passwd|hash|token|secret|salt|cipher|ciphertext|auth_tag|\biv\b|private_key|api_key/i;
    const scrub = (row) => {
      if (!row || typeof row !== 'object') return row;
      const out = {};
      for (const [k, v] of Object.entries(row)) if (!SECRET_KEY.test(k)) out[k] = v;
      return out;
    };
    const scrubAll = (rows) => rows.map(scrub);

    const profileRow = scrub(profile.rows[0] || null);
    /* Lifted out of the profile blob so a reader can find them. They are the
       two things a member is most likely to be checking. */
    /* Passed through privacy.effective() so the export shows the settings that
       actually apply. The stored JSONB still carries keys from an older schema
       — cgpa, github, address, linkedin — that no longer control anything;
       exporting them would show a member controls they do not have. */
    const privacySettings = privacy.effective(profileRow && profileRow.privacy_settings);
    const location = profileRow ? {
      city: profileRow.city, district: profileRow.district, division: profileRow.division,
      country: profileRow.country, postal_code: profileRow.postal_code,
      place_id: profileRow.place_id,
      awaiting_confirmation: profileRow.location_needs_confirmation
    } : null;

    const sections = {
      account: user.rows[0] || null,
      profile: profileRow,
      privacySettings,
      location,
      consentHistory: consents.rows,
      donations: donations.rows,
      eventRegistrations: registrations.rows,
      eventRoles: eventPeople.rows,
      eventTaskAssignments: taskWork.rows,
      jobApplications: scrubAll(applications.rows),
      jobReferralRequests: referrals.rows,
      mentorships: mentorships.rows,
      chapterMemberships: memberships.rows,
      connections: connections.rows,
      stories: stories.rows,
      notifications: notifications.rows,
      identityVault: vault.rows,
      deletionRequests: deletions.rows
    };

    const countOf = (v) => Array.isArray(v) ? v.length : (v ? 1 : 0);

    const bundle = {
      export: {
        generatedAt: new Date().toISOString(),
        account: { id: uid, email: user.rows[0]?.email || null, name: user.rows[0]?.full_name || null },
        format,
        /* Named individually, with a count, so "empty" and "not included" are
           distinguishable — an export that simply omits a heading looks the
           same as one where the member has no rows. */
        includedSections: Object.entries(sections).map(([name, v]) => ({ name, records: countOf(v) })),
        /* §11: an export that leaves something out has to say so, and say why.
           Claiming completeness while withholding is the failure this list
           exists to prevent. */
        omittedSections: [
          { name: 'credentials',
            reason: 'Passwords, password hashes, session tokens and password-reset tokens are never exported. They are authentication material, not personal data a member needs returned.' },
          { name: 'identityVault.contents',
            reason: 'The encrypted value itself is withheld. Its presence, type and last four characters are included above. Releasing the plaintext is an administrator action that is separately authorised and separately audited; there is no self-service route to it.' },
          { name: 'auditTrail',
            reason: 'The hash-chained audit log records administrative actions across the institution and is retained as an institutional record. Entries naming this account are not extracted here.' },
          { name: 'otherMembers',
            reason: 'Where a record involves another member — the other side of a connection, a mentor, a job poster — only this account\'s side is included.' }
        ],
        note: 'This file contains the personal data this platform holds about the named account. It is produced by the application from its own database at the time shown above.'
      },
      ...sections
    };

    await writeAudit('DSAR Export', `user ${uid} exported their data as ${format.toUpperCase()}`, '📦');

    if (format === 'csv') {
      // Flatten each section into its own labelled block.
      const lines = [];
      for (const [section, value] of Object.entries(bundle)) {
        if (Array.isArray(value)) {
          lines.push(`# ${section}`);
          if (value.length) {
            lines.push(Object.keys(value[0]).join(','));
            value.forEach(r => lines.push(Object.values(r)
              .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
          }
          lines.push('');
        } else if (value && typeof value === 'object') {
          lines.push(`# ${section}`);
          lines.push(Object.keys(value).join(','));
          lines.push(Object.values(value).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
          lines.push('');
        }
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="dic_dsar_export_${uid}.csv"`);
      return res.send(lines.join('\n'));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="dic_dsar_export_${uid}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  }));

  /* ─── DSAR: ACCOUNT DELETION WITH 30-DAY GRACE ─── */

  app.post('/api/dsar/delete', requireAuth, (req, res) => ok(res, async () => {
    const existing = await db.query(
      `SELECT * FROM deletion_requests WHERE user_id=$1 AND status='pending'`, [req.user.uid]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'A deletion request is already pending', request: existing.rows[0] });
    }
    const row = await db.query(
      'INSERT INTO deletion_requests (user_id, reason) VALUES ($1,$2) RETURNING *',
      [req.user.uid, req.body?.reason || null]);

    await writeAudit('Account Deletion Requested',
      `user ${req.user.uid}; purge scheduled ${row.rows[0].purge_after}`, '⚠');
    await db.query(`INSERT INTO notifications (user_id, icon, title, subtitle) VALUES ($1,'⚠','Account Deletion Scheduled',$2)`,
      [req.user.uid, 'Your account is scheduled for deletion in 30 days. You can cancel any time before then.']);

    res.json({ success: true, request: row.rows[0] });
  }));

  app.get('/api/dsar/delete', requireAuth, (req, res) => ok(res, async () => {
    const row = await db.query(
      `SELECT * FROM deletion_requests WHERE user_id=$1 AND status='pending'`, [req.user.uid]);
    res.json(row.rows[0] || null);
  }));

  app.delete('/api/dsar/delete', requireAuth, (req, res) => ok(res, async () => {
    const row = await db.query(
      `UPDATE deletion_requests SET status='cancelled' WHERE user_id=$1 AND status='pending' RETURNING *`,
      [req.user.uid]);
    if (!row.rows.length) return res.status(404).json({ error: 'No pending deletion request' });
    await writeAudit('Account Deletion Cancelled', `user ${req.user.uid}`, '↩');
    res.json({ success: true });
  }));

  /* ─── COMPLIANCE STATUS ───
     Drives the admin panel pills from reality instead of hardcoded green. */

  app.get('/api/compliance/status', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const [vault, consents, deletions, audits, access] = await Promise.all([
      db.query('SELECT COUNT(*)::int n FROM identity_vault'),
      db.query('SELECT COUNT(*)::int n FROM consent_logs'),
      db.query(`SELECT COUNT(*)::int n FROM deletion_requests WHERE status='pending'`),
      /* Split by chain version rather than a bare COUNT(*). Entries written
         before the Phase 5A boundary are hash-chained in name only — the digest
         input was never persisted, so nobody can recompute them (AUDIT_CHAIN.md
         §1-2). Reporting one total would present them as carrying the same
         guarantee as verifiable rows, in the panel an administrator reads to
         judge exactly that. */
      db.query(`SELECT COUNT(*) FILTER (WHERE chain_version = ${auditChain.CHAIN_VERSION})::int AS verifiable,
                       COUNT(*) FILTER (WHERE chain_version IS DISTINCT FROM ${auditChain.CHAIN_VERSION})::int AS legacy
                FROM audit_logs`),
      db.query('SELECT COUNT(*)::int n FROM vault_access_logs')
    ]);

    res.json([
      {
        icon: '🔐', title: 'AES-256-GCM Field Encryption',
        desc: encryptionReady
          ? `Active. ${vault.rows[0].n} identity field(s) encrypted at the application layer.`
          : 'INACTIVE — ENCRYPTION_KEY is not configured. Identity storage is refused.',
        status: encryptionReady ? 'compliant' : 'at_risk'
      },
      {
        icon: '📜', title: 'Consent Logging (PDPA 2026)',
        desc: `${consents.rows[0].n} consent event(s) recorded with IP, timestamp and policy version.`,
        status: consents.rows[0].n > 0 ? 'compliant' : 'pending'
      },
      {
        icon: '🛡', title: 'Hash-Chained Audit Trail (CA 2023)',
        desc: `${audits.rows[0].verifiable} independently verifiable entries` +
              (audits.rows[0].legacy
                ? `; ${audits.rows[0].legacy} legacy entries retained but not verifiable`
                : '') +
              `; ${access.rows[0].n} vault access record(s).`,
        status: audits.rows[0].verifiable > 0 ? 'compliant' : 'pending'
      },
      {
        icon: '📦', title: 'Data Subject Rights (DSAR)',
        desc: `JSON/CSV export active. ${deletions.rows[0].n} deletion request(s) in the 30-day grace window.`,
        status: 'compliant'
      }
    ]);
  }));
};
