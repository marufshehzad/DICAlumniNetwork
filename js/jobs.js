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
/* One form for posting and for editing.

   PUT /api/jobs/:id has existed and been ownership-guarded the whole time, but
   nothing called it: the job card offered Applicants and Delete only, so a
   poster who mistyped a title had to delete the posting — losing its
   applicants — and post it again. Passing a job here switches the same form to
   edit mode rather than duplicating it. */
function showPostJobModal(job) {
  const editing = !!job;
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="${editing ? 'pen-line' : 'plus'}" class="ui-icon"></i> ${editing ? 'Edit Job' : 'Post a Job'}</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div style="background:var(--primary-glow);border:1px solid rgba(11,56,151,0.2);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--primary-light)">
      <i data-lucide="lock" class="ui-icon"></i> Alumni-only posting — visible to verified DIC alumni.
    </div>
    <form onsubmit="handlePostJobSubmit(event, ${editing ? job.id : 'null'})">
      <div class="input-group"><label class="input-label" for="job-title">Job Title</label>
        <input type="text" id="job-title" class="form-input" placeholder="e.g. Senior Software Engineer" value="${editing ? escapeHtml(job.title) : ''}" required /></div>
      <div class="input-group"><label class="input-label" for="job-company">Company</label>
        <input type="text" id="job-company" class="form-input" placeholder="Your company name" value="${editing ? escapeHtml(job.company) : ''}" required /></div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="job-type">Type</label>
          <select id="job-type" class="form-select">
            ${['fulltime:Full-time','parttime:Part-time','internship:Internship','contract:Contract']
              .map(o => { const [v,l] = o.split(':');
                return `<option value="${v}" ${editing && job.type === v ? 'selected' : ''}>${l}</option>`; }).join('')}
          </select></div>
        <div class="input-group"><label class="input-label" for="job-work-mode">Work mode</label>
          <select id="job-work-mode" class="form-select">
            ${[':Not specified', 'onsite:On-site', 'remote:Remote', 'hybrid:Hybrid']
              .map(o => { const i = o.indexOf(':'); const v = o.slice(0, i), l = o.slice(i + 1);
                return `<option value="${v}" ${editing && (job.work_mode || '') === v ? 'selected' : ''}>${l}</option>`; }).join('')}
          </select></div>
      </div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="job-location">Location</label>
          <!-- value="Dhaka" was prefilled, so an unedited posting recorded
               Dhaka whether or not the role was there. Blank by default. -->
          <input type="text" id="job-location" class="form-input" placeholder="e.g. Chattogram, or Remote" value="${editing ? escapeHtml(job.location || '') : ''}" /></div>
      </div>
      <div class="input-group"><label class="input-label" for="job-salary">Salary Range</label>
        <input type="text" id="job-salary" class="form-input" placeholder="e.g. ৳80K–৳120K/mo" value="${editing ? escapeHtml(job.salary || '') : ''}" /></div>
      <div class="input-group"><label class="input-label" for="job-description">Description</label>
        <textarea id="job-description" class="form-input" rows="4"
                  placeholder="What the role involves, and what you are looking for.">${editing ? escapeHtml(job.description || '') : ''}</textarea></div>
      <div class="input-group"><label class="input-label" for="job-deadline">Application deadline</label>
        <input type="date" id="job-deadline" class="form-input"
               value="${editing && job.deadline ? escapeHtml(String(job.deadline).slice(0, 10)) : ''}" />
        <span class="field-hint" style="font-size:11px;color:var(--text-secondary)">Optional. After this date the posting stops accepting applications.</span></div>
      <div class="input-group"><label class="input-label" for="job-tags">Skill Tags (comma separated)</label>
        <input type="text" id="job-tags" class="form-input" placeholder="React, Node.js, PostgreSQL" value="${editing ? escapeHtml((job.tags || []).join(', ')) : ''}" /></div>
      <button type="submit" class="btn btn-primary btn-full">${editing ? 'Save changes' : 'Post Job'}</button>
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
      <label class="input-label" for="referral-message">Your message</label>
      <textarea id="referral-message" class="form-input" rows="5" placeholder="Introduce yourself and explain why you are a strong fit for this role…"></textarea>
    </div>
    <button class="btn btn-primary btn-full" onclick="submitReferralRequest(${jobId})"><i data-lucide="handshake" class="ui-icon"></i> Send Referral Request</button>
  `);
}


// Updated renderJobs with Referral button
// ─── JOBS (REQ-07) — served from PostgreSQL ───
/* The job location dropdown, filled from the locations jobs are actually
   posted in. It was a hardcoded Dhaka / Remote / UK / USA list, which meant a
   role in Chattogram could not be filtered for at all, and listed "Remote"
   among cities as though remote were a place.

   Job location remains free text on `jobs.location` and is NOT joined to the
   alumni location model: an employer's office and a member's home are
   different things with different privacy weights, and merging them was
   explicitly out of scope. Work mode (remote / hybrid / on-site) is still not
   modelled — that limitation is recorded rather than papered over. */
function populateJobLocationFilter() {
  const el = document.getElementById('job-location-filter');
  if (!el) return;
  API.getJobs({}).then(all => {
    if (apiFailed(all) || !Array.isArray(all)) return;
    const seen = new Map();
    for (const j of all) {
      const loc = (j.location || '').trim();
      if (!loc) continue;
      const k = loc.toLowerCase();
      seen.set(k, { label: loc, n: (seen.get(k)?.n || 0) + 1 });
    }
    const current = el.value;
    el.innerHTML = '<option value="">All Locations</option>' +
      [...seen.entries()]
        .sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label))
        .map(([k, v]) => `<option value="${escapeHtml(k)}" ${current === k ? 'selected' : ''}>` +
                         `${escapeHtml(v.label)} (${v.n})</option>`).join('');
  });
}

async function renderJobsEnhanced(filter = '') {
  const container = document.getElementById('jobs-list');
  if (!container) return;

  container.innerHTML = renderSkeletonCards(3, 'job');
  const q = { ...(filter ? { search: filter } : {}), ...(state.jobFilters || {}) };
  const jobs = await API.getJobs(q);
  populateJobLocationFilter();

  if (apiFailed(jobs)) {
    container.innerHTML = renderErrorState(jobs?.error || 'Could not load the job board.', 'renderJobsEnhanced()');
    return;
  }
  if (jobs.length === 0) {
    container.innerHTML = renderEmptyState('<i data-lucide="briefcase" class="ui-icon"></i>', 'No openings match your filters',
      'Any signed-in member can post a role using the button above.');
    return;
  }

  const meId = state.currentUser?.id;
  const isAdmin = state.currentUser && ['super_admin', 'univ_admin'].includes(state.currentUser.role);

  container.innerHTML = jobs.map(j => {
    const tags = Array.isArray(j.tags) ? j.tags : [];
    const mine = j.posted_by_id === meId;
    const titleArg = jsArg(j.title);
    return `
    <div class="job-card">
      <div class="job-company-logo">${emojiIcon(j.emoji, 'briefcase')}</div>
      <div class="job-info">
        <div class="job-title">${escapeHtml(j.title)}</div>
        <div class="job-company">${escapeHtml(j.company)}</div>
        <div class="job-meta">
          <span class="job-meta-item"><i data-lucide="map-pin" class="ui-icon"></i> ${escapeHtml(j.location || 'Location not stated')}</span>
          ${j.work_mode ? `<span class="job-meta-item"><i data-lucide="${
              j.work_mode === 'remote' ? 'globe' : j.work_mode === 'hybrid' ? 'shuffle' : 'building-2'
            }" class="ui-icon" aria-hidden="true"></i> ${
              j.work_mode === 'onsite' ? 'On-site' : j.work_mode === 'remote' ? 'Remote' : 'Hybrid'
            }</span>` : ''}
          <span class="job-meta-item"><i data-lucide="user" class="ui-icon"></i> ${escapeHtml(j.posted_by_name || 'DIC Alumni')}</span>
          <span class="job-meta-item"><i data-lucide="clock" class="ui-icon" aria-hidden="true"></i> ${escapeHtml(formatRelativeTime(j.created_at))}</span>
          <span class="job-meta-item"><i data-lucide="download" class="ui-icon"></i> ${j.applicants} applicant${j.applicants === 1 ? '' : 's'}</span>
        </div>
        <div class="job-tags">${tags.map(t => `<span class="job-tag">${escapeHtml(t)}</span>`).join('')}</div>
        ${j.description ? `<p class="job-description">${escapeHtml(j.description)}</p>` : ''}
      </div>
      <div class="job-right">
        <div class="job-salary">${escapeHtml(j.salary || 'Negotiable')}</div>
        ${jobStatusBadge(j)}
        <span class="job-type-badge ${escapeHtml(j.type)}">${escapeHtml((j.type || '').charAt(0).toUpperCase() + (j.type || '').slice(1))}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${mine || isAdmin
            ? `<button class="apply-btn" onclick="showJobApplicants(${j.id}, ${titleArg})"><i data-lucide="users" class="ui-icon"></i> Applicants (${j.applicants})</button>
               <button class="referral-btn" onclick="editJobPrompt(${j.id})"><i data-lucide="pen-line" class="ui-icon"></i> Edit</button>
               <button class="referral-btn" onclick="setJobStatus(${j.id}, ${j.status === 'closed' ? jsArg('open') : jsArg('closed')})"><i data-lucide="${j.status === 'closed' ? 'unlock' : 'lock'}" class="ui-icon"></i> ${j.status === 'closed' ? 'Reopen' : 'Close'}</button>
               <button class="referral-btn" onclick="deleteJobPrompt(${j.id}, ${titleArg})"><i data-lucide="trash-2" class="ui-icon"></i> Delete</button>`
            : `<button class="apply-btn" ${j.has_applied ? 'disabled' : ''} onclick="applyJob(${j.id}, ${titleArg})">${j.has_applied ? '<i data-lucide="check" class="ui-icon"></i> Applied' : 'Apply'}</button>
               <button class="referral-btn" onclick="showReferralModal(${j.id}, ${titleArg}, ${jsArg(j.posted_by_name)})"><i data-lucide="handshake" class="ui-icon"></i> Referral</button>`}
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
/* Open, closed or expired — three states a reader distinguishes, from two
   fields the server derives. A closed posting is not hidden: a candidate who
   applied deserves to still find it. */
function jobStatusBadge(j) {
  if (j.status === 'closed') {
    return '<span class="job-state is-closed"><i data-lucide="lock" class="ui-icon" aria-hidden="true"></i> Closed</span>';
  }
  if (j.is_expired) {
    return '<span class="job-state is-expired"><i data-lucide="calendar-x" class="ui-icon" aria-hidden="true"></i> Deadline passed</span>';
  }
  if (j.deadline) {
    return '<span class="job-state is-open"><i data-lucide="calendar-clock" class="ui-icon" aria-hidden="true"></i> Apply by '
         + escapeHtml(formatDate(j.deadline)) + '</span>';
  }
  return '<span class="job-state is-open"><i data-lucide="circle-check" class="ui-icon" aria-hidden="true"></i> Open</span>';
}

async function setJobStatus(id, status) {
  const res = await API.updateJob(id, { status });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not change the posting.'}`); return; }
  showToast(status === 'closed' ? '✅ Posting closed.' : '✅ Posting reopened.');
  renderJobsEnhanced();
}

/* The applicant's side. Someone could apply and then never learn what
   happened; the status existed in the database and nowhere a candidate could
   read it. */
const APPLICATION_LABEL = {
  submitted: 'Received', reviewing: 'Under review', shortlisted: 'Shortlisted',
  rejected: 'Not taken forward', hired: 'Successful'
};

async function renderMyApplications() {
  const el = document.getElementById('my-applications-list');
  if (!el) return;
  el.innerHTML = renderSkeletonCards(2);

  const rows = await API.myApplications();
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState(rows?.error || 'Could not load your applications.', 'renderMyApplications()');
    return;
  }
  if (!rows.length) {
    el.innerHTML = renderEmptyState('<i data-lucide="file-text" class="ui-icon"></i>',
      'No applications yet', 'Roles you apply for appear here with their current status.');
    if (window.lucide) lucide.createIcons();
    return;
  }
  el.innerHTML = rows.map(a => `
    <div class="queue-item">
      <div class="queue-info">
        <div class="queue-name">${escapeHtml(a.title)} · ${escapeHtml(a.company || '')}</div>
        <div class="queue-sub">Applied ${escapeHtml(formatRelativeTime(a.created_at))}${
          a.status_changed_at ? ' · updated ' + escapeHtml(formatRelativeTime(a.status_changed_at)) : ''}</div>
      </div>
      <span class="app-state is-${escapeHtml(a.status)}">${escapeHtml(APPLICATION_LABEL[a.status] || a.status)}</span>
    </div>`).join('');
  if (window.lucide) lucide.createIcons();
}

/* The employer's side: move an application through the states the server
   allows. The select is the control, so there is no separate save. */
async function setApplicationStatus(appId, status, jobId, title) {
  const res = await API.setApplicationStatus(appId, status);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not update the application.'}`); return; }
  showToast(`✅ Marked ${APPLICATION_LABEL[status] || status}.`);
  showJobApplicants(jobId, title);
}

async function answerReferral(id, status) {
  const res = await API.answerReferral(id, status);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not answer the request.'}`); return; }
  showToast(status === 'accepted' ? '✅ Referral accepted.' : '✓ Referral declined.');
  renderJobReferrals();
}

async function renderJobReferrals() {
  const el = document.getElementById('job-referrals-list');
  if (!el) return;
  el.innerHTML = renderSkeletonCards(3);

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
          ${r.requester_email ? ' · ' + escapeHtml(r.requester_email) : ''}
        </div>
        ${r.message ? `<div class="queue-sub" style="margin-top:4px">“${escapeHtml(r.message)}”</div>` : ''}
      </div>
      ${/* Only the person the request was addressed to may answer it, and only
            while it is still pending. The server enforces both; this mirrors
            it so a button is never offered that would be refused. */
        r.status === 'pending' && r.referrer_id === (state.currentUser || {}).id
        ? `<div class="referral-actions">
             <button type="button" class="btn btn-primary btn-sm" onclick="answerReferral(${r.id}, ${jsArg('accepted')})">
               <i data-lucide="check" class="ui-icon"></i> Accept</button>
             <button type="button" class="btn btn-outline btn-sm" onclick="answerReferral(${r.id}, ${jsArg('declined')})">
               <i data-lucide="x" class="ui-icon"></i> Decline</button>
           </div>`
        : `<span class="ref-state is-${escapeHtml(r.status || 'pending')}">${
             escapeHtml({ pending: 'Awaiting a reply', accepted: 'Accepted', declined: 'Declined' }[r.status] || r.status)
           }</span>`}
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
        <label class="input-label" for="apply-note">Cover note</label>
        <textarea id="apply-note" class="form-input" rows="4" placeholder="Why are you a good fit for this role?"></textarea>
      </div>
      <div class="input-group">
        <label class="input-label" for="apply-resume">Resume / portfolio URL (optional)</label>
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
            <label class="sr-only" for="app-status-${a.id}">Status for ${escapeHtml(a.name)}</label>
            <select id="app-status-${a.id}" class="form-select sm app-status-select"
                    onchange="setApplicationStatus(${a.id}, this.value, ${jobId}, ${jsArg(title)})">
              ${['submitted','reviewing','shortlisted','rejected','hired'].map(s =>
                `<option value="${s}" ${a.status === s ? 'selected' : ''}>${APPLICATION_LABEL[s]}</option>`).join('')}
            </select>
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


async function handlePostJobSubmit(e, jobId = null) {
  if (e) e.preventDefault();
  const payload = {
    title: document.getElementById('job-title').value.trim(),
    company: document.getElementById('job-company').value.trim(),
    type: document.getElementById('job-type').value,
    location: document.getElementById('job-location').value.trim(),
    workMode: document.getElementById('job-work-mode').value,
    description: document.getElementById('job-description').value.trim(),
    deadline: document.getElementById('job-deadline').value || null,
    salary: document.getElementById('job-salary').value.trim(),
    tags: document.getElementById('job-tags').value
  };

  /* PUT /api/jobs/:id enforces ownership server-side — poster or an
     administrator — so the button below being hidden is a convenience, not the
     control. */
  const res = jobId ? await API.updateJob(jobId, payload) : await API.createJob(payload);

  if (apiFailed(res)) {
    showToast(`⚠ ${res?.error || (jobId ? 'Could not save the changes.' : 'Could not post the job.')}`);
    return;
  }
  closeModal();
  showToast(jobId ? `✅ "${res.title}" updated.` : `✅ "${res.title}" posted to the job board.`);
  renderJobsEnhanced();
}

/* Loads the posting fresh before editing, so the form starts from what the
   server holds rather than from whatever the list was showing. */
async function editJobPrompt(id) {
  const all = await API.getJobs({});
  if (apiFailed(all) || !Array.isArray(all)) { showToast('⚠ Could not load the posting.'); return; }
  const job = all.find(j => j.id === id);
  if (!job) { showToast('⚠ That posting no longer exists.'); renderJobsEnhanced(); return; }
  showPostJobModal(job);
}
