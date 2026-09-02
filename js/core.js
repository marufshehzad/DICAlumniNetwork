/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   core.js

   Shared infrastructure: application state, the DOM and formatting helpers
   every screen uses, the modal and toast systems, icon rendering, the offline
   indicator and the boot sequence.

   There is exactly one implementation of showModal, closeModal, showToast,
   escapeHtml, formatDate, formatRelativeTime and the empty/error/skeleton
   renderers, and it is here.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */

/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   Single-Institution System with 5-Level Role-Based Access Control
   ============================================================ */

'use strict';

/* A map of real administrator e-mail addresses next to a shared password used
   to live here, in a file served unauthenticated to every visitor. Anyone
   reading View Source could sign in as super_admin. Identity now comes only
   from POST /api/auth/login, and those accounts have been rotated. */


/* MOCK_CAMPAIGNS held three fundraising campaigns with raised totals, donor
   counts and days remaining. The campaigns table holds the real ones, and
   /api/campaigns returns their settled totals computed from donations. */

// ─── APP STATE ──────────────────────────────────────────────
let state = {
  currentPage: 'dashboard',
  currentUser: null, // populated only by a successful /api/auth/login or /api/auth/me
  charts: {},
  searchTimeout: null,
  selectedAmount: null,
  analyticsChart: null,
  // Server-side directory query state (search/filter/sort/paging).
  directory: { search: '', batch: '', domain: '', mentor: false, sort: 'name', limit: 12, offset: 0 },
};


// A few widgets appear both on their own page and on the alumni dashboard.
// Returns every live container so both stay in sync — previously the duplicate
// ids meant getElementById only ever found the dashboard copy.
function renderTargets(id) {
  return [document.getElementById(id), document.getElementById("dash-" + id)].filter(Boolean);
}

// ─── SHARED VIEW HELPERS ────────────────────────────────────
// Every value rendered from PostgreSQL passes through escapeHtml — user-authored
// story titles, chapter names and notification text all reach innerHTML.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Legacy data (nav items, chapters, jobs, notifications…) still stores a single
// emoji character per icon field. This maps that character to a Lucide icon
// name so those fields can render as real icons without ever reflecting
// arbitrary text into innerHTML — unmapped input silently falls back.
const EMOJI_ICON_MAP = {
  '🎓':'graduation-cap', '👥':'users', '👤':'user', '🔒':'lock', '🔓':'unlock',
  '🔐':'lock-keyhole', '⚠':'triangle-alert', '✅':'circle-check-big', '✓':'check',
  '✕':'x', '✗':'x', '❌':'circle-x', '🤝':'handshake', '🗑':'trash-2', '🛡':'shield',
  '➕':'plus', '🎫':'ticket', '🎟':'ticket', '📋':'clipboard-list', '🔍':'search',
  '📥':'download', '⬇':'download', '📍':'map-pin', '📌':'pin', '✎':'pen-line',
  '✏':'pen-line', '✐':'pen-line', '📝':'file-text', '🌐':'globe', '🏫':'school',
  '👑':'crown', '⚡':'zap', '🏢':'building-2', '🏛':'landmark', '🚀':'rocket',
  '💰':'circle-dollar-sign', '📱':'smartphone', '📲':'smartphone', '🎉':'party-popper',
  '📊':'bar-chart-3', '📈':'trending-up', '💼':'briefcase', '📜':'scroll-text',
  '🌙':'moon', '🔔':'bell', '🏆':'trophy', '⚙':'settings', '🔄':'refresh-cw',
  '🗳':'vote', '🟢':'circle', '🟡':'circle', '🔴':'circle', '🌟':'sparkle',
  '⭐':'star', '✦':'sparkle', '✨':'sparkles', '🏪':'store', '📅':'calendar',
  '🗓':'calendar-check', '🚚':'truck', '⬡':'hexagon', '📦':'package', '🎨':'palette',
  '🛒':'shopping-cart', '🍎':'wallet', '☀':'sun', '📭':'inbox', '💚':'heart',
  '❤':'heart', '💳':'credit-card', '🔑':'key', '🧩':'puzzle', '☰':'menu',
  '🎙':'mic', '🔤':'languages', '💻':'laptop', '🎪':'layout-grid', '👋':'hand',
  '📚':'book-open', '📷':'camera', '⛔':'ban', '📣':'megaphone', '📢':'megaphone',
  '📰':'newspaper', '🚗':'car', '📡':'satellite', '🪪':'id-card', '📁':'folder',
  '💾':'save', '🎯':'target', '💎':'gem', '💬':'message-circle', '✉':'mail',
  '★':'star', '☆':'star', '🚦':'gauge', '🤖':'bot', '📄':'file-text',
  '↻':'refresh-cw', '↩':'undo-2', '⇅':'repeat', '↑':'trending-up',
  '◉':'users', '◈':'calendar-days', '◎':'id-card', '▦':'layout-dashboard',
  '⏻':'log-out', '⏳':'hourglass', '⏱':'timer', '●':'circle-dot', '○':'circle',
  '◀':'chevron-left', '▲':'chevron-up', '▼':'chevron-down', '⏭':'skip-forward',
  '⊞':'layout-dashboard', '⟁':'webhook', '⊕':'map', '⟳':'users-round', 'ℹ':'info',
  '🇬🇧':'flag', '🇺🇸':'flag',
};

function emojiIcon(rawEmoji, fallbackIconName) {
  // v5 writes Lucide names directly into icon columns; older rows still hold
  // an emoji glyph, so both are accepted and both render as an icon.
  const looksLikeIconName = typeof rawEmoji === 'string' && /^[a-z][a-z0-9-]*$/.test(rawEmoji);
  const name = EMOJI_ICON_MAP[rawEmoji] || (looksLikeIconName ? rawEmoji : null)
             || fallbackIconName || 'circle';
  return `<i data-lucide="${name}" class="ui-icon" aria-hidden="true"></i>`;
}

function formatDate(value) {
  if (!value) return '';
  const s = String(value);
  // Date-only values are formatted from their parts; see evDate().
  const plain = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plain) {
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return plain[3] + ' ' + M[Number(plain[2]) - 1] + ' ' + plain[1];
  }
  const d = new Date(value);
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRelativeTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(value);
}

function renderSkeletonCards(count, variant = 'card') {
  return Array.from({ length: count }, () => `
    <div class="skeleton-card skeleton-${variant}" aria-hidden="true">
      <div class="skeleton-line skeleton-line-lg"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line skeleton-line-sm"></div>
    </div>
  `).join('');
}

function renderEmptyState(icon, title, subtitle = '') {
  return `
    <div class="state-panel state-empty">
      <div class="state-icon">${icon}</div>
      <div class="state-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="state-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;
}

// Surfaces backend failures instead of silently falling back to mock data.
function renderErrorState(message, retryFn) {
  return `
    <div class="state-panel state-error">
      <div class="state-icon"><i data-lucide="triangle-alert" class="ui-icon"></i></div>
      <div class="state-title">${escapeHtml(message)}</div>
      <div class="state-subtitle">The server or database did not respond.</div>
      ${retryFn ? `<button class="btn btn-secondary state-retry" onclick="${retryFn}"><i data-lucide="refresh-cw" class="ui-icon"></i> Retry</button>` : ''}
    </div>
  `;
}

function updateUserUI() {
  const u = state.currentUser;
  const topbarAvatar = document.getElementById('topbar-user-avatar');
  const sidebarAvatar = document.getElementById('sidebar-user-avatar');
  const sidebarName = document.getElementById('sidebar-user-name');
  const sidebarRole = document.getElementById('sidebar-user-role');
  // Read-only: the role is reported by the server, not chosen in the browser.
  const topbarRole = document.getElementById('topbar-role-display');
  const drawerRole = document.getElementById('drawer-role-display');

  if (topbarAvatar) topbarAvatar.textContent = u.initials;
  if (sidebarAvatar) sidebarAvatar.textContent = u.initials;
  if (sidebarName) sidebarName.textContent = u.name;
  if (sidebarRole) sidebarRole.textContent = u.roleLabel;
  if (topbarRole) topbarRole.textContent = u.roleLabel;
  if (drawerRole) drawerRole.textContent = u.roleLabel;
}

// ─── APP INITIALIZATION & ROLE-BASED DASHBOARDS ──────────────
/* Warms the screens a portal actually has.

   Each call is guarded on the function existing, because the two entry points
   load different module lists: the staff portal has no news feed or alumni map,
   the alumni site has no administration screen. Calling a renderer whose module
   is not loaded used to throw and abort the rest of the sequence, leaving the
   page half-initialised. The guard means each portal simply skips what it does
   not have, and no module needs to know which entry point it is running in. */
/* The topbar chip read "PostgreSQL 16 · Live" as a literal in the HTML of both
   portals, with a green dot and nothing behind it. It said Live with the
   database down, and it named a major version the deployment is not obliged to
   be running. It now reports what GET /api/health answered, on the same
   contract as the super admin panel and the external monitor. */
function refreshConnectionChip() {
  const chips = ['offline-status', 'drawer-offline-status']
    .map(id => document.getElementById(id)).filter(Boolean);
  if (!chips.length || typeof API?.health !== 'function') return;
  API.health().then(h => {
    const ok = h && h.status === 'ok' && h.database === 'ok';
    const label = ok ? 'Database · Live'
                : h && h.status === 'degraded' ? 'Database · Unreachable'
                : 'API · No answer';
    chips.forEach(el => {
      const text = el.querySelector('.status-text');
      if (text) text.textContent = label;
      el.classList.toggle('online', ok);
      el.classList.toggle('offline', !ok);
      el.title = ok ? 'GET /api/health answered ok'
                    : 'GET /api/health did not report a healthy system';
    });
  });
}

function initApp() {
  updateUserUI();
  renderSidebarNav(state.currentUser.role);
  renderDashboard();
  refreshConnectionChip();

  const warm = (fn, ...args) => { if (typeof fn === 'function') fn(...args); };

  // Shared between both portals.
  warm(window.renderAlumniGrid);
  warm(window.renderMentorships);
  warm(window.renderCampaignsEnhanced);
  warm(window.renderEventsPage);
  warm(window.renderJobsEnhanced);
  warm(window.renderChapters);
  warm(window.renderNotifications);
  warm(window.renderRBACTableV2);   // every role may read its own permission row

  // Alumni site only.
  warm(window.renderNewsFeed);
  warm(window.renderMapClusters);
  warm(window.renderSpotlightAlumni);
  warm(window.generateGeoHeatmap);

  /* Tiered exactly as the server is. The audit log and the compliance grid are
     ADMIN_ROLES endpoints, so warming them for a moderator or a department
     admin produced a 403 and a console error for panels their navigation does
     not even offer. Analytics is MODERATOR_ROLES and warms for all staff. */
  const role = state.currentUser?.role;
  if (STAFF_ROLES.includes(role)) warm(window.renderAnalyticsMetrics);
  if (ADMIN_ROLES_CLIENT.includes(role)) {
    warm(window.renderAuditLog);
    warm(window.renderComplianceGrid);
  }
}

// Mirrors ADMIN_ROLES on the server. Used only to avoid requesting things the
// caller is not allowed to have; the server remains the boundary.
const ADMIN_ROLES_CLIENT = ['super_admin', 'univ_admin'];

// Matches MODERATOR_ROLES on the server; used only to avoid requesting things
// the caller is not allowed to have.
const STAFF_ROLES = ['super_admin', 'univ_admin', 'dept_admin', 'moderator'];

/* ─── DASHBOARDS ────────────────────────────────────────────
   All five dashboards used to ship their numbers as literals in the template:
   38,420 alumni, ৳45.2L collected, 3,800 mentorships, 89% placement, a 99.4%
   safety index, 18% CPU load. None of it came from the database. Every figure
   below is now read from GET /api/stats/overview, which is a set of COUNT and
   SUM queries over rows that exist, and anything that cannot be counted is not
   shown at all rather than invented. */

/* One fetch each per page load. Four separate renderers need the profile row —
   the completeness banner, the badges, the career timeline and the ten sections
   — and each was requesting it independently. */


// ─── MODALS ──────────────────────────────────────────────────
let _modalReturnFocus = null;
// A data-entry form must not be dismissed by a stray click on the backdrop —
// that would silently throw away everything the user typed. Only read-only
// dialogs (a ticket, a public preview) opt back in via { dismissable: true }.
let _modalDismissable = false;

function showModal(html, options) {
  const opts = options || {};
  const body = document.getElementById('modal-body');
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (body) body.innerHTML = html;

  _modalDismissable = opts.dismissable === true;

  if (content) {
    // The creation wizard needs room for three step labels side by side.
    content.classList.toggle('modal-wide', opts.wide === true);
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    const heading = content.querySelector('.modal-title');
    if (heading) {
      heading.id = heading.id || 'modal-heading';
      content.setAttribute('aria-labelledby', heading.id);
    } else {
      content.removeAttribute('aria-labelledby');
    }
    // Every close control is normalised here rather than trusting each call
    // site: an untyped <button> inside a <form> submits instead of closing.
    content.querySelectorAll('.modal-close').forEach(btn => {
      btn.setAttribute('type', 'button');
      if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'Close');
      btn.dataset.modalClose = '1';
    });
  }

  if (overlay) overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  _modalReturnFocus = (_modalReturnFocus && document.getElementById('modal-overlay') &&
                       !overlay.classList.contains('hidden') && content.contains(document.activeElement))
    ? _modalReturnFocus            // re-render of an already-open dialog: keep the original opener
    : document.activeElement;

  if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();

  requestAnimationFrame(() => {
    const first = content && content.querySelector(
      'input:not([type=hidden]):not([disabled]), select, textarea, button:not(.modal-close), [href], [tabindex]:not([tabindex="-1"])');
    (first || content)?.focus?.();
  });
}

// Delegated close handling. Survives every re-render of the dialog body,
// works for a click on the icon inside the button, and works on touch.
document.addEventListener('click', (e) => {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;

  const closer = e.target.closest && e.target.closest('[data-modal-close], .modal-close');
  if (closer) { e.preventDefault(); e.stopPropagation(); closeModal(); return; }

  // Backdrop: the click landed on the overlay itself, not inside the dialog.
  if (e.target === overlay && _modalDismissable) closeModal();
});

// Keeps Tab inside an open dialog rather than letting it walk the page behind.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  const content = document.getElementById('modal-content');
  if (!content) return;

  const focusable = [...content.querySelectorAll(
    'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null || el === document.activeElement);
  if (!focusable.length) return;

  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function openModal(html) {
  showModal(html);
}
window.openModal = showModal;

function closeModal(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  _modalDismissable = false;
  // Hand focus back to whatever opened the dialog.
  if (_modalReturnFocus && document.contains(_modalReturnFocus)) {
    try { _modalReturnFocus.focus(); } catch (err) { /* element may be gone */ }
  }
  _modalReturnFocus = null;
}

// Escape closes whichever modal is open, independent of where the click
// actually lands — a keyboard-driven fallback for the close button.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlay = document.getElementById('modal-overlay');
  if (overlay && !overlay.classList.contains('hidden')) closeModal();
});

// ─── TOAST NOTIFICATION ──────────────────────────────────────
// message is developer-authored text that may embed a leading emoji plus
// server- or user-derived data (names, error strings). The emoji is mapped
// to a safe, fixed icon element; everything else stays textContent so
// interpolated data can never be interpreted as markup.
function showToast(message, iconName) {
  let toast = document.getElementById('toast-container');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-container';
    toast.className = 'toast-stack';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }

  const t = document.createElement('div');
  t.className = 'toast';

  // v5 callers pass a Lucide name. Older callers still prefix an emoji, which
  // is mapped to the equivalent icon and stripped from the text.
  let name = iconName || null;
  if (!name) {
    const lead = message.match(/^(\S+)\s*/);
    if (lead && EMOJI_ICON_MAP[lead[1]]) {
      name = EMOJI_ICON_MAP[lead[1]];
      message = message.slice(lead[0].length);
    }
  }
  if (name) {
    const iconEl = document.createElement('i');
    iconEl.setAttribute('data-lucide', name);
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.className = 'ui-icon toast-icon';
    t.appendChild(iconEl);
  }

  const span = document.createElement('span');
  span.textContent = message;
  t.appendChild(span);

  toast.appendChild(t);
  if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
}

// Add toast keyframes
const style = document.createElement('style');
style.textContent = `
@keyframes slideInRight { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100px); opacity: 0; } }
`;
document.head.appendChild(style);

/* simulateOffline() sat here, wired to a click on the topbar status pill. It
   flipped a local boolean - it never checked the network - and claimed an
   "Offline Queue Active" outbox and a sync of "247 records". There is no
   client-side outbox (js/admin.js says as much where the sync panel is drawn),
   no service worker and no IndexedDB, so nothing was ever queued: while the
   pill read "offline", writes failed normally. Removed along with its click
   binding; the pill is now inert rather than lying. */

// ─── MOBILE PROGRESSIVE DISCLOSURE HELPER ───
function toggleProgressiveDisclosure(targetId, btn) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const isHidden = target.classList.contains('hidden');
  if (isHidden) {
    target.classList.remove('hidden');
    if (btn) btn.innerHTML = '<i data-lucide="chevron-up" class="ui-icon"></i> Show Less';
  } else {
    target.classList.add('hidden');
    if (btn) btn.innerHTML = '<i data-lucide="chevron-down" class="ui-icon"></i> Show More';
  }
}

// ─── INSTANT MOBILE & DESKTOP DOM INITIALIZER ────────────────
let __appInitialized = false;
// Boot: restore an existing session if the stored token is still valid,
// otherwise show the login screen. This previously called enterApp()
// unconditionally, which walked straight past authentication.
async function initAppOnce() {
  if (__appInitialized) return;
  __appInitialized = true;

  // A ?reset=<token> link opens the set-a-new-password screen instead of the
  // ordinary sign-in form.
  if (typeof initAuthScreen === 'function') initAuthScreen();

  const user = await API.me();
  if (user) {
    enterAuthenticatedApp(user);
  } else {
    API.logout();
    showLoginScreen();
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(initAppOnce, 1);
} else {
  document.addEventListener('DOMContentLoaded', initAppOnce);
  window.addEventListener('load', initAppOnce);
}

// ─── LUCIDE ICON RENDERING ────────────────────────────────────
// The UI is built almost entirely from innerHTML template strings, so
// <i data-lucide="..."> placeholders keep appearing as the app re-renders.
// Re-scanning after every DOM mutation (instead of after each render call)
// means every one of those call sites gets icons for free.
(function () {
  function renderIcons() {
    if (window.lucide) lucide.createIcons();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderIcons);
  } else {
    renderIcons();
  }
  // Trailing debounce rather than a single rAF: the app's dashboards render
  // progressively as each API call resolves, so mutations can land across
  // several ticks. Each new mutation pushes the timer back, guaranteeing a
  // final createIcons() pass once the burst actually settles.
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderIcons, 50);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

function money(v) {
  const n = Number(v) || 0;
  if (n >= 100000) return '৳' + (n / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
  return '৳' + n.toLocaleString('en-IN');
}

/* The four tiles above the campaign grid, computed from the campaigns the API
   returned. Every figure is a sum or count over settled donations; when there
   are none, the tiles read ৳0 and 0 rather than last year's marketing numbers. */

// ─── COMPLIANCE: DSAR & IDENTITY VAULT ───

function downloadTextFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
