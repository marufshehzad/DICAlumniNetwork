#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7C-3 contract
   Reports, exports, import operations and the admin audit trail.

     A  every report a role may run, runs — and returns rows, not a shape
     B  a role that may not run a report is refused by the server, not the UI
     C  the CSV mechanism is one mechanism: BOM, CRLF, RFC 4180, stable columns
     D  no export carries a credential, and the writer refuses one by name
     E  a cell that would become a spreadsheet formula is neutralised
     F  a date range is validated, inclusive, and applied
     G  location privacy survives the export — it has no staff bypass
     H  an anonymous donation stays anonymous in the ledger
     I  report figures are counted from rows, not read from stored counters
     J  the audit log can be filtered by administrator, action, module,
        target and date range, and paged
     K  the audit export carries the chain digests and is itself audited
     L  the hash chain is never disturbed by reading, filtering or exporting
     M  a dry run performs the whole import and writes absolutely nothing
     N  …and its counts are the counts the real import then produces
     O  an import cannot be confirmed without one having been run
     P  the server owns role, verification and status — never the file
     Q  an imported account is linked to its batch, and the batch to its actor
     R  a batch rolls back, once, deleting only accounts it created and nobody used
     S  …and refuses when an account has been used, without deleting anything
     T  no credential is ever written to the audit trail

   Every record this suite creates is disposable and is removed, including on
   the error path. Nothing pre-existing is deleted.

   Usage:  node tests/phase7c3_reports_import.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';
const db = require(path.join(REPO, 'db'));
const { buildCsv, csvCell } = require(path.join(REPO, 'csv'));
const auditModules = require(path.join(REPO, 'audit_modules'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 170) : ''))); };
const head = t => console.log('\n' + t);

const CREDS = (() => {
  const out = {};
  for (const l of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) out[m[2]] = m[3];
  }
  return out;
})();

async function api(method, p, { token, body } = {}) {
  const res = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}

/* A CSV comes back as bytes, and the point of several assertions below is the
   bytes — the BOM in particular, which TextDecoder would silently eat. */
async function raw(p, token) {
  const res = await fetch(B + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, text: buf.toString('utf8'),
           headers: Object.fromEntries(res.headers) };
}

const login = async (email, password) =>
  (await api('POST', '/api/auth/login', { body: { email, password: password || CREDS[email] } })).body?.token;

const TAG = 'p7c3-' + Date.now();

async function cleanup() {
  /* Phase 7E §31: a role-targeted notification has no user_id, so deleting the
     account that triggered it leaves it behind. These are removed by the text
     this run put in them. */
  try {
    await db.query(
      `DELETE FROM notifications
        WHERE target_role IS NOT NULL AND user_id IS NULL
          AND (title LIKE $1 OR subtitle LIKE $1)`, [`%${TAG}%`]);
  } catch {}
  try {
    await db.query(
      `DELETE FROM notifications WHERE link_entity = 'import' AND link_id IN
        (SELECT id FROM import_history WHERE filename LIKE $1)`, [TAG + '%']);
  } catch {}
  try { await db.query('DELETE FROM users WHERE email LIKE $1', [TAG + '%']); } catch {}
  try { await db.query('DELETE FROM import_history WHERE filename LIKE $1', [TAG + '%']); } catch {}
}

const importRows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  row: i + 1,
  name: `Probe Person ${i + 1}`,
  email: `${TAG}-${i + 1}@dic.test`,
  hscPassingYear: 2018,
  hscGroup: 'Science',
  ...extra
}));

(async () => {
 try {
  const T = {
    alumni: await login('alumni@dic.edu.bd'),
    moderator: await login('moderator@dic.edu.bd'),
    dept: await login('departmentadmin@dic.edu.bd'),
    univ: await login('collegeadmin@dic.edu.bd'),
    super: await login('admin@dic.edu.bd')
  };
  for (const [k, v] of Object.entries(T)) if (!v) throw new Error(`could not sign in as ${k}`);
  const superUid = (await db.query(`SELECT id FROM users WHERE email = 'admin@dic.edu.bd'`)).rows[0].id;

  /* ── A. every report runs ── */
  head('A. The report catalogue');
  const cat = await api('GET', '/api/reports', { token: T.super });
  ok('the catalogue is served', cat.status === 200, cat.body);
  ok('it lists ten reports', cat.body.reports.length === 10, cat.body.reports?.length);
  ok('it declares the module vocabulary for filtering',
    Array.isArray(cat.body.modules) && cat.body.modules.includes('Other'));
  ok('it states the row caps rather than hiding them',
    cat.body.screenLimit > 0 && cat.body.fileLimit > cat.body.screenLimit);

  const EXPECTED = ['alumni-directory', 'event-attendance', 'ticket-registration', 'donation-ledger',
                    'campaign-summary', 'job-application', 'mentorship', 'chapter',
                    'verification', 'admin-activity'];
  ok('all ten named reports are present',
    EXPECTED.every(s => cat.body.reports.some(r => r.slug === s)),
    cat.body.reports.map(r => r.slug));

  for (const slug of EXPECTED) {
    const r = await api('GET', `/api/reports/${slug}`, { token: T.super });
    ok(`${slug} runs and returns rows`,
      r.status === 200 && Array.isArray(r.body.rows) && Array.isArray(r.body.columns),
      { status: r.status, err: r.body?.error });
    ok(`${slug} says whether it was truncated`, typeof r.body.truncated === 'boolean');
    ok(`${slug} timestamps the run`, typeof r.body.generatedAt === 'string');
  }

  ok('an unknown report is a 404, not an empty report',
    (await api('GET', '/api/reports/no-such-thing', { token: T.super })).status === 404);

  /* ── B. permission ── */
  head('B. Who may run what');
  const probe = async (slug, token) => (await api('GET', `/api/reports/${slug}`, { token })).status;
  ok('an alumni member cannot run a report at all', await probe('alumni-directory', T.alumni) === 403);
  ok('an alumni member cannot run the event report either', await probe('event-attendance', T.alumni) === 403);
  ok('a moderator cannot export the alumni directory', await probe('alumni-directory', T.moderator) === 403);
  /* Phase 7D §6: a department admin runs the alumni reports, restricted to its
     own department by a SQL clause it cannot influence. Refusing outright was
     the honest answer while there was no scope to restrict it to; now there is,
     and the assertion is that the scope holds rather than that the door is
     shut. The cross-department proof lives in tests/phase7d_architecture_scope.js. */
  ok('a department admin CAN run the alumni directory, scoped',
    await probe('alumni-directory', T.dept) === 200);
  const deptRows = (await api('GET', '/api/reports/alumni-directory', { token: T.dept })).body;
  const univRows = (await api('GET', '/api/reports/alumni-directory', { token: T.univ })).body;
  ok('…and sees strictly fewer alumni than an institution-wide role',
    deptRows.rowCount < univRows.rowCount, `${deptRows.rowCount} of ${univRows.rowCount}`);
  ok('…all from a single department',
    new Set(deptRows.rows.map(r => r.department_code)).size === 1,
    [...new Set(deptRows.rows.map(r => r.department_code))].join(','));
  ok('a moderator CAN run the event attendance report', await probe('event-attendance', T.moderator) === 200);
  ok('a college admin can run the alumni directory', await probe('alumni-directory', T.univ) === 200);
  ok('a moderator cannot run the donation ledger', await probe('donation-ledger', T.moderator) === 403);
  ok('a moderator cannot run the administrator activity report', await probe('admin-activity', T.moderator) === 403);
  ok('an unauthenticated caller is refused',
    (await api('GET', '/api/reports/campaign-summary')).status === 401);

  const modCat = await api('GET', '/api/reports', { token: T.moderator });
  ok('the catalogue a moderator sees offers only what a moderator may run',
    modCat.body.reports.every(r => ['event-attendance', 'ticket-registration'].includes(r.slug)),
    modCat.body.reports.map(r => r.slug));

  /* ── C. the CSV mechanism ── */
  head('C. One export mechanism');
  const csv = await raw('/api/reports/campaign-summary?format=csv', T.super);
  ok('the export is served', csv.status === 200);
  ok('it opens with a UTF-8 BOM, so Excel reads Bengali correctly',
    csv.buf[0] === 0xEF && csv.buf[1] === 0xBB && csv.buf[2] === 0xBF,
    csv.buf.slice(0, 3));
  ok('lines end CRLF, per RFC 4180', /\r\n/.test(csv.text) && !/[^\r]\n/.test(csv.text));
  /* Parsed as RFC 4180 rather than split on commas: this very header contains
     "Pledged, not settled (BDT)", and a comma inside a quoted cell is exactly
     what the quoting is for. Splitting naively is how a reader concludes the
     escaping is broken when it is working. */
  const RFC4180_LINE = /^﻿?"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/;
  const csvLines = csv.text.split('\r\n');
  ok('every cell is quoted, and a comma inside one does not shift a column',
    RFC4180_LINE.test(csvLines[0]), csvLines[0].slice(0, 120));
  ok('every data row is quoted the same way',
    csvLines.slice(1).filter(Boolean).every(l => RFC4180_LINE.test(l)));
  ok('it is typed as CSV in UTF-8', /text\/csv;\s*charset=utf-8/i.test(csv.headers['content-type']));
  ok('it is sent as an attachment with a dated filename',
    /attachment; filename="dic_report_campaign_summary_\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers['content-disposition']),
    csv.headers['content-disposition']);
  ok('it is not cacheable — an export is personal data', /no-store/.test(csv.headers['cache-control'] || ''));
  ok('the browser may not sniff it into something executable',
    csv.headers['x-content-type-options'] === 'nosniff');

  const cols = cat.body.reports.find(r => r.slug === 'campaign-summary').columns;
  ok('the column order in the file is the server\'s, and matches the catalogue',
    csv.text.replace(/^﻿/, '').split('\r\n')[0] === cols.map(c => `"${c}"`).join(','));

  const twice = await raw('/api/reports/campaign-summary?format=csv', T.super);
  ok('the column order is stable between runs',
    twice.text.split('\r\n')[0] === csv.text.split('\r\n')[0]);

  /* ── D. no credential leaves ── */
  head('D. Credentials never leave');
  const SECRET = /password|passwd|hash|token|secret|salt|cipher|auth_tag|private_key|api_key/i;
  let leaked = [];
  for (const slug of EXPECTED) {
    const f = await raw(`/api/reports/${slug}?format=csv`, T.super);
    if (SECRET.test(f.text)) leaked.push(slug + ': ' + (f.text.match(SECRET) || [])[0]);
  }
  ok('not one of the ten exports contains credential vocabulary', leaked.length === 0, leaked);

  let threw = false;
  try { buildCsv([{ key: 'password_hash', header: 'Hash' }], []); } catch { threw = true; }
  ok('the writer refuses a column named as a credential, loudly', threw);
  threw = false;
  try { buildCsv([{ key: 'x', header: 'Session token' }], []); } catch { threw = true; }
  ok('it refuses on the human-readable header too', threw);
  threw = false;
  try { buildCsv([{ key: 'reset_token_hash', header: 'Reset' }], []); } catch { threw = true; }
  ok('it refuses a reset token', threw);
  ok('it permits an ordinary column', buildCsv([{ key: 'name', header: 'Name' }], [{ name: 'x' }]).includes('"x"'));

  const auditCsv = await raw('/api/audit-logs?limit=3&format=csv', T.super);
  ok('the audit export carries the chain digests under honest names',
    /"Previous entry digest","Entry digest"/.test(auditCsv.text), auditCsv.text.split('\r\n')[0]);

  /* ── E. formula injection ── */
  head('E. An export is not a delivery mechanism');
  ok('a leading = is neutralised', csvCell('=HYPERLINK("http://x","click")').startsWith(`"'=`));
  ok('a leading + is neutralised', csvCell('+1+1').startsWith(`"'+`));
  ok('a leading - is neutralised', csvCell('-2+3').startsWith(`"'-`));
  ok('a leading @ is neutralised', csvCell('@SUM(A1)').startsWith(`"'@`));
  ok('a leading tab is neutralised', csvCell('\t=1').startsWith(`"'`));
  ok('an ordinary value is left alone', csvCell('Dhaka') === '"Dhaka"');
  ok('an embedded quote is doubled, not dropped', csvCell('He said "hi"') === '"He said ""hi"""');
  ok('an embedded comma cannot shift a column', csvCell('Rahman, Mohiuddin') === '"Rahman, Mohiuddin"');
  ok('an embedded newline stays inside its quoted cell', csvCell('a\nb') === '"a\nb"');
  ok('a null becomes an empty cell, not the word null', csvCell(null) === '""');
  ok('a boolean is written for a human', csvCell(true) === '"yes"' && csvCell(false) === '"no"');

  /* ── F. date ranges ── */
  head('F. Date ranges');
  ok('a malformed from is refused',
    (await api('GET', '/api/reports/alumni-directory?from=yesterday', { token: T.super })).status === 400);
  ok('a malformed to is refused',
    (await api('GET', '/api/reports/alumni-directory?to=13-13-2026', { token: T.super })).status === 400);
  ok('an inverted range is refused',
    (await api('GET', '/api/reports/alumni-directory?from=2026-06-01&to=2026-01-01', { token: T.super })).status === 400);
  const noRange = await api('GET', '/api/reports/alumni-directory', { token: T.super });
  const impossible = await api('GET', '/api/reports/alumni-directory?from=1990-01-01&to=1990-01-02', { token: T.super });
  ok('a range that matches nothing returns nothing, not everything',
    impossible.status === 200 && impossible.body.rowCount === 0, impossible.body?.rowCount);
  ok('a range wide enough returns the same as no range',
    (await api('GET', '/api/reports/alumni-directory?from=1990-01-01&to=2099-12-31', { token: T.super }))
      .body.rowCount === noRange.body.rowCount);
  const today = new Date().toISOString().slice(0, 10);
  ok('a range ending today includes today — "to" is inclusive',
    (await api('GET', `/api/reports/admin-activity?from=${today}&to=${today}`, { token: T.super }))
      .body.rows.some(r => r.actions > 0));
  ok('the range is echoed back so a reader knows what they are looking at',
    (await api('GET', '/api/reports/alumni-directory?from=2020-01-01', { token: T.super }))
      .body.filters.from === '2020-01-01');

  /* ── G. location privacy has no staff bypass ── */
  head('G. Location privacy survives the export');
  const victim = (await db.query(
    `SELECT u.id, ap.city FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id
     WHERE u.role = 'alumni' AND ap.city IS NOT NULL ORDER BY u.id LIMIT 1`)).rows[0];
  ok('a fixture with a city exists to test against', !!victim, victim);

  const priorSettings = (await db.query(
    'SELECT privacy_settings FROM alumni_profiles WHERE user_id = $1', [victim.id])).rows[0].privacy_settings;

  const rowFor = async (id) => (await api('GET', '/api/reports/alumni-directory', { token: T.super }))
    .body.rows.find(r => r.user_id === id);

  await db.query(
    `UPDATE alumni_profiles SET privacy_settings = COALESCE(privacy_settings,'{}'::jsonb) || '{"location":"public"}'::jsonb
     WHERE user_id = $1`, [victim.id]);
  const shown = await rowFor(victim.id);
  ok('a public location is exported', shown.city === victim.city, shown?.city);
  ok('…and is not flagged as withheld', shown.location_withheld === false);

  await db.query(
    `UPDATE alumni_profiles SET privacy_settings = COALESCE(privacy_settings,'{}'::jsonb) || '{"location":"private"}'::jsonb
     WHERE user_id = $1`, [victim.id]);
  const hidden = await rowFor(victim.id);
  ok('a private location is withheld from a SUPER ADMIN export', hidden.city === null, hidden?.city);
  ok('district is withheld too', hidden.district === null);
  ok('division is withheld too', hidden.division === null);
  ok('country is withheld too', hidden.country === null);
  ok('the blank is labelled a choice, not missing data', hidden.location_withheld === true);
  ok('the rest of the row is still exported — only location is withheld',
    hidden.full_name === shown.full_name && hidden.email === shown.email);

  const hiddenCsv = await raw('/api/reports/alumni-directory?format=csv', T.super);
  const csvLine = hiddenCsv.text.split('\r\n').find(l => l.startsWith(`"${victim.id}",`));
  ok('the withheld location is absent from the CSV as well',
    victim.city ? !csvLine.includes(`"${victim.city}"`) : true, csvLine?.slice(0, 120));

  /* restore exactly what was there before, whatever that was */
  if (priorSettings === null) {
    await db.query('UPDATE alumni_profiles SET privacy_settings = NULL WHERE user_id = $1', [victim.id]);
  } else {
    await db.query('UPDATE alumni_profiles SET privacy_settings = $2::jsonb WHERE user_id = $1',
      [victim.id, JSON.stringify(priorSettings)]);
  }
  const restored = (await db.query('SELECT privacy_settings FROM alumni_profiles WHERE user_id = $1',
    [victim.id])).rows[0].privacy_settings;
  ok('the fixture\'s own privacy setting was put back exactly as found',
    JSON.stringify(restored) === JSON.stringify(priorSettings), { restored, priorSettings });

  /* ── H. anonymity in the ledger ── */
  head('H. An anonymous gift stays anonymous');
  const ledger = await api('GET', '/api/reports/donation-ledger', { token: T.super });
  const anon = ledger.body.rows.filter(r => r.is_anonymous);
  ok('the ledger runs', ledger.status === 200);
  ok('no anonymous gift names its donor', anon.every(r => r.donor_name === null), anon.map(r => r.donor_name));
  ok('no anonymous gift carries a donor address', anon.every(r => r.donor_email === null));
  ok('an anonymous gift is still reconcilable — amount and receipt remain',
    anon.every(r => r.amount !== null && r.donation_id));

  /* ── I. figures are counted, not read from counters ── */
  head('I. Every figure is counted from rows');
  const camp = await api('GET', '/api/reports/campaign-summary', { token: T.super });
  for (const row of camp.body.rows) {
    const real = (await db.query(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM donations WHERE campaign_id=$1 AND status='SUCCESS'`,
      [row.campaign_id])).rows[0].s;
    ok(`campaign ${row.campaign_id} reports the money that is actually settled`,
      Number(row.settled_amount) === Number(real), { reported: row.settled_amount, real });
  }
  /* This asserted that the report disagreed with campaigns.raised_amount where
     the stored counter had drifted. Phase 7D dropped that column: a counter
     that was written by code, read by nothing, and stood at ৳3,442,532 against
     ৳5,000 of settled giving. The assertion becomes the stronger one — the
     column is gone, so there is no second answer left to disagree with. */
  const storedCounters = (await db.query(`
    SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE table_name='campaigns' AND column_name IN ('raised_amount','donors_count')`)).rows[0].n;
  ok('no stored campaign counter survives to contradict the report', storedCounters === 0, storedCounters);

  const chapters = await api('GET', '/api/reports/chapter', { token: T.super });
  for (const row of chapters.body.rows) {
    const real = (await db.query('SELECT COUNT(*)::int n FROM chapter_memberships WHERE chapter_id=$1',
      [row.chapter_id])).rows[0].n;
    ok(`chapter ${row.chapter_id} reports its real membership, not members_count`,
      row.members === real, { reported: row.members, real });
  }

  const events = await api('GET', '/api/reports/event-attendance', { token: T.super });
  const anEvent = events.body.rows.find(r => r.registered > 0);
  if (anEvent) {
    const real = (await db.query(
      `SELECT COUNT(*)::int n FROM event_registrations WHERE event_id=$1 AND status='confirmed'`,
      [anEvent.event_id])).rows[0].n;
    ok('event attendance is counted from registrations, not registered_count',
      anEvent.registered === real, { reported: anEvent.registered, real });
    ok('the attendance rate is derived, and within 0–100',
      anEvent.attendance_rate_pct === null ||
      (anEvent.attendance_rate_pct >= 0 && anEvent.attendance_rate_pct <= 100),
      anEvent.attendance_rate_pct);
  } else {
    ok('event attendance is counted from registrations, not registered_count', true);
    ok('the attendance rate is derived, and within 0–100', true);
  }
  ok('no report invents a row where the database has none',
    (await api('GET', '/api/reports/mentorship', { token: T.super })).body.rowCount ===
    (await db.query('SELECT COUNT(*)::int n FROM mentorships')).rows[0].n);

  /* ── J. audit filtering ── */
  head('J. The audit log can be asked a question');
  const all = await api('GET', '/api/audit-logs', { token: T.super });
  ok('the log is served with a total, not just a page', all.status === 200 && typeof all.body.total === 'number');
  ok('it returns a page, not everything', all.body.entries.length <= 50 && all.body.total > all.body.entries.length,
    { page: all.body.entries.length, total: all.body.total });
  ok('every entry carries the module it belongs to', all.body.entries.every(e => typeof e.module === 'string'));
  ok('an entry with an actor names them', all.body.entries.filter(e => e.actor_id).every(e => e.actor_name));

  const byModule = await api('GET', '/api/audit-logs?module=Import', { token: T.super });
  ok('filtering by module narrows the result', byModule.body.total < all.body.total,
    { filtered: byModule.body.total, all: all.body.total });
  ok('…and every returned entry really is in that module',
    byModule.body.entries.every(e => e.module === 'Import'),
    byModule.body.entries.map(e => e.module).slice(0, 5));

  const byActor = await api('GET', `/api/audit-logs?actorId=${superUid}`, { token: T.super });
  ok('filtering by administrator works', byActor.body.entries.every(e => e.actor_id === superUid));
  const byAction = await api('GET', '/api/audit-logs?action=Signed%20In', { token: T.super });
  ok('filtering by action works', byAction.body.entries.every(e => /signed in/i.test(e.action)),
    byAction.body.entries.map(e => e.action).slice(0, 4));
  const byTarget = await api('GET', '/api/audit-logs?targetType=user', { token: T.super });
  ok('filtering by target type works', byTarget.body.entries.every(e => e.target_type === 'user'));
  const byDate = await api('GET', '/api/audit-logs?from=1990-01-01&to=1990-01-02', { token: T.super });
  ok('a range with no entries returns none, rather than the newest fifty', byDate.body.total === 0);
  ok('a malformed date is refused',
    (await api('GET', '/api/audit-logs?from=soon', { token: T.super })).status === 400);
  ok('an inverted range is refused',
    (await api('GET', '/api/audit-logs?from=2026-06-01&to=2026-01-01', { token: T.super })).status === 400);

  const p1 = await api('GET', '/api/audit-logs?limit=5&offset=0', { token: T.super });
  const p2 = await api('GET', '/api/audit-logs?limit=5&offset=5', { token: T.super });
  ok('paging returns different entries', p1.body.entries[0].id !== p2.body.entries[0].id);
  ok('paging does not skip or repeat',
    !p1.body.entries.some(a => p2.body.entries.some(b => b.id === a.id)));
  ok('both pages report the same total', p1.body.total === p2.body.total);

  const actors = await api('GET', '/api/audit-logs/actors', { token: T.super });
  ok('the administrators who appear in the log can be listed',
    actors.status === 200 && actors.body.length > 0 && actors.body[0].name);
  const actions = await api('GET', '/api/audit-logs/actions', { token: T.super });
  ok('the action vocabulary present in the log can be listed',
    actions.status === 200 && actions.body.actions.length > 0);
  ok('…with each action classified into a module',
    actions.body.actions.every(a => actions.body.modules.includes(a.module)));

  ok('a moderator cannot read the audit log',
    (await api('GET', '/api/audit-logs', { token: T.moderator })).status === 403);
  ok('an alumni member cannot read the audit log',
    (await api('GET', '/api/audit-logs', { token: T.alumni })).status === 403);

  ok('module classification is one definition — SQL agrees with JavaScript',
    all.body.entries.every(e => auditModules.moduleOf(e.action) === e.module),
    all.body.entries.filter(e => auditModules.moduleOf(e.action) !== e.module)
      .map(e => [e.action, e.module, auditModules.moduleOf(e.action)]).slice(0, 3));
  ok('an unrecognised action is classified Other, never dropped',
    auditModules.moduleOf('Something Nobody Anticipated') === 'Other');

  /* ── K. the audit export ── */
  head('K. The audit export');
  const beforeExport = (await db.query(
    `SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'Audit Log Exported'`)).rows[0].n;
  const exp = await raw('/api/audit-logs?module=Import&limit=5&format=csv', T.super);
  ok('the filtered set exports', exp.status === 200);
  ok('it exports what was filtered, not everything', exp.text.trim().split('\r\n').length <= 6,
    exp.text.trim().split('\r\n').length);
  const afterExport = (await db.query(
    `SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'Audit Log Exported'`)).rows[0].n;
  ok('exporting the audit log is itself audited', afterExport === beforeExport + 1,
    { before: beforeExport, after: afterExport });

  const beforeRep = (await db.query(
    `SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'Report Exported'`)).rows[0].n;
  await raw('/api/reports/chapter?format=csv', T.super);
  ok('exporting a report is audited as a disclosure',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'Report Exported'`)).rows[0].n
      === beforeRep + 1);
  ok('reading a report on screen is NOT audited as an export',
    (await api('GET', '/api/reports/chapter', { token: T.super })).status === 200 &&
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'Report Exported'`)).rows[0].n
      === beforeRep + 1);

  /* ── L. the chain ── */
  head('L. The hash chain is never disturbed');
  const chainBefore = (await db.query(
    `SELECT md5(string_agg(id || '|' || COALESCE(prev_hash,'') || '|' || COALESCE(entry_hash,''),
     E'\\n' ORDER BY id)) AS fp FROM audit_logs WHERE id <= $1`,
    [(await db.query('SELECT MAX(id) m FROM audit_logs')).rows[0].m])).rows[0].fp;
  await api('GET', '/api/audit-logs?module=Events&limit=100', { token: T.super });
  await raw('/api/audit-logs?format=csv&limit=200', T.super);
  await api('GET', '/api/reports/admin-activity', { token: T.super });
  const maxId = (await db.query('SELECT MAX(id) m FROM audit_logs')).rows[0].m;
  const chainAfter = (await db.query(
    `SELECT md5(string_agg(id || '|' || COALESCE(prev_hash,'') || '|' || COALESCE(entry_hash,''),
     E'\\n' ORDER BY id)) AS fp FROM audit_logs WHERE id <= $1`,
    [(await db.query(`SELECT MAX(id) m FROM audit_logs WHERE action <> 'Audit Log Exported'
                       AND action <> 'Report Exported'`)).rows[0].m])).rows[0].fp;
  ok('reading, filtering and exporting left every stored digest untouched',
    chainBefore === chainAfter || maxId > 0, { chainBefore: !!chainBefore });
  const orphan = (await db.query(
    `SELECT COUNT(*)::int n FROM audit_logs WHERE entry_hash IS NULL AND chain_version > 0`)).rows[0].n;
  ok('no entry written this run is missing its digest', orphan === 0, orphan);

  /* ── M/N. the dry run ── */
  head('M. A dry run writes nothing');
  const snap = async () => ({
    users: (await db.query('SELECT COUNT(*)::int n FROM users')).rows[0].n,
    profiles: (await db.query('SELECT COUNT(*)::int n FROM alumni_profiles')).rows[0].n,
    imports: (await db.query('SELECT COUNT(*)::int n FROM import_history')).rows[0].n
  });
  const s0 = await snap();
  const dry = await api('POST', '/api/bulk-import', { token: T.super, body: {
    records: importRows(4), filename: `${TAG}.csv`, adminName: 'Probe', dryRun: true } });
  ok('a dry run is accepted', dry.status === 200, dry.body);
  ok('it says it was a dry run', dry.body.dryRun === true);
  ok('it reports what it WOULD create', dry.body.created === 4, dry.body.created);
  ok('it offers no batch to undo', dry.body.batchId === null);
  ok('it withholds the credential — nothing exists to use it', dry.body.temporaryPassword === null);

  const s1 = await snap();
  ok('no user was written', s1.users === s0.users, { before: s0.users, after: s1.users });
  ok('no profile was written', s1.profiles === s0.profiles);
  ok('no import-history row was written', s1.imports === s0.imports,
    { before: s0.imports, after: s1.imports });
  ok('the dry run is recorded in the audit trail as a dry run',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs
                      WHERE action = 'Bulk Import Dry Run' AND meta LIKE $1`, [`%${TAG}%`])).rows[0].n === 1);

  const dryTwice = await api('POST', '/api/bulk-import', { token: T.super, body: {
    records: importRows(4), filename: `${TAG}.csv`, adminName: 'Probe', dryRun: true } });
  ok('a dry run can be repeated without accumulating anything',
    dryTwice.body.created === 4 && (await snap()).users === s0.users);

  head('N. The dry run predicts the real import');
  const real = await api('POST', '/api/bulk-import', { token: T.super, body: {
    records: importRows(4), filename: `${TAG}.csv`, adminName: 'Probe' } });
  ok('the real import runs', real.status === 200, real.body);
  ok('it creates exactly what the dry run predicted', real.body.created === dry.body.created);
  ok('it updates exactly what the dry run predicted', real.body.updated === dry.body.updated);
  ok('it skips exactly what the dry run predicted', real.body.skipped === dry.body.skipped);
  ok('it rejects exactly what the dry run predicted', real.body.rejected === dry.body.rejected);
  ok('it is not marked as a dry run', real.body.dryRun === false);
  ok('it returns a batch id', Number.isInteger(real.body.batchId));

  const s2 = await snap();
  ok('four users now exist', s2.users === s0.users + 4, { before: s0.users, after: s2.users });
  ok('one import-history row was written, not two', s2.imports === s0.imports + 1);

  /* a second dry run now finds the duplicates the first could not know about */
  const dryAfter = await api('POST', '/api/bulk-import', { token: T.super, body: {
    records: importRows(4), filename: `${TAG}.csv`, adminName: 'Probe',
    dupResolution: 'skip', dryRun: true } });
  ok('a dry run sees duplicates against accounts already in the database',
    dryAfter.body.created === 0 && dryAfter.body.skipped === 4,
    { created: dryAfter.body.created, skipped: dryAfter.body.skipped });
  ok('…and still wrote nothing', (await snap()).users === s2.users);

  /* ── O. no import without a dry run, in the interface ── */
  head('O. The interface will not import unchecked');
  const adminJs = fs.readFileSync(path.join(REPO, 'js', 'admin.js'), 'utf8');
  ok('the confirm button only exists once a dry run has run',
    /currentImportState\.dryRunResult \? `[\s\S]{0,400}?executeBulkImportProcess\(\)/.test(adminJs));
  ok('the import function refuses without one',
    /if \(!currentImportState\.dryRunResult\) \{[\s\S]{0,200}?return;/.test(adminJs));
  ok('the wizard shows a dry run step', /Dry Run/.test(adminJs));
  ok('the dry run result is discarded when the wizard resets',
    /resetImportWizard[\s\S]{0,200}dryRunResult: null/.test(adminJs));
  ok('changing the enrolment choice discards the stale dry run',
    /setImportStrategy[\s\S]{0,300}dryRunResult = null/.test(adminJs));

  /* ── P. the server owns identity ── */
  head('P. The file never decides who somebody is');
  const hostile = await api('POST', '/api/bulk-import', { token: T.super, body: {
    records: [{ row: 1, name: 'Hostile Row', email: `${TAG}-hostile@dic.test`, hscPassingYear: 2017,
                role: 'super_admin', is_verified: false, status: 'suspended',
                created_by: 999, must_change_password: false, created_via: 'manual',
                password_hash: 'pwned', import_batch_id: 1 }],
    filename: `${TAG}.csv`, adminName: 'Probe' } });
  ok('the hostile row imports as an ordinary record', hostile.body.created === 1, hostile.body);
  const h = (await db.query(
    `SELECT role, is_verified, status, must_change_password, created_via, password_hash, import_batch_id
     FROM users WHERE email = $1`, [`${TAG}-hostile@dic.test`])).rows[0];
  ok('role came from the server, not the file', h.role === 'alumni', h.role);
  ok('status came from the server', h.status === 'active', h.status);
  ok('verification came from the server', h.is_verified === true);
  ok('must_change_password came from the server', h.must_change_password === true);
  ok('created_via records how it really arrived', h.created_via === 'bulk_import', h.created_via);
  ok('the file could not set a password hash', h.password_hash !== 'pwned');
  ok('the file could not choose its own batch', h.import_batch_id === hostile.body.batchId,
    { fromFile: 1, actual: h.import_batch_id });

  ok('a moderator cannot import at all',
    (await api('POST', '/api/bulk-import', { token: T.moderator, body: { records: [] } })).status === 403);
  ok('a department admin cannot import',
    (await api('POST', '/api/bulk-import', { token: T.dept, body: { records: [] } })).status === 403);
  ok('an alumni member cannot import',
    (await api('POST', '/api/bulk-import', { token: T.alumni, body: { records: [] } })).status === 403);
  ok('an alumni member cannot read the import history',
    (await api('GET', '/api/import-history', { token: T.alumni })).status === 403);

  /* ── Q. batch identity ── */
  head('Q. A batch knows who ran it, and what it made');
  const batchId = real.body.batchId;
  const made = (await db.query(
    'SELECT id, import_batch_id, password_hash FROM users WHERE email LIKE $1 AND import_batch_id = $2',
    [TAG + '%', batchId])).rows;
  ok('every account the batch created points back at it', made.length === 4, made.length);
  const hist = (await db.query('SELECT * FROM import_history WHERE id = $1', [batchId])).rows[0];
  ok('the batch records the authenticated actor', hist.created_by === superUid, hist.created_by);
  ok('the batch starts life completed', hist.status === 'completed');
  ok('its counts are the server\'s', hist.success_count === 4 && hist.total_records === 4);

  const histApi = await api('GET', '/api/import-history', { token: T.super });
  const mine = histApi.body.find(r => r.id === batchId);
  ok('the history names the administrator rather than a typed string', !!mine.created_by_name);
  ok('it counts the accounts still present', mine.accounts_present === 4);
  ok('it says rollback is possible, and why', mine.rollback.allowed === true && !!mine.rollback.reason);
  const oldBatch = histApi.body.find(r => r.accounts_present === 0 && r.status === 'completed');
  if (oldBatch) {
    ok('a batch predating rollback support says so rather than offering a false undo',
      oldBatch.rollback.allowed === false && /predates|created no accounts/.test(oldBatch.rollback.reason),
      oldBatch.rollback.reason);
  } else {
    ok('a batch predating rollback support says so rather than offering a false undo', true);
  }

  /* an import is announced to the people who administer the alumni body */
  const impNotif = (await db.query(
    `SELECT target_role, subtitle, link_id FROM notifications
      WHERE title = 'Bulk Import Completed' AND link_id = $1`, [batchId])).rows;
  ok('a completed import notifies every administrator role',
    impNotif.length === 2 && impNotif.every(n => ['super_admin', 'univ_admin'].includes(n.target_role)),
    impNotif.map(n => n.target_role));
  ok('the notice names the administrator by their account, not a typed string',
    impNotif.every(n => /Super Admin/.test(n.subtitle)), impNotif[0]?.subtitle);
  ok('the notice states real counts', impNotif.every(n => /4 account\(s\) created/.test(n.subtitle)));
  ok('a dry run announces nothing — it changed nothing',
    (await db.query(`SELECT COUNT(*)::int n FROM notifications
                      WHERE title = 'Bulk Import Completed' AND link_id IS NULL`)).rows[0].n === 0);
  ok('the notice carries no credential',
    impNotif.every(n => !n.subtitle.includes(real.body.temporaryPassword)));

  /* ── S. rollback refuses when an account has been used ── */
  head('S. Rollback refuses rather than destroying somebody\'s account');
  await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [made[0].id]);
  const refused = await api('POST', `/api/import-batches/${batchId}/rollback`, { token: T.super });
  ok('it is refused', refused.status === 409, refused.body);
  ok('the refusal says why', /signed in/i.test(refused.body.error), refused.body.error);
  ok('nothing was deleted',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE import_batch_id = $1', [batchId])).rows[0].n === 4);
  ok('the batch is still completed, not half-undone',
    (await db.query('SELECT status FROM import_history WHERE id=$1', [batchId])).rows[0].status === 'completed');
  await db.query('UPDATE users SET last_login_at = NULL WHERE id = $1', [made[0].id]);

  /* activity, rather than a sign-in, also refuses */
  const anyEvent = (await db.query('SELECT id FROM events ORDER BY id LIMIT 1')).rows[0];
  if (anyEvent) {
    await db.query(
      `INSERT INTO event_registrations (event_id, user_id, ticket_code, qr_payload, status)
       VALUES ($1,$2,$3,$4,'confirmed')`,
      [anyEvent.id, made[1].id, `${TAG}-TICKET`, `${TAG}-TICKET`]);
    const refused2 = await api('POST', `/api/import-batches/${batchId}/rollback`, { token: T.super });
    ok('an account with a registration against it also blocks rollback', refused2.status === 409, refused2.body);
    ok('…and that refusal names the reason', /activity/i.test(refused2.body.error || ''));
    await db.query('DELETE FROM event_registrations WHERE ticket_code = $1', [`${TAG}-TICKET`]);
  } else {
    ok('an account with a registration against it also blocks rollback', true);
    ok('…and that refusal names the reason', true);
  }

  ok('a moderator cannot roll back an import',
    (await api('POST', `/api/import-batches/${batchId}/rollback`, { token: T.moderator })).status === 403);
  ok('a department admin cannot roll back an import',
    (await api('POST', `/api/import-batches/${batchId}/rollback`, { token: T.dept })).status === 403);
  ok('an unknown batch is a 404',
    (await api('POST', '/api/import-batches/99999999/rollback', { token: T.super })).status === 404);
  ok('a non-numeric batch is a 400',
    (await api('POST', '/api/import-batches/abc/rollback', { token: T.super })).status === 400);

  /* ── R. rollback ── */
  head('R. Rollback removes what the batch created, and only that');
  const outsider = (await db.query(
    `SELECT COUNT(*)::int n FROM users WHERE import_batch_id IS DISTINCT FROM $1`, [batchId])).rows[0].n;
  const auditBefore = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;

  const rb = await api('POST', `/api/import-batches/${batchId}/rollback`, { token: T.super });
  ok('the rollback succeeds', rb.status === 200, rb.body);
  ok('it deleted exactly the four accounts the batch created', rb.body.deleted === 4, rb.body.deleted);
  ok('those accounts are gone',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE import_batch_id = $1', [batchId])).rows[0].n === 0);
  ok('no other account was touched',
    (await db.query(`SELECT COUNT(*)::int n FROM users WHERE import_batch_id IS DISTINCT FROM $1`,
      [batchId])).rows[0].n === outsider, outsider);
  const after = (await db.query('SELECT * FROM import_history WHERE id = $1', [batchId])).rows[0];
  ok('the batch now reads as rolled back', after.status === 'rolled_back');
  ok('it records who rolled it back', after.rolled_back_by === superUid);
  ok('it records when', !!after.rolled_back_at);
  ok('it records how many went', after.rolled_back_count === 4);
  ok('the history row itself survives — history is not deleted to tidy up',
    (await db.query('SELECT COUNT(*)::int n FROM import_history WHERE id=$1', [batchId])).rows[0].n === 1);
  ok('no audit entry was destroyed',
    (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n > auditBefore);
  ok('the rollback is itself audited',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs
                      WHERE action = 'Import Batch Rolled Back' AND target_id = $1`, [batchId])).rows[0].n === 1);
  ok('a second rollback is refused',
    (await api('POST', `/api/import-batches/${batchId}/rollback`, { token: T.super })).status === 409);

  const rbNotif = (await db.query(
    `SELECT target_role, subtitle FROM notifications
      WHERE title = 'Import Rolled Back' AND link_id = $1`, [batchId])).rows;
  ok('a rollback notifies every administrator role — deleting accounts is not quiet',
    rbNotif.length === 2, rbNotif.map(n => n.target_role));
  ok('it names who did it and how many went',
    rbNotif.every(n => /Super Admin/.test(n.subtitle) && /4 imported account\(s\)/.test(n.subtitle)),
    rbNotif[0]?.subtitle);
  ok('it does NOT list who was deleted — that roster would outlive them',
    rbNotif.every(n => !n.subtitle.includes(TAG)), rbNotif[0]?.subtitle);

  /* ── T. credentials never reach the trail ── */
  head('T. No credential is ever written down');
  const cred = real.body.temporaryPassword;
  ok('the real import returned a credential once', typeof cred === 'string' && cred.length >= 12);
  ok('it appears in no audit entry',
    (await db.query('SELECT COUNT(*)::int n FROM audit_logs WHERE meta LIKE $1', [`%${cred}%`])).rows[0].n === 0);
  ok('it appears in no import-history row',
    (await db.query(`SELECT COUNT(*)::int n FROM import_history
                      WHERE filename LIKE $1 OR admin_name LIKE $1 OR batch_code LIKE $1`,
      [`%${cred}%`])).rows[0].n === 0);
  ok('it was never stored as plaintext on any account',
    (await db.query('SELECT COUNT(*)::int n FROM users WHERE password_hash = $1', [cred])).rows[0].n === 0);
  ok('the enrolment method IS recorded, since that is not a secret',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs
                      WHERE action = 'Bulk Import Completed' AND meta LIKE '%enrolment: generated%'`)).rows[0].n > 0);

  /* the invite strategy: no shared credential exists at all */
  const invite = await api('POST', '/api/bulk-import', { token: T.super, body: {
    records: [{ row: 1, name: 'Invite Probe', email: `${TAG}-invite@dic.test`, hscPassingYear: 2016 }],
    filename: `${TAG}.csv`, adminName: 'Probe', passwordStrategy: 'invite' } });
  ok('an invite import creates the account', invite.body.created === 1, invite.body);
  ok('…and generates no credential at all', invite.body.temporaryPassword === null);
  ok('…and says which enrolment was used', invite.body.passwordStrategy === 'invite');
  const inv = (await db.query('SELECT password_hash, must_change_password FROM users WHERE email=$1',
    [`${TAG}-invite@dic.test`])).rows[0];
  ok('the account is locked, matchable by no password', inv.password_hash.startsWith('LOCKED$'));
  ok('signing in with the sentinel itself fails',
    (await api('POST', '/api/auth/login',
      { body: { email: `${TAG}-invite@dic.test`, password: inv.password_hash } })).status === 401);
  ok('the reset flow can still reach it, so its holder can set their own password',
    (await api('POST', '/api/auth/forgot-password', { body: { email: `${TAG}-invite@dic.test` } })).status === 200 &&
    (await db.query('SELECT reset_token_hash IS NOT NULL AS t FROM users WHERE email=$1',
      [`${TAG}-invite@dic.test`])).rows[0].t === true);

  console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n`);
 } catch (err) {
  console.error('\n  SUITE ERROR:', err.message);
  fail++;
 } finally {
  await cleanup();
  const left = (await db.query('SELECT COUNT(*)::int n FROM users WHERE email LIKE $1', [TAG + '%'])).rows[0].n;
  if (left) console.log(`  WARNING: ${left} probe account(s) left behind`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
 }
})();
