/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE (DIC) ALUMNI PLATFORM
   Frontend PostgreSQL API Client Module with Fast Fallback
   ============================================================ */

const API_BASE_URL = window.location.origin;
const TOKEN_KEY = 'dic_session_token';

// ─── SESSION TOKEN STORAGE ───
function getSessionToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setSessionToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

// Every request carries the bearer token when one exists, so the server can
// resolve the caller's identity and role instead of trusting the request body.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const token = getSessionToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(timeoutId);
    // An expired or tampered token drops the client back to the login screen.
    // Auth endpoints are exempt: a 401 from /login or /change-password means
    // "wrong credentials", not "your session died", and treating it as the
    // latter logged the user out mid-flow.
    const isAuthEndpoint = /\/api\/auth\//.test(url);
    if (response.status === 401 && token && !isAuthEndpoint && typeof onSessionExpired === 'function') {
      onSessionExpired();
    }
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

const API = {
  // ─── AUTHENTICATION ───
  async login(email, password) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || 'Login failed' };
      setSessionToken(data.token);
      return data;
    } catch (e) {
      return { error: 'Cannot reach the server. Check your connection and try again.' };
    }
  },

  async register(data) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const body = await res.json();
      if (!res.ok) return { error: body.error || "Registration failed" };
      setSessionToken(body.token);
      return body;
    } catch (e) {
      return { error: "Cannot reach the server. Check your connection and try again." };
    }
  },

  async me() {
    if (!getSessionToken()) return null;
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/auth/me`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.user;
    } catch (e) {
      return null;
    }
  },

  /* Signing out now ends the session server-side as well. It used to only
     remove the browser's copy, which left the token itself valid for the rest
     of its twelve hours. The local copy is cleared whatever the request does,
     so a network failure cannot leave someone stuck signed in. */
  async logout() {
    const token = getSessionToken();
    if (token) {
      try {
        await fetchWithTimeout(`${API_BASE_URL}/api/auth/logout`, { method: 'POST' }, 4000);
      } catch { /* offline or already expired — the local drop below still applies */ }
    }
    setSessionToken(null);
  },

  /* Returns the endpoint's own body on any answer, including the 503 the server
     sends when its database is down — that body says 'degraded', and the caller
     needs to see it rather than have it flattened into a transport failure.
     Only a genuine no-answer produces the envelope below. It used to claim the
     database was 'IndexedDB & Local State'; there is no IndexedDB in this
     system and never was, so a failed health check was reporting an invented
     storage engine to whoever was trying to diagnose the outage. */
  async health() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/health`);
      return await res.json();
    } catch (e) {
      return { status: 'unreachable', database: 'unknown' };
    }
  },

  // Returns { alumni, total, limit, offset } or null when the request fails.
  async getAlumni({ search = '', dept = '', batch = '', domain = '', mentor = false,
                    country = '', city = '', placeId = '', division = '', district = '',
                    sort = 'name', limit = 12, offset = 0 } = {}) {
    try {
      const qs = new URLSearchParams();
      if (search) qs.set('search', search);
      if (dept) qs.set('dept', dept);
      if (batch) qs.set('batch', batch);
      if (domain) qs.set('domain', domain);
      if (mentor) qs.set('mentor', 'true');
      // Structured location filters. City used to be reachable only through
      // the free-text search box, and country not at all.
      if (country) qs.set('country', country);
      if (city) qs.set('city', city);
      if (placeId) qs.set('placeId', placeId);
      if (division) qs.set('division', division);
      if (district) qs.set('district', district);
      qs.set('sort', sort);
      qs.set('limit', limit);
      qs.set('offset', offset);

      const res = await fetchWithTimeout(`${API_BASE_URL}/api/alumni?${qs}`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async getAlumniProfile(id) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/alumni/${id}`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async getChapters() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/chapters`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async submitChapter(data) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  // The membership user is resolved from the session token server-side.
  async joinChapter(chapterId) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/chapters/${chapterId}/join`, {
        method: 'POST'
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async getChapterMembers(chapterId) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/chapters/${chapterId}/members`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async getStories() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/stories`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async submitStory(data) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async getModerationQueue() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/moderation`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async moderateChapter(id, action) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/moderation/chapter/${id}/${action}`, {
        method: 'POST'
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async moderateStory(id, action) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/moderation/story/${id}/${action}`, {
        method: 'POST'
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  // Scope is derived from the session token server-side.
  async getNotifications() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/notifications`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async markNotificationRead(id) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/notifications/${id}/read`, { method: 'PUT' });
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async markAllNotificationsRead() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/notifications/read-all`, { method: 'PUT' });
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async moderateProposal(id, action) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/moderation/proposal/${id}/${action}`, {
        method: 'POST'
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async getImportHistory() {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/import-history`);
      if (!res.ok) throw new Error('API Error');
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async postBulkImport(data) {
    try {
      // Large imports insert hundreds of rows over a cloud database and take
      // far longer than the 10s default. Aborting client-side used to report a
      // failure while the transaction had already committed server-side.
      const timeoutMs = Math.max(120000, (data.records?.length || 0) * 800);
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/bulk-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }, timeoutMs);
      return await res.json();
    } catch (e) {
      return null;
    }
  }
};

/* ============================================================
   API v2 — events/ticketing, jobs, campaigns/donations, custom fields,
   mentorship, polls, broadcasts, planner and compliance.

   These share one request helper instead of repeating the same
   try/catch/JSON block per endpoint. On failure they return
   { error: '…' } so callers can show the real reason rather than
   silently falling back to placeholder data.
   ============================================================ */

async function apiRequest(method, path, body) {
  try {
    const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      return { error: (data && data.error) || `Request failed (${res.status})`, status: res.status, data };
    }
    return data;
  } catch (e) {
    return { error: 'Cannot reach the server. Check your connection.', offline: true };
  }
}

// Builds ?a=1&b=2 from an object, skipping empty values.
function qs(params) {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// True when a helper returned a failure envelope rather than data.
function apiFailed(result) {
  return !result || (typeof result === 'object' && !Array.isArray(result) && 'error' in result);
}

Object.assign(API, {
  // ─── EVENTS, TICKETS, TASKS, PEOPLE (v5) ───
  getEvents:        (params = {})   => apiRequest('GET',    '/api/events' + qs(params)),
  getMyEvents:      ()             => apiRequest('GET',    '/api/events/mine'),
  getEvent:         (id)            => apiRequest('GET',    `/api/events/${id}`),
  getEventOverview: (id)            => apiRequest('GET',    `/api/events/${id}/overview`),
  createEvent:      (d)             => apiRequest('POST',   '/api/events', d),
  updateEvent:      (id, d)         => apiRequest('PUT',    `/api/events/${id}`, d),
  approveEvent:     (id)            => apiRequest('PUT',    `/api/events/${id}/approve`),
  rejectEvent:      (id, reason)    => apiRequest('PUT',    `/api/events/${id}/reject`, { reason }),
  cancelEvent:      (id, reason)    => apiRequest('PUT',    `/api/events/${id}/cancel`, { reason }),
  deleteEvent:      (id)            => apiRequest('DELETE', `/api/events/${id}`),

  getTicketTypes:   (id)            => apiRequest('GET',    `/api/events/${id}/ticket-types`),
  addTicketType:    (id, d)         => apiRequest('POST',   `/api/events/${id}/ticket-types`, d),
  updateTicketType: (ttId, d)       => apiRequest('PUT',    `/api/events/ticket-types/${ttId}`, d),
  deleteTicketType: (ttId)          => apiRequest('DELETE', `/api/events/ticket-types/${ttId}`),

  registerForEvent: (id, d)         => apiRequest('POST',   `/api/events/${id}/register`, d || {}),
  cancelRegistration:(id)           => apiRequest('DELETE', `/api/events/${id}/register`),
  getMyTicket:      (id)            => apiRequest('GET',    `/api/events/${id}/my-ticket`),
  getAttendees:     (id)            => apiRequest('GET',    `/api/events/${id}/attendees`),
  attendeesCsvUrl:  (id)            => `${API_BASE_URL}/api/events/${id}/attendees.csv`,
  checkInTicket:    (ticketCode)    => apiRequest('POST',   '/api/events/checkin', { ticketCode }),

  getEventTasks:    (id)            => apiRequest('GET',    `/api/events/${id}/tasks`),
  getTask:          (taskId)        => apiRequest('GET',    `/api/events/tasks/${taskId}`),
  createTask:       (id, d)         => apiRequest('POST',   `/api/events/${id}/tasks`, d),
  addStandardChecklist:(id)         => apiRequest('POST',   `/api/events/${id}/tasks/standard-checklist`),
  updateTask:       (taskId, d)     => apiRequest('PUT',    `/api/events/tasks/${taskId}`, d),
  verifyTask:       (taskId)        => apiRequest('PUT',    `/api/events/tasks/${taskId}/verify`),
  deleteTask:       (taskId)        => apiRequest('DELETE', `/api/events/tasks/${taskId}`),
  addTaskAssignees: (taskId, payload) => apiRequest('POST', `/api/events/tasks/${taskId}/assignees`,
                                       Array.isArray(payload) ? { userIds: payload } : payload),
  removeTaskAssignee:(taskId, userId) => apiRequest('DELETE', `/api/events/tasks/${taskId}/assignees/${userId}`),
  addTaskNote:      (taskId, body)  => apiRequest('POST',   `/api/events/tasks/${taskId}/notes`, { body }),
  addChecklistItem: (taskId, label) => apiRequest('POST',   `/api/events/tasks/${taskId}/checklist`, { label }),
  setChecklistItem: (itemId, isDone) => apiRequest('PUT',   `/api/events/tasks/checklist/${itemId}`, { isDone }),
  deleteChecklistItem:(itemId)      => apiRequest('DELETE', `/api/events/tasks/checklist/${itemId}`),
  runReminderSweep: ()              => apiRequest('POST',   '/api/events/tasks/reminder-sweep'),

  getEventPeople:   (id)            => apiRequest('GET',    `/api/events/${id}/people`),
  addEventPeople:   (id, d)         => apiRequest('POST',   `/api/events/${id}/people`, d),
  addExternalPerson:(id, d)         => apiRequest('POST',   `/api/events/${id}/external-people`, d),
  updateExternalPerson:(personId, d)=> apiRequest('PUT',    `/api/events/external-people/${personId}`, d),
  removeEventPerson:(personId)      => apiRequest('DELETE', `/api/events/people/${personId}`),
  removeTaskPerson: (taskId, personId) =>
                                       apiRequest('DELETE', `/api/events/tasks/${taskId}/assignees/person/${personId}`),

  searchDirectory:  (params = {})   => apiRequest('GET',    '/api/directory/search' + qs(params)),

  // ─── JOBS ───
  getJobs:          (q = {})        => apiRequest('GET',    `/api/jobs?${new URLSearchParams(q)}`),
  createJob:        (d)             => apiRequest('POST',   '/api/jobs', d),
  updateJob:        (id, d)         => apiRequest('PUT',    `/api/jobs/${id}`, d),
  deleteJob:        (id)            => apiRequest('DELETE', `/api/jobs/${id}`),
  applyToJob:       (id, d)         => apiRequest('POST',   `/api/jobs/${id}/apply`, d || {}),
  getJobApplicants: (id)            => apiRequest('GET',    `/api/jobs/${id}/applicants`),
  requestReferral:  (id, message)   => apiRequest('POST',   `/api/jobs/${id}/refer`, { message }),
  // Phase 7C-2: the halves of the job workflow that had no caller.
  myApplications:   ()              => apiRequest('GET',    '/api/my-applications'),
  setApplicationStatus: (id, status) => apiRequest('PUT',   `/api/job-applications/${id}/status`, { status }),
  answerReferral:   (id, status)    => apiRequest('PUT',    `/api/job-referrals/${id}`, { status }),

  // ─── REAL PLATFORM STATISTICS ───
  // Backs every dashboard tile, analytics figure and map number. Each field is
  // a COUNT or SUM over rows that exist; none of it is a stored counter.
  getStatsOverview:     ()          => apiRequest('GET',    '/api/stats/overview'),
  getStatsAnalytics:    ()          => apiRequest('GET',    '/api/stats/analytics'),
  getStatsMap:          ()          => apiRequest('GET',    '/api/stats/map'),

  // ─── LOCATION (Phase 5B) ───
  // Reference places for the profile editor's Country → City selector.
  getLocationPlaces:    ()          => apiRequest('GET',    '/api/locations/places'),
  // Directory filter options, built from alumni who are actually there.
  getLocationFilters:   ()          => apiRequest('GET',    '/api/locations/filters'),
  // Sets or clears a chapter's institution-level location. Admin-only server
  // side; passing null clears it, which is right for a multi-city chapter.
  setChapterPlace:      (id, placeId) => apiRequest('PUT',  `/api/chapters/${id}/place`, { placeId }),
  // The field-privacy contract the server enforces, so the browser renders it
  // rather than keeping its own copy that drifts out of step.
  getPrivacySchema:     ()          => apiRequest('GET',    '/api/profile/privacy-schema'),
  getRbacMatrix:        ()          => apiRequest('GET',    '/api/stats/rbac'),
  getVerificationQueue: ()          => apiRequest('GET',    '/api/verification-queue'),

  // ─── ADMINISTRATOR ACCOUNTS (super admin only) ───
  getAdministrators:    ()          => apiRequest('GET',    '/api/admin/administrators'),
  getAdministrator:     (id)        => apiRequest('GET',    '/api/admin/administrators/' + id),
  createAdministrator:  (d)         => apiRequest('POST',   '/api/admin/administrators', d),
  updateAdministrator:  (id, d)     => apiRequest('PUT',    '/api/admin/administrators/' + id, d),
  setAdministratorStatus: (id, s)   => apiRequest('PUT',    '/api/admin/administrators/' + id + '/status', { status: s }),
  resetAdministratorPassword: (id)  => apiRequest('POST',   '/api/admin/administrators/' + id + '/reset-password', {}),
  getSegmentOptions:    ()          => apiRequest('GET',    '/api/segment/options'),
  getSegmentCount:      (q)         => apiRequest('GET',    '/api/segment/count?' + new URLSearchParams(q)),
  verifyUser:        (id, v = true) => apiRequest('PUT',    '/api/users/' + id + '/verify', { verified: v }),
  getSyncMutations:     ()          => apiRequest('GET',    '/api/sync-mutations'),
  getJobReferrals:      ()          => apiRequest('GET',    '/api/job-referrals'),

  // ─── CAMPAIGNS & DONATIONS ───
  getCampaigns:     ()              => apiRequest('GET',    '/api/campaigns'),
  createCampaign:   (d)             => apiRequest('POST',   '/api/campaigns', d),
  updateCampaign:   (id, d)         => apiRequest('PUT',    `/api/campaigns/${id}`, d),
  deleteCampaign:   (id)            => apiRequest('DELETE', `/api/campaigns/${id}`),
  // Records a pledge. There is no browser-callable path to a settled donation:
  // confirmDonation() used to POST {success:true} and is gone with its endpoint.
  createDonation:   (d)             => apiRequest('POST',   '/api/donations', d),
  cancelPledge:     (id)            => apiRequest('POST',   `/api/donations/${id}/cancel`),
  recordDonationPayment: (id, d)    => apiRequest('POST',   `/api/donations/${id}/record-payment`, d || { received: true }),
  getMyDonations:   ()              => apiRequest('GET',    '/api/donations/mine'),
  getDonorLeaderboard: ()           => apiRequest('GET',    '/api/donations/leaderboard'),

  // ─── CUSTOM FIELDS ───
  getCustomFields:  ()              => apiRequest('GET',    '/api/custom-fields'),
  createCustomField:(d)             => apiRequest('POST',   '/api/custom-fields', d),
  deleteCustomFieldApi: (id)        => apiRequest('DELETE', `/api/custom-fields/${id}`),

  // ─── MENTORSHIP ───
  getMentorships:   ()              => apiRequest('GET',    '/api/mentorships'),
  getMentorSuggestions: ()          => apiRequest('GET',    '/api/mentorships/suggestions'),
  requestMentorship:(d)             => apiRequest('POST',   '/api/mentorships', d),
  respondMentorship:(id, action)    => apiRequest('PUT',    `/api/mentorships/${id}/${action}`),

  // ─── CONNECTIONS ───
  getConnections:   ()              => apiRequest('GET',    '/api/connections'),
  connectWith:      (userId)        => apiRequest('POST',   `/api/connections/${userId}`),

  // ─── POLLS ───
  getActivePoll:    ()              => apiRequest('GET',    '/api/polls/active'),
  votePoll:         (id, optionIndex) => apiRequest('POST', `/api/polls/${id}/vote`, { optionIndex }),
  // Poll administration, staff only server-side.
  getPolls:         ()              => apiRequest('GET',    '/api/polls'),
  getPollResults:   (id)            => apiRequest('GET',    `/api/polls/${id}/results`),
  createPoll:       (d)             => apiRequest('POST',   '/api/polls', d),
  updatePoll:       (id, d)         => apiRequest('PUT',    `/api/polls/${id}`, d),
  setPollStatus:    (id, status)    => apiRequest('PUT',    `/api/polls/${id}/status`, { status }),
  deletePoll:       (id)            => apiRequest('DELETE', `/api/polls/${id}`),

  // ─── BROADCASTS & AUDIT ───
  getBroadcasts:    ()              => apiRequest('GET',    '/api/broadcasts'),
  sendBroadcastApi: (d)             => apiRequest('POST',   '/api/broadcasts', d),
  // Operations panel (Phase 4). ADMIN_ROLES for status; the run trigger is
  // super-admin-only and the server enforces that, not this file.
  getOpsStatus:     ()              => apiRequest('GET',    '/api/ops/status'),
  runOpsJob:        (job)           => apiRequest('POST',   `/api/internal/jobs/run?job=${encodeURIComponent(job)}`),
  getAuditLogs:     ()              => apiRequest('GET',    '/api/audit-logs'),

  // ─── EVENT ADVANCED MODULES (staff only) ───
  getPlannerWorkspace: (eventId) => apiRequest('GET',   `/api/planner/workspace/${eventId}`),
  getPlannerAnalytics: (eventId) => apiRequest('GET',   `/api/planner/analytics/${eventId}`),
  getPlannerList:   (kind, eventId) => apiRequest('GET', `/api/planner/${kind}?eventId=${eventId}`),
  createPlannerItem:(kind, d)       => apiRequest('POST',   `/api/planner/${kind}`, d),
  updatePlannerItem:(kind, id, d)   => apiRequest('PUT',    `/api/planner/${kind}/${id}`, d),
  deletePlannerItem:(kind, id)      => apiRequest('DELETE', `/api/planner/${kind}/${id}`),
  plannerReportUrl: (eventId, type = 'full') => `${API_BASE_URL}/api/planner/report/${eventId}?type=${type}`,

  // ─── COMPLIANCE ───
  recordConsent:    (d)             => apiRequest('POST',   '/api/consent', d),
  getConsentHistory:()              => apiRequest('GET',    '/api/consent'),
  getVault:         ()              => apiRequest('GET',    '/api/vault'),
  storeVaultField:  (d)             => apiRequest('POST',   '/api/vault', d),
  revealVaultField: (id, reason)    => apiRequest('POST',   `/api/vault/${id}/reveal`, { reason }),
  getVaultAccessLogs:()             => apiRequest('GET',    '/api/vault/access-logs'),
  getComplianceStatus:()            => apiRequest('GET',    '/api/compliance/status'),
  getDeletionRequest:()             => apiRequest('GET',    '/api/dsar/delete'),
  requestDeletion:  (reason)        => apiRequest('POST',   '/api/dsar/delete', { reason }),
  cancelDeletion:   ()              => apiRequest('DELETE', '/api/dsar/delete'),
  dsarExportUrl:    (format = 'json') => `${API_BASE_URL}/api/dsar/export?format=${format}`,

  // Import history (admin panel audit trail)
  getImportHistoryV2: ()            => apiRequest('GET',    '/api/import-history')
});

Object.assign(API, {
  changePassword: (currentPassword, newPassword) =>
    apiRequest('POST', '/api/auth/change-password', { currentPassword, newPassword }),
  // Changing a password ends every session opened under the old one, so the
  // response carries a replacement token for this browser.
  forgotPassword:   (email)         => apiRequest('POST',   '/api/auth/forgot-password', { email }),
  resetPassword:    (token, newPassword) =>
    apiRequest('POST', '/api/auth/reset-password', { token, newPassword }),
  getMyProfile: () => apiRequest('GET', '/api/profile/me'),
  updateMyProfile: (data) => apiRequest('PUT', '/api/profile/me', data)
});
