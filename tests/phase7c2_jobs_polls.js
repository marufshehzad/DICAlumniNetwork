#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7C-2 contract
   Jobs, applications, referrals and polls, end to end.

     A  a job has a lifecycle: open, closed, and expired by its own deadline
     B  only its poster (or an administrator) may change it
     C  an application can be moved through its states, by the right person
     D  …and the applicant can see the result
     E  an employer sees what an employer needs, and no contact data
     F  a referral can be answered, once, by the person it was addressed to
     G  …and answering it does not disclose an address the requester hid
     H  a poll is drafted before it is live, and closes when it says it will
     I  one member, one vote; a draft and a closed poll both refuse
     J  poll administration is staff-only, and a poll with votes is not deleted
     K  the Phase 7C-1 verification gate still holds
     L  every administrative action reaches the audit trail

   Records created here are disposable and removed; nothing pre-existing is
   deleted.

   Usage:  node tests/phase7c2_jobs_polls.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';
const db = require(path.join(REPO, 'db'));

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
const login = async (email, password) =>
  (await api('POST', '/api/auth/login', { body: { email, password: password || CREDS[email] } })).body?.token;

const TAG = 'p7c2-' + Date.now();
const PW = 'Phase7C2-Probe-Pw1';

async function newMember(tag, { verified = true } = {}) {
  const email = `${TAG}-${tag}@dic.test`;
  const r = await api('POST', '/api/auth/register', {
    body: { name: `Probe ${tag}`, email, password: PW, hscPassingYear: 2019, hscGroup: 'Science' } });
  if (!r.body?.token) throw new Error(`register ${tag}: ${r.status} ${JSON.stringify(r.body)}`);
  const uid = r.body.user.id;
  if (verified) {
    await db.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [uid]);
    return { email, uid, token: await login(email, PW) };
  }
  return { email, uid, token: r.body.token };
}

/* Everything this run creates, removed on the way out — including from the
   error path, so a mid-run throw cannot leave rows for the next suite. */
async function cleanup() {
  const ids = (await db.query('SELECT id FROM users WHERE email LIKE $1', [TAG + '%'])).rows.map(r => r.id);
  const jobIds = (await db.query('SELECT id FROM jobs WHERE title LIKE $1', [TAG + '%'])).rows.map(r => r.id);
  for (const j of jobIds) {
    for (const q of ['DELETE FROM job_applications WHERE job_id=$1',
                     'DELETE FROM job_referrals WHERE job_id=$1',
                     'DELETE FROM jobs WHERE id=$1']) {
      try { await db.query(q, [j]); } catch {}
    }
  }
  try { await db.query('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE question LIKE $1)', [TAG + '%']); } catch {}
  try { await db.query('DELETE FROM polls WHERE question LIKE $1', [TAG + '%']); } catch {}
  for (const id of ids) {
    for (const q of ['DELETE FROM job_applications WHERE applicant_id=$1',
                     'DELETE FROM job_referrals WHERE requester_id=$1 OR referrer_id=$1',
                     'DELETE FROM poll_votes WHERE user_id=$1',
                     'DELETE FROM notifications WHERE user_id=$1',
                     'DELETE FROM jobs WHERE posted_by_id=$1',
                     'DELETE FROM consent_logs WHERE user_id=$1',
                     'DELETE FROM alumni_profiles WHERE user_id=$1',
                     'DELETE FROM users WHERE id=$1']) {
      try { await db.query(q, [id]); } catch {}
    }
  }
}

(async () => {
  const T = {
    alumni: await login('alumni@dic.edu.bd'),
    moderator: await login('moderator@dic.edu.bd'),
    dept: await login('departmentadmin@dic.edu.bd'),
    univ: await login('collegeadmin@dic.edu.bd'),
    super: await login('admin@dic.edu.bd')
  };
  const poster = await newMember('poster');
  const seeker = await newMember('seeker');
  const other = await newMember('other');
  const unverified = await newMember('unver', { verified: false });

  /* ── A. a job has a lifecycle ─────────────────────────── */
  head('=== A. A job opens, closes, and expires by its own deadline ===');
  let jobId;
  {
    const made = await api('POST', '/api/jobs', { token: poster.token, body: {
      title: `${TAG} Backend Engineer`, company: 'Probe Ltd', location: 'Dhaka',
      workMode: 'hybrid', type: 'fulltime', description: 'A real description.',
      deadline: '2027-12-31' } });
    ok('a job can be created with a description and a deadline', made.status === 200, made.body);
    jobId = made.body?.id;
    ok('it stores the description', made.body?.description === 'A real description.', made.body?.description);
    ok('it opens by default', made.body?.status === 'open', made.body?.status);

    const listed = (await api('GET', '/api/jobs', { token: seeker.token })).body.find(j => j.id === jobId);
    ok('the list says it is open and not expired', listed?.is_open === true && listed?.is_expired === false, listed);

    ok('a deadline that is not a date is refused',
       (await api('PUT', `/api/jobs/${jobId}`, { token: poster.token, body: { deadline: 'soon' } })).status === 400);
    ok('a status that is not open or closed is refused',
       (await api('PUT', `/api/jobs/${jobId}`, { token: poster.token, body: { status: 'paused' } })).status === 400);

    const closed = await api('PUT', `/api/jobs/${jobId}`, { token: poster.token, body: { status: 'closed' } });
    ok('the poster can close it', closed.status === 200 && closed.body?.status === 'closed', closed.body?.status);
    ok('closing stamps when and by whom',
       !!(await db.query('SELECT closed_at, closed_by FROM jobs WHERE id=$1', [jobId])).rows[0].closed_at);
    ok('a closed job refuses an application',
       (await api('POST', `/api/jobs/${jobId}/apply`, { token: seeker.token, body: {} })).status === 409);
    ok('it is excluded from the open filter',
       !((await api('GET', '/api/jobs?status=open', { token: seeker.token })).body || []).some(j => j.id === jobId));

    const reopened = await api('PUT', `/api/jobs/${jobId}`, { token: poster.token, body: { status: 'open' } });
    ok('and it can be reopened', reopened.body?.status === 'open', reopened.body?.status);
    ok('reopening clears the closure stamp',
       (await db.query('SELECT closed_at FROM jobs WHERE id=$1', [jobId])).rows[0].closed_at === null);

    // expiry is derived, so move the deadline rather than waiting a year
    await db.query(`UPDATE jobs SET deadline = CURRENT_DATE - 1 WHERE id = $1`, [jobId]);
    const expired = (await api('GET', '/api/jobs', { token: seeker.token })).body.find(j => j.id === jobId);
    ok('a past deadline reads as expired without anything writing it',
       expired?.is_expired === true && expired?.is_open === false, expired);
    ok('an expired job refuses an application',
       (await api('POST', `/api/jobs/${jobId}/apply`, { token: seeker.token, body: {} })).status === 409);
    ok('an expired job is still not "open" in the filter',
       !((await api('GET', '/api/jobs?status=open', { token: seeker.token })).body || []).some(j => j.id === jobId));
    await db.query(`UPDATE jobs SET deadline = NULL WHERE id = $1`, [jobId]);
  }

  /* ── B. ownership ─────────────────────────────────────── */
  head('=== B. Only the poster, or an administrator, may change a job ===');
  {
    ok('another member cannot edit it',
       (await api('PUT', `/api/jobs/${jobId}`, { token: other.token, body: { title: 'stolen' } })).status === 403);
    ok('another member cannot delete it',
       (await api('DELETE', `/api/jobs/${jobId}`, { token: other.token })).status === 403);
    ok('another member cannot see the applicants',
       (await api('GET', `/api/jobs/${jobId}/applicants`, { token: other.token })).status === 403);
    ok('a moderator is not automatically the owner',
       (await api('PUT', `/api/jobs/${jobId}`, { token: T.moderator, body: { title: `${TAG} touched` } })).status === 403);
    for (const r of ['univ', 'super']) {
      ok(`${r} may act on any posting, per the existing role policy`,
         (await api('PUT', `/api/jobs/${jobId}`, { token: T[r], body: { salary: 'Negotiable' } })).status === 200);
    }
    const title = (await db.query('SELECT title FROM jobs WHERE id=$1', [jobId])).rows[0].title;
    ok('the refused edits changed nothing', title === `${TAG} Backend Engineer`, title);
  }

  /* ── C/D. applications ────────────────────────────────── */
  head('=== C. An application moves through its states, by the right hand ===');
  let appId;
  {
    const applied = await api('POST', `/api/jobs/${jobId}/apply`, { token: seeker.token, body: { coverNote: 'probe note' } });
    ok('a verified member can apply', applied.status === 200, applied.body);
    ok('applying twice is refused',
       (await api('POST', `/api/jobs/${jobId}/apply`, { token: seeker.token, body: {} })).status === 409);

    const list = (await api('GET', `/api/jobs/${jobId}/applicants`, { token: poster.token })).body;
    ok('the poster sees the applicant', Array.isArray(list) && list.length === 1, list);
    appId = list[0].id;
    ok('it starts in the submitted state', list[0].status === 'submitted', list[0].status);

    ok('an unknown status is refused',
       (await api('PUT', `/api/job-applications/${appId}/status`, { token: poster.token, body: { status: 'maybe' } })).status === 400);
    ok('the applicant cannot promote their own application',
       (await api('PUT', `/api/job-applications/${appId}/status`, { token: seeker.token, body: { status: 'hired' } })).status === 403);
    ok('an unrelated member cannot touch it',
       (await api('PUT', `/api/job-applications/${appId}/status`, { token: other.token, body: { status: 'rejected' } })).status === 403);

    const moved = await api('PUT', `/api/job-applications/${appId}/status`, { token: poster.token, body: { status: 'shortlisted' } });
    ok('the poster can shortlist', moved.status === 200 && moved.body?.status === 'shortlisted', moved.body);
    ok('the change is stamped',
       !!(await db.query('SELECT status_changed_at, status_changed_by FROM job_applications WHERE id=$1', [appId])).rows[0].status_changed_at);
    ok('an administrator can also act',
       (await api('PUT', `/api/job-applications/${appId}/status`, { token: T.super, body: { status: 'hired' } })).status === 200);
  }

  head('=== D. …and the applicant can see what happened ===');
  {
    const mine = (await api('GET', '/api/my-applications', { token: seeker.token })).body;
    ok('the applicant sees their own application', Array.isArray(mine) && mine.length === 1, mine);
    ok('with its current status', mine[0]?.status === 'hired', mine[0]?.status);
    ok('and the job it was for', mine[0]?.title === `${TAG} Backend Engineer`, mine[0]?.title);
    ok('another member sees none of it',
       ((await api('GET', '/api/my-applications', { token: other.token })).body || []).length === 0);
    ok('the applicant was notified of the change',
       (await db.query(`SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND title='Application update'`,
                       [seeker.uid])).rows[0].n >= 1);
  }

  /* ── E. what the employer is shown ────────────────────── */
  head('=== E. An employer sees an applicant, not their contact details ===');
  {
    const list = (await api('GET', `/api/jobs/${jobId}/applicants`, { token: poster.token })).body;
    const keys = Object.keys(list[0]);
    for (const forbidden of ['email', 'primary_email', 'mobile', 'mobile_number', 'phone',
                             'present_address', 'permanent_address', 'postal_code', 'city', 'country']) {
      ok(`the applicant list carries no ${forbidden}`, !keys.includes(forbidden), keys);
    }
    ok('it does carry what an employer needs',
       keys.includes('name') && keys.includes('batch') && keys.includes('skills') && keys.includes('cover_note'));
  }

  /* ── F/G. referrals ───────────────────────────────────── */
  head('=== F. A referral is answered once, by the person it was sent to ===');
  let refId;
  {
    const asked = await api('POST', `/api/jobs/${jobId}/refer`, { token: seeker.token, body: { message: 'probe' } });
    ok('a member can ask the poster for a referral', asked.status === 200, asked.body);
    refId = asked.body?.referral?.id;
    ok('it starts pending', asked.body?.referral?.status === 'pending', asked.body?.referral?.status);

    ok('the requester cannot answer their own request',
       (await api('PUT', `/api/job-referrals/${refId}`, { token: seeker.token, body: { status: 'accepted' } })).status === 403);
    ok('an unrelated member cannot answer it',
       (await api('PUT', `/api/job-referrals/${refId}`, { token: other.token, body: { status: 'accepted' } })).status === 403);
    ok('an administrator cannot vouch on the poster\'s behalf',
       (await api('PUT', `/api/job-referrals/${refId}`, { token: T.super, body: { status: 'accepted' } })).status === 403);
    ok('a status outside accepted/declined is refused',
       (await api('PUT', `/api/job-referrals/${refId}`, { token: poster.token, body: { status: 'maybe' } })).status === 400);

    const answered = await api('PUT', `/api/job-referrals/${refId}`, { token: poster.token, body: { status: 'accepted' } });
    ok('the poster can accept', answered.status === 200 && answered.body?.status === 'accepted', answered.body);
    ok('the answer is stamped', !!answered.body?.responded_at);
    ok('answering twice is refused',
       (await api('PUT', `/api/job-referrals/${refId}`, { token: poster.token, body: { status: 'declined' } })).status === 409);
    ok('the requester was notified',
       (await db.query(`SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND title='Referral accepted'`,
                       [seeker.uid])).rows[0].n === 1);

    // and a decline, on its own request
    const asked2 = await api('POST', `/api/jobs/${jobId}/refer`, { token: other.token, body: { message: 'probe 2' } });
    const dec = await api('PUT', `/api/job-referrals/${asked2.body.referral.id}`, { token: poster.token, body: { status: 'declined' } });
    ok('a referral can be declined', dec.body?.status === 'declined', dec.body);
    ok('the requester was told', (await db.query(
       `SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND title='Referral declined'`, [other.uid])).rows[0].n === 1);
  }

  head('=== G. …without disclosing an address the requester had hidden ===');
  {
    await api('PUT', '/api/profile/me', { token: seeker.token, body: { privacySettings: { email: 'private' } } });
    const seenByPoster = ((await api('GET', '/api/job-referrals', { token: poster.token })).body || [])
      .find(r => r.id === refId);
    ok('a private email is withheld from the poster', seenByPoster && seenByPoster.requester_email === null, seenByPoster);

    const seenBySelf = ((await api('GET', '/api/job-referrals', { token: seeker.token })).body || []).find(r => r.id === refId);
    ok('the requester still sees their own address', !!seenBySelf?.requester_email);

    await api('PUT', '/api/profile/me', { token: seeker.token, body: { privacySettings: { email: 'public' } } });
    const nowVisible = ((await api('GET', '/api/job-referrals', { token: poster.token })).body || []).find(r => r.id === refId);
    ok('and it returns when they make it visible again', !!nowVisible?.requester_email);

    ok('a member sees no referral that is not theirs',
       ((await api('GET', '/api/job-referrals', { token: (await newMember('nosy')).token })).body || []).length === 0);
  }

  /* ── H/I/J. polls ─────────────────────────────────────── */
  head('=== H. A poll is drafted before it is live ===');
  let pollId;
  {
    ok('an alumnus cannot create a poll',
       (await api('POST', '/api/polls', { token: T.alumni, body: { question: `${TAG} q`, options: ['a', 'b'] } })).status === 403);
    ok('a poll needs two options',
       (await api('POST', '/api/polls', { token: T.moderator, body: { question: `${TAG} q`, options: ['only one'] } })).status === 400);
    ok('a poll needs a question',
       (await api('POST', '/api/polls', { token: T.moderator, body: { question: '', options: ['a', 'b'] } })).status === 400);

    const made = await api('POST', '/api/polls', { token: T.moderator,
      body: { question: `${TAG} Which day suits the reunion?`, options: ['Friday', 'Saturday', 'Sunday'] } });
    ok('a moderator can create one', made.status === 200, made.body);
    pollId = made.body?.id;
    ok('it starts as a draft', made.body?.status === 'draft', made.body?.status);
    ok('a draft is not offered to members',
       ((await api('GET', '/api/polls/active', { token: T.alumni })).body || {}).id !== pollId);
    ok('a draft refuses a vote',
       (await api('POST', `/api/polls/${pollId}/vote`, { token: T.alumni, body: { optionIndex: 0 } })).status === 403);

    const edited = await api('PUT', `/api/polls/${pollId}`, { token: T.moderator,
      body: { question: `${TAG} Which day suits the reunion best?`, options: ['Friday', 'Saturday'] } });
    ok('a draft can be edited', edited.status === 200 && edited.body.options.length === 2, edited.body);

    const opened = await api('PUT', `/api/polls/${pollId}/status`, { token: T.moderator, body: { status: 'open' } });
    ok('and then opened', opened.status === 200 && opened.body?.status === 'open', opened.body);
    ok('opening is stamped', !!opened.body?.opened_at);
    ok('an open poll cannot be edited — votes attach to its options',
       (await api('PUT', `/api/polls/${pollId}`, { token: T.moderator, body: { question: 'x', options: ['a', 'b'] } })).status === 409);
  }

  head('=== I. One member, one vote; closed means closed ===');
  {
    const v1 = await api('POST', `/api/polls/${pollId}/vote`, { token: seeker.token, body: { optionIndex: 0 } });
    ok('a member can vote', v1.status === 200, v1.body);
    ok('an option that does not exist is refused',
       (await api('POST', `/api/polls/${pollId}/vote`, { token: seeker.token, body: { optionIndex: 9 } })).status === 400);
    await api('POST', `/api/polls/${pollId}/vote`, { token: seeker.token, body: { optionIndex: 1 } });
    ok('voting again replaces, never adds a second vote',
       (await db.query('SELECT COUNT(*)::int n FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [pollId, seeker.uid])).rows[0].n === 1);

    // a closing time in the past must close it, which is the bug this fixes
    await db.query(`UPDATE polls SET closes_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id=$1`, [pollId]);
    ok('a poll past its closing time refuses a vote',
       (await api('POST', `/api/polls/${pollId}/vote`, { token: other.token, body: { optionIndex: 0 } })).status === 409);
    ok('…and is no longer offered as the active poll',
       ((await api('GET', '/api/polls/active', { token: T.alumni })).body || {})?.id !== pollId);
    await db.query(`UPDATE polls SET closes_at = NULL WHERE id=$1`, [pollId]);

    const closed = await api('PUT', `/api/polls/${pollId}/status`, { token: T.moderator, body: { status: 'closed' } });
    ok('a moderator can close it', closed.body?.status === 'closed');
    ok('a closed poll refuses a vote',
       (await api('POST', `/api/polls/${pollId}/vote`, { token: other.token, body: { optionIndex: 0 } })).status === 409);
    ok('a closed poll is not reopened',
       (await api('PUT', `/api/polls/${pollId}/status`, { token: T.moderator, body: { status: 'open' } })).status === 409);
  }

  head('=== J. Poll administration is staff-only, and votes are not deleted ===');
  {
    ok('an alumnus cannot list every poll', (await api('GET', '/api/polls', { token: T.alumni })).status === 403);
    ok('an alumnus cannot read the results endpoint',
       (await api('GET', `/api/polls/${pollId}/results`, { token: T.alumni })).status === 403);
    ok('a moderator can', (await api('GET', '/api/polls', { token: T.moderator })).status === 200);

    const results = (await api('GET', `/api/polls/${pollId}/results`, { token: T.moderator })).body;
    ok('the results count the real votes', results?.total === 1, results);
    ok('the counts line up with the options', Array.isArray(results?.counts) && results.counts.length === results.options.length);

    ok('an alumnus cannot delete a poll', (await api('DELETE', `/api/polls/${pollId}`, { token: T.alumni })).status === 403);
    ok('a moderator cannot delete a poll either — that is an admin act',
       (await api('DELETE', `/api/polls/${pollId}`, { token: T.moderator })).status === 403);
    const refused = await api('DELETE', `/api/polls/${pollId}`, { token: T.super });
    ok('a poll holding votes is refused deletion', refused.status === 409, refused.body);
    ok('…and it is still there', (await db.query('SELECT 1 FROM polls WHERE id=$1', [pollId])).rows.length === 1);

    const empty = await api('POST', '/api/polls', { token: T.moderator, body: { question: `${TAG} disposable`, options: ['a', 'b'] } });
    ok('a poll with no votes can be deleted',
       (await api('DELETE', `/api/polls/${empty.body.id}`, { token: T.super })).status === 200);
  }

  /* ── K. the 7C-1 gate still holds ─────────────────────── */
  head('=== K. The verification gate from Phase 7C-1 is untouched ===');
  {
    ok('an unverified member cannot post a job',
       (await api('POST', '/api/jobs', { token: unverified.token, body: { title: `${TAG} x`, company: 'y' } })).status === 403);
    ok('an unverified member cannot apply',
       (await api('POST', `/api/jobs/${jobId}/apply`, { token: unverified.token, body: {} })).status === 403);
    ok('an unverified member cannot ask for a referral',
       (await api('POST', `/api/jobs/${jobId}/refer`, { token: unverified.token, body: {} })).status === 403);
    ok('an unverified member cannot answer a referral',
       (await api('PUT', `/api/job-referrals/${refId}`, { token: unverified.token, body: { status: 'accepted' } })).status === 403);
    ok('but may still browse jobs',
       (await api('GET', '/api/jobs', { token: unverified.token })).status === 200);
  }

  /* ── L. the audit trail ───────────────────────────────── */
  head('=== L. Administrative actions reach the audit trail ===');
  {
    for (const action of ['Job Created', 'Job Edited', 'Job Closed', 'Job Reopened',
                          'Application Status Changed', 'Referral Accepted', 'Referral Declined',
                          'Poll Created', 'Poll Edited', 'Poll Opened', 'Poll Closed', 'Poll Deleted']) {
      const n = (await db.query('SELECT COUNT(*)::int n FROM audit_logs WHERE action = $1', [action])).rows[0].n;
      ok(`"${action}" is recorded`, n > 0, n);
    }
    const leak = await db.query(
      `SELECT COUNT(*)::int n FROM audit_logs WHERE meta ILIKE '%password%' OR meta ILIKE '%token%'`);
    ok('no audit entry carries a credential', leak.rows[0].n === 0, leak.rows[0]);
  }

  /* ── cleanup ──────────────────────────────────────────── */
  head('=== cleanup ===');
  {
    await cleanup();
    ok('every probe account was removed',
       (await db.query('SELECT COUNT(*)::int n FROM users WHERE email LIKE $1', [TAG + '%'])).rows[0].n === 0);
    ok('every probe job was removed',
       (await db.query('SELECT COUNT(*)::int n FROM jobs WHERE title LIKE $1', [TAG + '%'])).rows[0].n === 0);
    ok('every probe poll was removed',
       (await db.query('SELECT COUNT(*)::int n FROM polls WHERE question LIKE $1', [TAG + '%'])).rows[0].n === 0);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nSUITE ERROR:', e.message);
  try { await cleanup(); } catch {}
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
