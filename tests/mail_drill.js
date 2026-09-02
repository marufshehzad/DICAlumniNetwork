#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — PASSWORD RESET DELIVERY DRILL

   Proves that a password-reset email is actually delivered over SMTP, by
   standing up a real SMTP server, pointing the application at it, asking for a
   reset through the public endpoint, and reading the message that arrives.

   WHAT THIS PROVES: the whole path. nodemailer opens a TCP connection, speaks
   SMTP, and a message arrives with the right sender, a subject that identifies
   the platform, and a link that works — and the link then resets the password,
   once, and only once.

   WHAT THIS DOES NOT PROVE: that a third party will accept the message.
   Deliverability — SPF, DKIM, DMARC, and whether a provider decides the mail is
   spam — depends on DIC's domain and mail account, and no drill on a developer
   machine can establish it. That remains an external dependency, recorded in
   PRODUCTION_HANDOVER_CHECKLIST.md.

   The SMTP server here is a few dozen lines of `net` rather than a dependency:
   the platform has five runtime dependencies and this is a test.

   Usage:  node tests/mail_drill.js
   ============================================================ */

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'db'));

const SMTP_PORT = 8470 + (process.pid % 40);
const APP_PORT = 8510 + (process.pid % 40);
const TAG = 'p6-mail';

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const head = (t) => console.log('\n' + t);

/* ── a real, minimal SMTP server ───────────────────────────────────────────
   Enough of RFC 5321 for nodemailer to complete a transaction: greeting,
   EHLO, MAIL FROM, RCPT TO, DATA terminated by a lone dot, QUIT. It captures
   the envelope and the message so the drill can read what was actually sent
   rather than what the application says it sent. */
const inbox = [];
function startSmtp() {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      let buf = '', inData = false, msg = { from: null, to: [], data: '' };
      socket.write('220 drill.smtp ESMTP ready\r\n');
      socket.on('data', chunk => {
        buf += chunk.toString('utf8');
        for (;;) {
          const i = buf.indexOf('\r\n');
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              inbox.push({ ...msg, receivedAt: new Date().toISOString() });
              msg = { from: null, to: [], data: '' };
              socket.write('250 2.0.0 Ok: queued\r\n');
            } else {
              msg.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
            }
            continue;
          }

          const cmd = line.toUpperCase();
          if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
            // No STARTTLS and no AUTH advertised: this is a loopback drill, and
            // nodemailer will proceed in plaintext rather than requiring either.
            socket.write('250-drill.smtp\r\n250 8BITMIME\r\n');
          } else if (cmd.startsWith('MAIL FROM')) {
            msg.from = (line.match(/<([^>]*)>/) || [])[1] || line.slice(10);
            socket.write('250 2.1.0 Ok\r\n');
          } else if (cmd.startsWith('RCPT TO')) {
            msg.to.push((line.match(/<([^>]*)>/) || [])[1] || line.slice(8));
            socket.write('250 2.1.5 Ok\r\n');
          } else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n'); socket.end();
          } else if (cmd === 'RSET' || cmd.startsWith('NOOP')) {
            socket.write('250 2.0.0 Ok\r\n');
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }
        }
      });
      socket.on('error', () => { /* the client hanging up is not interesting */ });
    });
    server.listen(SMTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

/* Decode quoted-printable before reading the body.

   The template contains an em-dash, so nodemailer encodes the message as
   quoted-printable — in which '=' becomes '=3D' and any line over 76 characters
   is soft-wrapped with a trailing '='. Both apply to the reset URL: '?reset='
   arrives as '?reset=3D', and a 43-character token pushes the line past the
   limit so it is split in two.

   A mail client undoes both, which is why a real recipient's link works. A test
   that reads the raw SMTP stream has to undo them itself, or it will extract a
   token beginning '3D' and conclude the product is broken when it is not. */
function decodeQuotedPrintable(body) {
  return body
    .replace(new RegExp('=\\r?\\n', 'g'), '')                  // soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const api = async (p, o = {}) => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});

(async () => {
  console.log(`\nPassword-reset delivery drill  (smtp :${SMTP_PORT}, app :${APP_PORT})`);

  const smtp = await startSmtp();
  ok('a real SMTP server is listening', smtp.listening);

  // A throwaway member to receive the reset.
  const email = `${TAG}-subject@dic.test`;
  await db.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%`]);

  const PUBLIC_ORIGIN = 'https://alumni.drill.test';
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      NODE_ENV: 'development',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(SMTP_PORT),
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      SMTP_FROM: 'DIC Alumni Network <no-reply@alumni.drill.test>',
      PUBLIC_ORIGIN
    }
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  await new Promise(r => setTimeout(r, 4500));
  ok('the application started with MAIL_TRANSPORT=smtp', /API Server running/.test(log));

  const reg = await post('/api/auth/register', {
    name: 'Mail Drill', email, password: 'Mail-Drill-Pw1',
    hscPassingYear: 2018, hscGroup: 'Science'
  });
  ok('a member exists to reset', reg.status === 200, JSON.stringify(reg.body).slice(0, 90));

  head('=== A. The reset email is actually delivered ===');
  const before = inbox.length;
  const asked = await post('/api/auth/forgot-password', { email });
  ok('the reset request is accepted', asked.status === 200, JSON.stringify(asked.body).slice(0, 80));

  // Give the SMTP transaction a moment to complete.
  for (let i = 0; i < 40 && inbox.length === before; i++) await new Promise(r => setTimeout(r, 250));
  ok('a message ARRIVED at the SMTP server', inbox.length > before, `${inbox.length} message(s)`);

  const raw = inbox[inbox.length - 1] || { data: '', to: [], from: '' };
  const mail = { ...raw, data: decodeQuotedPrintable(raw.data) };
  ok('the message is transfer-encoded, and decodes cleanly',
    /quoted-printable|7bit|base64/i.test(raw.data), 'no Content-Transfer-Encoding');
  ok('addressed to the member who asked', mail.to.includes(email), mail.to.join(','));
  ok('sent from the configured sender', /no-reply@alumni\.drill\.test/.test(mail.from + mail.data),
    mail.from);
  ok('the subject identifies the platform and the purpose',
    /Subject:.*DIC Alumni Network password/i.test(mail.data),
    (mail.data.match(/Subject:.*/) || [''])[0]);
  ok('the body names DIC', /DIC/.test(mail.data));
  ok('the body states the expiry', /\b30\b.*minute|minute.*\b30\b/i.test(mail.data));

  const link = (mail.data.match(/https?:\/\/\S*reset=[A-Za-z0-9_-]+/) || [])[0];
  ok('the body carries a reset link on the configured public origin',
    !!link && link.startsWith(PUBLIC_ORIGIN), String(link).slice(0, 60));

  head('=== B. The token in that email works, once ===');
  const token = link ? (link.match(/reset=([A-Za-z0-9_-]+)/) || [])[1] : null;
  ok('a token was extracted', !!token, String(token).slice(0, 12) + '…');

  const stored = await db.query(
    'SELECT reset_token_hash, reset_expires_at FROM users WHERE email=$1', [email]);
  ok('the token is stored HASHED, never in the clear',
    !!stored.rows[0]?.reset_token_hash && stored.rows[0].reset_token_hash !== token,
    String(stored.rows[0]?.reset_token_hash).slice(0, 16) + '…');
  const minutes = stored.rows[0]?.reset_expires_at
    ? (new Date(stored.rows[0].reset_expires_at) - Date.now()) / 60000 : -1;
  ok('it expires in about 30 minutes', minutes > 25 && minutes <= 31, `${Math.round(minutes)} min`);

  const used = await post('/api/auth/reset-password', { token, newPassword: 'Mail-Drill-Chosen-1' });
  ok('the link resets the password', used.status === 200, JSON.stringify(used.body).slice(0, 80));
  const reused = await post('/api/auth/reset-password', { token, newPassword: 'Mail-Drill-Again-1' });
  ok('the same token cannot be used twice', reused.status >= 400, String(reused.status));
  const signIn = await post('/api/auth/login', { email, password: 'Mail-Drill-Chosen-1' });
  ok('the new password works', signIn.status === 200);

  head('=== C. The reset token never reaches a log ===');
  ok('the token does not appear in the server log', !log.includes(token), 'token found in log');
  ok('the full link does not appear in the server log', !link || !log.includes(link));
  ok('the recipient address is masked in the mail log',
    !/\[mail\] sent .*p6-mail-subject@dic\.test/.test(log),
    (log.match(/\[mail\][^\n]*/) || [''])[0].slice(0, 80));
  ok('a send IS recorded, masked', /\[mail\] sent/.test(log), (log.match(/\[mail\][^\n]*/) || [''])[0]);

  head('=== D. The endpoint does not reveal who has an account ===');
  const known = await post('/api/auth/forgot-password', { email });
  const unknown = await post('/api/auth/forgot-password', { email: `${TAG}-nobody@dic.test` });
  ok('same status for a known and an unknown address', known.status === unknown.status,
    `${known.status} vs ${unknown.status}`);
  ok('same body for a known and an unknown address',
    JSON.stringify(known.body) === JSON.stringify(unknown.body),
    `${JSON.stringify(known.body)} vs ${JSON.stringify(unknown.body)}`);
  const mailsForUnknown = inbox.filter(m => m.to.includes(`${TAG}-nobody@dic.test`)).length;
  ok('no message is sent for an address with no account', mailsForUnknown === 0);

  head('=== E. Cleanup ===');
  try { srv.kill('SIGKILL'); } catch {}
  smtp.close();
  await db.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%`]);
  ok('the drill account was removed',
    (await db.query('SELECT count(*)::int n FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows[0].n === 0);

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('  Note: this proves delivery over SMTP. Deliverability to a real');
  console.log('  provider (SPF/DKIM/DMARC) needs DIC\'s domain and mail account.');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nDRILL ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(2);
});
