/* ============================================================
   DIC ALUMNI PLATFORM — ISSUE A PASSWORD RESET LINK

   The recovery path for an administrator who cannot sign in — including the
   super admin, who has nobody above them to click "Reset password".

   Why a command-line tool rather than the web endpoint handing the link back:
   there is no mail transport configured. POST /api/auth/forgot-password creates
   the token but deliberately does not return it, because returning it would let
   anyone who knows an address take over that account. Until SMTP exists, the
   link has to travel over a channel that proves who is asking, and server access
   is the only one this deployment has. That is the same trust boundary
   rotate_credentials.js already relies on.

   The link is written to reset-link.local.txt (gitignored, mode 0600) and never
   printed to the console, so it cannot end up in a terminal scrollback, a CI log
   or a screen recording.

   Usage:
     node reset_link.js --email principal@dic.edu.bd
     node reset_link.js --email principal@dic.edu.bd --base https://admin.dic.edu.bd
   ============================================================ */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const app = require('./server');

const OUT_FILE = path.join(__dirname, 'reset-link.local.txt');

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
};

const mask = (e) => {
  const [u, d] = String(e).split('@');
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(u.length - 2)) + '@' + d;
};

(async () => {
  const email = (arg('email') || '').trim().toLowerCase();
  const base = (arg('base') || process.env.ADMIN_ORIGIN || 'http://localhost:8000')
    .replace(/\/$/, '');

  if (!email) {
    console.error('\n  Usage: node reset_link.js --email <address> [--base https://admin.example.edu]\n');
    await db.pool.end();
    process.exitCode = 1;
    return;
  }

  try {
    const r = await db.query(
      'SELECT id, full_name, role, status FROM users WHERE LOWER(email) = $1', [email]);

    if (!r.rows.length) {
      console.error(`\n  No account found for ${mask(email)}.\n`);
      process.exitCode = 1;
      return;
    }
    const user = r.rows[0];
    if (user.status !== 'active') {
      console.error(`\n  ${mask(email)} is ${user.status}. Reactivate the account first;\n` +
                    '  recovering a suspended account is an administrator decision.\n');
      process.exitCode = 1;
      return;
    }

    const token = await app.issueResetToken(user.id);
    const link = `${base}/admin?reset=${token}`;

    const body =
      'DIC Alumni Platform — password reset link\n' +
      'Issued ' + new Date().toISOString() + '\n' +
      'Account: ' + user.full_name + ' <' + email + '> (' + user.role + ')\n\n' +
      'This link is single-use and expires 30 minutes after it was issued.\n' +
      'Give it to the account holder over a channel you trust, then delete this\n' +
      'file. It is gitignored and must never be committed.\n\n' +
      link + '\n';

    fs.writeFileSync(OUT_FILE, body, { mode: 0o600 });
    try { fs.chmodSync(OUT_FILE, 0o600); } catch { /* not supported on this filesystem */ }

    console.log('\n  Reset link issued for ' + mask(email) + ' (' + user.role + ')');
    console.log('  Written to reset-link.local.txt — the link is NOT printed here.');
    console.log('  Valid for 30 minutes, single use. Delete the file once delivered.\n');
  } catch (err) {
    console.error('\n  Failed:', err.message, '\n');
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
