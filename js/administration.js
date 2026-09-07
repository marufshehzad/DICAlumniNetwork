/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ADMIN PORTAL
   administration.js

   Administrator accounts: list, create, edit, suspend, activate, reset
   password. Super admin only, both here and on the server — every endpoint
   this file calls is guarded by SUPER_ONLY.

   Designation and permission role are kept visibly separate throughout. The
   designation is what a person is called; the role is what the middleware
   checks. Nothing on this screen implies the two are connected.

   Loaded only by admin.html. The alumni entry point does not include it.
   ============================================================ */


let _adminDirectory = null;   // last fetched list, for the detail view

/* Roles this screen may assign, filled from the server so the form can never
   offer one the API would reject. super_admin is deliberately absent: platform
   authority is not handed out through a form. */
let _assignableRoles = {};
/* The reference departments, so the edit form can offer real ones. Loaded with
   the page rather than per-modal: it is four rows and it does not change while
   somebody is looking at it. */
let adminDepartments = [];

async function renderAdministrationPage() {
  const el = document.getElementById('administration-body');
  if (!el) return;

  el.innerHTML = '<div class="queue-sub" style="padding:16px">Loading administrators…</div>';
  const [res, depts] = await Promise.all([API.getAdministrators(), API.getDepartments()]);
  /* If the department list does not come back the page still renders: an empty
     selector costs an administrator the ability to change a scope, which is
     better than costing them the whole screen. */
  adminDepartments = apiFailed(depts) ? [] : (depts.departments || []);

  if (apiFailed(res)) {
    el.innerHTML = renderErrorState(
      res?.error || 'Could not load administrators.', 'renderAdministrationPage()');
    return;
  }

  _adminDirectory = res.administrators || [];
  _assignableRoles = res.assignableRoles || {};

  const active = _adminDirectory.filter(a => a.status === 'active').length;
  const suspended = _adminDirectory.length - active;

  el.innerHTML = `
    <div class="sync-overview-grid mb-16">
      <div class="sync-stat-card"><div class="sync-stat-val">${_adminDirectory.length}</div><div class="sync-stat-label">Administrators</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--teal-text)">${active}</div><div class="sync-stat-label">Active</div></div>
      <div class="sync-stat-card"><div class="sync-stat-val" style="color:var(--amber-text)">${suspended}</div><div class="sync-stat-label">Suspended</div></div>
    </div>

    <div class="glass-card">
      <div class="card-header">
        <h2 class="card-title"><i data-lucide="users" class="ui-icon"></i> Administrators</h2>
        <button class="btn btn-primary btn-sm" onclick="showCreateAdministrator()">+ Create Administrator</button>
      </div>
      ${_adminDirectory.length === 0
        ? renderEmptyState('<i data-lucide="users" class="ui-icon"></i>', 'No administrators yet',
            'Create the first institutional administrator account.')
        : `<div class="table-scroll"><table class="rbac-table">
            <thead><tr>
              <th>Name</th><th>Designation</th><th>Email</th><th>Phone</th>
              <th>Permission role</th><th>Status</th><th>Last login</th><th>Created by</th><th></th>
            </tr></thead>
            <tbody>${_adminDirectory.map(adminRow).join('')}</tbody>
          </table></div>`}
    </div>

    <div class="chapter-empty-note" style="margin-top:12px">
      Designation is a title and is shown for identification only. Permission
      role is the setting that decides what an account can do; it is the value
      the server checks on every request.
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

function adminRow(a) {
  const me = state.currentUser && state.currentUser.id === a.id;
  const isSuper = a.role === 'super_admin';
  return `
    <tr id="admin-row-${a.id}">
      <td style="font-weight:700">${escapeHtml(a.name)}${me ? ' <span class="card-badge">you</span>' : ''}</td>
      <td>${escapeHtml(a.designation || '—')}</td>
      <td style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px">${escapeHtml(a.email)}</td>
      <td>${escapeHtml(a.phone || '—')}</td>
      <td><span class="card-badge ${isSuper ? 'amber' : 'teal'}">${escapeHtml(a.roleLabel || a.role)}</span></td>
      <td><span class="card-badge ${a.status === 'active' ? 'teal' : ''}"
                style="${a.status === 'suspended' ? 'background:rgba(255,140,66,0.18);color:var(--amber-text)' : ''}">
            ${a.status === 'active' ? 'Active' : 'Suspended'}</span>
          ${a.mustChangePassword ? '<div style="font-size:10px;color:var(--text-muted);margin-top:3px">must change password</div>' : ''}</td>
      <td style="font-size:11px">${a.lastLoginAt ? escapeHtml(formatRelativeTime(a.lastLoginAt)) : '<span style="color:var(--text-muted)">never</span>'}</td>
      <td style="font-size:11px">${escapeHtml(a.createdByName || '—')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="showAdministrator(${a.id})" title="View"><i data-lucide="eye" class="ui-icon"></i></button>
        ${isSuper ? '' : `
          <button class="btn btn-ghost btn-sm" onclick="showEditAdministrator(${a.id})" title="Edit"><i data-lucide="pen-line" class="ui-icon"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="resetAdministratorPassword(${a.id})" title="Reset password"><i data-lucide="key-round" class="ui-icon"></i></button>
          ${me ? '' : a.status === 'active'
            ? `<button class="btn btn-ghost btn-sm" onclick="setAdministratorStatus(${a.id}, 'suspended')" title="Suspend"><i data-lucide="ban" class="ui-icon"></i></button>`
            : `<button class="btn btn-ghost btn-sm" onclick="setAdministratorStatus(${a.id}, 'active')" title="Activate"><i data-lucide="circle-check" class="ui-icon"></i></button>`}`}
      </td>
    </tr>`;
}

/* ─── VIEW ───────────────────────────────────────────────── */
/* Two different things are called "department" on an administrator, and running
   them together is how somebody concludes a scope is set when it is not.

   `department` is a free-text label — 'CSE Department', 'DIC Administration',
   'System & Security'. It is what a person reads and it governs nothing.
   `departmentId` is the relation every scope check is decided by.

   This line reports the second, and says plainly when a department admin has
   none: that account can reach no departmental record at all, which is the safe
   default and a confusing one to meet without being told. */
function governsLine(a) {
  if (!a.departmentScoped) {
    return a.role === 'moderator'
      ? 'Moderation is platform-wide, not departmental'
      : 'Every department — this role is institution-wide';
  }
  if (!a.departmentId) {
    return '<span style="color:var(--amber-text);font-weight:650">No department assigned</span>' +
           '<span style="display:block;font-size:11.5px;color:var(--text-secondary);line-height:1.45">' +
           'Until one is set, this administrator can reach no alumni, events, reports or ' +
           'audit entries. Edit the account to assign one.</span>';
  }
  return `${escapeHtml(a.departmentName || '')} <span class="card-badge teal">${escapeHtml(a.departmentCode || '')}</span>`;
}

function showAdministrator(id) {
  const a = (_adminDirectory || []).find(x => x.id === id);
  if (!a) return;
  const row = (k, v) => `<div class="totals-row"><span class="totals-key">${k}</span><span class="totals-val">${v}</span></div>`;
  const when = (t) => t ? escapeHtml(formatRelativeTime(t)) : '—';

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="user" class="ui-icon"></i> ${escapeHtml(a.name)}</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div class="totals-list">
      ${row('Designation', escapeHtml(a.designation || '—'))}
      ${row('Permission role', escapeHtml(a.roleLabel || a.role))}
      ${row('Email', escapeHtml(a.email))}
      ${row('Phone', escapeHtml(a.phone || '—'))}
      ${row('Department', escapeHtml(a.department || '—'))}
      ${row('Governs', governsLine(a))}
      ${row('Status', a.status === 'active' ? 'Active' : 'Suspended')}
      ${row('Last sign-in', when(a.lastLoginAt))}
      ${row('Password last changed', when(a.lastPasswordChangedAt))}
      ${row('Account created', when(a.createdAt))}
      ${row('Created by', escapeHtml(a.createdByName || '—'))}
    </div>
  `, { dismissable: true });
}

/* ─── CREATE ─────────────────────────────────────────────── */
function showCreateAdministrator() {
  const roles = Object.entries(_assignableRoles)
    .map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join('');

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="user-plus" class="ui-icon"></i> Create Administrator</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="submitCreateAdministrator(event)">
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="na-name">Full name *</label>
          <input type="text" id="na-name" class="form-input" required /></div>
        <div class="input-group"><label class="input-label" for="na-designation">Designation *</label>
          <input type="text" id="na-designation" class="form-input" placeholder="e.g. Vice Principal" required /></div>
      </div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="na-email">Email *</label>
          <input type="email" id="na-email" class="form-input" required /></div>
        <div class="input-group"><label class="input-label" for="na-phone">Phone</label>
          <input type="tel" id="na-phone" class="form-input" placeholder="+880 …" /></div>
      </div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="na-department">Department</label>
          <input type="text" id="na-department" class="form-input" placeholder="DIC Administration" /></div>
        <div class="input-group"><label class="input-label" for="na-photo">Photo URL</label>
          <input type="url" id="na-photo" class="form-input" placeholder="https://…" /></div>
      </div>
      <div class="input-group">
        <label class="input-label" for="na-role">Permission role *</label>
        <select id="na-role" class="form-select" required>
          <option value="">Choose a permission role…</option>${roles}
        </select>
        <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
          This decides what the account can do. The designation above is a title
          and grants nothing on its own.
        </div>
      </div>
      <div id="na-error" class="form-error hidden"></div>
      <button class="btn btn-primary btn-full" type="submit">
        <i data-lucide="user-plus" class="ui-icon"></i> Create administrator
      </button>
    </form>
  `);
}

async function submitCreateAdministrator(e) {
  if (e) e.preventDefault();
  const err = document.getElementById('na-error');
  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  const v = (id) => document.getElementById(id).value.trim();

  const res = await API.createAdministrator({
    fullName: v('na-name'), designation: v('na-designation'), email: v('na-email'),
    phone: v('na-phone'), department: v('na-department'), photoUrl: v('na-photo'),
    role: document.getElementById('na-role').value
  });
  if (apiFailed(res)) return fail(res?.error || 'Could not create the administrator.');

  closeModal();
  showTemporaryPassword(res.administrator.name, res.temporaryPassword,
    'The account is flagged to change this at first sign-in.');
  renderAdministrationPage();
}

/* A generated password is returned exactly once. It is shown here and nowhere
   else: not stored in plaintext, not written to a log, not in the audit entry. */
function showTemporaryPassword(name, password, note) {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="key-round" class="ui-icon"></i> Temporary password</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
      For <strong>${escapeHtml(name)}</strong>. ${escapeHtml(note)}
    </p>
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;font-weight:700;
                letter-spacing:1px;margin:12px 0;color:var(--teal-text);user-select:all;word-break:break-all">${escapeHtml(password)}</div>
    <div class="chapter-empty-note">
      Shown once. It is not stored anywhere you can read it back, and closing
      this dialog loses it. Pass it to the holder over a channel you trust.
    </div>
  `);
}

/* ─── EDIT ───────────────────────────────────────────────── */
function showEditAdministrator(id) {
  const a = (_adminDirectory || []).find(x => x.id === id);
  if (!a) return;
  const roles = Object.entries(_assignableRoles)
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === a.role ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="pen-line" class="ui-icon"></i> Edit ${escapeHtml(a.name)}</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="submitEditAdministrator(event, ${a.id})">
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="ea-name">Full name *</label>
          <input type="text" id="ea-name" class="form-input" value="${escapeHtml(a.name)}" required /></div>
        <div class="input-group"><label class="input-label" for="ea-designation">Designation *</label>
          <input type="text" id="ea-designation" class="form-input" value="${escapeHtml(a.designation || '')}" required /></div>
      </div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label" for="ea-phone">Phone</label>
          <input type="tel" id="ea-phone" class="form-input" value="${escapeHtml(a.phone || '')}" /></div>
        <div class="input-group"><label class="input-label" for="ea-department">Department label</label>
          <input type="text" id="ea-department" class="form-input" value="${escapeHtml(a.department || '')}" />
          <span style="font-size:11.5px;color:var(--text-muted)">Shown on the profile. Does not decide what they can see.</span></div>
      </div>
      <div class="input-group">
        <label class="input-label" for="ea-role">Permission role *</label>
        <select id="ea-role" class="form-select" required>${roles}</select>
      </div>
      <div class="input-group">
        <label class="input-label" for="ea-department-id">Governs department</label>
        <select id="ea-department-id" class="form-select">
          <option value="">— none —</option>
          ${(adminDepartments || []).map(d => `<option value="${d.id}"${
            a.departmentId === d.id ? ' selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(d.code)})</option>`).join('')}
        </select>
        <span style="font-size:11.5px;color:var(--text-muted);line-height:1.45;display:block;margin-top:5px">
          This is what a department administrator's access is limited to. It has no effect on any
          other role, which sees every department. Left as &ldquo;none&rdquo;, a department
          administrator can reach nothing.
        </span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
        The email address is the sign-in identifier and cannot be changed here.
      </div>
      <div id="ea-error" class="form-error hidden"></div>
      <button class="btn btn-primary btn-full" type="submit">Save changes</button>
    </form>
  `);
}

async function submitEditAdministrator(e, id) {
  if (e) e.preventDefault();
  const err = document.getElementById('ea-error');
  const v = (x) => document.getElementById(x).value.trim();

  const res = await API.updateAdministrator(id, {
    fullName: v('ea-name'), designation: v('ea-designation'),
    phone: v('ea-phone'), department: v('ea-department'),
    /* Sent as null rather than omitted when cleared, so "none" is an instruction
       and not merely an absence the server would ignore. */
    departmentId: document.getElementById('ea-department-id').value || null,
    role: document.getElementById('ea-role').value
  });
  if (apiFailed(res)) {
    err.textContent = res?.error || 'Could not save the changes.';
    err.classList.remove('hidden');
    return;
  }
  closeModal();
  showToast('✅ Administrator updated.');
  renderAdministrationPage();
}

/* ─── SUSPEND / ACTIVATE ─────────────────────────────────── */
async function setAdministratorStatus(id, status) {
  const a = (_adminDirectory || []).find(x => x.id === id);
  const name = a ? a.name : 'this administrator';
  const suspending = status === 'suspended';

  showModal(`
    <div class="modal-header">
      <div class="modal-title">
        <i data-lucide="${suspending ? 'ban' : 'circle-check'}" class="ui-icon"></i>
        ${suspending ? 'Suspend' : 'Activate'} ${escapeHtml(name)}?
      </div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">
      ${suspending
        ? 'They lose access immediately, including any session already open — the server checks account status on every request.'
        : 'They can sign in again straight away.'}
    </p>
    <div style="display:flex;gap:8px">
      <button class="btn ${suspending ? 'btn-danger' : 'btn-primary'}"
              onclick="confirmAdministratorStatus(${id}, ${jsArg(status)})">
        ${suspending ? 'Suspend account' : 'Activate account'}
      </button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `, { dismissable: true });
}

async function confirmAdministratorStatus(id, status) {
  const res = await API.setAdministratorStatus(id, status);
  closeModal();
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not change the status.'}`); return; }
  showToast(status === 'suspended' ? `⛔ ${res.name} suspended.` : `✅ ${res.name} activated.`);
  renderAdministrationPage();
}

/* ─── RESET PASSWORD ─────────────────────────────────────── */
async function resetAdministratorPassword(id) {
  const a = (_adminDirectory || []).find(x => x.id === id);
  const name = a ? a.name : 'this administrator';

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="key-round" class="ui-icon"></i> Reset password for ${escapeHtml(name)}?</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">
      Their current password stops working immediately. A new temporary one is
      shown to you once, and they must replace it at their next sign-in.
    </p>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" onclick="confirmResetAdministratorPassword(${id})">Reset password</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `, { dismissable: true });
}

async function confirmResetAdministratorPassword(id) {
  const res = await API.resetAdministratorPassword(id);
  closeModal();
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not reset the password.'}`); return; }
  showTemporaryPassword(res.name, res.temporaryPassword,
    'Their previous password no longer works.');
  renderAdministrationPage();
}
