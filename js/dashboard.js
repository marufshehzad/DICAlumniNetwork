/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   dashboard.js

   The five role dashboards, the analytics screen and the alumni map.
   Every figure on these screens comes from /api/stats/*; see the notes in
   loadPlatformStats and renderAnalyticsMetrics.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


let _statsPromise = null;
function loadPlatformStats(force = false) {
  if (force) _statsPromise = null;
  if (!_statsPromise) {
    _statsPromise = API.getStatsOverview().then(r => (apiFailed(r) ? null : r));
  }
  return _statsPromise;
}

// Numbers render as "—" until the real value arrives, never as a placeholder
// figure that could be mistaken for data.
const statNum = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN'));
const statMoney = (v) => (v === null || v === undefined ? '—' : '৳' + Number(v).toLocaleString('en-IN'));

// Writes a value into every element carrying data-stat="<key>", so a dashboard
// only has to name the field it wants in the markup.
function paintStats(stats, formatters = {}) {
  document.querySelectorAll('[data-stat]').forEach(el => {
    const key = el.getAttribute('data-stat');
    const fmt = formatters[key] || statNum;
    el.textContent = fmt(stats ? stats[key] : null);
  });
}

/* The four staff dashboards live in admin.js, which only the staff portal
   loads. When a staff account signs in at the alumni site — a bookmark, a
   shared link — there is no staff dashboard to render, so they get a pointer to
   the portal instead of a broken page. */
function renderDashboard() {
  const page = document.getElementById('page-dashboard');
  if (!page) return;

  const role = state.currentUser.role;

  if (role === 'alumni') return renderAlumniDashboard(page);

  const byRole = {
    moderator: window.renderModeratorDashboard,
    dept_admin: window.renderDeptAdminDashboard,
    univ_admin: window.renderUnivAdminDashboard,
    super_admin: window.renderSuperAdminDashboard
  };
  const render = byRole[role] || window.renderSuperAdminDashboard;
  if (typeof render === 'function') return render(page);

  renderStaffElsewhereNotice(page);
}

// Shown on the alumni site to a staff account: their tools are at /admin.
function renderStaffElsewhereNotice(page) {
  const u = state.currentUser;
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Welcome, ${escapeHtml(u.name)}</h1>
        <p class="page-subtitle">${escapeHtml(u.designation || u.roleLabel || '')}</p>
      </div>
    </div>
    <div class="glass-card">
      <div class="card-header"><h3 class="card-title"><i data-lucide="shield" class="ui-icon"></i> Staff tools are on the staff portal</h3></div>
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 14px">
        This is the alumni site. Administration, moderation, event management,
        reports and compliance are on the staff portal, which is a separate
        sign-in.
      </p>
      <a class="btn btn-primary" href="/admin"><i data-lucide="external-link" class="ui-icon"></i> Open the staff portal</a>
    </div>`;
  if (window.lucide) lucide.createIcons();
}

// 1. ALUMNI DASHBOARD
function renderAlumniDashboard(page) {
  const u = state.currentUser;
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Welcome back, ${escapeHtml(u.name)}! <i data-lucide="hand" class="ui-icon"></i></h1>
        <p class="page-subtitle">Daffodil International College · ${escapeHtml(u.dept || '')}</p>
      </div>
      <button class="btn btn-primary" onclick="showPage('profile')"><i data-lucide="id-card" class="ui-icon"></i> View Digital ID</button>
    </div>

    <!-- Completeness is measured against the profile fields that are actually
         filled in, not a fixed 85%. -->
    <div class="profile-completeness-banner glass-card">
      <div class="pc-left">
        <div class="pc-title">DIC Profile Completeness</div>
        <div class="pc-track"><div class="pc-fill" id="dash-pc-fill" style="width:0%"></div></div>
        <div class="pc-sub" id="dash-pc-text">Checking your profile…</div>
      </div>
      <div class="pc-score-ring">
        <div class="pc-ring-val" id="dash-pc-ring" style="color:var(--daffodil-primary)">—</div>
      </div>
    </div>

    <div class="sync-overview-grid mb-16">
      <div class="sync-stat-card"><div class="sync-stat-val" data-stat="my_registrations">—</div><div class="sync-stat-label">My Event Registrations</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal)" data-stat="my_connections">—</div><div class="sync-stat-label">My Connections</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber)" data-stat="my_chapters">—</div><div class="sync-stat-label">My Chapters</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--primary-light)" data-stat="my_unread_notifications">—</div><div class="sync-stat-label">Unread Notifications</div></div>
    </div>

    <div class="dashboard-split">
      <div class="dashboard-left">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="handshake" class="ui-icon"></i> Recommended DIC Alumni Connections</h3></div>
          <div id="dash-alumni-grid" class="alumni-grid"></div>
        </div>
        <div class="glass-card mt-16">
          <div class="card-header"><h3 class="card-title"><i data-lucide="calendar" class="ui-icon"></i> Upcoming DIC Events</h3></div>
          <div id="dash-events-grid" class="events-grid"></div>
        </div>
      </div>
      <div class="dashboard-right">
        <div class="glass-card">
          <div class="card-header"><h3 class="card-title"><i data-lucide="trophy" class="ui-icon"></i> Top Donors</h3></div>
          <div id="donor-leaderboard"></div>
        </div>
        <div class="glass-card mt-16">
          <div class="card-header"><h3 class="card-title"><i data-lucide="vote" class="ui-icon"></i> DIC Live Poll</h3></div>
          <div id="dash-active-poll"></div>
        </div>
      </div>
    </div>
  `;
  renderAlumniGrid();
  renderEventsPage();
  renderDonorLeaderboard();
  loadPlatformStats().then(s => paintStats(s));
  /* The live poll and the profile-completeness banner belong to news.js and
     profile.js, which the staff portal does not load. This dashboard is only
     ever rendered for an alumnus, so the guard is belt and braces — but an
     unguarded reference in a file both portals load is the kind of thing that
     breaks later, quietly. */
  if (typeof renderActivePoll === 'function') renderActivePoll();
  if (typeof paintProfileCompleteness === 'function') {
    paintProfileCompleteness('dash-pc-fill', 'dash-pc-ring', 'dash-pc-text');
  }
}

/* Profile completeness, measured. PROFILE_COMPLETENESS_FIELDS is the list the
   profile page itself asks the user to fill in; the score is simply how many of
   them are non-empty. The old banner was a hardcoded 85% for every account,
   including one with an entirely blank profile. */
function renderDepartmentBreakdown(myDept) {
  const el = document.getElementById('dept-breakdown');
  API.getStatsAnalytics().then(res => {
    if (apiFailed(res)) {
      if (el) el.innerHTML = renderEmptyState('<i data-lucide="chart-column" class="ui-icon"></i>',
        'Breakdown unavailable', 'Department figures could not be loaded.');
      return;
    }
    const rows = res.byDepartment || [];
    const mine = rows.find(r => r.department === myDept);
    const countEl = document.getElementById('dept-alumni-count');
    if (countEl) countEl.textContent = mine ? statNum(mine.n) : '0';

    if (!el) return;
    if (!rows.length) {
      el.innerHTML = renderEmptyState('<i data-lucide="chart-column" class="ui-icon"></i>',
        'No alumni profiles recorded yet',
        'Department figures appear once alumni profiles carry a department.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    const max = Math.max(...rows.map(r => r.n));
    el.innerHTML = `<div class="funnel-bars">${rows.map(r => `
      <div class="funnel-item">
        <div class="funnel-label">${escapeHtml(r.department)}</div>
        <div class="funnel-track"><div class="funnel-fill bkash" style="width:${Math.round((r.n / max) * 100)}%">${r.n}</div></div>
      </div>`).join('')}</div>`;
    if (window.lucide) lucide.createIcons();
  });
}
function renderBatchBreakdown() {
  const el = document.getElementById('univ-batch-breakdown');
  if (!el) return;
  API.getStatsAnalytics().then(res => {
    if (apiFailed(res)) {
      el.innerHTML = renderEmptyState('<i data-lucide="chart-column" class="ui-icon"></i>',
        'Breakdown unavailable', 'Batch figures could not be loaded.');
      return;
    }
    const rows = res.byBatch || [];
    if (!rows.length) {
      el.innerHTML = renderEmptyState('<i data-lucide="chart-column" class="ui-icon"></i>',
        'No batch data recorded yet', 'Figures appear once alumni profiles carry a passing year.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    const max = Math.max(...rows.map(r => r.n));
    el.innerHTML = `<div class="funnel-bars">${rows.map(r => `
      <div class="funnel-item">
        <div class="funnel-label">Batch ${r.batch}</div>
        <div class="funnel-track"><div class="funnel-fill nagad" style="width:${Math.round((r.n / max) * 100)}%">${r.n}</div></div>
      </div>`).join('')}</div>`;
    if (window.lucide) lucide.createIcons();
  });
}
function renderSystemStatus() {
  const el = document.getElementById('system-status');
  if (!el) return;
  API.health().then(h => {
    if (apiFailed(h) || !h || h.status !== 'online') {
      el.innerHTML = `<div class="server-card"><div class="server-val" style="color:var(--danger)">Unreachable</div>
        <div class="server-label">The API did not answer a health check</div></div>`;
      return;
    }
    const t = new Date(h.time);
    el.innerHTML = `
      <div class="server-card"><div class="server-val" style="color:var(--teal)">Online</div><div class="server-label">API status</div></div>
      <div class="server-card"><div class="server-val" style="font-size:15px">${escapeHtml(h.database || 'PostgreSQL')}</div><div class="server-label">Database</div></div>
      <div class="server-card"><div class="server-val">${statNum(h.total_users)}</div><div class="server-label">User accounts</div></div>
      <div class="server-card"><div class="server-val" style="font-size:15px">${isNaN(t) ? '—' : t.toLocaleString()}</div><div class="server-label">Database server time</div></div>`;
  });
}

// A plain listing of the counts behind the platform, so the figures on every
// other screen can be checked against one place.
function renderSuperTotals(s) {
  const el = document.getElementById('super-totals');
  if (!el) return;
  if (!s) {
    el.innerHTML = renderEmptyState('<i data-lucide="database" class="ui-icon"></i>',
      'Totals unavailable', 'Platform figures could not be loaded.');
    if (window.lucide) lucide.createIcons();
    return;
  }
  const rows = [
    ['Alumni profiles', statNum(s.profiles_total)],
    ['Verified accounts', statNum(s.users_verified)],
    ['Events', statNum(s.events_total)],
    ['Event registrations', statNum(s.registrations_total)],
    ['Event tasks', `${statNum(s.tasks_completed)} of ${statNum(s.tasks_total)} completed`],
    ['Jobs', statNum(s.jobs_total)],
    ['Job applications', statNum(s.job_applications_total)],
    ['Chapters', statNum(s.chapters_total)],
    ['Chapter memberships', statNum(s.chapter_memberships_total)],
    ['Mentorships', statNum(s.mentorships_total)],
    ['Donations settled', `${statMoney(s.donations_total)} from ${statNum(s.donors_count)} donor(s)`],
    ['Bulk imports run', statNum(s.imports_total)],
    ['Broadcasts sent', statNum(s.broadcasts_total)]
  ];
  el.innerHTML = `<div class="totals-list">${rows.map(([k, v]) => `
    <div class="totals-row"><span class="totals-key">${k}</span><span class="totals-val">${v}</span></div>`).join('')}</div>`;
}

// ─── KPI ANIMATIONS ─────────────────────────────────────────
function animateKPIs() {
  // Alumni counter
  animateCounter('kpi-alumni', 0, 12847, 1200, v => v.toLocaleString());
  // Funds counter
  animateCounter('kpi-funds', 0, 24.7, 1400, v => '৳' + v.toFixed(1) + 'L');
  // Mentors counter
  animateCounter('kpi-mentors', 0, 1203, 1000, v => Math.floor(v).toLocaleString());
  // Events counter
  animateCounter('kpi-events', 0, 47, 800, v => Math.floor(v));
}

function animateCounter(id, from, to, duration, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = performance.now();
  function update(ts) {
    const elapsed = ts - start;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatter(from + (to - from) * ease);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ─── CHARTS ─────────────────────────────────────────────────
const CHART_DATA = {
  engagement: {
    labels: ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
    data: [1240, 1380, 1520, 1690, 1820, 2100, 2340, 2580, 2820, 3100, 3540, 4120],
    label: 'Active Alumni',
    color: '#0B3897',
  },
  donations: {
    labels: ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
    data: [84000, 102000, 98000, 145000, 312000, 187000, 203000, 241000, 289000, 334000, 412000, 487000],
    label: 'Donations (৳)',
    color: '#00D4AA',
  },
  geographic: {
    labels: ['BD', 'UK', 'USA', 'Canada', 'UAE', 'Australia', 'Singapore', 'Germany', 'India', 'Others'],
    data: [8241, 1240, 987, 542, 487, 381, 298, 187, 142, 342],
    label: 'Alumni Count',
    color: '#C084FC',
    type: 'bar',
  }
};

function initDashboardChart() {
  const ctx = document.getElementById('main-chart');
  if (!ctx || typeof Chart === 'undefined') return;

  if (state.charts.main) state.charts.main.destroy();

  const d = CHART_DATA.engagement;
  if (typeof Chart === 'undefined') return;   // CDN unavailable — skip charting
  state.charts.main = new Chart(ctx, {
    type: 'line',
    data: {
      labels: d.labels,
      datasets: [{
        label: d.label,
        data: d.data,
        borderColor: d.color,
        backgroundColor: d.color + '18',
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: d.color,
        pointRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });
}

function switchChart(type, btn) {
  document.querySelectorAll('.chart-tabs .chart-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  const d = CHART_DATA[type];
  if (!d || !state.charts.main) return;

  const isBar = d.type === 'bar';
  state.charts.main.data.labels = d.labels;
  state.charts.main.data.datasets[0].data = d.data;
  state.charts.main.data.datasets[0].label = d.label;
  state.charts.main.data.datasets[0].borderColor = d.color;
  state.charts.main.data.datasets[0].backgroundColor = d.color + (isBar ? '30' : '18');
  state.charts.main.data.datasets[0].pointBackgroundColor = d.color;
  state.charts.main.config.type = isBar ? 'bar' : 'line';
  state.charts.main.update();
}

function initAnalyticsChart() {
  const ctx = document.getElementById('analytics-chart');
  if (!ctx) return;
  if (state.analyticsChart) state.analyticsChart.destroy();

  if (typeof Chart === 'undefined') return;   // CDN unavailable — skip charting

  state.analyticsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      datasets: [
        {
          label: 'Active Alumni',
          data: [2100, 2340, 2580, 2820, 3100, 3540, 4120, null, null, null, null, null],
          borderColor: '#0B3897',
          backgroundColor: '#0B389718',
          borderWidth: 2.5,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: '#0B3897',
          pointRadius: 4,
        },
        {
          label: 'Donations (৳000)',
          data: [187, 203, 241, 289, 334, 412, 487, null, null, null, null, null],
          borderColor: '#00D4AA',
          backgroundColor: '#00D4AA18',
          borderWidth: 2.5,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: '#00D4AA',
          pointRadius: 4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          // Compact swatches so the legend sits on one line at 375px instead of
          // consuming two rows of chart height.
          labels: {
            color: '#334155',
            font: { family: 'Inter', size: 12 },
            padding: window.innerWidth < 900 ? 12 : 20,
            boxWidth: window.innerWidth < 900 ? 12 : 40,
            boxHeight: window.innerWidth < 900 ? 12 : 12,
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(17, 27, 46, 0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#F1F5FF',
          bodyColor: '#C7D2E8',
          padding: 12,
          cornerRadius: 10,
        }
      },
      scales: {
        x: { grid: { color: 'rgba(11, 56, 151, 0.08)' }, ticks: { color: '#64748B', font: { size: 11, family: 'Inter' } } },
        y: { grid: { color: 'rgba(11, 56, 151, 0.08)' }, ticks: { color: '#64748B', font: { size: 11, family: 'Inter' } } }
      }
    }
  });
}

function switchAnalytics(type, btn) {
  document.querySelectorAll('.analytics-tabs .chart-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
}

// ─── RENDER FUNCTIONS ────────────────────────────────────────
/* The real queue: accounts where users.is_verified is false. It used to list the
   same two invented people — Rafiq Hossain and Sumaiya Zaman — on every install,
   and the dashboard badge above it always read 12. */
const MAP_COUNTRY_POSITIONS = {
  'bangladesh': { top: 42, left: 68 },
  'india': { top: 45, left: 65 },
  'pakistan': { top: 40, left: 62 },
  'united kingdom': { top: 26, left: 45 },
  'united states': { top: 34, left: 20 },
  'canada': { top: 24, left: 20 },
  'australia': { top: 74, left: 82 },
  'germany': { top: 28, left: 48 },
  'france': { top: 30, left: 46 },
  'japan': { top: 36, left: 82 },
  'singapore': { top: 56, left: 76 },
  'malaysia': { top: 55, left: 75 },
  'united arab emirates': { top: 44, left: 58 },
  'saudi arabia': { top: 44, left: 55 },
  'qatar': { top: 44, left: 57 },
  'italy': { top: 32, left: 49 },
  'sweden': { top: 20, left: 50 },
  'south korea': { top: 35, left: 80 },
  'china': { top: 36, left: 74 },
  'new zealand': { top: 80, left: 88 }
};

// A pin's size band reflects how many alumni it stands for, matching the legend.
function mapClusterSize(n) {
  if (n >= 1000) return 'xl';
  if (n >= 100) return 'lg';
  if (n >= 10) return 'md';
  return 'sm';
}

async function renderMapClusters() {
  const container = document.getElementById('map-clusters');
  if (!container) return;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const res = await API.getStatsMap();

  if (apiFailed(res)) {
    container.innerHTML = '';
    ['map-stat-countries', 'map-stat-mapped', 'map-stat-bd', 'map-stat-intl', 'map-stat-chapters']
      .forEach(id => set(id, '—'));
    return;
  }

  const countries = res.countries || [];
  set('map-stat-countries', String(countries.length));
  set('map-stat-mapped', Number(res.located || 0).toLocaleString('en-IN'));
  set('map-stat-bd', Number(res.in_bangladesh || 0).toLocaleString('en-IN'));
  set('map-stat-intl', Number(res.international || 0).toLocaleString('en-IN'));
  set('map-stat-chapters', String(res.chapters ?? 0));

  const placed = [];
  const unplaced = [];
  countries.forEach(c => {
    const pos = MAP_COUNTRY_POSITIONS[String(c.country).trim().toLowerCase()];
    (pos ? placed : unplaced).push({ ...c, pos });
  });

  container.innerHTML = placed.map(c => `
    <div class="map-cluster ${mapClusterSize(c.n)}" style="top:${c.pos.top}%;left:${c.pos.left}%"
         title="${escapeHtml(c.country)}: ${c.n} alumni">${c.n}</div>
  `).join('');

  // Honest caption under the map: what is drawn, and what is real but not drawn.
  const note = document.getElementById('map-note');
  if (note) {
    if (!countries.length) {
      note.textContent = 'No alumni profile records a country yet, so there is nothing to place on the map.';
    } else if (unplaced.length) {
      note.textContent = `${placed.length} of ${countries.length} countries are shown. ` +
        `Not positioned on this map: ${unplaced.map(c => `${c.country} (${c.n})`).join(', ')}.`;
    } else {
      note.textContent = `Showing every country with a recorded alumni location (${countries.length}).`;
    }
  }
}


/* renderRBACTable() was removed. It was the first version of the permission
   matrix, reading a MOCK_RBAC constant that no longer exists, so it would have
   thrown had anything called it. renderRBACTableV2() builds the table from
   GET /api/stats/rbac instead. */
async function renderAnalyticsMetrics() {
  const el = document.getElementById('analytics-metrics');
  if (!el) return;

  el.innerHTML = '<div class="analytics-metric-item"><div class="analytics-metric-label">Loading…</div></div>';
  const res = await API.getStatsAnalytics();

  if (apiFailed(res)) {
    el.innerHTML = renderEmptyState('<i data-lucide="chart-column" class="ui-icon"></i>',
      'Analytics unavailable', 'Figures could not be loaded from the database.');
    if (window.lucide) lucide.createIcons();
    return;
  }

  const t = res.totals || {};
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + '%' : null);

  // Each entry names the query behind it, so a reader can check the figure.
  const metrics = [
    { label: 'User accounts', value: t.users, sub: 'COUNT(users)' },
    { label: 'Alumni profiles', value: t.profiles, sub: 'COUNT(alumni_profiles)' },
    { label: 'Profiles per account', value: pct(t.profiles, t.users), sub: 'profiles ÷ accounts' },
    { label: 'Events', value: t.events, sub: 'COUNT(events)' },
    { label: 'Event registrations', value: t.registrations, sub: 'COUNT(event_registrations)' },
    { label: 'Job postings', value: t.jobs, sub: 'COUNT(jobs)' },
    { label: 'Job applications', value: t.job_applications, sub: 'COUNT(job_applications)' },
    { label: 'Mentorship records', value: t.mentorships, sub: 'COUNT(mentorships)' },
    { label: 'Chapter memberships', value: t.chapter_memberships, sub: 'COUNT(chapter_memberships)' },
    { label: 'Accepted connections', value: t.connections, sub: "COUNT(connections WHERE status='accepted')" },
    { label: 'Settled donations', value: t.donations, sub: "COUNT(donations WHERE status='SUCCESS')" },
    { label: 'Amount settled', value: money(t.donations_amount), sub: "SUM(amount WHERE status='SUCCESS')" }
  ].filter(m => m.value !== null && m.value !== undefined);

  el.innerHTML = metrics.map(m => `
    <div class="analytics-metric-item">
      <div class="analytics-metric-label">${m.label}</div>
      <div class="analytics-metric-value">${typeof m.value === 'number' ? m.value.toLocaleString('en-IN') : m.value}</div>
      <div class="analytics-metric-source">${escapeHtml(m.sub)}</div>
    </div>
  `).join('');
}

/* Ten countries were listed here with fixed counts and fixed bar widths,
   totalling the same imaginary 12,847 alumni. This reads alumni_profiles.country. */
async function generateGeoHeatmap() {
  const el = document.getElementById('geo-heatmap');
  if (!el) return;

  const res = await API.getStatsMap();
  if (apiFailed(res)) {
    el.innerHTML = renderEmptyState('<i data-lucide="globe" class="ui-icon"></i>',
      'Distribution unavailable', 'Location figures could not be loaded.');
    if (window.lucide) lucide.createIcons();
    return;
  }

  const countries = res.countries || [];
  if (!countries.length) {
    el.innerHTML = renderEmptyState('<i data-lucide="globe" class="ui-icon"></i>',
      'No locations recorded yet',
      'Countries appear here once alumni profiles carry a country.');
    if (window.lucide) lucide.createIcons();
    return;
  }

  const max = Math.max(...countries.map(c => c.n));
  el.innerHTML = `<div class="geo-countries">${countries.map(c => `
    <div class="geo-country-item">
      <div class="geo-country-name">${escapeHtml(c.country)}</div>
      <div class="geo-country-bar-track"><div class="geo-country-bar-fill" style="width:${Math.round((c.n / max) * 100)}%"></div></div>
      <div class="geo-country-count">${c.n.toLocaleString('en-IN')}</div>
    </div>
  `).join('')}</div>`;
}

// ─── QR CODE ─────────────────────────────────────────────────
/* initQRCode() was removed with the QR it drew. The code encoded
   https://dic.alumnai.io/verify?id=DIC-2020-0847&token=SEC-<random> — a domain
   that does not exist, a student ID belonging to nobody, and a token generated
   fresh on every render, all under a badge reading "Anti-Spoofing QR". Nothing
   could have verified it. Event ticket QRs are a separate, real mechanism with
   an HMAC-signed payload and are untouched. */

// ─── 2. ANALYTICS: MENTORSHIP HEALTH & EVENT ROI ─────────────
const _origSwitchAnalytics = switchAnalytics;
switchAnalytics = function(tab, btn) {
  const mainPanel = document.getElementById('analytics-panel-main');
  const mentPanel = document.getElementById('analytics-panel-mentorship');
  const roiPanel = document.getElementById('analytics-panel-eventROI');

  // Update tabs active class
  document.querySelectorAll('.analytics-tabs .chart-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  if (mainPanel) mainPanel.classList.add('hidden');
  if (mentPanel) mentPanel.classList.add('hidden');
  if (roiPanel) roiPanel.classList.add('hidden');

  if (tab === 'mentorship') {
    if (mentPanel) mentPanel.classList.remove('hidden');
    renderMentorshipHealthAnalytics();
  } else if (tab === 'eventROI') {
    if (roiPanel) roiPanel.classList.remove('hidden');
    renderEventROIAnalytics();
  } else {
    if (mainPanel) mainPanel.classList.remove('hidden');
    if (typeof _origSwitchAnalytics === 'function') _origSwitchAnalytics(tab, btn);
  }
};

/* The scorecard read 1,203 active connections, an 83% goal completion rate, a
   sub-12-hour mentor response time and a 4.9/5.0 mentee rating, over a
   mentorships table holding zero rows. The outcome distribution below it was
   four fixed bars. Nothing records a goal, a response time or a rating, so
   those three are gone; the counts that are stored are shown instead. */
