/* ============================================================
   DIC ALUMNI PLATFORM — OUTBOUND EMAIL

   Password recovery was designed correctly in Phase 2C — hashed single-use
   tokens, a 30-minute life, a uniform response that reveals nothing about
   whether an address exists — and then had nowhere to send the link. Delivery
   depended on an operator with shell access running reset_link.js. Fine for
   the super admin; useless for a vice principal locked out at 9pm.

   This is the transport. It stays deliberately small: one provider, one
   template, no queue, no retry storm. If a send fails, the caller still
   returns the same uniform response to the browser — a mail outage must not
   become a way to discover which addresses are registered.

   MAIL_TRANSPORT decides what happens to a message:
     smtp     a real SMTP server (required in production unless overridden)
     console  writes the message to the log instead of sending — development
              only, and it says so loudly on every send
     none     accepts and drops, for a deployment that has consciously chosen
              to keep the operator CLI as the only recovery path
   ============================================================ */

const nodemailer = require('nodemailer');

const MODE = (process.env.MAIL_TRANSPORT || '').toLowerCase() ||
             (process.env.SMTP_HOST ? 'smtp' : 'console');

const CONFIG = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASSWORD || '',
  from: process.env.SMTP_FROM || 'DIC Alumni Network <no-reply@localhost>'
};

// Configured means "could actually send", not "somebody set a variable".
const smtpReady = MODE === 'smtp' && !!CONFIG.host && !!CONFIG.from;

let transport = null;
function getTransport() {
  if (!smtpReady) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: CONFIG.host,
      port: CONFIG.port,
      // 465 is implicit TLS; everything else negotiates STARTTLS.
      secure: CONFIG.port === 465,
      auth: CONFIG.user ? { user: CONFIG.user, pass: CONFIG.pass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }
  return transport;
}

/* What production must have before it is allowed to boot. Returned rather
   than thrown so server.js can report every missing secret at once. */
function missingMailConfig() {
  if (MODE === 'none' || MODE === 'console') return [];   // an explicit choice
  const missing = [];
  if (!CONFIG.host) missing.push('SMTP_HOST');
  if (!CONFIG.from) missing.push('SMTP_FROM');
  return missing;
}

function status() {
  return {
    mode: MODE,
    ready: MODE === 'none' ? true : (MODE === 'console' ? true : smtpReady),
    // The host is operational detail an admin needs; the password is never
    // read back out of here.
    host: MODE === 'smtp' ? (CONFIG.host || null) : null,
    from: MODE === 'smtp' ? CONFIG.from : null
  };
}

/* Sends, and reports whether it went. Never throws: every caller is on a path
   where the response must not vary with mail health. */
async function send({ to, subject, text }) {
  if (MODE === 'none') {
    console.log(`[mail] dropped (MAIL_TRANSPORT=none): "${subject}" for ${maskEmail(to)}`);
    return { sent: false, mode: MODE };
  }

  if (MODE === 'console' || !smtpReady) {
    /* Development. The body is printed because a developer needs the link,
       and the banner exists so nobody mistakes a log line for a delivery. */
    console.log('\n' + '─'.repeat(64));
    console.log('  MAIL NOT SENT — MAIL_TRANSPORT=console (development only)');
    console.log('  To:      ' + to);
    console.log('  Subject: ' + subject);
    console.log('─'.repeat(64));
    console.log(text);
    console.log('─'.repeat(64) + '\n');
    return { sent: false, mode: 'console' };
  }

  try {
    await getTransport().sendMail({ from: CONFIG.from, to, subject, text });
    // The address is masked: a mail log should not become a member directory.
    console.log(`[mail] sent "${subject}" to ${maskEmail(to)}`);
    return { sent: true, mode: 'smtp' };
  } catch (e) {
    // The reason matters to an operator; it must not reach the browser, and
    // it must never carry the message body (which holds the reset link).
    console.error(`[mail] FAILED "${subject}" to ${maskEmail(to)}: ${e.message}`);
    return { sent: false, mode: 'smtp', error: e.message };
  }
}

function maskEmail(addr) {
  const s = String(addr || '');
  const at = s.indexOf('@');
  if (at < 2) return '***';
  return s.slice(0, 2) + '***' + s.slice(at);
}

/* The one template. Plain text on purpose: it renders everywhere, cannot
   carry a tracking pixel, and there is nothing here that HTML would improve. */
function passwordResetMessage({ name, url, minutes }) {
  return {
    subject: 'Reset your DIC Alumni Network password',
    text:
`Hello ${name || 'there'},

Someone asked to reset the password for this DIC Alumni Network account.

Open this link to choose a new one:

${url}

The link works once and expires in ${minutes} minutes.

If you did not ask for this, you can ignore this message — your password has
not changed and nobody has been told whether this address is registered.

Daffodil International College — Alumni Network
This is an automated message; replies are not monitored.`
  };
}

module.exports = { send, status, missingMailConfig, passwordResetMessage, maskEmail, MODE };
