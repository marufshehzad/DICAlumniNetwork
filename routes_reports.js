/* ============================================================
   DIC ALUMNI PLATFORM — REPORTS AND EXPORTS
   Phase 7C-3.

   The admin portal's navigation had an entry labelled "Reports". It opened a
   page titled "Executive Analytics" holding five charts, and there was no way
   to get a row of data out of the platform in any form except one event's
   attendee list — an endpoint with no interface, so in practice: none.

   This is a registry, not ten hand-written endpoints. Every report declares
   its label, the roles that may run it, its column list and its query, and two
   generic routes serve all of them. That means the permission check, the date
   range parsing, the row cap and the CSV writer each exist exactly once, and a
   report added later cannot accidentally skip one.

   Rules this file is built to keep, and where they are enforced:

   • No credential ever leaves. csv.js throws on a column whose key or header
     reads as a secret, and no query below selects password_hash, a token, a
     reset hash or identity-vault plaintext. The guard is mechanical rather
     than a matter of review.
   • Location privacy has no staff bypass — privacy.js says so — so the
     alumni export blanks city, district and division for a member who set
     location to private, even for a super administrator. Email and mobile do
     carry a staff bypass, and are exported.
   • Every figure is counted from rows. The stored counters campaigns.raised_amount,
     campaigns.donors_count, chapters.members_count, chapters.events_count and
     events.registered_count are all deliberately unused: server.js already
     records that they were seeded far above the rows behind them and can drift.
   • Anonymous donations stay anonymous. is_anonymous suppresses the donor's
     name and email in the ledger, not merely in the public list.
   ============================================================ */

const db = require('./db');
const privacy = require('./privacy');
const { sendCsv } = require('./csv');
const { MODULE_NAMES, moduleCaseSql } = require('./audit_modules');
const scope = require('./scope');

/* Phase 7D: roles that may run a report at all. DEPT_ROLES is not a widening —
   a department admin sees the same reports as a college admin, restricted to
   its own department by the scope clause each query carries. A report with no
   department dimension is NOT in DEPT_ROLES, because there is nothing to
   restrict it to and an unrestricted institutional report is exactly what a
   department admin must not have. */
module.exports = function (app, guards) {
  const { requireRole, ADMIN_ROLES, MODERATOR_ROLES, serverError, writeAudit } = guards;

  /* Institution-wide roles plus department admins. Every report using this
     list applies scope.sqlFor to a real department_id column — that pairing is
     asserted by the suite, so a report cannot join this list without one. */
  const DEPT_ROLES = [...ADMIN_ROLES, 'dept_admin'];
  const ok = (res, fn) => fn().catch(err => serverError(res, err, 'reports'));

  /* ─── date range ───────────────────────────────────────────
     Both bounds are optional and inclusive. "to" is turned into "before the
     following midnight" so that a range ending today includes today, which is
     what every operator means and what a naive <= on a timestamp does not do. */
  function dateRange(query) {
    const parse = (v, label) => {
      if (v === undefined || v === null || v === '') return null;
      const s = String(v).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequest(`${label} must be a date, as YYYY-MM-DD`);
      const d = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new BadRequest(`${label} is not a real date`);
      return s;
    };
    const from = parse(query.from, 'from');
    const to = parse(query.to, 'to');
    if (from && to && from > to) throw new BadRequest('from must not be later than to');
    return { from, to };
  }

  class BadRequest extends Error {}

  /* A range applied to one column. Returns SQL and the parameters to append. */
  function rangeClause(column, { from, to }, params) {
    const parts = [];
    if (from) { params.push(from); parts.push(`${column} >= $${params.length}::date`); }
    if (to)   { params.push(to);   parts.push(`${column} < ($${params.length}::date + INTERVAL '1 day')`); }
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  }

  /* ─── row cap ──────────────────────────────────────────────
     A report is read into memory before it is written out, so it needs a
     ceiling. 5,000 rows on screen, 50,000 in a file: enough for an alumni body
     many times the size of this one, and small enough that a single request
     cannot exhaust the process. A capped result says so in its payload rather
     than quietly ending early. */
  const SCREEN_CAP = 5000;
  const FILE_CAP = 50000;

  function rowLimit(query, isCsv) {
    const cap = isCsv ? FILE_CAP : SCREEN_CAP;
    const asked = parseInt(query.limit, 10);
    if (Number.isFinite(asked) && asked > 0) return Math.min(asked, cap);
    return cap;
  }

  /* ═══ THE REPORT REGISTRY ═══════════════════════════════════
     Each entry: who may run it, what the columns are (in order, server-side,
     never negotiable by the caller), which filters it accepts, and the query.
     `run` receives the parsed filters and returns rows. */

  const REPORTS = {

    /* ─── A. Alumni Directory ─── */
    'alumni-directory': {
      label: 'Alumni Directory',
      description: 'Every alumni account, with graduation and employment detail. ' +
                   'Location is withheld for members who set it to private — that setting has no staff override.',
      roles: DEPT_ROLES,
      scoped: 'u.department_id',
      filters: ['from', 'to', 'department', 'batch', 'status'],
      dateLabel: 'Account created',
      columns: [
        { key: 'user_id', header: 'Account ID' },
        { key: 'full_name', header: 'Name' },
        { key: 'email', header: 'Email' },
        { key: 'mobile_number', header: 'Mobile' },
        { key: 'department', header: 'Department' },
        { key: 'department_code', header: 'Department code' },
        { key: 'batch', header: 'Batch' },
        { key: 'passing_year', header: 'Passing year' },
        { key: 'program', header: 'Programme' },
        { key: 'current_status', header: 'Current status' },
        { key: 'current_company', header: 'Organisation' },
        { key: 'job_title', header: 'Designation' },
        { key: 'industry', header: 'Industry' },
        { key: 'city', header: 'City' },
        { key: 'district', header: 'District' },
        { key: 'division', header: 'Division' },
        { key: 'country', header: 'Country' },
        { key: 'location_withheld', header: 'Location withheld by member' },
        { key: 'account_status', header: 'Account status' },
        { key: 'verified', header: 'Verified' },
        { key: 'created_at', header: 'Account created' },
        { key: 'last_login_at', header: 'Last sign-in' }
      ],
      async run(f) {
        const params = [];
        let where = "WHERE u.role = 'alumni'";
        /* The scope clause goes on FIRST, so no later filter can widen past it.
           A caller supplying ?department= narrows within their scope; it can
           never reach outside it, because both clauses are ANDed and the scope
           one is not built from anything in the request. */
        where += scope.sqlFor(f.user, 'u.department_id', params);
        where += rangeClause('u.created_at', f.range, params);
        if (f.department) { params.push(f.department); where += ` AND u.department = $${params.length}`; }
        if (f.batch)      { params.push(f.batch);      where += ` AND ap.batch = $${params.length}`; }
        if (f.status)     { params.push(f.status);     where += ` AND u.status = $${params.length}`; }
        params.push(f.limit);

        /* Location privacy carries no staff bypass, so it is applied in SQL
           rather than trusted to the caller's role. A member who chose
           'private' exports as blank, with a column saying the blank is a
           choice and not missing data — otherwise an operator reads it as an
           incomplete profile and goes looking. */
        const { rows } = await db.query(`
          SELECT u.id AS user_id, u.full_name, u.email, u.department,
                 u.status AS account_status, u.is_verified AS verified,
                 u.created_at, u.last_login_at, dept.code AS department_code,
                 ap.batch, ap.passing_year, ap.program, ap.current_status,
                 ap.current_company, ap.job_title, ap.industry, ap.mobile_number,
                 CASE WHEN ${privacy.DIRECTORY_VISIBLE_SQL} THEN ap.city     END AS city,
                 CASE WHEN ${privacy.DIRECTORY_VISIBLE_SQL} THEN ap.district END AS district,
                 CASE WHEN ${privacy.DIRECTORY_VISIBLE_SQL} THEN ap.division END AS division,
                 CASE WHEN ${privacy.DIRECTORY_VISIBLE_SQL} THEN ap.country  END AS country,
                 NOT (${privacy.DIRECTORY_VISIBLE_SQL}) AS location_withheld
          FROM users u
          LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
          LEFT JOIN departments dept ON dept.id = u.department_id
          ${where}
          ORDER BY u.id
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── B. Event Attendance ─── */
    'event-attendance': {
      label: 'Event Attendance',
      description: 'One row per event: registered, checked in, and the attendance rate counted from registrations.',
      roles: MODERATOR_ROLES,
      scoped: 'e.department_id',
      filters: ['from', 'to'],
      dateLabel: 'Event date',
      columns: [
        { key: 'event_id', header: 'Event ID' },
        { key: 'title', header: 'Event' },
        { key: 'starts_on', header: 'Date' },
        { key: 'venue', header: 'Venue' },
        { key: 'organizer_department', header: 'Organising department' },
        { key: 'status', header: 'Status' },
        { key: 'capacity', header: 'Capacity' },
        { key: 'registered', header: 'Registered' },
        { key: 'cancelled', header: 'Cancelled' },
        { key: 'checked_in', header: 'Checked in' },
        { key: 'attendance_rate_pct', header: 'Attendance rate %' },
        { key: 'gross_paid', header: 'Ticket revenue (BDT)' }
      ],
      async run(f) {
        const params = [];
        let where = 'WHERE TRUE';
        where += scope.sqlFor(f.user, 'e.department_id', params);
        /* starts_on, not event_date. Phase 7C-3 wrote this against event_date,
           which is a VARCHAR populated on 7 of 21 events — so the column read
           blank for two thirds of the report and the date filter compared a
           string to a date. starts_on is the typed DATE every event has, and
           qa1 already asserts it is the authoritative one. */
        where += rangeClause('e.starts_on', f.range, params);
        params.push(f.limit);

        /* registered_count is a stored counter on events and is not read here.
           Every number below is counted from event_registrations. The rate is
           checked-in over confirmed, not over every row ever created, because
           a cancelled registration was never going to attend. */
        const { rows } = await db.query(`
          SELECT e.id AS event_id, e.title, e.starts_on, e.venue,
                 e.organizer_department, e.status, e.capacity,
                 COUNT(r.id) FILTER (WHERE r.status = 'confirmed')::int AS registered,
                 COUNT(r.id) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                 COUNT(r.id) FILTER (WHERE r.checked_in)::int           AS checked_in,
                 CASE WHEN COUNT(r.id) FILTER (WHERE r.status = 'confirmed') > 0
                      THEN ROUND(100.0 * COUNT(r.id) FILTER (WHERE r.checked_in)
                                       / COUNT(r.id) FILTER (WHERE r.status = 'confirmed'))::int
                 END AS attendance_rate_pct,
                 COALESCE(SUM(r.amount_paid) FILTER (WHERE r.status = 'confirmed'), 0) AS gross_paid
          FROM events e
          LEFT JOIN event_registrations r ON r.event_id = e.id
          ${where}
          GROUP BY e.id
          ORDER BY e.starts_on DESC NULLS LAST, e.id DESC
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── C. Ticket / Registration ─── */
    'ticket-registration': {
      label: 'Ticket & Registration',
      description: 'One row per registration, with ticket code, payment and check-in.',
      roles: MODERATOR_ROLES,
      scoped: 'e.department_id',
      filters: ['from', 'to', 'eventId', 'status'],
      dateLabel: 'Registered',
      columns: [
        { key: 'registration_id', header: 'Registration ID' },
        { key: 'event_title', header: 'Event' },
        { key: 'starts_on', header: 'Event date' },
        { key: 'attendee_name', header: 'Attendee' },
        { key: 'attendee_email', header: 'Email' },
        { key: 'ticket_type', header: 'Ticket type' },
        { key: 'ticket_code', header: 'Ticket code' },
        { key: 'amount_paid', header: 'Amount paid (BDT)' },
        { key: 'payment_gateway', header: 'Payment method' },
        { key: 'status', header: 'Status' },
        { key: 'checked_in', header: 'Checked in' },
        { key: 'checked_in_at', header: 'Checked in at' },
        { key: 'created_at', header: 'Registered' }
      ],
      async run(f) {
        const params = [];
        let where = 'WHERE TRUE';
        where += scope.sqlFor(f.user, 'e.department_id', params);
        where += rangeClause('r.created_at', f.range, params);
        if (f.eventId) { params.push(f.eventId); where += ` AND r.event_id = $${params.length}::int`; }
        if (f.status)  { params.push(f.status);  where += ` AND r.status = $${params.length}`; }
        params.push(f.limit);

        const { rows } = await db.query(`
          SELECT r.id AS registration_id, e.title AS event_title, e.starts_on,
                 u.full_name AS attendee_name, u.email AS attendee_email,
                 COALESCE(tt.name, r.ticket_type) AS ticket_type,
                 r.ticket_code, r.amount_paid, r.payment_gateway, r.status,
                 r.checked_in, r.checked_in_at, r.created_at
          FROM event_registrations r
          JOIN events e ON e.id = r.event_id
          LEFT JOIN users u ON u.id = r.user_id
          LEFT JOIN event_ticket_types tt ON tt.id = r.ticket_type_id
          ${where}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── D. Donation Ledger ─── */
    'donation-ledger': {
      label: 'Donation Ledger',
      description: 'Every donation with its settlement state. Donors who gave anonymously are not named.',
      roles: ADMIN_ROLES,
      filters: ['from', 'to', 'status', 'campaignId'],
      dateLabel: 'Recorded',
      columns: [
        { key: 'donation_id', header: 'Donation ID' },
        { key: 'receipt_code', header: 'Receipt' },
        { key: 'campaign_name', header: 'Campaign' },
        { key: 'donor_name', header: 'Donor' },
        { key: 'donor_email', header: 'Donor email' },
        { key: 'is_anonymous', header: 'Anonymous' },
        { key: 'amount', header: 'Amount' },
        { key: 'currency', header: 'Currency' },
        { key: 'status', header: 'Status' },
        { key: 'payment_gateway', header: 'Gateway' },
        { key: 'transaction_reference', header: 'Transaction reference' },
        { key: 'recorded_method', header: 'Recorded by' },
        { key: 'completed_at', header: 'Settled' },
        { key: 'created_at', header: 'Recorded' }
      ],
      async run(f) {
        const params = [];
        let where = 'WHERE TRUE';
        where += rangeClause('d.created_at', f.range, params);
        if (f.status)     { params.push(String(f.status).toUpperCase()); where += ` AND d.status = $${params.length}`; }
        if (f.campaignId) { params.push(f.campaignId); where += ` AND d.campaign_id = $${params.length}::int`; }
        params.push(f.limit);

        /* An anonymous gift is anonymous in the ledger too. Finance can still
           reconcile it: the receipt code, the transaction reference and the
           amount are all present. What is withheld is only the identity, which
           is the thing the donor was promised. */
        const { rows } = await db.query(`
          SELECT d.id AS donation_id, d.receipt_code, c.name AS campaign_name,
                 CASE WHEN d.is_anonymous THEN NULL ELSE COALESCE(u.full_name, d.donor_name) END AS donor_name,
                 CASE WHEN d.is_anonymous THEN NULL ELSE u.email END AS donor_email,
                 d.is_anonymous, d.amount, d.currency, d.status, d.payment_gateway,
                 d.transaction_reference, d.recorded_method, d.completed_at, d.created_at
          FROM donations d
          LEFT JOIN campaigns c ON c.id = d.campaign_id
          LEFT JOIN users u ON u.id = d.donor_user_id
          ${where}
          ORDER BY d.created_at DESC, d.id DESC
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── E. Campaign Summary ─── */
    'campaign-summary': {
      label: 'Campaign Summary',
      description: 'Per campaign: money actually settled, money pledged but not settled, and donor counts — ' +
                   'all counted from donation rows, not from the stored campaign totals.',
      roles: ADMIN_ROLES,
      filters: [],
      columns: [
        { key: 'campaign_id', header: 'Campaign ID' },
        { key: 'name', header: 'Campaign' },
        { key: 'tag', header: 'Tag' },
        { key: 'goal_amount', header: 'Goal (BDT)' },
        { key: 'settled_amount', header: 'Settled (BDT)' },
        { key: 'pledged_amount', header: 'Pledged, not settled (BDT)' },
        { key: 'settled_gifts', header: 'Settled gifts' },
        { key: 'pledged_gifts', header: 'Pledges outstanding' },
        { key: 'distinct_donors', header: 'Distinct identified donors' },
        { key: 'anonymous_gifts', header: 'Anonymous gifts' },
        { key: 'goal_progress_pct', header: 'Progress toward goal %' },
        { key: 'first_gift_at', header: 'First gift' },
        { key: 'latest_gift_at', header: 'Latest gift' }
      ],
      async run(f) {
        /* campaigns.raised_amount and campaigns.donors_count are ignored on
           purpose. Both were seeded far above the donations behind them —
           ৳18.45L against ৳5,000 of settled gifts — and a report that repeated
           them would be reporting the seed, not the money. */
        const { rows } = await db.query(`
          SELECT c.id AS campaign_id, c.name, c.tag, c.goal_amount,
                 COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'SUCCESS'), 0) AS settled_amount,
                 COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'PLEDGED'), 0) AS pledged_amount,
                 COUNT(d.id) FILTER (WHERE d.status = 'SUCCESS')::int AS settled_gifts,
                 COUNT(d.id) FILTER (WHERE d.status = 'PLEDGED')::int AS pledged_gifts,
                 COUNT(DISTINCT d.donor_user_id) FILTER (WHERE d.status = 'SUCCESS' AND NOT d.is_anonymous)::int
                   AS distinct_donors,
                 COUNT(d.id) FILTER (WHERE d.is_anonymous)::int AS anonymous_gifts,
                 CASE WHEN c.goal_amount > 0
                      THEN ROUND(100.0 * COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'SUCCESS'), 0)
                                       / c.goal_amount, 1)
                 END AS goal_progress_pct,
                 MIN(d.created_at) FILTER (WHERE d.status = 'SUCCESS') AS first_gift_at,
                 MAX(d.created_at) FILTER (WHERE d.status = 'SUCCESS') AS latest_gift_at
          FROM campaigns c
          LEFT JOIN donations d ON d.campaign_id = c.id
          GROUP BY c.id
          ORDER BY settled_amount DESC, c.id
          LIMIT $1`, [f.limit]);
        return rows;
      }
    },

    /* ─── F. Job & Application ─── */
    'job-application': {
      label: 'Job & Application',
      description: 'One row per posting, with its application funnel counted from applications.',
      roles: ADMIN_ROLES,
      filters: ['from', 'to', 'status'],
      dateLabel: 'Posted',
      columns: [
        { key: 'job_id', header: 'Job ID' },
        { key: 'title', header: 'Role' },
        { key: 'company', header: 'Organisation' },
        { key: 'location', header: 'Location' },
        { key: 'work_mode', header: 'Work mode' },
        { key: 'type', header: 'Employment type' },
        { key: 'posted_by_name', header: 'Posted by' },
        { key: 'status', header: 'Status' },
        { key: 'deadline', header: 'Apply by' },
        { key: 'is_expired', header: 'Deadline passed' },
        { key: 'applications', header: 'Applications' },
        { key: 'reviewing', header: 'Reviewing' },
        { key: 'shortlisted', header: 'Shortlisted' },
        { key: 'rejected', header: 'Rejected' },
        { key: 'hired', header: 'Hired' },
        { key: 'referrals_requested', header: 'Referrals requested' },
        { key: 'referrals_accepted', header: 'Referrals accepted' },
        { key: 'created_at', header: 'Posted' }
      ],
      async run(f) {
        const params = [];
        let where = 'WHERE TRUE';
        where += rangeClause('j.created_at', f.range, params);
        if (f.status) { params.push(f.status); where += ` AND j.status = $${params.length}`; }
        params.push(f.limit);

        const { rows } = await db.query(`
          SELECT j.id AS job_id, j.title, j.company, j.location, j.work_mode, j.type,
                 j.posted_by_name, j.status, j.deadline, j.created_at,
                 (j.deadline IS NOT NULL AND j.deadline < CURRENT_DATE) AS is_expired,
                 COUNT(DISTINCT a.id)::int AS applications,
                 COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'reviewing')::int   AS reviewing,
                 COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'shortlisted')::int AS shortlisted,
                 COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'rejected')::int    AS rejected,
                 COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'hired')::int       AS hired,
                 COUNT(DISTINCT rf.id)::int AS referrals_requested,
                 COUNT(DISTINCT rf.id) FILTER (WHERE rf.status = 'accepted')::int AS referrals_accepted
          FROM jobs j
          LEFT JOIN job_applications a ON a.job_id = j.id
          LEFT JOIN job_referrals rf ON rf.job_id = j.id
          ${where}
          GROUP BY j.id
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── G. Mentorship ─── */
    'mentorship': {
      label: 'Mentorship',
      description: 'One row per mentorship, with both parties and the state of the match.',
      roles: ADMIN_ROLES,
      filters: ['from', 'to', 'status'],
      dateLabel: 'Requested',
      columns: [
        { key: 'mentorship_id', header: 'Mentorship ID' },
        { key: 'mentor_name', header: 'Mentor' },
        { key: 'mentor_department', header: 'Mentor department' },
        { key: 'mentee_name', header: 'Mentee' },
        { key: 'mentee_department', header: 'Mentee department' },
        { key: 'subject', header: 'Subject' },
        { key: 'status', header: 'Status' },
        { key: 'match_score', header: 'Match score' },
        { key: 'created_at', header: 'Requested' },
        { key: 'responded_at', header: 'Answered' },
        { key: 'completed_at', header: 'Completed' },
        { key: 'days_to_response', header: 'Days to answer' }
      ],
      async run(f) {
        const params = [];
        let where = 'WHERE TRUE';
        where += rangeClause('m.created_at', f.range, params);
        if (f.status) { params.push(f.status); where += ` AND m.status = $${params.length}`; }
        params.push(f.limit);

        /* health_score is a stored column and is not reported: nothing in the
           platform computes it, so it would be a number with no method behind
           it. Days to answer is arithmetic on two real timestamps instead. */
        const { rows } = await db.query(`
          SELECT m.id AS mentorship_id,
                 mentor.full_name AS mentor_name, mentor.department AS mentor_department,
                 mentee.full_name AS mentee_name, mentee.department AS mentee_department,
                 m.subject, m.status, m.match_score,
                 m.created_at, m.responded_at, m.completed_at,
                 CASE WHEN m.responded_at IS NOT NULL
                      THEN ROUND(EXTRACT(EPOCH FROM (m.responded_at - m.created_at)) / 86400.0, 1)
                 END AS days_to_response
          FROM mentorships m
          LEFT JOIN users mentor ON mentor.id = m.mentor_id
          LEFT JOIN users mentee ON mentee.id = m.mentee_id
          ${where}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── H. Chapter ─── */
    'chapter': {
      label: 'Chapter',
      description: 'Per chapter: membership counted from memberships, plus its location where one is set.',
      roles: ADMIN_ROLES,
      filters: ['status'],
      columns: [
        { key: 'chapter_id', header: 'Chapter ID' },
        { key: 'name', header: 'Chapter' },
        { key: 'type', header: 'Type' },
        { key: 'status', header: 'Status' },
        { key: 'members', header: 'Members' },
        { key: 'joined_last_90_days', header: 'Joined in last 90 days' },
        { key: 'city', header: 'City' },
        { key: 'district', header: 'District' },
        { key: 'country', header: 'Country' },
        { key: 'created_by_name', header: 'Created by' },
        { key: 'created_at', header: 'Created' }
      ],
      async run(f) {
        const params = [];
        let where = 'WHERE TRUE';
        if (f.status) { params.push(f.status); where += ` AND c.status = $${params.length}`; }
        params.push(f.limit);

        /* chapters.members_count is the stored counter that read 18,420
           against zero memberships. Ignored; the count below is the join. */
        const { rows } = await db.query(`
          SELECT c.id AS chapter_id, c.name, c.type, c.status,
                 COUNT(cm.id)::int AS members,
                 COUNT(cm.id) FILTER (WHERE cm.joined_at > CURRENT_TIMESTAMP - INTERVAL '90 days')::int
                   AS joined_last_90_days,
                 p.city, p.district, p.country,
                 creator.full_name AS created_by_name, c.created_at
          FROM chapters c
          LEFT JOIN chapter_memberships cm ON cm.chapter_id = c.id
          LEFT JOIN location_places p ON p.id = c.place_id
          LEFT JOIN users creator ON creator.id = c.created_by_id
          ${where}
          GROUP BY c.id, p.city, p.district, p.country, creator.full_name
          ORDER BY members DESC, c.id
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── I. Verification ─── */
    'verification': {
      label: 'Verification',
      description: 'Alumni accounts and whether each is verified, with the last verification decision recorded against it.',
      roles: DEPT_ROLES,
      scoped: 'u.department_id',
      filters: ['from', 'to', 'department', 'verified'],
      dateLabel: 'Account created',
      columns: [
        { key: 'user_id', header: 'Account ID' },
        { key: 'full_name', header: 'Name' },
        { key: 'email', header: 'Email' },
        { key: 'department', header: 'Department' },
        { key: 'department_code', header: 'Department code' },
        { key: 'batch', header: 'Batch' },
        { key: 'student_id', header: 'Student ID' },
        { key: 'verified', header: 'Verified' },
        { key: 'account_status', header: 'Account status' },
        { key: 'created_via', header: 'Created via' },
        { key: 'created_at', header: 'Account created' },
        { key: 'last_decision', header: 'Last verification decision' },
        { key: 'last_decision_at', header: 'Decided at' },
        { key: 'days_awaiting', header: 'Days unverified' }
      ],
      async run(f) {
        const params = [];
        let where = "WHERE u.role = 'alumni'";
        where += scope.sqlFor(f.user, 'u.department_id', params);
        where += rangeClause('u.created_at', f.range, params);
        if (f.department) { params.push(f.department); where += ` AND u.department = $${params.length}`; }
        if (f.verified === 'yes') where += ' AND u.is_verified';
        if (f.verified === 'no')  where += ' AND NOT u.is_verified';
        params.push(f.limit);

        /* There is no verification_requests table — verification is a boolean
           on the account. The decision and its date therefore come from the
           audit trail, which is where they were actually recorded. An account
           with no entry reports blank rather than a guessed date. */
        const { rows } = await db.query(`
          SELECT u.id AS user_id, u.full_name, u.email, u.department,
                 dept.code AS department_code,
                 ap.batch, ap.student_id,
                 u.is_verified AS verified, u.status AS account_status,
                 u.created_via, u.created_at,
                 last.action AS last_decision, last.created_at AS last_decision_at,
                 CASE WHEN NOT u.is_verified
                      THEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - u.created_at))::int
                 END AS days_awaiting
          FROM users u
          LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
          LEFT JOIN departments dept ON dept.id = u.department_id
          LEFT JOIN LATERAL (
            SELECT a.action, a.created_at
            FROM audit_logs a
            WHERE a.target_type = 'user' AND a.target_id = u.id
              AND a.action IN ('Alumni Verified', 'Verification Revoked')
            ORDER BY a.id DESC LIMIT 1
          ) last ON TRUE
          ${where}
          ORDER BY u.is_verified, u.created_at
          LIMIT $${params.length}`, params);
        return rows;
      }
    },

    /* ─── J. Administrator Activity ─── */
    'admin-activity': {
      label: 'Administrator Activity',
      description: 'One row per administrator: what they did, in which modules, and when they were last active.',
      roles: ADMIN_ROLES,
      filters: ['from', 'to', 'module'],
      dateLabel: 'Activity',
      columns: [
        { key: 'admin_id', header: 'Administrator ID' },
        { key: 'full_name', header: 'Administrator' },
        { key: 'email', header: 'Email' },
        { key: 'role', header: 'Role' },
        { key: 'account_status', header: 'Account status' },
        { key: 'actions', header: 'Actions recorded' },
        { key: 'modules_touched', header: 'Modules' },
        { key: 'distinct_actions', header: 'Distinct action types' },
        { key: 'first_action_at', header: 'First action in range' },
        { key: 'last_action_at', header: 'Last action in range' },
        { key: 'last_login_at', header: 'Last sign-in' }
      ],
      async run(f) {
        const params = [];
        let joinWhere = 'a.actor_id = u.id';
        joinWhere += rangeClause('a.created_at', f.range, params);
        if (f.module) {
          params.push(f.module);
          joinWhere += ` AND ${moduleCaseSql('a.action')} = $${params.length}`;
        }
        params.push(f.limit);

        const staff = ['super_admin', 'univ_admin', 'dept_admin', 'moderator'];
        const { rows } = await db.query(`
          SELECT u.id AS admin_id, u.full_name, u.email, u.role,
                 u.status AS account_status, u.last_login_at,
                 COALESCE(act.actions, 0)::int AS actions,
                 COALESCE(act.modules_touched, '') AS modules_touched,
                 COALESCE(act.distinct_actions, 0)::int AS distinct_actions,
                 act.first_action_at, act.last_action_at
          FROM users u
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS actions,
                   COUNT(DISTINCT a.action) AS distinct_actions,
                   MIN(a.created_at) AS first_action_at,
                   MAX(a.created_at) AS last_action_at,
                   string_agg(DISTINCT ${moduleCaseSql('a.action')}, ', ') AS modules_touched
            FROM audit_logs a
            WHERE ${joinWhere}
          ) act ON TRUE
          WHERE u.role = ANY($${params.length + 1}::varchar[])
          ORDER BY act.actions DESC NULLS LAST, u.id
          LIMIT $${params.length}`, params.concat([staff]));
        return rows;
      }
    }
  };

  /* ═══ ROUTES ════════════════════════════════════════════════ */

  /* A report a department admin may run MUST carry a department column, or the
     scope clause has nothing to attach to and the report would return the whole
     institution. Checked once, at mount, so the process refuses to start rather
     than serving an unscoped institutional report to a department admin. This
     is the kind of mistake that is invisible in review and obvious here. */
  for (const [slug, spec] of Object.entries(REPORTS)) {
    const departmental = spec.roles.some(r => !scope.isInstitutionWide(r) && r !== 'moderator');
    if (departmental && !spec.scoped) {
      throw new Error(
        `routes_reports: "${slug}" is offered to a department-scoped role but declares no ` +
        `scoped column. Either restrict its roles or give it one.`);
    }
  }

  const visibleTo = (role) => Object.entries(REPORTS)
    .filter(([, r]) => r.roles.includes(role))
    .map(([slug, r]) => ({
      slug, label: r.label, description: r.description,
      filters: r.filters, dateLabel: r.dateLabel || null,
      columns: r.columns.map(c => c.header)
    }));

  /* What this caller may run. The interface builds itself from this, so a
     report a role cannot run is never offered and then refused. */
  app.get('/api/reports', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    res.json({
      reports: visibleTo(req.user.role),
      modules: MODULE_NAMES,
      screenLimit: SCREEN_CAP,
      fileLimit: FILE_CAP
    });
  }));

  app.get('/api/reports/:slug', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const spec = REPORTS[req.params.slug];
    if (!spec) return res.status(404).json({ error: 'No such report.' });

    /* The role check is here and only here, per report. A caller who knows the
       slug of a report their role may not run is refused the same way as one
       who guesses. */
    if (!spec.roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role cannot run this report.' });
    }

    const isCsv = String(req.query.format || '').toLowerCase() === 'csv';

    let filters;
    try {
      filters = {
        range: dateRange(req.query),
        department: req.query.department || null,
        batch: req.query.batch || null,
        status: req.query.status || null,
        verified: req.query.verified || null,
        module: req.query.module || null,
        eventId: /^\d+$/.test(String(req.query.eventId || '')) ? req.query.eventId : null,
        campaignId: /^\d+$/.test(String(req.query.campaignId || '')) ? req.query.campaignId : null,
        limit: rowLimit(req.query, isCsv),
        /* The authenticated caller, so a report's own query can apply the
           department clause. Never anything the caller sent. */
        user: req.user
      };
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }

    const rows = await spec.run(filters);

    if (isCsv) {
      /* Who exported what, and how much of it. An export is a disclosure of
         personal data and is recorded as one — before the file is sent, so a
         download that fails midway is still on the record. */
      await writeAudit('Report Exported',
        `${spec.label} — ${rows.length} row(s)` +
        (filters.range.from || filters.range.to
          ? ` for ${filters.range.from || 'the beginning'} to ${filters.range.to || 'today'}` : ''),
        '📤', { actorId: req.user.uid, targetType: 'report', ip: req.ip });

      return sendCsv(res, `report_${req.params.slug}`, spec.columns, rows);
    }

    res.json({
      slug: req.params.slug,
      label: spec.label,
      description: spec.description,
      generatedAt: new Date().toISOString(),
      filters: { from: filters.range.from, to: filters.range.to },
      columns: spec.columns,
      rowCount: rows.length,
      /* An operator must be able to tell "this is everything" from "this is
         where we stopped". Silence on that point is how a partial export gets
         filed as a complete one. */
      truncated: rows.length >= filters.limit,
      limit: filters.limit,
      rows
    });
  }));

  return { REPORTS, dateRange, rangeClause, BadRequest };
};
