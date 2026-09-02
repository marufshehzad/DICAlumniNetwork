/* ============================================================
   DIC ALUMNI PLATFORM — CREDENTIAL ROTATION

   Replaces known/default passwords with strong random ones, or with values
   supplied through the environment. Written because every seeded account —
   including super_admin — accepted the shared password '12345678', which was
   also published in README.md and shipped inside app.js.

   Usage
     node rotate_credentials.js              rotate privileged accounts only
     node rotate_credentials.js --all        also rotate the seeded alumni demo accounts
     node rotate_credentials.js --check      report which accounts still accept a weak password
     node rotate_credentials.js --lock       lock an account instead of setting a password

     node rotate_credentials.js --create-super-admin <email> [--name "Full Name"]
                                             create the FIRST administrator on a
                                             new deployment. Refuses if one exists.

   Supplying your own passwords (preferred for production) — set any of:
     ADMIN_PW_SUPER_ADMIN, ADMIN_PW_UNIV_ADMIN,
     ADMIN_PW_DEPT_ADMIN,  ADMIN_PW_MODERATOR
   Any role without an environment variable gets a generated 24-character
   password.

   Passwords are never printed to stdout and never written to a log. Generated
   values are written once to  admin-credentials.local.txt  (gitignored), with
   file permissions restricted where the platform supports it. Delete that file
   once you have stored the values in your password manager.
   ============================================================ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const ROTATE_ALL = process.argv.includes('--all');
const CHECK_ONLY = process.argv.includes('--check');
const LOCK_MODE = process.argv.includes('--lock');

/* --create-super-admin <email> — the first administrator on a fresh database.

   Phase 6 installed the platform from scratch and found there was no way to get
   one. A production install is told not to run seed.sql, so the users table is
   empty; this script only ever SELECTed existing rows, so it reported
   "accounts: 0, nothing to rotate"; and every provisioning route is
   requireRole(SUPER_ONLY), so the portal cannot create the account that would be
   needed to use the portal. The platform could be installed and then not signed
   into by anybody.

   Deliberately narrow: it refuses when a super_admin already exists, so it
   cannot quietly mint a second one on a running deployment. */
const CREATE_SUPER = process.argv.includes('--create-super-admin');
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v && !v.startsWith('--') ? v.trim() : null;
};
const argEmail = (argAfter('--create-super-admin') || '').toLowerCase() || null;
const argName = argAfter('--name');

const OUT_FILE = path.join(__dirname, 'admin-credentials.local.txt');
const WEAK_PASSWORDS = ['12345678', 'password', 'admin', '123456', 'changeme'];
const PRIVILEGED = ['super_admin', 'univ_admin', 'dept_admin', 'moderator'];

const ENV_BY_ROLE = {
  super_admin: 'ADMIN_PW_SUPER_ADMIN',
  univ_admin: 'ADMIN_PW_UNIV_ADMIN',
  dept_admin: 'ADMIN_PW_DEPT_ADMIN',
  moderator: 'ADMIN_PW_MODERATOR'
};

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (stored.startsWith('LOCKED$')) return false;
  if (!stored.startsWith('scrypt$')) {
    const a = Buffer.from(String(plain));
    const b = Buffer.from(String(stored));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [, salt, expected] = stored.split('$');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 24 chars from an unambiguous alphabet — no O/0/I/l to mistype over the phone.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%+=?';
  let out = '';
  while (out.length < 24) {
    const b = crypto.randomBytes(32);
    for (const byte of b) {
      if (byte < 248) { out += alphabet[byte % alphabet.length]; if (out.length === 24) break; }
    }
  }
  return out;
}

const mask = (e) => {
  const [u, d] = String(e).split('@');
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(u.length - 2)) + '@' + d;
};

async function createFirstSuperAdmin() {
  if (!argEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(argEmail)) {
    console.error('\n  Usage: node rotate_credentials.js --create-super-admin <email> [--name "Full Name"]\n');
    process.exitCode = 2;
    return;
  }

  const existing = await db.query("SELECT id FROM users WHERE role = 'super_admin'");
  if (existing.rows.length) {
    console.error(`\n  Refused: a super_admin already exists (id ${existing.rows[0].id}).`);
    console.error('  This command is for the first administrator on a new deployment only.');
    console.error('  To add another, sign in and use the staff portal.\n');
    process.exitCode = 1;
    return;
  }

  const dup = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [argEmail]);
  if (dup.rows.length) {
    console.error(`\n  Refused: that address already has an account (id ${dup.rows[0].id}).\n`);
    process.exitCode = 1;
    return;
  }

  const supplied = process.env.ADMIN_PW_SUPER_ADMIN;
  if (supplied && supplied.length < 12) {
    console.error('\n  Refused: ADMIN_PW_SUPER_ADMIN must be at least 12 characters.\n');
    process.exitCode = 2;
    return;
  }

  const password = supplied || generatePassword();
  const name = argName || 'DIC Super Administrator';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'SA';

  /* must_change_password is TRUE whether the password was generated or supplied:
     in both cases somebody other than the account holder has seen it. The
     enrolment gate then restricts the first session to changing it. */
  const r = await db.query(
    `INSERT INTO users (email, password_hash, full_name, initials, role, role_label,
                        department, is_verified, must_change_password, created_via)
     VALUES ($1,$2,$3,$4,'super_admin','Super Admin','Administration',TRUE,TRUE,'bootstrap')
     RETURNING id`,
    [argEmail, hashPassword(password), name, initials]);
  const uid = r.rows[0].id;

  await db.query(
    `INSERT INTO alumni_profiles (user_id, student_id, batch, passing_year, department, primary_email)
     VALUES ($1,$2,$3,$3,'Administration',$4) ON CONFLICT DO NOTHING`,
    [uid, `DIC-ADMIN-${uid}`, new Date().getFullYear(), argEmail]);

  if (!supplied) {
    fs.writeFileSync(OUT_FILE,
      'DIC Alumni Platform \u2014 first administrator\n' +
      'Written ' + new Date().toISOString() + '\n' +
      'This account must set its own password at first sign-in.\n' +
      'Store this in the institution password manager, then DELETE this file.\n' +
      'This file is gitignored and must never be committed.\n\n' +
      `super_admin  ${argEmail}  ${password}\n`, { mode: 0o600 });
    try { fs.chmodSync(OUT_FILE, 0o600); } catch { /* not supported on this filesystem */ }
  }

  console.log('\n=== FIRST ADMINISTRATOR CREATED ===');
  console.log(`  id     ${uid}`);
  console.log(`  email  ${mask(argEmail)}`);
  console.log('  role   super_admin');
  console.log(supplied
    ? '  password: the value supplied in ADMIN_PW_SUPER_ADMIN'
    : `  password: written once to ${path.basename(OUT_FILE)} \u2014 move it to the password manager, then delete that file`);
  console.log('  It must change that password before the account can do anything else.\n');
}

(async () => {
  try {
    if (CREATE_SUPER) {
      await createFirstSuperAdmin();
      await db.pool.end();
      return;
    }

    const users = (await db.query(
      'SELECT id, email, role, full_name, password_hash FROM users ORDER BY id')).rows;

    const weak = users.filter(u => WEAK_PASSWORDS.some(p => verifyPassword(p, u.password_hash)));
    const locked = users.filter(u => String(u.password_hash).startsWith('LOCKED$'));

    console.log('\n=== CREDENTIAL AUDIT ===');
    console.log(`  accounts:            ${users.length}`);
    console.log(`  accept a weak/default password: ${weak.length}`);
    console.log(`  locked (cannot sign in):        ${locked.length}`);
    if (weak.length) {
      console.log('\n  accounts needing rotation:');
      weak.forEach(u => console.log(`    ${String(u.id).padStart(3)}  ${u.role.padEnd(12)} ${mask(u.email)}`));
    }

    if (CHECK_ONLY) {
      console.log('\n  --check only, nothing changed.\n');
      await db.pool.end();
      return;
    }

    const targets = weak.filter(u => ROTATE_ALL || PRIVILEGED.includes(u.role));
    if (!targets.length) {
      console.log('\n  Nothing to rotate. All targeted accounts already have a strong password.\n');
      await db.pool.end();
      return;
    }

    if (LOCK_MODE) {
      for (const u of targets) {
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2',
          ['LOCKED$rotated-' + crypto.randomBytes(8).toString('hex'), u.id]);
      }
      console.log(`\n  Locked ${targets.length} account(s). They cannot sign in until rotated.\n`);
      await db.pool.end();
      return;
    }

    const issued = [];
    for (const u of targets) {
      const envVar = ENV_BY_ROLE[u.role];
      const fromEnv = envVar ? process.env[envVar] : null;

      if (fromEnv && fromEnv.length < 12) {
        throw new Error(`${envVar} is shorter than 12 characters — refusing to set a weak password.`);
      }
      const password = fromEnv || generatePassword();

      await db.query(
        'UPDATE users SET password_hash = $1, must_change_password = $2 WHERE id = $3',
        [hashPassword(password), !fromEnv, u.id]);

      issued.push({ id: u.id, email: u.email, role: u.role, name: u.full_name, password, generated: !fromEnv });
    }

    const generated = issued.filter(i => i.generated);
    if (generated.length) {
      const body =
        'DIC Alumni Platform — generated credentials\n' +
        'Written ' + new Date().toISOString() + '\n' +
        'These accounts are flagged must_change_password: the holder is prompted\n' +
        'to set their own password at first sign-in.\n' +
        'Store these in a password manager, then DELETE this file.\n' +
        'This file is gitignored and must never be committed.\n\n' +
        generated.map(i =>
          `${i.role.padEnd(12)} ${i.email.padEnd(32)} ${i.password}`).join('\n') + '\n';
      fs.writeFileSync(OUT_FILE, body, { mode: 0o600 });
      try { fs.chmodSync(OUT_FILE, 0o600); } catch { /* not supported on this filesystem */ }
    }

    console.log('\n=== ROTATION COMPLETE ===');
    issued.forEach(i => console.log(
      `  ${String(i.id).padStart(3)}  ${i.role.padEnd(12)} ${mask(i.email).padEnd(32)} ` +
      (i.generated ? 'generated' : `from ${ENV_BY_ROLE[i.role]}`)));
    console.log(`\n  ${issued.length} account(s) rotated.`);
    if (generated.length) {
      console.log(`  ${generated.length} generated password(s) written to admin-credentials.local.txt`);
      console.log('  Passwords are NOT printed here. Read that file, store them, then delete it.');
    }
    console.log('');

    await db.pool.end();
  } catch (err) {
    console.error('\n✗ Rotation failed:', err.message, '\n');
    try { await db.pool.end(); } catch { /* pool may already be closed */ }
    process.exitCode = 1;
  }
})();
