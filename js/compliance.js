/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   compliance.js

   PDPA/CA compliance: the identity vault, DSAR export and deletion,
   consent records and the vault access log.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


// ─── COMPLIANCE GRID (REQ-14) ───
// Reports actual encryption / consent / audit state instead of fixed green pills.
async function renderComplianceGrid() {
  const el = document.getElementById('compliance-grid');
  if (!el) return;

  const items = await API.getComplianceStatus();
  if (apiFailed(items)) {
    el.innerHTML = renderErrorState(items?.error || 'Could not load compliance status.', 'renderComplianceGrid()');
    return;
  }

  const labels = { compliant: '<i data-lucide="check" class="ui-icon"></i> Compliant', pending: '<i data-lucide="clock" class="ui-icon"></i> No data yet', at_risk: '<i data-lucide="triangle-alert" class="ui-icon"></i> Action required' };
  el.innerHTML = items.map(c => `
    <div class="compliance-card ${c.status}">
      <div class="compliance-icon">${emojiIcon(c.icon, 'shield-check')}</div>
      <div class="compliance-title">${escapeHtml(c.title)}</div>
      <div class="compliance-desc">${escapeHtml(c.desc)}</div>
      <span class="compliance-status ${c.status}">${labels[c.status] || c.status}</span>
    </div>`).join('');
}

// ─── 3. REQ-14: NID & BRC AES-256 ENCRYPTED VAULT ───────────

// ─── IDENTITY VAULT PANEL (REQ-14) ───
async function renderNIDVaultPanel() {
  const el = document.getElementById('nid-vault-panel');
  if (!el) return;

  const data = await API.getVault();
  if (apiFailed(data)) {
    el.innerHTML = renderErrorState(data?.error || 'Could not load the identity vault.', 'renderNIDVaultPanel()');
    return;
  }

  const banner = data.encryptionEnabled
    ? `<div class="vault-banner ok"><i data-lucide="lock-keyhole" class="ui-icon"></i> AES-256-GCM encryption active. Values are decryptable only with a logged reason.</div>`
    : `<div class="vault-banner warn"><i data-lucide="triangle-alert" class="ui-icon"></i> ENCRYPTION_KEY is not configured — the vault is refusing to store identity data.</div>`;

  el.innerHTML = `
    ${banner}
    <div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" onclick="showStoreIdentityModal()"><i data-lucide="plus" class="ui-icon"></i> Encrypt a field</button>
      <button class="btn btn-ghost btn-sm" onclick="showVaultAccessLogs()"><i data-lucide="scroll-text" class="ui-icon"></i> Access log</button>
    </div>
    ${data.entries.length === 0
      ? renderEmptyState('<i data-lucide="lock-keyhole" class="ui-icon"></i>', 'No identity fields stored', 'Encrypted NID / BRC records will be listed here, masked.')
      : `<div style="display:flex;flex-direction:column;gap:8px">
          ${data.entries.map(v => `
            <div class="vault-row">
              <div class="vault-icon"><i data-lucide="id-card" class="ui-icon"></i></div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:13px">${escapeHtml(v.owner_name)}</div>
                <div style="font-size:12px;color:var(--text-secondary)">
                  ${escapeHtml(v.field_type.toUpperCase())} · <span style="font-family:monospace">•••• •••• ${escapeHtml(v.last_four || '••••')}</span>
                </div>
              </div>
              <button class="btn btn-sm btn-outline" onclick="decryptVaultField(${v.id}, '${escapeHtml(v.owner_name).replace(/'/g, '&#39;')}')"><i data-lucide="unlock" class="ui-icon"></i> Decrypt</button>
            </div>`).join('')}
        </div>`}
  `;
}

/* The alumnus-facing data-rights functions — exportUserData,
   exportProfileDSAR, showDeleteAccount, confirmAccountDeletion,
   cancelAccountDeletion and recordConsent — moved to profile.js. They are wired
   to buttons on an alumnus's own profile, and the alumni site does not load this
   file: it has no identity vault and no compliance grid. The administrator half
   stays here. */






// Decrypts a real AES-256-GCM field; the reason is mandatory and audited.
async function decryptVaultField(vaultId, ownerName) {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="unlock" class="ui-icon"></i> Decrypt Identity Field</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
      Decrypting ${escapeHtml(ownerName)}'s identity data is a privileged action. Your name, the reason
      and a timestamp are written to the immutable access log.
    </p>
    <div class="input-group">
      <label class="input-label">Reason for access (required)</label>
      <input type="text" id="vault-reason" class="form-input" placeholder="e.g. Scholarship eligibility verification" required />
    </div>
    <button class="btn btn-primary btn-full" onclick="performVaultReveal(${vaultId})"><i data-lucide="unlock" class="ui-icon"></i> Decrypt & Log Access</button>
    <div id="vault-reveal-result" class="mt-16"></div>
  `);
}

async function performVaultReveal(vaultId) {
  const reason = document.getElementById('vault-reason')?.value.trim();
  const box = document.getElementById('vault-reveal-result');

  const res = await API.revealVaultField(vaultId, reason);
  if (apiFailed(res)) {
    box.innerHTML = `<div class="state-panel state-error" style="padding:16px"><div class="state-title">${escapeHtml(res?.error || 'Decryption failed')}</div></div>`;
    return;
  }

  box.innerHTML = `
    <div class="state-panel" style="padding:18px;border-color:rgba(52,211,153,0.4);background:rgba(52,211,153,0.08)">
      <div class="state-title" style="font-family:monospace;font-size:18px;letter-spacing:0.08em">${escapeHtml(res.value)}</div>
      <div class="state-subtitle">${escapeHtml(res.fieldType.toUpperCase())} · ${escapeHtml(res.owner)} · access logged</div>
    </div>`;
  if (typeof renderAuditLog === 'function') renderAuditLog();
}

async function storeIdentityField() {
  const fieldType = document.getElementById('vault-field-type')?.value;
  const value = document.getElementById('vault-field-value')?.value.trim();
  if (!value) { showToast('⚠ Enter a value to encrypt.'); return; }

  const res = await API.storeVaultField({ fieldType, value });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not store the field.'}`); return; }
  closeModal();
  showToast(`🔐 ${fieldType.toUpperCase()} encrypted with AES-256-GCM and stored.`);
  if (typeof renderNIDVaultPanel === 'function') renderNIDVaultPanel();
}


function showStoreIdentityModal() {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="lock-keyhole" class="ui-icon"></i> Encrypt an Identity Field</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">
      The value is encrypted with AES-256-GCM in the application layer before it reaches PostgreSQL.
      Only the last four digits are stored separately for display.
    </p>
    <div class="input-group"><label class="input-label">Field type</label>
      <select id="vault-field-type" class="form-select">
        <option value="nid">National ID (NID)</option>
        <option value="brc">Birth Registration (BRC)</option>
        <option value="passport">Passport</option>
      </select></div>
    <div class="input-group"><label class="input-label">Value</label>
      <input type="text" id="vault-field-value" class="form-input" placeholder="Enter the identity number" autocomplete="off" required /></div>
    <button class="btn btn-primary btn-full" onclick="storeIdentityField()"><i data-lucide="lock-keyhole" class="ui-icon"></i> Encrypt & Store</button>
  `);
}

async function showVaultAccessLogs() {
  const rows = await API.getVaultAccessLogs();
  if (apiFailed(rows)) { showToast(`⚠ ${rows?.error || 'Could not load access logs.'}`); return; }

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="scroll-text" class="ui-icon"></i> Vault Access Log</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:56vh;overflow-y:auto">
      ${rows.length ? rows.map(l => `
        <div class="glass-card" style="padding:12px">
          <div style="font-weight:700;font-size:13px">${escapeHtml(l.accessed_by_name || 'Unknown')} decrypted ${escapeHtml((l.field_type || '').toUpperCase())}</div>
          <div style="font-size:12px;color:var(--text-secondary)">Subject: ${escapeHtml(l.owner_name || '—')}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">Reason: ${escapeHtml(l.reason)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${escapeHtml(formatRelativeTime(l.created_at))}</div>
        </div>`).join('')
      : renderEmptyState('<i data-lucide="scroll-text" class="ui-icon"></i>', 'No decryption events recorded')}
    </div>
  `);
}
