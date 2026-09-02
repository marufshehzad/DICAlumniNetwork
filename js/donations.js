/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   donations.js

   Campaigns, the donation flow and the donor leaderboard. Totals are
   computed from settled donations, never from campaigns.raised_amount.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */




/* ─── PLEDGE MODAL ───
   This was a donation modal: pick an amount, pick bKash/Nagad/Rocket/Card,
   type a PIN into a fake gateway screen, and the browser then told the server
   the payment had succeeded. No gateway existed at any point in that flow.

   What the platform can actually do is record that someone intends to give,
   and let the alumni office confirm the money once it arrives. So the form
   records a pledge, and says so. */
function showDonateModal(campaignId, campaignName) {
  state.selectedAmount = null;

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="heart" class="ui-icon"></i> Pledge a donation</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div style="margin-bottom:14px;padding:12px;background:var(--bg-glass);border:1px solid var(--border-glass);border-radius:var(--radius-sm)">
      <div style="font-size:12px;color:var(--text-muted)">Contributing to</div>
      <div style="font-size:15px;font-weight:700;margin-top:2px">${escapeHtml(campaignName)}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Select Amount (৳)</div>
      <div class="amount-grid">
        ${[500, 1000, 2500, 5000, 10000, 25000].map(a =>
          `<button class="amount-btn" onclick="selectAmount(this, ${a})">৳${a.toLocaleString()}</button>`).join('')}
      </div>
      <div class="input-group mt-16">
        <label class="input-label">Or enter a custom amount</label>
        <input type="number" id="custom-amount" class="form-input" min="1" placeholder="e.g. 7500" inputmode="numeric" />
      </div>
    </div>
    <div class="modal-section">
      <div class="login-note" style="display:block">
        <strong>No payment is taken here.</strong> Online payment is not connected yet.
        Your pledge is recorded and the alumni office will contact you to arrange
        payment. Nothing is counted towards the campaign total until they confirm
        the funds have arrived.
      </div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);margin:14px 0;cursor:pointer">
      <input type="checkbox" id="donate-anonymous" /> Keep my name off the public donor list
    </label>
    <button class="btn btn-primary btn-full" onclick="processDonation(${campaignId}, '${escapeHtml(campaignName).replace(/'/g, '&#39;')}')">Record my pledge</button>
  `);
}

function selectAmount(btn, amount) {
  document.querySelectorAll('.amount-option').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  state.selectedAmount = amount;
  document.getElementById('custom-amount').value = '';
}

/* selectGateway() lived here. It drove a bKash/Nagad/Rocket/Card picker in the
   donate modal whose only effect was to label the ledger row with a brand no
   gateway had ever seen. Removed with the picker. */
function campaignDeadline(c) {
  const days = parseInt(c.days_left, 10);
  if (!Number.isFinite(days) || !c.created_at) return '';
  const ends = new Date(c.created_at);
  if (isNaN(ends)) return '';
  ends.setDate(ends.getDate() + days);

  const left = Math.ceil((ends - new Date()) / 86400000);
  const icon = '<i data-lucide="calendar" class="ui-icon"></i>';
  if (left < 0) return `<span>${icon} Closed ${escapeHtml(evDate ? evDate(ends) : ends.toLocaleDateString())}</span>`;
  if (left === 0) return `<span>${icon} Closes today</span>`;
  return `<span>${icon} ${left} day${left === 1 ? '' : 's'} left</span>`;
}
function renderDonationStats(campaigns) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const raised = list.reduce((a, c) => a + (Number(c.raised_live) || 0), 0);
  const donors = list.reduce((a, c) => a + (Number(c.donors_live) || 0), 0);

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('don-kpi-raised', money(raised));
  set('don-kpi-donors', donors.toLocaleString('en-IN'));
  // Average is per donor, and is only meaningful once somebody has donated.
  set('don-kpi-avg', donors > 0 ? money(Math.round(raised / donors)) : '—');
  set('don-kpi-campaigns', String(list.length));
}

async function renderCampaignsEnhanced() {
  const container = document.getElementById('campaigns-grid');
  if (!container) return;

  container.innerHTML = renderSkeletonCards(3, 'campaign');
  const campaigns = await API.getCampaigns();

  if (apiFailed(campaigns)) {
    container.innerHTML = renderErrorState(campaigns?.error || 'Could not load campaigns.', 'renderCampaignsEnhanced()');
    return;
  }
  if (campaigns.length === 0) {
    renderDonationStats([]);   // tiles read ৳0 / 0, not a stale figure
    container.innerHTML = renderEmptyState('<i data-lucide="heart" class="ui-icon"></i>', 'No active campaigns', 'Fundraising campaigns will appear here once launched.');
    return;
  }

  const canManage = state.currentUser && ['super_admin', 'univ_admin'].includes(state.currentUser.role);

  renderDonationStats(campaigns);

  container.innerHTML = campaigns.map(c => {
    // raised_live / donors_live are computed by the API as SUM and COUNT over
    // donations with status SUCCESS. The card used to read campaigns.raised_amount,
    // a stored column seeded at ৳18.45L for a campaign holding ৳5,000 of real
    // settled donations, and campaigns.donors_count, which was never written to.
    const raised = Number(c.raised_live) || 0;
    const donors = Number(c.donors_live) || 0;
    const goal = Number(c.goal_amount) || 0;
    const pct = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
    const remaining = Math.max(0, goal - raised);
    const safeName = escapeHtml(c.name).replace(/'/g, '&#39;');
    return `
    <div class="campaign-card">
      <div class="campaign-card-header">
        <span class="campaign-tag ${escapeHtml(c.tag)}">${escapeHtml((c.tag || '').toUpperCase())}</span>
        <div class="campaign-name">${escapeHtml(c.name)}</div>
        <div class="campaign-desc">${escapeHtml(c.description || '')}</div>
      </div>
      <div class="campaign-progress">
        <div class="campaign-live-indicator"><div class="live-dot"></div> Live</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-meta">
          <span class="progress-raised">${money(raised)} raised</span>
          <span class="progress-goal">of ${money(goal)} goal · ${pct}%</span>
        </div>
        <div style="display:flex;gap:12px;margin-top:8px;font-size:12px;color:var(--text-muted)">
          <span><i data-lucide="users" class="ui-icon"></i> ${donors === 0 ? 'No donations yet' : donors.toLocaleString('en-IN') + (donors === 1 ? ' donor' : ' donors')}</span>
          <span><i data-lucide="target" class="ui-icon"></i> ${money(remaining)} remaining</span>
          ${campaignDeadline(c)}
        </div>
      </div>
      <div class="campaign-footer">
        <div class="gateway-pills">
          <span class="gateway-pill">Pledge · paid offline</span>
        </div>
        <div style="display:flex;gap:6px">
          ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="deleteCampaignPrompt(${c.id}, '${safeName}')"><i data-lucide="trash-2" class="ui-icon"></i></button>` : ''}
          <button class="donate-btn" onclick="showDonateModal(${c.id}, '${safeName}')">Pledge →</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─── OVERRIDE INITAPP & SHOWPAGE (CLEANED UP) ─────────────────
// All renderers directly invoked in master initApp and showPage functions


// ============================================================
// REMAINING FEATURE IMPLEMENTATIONS
// ============================================================

// ─── 1. TOP DONORS LEADERBOARD (DASHBOARD) ───────────────────

// ─── DONOR LEADERBOARD ───
async function renderDonorLeaderboard() {
  const el = document.getElementById('donor-leaderboard');
  if (!el) return;

  const rows = await API.getDonorLeaderboard();
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState('Could not load the leaderboard.', 'renderDonorLeaderboard()');
    return;
  }
  if (rows.length === 0) {
    el.innerHTML = renderEmptyState('<i data-lucide="trophy" class="ui-icon"></i>', 'No donations yet', 'The top contributors will be listed here.');
    return;
  }

  /* The tier under each name — Gold Benefactor, Silver Patron, Bronze Supporter
     and so on — was assigned by position in the list, so whoever gave the most
     was "Gold Benefactor" even at ৳1, and second place was "Silver Patron" even
     at ৳100,000. No tier thresholds are defined anywhere. The rank and the
     amount are real, so those stay and the invented status label goes; the line
     under the name is now the count of donations behind the total. */
  el.innerHTML = rows.map((d, i) => {
    const n = Number(d.donation_count || 0);
    return `
    <div class="donor-row">
      <div class="donor-rank rank-${i + 1}">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <div class="donor-name">${escapeHtml(d.name || 'Anonymous Donor')}${d.batch ? ` · <span style="color:var(--text-muted);font-weight:500">Batch '${String(d.batch).slice(-2)}</span>` : ''}</div>
        ${n ? `<div class="donor-tier">${n} donation${n === 1 ? '' : 's'}</div>` : ''}
      </div>
      <div class="donor-amount">${money(d.total)}</div>
    </div>`;
  }).join('');
}

// ─── EVENT REGISTRATION & TICKETS ───


// ─── DONATIONS ───

/* Records the pledge. There is no second step: the browser has nothing to
   authorise, because nothing is being charged. The simulated gateway screen
   that used to sit here — a bKash/Nagad/Rocket logo, four PIN boxes that were
   never read, a 'Confirm Payment' button and a 'Simulate a failed payment'
   button, both of which POSTed the outcome to the server — is gone. */
async function processDonation(campaignId, campaignName) {
  const custom = document.getElementById('custom-amount');
  const amount = state.selectedAmount || (custom && parseFloat(custom.value));

  if (!amount || amount <= 0) { showToast('\u26a0 Please select or enter an amount'); return; }

  const created = await API.createDonation({
    campaignId, amount,
    isAnonymous: document.getElementById('donate-anonymous')?.checked || false
  });

  if (apiFailed(created)) {
    showToast('\u26a0 ' + ((created && created.error) || 'Could not record the pledge.'));
    return;
  }

  const d = created.donation;
  const date = new Date(d.created_at || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });

  showModal(
    '<div class="modal-header">' +
      '<div class="modal-title"><i data-lucide="handshake" class="ui-icon"></i> Pledge recorded</div>' +
      '<button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>' +
    '</div>' +
    '<div class="payment-step">' +
      '<div class="payment-success"><i data-lucide="circle-check-big" class="ui-icon"></i></div>' +
      '<div class="payment-success-title">Thank you</div>' +
      '<div class="payment-success-sub">Your pledge to ' + escapeHtml(campaignName) + ' is on record.</div>' +
      '<div class="receipt-preview">' +
        '<div style="font-size:13px;font-weight:700;margin-bottom:4px;text-align:center">PLEDGE RECORD</div>' +
        '<div style="font-size:11px;text-align:center;color:var(--text-muted);margin-bottom:12px">' +
          'Not a receipt. No funds have been collected.</div>' +
        '<div class="receipt-row"><span>Donor</span><span>' +
          escapeHtml(d.is_anonymous ? 'Anonymous' : d.donor_name) + '</span></div>' +
        '<div class="receipt-row"><span>Reference</span><span style="font-family:monospace;font-size:11px">' +
          escapeHtml(d.transaction_reference) + '</span></div>' +
        '<div class="receipt-row"><span>Recorded</span><span style="font-size:11px">' +
          escapeHtml(date) + '</span></div>' +
        '<div class="receipt-row"><span>Amount pledged</span><span>\u09f3' +
          Number(d.amount).toLocaleString() + '</span></div>' +
        '<div class="receipt-row"><span>Status</span><span>Awaiting payment</span></div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-top:14px;line-height:1.5">' +
        'The alumni office will contact you to arrange payment. Once they confirm the ' +
        'funds have arrived, this becomes a donation and a receipt is issued.</div>' +
      '<div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
        '<button class="btn btn-outline" onclick="closeModal()">' +
          '<i data-lucide="check" class="ui-icon"></i> Done</button>' +
      '</div>' +
    '</div>'
  );

  state.selectedAmount = null;
  renderCampaignsEnhanced();
  renderDonorLeaderboard();
  renderMyDonations();
  renderNotifications();
}

/* The donor's own ledger. Before this, a pledge vanished the moment the modal
   closed: nothing listed it, nothing could settle it, and downloadReceipt()
   below had lost its only call site when the old fake success modal was
   removed. Staff (ADMIN_ROLES) additionally get the confirm control here,
   which is the only route to a settled donation anywhere in the product. */
async function renderMyDonations() {
  const el = document.getElementById('my-donations');
  if (!el) return;

  const rows = await API.getMyDonations();
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState(rows?.error || 'Could not load your donations.', 'renderMyDonations()');
    return;
  }
  if (!rows.length) {
    el.innerHTML = renderEmptyState('<i data-lucide="heart" class="ui-icon"></i>', 'No pledges yet',
      'Pledges you make will be listed here until the alumni office confirms payment.');
    return;
  }

  const isStaff = state.currentUser && ['super_admin', 'univ_admin'].includes(state.currentUser.role);
  const LABEL = { PLEDGED: 'Awaiting payment', SUCCESS: 'Received', CANCELLED: 'Closed',
                  FAILED: 'Closed', PENDING: 'Awaiting payment', REFUNDED: 'Refunded' };

  el.innerHTML = rows.map(r => {
    const status = LABEL[r.status] || r.status;
    const tone = r.status === 'SUCCESS' ? 'teal' : (r.status === 'PLEDGED' || r.status === 'PENDING') ? 'amber' : '';
    return '<div class="broadcast-entry">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:700;font-size:13px">' + escapeHtml(r.campaign_name || 'Campaign') + '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary)">\u09f3' +
          Number(r.amount).toLocaleString() + ' \u00b7 ' + escapeHtml(r.transaction_reference) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' +
          escapeHtml(formatRelativeTime(r.created_at)) +
          (r.receipt_code ? ' \u00b7 receipt ' + escapeHtml(r.receipt_code) : '') + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;gap:6px;align-items:flex-end">' +
        '<span class="card-badge ' + tone + '">' + escapeHtml(status) + '</span>' +
        (r.status === 'SUCCESS'
          ? '<button class="btn btn-ghost btn-sm" onclick="downloadReceipt(' + r.id + ')">' +
              '<i data-lucide="file-text" class="ui-icon"></i> Receipt</button>'
          : '') +
        (r.status === 'PLEDGED' && isStaff
          ? '<button class="btn btn-outline btn-sm" onclick="recordDonationReceived(' + r.id + ')">' +
              '<i data-lucide="badge-check" class="ui-icon"></i> Mark received</button>'
          : '') +
        (r.status === 'PLEDGED' && !isStaff
          ? '<button class="btn btn-ghost btn-sm" onclick="withdrawPledge(' + r.id + ')">Withdraw</button>'
          : '') +
      '</div>' +
    '</div>';
  }).join('');
  if (typeof refreshIcons === 'function') refreshIcons();
}

// Staff only, and the server enforces that - this is simply the control.
async function recordDonationReceived(id) {
  const method = prompt('How were the funds received? (e.g. bank transfer, cash at the office)', 'bank transfer');
  if (method === null) return;
  const res = await API.recordDonationPayment(id, { received: true, method: method.trim() || 'manual' });
  if (apiFailed(res)) { showToast('\u26a0 ' + ((res && res.error) || 'Could not record the payment.')); return; }
  showToast('Recorded as received. A receipt has been issued to the donor.');
  renderMyDonations(); renderCampaignsEnhanced(); renderDonorLeaderboard();
}

async function withdrawPledge(id) {
  if (!confirm('Withdraw this pledge? The alumni office will no longer expect payment.')) return;
  const res = await API.cancelPledge(id);
  if (apiFailed(res)) { showToast('\u26a0 ' + ((res && res.error) || 'Could not withdraw the pledge.')); return; }
  showToast('Pledge withdrawn.');
  renderMyDonations(); renderCampaignsEnhanced();
}

// Generates a real downloadable receipt from the ledger row.
async function downloadReceipt(donationId) {
  const rows = await API.getMyDonations();
  if (apiFailed(rows)) { showToast('⚠ Could not load your receipt.'); return; }

  const d = rows.find(r => r.id === donationId) || rows[0];
  if (!d) { showToast('⚠ Receipt not found.'); return; }

  const lines = [
    'DAFFODIL INTERNATIONAL COLLEGE — ALUMNI ASSOCIATION',
    'DONATION LEDGER RECORD',
    'Not a tax receipt. Confirmed donations only are marked RECEIVED below.',
    '',
    `Receipt No.      : ${d.receipt_code || '—'}`,
    `Transaction Ref  : ${d.transaction_reference}`,
    `Donor            : ${d.is_anonymous ? 'Anonymous' : d.donor_name}`,
    `Campaign         : ${d.campaign_name || '—'}`,
    `Amount           : BDT ${Number(d.amount).toLocaleString()}`,
    `Method           : ${d.recorded_method || 'not yet received'}`,
    `Status           : ${d.status}`,
    `Date             : ${new Date(d.completed_at || d.created_at).toLocaleString('en-GB')}`,
    '',
    'Generated from the institutional donation ledger.'
  ];

  downloadTextFile(`DIC_Receipt_${d.receipt_code || d.id}.txt`, lines.join('\n'));
  showToast('📄 Receipt downloaded.');
}

async function deleteCampaignPrompt(id, name) {
  if (!confirm(`Delete the campaign "${name}"? Donations already recorded are retained in the ledger.`)) return;
  const res = await API.deleteCampaign(id);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not delete.'}`); return; }
  showToast('🗑 Campaign deleted.');
  renderCampaignsEnhanced();
}

// ─── CREATE CAMPAIGN (was a toast-only shell) ───
function showCreateCampaign() {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="plus" class="ui-icon"></i> Create Campaign</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="handleCreateCampaignSubmit(event)">
      <div class="input-group"><label class="input-label">Campaign Name</label>
        <input type="text" id="campaign-name" class="form-input" placeholder="e.g. Science Lab Fund 2026" required /></div>
      <div class="input-group"><label class="input-label">Description</label>
        <textarea id="campaign-desc" class="form-input" rows="3" placeholder="Describe the impact of this campaign…"></textarea></div>
      <div class="field-grid-2">
        <div class="input-group"><label class="input-label">Goal Amount (৳)</label>
          <input type="number" id="campaign-goal" class="form-input" min="1" value="1500000" required /></div>
        <div class="input-group"><label class="input-label">Days to run</label>
          <input type="number" id="campaign-days" class="form-input" min="1" value="30" /></div>
      </div>
      <div class="input-group"><label class="input-label">Category</label>
        <select id="campaign-tag" class="form-select">
          <option value="scholarship">Scholarship</option><option value="education">Education</option>
          <option value="infrastructure">Infrastructure</option><option value="sports">Sports</option>
        </select></div>
      <button type="submit" class="btn btn-primary btn-full">Create Campaign</button>
    </form>
  `);
}

async function handleCreateCampaignSubmit(e) {
  if (e) e.preventDefault();
  const res = await API.createCampaign({
    name: document.getElementById('campaign-name').value.trim(),
    description: document.getElementById('campaign-desc').value.trim(),
    goalAmount: document.getElementById('campaign-goal').value,
    daysLeft: document.getElementById('campaign-days').value,
    tag: document.getElementById('campaign-tag').value
  });

  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not create the campaign.'}`); return; }
  closeModal();
  showToast(`✅ "${res.name}" is now live.`);
  renderCampaignsEnhanced();
}
