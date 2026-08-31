/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   events.js

   Events and tickets, kept together exactly as it was: the list, the
   Manage/Public views, the creation wizard, the workspace and its tabs, tasks,
   the directory picker, external people, tickets, waitlist, QR, check-in,
   reports, the Advanced planner modules, permissions and notifications.

   This module is a protected baseline. It was moved wholesale, in source order,
   with no edit to any statement.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */



async function renderEventROIAnalytics() {
  const table = document.getElementById('event-roi-table');
  const summary = document.getElementById('roi-summary');
  if (!table) return;

  // v5: real figures from the events API. This panel previously rendered a
  // hardcoded MOCK_EVENT_ROI array that looked like live reporting.
  table.innerHTML = renderSkeletonCards(2, 'analytics');
  const events = await API.getEvents({ scope: 'manage', status: 'all' });

  if (apiFailed(events)) {
    table.innerHTML = renderErrorState(events && events.error ? events.error : 'Could not load event data.',
      'renderEventROIAnalytics()');
    if (summary) summary.innerHTML = '';
    evRefreshIcons();
    return;
  }
  if (!events.length) {
    table.innerHTML = renderEmptyState('<i data-lucide="calendar" class="ui-icon"></i>',
      'No events yet', 'Attendance and revenue appear here once events exist.');
    if (summary) summary.innerHTML = '';
    evRefreshIcons();
    return;
  }

  const rows = events.map(function (e) {
    const reg = e.registered || 0;
    const cap = e.capacity || 0;
    return {
      name: e.title,
      registered: reg,
      capacity: cap,
      checkedIn: e.checked_in || 0,
      fill: cap ? Math.round((reg / cap) * 100) : 0,
      revenue: Number(e.revenue || 0)
    };
  });

  table.innerHTML =
    '<div class="table-scroll"><table class="rbac-table"><thead><tr>' +
      '<th>Event</th><th>Registered</th><th>Capacity</th><th>Fill rate</th>' +
      '<th>Checked in</th><th>Ticket revenue</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr><td style="font-weight:700">' + escapeHtml(r.name) + '</td>' +
        '<td>' + r.registered.toLocaleString() + '</td>' +
        '<td>' + r.capacity.toLocaleString() + '</td>' +
        '<td><span class="card-badge ' + (r.fill >= 80 ? 'teal' : '') + '">' + r.fill + '%</span></td>' +
        '<td>' + r.checkedIn.toLocaleString() + '</td>' +
        '<td style="font-weight:700">' + evMoney(r.revenue) + '</td></tr>';
    }).join('') + '</tbody></table></div>';

  if (summary) {
    const totalReg = rows.reduce(function (a, r) { return a + r.registered; }, 0);
    const totalCap = rows.reduce(function (a, r) { return a + r.capacity; }, 0);
    const totalRev = rows.reduce(function (a, r) { return a + r.revenue; }, 0);
    const totalIn = rows.reduce(function (a, r) { return a + r.checkedIn; }, 0);
    const stat = function (label, value) {
      return '<div class="enrichment-stat-item"><span class="enrichment-stat-label">' + label +
             '</span><span class="enrichment-stat-val">' + value + '</span></div>';
    };
    summary.innerHTML = '<div style="display:flex;flex-direction:column;gap:12px">' +
      stat('Events', rows.length) +
      stat('Total registered', totalReg.toLocaleString()) +
      stat('Overall fill rate', (totalCap ? Math.round((totalReg / totalCap) * 100) : 0) + '%') +
      stat('Total checked in', totalIn.toLocaleString()) +
      stat('Total ticket revenue', evMoney(totalRev)) +
      '</div>';
  }
  evRefreshIcons();
}
// Shared table→card renderer. On mobile every planner table becomes a stack of
// cards (Phase 7) instead of a horizontally scrolling grid.


// ─── PLANNER: VENDORS / TIMELINE / LOGISTICS TABS (new in Phase 6) ───

/* Planner analytics moved into the event Reports tab (evTabReports). */

const PLANNER_FIELDS = {
  vendors:    { label: 'Vendor', fields: [['name','Vendor name','text',true],['category','Category','text'],['contactPerson','Contact person','text'],['phone','Phone','tel'],['email','Email','email'],['contractValue','Contract value (৳)','number'],['rating','Rating (0-5)','number'],['status','Status','select',false,['shortlisted','contracted','paid','rejected']]] },
  timeline:   { label: 'Milestone', fields: [['title','Milestone title','text',true],['description','Description','textarea'],['phase','Phase','text'],['startsAt','Start date','date'],['endsAt','End date','date'],['owner','Owner','text'],['progress','Progress %','number'],['status','Status','select',false,['pending','in_progress','done','delayed']]] },
  logistics:  { label: 'Logistics item', fields: [['item','Item','text',true],['category','Category','text'],['quantity','Quantity','number'],['location','Location','text'],['responsible','Responsible','text'],['status','Status','select',false,['planned','arranged','on_site','returned']]] },
  marketing:  { label: 'Campaign', fields: [['channel','Channel','text',true],['campaignName','Campaign name','text',true],['audience','Audience','text'],['budget','Budget (৳)','number'],['reach','Reach','number'],['conversions','Conversions','number'],['scheduledFor','Scheduled for','date'],['status','Status','select',false,['planned','live','completed','paused']]] },
  meetings:   { label: 'Meeting', fields: [['title','Meeting title','text',true],['agenda','Agenda','textarea'],['meetingDate','Date','date'],['meetingTime','Time','text'],['location','Location','text'],['attendees','Attendees','text'],['status','Status','select',false,['scheduled','held','cancelled']]] },
  committees: { label: 'Committee', fields: [['name','Committee name','text',true],['leaderName','Leader','text',true],['membersCount','Members','number'],['budgetAllocated','Budget (৳)','number']] },
  volunteers: { label: 'Volunteer', fields: [['volunteerName','Volunteer name','text',true],['shiftTime','Shift','text'],['assignedCommittee','Committee','text'],['attendanceStatus','Attendance','select',false,['assigned','checked_in','absent']]] },
  risks:      { label: 'Risk', fields: [['riskTitle','Risk','text',true],['category','Category','text'],['severity','Severity','select',false,['high','medium','low']],['contingencyPlan','Contingency plan','textarea',true]] },
  budgets:    { label: 'Budget line', fields: [['category','Category','text',true],['estimatedCost','Estimated cost','number'],['actualCost','Actual cost','number'],['vendorName','Vendor','text'],['paymentStatus','Payment','select',false,['unpaid','partial','paid']]] },
  sponsors:   { label: 'Sponsor', fields: [['company','Company','text',true],['contactPerson','Contact person','text'],['email','Email','email'],['phone','Phone','tel'],['packageTier','Tier','select',false,['title','gold','silver','bronze','partner']],['contributionAmount','Amount','number'],['pipelineStatus','Status','select',false,['proposed','agreed','received','rejected']],['deliverables','Deliverables','textarea']] },
  procurement:{ label: 'Item', fields: [['itemName','Item','text',true],['category','Category','text'],['quantity','Quantity','number'],['estimatedPrice','Estimated price','number'],['actualPrice','Actual price','number'],['vendorName','Vendor','text'],['deliveryStatus','Delivery','select',false,['requested','ordered','delivered']]] }
};

function showPlannerItemModal(kind) {
  const spec = PLANNER_FIELDS[kind];
  if (!spec) return;

  // Every label is tied to its field with `for`, and the close button carries an
  // accessible name — this form is reached from the event workspace, so it holds
  // to the same bar as the rest of the module.
  showModal(`
    <div class="modal-header">
      <h2 class="modal-title"><i data-lucide="plus" class="ui-icon" aria-hidden="true"></i> Add ${escapeHtml(spec.label)}</h2>
      <button type="button" class="modal-close" aria-label="Close">
        <i data-lucide="x" class="ui-icon" aria-hidden="true"></i></button>
    </div>
    <form onsubmit="submitPlannerItem(event, '${kind}')">
      ${spec.fields.map(([key, label, type, required, options]) => {
        const id = `pf-${key}`;
        const req = required ? ' <span class="req">*</span>' : '';
        const lab = `<label class="input-label" for="${id}">${escapeHtml(label)}${req}</label>`;
        if (type === 'textarea') {
          return `<div class="input-group">${lab}
            <textarea id="${id}" class="form-input" rows="3" ${required ? 'required' : ''}></textarea></div>`;
        }
        if (type === 'select') {
          return `<div class="input-group">${lab}
            <select id="${id}" class="form-select">${options.map(o => `<option value="${o}">${o.replace('_', ' ')}</option>`).join('')}</select></div>`;
        }
        return `<div class="input-group">${lab}
          <input type="${type}" id="${id}" class="form-input" ${required ? 'required' : ''} /></div>`;
      }).join('')}
      <div class="ev-modal-footer">
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save ${escapeHtml(spec.label)}</button>
      </div>
    </form>
  `);
}

async function submitPlannerItem(e, kind) {
  if (e) e.preventDefault();
  const spec = PLANNER_FIELDS[kind];
  const payload = { eventId: EV.event ? EV.event.id : null };
  if (!payload.eventId) { showToast('Open an event first.', 'triangle-alert'); return; }
  spec.fields.forEach(([key]) => {
    const el = document.getElementById('pf-' + key);
    if (el && el.value !== '') payload[key] = el.value;
  });

  const res = await API.createPlannerItem(kind, payload);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not save.'}`); return; }

  closeModal();
  showToast(`${spec.label} added.`, 'circle-check-big');
  EV.tab = 'advanced';
  renderEventTabs();
  await evTabAdvanced();
}

async function deletePlannerItem(kind, id) {
  if (!confirm('Delete this entry?')) return;
  const res = await API.deletePlannerItem(kind, id);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not delete.'}`); return; }
  showToast('Deleted.', 'trash-2');
  EV.tab = 'advanced';
  renderEventTabs();
  await evTabAdvanced();
}

/* ============================================================
   BULK IMPORT — REAL CSV PARSING
   Replaces simulateFileUploadProcess(), which ignored the chosen file and
   returned 12 hardcoded rows. This reads the actual file, parses it to
   RFC 4180, auto-maps headers, and validates before anything is sent.
   ============================================================ */

const EV_TYPES = ['Reunion', 'Seminar', 'Workshop', 'Career', 'Sports', 'Gala',
                  'Conference', 'Cultural', 'Ceremony', 'Meetup', 'Other'];

const EV_TYPE_ICON = {
  Reunion: 'users', Seminar: 'presentation', Workshop: 'wrench', Career: 'briefcase',
  Sports: 'trophy', Gala: 'sparkles', Conference: 'mic', Cultural: 'music',
  Ceremony: 'award', Meetup: 'coffee', Other: 'calendar'
};

const EV_STATUS_LABEL = { upcoming: 'Upcoming', ongoing: 'Ongoing', past: 'Past', cancelled: 'Cancelled' };

const EV_TASK_STATUS = [
  { key: 'todo',        label: 'Not Started', icon: 'circle-dashed',    tone: 'muted' },
  { key: 'in_progress', label: 'In Progress', icon: 'circle-dot',       tone: 'info' },
  { key: 'blocked',     label: 'Blocked',     icon: 'octagon-alert',    tone: 'danger' },
  { key: 'completed',   label: 'Done',        icon: 'circle-check-big', tone: 'success' }
];
const EV_TASK_CATEGORIES = ['Venue', 'Catering', 'Invitations', 'Budget',
                            'Volunteers', 'Marketing', 'Logistics', 'General'];
const EV_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const EV_PEOPLE_ROLES = [
  { key: 'coordinator',    label: 'Coordinator' },
  { key: 'committee_lead', label: 'Committee lead' },
  { key: 'member',         label: 'Committee member' },
  { key: 'volunteer',      label: 'Volunteer' }
];

const EV = {
  list: [], filter: 'upcoming', search: '', publicView: false,
  event: null, overview: null, tab: 'overview',
  tasks: [], taskFilter: 'all', people: [], attendees: [], advancedTab: 'budget',
  wizard: null, picker: null, task: null, _searchTimer: null
};

/* ─── helpers ─── */
/* "Super Admin · Super Admin" happened because the account name and its role
   label are often the same string on staff accounts. Show the name once, and
   append the role only when it genuinely adds something. */
function evCreditLine(name, roleLabel) {
  const n = String(name || '').trim();
  if (!n) return 'Not recorded';
  const r = String(roleLabel || '').trim();
  if (!r || r.toLowerCase() === n.toLowerCase()) return escapeHtml(n);
  return escapeHtml(n) + ' · ' + escapeHtml(r);
}

function evCanManage() {
  return !!state.currentUser &&
    ['super_admin', 'univ_admin', 'dept_admin', 'moderator'].includes(state.currentUser.role);
}
function evIsAdmin() {
  return !!state.currentUser && ['super_admin', 'univ_admin'].includes(state.currentUser.role);
}
function evTypeIcon(t) { return EV_TYPE_ICON[t] || 'calendar'; }

const EV_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Date-only values arrive as 'YYYY-MM-DD' and are formatted from their parts.
// Running them through `new Date()` would re-interpret them as UTC midnight and
// shift the day for any viewer west of Greenwich.
function evDate(v) {
  if (!v) return 'Date to be confirmed';
  const s = String(v);
  const plain = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plain) {
    return Number(plain[3]) + ' ' + EV_MONTHS[Number(plain[2]) - 1] + ' ' + plain[1];
  }
  const d = new Date(v);            // a real instant (created_at, approved_at…)
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Value for <input type="date">, which wants a bare 'YYYY-MM-DD'.
function evDateInput(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(v);
  if (isNaN(d)) return '';
  // Local parts, not toISOString(), so the day does not slip a zone.
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}
function evTime(v) {
  if (!v) return '';
  const parts = String(v).split(':');
  if (parts.length < 2) return String(v);
  const hh = parseInt(parts[0], 10);
  if (isNaN(hh)) return String(v);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return h12 + ':' + parts[1] + ' ' + suffix;
}
function evTimeInput(v) { return v ? String(v).slice(0, 5) : ''; }
function evTimeRange(e) {
  const a = evTime(e.start_time), b = evTime(e.end_time);
  return a && b ? (a + ' – ' + b) : (a || '');
}
function evMoney(n) { return '৳' + Number(n || 0).toLocaleString('en-IN'); }
function evIcon(name, cls) {
  return '<i data-lucide="' + name + '" class="ui-icon ' + (cls || '') + '" aria-hidden="true"></i>';
}
function evRefreshIcons() {
  if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
}

// Digits-only phone for tel: and wa.me. Bangladeshi local numbers get +880.
function evPhoneDigits(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('880')) return d;
  if (d.startsWith('0')) return '880' + d.slice(1);
  return d;
}

// Call / WhatsApp / Profile. A button is omitted when its number is missing.
function evContactButtons(p, compact) {
  const cls = 'ev-contact-btn' + (compact ? ' sm' : '');
  const phone = evPhoneDigits(p.phone);
  const wa = evPhoneDigits(p.whatsapp);
  const name = escapeHtml(p.name || 'this person');
  const out = [];
  if (phone) {
    out.push('<a class="' + cls + '" href="tel:+' + phone + '" aria-label="Call ' + name + '">' +
             evIcon('phone') + '<span>Call</span></a>');
  }
  if (wa) {
    out.push('<a class="' + cls + ' wa" href="https://wa.me/' + wa + '" target="_blank" rel="noopener" ' +
             'aria-label="Message ' + name + ' on WhatsApp">' + evIcon('message-circle') + '<span>WhatsApp</span></a>');
  }
  /* Only a DIC account has a profile to open. An external contact's id is an
     event_people row, not a user — linking it would open a stranger. */
  const uid = p.person_type === 'external' ? null : (p.user_id || p.id);
  if (uid && typeof viewAlumniProfile === 'function') {
    out.push('<button type="button" class="' + cls + '" onclick="viewAlumniProfile(' + uid + ')" ' +
             'aria-label="Open profile for ' + name + '">' + evIcon('user') + '<span>Profile</span></button>');
  }
  return out.join('');
}

function evAvatar(p, size) {
  const s = size || 34;
  if (p.photo_url) {
    return '<img class="ev-avatar" style="width:' + s + 'px;height:' + s + 'px" src="' +
           escapeHtml(p.photo_url) + '" alt="" loading="lazy" />';
  }
  const initials = p.initials || String(p.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('');
  return '<span class="ev-avatar ev-avatar-initials" aria-hidden="true" style="width:' + s +
         'px;height:' + s + 'px;font-size:' + Math.round(s / 2.8) + 'px">' + escapeHtml(initials) + '</span>';
}

function evPersonMeta(p) {
  return [p.dept, p.section ? 'Sec ' + p.section : null, p.student_id,
          p.batch ? 'Batch ' + p.batch : null]
    .filter(Boolean).map(escapeHtml).join(' · ') || '—';
}

/* ══════════════════════════════════════════════════════════
   EVENT LIST
   ══════════════════════════════════════════════════════════ */

/* Entering the Events page always starts in Manage for staff.
   EV.publicView used to persist for the life of the page, so an admin who
   peeked at Public view and navigated away came back to the public screen —
   which is the "wrong view on first entry, correct after refresh" report.
   Public view is a look, not a saved preference. */
async function renderEventsPage() {
  const listView = document.getElementById('ev-list-view');
  const wsView = document.getElementById('ev-workspace-view');
  if (listView) listView.classList.remove('hidden');
  if (wsView) wsView.classList.add('hidden');
  EV.event = null;

  // Identity must be settled before deciding which Events screen to draw.
  // Without this the module would fall through to its non-staff branch and
  // flash the public list at an admin.
  if (!(await evEnsureIdentity())) return;

  EV.publicView = false;
  renderEventListChrome();
  evRunMaintenanceSweep();
  await loadEventList();
}

/* Resolves the signed-in user before anything role-dependent renders.
   Shows a neutral skeleton while it waits, never the wrong view. */
async function evEnsureIdentity() {
  if (state.currentUser && state.currentUser.role) return true;

  const actions = document.getElementById('ev-list-actions');
  const filters = document.getElementById('ev-filters');
  const list = document.getElementById('ev-list');
  const sub = document.getElementById('ev-list-subtitle');
  if (actions) actions.innerHTML = '<span class="ev-chrome-skeleton" aria-hidden="true"></span>';
  if (filters) filters.innerHTML = '';
  if (sub) sub.textContent = 'Loading your events…';
  if (list) list.innerHTML = renderSkeletonCards(3, 'event');

  const me = await API.me();
  if (me && me.role) {
    state.currentUser = me;
    return true;
  }
  if (list) {
    list.innerHTML = renderErrorState(
      'Your session could not be confirmed. Please sign in again.', 'renderEventsPage()');
  }
  if (sub) sub.textContent = '';
  evRefreshIcons();
  return false;
}

/* There is no scheduler in this deployment (single Express app, also deployed
   serverless), so the calendar-driven event status roll-forward and the task
   deadline/overdue reminders run once per session when a staff member opens
   the Events page. Nothing else performs this maintenance.

   Fire-and-forget: a failure here must never block the page. The definition
   was lost in an earlier edit while its call site survived, which threw a
   ReferenceError that aborted renderEventsPage() before the list loaded. */
let _evSweptThisSession = false;

function evRunMaintenanceSweep() {
  if (_evSweptThisSession || !evCanManage()) return;
  _evSweptThisSession = true;
  Promise.resolve()
    .then(() => API.runReminderSweep())
    .then(res => {
      if (!apiFailed(res) && res.sent > 0 && typeof renderNotifications === 'function') {
        renderNotifications();
      }
    })
    .catch(() => { /* best effort — never surfaces to the user */ });
}

function renderEventListChrome() {
  const manage = evCanManage() && !EV.publicView;
  const sub = document.getElementById('ev-list-subtitle');
  if (sub) {
    sub.textContent = evCanManage()
      ? (manage ? 'Create, approve and run college events'
                : 'This is what alumni see')
      : 'Browse and register for college events';
  }

  const actions = document.getElementById('ev-list-actions');
  if (actions) {
    actions.innerHTML = evCanManage() ? (
      '<div class="ev-viewswitch" role="group" aria-label="Event view">' +
        '<button type="button" class="ev-viewswitch-btn ' + (EV.publicView ? '' : 'active') + '" ' +
          'aria-pressed="' + (!EV.publicView) + '" onclick="setEventListView(false)">' +
          evIcon('settings-2') + '<span>Manage</span></button>' +
        '<button type="button" class="ev-viewswitch-btn ' + (EV.publicView ? 'active' : '') + '" ' +
          'aria-pressed="' + EV.publicView + '" onclick="setEventListView(true)">' +
          evIcon('eye') + '<span>Public view</span></button>' +
      '</div>' +
      '<button type="button" class="btn btn-primary" onclick="openEventWizard()">' +
        evIcon('plus') + ' New Event</button>'
    ) : '';
  }

  const filters = document.getElementById('ev-filters');
  if (filters) {
    const opts = [['upcoming', 'Upcoming'], ['ongoing', 'Ongoing'], ['past', 'Past'],
                  ['cancelled', 'Cancelled'], ['all', 'All']];
    filters.innerHTML = opts.map(function (o) {
      const on = EV.filter === o[0];
      return '<button type="button" class="ev-chip ' + (on ? 'active' : '') + '" role="tab" ' +
             'aria-selected="' + on + '" onclick="setEventFilter(\'' + o[0] + '\')">' + o[1] + '</button>';
    }).join('');
  }
  evRefreshIcons();
}

function setEventListView(isPublic) {
  EV.publicView = isPublic;
  renderEventListChrome();
  loadEventList();
}
function setEventFilter(f) {
  EV.filter = f;
  renderEventListChrome();
  loadEventList();
}
function onEventSearch(v) {
  EV.search = v;
  clearTimeout(EV._searchTimer);
  EV._searchTimer = setTimeout(loadEventList, 250);
}

/* Boot fires one render and a click can fire another, so two responses race.
   Only the newest is allowed to paint — otherwise a slower earlier request
   lands last and overwrites the list the user actually asked for. */
let _evListRequest = 0;

async function loadEventList() {
  const el = document.getElementById('ev-list');
  if (!el) return;
  const ticket = ++_evListRequest;
  el.innerHTML = renderSkeletonCards(3, 'event');

  const params = {};
  if (EV.search) params.search = EV.search;
  if (EV.filter !== 'all') params.status = EV.filter;
  if (evCanManage() && !EV.publicView) params.scope = 'manage';

  const rows = await API.getEvents(params);
  if (ticket !== _evListRequest) return;   // a newer request has taken over
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState(rows && rows.error ? rows.error : 'Could not load events.', 'loadEventList()');
    evRefreshIcons();
    return;
  }
  EV.list = rows;

  if (!rows.length) {
    // Say why it is empty. "Nothing here yet" is wrong when the college has
    // plenty of events and the Upcoming filter simply matches none of them.
    const labels = { upcoming: 'upcoming', ongoing: 'ongoing', past: 'past', cancelled: 'cancelled' };
    let title, hint;
    if (EV.search) {
      title = 'No events match "' + EV.search.trim() + '"';
      hint = 'Try a different name or venue, or clear the search.';
    } else if (EV.filter !== 'all') {
      title = 'No ' + (labels[EV.filter] || EV.filter) + ' events';
      hint = 'Choose "All" to see every event.';
    } else {
      title = 'No events yet';
      hint = evCanManage() && !EV.publicView
        ? 'Use "New Event" to create the first one.'
        : 'New events will appear here once published.';
    }
    el.innerHTML = renderEmptyState(evIcon('calendar'), title, hint);
    evRefreshIcons();
    return;
  }

  const manage = evCanManage() && !EV.publicView;
  el.innerHTML = rows.map(function (e) { return manage ? evManageCard(e) : evPublicCard(e); }).join('');
  evRefreshIcons();
}

function evStatusPill(e) {
  if (e.status === 'cancelled') return '<span class="ev-pill danger">' + evIcon('calendar-x') + ' Cancelled</span>';
  if (e.approval_status === 'pending_approval') return '<span class="ev-pill warn">' + evIcon('clock') + ' Awaiting approval</span>';
  if (e.approval_status === 'rejected') return '<span class="ev-pill danger">' + evIcon('undo-2') + ' Sent back</span>';
  if (e.approval_status === 'draft') return '<span class="ev-pill muted">' + evIcon('file-pen') + ' Draft</span>';
  const label = EV_STATUS_LABEL[e.status] || e.status;
  return '<span class="ev-pill ' + (e.status === 'past' ? 'muted' : 'success') + '">' +
         evIcon('circle-check-big') + ' ' + escapeHtml(label) + '</span>';
}

function evCapacityBar(e) {
  const reg = e.registered != null ? e.registered : 0;
  const cap = e.capacity || 0;
  const pct = cap ? Math.min(100, Math.round((reg / cap) * 100)) : 0;
  return '<div class="ev-capacity">' +
    '<div class="ev-capacity-track" role="img" aria-label="' + reg + ' of ' + cap + ' places taken">' +
      '<div class="ev-capacity-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="ev-capacity-meta"><span>' + reg.toLocaleString() + ' of ' + cap.toLocaleString() +
      ' registered</span><span>' + pct + '%</span></div></div>';
}

function evManageCard(e) {
  return '<article class="ev-card">' +
    '<div class="ev-card-top">' +
      '<span class="ev-card-icon">' + evIcon(evTypeIcon(e.event_type)) + '</span>' +
      '<div class="ev-card-headings">' +
        '<h3 class="ev-card-title">' + escapeHtml(e.title) + '</h3>' +
        '<p class="ev-card-type">' + escapeHtml(e.event_type || 'Event') + '</p>' +
      '</div>' + evStatusPill(e) +
    '</div>' +
    '<dl class="ev-card-meta">' +
      '<div><dt>' + evIcon('calendar') + '<span class="sr-only">Date</span></dt><dd>' +
        escapeHtml(evDate(e.starts_on)) + (evTimeRange(e) ? ' · ' + escapeHtml(evTimeRange(e)) : '') + '</dd></div>' +
      '<div><dt>' + evIcon('map-pin') + '<span class="sr-only">Venue</span></dt><dd>' +
        escapeHtml(e.venue) + '</dd></div>' +
      '<div><dt>' + evIcon('user-round-pen') + '<span class="sr-only">Created by</span></dt><dd>' +
        evCreditLine(e.created_by_name, e.created_by_role) + '</dd></div>' +
    '</dl>' +
    evCapacityBar(e) +
    '<div class="ev-card-actions">' +
      '<button class="btn btn-primary btn-sm" onclick="openEventWorkspace(' + e.id + ')">' +
        evIcon('settings-2') + ' Manage</button>' +
      (e.approval_status === 'pending_approval' && evIsAdmin()
        ? '<button class="btn btn-outline btn-sm" onclick="evApprove(' + e.id + ')">' + evIcon('check') + ' Approve</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="evReject(' + e.id + ')">' + evIcon('undo-2') + ' Send back</button>'
        : '') +
    '</div></article>';
}

function evPublicCard(e) {
  const reg = e.registered != null ? e.registered : 0;
  const full = e.capacity ? reg >= e.capacity : false;
  return '<article class="ev-card">' +
    '<div class="ev-card-top">' +
      '<span class="ev-card-icon">' + evIcon(evTypeIcon(e.event_type)) + '</span>' +
      '<div class="ev-card-headings">' +
        '<h3 class="ev-card-title">' + escapeHtml(e.title) + '</h3>' +
        '<p class="ev-card-type">' + escapeHtml(e.event_type || 'Event') + ' · ' +
          (e.is_paid ? 'Paid' : 'Free') + '</p>' +
      '</div>' +
      (full ? '<span class="ev-pill warn">' + evIcon('hourglass') + ' Full</span>'
            : '<span class="ev-pill success">' + evIcon('circle-check-big') + ' Open</span>') +
    '</div>' +
    (e.description ? '<p class="ev-card-desc">' + escapeHtml(e.description) + '</p>' : '') +
    '<dl class="ev-card-meta">' +
      '<div><dt>' + evIcon('calendar') + '<span class="sr-only">Date</span></dt><dd>' +
        escapeHtml(evDate(e.starts_on)) + (evTimeRange(e) ? ' · ' + escapeHtml(evTimeRange(e)) : '') + '</dd></div>' +
      '<div><dt>' + evIcon('map-pin') + '<span class="sr-only">Venue</span></dt><dd>' +
        escapeHtml(e.venue) + '</dd></div>' +
    '</dl>' +
    evCapacityBar(e) +
    '<div class="ev-card-actions">' +
      (e.is_registered
        ? '<button class="btn btn-outline btn-sm" onclick="evViewTicket(' + e.id + ')">' + evIcon('ticket') + ' View ticket</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="evCancelTicket(' + e.id + ')">Cancel</button>'
        : '<button class="btn btn-primary btn-sm" onclick="evRegister(' + e.id + ')">' +
            evIcon(full ? 'hourglass' : 'ticket') + ' ' + (full ? 'Join waitlist' : 'Get ticket') + '</button>') +
    '</div></article>';
}

/* ══════════════════════════════════════════════════════════
   EVENT WORKSPACE SHELL
   ══════════════════════════════════════════════════════════ */

const EV_TABS = [
  { key: 'overview', label: 'Overview',            icon: 'layout-dashboard' },
  { key: 'tasks',    label: 'Tasks',               icon: 'clipboard-list' },
  { key: 'tickets',  label: 'Tickets & Attendees', icon: 'ticket' },
  { key: 'people',   label: 'People',              icon: 'users' },
  { key: 'reports',  label: 'Reports',             icon: 'chart-no-axes-column' },
  { key: 'advanced', label: 'Advanced',            icon: 'sliders-horizontal' }
];

async function openEventWorkspace(id, tab) {
  if (!evCanManage()) { showToast('Only organisers can open the event workspace.', 'lock'); return; }
  const listView = document.getElementById('ev-list-view');
  const wsView = document.getElementById('ev-workspace-view');
  if (listView) listView.classList.add('hidden');
  if (wsView) wsView.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  EV.tab = tab || 'overview';
  const header = document.getElementById('ev-context-header');
  const content = document.getElementById('ev-tab-content');
  if (header) header.innerHTML = renderSkeletonCards(1, 'event');
  if (content) content.innerHTML = renderSkeletonCards(2, 'planner');

  const data = await API.getEventOverview(id);
  if (apiFailed(data)) {
    if (content) content.innerHTML = renderErrorState(
      data && data.error ? data.error : 'Could not open this event.', 'openEventWorkspace(' + id + ')');
    if (header) header.innerHTML = '';
    evRefreshIcons();
    return;
  }
  EV.event = data.event;
  EV.overview = data;
  renderEventContextHeader();
  renderEventTabs();
  renderEventTab(EV.tab);
}

function closeEventWorkspace() { renderEventsPage(); }

async function evReloadWorkspace(tab) {
  if (!EV.event) return;
  await openEventWorkspace(EV.event.id, tab || EV.tab);
}

function renderEventContextHeader() {
  const el = document.getElementById('ev-context-header');
  const e = EV.event;
  if (!el || !e) return;

  const created = e.created_by_name
    ? evCreditLine(e.created_by_name, e.created_by_role) + ' · ' + escapeHtml(evDate(e.created_at))
    : 'Not recorded';

  el.innerHTML =
    '<section class="ev-context" aria-label="Event summary">' +
      '<div class="ev-context-main">' +
        '<span class="ev-context-icon">' + evIcon(evTypeIcon(e.event_type)) + '</span>' +
        '<div class="ev-context-text">' +
          '<h1 class="ev-context-title">' + escapeHtml(e.title) + '</h1>' +
          '<p class="ev-context-line">' + evIcon('calendar') + ' ' + escapeHtml(evDate(e.starts_on)) +
            (evTimeRange(e) ? ' · ' + escapeHtml(evTimeRange(e)) : '') + '</p>' +
          '<p class="ev-context-line">' + evIcon('map-pin') + ' ' + escapeHtml(e.venue) + '</p>' +
          '<p class="ev-context-line">' + evIcon('user-round-pen') + ' Created by ' + created + '</p>' +
        '</div>' +
        '<div class="ev-context-status">' + evStatusPill(e) +
          '<span class="ev-context-count">' + (e.registered != null ? e.registered : 0).toLocaleString() +
            ' / ' + (e.capacity || 0).toLocaleString() + ' registered</span>' +
          (e.approved_by_name ? '<span class="ev-context-sub">Approved by ' + escapeHtml(e.approved_by_name) + '</span>' : '') +
        '</div>' +
      '</div>' +
      (e.cancellation_reason ? '<p class="ev-banner danger">' + evIcon('triangle-alert') +
        ' Cancelled — ' + escapeHtml(e.cancellation_reason) + '</p>' : '') +
      (e.rejection_reason ? '<p class="ev-banner warn">' + evIcon('undo-2') +
        ' Sent back — ' + escapeHtml(e.rejection_reason) + '</p>' : '') +
      '<div class="ev-context-actions">' +
        '<button class="btn btn-outline btn-sm" onclick="evEditEvent()">' + evIcon('pencil') + ' Edit event</button>' +
        '<button class="btn btn-outline btn-sm" onclick="evPreviewPublic()">' + evIcon('eye') + ' Preview</button>' +
        (evIsAdmin() && e.status !== 'cancelled'
          ? '<button class="btn btn-ghost btn-sm ev-danger" onclick="evCancelEvent()">' + evIcon('calendar-x') + ' Cancel event</button>' : '') +
        (evIsAdmin() && e.approval_status === 'pending_approval'
          ? '<button class="btn btn-primary btn-sm" onclick="evApprove(' + e.id + ')">' + evIcon('check') + ' Approve</button>' +
            '<button class="btn btn-ghost btn-sm" onclick="evReject(' + e.id + ')">' + evIcon('undo-2') + ' Send back</button>' : '') +
      '</div>' +
    '</section>';
  evRefreshIcons();
}

function renderEventTabs() {
  const nav = document.getElementById('ev-tabs');
  if (!nav) return;
  nav.innerHTML = EV_TABS.map(function (t) {
    const on = EV.tab === t.key;
    return '<button type="button" class="ev-tab ' + (on ? 'active' : '') + '" role="tab" ' +
           'id="ev-tab-' + t.key + '" aria-selected="' + on + '" ' +
           'onclick="switchEventTab(\'' + t.key + '\')">' + evIcon(t.icon) + '<span>' + t.label + '</span></button>';
  }).join('');
  evRefreshIcons();
  const active = nav.querySelector('.ev-tab.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function switchEventTab(tab) {
  EV.tab = tab;
  renderEventTabs();
  renderEventTab(tab);
}

function renderEventTab(tab) {
  const el = document.getElementById('ev-tab-content');
  if (!el) return;
  el.setAttribute('aria-labelledby', 'ev-tab-' + tab);
  if (tab === 'overview') return evTabOverview();
  if (tab === 'tasks')    return evTabTasks();
  if (tab === 'tickets')  return evTabTickets();
  if (tab === 'people')   return evTabPeople();
  if (tab === 'reports')  return evTabReports();
  if (tab === 'advanced') return evTabAdvanced();
}

/* ══════════════════════════════════════════════════════════
   TAB — OVERVIEW
   ══════════════════════════════════════════════════════════ */

function evStat(icon, value, label, tone) {
  return '<div class="ev-stat">' +
    '<span class="ev-stat-icon ' + (tone || '') + '">' + evIcon(icon) + '</span>' +
    '<div><div class="ev-stat-value">' + value + '</div>' +
    '<div class="ev-stat-label">' + label + '</div></div></div>';
}

function evTabOverview() {
  const el = document.getElementById('ev-tab-content');
  const e = EV.event, o = EV.overview;
  if (!el || !e || !o) return;

  const available = Math.max(0, (e.capacity || 0) - (e.registered || 0));
  const hasTasks = o.tasks.total > 0;

  el.innerHTML =
    '<div class="ev-stats">' +
      evStat('users', (e.registered || 0).toLocaleString(), 'Registered', 'info') +
      evStat('armchair', available.toLocaleString(), 'Seats available') +
      evStat('clipboard-list', o.tasks.total, 'Tasks') +
      evStat('circle-check-big', o.tasks.completionRate + '%', 'Tasks complete', 'success') +
      (e.is_paid ? evStat('banknote', evMoney(o.revenue), 'Ticket revenue', 'success') : '') +
      (o.tasks.overdue ? evStat('triangle-alert', o.tasks.overdue, 'Overdue', 'danger') : '') +
    '</div>' +

    (e.description
      ? '<section class="ev-panel"><h2 class="ev-panel-title">About this event</h2>' +
        '<p class="ev-prose">' + escapeHtml(e.description) + '</p>' +
        '<dl class="ev-deflist">' +
          '<div><dt>Organiser</dt><dd>' +
            (e.organizer_department ? escapeHtml(e.organizer_department)
                                    : '<span class="ev-notset">Not set</span>') + '</dd></div>' +
          '<div><dt>Visibility</dt><dd>' + escapeHtml(
              e.visibility === 'public' ? 'Public' : e.visibility === 'invite' ? 'Invite only' : 'Alumni only') + '</dd></div>' +
          '<div><dt>Registration</dt><dd>' + escapeHtml(evRegWindowText(e)) + '</dd></div>' +
          '<div><dt>Waitlist</dt><dd>' + (e.waitlist_enabled ? 'Enabled' : 'Off') + '</dd></div>' +
        '</dl></section>'
      : '') +

    '<section class="ev-panel">' +
      '<h2 class="ev-panel-title">Next steps</h2>' +
      '<div class="ev-starters">' +
        '<button type="button" class="ev-starter" onclick="switchEventTab(\'tasks\')">' +
          '<span class="ev-starter-icon">' + evIcon('clipboard-list') + '</span>' +
          '<span class="ev-starter-text"><strong>Add tasks</strong>' +
          '<span>Break the work down and give it deadlines</span></span>' +
          evIcon('chevron-right', 'ev-starter-chevron') + '</button>' +
        '<button type="button" class="ev-starter" onclick="switchEventTab(\'people\')">' +
          '<span class="ev-starter-icon">' + evIcon('users') + '</span>' +
          '<span class="ev-starter-text"><strong>Add people</strong>' +
          '<span>Build the committee and volunteer team</span></span>' +
          evIcon('chevron-right', 'ev-starter-chevron') + '</button>' +
        '<button type="button" class="ev-starter" onclick="evPreviewPublic()">' +
          '<span class="ev-starter-icon">' + evIcon('eye') + '</span>' +
          '<span class="ev-starter-text"><strong>Preview public event</strong>' +
          '<span>See what alumni will see</span></span>' +
          evIcon('chevron-right', 'ev-starter-chevron') + '</button>' +
      '</div>' +
      (hasTasks ? '' :
        '<div class="ev-callout">' + evIcon('list-checks') +
          '<div><strong>No tasks yet</strong>' +
          '<p>Add a ready-made checklist of the usual jobs — confirm venue, catering, ' +
          'invitations, volunteers — with deadlines worked back from the event date.</p></div>' +
          '<button class="btn btn-primary btn-sm" onclick="evAddStandardChecklist()">Add standard checklist</button>' +
        '</div>') +
    '</section>';
  evRefreshIcons();
}

function evRegWindowText(e) {
  const o = e.registration_opens_at ? evDate(e.registration_opens_at) : null;
  const c = e.registration_closes_at ? evDate(e.registration_closes_at) : null;
  if (o && c) return 'Open ' + o + ' to ' + c;
  if (o) return 'Opens ' + o;
  if (c) return 'Closes ' + c;
  return 'Open now';
}

async function evAddStandardChecklist() {
  if (!EV.event) return;
  const res = await API.addStandardChecklist(EV.event.id);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not add the checklist.', 'triangle-alert'); return; }
  showToast(res.created + ' task' + (res.created === 1 ? '' : 's') + ' added.', 'circle-check-big');
  await evReloadWorkspace('tasks');
}

/* ══════════════════════════════════════════════════════════
   TAB — TASKS  (filterable list; no Kanban at any width)
   ══════════════════════════════════════════════════════════ */

async function evTabTasks() {
  const el = document.getElementById('ev-tab-content');
  if (!el || !EV.event) return;
  el.innerHTML = renderSkeletonCards(3, 'planner');

  const tasks = await API.getEventTasks(EV.event.id);
  if (apiFailed(tasks)) {
    el.innerHTML = renderErrorState(tasks && tasks.error ? tasks.error : 'Could not load tasks.', 'evTabTasks()');
    evRefreshIcons();
    return;
  }
  EV.tasks = tasks;
  evRenderTaskList();
}

function evRenderTaskList() {
  const el = document.getElementById('ev-tab-content');
  if (!el) return;

  const counts = { all: EV.tasks.length, overdue: EV.tasks.filter(function (t) { return t.is_overdue; }).length };
  EV_TASK_STATUS.forEach(function (s) {
    counts[s.key] = EV.tasks.filter(function (t) { return t.status === s.key; }).length;
  });

  const chips = [{ key: 'all', label: 'All' }]
    .concat(EV_TASK_STATUS.map(function (s) { return { key: s.key, label: s.label }; }))
    .concat(counts.overdue ? [{ key: 'overdue', label: 'Overdue' }] : []);

  const filtered = EV.tasks.filter(function (t) {
    if (EV.taskFilter === 'all') return true;
    if (EV.taskFilter === 'overdue') return t.is_overdue;
    return t.status === EV.taskFilter;
  });

  el.innerHTML =
    '<section class="ev-panel">' +
      '<div class="ev-panel-head">' +
        '<h2 class="ev-panel-title">Tasks</h2>' +
        '<div class="ev-panel-actions">' +
          (EV.tasks.length ? '' :
            '<button class="btn btn-outline btn-sm" onclick="evAddStandardChecklist()">' +
            evIcon('list-checks') + ' Standard checklist</button>') +
          '<button class="btn btn-primary btn-sm" onclick="evNewTask()">' + evIcon('plus') + ' New task</button>' +
        '</div>' +
      '</div>' +
      '<div class="ev-filters" role="tablist" aria-label="Filter tasks">' +
        chips.map(function (c) {
          const on = EV.taskFilter === c.key;
          return '<button type="button" class="ev-chip ' + (on ? 'active' : '') + '" role="tab" ' +
                 'aria-selected="' + on + '" onclick="evSetTaskFilter(\'' + c.key + '\')">' +
                 c.label + '<span class="ev-chip-count">' + (counts[c.key] || 0) + '</span></button>';
        }).join('') +
      '</div>' +
      (filtered.length
        ? '<ul class="ev-tasklist">' + filtered.map(evTaskRow).join('') + '</ul>'
        : renderEmptyState(evIcon('clipboard-list'), 'No tasks here',
            EV.taskFilter === 'all' ? 'Add the first task to get started.' : 'Try another filter.')) +
    '</section>';
  evRefreshIcons();
}

function evSetTaskFilter(f) { EV.taskFilter = f; evRenderTaskList(); }

function evTaskStatusMeta(key) {
  return EV_TASK_STATUS.find(function (s) { return s.key === key; }) || EV_TASK_STATUS[0];
}

function evTaskRow(t) {
  const meta = evTaskStatusMeta(t.status);
  const assignees = t.assignees || [];
  const shown = assignees.slice(0, 3);
  const extra = assignees.length - shown.length;

  return '<li class="ev-task ' + (t.is_overdue ? 'overdue' : '') + '">' +
    '<button type="button" class="ev-task-main" onclick="evOpenTask(' + t.id + ')" ' +
            'aria-label="Open task ' + escapeHtml(t.title) + '">' +
      '<span class="ev-task-status ' + meta.tone + '">' + evIcon(meta.icon) +
        '<span class="ev-task-status-label">' + meta.label + '</span></span>' +
      '<span class="ev-task-body">' +
        '<span class="ev-task-title">' + escapeHtml(t.title) + '</span>' +
        '<span class="ev-task-meta">' +
          (t.category ? '<span class="ev-tag">' + escapeHtml(t.category) + '</span>' : '') +
          '<span class="ev-tag prio-' + escapeHtml(t.priority) + '">' + escapeHtml(t.priority) + '</span>' +
          (t.due_on
            ? '<span class="ev-task-due ' + (t.is_overdue ? 'danger' : '') + '">' + evIcon('calendar') + ' ' +
              escapeHtml(evDate(t.due_on)) + (t.is_overdue ? ' · overdue' : '') + '</span>'
            : '') +
          (t.verified_at ? '<span class="ev-task-due success">' + evIcon('badge-check') + ' Verified</span>' : '') +
        '</span>' +
        (t.status === 'blocked' && t.blocked_reason
          ? '<span class="ev-task-blocked">' + evIcon('octagon-alert') + ' ' + escapeHtml(t.blocked_reason) + '</span>'
          : '') +
      '</span>' +
      '<span class="ev-task-right">' +
        '<span class="ev-progress" role="img" aria-label="' + t.progress + ' percent complete">' +
          '<span class="ev-progress-track"><span class="ev-progress-fill" style="width:' + t.progress + '%"></span></span>' +
          '<span class="ev-progress-num">' + t.progress + '%</span>' +
        '</span>' +
        '<span class="ev-task-avatars">' +
          shown.map(function (a) {
            return '<span class="ev-stackav ' + (a.person_type === 'external' ? 'external' : '') + '" ' +
              'title="' + escapeHtml(a.name) + (a.person_type === 'external' ? ' (external)' : '') + '">' +
              evAvatar(a, 26) + '</span>'; }).join('') +
          (extra > 0 ? '<span class="ev-avatar ev-avatar-more" style="width:26px;height:26px">+' + extra + '</span>' : '') +
          (assignees.length === 0 ? '<span class="ev-unassigned">Unassigned</span>' : '') +
        '</span>' +
      '</span>' +
    '</button></li>';
}

/* ─── Task detail ─── */

async function evOpenTask(taskId) {
  const t = await API.getTask(taskId);
  if (apiFailed(t)) { showToast(t && t.error ? t.error : 'Could not open this task.', 'triangle-alert'); return; }
  EV.task = t;
  evRenderTaskModal();
}

function evRenderTaskModal() {
  const t = EV.task;
  if (!t) return;
  const canManage = t.access && t.access.canManage;
  const meta = evTaskStatusMeta(t.status);

  const statusButtons = EV_TASK_STATUS.map(function (s) {
    const on = t.status === s.key;
    return '<button type="button" class="ev-seg ' + (on ? 'active ' + s.tone : '') + '" ' +
      'aria-pressed="' + on + '" onclick="evSetTaskStatus(\'' + s.key + '\')">' +
      evIcon(s.icon) + '<span>' + s.label + '</span></button>';
  }).join('');

  const steps = [0, 25, 50, 75, 100].map(function (p) {
    return '<button type="button" class="ev-progress-step ' + (t.progress === p ? 'active' : '') + '" ' +
      'aria-pressed="' + (t.progress === p) + '" onclick="evSetTaskProgress(' + p + ')">' + p + '%</button>';
  }).join('');

  showModal(
    '<div class="modal-header">' +
      '<h2 class="modal-title">' + evIcon('clipboard-list') + ' ' + escapeHtml(t.title) + '</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button>' +
    '</div>' +
    '<div class="ev-taskmodal">' +

      (t.is_overdue ? '<p class="ev-banner danger">' + evIcon('triangle-alert') + ' This task is overdue.</p>' : '') +
      (t.status === 'blocked' && t.blocked_reason
        ? '<p class="ev-banner warn">' + evIcon('octagon-alert') + ' Blocked — ' + escapeHtml(t.blocked_reason) + '</p>' : '') +
      (t.verified_at
        ? '<p class="ev-banner success">' + evIcon('badge-check') + ' Verified by ' +
          escapeHtml(t.verified_by_name || 'an organiser') + ' on ' + escapeHtml(evDate(t.verified_at)) + '</p>' : '') +

      (t.description ? '<p class="ev-prose">' + escapeHtml(t.description) + '</p>' : '') +

      '<dl class="ev-deflist compact">' +
        '<div><dt>Category</dt><dd>' + escapeHtml(t.category || 'General') + '</dd></div>' +
        '<div><dt>Priority</dt><dd>' + escapeHtml(t.priority) + '</dd></div>' +
        '<div><dt>Deadline</dt><dd>' + (t.due_on ? escapeHtml(evDate(t.due_on)) : 'None') + '</dd></div>' +
        '<div><dt>Created by</dt><dd>' +
          (t.created_by_name ? escapeHtml(t.created_by_name) : '<span class="ev-notset">Not recorded</span>') +
          '</dd></div>' +
        (t.updated_by_name ? '<div><dt>Last updated by</dt><dd>' + escapeHtml(t.updated_by_name) +
          ' · ' + escapeHtml(evDate(t.updated_at)) + '</dd></div>' : '') +
        (t.completed_at ? '<div><dt>Completed</dt><dd>' + escapeHtml(evDate(t.completed_at)) + '</dd></div>' : '') +
      '</dl>' +

      '<div class="ev-field">' +
        '<span class="ev-label">Status</span>' +
        '<div class="ev-segrow" role="group" aria-label="Task status">' + statusButtons + '</div>' +
      '</div>' +

      '<div class="ev-field">' +
        '<span class="ev-label">Progress <strong>' + t.progress + '%</strong></span>' +
        '<div class="ev-progress-steps" role="group" aria-label="Task progress">' + steps + '</div>' +
      '</div>' +

      '<div class="ev-field">' +
        '<div class="ev-field-head">' +
          '<span class="ev-label">Assigned to</span>' +
          (canManage ? '<button class="btn btn-outline btn-sm" onclick="evOpenPicker(\'task\')">' +
            evIcon('user-plus') + ' Add people</button>' : '') +
        '</div>' +
        (t.assignees && t.assignees.length
          ? '<ul class="ev-people">' + t.assignees.map(function (a) {
              const isExternal = a.person_type === 'external';
              const meta = isExternal
                ? [a.role_label, a.organization].filter(Boolean).map(escapeHtml).join(' · ')
                : evPersonMeta(a);
              const remove = isExternal
                ? 'evRemoveAssigneePerson(' + a.event_person_id + ')'
                : 'evRemoveAssignee(' + a.user_id + ')';
              return '<li class="ev-person">' + evAvatar(a, 38) +
                '<div class="ev-person-text">' +
                  '<div class="ev-person-name"><strong>' + escapeHtml(a.name) + '</strong>' +
                    evPersonBadge(a.person_type) + '</div>' +
                  (meta ? '<span>' + meta + '</span>' : '') +
                  (isExternal
                    ? '<span class="ev-muted small">' + evIcon('info') +
                      ' External contact · No in-app account</span>' : '') +
                '</div>' +
                '<div class="ev-person-actions">' + evContactButtons(a, true) +
                  (canManage ? '<button type="button" class="ev-contact-btn sm danger" ' +
                    'onclick="' + remove + '" aria-label="Remove ' + escapeHtml(a.name) + '">' +
                    evIcon('user-minus') + '<span>Remove</span></button>' : '') +
                '</div></li>'; }).join('') + '</ul>'
          : '<p class="ev-muted">Nobody assigned yet.</p>') +
        (t.assigned_to && (!t.assignees || !t.assignees.length)
          ? '<p class="ev-muted small">Previously recorded as “' + escapeHtml(t.assigned_to) +
            '” before people were linked to accounts.</p>' : '') +
      '</div>' +

      '<div class="ev-field">' +
        '<div class="ev-field-head"><span class="ev-label">Checklist</span>' +
        (canManage ? '<button class="btn btn-ghost btn-sm" onclick="evAddChecklistItem()">' +
          evIcon('plus') + ' Add item</button>' : '') + '</div>' +
        (t.checklist && t.checklist.length
          ? '<ul class="ev-checklist">' + t.checklist.map(function (c) {
              return '<li><label class="ev-check"><input type="checkbox" ' + (c.is_done ? 'checked' : '') +
                ' onchange="evToggleChecklist(' + c.id + ', this.checked)" />' +
                '<span>' + escapeHtml(c.label) + '</span></label>' +
                (canManage ? '<button type="button" class="ev-icon-btn" onclick="evDeleteChecklistItem(' + c.id + ')" ' +
                  'aria-label="Remove checklist item">' + evIcon('x') + '</button>' : '') + '</li>'; }).join('') + '</ul>'
          : '<p class="ev-muted">No checklist items.</p>') +
      '</div>' +

      '<div class="ev-field">' +
        '<span class="ev-label">Notes</span>' +
        (t.notes && t.notes.length
          ? '<ul class="ev-notes">' + t.notes.map(function (n) {
              return '<li><div class="ev-note-head"><strong>' + escapeHtml(n.author || 'Someone') + '</strong>' +
                '<span>' + escapeHtml(formatRelativeTime(n.created_at)) + '</span></div>' +
                '<p>' + escapeHtml(n.body) + '</p></li>'; }).join('') + '</ul>'
          : '<p class="ev-muted">No notes yet.</p>') +
        '<form class="ev-note-form" onsubmit="evAddNote(event)">' +
          '<label class="sr-only" for="ev-note-input">Add a note</label>' +
          '<input type="text" id="ev-note-input" class="form-input" placeholder="Add a note…" maxlength="500" />' +
          '<button type="submit" class="btn btn-outline btn-sm">' + evIcon('send') + ' Post</button>' +
        '</form>' +
      '</div>' +

      '<div class="ev-modal-footer">' +
        (canManage
          ? '<button class="btn btn-outline btn-sm" onclick="evEditTask()">' + evIcon('pencil') + ' Edit details</button>' +
            (t.status === 'completed' && !t.verified_at
              ? '<button class="btn btn-primary btn-sm" onclick="evVerifyTask()">' + evIcon('badge-check') + ' Verify</button>' : '') +
            '<button class="btn btn-ghost btn-sm ev-danger" onclick="evDeleteTask()">' + evIcon('trash-2') + ' Delete</button>'
          : '') +
      '</div>' +
    '</div>');
  evRefreshIcons();
}

async function evReloadTask() {
  if (!EV.task) return;
  const t = await API.getTask(EV.task.id);
  if (!apiFailed(t)) { EV.task = t; evRenderTaskModal(); }

  // An assignee can reach a task straight from a notification without ever
  // opening the event workspace, so there may be no event list to refresh.
  if (!EV.event) return;
  const tasks = await API.getEventTasks(EV.event.id);
  if (!apiFailed(tasks)) { EV.tasks = tasks; if (EV.tab === 'tasks') evRenderTaskList(); }
}

async function evSetTaskStatus(status) {
  if (!EV.task) return;
  let payload = { status: status };
  if (status === 'blocked') {
    const reason = prompt('What is blocking this task?', EV.task.blocked_reason || '');
    if (reason === null) return;
    if (!reason.trim()) { showToast('A reason is required to mark a task blocked.', 'triangle-alert'); return; }
    payload.blockedReason = reason.trim();
  }
  const res = await API.updateTask(EV.task.id, payload);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not update the task.', 'triangle-alert'); return; }
  showToast('Task set to ' + evTaskStatusMeta(status).label + '.', 'circle-check-big');
  await evReloadTask();
}

async function evSetTaskProgress(p) {
  if (!EV.task) return;
  const payload = { progress: p };
  if (p > 0 && p < 100 && EV.task.status === 'todo') payload.status = 'in_progress';
  const res = await API.updateTask(EV.task.id, payload);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not update progress.', 'triangle-alert'); return; }
  showToast('Progress set to ' + p + '%.', 'circle-check-big');
  await evReloadTask();
}

async function evVerifyTask() {
  const res = await API.verifyTask(EV.task.id);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not verify.', 'triangle-alert'); return; }
  showToast('Task verified.', 'badge-check');
  await evReloadTask();
}

async function evDeleteTask() {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  const res = await API.deleteTask(EV.task.id);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not delete.', 'triangle-alert'); return; }
  closeModal();
  showToast('Task deleted.', 'trash-2');
  EV.task = null;
  if (EV.event) evTabTasks();
}

async function evAddNote(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('ev-note-input');
  const body = input ? input.value.trim() : '';
  if (!body) return;
  const res = await API.addTaskNote(EV.task.id, body);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not post the note.', 'triangle-alert'); return; }
  await evReloadTask();
}

async function evAddChecklistItem() {
  const label = prompt('Checklist item');
  if (!label || !label.trim()) return;
  const res = await API.addChecklistItem(EV.task.id, label.trim());
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not add the item.', 'triangle-alert'); return; }
  await evReloadTask();
}
async function evToggleChecklist(id, isDone) {
  await API.setChecklistItem(id, isDone);
  await evReloadTask();
}
async function evDeleteChecklistItem(id) {
  await API.deleteChecklistItem(id);
  await evReloadTask();
}
async function evRemoveAssignee(userId) {
  const res = await API.removeTaskAssignee(EV.task.id, userId);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not remove.', 'triangle-alert'); return; }
  await evReloadTask();
}

// An external contact is keyed by its event_people row, not a user id.
async function evRemoveAssigneePerson(personId) {
  const res = await API.removeTaskPerson(EV.task.id, personId);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not remove.', 'triangle-alert'); return; }
  await evReloadTask();
}

/* ─── Create / edit a task ─── */

function evTaskForm(t) {
  const isEdit = !!t;
  return '<form onsubmit="evSubmitTask(event, ' + (isEdit ? t.id : 'null') + ')" class="ev-form">' +
    '<div class="ev-field"><label class="ev-label" for="ev-t-title">Task title <span class="req">*</span></label>' +
      '<input type="text" id="ev-t-title" class="form-input" required maxlength="200" ' +
      'value="' + (isEdit ? escapeHtml(t.title) : '') + '" placeholder="Confirm venue booking" />' +
      '<span class="ev-help">What needs to be done, in a few words.</span></div>' +

    '<div class="ev-field"><label class="ev-label" for="ev-t-desc">Details</label>' +
      '<textarea id="ev-t-desc" class="form-input" rows="3" maxlength="1000" ' +
      'placeholder="Anything the person doing this needs to know">' + (isEdit ? escapeHtml(t.description || '') : '') + '</textarea></div>' +

    '<div class="ev-grid2">' +
      '<div class="ev-field"><label class="ev-label" for="ev-t-cat">Category</label>' +
        '<select id="ev-t-cat" class="form-select">' +
        EV_TASK_CATEGORIES.map(function (c) {
          return '<option value="' + c + '"' + (isEdit && t.category === c ? ' selected' : '') + '>' + c + '</option>';
        }).join('') + '</select></div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-t-prio">Priority</label>' +
        '<select id="ev-t-prio" class="form-select">' +
        EV_PRIORITIES.map(function (p) {
          const sel = isEdit ? t.priority === p : p === 'medium';
          return '<option value="' + p + '"' + (sel ? ' selected' : '') + '>' +
                 p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
        }).join('') + '</select></div>' +
    '</div>' +

    '<div class="ev-field"><label class="ev-label" for="ev-t-due">Deadline</label>' +
      '<input type="date" id="ev-t-due" class="form-input" value="' + (isEdit ? evDateInput(t.due_on) : '') + '" />' +
      '<span class="ev-help">Optional. Overdue tasks are flagged automatically.</span></div>' +

    '<div class="ev-modal-footer">' +
      '<button type="button" class="btn btn-outline" onclick="' + (isEdit ? 'evRenderTaskModal()' : 'closeModal()') + '">' +
        (isEdit ? 'Back' : 'Cancel') + '</button>' +
      '<button type="submit" class="btn btn-primary">' + (isEdit ? 'Save changes' : 'Create task') + '</button>' +
    '</div></form>';
}

function evNewTask() {
  showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('plus') + ' New task</h2>' +
    '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    evTaskForm(null));
  evRefreshIcons();
}

function evEditTask() {
  showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('pencil') + ' Edit task</h2>' +
    '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    evTaskForm(EV.task));
  evRefreshIcons();
}

async function evSubmitTask(e, taskId) {
  if (e) e.preventDefault();
  const payload = {
    title: document.getElementById('ev-t-title').value.trim(),
    description: document.getElementById('ev-t-desc').value.trim(),
    category: document.getElementById('ev-t-cat').value,
    priority: document.getElementById('ev-t-prio').value,
    dueOn: document.getElementById('ev-t-due').value || null
  };
  if (!payload.title) { showToast('A task title is required.', 'triangle-alert'); return; }

  const res = taskId ? await API.updateTask(taskId, payload) : await API.createTask(EV.event.id, payload);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not save the task.', 'triangle-alert'); return; }

  if (taskId) { EV.task = res; showToast('Task updated.', 'circle-check-big'); await evReloadTask(); }
  else { closeModal(); showToast('Task created.', 'circle-check-big'); await evTabTasks(); }
}

/* ══════════════════════════════════════════════════════════
   DIRECTORY PICKER  (desktop popover / mobile full-screen sheet)
   ══════════════════════════════════════════════════════════ */

function evOpenPicker(mode) {
  EV.picker = { mode: mode, selected: [], results: [], query: '', timer: null,
                role: 'member', source: 'directory', external: [] };
  evRenderPicker();
  evPickerSearch('');
  // Assigning a task can also draw on the external contacts already on this
  // event, so they are fetched alongside the directory search.
  if (mode === 'task' && EV.event) {
    API.getEventPeople(EV.event.id).then(function (rows) {
      if (!apiFailed(rows) && EV.picker) {
        EV.picker.external = rows.filter(function (r) { return r.person_type === 'external'; });
        if (EV.picker.source === 'external') evRenderPickerResults();
        evRenderPickerTabs();
      }
    });
  }
}

function evSetPickerSource(src) {
  if (!EV.picker) return;
  EV.picker.source = src;
  evRenderPickerTabs();
  evRenderPickerResults();
}

function evRenderPickerTabs() {
  const p = EV.picker;
  const box = document.getElementById('ev-picker-tabs');
  if (!p || !box) return;
  if (p.mode !== 'task') { box.innerHTML = ''; return; }
  const n = (p.external || []).length;
  box.innerHTML =
    '<div class="ev-filters" role="tablist" aria-label="Where the person comes from">' +
      '<button type="button" class="ev-chip ' + (p.source === 'directory' ? 'active' : '') + '" role="tab" ' +
        'aria-selected="' + (p.source === 'directory') + '" onclick="evSetPickerSource(\'directory\')">' +
        evIcon('graduation-cap') + ' DIC directory</button>' +
      '<button type="button" class="ev-chip ' + (p.source === 'external' ? 'active' : '') + '" role="tab" ' +
        'aria-selected="' + (p.source === 'external') + '" onclick="evSetPickerSource(\'external\')">' +
        evIcon('user-round') + ' External contacts<span class="ev-chip-count">' + n + '</span></button>' +
    '</div>';
  const search = document.getElementById('ev-picker-searchbox');
  if (search) search.classList.toggle('hidden', p.source === 'external');
  evRefreshIcons();
}

function evRenderPicker() {
  const p = EV.picker;
  if (!p) return;
  const isPeople = p.mode === 'people';

  showModal(
    '<div class="modal-header">' +
      '<h2 class="modal-title">' + evIcon('user-plus') + ' ' +
        (isPeople ? 'Add people to this event' : 'Assign people to this task') + '</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button>' +
    '</div>' +
    '<div class="ev-picker">' +
      (isPeople
        ? '<div class="ev-field"><label class="ev-label" for="ev-pk-role">Role on this event</label>' +
          '<select id="ev-pk-role" class="form-select" onchange="EV.picker.role=this.value">' +
          EV_PEOPLE_ROLES.map(function (r) {
            return '<option value="' + r.key + '"' + (p.role === r.key ? ' selected' : '') + '>' + r.label + '</option>';
          }).join('') + '</select></div>'
        : '') +

      '<div id="ev-picker-tabs"></div>' +

      '<div class="ev-field" id="ev-picker-searchbox">' +
        '<label class="ev-label" for="ev-pk-q">Search the directory</label>' +
        '<div class="ev-search boxed">' + evIcon('search', 'ev-search-icon') +
          '<input type="search" id="ev-pk-q" class="ev-search-input" autocomplete="off" ' +
          'placeholder="Name, ID, phone, department or section" ' +
          'oninput="evPickerSearch(this.value)" />' +
        '</div>' +
        '<span class="ev-help">Search by name, alumni/student ID, phone number, department or section.</span>' +
      '</div>' +

      '<div class="ev-picker-selected" id="ev-picker-selected"></div>' +
      '<div class="ev-picker-results" id="ev-picker-results" role="listbox" aria-label="Search results"></div>' +

      '<div class="ev-modal-footer sticky">' +
        '<button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="ev-picker-confirm" onclick="evPickerConfirm()" disabled>' +
          'Add people</button>' +
      '</div>' +
    '</div>');
  evRefreshIcons();
  evRenderPickerTabs();
  evRenderPickerSelected();
}

function evPickerSearch(q) {
  const p = EV.picker;
  if (!p) return;
  p.query = q;
  clearTimeout(p.timer);
  p.timer = setTimeout(async function () {
    const box = document.getElementById('ev-picker-results');
    if (box) box.innerHTML = '<p class="ev-muted">Searching…</p>';
    const res = await API.searchDirectory({ q: q, limit: 25 });
    if (apiFailed(res)) {
      if (box) box.innerHTML = '<p class="ev-muted">' + escapeHtml(res && res.error ? res.error : 'Search failed.') + '</p>';
      return;
    }
    p.results = res.results || [];
    evRenderPickerResults();
  }, 220);
}

function evRenderPickerResults() {
  const p = EV.picker;
  const box = document.getElementById('ev-picker-results');
  if (!p || !box) return;

  // External contacts are attached to this event, so the list is local rather
  // than a search; DIC people come from the directory query.
  const externalMode = p.mode === 'task' && p.source === 'external';
  const rows = externalMode ? (p.external || []) : p.results;

  const already = p.mode === 'task' && EV.task
    ? (EV.task.assignees || []).map(function (a) {
        return a.person_type === 'external' ? 'x' + a.event_person_id : 'u' + a.user_id; })
    : (EV.people || []).map(function (x) { return 'u' + x.user_id; });

  if (!rows.length) {
    box.innerHTML = externalMode
      ? '<div class="ev-picker-empty">' + evIcon('user-round') +
        '<p>No external contacts on this event yet.</p>' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="evOpenExternalForm()">' +
        evIcon('plus') + ' Add external person</button></div>'
      : '<p class="ev-muted">No matching people.</p>';
    evRefreshIcons();
    return;
  }

  box.innerHTML = rows.map(function (r) {
    const key = externalMode ? 'x' + r.id : 'u' + r.id;
    const isSel = p.selected.some(function (s) { return s.key === key; });
    const isOn = already.indexOf(key) !== -1;
    const meta = externalMode
      ? [r.role_title || r.role_label, r.organization].filter(Boolean).map(escapeHtml).join(' · ')
      : evPersonMeta(r);
    return '<button type="button" role="option" aria-selected="' + isSel + '" ' +
      'class="ev-picker-row ' + (isSel ? 'selected' : '') + (isOn ? ' disabled' : '') + '" ' +
      (isOn ? 'disabled ' : '') + 'onclick="evPickerToggle(\'' + key + '\')">' +
      evAvatar(r, 40) +
      '<span class="ev-picker-text">' +
        '<span class="ev-person-name"><strong>' + escapeHtml(r.name) + '</strong>' +
          evPersonBadge(externalMode ? 'external' : 'directory') + '</span>' +
        '<span>' + (meta || '—') + '</span>' +
        '<span class="ev-picker-contact">' +
          (r.phone ? '<span>' + evIcon('phone') + escapeHtml(r.phone) + '</span>' : '') +
          (r.whatsapp ? '<span>' + evIcon('message-circle') + escapeHtml(r.whatsapp) + '</span>' : '') +
        '</span>' +
      '</span>' +
      '<span class="ev-picker-mark">' +
        (isOn ? evIcon('check') + ' Added' : (isSel ? evIcon('circle-check-big') : evIcon('circle-plus'))) +
      '</span></button>';
  }).join('') +
    (externalMode
      ? '<button type="button" class="ev-picker-addnew" onclick="evOpenExternalForm()">' +
        evIcon('plus') + ' Add another external person</button>'
      : '');
  evRefreshIcons();
}

function evPickerToggle(key) {
  const p = EV.picker;
  if (!p) return;
  const idx = p.selected.findIndex(function (s) { return s.key === key; });
  if (idx >= 0) {
    p.selected.splice(idx, 1);
  } else {
    const isExternal = String(key).charAt(0) === 'x';
    const id = parseInt(String(key).slice(1), 10);
    const src = isExternal ? (p.external || []) : p.results;
    const r = src.find(function (x) { return x.id === id; });
    if (r) p.selected.push({ key: key, id: id, name: r.name, initials: r.initials,
                             photo_url: r.photo_url, external: isExternal });
  }
  evRenderPickerResults();
  evRenderPickerSelected();
}

function evRenderPickerSelected() {
  const p = EV.picker;
  const box = document.getElementById('ev-picker-selected');
  const btn = document.getElementById('ev-picker-confirm');
  if (!p || !box) return;

  if (!p.selected.length) {
    box.innerHTML = '<p class="ev-muted small">Nobody selected yet.</p>';
  } else {
    const externals = p.selected.filter(function (s) { return s.external; }).length;
    box.innerHTML = '<div class="ev-chips">' + p.selected.map(function (s) {
      return '<span class="ev-selchip ' + (s.external ? 'external' : '') + '">' +
        evAvatar(s, 22) + escapeHtml(s.name) +
        '<button type="button" onclick="evPickerToggle(\'' + s.key + '\')" ' +
        'aria-label="Remove ' + escapeHtml(s.name) + '">' + evIcon('x') + '</button></span>';
    }).join('') + '</div>' +
    (externals
      ? '<p class="ev-muted small">' + evIcon('info') + ' ' + externals +
        ' external contact' + (externals === 1 ? '' : 's') +
        ' selected — they have no in-app account and will not be notified.</p>'
      : '');
  }
  if (btn) {
    btn.disabled = p.selected.length === 0;
    btn.textContent = p.selected.length
      ? 'Add ' + p.selected.length + ' ' + (p.selected.length === 1 ? 'person' : 'people')
      : 'Add people';
  }
  evRefreshIcons();
}

async function evPickerConfirm() {
  const p = EV.picker;
  if (!p || !p.selected.length) return;

  if (p.mode === 'task') {
    const userIds = p.selected.filter(function (s) { return !s.external; }).map(function (s) { return s.id; });
    const eventPersonIds = p.selected.filter(function (s) { return s.external; }).map(function (s) { return s.id; });
    const res = await API.addTaskAssignees(EV.task.id, { userIds: userIds, eventPersonIds: eventPersonIds });
    if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not assign.', 'triangle-alert'); return; }
    showToast(res.added + ' assigned' +
      (res.notified ? ' · ' + res.notified + ' notified' : '') +
      (res.externalAdded ? ' · ' + res.externalAdded + ' external (no notification)' : '') + '.',
      'user-plus');
    EV.picker = null;
    await evReloadTask();
  } else {
    const ids = p.selected.filter(function (s) { return !s.external; }).map(function (s) { return s.id; });
    const res = await API.addEventPeople(EV.event.id, { userIds: ids, roleInEvent: p.role });
    if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not add people.', 'triangle-alert'); return; }
    closeModal();
    showToast(res.added + ' person' + (res.added === 1 ? '' : 's') + ' added to the team.', 'users');
    EV.picker = null;
    await evTabPeople();
  }
}

/* ══════════════════════════════════════════════════════════
   TAB — TICKETS & ATTENDEES
   ══════════════════════════════════════════════════════════ */

async function evTabTickets() {
  const el = document.getElementById('ev-tab-content');
  if (!el || !EV.event) return;
  el.innerHTML = renderSkeletonCards(2, 'planner');

  const results = await Promise.all([
    API.getTicketTypes(EV.event.id),
    API.getAttendees(EV.event.id)
  ]);
  const types = results[0], attendees = results[1];

  if (apiFailed(types) || apiFailed(attendees)) {
    el.innerHTML = renderErrorState('Could not load tickets and attendees.', 'evTabTickets()');
    evRefreshIcons();
    return;
  }
  EV.ticketTypes = types;
  EV.attendees = attendees;
  evRenderTickets();
}

function evRenderTickets() {
  const el = document.getElementById('ev-tab-content');
  const e = EV.event;
  if (!el || !e) return;

  const rows = EV.attendees;
  const confirmed = rows.filter(function (r) { return r.status === 'confirmed'; });
  const waitlisted = rows.filter(function (r) { return r.status === 'waitlisted'; });
  const cancelled = rows.filter(function (r) { return r.status === 'cancelled'; });
  const checkedIn = rows.filter(function (r) { return r.checked_in; });
  const available = Math.max(0, (e.capacity || 0) - confirmed.length);

  el.innerHTML =
    '<div class="ev-stats">' +
      evStat('users', confirmed.length, 'Confirmed', 'info') +
      evStat('hourglass', waitlisted.length, 'Waitlisted', waitlisted.length ? 'warn' : '') +
      evStat('circle-check-big', checkedIn.length, 'Checked in', 'success') +
      evStat('armchair', available, 'Available') +
    '</div>' +

    /* ── Ticket types ── */
    '<section class="ev-panel">' +
      '<div class="ev-panel-head"><h2 class="ev-panel-title">Ticket types</h2>' +
        '<button class="btn btn-outline btn-sm" onclick="evAddTicketType()">' + evIcon('plus') + ' Add type</button></div>' +
      (EV.ticketTypes.length
        ? '<ul class="ev-ticketlist">' + EV.ticketTypes.map(function (t) {
            const quota = t.quota == null ? '∞' : t.quota;
            const pct = t.quota ? Math.min(100, Math.round((t.sold / t.quota) * 100)) : 0;
            return '<li class="ev-ticketrow">' +
              '<div class="ev-ticketrow-main">' +
                '<strong>' + escapeHtml(t.name) + '</strong>' +
                '<span class="ev-ticketrow-price">' + (Number(t.price) > 0 ? evMoney(t.price) : 'Free') + '</span>' +
              '</div>' +
              '<div class="ev-ticketrow-quota">' +
                '<div class="ev-capacity-track"><div class="ev-capacity-fill" style="width:' + pct + '%"></div></div>' +
                '<span>' + t.sold + ' of ' + quota + ' issued</span>' +
              '</div>' +
              '<button type="button" class="ev-icon-btn" onclick="evEditTicketType(' + t.id + ')" ' +
                'aria-label="Edit ticket type ' + escapeHtml(t.name) + '">' + evIcon('pencil') + '</button>' +
              '<button type="button" class="ev-icon-btn danger" onclick="evDeleteTicketType(' + t.id + ')" ' +
                'aria-label="Remove ticket type ' + escapeHtml(t.name) + '">' + evIcon('trash-2') + '</button>' +
            '</li>'; }).join('') + '</ul>'
        : '<p class="ev-muted">No ticket types yet.</p>') +
    '</section>' +

    /* ── Check-in ── */
    '<section class="ev-panel">' +
      '<h2 class="ev-panel-title">Check-in</h2>' +
      '<p class="ev-help">Scan a ticket QR into the box, or type the code printed on it.</p>' +
      '<form class="ev-checkin" onsubmit="evCheckIn(event)">' +
        '<label class="sr-only" for="ev-checkin-code">Ticket code</label>' +
        '<input type="text" id="ev-checkin-code" class="form-input" autocomplete="off" ' +
          'placeholder="DIC-TKT-XXXXX-XXXXXX" required />' +
        '<button type="submit" class="btn btn-primary">' + evIcon('scan-line') + ' Check in</button>' +
      '</form>' +
      '<div id="ev-checkin-result" aria-live="polite"></div>' +
    '</section>' +

    /* ── Registrations & waitlist ── */
    '<section class="ev-panel">' +
      '<div class="ev-panel-head"><h2 class="ev-panel-title">Registrations</h2>' +
        '<a class="btn btn-outline btn-sm" href="' + API.attendeesCsvUrl(e.id) + '" download>' +
          evIcon('download') + ' Export CSV</a></div>' +
      (rows.length
        ? (waitlisted.length
            ? '<h3 class="ev-subhead">' + evIcon('hourglass') + ' Waitlist (' + waitlisted.length + ')' +
              '<span class="ev-help inline">Promoted automatically when a confirmed ticket is cancelled.</span></h3>' +
              '<ul class="ev-people">' + waitlisted.map(evAttendeeRow).join('') + '</ul>'
            : '') +
          '<h3 class="ev-subhead">' + evIcon('users') + ' Confirmed (' + confirmed.length + ')</h3>' +
          (confirmed.length ? '<ul class="ev-people">' + confirmed.map(evAttendeeRow).join('') + '</ul>'
                            : '<p class="ev-muted">Nobody has registered yet.</p>') +
          (cancelled.length
            ? '<h3 class="ev-subhead">' + evIcon('circle-x') + ' Cancelled (' + cancelled.length + ')</h3>' +
              '<ul class="ev-people">' + cancelled.map(evAttendeeRow).join('') + '</ul>'
            : '')
        : renderEmptyState(evIcon('ticket'), 'No registrations yet',
            'Tickets appear here as alumni register.')) +
    '</section>';
  evRefreshIcons();
}

function evAttendeeRow(a) {
  return '<li class="ev-person">' + evAvatar(a, 38) +
    '<div class="ev-person-text"><strong>' + escapeHtml(a.name) + '</strong>' +
      '<span>' + evPersonMeta(a) + '</span>' +
      '<span class="ev-mono">' + escapeHtml(a.ticket_code) +
        (a.ticket_type_name ? ' · ' + escapeHtml(a.ticket_type_name) : '') +
        (Number(a.amount_paid) > 0 ? ' · ' + evMoney(a.amount_paid) : '') + '</span>' +
    '</div>' +
    '<div class="ev-person-actions">' +
      (a.checked_in
        ? '<span class="ev-pill success">' + evIcon('circle-check-big') + ' Checked in</span>'
        : a.status === 'waitlisted'
          ? '<span class="ev-pill warn">' + evIcon('hourglass') + ' Waitlist</span>'
          : a.status === 'cancelled'
            ? '<span class="ev-pill muted">' + evIcon('circle-x') + ' Cancelled</span>'
            : '<span class="ev-pill">' + evIcon('ticket') + ' Confirmed</span>') +
      evContactButtons(a, true) +
    '</div></li>';
}

async function evCheckIn(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('ev-checkin-code');
  const box = document.getElementById('ev-checkin-result');
  const code = input ? input.value.trim() : '';
  if (!code) return;

  const res = await API.checkInTicket(code);
  if (apiFailed(res)) {
    box.innerHTML = '<p class="ev-banner danger">' + evIcon('circle-x') + ' ' +
      escapeHtml(res && res.error ? res.error : 'Check-in failed') + '</p>';
    evRefreshIcons();
    return;
  }
  box.innerHTML = '<p class="ev-banner success">' + evIcon('circle-check-big') + ' ' +
    escapeHtml(res.attendee) + ' checked in' + (res.batch ? ' · Batch ' + escapeHtml(String(res.batch)) : '') + '</p>';
  input.value = '';
  input.focus();
  const rows = await API.getAttendees(EV.event.id);
  if (!apiFailed(rows)) EV.attendees = rows;
  evRefreshIcons();
}

function evAddTicketType() {
  showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('ticket') + ' Add ticket type</h2>' +
    '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    '<form class="ev-form" onsubmit="evSubmitTicketType(event, null)">' +
      '<div class="ev-field"><label class="ev-label" for="ev-tt-name">Name <span class="req">*</span></label>' +
        '<input type="text" id="ev-tt-name" class="form-input" required placeholder="Alumni" /></div>' +
      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-tt-price">Price (৳)</label>' +
          '<input type="number" id="ev-tt-price" class="form-input" min="0" step="1" value="0" />' +
          '<span class="ev-help">Use 0 for a free ticket.</span></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-tt-quota">Quota</label>' +
          '<input type="number" id="ev-tt-quota" class="form-input" min="0" step="1" placeholder="Unlimited" />' +
          '<span class="ev-help">Leave blank for no per-type limit.</span></div>' +
      '</div>' +
      '<div class="ev-modal-footer">' +
        '<button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Add ticket type</button></div>' +
    '</form>');
  evRefreshIcons();
}

function evEditTicketType(id) {
  const t = EV.ticketTypes.find(function (x) { return x.id === id; });
  if (!t) return;
  showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('pencil') + ' Edit ticket type</h2>' +
    '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    '<form class="ev-form" onsubmit="evSubmitTicketType(event, ' + id + ')">' +
      '<div class="ev-field"><label class="ev-label" for="ev-tt-name">Name <span class="req">*</span></label>' +
        '<input type="text" id="ev-tt-name" class="form-input" required value="' + escapeHtml(t.name) + '" /></div>' +
      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-tt-price">Price (৳)</label>' +
          '<input type="number" id="ev-tt-price" class="form-input" min="0" value="' + Number(t.price) + '" /></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-tt-quota">Quota</label>' +
          '<input type="number" id="ev-tt-quota" class="form-input" min="' + t.sold + '" ' +
          'value="' + (t.quota == null ? '' : t.quota) + '" placeholder="Unlimited" />' +
          '<span class="ev-help">' + t.sold + ' already issued.</span></div>' +
      '</div>' +
      '<div class="ev-modal-footer">' +
        '<button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Save changes</button></div>' +
    '</form>');
  evRefreshIcons();
}

async function evSubmitTicketType(e, id) {
  if (e) e.preventDefault();
  const quotaRaw = document.getElementById('ev-tt-quota').value;
  const payload = {
    name: document.getElementById('ev-tt-name').value.trim(),
    price: Number(document.getElementById('ev-tt-price').value) || 0,
    quota: quotaRaw === '' ? null : Number(quotaRaw)
  };
  const res = id ? await API.updateTicketType(id, payload) : await API.addTicketType(EV.event.id, payload);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not save.', 'triangle-alert'); return; }
  closeModal();
  showToast('Ticket type saved.', 'circle-check-big');
  await evTabTickets();
}

async function evDeleteTicketType(id) {
  if (!confirm('Remove this ticket type?')) return;
  const res = await API.deleteTicketType(id);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not remove.', 'triangle-alert'); return; }
  showToast('Ticket type removed.', 'trash-2');
  await evTabTickets();
}

/* ══════════════════════════════════════════════════════════
   PEOPLE — DIC members and external contacts, kept visibly apart
   ══════════════════════════════════════════════════════════ */

// Common roles for someone with no DIC account, offered as suggestions.
const EV_EXTERNAL_ROLES = ['Decorator', 'Caterer', 'Photographer', 'Sound Engineer',
                           'Security', 'Venue staff', 'External volunteer',
                           'Vendor representative', 'Transport', 'Other'];

function evPersonBadge(type) {
  return type === 'external'
    ? '<span class="ev-typebadge external">' + evIcon('user-round') + 'External</span>'
    : '<span class="ev-typebadge dic">' + evIcon('graduation-cap') + 'DIC member</span>';
}

async function evTabPeople() {
  const el = document.getElementById('ev-tab-content');
  if (!el || !EV.event) return;
  el.innerHTML = renderSkeletonCards(2, 'planner');

  const people = await API.getEventPeople(EV.event.id);
  if (apiFailed(people)) {
    el.innerHTML = renderErrorState(people && people.error ? people.error : 'Could not load people.', 'evTabPeople()');
    evRefreshIcons();
    return;
  }
  EV.people = people;

  const dic = people.filter(function (p) { return p.person_type !== 'external'; });
  const ext = people.filter(function (p) { return p.person_type === 'external'; });

  const dicGroups = EV_PEOPLE_ROLES.map(function (r) {
    return { role: r, members: dic.filter(function (p) { return p.role_in_event === r.key; }) };
  }).filter(function (g) { return g.members.length; });

  el.innerHTML =
    '<section class="ev-panel">' +
      '<div class="ev-panel-head">' +
        '<h2 class="ev-panel-title">Event team</h2>' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="evOpenAddPeople()">' +
          evIcon('user-plus') + ' Add people</button>' +
      '</div>' +

      (people.length
        ? '<div class="ev-stats compact">' +
            evStat('graduation-cap', dic.length, 'DIC members', 'info') +
            evStat('user-round', ext.length, 'External contacts') +
          '</div>'
        : '') +

      /* ── DIC members ── */
      '<h3 class="ev-subhead">' + evIcon('graduation-cap') + ' DIC members' +
        (dic.length ? ' (' + dic.length + ')' : '') + '</h3>' +
      (dic.length
        ? dicGroups.map(function (g) {
            return '<p class="ev-grouplabel">' + escapeHtml(g.role.label) + '</p>' +
              '<ul class="ev-people">' + g.members.map(evPersonRow).join('') + '</ul>';
          }).join('')
        : '<p class="ev-muted">No DIC members on this event yet.</p>') +

      /* ── External contacts ── */
      '<h3 class="ev-subhead">' + evIcon('user-round') + ' External contacts' +
        (ext.length ? ' (' + ext.length + ')' : '') +
        '<span class="ev-help inline">People with no DIC account — decorators, caterers, vendors.</span></h3>' +
      (ext.length
        ? '<ul class="ev-people">' + ext.map(evPersonRow).join('') + '</ul>'
        : '<p class="ev-muted">No external contacts yet.</p>') +
    '</section>';
  evRefreshIcons();
}

function evPersonRow(p) {
  const isExternal = p.person_type === 'external';
  const meta = isExternal
    ? [p.organization, p.dept].filter(Boolean).map(escapeHtml).join(' · ')
    : evPersonMeta(p);

  return '<li class="ev-person">' + evAvatar(p, 42) +
    '<div class="ev-person-text">' +
      '<div class="ev-person-name"><strong>' + escapeHtml(p.name) + '</strong>' + evPersonBadge(p.person_type) + '</div>' +
      (p.role_label ? '<span class="ev-person-role">' + escapeHtml(p.role_label) + '</span>' : '') +
      (meta ? '<span>' + meta + '</span>' : '') +
      (p.committee ? '<span class="ev-tag">' + escapeHtml(p.committee) + '</span>' : '') +
      (isExternal
        ? '<span class="ev-muted small">' + evIcon('info') + ' External contact · No in-app account</span>'
        : (p.task_count ? '<span class="ev-muted small">' + p.task_count +
            ' task' + (p.task_count === 1 ? '' : 's') + ' on this event</span>' : '')) +
      (isExternal && p.notes ? '<span class="ev-muted small">' + escapeHtml(p.notes) + '</span>' : '') +
    '</div>' +
    '<div class="ev-person-actions">' + evContactButtons(p, true) +
      (isExternal
        ? '<button type="button" class="ev-contact-btn sm" onclick="evEditExternalPerson(' + p.id + ')" ' +
          'aria-label="Edit ' + escapeHtml(p.name) + '">' + evIcon('pencil') + '<span>Edit</span></button>'
        : '') +
      '<button type="button" class="ev-contact-btn sm danger" onclick="evRemovePerson(' + p.id + ')" ' +
        'aria-label="Remove ' + escapeHtml(p.name) + ' from the team">' +
        evIcon('user-minus') + '<span>Remove</span></button>' +
    '</div></li>';
}

async function evRemovePerson(personId) {
  if (!confirm('Remove this person from the event team?')) return;
  const res = await API.removeEventPerson(personId);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not remove.', 'triangle-alert'); return; }
  showToast('Removed from the team.', 'user-minus');
  await evTabPeople();
}

/* ── Choose a source before searching, so the two flows never mix ── */
function evOpenAddPeople(mode) {
  showModal(
    '<div class="modal-header">' +
      '<h2 class="modal-title">' + evIcon('user-plus') + ' Add people</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button>' +
    '</div>' +
    '<p class="ev-help">Choose where this person comes from.</p>' +
    '<div class="ev-sourcechoice">' +
      '<button type="button" class="ev-source" onclick="evOpenPicker(\'people\')">' +
        '<span class="ev-source-icon">' + evIcon('graduation-cap') + '</span>' +
        '<span class="ev-source-text"><strong>Search DIC directory</strong>' +
        '<span>Alumni, staff and students with a DIC account. They can be ' +
        'assigned tasks and receive in-app notifications.</span></span>' +
        evIcon('chevron-right', 'ev-source-chevron') + '</button>' +
      '<button type="button" class="ev-source" onclick="evOpenExternalForm()">' +
        '<span class="ev-source-icon">' + evIcon('user-round') + '</span>' +
        '<span class="ev-source-text"><strong>Add external person</strong>' +
        '<span>A decorator, caterer, photographer or vendor with no DIC ' +
        'account. Contactable by phone and WhatsApp only.</span></span>' +
        evIcon('chevron-right', 'ev-source-chevron') + '</button>' +
    '</div>');
  evRefreshIcons();
}

/* ── External person form ── */
function evOpenExternalForm(person) {
  const p = person || {};
  const isEdit = !!person;
  showModal(
    '<div class="modal-header">' +
      '<h2 class="modal-title">' + evIcon(isEdit ? 'pencil' : 'user-round') + ' ' +
        (isEdit ? 'Edit external contact' : 'Add external person') + '</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button>' +
    '</div>' +
    '<p class="ev-callout-plain">' + evIcon('info') +
      ' This person is recorded on this event only. No DIC account is created and they ' +
      'do not appear in the alumni directory.</p>' +
    '<form class="ev-form" onsubmit="evSubmitExternalPerson(event, ' + (isEdit ? p.id : 'null') + ')">' +
      '<div class="ev-field">' +
        '<label class="ev-label" for="ev-x-name">Full name <span class="req">*</span></label>' +
        '<input type="text" id="ev-x-name" class="form-input" required maxlength="150" ' +
          'value="' + escapeHtml(p.name || '') + '" placeholder="Rahim Decorators" /></div>' +

      '<div class="ev-field">' +
        '<label class="ev-label" for="ev-x-role">Role on event <span class="req">*</span></label>' +
        '<input type="text" id="ev-x-role" class="form-input" required maxlength="120" list="ev-x-roles" ' +
          'value="' + escapeHtml(p.role_title || '') + '" placeholder="Event Decorator" />' +
        '<datalist id="ev-x-roles">' +
          EV_EXTERNAL_ROLES.map(function (r) { return '<option value="' + r + '"></option>'; }).join('') +
        '</datalist>' +
        '<span class="ev-help">What they are doing for this event.</span></div>' +

      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-x-phone">Phone</label>' +
          '<input type="tel" id="ev-x-phone" class="form-input" maxlength="50" ' +
            'value="' + escapeHtml(p.phone || '') + '" placeholder="01711 223344" />' +
          '<span class="ev-help">Adds a Call button.</span></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-x-wa">WhatsApp</label>' +
          '<input type="tel" id="ev-x-wa" class="form-input" maxlength="50" ' +
            'value="' + escapeHtml(p.whatsapp || '') + '" placeholder="01711 223344" />' +
          '<span class="ev-help">Adds a WhatsApp button.</span></div>' +
      '</div>' +

      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-x-org">Organization / company</label>' +
          '<input type="text" id="ev-x-org" class="form-input" maxlength="150" ' +
            'value="' + escapeHtml(p.organization || '') + '" placeholder="Rahim Decor Ltd" /></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-x-area">Department / area</label>' +
          '<input type="text" id="ev-x-area" class="form-input" maxlength="150" ' +
            'value="' + escapeHtml(p.department_area || '') + '" placeholder="Stage &amp; decor" /></div>' +
      '</div>' +

      '<div class="ev-field"><label class="ev-label" for="ev-x-notes">Notes</label>' +
        '<textarea id="ev-x-notes" class="form-input" rows="2" maxlength="500" ' +
          'placeholder="Anything the team should know">' + escapeHtml(p.notes || '') + '</textarea></div>' +

      '<p class="ev-inline-error hidden" id="ev-x-error" role="alert"></p>' +
      '<div class="ev-modal-footer">' +
        '<button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">' +
          (isEdit ? 'Save changes' : 'Add to event') + '</button>' +
      '</div>' +
    '</form>');
  evRefreshIcons();
}

function evEditExternalPerson(personId) {
  const p = (EV.people || []).find(function (x) { return x.id === personId; });
  if (!p) return;
  evOpenExternalForm({ id: p.id, name: p.name, role_title: p.role_title || p.role_label,
                       phone: p.phone, whatsapp: p.whatsapp, organization: p.organization,
                       department_area: p.dept, notes: p.notes });
}

async function evSubmitExternalPerson(e, personId) {
  if (e) e.preventDefault();
  const err = document.getElementById('ev-x-error');
  const val = function (id) { return document.getElementById(id).value.trim(); };
  const payload = {
    name: val('ev-x-name'), roleTitle: val('ev-x-role'),
    phone: val('ev-x-phone'), whatsapp: val('ev-x-wa'),
    organization: val('ev-x-org'), departmentArea: val('ev-x-area'),
    notes: val('ev-x-notes')
  };
  const fail = function (msg) {
    if (err) { err.textContent = msg; err.classList.remove('hidden'); }
    else showToast(msg, 'triangle-alert');
  };
  if (!payload.name) return fail('Please enter the person’s full name.');
  if (!payload.roleTitle) return fail('Please say what their role on this event is.');

  const res = personId
    ? await API.updateExternalPerson(personId, payload)
    : await API.addExternalPerson(EV.event.id, payload);

  if (apiFailed(res)) return fail((res && res.error) || 'Could not save this contact.');

  closeModal();
  showToast(personId ? 'External contact updated.' : payload.name + ' added to the team.', 'user-plus');
  await evTabPeople();
}

/* ══════════════════════════════════════════════════════════
   TAB — REPORTS
   ══════════════════════════════════════════════════════════ */

async function evTabReports() {
  const el = document.getElementById('ev-tab-content');
  const e = EV.event;
  if (!el || !e) return;
  el.innerHTML = renderSkeletonCards(2, 'analytics');

  const results = await Promise.all([
    API.getEventOverview(e.id),
    API.getPlannerAnalytics(e.id)
  ]);
  const o = results[0], a = results[1];
  if (apiFailed(o)) {
    el.innerHTML = renderErrorState('Could not load the report.', 'evTabReports()');
    evRefreshIcons();
    return;
  }
  // Refresh the cached event too: counters move while the workspace is open
  // (a check-in on the Tickets tab, a registration elsewhere), and reading the
  // stale copy made Reports contradict what Tickets had just shown.
  EV.overview = o;
  EV.event = o.event;
  const ev = o.event;
  renderEventContextHeader();

  const fill = ev.capacity ? Math.round(((ev.registered || 0) / ev.capacity) * 100) : 0;
  const spend = apiFailed(a) ? null : a.budget.actual;
  const net = spend === null ? null : o.revenue - spend;

  el.innerHTML =
    '<section class="ev-panel">' +
      '<h2 class="ev-panel-title">Attendance</h2>' +
      '<div class="ev-stats">' +
        evStat('users', (ev.registered || 0).toLocaleString(), 'Registered', 'info') +
        evStat('hourglass', (ev.waitlisted || 0).toLocaleString(), 'Waitlisted') +
        evStat('circle-check-big', (ev.checked_in || 0).toLocaleString(), 'Checked in', 'success') +
        evStat('percent', fill + '%', 'Capacity filled') +
      '</div>' +
    '</section>' +

    '<section class="ev-panel">' +
      '<h2 class="ev-panel-title">Tasks</h2>' +
      '<div class="ev-stats">' +
        evStat('clipboard-list', o.tasks.total, 'Total') +
        evStat('circle-check-big', o.tasks.completed, 'Done', 'success') +
        evStat('octagon-alert', o.tasks.blocked, 'Blocked', o.tasks.blocked ? 'danger' : '') +
        evStat('triangle-alert', o.tasks.overdue, 'Overdue', o.tasks.overdue ? 'danger' : '') +
      '</div>' +
      '<div class="ev-capacity"><div class="ev-capacity-track">' +
        '<div class="ev-capacity-fill" style="width:' + o.tasks.completionRate + '%"></div></div>' +
        '<div class="ev-capacity-meta"><span>Completion</span><span>' + o.tasks.completionRate + '%</span></div></div>' +
    '</section>' +

    '<section class="ev-panel">' +
      '<div class="ev-panel-head"><h2 class="ev-panel-title">Money</h2>' +
        '<div class="ev-panel-actions">' +
          '<a class="btn btn-outline btn-sm" href="' + API.attendeesCsvUrl(ev.id) + '" download>' +
            evIcon('download') + ' Attendees CSV</a>' +
          '<a class="btn btn-outline btn-sm" href="' + API.plannerReportUrl(ev.id, 'full') + '" download>' +
            evIcon('file-text') + ' Full report CSV</a>' +
        '</div></div>' +
      '<div class="ev-stats">' +
        evStat('banknote', evMoney(o.revenue), 'Ticket revenue', 'success') +
        (spend !== null ? evStat('receipt', evMoney(spend), 'Recorded spend') : '') +
        (net !== null ? evStat(net >= 0 ? 'trending-up' : 'trending-down', evMoney(net),
                               'Net', net >= 0 ? 'success' : 'danger') : '') +
      '</div>' +
      (spend === null ? '<p class="ev-muted small">Spend is recorded under Advanced → Budget.</p>' : '') +
    '</section>';
  evRefreshIcons();
}

/* ══════════════════════════════════════════════════════════
   TAB — ADVANCED  (budget, vendors, sponsors, marketing, meetings, risks)
   ══════════════════════════════════════════════════════════ */

const EV_ADVANCED = [
  { key: 'budget',    label: 'Budget',    icon: 'circle-dollar-sign' },
  { key: 'vendors',   label: 'Vendors',   icon: 'store' },
  { key: 'sponsors',  label: 'Sponsors',  icon: 'handshake' },
  { key: 'marketing', label: 'Marketing', icon: 'megaphone' },
  { key: 'meetings',  label: 'Meetings',  icon: 'calendar-check' },
  { key: 'risks',     label: 'Risks',     icon: 'shield-alert' }
];

async function evTabAdvanced() {
  const el = document.getElementById('ev-tab-content');
  if (!el || !EV.event) return;
  el.innerHTML = renderSkeletonCards(2, 'planner');

  const data = await API.getPlannerWorkspace(EV.event.id);
  if (apiFailed(data)) {
    el.innerHTML = renderErrorState(data && data.error ? data.error : 'Could not load the advanced modules.', 'evTabAdvanced()');
    evRefreshIcons();
    return;
  }
  EV.advanced = data;
  evRenderAdvanced();
}

function evSetAdvancedTab(k) { EV.advancedTab = k; evRenderAdvanced(); }

function evRenderAdvanced() {
  const el = document.getElementById('ev-tab-content');
  const d = EV.advanced;
  if (!el || !d) return;

  const nav = '<div class="ev-filters" role="tablist" aria-label="Advanced modules">' +
    EV_ADVANCED.map(function (a) {
      const on = EV.advancedTab === a.key;
      return '<button type="button" class="ev-chip ' + (on ? 'active' : '') + '" role="tab" ' +
        'aria-selected="' + on + '" onclick="evSetAdvancedTab(\'' + a.key + '\')">' +
        evIcon(a.icon) + ' ' + a.label + '</button>';
    }).join('') + '</div>';

  el.innerHTML =
    '<section class="ev-panel">' +
      '<h2 class="ev-panel-title">Advanced</h2>' +
      '<p class="ev-help">Optional modules for larger events. A small event does not need any of these.</p>' +
      nav + '<div id="ev-advanced-body"></div>' +
    '</section>';

  const body = document.getElementById('ev-advanced-body');
  const k = EV.advancedTab;

  if (k === 'budget') {
    const b = d.budgets || [], proc = d.procurement || [];
    const est = b.reduce(function (a, r) { return a + Number(r.estimated_cost || 0); }, 0);
    const act = b.reduce(function (a, r) { return a + Number(r.actual_cost || 0); }, 0);
    const procSpend = proc.reduce(function (a, r) { return a + Number(r.actual_price || 0) * (r.quantity || 1); }, 0);
    body.innerHTML =
      '<div class="ev-stats">' +
        evStat('calculator', evMoney(est), 'Estimated') +
        evStat('receipt', evMoney(act), 'Actual spend') +
        evStat(est - act >= 0 ? 'trending-up' : 'trending-down', evMoney(est - act), 'Remaining',
               est - act >= 0 ? 'success' : 'danger') +
        evStat('shopping-cart', evMoney(procSpend), 'Procurement') +
      '</div>' +
      evAdvToolbar('budgets', 'Budget line') +
      evAdvTable(['Category', 'Vendor', 'Estimated', 'Actual', 'Status', ''], b, function (r) {
        return ['<strong>' + escapeHtml(r.category) + '</strong>', escapeHtml(r.vendor_name || '—'),
                evMoney(r.estimated_cost), evMoney(r.actual_cost),
                '<span class="ev-pill ' + (r.payment_status === 'paid' ? 'success' : 'warn') + '">' +
                  escapeHtml(r.payment_status || '—') + '</span>',
                evAdvDelete('budgets', r.id)];
      }, 'No budget lines yet') +
      '<h3 class="ev-subhead">' + evIcon('shopping-cart') + ' Procurement</h3>' +
      evAdvToolbar('procurement', 'Item') +
      evAdvTable(['Item', 'Category', 'Qty', 'Actual', 'Vendor', 'Status', ''], proc, function (r) {
        return ['<strong>' + escapeHtml(r.item_name) + '</strong>', escapeHtml(r.category || '—'),
                String(r.quantity || 1), evMoney(r.actual_price), escapeHtml(r.vendor_name || '—'),
                '<span class="ev-pill">' + escapeHtml(r.delivery_status || '—') + '</span>',
                evAdvDelete('procurement', r.id)];
      }, 'No procurement items yet');

  } else if (k === 'vendors') {
    const v = d.vendors || [];
    body.innerHTML = evAdvToolbar('vendors', 'Vendor') +
      evAdvTable(['Vendor', 'Category', 'Contact', 'Contract', 'Status', ''], v, function (r) {
        return ['<strong>' + escapeHtml(r.name) + '</strong>', escapeHtml(r.category || '—'),
                escapeHtml(r.contact_person || '—') + (r.phone ? '<br><span class="ev-muted small">' +
                  escapeHtml(r.phone) + '</span>' : ''),
                evMoney(r.contract_value),
                '<span class="ev-pill ' + (r.status === 'paid' ? 'success' : 'warn') + '">' +
                  escapeHtml(r.status || '—') + '</span>',
                evAdvDelete('vendors', r.id)];
      }, 'No vendors yet');

  } else if (k === 'sponsors') {
    const s = d.sponsors || [];
    const secured = s.filter(function (r) { return ['agreed', 'received'].indexOf(r.pipeline_status) !== -1; })
                     .reduce(function (a, r) { return a + Number(r.contribution_amount || 0); }, 0);
    body.innerHTML = '<div class="ev-stats">' +
        evStat('handshake', s.length, 'Sponsors') +
        evStat('banknote', evMoney(secured), 'Secured', 'success') + '</div>' +
      evAdvToolbar('sponsors', 'Sponsor') +
      evAdvTable(['Company', 'Contact', 'Tier', 'Amount', 'Status', ''], s, function (r) {
        return ['<strong>' + escapeHtml(r.company) + '</strong>', escapeHtml(r.contact_person || '—'),
                escapeHtml(r.package_tier || '—'), evMoney(r.contribution_amount),
                '<span class="ev-pill">' + escapeHtml(r.pipeline_status || '—') + '</span>',
                evAdvDelete('sponsors', r.id)];
      }, 'No sponsors yet');

  } else if (k === 'marketing') {
    const m = d.marketing || [];
    body.innerHTML = evAdvToolbar('marketing', 'Campaign') +
      evAdvTable(['Channel', 'Campaign', 'Budget', 'Reach', 'Conversions', 'Status', ''], m, function (r) {
        return [escapeHtml(r.channel), '<strong>' + escapeHtml(r.campaign_name) + '</strong>',
                evMoney(r.budget), Number(r.reach || 0).toLocaleString(),
                Number(r.conversions || 0).toLocaleString(),
                '<span class="ev-pill">' + escapeHtml(r.status || '—') + '</span>',
                evAdvDelete('marketing', r.id)];
      }, 'No campaigns yet');

  } else if (k === 'meetings') {
    const mt = d.meetings || [];
    body.innerHTML = evAdvToolbar('meetings', 'Meeting') +
      evAdvTable(['Meeting', 'Date', 'Location', 'Attendees', 'Status', ''], mt, function (r) {
        return ['<strong>' + escapeHtml(r.title) + '</strong>', escapeHtml(evDate(r.meeting_date)),
                escapeHtml(r.location || '—'), escapeHtml(r.attendees || '—'),
                '<span class="ev-pill">' + escapeHtml(r.status || '—') + '</span>',
                evAdvDelete('meetings', r.id)];
      }, 'No meetings scheduled');

  } else if (k === 'risks') {
    const r = d.risks || [];
    body.innerHTML = evAdvToolbar('risks', 'Risk') +
      evAdvTable(['Risk', 'Category', 'Severity', 'Contingency', ''], r, function (x) {
        return ['<strong>' + escapeHtml(x.risk_title) + '</strong>', escapeHtml(x.category || '—'),
                '<span class="ev-pill ' + (x.severity === 'high' ? 'danger' : 'warn') + '">' +
                  escapeHtml(x.severity) + '</span>',
                escapeHtml(x.contingency_plan || '—'), evAdvDelete('risks', x.id)];
      }, 'No risks recorded');
  }
  evRefreshIcons();
}

function evAdvToolbar(kind, label) {
  return '<div class="ev-panel-actions right"><button class="btn btn-outline btn-sm" ' +
    'onclick="showPlannerItemModal(\'' + kind + '\')">' + evIcon('plus') + ' Add ' + label + '</button></div>';
}
function evAdvDelete(kind, id) {
  return '<button type="button" class="ev-icon-btn danger" onclick="deletePlannerItem(\'' + kind + '\', ' + id + ')" ' +
    'aria-label="Delete">' + evIcon('trash-2') + '</button>';
}
function evAdvTable(cols, rows, rowFn, emptyText) {
  if (!rows.length) return '<p class="ev-muted">' + escapeHtml(emptyText) + '</p>';
  return '<div class="ev-table" style="--ev-cols:' + cols.length + '">' +
    '<div class="ev-table-head">' + cols.map(function (c) { return '<div>' + escapeHtml(c) + '</div>'; }).join('') + '</div>' +
    rows.map(function (r) {
      return '<div class="ev-table-row">' + rowFn(r).map(function (cell, i) {
        return '<div data-label="' + escapeHtml(cols[i]) + '">' + cell + '</div>';
      }).join('') + '</div>';
    }).join('') + '</div>';
}

/* ══════════════════════════════════════════════════════════
   CREATION WIZARD — Basics → Tickets → Review
   ══════════════════════════════════════════════════════════ */

function openEventWizard() {
  if (!evCanManage()) { showToast('Only organisers can create events.', 'lock'); return; }
  EV.wizard = {
    step: 1,
    basics: {
      title: '', description: '', eventType: 'Reunion', startsOn: '', startTime: '', endTime: '',
      venue: '', organizerDepartment: (state.currentUser && state.currentUser.dept) || '',
      visibility: 'alumni', capacity: 100
    },
    tickets: { isPaid: false, waitlistEnabled: true,
               opensDate: '', opensTime: '', closesDate: '', closesTime: '',
               types: [{ name: 'Alumni', price: 500, quota: '' }] },
    error: ''
  };
  evRenderWizard();
}

const EV_WIZARD_STEPS = ['Event basics', 'Tickets & Registration', 'Review & Create'];

function evWizardStepper(step) {
  // Desktop shows all three labels in full — nothing is ellipsised. Narrow
  // screens drop to "Step n of 3" plus the current label, which is readable
  // where three labels side by side would not be.
  return '<ol class="ev-stepper" aria-label="Progress">' +
    EV_WIZARD_STEPS.map(function (label, i) {
      const n = i + 1;
      const cls = n === step ? 'current' : (n < step ? 'done' : '');
      return '<li class="' + cls + '" ' + (n === step ? 'aria-current="step"' : '') + '>' +
        '<span class="ev-stepper-num">' + (n < step ? evIcon('check') : n) + '</span>' +
        '<span class="ev-stepper-label">' + label + '</span></li>';
    }).join('') + '</ol>' +
    '<p class="ev-stepper-compact" aria-hidden="true">' +
      '<span class="ev-stepper-count">Step ' + step + ' of 3</span>' +
      '<span class="ev-stepper-current">' + EV_WIZARD_STEPS[step - 1] + '</span></p>';
}

function evRenderWizard() {
  const w = EV.wizard;
  if (!w) return;
  let bodyHtml = '';
  if (w.step === 1) bodyHtml = evWizardStep1();
  else if (w.step === 2) bodyHtml = evWizardStep2();
  else bodyHtml = evWizardStep3();

  showModal(
    '<div class="modal-header">' +
      '<h2 class="modal-title">' + evIcon('calendar-plus') + ' New event</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button>' +
    '</div>' +
    evWizardStepper(w.step) +
    (w.error ? '<p class="ev-banner danger" role="alert">' + evIcon('triangle-alert') + ' ' + escapeHtml(w.error) + '</p>' : '') +
    '<div class="ev-wizard-body">' + bodyHtml + '</div>',
    { wide: true });
  evRefreshIcons();
}

function evWizardStep1() {
  const b = EV.wizard.basics;
  return '<div class="ev-form">' +
    '<div class="ev-field"><label class="ev-label" for="ev-w-title">Event title <span class="req">*</span></label>' +
      '<input type="text" id="ev-w-title" class="form-input" maxlength="200" required ' +
      'value="' + escapeHtml(b.title) + '" placeholder="DIC Annual Alumni Reunion 2026" />' +
      '<span class="ev-help">The name alumni will see.</span></div>' +

    '<div class="ev-field"><label class="ev-label" for="ev-w-desc">Description</label>' +
      '<textarea id="ev-w-desc" class="form-input" rows="3" maxlength="2000" ' +
      'placeholder="What the event is, who it is for, what to expect">' + escapeHtml(b.description) + '</textarea></div>' +

    '<div class="ev-grid2">' +
      '<div class="ev-field"><label class="ev-label" for="ev-w-type">Event type <span class="req">*</span></label>' +
        '<select id="ev-w-type" class="form-select">' + EV_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (b.eventType === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') + '</select>' +
        '<span class="ev-help">Chooses the icon shown on the event card.</span></div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-w-date">Date <span class="req">*</span></label>' +
        '<input type="date" id="ev-w-date" class="form-input" required value="' + escapeHtml(b.startsOn) + '" /></div>' +
    '</div>' +

    '<div class="ev-grid2">' +
      '<div class="ev-field"><label class="ev-label" for="ev-w-start">Start time</label>' +
        '<input type="time" id="ev-w-start" class="form-input" value="' + escapeHtml(b.startTime) + '" /></div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-w-end">End time</label>' +
        '<input type="time" id="ev-w-end" class="form-input" value="' + escapeHtml(b.endTime) + '" /></div>' +
    '</div>' +

    '<div class="ev-field"><label class="ev-label" for="ev-w-venue">Venue <span class="req">*</span></label>' +
      '<input type="text" id="ev-w-venue" class="form-input" required maxlength="200" ' +
      'value="' + escapeHtml(b.venue) + '" placeholder="DIC Main Campus Auditorium" /></div>' +

    '<div class="ev-grid2">' +
      '<div class="ev-field"><label class="ev-label" for="ev-w-org">Organiser / department</label>' +
        '<input type="text" id="ev-w-org" class="form-input" maxlength="150" ' +
        'value="' + escapeHtml(b.organizerDepartment) + '" placeholder="DIC Alumni Relations" /></div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-w-cap">Total capacity</label>' +
        '<input type="number" id="ev-w-cap" class="form-input" min="1" value="' + (b.capacity || 100) + '" />' +
        '<span class="ev-help">Total seats. Ticket quotas can be set on the next step.</span></div>' +
    '</div>' +

    '<fieldset class="ev-field ev-fieldset">' +
      '<legend class="ev-label">Who can see this event</legend>' +
      evRadioCard('ev-w-vis', 'visibility', 'public', 'Public', 'Anyone can see it', b.visibility === 'public') +
      evRadioCard('ev-w-vis', 'visibility', 'alumni', 'Alumni only', 'Signed-in alumni only', b.visibility === 'alumni') +
      evRadioCard('ev-w-vis', 'visibility', 'invite', 'Invite only', 'Hidden from the public list', b.visibility === 'invite') +
    '</fieldset>' +

    '<div class="ev-modal-footer">' +
      '<button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>' +
      '<button type="button" class="btn btn-primary" onclick="evWizardNext()">Next: Tickets ' + evIcon('arrow-right') + '</button>' +
    '</div></div>';
}

function evRadioCard(idBase, name, value, label, help, checked) {
  const id = idBase + '-' + value;
  return '<label class="ev-radio" for="' + id + '">' +
    '<input type="radio" id="' + id + '" name="' + name + '" value="' + value + '"' + (checked ? ' checked' : '') + ' />' +
    '<span><strong>' + label + '</strong><span>' + help + '</span></span></label>';
}

function evWizardStep2() {
  const t = EV.wizard.tickets;
  return '<div class="ev-form">' +
    '<fieldset class="ev-field ev-fieldset">' +
      '<legend class="ev-label">Registration</legend>' +
      '<label class="ev-radio" for="ev-w-free"><input type="radio" id="ev-w-free" name="paid" value="free"' +
        (t.isPaid ? '' : ' checked') + ' onchange="evWizardSetPaid(false)" />' +
        '<span><strong>Free</strong><span>Alumni register at no cost</span></span></label>' +
      '<label class="ev-radio" for="ev-w-paid"><input type="radio" id="ev-w-paid" name="paid" value="paid"' +
        (t.isPaid ? ' checked' : '') + ' onchange="evWizardSetPaid(true)" />' +
        '<span><strong>Paid</strong><span>One or more ticket types with prices</span></span></label>' +
    '</fieldset>' +

    (t.isPaid
      ? '<div class="ev-field"><div class="ev-field-head"><span class="ev-label">Ticket types</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" onclick="evWizardAddType()">' +
            evIcon('plus') + ' Add type</button></div>' +
        '<div class="ev-tickettypes">' +
          '<div class="ev-tt-head"><span>Name</span><span>Price (৳)</span><span>Quota</span><span></span></div>' +
          t.types.map(function (row, i) {
            return '<div class="ev-tt-row">' +
              evWizTicketCell(i, 'n', 'Ticket name', 'text', row.name, 'name', 'Alumni') +
              evWizTicketCell(i, 'p', 'Price', 'number', row.price, 'price', '0') +
              evWizTicketCell(i, 'q', 'Quota', 'number', row.quota, 'quota', 'No limit') +
              (t.types.length > 1
                ? '<button type="button" class="ev-icon-btn danger" onclick="evWizardRemoveType(' + i + ')" ' +
                  'aria-label="Remove ticket type">' + evIcon('x') + '</button>'
                : '<span></span>') +
            '</div>'; }).join('') +
        '</div>' +
        '<span class="ev-help">Leave a quota blank for no per-type limit. Quotas are enforced on top of total capacity.</span></div>'
      : '<p class="ev-callout-plain">' + evIcon('info') +
        ' Everyone gets one free ticket, limited by the total capacity you set on the previous step.</p>') +

    '<fieldset class="ev-field ev-fieldset ev-regwindow">' +
      '<legend class="ev-label">Registration window</legend>' +
      '<div class="ev-regrow">' +
        '<span class="ev-reglabel" id="ev-reg-open-lbl">Registration opens</span>' +
        '<div class="ev-regpair" role="group" aria-labelledby="ev-reg-open-lbl">' +
          '<div class="ev-regcell">' +
            '<label class="ev-sublabel" for="ev-w-open-date">Date</label>' +
            '<input type="date" id="ev-w-open-date" class="form-input" value="' + escapeHtml(t.opensDate) + '" ' +
              'oninput="evWizardWindowChanged()" />' +
          '</div>' +
          '<div class="ev-regcell">' +
            '<label class="ev-sublabel" for="ev-w-open-time">Time</label>' +
            '<input type="time" id="ev-w-open-time" class="form-input" value="' + escapeHtml(t.opensTime) + '" ' +
              'oninput="evWizardWindowChanged()" />' +
          '</div>' +
        '</div>' +
        '<span class="ev-help">Optional — leave blank to open registration immediately.</span>' +
      '</div>' +

      '<div class="ev-regrow">' +
        '<span class="ev-reglabel" id="ev-reg-close-lbl">Registration closes</span>' +
        '<div class="ev-regpair" role="group" aria-labelledby="ev-reg-close-lbl">' +
          '<div class="ev-regcell">' +
            '<label class="ev-sublabel" for="ev-w-close-date">Date</label>' +
            '<input type="date" id="ev-w-close-date" class="form-input" value="' + escapeHtml(t.closesDate) + '" ' +
              'oninput="evWizardWindowChanged()" />' +
          '</div>' +
          '<div class="ev-regcell">' +
            '<label class="ev-sublabel" for="ev-w-close-time">Time</label>' +
            '<input type="time" id="ev-w-close-time" class="form-input" value="' + escapeHtml(t.closesTime) + '" ' +
              'oninput="evWizardWindowChanged()" />' +
          '</div>' +
        '</div>' +
        '<span class="ev-help">Optional — leave blank to keep registration open.</span>' +
      '</div>' +
      '<p class="ev-inline-error hidden" id="ev-reg-error" role="alert"></p>' +
    '</fieldset>' +

    '<label class="ev-switch" for="ev-w-wait">' +
      '<input type="checkbox" id="ev-w-wait"' + (t.waitlistEnabled ? ' checked' : '') + ' />' +
      '<span><strong>Keep a waitlist when the event is full</strong>' +
      '<span>People are promoted automatically when someone cancels.</span></span></label>' +

    '<div class="ev-modal-footer">' +
      '<button type="button" class="btn btn-outline" onclick="evWizardBack()">' + evIcon('arrow-left') + ' Back</button>' +
      '<button type="button" class="btn btn-primary" onclick="evWizardNext()">Next: Review ' + evIcon('arrow-right') + '</button>' +
    '</div></div>';
}

// One labelled field in a ticket-type row. The .ev-tt-head row supplies the
// column names on wide screens; once the grid stacks those disappear, so each
// input keeps its own label rather than leaving a bare "500" next to "150".
function evWizTicketCell(i, slot, label, type, value, key, placeholder) {
  const id = 'ev-tt-' + slot + '-' + i;
  return '<div class="ev-tt-cell">' +
    '<label class="ev-tt-label" for="' + id + '">' + label + '</label>' +
    '<input type="' + type + '" id="' + id + '" class="form-input"' +
      (type === 'number' ? ' min="0"' : '') +
      ' placeholder="' + placeholder + '"' +
      ' value="' + escapeHtml(String(value == null ? '' : value)) + '"' +
      ' oninput="evWizardType(' + i + ', \'' + key + '\', this.value)" /></div>';
}

/* A date with no time is ambiguous, so an opening date defaults to the start
   of that day and a closing date to the end of it — which is what an organiser
   means by "closes on the 10th". Returns null when no date was given. */
function evRegInstant(date, time, fallbackTime) {
  if (!date) return null;
  return date + 'T' + (time && time.length >= 4 ? time : fallbackTime);
}

function evRegWindowError(t) {
  if (t.opensTime && !t.opensDate) return 'Registration opens: please choose a date, or clear the time.';
  if (t.closesTime && !t.closesDate) return 'Registration closes: please choose a date, or clear the time.';
  const open = evRegInstant(t.opensDate, t.opensTime, '00:00');
  const close = evRegInstant(t.closesDate, t.closesTime, '23:59');
  if (open && close && close <= open) {
    return 'Registration must close after it opens.';
  }
  return '';
}

function evRegWindowSummary(t) {
  const open = evRegInstant(t.opensDate, t.opensTime, '00:00');
  const close = evRegInstant(t.closesDate, t.closesTime, '23:59');
  const fmt = function (iso) {
    const parts = String(iso).split('T');
    return evDate(parts[0]) + (parts[1] ? ' at ' + evTime(parts[1]) : '');
  };
  if (!open && !close) return 'Opens immediately · no closing date';
  if (open && !close) return 'Opens ' + fmt(open) + ' · no closing date';
  if (!open && close) return 'Opens immediately · closes ' + fmt(close);
  return 'Opens ' + fmt(open) + ' · closes ' + fmt(close);
}

/* Inline validation as the organiser types, so the problem is shown next to
   the fields rather than only when Next is pressed. */
function evWizardWindowChanged() {
  const w = EV.wizard;
  if (!w) return;
  evWizardCapture();
  const box = document.getElementById('ev-reg-error');
  if (!box) return;
  const msg = evRegWindowError(w.tickets);
  box.textContent = msg;
  box.classList.toggle('hidden', !msg);
}

function evWizardSetPaid(paid) {
  evWizardCapture();
  EV.wizard.tickets.isPaid = paid;
  evRenderWizard();
}
function evWizardType(i, field, value) {
  EV.wizard.tickets.types[i][field] = value;
}
function evWizardAddType() {
  evWizardCapture();
  EV.wizard.tickets.types.push({ name: '', price: 0, quota: '' });
  evRenderWizard();
}
function evWizardRemoveType(i) {
  evWizardCapture();
  EV.wizard.tickets.types.splice(i, 1);
  evRenderWizard();
}

function evWizardStep3() {
  const w = EV.wizard, b = w.basics, t = w.tickets;
  const u = state.currentUser || {};
  const needsApproval = !evIsAdmin();
  const quotaSum = t.isPaid
    ? t.types.reduce(function (a, r) { return a + (parseInt(r.quota, 10) || 0); }, 0) : 0;
  const capacity = parseInt(b.capacity, 10) || quotaSum || 100;

  const row = function (label, value) {
    return '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';
  };

  return '<div class="ev-review">' +
    '<div class="ev-review-head">' +
      '<span class="ev-card-icon">' + evIcon(evTypeIcon(b.eventType)) + '</span>' +
      '<div><h3>' + escapeHtml(b.title) + '</h3>' +
      '<p>' + escapeHtml(b.eventType) + ' · ' + (t.isPaid ? 'Paid' : 'Free') + '</p></div>' +
    '</div>' +
    (b.description ? '<p class="ev-prose">' + escapeHtml(b.description) + '</p>' : '') +
    '<dl class="ev-deflist">' +
      row('Date', escapeHtml(evDate(b.startsOn))) +
      row('Time', escapeHtml(
        b.startTime ? evTime(b.startTime) + (b.endTime ? ' – ' + evTime(b.endTime) : '') : 'Not set')) +
      row('Venue', escapeHtml(b.venue)) +
      row('Capacity', capacity.toLocaleString() + ' seats') +
      row('Organiser', b.organizerDepartment ? escapeHtml(b.organizerDepartment)
                                             : '<span class="ev-notset">Not set</span>') +
      row('Visibility', b.visibility === 'public' ? 'Public'
                      : b.visibility === 'invite' ? 'Invite only' : 'Alumni only') +
      row('Registration', escapeHtml(evRegWindowSummary(t))) +
      row('Waitlist', t.waitlistEnabled ? 'Enabled' : 'Off') +
    '</dl>' +

    '<h4 class="ev-subhead">' + evIcon('ticket') + ' Tickets</h4>' +
    (t.isPaid
      ? '<ul class="ev-review-tickets">' + t.types.map(function (r) {
          return '<li><strong>' + escapeHtml(r.name || 'Unnamed') + '</strong>' +
            '<span>' + evMoney(r.price) + '</span>' +
            '<span>' + (r.quota === '' || r.quota == null ? 'No limit' : r.quota + ' available') + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="ev-muted">One free ticket per person, limited to ' + capacity.toLocaleString() + ' seats.</p>') +

    '<div class="ev-createdby">' +
      evIcon('user-round-pen') +
      '<div><span class="ev-label">Created by</span>' +
        '<strong>' + escapeHtml(u.name || 'You') + '</strong>' +
        '<span>' + escapeHtml(u.roleLabel || u.role || '') + ' · ' +
          escapeHtml(evDate(new Date().toISOString())) + '</span></div>' +
    '</div>' +

    '<p class="ev-banner ' + (needsApproval ? 'warn' : 'success') + '">' +
      evIcon(needsApproval ? 'clock' : 'circle-check-big') + ' ' +
      (needsApproval
        ? 'This event will be submitted for approval.'
        : 'This event will be published immediately.') + '</p>' +

    '<div class="ev-modal-footer">' +
      '<button type="button" class="btn btn-outline" onclick="evWizardBack()">' + evIcon('arrow-left') + ' Back</button>' +
      '<button type="button" class="btn btn-primary" id="ev-w-submit" onclick="evWizardSubmit()">Create event</button>' +
    '</div></div>';
}

// Reads whatever is on screen back into wizard state before re-rendering.
function evWizardCapture() {
  const w = EV.wizard;
  if (!w) return;
  const val = function (id) { const el = document.getElementById(id); return el ? el.value : undefined; };

  if (w.step === 1) {
    const b = w.basics;
    if (val('ev-w-title') !== undefined) {
      b.title = val('ev-w-title').trim();
      b.description = val('ev-w-desc').trim();
      b.eventType = val('ev-w-type');
      b.startsOn = val('ev-w-date');
      b.startTime = val('ev-w-start');
      b.endTime = val('ev-w-end');
      b.venue = val('ev-w-venue').trim();
      b.organizerDepartment = val('ev-w-org').trim();
      b.capacity = val('ev-w-cap');
      const vis = document.querySelector('input[name="visibility"]:checked');
      if (vis) b.visibility = vis.value;
    }
  } else if (w.step === 2) {
    const t = w.tickets;
    if (val('ev-w-open-date') !== undefined) {
      t.opensDate = val('ev-w-open-date');
      t.opensTime = val('ev-w-open-time');
      t.closesDate = val('ev-w-close-date');
      t.closesTime = val('ev-w-close-time');
      const wait = document.getElementById('ev-w-wait');
      if (wait) t.waitlistEnabled = wait.checked;
    }
  }
}

function evWizardBack() {
  evWizardCapture();
  EV.wizard.error = '';
  EV.wizard.step = Math.max(1, EV.wizard.step - 1);
  evRenderWizard();
}

function evWizardNext() {
  evWizardCapture();
  const w = EV.wizard;
  w.error = '';

  if (w.step === 1) {
    const b = w.basics;
    if (!b.title) w.error = 'Please give the event a title.';
    else if (!b.startsOn) w.error = 'Please choose the event date.';
    else if (!b.venue) w.error = 'Please enter the venue.';
    else if (b.startTime && b.endTime && b.endTime <= b.startTime)
      w.error = 'The end time must be after the start time.';
    if (w.error) { evRenderWizard(); return; }
  }

  if (w.step === 2) {
    if (w.tickets.isPaid) {
      const bad = w.tickets.types.find(function (r) { return !String(r.name || '').trim(); });
      if (bad) { w.error = 'Every ticket type needs a name.'; evRenderWizard(); return; }
    }
    const windowError = evRegWindowError(w.tickets);
    if (windowError) { w.error = windowError; evRenderWizard(); return; }
  }

  w.step = Math.min(3, w.step + 1);
  evRenderWizard();
}

async function evWizardSubmit() {
  const w = EV.wizard;
  if (!w) return;
  const btn = document.getElementById('ev-w-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  const b = w.basics, t = w.tickets;
  const payload = {
    title: b.title, description: b.description || null, eventType: b.eventType,
    startsOn: b.startsOn, startTime: b.startTime || null, endTime: b.endTime || null,
    venue: b.venue, capacity: parseInt(b.capacity, 10) || null,
    organizerDepartment: b.organizerDepartment || null, visibility: b.visibility,
    isPaid: t.isPaid, waitlistEnabled: t.waitlistEnabled,
    registrationOpensAt: evRegInstant(t.opensDate, t.opensTime, '00:00'),
    registrationClosesAt: evRegInstant(t.closesDate, t.closesTime, '23:59'),
    ticketTypes: t.isPaid
      ? t.types.map(function (r) {
          return { name: String(r.name).trim(), price: Number(r.price) || 0,
                   quota: r.quota === '' || r.quota == null ? null : Number(r.quota) };
        })
      : []
  };

  const res = await API.createEvent(payload);
  if (apiFailed(res)) {
    w.error = (res && res.error) || 'Could not create the event.';
    evRenderWizard();
    return;
  }

  closeModal();
  EV.wizard = null;
  showToast(res.approval_status === 'pending_approval'
    ? '"' + res.title + '" submitted for approval.'
    : '"' + res.title + '" created and published.', 'circle-check-big');
  await openEventWorkspace(res.id, 'overview');
}

/* ══════════════════════════════════════════════════════════
   EVENT ACTIONS
   ══════════════════════════════════════════════════════════ */

function evEditEvent() {
  const e = EV.event;
  if (!e) return;
  showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('pencil') + ' Edit event</h2>' +
    '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    '<form class="ev-form" onsubmit="evSubmitEditEvent(event)">' +
      '<div class="ev-field"><label class="ev-label" for="ev-e-title">Title <span class="req">*</span></label>' +
        '<input type="text" id="ev-e-title" class="form-input" required value="' + escapeHtml(e.title) + '" /></div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-e-desc">Description</label>' +
        '<textarea id="ev-e-desc" class="form-input" rows="3">' + escapeHtml(e.description || '') + '</textarea></div>' +
      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-e-type">Type</label>' +
          '<select id="ev-e-type" class="form-select">' + EV_TYPES.map(function (t) {
            return '<option value="' + t + '"' + (e.event_type === t ? ' selected' : '') + '>' + t + '</option>';
          }).join('') + '</select></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-e-date">Date <span class="req">*</span></label>' +
          '<input type="date" id="ev-e-date" class="form-input" required value="' + evDateInput(e.starts_on) + '" /></div>' +
      '</div>' +
      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-e-start">Start time</label>' +
          '<input type="time" id="ev-e-start" class="form-input" value="' + evTimeInput(e.start_time) + '" /></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-e-end">End time</label>' +
          '<input type="time" id="ev-e-end" class="form-input" value="' + evTimeInput(e.end_time) + '" /></div>' +
      '</div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-e-venue">Venue <span class="req">*</span></label>' +
        '<input type="text" id="ev-e-venue" class="form-input" required value="' + escapeHtml(e.venue) + '" /></div>' +
      '<div class="ev-grid2">' +
        '<div class="ev-field"><label class="ev-label" for="ev-e-cap">Capacity</label>' +
          '<input type="number" id="ev-e-cap" class="form-input" min="1" value="' + (e.capacity || 0) + '" /></div>' +
        '<div class="ev-field"><label class="ev-label" for="ev-e-org">Organiser</label>' +
          '<input type="text" id="ev-e-org" class="form-input" value="' + escapeHtml(e.organizer_department || '') + '" /></div>' +
      '</div>' +
      '<div class="ev-field"><label class="ev-label" for="ev-e-vis">Visibility</label>' +
        '<select id="ev-e-vis" class="form-select">' +
          '<option value="public"' + (e.visibility === 'public' ? ' selected' : '') + '>Public</option>' +
          '<option value="alumni"' + (e.visibility === 'alumni' ? ' selected' : '') + '>Alumni only</option>' +
          '<option value="invite"' + (e.visibility === 'invite' ? ' selected' : '') + '>Invite only</option>' +
        '</select></div>' +
      '<div class="ev-modal-footer">' +
        '<button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Save changes</button></div>' +
    '</form>');
  evRefreshIcons();
}

async function evSubmitEditEvent(e) {
  if (e) e.preventDefault();
  const payload = {
    title: document.getElementById('ev-e-title').value.trim(),
    description: document.getElementById('ev-e-desc').value.trim(),
    eventType: document.getElementById('ev-e-type').value,
    startsOn: document.getElementById('ev-e-date').value,
    startTime: document.getElementById('ev-e-start').value || null,
    endTime: document.getElementById('ev-e-end').value || null,
    venue: document.getElementById('ev-e-venue').value.trim(),
    capacity: parseInt(document.getElementById('ev-e-cap').value, 10) || null,
    organizerDepartment: document.getElementById('ev-e-org').value.trim(),
    visibility: document.getElementById('ev-e-vis').value
  };
  const res = await API.updateEvent(EV.event.id, payload);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not save.', 'triangle-alert'); return; }
  closeModal();
  showToast('Event updated.', 'circle-check-big');
  await evReloadWorkspace();
}

async function evApprove(id) {
  const res = await API.approveEvent(id);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not approve.', 'triangle-alert'); return; }
  showToast('Event approved and published.', 'circle-check-big');
  if (EV.event && EV.event.id === id) await evReloadWorkspace(); else await loadEventList();
}

async function evReject(id) {
  const reason = prompt('Why is this event being sent back? The organiser will see this.');
  if (reason === null) return;
  if (!reason.trim()) { showToast('A reason is required.', 'triangle-alert'); return; }
  const res = await API.rejectEvent(id, reason.trim());
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not send back.', 'triangle-alert'); return; }
  showToast('Sent back to the organiser.', 'undo-2');
  if (EV.event && EV.event.id === id) await evReloadWorkspace(); else await loadEventList();
}

async function evCancelEvent() {
  const e = EV.event;
  if (!e) return;
  const reason = prompt('Why is "' + e.title + '" being cancelled? Everyone holding a ticket will be told.');
  if (reason === null) return;
  if (!reason.trim()) { showToast('A reason is required.', 'triangle-alert'); return; }
  const res = await API.cancelEvent(e.id, reason.trim());
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not cancel.', 'triangle-alert'); return; }
  showToast('Event cancelled and ticket holders notified.', 'calendar-x');
  await evReloadWorkspace();
}

function evPreviewPublic() {
  const e = EV.event;
  if (!e) return;
  const reg = e.registered || 0;
  const full = e.capacity ? reg >= e.capacity : false;
  showModal(
    '<div class="modal-header"><h2 class="modal-title">' + evIcon('eye') + ' Public preview</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    '<p class="ev-help">This is how the event appears to alumni.</p>' +
    '<div class="ev-preview">' + evPublicCard(Object.assign({}, e, { is_registered: false })) + '</div>' +
    (e.visibility === 'invite'
      ? '<p class="ev-banner warn">' + evIcon('eye-off') +
        ' This event is invite only, so it does not appear in the public list.</p>' : '') +
    (e.approval_status !== 'approved'
      ? '<p class="ev-banner warn">' + evIcon('clock') +
        ' Not approved yet, so alumni cannot see it.</p>' : ''),
    { dismissable: true });
  evRefreshIcons();
}

/* ══════════════════════════════════════════════════════════
   ALUMNI-FACING TICKET ACTIONS
   ══════════════════════════════════════════════════════════ */

async function evRegister(eventId) {
  const e = EV.list.find(function (x) { return x.id === eventId; });
  const types = e && e.is_paid ? await API.getTicketTypes(eventId) : null;

  if (types && !apiFailed(types) && types.length > 1) {
    showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('ticket') + ' Choose a ticket</h2>' +
      '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
      '<div class="ev-ticketchoices">' + types.map(function (t) {
        const left = t.quota == null ? null : Math.max(0, t.quota - t.sold);
        const soldOut = left === 0;
        return '<button type="button" class="ev-ticketchoice" ' + (soldOut ? 'disabled' : '') + ' ' +
          'onclick="evDoRegister(' + eventId + ',' + t.id + ')">' +
          '<span class="ev-ticketchoice-name"><strong>' + escapeHtml(t.name) + '</strong>' +
          '<span>' + (left == null ? 'No limit' : (soldOut ? 'Sold out' : left + ' left')) + '</span></span>' +
          '<span class="ev-ticketchoice-price">' + (Number(t.price) > 0 ? evMoney(t.price) : 'Free') + '</span>' +
          '</button>'; }).join('') + '</div>');
    evRefreshIcons();
    return;
  }
  await evDoRegister(eventId, types && !apiFailed(types) && types[0] ? types[0].id : null);
}

async function evDoRegister(eventId, ticketTypeId) {
  const body = { clientMutationId: 'reg-' + eventId + '-' + (state.currentUser ? state.currentUser.id : 0) + '-' + Date.now() };
  if (ticketTypeId) body.ticketTypeId = ticketTypeId;

  const res = await API.registerForEvent(eventId, body);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Registration failed.', 'triangle-alert'); return; }
  closeModal();
  showToast(res.status === 'waitlisted'
    ? 'That event is full — you are on the waitlist.'
    : 'Ticket confirmed for "' + res.event + '".', res.status === 'waitlisted' ? 'hourglass' : 'ticket-check');
  await loadEventList();
  if (typeof renderNotifications === 'function') renderNotifications();
  if (res.status === 'confirmed') evViewTicket(eventId);
}

async function evCancelTicket(eventId) {
  if (!confirm('Cancel your ticket for this event?')) return;
  const res = await API.cancelRegistration(eventId);
  if (apiFailed(res)) { showToast(res && res.error ? res.error : 'Could not cancel.', 'triangle-alert'); return; }
  showToast(res.promoted ? 'Ticket cancelled — a waitlisted alumnus was promoted.' : 'Ticket cancelled.', 'circle-check-big');
  await loadEventList();
}

async function evViewTicket(eventId) {
  const t = await API.getMyTicket(eventId);
  if (apiFailed(t) || !t) { showToast('No ticket found for this event.', 'triangle-alert'); return; }

  showModal('<div class="modal-header"><h2 class="modal-title">' + evIcon('ticket') + ' Your ticket</h2>' +
    '<button type="button" class="modal-close" aria-label="Close">' + evIcon('x') + '</button></div>' +
    '<div class="ev-ticket">' +
      '<div class="ev-ticket-event">' +
        '<strong>' + escapeHtml(t.event_title || '') + '</strong>' +
        '<span>' + escapeHtml(evDate(t.starts_on)) +
          (t.start_time ? ' · ' + escapeHtml(evTime(t.start_time)) : '') + '</span>' +
        '<span>' + escapeHtml(t.venue || '') + '</span>' +
      '</div>' +
      '<div id="ev-ticket-qr" class="ev-ticket-qr"></div>' +
      '<p class="ev-ticket-code">' + escapeHtml(t.ticket_code) + '</p>' +
      '<p class="ev-ticket-status">' +
        (t.status === 'waitlisted'
          ? evIcon('hourglass') + ' Waitlisted — you will be told if a seat opens'
          : evIcon('circle-check-big') + ' Confirmed') +
        (t.ticket_type_name ? ' · ' + escapeHtml(t.ticket_type_name) : '') +
        (t.checked_in ? ' · ' + evIcon('check') + ' Checked in' : '') + '</p>' +
      (Number(t.amount_paid) > 0
        ? '<p class="ev-muted small">Paid ' + evMoney(t.amount_paid) + '</p>' : '') +
      '<p class="ev-help">Show this QR code at the entrance.</p>' +
    '</div>', { dismissable: true });
  evRefreshIcons();

  const holder = document.getElementById('ev-ticket-qr');
  if (holder && typeof QRCode !== 'undefined') {
    try {
      new QRCode(holder, { text: t.qr_payload, width: 176, height: 176,
                           colorDark: '#0B3897', colorLight: '#ffffff' });
    } catch (err) {
      holder.innerHTML = '<p class="ev-muted small">QR code unavailable — use the code below.</p>';
    }
  } else if (holder) {
    holder.innerHTML = '<p class="ev-muted small">QR code unavailable — use the code below.</p>';
  }
}
