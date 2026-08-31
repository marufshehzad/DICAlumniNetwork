/* ============================================================
   DIC ALUMNI PLATFORM — ADMINISTRATOR ACCOUNTS

   Provisioning and lifecycle for institutional authority accounts. These are
   ordinary rows in `users`: one identity system, one login endpoint, one token
   format, one audit trail. Nothing here creates a parallel authentication path.

   Everything in this file is super_admin only. That is the point of the
   SUPER_ONLY tier: before it, a college administrator could have provisioned
   further administrators, because univ_admin and super_admin were
   interchangeable everywhere except /api/seed-db.

   Passwords are never returned in a listing, never written to a log, and never
   stored in plaintext. A generated password is shown exactly once, in the
   response to the request that created or reset it.
   ============================================================ */

const crypto = require('crypto');
const db = require('./db');

// 20 characters from an unambiguous alphabet — no O/0/I/l, because these get
// read aloud or copied off a screen.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%+=?';
  let out = '';
  while (out.length < 20) {
    for (const byte of crypto.randomBytes(32)) {
      if (byte < 248) { out += alphabet[byte % alphabet.length]; if (out.length === 20) break; }
    }
  }
  return out;
}

const initialsOf = (name) => String(name).trim().split(/\s+/)
  .map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/* Roles an administrator account may hold. `alumni` is absent deliberately:
   this endpoint provisions staff, and an alumnus arrives by self-registration
   or bulk import. super_admin is absent too — platform authority is not handed
   out through a form; it is set deliberately in the database. */
const ASSIGNABLE_ROLES = {
  moderator:  'Moderator',
  dept_admin: 'Department Admin',
  univ_admin: 'College Admin'
};

module.exports = function mountAdminUsers(app, guards) {
  const { requireRole, SUPER_ONLY, STAFF_ROLES, hashPassword, writeAudit, auditCtx, publicUser } = guards;
  const ok = (res, fn) => fn().catch(err => res.status(500).json({ error: err.message }));

  const SELECT_ADMIN = `
    SELECT u.id, u.full_name, u.initials, u.email, u.role, u.role_label, u.designation,
           u.department, u.phone, u.photo_url, u.status, u.is_verified,
           u.must_change_password, u.created_at, u.updated_at, u.last_login_at,
           u.last_password_changed_at, u.failed_login_count, u.locked_until,
           u.created_by, c.full_name AS created_by_name
    FROM users u
    LEFT JOIN users c ON c.id = u.created_by`;

  // Never includes password_hash or reset_token_hash.
  const shape = (r) => ({
    id: r.id, name: r.full_name, initials: r.initials, email: r.email,
    role: r.role, roleLabel: r.role_label, designation: r.designation,
    department: r.department, phone: r.phone, photoUrl: r.photo_url,
    status: r.status, verified: r.is_verified,
    mustChangePassword: r.must_change_password === true,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastLoginAt: r.last_login_at, lastPasswordChangedAt: r.last_password_changed_at,
    lockedUntil: r.locked_until, failedLoginCount: r.failed_login_count,
    createdBy: r.created_by, createdByName: r.created_by_name
  });

  /* ─── LIST ─────────────────────────────────────────────── */
  app.get('/api/admin/administrators', requireRole(...SUPER_ONLY), (req, res) => ok(res, async () => {
    const rows = await db.query(
      `${SELECT_ADMIN} WHERE u.role = ANY($1::text[]) ORDER BY u.full_name`,
      [STAFF_ROLES]);
    res.json({ administrators: rows.rows.map(shape), assignableRoles: ASSIGNABLE_ROLES });
  }));

  app.get('/api/admin/administrators/:id', requireRole(...SUPER_ONLY), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid administrator id' });
    const r = await db.query(`${SELECT_ADMIN} WHERE u.id = $1 AND u.role = ANY($2::text[])`,
      [id, STAFF_ROLES]);
    if (!r.rows.length) return res.status(404).json({ error: 'Administrator not found' });
    res.json(shape(r.rows[0]));
  }));

  /* ─── CREATE ───────────────────────────────────────────── */
  app.post('/api/admin/administrators', requireRole(...SUPER_ONLY), (req, res) => ok(res, async () => {
    const { fullName, designation, email, phone, photoUrl, department, role } = req.body || {};

    if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'Full name is required' });
    if (!designation || !String(designation).trim()) return res.status(400).json({ error: 'Designation is required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email address is required' });
    if (!ASSIGNABLE_ROLES[role]) {
      return res.status(400).json({
        error: 'Permission role must be one of: ' + Object.keys(ASSIGNABLE_ROLES).join(', ')
      });
    }

    const clean = String(email).trim().toLowerCase();
    const dup = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [clean]);
    if (dup.rows.length) return res.status(409).json({ error: 'An account with that email already exists' });

    // Generated here, hashed immediately, returned once and never persisted or
    // logged in plaintext.
    const password = generatePassword();

    const row = await db.query(`
      INSERT INTO users (email, password_hash, full_name, initials, role, role_label,
                         designation, department, phone, photo_url, icon,
                         is_verified, must_change_password, status, created_by,
                         created_via, last_password_changed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'shield',TRUE,TRUE,'active',$11,'admin_console',NOW())
      RETURNING id`,
      [clean, hashPassword(password), String(fullName).trim(), initialsOf(fullName),
       role, ASSIGNABLE_ROLES[role], String(designation).trim(),
       (department || '').trim() || 'DIC Administration',
       (phone || '').trim() || null, (photoUrl || '').trim() || null,
       req.user.uid]);

    const id = row.rows[0].id;
    await writeAudit('Administrator Created',
      `${String(fullName).trim()} <${clean}> as ${ASSIGNABLE_ROLES[role]} (${String(designation).trim()}) ` +
      `by user ${req.user.uid}`, '👤', auditCtx(req, 'user', id));

    const created = await db.query(`${SELECT_ADMIN} WHERE u.id = $1`, [id]);
    res.json({
      administrator: shape(created.rows[0]),
      // Shown once. The account is flagged must_change_password, so the holder
      // replaces it at first sign-in.
      temporaryPassword: password
    });
  }));

  /* ─── UPDATE ───────────────────────────────────────────── */
  app.put('/api/admin/administrators/:id', requireRole(...SUPER_ONLY), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid administrator id' });

    const existing = await db.query(
      'SELECT id, full_name, role, role_label, designation FROM users WHERE id = $1 AND role = ANY($2::text[])',
      [id, STAFF_ROLES]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Administrator not found' });
    const before = existing.rows[0];

    const { fullName, designation, phone, photoUrl, department, role } = req.body || {};
    const sets = [], vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (fullName !== undefined) {
      if (!String(fullName).trim()) return res.status(400).json({ error: 'Full name cannot be empty' });
      put('full_name', String(fullName).trim());
      put('initials', initialsOf(fullName));
    }
    if (designation !== undefined) {
      if (!String(designation).trim()) return res.status(400).json({ error: 'Designation cannot be empty' });
      put('designation', String(designation).trim());
    }
    if (phone !== undefined)      put('phone', String(phone).trim() || null);
    if (photoUrl !== undefined)   put('photo_url', String(photoUrl).trim() || null);
    if (department !== undefined) put('department', String(department).trim() || 'DIC Administration');

    let roleChanged = null;
    if (role !== undefined && role !== before.role) {
      if (!ASSIGNABLE_ROLES[role]) {
        return res.status(400).json({
          error: 'Permission role must be one of: ' + Object.keys(ASSIGNABLE_ROLES).join(', ')
        });
      }
      // A super admin cannot be demoted through this endpoint. Platform
      // authority is not administered from a form.
      if (before.role === 'super_admin') {
        return res.status(403).json({ error: 'A super admin role cannot be changed here' });
      }
      put('role', role);
      put('role_label', ASSIGNABLE_ROLES[role]);
      roleChanged = { from: before.role, to: role };
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    put('updated_at', new Date());
    vals.push(id);

    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

    await writeAudit('Administrator Updated',
      `${before.full_name} (user ${id}) by user ${req.user.uid}`, '✎', auditCtx(req, 'user', id));
    if (roleChanged) {
      await writeAudit('Administrator Role Changed',
        `${before.full_name} (user ${id}): ${roleChanged.from} → ${roleChanged.to} by user ${req.user.uid}`,
        '🔀', auditCtx(req, 'user', id));
    }

    const after = await db.query(`${SELECT_ADMIN} WHERE u.id = $1`, [id]);
    res.json(shape(after.rows[0]));
  }));

  /* ─── SUSPEND / ACTIVATE ───────────────────────────────── */
  app.put('/api/admin/administrators/:id/status', requireRole(...SUPER_ONLY), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid administrator id' });

    const status = req.body?.status;
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
    }
    // Locking yourself out of the only account that can unlock anything is not
    // a recoverable mistake.
    if (id === req.user.uid && status === 'suspended') {
      return res.status(400).json({ error: 'You cannot suspend your own account' });
    }

    /* Suspending also bumps token_version. attachUser() already refuses a
       suspended account on its next request, so this is belt and braces — but it
       means the tokens are dead even if the status is later flipped back, so
       reactivating does not silently revive somebody's old session. */
    /* $1 is cast because Postgres otherwise has to deduce one type for it from
       both the varchar assignment and the text comparison, and refuses:
       "inconsistent types deduced for parameter $1". */
    const r = await db.query(
      `UPDATE users SET status = $1::text, updated_at = NOW(),
                        token_version = token_version
                          + CASE WHEN $1::text = 'suspended' THEN 1 ELSE 0 END
        WHERE id = $2 AND role = ANY($3::text[]) RETURNING full_name`,
      [status, id, STAFF_ROLES]);
    if (!r.rows.length) return res.status(404).json({ error: 'Administrator not found' });

    /* Suspension is effective immediately: attachUser() reads users.status on
       every request, so an outstanding token stops working on its next use
       rather than when it expires. */
    await writeAudit(status === 'suspended' ? 'Administrator Suspended' : 'Administrator Activated',
      `${r.rows[0].full_name} (user ${id}) by user ${req.user.uid}`,
      status === 'suspended' ? '⛔' : '✅', auditCtx(req, 'user', id));

    res.json({ id, status, name: r.rows[0].full_name });
  }));

  /* ─── PASSWORD RESET ───────────────────────────────────── */
  app.post('/api/admin/administrators/:id/reset-password', requireRole(...SUPER_ONLY), (req, res) => ok(res, async () => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid administrator id' });

    const target = await db.query(
      'SELECT full_name FROM users WHERE id = $1 AND role = ANY($2::text[])', [id, STAFF_ROLES]);
    if (!target.rows.length) return res.status(404).json({ error: 'Administrator not found' });

    const password = generatePassword();
    /* Ends every session the holder had. Resetting a password because an
       account may be compromised is pointless if the attacker's existing token
       keeps working for the rest of the day. */
    await db.query(`
      UPDATE users
         SET password_hash = $1, must_change_password = TRUE,
             last_password_changed_at = NOW(), updated_at = NOW(),
             failed_login_count = 0, locked_until = NULL,
             reset_token_hash = NULL, reset_expires_at = NULL,
             token_version = token_version + 1
       WHERE id = $2`, [hashPassword(password), id]);

    // The action is audited; the password is not part of the audit entry.
    await writeAudit('Administrator Password Reset',
      `${target.rows[0].full_name} (user ${id}) by user ${req.user.uid}`, '🔑',
      auditCtx(req, 'user', id));

    res.json({ id, name: target.rows[0].full_name, temporaryPassword: password });
  }));
};

module.exports.ASSIGNABLE_ROLES = ASSIGNABLE_ROLES;
