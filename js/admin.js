/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   admin.js

   The admin control centre: bulk import, custom fields, the RBAC matrix,
   the audit log, moderation, the sync ledger and audience segmentation.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


// 2. MODERATOR DASHBOARD
function renderModeratorDashboard(page) {
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title"><i data-lucide="shield" class="ui-icon"></i> Community Moderation Center</h1>
        <p class="page-subtitle">DIC Community Approvals Control Panel</p>
      </div>
      <span class="card-badge teal"><span data-stat="moderation_pending">—</span> pending</span>
    </div>

    <div class="sync-overview-grid mb-16">
      <div class="sync-stat-card"><div class="sync-stat-val" data-stat="pending_verifications">—</div><div class="sync-stat-label">Unverified Accounts</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber)" data-stat="pending_stories">—</div><div class="sync-stat-label">Stories Awaiting Review</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal)" data-stat="pending_chapters">—</div><div class="sync-stat-label">Chapters Awaiting Review</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--primary-light)" data-stat="pending_events">—</div><div class="sync-stat-label">Events Awaiting Approval</div></div>
    </div>

    <div class="dashboard-split">
      <div class="dashboard-left">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="search" class="ui-icon"></i> Pending Alumni Verification Queue</h3></div>
          <div id="verification-queue"></div>
        </div>
      </div>
      <div class="dashboard-right">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="clipboard-list" class="ui-icon"></i> Moderation Queue</h3></div>
          <div id="dash-moderation-queue"></div>
        </div>
      </div>
    </div>
  `;
  renderVerificationQueue();
  renderDashModerationQueue();
  loadPlatformStats().then(s => paintStats(s));
}

/* The real moderation queue. The panel this replaces held one invented item —
   "Reported Discussion Post #482" — with working Take Down and Dismiss buttons
   that only raised a toast. There is no reports table in the schema, so no
   report count is shown; what is shown is what /api/moderation returns. */
function renderDashModerationQueue() {
  const el = document.getElementById('dash-moderation-queue');
  if (!el) return;
  el.innerHTML = '<div class="queue-sub" style="padding:12px">Loading…</div>';
  API.getModerationQueue().then(res => {
    if (apiFailed(res)) {
      el.innerHTML = renderEmptyState('<i data-lucide="shield-off" class="ui-icon"></i>',
        'Moderation queue unavailable', 'The queue could not be loaded.');
      return;
    }
    const items = [
      ...(res.chapters || []).map(c => ({ kind: 'Chapter', title: c.name, id: c.id, type: 'chapter' })),
      ...(res.stories || []).map(s => ({ kind: 'Story', title: s.title, id: s.id, type: 'story' }))
    ];
    if (!items.length) {
      el.innerHTML = renderEmptyState('<i data-lucide="check-check" class="ui-icon"></i>',
        'Nothing waiting for review', 'Chapters and stories submitted for approval appear here.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    el.innerHTML = items.map(i => `
      <div class="queue-item">
        <div class="queue-info">
          <div class="queue-name">${escapeHtml(i.title || 'Untitled')}</div>
          <div class="queue-sub">${i.kind} · awaiting review</div>
        </div>
        <div class="queue-actions">
          <button class="approve-btn" onclick="${i.type === 'chapter' ? 'handleModerateChapter' : 'handleModerateStory'}(${i.id}, 'approve')">Approve</button>
          <button class="review-btn" onclick="${i.type === 'chapter' ? 'handleModerateChapter' : 'handleModerateStory'}(${i.id}, 'reject')">Reject</button>
        </div>
      </div>`).join('');
    if (window.lucide) lucide.createIcons();
  });
}

// 3. DEPARTMENT ADMIN DASHBOARD
function renderDeptAdminDashboard(page) {
  const u = state.currentUser;
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title"><i data-lucide="building-2" class="ui-icon"></i> Department Admin Center</h1>
        <p class="page-subtitle">Daffodil International College · ${escapeHtml(u.dept || '')}</p>
      </div>
    </div>

    <div class="sync-overview-grid">
      <div class="sync-stat-card"><div class="sync-stat-val" id="dept-alumni-count">—</div><div class="sync-stat-label">Alumni in ${escapeHtml(u.dept || 'your department')}</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal)" data-stat="events_upcoming">—</div><div class="sync-stat-label">Upcoming Events</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber)" data-stat="my_assigned_tasks">—</div><div class="sync-stat-label">Tasks Assigned to Me</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--primary-light)" data-stat="moderation_pending">—</div><div class="sync-stat-label">Items Awaiting Review</div></div>
    </div>

    <div class="dashboard-split">
      <div class="dashboard-left">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="users" class="ui-icon"></i> Alumni by Department</h3></div>
          <div id="dept-breakdown"></div>
        </div>
      </div>
      <div class="dashboard-right">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="clipboard-list" class="ui-icon"></i> Verification Queue</h3></div>
          <div id="verification-queue"></div>
        </div>
      </div>
    </div>
  `;
  renderVerificationQueue();
  loadPlatformStats().then(s => paintStats(s));
  renderDepartmentBreakdown(u.dept);
}

/* Real headcount per department, straight from alumni_profiles. This replaces a
   fixed "6,210 CSE Alumni" tile and a placement-funnel chart whose series was a
   literal array. There is no employment-outcome data in the schema, so no
   employment rate is shown. */

// 4. COLLEGE ADMIN DASHBOARD
function renderUnivAdminDashboard(page) {
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title"><i data-lucide="landmark" class="ui-icon"></i> DIC Executive Command Center</h1>
        <p class="page-subtitle">Daffodil International College</p>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-primary" onclick="showBroadcastModal()"><i data-lucide="megaphone" class="ui-icon"></i> College Broadcast</button>
      </div>
    </div>

    <!-- No trend captions: nothing in the schema records a prior period to
         compare against, so a "9.2% this quarter" line could only be invented. -->
    <div class="kpi-grid">
      <div class="kpi-card indigo">
        <div class="kpi-icon"><i data-lucide="users" class="ui-icon"></i></div>
        <div class="kpi-body">
          <div class="kpi-value" data-stat="users_verified">—</div>
          <div class="kpi-label">Verified Accounts</div>
        </div>
      </div>
      <div class="kpi-card teal">
        <div class="kpi-icon">৳</div>
        <div class="kpi-body">
          <div class="kpi-value" data-stat="donations_total">—</div>
          <div class="kpi-label">Donations Settled</div>
        </div>
      </div>
      <div class="kpi-card amber">
        <div class="kpi-icon"><i data-lucide="handshake" class="ui-icon"></i></div>
        <div class="kpi-body">
          <div class="kpi-value" data-stat="mentorships_active">—</div>
          <div class="kpi-label">Active Mentorships</div>
        </div>
      </div>
      <div class="kpi-card purple">
        <div class="kpi-icon"><i data-lucide="ticket" class="ui-icon"></i></div>
        <div class="kpi-body">
          <div class="kpi-value" data-stat="events_upcoming">—</div>
          <div class="kpi-label">Upcoming Events</div>
        </div>
      </div>
    </div>

    <div class="sync-overview-grid mt-16">
      <div class="sync-stat-card"><div class="sync-stat-val" data-stat="profiles_total">—</div><div class="sync-stat-label">Alumni Profiles</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal)" data-stat="registrations_total">—</div><div class="sync-stat-label">Event Registrations</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber)" data-stat="jobs_total">—</div><div class="sync-stat-label">Job Postings</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--primary-light)" data-stat="chapter_memberships_total">—</div><div class="sync-stat-label">Chapter Memberships</div></div>
    </div>

    <div class="dashboard-split mt-16">
      <div class="dashboard-left">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="chart-column" class="ui-icon"></i> Alumni by Batch</h3></div>
          <div id="univ-batch-breakdown"></div>
        </div>
      </div>
      <div class="dashboard-right">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="trophy" class="ui-icon"></i> Top Benefactors</h3></div>
          <div id="donor-leaderboard"></div>
        </div>
      </div>
    </div>
  `;
  renderDonorLeaderboard();
  loadPlatformStats().then(s => paintStats(s, { donations_total: statMoney }));
  renderBatchBreakdown();
}

/* Alumni per graduating batch, from alumni_profiles.batch. Replaces a
   "12-Month Alumni Engagement Trends" chart whose twelve data points were a
   literal array — the schema stores no monthly engagement history. */

// 5. SUPER ADMIN DASHBOARD
function renderSuperAdminDashboard(page) {
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title"><i data-lucide="crown" class="ui-icon"></i> DIC Super Admin Control Panel</h1>
        <p class="page-subtitle">Platform totals · audit trail · system status</p>
      </div>
    </div>

    <!-- The four tiles here used to report CPU load, RAM usage, API latency and
         a database connection-pool figure. Nothing in this system collects any
         of that, so all four were literals. GET /api/health is the only real
         telemetry available: it proves the database answered and reports what
         it is and what time it thinks it is. -->
    <div class="server-health-grid" id="system-status">
      <div class="server-card"><div class="server-val">—</div><div class="server-label">Checking system status…</div></div>
    </div>

    <div class="sync-overview-grid mt-16">
      <div class="sync-stat-card"><div class="sync-stat-val" data-stat="users_total">—</div><div class="sync-stat-label">User Accounts</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal)" data-stat="events_total">—</div><div class="sync-stat-label">Events</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber)" data-stat="audit_entries">—</div><div class="sync-stat-label">Audit Log Entries</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--primary-light)" data-stat="custom_fields_total">—</div><div class="sync-stat-label">Custom Fields</div></div>
    </div>

    <div class="dashboard-split mt-16">
      <div class="dashboard-left">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="scroll-text" class="ui-icon"></i> Immutable System Security Audit Trail</h3><button class="btn btn-outline btn-sm" onclick="showPage('admin')">View Full Audit Log →</button></div>
          <div id="audit-log"></div>
        </div>
      </div>
      <div class="dashboard-right">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="database" class="ui-icon"></i> Platform Totals</h3></div>
          <div id="super-totals"></div>
        </div>
      </div>
    </div>
  `;
  renderAuditLog();
  renderSystemStatus();
  loadPlatformStats().then(s => {
    paintStats(s, { donations_total: statMoney });
    renderSuperTotals(s);
  });
}

/* Real system status. Everything shown is something GET /api/health actually
   returned; when it does not answer, that is what the panel says. */
async function renderVerificationQueue() {
  const container = document.getElementById('verification-queue');
  if (!container) return;

  container.innerHTML = '<div class="queue-sub" style="padding:12px">Loading…</div>';
  const rows = await API.getVerificationQueue();

  if (apiFailed(rows)) {
    container.innerHTML = renderErrorState(
      rows?.error || 'Could not load the verification queue.', 'renderVerificationQueue()');
    return;
  }
  if (!rows.length) {
    container.innerHTML = renderEmptyState('<i data-lucide="user-check" class="ui-icon"></i>',
      'No accounts awaiting verification',
      'New sign-ups appear here until an administrator verifies them.');
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = rows.map(u => {
    const detail = [
      u.department, u.batch ? `Batch ${u.batch}` : null,
      u.student_id ? `ID ${u.student_id}` : null
    ].filter(Boolean).join(' · ') || u.email;
    return `
    <div class="queue-item" id="vq-${u.id}">
      <div class="queue-avatar">${escapeHtml(u.initials || (u.full_name || '?').charAt(0))}</div>
      <div class="queue-info">
        <div class="queue-name">${escapeHtml(u.full_name || 'Unnamed account')}</div>
        <div class="queue-sub">${escapeHtml(detail)}</div>
      </div>
      <div class="queue-actions">
        <button class="approve-btn" onclick="approveAlumni(${u.id})"><i data-lucide="check" class="ui-icon"></i> Verify</button>
      </div>
    </div>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

/* Actually verifies the account. The previous version took a name and raised a
   toast saying it had been approved, while users.is_verified stayed false. */
async function approveAlumni(id) {
  const res = await API.verifyUser(id, true);
  if (apiFailed(res)) {
    showToast('⚠ Could not verify this account — please try again.');
    return;
  }
  showToast(`✅ ${res.full_name} is now verified`);
  loadPlatformStats(true).then(s => paintStats(s, { donations_total: statMoney }));
  renderVerificationQueue();
}

// ─── IMMUTABLE AUDIT LOG ───
/* The super admin dashboard embeds its own #audit-log panel, so on the staff
   portal two elements carried that id and getElementById() always returned the
   dashboard's — the Audit Logs page stayed permanently empty. The target is now
   a parameter; the dashboard keeps the default. */
async function renderAuditLog(targetId = 'audit-log') {
  const el = document.getElementById(targetId);
  if (!el) return;

  const rows = await API.getAuditLogs();
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState(rows?.error || 'Could not load audit logs.', 'renderAuditLog()');
    return;
  }
  if (rows.length === 0) {
    el.innerHTML = renderEmptyState('<i data-lucide="shield" class="ui-icon"></i>', 'No audit entries yet', 'Privileged actions are recorded here as they happen.');
    return;
  }

  el.innerHTML = rows.map(l => `
    <div class="audit-entry">
      <div class="audit-icon" style="background:${escapeHtml(l.bg_color || 'rgba(0,168,89,0.15)')}">${emojiIcon(l.icon, 'shield')}</div>
      <div style="flex:1;min-width:0">
        <div class="audit-action">${escapeHtml(l.action)}</div>
        <div class="audit-meta">${escapeHtml(l.meta)} · ${escapeHtml(formatRelativeTime(l.created_at))}</div>
      </div>
      <div class="audit-hash" title="Hash-chained to the previous entry">${escapeHtml(l.hash)}</div>
    </div>`).join('');
}

// ─── ADMIN SECTIONS ─────────────────────────────────────────
function switchAdmin(section, btn) {
  document.querySelectorAll('.admin-tabs .chart-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
  document.getElementById('admin-' + section).classList.remove('hidden');
}
async function renderRBACTableV2() {
  const table = document.getElementById('rbac-table');
  if (!table) return;

  const res = await API.getRbacMatrix();
  if (apiFailed(res)) {
    table.innerHTML = `<tbody><tr><td style="padding:16px;color:var(--text-muted)">
      The permission matrix could not be loaded.</td></tr></tbody>`;
    return;
  }

  const label = (r) => ({
    alumni: 'Alumni', moderator: 'Moderator', dept_admin: 'Dept Admin',
    univ_admin: 'College Admin', super_admin: 'Super Admin'
  }[r] || r);

  let html = `<thead><tr>
    <th class="module-col">Capability</th>
    ${res.roles.map(r => `<th class="role-col" style="font-size:10px">${escapeHtml(label(r))}</th>`).join('')}
  </tr></thead><tbody>`;

  res.capabilities.forEach(cap => {
    // data-label lets the same markup render as a table on desktop and as one
    // card per capability on mobile (see the ≤900px block in styles.css).
    html += `<tr>
      <td class="module-name">${escapeHtml(cap.label)}</td>
      ${res.roles.map(r => {
        const allowed = cap.allowed.includes(r);
        return `<td class="perm-cell" data-label="${escapeHtml(label(r))}">
          <span class="${allowed ? 'perm-full' : 'perm-none'}">${allowed ? 'Allowed' : 'No'}</span></td>`;
      }).join('')}
    </tr>`;
  });
  html += '</tbody>';
  table.innerHTML = html;
}

/* ─── OFFLINE SYNC LEDGER ───────────────────────────────────
   sync_mutations is a real table: routes_events.js writes a row for every event
   registration, keyed by client_mutation_id so a retried request cannot
   register the same person twice. This panel shows those rows.

   What it no longer shows, because none of it was ever recorded anywhere: a
   six-item pending queue with byte sizes and timestamps, a conflict-resolution
   log, "247 synced today", a 99.8% success rate, and a 3.8 MB payload against a
   5 MB cap with LRU eviction at 100 MB. The Sync Now and Clear Conflicts
   buttons raised a toast and did nothing; there is no client-side outbox to
   flush, so they are gone too. */
async function renderOfflineSyncPanel() {
  const el = document.getElementById('offline-sync-panel');
  if (!el) return;

  el.innerHTML = '<div class="glass-card"><div style="padding:16px;color:var(--text-muted);font-size:12px">Loading…</div></div>';
  const res = await API.getSyncMutations();

  if (apiFailed(res)) {
    el.innerHTML = `<div class="glass-card">${renderErrorState(
      res?.error || 'Could not load the sync ledger.', 'renderOfflineSyncPanel()')}</div>`;
    return;
  }

  const rows = res.mutations || [];
  el.innerHTML = `
    <div class="glass-card">
      <div class="card-header">
        <h3 class="card-title">Sync Ledger</h3>
        <span class="card-badge teal">sync_mutations</span>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px">
        Every write that arrived with a client mutation id. The id makes a retried
        request idempotent: a registration submitted twice is recorded once.
      </p>
      <div class="sync-overview-grid">
        <div class="sync-stat-card"><div class="sync-stat-val">${res.total ?? 0}</div><div class="sync-stat-label">Recorded Mutations</div></div>
        <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal)">${res.applied ?? 0}</div><div class="sync-stat-label">Applied</div></div>
        <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber)">${res.unapplied ?? 0}</div><div class="sync-stat-label">Not Applied</div></div>
      </div>
    </div>
    <div class="glass-card">
      <div class="card-header"><h3 class="card-title">Recorded Mutations</h3><span class="badge-count">${rows.length}</span></div>
      ${rows.length === 0
        ? renderEmptyState('<i data-lucide="refresh-cw" class="ui-icon"></i>', 'No mutations recorded yet',
            'Rows appear here as registrations and check-ins are submitted.')
        : rows.map(m => `
          <div class="sync-queue-item">
            <span class="sync-queue-type ${m.applied ? 'mutation' : 'conflict'}">${escapeHtml(String(m.action || '').toUpperCase())}</span>
            <span style="flex:1;color:var(--text-secondary);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;min-width:0;overflow-wrap:anywhere">${escapeHtml(m.entity || '')} · ${escapeHtml(m.client_mutation_id || '')}</span>
            <span style="color:var(--text-muted);font-size:11px">${escapeHtml(m.user_name || 'Unknown')}</span>
            <span style="color:var(--text-muted);font-size:11px">${escapeHtml(formatRelativeTime(m.created_at))}</span>
          </div>`).join('')
      }
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}


// ─── 4. BULK USER IMPORT & AUTOMATIC PROFILE CREATION ENGINE ──
// Import audit rows, loaded from PostgreSQL by loadImportHistory().
let importHistory = [];

// Fetches the audit trail then re-renders the panel with the real rows.
async function loadImportHistory() {
  const rows = await API.getImportHistory();
  if (rows === null) return;
  importHistory = rows;
  renderBulkImportPanel();
}

let currentImportState = {
  step: 1,
  filename: '',
  strategy: 'generated',
  dupResolution: 'update',   // retain data by enriching existing profiles
  totalRows: 0,
  headers: [],        // raw CSV header cells
  rawRows: [],        // raw CSV data cells
  mapping: [],        // per-column system field key (or 'ignore')
  validRecords: [],
  invalidRecords: [],
  duplicateRecords: [],
  lastResult: null
};

function downloadSampleImportCSV() {
  const headers = [
    'FullName', 'StudentID', 'RollNumber', 'RegistrationNumber', 'Batch', 'PassingYear', 'Department', 'Program', 'Section',
    'CGPA', 'CurrentStatus', 'Degree', 'GraduationDate', 'CurrentCompany', 'JobTitle', 'Industry', 'EmploymentStatus',
    'YearsExperience', 'Skills', 'LinkedIn', 'Portfolio', 'Email', 'MobileNumber', 'AltPhone', 'DateOfBirth', 'Gender',
    'BloodGroup', 'PresentAddress', 'PermanentAddress', 'Hometown', 'District', 'Country', 'Facebook', 'GitHub', 'Twitter',
    'EmergencyName', 'EmergencyPhone', 'EmergencyRelation', 'AreasOfExpertise', 'CanMentor', 'LookingForJob', 'Hiring', 'Networking'
  ];
  
  const sampleRow1 = [
    'Rafiqul Islam', 'DIC-2020-101', '101', 'REG-2020-001', '2020', '2020', 'CSE', 'BSc CSE', 'A',
    '3.85', 'Alumni', 'BSc CSE', '2020-12-15', 'Brain Station 23', 'Software Engineer', 'Technology', 'Full-time',
    '4', 'React; Node.js; AWS', 'https://linkedin.com/in/rafiqul', 'https://rafiqul.dev', 'rafiqul@gmail.com', '+8801711223344', '+8801811223344', '1998-05-12', 'Male',
    'O+', 'Dhanmondi, Dhaka', 'Comilla', 'Comilla', 'Dhaka', 'Bangladesh', 'https://fb.com/rafiqul', 'https://github.com/rafiqul', 'https://x.com/rafiqul',
    'Abul Islam', '+8801911223344', 'Father', 'Software Architecture; Cloud', 'Yes', 'No', 'Yes', 'Yes'
  ];

  const sampleRow2 = [
    'Nusrat Jahan Rima', 'DIC-2020-102', '102', 'REG-2020-002', '2020', '2020', 'SWE', 'BSc SWE', 'B',
    '3.92', 'Alumni', 'BSc SWE', '2020-12-15', 'Pathao', 'Data Analyst', 'Tech', 'Full-time',
    '3', 'Python; SQL; Tableau', 'https://linkedin.com/in/nusrat', 'https://nusrat.io', 'nusrat.rima@gmail.com', '+8801722334455', '', '1999-02-20', 'Female',
    'AB+', 'Gulshan, Dhaka', 'Noakhali', 'Noakhali', 'Dhaka', 'Bangladesh', '', 'https://github.com/nusrat', '',
    'Mariam Begum', '+8801922334455', 'Mother', 'Data Science; Machine Learning', 'Yes', 'Yes', 'No', 'Yes'
  ];

  const csvContent = "data:text/csv;charset=utf-8," 
    + headers.join(",") + "\n" 
    + sampleRow1.join(",") + "\n" 
    + sampleRow2.join(",");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "sample_alumni_import_template.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('📥 Downloaded sample_alumni_import_template.csv');
}

function renderBulkImportPanel() {
  const el = document.getElementById('bulk-import-panel');
  if (!el) return;

  el.innerHTML = `
    <div class="glass-card">
      <div class="card-header">
        <div>
          <h3 class="card-title"><i data-lucide="download" class="ui-icon"></i> Bulk User Import &amp; Automatic Profile Generation</h3>
          <p style="font-size:12px;color:var(--text-secondary);margin-top:2px">Upload CSV or Excel files to import hundreds of student/alumni records simultaneously with automated login accounts &amp; email notifications.</p>
        </div>
        <button class="btn btn-outline btn-sm" onclick="downloadSampleImportCSV()"><i data-lucide="file-text" class="ui-icon"></i> Download CSV Template</button>
      </div>

      <!-- WIZARD STEPS INDICATOR -->
      <div class="import-wizard-steps">
        <div class="wizard-step-item ${currentImportState.step === 1 ? 'active' : ''}">
          <span class="wizard-step-num">1</span> <i data-lucide="folder" class="ui-icon"></i> Upload File
        </div>
        <div class="wizard-step-item ${currentImportState.step === 2 ? 'active' : ''}">
          <span class="wizard-step-num">2</span> <i data-lucide="search" class="ui-icon"></i> Validation Engine
        </div>
        <div class="wizard-step-item ${currentImportState.step === 3 ? 'active' : ''}">
          <span class="wizard-step-num">3</span> <i data-lucide="zap" class="ui-icon"></i> Preview &amp; Duplicates
        </div>
        <div class="wizard-step-item ${currentImportState.step === 4 ? 'active' : ''}">
          <span class="wizard-step-num">4</span> <i data-lucide="party-popper" class="ui-icon"></i> Accounts Created
        </div>
      </div>

      <div id="wizard-step-container">
        ${renderWizardStepContent()}
      </div>
    </div>

    <!-- HISTORICAL IMPORT AUDIT LOG -->
    <div class="glass-card mt-16">
      <div class="card-header">
        <h3 class="card-title"><i data-lucide="scroll-text" class="ui-icon"></i> Import Activity History &amp; Audit Trail</h3>
        <span class="card-badge teal">Write-Once System Log</span>
      </div>
      <div class="table-scroll">
        <table class="rbac-table">
          <thead>
            <tr><th>Batch ID</th><th>Filename</th><th>Total Records</th><th>Successful</th><th>Failed</th><th>Duplicates</th><th>Date &amp; Admin</th><th>Speed</th></tr>
          </thead>
          <tbody>
            ${importHistory.map(h => `
              <tr>
                <td><strong>${escapeHtml(h.batch_code)}</strong></td>
                <td><i data-lucide="file-text" class="ui-icon"></i> ${escapeHtml(h.filename)}</td>
                <td>${h.total_records}</td>
                <td><span class="card-badge teal">${h.success_count}</span></td>
                <td>${h.failed_count > 0 ? `<span class="card-badge amber">${h.failed_count}</span>` : '0'}</td>
                <td>${h.duplicate_count}</td>
                <td>${formatDate(h.created_at)} (${escapeHtml(h.admin_name)})</td>
                <td>${escapeHtml(h.processing_time)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderWizardStepContent() {
  if (currentImportState.step === 1) {
    return `
      <input type="file" id="import-file-input" accept=".csv,text/csv" style="display:none"
             onchange="handleImportFileSelected(this)" />
      <div class="dropzone" onclick="document.getElementById('import-file-input').click()">
        <div class="dropzone-icon"><i data-lucide="file-text" class="ui-icon"></i></div>
        <div class="dropzone-title">Click to choose a CSV file</div>
        <div class="dropzone-sub">Headers are detected and mapped automatically. Timestamp and
          &ldquo;Commicate with&rdquo; are excluded by default.</div>
      </div>

      <div class="field-grid-2" style="margin-top:16px">
        <div class="input-group">
          <label class="input-label">Initial Password Policy</label>
          <select class="form-select" id="password-strategy-select" onchange="currentImportState.strategy = this.value">
            <option value="generated">Generate a temporary password for this batch</option>
          </select>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
            The password is created when you confirm the import and shown to you once,
            on the next screen. Stored only as a scrypt hash; every imported account is
            flagged to change it on first login.
          </div>
        </div>
        <div class="input-group">
          <label class="input-label">If an account already exists</label>
          <select class="form-select" onchange="currentImportState.dupResolution = this.value">
            <option value="update">Update / enrich the existing profile (recommended)</option>
            <option value="skip">Skip the duplicate</option>
          </select>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
            Matched on email address, then mobile number.
          </div>
        </div>
      </div>

      <button class="btn btn-outline btn-full mt-16" onclick="downloadSampleImportCSV()"><i data-lucide="download" class="ui-icon"></i> Download a sample template</button>
    `;
  }

  // Column-mapping review — the administrator confirms every header before import.
  if (currentImportState.step === 'mapping') {
    const { headers, mapping, rawRows, totalRows, filename } = currentImportState;
    const mappedCount = mapping.filter(m => m !== 'ignore').length;
    const ignoredCount = mapping.filter(m => m === 'ignore').length;
    const hasName = mapping.includes('name');
    const hasEmail = mapping.includes('email');

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <div style="font-weight:700;font-size:14px"><i data-lucide="file-text" class="ui-icon"></i> ${escapeHtml(filename)} — ${totalRows} rows, ${headers.length} columns</div>
        <button class="btn btn-outline btn-sm" onclick="resetImportWizard()">← Choose a different file</button>
      </div>

      <div class="validation-summary-bar mb-16">
        <div class="vstat-card"><div class="vstat-num">${totalRows}</div><div class="vstat-label">Rows</div></div>
        <div class="vstat-card"><div class="vstat-num" style="color:var(--teal)">${mappedCount}</div><div class="vstat-label">Mapped</div></div>
        <div class="vstat-card"><div class="vstat-num" style="color:var(--text-muted)">${ignoredCount}</div><div class="vstat-label">Excluded</div></div>
      </div>

      ${(!hasName || !hasEmail) ? `<div class="login-error" style="margin-bottom:12px">Full Name and Email must both be mapped before importing.</div>` : ''}

      <div class="mapping-list">
        ${headers.map((h, i) => {
          const sample = ((rawRows[0] && rawRows[0][i]) || '').trim().slice(0, 40);
          const isIgnored = mapping[i] === 'ignore';
          return `
          <div class="mapping-row${isIgnored ? ' excluded' : ''}">
            <div class="mapping-col">
              <div class="mapping-header">${escapeHtml(h)}</div>
              <div class="mapping-sample">${sample ? 'e.g. ' + escapeHtml(sample) : 'empty'}</div>
            </div>
            <div class="mapping-arrow">→</div>
            <select class="form-select" onchange="setImportMapping(${i}, this.value)">
              ${IMPORT_FIELDS.map(f => `<option value="${f.key}" ${mapping[i] === f.key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
            </select>
          </div>`;
        }).join('')}
      </div>

      <button class="btn btn-primary btn-full mt-16" ${(!hasName || !hasEmail) ? 'disabled' : ''}
              onclick="validateImportRows()"><i data-lucide="check" class="ui-icon"></i> Confirm mapping and validate ${totalRows} rows</button>
    `;
  }

  if (currentImportState.step === 2 || currentImportState.step === 3) {
    const validCount = currentImportState.validRecords.length;
    const invalidCount = currentImportState.invalidRecords.length;
    const dupCount = currentImportState.duplicateRecords.length;

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-weight:700;font-size:14px;color:var(--text-primary)">
          <i data-lucide="file-text" class="ui-icon"></i> Parsed File: <strong>"${currentImportState.filename}"</strong> (${currentImportState.totalRows} Total Records)
        </div>
        <button class="btn btn-outline btn-sm" onclick="resetImportWizard()">← Upload Different File</button>
      </div>

      <!-- VALIDATION STATS -->
      <div class="validation-summary-bar">
        <div class="vstat-card"><div class="vstat-num">${currentImportState.totalRows}</div><div class="vstat-label">Total Rows</div></div>
        <div class="vstat-card"><div class="vstat-num" style="color:var(--teal)">${validCount}</div><div class="vstat-label">Valid Records</div></div>
        <div class="vstat-card"><div class="vstat-num" style="color:var(--amber)">${dupCount}</div><div class="vstat-label">Duplicates Found</div></div>
        <div class="vstat-card"><div class="vstat-num" style="color:var(--red)">${invalidCount}</div><div class="vstat-label">Validation Errors</div></div>
      </div>

      <!-- DUPLICATE RESOLUTION STRATEGY -->
      ${dupCount > 0 ? `
        <div class="duplicate-strategy-box">
          <div style="font-weight:700;color:var(--amber);margin-bottom:6px"><i data-lucide="triangle-alert" class="ui-icon"></i> ${dupCount} Duplicate Records Detected (Priority: StudentID &gt; Roll &gt; Email &gt; Phone)</div>
          <div style="display:flex;gap:16px;font-size:12px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="dup-strat" value="skip" checked onchange="currentImportState.dupResolution = this.value" />
              <span>Skip Duplicates (Recommended)</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="dup-strat" value="update" onchange="currentImportState.dupResolution = this.value" />
              <span>Update Existing Profiles</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="dup-strat" value="merge" onchange="currentImportState.dupResolution = this.value" />
              <span>Merge Records</span>
            </label>
          </div>
        </div>
      ` : ''}

      <!-- PREVIEW TABLE -->
      <div class="table-scroll" style="max-height:260px">
        <table class="rbac-table">
          <thead>
            <tr><th>Row</th><th>Full Name</th><th>Student ID</th><th>Email</th><th>Passing Year</th><th>Dept</th><th>Status</th><th>Validation Message</th></tr>
          </thead>
          <tbody>
            ${currentImportState.validRecords.map(r => `
              <tr>
                <td>#${r.row}</td>
                <td><strong>${r.name}</strong></td>
                <td>${r.studentId}</td>
                <td>${r.email}</td>
                <td>${r.year}</td>
                <td>${r.dept}</td>
                <td><span class="card-badge teal">Valid</span></td>
                <td style="color:var(--teal);font-size:11px"><i data-lucide="check" class="ui-icon"></i> Ready for Account Creation</td>
              </tr>
            `).join('')}
            ${currentImportState.duplicateRecords.map(r => `
              <tr>
                <td>#${r.row}</td>
                <td><strong>${r.name}</strong></td>
                <td>${r.studentId}</td>
                <td>${r.email}</td>
                <td>${r.year}</td>
                <td>${r.dept}</td>
                <td><span class="card-badge amber">Duplicate</span></td>
                <td style="color:var(--amber);font-size:11px"><i data-lucide="triangle-alert" class="ui-icon"></i> Matches existing alumni ID ${r.studentId}</td>
              </tr>
            `).join('')}
            ${currentImportState.invalidRecords.map(r => `
              <tr>
                <td>#${r.row}</td>
                <td><strong>${r.name || 'N/A'}</strong></td>
                <td>${r.studentId || 'Missing'}</td>
                <td>${r.email || 'Missing'}</td>
                <td>${r.year || 'N/A'}</td>
                <td>${r.dept || 'N/A'}</td>
                <td><span class="card-badge red">Invalid</span></td>
                <td style="color:var(--red);font-size:11px"><i data-lucide="circle-x" class="ui-icon"></i> ${r.errorMsg}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
        ${invalidCount > 0 ? `
          <button class="btn btn-outline btn-sm" onclick="downloadImportErrorReportCSV()"><i data-lucide="download" class="ui-icon"></i> Download Error Report (${invalidCount} rows)</button>
        ` : '<div></div>'}
        <button class="btn btn-primary" onclick="executeBulkImportProcess()"><i data-lucide="rocket" class="ui-icon"></i> Confirm &amp; Create ${validCount} Accounts →</button>
      </div>
    `;
  }

  if (currentImportState.step === 4) {
    return `
      <div style="text-align:center;padding:24px 0">
        <div style="font-size:48px;margin-bottom:8px"><i data-lucide="party-popper" class="ui-icon"></i></div>
        <h2 style="color:var(--teal);font-size:22px;font-weight:800">Bulk Import &amp; Profile Generation Complete!</h2>
        <p style="color:var(--text-secondary);font-size:13px;max-width:500px;margin:8px auto 20px">
          Successfully created <strong>${currentImportState.validRecords.length} User Accounts &amp; Alumni Profiles</strong> in the database.
        </p>

        ${currentImportState.lastResult?.temporaryPassword ? `
          <div style="max-width:520px;margin:0 auto 20px;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);text-align:left">
            <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;color:var(--text-primary)">
              <i data-lucide="key-round" class="ui-icon"></i> Temporary password for this batch
            </div>
            <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;font-weight:700;letter-spacing:1px;margin:10px 0;color:var(--teal);user-select:all">${esc(currentImportState.lastResult.temporaryPassword)}</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">
              Every account created by this import signs in with this password once, then
              has to choose their own. It is shown here only — it is not stored anywhere
              you can read it back, and leaving this screen loses it. Copy it now.
            </div>
          </div>
        ` : ''}

        <div style="display:inline-flex;gap:12px;justify-content:center">
          <button class="btn btn-primary" onclick="showPage('directory')"><i data-lucide="users" class="ui-icon"></i> View Alumni Directory</button>
          <button class="btn btn-outline" onclick="resetImportWizard()"><i data-lucide="download" class="ui-icon"></i> Import Another File</button>
        </div>
      </div>
    `;
  }
}


function resetImportWizard() {
  Object.assign(currentImportState, {
    step: 1, filename: '', totalRows: 0,
    headers: [], rawRows: [], mapping: [],
    validRecords: [], invalidRecords: [], duplicateRecords: [], lastResult: null
  });
  const input = document.getElementById('import-file-input');
  if (input) input.value = '';
  renderBulkImportPanel();
}

function downloadImportErrorReportCSV() {
  const headers = ['RowNumber', 'Name', 'StudentID', 'Email', 'ErrorType', 'SuggestedFix'];
  const rows = currentImportState.invalidRecords.map(r => [
    r.row, `"${r.name || ''}"`, `"${r.studentId || ''}"`, `"${r.email || ''}"`, `"${r.errorMsg}"`, '"Provide required valid Student ID, Email, and Full Name"'
  ]);

  const csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n" + rows.map(e => e.join(",")).join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "bulk_import_error_report.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('📥 Downloaded bulk_import_error_report.csv');
}

// Sends the parsed rows to POST /api/bulk-import, which inserts real users +
// alumni_profiles and writes an import_history audit row. This previously
// pushed objects into an in-memory array, which is why import_history stayed
// empty even though the endpoint worked.
async function executeBulkImportProcess() {
  currentImportState.step = 4;

  // Maximum retention: send the in-file duplicates as well. The server matches
  // them to the existing account and enriches that profile instead of dropping
  // the second submission on the floor.
  const records = [...currentImportState.validRecords, ...currentImportState.duplicateRecords];
  const startedAt = Date.now();

  showToast(`⏳ Importing ${records.length} record${records.length === 1 ? '' : 's'} into PostgreSQL…`);

  const result = await API.postBulkImport({
    records,
    filename: currentImportState.filename,
    adminName: state.currentUser ? state.currentUser.name : 'Admin',
    dupResolution: currentImportState.dupResolution,
    failedCount: currentImportState.invalidRecords.length,
    duplicateCount: currentImportState.duplicateRecords.length,
    processingTime: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  });

  if (!result || result.error) {
    currentImportState.step = 3;
    renderBulkImportPanel();
    showToast(`⚠ Import failed: ${result?.error || 'the server did not respond.'}`);
    return;
  }

  // Keep the server's own tallies — the client's in-file counts do not include
  // duplicates found against existing accounts.
  currentImportState.lastResult = result;

  loadImportHistory(); // re-renders the panel including the new audit row
  showToast(`🎉 Import complete — ${result.created} created, ${result.updated} updated, ` +
            `${result.skipped} duplicates skipped, ${result.rejected} rejected.`);

  // Reflect the new alumni immediately wherever they appear.
  state.directory.offset = 0;
  renderAlumniGrid();
}

// ─── 5. ADMIN DYNAMIC CUSTOM FIELD MANAGER ───────────────────
/* MOCK_CUSTOM_FIELDS duplicated the three rows already in the custom_fields
   table. The admin manager and the profile both read the table now. */


// ─── CUSTOM FIELDS ───
async function renderCustomFieldManager() {
  const el = document.getElementById('custom-field-manager');
  if (!el) return;

  const fields = await API.getCustomFields();
  if (apiFailed(fields)) {
    el.innerHTML = renderErrorState(fields?.error || 'Could not load custom fields.', 'renderCustomFieldManager()');
    return;
  }

  el.innerHTML = `
    <form onsubmit="handleCreateCustomField(event)" class="custom-field-form">
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label">Field Label</label>
          <input type="text" id="cf-label" class="form-input" placeholder="e.g. LinkedIn Headline" required /></div>
        <div class="input-group"><label class="input-label">Section</label>
          <select id="cf-section" class="form-select">
            <option value="academic">Academic</option><option value="professional">Professional</option>
            <option value="contact">Contact</option><option value="personal">Personal</option>
          </select></div>
      </div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label">Field Type</label>
          <select id="cf-type" class="form-select">
            <option value="text">Text</option><option value="number">Number</option>
            <option value="date">Date</option><option value="select">Dropdown</option>
            <option value="url">URL</option>
          </select></div>
        <div class="input-group" style="display:flex;align-items:flex-end">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:48px;cursor:pointer">
            <input type="checkbox" id="cf-required" /> Required field
          </label></div>
      </div>
      <button type="submit" class="btn btn-primary btn-full"><i data-lucide="plus" class="ui-icon"></i> Add Custom Field</button>
    </form>
    <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">
      ${fields.length ? fields.map(f => `
        <div class="custom-field-row">
          <div class="vault-icon"><i data-lucide="puzzle" class="ui-icon"></i></div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13px">${escapeHtml(f.label)}${f.is_required ? ' <span style="color:var(--red)">*</span>' : ''}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(f.section)} · ${escapeHtml(f.field_type)} · <span style="font-family:monospace;font-size:11px">${escapeHtml(f.id)}</span></div>
          </div>
          <button class="btn btn-sm btn-ghost" onclick="deleteCustomField('${escapeHtml(f.id)}', '${escapeHtml(f.label).replace(/'/g, '&#39;')}')"><i data-lucide="trash-2" class="ui-icon"></i></button>
        </div>`).join('')
      : renderEmptyState('<i data-lucide="puzzle" class="ui-icon"></i>', 'No custom fields yet', 'Add schema fields without a code change.')}
    </div>`;
}

async function handleCreateCustomField(e) {
  if (e) e.preventDefault();
  const res = await API.createCustomField({
    label: document.getElementById('cf-label').value.trim(),
    section: document.getElementById('cf-section').value,
    fieldType: document.getElementById('cf-type').value,
    isRequired: document.getElementById('cf-required').checked
  });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not create the field.'}`); return; }
  showToast(`✅ Custom field "${res.label}" added.`);
  renderCustomFieldManager();
}

async function deleteCustomField(id, label) {
  if (!confirm(`Delete the custom field "${label}"?`)) return;
  const res = await API.deleteCustomFieldApi(id);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not delete.'}`); return; }
  showToast('🗑 Custom field deleted.');
  renderCustomFieldManager();
}
/* renderProfileCustomFields() moved to profile.js: it renders Section 8 of an
   alumnus's own profile, so it is alumni-facing, and the alumni site no longer
   loads this file. The admin-side custom field manager above stays here. */

let _segmentOptions = null;

async function renderSegmentationPanel() {
  const el = document.getElementById('segmentation-panel');
  if (!el) return;

  el.innerHTML = '<div class="glass-card"><div style="padding:16px;color:var(--text-muted);font-size:12px">Loading…</div></div>';
  const opt = await API.getSegmentOptions();

  if (apiFailed(opt)) {
    el.innerHTML = `<div class="glass-card">${renderErrorState(
      opt?.error || 'Could not load segmentation options.', 'renderSegmentationPanel()')}</div>`;
    return;
  }
  _segmentOptions = opt;

  if (!opt.total) {
    el.innerHTML = `<div class="glass-card">${renderEmptyState(
      '<i data-lucide="target" class="ui-icon"></i>', 'No alumni profiles to segment',
      'Filters and counts appear here once alumni profiles exist.')}</div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  const years = opt.batches.map(b => `<option value="${b}">${b}</option>`).join('');
  el.innerHTML = `
    <div class="glass-card">
      <div class="card-header">
        <h3 class="card-title"><i data-lucide="target" class="ui-icon"></i> Alumni Audience Segmentation</h3>
        <span class="card-badge teal">${opt.total.toLocaleString('en-IN')} profiles</span>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px">
        Every option below is a value that exists in the data. Batches run
        ${opt.min_batch}–${opt.max_batch}; ${opt.mentors} profile(s) offer mentoring and
        ${opt.donors} account(s) have a settled donation.
      </p>
      <div class="segment-builder">
        <div class="input-group">
          <label class="input-label">Batch from</label>
          <select class="form-select" id="seg-batch-from" onchange="updateSegmentCount()">
            <option value="">Any</option>${years}
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Batch to</label>
          <select class="form-select" id="seg-batch-to" onchange="updateSegmentCount()">
            <option value="">Any</option>${years}
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Department</label>
          <select class="form-select" id="seg-dept" onchange="updateSegmentCount()">
            <option value="all">All departments</option>
            ${opt.departments.map(d => `<option value="${escapeHtml(d.department)}">${escapeHtml(d.department)} (${d.n})</option>`).join('')}
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Industry</label>
          <select class="form-select" id="seg-industry" onchange="updateSegmentCount()">
            <option value="all">All industries</option>
            ${opt.industries.map(i => `<option value="${escapeHtml(i.industry)}">${escapeHtml(i.industry)} (${i.n})</option>`).join('')}
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Donation history</label>
          <select class="form-select" id="seg-donor" onchange="updateSegmentCount()">
            <option value="all">Any donor status</option>
            <option value="donors">Has a settled donation</option>
            <option value="nondonors">No settled donation</option>
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Mentoring</label>
          <select class="form-select" id="seg-mentor" onchange="updateSegmentCount()">
            <option value="">Anyone</option>
            <option value="true">Offers mentoring</option>
          </select>
        </div>
      </div>
      <div style="margin-top:16px;padding:12px;background:var(--bg-glass);border-radius:var(--radius-sm)">
        <div><strong style="color:var(--teal)">Segment:</strong>
          <span id="segment-count-val">${opt.total.toLocaleString('en-IN')}</span>
          of ${opt.total.toLocaleString('en-IN')} alumni profiles
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px" id="segment-query"></div>
      </div>
      <!-- The broadcast composer targets a role and optionally one batch; it
           cannot take an arbitrary segment, so this says so rather than
           implying the filters above carry over. -->
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="showBroadcastModal()"><i data-lucide="megaphone" class="ui-icon"></i> Open broadcast composer</button>
        <span style="font-size:11px;color:var(--text-muted)">A broadcast targets a role and optionally one batch, not this segment.</span>
      </div>
    </div>
  `;
  if (window.lucide) lucide.createIcons();
  updateSegmentCount();
}

async function updateSegmentCount() {
  const out = document.getElementById('segment-count-val');
  const desc = document.getElementById('segment-query');
  if (!out) return;

  const v = (id) => document.getElementById(id)?.value || '';
  const q = {
    batchFrom: v('seg-batch-from'), batchTo: v('seg-batch-to'),
    department: v('seg-dept'), industry: v('seg-industry'),
    donor: v('seg-donor'), mentor: v('seg-mentor')
  };
  Object.keys(q).forEach(k => { if (!q[k] || q[k] === 'all') delete q[k]; });

  out.textContent = '…';
  const res = await API.getSegmentCount(q);
  if (apiFailed(res)) { out.textContent = '—'; if (desc) desc.textContent = 'Count unavailable.'; return; }

  out.textContent = res.matched.toLocaleString('en-IN');
  if (desc) {
    const parts = Object.entries(q).map(([k, val]) => `${k}=${val}`);
    desc.textContent = 'COUNT over users JOIN alumni_profiles' +
      (parts.length ? ' WHERE ' + parts.join(' AND ') : ' with no filter applied');
  }
}


// ─── 9. MODERATION QUEUE & APPROVAL WORKFLOW ─────────────────
async function renderModerationPanel() {
  const el = document.getElementById('moderation-panel');
  if (!el) return;

  let pendingChapters = [];
  let pendingStories = [];

  if (typeof API !== 'undefined') {
    const queue = await API.getModerationQueue();
    if (queue) {
      pendingChapters = queue.pendingChapters || [];
      pendingStories = queue.pendingStories || [];
    }
  }

  el.innerHTML = `
    <div class="glass-card mb-16">
      <div class="card-header">
        <h3 class="card-title"><i data-lucide="school" class="ui-icon"></i> Pending Chapter Creation Approvals (${pendingChapters.length})</h3>
        <span class="card-badge ${pendingChapters.length > 0 ? 'amber' : 'teal'}">${pendingChapters.length} Pending Review</span>
      </div>
      ${pendingChapters.length === 0 ? `
        <div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px"><i data-lucide="check" class="ui-icon"></i> No pending chapter review requests at this time.</div>
      ` : `
        <div class="table-scroll">
          <table class="rbac-table">
            <thead>
              <tr><th>Icon</th><th>Chapter Name</th><th>Type</th><th>Description</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${pendingChapters.map(c => `
                <tr>
                  <td style="font-size:20px">${emojiIcon(c.icon, 'hexagon')}</td>
                  <td><strong>${c.name}</strong></td>
                  <td><span class="card-badge teal">${c.type}</span></td>
                  <td style="font-size:12px;color:var(--text-secondary)">${c.description || 'No description provided'}</td>
                  <td>
                    <div style="display:flex;gap:6px">
                      <button class="btn btn-sm btn-primary" onclick="handleModerateChapter(${c.id}, 'approve')">Approve <i data-lucide="check" class="ui-icon"></i></button>
                      <button class="btn btn-sm btn-danger" onclick="handleModerateChapter(${c.id}, 'reject')">Reject <i data-lucide="x" class="ui-icon"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>

    <div class="glass-card">
      <div class="card-header">
        <h3 class="card-title"><i data-lucide="pen-line" class="ui-icon"></i> Pending Story &amp; News Approvals (${pendingStories.length})</h3>
        <span class="card-badge ${pendingStories.length > 0 ? 'amber' : 'teal'}">${pendingStories.length} Pending Review</span>
      </div>
      ${pendingStories.length === 0 ? `
        <div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px"><i data-lucide="check" class="ui-icon"></i> No pending story moderation requests at this time.</div>
      ` : `
        <div class="table-scroll">
          <table class="rbac-table">
            <thead>
              <tr><th>Emoji</th><th>Headline</th><th>Category</th><th>Author</th><th>Excerpt</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${pendingStories.map(s => `
                <tr>
                  <td style="font-size:20px">${s.emoji || '<i data-lucide="sparkle" class="ui-icon"></i>'}</td>
                  <td><strong>${s.title}</strong></td>
                  <td><span class="card-badge indigo">${s.category}</span></td>
                  <td>${s.author_name}</td>
                  <td style="font-size:12px;color:var(--text-secondary)">${s.excerpt}</td>
                  <td>
                    <div style="display:flex;gap:6px">
                      <button class="btn btn-sm btn-primary" onclick="handleModerateStory(${s.id}, 'approve')">Approve <i data-lucide="check" class="ui-icon"></i></button>
                      <button class="btn btn-sm btn-danger" onclick="handleModerateStory(${s.id}, 'reject')">Reject <i data-lucide="x" class="ui-icon"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

async function handleModerateStory(id, action) {
  if (typeof API !== 'undefined') {
    await API.moderateStory(id, action);
  }
  showToast(`✅ Story ${action === 'approve' ? 'Approved & Published to News Feed' : 'Rejected'}`);
  renderModerationPanel();
  renderNewsFeed();
}

// ─── ADMIN SWITCHER UPDATE ───────────────────────────────────
const _origSwitchAdmin = switchAdmin;
switchAdmin = function(tab, btn) {
  document.querySelectorAll('.admin-tabs .chart-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const sections = ['rbac', 'audit', 'compliance', 'nidvault', 'tenants', 'offlinesync', 'broadcast', 'bulkimport', 'customfields', 'moderation', 'segmentation'];
  sections.forEach(s => {
    const el = document.getElementById(`admin-${s}`);
    if (el) el.classList.add('hidden');
  });

  const target = document.getElementById(`admin-${tab}`);
  if (target) target.classList.remove('hidden');

  if (tab === 'nidvault') renderNIDVaultPanel();
  if (tab === 'bulkimport') renderBulkImportPanel();
  if (tab === 'customfields') renderCustomFieldManager();
  if (tab === 'moderation') renderModerationPanel();
  if (tab === 'segmentation') renderSegmentationPanel();
  if (tab === 'offlinesync') renderOfflineSyncPanel();
  if (tab === 'broadcast') renderBroadcastHistory();
};


/* ============================================================
   v2 ACTION HANDLERS
   Replace the toast-only stubs (buyTicket, applyJob, simulateCheckin,
   acceptRequest, sendBroadcast, exportUserData, downloadReceipt,
   decryptVaultField, showDeleteAccount, downloadEventReport …) with calls
   to the real endpoints.
   ============================================================ */

// Canonical system fields the importer can populate. `ignore` marks columns
// that must never reach a profile.
const IMPORT_FIELDS = [
  { key: 'ignore',         label: '— Do not import —' },
  { key: 'name',           label: 'Full Name',                       required: true },
  { key: 'email',          label: 'Email Address',                   required: true },
  { key: 'mobile',         label: 'Mobile Number' },
  { key: 'hscPassingYear', label: 'HSC Passing Year / Batch' },
  { key: 'hscGroup',       label: 'HSC Group' },
  { key: 'hscVersion',     label: 'HSC Version' },
  { key: 'bloodGroup',     label: 'Blood Group' },
  { key: 'presentAddress', label: 'Present Address' },
  { key: 'occupation',     label: 'Occupation' },
  { key: 'organization',   label: 'Current Organization / Institution' },
  { key: 'designation',    label: 'Current Designation' },
  { key: 'photoUrl',       label: 'Profile Photo URL' },
  { key: 'facebook',       label: 'Facebook Profile Link' }
];

// Header patterns -> system field. Anything unmatched defaults to "do not
// import", so a new column can never silently land in the wrong place.
const HEADER_RULES = [
  [/^timestamp$/i,                                   'ignore'],
  [/^comm?[ui]nicate\s*with$/i,                      'ignore'],  // CSV header is misspelled "Commicate with"
  [/^(full\s*)?name$/i,                              'name'],
  [/e-?mail/i,                                       'email'],
  [/(mobile|phone|contact\s*number)/i,               'mobile'],
  [/hsc.*(pass|year|batch)|(^|\s)batch(\s|$)/i,      'hscPassingYear'],
  [/^group\s*$|hsc\s*group/i,                        'hscGroup'],
  [/version|medium/i,                                'hscVersion'],
  [/blood/i,                                         'bloodGroup'],
  [/(present|current)\s*address|^address$/i,         'presentAddress'],
  [/occupation|profession/i,                         'occupation'],
  [/institution|organization|organisation|company|workplace/i, 'organization'],
  [/designation|job\s*title|position/i,              'designation'],
  [/photo|image|picture/i,                           'photoUrl'],
  [/facebook|fb\s*profile/i,                         'facebook']
];

function autoMapHeader(header) {
  const h = (header || '').trim();
  for (const [pattern, field] of HEADER_RULES) if (pattern.test(h)) return field;
  return 'ignore';
}

// RFC 4180 parser: handles quoted fields, embedded commas/newlines and "" escapes.
function parseCSVText(text) {
  const rows = [];
  let row = [], cur = '', quoted = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

// Mirrors the server normaliser so the preview shows what will actually be stored.
function sanitizeEmailClient(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase().replace(/[\u00a0\s]+/g, " ");
  const tokens = s.split(" ").filter(Boolean);
  const token = tokens.find(t => t.includes("@"));
  const looksValid = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v || "");
  if (token && tokens.length > 1 && looksValid(token)) return token;
  s = s.replace(/\s+/g, "").replace(/^mailto:/, "").replace(/[,;]+$/, "");
  return s || null;
}

function normalizeBloodGroupClient(raw) {
  if (!raw || !String(raw).trim()) return null;
  let s = String(raw).trim().toUpperCase().replace(/[()'`.\s]/g, '');
  s = s.replace(/POSSATIVE|POSITIVE|POSITIVR|POSTIVE|POS(?![A-Z])|PLUS/g, '+')
       .replace(/NEGATIVE|NEGETIVE|NEG(?![A-Z])|MINUS/g, '-')
       .replace(/VE$/, '')
       .replace(/^0/, 'O')
       .replace(/ABB/g, 'AB')
       .replace(/\++/g, '+').replace(/-+/g, '-');
  const letters = (s.match(/AB|A|B|O/) || [])[0];
  if (!letters) return 'Unknown';
  const sign = s.includes('+') ? '+' : (s.includes('-') ? '-' : null);
  if (!sign) return 'Unknown';   // never guess a rhesus factor
  const candidate = letters + sign;
  return ['A+','A-','B+','B-','AB+','AB-','O+','O-'].includes(candidate) ? candidate : 'Unknown';
}

function handleImportFileSelected(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  if (!/\.(csv|txt)$/i.test(file.name)) {
    showToast('⚠ Please choose a .csv file. XLSX is not supported yet — export it to CSV first.');
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => showToast('⚠ Could not read the file.');
  reader.onload = () => {
    try {
      const rows = parseCSVText(String(reader.result));
      if (rows.length < 2) { showToast('⚠ The file has no data rows.'); return; }

      currentImportState.filename = file.name;
      currentImportState.headers = rows[0].map(h => h.trim());
      currentImportState.rawRows = rows.slice(1);
      currentImportState.totalRows = rows.length - 1;
      currentImportState.mapping = currentImportState.headers.map(autoMapHeader);
      currentImportState.step = 'mapping';

      renderBulkImportPanel();
      showToast(`📄 Parsed "${file.name}" — ${currentImportState.totalRows} rows, ${currentImportState.headers.length} columns.`);
    } catch (e) {
      showToast('⚠ Could not parse the CSV: ' + e.message);
    }
  };
  reader.readAsText(file);
}

function setImportMapping(colIndex, fieldKey) {
  currentImportState.mapping[colIndex] = fieldKey;
  renderBulkImportPanel();
}

// Applies the mapping, then validates and classifies every row.
function validateImportRows() {
  const { headers, rawRows, mapping } = currentImportState;
  const valid = [], invalid = [], duplicates = [];
  const seenEmail = new Set(), seenMobile = new Set();

  rawRows.forEach((cells, i) => {
    const rec = { row: i + 2 };   // +2: 1-based, and row 1 is the header
    mapping.forEach((field, col) => {
      if (field === 'ignore') return;
      rec[field] = (cells[col] || '').trim();
    });

    // Maximum-retention policy: blank optional fields are stored as NULL and
    // never block a row. Only a record that cannot be identified or saved at
    // all is rejected — email is UNIQUE NOT NULL and is the login identifier.
    rec.emailRaw = rec.email;
    rec.email = sanitizeEmailClient(rec.email) || '';

    // A non-4-digit year is dropped rather than failing the row.
    if (rec.hscPassingYear && !/^\d{4}$/.test(rec.hscPassingYear)) {
      rec.hscPassingYearRaw = rec.hscPassingYear;
      rec.hscPassingYear = '';
    }

    const errors = [];
    if (!rec.name) errors.push('Missing name — cannot identify the person');
    if (!rec.email) errors.push('Missing email — required as the unique login identifier');
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(rec.email))
      errors.push('Email could not be recovered: "' + rec.emailRaw + '"');

    if (errors.length) { invalid.push({ ...rec, errorMsg: errors.join(' · ') }); return; }

    // Count blanks for the import summary.
    rec._missing = ['mobile','hscPassingYear','hscGroup','hscVersion','bloodGroup',
                    'presentAddress','occupation','organization','designation',
                    'photoUrl','facebook'].filter(f => !rec[f] || !String(rec[f]).trim());

    const emailKey = rec.email.toLowerCase();
    const mobileKey = (rec.mobile || '').replace(/\D/g, '').slice(-10);
    if (seenEmail.has(emailKey) || (mobileKey && seenMobile.has(mobileKey))) {
      // Same person submitted twice. Keep the later row so its data can enrich
      // the existing profile rather than being thrown away.
      duplicates.push({ ...rec, errorMsg: 'Same person as an earlier row (merged, not discarded)' });
      return;
    }
    seenEmail.add(emailKey);
    if (mobileKey) seenMobile.add(mobileKey);

    rec.bloodGroupNormalized = normalizeBloodGroupClient(rec.bloodGroup);
    valid.push(rec);
  });

  currentImportState.validRecords = valid;
  currentImportState.invalidRecords = invalid;
  currentImportState.duplicateRecords = duplicates;
  currentImportState.step = 2;
  renderBulkImportPanel();
  showToast(`🔍 Validated: ${valid.length} valid · ${duplicates.length} duplicates · ${invalid.length} errors`);
}

/* ============================================================
   SIGN UP  —  the app previously offered sign-in only, so an alumnus who
   was not bulk imported had no route into the system.
   ============================================================ */
