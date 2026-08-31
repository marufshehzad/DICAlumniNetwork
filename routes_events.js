/* ============================================================
   DIC ALUMNI PLATFORM — EVENTS & TICKETS  (v5 redesign)

   One module owning the whole event lifecycle: creation and approval,
   ticket types and registration, tasks and assignees, people, and the
   directory lookup used to assign work.

   Replaces three previously overlapping surfaces:
     • the event/ticket endpoints that lived in routes_v2.js
     • the legacy /api/events/{planner,proposals,budgets,sponsors,tasks,
       procurement,ai-estimate} endpoints in server.js
     • the proposal approval endpoints that no UI ever reached

   routes_planner.js keeps only the Advanced modules (budget, sponsors,
   vendors, marketing, meetings, risks, logistics) and is now staff-only.
   ============================================================ */

const crypto = require('crypto');
const db = require('./db');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

// Same construction the pre-v5 code used, so every ticket QR issued before
// this release still validates byte-for-byte.
const signTicket = (code, eventId, userId) =>
  crypto.createHmac('sha256', ENCRYPTION_KEY || 'dic-ticket')
        .update(`${code}:${eventId}:${userId}`).digest('hex').slice(0, 16);

const ref = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const EVENT_TYPES = [
  'Reunion', 'Seminar', 'Workshop', 'Career', 'Sports', 'Gala',
  'Conference', 'Cultural', 'Ceremony', 'Meetup', 'Other'
];
const VISIBILITIES = ['public', 'alumni', 'invite'];
const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'completed'];
const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const PEOPLE_ROLES = ['coordinator', 'committee_lead', 'member', 'volunteer'];

// Practical defaults for a college event. Offsets are days before the event.
const STANDARD_CHECKLIST = [
  { title: 'Confirm venue booking',        category: 'Venue',       priority: 'critical', offset: 30 },
  { title: 'Prepare and send invitations', category: 'Invitations', priority: 'high',     offset: 21 },
  { title: 'Book decorator',               category: 'Venue',       priority: 'medium',   offset: 21 },
  { title: 'Confirm catering',             category: 'Catering',    priority: 'high',     offset: 14 },
  { title: 'Arrange sound system',         category: 'Logistics',   priority: 'high',     offset: 14 },
  { title: 'Confirm volunteers',           category: 'Volunteers',  priority: 'medium',   offset: 7 },
  { title: 'Final venue inspection',       category: 'Venue',       priority: 'high',     offset: 2 },
  { title: 'Event-day coordination',       category: 'Logistics',   priority: 'critical', offset: 0 }
];

module.exports = function mountEvents(app, guards) {
  const { requireAuth, requireRole, ADMIN_ROLES, MODERATOR_ROLES, writeAudit } = guards;

  const ok = (res, fn) => fn().catch(err => {
    console.error('[events]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  const isStaff = (u) => !!u && MODERATOR_ROLES.includes(u.role);
  const isAdmin = (u) => !!u && ADMIN_ROLES.includes(u.role);
  const num = (v, d = null) => (v === undefined || v === null || v === '' ? d : parseInt(v, 10));

  /* ─── in-app notification helper (in-app only, with a deep link) ─── */
  async function notify(client, { userId, role, title, subtitle, entity, entityId, icon = 'bell' }) {
    const q = client || db;
    await q.query(
      `INSERT INTO notifications (user_id, target_role, icon, title, subtitle, link_entity, link_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, role || null, icon, title, subtitle || null, entity || null, entityId || null]);
  }
  // The signed token carries uid and role only, so notification copy that
  // names the actor has to resolve the name from the database.
  const _nameCache = new Map();
  async function actorName(uid, fallback = 'An organiser') {
    if (!uid) return fallback;
    if (_nameCache.has(uid)) return _nameCache.get(uid);
    const r = await db.query('SELECT full_name FROM users WHERE id = $1', [uid]);
    const name = r.rows[0] ? r.rows[0].full_name : fallback;
    _nameCache.set(uid, name);
    return name;
  }

  async function notifyMany(client, userIds, payload) {
    for (const uid of [...new Set(userIds)].filter(Boolean)) {
      await notify(client, { ...payload, userId: uid });
    }
  }

  /* ─── shared SQL fragments ─── */
  const LIVE_COUNTS = `
    (SELECT COUNT(*)::int FROM event_registrations r
      WHERE r.event_id = e.id AND r.status = 'confirmed')   AS registered,
    (SELECT COUNT(*)::int FROM event_registrations r
      WHERE r.event_id = e.id AND r.status = 'waitlisted')  AS waitlisted,
    (SELECT COUNT(*)::int FROM event_registrations r
      WHERE r.event_id = e.id AND r.checked_in)             AS checked_in`;

  // Money is staff-only and is never added to the alumni-facing projection.
  const STAFF_REVENUE = `,
    (SELECT COALESCE(SUM(r.amount_paid), 0)::numeric FROM event_registrations r
      WHERE r.event_id = e.id AND r.status = 'confirmed')   AS revenue`;

  const EVENT_SELECT = `
    e.*, ${LIVE_COUNTS},
    cu.full_name AS created_by_name, cu.role_label AS created_by_role,
    au.full_name AS approved_by_name`;

  const EVENT_SELECT_STAFF = EVENT_SELECT + STAFF_REVENUE;

  const EVENT_JOINS = `
    FROM events e
    LEFT JOIN users cu ON cu.id = e.created_by
    LEFT JOIN users au ON au.id = e.approved_by`;

  // What an ordinary alumnus is allowed to see: approved, not cancelled, and
  // not invite-only. Staff see everything.
  const PUBLIC_FILTER = `
    e.approval_status = 'approved' AND e.status <> 'cancelled' AND e.visibility <> 'invite'`;

  async function loadEvent(id) {
    const r = await db.query(`SELECT ${EVENT_SELECT} ${EVENT_JOINS} WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }

  async function ticketTypesFor(eventId) {
    const r = await db.query(`
      SELECT t.*, (SELECT COUNT(*)::int FROM event_registrations r
                    WHERE r.ticket_type_id = t.id AND r.status = 'confirmed') AS sold
        FROM event_ticket_types t WHERE t.event_id = $1 ORDER BY t.position, t.id`, [eventId]);
    return r.rows;
  }

  /* ══════════════════════════════════════════════════════════
     EVENTS
     ══════════════════════════════════════════════════════════ */

  // Events the signed-in user manages or is assigned work on.
  app.get('/api/events/mine', requireAuth, (req, res) => ok(res, async () => {
    const r = await db.query(`
      SELECT ${EVENT_SELECT} ${EVENT_JOINS}
       WHERE e.created_by = $1
          OR EXISTS (SELECT 1 FROM event_people p WHERE p.event_id = e.id AND p.user_id = $1)
          OR EXISTS (SELECT 1 FROM event_task_assignees a
                      JOIN event_tasks t ON t.id = a.task_id
                     WHERE t.event_id = e.id AND a.user_id = $1)
       ORDER BY e.starts_on NULLS LAST, e.id DESC`, [req.user.uid]);
    res.json(r.rows);
  }));

  app.get('/api/events', requireAuth, (req, res) => ok(res, async () => {
    const { status, search, scope } = req.query;
    const staffView = scope === 'manage';

    if (staffView && !isStaff(req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }

    const where = [];
    const params = [];
    if (!staffView) where.push(PUBLIC_FILTER);
    if (status && status !== 'all') { params.push(status); where.push(`e.status = $${params.length}`); }
    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      where.push(`(LOWER(e.title) LIKE $${params.length} OR LOWER(e.venue) LIKE $${params.length})`);
    }

    const r = await db.query(`
      SELECT ${staffView ? EVENT_SELECT_STAFF : EVENT_SELECT} ${EVENT_JOINS}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.starts_on NULLS LAST, e.id DESC`, params);

    // is_registered is per-caller and cheap enough to add here.
    const mine = await db.query(
      `SELECT event_id FROM event_registrations WHERE user_id = $1 AND status <> 'cancelled'`,
      [req.user.uid]);
    const regSet = new Set(mine.rows.map(x => x.event_id));

    res.json(r.rows.map(e => ({ ...e, is_registered: regSet.has(e.id) })));
  }));

  app.get('/api/events/:id', requireAuth, (req, res) => ok(res, async () => {
    const event = await loadEvent(num(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // An alumnus may only read an event that passes the public filter.
    if (!isStaff(req.user) &&
        !(event.approval_status === 'approved' && event.status !== 'cancelled' && event.visibility !== 'invite')) {
      return res.status(403).json({ error: 'This event is not available' });
    }

    event.ticket_types = await ticketTypesFor(event.id);
    const mine = await db.query(
      `SELECT 1 FROM event_registrations WHERE event_id=$1 AND user_id=$2 AND status <> 'cancelled'`,
      [event.id, req.user.uid]);
    event.is_registered = mine.rows.length > 0;
    res.json(event);
  }));

  // Overview counters for the event workspace.
  app.get('/api/events/:id/overview', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const event = await loadEvent(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const [tasks, revenue, people] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int n, COALESCE(AVG(progress),0)::int avg_p
                  FROM event_tasks WHERE event_id=$1 GROUP BY status`, [id]),
      db.query(`SELECT COALESCE(SUM(amount_paid),0)::numeric total
                  FROM event_registrations WHERE event_id=$1 AND status='confirmed'`, [id]),
      db.query(`SELECT COUNT(*)::int n FROM event_people WHERE event_id=$1`, [id])
    ]);

    const byStatus = Object.fromEntries(tasks.rows.map(r => [r.status, r.n]));
    const total = tasks.rows.reduce((a, r) => a + r.n, 0);
    const overdue = await db.query(
      `SELECT COUNT(*)::int n FROM event_tasks
        WHERE event_id=$1 AND status <> 'completed' AND due_on IS NOT NULL AND due_on < CURRENT_DATE`, [id]);

    res.json({
      event,
      ticketTypes: await ticketTypesFor(id),
      tasks: {
        total,
        todo: byStatus.todo || 0,
        in_progress: byStatus.in_progress || 0,
        blocked: byStatus.blocked || 0,
        completed: byStatus.completed || 0,
        overdue: overdue.rows[0].n,
        completionRate: total ? Math.round(((byStatus.completed || 0) / total) * 100) : 0
      },
      revenue: Number(revenue.rows[0].total),
      peopleCount: people.rows[0].n
    });
  }));

  /* ─── CREATE (the single event creation workflow) ─── */
  app.post('/api/events', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const venue = String(b.venue || '').trim();

    if (!title) return res.status(400).json({ error: 'Event title is required' });
    if (!venue) return res.status(400).json({ error: 'Venue is required' });
    if (!b.startsOn) return res.status(400).json({ error: 'Event date is required' });
    if (isNaN(Date.parse(b.startsOn))) return res.status(400).json({ error: 'Event date is not a valid date' });

    const eventType = EVENT_TYPES.includes(b.eventType) ? b.eventType : 'Other';
    const visibility = VISIBILITIES.includes(b.visibility) ? b.visibility : 'alumni';
    const isPaid = b.isPaid === true || b.isPaid === 'true';

    const types = Array.isArray(b.ticketTypes) ? b.ticketTypes : [];
    if (isPaid && !types.length) {
      return res.status(400).json({ error: 'A paid event needs at least one ticket type' });
    }
    for (const t of types) {
      if (!String(t.name || '').trim()) return res.status(400).json({ error: 'Every ticket type needs a name' });
      if (isPaid && !(Number(t.price) >= 0)) return res.status(400).json({ error: `Ticket "${t.name}" needs a valid price` });
    }

    // Approval is a function of who is creating, not a separate form.
    const approvalStatus = isAdmin(req.user) ? 'approved' : 'pending_approval';

    // Capacity: explicit override wins, otherwise sum the quotas.
    const quotaSum = types.reduce((a, t) => a + (num(t.quota, 0) || 0), 0);
    const capacity = num(b.capacity) || quotaSum || 100;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const row = await client.query(`
        INSERT INTO events
          (title, description, event_type, type, starts_on, start_time, end_time, venue,
           capacity, organizer_department, visibility, status, approval_status,
           registration_opens_at, registration_closes_at, waitlist_enabled, is_paid,
           cover_image_url, created_by, updated_by, approved_by, approved_at, price)
        VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,'upcoming',$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20)
        RETURNING *`,
        [title, b.description || null, eventType, b.startsOn, b.startTime || null, b.endTime || null,
         venue, capacity, b.organizerDepartment || null, visibility, approvalStatus,
         b.registrationOpensAt || null, b.registrationClosesAt || null,
         b.waitlistEnabled !== false, isPaid, b.coverImageUrl || null, req.user.uid,
         approvalStatus === 'approved' ? req.user.uid : null,
         approvalStatus === 'approved' ? new Date() : null,
         isPaid ? 'Paid' : 'Free']);

      const event = row.rows[0];

      const finalTypes = types.length ? types
        : [{ name: 'General Admission', price: 0, quota: capacity }];
      for (let i = 0; i < finalTypes.length; i++) {
        const t = finalTypes[i];
        await client.query(
          `INSERT INTO event_ticket_types (event_id, name, price, quota, position)
           VALUES ($1,$2,$3,$4,$5)`,
          [event.id, String(t.name).trim(), isPaid ? Number(t.price) || 0 : 0,
           num(t.quota), i]);
      }

      if (approvalStatus === 'pending_approval') {
        await notify(client, {
          role: 'super_admin', icon: 'calendar-clock',
          title: 'Event awaiting approval',
          subtitle: `"${title}" was submitted by ${await actorName(req.user.uid, 'a moderator')}.`,
          entity: 'event', entityId: event.id
        });
        await notify(client, {
          role: 'univ_admin', icon: 'calendar-clock',
          title: 'Event awaiting approval',
          subtitle: `"${title}" was submitted for approval.`,
          entity: 'event', entityId: event.id
        });
      }

      await client.query('COMMIT');
      await writeAudit('Event Created', `"${title}" by user ${req.user.uid}`, 'calendar-plus');

      event.ticket_types = await ticketTypesFor(event.id);
      res.json(event);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  /* ─── UPDATE ─── */
  app.put('/api/events/:id', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const b = req.body || {};

    const map = {
      title: 'title', description: 'description', venue: 'venue',
      startsOn: 'starts_on', startTime: 'start_time', endTime: 'end_time',
      capacity: 'capacity', organizerDepartment: 'organizer_department',
      coverImageUrl: 'cover_image_url',
      registrationOpensAt: 'registration_opens_at', registrationClosesAt: 'registration_closes_at',
      waitlistEnabled: 'waitlist_enabled', status: 'status'
    };

    const sets = [], vals = [id];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { vals.push(b[k] === '' ? null : b[k]); sets.push(`${col} = $${vals.length}`); }
    }
    if (b.eventType !== undefined) {
      if (!EVENT_TYPES.includes(b.eventType)) return res.status(400).json({ error: 'Unknown event type' });
      vals.push(b.eventType); sets.push(`event_type = $${vals.length}`);
      vals.push(b.eventType); sets.push(`type = $${vals.length}`);
    }
    if (b.visibility !== undefined) {
      if (!VISIBILITIES.includes(b.visibility)) return res.status(400).json({ error: 'Unknown visibility' });
      vals.push(b.visibility); sets.push(`visibility = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.user.uid);
    sets.push(`updated_by = $${vals.length}`, `updated_at = CURRENT_TIMESTAMP`);

    const row = await db.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!row.rows.length) return res.status(404).json({ error: 'Event not found' });

    await writeAudit('Event Updated', `Event ${id} by user ${req.user.uid}`, 'calendar-cog');
    res.json(await loadEvent(id));
  }));

  /* ─── APPROVE / REJECT (replaces the unreachable proposal workflow) ─── */
  app.put('/api/events/:id/approve', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const row = await db.query(`
      UPDATE events SET approval_status='approved', approved_by=$2, approved_at=CURRENT_TIMESTAMP,
                        rejection_reason=NULL, updated_by=$2, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING *`, [id, req.user.uid]);
    if (!row.rows.length) return res.status(404).json({ error: 'Event not found' });

    if (row.rows[0].created_by) {
      await notify(null, {
        userId: row.rows[0].created_by, icon: 'circle-check-big',
        title: 'Event approved',
        subtitle: `"${row.rows[0].title}" has been approved and is now live.`,
        entity: 'event', entityId: id
      });
    }
    await writeAudit('Event Approved', `"${row.rows[0].title}" by user ${req.user.uid}`, 'circle-check-big');
    res.json(await loadEvent(id));
  }));

  app.put('/api/events/:id/reject', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required when rejecting an event' });

    const row = await db.query(`
      UPDATE events SET approval_status='rejected', rejection_reason=$3,
                        updated_by=$2, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING *`, [id, req.user.uid, reason]);
    if (!row.rows.length) return res.status(404).json({ error: 'Event not found' });

    if (row.rows[0].created_by) {
      await notify(null, {
        userId: row.rows[0].created_by, icon: 'circle-x',
        title: 'Event sent back',
        subtitle: `"${row.rows[0].title}" was not approved: ${reason}`,
        entity: 'event', entityId: id
      });
    }
    await writeAudit('Event Rejected', `"${row.rows[0].title}" by user ${req.user.uid}`, 'circle-x');
    res.json(await loadEvent(id));
  }));

  /* ─── CANCEL (soft; registrations and tickets are preserved) ─── */
  app.put('/api/events/:id/cancel', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A cancellation reason is required' });

    const row = await db.query(`
      UPDATE events SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, cancellation_reason=$3,
                        updated_by=$2, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING *`, [id, req.user.uid, reason]);
    if (!row.rows.length) return res.status(404).json({ error: 'Event not found' });

    const holders = await db.query(
      `SELECT DISTINCT user_id FROM event_registrations WHERE event_id=$1 AND status <> 'cancelled'`, [id]);
    await notifyMany(null, holders.rows.map(r => r.user_id), {
      icon: 'calendar-x', title: 'Event cancelled',
      subtitle: `"${row.rows[0].title}" has been cancelled. ${reason}`,
      entity: 'event', entityId: id
    });

    await writeAudit('Event Cancelled', `"${row.rows[0].title}" by user ${req.user.uid}`, 'calendar-x');
    res.json(await loadEvent(id));
  }));

  app.delete('/api/events/:id', requireRole(...ADMIN_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const reg = await db.query(
      `SELECT COUNT(*)::int n FROM event_registrations WHERE event_id=$1 AND status <> 'cancelled'`, [id]);
    if (reg.rows[0].n > 0) {
      return res.status(409).json({
        error: `This event has ${reg.rows[0].n} live registration(s). Cancel it instead of deleting it.` });
    }
    const row = await db.query('DELETE FROM events WHERE id=$1 RETURNING title', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Event not found' });
    await writeAudit('Event Deleted', `"${row.rows[0].title}" by user ${req.user.uid}`, 'trash-2');
    res.json({ success: true });
  }));

  /* ══════════════════════════════════════════════════════════
     TICKET TYPES
     ══════════════════════════════════════════════════════════ */

  app.get('/api/events/:id/ticket-types', requireAuth, (req, res) => ok(res, async () => {
    res.json(await ticketTypesFor(num(req.params.id)));
  }));

  app.post('/api/events/:id/ticket-types', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const { name, price, quota } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Ticket name is required' });

    const pos = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM event_ticket_types WHERE event_id=$1`, [id]);
    const row = await db.query(
      `INSERT INTO event_ticket_types (event_id, name, price, quota, position)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, String(name).trim(), Number(price) || 0, num(quota), pos.rows[0].p]);
    res.json(row.rows[0]);
  }));

  app.put('/api/events/ticket-types/:ttId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const { name, price, quota } = req.body || {};
    const sets = [], vals = [num(req.params.ttId)];
    if (name !== undefined)  { vals.push(String(name).trim()); sets.push(`name = $${vals.length}`); }
    if (price !== undefined) { vals.push(Number(price) || 0);  sets.push(`price = $${vals.length}`); }
    if (quota !== undefined) { vals.push(num(quota));          sets.push(`quota = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    const row = await db.query(
      `UPDATE event_ticket_types SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    if (!row.rows.length) return res.status(404).json({ error: 'Ticket type not found' });
    res.json(row.rows[0]);
  }));

  app.delete('/api/events/ticket-types/:ttId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const ttId = num(req.params.ttId);
    const sold = await db.query(
      `SELECT COUNT(*)::int n FROM event_registrations WHERE ticket_type_id=$1 AND status <> 'cancelled'`, [ttId]);
    if (sold.rows[0].n > 0) {
      return res.status(409).json({ error: `${sold.rows[0].n} ticket(s) of this type have been issued — it cannot be removed.` });
    }
    const row = await db.query('DELETE FROM event_ticket_types WHERE id=$1 RETURNING id', [ttId]);
    if (!row.rows.length) return res.status(404).json({ error: 'Ticket type not found' });
    res.json({ success: true });
  }));

  /* ══════════════════════════════════════════════════════════
     REGISTRATION, WAITLIST & CHECK-IN
     Preserved verbatim from the working v2 implementation: row locking,
     database-level duplicate prevention, waitlist promotion, signed QR.
     Extended with ticket_type_id and the registration window.
     ══════════════════════════════════════════════════════════ */

  app.post('/api/events/:id/register', requireAuth, (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    const { paymentGateway, clientMutationId, ticketTypeId } = req.body || {};

    if (clientMutationId) {
      const seen = await db.query('SELECT 1 FROM sync_mutations WHERE client_mutation_id = $1', [clientMutationId]);
      if (seen.rows.length) {
        const existing = await db.query(
          'SELECT * FROM event_registrations WHERE event_id=$1 AND user_id=$2', [eventId, req.user.uid]);
        return res.json({ duplicate: true, registration: existing.rows[0] || null });
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const ev = await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId]);
      if (!ev.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
      const event = ev.rows[0];

      if (event.status === 'cancelled') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This event has been cancelled' });
      }
      if (event.approval_status !== 'approved') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This event is not open for registration yet' });
      }
      const now = new Date();
      if (event.registration_opens_at && now < new Date(event.registration_opens_at)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Registration for this event has not opened yet' });
      }
      if (event.registration_closes_at && now > new Date(event.registration_closes_at)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Registration for this event has closed' });
      }

      const dup = await client.query(
        'SELECT * FROM event_registrations WHERE event_id=$1 AND user_id=$2', [eventId, req.user.uid]);
      if (dup.rows.length && dup.rows[0].status !== 'cancelled') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You already have a ticket for this event', registration: dup.rows[0] });
      }

      // Resolve the ticket type: explicit choice, else the event's first type.
      let type = null;
      if (ticketTypeId) {
        const t = await client.query(
          'SELECT * FROM event_ticket_types WHERE id=$1 AND event_id=$2 FOR UPDATE', [num(ticketTypeId), eventId]);
        if (!t.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown ticket type for this event' }); }
        type = t.rows[0];
      } else {
        const t = await client.query(
          'SELECT * FROM event_ticket_types WHERE event_id=$1 ORDER BY position, id LIMIT 1 FOR UPDATE', [eventId]);
        type = t.rows[0] || null;
      }

      const takenTotal = await client.query(
        "SELECT COUNT(*)::int n FROM event_registrations WHERE event_id=$1 AND status='confirmed'", [eventId]);
      let full = takenTotal.rows[0].n >= event.capacity;

      // Per-type quota is checked on top of overall capacity.
      if (!full && type && type.quota !== null) {
        const takenType = await client.query(
          "SELECT COUNT(*)::int n FROM event_registrations WHERE ticket_type_id=$1 AND status='confirmed'", [type.id]);
        if (takenType.rows[0].n >= type.quota) full = true;
      }

      if (full && !event.waitlist_enabled) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This event is full and has no waitlist' });
      }
      const status = full ? 'waitlisted' : 'confirmed';

      const ticketCode = ref('DIC-TKT');
      const qrPayload = JSON.stringify({
        t: ticketCode, e: eventId, u: req.user.uid,
        s: signTicket(ticketCode, eventId, req.user.uid)
      });
      const priceValue = type ? Number(type.price) || 0
        : parseFloat(String(event.price).replace(/[^\d.]/g, '')) || 0;

      const reg = await client.query(`
        INSERT INTO event_registrations
          (event_id, user_id, ticket_code, qr_payload, ticket_type_id, ticket_type,
           amount_paid, payment_gateway, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [eventId, req.user.uid, ticketCode, qrPayload, type ? type.id : null,
         type ? type.name : 'standard', priceValue, paymentGateway || null, status]);

      if (status === 'confirmed') {
        await client.query('UPDATE events SET registered_count = registered_count + 1 WHERE id=$1', [eventId]);
      }
      if (clientMutationId) {
        await client.query(
          `INSERT INTO sync_mutations (client_mutation_id, user_id, entity, action, payload)
           VALUES ($1,$2,'event_registration','create',$3) ON CONFLICT DO NOTHING`,
          [clientMutationId, req.user.uid, JSON.stringify({ eventId })]);
      }

      await notify(client, {
        userId: req.user.uid,
        icon: status === 'confirmed' ? 'ticket-check' : 'hourglass',
        title: status === 'confirmed' ? 'Ticket confirmed' : 'Added to waitlist',
        subtitle: status === 'confirmed'
          ? `Your ticket for "${event.title}" is ${ticketCode}.`
          : `"${event.title}" is at capacity — you are on the waitlist.`,
        entity: 'ticket', entityId: eventId
      });

      await client.query('COMMIT');
      res.json({ registration: reg.rows[0], status, event: event.title });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }));

  app.delete('/api/events/:id/register', requireAuth, (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    const row = await db.query(
      `UPDATE event_registrations SET status='cancelled'
        WHERE event_id=$1 AND user_id=$2 AND status <> 'cancelled' RETURNING *`,
      [eventId, req.user.uid]);
    if (!row.rows.length) return res.status(404).json({ error: 'No active ticket found' });

    await db.query('UPDATE events SET registered_count = GREATEST(0, registered_count - 1) WHERE id=$1', [eventId]);

    const promoted = await db.query(`
      UPDATE event_registrations SET status='confirmed'
       WHERE id = (SELECT id FROM event_registrations
                    WHERE event_id=$1 AND status='waitlisted' ORDER BY created_at ASC LIMIT 1)
      RETURNING user_id, ticket_code`, [eventId]);

    if (promoted.rows.length) {
      await db.query('UPDATE events SET registered_count = registered_count + 1 WHERE id=$1', [eventId]);
      await notify(null, {
        userId: promoted.rows[0].user_id, icon: 'ticket-check',
        title: 'A seat opened up — you are in',
        subtitle: `Your waitlisted ticket ${promoted.rows[0].ticket_code} is now confirmed.`,
        entity: 'ticket', entityId: eventId
      });
    }
    res.json({ success: true, promoted: promoted.rows.length > 0 });
  }));

  app.get('/api/events/:id/my-ticket', requireAuth, (req, res) => ok(res, async () => {
    const rows = await db.query(`
      SELECT r.*, t.name AS ticket_type_name, e.title AS event_title,
             e.starts_on, e.start_time, e.venue
        FROM event_registrations r
        JOIN events e ON e.id = r.event_id
        LEFT JOIN event_ticket_types t ON t.id = r.ticket_type_id
       WHERE r.event_id=$1 AND r.user_id=$2 AND r.status <> 'cancelled'`,
      [num(req.params.id), req.user.uid]);
    res.json(rows.rows[0] || null);
  }));

  async function attendeeRows(eventId) {
    const r = await db.query(`
      SELECT r.id, r.ticket_code, r.status, r.checked_in, r.checked_in_at, r.amount_paid,
             r.created_at, COALESCE(t.name, r.ticket_type) AS ticket_type_name,
             u.id AS user_id, u.full_name AS name, u.initials, u.email,
             ap.batch, ap.department AS dept, ap.section_code AS section,
             ap.current_company AS company, ap.mobile_number AS phone
        FROM event_registrations r
        JOIN users u ON u.id = r.user_id
        LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
        LEFT JOIN event_ticket_types t ON t.id = r.ticket_type_id
       WHERE r.event_id = $1
       ORDER BY CASE r.status WHEN 'confirmed' THEN 0 WHEN 'waitlisted' THEN 1 ELSE 2 END,
                r.created_at ASC`, [eventId]);
    return r.rows;
  }

  app.get('/api/events/:id/attendees', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    res.json(await attendeeRows(num(req.params.id)));
  }));

  app.get('/api/events/:id/attendees.csv', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.id);
    const rows = await attendeeRows(id);
    const cols = ['name', 'email', 'phone', 'batch', 'dept', 'section', 'ticket_type_name',
                  'ticket_code', 'status', 'checked_in', 'checked_in_at', 'amount_paid'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="dic_event_${id}_attendees.csv"`);
    res.send(csv);
  }));

  app.post('/api/events/checkin', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    let { ticketCode } = req.body || {};
    if (!ticketCode) return res.status(400).json({ error: 'ticketCode is required' });
    ticketCode = String(ticketCode).trim();

    // Accept either a typed code or a whole scanned QR payload.
    if (ticketCode.startsWith('{')) {
      try {
        const p = JSON.parse(ticketCode);
        if (p && p.t) {
          if (p.s && p.e && p.u && p.s !== signTicket(p.t, p.e, p.u)) {
            return res.status(400).json({ error: 'This QR code failed signature validation' });
          }
          ticketCode = p.t;
        }
      } catch { /* fall through and treat it as a literal code */ }
    }

    const found = await db.query(`
      SELECT r.*, u.full_name, ap.batch, e.title AS event_title
        FROM event_registrations r
        JOIN users u ON u.id = r.user_id
        JOIN events e ON e.id = r.event_id
        LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
       WHERE r.ticket_code = $1`, [ticketCode]);

    if (!found.rows.length) return res.status(404).json({ error: 'Ticket not recognised' });
    const t = found.rows[0];
    if (t.status === 'cancelled') return res.status(409).json({ error: 'This ticket was cancelled' });
    if (t.status === 'waitlisted') return res.status(409).json({ error: 'This ticket is still on the waitlist' });
    if (t.checked_in) {
      return res.status(409).json({ error: 'Already checked in', attendee: t.full_name, at: t.checked_in_at });
    }

    const upd = await db.query(`
      UPDATE event_registrations
         SET checked_in = TRUE, checked_in_at = CURRENT_TIMESTAMP, checked_in_by = $2
       WHERE id = $1 RETURNING checked_in_at`, [t.id, req.user.uid]);

    await writeAudit('Attendee Checked In', `${t.full_name} · ticket ${ticketCode}`, 'circle-check-big');
    res.json({ success: true, attendee: t.full_name, batch: t.batch,
               event: t.event_title, at: upd.rows[0].checked_in_at });
  }));

  /* ══════════════════════════════════════════════════════════
     TASKS
     ══════════════════════════════════════════════════════════ */

  const TASK_SELECT = `
    t.*,
    cu.full_name AS created_by_name,
    uu.full_name AS updated_by_name,
    vu.full_name AS verified_by_name,
    (t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE AND t.status <> 'completed') AS is_overdue,
    COALESCE((
      /* A task can be assigned to a DIC account or to an external contact who
         has no account at all, so both are gathered into one ordered list and
         tagged with person_type. */
      SELECT json_agg(x ORDER BY x->>'name')
        FROM (
          SELECT json_build_object(
            'assignee_id', a.id, 'person_type', 'directory',
            'user_id', u.id, 'event_person_id', NULL,
            'name', u.full_name, 'initials', u.initials,
            'role_label', u.role_label, 'dept', ap.department, 'section', ap.section_code,
            'student_id', ap.student_id, 'phone', ap.mobile_number,
            'whatsapp', ap.whatsapp_number, 'photo_url', ap.photo_url,
            'organization', NULL, 'notifiable', TRUE
          ) AS x
            FROM event_task_assignees a
            JOIN users u ON u.id = a.user_id
            LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
           WHERE a.task_id = t.id
          UNION ALL
          SELECT json_build_object(
            'assignee_id', a.id, 'person_type', 'external',
            'user_id', NULL, 'event_person_id', p.id,
            'name', p.name, 'initials', UPPER(LEFT(p.name, 1)),
            'role_label', p.role_title, 'dept', p.department_area, 'section', NULL,
            'student_id', NULL, 'phone', p.phone,
            'whatsapp', p.whatsapp, 'photo_url', NULL,
            'organization', p.organization, 'notifiable', FALSE
          ) AS x
            FROM event_task_assignees a
            JOIN event_people p ON p.id = a.event_person_id
           WHERE a.task_id = t.id
        ) merged_assignees
    ), '[]'::json) AS assignees`;

  const TASK_JOINS = `
    FROM event_tasks t
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    LEFT JOIN users vu ON vu.id = t.verified_by`;

  // Staff manage every task; an assignee may act on their own.
  async function taskAccess(taskId, user) {
    const r = await db.query(
      `SELECT t.id, t.event_id,
              EXISTS (SELECT 1 FROM event_task_assignees a
                       WHERE a.task_id = t.id AND a.user_id = $2) AS is_assignee
         FROM event_tasks t WHERE t.id = $1`, [taskId, user.uid]);
    if (!r.rows.length) return null;
    return { ...r.rows[0], canManage: isStaff(user), canUpdate: isStaff(user) || r.rows[0].is_assignee };
  }

  app.get('/api/events/:id/tasks', requireAuth, (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    if (!isStaff(req.user)) {
      // A non-staff user sees only the tasks they are assigned to.
      const r = await db.query(`
        SELECT ${TASK_SELECT} ${TASK_JOINS}
         WHERE t.event_id = $1
           AND EXISTS (SELECT 1 FROM event_task_assignees a
                        WHERE a.task_id = t.id AND a.user_id = $2)
         ORDER BY t.due_on NULLS LAST, t.id`, [eventId, req.user.uid]);
      return res.json(r.rows);
    }
    const r = await db.query(
      `SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.event_id = $1
        ORDER BY t.due_on NULLS LAST, t.id`, [eventId]);
    res.json(r.rows);
  }));

  app.get('/api/events/tasks/:taskId', requireAuth, (req, res) => ok(res, async () => {
    const taskId = num(req.params.taskId);
    const access = await taskAccess(taskId, req.user);
    if (!access) return res.status(404).json({ error: 'Task not found' });
    if (!access.canUpdate) return res.status(403).json({ error: 'You do not have access to this task' });

    const [task, notes, checklist] = await Promise.all([
      db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id = $1`, [taskId]),
      db.query(`SELECT n.*, u.full_name AS author, u.initials
                  FROM event_task_notes n LEFT JOIN users u ON u.id = n.user_id
                 WHERE n.task_id = $1 ORDER BY n.created_at`, [taskId]),
      db.query(`SELECT * FROM event_task_checklist WHERE task_id = $1 ORDER BY position, id`, [taskId])
    ]);
    res.json({ ...task.rows[0], notes: notes.rows, checklist: checklist.rows, access });
  }));

  app.post('/api/events/:id/tasks', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Task title is required' });

    const priority = TASK_PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    const assigneeIds = Array.isArray(b.assigneeIds) ? b.assigneeIds.map(x => num(x)).filter(Boolean) : [];

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(`
        INSERT INTO event_tasks
          (event_id, title, description, category, committee_name, priority, status,
           due_on, deadline, created_by, updated_by, progress)
        VALUES ($1,$2,$3,$4,$4,$5,'todo',$6,NULL,$7,$7,0) RETURNING *`,
        [eventId, title, b.description || null, b.category || 'General', priority,
         b.dueOn || null, req.user.uid]);
      const task = row.rows[0];

      for (const uid of assigneeIds) {
        await client.query(
          `INSERT INTO event_task_assignees (task_id, user_id, assigned_by)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [task.id, uid, req.user.uid]);
      }
      const ev = await client.query('SELECT title FROM events WHERE id=$1', [eventId]);
      await notifyMany(client, assigneeIds, {
        icon: 'clipboard-list', title: 'You were assigned a task',
        subtitle: `"${title}" for ${ev.rows[0]?.title || 'an event'}.`,
        entity: 'task', entityId: task.id
      });

      await client.query('COMMIT');
      const full = await db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id=$1`, [task.id]);
      res.json(full.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  // Seed a practical checklist, with deadlines derived from the event date.
  app.post('/api/events/:id/tasks/standard-checklist', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    const ev = await db.query('SELECT id, title, starts_on FROM events WHERE id=$1', [eventId]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Event not found' });

    const created = [];
    for (const item of STANDARD_CHECKLIST) {
      const dup = await db.query(
        `SELECT 1 FROM event_tasks WHERE event_id=$1 AND LOWER(title)=LOWER($2)`, [eventId, item.title]);
      if (dup.rows.length) continue;

      const row = await db.query(`
        INSERT INTO event_tasks
          (event_id, title, category, committee_name, priority, status, due_on, created_by, updated_by, progress)
        VALUES ($1,$2,$3,$3,$4,'todo',
                CASE WHEN $6::date IS NULL THEN NULL
                     ELSE GREATEST($6::date - ($5 || ' days')::interval, CURRENT_DATE)::date END,
                $7,$7,0)
        RETURNING *`,
        [eventId, item.title, item.category, item.priority, String(item.offset),
         ev.rows[0].starts_on, req.user.uid]);
      created.push(row.rows[0]);
    }
    await writeAudit('Standard Checklist Added',
      `${created.length} task(s) on event ${eventId} by user ${req.user.uid}`, 'list-checks');
    res.json({ created: created.length, skipped: STANDARD_CHECKLIST.length - created.length });
  }));

  /* ─── UPDATE: field-scoped by role (Phase 10) ─── */
  app.put('/api/events/tasks/:taskId', requireAuth, (req, res) => ok(res, async () => {
    const taskId = num(req.params.taskId);
    const access = await taskAccess(taskId, req.user);
    if (!access) return res.status(404).json({ error: 'Task not found' });
    if (!access.canUpdate) {
      return res.status(403).json({ error: 'Only an assignee or an organiser can update this task' });
    }

    const b = req.body || {};
    // An assignee may move their own work forward; only staff may re-scope it.
    const assigneeFields = { status: 'status', progress: 'progress', blockedReason: 'blocked_reason' };
    const managerFields = {
      title: 'title', description: 'description', category: 'category',
      priority: 'priority', dueOn: 'due_on'
    };
    const allowed = access.canManage ? { ...assigneeFields, ...managerFields } : assigneeFields;

    for (const key of Object.keys(b)) {
      if (key in managerFields && !access.canManage) {
        return res.status(403).json({ error: `Only an organiser can change "${key}"` });
      }
    }

    if (b.status !== undefined && !TASK_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: 'Unknown task status' });
    }
    if (b.priority !== undefined && !TASK_PRIORITIES.includes(b.priority)) {
      return res.status(400).json({ error: 'Unknown task priority' });
    }
    if (b.status === 'blocked' && !String(b.blockedReason || '').trim()) {
      const existing = await db.query('SELECT blocked_reason FROM event_tasks WHERE id=$1', [taskId]);
      if (!String(existing.rows[0]?.blocked_reason || '').trim()) {
        return res.status(400).json({ error: 'A reason is required when marking a task blocked' });
      }
    }
    if (b.progress !== undefined) {
      const p = num(b.progress, 0);
      if (p < 0 || p > 100) return res.status(400).json({ error: 'Progress must be between 0 and 100' });
    }

    const before = await db.query('SELECT * FROM event_tasks WHERE id=$1', [taskId]);
    const prev = before.rows[0];

    const sets = [], vals = [taskId];
    for (const [k, col] of Object.entries(allowed)) {
      if (b[k] !== undefined) { vals.push(b[k] === '' ? null : b[k]); sets.push(`${col} = $${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    // Done implies 100%; leaving Done reopens progress; leaving Blocked clears the reason.
    if (b.status === 'completed') {
      sets.push(`progress = 100`, `completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)`);
    } else if (b.status && b.status !== 'completed') {
      sets.push(`completed_at = NULL`);
      if (b.progress === undefined && prev.progress === 100) sets.push(`progress = 75`);
    }
    if (b.status && b.status !== 'blocked') sets.push(`blocked_reason = NULL`);
    if (b.progress !== undefined && num(b.progress) === 100 && b.status === undefined) {
      sets.push(`status = 'completed'`, `completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)`);
    }

    vals.push(req.user.uid);
    sets.push(`updated_by = $${vals.length}`, `updated_at = CURRENT_TIMESTAMP`);

    const row = await db.query(
      `UPDATE event_tasks SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    const task = row.rows[0];

    /* Tell the people who need to know: the organiser when work becomes
       blocked or done, the assignees when an organiser re-scopes it. */
    const actor = await actorName(req.user.uid, 'An assignee');
    const ev = await db.query('SELECT title, created_by FROM events WHERE id=$1', [task.event_id]);
    const owner = ev.rows[0]?.created_by;

    if (b.status && b.status !== prev.status) {
      if (b.status === 'blocked' && owner && owner !== req.user.uid) {
        await notify(null, {
          userId: owner, icon: 'octagon-alert', title: 'Task marked blocked',
          subtitle: `${actor} blocked "${task.title}": ${task.blocked_reason || 'no reason given'}`,
          entity: 'task', entityId: task.id
        });
      }
      if (b.status === 'completed' && owner && owner !== req.user.uid) {
        await notify(null, {
          userId: owner, icon: 'circle-check-big', title: 'Task marked done',
          subtitle: `${actor} completed "${task.title}".`,
          entity: 'task', entityId: task.id
        });
      }
    }

    const full = await db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id=$1`, [taskId]);
    res.json(full.rows[0]);
  }));

  app.put('/api/events/tasks/:taskId/verify', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const taskId = num(req.params.taskId);
    const t = await db.query('SELECT status FROM event_tasks WHERE id=$1', [taskId]);
    if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
    if (t.rows[0].status !== 'completed') {
      return res.status(409).json({ error: 'Only a completed task can be verified' });
    }
    const row = await db.query(`
      UPDATE event_tasks SET verified_by=$2, verified_at=CURRENT_TIMESTAMP,
                             updated_by=$2, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING *`, [taskId, req.user.uid]);

    const assignees = await db.query('SELECT user_id FROM event_task_assignees WHERE task_id=$1', [taskId]);
    await notifyMany(null, assignees.rows.map(r => r.user_id), {
      icon: 'badge-check', title: 'Task verified',
      subtitle: `"${row.rows[0].title}" was verified by ${await actorName(req.user.uid)}.`,
      entity: 'task', entityId: taskId
    });

    const full = await db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id=$1`, [taskId]);
    res.json(full.rows[0]);
  }));

  app.delete('/api/events/tasks/:taskId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const row = await db.query('DELETE FROM event_tasks WHERE id=$1 RETURNING title', [num(req.params.taskId)]);
    if (!row.rows.length) return res.status(404).json({ error: 'Task not found' });
    await writeAudit('Task Deleted', `"${row.rows[0].title}" by user ${req.user.uid}`, 'trash-2');
    res.json({ success: true });
  }));

  /* ─── ASSIGNEES ───
     Accepts `userIds` (DIC accounts) and/or `eventPersonIds` (external
     contacts attached to this event). Only DIC accounts are notified — an
     external contact has no inbox, and inventing one would be a lie. */
  app.post('/api/events/tasks/:taskId/assignees', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const taskId = num(req.params.taskId);
    const b = req.body || {};
    const userIds = Array.isArray(b.userIds) ? b.userIds.map(x => num(x)).filter(Boolean) : [];
    const personIds = Array.isArray(b.eventPersonIds) ? b.eventPersonIds.map(x => num(x)).filter(Boolean) : [];
    if (!userIds.length && !personIds.length) {
      return res.status(400).json({ error: 'Select at least one person' });
    }

    const t = await db.query(
      `SELECT t.id, t.title, t.event_id, e.title AS event_title FROM event_tasks t
         JOIN events e ON e.id = t.event_id WHERE t.id=$1`, [taskId]);
    if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
    const eventId = t.rows[0].event_id;

    const addedUsers = [];
    for (const uid of userIds) {
      const r = await db.query(
        `INSERT INTO event_task_assignees (task_id, user_id, assigned_by)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id`,
        [taskId, uid, req.user.uid]);
      if (r.rows.length) addedUsers.push(uid);
    }

    let addedExternal = 0;
    for (const pid of personIds) {
      // An external contact belongs to one event; it cannot be borrowed by another.
      const owns = await db.query(
        `SELECT 1 FROM event_people WHERE id=$1 AND event_id=$2 AND person_type='external'`,
        [pid, eventId]);
      if (!owns.rows.length) continue;
      const r = await db.query(
        `INSERT INTO event_task_assignees (task_id, event_person_id, assigned_by)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
        [taskId, pid, req.user.uid]);
      if (r.rows.length) addedExternal++;
    }

    await notifyMany(null, addedUsers, {
      icon: 'clipboard-list', title: 'You were assigned a task',
      subtitle: `"${t.rows[0].title}" for ${t.rows[0].event_title}.`,
      entity: 'task', entityId: taskId
    });

    const full = await db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id=$1`, [taskId]);
    res.json({
      added: addedUsers.length + addedExternal,
      notified: addedUsers.length,
      externalAdded: addedExternal,
      task: full.rows[0]
    });
  }));

  app.delete('/api/events/tasks/:taskId/assignees/:userId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    await db.query('DELETE FROM event_task_assignees WHERE task_id=$1 AND user_id=$2',
      [num(req.params.taskId), num(req.params.userId)]);
    const full = await db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id=$1`, [num(req.params.taskId)]);
    res.json(full.rows[0]);
  }));

  app.delete('/api/events/tasks/:taskId/assignees/person/:personId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    await db.query('DELETE FROM event_task_assignees WHERE task_id=$1 AND event_person_id=$2',
      [num(req.params.taskId), num(req.params.personId)]);
    const full = await db.query(`SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id=$1`, [num(req.params.taskId)]);
    res.json(full.rows[0]);
  }));

  /* ─── NOTES & CHECKLIST ─── */
  app.post('/api/events/tasks/:taskId/notes', requireAuth, (req, res) => ok(res, async () => {
    const taskId = num(req.params.taskId);
    const access = await taskAccess(taskId, req.user);
    if (!access) return res.status(404).json({ error: 'Task not found' });
    if (!access.canUpdate) return res.status(403).json({ error: 'Only an assignee or an organiser can add notes' });

    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note cannot be empty' });

    const row = await db.query(
      `INSERT INTO event_task_notes (task_id, user_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [taskId, req.user.uid, body]);
    res.json({ ...row.rows[0], author: await actorName(req.user.uid, null) });
  }));

  app.post('/api/events/tasks/:taskId/checklist', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const taskId = num(req.params.taskId);
    const label = String((req.body || {}).label || '').trim();
    if (!label) return res.status(400).json({ error: 'Checklist item cannot be empty' });
    const pos = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 p FROM event_task_checklist WHERE task_id=$1`, [taskId]);
    const row = await db.query(
      `INSERT INTO event_task_checklist (task_id, label, position) VALUES ($1,$2,$3) RETURNING *`,
      [taskId, label, pos.rows[0].p]);
    res.json(row.rows[0]);
  }));

  app.put('/api/events/tasks/checklist/:itemId', requireAuth, (req, res) => ok(res, async () => {
    const itemId = num(req.params.itemId);
    const owner = await db.query('SELECT task_id FROM event_task_checklist WHERE id=$1', [itemId]);
    if (!owner.rows.length) return res.status(404).json({ error: 'Checklist item not found' });
    const access = await taskAccess(owner.rows[0].task_id, req.user);
    if (!access || !access.canUpdate) return res.status(403).json({ error: 'You cannot change this checklist' });

    const row = await db.query(
      `UPDATE event_task_checklist SET is_done = $2 WHERE id = $1 RETURNING *`,
      [itemId, (req.body || {}).isDone === true]);
    res.json(row.rows[0]);
  }));

  app.delete('/api/events/tasks/checklist/:itemId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    await db.query('DELETE FROM event_task_checklist WHERE id=$1', [num(req.params.itemId)]);
    res.json({ success: true });
  }));

  /* ══════════════════════════════════════════════════════════
     PEOPLE
     ══════════════════════════════════════════════════════════ */

  app.get('/api/events/:id/people', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    /* One list, two kinds of person. A directory row reads its details from
       the account; an external row carries its own, because there is no
       account to read from. */
    const r = await db.query(`
      SELECT p.id, p.person_type, p.role_in_event, p.committee, p.note, p.created_at,
             p.user_id,
             COALESCE(u.full_name, p.name)                       AS name,
             COALESCE(u.initials, UPPER(LEFT(p.name, 1)))        AS initials,
             COALESCE(u.role_label, p.role_title)                AS role_label,
             p.role_title,
             u.email,
             COALESCE(ap.department, p.department_area)          AS dept,
             ap.section_code                                     AS section,
             ap.student_id,
             COALESCE(ap.mobile_number, p.phone)                 AS phone,
             COALESCE(ap.whatsapp_number, p.whatsapp)            AS whatsapp,
             ap.photo_url,
             p.organization, p.notes,
             (p.person_type = 'directory')                       AS notifiable,
             ab.full_name AS added_by_name,
             (SELECT COUNT(*)::int FROM event_task_assignees a
                JOIN event_tasks t ON t.id = a.task_id
               WHERE t.event_id = p.event_id
                 AND ((a.user_id IS NOT NULL AND a.user_id = p.user_id)
                   OR (a.event_person_id = p.id)))               AS task_count
        FROM event_people p
        LEFT JOIN users u ON u.id = p.user_id
        LEFT JOIN alumni_profiles ap ON ap.user_id = p.user_id
        LEFT JOIN users ab ON ab.id = p.added_by
       WHERE p.event_id = $1
       ORDER BY p.person_type,
                CASE p.role_in_event WHEN 'coordinator' THEN 0 WHEN 'committee_lead' THEN 1
                                     WHEN 'member' THEN 2 ELSE 3 END,
                COALESCE(u.full_name, p.name)`,
      [num(req.params.id)]);
    res.json(r.rows);
  }));

  // Attach one or more DIC accounts to the event team.
  app.post('/api/events/:id/people', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    const b = req.body || {};
    const ids = Array.isArray(b.userIds) ? b.userIds.map(x => num(x)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one person' });
    const role = PEOPLE_ROLES.includes(b.roleInEvent) ? b.roleInEvent : 'member';

    const ev = await db.query('SELECT title FROM events WHERE id=$1', [eventId]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Event not found' });

    const added = [];
    for (const uid of ids) {
      const r = await db.query(`
        INSERT INTO event_people (event_id, user_id, person_type, role_in_event, committee, added_by)
        VALUES ($1,$2,'directory',$3,$4,$5)
        ON CONFLICT (event_id, user_id) DO NOTHING RETURNING user_id`,
        [eventId, uid, role, b.committee || null, req.user.uid]);
      if (r.rows.length) added.push(uid);
    }
    await notifyMany(null, added, {
      icon: 'users', title: 'You were added to an event team',
      subtitle: `You are part of "${ev.rows[0].title}".`,
      entity: 'event', entityId: eventId
    });
    res.json({ added: added.length, notified: added.length });
  }));

  /* Add someone with no DIC account — a decorator, caterer, photographer.
     This deliberately does NOT create a users row and never touches the
     alumni directory: the record lives and dies with this event. */
  app.post('/api/events/:id/external-people', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const eventId = num(req.params.id);
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const roleTitle = String(b.roleTitle || '').trim();

    if (!name) return res.status(400).json({ error: 'Full name is required' });
    if (!roleTitle) return res.status(400).json({ error: 'Role on event is required' });

    const ev = await db.query('SELECT id FROM events WHERE id=$1', [eventId]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Event not found' });

    const dup = await db.query(
      `SELECT 1 FROM event_people
        WHERE event_id=$1 AND person_type='external' AND LOWER(btrim(name))=LOWER($2)`,
      [eventId, name]);
    if (dup.rows.length) {
      return res.status(409).json({ error: `"${name}" is already on this event's team` });
    }

    const row = await db.query(`
      INSERT INTO event_people
        (event_id, user_id, person_type, role_in_event, name, role_title,
         phone, whatsapp, organization, department_area, notes, added_by)
      VALUES ($1, NULL, 'external', 'member', $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [eventId, name, roleTitle,
       String(b.phone || '').trim() || null,
       String(b.whatsapp || '').trim() || null,
       String(b.organization || '').trim() || null,
       String(b.departmentArea || '').trim() || null,
       String(b.notes || '').trim() || null,
       req.user.uid]);

    await writeAudit('External Contact Added',
      `"${name}" (${roleTitle}) on event ${eventId} by user ${req.user.uid}`, 'user-plus');
    res.json(row.rows[0]);
  }));

  app.put('/api/events/external-people/:personId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const id = num(req.params.personId);
    const b = req.body || {};
    const map = { name: 'name', roleTitle: 'role_title', phone: 'phone', whatsapp: 'whatsapp',
                  organization: 'organization', departmentArea: 'department_area', notes: 'notes' };
    const sets = [], vals = [id];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) {
        const v = String(b[k]).trim();
        if ((k === 'name' || k === 'roleTitle') && !v) {
          return res.status(400).json({ error: `${k === 'name' ? 'Full name' : 'Role on event'} cannot be empty` });
        }
        vals.push(v || null); sets.push(`${col} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    const row = await db.query(
      `UPDATE event_people SET ${sets.join(', ')}
        WHERE id=$1 AND person_type='external' RETURNING *`, vals);
    if (!row.rows.length) return res.status(404).json({ error: 'External contact not found' });
    res.json(row.rows[0]);
  }));

  app.delete('/api/events/people/:personId', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const row = await db.query('DELETE FROM event_people WHERE id=$1 RETURNING id, person_type, name',
      [num(req.params.personId)]);
    if (!row.rows.length) return res.status(404).json({ error: 'Person not found on this event' });
    res.json({ success: true });
  }));

  /* ══════════════════════════════════════════════════════════
     DIRECTORY LOOKUP (staff only — returns contact details)
     ══════════════════════════════════════════════════════════ */

  app.get('/api/directory/search', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(num(req.query.limit, 20), 50);
    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(
        LOWER(u.full_name) LIKE ${p}
        OR LOWER(COALESCE(ap.student_id, '')) LIKE ${p}
        OR LOWER(COALESCE(ap.roll_number, '')) LIKE ${p}
        OR regexp_replace(COALESCE(ap.mobile_number, ''), '[^0-9]', '', 'g') LIKE
           regexp_replace(${p}, '[^0-9%]', '', 'g')
        OR LOWER(COALESCE(ap.department, u.department)) LIKE ${p}
        OR LOWER(COALESCE(ap.section_code, '')) LIKE ${p}
      )`);
    }
    if (req.query.dept) {
      params.push(`%${String(req.query.dept).toLowerCase()}%`);
      where.push(`LOWER(COALESCE(ap.department, u.department)) LIKE $${params.length}`);
    }
    if (req.query.section) {
      params.push(String(req.query.section).toLowerCase());
      where.push(`LOWER(COALESCE(ap.section_code, '')) = $${params.length}`);
    }

    params.push(limit);
    const r = await db.query(`
      SELECT u.id, u.full_name AS name, u.initials, u.role, u.role_label,
             COALESCE(ap.department, u.department) AS dept,
             ap.section_code AS section, ap.student_id, ap.batch,
             ap.mobile_number AS phone, ap.whatsapp_number AS whatsapp,
             ap.photo_url, ap.color
        FROM users u
        LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY u.full_name
       LIMIT $${params.length}`, params);

    res.json({ results: r.rows, query: q });
  }));

  /* ══════════════════════════════════════════════════════════
     DEADLINE SWEEP — in-app reminders for approaching / overdue work.
     No scheduler exists in this deployment, so this is called on demand
     (on staff login) and is idempotent for a given day.
     ══════════════════════════════════════════════════════════ */

  /* Staff only. This was requireAuth, so any signed-in alumnus could advance
     every event's run status platform-wide and fan out overdue-task
     notifications. Nothing about the sweep is per-user: it is a maintenance
     pass over the whole events table, and only the people who manage events
     have any reason to trigger it. The client already calls it exclusively
     from evRunMaintenanceSweep(), which is itself gated on evCanManage(). */
  app.post('/api/events/tasks/reminder-sweep', requireRole(...MODERATOR_ROLES), (req, res) => ok(res, async () => {
    /* Advance event run status from the calendar. Nothing did this before, so
       an event stayed 'upcoming' for ever and the Past filter was always empty. */
    const advanced = await db.query(`
      UPDATE events SET status = CASE
               WHEN starts_on < CURRENT_DATE THEN 'past'
               WHEN starts_on = CURRENT_DATE THEN 'ongoing'
               ELSE status END
       WHERE status IN ('upcoming', 'ongoing')
         AND starts_on IS NOT NULL
         AND starts_on <= CURRENT_DATE
         AND status <> CASE WHEN starts_on < CURRENT_DATE THEN 'past' ELSE 'ongoing' END
      RETURNING id`);

    const due = await db.query(`
      SELECT t.id, t.title, t.due_on, a.user_id, e.title AS event_title,
             (t.due_on < CURRENT_DATE) AS overdue
        FROM event_tasks t
        JOIN event_task_assignees a ON a.task_id = t.id
        JOIN events e ON e.id = t.event_id
       WHERE t.status <> 'completed'
         AND t.due_on IS NOT NULL
         AND t.due_on <= CURRENT_DATE + INTERVAL '2 days'
         AND e.status <> 'cancelled'`);

    let sent = 0;
    for (const row of due.rows) {
      const title = row.overdue ? 'Task overdue' : 'Task deadline approaching';
      // One reminder per task per person per calendar day.
      const already = await db.query(`
        SELECT 1 FROM notifications
         WHERE user_id=$1 AND link_entity='task' AND link_id=$2 AND title=$3
           AND created_at::date = CURRENT_DATE`, [row.user_id, row.id, title]);
      if (already.rows.length) continue;

      await notify(null, {
        userId: row.user_id, icon: row.overdue ? 'triangle-alert' : 'clock',
        title,
        subtitle: `"${row.title}" (${row.event_title}) ${row.overdue ? 'was due' : 'is due'} ${String(row.due_on).slice(0, 10)}.`,
        entity: 'task', entityId: row.id
      });
      sent++;
    }
    res.json({ sent, scanned: due.rows.length, statusAdvanced: advanced.rowCount });
  }));

  return { STANDARD_CHECKLIST, EVENT_TYPES };
};
