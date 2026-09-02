#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — OFF-SITE BACKUP COPY

   A backup that lives only on the machine it was taken from does not survive
   the failure it exists for. This copies the newest dump somewhere else, and
   leaves a receipt so a monitor can tell whether it happened.

   PROVIDER-AGNOSTIC BY DESIGN. This file contains no vendor SDK, no bucket
   name and no credential. It shells out to a command the deployment supplies:

     OFFSITE_CMD   the command that ships one file. It receives the dump's
                   path as {file} and its basename as {name}, substituted into
                   the string. Everything the command needs to authenticate —
                   a profile, a token, an ssh key — is the deployment's to
                   configure in the environment the command runs in.

   Worked examples. Pick the one that matches where DIC actually keeps things;
   none of them is enabled by default.

     S3-compatible object storage (AWS, Backblaze B2, Wasabi, MinIO):
       OFFSITE_CMD='aws s3 cp {file} s3://dic-alumni-backups/{name} --sse AES256'

     Any host reachable over ssh:
       OFFSITE_CMD='scp -q {file} backups@offsite.example:/srv/dic/{name}'

     rclone, which speaks most consumer and institutional cloud storage:
       OFFSITE_CMD='rclone copyto {file} dic-remote:alumni-backups/{name}'

   ENCRYPTION. A dump contains every alumnus's personal data in plaintext, plus
   the identity vault's ciphertext. Storage-side encryption is the usual answer
   (S3 SSE above, or an encrypted volume). If the destination cannot provide it,
   set OFFSITE_ENCRYPT_CMD to encrypt before sending — for example

     OFFSITE_ENCRYPT_CMD='gpg --batch --yes --encrypt --recipient backups@dic --output {out} {file}'

   and the encrypted file is what gets shipped. Whoever holds the decryption key
   must not be the same person who holds only the backups, or the pair is
   useless; see OPERATIONS_RUNBOOK.md section I.

   Usage:  node offsite.js            copy the newest dump
           node offsite.js --check    report configuration and last result only
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

require('./db');                       // one .env drives the whole platform

const DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const CMD = (process.env.OFFSITE_CMD || '').trim();
const ENCRYPT_CMD = (process.env.OFFSITE_ENCRYPT_CMD || '').trim();
const RECEIPT = path.join(DIR, 'last-offsite.json');
const CHECK_ONLY = process.argv.includes('--check');

const log = (...a) => console.log(...a);

function writeReceipt(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(RECEIPT, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[offsite] could not write the receipt: ' + e.message);
  }
}

function newestDump() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR)
    // The plain dump only: an encrypted copy is transient and is never the source.
    .filter(f => /^dic_alumni_.*\.sql$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(DIR, files[0].f) : null;
}

/* The command is run through the shell because the examples above are shell
   one-liners, which is what an operator will paste. It is therefore
   configuration a server administrator writes, exactly like a crontab line —
   not anything a user of the platform can influence. Nothing from the database
   or from a request reaches it; the only substitutions are a filename this
   script generated and its basename. */
function shell(cmd, label) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 30 * 60 * 1000 });
  if (r.error || r.status !== 0) {
    const why = (r.error && r.error.message) ||
                String(r.stderr || '').trim().split('\n').slice(-3).join(' ') ||
                `${label} exited ${r.status}`;
    return { ok: false, why: why.slice(0, 300) };
  }
  return { ok: true };
}

function status() {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')); } catch { /* none yet */ }
  return {
    configured: !!CMD,
    encrypts: !!ENCRYPT_CMD,
    known: !!last,
    ...(last ? {
      status: last.status,
      finishedAt: last.finishedAt,
      ageHours: Math.round(((Date.now() - new Date(last.finishedAt).getTime()) / 3600000) * 10) / 10,
      name: last.name,
      error: last.error
    } : {})
  };
}

function run() {
  const started = new Date();

  if (!CMD) {
    /* Not an error, and deliberately not silent. A deployment with no off-site
       destination has one copy of its data, and somebody chose that. It should
       be a recorded decision rather than something nobody noticed. */
    log('[offsite] OFFSITE_CMD is not set — the backup stays on this machine only.');
    log('[offsite] See OPERATIONS_RUNBOOK.md section D for what to set it to.');
    writeReceipt({ status: 'not-configured', finishedAt: started.toISOString() });
    return 0;
  }

  const dump = newestDump();
  if (!dump) {
    log('[offsite] FAILED: there is no dump to copy. Has backup.js run?');
    writeReceipt({ status: 'failed', startedAt: started.toISOString(),
                   finishedAt: new Date().toISOString(), error: 'no dump found in ' + DIR });
    return 1;
  }

  let toSend = dump;
  let temp = null;

  if (ENCRYPT_CMD) {
    /* .enc, not .gpg: the command is the deployment's choice and may be gpg,
       openssl, age or something else. The extension should not claim a tool. */
    temp = dump + '.enc';
    const enc = shell(ENCRYPT_CMD.replace(/\{file\}/g, JSON.stringify(dump))
                                 .replace(/\{out\}/g, JSON.stringify(temp)), 'encrypt');
    if (!enc.ok || !fs.existsSync(temp)) {
      log('[offsite] FAILED at the encryption step: ' + (enc.why || 'no output file'));
      writeReceipt({ status: 'failed', startedAt: started.toISOString(),
                     finishedAt: new Date().toISOString(), stage: 'encrypt',
                     error: (enc.why || 'no output file').slice(0, 300) });
      return 1;
    }
    toSend = temp;
    log('[offsite] encrypted -> ' + path.basename(temp));
  }

  const name = path.basename(toSend);
  log(`[offsite] shipping ${name} (${(fs.statSync(toSend).size / 1048576).toFixed(1)} MB)`);

  const sent = shell(CMD.replace(/\{file\}/g, JSON.stringify(toSend))
                        .replace(/\{name\}/g, name), 'offsite command');

  // The encrypted copy is a transient; the plain dump stays for local restores.
  if (temp && fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* leave it */ } }

  if (!sent.ok) {
    log('[offsite] FAILED: ' + sent.why);
    log('[offsite] a failed off-site copy is an incident — see OPERATIONS_RUNBOOK.md section D');
    writeReceipt({ status: 'failed', startedAt: started.toISOString(),
                   finishedAt: new Date().toISOString(), name, error: sent.why });
    return 1;
  }

  log('[offsite] ok');
  writeReceipt({ status: 'ok', startedAt: started.toISOString(),
                 finishedAt: new Date().toISOString(), name,
                 encrypted: !!ENCRYPT_CMD });
  return 0;
}

module.exports = { status, newestDump, RECEIPT };

if (require.main === module) {
  if (CHECK_ONLY) {
    const s = status();
    log('\n=== OFF-SITE BACKUP ===');
    log(`  configured:  ${s.configured ? 'yes' : 'NO — backups stay on this machine'}`);
    log(`  encrypts:    ${s.encrypts ? 'yes, before sending' : 'no — the destination must encrypt at rest'}`);
    log(s.known ? `  last result: ${s.status}${s.ageHours !== undefined ? ` (${s.ageHours}h ago)` : ''}`
                : '  last result: never run');
    if (s.error) log(`  last error:  ${s.error}`);
    log('');
    process.exit(0);
  }
  process.exit(run());
}
