/* ============================================================
   Applies schema_v2.sql and seeds the rows the new modules need.
   Idempotent — safe to re-run.  Usage:  node migrate_v2.js
   ============================================================ */

const fs = require('fs');
const path = require('path');
const db = require('./db');

async function run() {
  const ddl = fs.readFileSync(path.join(__dirname, 'schema_v2.sql'), 'utf8');
  await db.query(ddl);
  console.log('⚡ schema_v2 applied.');

  // Backfill campaign totals from the ledger so the two never disagree.
  await db.query(`
    UPDATE campaigns c SET
      raised_amount = COALESCE(t.total, 0) + COALESCE(c.raised_amount, 0) * 0,
      donors_count  = COALESCE(t.donors, 0)
    FROM (
      SELECT campaign_id, SUM(amount) AS total, COUNT(DISTINCT donor_user_id) AS donors
      FROM donations WHERE status = 'SUCCESS' GROUP BY campaign_id
    ) t
    WHERE t.campaign_id = c.id
  `);

  /* ─── DEMONSTRATION DATA — OFF BY DEFAULT ───────────────────
     Everything below invents content: a poll question, four catering and
     security vendors with made-up Bangladeshi names and phone numbers, a
     project timeline, marketing campaigns and meetings. It was written to stop
     the new planner tabs opening empty during development.

     It ran unconditionally on any database where those tables were empty —
     which is exactly a fresh PRODUCTION database. PRODUCTION_DEPLOYMENT_RUNBOOK
     step 4 tells the operator not to run seed.sql precisely to avoid demo data,
     and this happened anyway: Phase 6 installed from scratch and found a live
     poll on the public news feed and 'Dhaka Grand Caterers / +880 1711-220011'
     in the vendor list of a database nobody had seeded.

     It also caused the install to FAIL. These rows are written with event_id=1,
     and on a fresh database no event 1 exists — so they became the orphaned
     child rows that migrate_v5 then aborted on.

     Now opt-in. Set DIC_SEED_DEMO=1 to populate a demonstration environment.
     Production never sets it, so production gets nothing invented. */
  const SEED_DEMO = process.env.DIC_SEED_DEMO === '1';
  if (!SEED_DEMO) {
    console.log('🌱 Demonstration data skipped (set DIC_SEED_DEMO=1 to populate a demo environment).');
  }

  const poll = await db.query('SELECT COUNT(*)::int n FROM polls');
  if (SEED_DEMO && poll.rows[0].n === 0) {
    await db.query(`
      INSERT INTO polls (question, options, is_active, closes_at)
      VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP + INTERVAL '14 days')
    `, ['Which DIC reunion activity should we prioritise in 2026?',
        ['Career & networking fair', 'Cultural night & concert', 'Sports tournament', 'Tech hackathon']]);
    console.log('🗳  Seeded the active poll.');
  }

  // Event planner: seed the modules that had no rows at all so the new tabs
  // open with realistic content rather than empty states everywhere.
  const seedIf = async (table, sql, params) => {
    if (!SEED_DEMO) return;
    const c = await db.query(`SELECT COUNT(*)::int n FROM ${table}`);
    if (c.rows[0].n === 0) { await db.query(sql, params); console.log(`🌱 Seeded ${table}.`); }
  };

  await seedIf('event_vendors', `
    INSERT INTO event_vendors (event_id, name, category, contact_person, phone, contract_value, rating, status) VALUES
    (1,'Dhaka Grand Caterers','Catering','Mizanur Rahman','+880 1711-220011',450000,4,'contracted'),
    (1,'SoundVision BD','Stage & AV','Shafiq Islam','+880 1811-330022',180000,5,'contracted'),
    (1,'PrintCraft Ltd','Branding & Print','Nadia Haque','+880 1911-440033',95000,4,'paid'),
    (1,'SecureForce Ltd','Security','Kamrul Hasan','+880 1611-550044',120000,3,'shortlisted')
  `);

  await seedIf('event_timeline', `
    INSERT INTO event_timeline (event_id, title, description, phase, starts_at, ends_at, owner, progress, status) VALUES
    (1,'Proposal & venue confirmation','Approve the proposal and lock the auditorium booking.','planning','2026-06-01','2026-06-14','DIC Alumni Board',100,'done'),
    (1,'Sponsor outreach','Secure title and gold tier sponsors.','fundraising','2026-06-15','2026-07-05','Sponsorship Committee',75,'in_progress'),
    (1,'Ticketing & campaign launch','Open registration and run the omnichannel campaign.','marketing','2026-07-06','2026-07-25','Marketing Committee',40,'in_progress'),
    (1,'Procurement & kits','Order welcome kits, badges and merchandise.','operations','2026-07-20','2026-08-05','Procurement Committee',10,'pending'),
    (1,'Volunteer briefing & rehearsal','Shift assignment, briefing and stage sound check.','operations','2026-08-10','2026-08-14','Volunteer Committee',0,'pending'),
    (1,'Event day execution','Run the event, QR check-in and live coverage.','execution','2026-08-15','2026-08-15','All Committees',0,'pending')
  `);

  await seedIf('event_logistics', `
    INSERT INTO event_logistics (event_id, item, category, quantity, location, responsible, status) VALUES
    (1,'Main stage & backdrop','Venue',1,'Main Auditorium','Logistics Committee','arranged'),
    (1,'Registration desks','Venue',6,'Auditorium Foyer','Hospitality Committee','planned'),
    (1,'250kVA standby generator','Power',1,'Rear Compound','Technical Committee','arranged'),
    (1,'Shuttle buses','Transport',4,'Campus Gate 1','Transport Committee','planned'),
    (1,'Medical & first aid booth','Safety',1,'Foyer East','Safety Committee','planned')
  `);

  await seedIf('event_marketing', `
    INSERT INTO event_marketing (event_id, channel, campaign_name, audience, budget, reach, conversions, scheduled_for, status) VALUES
    (1,'Facebook','Reunion 2026 Countdown','Alumni 2010-2024',45000,128000,1840,'2026-07-06','live'),
    (1,'SMS','Early-bird Ticket Blast','All verified alumni',28000,38420,920,'2026-07-10','live'),
    (1,'Email','Sponsor & VIP Invitation','Donors and sponsors',0,4200,310,'2026-07-15','completed'),
    (1,'LinkedIn','Career Fair Promotion','Working professionals',22000,54000,640,'2026-07-22','planned')
  `);

  await seedIf('event_meetings', `
    INSERT INTO event_meetings (event_id, title, agenda, meeting_date, meeting_time, location, attendees, status) VALUES
    (1,'Kickoff — all committees','Scope, budget envelope and committee ownership.','2026-06-05','4:00 PM','Conference Room A','All committee leads','held'),
    (1,'Sponsorship review','Pipeline review and title sponsor negotiation.','2026-07-08','5:00 PM','Conference Room B','Sponsorship Committee','held'),
    (1,'Final operations briefing','Run sheet, volunteer shifts and contingencies.','2026-08-12','3:00 PM','Main Auditorium','All committees + volunteers','scheduled')
  `);

  const counts = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM donations) donations,
      (SELECT COUNT(*)::int FROM event_registrations) registrations,
      (SELECT COUNT(*)::int FROM mentorships) mentorships,
      (SELECT COUNT(*)::int FROM event_vendors) vendors,
      (SELECT COUNT(*)::int FROM event_timeline) timeline,
      (SELECT COUNT(*)::int FROM event_logistics) logistics,
      (SELECT COUNT(*)::int FROM event_marketing) marketing,
      (SELECT COUNT(*)::int FROM event_meetings) meetings,
      (SELECT COUNT(*)::int FROM polls) polls
  `);
  console.log('📊 New tables:', JSON.stringify(counts.rows[0]));
}

run().then(() => process.exit(0))
     .catch(e => { console.error('❌ migrate_v2 failed:', e.message); process.exit(1); });
