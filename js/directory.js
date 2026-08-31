/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   directory.js

   The alumni directory: search, filters, sorting, paging and the
   Bangla transliteration hint.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


// Directory is served from PostgreSQL. Search, filters, sorting and paging are
// all query parameters — the browser no longer filters a hardcoded array.
async function renderAlumniGrid({ append = false } = {}) {
  const containers = renderTargets('alumni-grid');
  if (!containers.length) return;
  const container = containers[0];

  const d = state.directory;
  const countEl = document.getElementById('dir-count');
  const loadMoreWrap = document.querySelector('.load-more-container');

  if (!append) containers.forEach(c => c.innerHTML = renderSkeletonCards(4, 'alumni'));
  if (countEl && !append) countEl.textContent = 'Loading profiles…';

  const result = await API.getAlumni({
    search: d.search, batch: d.batch, domain: d.domain,
    mentor: d.mentor, sort: d.sort, limit: d.limit, offset: d.offset
  });

  if (result === null) {
    container.innerHTML = renderErrorState('Could not load the alumni directory.', 'renderAlumniGrid()');
    if (countEl) countEl.textContent = '';
    if (loadMoreWrap) loadMoreWrap.style.display = 'none';
    return;
  }

  const { alumni, total } = result;

  if (total === 0) {
    container.innerHTML = renderEmptyState('<i data-lucide="search" class="ui-icon"></i>', 'No profiles match your search',
      'Try a different name, company, skill, batch year or location.');
    if (countEl) countEl.textContent = 'Showing 0 profiles';
    if (loadMoreWrap) loadMoreWrap.style.display = 'none';
    return;
  }

  const cards = alumni.map(renderAlumniCard).join('');
  containers.forEach(c => append ? c.insertAdjacentHTML('beforeend', cards) : (c.innerHTML = cards));

  const shownCount = container.querySelectorAll('.alumni-card').length;
  if (countEl) countEl.textContent = `Showing ${shownCount} of ${total} profile${total === 1 ? '' : 's'}`;
  if (loadMoreWrap) loadMoreWrap.style.display = shownCount < total ? '' : 'none';
}

function loadMoreAlumni() {
  state.directory.offset += state.directory.limit;
  renderAlumniGrid({ append: true });
}

function filterDirectory(value) {
  clearTimeout(state.searchTimeout);
  const indicator = document.getElementById('search-indicator');
  if (indicator) indicator.style.display = 'flex';
  state.searchTimeout = setTimeout(() => {
    if (indicator) indicator.style.display = 'none';
    state.directory.search = value;
    state.directory.offset = 0;
    renderAlumniGrid();
  }, 400);
}

// Chip filters map onto real query parameters instead of slicing a local array.
function toggleChip(el, filter) {
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');

  const d = state.directory;
  d.offset = 0;
  d.mentor = false;
  d.batch = '';
  d.domain = '';
  d.search = '';

  if (filter === 'mentor') d.mentor = true;
  else if (/^\d{4}$/.test(filter)) d.batch = filter;
  else if (['tech', 'finance', 'design', 'business'].includes(filter)) d.domain = filter;
  else if (filter !== 'all') d.search = filter; // location chips: dhaka / uk / usa

  const searchBox = document.getElementById('dir-search');
  if (searchBox) searchBox.value = d.search;

  renderAlumniGrid();
}

function connectAlumni(name, btn) {
  if (!state.connectedAlumni) state.connectedAlumni = {};
  if (state.connectedAlumni[name]) {
    showToast('ℹ️ Connection request already sent to ' + name);
    return;
  }
  state.connectedAlumni[name] = true;
  
  if (btn) {
    btn.innerHTML = '<i data-lucide="check" class="ui-icon"></i> Connected';
    btn.classList.add('connected');
    btn.setAttribute('disabled', 'true');
    btn.style.background = 'rgba(0,212,170,0.15)';
    btn.style.color = 'var(--teal)';
    btn.style.borderColor = 'rgba(0,212,170,0.4)';
  } else {
    document.querySelectorAll('.connect-btn').forEach(b => {
      if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(name)) {
        b.innerHTML = '<i data-lucide="check" class="ui-icon"></i> Connected';
        b.classList.add('connected');
        b.setAttribute('disabled', 'true');
        b.style.background = 'rgba(0,212,170,0.15)';
        b.style.color = 'var(--teal)';
        b.style.borderColor = 'rgba(0,212,170,0.4)';
      }
    });
  }
  
  showToast('🤝 Connection request sent to ' + name + '!');
}

// Single card renderer shared by the directory grid and the dashboard
// recommendations — these were two near-identical copies that had already
// drifted apart (one omitted the verified ring, the other the click target).
function renderAlumniCard(a) {
  const isConn = state.connectedAlumni && state.connectedAlumni[a.name];
  const color = a.color || '#00A859';
  const nameAttr = escapeHtml(a.name).replace(/'/g, '&#39;');
  const subtitle = [a.role, a.company].filter(Boolean).join(' · ') || 'Profile incomplete';

  return `
    <div class="alumni-card" onclick="viewAlumniProfile(${a.id})">
      <div class="alumni-card-top">
        <div class="alumni-avatar ${a.verified ? 'verified-ring' : ''}" style="background: linear-gradient(135deg, ${color}40, ${color}20);">
          <span style="color:${color}">${escapeHtml(a.initials)}</span>
          ${a.verified ? '<div class="verified-badge-icon"><i data-lucide="check" class="ui-icon"></i></div>' : ''}
        </div>
        <div class="alumni-card-info">
          <div class="alumni-card-name">${escapeHtml(a.name)}</div>
          <div class="alumni-card-role">${escapeHtml(subtitle)}</div>
          <div class="alumni-card-location"><i data-lucide="map-pin" class="ui-icon"></i> ${escapeHtml(a.location || 'Location not set')}${a.batch ? ` · Batch ${a.batch}` : ''}</div>
        </div>
      </div>
      <div class="alumni-tags">
        ${(a.skills || []).map(s => `<span class="alumni-tag">${escapeHtml(s)}</span>`).join('')}
        ${a.mentor ? '<span class="alumni-tag mentor-tag"><i data-lucide="handshake" class="ui-icon"></i> Mentor</span>' : ''}
      </div>
      <div class="alumni-card-actions">
        <button class="connect-btn ${isConn ? 'connected' : ''}"
                onclick="event.stopPropagation(); connectAlumni('${nameAttr}', this)"
                ${isConn ? 'disabled' : ''}>${isConn ? '<i data-lucide="check" class="ui-icon"></i> Connected' : '+ Connect'}</button>
        ${a.mentor ? `<button class="mentor-req-btn" onclick="event.stopPropagation(); showMentorModal('${nameAttr}', ${a.id})"><i data-lucide="handshake" class="ui-icon"></i> Request Mentorship</button>` : ''}
      </div>
    </div>`;
}

// Previously ignored its argument entirely and just re-rendered the same order.
function sortDirectory(by) {
  state.directory.sort = by === 'relevance' ? 'name' : by;
  state.directory.offset = 0;
  renderAlumniGrid();
}


function handleGlobalSearch(value) {
  if (value.length > 2) {
    setTimeout(() => {
      if (state.currentPage !== 'directory') {
        showPage('directory');
        document.getElementById('dir-search').value = value;
        filterDirectory(value);
      }
    }, 300);
  }
}

// ============================================================
// GAP-FIX ADDITIONS — REQ-01, REQ-03, REQ-05, REQ-07, REQ-08
//                     REQ-09, REQ-10, REQ-12, REQ-18
// ============================================================

// ─── REQ-03: BANGLA TRANSLITERATION DETECTION ────────────────
const BANGLA_RANGE = /[\u0980-\u09FF]/;
const _origFilterDir = filterDirectory;
filterDirectory = function(value) {
  const badge = document.getElementById('transliteration-badge');
  if (badge) {
    if (BANGLA_RANGE.test(value)) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  _origFilterDir(value);
};

/* The "real-time campaign ticker" was removed. Every few seconds it picked a
   random increment from [500, 1000, 2000, 5000], added it to a campaign's raised
   total and incremented the donor count, then wrote the result into the page —
   inventing donations that nobody had made and that no donations row recorded.
   Campaign totals now come from SUM(amount) over settled donations and change
   only when somebody actually donates. */

// ─── DONATIONS (REQ-05) ───
// Two-phase: a PENDING ledger row is written, the gateway step is authorised,
// then the transaction is confirmed and the campaign total moves.
/* Money in taka. Small sums are shown in full rather than rounded into lakh —
   "৳0.1L" for a ৳5,000 donation reads as a rounding artefact and hides the real
   figure, which is exactly the problem this page had. */
/* Campaigns store days_left as a plain integer written once, at creation, and
   never decremented — so a campaign created on 5 August with 18 days on it was
   still advertising "18 days left" four weeks after it closed. There is no end
   date column, but created_at + days_left is one, so the remaining days are
   counted from that and a campaign past its date says so. */
