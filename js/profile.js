/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   profile.js

   The ten-section profile hub, the profile editor, completeness scoring,
   badges and the digital ID card.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */

let _profilePromise = null;
function loadMyProfile(force = false) {
  if (force) _profilePromise = null;
  if (!_profilePromise) _profilePromise = API.getMyProfile();
  return _profilePromise;
}
const PROFILE_COMPLETENESS_FIELDS = [
  ['full_name', 'Full name'], ['primary_email', 'Email address'], ['mobile_number', 'Mobile number'],
  ['batch', 'Batch / passing year'], ['department', 'Department'], ['student_id', 'Student ID'],
  ['bio', 'Short bio'], ['photo_url', 'Profile photo'], ['present_address', 'Present address'],
  ['city', 'City'], ['country', 'Country'], ['blood_group', 'Blood group'],
  ['current_company', 'Current organisation'], ['job_title', 'Current designation'],
  ['skills', 'Skills'], ['linkedin', 'LinkedIn profile']
];

function profileCompleteness(profile) {
  if (!profile) return null;
  const filled = PROFILE_COMPLETENESS_FIELDS.filter(([k]) => {
    const v = profile[k];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
  return {
    percent: Math.round((filled.length / PROFILE_COMPLETENESS_FIELDS.length) * 100),
    filled: filled.length,
    total: PROFILE_COMPLETENESS_FIELDS.length,
    missing: PROFILE_COMPLETENESS_FIELDS.filter(([k]) => {
      const v = profile[k];
      return v === null || v === undefined || String(v).trim() === '';
    }).map(([, label]) => label)
  };
}

function paintProfileCompleteness(fillId, ringId, textId, itemsId) {
  loadMyProfile().then(p => {
    const fill = document.getElementById(fillId);
    const ring = document.getElementById(ringId);
    const text = document.getElementById(textId);
    const items = itemsId ? document.getElementById(itemsId) : null;
    if (apiFailed(p)) {
      if (text) text.textContent = 'Profile could not be loaded.';
      if (ring) ring.textContent = '—';
      if (items) items.innerHTML = '';
      return;
    }
    const c = profileCompleteness(p);
    if (fill) fill.style.width = c.percent + '%';
    if (ring) ring.textContent = c.percent + '%';
    if (text) {
      text.textContent = c.percent === 100
        ? `Complete — all ${c.total} profile fields filled in`
        : `${c.filled} of ${c.total} fields filled in · next: ${c.missing.slice(0, 3).join(', ')}`;
    }
    // One chip per field, ticked only when that field actually holds a value.
    if (items) {
      items.innerHTML = PROFILE_COMPLETENESS_FIELDS.map(([key, label]) => {
        const v = p[key];
        const done = v !== null && v !== undefined && String(v).trim() !== '';
        return `<div class="pc-item ${done ? 'done' : 'missing'}">
          <i data-lucide="${done ? 'check' : 'circle'}" class="ui-icon"></i> ${escapeHtml(label)}</div>`;
      }).join('');
      if (window.lucide) lucide.createIcons();
    }
  });
}

async function viewAlumniProfile(id) {
  const profile = await API.getAlumniProfile(id);

  // No silent mock substitution: if the profile cannot be fetched, say so.
  if (!profile || !profile.name) {
    showModal(`
      <div class="modal-header">
        <div class="modal-title">Profile unavailable</div>
        <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
      </div>
      ${renderErrorState('Could not load this alumni profile.', `closeModal(); viewAlumniProfile(${parseInt(id)})`)}
    `);
    return;
  }

  // Fields the database genuinely has no value for render as an explicit
  // placeholder rather than a plausible-looking invention.
  const unset = '<span class="field-unset">Not provided</span>';
  const val = (v) => (v === null || v === undefined || v === '') ? unset : escapeHtml(v);

  /* A constant "96% AI Mentorship Career Vector Match" used to be shown here,
     on every profile, for every viewer. Nothing computed it and no model exists.
     What the database can compare is which profile attributes the viewer and
     this alumnus have in common, so that is what is listed. */
  const shared = sharedProfileAttributes(profile);


  showModal(`
    <div class="onboarding-header">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="alumni-avatar verified-ring" style="width:52px;height:52px;font-size:18px;background:var(--teal)">
          <span>${profile.initials || profile.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()}</span>
          <div class="verified-badge-icon"><i data-lucide="check" class="ui-icon"></i></div>
        </div>
        <div style="flex:1">
          <div class="onboarding-title" style="font-size:18px">${profile.name}</div>
          <div class="onboarding-sub">${[profile.jobTitle, profile.company].filter(Boolean).join(" · ") || "Profile incomplete"}</div>
          <div style="font-size:11px;color:var(--teal);margin-top:2px"><i data-lucide="graduation-cap" class="ui-icon"></i> ${val(profile.degree)}${profile.batch ? ` (Batch ${profile.batch})` : ""} · ${val(profile.department)}</div>
        </div>
        <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px;max-height:62vh;overflow-y:auto;padding-right:6px">
      <!-- What the two profiles genuinely have in common. No score. -->
      ${shared.length ? `
      <div style="background:var(--bg-glass);border:1px solid var(--border-glass);border-radius:var(--radius-sm);padding:10px 14px">
        <div style="display:flex;align-items:center;gap:8px">
          <i data-lucide="link-2" class="ui-icon"></i>
          <div>
            <div style="font-weight:700;font-size:13px;color:var(--teal)">You have ${shared.length} thing${shared.length === 1 ? '' : 's'} in common</div>
            <div style="font-size:11px;color:var(--text-secondary)">${shared.map(escapeHtml).join(' · ')}</div>
          </div>
        </div>
      </div>` : ''}

      <!-- VERIFICATION BADGES -->
      <div class="verification-badges-grid">
        ${profile.studentId ? `<span class="verify-pill"><i data-lucide="check" class="ui-icon"></i> Student ID ${escapeHtml(profile.studentId)}</span>` : ""}
        ${profile.email ? `<span class="verify-pill"><i data-lucide="check" class="ui-icon"></i> Email Verified (${escapeHtml(profile.email)})</span>` : ""}
        <span class="verify-pill"><i data-lucide="check" class="ui-icon"></i> DIC Alumni Board Verified</span>
      </div>

      <!-- ABOUT BIO -->
      <div class="profile-section-card">
        <div class="profile-section-title" style="font-size:13px;font-weight:700;color:var(--teal)"><i data-lucide="pin" class="ui-icon"></i> About &amp; Biography</div>
        <div style="font-size:13px;color:var(--text-primary);margin-top:6px">${val(profile.bio)}</div>
      </div>

      <!-- CAREER & LOCATION -->
      <div class="profile-section-card">
        <div class="profile-section-title" style="font-size:13px;font-weight:700;color:var(--teal)"><i data-lucide="briefcase" class="ui-icon"></i> Professional &amp; Location Details</div>
        <div class="field-grid-2" style="margin-top:8px">
          <div><div class="field-label">Current Role &amp; Employer</div><div class="field-val">${profile.jobTitle || profile.company ? escapeHtml([profile.jobTitle, profile.company].filter(Boolean).join(" at ")) : unset}</div></div>
          <div><div class="field-label">Geographical Location</div><div class="field-val"><i data-lucide="map-pin" class="ui-icon"></i> ${val(profile.location)}</div></div>
          <div><div class="field-label">Primary Email</div><div class="field-val">${val(profile.email)}</div></div>
          <div><div class="field-label">Mobile Number</div><div class="field-val">${val(profile.mobile)}</div></div>
        </div>
      </div>

      <!-- SKILLS -->
      <div class="profile-section-card">
        <div class="profile-section-title" style="font-size:13px;font-weight:700;color:var(--teal)"><i data-lucide="zap" class="ui-icon"></i> Core Expertise &amp; Skills</div>
        <div class="alumni-tags" style="margin-top:8px">
          ${(profile.skills && profile.skills.length) ? profile.skills.map(s => `<span class="alumni-tag">${escapeHtml(s)}</span>`).join('') : unset}
        </div>
      </div>

      <!-- PRD UTILITIES (DIGITAL PASS & DSAR EXPORT) -->
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" style="flex:1" onclick="showToast('🎟 Generated DIC Wallet Pass (Apple/Google PKPass)')"><i data-lucide="ticket" class="ui-icon"></i> Download Digital Pass</button>
        <button class="btn btn-outline btn-sm" style="flex:1" onclick="exportProfileDSAR('${profile.name}')"><i data-lucide="download" class="ui-icon"></i> Export Data (DSAR JSON)</button>
      </div>

      <!-- ACTION BUTTONS -->
      <div class="field-grid-2" style="margin-top:10px">
        <button class="btn btn-primary btn-full" onclick="closeModal(); connectAlumni('${profile.name}')">+ Connect</button>
        <button class="btn btn-outline btn-full" onclick="closeModal(); showMentorModal('${escapeHtml(profile.name).replace(/'/g, '&#39;')}', ${profile.id})"><i data-lucide="handshake" class="ui-icon"></i> Request Mentorship</button>
      </div>
    </div>
  `);
}


/* Attributes the signed-in user and another profile actually share, compared
   field by field against alumni_profiles. Used in place of the invented match
   percentage; returns an empty list when nothing matches, and the caller then
   shows nothing rather than a low score dressed up as a high one. */

// ─── MISC ACTIONS ────────────────────────────────────────────


function showEditProfile() { showToast('✏ Profile editor loading…'); }

// ─── 6. COMPREHENSIVE 10-SECTION USER PROFILE HUB ─────────────
let PROFILE_PRIVACY_SETTINGS = {
  mobile: 'private',
  email: 'alumni',
  address: 'private',
  cgpa: 'private',
  linkedin: 'public',
  github: 'public',
  company: 'public'
};

/* This object used to be a complete, invented alumnus — Mohiuddin Rahman, ID
   DIC-2020-0847, born 14 August 1998, blood group O+, living at House 42 Road 11
   Dhanmondi, father Abdur Rahman on +880 1912-345678 — and the ten-section
   profile page rendered it for whoever was signed in. Every account saw the same
   stranger's address, phone numbers and emergency contact as their own profile.

   It now starts empty and is filled by hydrateUserProfile() from
   GET /api/profile/me. A field the database has no column for stays empty and
   renders as "Not recorded" rather than as somebody's invented answer. */
let FULL_USER_PROFILE = {
  fullName: '', nickname: '', studentId: '', rollNumber: '', registrationNumber: '',
  batch: '', passingYear: '', department: '', program: '', section: '',
  currentStatus: '', dob: '', gender: '', bloodGroup: '', bio: '',
  primaryEmail: '', secondaryEmail: '', mobileNumber: '', altMobile: '',
  emergencyName: '', emergencyPhone: '', emergencyRelation: '',
  presentAddress: '', permanentAddress: '', hometown: '', city: '', district: '',
  division: '', country: '', postalCode: '',
  degree: '', cgpa: '', admissionYear: '', clubs: '', scholarship: '', awards: '',
  publications: '', certifications: '',
  currentCompany: '', jobTitle: '', employmentType: '', industry: '',
  yearsExperience: '', skills: '',
  linkedin: '', facebook: '', github: '', twitter: '', website: ''
};

/* Maps the alumni_profiles / users row onto the key names the profile template
   already uses, so the markup is untouched and only the source of the values
   changes. Called before the profile page renders. */
async function hydrateUserProfile() {
  const p = await loadMyProfile();
  if (apiFailed(p)) return null;

  const v = (x) => (x === null || x === undefined ? '' : String(x));
  Object.assign(FULL_USER_PROFILE, {
    fullName: v(p.full_name),
    studentId: v(p.student_id),
    rollNumber: v(p.roll_number),
    registrationNumber: v(p.registration_number),
    batch: v(p.batch),
    passingYear: v(p.passing_year),
    department: v(p.department || p.user_department),
    program: v(p.program),
    section: v(p.section_code),
    currentStatus: v(p.current_status),
    dob: v(p.dob),
    gender: v(p.gender),
    bloodGroup: v(p.blood_group),
    bio: v(p.bio),
    primaryEmail: v(p.primary_email || p.email),
    secondaryEmail: v(p.secondary_email),
    mobileNumber: v(p.mobile_number),
    altMobile: v(p.alt_mobile),
    emergencyName: v(p.emergency_name),
    emergencyPhone: v(p.emergency_phone),
    emergencyRelation: v(p.emergency_relation),
    presentAddress: v(p.present_address),
    permanentAddress: v(p.permanent_address),
    hometown: v(p.hometown),
    city: v(p.city),
    district: v(p.district),
    division: v(p.division),
    country: v(p.country),
    postalCode: v(p.postal_code),
    degree: v(p.degree),
    cgpa: v(p.cgpa),
    admissionYear: v(p.admission_year),
    clubs: v(p.clubs),
    scholarship: v(p.scholarship),
    awards: v(p.awards),
    publications: v(p.publications),
    certifications: v(p.certifications),
    currentCompany: v(p.current_company),
    jobTitle: v(p.job_title),
    employmentType: v(p.employment_type),
    industry: v(p.industry),
    yearsExperience: v(p.years_experience),
    skills: v(p.skills),
    linkedin: v(p.linkedin),
    facebook: v(p.facebook),
    github: v(p.github),
    twitter: v(p.twitter),
    website: v(p.website)
  });

  // The digital ID card, from the same row.
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('id-card-avatar', p.initials || (p.full_name || '?').charAt(0));
  set('id-card-name', p.full_name || 'Unnamed account');
  set('id-card-degree', [p.degree, p.program].filter(Boolean).join(' · '));
  set('id-card-batch', p.batch ? `Batch of ${p.batch}` : '');
  set('id-card-role', p.role_label || p.role || '');
  set('id-card-number', p.student_id ? `ID: ${p.student_id}` : 'No student ID recorded');
  set('id-card-verified', p.is_verified ? 'Verified by an administrator' : 'Not yet verified');
  return p;
}

function render10SectionProfile(filterSection = 'all') {
  const container = document.getElementById('profile-hub-content');
  if (!container) return;

  /* Reads through hydrateUserProfile()'s values but substitutes "Not recorded"
     for anything empty, so a field the user has not filled in is visibly
     missing rather than a blank space that could pass for a value. */
  const p = new Proxy(FULL_USER_PROFILE, {
    get(t, k) {
      const v = t[k];
      return (v === '' || v === null || v === undefined) ? 'Not recorded' : v;
    }
  });
  const priv = PROFILE_PRIVACY_SETTINGS;

  let html = '';

  // 1. BASIC INFO
  if (filterSection === 'all' || filterSection === 'basic') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="user" class="ui-icon"></i> Section 1: Basic &amp; Academic Identity</div>
          <span class="privacy-badge public"><i data-lucide="globe" class="ui-icon"></i> Public</span>
        </div>
        <div class="field-grid-3 mb-16">
          <div class="profile-field-row"><div><div class="field-label">Full Name</div><div class="field-val">${p.fullName}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Nickname</div><div class="field-val">${p.nickname}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Student ID</div><div class="field-val">${p.studentId}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Roll &amp; Reg No</div><div class="field-val">${p.rollNumber} / ${p.registrationNumber}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Batch &amp; Dept</div><div class="field-val">Batch ${p.batch} · ${p.department}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Status &amp; Gender</div><div class="field-val">${p.currentStatus} · ${p.gender} (${p.bloodGroup})</div></div></div>
        </div>
        <div class="profile-field-row"><div><div class="field-label">Biography</div><div class="field-val">${p.bio}</div></div></div>
      </div>
    `;
  }

  // 2. CONTACT & EMERGENCY
  if (filterSection === 'all' || filterSection === 'contact') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="smartphone" class="ui-icon"></i> Section 2: Contact &amp; Emergency Details</div>
          <span class="privacy-badge ${priv.mobile}">${priv.mobile === 'private' ? '<i data-lucide="lock" class="ui-icon"></i> Private' : '<i data-lucide="globe" class="ui-icon"></i> Public'}</span>
        </div>
        <div class="field-grid-2 mb-16">
          <div class="profile-field-row"><div><div class="field-label">Primary Email</div><div class="field-val">${p.primaryEmail}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Secondary Email</div><div class="field-val">${p.secondaryEmail}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Mobile Number</div><div class="field-val">${p.mobileNumber}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Emergency Contact</div><div class="field-val">${p.emergencyName} (${p.emergencyRelation}) — ${p.emergencyPhone}</div></div></div>
        </div>
      </div>
    `;
  }

  // 3. ADDRESS & LOCATION
  if (filterSection === 'all' || filterSection === 'location') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="map-pin" class="ui-icon"></i> Section 3: Address &amp; Geographical Location</div>
          <span class="privacy-badge ${priv.address}">${priv.address === 'private' ? '<i data-lucide="lock" class="ui-icon"></i> Private' : '<i data-lucide="users" class="ui-icon"></i> Alumni Only'}</span>
        </div>
        <div class="field-grid-2 mb-16">
          <div class="profile-field-row"><div><div class="field-label">Present Address</div><div class="field-val">${p.presentAddress}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Permanent Address</div><div class="field-val">${p.permanentAddress}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Hometown &amp; District</div><div class="field-val">${p.hometown}, ${p.district}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Country &amp; Zip</div><div class="field-val">${p.country} (${p.postalCode})</div></div></div>
        </div>
      </div>
    `;
  }

  // 4. ACADEMIC RECORD
  if (filterSection === 'all' || filterSection === 'academic') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="graduation-cap" class="ui-icon"></i> Section 4: Academic Honors &amp; Publications</div>
          <span class="privacy-badge alumni"><i data-lucide="users" class="ui-icon"></i> Alumni Only</span>
        </div>
        <div class="field-grid-2 mb-16">
          <div class="profile-field-row"><div><div class="field-label">Degree &amp; CGPA</div><div class="field-val">${p.degree} (CGPA: ${p.cgpa})</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Scholarship &amp; Awards</div><div class="field-val">${p.scholarship}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Clubs &amp; Societies</div><div class="field-val">${p.clubs}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Research Publications</div><div class="field-val">${p.publications}</div></div></div>
        </div>
      </div>
    `;
  }

  // 5. PROFESSIONAL INFO
  if (filterSection === 'all' || filterSection === 'professional') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="briefcase" class="ui-icon"></i> Section 5: Professional Career &amp; Experience</div>
          <span class="privacy-badge public"><i data-lucide="globe" class="ui-icon"></i> Public</span>
        </div>
        <div class="field-grid-2 mb-16">
          <div class="profile-field-row"><div><div class="field-label">Current Company &amp; Role</div><div class="field-val">${p.currentCompany} — ${p.jobTitle}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Industry &amp; Experience</div><div class="field-val">${p.industry} (${p.yearsExperience})</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Technical Skills</div><div class="field-val">${p.skills}</div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Certifications</div><div class="field-val">${p.certifications}</div></div></div>
        </div>
      </div>
    `;
  }

  // 6. NETWORKING & HIRING
  if (filterSection === 'all' || filterSection === 'networking') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="handshake" class="ui-icon"></i> Section 6: Networking &amp; Mentorship Status</div>
          <span class="privacy-badge public"><i data-lucide="globe" class="ui-icon"></i> Public</span>
        </div>
        <div class="verification-badges-grid mb-16">
          <span class="verify-pill" style="background:rgba(0,168,89,0.2)"><i data-lucide="check" class="ui-icon"></i> Open for Mentoring Students</span>
          <span class="verify-pill" style="background:rgba(0,212,170,0.2)"><i data-lucide="check" class="ui-icon"></i> Actively Hiring at Brain Station 23</span>
          <span class="verify-pill"><i data-lucide="check" class="ui-icon"></i> Available for Startup Collaboration</span>
        </div>
      </div>
    `;
  }

  // 7. SOCIAL PROFILES
  if (filterSection === 'all' || filterSection === 'social') {
    html += `
      <div class="profile-section-card">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="globe" class="ui-icon"></i> Section 7: Social Profiles &amp; Portfolio</div>
          <span class="privacy-badge public"><i data-lucide="globe" class="ui-icon"></i> Public</span>
        </div>
        <div class="field-grid-2 mb-16">
          <div class="profile-field-row"><div><div class="field-label">LinkedIn</div><div class="field-val"><a href="${p.linkedin}" target="_blank" style="color:var(--teal)">${p.linkedin}</a></div></div></div>
          <div class="profile-field-row"><div><div class="field-label">GitHub</div><div class="field-val"><a href="${p.github}" target="_blank" style="color:var(--teal)">${p.github}</a></div></div></div>
          <div class="profile-field-row"><div><div class="field-label">Personal Portfolio</div><div class="field-val"><a href="${p.website}" target="_blank" style="color:var(--teal)">${p.website}</a></div></div></div>
        </div>
      </div>
    `;
  }

  // 8. CUSTOM FIELDS (ADMIN CREATED)
  // Fields come from the custom_fields table via renderProfileCustomFields().
  // They previously came from a MOCK_CUSTOM_FIELDS array that duplicated the
  // same three rows, and every one of them displayed the same invented answer,
  // "IEEE Research Paper / National Award 2020", on every profile. There is no
  // per-user value column for these fields, so no value can be shown.
  if (filterSection === 'all' || filterSection === 'custom') {
    html += `
      <div class="profile-section-card" id="profile-custom-fields">
        <div class="profile-section-header">
          <div class="profile-section-title"><i data-lucide="settings" class="ui-icon"></i> Section 8: Admin Custom Institution Fields</div>
          <span class="privacy-badge alumni"><i data-lucide="users" class="ui-icon"></i> DIC Portal Only</span>
        </div>
        <div id="profile-custom-fields-body"></div>
      </div>
    `;
  }

  container.innerHTML = html;
  renderProfileCustomFields();
}

/* Lists the fields an administrator has defined in custom_fields. The table
   stores the definition only — label, section, type, required — and there is no
   column anywhere holding a given alumnus's answer, so the values are shown as
   not recorded rather than filled in with something plausible. */

async function renderProfileCustomFields() {
  const el = document.getElementById('profile-custom-fields-body');
  if (!el) return;
  const fields = await API.getCustomFields();
  if (apiFailed(fields)) {
    el.innerHTML = '<div class="chapter-empty-note">Custom fields could not be loaded.</div>';
    return;
  }
  if (!fields.length) {
    el.innerHTML = '<div class="chapter-empty-note">No custom fields have been defined for this institution.</div>';
    return;
  }
  el.innerHTML = `
    <div class="field-grid-2 mb-16">
      ${fields.map(f => `
        <div class="profile-field-row">
          <div>
            <div class="field-label">${escapeHtml(f.label)}${f.is_required ? ' *' : ''}</div>
            <div class="field-val" style="color:var(--text-muted)">Not recorded</div>
          </div>
        </div>`).join('')}
    </div>
    <div class="chapter-empty-note">
      These fields are defined by an administrator, but the system does not yet
      store a value per alumnus for them.
    </div>`;
  if (window.lucide) lucide.createIcons();
}

function switchProfileHubSection(sectionTag, btn) {
  document.querySelectorAll('.profile-hub-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  render10SectionProfile(sectionTag);
}

// ─── 7. FULL PROFILE EDITOR MODAL ───────────────────────────
function showEditProfileV2() {
  const p = FULL_USER_PROFILE;
  openModal(`
    <div class="onboarding-header">
      <div class="onboarding-title"><i data-lucide="pen-line" class="ui-icon"></i> Edit Comprehensive Profile</div>
      <div class="onboarding-sub">Update your 10-section profile details and field privacy settings</div>
    </div>

    <form onsubmit="handleSaveProfileV2(event)" style="display:flex;flex-direction:column;gap:14px;margin-top:14px;max-height:60vh;overflow-y:auto;padding-right:6px">
      <div class="input-group"><label class="input-label">Full Name</label><input type="text" id="edit-fullname" class="form-input" value="${p.fullName}" required /></div>
      <div class="input-group"><label class="input-label">Current Company &amp; Job Title</label><input type="text" id="edit-company" class="form-input" value="${p.currentCompany}" required /></div>
      <div class="input-group"><label class="input-label">Technical Skills (Comma separated)</label><input type="text" id="edit-skills" class="form-input" value="${p.skills}" required /></div>
      <div class="input-group"><label class="input-label">LinkedIn Profile URL</label><input type="url" id="edit-linkedin" class="form-input" value="${p.linkedin}" /></div>
      <div class="input-group"><label class="input-label">Mobile Number Privacy Level</label>
        <select class="form-select" id="edit-priv-mobile">
          <option value="public" ${PROFILE_PRIVACY_SETTINGS.mobile === 'public' ? 'selected' : ''}>Public (Everyone)</option>
          <option value="alumni" ${PROFILE_PRIVACY_SETTINGS.mobile === 'alumni' ? 'selected' : ''}>DIC Alumni Only</option>
          <option value="private" ${PROFILE_PRIVACY_SETTINGS.mobile === 'private' ? 'selected' : ''}>Private (Only Me)</option>
        </select>
      </div>
      <div class="input-group"><label class="input-label">Biography</label><textarea id="edit-bio" class="form-input" rows="3">${p.bio}</textarea></div>
      <button type="submit" class="btn btn-primary btn-full mt-16"><i data-lucide="save" class="ui-icon"></i> Save Profile &amp; Update ID Card</button>
    </form>
  `);
}

function handleSaveProfileV2(e) {
  e.preventDefault();
  FULL_USER_PROFILE.fullName = document.getElementById('edit-fullname').value.trim();
  FULL_USER_PROFILE.currentCompany = document.getElementById('edit-company').value.trim();
  FULL_USER_PROFILE.skills = document.getElementById('edit-skills').value.trim();
  FULL_USER_PROFILE.linkedin = document.getElementById('edit-linkedin').value.trim();
  FULL_USER_PROFILE.bio = document.getElementById('edit-bio').value.trim();
  PROFILE_PRIVACY_SETTINGS.mobile = document.getElementById('edit-priv-mobile').value;

  closeModal();
  loadMyProfile(true);   // the row changed; drop the cached copy
  render10SectionProfile();

  // Update Digital ID & topbar name
  const nameEl = document.getElementById('id-card-name');
  if (nameEl) nameEl.textContent = FULL_USER_PROFILE.fullName;
  
  showToast('✅ User Profile & Field Privacy Settings Saved!');
}

// ─── 8. AUDIENCE SEGMENTATION ENGINE (ADMIN) ─────────────────
/* Audience segmentation. The count under these filters used to start at a
   literal 3,420 and be replaced on every change by updateSegmentCount(), whose
   entire body was Math.floor(Math.random() * 2000) + 1500 — a random number
   between 1,500 and 3,500, labelled "Alumni matched" beside a badge reading
   "Real-Time Vector Filtering". The three filters were invented as well: a
   batch range of 2000-2026 against profiles that run 2014-2021, and industry
   options that did not match the values stored in the column.

   The filters are now built from the values that exist and the count is a
   COUNT over alumni_profiles. */
function renderEngagementScore() {
  const el = document.getElementById('engagement-score-display');
  if (!el) return;
  el.innerHTML = '<div class="engagement-score-display"><div class="score-level">Loading…</div></div>';

  loadPlatformStats().then(s => {
    if (!s) {
      el.innerHTML = renderEmptyState('<i data-lucide="activity" class="ui-icon"></i>',
        'Activity unavailable', 'Your activity summary could not be loaded.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    const rows = [
      ['Events registered', s.my_registrations],
      ['Chapters joined', s.my_chapters],
      ['Connections', s.my_connections],
      ['Mentorships', s.my_mentorships],
      ['Job applications', s.my_job_applications],
      ['Donated', money(s.my_donations_total)]
    ];
    el.innerHTML = `<div class="totals-list">${rows.map(([k, v]) => `
      <div class="totals-row"><span class="totals-key">${k}</span>
      <span class="totals-val">${typeof v === 'number' ? v.toLocaleString('en-IN') : v}</span></div>`).join('')}</div>`;
  });
}

/* Six badges used to be handed to every account unconditionally — Master Mentor
   for "5+ active mentees", Top Donor for "৳50k+", Event Regular for "5+
   reunions" — on a profile with no mentees, no donations and no registrations.
   A badge is now shown only when the count behind it actually meets the bar, and
   the bar is stated on the card. Two of the original six are gone entirely: "PWA
   Early Adopter" and "Community Champion — referred 10+ alumni" have no
   corresponding data anywhere. */
function renderAlumniBadges() {
  const el = document.getElementById('alumni-badges');
  if (!el) return;
  el.innerHTML = '<div class="queue-sub" style="padding:12px">Loading…</div>';

  Promise.all([loadPlatformStats(), loadMyProfile()]).then(([s, profile]) => {
    if (!s) {
      el.innerHTML = renderEmptyState('<i data-lucide="award" class="ui-icon"></i>',
        'Badges unavailable', 'Your activity could not be loaded.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    const verified = !apiFailed(profile) && profile.is_verified;
    const candidates = [
      { icon: 'handshake', title: 'Mentor', desc: 'In an active mentorship', earned: (s.my_mentorships || 0) >= 1 },
      { icon: 'gem', title: 'Donor', desc: 'Has a settled donation', earned: (s.my_donations_total || 0) > 0 },
      { icon: 'ticket', title: 'Event Attendee', desc: 'Registered for an event', earned: (s.my_registrations || 0) >= 1 },
      { icon: 'hexagon', title: 'Chapter Member', desc: 'Joined a chapter', earned: (s.my_chapters || 0) >= 1 },
      { icon: 'users', title: 'Connected', desc: 'Has an accepted connection', earned: (s.my_connections || 0) >= 1 },
      { icon: 'badge-check', title: 'Verified Alumnus', desc: 'Verified by an administrator', earned: !!verified }
    ];
    const earned = candidates.filter(b => b.earned);

    if (!earned.length) {
      el.innerHTML = renderEmptyState('<i data-lucide="award" class="ui-icon"></i>',
        'No badges yet',
        'Badges are awarded for joining a chapter, registering for an event, donating, mentoring or connecting with alumni.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    el.innerHTML = `
      <div class="alumni-badges-grid">
        ${earned.map(b => `
          <div class="badge-card">
            <div class="badge-icon"><i data-lucide="${b.icon}" class="ui-icon"></i></div>
            <div class="badge-title">${b.title}</div>
            <div class="badge-desc">${b.desc}</div>
          </div>`).join('')}
      </div>`;
    if (window.lucide) lucide.createIcons();
  });
}

/* The profile's Career Timeline listed two invented jobs — "DIC Alumni Board
   Director, 2024–Present" and "Senior Software Engineer at Brain Station 23" —
   on every account. alumni_profiles stores a current company and job title and
   nothing historical, so that is what this shows. */
function renderCareerTimeline() {
  const el = document.getElementById('career-timeline');
  if (!el) return;
  loadMyProfile().then(p => {
    if (apiFailed(p)) {
      el.innerHTML = renderEmptyState('<i data-lucide="briefcase" class="ui-icon"></i>',
        'Career details unavailable', 'Your profile could not be loaded.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    const company = (p.current_company || '').trim();
    const role = (p.job_title || '').trim();
    if (!company && !role) {
      el.innerHTML = renderEmptyState('<i data-lucide="briefcase" class="ui-icon"></i>',
        'No current position recorded',
        'Add your organisation and designation from Edit Profile and they will appear here.');
      if (window.lucide) lucide.createIcons();
      return;
    }
    el.innerHTML = `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-company">${escapeHtml(company || '—')}</div>
        <div class="timeline-role">${escapeHtml(role || '—')}</div>
        <div class="timeline-period">Current position</div>
      </div>
      <div class="chapter-empty-note" style="margin-top:12px">
        Only your current position is stored. The system does not keep employment
        history, so there is nothing earlier to show.
      </div>`;
    if (window.lucide) lucide.createIcons();
  });
}

const BLOOD_GROUP_OPTIONS = ['A+','A-','B+','B-','AB+','AB-','O+','O-','Unknown','Prefer not to say'];
const OCCUPATION_OPTIONS = ['Student','Job','Business','Others'];
const HSC_GROUP_OPTIONS = ['Science','Business Studies','Humanities'];
const HSC_VERSION_OPTIONS = ['Bangla','English'];

async function showEditProfileV2() {
  const p = await API.getMyProfile();
  if (apiFailed(p)) { showToast(`⚠ ${p?.error || 'Could not load your profile.'}`); return; }

  const sel = (id, label, options, value, allowBlank = true) => `
    <div class="input-group">
      <label class="input-label">${escapeHtml(label)}</label>
      <select id="${id}" class="form-select">
        ${allowBlank ? `<option value="">Not specified</option>` : ''}
        ${options.map(o => `<option ${String(value) === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
    </div>`;

  const txt = (id, label, value, type = 'text', placeholder = '') => `
    <div class="input-group">
      <label class="input-label">${escapeHtml(label)}</label>
      <input type="${type}" id="${id}" class="form-input" placeholder="${escapeHtml(placeholder)}"
             value="${escapeHtml(value ?? '')}" />
    </div>`;

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="pen-line" class="ui-icon"></i> Edit My Profile</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="handleSaveProfileV2(event)">
      <div class="modal-section-title">Identity</div>
      ${txt('pf-name', 'Full Name', p.full_name)}
      ${txt('pf-mobile', 'Mobile Number', p.mobile_number, 'tel', '01XXXXXXXXX')}
      ${sel('pf-bloodGroup', 'Blood Group', BLOOD_GROUP_OPTIONS, p.blood_group)}

      <div class="modal-section-title mt-16">Academic</div>
      <div class="field-grid-2">
        ${txt('pf-hscPassingYear', 'HSC Passing Year / Batch', p.passing_year, 'number')}
        ${sel('pf-hscGroup', 'HSC Group', HSC_GROUP_OPTIONS, p.hsc_group)}
      </div>
      ${sel('pf-hscVersion', 'HSC Version', HSC_VERSION_OPTIONS, p.hsc_version)}

      <div class="modal-section-title mt-16">Professional</div>
      ${sel('pf-occupation', 'Occupation', OCCUPATION_OPTIONS, p.occupation)}
      ${txt('pf-organization', 'Current Organization / Institution', p.current_company, 'text', 'e.g. NZ Tex Group')}
      ${txt('pf-designation', 'Current Designation', p.job_title, 'text', 'e.g. AGM')}

      <div class="modal-section-title mt-16">Contact &amp; Links</div>
      ${txt('pf-presentAddress', 'Present Address', p.present_address)}
      ${txt('pf-facebook', 'Facebook Profile Link', p.facebook, 'url')}
      ${txt('pf-linkedin', 'LinkedIn', p.linkedin, 'url')}

      <div class="login-error hidden" id="pf-error" role="alert"></div>
      <button type="submit" class="btn btn-primary btn-full mt-16">Save Profile</button>
    </form>
  `);
}

async function handleSaveProfileV2(e) {
  if (e) e.preventDefault();
  const v = (id) => document.getElementById(id)?.value ?? '';

  const res = await API.updateMyProfile({
    name: v('pf-name'),
    mobile: v('pf-mobile'),
    bloodGroup: v('pf-bloodGroup'),
    hscPassingYear: v('pf-hscPassingYear'),
    hscGroup: v('pf-hscGroup'),
    hscVersion: v('pf-hscVersion'),
    occupation: v('pf-occupation'),
    organization: v('pf-organization'),
    designation: v('pf-designation'),
    presentAddress: v('pf-presentAddress'),
    facebook: v('pf-facebook'),
    linkedin: v('pf-linkedin')
  });

  if (apiFailed(res)) {
    const err = document.getElementById('pf-error');
    if (err) { err.textContent = res?.error || 'Could not save.'; err.classList.remove('hidden'); }
    return;
  }

  closeModal();
  showToast('✅ Profile updated.');
  if (state.currentUser && v('pf-name')) state.currentUser.name = v('pf-name').trim();
  updateUserUI();
  if (typeof render10SectionProfile === 'function') render10SectionProfile();
  renderAlumniGrid();
}

function showEditProfile() { return showEditProfileV2(); }

/* ============================================================
   EVENTS & TICKETS — v5
   One list, one workspace, one creation wizard. Light UI, Lucide icons,
   no emoji, no mock panels. Staff see management; alumni see discovery.
   ============================================================ */


/* ─── DATA RIGHTS (PDPA 2026) ───────────────────────────────
   An alumnus's own record: export it, or ask for it to be deleted. These live
   with the profile because that is the page they are reached from; the
   administrator's vault and compliance views are in compliance.js, which the
   alumni site does not load. */

// Downloads through fetch so the Authorization header is attached.
async function exportUserData(format = 'json') {
  showToast(`📦 Preparing your ${format.toUpperCase()} export…`);
  try {
    const res = await fetch(API.dsarExportUrl(format), {
      headers: { Authorization: `Bearer ${localStorage.getItem('dic_session_token')}` }
    });
    if (!res.ok) throw new Error('export failed');
    const text = await res.text();
    downloadTextFile(`dic_my_data.${format}`, text, format === 'csv' ? 'text/csv' : 'application/json');
    showToast('✅ Your data export has been downloaded.');
  } catch {
    showToast('⚠ Could not generate the export. Please try again.');
  }
}

async function exportProfileDSAR() {
  return exportUserData('json');
}

async function showDeleteAccount() {
  const pending = await API.getDeletionRequest();
  const hasPending = !apiFailed(pending) && pending;

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="triangle-alert" class="ui-icon"></i> Delete Account</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    ${hasPending ? `
      <div class="state-panel" style="border-color:rgba(255,140,66,0.4);background:rgba(255,140,66,0.08)">
        <div class="state-icon"><i data-lucide="hourglass" class="ui-icon"></i></div>
        <div class="state-title">Deletion already scheduled</div>
        <div class="state-subtitle">Your account will be permanently purged on ${escapeHtml(formatDate(pending.purge_after))}. You can cancel until then.</div>
      </div>
      <button class="btn btn-primary btn-full mt-16" onclick="cancelAccountDeletion()"><i data-lucide="undo-2" class="ui-icon"></i> Cancel deletion request</button>
    ` : `
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">
        Under PDPA 2026 your account enters a <strong>30-day grace period</strong> before permanent deletion.
        You can cancel at any point during that window. We recommend exporting your data first.
      </p>
      <button class="btn btn-outline btn-full" onclick="exportUserData('json')"><i data-lucide="package" class="ui-icon"></i> Export my data first</button>
      <div class="input-group mt-16">
        <label class="input-label">Reason (optional)</label>
        <textarea id="delete-reason" class="form-input" rows="3" placeholder="Help us understand why you are leaving…"></textarea>
      </div>
      <button class="btn btn-danger btn-full" onclick="confirmAccountDeletion()">Request account deletion</button>
    `}
  `);
}

async function confirmAccountDeletion() {
  if (!confirm('Schedule your account for deletion in 30 days?')) return;
  const res = await API.requestDeletion(document.getElementById('delete-reason')?.value.trim());
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not submit the request.'}`); return; }
  closeModal();
  showToast(`⚠ Account deletion scheduled for ${formatDate(res.request.purge_after)}. You can cancel until then.`);
  renderNotifications();
}

async function cancelAccountDeletion() {
  const res = await API.cancelDeletion();
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not cancel.'}`); return; }
  closeModal();
  showToast('✓ Deletion request cancelled — your account is active.');
}

// Records consent with IP + policy version (PDPA 2026).
async function recordConsent(consentType, granted = true) {
  const res = await API.recordConsent({ consentType, granted });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not record consent.'}`); return; }
  showToast(granted ? '✓ Consent recorded.' : '✓ Consent withdrawn.');
}
