#!/usr/bin/env node
const path = require('path');
const REPO = path.join(__dirname, '..');
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 5D hardening regressions

   Pins the P0/P1 fixes from POST_PHASE5B_WHOLE_SYSTEM_AUDIT.md:

     P5C-001  CSV values rendered raw into the administrator's DOM.
     P5C-002  README describing fields and privacy levels that do not exist.
     P5C-003  /api/stories answering without a session and exposing author_id.
     P5C-025  esc() called in the import success screen and never defined.
     P5C-026  HEADER_RULES auto-mapping fields IMPORT_FIELDS did not offer.
     P5C-013  Events filter row unreachable at 360px.

   Usage:  node tests/phase5d_hardening.js
           (needs the application running on TEST_BASE, default :8123)
   ============================================================ */

const fs = require('fs');
const db = require(path.join(REPO, 'db'));

const B = process.env.TEST_BASE || 'http://localhost:8123';
const CREDS_FILE = path.join(REPO, 'admin-credentials.local.txt');

const creds = {};
if (fs.existsSync(CREDS_FILE)) {
  for (const l of fs.readFileSync(CREDS_FILE, 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) creds[m[2]] = m[3];
  }
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};

// CRLF-normalised: a Windows checkout would otherwise break every source match.
const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  /* ══════════════════════════════════════════════════════════
     A. P5C-001 — the import preview escapes everything
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== A. no CSV value reaches the DOM unescaped ===');

  const admin = src('js/admin.js');
  const panelStart = admin.indexOf('function renderBulkImportPanel');
  const panelEnd = admin.indexOf('function resetImportWizard');
  ok('the import panel was located', panelStart > 0 && panelEnd > panelStart);
  const panel = admin.slice(panelStart, panelEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

  /* Every record field and the filename must pass through escapeHtml. These
     are the exact sinks that were raw: fifteen table cells across the valid,
     duplicate and invalid previews, plus the "Parsed File" header. */
  const rawRecordFields = [...panel.matchAll(/\$\{\s*(r\.[a-zA-Z]+|currentImportState\.filename)[^}]*\}/g)]
    .filter(m => !m[0].includes('escapeHtml'))
    .map(m => m[0].slice(0, 40));
  ok('no record field is interpolated without escapeHtml',
    rawRecordFields.length === 0, rawRecordFields.join(' | '));

  ok('the filename is escaped in the parsed-file header',
    /Parsed File:[\s\S]{0,120}escapeHtml\(currentImportState\.filename\)/.test(panel));

  const escapedCells = (panel.match(/escapeHtml\(r\./g) || []).length;
  ok('all three preview tables escape their cells', escapedCells >= 15, String(escapedCells));

  /* P5C-025: esc() was called and never defined, so the success screen threw a
     ReferenceError exactly when a batch had created accounts — the one moment
     the temporary password is shown. */
  ok('no undefined esc() helper is called', !/[^a-zA-Z]esc\(/.test(admin));
  ok('the temporary password is escaped with the real helper',
    /escapeHtml\(currentImportState\.lastResult\.temporaryPassword\)/.test(admin));

  // escapeHtml itself must neutralise every character that opens a tag or attribute.
  const core = src('js/core.js');
  for (const ch of ['&', '<', '>', '"', "'"]) {
    ok(`escapeHtml handles ${ch}`, core.includes(`replace(/${ch === '&' ? '&' : ch}/g`) ||
      new RegExp(`replace\\(/\\${ch}/g`).test(core) || core.includes(`/${ch}/g`));
  }

  /* P5C-005/006: the success screen reports what the SERVER did. */
  ok('the success screen reports the server tallies, not the client count',
    /lastResult\?\.created/.test(admin) &&
    !/Successfully created <strong>\$\{currentImportState\.validRecords\.length\}/.test(admin));
  ok('unresolved import locations are surfaced to the administrator',
    /unresolvedLocationCount/.test(admin));

  // The error-report CSV is the second sink for the same untrusted data.
  ok('the error report quotes and escapes its cells', /function csvCell/.test(admin));
  ok('…and guards against spreadsheet formula injection',
    /\^\[=\+\\?-@/.test(admin) || /\[=\+/.test(admin));

  /* ══════════════════════════════════════════════════════════
     B. P5C-026 — auto-mapping and manual mapping offer the same fields
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== B. import field mapping is internally consistent ===');

  const fieldKeys = [...admin.matchAll(/\{\s*key:\s*'([a-zA-Z]+)'/g)].map(m => m[1]);
  const ruleTargets = [...admin.matchAll(/\],\s*'([a-zA-Z]+)'\],?/g)].map(m => m[1]);
  const offered = new Set(fieldKeys);
  const missing = [...new Set(ruleTargets)].filter(t => t !== 'ignore' && !offered.has(t));
  ok('every header rule maps to a field the dropdown offers',
    missing.length === 0, missing.join(','));
  for (const f of ['city', 'country', 'district', 'hometown', 'postalCode', 'permanentAddress']) {
    ok(`the mapper offers "${f}"`, offered.has(f));
  }

  /* ══════════════════════════════════════════════════════════
     C. P5C-003 — stories require a session and hide author_id
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== C. the stories endpoint is not public ===');

  const anon = await j('/api/stories');
  ok('an unauthenticated caller is refused', anon.status === 401, String(anon.status));

  let token = null;
  if (creds['alumni@dic.edu.bd']) {
    token = (await j('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alumni@dic.edu.bd', password: creds['alumni@dic.edu.bd'] })
    })).body?.token;
  }
  if (token) {
    const authed = await j('/api/stories', { headers: { Authorization: 'Bearer ' + token } });
    ok('a signed-in member still gets the feed', authed.status === 200);
    const row = (authed.body || [])[0] || {};
    ok('author_id is not returned to anybody', !('author_id' in row), Object.keys(row).join(','));
    ok('the fields the feed renders are present',
      ['title', 'category', 'excerpt', 'author_name'].every(k => k in row), Object.keys(row).join(','));
    ok('no other route was made public by mistake',
      (await j('/api/alumni?limit=1')).status === 401);
  } else {
    ok('alumni credentials available for the stories check', false, 'no credentials file');
  }

  /* ══════════════════════════════════════════════════════════
     D. P5C-002 — the README describes only what exists
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== D. the README does not promise absent features ===');

  const readme = src('README.md');
  const cols = (await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'alumni_profiles'`)).rows.map(r => r.column_name);

  /* Each of these was advertised as a profile field and has no column. The
     README may now only mention them under an explicit "not implemented"
     heading, so the check is that none is claimed as a feature. */
  const notImplemented = readme.slice(readme.indexOf('Not currently implemented'));
  const claimed = readme.slice(0, readme.indexOf('Not currently implemented'));
  for (const term of ['Cover Photo', 'Resume/CV Upload', 'Instagram', 'Kaggle',
                      'Behance', 'Dribbble', 'Stack Overflow', 'Soft Skills']) {
    ok(`"${term}" is not claimed as an existing field`, !claimed.includes(term));
  }
  ok('the absent features are listed honestly instead', notImplemented.length > 200);

  for (const level of ['Same Batch', 'Connections*', 'Teachers']) {
    ok(`the fictional privacy level "${level}" is gone`, !readme.includes('*' + level + '*'));
  }
  ok('the README states the real privacy fields',
    /Email address/.test(readme) && /Mobile number/.test(readme) && /City & country/.test(readme));
  // Whitespace-tolerant: the phrase wraps across lines in the rendered file.
  ok('the README documents the location model added in Phase 5B',
    /##[^\n]*Location/.test(readme) && /no\s+map\s+library/i.test(readme));
  ok('README claims no verification badges the schema lacks',
    !/Phone Verified/.test(claimed) && !/Student ID Verified/.test(claimed));

  // Spot-check that the columns the README does claim actually exist.
  for (const c of ['whatsapp_number', 'hometown', 'place_id', 'postal_code']) {
    ok(`claimed column ${c} exists`, cols.includes(c));
  }

  /* ══════════════════════════════════════════════════════════
     E. P5C-013 — the events filter row can scroll on a phone
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== E. every events filter is reachable at 360px ===');

  const css = src('styles.css');
  const mobileFilters = css.slice(css.indexOf('.ev-toolbar .ev-filters {', css.indexOf('@media (max-width: 760px)')));
  const block = mobileFilters.slice(0, mobileFilters.indexOf('}') + 1);
  ok('the filter row scrolls horizontally', /overflow-x:\s*auto/.test(block));
  ok('…and is pinned to its container so it can scroll',
    /width:\s*100%/.test(block) && /max-width:\s*100%/.test(block), block.replace(/\s+/g, ' ').slice(0, 120));
  ok('filter chips meet the 44px touch minimum',
    /\.ev-toolbar \.ev-chip\s*\{[^}]*min-height:\s*44px/.test(css));

  /* ══════════════════════════════════════════════════════════
     F. P5C-009 — the stale counters are labelled, not silently trusted
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== F. stale counters carry a warning at every write site ===');

  /* P5C-009 asked that these counters be LABELLED, because they were wrong and
     still being written. Phase 7D removed them: every one was written by code
     and read by none, and each had drifted far from the rows behind it —
     ৳3,442,532 claimed against ৳5,000 settled, 41,994 chapter members against
     0 memberships, 83 registrations against 4.

     A removed counter cannot mislead anyone, so these assertions are now the
     stronger form of the same requirement: the columns are gone, and no code
     writes them. A label is a promise to be careful; an absent column needs no
     care. */
  for (const [file, needle] of [['server.js', 'members_count = members_count + 1'],
                                ['routes_events.js', 'registered_count = registered_count + 1'],
                                ['routes_v2.js', 'raised_amount = raised_amount + ']]) {
    ok(`${file}: no code writes the stale counter any more`, src(file).indexOf(needle) === -1, needle);
  }
  const dropped = await db.query(`
    SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE (table_name='campaigns' AND column_name IN ('raised_amount','donors_count'))
        OR (table_name='chapters'  AND column_name IN ('members_count','events_count'))
        OR (table_name='events'    AND column_name = 'registered_count')`);
  ok('every stale counter column is gone from the schema', dropped.rows[0].n === 0, String(dropped.rows[0].n));
  /* The figures those counters pretended to be are still computed from rows,
     which is what made removing them safe. */
  ok('campaign totals are still available as a real sum',
    typeof (await db.query(
      `SELECT COALESCE(SUM(amount),0)::int n FROM donations WHERE status='SUCCESS'`)).rows[0].n === 'number');
  ok('chapter membership is still available as a real count',
    typeof (await db.query('SELECT COUNT(*)::int n FROM chapter_memberships')).rows[0].n === 'number');

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})().catch(async (e) => {
  console.error('\nHARNESS ERROR: ' + e.message);
  console.error(e.stack);
  try { await db.pool.end(); } catch {}
  process.exit(2);
});
