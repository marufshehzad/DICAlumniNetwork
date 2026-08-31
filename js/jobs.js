/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   jobs.js

   The job board, applications and referral requests.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */




// ─── EVENTS & TICKETING (REQ-06) ───
// Reads from PostgreSQL, shows the signed-in user's ticket state, and drives
// registration / cancellation / QR check-in through the real endpoints.


// Every event gets its own planner (tasks, budget, etc). The dropdown is how
// an organizer switches between the events they've created — without it the
// workspace could only ever show event #1.


// The lightweight workspace for casual events (e.g. an Iftar party): just the
// event basics and "who's doing what", none of the budget/sponsor/vendor
// machinery a small get-together doesn't need.


function filterJobs(value) { renderJobsEnhanced(value); }
function filterJobType(v) {
  state.jobFilters = { ...(state.jobFilters || {}), type: v === 'all' ? '' : v };
  renderJobsEnhanced();
}

// Restored verbatim from f293872. It sat between two event functions that were
// deleted during the Events rework and was removed with them, leaving the
// onchange handler at index.html:620 throwing a ReferenceError.
function filterJobLocation(v) {
  state.jobFilters = { ...(state.jobFilters || {}), location: v === 'all' ? '' : v };
  renderJobsEnhanced();
}


// ─── CREATE EVENT (was a toast-only shell) ───

// ─── POST JOB (was a toast-only shell) ───
function showPostJobModal() {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="plus" class="ui-icon"></i> Post a Job</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div style="background:var(--primary-glow);border:1px solid rgba(11,56,151,0.2);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--primary-light)">
      <i data-lucide="lock" class="ui-icon"></i> Alumni-only posting — visible to verified DIC alumni.
    </div>
    <form onsubmit="handlePostJobSubmit(event)">
      <div class="input-group"><label class="input-label">Job Title</label>
        <input type="text" id="job-title" class="form-input" placeholder="e.g. Senior Software Engineer" required /></div>
      <div class="input-group"><label class="input-label">Company</label>
        <input type="text" id="job-company" class="form-input" placeholder="Your company name" required /></div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label">Type</label>
          <select id="job-type" class="form-select">
            <option value="fulltime">Full-time</option><option value="parttime">Part-time</option>
            <option value="internship">Internship</option><option value="contract">Contract</option>
          </select></div>
        <div class="input-group"><label class="input-label">Location</label>
          <input type="text" id="job-location" class="form-input" placeholder="Dhaka / Remote" value="Dhaka" /></div>
      </div>
      <div class="input-group"><label class="input-label">Salary Range</label>
        <input type="text" id="job-salary" class="form-input" placeholder="e.g. ৳80K–৳120K/mo" /></div>
      <div class="input-group"><label class="input-label">Skill Tags (comma separated)</label>
        <input type="text" id="job-tags" class="form-input" placeholder="React, Node.js, PostgreSQL" /></div>
      <button type="submit" class="btn btn-primary btn-full">Post Job</button>
    </form>
  `);
}

// ─── REQ-07: REFERRAL REQUEST WORKFLOW ──────────────────────
function showReferralModal(jobId, jobTitle, postedBy) {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="handshake" class="ui-icon"></i> Request a Referral</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div style="margin-bottom:14px;padding:12px;background:var(--bg-glass);border:1px solid var(--border-glass);border-radius:var(--radius-sm)">
      <div style="font-size:12px;color:var(--text-muted)">Referral for</div>
      <div style="font-size:15px;font-weight:700;margin-top:2px">${escapeHtml(jobTitle)}</div>
      ${postedBy ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">Posted by ${escapeHtml(postedBy)}</div>` : ''}
    </div>
    <div class="input-group">
      <label class="input-label">Your message</label>
      <textarea id="referral-message" class="form-input" rows="5" placeholder="Introduce yourself and explain why you are a strong fit for this role…"></textarea>
    </div>
    <button class="btn btn-primary btn-full" onclick="submitReferralRequest(${jobId})"><i data-lucide="handshake" class="ui-icon"></i> Send Referral Request</button>
  `);
}


// Updated renderJobs with Referral button
// ─── JOBS (REQ-07) — served from PostgreSQL ───
async function renderJobsEnhanced(filter = '') {
  const container = document.getElementById('jobs-list');
  if (!container) return;

  container.innerHTML = renderSkeletonCards(3, 'job');
  const q = { ...(filter ? { search: filter } : {}), ...(state.jobFilters || {}) };
  const jobs = await API.getJobs(q);

  if (apiFailed(jobs)) {
    container.innerHTML = renderErrorState(jobs?.error || 'Could not load the job board.', 'renderJobsEnhanced()');
    return;
  }
  if (jobs.length === 0) {
    container.innerHTML = renderEmptyState('<i data-lucide="briefcase" class="ui-icon"></i>', 'No openings match your filters',
      'Verified alumni can post roles using the button above.');
    return;
  }

  const meId = state.currentUser?.id;
  const isAdmin = state.currentUser && ['super_admin', 'univ_admin'].includes(state.currentUser.role);

  container.innerHTML = jobs.map(j => {
    const tags = Array.isArray(j.tags) ? j.tags : [];
    const mine = j.posted_by_id === meId;
    const safeTitle = escapeHtml(j.title).replace(/'/g, '&#39;');
    return `
    <div class="job-card">
      <div class="job-company-logo">${emojiIcon(j.emoji, 'briefcase')}</div>
      <div class="job-info">
        <div class="job-title">${escapeHtml(j.title)}</div>
        <div class="job-company">${escapeHtml(j.company)}</div>
        <div class="job-meta">
          <span class="job-meta-item"><i data-lucide="map-pin" class="ui-icon"></i> ${escapeHtml(j.location || '—')}</span>
          <span class="job-meta-item"><i data-lucide="user" class="ui-icon"></i> ${escapeHtml(j.posted_by_name || 'DIC Alumni')}</span>
          <span class="job-meta-item">🕒 ${escapeHtml(formatRelativeTime(j.created_at))}</span>
          <span class="job-meta-item"><i data-lucide="download" class="ui-icon"></i> ${j.applicants} applicant${j.applicants === 1 ? '' : 's'}</span>
        </div>
        <div class="job-tags">${tags.map(t => `<span class="job-tag">${escapeHtml(t)}</span>`).join('')}</div>
      </div>
      <div class="job-right">
        <div class="job-salary">${escapeHtml(j.salary || 'Negotiable')}</div>
        <span class="job-type-badge ${escapeHtml(j.type)}">${escapeHtml((j.type || '').charAt(0).toUpperCase() + (j.type || '').slice(1))}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${mine || isAdmin
            ? `<button class="apply-btn" onclick="showJobApplicants(${j.id}, '${safeTitle}')"><i data-lucide="users" class="ui-icon"></i> Applicants (${j.applicants})</button>
               <button class="referral-btn" onclick="deleteJobPrompt(${j.id}, '${safeTitle}')"><i data-lucide="trash-2" class="ui-icon"></i> Delete</button>`
            : `<button class="apply-btn" ${j.has_applied ? 'disabled' : ''} onclick="applyJob(${j.id}, '${safeTitle}')">${j.has_applied ? '<i data-lucide="check" class="ui-icon"></i> Applied' : 'Apply →'}</button>
               <button class="referral-btn" onclick="showReferralModal(${j.id}, '${safeTitle}', '${escapeHtml(j.posted_by_name || '').replace(/'/g, '&#39;')}')"><i data-lucide="handshake" class="ui-icon"></i> Referral</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
}

/* The Career Progression tracker was removed with its page: an eight-person
   registry of invented job moves tagged "AI Updated" or "Self-Reported", four
   self-report prompts naming real alumni, an enrichment-statistics panel, and
   modals for confirming a job change and setting career privacy. Nothing in the
   schema records employment history or any enrichment run. */

/* ─── RBAC MATRIX ───────────────────────────────────────────
   The matrix used to be a 12x12 grid maintained by hand in this file, listing
   roles the system does not have — School Owner, Chapter Officer, Event Manager,
   Finance Auditor, API Developer, System — against modules it does not enforce,
   and marking cells Full / Edit / View / Limited / Audit / Donate purely by
   assertion. The platform has five roles and its guards are requireAuth and
   requireRole(...ADMIN_ROLES | ...MODERATOR_ROLES). GET /api/stats/rbac derives
   the table from those same constants, so the screen cannot drift from the
   middleware, and no permission rule is written twice. */
async function renderJobReferrals() {
  const el = document.getElementById('job-referrals-list');
  if (!el) return;
  el.innerHTML = '<div class="queue-sub" style="padding:12px">Loading…</div>';

  const rows = await API.getJobReferrals();
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState(rows?.error || 'Could not load referral requests.', 'renderJobReferrals()');
    return;
  }
  if (!rows.length) {
    el.innerHTML = renderEmptyState('<i data-lucide="handshake" class="ui-icon"></i>',
      'No referral requests yet',
      'Requests you send, and requests sent to you about your own postings, appear here.');
    if (window.lucide) lucide.createIcons();
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="queue-item">
      <div class="queue-info">
        <div class="queue-name">${escapeHtml(r.job_title || 'Job')} · ${escapeHtml(r.company || '')}</div>
        <div class="queue-sub">
          ${escapeHtml(r.requester_name || 'Someone')} asked ${escapeHtml(r.referrer_name || 'the poster')}
          · ${escapeHtml(formatRelativeTime(r.created_at))}
        </div>
        ${r.message ? `<div class="queue-sub" style="margin-top:4px">“${escapeHtml(r.message)}”</div>` : ''}
      </div>
      <span class="card-badge ${r.status === 'accepted' ? 'teal' : ''}">${escapeHtml(r.status || 'pending')}</span>
    </div>`).join('');
  if (window.lucide) lucide.createIcons();
}

// ─── JOBS ───

async function applyJob(jobId, title) {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="file-text" class="ui-icon"></i> Apply — ${escapeHtml(title)}</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="submitJobApplication(event, ${jobId})">
      <div class="input-group">
        <label class="input-label">Cover note</label>
        <textarea id="apply-note" class="form-input" rows="4" placeholder="Why are you a good fit for this role?"></textarea>
      </div>
      <div class="input-group">
        <label class="input-label">Resume / portfolio URL (optional)</label>
        <input type="url" id="apply-resume" class="form-input" placeholder="https://…" />
      </div>
      <button type="submit" class="btn btn-primary btn-full">Submit Application</button>
    </form>
  `);
}

async function submitJobApplication(e, jobId) {
  if (e) e.preventDefault();
  const res = await API.applyToJob(jobId, {
    coverNote: document.getElementById('apply-note')?.value.trim(),
    resumeUrl: document.getElementById('apply-resume')?.value.trim()
  });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Application failed.'}`); return; }
  closeModal();
  showToast('✅ Application submitted.');
  renderJobsEnhanced();
}

async function showJobApplicants(jobId, title) {
  const rows = await API.getJobApplicants(jobId);
  if (apiFailed(rows)) { showToast(`⚠ ${rows?.error || 'Could not load applicants.'}`); return; }

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="users" class="ui-icon"></i> Applicants — ${escapeHtml(title)}</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:56vh;overflow-y:auto">
      ${rows.length ? rows.map(a => `
        <div class="glass-card" style="padding:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="alumni-avatar" style="width:36px;height:36px;font-size:12px;background:var(--teal);flex-shrink:0"><span>${escapeHtml(a.initials || '??')}</span></div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:13px">${escapeHtml(a.name)}</div>
              <div style="font-size:11px;color:var(--text-secondary)">${escapeHtml([a.dept, a.batch && `Batch ${a.batch}`, a.company].filter(Boolean).join(' · ') || '—')}</div>
            </div>
            <span class="card-badge">${escapeHtml(a.status)}</span>
          </div>
          ${a.cover_note ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:8px;padding-top:8px;border-top:1px solid var(--border-glass)">${escapeHtml(a.cover_note)}</div>` : ''}
        </div>`).join('')
      : renderEmptyState('<i data-lucide="inbox" class="ui-icon"></i>', 'No applications yet')}
    </div>
  `);
}

async function submitReferralRequest(jobId) {
  const message = document.getElementById('referral-message')?.value.trim();
  const res = await API.requestReferral(jobId, message);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not send the request.'}`); return; }
  closeModal();
  showToast('🤝 Referral request sent to the poster.');
}

async function deleteJobPrompt(id, title) {
  if (!confirm(`Delete the posting "${title}"?`)) return;
  const res = await API.deleteJob(id);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not delete.'}`); return; }
  showToast('🗑 Job posting deleted.');
  renderJobsEnhanced();
}

// ─── EVENT PLANNER REPORTS ───


async function handlePostJobSubmit(e) {
  if (e) e.preventDefault();
  const res = await API.createJob({
    title: document.getElementById('job-title').value.trim(),
    company: document.getElementById('job-company').value.trim(),
    type: document.getElementById('job-type').value,
    location: document.getElementById('job-location').value.trim(),
    salary: document.getElementById('job-salary').value.trim(),
    tags: document.getElementById('job-tags').value
  });

  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not post the job.'}`); return; }
  closeModal();
  showToast(`✅ "${res.title}" posted to the job board.`);
  renderJobsEnhanced();
}
