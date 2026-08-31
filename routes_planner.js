/* ============================================================
   DIC ALUMNI PLATFORM — EVENT "ADVANCED" MODULES

   Budget, sponsors, vendors, procurement, marketing, meetings, risks,
   committees, volunteers, logistics and timeline — the parts of event
   planning a small college event does not need, kept behind the Advanced
   disclosure in the UI.

   v5: every route here is staff-only. These endpoints previously answered
   any signed-in user, which exposed sponsor contacts, vendor contract values
   and meeting minutes to ordinary alumni. Events, tickets, tasks and people
   moved to routes_events.js; approval moved onto the event row.
   ============================================================ */

const db = require('./db');

// Generic CRUD factory — every planner sub-module has the same shape, so the
// routes are generated from a column map instead of nine copies of the code.
function crud(app, guards, { path, table, columns, required = [], label }) {
  const { requireAuth, requireRole, MODERATOR_ROLES, writeAudit } = guards;
  const ok = (res, fn) => fn().catch(err => res.status(500).json({ error: err.message }));
  const keys = Object.keys(columns);

  app.get(`/api/planner/${path}`, requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = parseInt(req.query.eventId);
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    const rows = await db.query(`SELECT * FROM ${table} WHERE event_id = $1 ORDER BY id ASC`, [eventId]);
    res.json(rows.rows);
  }));

  app.post(`/api/planner/${path}`, requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    for (const r of required) {
      if (!req.body[r] || !String(req.body[r]).trim()) {
        return res.status(400).json({ error: `${r} is required` });
      }
    }
    const eventId = parseInt(req.body.eventId);
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    const cols = ['event_id', ...keys];
    const vals = [eventId, ...keys.map(k => {
      const v = req.body[k];
      return v === undefined || v === '' ? null : v;
    })];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const dbCols = ['event_id', ...keys.map(k => columns[k])].join(',');

    const row = await db.query(
      `INSERT INTO ${table} (${dbCols}) VALUES (${placeholders}) RETURNING *`, vals);
    await writeAudit(`${label} Added`, `${table} #${row.rows[0].id} by user ${req.user.uid}`, 'clipboard-list');
    res.json(row.rows[0]);
  }));

  app.put(`/api/planner/${path}/:id`, requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const sets = [], vals = [parseInt(req.params.id)];
    keys.forEach(k => {
      if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${columns[k]} = $${vals.length}`); }
    });
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    const row = await db.query(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!row.rows.length) return res.status(404).json({ error: `${label} not found` });
    res.json(row.rows[0]);
  }));

  app.delete(`/api/planner/${path}/:id`, requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const row = await db.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [parseInt(req.params.id)]);
    if (!row.rows.length) return res.status(404).json({ error: `${label} not found` });
    await writeAudit(`${label} Deleted`, `${table} #${req.params.id} by user ${req.user.uid}`, 'trash-2');
    res.json({ success: true });
  }));
}

module.exports = function mountPlanner(app, guards) {
  const { requireAuth, requireRole, ADMIN_ROLES, MODERATOR_ROLES, writeAudit } = guards;
  const ok = (res, fn) => fn().catch(err => res.status(500).json({ error: err.message }));

  /* ─── CRUD for every planner sub-module ─── */

  crud(app, guards, { path: 'committees', table: 'event_committees', label: 'Committee',
    required: ['name', 'leaderName'],
    columns: { name: 'name', leaderName: 'leader_name', membersCount: 'members_count', budgetAllocated: 'budget_allocated' } });

  crud(app, guards, { path: 'volunteers', table: 'event_volunteers', label: 'Volunteer',
    required: ['volunteerName'],
    columns: { volunteerName: 'volunteer_name', shiftTime: 'shift_time', assignedCommittee: 'assigned_committee',
               attendanceStatus: 'attendance_status', certificateIssued: 'certificate_issued' } });

  crud(app, guards, { path: 'risks', table: 'event_risks', label: 'Risk',
    required: ['riskTitle', 'contingencyPlan'],
    columns: { riskTitle: 'risk_title', category: 'category', severity: 'severity', contingencyPlan: 'contingency_plan' } });

  crud(app, guards, { path: 'vendors', table: 'event_vendors', label: 'Vendor',
    required: ['name'],
    columns: { name: 'name', category: 'category', contactPerson: 'contact_person', phone: 'phone',
               email: 'email', contractValue: 'contract_value', rating: 'rating', status: 'status', notes: 'notes' } });

  crud(app, guards, { path: 'timeline', table: 'event_timeline', label: 'Milestone',
    required: ['title'],
    columns: { title: 'title', description: 'description', phase: 'phase', startsAt: 'starts_at',
               endsAt: 'ends_at', owner: 'owner', progress: 'progress', status: 'status' } });

  crud(app, guards, { path: 'logistics', table: 'event_logistics', label: 'Logistics Item',
    required: ['item'],
    columns: { item: 'item', category: 'category', quantity: 'quantity', location: 'location',
               responsible: 'responsible', status: 'status', notes: 'notes' } });

  crud(app, guards, { path: 'marketing', table: 'event_marketing', label: 'Marketing Campaign',
    required: ['channel', 'campaignName'],
    columns: { channel: 'channel', campaignName: 'campaign_name', audience: 'audience', budget: 'budget',
               reach: 'reach', conversions: 'conversions', scheduledFor: 'scheduled_for', status: 'status' } });

  crud(app, guards, { path: 'meetings', table: 'event_meetings', label: 'Meeting',
    required: ['title'],
    columns: { title: 'title', agenda: 'agenda', meetingDate: 'meeting_date', meetingTime: 'meeting_time',
               location: 'location', attendees: 'attendees', minutes: 'minutes', status: 'status' } });

  /* Budget, sponsors and procurement used to have PUT/DELETE only — their
     create path lived on the legacy /api/events/* endpoints that v5 removed,
     which left the Advanced tab's "Add" buttons posting to nothing. They now
     go through the same factory as every other module. */

  crud(app, guards, { path: 'budgets', table: 'event_budgets', label: 'Budget Line',
    required: ['category'],
    columns: { category: 'category', estimatedCost: 'estimated_cost', actualCost: 'actual_cost',
               vendorName: 'vendor_name', status: 'status', paymentStatus: 'payment_status' } });

  crud(app, guards, { path: 'sponsors', table: 'event_sponsors', label: 'Sponsor',
    required: ['company'],
    columns: { company: 'company', contactPerson: 'contact_person', email: 'email', phone: 'phone',
               packageTier: 'package_tier', contributionAmount: 'contribution_amount',
               pipelineStatus: 'pipeline_status', deliverables: 'deliverables' } });

  crud(app, guards, { path: 'procurement', table: 'event_procurement', label: 'Procurement Item',
    required: ['itemName'],
    columns: { itemName: 'item_name', category: 'category', quantity: 'quantity',
               estimatedPrice: 'estimated_price', actualPrice: 'actual_price',
               vendorName: 'vendor_name', deliveryStatus: 'delivery_status' } });

  /* Event approval moved to routes_events.js in v5: approval is now a
     property of the event itself (events.approval_status) rather than a
     parallel event_proposals workflow that no UI could ever reach. */

  /* ─── REPORTS & ANALYTICS (were hardcoded figures / toasts) ─── */

  app.get('/api/planner/analytics/:eventId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = parseInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });

    const [budget, sponsors, tasks, procurement, volunteers, risks, marketing, timeline, vendors] =
      await Promise.all([
        db.query(`SELECT COALESCE(SUM(estimated_cost),0) est, COALESCE(SUM(actual_cost),0) act, COUNT(*)::int n
                  FROM event_budgets WHERE event_id=$1`, [eventId]),
        db.query(`SELECT COALESCE(SUM(contribution_amount) FILTER (WHERE pipeline_status IN ('agreed','received')),0) secured,
                         COALESCE(SUM(contribution_amount),0) pipeline, COUNT(*)::int n
                  FROM event_sponsors WHERE event_id=$1`, [eventId]),
        db.query(`SELECT status, COUNT(*)::int n FROM event_tasks WHERE event_id=$1 GROUP BY status`, [eventId]),
        db.query(`SELECT COALESCE(SUM(actual_price*quantity),0) spend, COUNT(*)::int n
                  FROM event_procurement WHERE event_id=$1`, [eventId]),
        db.query(`SELECT attendance_status, COUNT(*)::int n FROM event_volunteers WHERE event_id=$1 GROUP BY attendance_status`, [eventId]),
        db.query(`SELECT severity, COUNT(*)::int n FROM event_risks WHERE event_id=$1 GROUP BY severity`, [eventId]),
        db.query(`SELECT COALESCE(SUM(budget),0) spend, COALESCE(SUM(reach),0) reach, COALESCE(SUM(conversions),0) conv
                  FROM event_marketing WHERE event_id=$1`, [eventId]),
        db.query(`SELECT COALESCE(AVG(progress),0)::int avg_progress, COUNT(*)::int n,
                         COUNT(*) FILTER (WHERE status='done')::int done
                  FROM event_timeline WHERE event_id=$1`, [eventId]),
        db.query(`SELECT COALESCE(SUM(contract_value),0) committed, COUNT(*)::int n FROM event_vendors WHERE event_id=$1`, [eventId])
      ]);

    const taskMap = Object.fromEntries(tasks.rows.map(r => [r.status, r.n]));
    const totalTasks = tasks.rows.reduce((a, r) => a + r.n, 0);

    const estimated = Number(budget.rows[0].est);
    const actual = Number(budget.rows[0].act);
    const secured = Number(sponsors.rows[0].secured);

    res.json({
      budget: {
        estimated, actual, variance: estimated - actual,
        utilisation: estimated ? Math.round((actual / estimated) * 100) : 0,
        lines: budget.rows[0].n
      },
      sponsors: {
        secured, pipeline: Number(sponsors.rows[0].pipeline), count: sponsors.rows[0].n,
        coverage: estimated ? Math.round((secured / estimated) * 100) : 0
      },
      tasks: {
        total: totalTasks, ...taskMap,
        completionRate: totalTasks ? Math.round(((taskMap.completed || 0) / totalTasks) * 100) : 0
      },
      procurement: { spend: Number(procurement.rows[0].spend), items: procurement.rows[0].n },
      vendors: { committed: Number(vendors.rows[0].committed), count: vendors.rows[0].n },
      volunteers: Object.fromEntries(volunteers.rows.map(r => [r.attendance_status, r.n])),
      risks: Object.fromEntries(risks.rows.map(r => [r.severity, r.n])),
      marketing: {
        spend: Number(marketing.rows[0].spend),
        reach: Number(marketing.rows[0].reach),
        conversions: Number(marketing.rows[0].conv),
        costPerConversion: Number(marketing.rows[0].conv)
          ? Math.round(Number(marketing.rows[0].spend) / Number(marketing.rows[0].conv)) : 0
      },
      timeline: {
        avgProgress: timeline.rows[0].avg_progress,
        milestones: timeline.rows[0].n,
        done: timeline.rows[0].done
      }
    });
  }));

  // Real CSV export — downloadEventReport() used to be a toast.
  app.get('/api/planner/report/:eventId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = parseInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    const type = (req.query.type || 'full').toLowerCase();

    const sections = {
      budget:      { sql: 'SELECT category, estimated_cost, actual_cost, vendor_name, status, payment_status FROM event_budgets WHERE event_id=$1 ORDER BY id' },
      sponsors:    { sql: 'SELECT company, contact_person, package_tier, contribution_amount, pipeline_status FROM event_sponsors WHERE event_id=$1 ORDER BY id' },
      tasks:       { sql: 'SELECT title, committee_name, priority, status, assigned_to, deadline FROM event_tasks WHERE event_id=$1 ORDER BY id' },
      procurement: { sql: 'SELECT item_name, category, quantity, estimated_price, actual_price, vendor_name, delivery_status FROM event_procurement WHERE event_id=$1 ORDER BY id' },
      vendors:     { sql: 'SELECT name, category, contact_person, contract_value, rating, status FROM event_vendors WHERE event_id=$1 ORDER BY id' },
      volunteers:  { sql: 'SELECT volunteer_name, shift_time, assigned_committee, attendance_status, certificate_issued FROM event_volunteers WHERE event_id=$1 ORDER BY id' },
      timeline:    { sql: 'SELECT title, phase, starts_at, ends_at, owner, progress, status FROM event_timeline WHERE event_id=$1 ORDER BY starts_at' },
      logistics:   { sql: 'SELECT item, category, quantity, location, responsible, status FROM event_logistics WHERE event_id=$1 ORDER BY id' },
      marketing:   { sql: 'SELECT channel, campaign_name, audience, budget, reach, conversions, status FROM event_marketing WHERE event_id=$1 ORDER BY id' },
      risks:       { sql: 'SELECT risk_title, category, severity, contingency_plan FROM event_risks WHERE event_id=$1 ORDER BY id' }
    };

    const wanted = type === 'full' ? Object.keys(sections)
                 : Object.keys(sections).filter(k => k === type);
    if (!wanted.length) return res.status(400).json({ error: `Unknown report type "${type}"` });

    const lines = [`DIC Event Planner Report — event ${eventId} — generated ${new Date().toISOString()}`, ''];
    for (const key of wanted) {
      const rows = await db.query(sections[key].sql, [eventId]);
      lines.push(`## ${key.toUpperCase()}`);
      if (rows.rows.length) {
        lines.push(Object.keys(rows.rows[0]).join(','));
        rows.rows.forEach(r => lines.push(
          Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
      } else {
        lines.push('(no records)');
      }
      lines.push('');
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="dic_event_${eventId}_${type}_report.csv"`);
    res.send(lines.join('\n'));
  }));

  /* ─── Extended planner bundle: everything the workspace needs in one call ─── */

  app.get('/api/planner/workspace/:eventId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = parseInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    const q = (sql) => db.query(sql, [eventId]).then(r => r.rows);

    // NOTE: this used to also fetch `event_proposals WHERE id = eventId`, which
    // paired an event with whichever proposal happened to share its primary key.
    // Proposals are gone in v5; approval lives on the event row.
    const [event, budgets, sponsors, committees, tasks, procurement,
           volunteers, risks, vendors, timeline, logistics, marketing, meetings] = await Promise.all([
      db.query('SELECT * FROM events WHERE id=$1', [eventId]).then(r => r.rows[0] || null),
      q('SELECT * FROM event_budgets WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_sponsors WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_committees WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_tasks WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_procurement WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_volunteers WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_risks WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_vendors WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_timeline WHERE event_id=$1 ORDER BY starts_at NULLS LAST, id'),
      q('SELECT * FROM event_logistics WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_marketing WHERE event_id=$1 ORDER BY id'),
      q('SELECT * FROM event_meetings WHERE event_id=$1 ORDER BY meeting_date NULLS LAST, id')
    ]);

    res.json({ event, budgets, sponsors, committees, tasks, procurement,
               volunteers, risks, vendors, timeline, logistics, marketing, meetings });
  }));
};
