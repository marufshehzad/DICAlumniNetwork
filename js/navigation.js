/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   navigation.js

   Page switching and the role-aware sidebar. showPage() is the single
   authoritative implementation and lives here.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


/* Which portal this page is. The entry point sets it: index.html leaves it
   alone (alumni), admin.html sets 'admin' before the modules load. Everything
   portal-specific reads this one flag, so neither entry point needs its own
   copy of the navigation or the page list. */
const PORTAL = (typeof window !== 'undefined' && window.DIC_PORTAL) || 'alumni';
const isAdminPortal = () => PORTAL === 'admin';

/* The admin portal's navigation. Every entry is backed by an endpoint that
   exists — see the audit. Modules the platform does not have (system settings,
   an admin notifications inbox) are absent rather than present and empty. */
const ADMIN_NAV = [
  { id: 'dashboard',      icon: '⊞',             label: 'Dashboard',        roles: ['moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'directory',      icon: '◉',             label: 'Alumni',           roles: ['moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'events',         icon: 'calendar-days', label: 'Events',           roles: ['moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'jobs',           icon: '✦',             label: 'Jobs',             roles: ['dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'mentorship',     icon: '⟳',             label: 'Mentorship',       roles: ['moderator', 'univ_admin', 'super_admin'] },
  { id: 'donations',      icon: '❤',             label: 'Donations',        roles: ['univ_admin', 'super_admin'] },
  { id: 'chapters',       icon: '⬡',             label: 'Chapters',         roles: ['univ_admin', 'super_admin'] },
  { id: 'moderation',     icon: 'shield-check',  label: 'Moderation',       roles: ['moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'broadcasts',     icon: 'megaphone',     label: 'Broadcasts',       roles: ['univ_admin', 'super_admin'] },
  { id: 'analytics',      icon: '▦',             label: 'Reports',          roles: ['dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'segmentation',   icon: 'target',        label: 'Segmentation',     roles: ['moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
  { id: 'compliance',     icon: 'shield',        label: 'Compliance',       roles: ['univ_admin', 'super_admin'] },
  { id: 'administration', icon: 'users',         label: 'Administration',   isDivider: true, roles: ['super_admin'] },
  { id: 'audit',          icon: 'scroll-text',   label: 'Audit Logs',       roles: ['univ_admin', 'super_admin'] }
];

// ─── DYNAMIC SIDEBAR NAV PER ROLE ───────────────────────────
function renderSidebarNav(role) {
  const container = document.getElementById('sidebar-nav-container');
  if (!container) return;

  const navItems = isAdminPortal() ? ADMIN_NAV : [
    { id: 'dashboard', icon: '⊞', label: 'Dashboard', roles: ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
    { id: 'directory', icon: '◉', label: 'Alumni Directory', roles: ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
    // The badge on this item read a literal "3" against a mentorships table
    // holding no rows, and the Job Board badge below read a literal "5". Both
    // are gone; a count in the navigation would need to be fetched, and neither
    // is worth a request on every render.
    { id: 'mentorship', icon: '⟳', label: 'Mentorship Hub', roles: ['alumni', 'moderator', 'univ_admin', 'super_admin'] },
    { id: 'donations', icon: '❤', label: 'Donations & Funds', roles: ['alumni', 'univ_admin', 'super_admin'] },
    { id: 'events', icon: 'calendar-days', label: 'Events & Tickets', roles: ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
    { id: 'jobs', icon: '✦', label: 'Job Board', roles: ['alumni', 'dept_admin', 'univ_admin', 'super_admin'] },
    { id: 'analytics', icon: '▦', label: 'Executive Analytics', roles: ['dept_admin', 'univ_admin', 'super_admin'] },
    { id: 'chapters', icon: '⬡', label: 'DIC Chapters', roles: ['alumni', 'univ_admin', 'super_admin'] },
    { id: 'news', icon: '✐', label: 'DIC News Feed', roles: ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
    { id: 'map', icon: '⊕', label: 'Alumni Map', roles: ['alumni', 'univ_admin', 'super_admin'] },
    { id: 'profile', icon: '◎', label: 'My DIC Profile', isDivider: true, roles: ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin'] },
    /* The admin panel link is gone from the alumni portal: administration now
       lives at /admin, a separate entry point that does not load admin.js or
       compliance.js at all. */
  ];

  const allowed = navItems.filter(item => item.roles.includes(role));

  container.innerHTML = allowed.map(item => `
    ${item.isDivider ? '<div class="nav-divider"></div>' : ''}
    <a class="nav-item ${item.id === state.currentPage ? 'active' : ''}" onclick="showPage('${item.id}')" id="nav-${item.id}">
      <span class="nav-icon">${emojiIcon(item.icon, 'circle')}</span>
      <span class="nav-label">${item.label}</span>
      ${item.badge ? `<span class="nav-badge ${item.badgeNew ? 'new' : ''}" ${item.badgeTeal ? 'style="background:var(--teal);color:var(--bg-deep)"' : ''}>${item.badge}</span>` : ''}
    </a>
  `).join('');
}

// ─── NAVIGATION ─────────────────────────────────────────────
/* Pages the signed-in role may not open, whatever it types into the console.
   showPage() used to be a pure DOM toggle: the sidebar link was role-gated, but
   showPage('admin') rendered the whole DIC Admin Control Center shell for an
   alumnus — the tab bar naming Bulk Import, RBAC, Audit Log, Compliance Vault
   and the rest. Every panel inside was empty because the API refuses the token,
   so nothing leaked but the structure; it still had no business being reachable.

   This is a usability guard, not the security boundary. The boundary is the
   server, which refuses all 20 admin endpoints for a non-staff token. */
const PAGE_ROLES = {
  admin:          ['univ_admin', 'super_admin'],
  analytics:      ['dept_admin', 'univ_admin', 'super_admin'],
  administration: ['super_admin'],
  moderation:     ['moderator', 'dept_admin', 'univ_admin', 'super_admin'],
  broadcasts:     ['univ_admin', 'super_admin'],
  segmentation:   ['moderator', 'dept_admin', 'univ_admin', 'super_admin'],
  compliance:     ['univ_admin', 'super_admin'],
  audit:          ['univ_admin', 'super_admin'],
};

function canOpenPage(page) {
  const allowed = PAGE_ROLES[page];
  if (!allowed) return true;
  return !!state.currentUser && allowed.includes(state.currentUser.role);
}

function showPage(page) {
  if (!canOpenPage(page)) {
    if (typeof showToast === 'function') showToast('⚠ You do not have access to that page.');
    return;
  }

  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) {
    target.classList.remove('hidden');
    target.classList.add('active');
  }

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.getElementById('nav-' + page);
  if (navItem) navItem.classList.add('active');

  document.querySelectorAll('.bottom-nav-item').forEach(n => n.classList.remove('active'));
  const bnavItem = document.getElementById('bnav-' + page);
  if (bnavItem) bnavItem.classList.add('active');

  state.currentPage = page;

  // Close sidebar on mobile
  if (window.innerWidth < 900) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('open');
  }

  /* What each page renders when you arrive on it.

     Every call goes through render(), which skips anything the loaded modules
     do not declare. The two entry points load different module lists — the
     alumni site has no administration screen, the staff portal has no news feed
     or profile hub — so the same table serves both and neither needs its own
     copy. Without the guard, navigating to a page whose module is absent threw
     and left the view half-built. */
  const render = (fn, ...args) => { if (typeof fn === 'function') fn(...args); };

  const ON_ENTER = {
    dashboard:      () => render(window.renderDashboard),
    directory:      () => render(window.renderAlumniGrid),
    mentorship:     () => render(window.renderMentorships),
    donations:      () => render(window.renderCampaignsEnhanced),
    events:         () => render(window.renderEventsPage),
    chapters:       () => render(window.renderChapters),
    map:            () => render(window.renderMapClusters),
    jobs:           () => { render(window.renderJobReferrals); render(window.renderJobsEnhanced); },
    news:           () => {
      render(window.renderNewsFeed);
      render(window.renderActivePoll);
      render(window.renderTrendingTags);
      render(window.renderPastPolls);
      render(window.renderSpotlightAlumni);
    },
    profile:        () => {
      // Load the real row first; the ten sections read from FULL_USER_PROFILE.
      if (typeof hydrateUserProfile === 'function') {
        hydrateUserProfile().then(() => render(window.render10SectionProfile));
      }
      render(window.renderCareerTimeline);
      render(window.paintProfileCompleteness, 'profile-completeness-bar',
             'profile-completeness-ring', 'profile-completeness-text',
             'profile-completeness-items');
      render(window.renderEngagementScore);
      render(window.renderAlumniBadges);
    },
    analytics:      () => {
      if (!state.analyticsChart && typeof initAnalyticsChart === 'function') {
        setTimeout(initAnalyticsChart, 100);
      }
      render(window.renderAnalyticsMetrics);
      render(window.generateGeoHeatmap);
    },

    // Staff portal only. Each is a focused screen over an endpoint that already
    // exists, rather than a tab inside the old single admin panel.
    moderation:     () => render(window.renderModerationPanel),
    broadcasts:     () => render(window.renderBroadcastHistory),
    segmentation:   () => render(window.renderSegmentationPanel),
    audit:          () => render(window.renderAuditLog, 'audit-log-page'),
    administration: () => render(window.renderAdministrationPage),
    compliance:     () => {
      render(window.renderComplianceGrid);
      render(window.renderNIDVaultPanel);
    },
  };

  if (ON_ENTER[page]) ON_ENTER[page]();

  // Scroll to top
  const pagesContainer = document.getElementById('pages');
  if (pagesContainer) pagesContainer.scrollTop = 0;
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}
