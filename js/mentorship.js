/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   mentorship.js

   Mentorship requests, the suggestion list and the shared-attribute
   comparison behind it.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */

function sharedProfileAttributes(profile) {
  const me = FULL_USER_PROFILE || {};
  const same = (a, b) => a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const out = [];
  if (same(me.department, profile.department)) out.push('Department: ' + profile.department);
  if (same(me.batch, profile.batch)) out.push('Batch ' + profile.batch);
  if (same(me.city, profile.city)) out.push('City: ' + profile.city);
  if (same(me.industry, profile.industry)) out.push('Industry: ' + profile.industry);
  if (same(me.currentCompany, profile.company)) out.push('Organisation: ' + profile.company);

  // Skills overlap. The profile endpoint returns an array; the signed-in user's
  // own row is a comma-separated string, so both shapes are normalised here.
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const mine = list(me.skills);
  const theirs = list(profile.skills);
  const both = mine.filter(x => theirs.includes(x));
  if (both.length) out.push('Shared skill' + (both.length === 1 ? '' : 's') + ': ' + both.slice(0, 3).join(', '));
  return out;
}

// ─── MENTORSHIP (REQ-04) ───
/* The suggestion card used to show "${m.match_score}%" from a weighted score
   that handed every mentor 25 points before comparing anything real (see the
   note on /api/mentorships/suggestions). The API now returns which of the four
   comparable attributes matched, so the card names them. */
/* Replaces the Quota Tracker, which showed "2/5 Mentee Slots" and "3 available
   this month" to everyone. No quota exists in the schema and nothing limits how
   many mentees a mentor may take, so this reports the caller's real counts. */
function renderMentorshipActivity(data) {
  const el = document.getElementById('mentorship-activity');
  if (!el) return;
  const all = [...data.asMentor, ...data.asMentee];
  const rows = [
    ['Mentoring others', data.asMentor.filter(m => m.status === 'accepted').length],
    ['Being mentored', data.asMentee.filter(m => m.status === 'accepted').length],
    ['Requests awaiting my answer', data.incoming.length],
    ['Requests I have sent', data.asMentee.filter(m => m.status === 'pending').length],
    ['Completed', all.filter(m => m.status === 'completed').length]
  ];
  el.innerHTML = `<div class="totals-list">${rows.map(([k, v]) => `
    <div class="totals-row"><span class="totals-key">${k}</span><span class="totals-val">${v}</span></div>`).join('')}</div>`;
}

function matchSummary(m) {
  const hits = [];
  if (m.matched_industry) hits.push('industry');
  if (m.matched_skill) hits.push('skills');
  if (m.matched_city) hits.push('city');
  if (m.matched_department) hits.push('department');
  if (!hits.length) return '<span class="match-score-badge" title="No shared industry, skill, city or department">No shared attributes</span>';
  return `<span class="match-score-badge" title="Shared with you: ${escapeHtml(hits.join(', '))}">Shares ${hits.length} of 4</span>`;
}

async function renderMentorships() {
  const list = document.getElementById('mentorship-list');
  const pending = document.getElementById('pending-requests');
  const suggested = document.getElementById('suggested-mentors');

  if (list) list.innerHTML = renderSkeletonCards(2, 'mentor');

  const [data, suggestions] = await Promise.all([API.getMentorships(), API.getMentorSuggestions()]);

  if (list) {
    if (apiFailed(data)) {
      list.innerHTML = renderErrorState(data?.error || 'Could not load mentorships.', 'renderMentorships()');
    } else {
      const active = [...data.asMentor, ...data.asMentee].filter(m => m.status === 'accepted');
      list.innerHTML = active.length ? active.map(m => {
        const isMentor = m.mentor_id === state.currentUser.id;
        const other = isMentor ? m.mentee_name : m.mentor_name;
        const initials = isMentor ? m.mentee_initials : m.mentor_initials;
        return `
        <div class="mentorship-connection">
          <div class="alumni-avatar" style="width:44px;height:44px;background:linear-gradient(135deg,rgba(11,56,151,0.3),rgba(0,212,170,0.3));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;">${escapeHtml(initials || '??')}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${escapeHtml(other)}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(m.subject)}</div>
          </div>
          <span class="mentorship-type-badge ${isMentor ? 'mentor' : 'mentee'}">${isMentor ? '<i data-lucide="graduation-cap" class="ui-icon"></i> Mentoring' : '<i data-lucide="book-open" class="ui-icon"></i> Learning'}</span>
          <button class="btn btn-ghost btn-sm" onclick="respondToMentorship(${m.id}, 'complete')">Complete</button>
        </div>`;
      }).join('') : renderEmptyState('<i data-lucide="handshake" class="ui-icon"></i>', 'No active mentorships', 'Accepted mentorship connections will appear here.');
    }
  }

  if (pending) {
    if (apiFailed(data)) {
      pending.innerHTML = '';
    } else if (data.incoming.length === 0) {
      pending.innerHTML = renderEmptyState('<i data-lucide="inbox" class="ui-icon"></i>', 'No pending requests');
    } else {
      pending.innerHTML = data.incoming.map(r => {
        const daysLeft = Math.max(0, Math.ceil((new Date(r.expires_at) - Date.now()) / 86400000));
        return `
        <div class="pending-request">
          <div class="alumni-avatar" style="width:40px;height:40px;background:linear-gradient(135deg,rgba(255,140,66,0.3),rgba(192,132,252,0.2));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;">${escapeHtml(r.mentee_initials || '??')}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${escapeHtml(r.mentee_name)}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(r.subject)}</div>
          </div>
          <span class="expiry-badge"><i data-lucide="timer" class="ui-icon"></i> ${daysLeft}d left</span>
          <button class="btn btn-sm btn-primary" onclick="respondToMentorship(${r.id}, 'accept')">Accept</button>
          <button class="btn btn-sm btn-ghost" onclick="respondToMentorship(${r.id}, 'decline')">Decline</button>
        </div>`;
      }).join('');
    }
  }

  // The two card badges read a literal 4 and "3 pending"; they now count the
  // rows this same request returned.
  if (!apiFailed(data)) {
    const activeEl = document.getElementById('mentorship-active-count');
    const pendEl = document.getElementById('mentorship-pending-count');
    const activeN = [...data.asMentor, ...data.asMentee].filter(m => m.status === 'accepted').length;
    if (activeEl) activeEl.textContent = String(activeN);
    if (pendEl) pendEl.textContent = data.incoming.length + ' pending';
    renderMentorshipActivity(data);
  }

  // What the four comparisons behind the suggestion list actually are.
  const crit = document.getElementById('matching-criteria');
  if (crit) {
    crit.innerHTML = [
      ['Same industry', 'alumni_profiles.industry'],
      ['Overlapping skills', 'alumni_profiles.skills'],
      ['Same city', 'alumni_profiles.city'],
      ['Same department', 'alumni_profiles.department']
    ].map(([label, src]) => `
      <div class="criterion-item">
        <div class="criterion-label">${label}</div>
        <div class="criterion-source">${src}</div>
      </div>`).join('') +
      `<div class="chapter-empty-note" style="margin-top:10px">
        A mentor is suggested when they offer mentoring and you have no open
        request with them. The card shows how many of these four match; there is
        no weighting and no score.
      </div>`;
  }

  if (suggested) {
    if (apiFailed(suggestions)) {
      suggested.innerHTML = renderErrorState('Could not load mentor suggestions.', 'renderMentorships()');
    } else if (suggestions.length === 0) {
      suggested.innerHTML = renderEmptyState('<i data-lucide="sparkles" class="ui-icon"></i>', 'No mentor matches yet');
    } else {
      suggested.innerHTML = suggestions.map(m => `
        <div class="suggested-mentor-card">
          <div class="alumni-avatar" style="width:40px;height:40px;background:linear-gradient(135deg,${m.color || '#00A859'}40,${m.color || '#00A859'}20);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${m.color || '#00A859'}">${escapeHtml(m.initials)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13px">${escapeHtml(m.name)}</div>
            <div style="font-size:11px;color:var(--text-secondary)">${escapeHtml([m.role, m.company].filter(Boolean).join(' · ') || 'DIC Alumni')}</div>
          </div>
          ${matchSummary(m)}
          <button class="btn btn-sm btn-primary" onclick="showMentorModal('${escapeHtml(m.name).replace(/'/g, '&#39;')}', ${m.id})">Request</button>
        </div>`).join('');
    }
  }
}

// ─── MENTOR REQUEST MODAL ───
function showMentorModal(mentorName = '', mentorId = null) {
  if (!mentorId) {
    showToast('ℹ Open a mentor from the suggestions list to send a request.');
    return;
  }
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="handshake" class="ui-icon"></i> Request a Mentor</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div class="socratic-prompt">
      <div class="socratic-prompt-icon"><i data-lucide="bot" class="ui-icon"></i></div>
      <div class="socratic-prompt-text">
        <strong>ConnectAI:</strong> Be specific about your goal and what guidance you need — focused requests are accepted far more often.
      </div>
    </div>
    <div style="margin-bottom:14px;padding:12px;background:var(--bg-glass);border:1px solid var(--border-glass);border-radius:var(--radius-sm)">
      <div style="font-size:12px;color:var(--text-muted)">Requesting mentorship from</div>
      <div style="font-size:15px;font-weight:700;margin-top:2px">${escapeHtml(mentorName)}</div>
    </div>
    <div class="input-group">
      <label class="input-label">What do you need help with?</label>
      <input type="text" id="mentor-subject" class="form-input" placeholder="e.g. Transitioning from web development into ML engineering" required />
    </div>
    <div class="input-group">
      <label class="input-label">Your message</label>
      <textarea id="mentor-message" class="form-input" rows="5" placeholder="Introduce yourself, your background and what specific guidance would help most…"></textarea>
    </div>
    <button class="btn btn-primary btn-full" onclick="submitMentorRequest(${mentorId})"><i data-lucide="handshake" class="ui-icon"></i> Send Request</button>
    <div style="font-size:11px;color:var(--text-muted);margin-top:10px;text-align:center">Unanswered requests expire automatically after 5 days.</div>
  `);
}
async function renderMentorshipHealthAnalytics() {
  const grid = document.getElementById('mentorship-health-grid');
  const dist = document.getElementById('outcome-distribution');
  if (!grid) return;

  grid.innerHTML = '<div class="queue-sub" style="padding:12px">Loading…</div>';
  const res = await API.getStatsAnalytics();

  if (apiFailed(res)) {
    grid.innerHTML = renderEmptyState('<i data-lucide="handshake" class="ui-icon"></i>',
      'Mentorship figures unavailable', 'They could not be loaded from the database.');
    if (dist) dist.innerHTML = '';
    if (window.lucide) lucide.createIcons();
    return;
  }

  const total = res.totals?.mentorships ?? 0;
  if (total === 0) {
    grid.innerHTML = renderEmptyState('<i data-lucide="handshake" class="ui-icon"></i>',
      'No mentorship records yet',
      'Figures appear here once alumni request and accept mentorships.');
  } else {
    grid.innerHTML = `
      <div class="sync-overview-grid">
        <div class="sync-stat-card"><div class="sync-stat-val">${total.toLocaleString('en-IN')}</div><div class="sync-stat-label">Mentorship Records</div></div>
      </div>`;
  }

  if (dist) {
    dist.innerHTML = `<div class="chapter-empty-note">
      Mentorship outcomes are not recorded. The mentorships table stores a
      status — pending, accepted, declined, expired or completed — but no
      outcome category, goal or rating, so there is no distribution to chart.
    </div>`;
  }
  if (window.lucide) lucide.createIcons();
}

/* Referral requests, read side. POST /api/jobs/:id/refer has always written a
   job_referrals row, but nothing could read one back: there was no endpoint and
   no screen, so every request a student sent vanished. */

// ─── MENTORSHIP ───

// The score is no longer passed from the browser: the server computes and
// stores it from the two profiles, so it cannot be set by the caller.
async function submitMentorRequest(mentorId) {
  const subject = document.getElementById('mentor-subject')?.value.trim();
  const message = document.getElementById('mentor-message')?.value.trim();
  if (!subject) { showToast('⚠ Please describe what you need help with.'); return; }

  const res = await API.requestMentorship({ mentorId, subject, message });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Request failed.'}`); return; }

  closeModal();
  showToast('🤝 Mentorship request sent — it expires in 5 days if unanswered.');
  renderMentorships();
  renderNotifications();
}

async function respondToMentorship(id, action) {
  const res = await API.respondMentorship(id, action);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not update the request.'}`); return; }
  const verb = { accept: 'accepted', decline: 'declined', complete: 'marked complete' }[action];
  showToast(`✓ Mentorship ${verb}.`);
  renderMentorships();
  renderNotifications();
}
