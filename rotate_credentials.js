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

(async () => {
  try {
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
