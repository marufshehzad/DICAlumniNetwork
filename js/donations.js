/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   donations.js

   Campaigns, the donation flow and the donor leaderboard. Totals are
   computed from settled donations, never from campaigns.raised_amount.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */




// ─── DONATE MODAL ───
function showDonateModal(campaignId, campaignName) {
  state.selectedAmount = null;
  state.selectedGateway = null;

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="heart" class="ui-icon"></i> Donate</div>
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
      <div class="modal-section-title">Payment Method</div>
      <div class="gateway-grid">
        ${[['bkash','<i data-lucide="smartphone" class="ui-icon"></i>','bKash'],['nagad','<i data-lucide="smartphone" class="ui-icon"></i>','Nagad'],['rocket','<i data-lucide="rocket" class="ui-icon"></i>','Rocket'],['card','<i data-lucide="credit-card" class="ui-icon"></i>','Card']].map(([id, icon, label]) =>
          `<div class="gateway-option" onclick="selectGateway(this, '${id}')">
             <div style="font-size:22px">${icon}</div><div style="font-size:12px;font-weight:700">${label}</div>
           </div>`).join('')}
      </div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);margin:14px 0;cursor:pointer">
      <input type="checkbox" id="donate-anonymous" /> Donate anonymously
    </label>
    <button class="btn btn-primary btn-full" onclick="processDonation(${campaignId}, '${escapeHtml(campaignName).replace(/'/g, '&#39;')}')">Continue to Payment →</button>
  `);
}

function selectAmount(btn, amount) {
  document.querySelectorAll('.amount-option').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  state.selectedAmount = amount;
  document.getElementById('custom-amount').value = '';
}

function selectGateway(el, gateway) {
  document.querySelectorAll('.gateway-option').forEach(g => g.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedGateway = gateway;
}
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
    const gateways = Array.isArray(c.gateways) ? c.gateways : [];
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
          ${gateways.map(g => `<span class="gateway-pill ${escapeHtml(g)}">${escapeHtml(g.charAt(0).toUpperCase() + g.slice(1))}</span>`).join('')}
        </div>
        <div style="display:flex;gap:6px">
          ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="deleteCampaignPrompt(${c.id}, '${safeName}')"><i data-lucide="trash-2" class="ui-icon"></i></button>` : ''}
          <button class="donate-btn" onclick="showDonateModal(${c.id}, '${safeName}')">Donate →</button>
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

async function processDonation(campaignId, campaignName) {
  const custom = document.getElementById('custom-amount');
  const amount = state.selectedAmount || (custom && parseFloat(custom.value));

  if (!amount || amount <= 0) { showToast('⚠ Please select or enter a donation amount'); return; }
  if (!state.selectedGateway) { showToast('⚠ Please select a payment gateway'); return; }

  // Phase 1: write the PENDING ledger row before contacting the gateway.
  const created = await API.createDonation({
    campaignId, amount, gateway: state.selectedGateway,
    isAnonymous: document.getElementById('donate-anonymous')?.checked || false
  });

  if (apiFailed(created)) { showToast(`⚠ ${created?.error || 'Could not start the donation.'}`); return; }

  const gwNames = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Visa/Mastercard' };
  const gwName = gwNames[state.selectedGateway] || state.selectedGateway;
  const donation = created.donation;

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="lock-keyhole" class="ui-icon"></i> Authorize Payment</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div class="payment-step">
      <div style="font-size:44px;margin-bottom:10px">${state.selectedGateway === 'bkash' ? '<i data-lucide="smartphone" class="ui-icon"></i>' : state.selectedGateway === 'nagad' ? '<i data-lucide="smartphone" class="ui-icon"></i>' : state.selectedGateway === 'rocket' ? '<i data-lucide="rocket" class="ui-icon"></i>' : '<i data-lucide="credit-card" class="ui-icon"></i>'}</div>
      <div style="font-size:17px;font-weight:800;margin-bottom:6px">Authorising via ${escapeHtml(gwName)}</div>
      <div style="color:var(--text-secondary);margin-bottom:6px">Amount: <strong style="color:var(--teal)">৳${Number(amount).toLocaleString()}</strong></div>
      <div style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-bottom:18px">Ref ${escapeHtml(donation.transaction_reference)}</div>
      <div style="background:var(--bg-glass);border:1px solid var(--border-glass);border-radius:var(--radius-sm);padding:16px;margin-bottom:18px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">Enter your ${escapeHtml(gwName)} PIN</div>
        <div class="otp-inputs" style="justify-content:center">
          ${[0,1,2,3].map(() => '<input type="password" class="otp-box" maxlength="1" inputmode="numeric" />').join('')}
        </div>
      </div>
      <button class="btn btn-primary btn-full" onclick="settleDonation(${donation.id}, true)"><i data-lucide="check" class="ui-icon"></i> Confirm Payment</button>
      <button class="btn btn-ghost btn-full mt-8" onclick="settleDonation(${donation.id}, false)">Simulate a failed payment</button>
      <div style="font-size:11px;color:var(--text-muted);margin-top:10px">A PENDING ledger entry has already been recorded. The campaign total updates only on confirmation.</div>
    </div>
  `);
}

async function settleDonation(donationId, success) {
  const res = await API.confirmDonation(donationId, {
    success, failureReason: success ? null : 'Simulated gateway decline'
  });

  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not settle the transaction.'}`); return; }

  const d = res.donation;

  if (d.status === 'FAILED') {
    showModal(`
      <div class="modal-header">
        <div class="modal-title"><i data-lucide="circle-x" class="ui-icon"></i> Payment Failed</div>
        <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
      </div>
      <div class="payment-step">
        <div style="font-size:44px;margin-bottom:10px"><i data-lucide="triangle-alert" class="ui-icon"></i></div>
        <div style="font-size:16px;font-weight:800;margin-bottom:6px">The transaction was declined</div>
        <div style="color:var(--text-secondary);margin-bottom:8px">${escapeHtml(d.failure_reason || 'The gateway rejected the payment.')}</div>
        <div style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-bottom:18px">Ref ${escapeHtml(d.transaction_reference)}</div>
        <button class="btn btn-primary btn-full" onclick="closeModal(); showPage('donations')">Try again</button>
      </div>
    `);
    renderCampaignsEnhanced();
    return;
  }

  const date = new Date(d.completed_at || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });

  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="party-popper" class="ui-icon"></i> Payment Successful</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div class="payment-step">
      <div class="payment-success"><i data-lucide="circle-check-big" class="ui-icon"></i></div>
      <div class="payment-success-title">Thank you for your donation!</div>
      <div class="payment-success-sub">Your contribution has been recorded in the ledger.</div>
      <div class="receipt-preview">
        <div style="font-size:13px;font-weight:700;margin-bottom:10px;text-align:center">OFFICIAL TAX RECEIPT</div>
        <div style="font-size:11px;text-align:center;color:var(--text-muted);margin-bottom:12px">Daffodil International College Alumni Association</div>
        <div class="receipt-row"><span>Donor</span><span>${escapeHtml(d.is_anonymous ? 'Anonymous' : d.donor_name)}</span></div>
        <div class="receipt-row"><span>Receipt No.</span><span style="font-family:monospace;font-size:11px">${escapeHtml(d.receipt_code)}</span></div>
        <div class="receipt-row"><span>Transaction</span><span style="font-family:monospace;font-size:11px">${escapeHtml(d.transaction_reference)}</span></div>
        <div class="receipt-row"><span>Gateway</span><span>${escapeHtml(d.payment_gateway)}</span></div>
        <div class="receipt-row"><span>Date</span><span style="font-size:11px">${escapeHtml(date)}</span></div>
        <div class="receipt-row"><span>Amount</span><span>৳${Number(d.amount).toLocaleString()}</span></div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-outline" onclick="downloadReceipt(${d.id})"><i data-lucide="file-text" class="ui-icon"></i> Download Receipt</button>
        <button class="btn btn-outline" onclick="closeModal()"><i data-lucide="check" class="ui-icon"></i> Done</button>
      </div>
    </div>
  `);

  state.selectedAmount = null;
  state.selectedGateway = null;
  renderCampaignsEnhanced();
  renderDonorLeaderboard();
  renderNotifications();
}

// Generates a real downloadable receipt from the ledger row.
async function downloadReceipt(donationId) {
  const rows = await API.getMyDonations();
  if (apiFailed(rows)) { showToast('⚠ Could not load your receipt.'); return; }

  const d = rows.find(r => r.id === donationId) || rows[0];
  if (!d) { showToast('⚠ Receipt not found.'); return; }

  const lines = [
    'DAFFODIL INTERNATIONAL COLLEGE — ALUMNI ASSOCIATION',
    'OFFICIAL DONATION RECEIPT (Tax Deductible)',
    '',
    `Receipt No.      : ${d.receipt_code || '—'}`,
    `Transaction Ref  : ${d.transaction_reference}`,
    `Donor            : ${d.is_anonymous ? 'Anonymous' : d.donor_name}`,
    `Campaign         : ${d.campaign_name || '—'}`,
    `Amount           : BDT ${Number(d.amount).toLocaleString()}`,
    `Payment Gateway  : ${d.payment_gateway}`,
    `Status           : ${d.status}`,
    `Date             : ${new Date(d.completed_at || d.created_at).toLocaleString('en-GB')}`,
    '',
    'This receipt was generated from the institutional donation ledger.',
    'Verify at: alumni.dic.edu.bd/verify/' + (d.receipt_code || '')
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
      <div class="input-group"><label class="input-label">Payment Gateways</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${['bkash','nagad','rocket','card'].map((g, i) =>
            `<button type="button" class="chip campaign-gateway${i !== 2 ? ' active' : ''}" data-gateway="${g}" onclick="this.classList.toggle('active')">${g.charAt(0).toUpperCase() + g.slice(1)}</button>`).join('')}
        </div></div>
      <button type="submit" class="btn btn-primary btn-full">Create Campaign</button>
    </form>
  `);
}

async function handleCreateCampaignSubmit(e) {
  if (e) e.preventDefault();
  const gateways = [...document.querySelectorAll('.campaign-gateway.active')].map(b => b.dataset.gateway);
  const res = await API.createCampaign({
    name: document.getElementById('campaign-name').value.trim(),
    description: document.getElementById('campaign-desc').value.trim(),
    goalAmount: document.getElementById('campaign-goal').value,
    daysLeft: document.getElementById('campaign-days').value,
    tag: document.getElementById('campaign-tag').value,
    gateways
  });

  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Could not create the campaign.'}`); return; }
  closeModal();
  showToast(`✅ "${res.name}" is now live.`);
  renderCampaignsEnhanced();
}
