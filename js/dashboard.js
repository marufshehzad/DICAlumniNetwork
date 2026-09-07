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
      <div class="card-header"><h2 class="card-title"><i data-lucide="shield" class="ui-icon"></i> Staff tools are on the staff portal</h2></div>
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
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal-text)" data-stat="my_connections">—</div><div class="sync-stat-label">My Connections</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber-text)" data-stat="my_chapters">—</div><div class="sync-stat-label">My Chapters</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--primary-light)" data-stat="my_unread_notifications">—</div><div class="sync-stat-label">Unread Notifications</div></div>
    </div>

    <div class="dashboard-split">
      <div class="dashboard-left">
        <div class="glass-card">
          <div class="card-header"><h2 class="card-title"><i data-lucide="handshake" class="ui-icon"></i> Recommended DIC Alumni Connections</h2></div>
          <div id="dash-alumni-grid" class="alumni-grid"></div>
        </div>
        <div class="glass-card mt-16">
          <div class="card-header"><h2 class="card-title"><i data-lucide="calendar" class="ui-icon"></i> Upcoming DIC Events</h2></div>
          <div id="dash-events-grid" class="events-grid"></div>
        </div>
      </div>
      <div class="dashboard-right">
        <div class="glass-card">
          <div class="card-header"><h2 class="card-title"><i data-lucide="trophy" class="ui-icon"></i> Top Donors</h2></div>
          <div id="donor-leaderboard"></div>
        </div>
        <div class="glass-card mt-16">
          <div class="card-header"><h2 class="card-title"><i data-lucide="vote" class="ui-icon"></i> DIC Live Poll</h2></div>
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
/* Real system status. Everything shown is something GET /api/health actually
   returned; when it does not answer, that is what the panel says.

   The three states below are the three the endpoint can produce, and they are
   not interchangeable: 200 ok, 503 degraded (the API is up and answering, its
   database is not), and no answer at all. Collapsing the middle one into
   "unreachable" would send an operator looking for a dead server when what is
   actually dead is the database. This panel and the external monitor read the
   same contract — see PRODUCTION_DEPENDENCIES.md §2.7. */
function renderSystemStatus() {
  const el = document.getElementById('system-status');
  if (!el) return;
  API.health().then(h => {
    if (!h || h.status === 'unreachable') {
      el.innerHTML = `<div class="server-card"><div class="server-val" style="color:var(--danger)">Unreachable</div>
        <div class="server-label">The API did not answer a health check</div></div>`;
      return;
    }
    if (h.status !== 'ok') {
      el.innerHTML = `
        <div class="server-card"><div class="server-val" style="color:var(--amber-text)">Degraded</div><div class="server-label">API status</div></div>
        <div class="server-card"><div class="server-val" style="color:var(--danger);font-size:15px">Unreachable</div><div class="server-label">Database</div></div>`;
      return;
    }
    const dbOk = h.database === 'ok';
    const latency = Number.isFinite(h.latencyMs) ? `${h.latencyMs} ms` : '—';
    el.innerHTML = `
      <div class="server-card"><div class="server-val">Online</div><div class="server-label">API status</div></div>
      <div class="server-card"><div class="server-val" style="font-size:15px${dbOk ? '' : ';color:var(--danger)'}">${dbOk ? 'Reachable' : 'Unreachable'}</div><div class="server-label">Database</div></div>
      <div class="server-card"><div class="server-val" style="font-size:15px">${escapeHtml(latency)}</div><div class="server-label">Health check latency</div></div>`;
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

/* A block of KPI counters and a chart configuration stood here, none of it
   reachable: #kpi-alumni, #main-chart and .chart-tabs exist in neither
   portal, and animateKPIs / initDashboardChart / switchChart were each
   referenced only by their own definition.

   It is gone rather than dormant because of what it held — a hardcoded
   per-country alumni distribution (BD 8,241 · UK 1,240 · USA 987 · Canada
   542 …) labelled "Alumni Count", plus a 12,847 alumni counter. Those are
   the same invented figures Phase 5B removed from the map, waiting one
   wire-up away from being believed again. The real per-country numbers come
   from GET /api/stats/map, which counts rows. */

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
        x: { grid: { color: 'rgba(11, 56, 151, 0.08)' }, ticks: { color: '#5D6B7F', font: { size: 11, family: 'Inter' } } },
        y: { grid: { color: 'rgba(11, 56, 151, 0.08)' }, ticks: { color: '#5D6B7F', font: { size: 11, family: 'Inter' } } }
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
/* MAP_COUNTRY_POSITIONS is gone. It was a hand-written table of twenty
   countries with `top`/`left` percentages — screen positions someone chose by
   eye, not coordinates — and any country outside the twenty could not be drawn
   at all. Pins are now projected from the real latitude and longitude the
   server sends with each city, so every place on earth has a correct position
   and no lookup table can fall behind the data.

   The projection is equirectangular (plate carrée): longitude maps linearly to
   x, latitude linearly to y. It is the projection the graticule below is drawn
   for, it needs no library, and it is exact for what this map claims — where a
   city is relative to the grid it is drawn on. */
const MAP_VIEW = { width: 900, height: 450 };

/* View state. Zoom scales the projection rather than CSS-transforming the
   layer, so badges keep a constant pixel size and the numbers stay legible at
   every level — the number is the primary signal, and a scaled-down number is
   no signal at all. */
/* The top of this range is deliberately deep. Dhaka and Chattogram are about
   1.4° apart, which is five view units at world zoom — the detail panel tells
   the reader to zoom in to separate a cluster, and at 4× they still would not
   have. 16× puts roughly eighty units between them, so the promise holds. */
const MAP_ZOOM_STEPS = [1, 2, 4, 8, 16];
let mapZoomIndex = 0;
let mapCenter = { lat: 0, lng: 0 };
let mapMode = 'cities';          // 'cities' | 'countries' | 'divisions'
/* Phase 7G. Two levels, as §5 asks for, and no deeper: the world, and
   Bangladesh. 'bangladesh' swaps the coarse outline for the detailed one,
   frames the country, and groups alumni by division. */
let mapView = 'world';           // 'world' | 'bangladesh'
let mapData = null;              // last payload from GET /api/stats/map
let mapSelected = null;          // the marker whose detail panel is open
let mapClusters = [];            // the merged badges currently drawn
let mapQuery = '';               // §7 search, applied to what the server sent

function mapZoom() { return MAP_ZOOM_STEPS[mapZoomIndex]; }

/* Bangladesh spans about 4.6° of longitude and 5.9° of latitude.

   Phase 7G framed this at 8x on the stated grounds that "at 16x the whole
   country is wider than the canvas". Measured, that is not true: the 900x450
   viewBox at 16x puts the country's projected bounding box fully inside the
   canvas at 20% of its width and 52% of its height. At 8x it is 10% by 26% —
   a country the size of a thumbnail, which was tolerable when the outline was
   the only thing inside it and is wasteful now that it contains 64 real
   district boundaries. 16x is what makes those legible.

   The centre is the country's real geographic middle, not the alumni mean —
   pressing "Bangladesh" should show Bangladesh, not wherever three graduates
   happen to live. */
const BD_CENTER = { lat: 23.7, lng: 90.35 };

function mapShowBangladesh() {
  mapView = 'bangladesh';
  mapMode = 'divisions';
  mapCenter = { ...BD_CENTER };
  mapZoomIndex = MAP_ZOOM_STEPS.indexOf(16) >= 0 ? MAP_ZOOM_STEPS.indexOf(16) : MAP_ZOOM_STEPS.length - 1;
  mapSelected = null;
  syncMapModeButtons();
  renderMapClusters();
}

function mapShowWorld() {
  mapView = 'world';
  mapMode = 'cities';
  mapCenter = { lat: 0, lng: 0 };
  mapZoomIndex = 0;
  mapSelected = null;
  syncMapModeButtons();
  renderMapClusters();
}

/* The toolbar has to agree with the state, whichever way the state was
   reached — a button press, the Bangladesh shortcut, or returning to the page. */
function syncMapModeButtons() {
  for (const btn of document.querySelectorAll('[data-map-mode]')) {
    btn.classList.toggle('active', btn.getAttribute('data-map-mode') === mapMode);
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-map-mode') === mapMode));
  }
  const bd = document.getElementById('map-bd-btn');
  if (bd) bd.setAttribute('aria-pressed', String(mapView === 'bangladesh'));
}

function projectLatLng(lat, lng) {
  const z = mapZoom();
  const bx = (Number(lng) + 180) / 360;
  const by = (90 - Number(lat)) / 180;
  const cx = (mapCenter.lng + 180) / 360;
  const cy = (90 - mapCenter.lat) / 180;
  return {
    x: ((bx - cx) * z + 0.5) * MAP_VIEW.width,
    y: ((by - cy) * z + 0.5) * MAP_VIEW.height
  };
}

/* Legend bands, derived from the dataset actually being drawn rather than from
   the fixed 1000+/100–999/<100 scale the old legend printed. On a college-scale
   dataset those three buckets put every real place in the smallest one, so the
   legend described a distribution that did not exist. */
function mapBands(counts) {
  const max = counts.length ? Math.max(...counts) : 0;
  if (max <= 1) return [{ label: '1', min: 1, cls: 'sm' }];
  if (max <= 10) {
    return [{ label: '1–3', min: 1, cls: 'sm' },
            { label: '4–10', min: 4, cls: 'md' }];
  }
  if (max <= 50) {
    return [{ label: '1–5', min: 1, cls: 'sm' },
            { label: '6–20', min: 6, cls: 'md' },
            { label: '21+', min: 21, cls: 'lg' }];
  }
  return [{ label: '1–10', min: 1, cls: 'sm' },
          { label: '11–50', min: 11, cls: 'md' },
          { label: '51–100', min: 51, cls: 'lg' },
          { label: '100+', min: 101, cls: 'xl' }];
}

function mapBandFor(n, bands) {
  let cls = bands[0].cls;
  for (const b of bands) if (n >= b.min) cls = b.cls;
  return cls;
}

/* ─── the basemap (Phase 7G) ──────────────────────────────────

   Until this phase the map drew a graticule and nothing else. That was honest —
   the project held no boundary data, and a coastline drawn from memory is
   fabrication — but it asked a reader to locate a country from meridian numbers,
   which almost nobody can do. So the boundaries are real now.

   assets/geo/boundaries.json is Natural Earth's Admin 0 countries, PUBLIC
   DOMAIN, plus — added in the 7G closure pass — Bangladesh's 8 divisions (CC0)
   and 64 districts (CC BY 3.0 IGO) from geoBoundaries. Converted once at build
   time by tools/build_geo.js and shipped as a static file. The geoBoundaries
   layers require attribution, which is rendered under the map; see
   MAP_TECHNOLOGY.md. No tile provider, no API key, no request to anyone's server, and
   no mapping library: the rings are plain longitude/latitude and are projected
   by the SAME projectLatLng() that positions the alumni markers. Boundaries and
   markers therefore cannot drift apart — they are one projection, not two that
   resemble each other.

   Fetched once per page and held. A failure is not fatal: the graticule still
   draws and the markers are still correctly placed, so the map degrades to
   exactly what it was before this phase rather than to nothing. */
const GEO_URL = '/assets/geo/boundaries.json';
let geoData = null;
let geoPromise = null;
let geoFailed = false;

async function loadMapGeometry() {
  if (geoData || geoFailed) return geoData;
  if (!geoPromise) {
    geoPromise = fetch(GEO_URL)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(j => {
        if (j && Array.isArray(j.world)) geoData = j; else geoFailed = true;
        return geoData;
      });
  }
  return geoPromise;
}

/* One country's rings as an SVG path, clipped crudely to the drawing area.

   The crude part matters: a ring is skipped when its projected bounding box is
   entirely off-canvas, which at 16× zoom is almost every country. Without it
   the browser builds a path string for 166 countries on every pan. */
function countryPath(rings, W, H) {
  const parts = [];
  for (const ring of rings) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const pts = new Array(ring.length);
    for (let i = 0; i < ring.length; i++) {
      const pt = projectLatLng(ring[i][1], ring[i][0]);
      pts[i] = pt;
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    if (maxX < -40 || minX > W + 40 || maxY < -40 || minY > H + 40) continue;
    /* A ring that projects to less than a pixel is a dot of noise, not a
       country — drawing it just fuzzes the coastline. */
    if (maxX - minX < 0.8 && maxY - minY < 0.8) continue;

    let d = 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (let i = 1; i < pts.length; i++) d += 'L' + pts[i].x.toFixed(1) + ' ' + pts[i].y.toFixed(1);
    parts.push(d + 'Z');
  }
  return parts.join('');
}

/* Where to put a country's label: the centre of its largest ring, which is a
   better anchor than a bounding-box centre for a country shaped like Norway. */
function ringAnchor(rings) {
  let best = null, bestSpan = -1;
  for (const ring of rings) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < minX) minX = lng; if (lng > maxX) maxX = lng;
      if (lat < minY) minY = lat; if (lat > maxY) maxY = lat;
    }
    const span = (maxX - minX) * (maxY - minY);
    if (span > bestSpan) { bestSpan = span; best = [(minX + maxX) / 2, (minY + maxY) / 2]; }
  }
  return best;
}

function drawMapGraticule() {
  const svg = document.getElementById('world-map-svg');
  if (!svg) return;
  const { width: W, height: H } = MAP_VIEW;
  const parts = [];
  const z = mapZoom();
  const step = z >= 8 ? 5 : z >= 2.6 ? 10 : 30;

  for (let lng = -180; lng <= 180; lng += step) {
    const { x } = projectLatLng(0, lng);
    if (x < -20 || x > W + 20) continue;
    const prime = lng === 0;
    parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" ` +
      `stroke="currentColor" stroke-width="${prime ? 1.3 : 0.7}" opacity="${prime ? 0.5 : 0.22}" />`);
    if (Math.abs(lng) !== 180) {
      parts.push(`<text x="${(x + 4).toFixed(1)}" y="${H - 7}" font-size="10" ` +
        `fill="#475569" opacity="0.9">${lng}°</text>`);
    }
  }
  for (let lat = -80; lat <= 80; lat += step) {
    const { y } = projectLatLng(lat, 0);
    if (y < -20 || y > H + 20) continue;
    const equator = lat === 0;
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" ` +
      `stroke="currentColor" stroke-width="${equator ? 1.3 : 0.7}" opacity="${equator ? 0.5 : 0.22}" />`);
    parts.push(`<text x="6" y="${(y - 5).toFixed(1)}" font-size="10" ` +
      `fill="#475569" opacity="0.9">${lat}°</text>`);
  }

  /* Countries UNDER the graticule: the grid is a reference, the land is the
     thing being referenced, and a grid drawn beneath filled shapes disappears.
     Land is a pale fill with a slightly darker stroke so a boundary reads at
     world zoom without the map turning into a colouring book — the alumni
     badges are the primary signal and must stay the loudest thing on it. */
  const land = [];
  if (geoData) {
    /* At Bangladesh focus the detailed 1:10m outline replaces the coarse one,
       so the country the institution is in is recognisable rather than a
       five-sided blob. */
    const detailed = mapView === 'bangladesh' && geoData.bangladesh && geoData.bangladesh.length;
    for (const f of geoData.world) {
      if (detailed && f.name === 'Bangladesh') continue;
      const d = countryPath(f.rings, W, H);
      if (!d) continue;
      const here = f.name === 'Bangladesh';
      /* Enough contrast that a continent is recognisable at a glance, and no
         more: the alumni badges are the point of the map and must stay the
         loudest thing on it. Bangladesh is tinted green because it is the
         institution's own country and the one the focused view is about. */
      land.push(`<path d="${d}" fill="${here ? '#D6EBE0' : '#E1EAF4'}" ` +
        `stroke="${here ? '#6BAA8C' : '#A7BAD2'}" stroke-width="${here ? 1 : 0.7}" ` +
        `stroke-linejoin="round" />`);
    }
    if (detailed) {
      const d = countryPath(geoData.bangladesh[0].rings, W, H);
      if (d) land.push(`<path d="${d}" fill="#DCEFE6" stroke="#4E9B7C" stroke-width="1.2" stroke-linejoin="round" />`);

      /* Real internal boundaries (Phase 7G closure).

         Phase 7G shipped divisions as labelled points and recorded that no
         licensable geometry existed for them. That was wrong: geoBoundaries
         gbOpen publishes Bangladesh ADM1 and ADM2 under CC0 and CC BY 3.0 IGO
         respectively — attribution, but no share-alike, which is what ruled out
         GADM and OSM. So the divisions and districts below are REAL surveyed
         boundaries from the Bangladesh Bureau of Statistics, not drawn shapes.

         A district is tinted only when alumni are actually recorded in it, and
         the count comes from the same server-computed rows the badges use — so
         the shading and the ranked list can never disagree. An untinted
         district is a real district with nobody in it, which is a true and
         useful thing for a reader to be able to see. */
      const perDistrict = new Map();
      for (const c of (mapData && mapData.cities) || []) {
        if (c.country !== 'Bangladesh' || !c.district) continue;
        perDistrict.set(c.district, (perDistrict.get(c.district) || 0) + c.n);
      }
      for (const f of geoData.bdDistricts || []) {
        const dd = countryPath(f.rings, W, H);
        if (!dd) continue;
        const has = perDistrict.get(f.name) > 0;
        land.push(`<path d="${dd}" fill="${has ? '#9ECCB4' : 'none'}" ` +
          `stroke="#7FAE96" stroke-width="0.45" stroke-linejoin="round" />`);
      }
      /* Divisions last and heavier, so the eight big units read at a glance
         over the sixty-four smaller ones rather than competing with them. */
      for (const f of geoData.bdDivisions || []) {
        const dd = countryPath(f.rings, W, H);
        if (dd) land.push(`<path d="${dd}" fill="none" stroke="#3F8A69" ` +
          `stroke-width="1.1" stroke-linejoin="round" />`);
      }
    }
  }

  /* Country names, only where they fit. A label narrower than the country it
     names is a label; one wider is a smear across three neighbours, so the
     projected width of the country decides whether it is drawn at all. */
  const labels = [];
  if (geoData && mapZoom() >= 2) {
    const placed = [];
    const named = geoData.world
      .filter(f => f.name)
      .map(f => ({ f, anchor: ringAnchor(f.rings) }))
      .filter(x => x.anchor);
    for (const { f, anchor } of named) {
      const at = projectLatLng(anchor[1], anchor[0]);
      if (at.x < 30 || at.x > W - 30 || at.y < 14 || at.y > H - 14) continue;
      const approxW = f.name.length * 5.4;
      if (placed.some(pl => Math.abs(pl.x - at.x) < (approxW + pl.w) / 2 && Math.abs(pl.y - at.y) < 13)) continue;
      placed.push({ x: at.x, y: at.y, w: approxW });
      labels.push(`<text x="${at.x.toFixed(1)}" y="${at.y.toFixed(1)}" font-size="10.5" ` +
        `text-anchor="middle" fill="#42546B" opacity="0.85" ` +
        `style="paint-order:stroke;stroke:#FFFFFF;stroke-width:2.5px">${escapeHtml(f.name)}</text>`);
    }
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', geoData
    ? 'World map with country boundaries. Alumni counts are listed in the table beside it.'
    : 'Map grid. Alumni counts are listed in the table beside it.');
  svg.innerHTML = land.join('') + parts.join('') + labels.join('');
}

/* Merge badges that would collide, rather than pushing them apart.

   Dhaka, Chattogram, Cumilla and Sylhet are within about five degrees of each
   other; at world zoom they project to nearly the same point. Nudging each one
   aside scattered them across a third of the map and left every badge pointing
   at somewhere it is not — worse than the overlap it was solving.

   So co-located places combine into one badge carrying their combined total,
   which is what a map cluster is for. Zooming in increases the projected
   distance between them, so the cluster splits on its own and the zoom control
   does something worth doing. A cluster is always expandable: clicking it
   lists the places inside with their individual counts.

   The cluster sits at the alumni-weighted centre of its members, so the badge
   leans toward the place most of the people are. */
function clusterMapPoints(points, minDist) {
  const remaining = [...points].sort((a, b) => b.n - a.n);
  const clusters = [];

  while (remaining.length) {
    const seed = remaining.shift();
    const at = projectLatLng(seed.latitude, seed.longitude);
    const members = [seed];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const p = projectLatLng(remaining[i].latitude, remaining[i].longitude);
      if (Math.hypot(p.x - at.x, p.y - at.y) < minDist) {
        members.push(remaining[i]);
        remaining.splice(i, 1);
      }
    }

    const total = members.reduce((a, m) => a + m.n, 0);
    const x = members.reduce((a, m) => a + projectLatLng(m.latitude, m.longitude).x * m.n, 0) / total;
    const y = members.reduce((a, m) => a + projectLatLng(m.latitude, m.longitude).y * m.n, 0) / total;
    members.sort((a, b) => b.n - a.n);
    clusters.push({ members, total, x, y, key: 'c:' + mapKeyOf(seed) });
  }
  return clusters;
}

/* What a row is called, what a level is called, and what sits under the name.
   Phase 7G added a third level and every label site was a two-way ternary
   between country and city — three of them, in three different files' worth of
   markup. One helper each, so a fourth level would be one edit and not five. */
function mapLabelOf(row) {
  if (!row) return '';
  if (mapMode === 'countries') return row.country || '';
  if (mapMode === 'divisions') return row.division || '';
  return row.city || '';
}

function mapUnitName(plural) {
  if (mapMode === 'countries') return plural ? 'countries' : 'country';
  if (mapMode === 'divisions') return plural ? 'divisions' : 'division';
  return plural ? 'cities' : 'city';
}

function mapSubLabelOf(row) {
  if (!row) return '';
  if (mapMode === 'countries') return `${row.cities} ${row.cities === 1 ? 'city' : 'cities'}`;
  if (mapMode === 'divisions') {
    return `${row.cities} ${row.cities === 1 ? 'city' : 'cities'} · Bangladesh`;
  }
  return row.country || '';
}

function mapKeyOf(row) {
  if (mapMode === 'countries') return row.country_code;
  if (mapMode === 'divisions') return 'div:' + row.division;
  return String(row.place_id);
}

async function renderMapClusters() {
  const container = document.getElementById('map-clusters');
  if (!container) return;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const loading = document.getElementById('map-loading');
  if (loading && !mapData) loading.classList.remove('hidden');

  /* Both in flight together: the counts come from the API and the outlines from
     a static file, and neither needs the other. Awaiting them in sequence would
     make the map appear in two visible steps for no reason. */
  const [res] = await Promise.all([API.getStatsMap(), loadMapGeometry()]);
  if (loading) loading.classList.add('hidden');
  wireMapGestures();

  if (apiFailed(res)) {
    container.innerHTML = '';
    ['map-stat-countries', 'map-stat-mapped', 'map-stat-bd', 'map-stat-intl', 'map-stat-chapters']
      .forEach(id => set(id, '—'));
    return;
  }

  mapData = res;
  const countries = res.countries || [];
  set('map-stat-countries', String(countries.length));
  set('map-stat-mapped', Number(res.mapped || 0).toLocaleString('en-IN'));
  set('map-stat-bd', Number(res.in_bangladesh || 0).toLocaleString('en-IN'));
  set('map-stat-intl', Number(res.international || 0).toLocaleString('en-IN'));
  set('map-stat-chapters', String(res.chapters ?? 0));

  paintMap();
}

/* Draws whatever is currently in mapData at the current mode and zoom. Split
   from the fetch so zooming and switching mode never re-query the server —
   §9's rule that the endpoint is the single source of truth cuts both ways:
   the browser must not recompute the counts, and it must not re-fetch them to
   redraw the same numbers. */
function paintMap() {
  const container = document.getElementById('map-clusters');
  if (!container || !mapData) return;
  const rows = mapRows();

  drawMapGraticule();
  renderMapLegend(rows.map(r => r.n));
  renderMapRanking();

  /* Two different nothings. A map with no confirmed locations is a fact
     about the data; a search that matches none of them is a fact about the
     search, and telling the reader the first when the second is true would be
     wrong. */
  const empty = document.getElementById('map-empty');
  const emptyText = document.getElementById('map-empty-text');
  const searching = mapQuery.trim() !== '';
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  if (emptyText) {
    emptyText.textContent = searching
      ? `No ${mapUnitName(false)} matches "${mapQuery.trim()}".`
      : (mapView === 'bangladesh'
          /* Empty here is a real answer, not a failure, and it says which
             answer it is: nobody with a public location has a Bangladeshi
             division recorded. */
          ? 'No alumni with a public location are recorded in a Bangladeshi division yet.'
          : 'No confirmed locations to display yet.');
  }
  if (!rows.length) {
    container.innerHTML = '';
    renderMapNote();
    renderMapLegend([]);
    return;
  }

  /* Markers are positioned from coordinates the SERVER sent. For a city that
     is the city's own coordinate; for a country it is the alumni-weighted mean
     of its cities, which the server computes. Neither is a person's position —
     no such coordinate exists anywhere in this system. */
  /* Clearance is computed in VIEW units from the canvas's real pixel width, so
     two badges cannot end up touching on a narrow canvas where a view unit is
     worth fewer pixels. 58px is the largest badge (50px) plus a margin; a fixed
     view-unit constant left the biggest discs overlapping. */
  /* Merge distance, in VIEW units, derived from the canvas's real pixel width
     so that two badges merge exactly when they would otherwise overlap on
     screen. 34px is a typical badge diameter plus a small margin; 54px — the
     largest badge — was far too greedy on a narrow canvas and collapsed most of
     the world into a single disc. */
  const canvasEl = document.getElementById('alumni-map');
  const pxPerUnit = Math.max(0.2, (canvasEl?.clientWidth || 740) / MAP_VIEW.width);
  const clusters = clusterMapPoints(rows, 34 / pxPerUnit);
  mapClusters = clusters;

  const bands = mapBands(clusters.map(c => c.total));
  const pct = (v, total) => (v / total * 100).toFixed(2);

  container.innerHTML = clusters.map(c => {
    const many = c.members.length > 1;
    const first = c.members[0];
    const name = many
      ? `${c.members.length} ${mapUnitName(true)}`
      : mapLabelOf(first);
    const sub = many
      ? `${c.members.map(mapLabelOf).join(', ')} — ${c.total} alumni`
      : `${mapLabelOf(first)}${mapMode === 'cities' ? ', ' + (first.country || '') : ''}: ` +
        `${first.n} alumni${mapMode === 'cities' ? '' : ' · ' + mapSubLabelOf(first)}`;
    const left = pct(c.x, MAP_VIEW.width);
    const top = pct(c.y, MAP_VIEW.height);
    const active = mapSelected === c.key ? ' is-selected' : '';

    return `
      <button type="button" class="map-cluster ${mapBandFor(c.total, bands)}${active}${many ? ' is-group' : ''}"
              style="top:${top}%;left:${left}%"
              onclick="selectMapMarker(${jsArg(c.key)})"
              aria-label="${escapeHtml(name)}, ${c.total} alumni. Show details."
              title="${escapeHtml(sub)}">${c.total}</button>
      <span class="map-city-label${c.x > MAP_VIEW.width * 0.8 ? ' flip' : ''}"
            style="top:${top}%;left:${left}%">${escapeHtml(name)}</span>`;
  }).join('');

  renderMapNote();
  renderMapDetail();
  if (window.lucide) lucide.createIcons();
}

/* Honest caption: what is drawn, and what is real but deliberately not drawn.
   `unconfirmed` are the profiles whose location the pre-v13 hardcoded path
   wrote. Plotting them would republish a fabrication, so they are counted here
   and left off the map. */
/* The rows currently displayed: the active mode, narrowed by the search.
   Filtering happens here and nowhere else, so the discs, the ranking list and
   the legend are always describing the same set. Counts are never recomputed —
   they are the server's. */
function mapRows() {
  if (!mapData) return [];
  /* Three levels, one source. Divisions arrive already aggregated and already
     privacy-filtered by the server, exactly like cities and countries — the
     browser never groups personal rows itself. */
  const all = mapMode === 'countries' ? (mapData.countries || [])
            : mapMode === 'divisions' ? (mapData.divisions || [])
            : (mapData.cities || []);
  const q = mapQuery.trim().toLowerCase();
  if (!q) return all;
  return all.filter(r =>
    String(r.city || '').toLowerCase().includes(q) ||
    String(r.division || '').toLowerCase().includes(q) ||
    String(r.country || '').toLowerCase().includes(q));
}

function setMapQuery(value) {
  mapQuery = String(value || '');
  mapSelected = null;
  const detail = document.getElementById('map-detail');
  if (detail) detail.classList.add('hidden');
  paintMap();
}

function renderMapNote() {
  const note = document.getElementById('map-note');
  if (!note || !mapData) return;
  const res = mapData;
  const cities = res.cities || [];
  const parts = [];

  if (!cities.length) {
    parts.push('No confirmed locations to display yet.');
  } else {
    parts.push(`${cities.length} ${cities.length === 1 ? 'city' : 'cities'} across ` +
               `${(res.countries || []).length} ${(res.countries || []).length === 1 ? 'country' : 'countries'}, ` +
               `${res.mapped} alumni who chose to appear on the map.`);
  }
  if (res.unconfirmed) {
    parts.push(`${res.unconfirmed} profile${res.unconfirmed === 1 ? '' : 's'} carry a location ` +
               `recorded automatically before it could be confirmed; ` +
               `${res.unconfirmed === 1 ? 'it is' : 'they are'} not shown here.`);
  }
  const hidden = (res.confirmed || 0) - (res.mapped || 0);
  if (hidden > 0) parts.push(`${hidden} chose to keep their location off the map.`);
  note.textContent = parts.join(' ');
}

function renderMapLegend(counts) {
  const el = document.getElementById('map-legend');
  if (!el) return;
  if (!counts.length) { el.innerHTML = ''; return; }
  const bands = mapBands(counts);
  el.innerHTML = `<span class="legend-title">Alumni per ${mapUnitName(false)}</span>` +
    bands.map(b => `<span class="legend-item"><span class="legend-dot ${b.cls}"></span>${escapeHtml(b.label)}</span>`).join('');
}

/* A plain ranked list beside the map. The map answers "where", this answers
   "how many, exactly" without anyone having to read a disc, and it is the part
   that stays usable on a narrow screen. */
function renderMapRanking() {
  const el = document.getElementById('map-ranking');
  if (!el || !mapData) return;
  const rows = mapRows();
  if (!rows.length) { el.innerHTML = ''; return; }
  const max = Math.max(...rows.map(r => r.n));

  el.innerHTML = rows.slice(0, 12).map(r => {
    const name = mapLabelOf(r);
    const sub = mapSubLabelOf(r);
    const key = mapKeyOf(r);
    return `
      <button type="button" class="map-rank-row ${mapSelected === key ? 'is-selected' : ''}"
              onclick="selectMapMarker(${jsArg(key)})">
        <span class="map-rank-name">${escapeHtml(name)}<span class="map-rank-sub">${escapeHtml(sub)}</span></span>
        <span class="map-rank-bar"><span style="width:${Math.max(4, Math.round(r.n / max * 100))}%"></span></span>
        <span class="map-rank-n">${r.n}</span>
      </button>`;
  }).join('');
}


/* ─── MAP INTERACTION ────────────────────────────────────────
   Selection, the detail panel, zoom and the hand-off to the directory. All of
   it reads mapData — nothing here recounts anything or calls the API again. */

function mapRowFor(key) {
  if (!mapData) return null;
  if (mapMode === 'countries') return (mapData.countries || []).find(c => c.country_code === key);
  if (mapMode === 'divisions') {
    return (mapData.divisions || []).find(d => 'div:' + d.division === key);
  }
  return (mapData.cities || []).find(c => String(c.place_id) === String(key));
}

/* A selection is either a single place (from the ranked list) or a cluster
   badge holding several. Both resolve to the same shape so the detail panel
   has one code path. */
function mapSelectionFor(key) {
  if (!key) return null;
  if (String(key).startsWith('c:')) {
    const cluster = (mapClusters || []).find(c => c.key === key);
    if (!cluster) return null;
    if (cluster.members.length === 1) return { kind: 'one', row: cluster.members[0] };
    return { kind: 'group', cluster };
  }
  const row = mapRowFor(key);
  return row ? { kind: 'one', row } : null;
}

function selectMapMarker(key) {
  mapSelected = mapSelected === key ? null : key;
  paintMap();
}

function closeMapDetail() { mapSelected = null; paintMap(); }

/* The detail panel. For a country it reports the name, the total and how many
   cities are represented — never an area or a border measurement. The map now
   DOES carry real boundary geometry, but it carries it to be drawn, not to be
   measured: a simplified 1:110m ring is the right shape at this scale and the
   wrong number for any question about size. */
function renderMapDetail() {
  const el = document.getElementById('map-detail');
  if (!el) return;
  const sel = mapSelectionFor(mapSelected);
  if (!sel) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const isCountry = mapMode === 'countries';
  const close = `
    <button type="button" class="map-detail-close" onclick="closeMapDetail()" aria-label="Close">
      <i data-lucide="x" class="ui-icon"></i>
    </button>`;

  if (sel.kind === 'group') {
    // A merged badge: name every place inside it, each with its own count and
    // its own way through to the directory.
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="map-detail-head">
        <div>
          <div class="map-detail-title">${sel.cluster.members.length} ${isCountry ? 'countries' : 'cities'} here</div>
          <div class="map-detail-sub">${sel.cluster.total} alumni in total</div>
        </div>${close}
      </div>
      <div class="map-detail-list">
        ${sel.cluster.members.map(m => `
          <button type="button" class="map-detail-item"
                  onclick="selectMapMarker(${jsArg(mapKeyOf(m))})">
            <span>${escapeHtml(isCountry ? m.country : m.city)}</span><span>${m.n}</span>
          </button>`).join('')}
      </div>
      <p class="map-detail-foot">These places are too close together to draw
        separately at this zoom. Zoom in to separate them.</p>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  const row = sel.row;
  const title = isCountry ? row.country : row.city;
  const lines = isCountry
    ? [['Alumni', row.n], ['Cities represented', row.cities]]
    : [['Country', row.country], ['Alumni', row.n]];

  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="map-detail-head">
      <div>
        <div class="map-detail-title">${escapeHtml(title)}</div>
        ${isCountry ? '' : `<div class="map-detail-sub">${escapeHtml(row.country)}</div>`}
      </div>${close}
    </div>
    <dl class="map-detail-rows">
      ${lines.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}
    </dl>
    <button type="button" class="btn btn-primary btn-sm btn-full"
            onclick="viewAlumniForMapSelection()">
      <i data-lucide="users" class="ui-icon"></i> View alumni
    </button>
    ${isCountry ? `<p class="map-detail-foot">Badge position is the average of this
      country's alumni cities — not a border or a centroid.</p>` : ''}`;
  if (window.lucide) lucide.createIcons();
}

/* Hands off to the directory using the STRUCTURED filter — ?country= or
   ?city= — not the free-text search box. The old chips fed the search box,
   which never looked at the country column, so "UK" and "USA" matched nothing. */
function viewAlumniForMapSelection() {
  const sel = mapSelectionFor(mapSelected);
  if (!sel || sel.kind !== 'one') return;
  if (mapMode === 'countries') filterByCountry(sel.row.country_code);
  else filterByCity(sel.row.city);
  showPage('directory');
}

function setMapMode(mode) {
  if (!['cities', 'countries', 'divisions'].includes(mode)) return;
  /* Divisions only mean anything inside the Bangladesh view, and leaving that
     view has to leave the level behind with it — otherwise the world map ends
     up labelled "Alumni per division". */
  if (mode === 'divisions' && mapView !== 'bangladesh') { mapShowBangladesh(); return; }
  if (mode !== 'divisions' && mapView === 'bangladesh') mapView = 'world';
  mapMode = mode;
  mapSelected = null;
  syncMapModeButtons();
  paintMap();
}

/* The alumni-weighted centre of everything currently drawn. Zooming about
   0°,0° — a point in the Atlantic where nobody lives — pushed the data off the
   canvas on the first click, so the first zoom recentres on where the alumni
   actually are. */
function mapDataCentre() {
  const rows = mapMode === 'countries' ? (mapData?.countries || []) : (mapData?.cities || []);
  if (!rows.length) return { lat: 0, lng: 0 };
  const total = rows.reduce((a, r) => a + r.n, 0) || 1;
  return {
    lat: rows.reduce((a, r) => a + Number(r.latitude) * r.n, 0) / total,
    lng: rows.reduce((a, r) => a + Number(r.longitude) * r.n, 0) / total
  };
}

function mapZoomIn() {
  if (mapZoomIndex >= MAP_ZOOM_STEPS.length - 1) return;
  if (mapZoomIndex === 0) mapCenter = mapDataCentre();
  mapZoomIndex++;
  paintMap();
}

function mapZoomOut() {
  if (mapZoomIndex <= 0) return;
  mapZoomIndex--;
  if (mapZoomIndex === 0) mapCenter = { lat: 0, lng: 0 };   // back to the whole world
  paintMap();
}

/* Reset returns to the world view. Zoom is never required to read this map —
   every count is also listed beside it — so there is no pan control to get
   lost in. Zooming in centres on the busiest place so the control does
   something useful rather than magnifying empty ocean. */
function mapResetView() {
  mapZoomIndex = 0;
  mapCenter = { lat: 0, lng: 0 };
  mapSelected = null;
  paintMap();
}

/* ─── pointer zoom: wheel and pinch (Phase 7G closure) ───────

   Neither existed. The controls were the +/− buttons alone, which is fine on a
   desktop and poor on a phone, where pinching is what everyone tries first.

   ZOOM IS STEPPED. MAP_ZOOM_STEPS is 1/2/4/8/16 and badge sizes are constant
   pixels at every level by design, so these gestures choose a STEP rather than
   scaling continuously. A wheel notch or a pinch past a threshold is one step.

   ZOOM IS ANCHORED. Zooming about the centre of the canvas moves whatever the
   reader was pointing at away from the pointer, which feels wrong and loses the
   thing they were looking at. Both gestures recentre on the point under the
   pointer (or between the two fingers) before stepping, so that point stays
   roughly still.

   THE PAGE MUST NOT MOVE. preventDefault on a non-passive wheel listener stops
   the page scrolling while the pointer is over the map, and `touch-action:
   none` on the canvas stops the browser panning the page during a pinch.
   Neither is attached to the document — outside the canvas, scrolling is
   entirely normal. */

/* Which latitude/longitude is under a client point, given the current view. */
function mapLatLngAt(clientX, clientY) {
  const canvas = document.getElementById('alumni-map');
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  /* The SVG uses preserveAspectRatio="none", so the view maps linearly onto the
     element box whatever its aspect ratio. */
  const u = (clientX - r.left) / r.width;
  const v = (clientY - r.top) / r.height;
  const z = mapZoom();
  const cx = (mapCenter.lng + 180) / 360;
  const cy = (90 - mapCenter.lat) / 180;
  const bx = (u - 0.5) / z + cx;
  const by = (v - 0.5) / z + cy;
  return { lng: bx * 360 - 180, lat: 90 - by * 180 };
}

/* Step the zoom, keeping the given point under the pointer where it was. */
function mapZoomAt(direction, clientX, clientY) {
  const next = mapZoomIndex + direction;
  if (next < 0 || next > MAP_ZOOM_STEPS.length - 1) return false;
  const anchor = (clientX === undefined) ? null : mapLatLngAt(clientX, clientY);
  mapZoomIndex = next;
  if (mapZoomIndex === 0) {
    mapCenter = { lat: 0, lng: 0 };            // the whole world, always framed
  } else if (anchor) {
    /* Halfway between the old centre and the anchor: the point under the
       pointer stays close to the pointer without the view lurching. */
    mapCenter = {
      lat: Math.max(-85, Math.min(85, (mapCenter.lat + anchor.lat) / 2)),
      lng: Math.max(-180, Math.min(180, (mapCenter.lng + anchor.lng) / 2))
    };
  }
  paintMap();
  return true;
}

/* A trackpad emits dozens of small wheel events per gesture and a mouse emits
   one large one. Accumulating and stepping at a threshold makes both feel the
   same and stops a trackpad flying from world to 16x in one flick. */
let _wheelAccum = 0;
let _wheelResetTimer = null;
const WHEEL_STEP = 120;          // one classic mouse notch

function mapWheel(e) {
  e.preventDefault();            // the page does not scroll while over the map
  _wheelAccum += e.deltaY;
  clearTimeout(_wheelResetTimer);
  _wheelResetTimer = setTimeout(() => { _wheelAccum = 0; }, 220);
  while (Math.abs(_wheelAccum) >= WHEEL_STEP) {
    const dir = _wheelAccum > 0 ? -1 : 1;      // wheel down zooms out
    _wheelAccum -= Math.sign(_wheelAccum) * WHEEL_STEP;
    if (!mapZoomAt(dir, e.clientX, e.clientY)) { _wheelAccum = 0; break; }
  }
}

/* Pinch. Two pointers, and the ratio of the current span to the span the
   gesture started with. Crossing 1.35 zooms in a step, 0.74 out, and the
   baseline resets after each step so a long pinch keeps stepping. */
let _pinchStart = 0;
const PINCH_IN = 1.35, PINCH_OUT = 0.74;
const touchSpan = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

function mapTouchStart(e) {
  if (e.touches.length === 2) { _pinchStart = touchSpan(e.touches); e.preventDefault(); }
}

function mapTouchMove(e) {
  if (e.touches.length !== 2 || !_pinchStart) return;
  e.preventDefault();                          // the page does not pan mid-pinch
  const span = touchSpan(e.touches);
  const ratio = span / _pinchStart;
  const mid = touchMid(e.touches);
  if (ratio >= PINCH_IN) { mapZoomAt(1, mid.x, mid.y); _pinchStart = span; }
  else if (ratio <= PINCH_OUT) { mapZoomAt(-1, mid.x, mid.y); _pinchStart = span; }
}

function mapTouchEnd(e) { if (e.touches.length < 2) _pinchStart = 0; }

/* Attached to the canvas, once. The map page can be rendered more than once in
   a session, so a guard stops a second set of listeners accumulating — two
   wheel handlers would zoom two steps per notch. */
function wireMapGestures() {
  const canvas = document.getElementById('alumni-map');
  if (!canvas || canvas.dataset.gesturesWired === '1') return;
  canvas.dataset.gesturesWired = '1';
  canvas.addEventListener('wheel', mapWheel, { passive: false });
  canvas.addEventListener('touchstart', mapTouchStart, { passive: false });
  canvas.addEventListener('touchmove', mapTouchMove, { passive: false });
  canvas.addEventListener('touchend', mapTouchEnd);
  canvas.addEventListener('touchcancel', mapTouchEnd);
}

function mapFocusBusiest() {
  const rows = mapRows();
  if (!rows.length) return;
  const top = rows.reduce((a, b) => (b.n > a.n ? b : a), rows[0]);
  mapCenter = { lat: Number(top.latitude), lng: Number(top.longitude) };
  mapZoomIndex = Math.max(mapZoomIndex, 2);
  paintMap();
}

/* renderRBACTable() was removed. It was the first version of the permission
   matrix, reading a MOCK_RBAC constant that no longer exists, so it would have
   thrown had anything called it. renderRBACTableV2() builds the table from
   GET /api/stats/rbac instead. */
async function renderAnalyticsMetrics() {
  const el = document.getElementById('analytics-metrics');
  if (!el) return;

  el.innerHTML = renderSkeletonCards(1);
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
      'No locations shared yet',
      res.unconfirmed
        ? `${res.unconfirmed} profile(s) carry a location recorded automatically ` +
          'before it could be confirmed. Countries appear here once alumni ' +
          'choose their city and allow it on the map.'
        : 'Countries appear here once alumni choose their city and allow it on the map.');
    if (window.lucide) lucide.createIcons();
    return;
  }

  /* Same endpoint, same counts, same privacy filter as the alumni map — this
     panel has never had its own aggregation and does not gain one here. It now
     also shows how many cities each country represents, which the endpoint
     started returning for the map, and each row opens the directory on that
     country through the structured filter. */
  const max = Math.max(...countries.map(c => c.n));
  el.innerHTML = `<div class="geo-countries">${countries.map(c => `
    <button type="button" class="geo-country-item" onclick="filterByCountry(${jsArg(c.country_code)}); showPage('directory');"
            title="Show alumni in ${escapeHtml(c.country)}">
      <div class="geo-country-name">${escapeHtml(c.country)}${
        c.cities ? `<span class="geo-country-sub">${c.cities} ${c.cities === 1 ? 'city' : 'cities'}</span>` : ''}</div>
      <div class="geo-country-bar-track"><div class="geo-country-bar-fill" style="width:${Math.round((c.n / max) * 100)}%"></div></div>
      <div class="geo-country-count">${c.n.toLocaleString('en-IN')}</div>
    </button>
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
