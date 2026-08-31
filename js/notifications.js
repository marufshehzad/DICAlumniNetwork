/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   notifications.js

   The notification panel, its unread badge, and broadcasts.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */



async function renderNotifications() {
  const el = document.getElementById('notif-list');
  if (!el) return;

  el.innerHTML = renderSkeletonCards(3, 'notif');

  const items = await API.getNotifications();

  if (items === null) {
    el.innerHTML = renderErrorState('Could not load notifications.', 'renderNotifications()');
    updateNotifBadge(0);
    return;
  }
  if (items.length === 0) {
    el.innerHTML = renderEmptyState('<i data-lucide="bell" class="ui-icon"></i>', 'You are all caught up', 'New activity will show up here.');
    updateNotifBadge(0);
    return;
  }

  el.innerHTML = items.map(n => `
    <div class="notif-item${n.is_unread ? ' unread' : ''}${n.link_entity ? ' linked' : ''}"
         ${n.link_entity ? 'role="button" tabindex="0"' : ''}
         onclick="openNotification(${n.id}, '${n.link_entity || ''}', ${n.link_id || 'null'})"
         ${n.link_entity ? `onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}"` : ''}>
      <div class="notif-item-icon">${emojiIcon(n.icon, 'bell')}</div>
      <div class="notif-item-body">
        <div class="notif-item-title">${escapeHtml(n.title)}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(n.subtitle || '')}</div>
        <div class="notif-item-time">${escapeHtml(formatRelativeTime(n.created_at))}</div>
      </div>
      ${n.is_unread ? '<div class="notif-item-unread"></div>' : ''}
    </div>
  `).join('');

  updateNotifBadge(items.filter(n => n.is_unread).length);
}

// Keeps the topbar bell count honest instead of the hardcoded "7".
function updateNotifBadge(count) {
  document.querySelectorAll('.notif-count').forEach(badge => {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  });
}

/* Notifications carry link_entity/link_id, so clicking one opens the thing it
   is about instead of only marking it read. Staff land in the event workspace;
   an assignee who is not staff gets the task itself, which they can update. */
async function openNotification(id, entity, linkId) {
  markNotificationRead(id);
  if (!entity || !linkId) return;
  if (typeof closeNotifications === 'function') closeNotifications();

  if (entity === 'task') {
    showPage('events');
    if (evCanManage()) {
      const t = await API.getTask(linkId);
      if (!apiFailed(t) && t.event_id) {
        await openEventWorkspace(t.event_id, 'tasks');
        await evOpenTask(linkId);
        return;
      }
    }
    await evOpenTask(linkId);
    return;
  }

  if (entity === 'event') {
    showPage('events');
    if (evCanManage()) await openEventWorkspace(linkId, 'overview');
    return;
  }

  if (entity === 'ticket') {
    showPage('events');
    await evViewTicket(linkId);
  }
}

async function markNotificationRead(id) {
  const res = await API.markNotificationRead(id);
  if (res) renderNotifications();
}

async function markAllNotificationsRead() {
  const res = await API.markAllNotificationsRead();
  if (res) {
    showToast(`✓ ${res.updated} notification${res.updated === 1 ? '' : 's'} marked as read`);
    renderNotifications();
  } else {
    showToast('⚠ Could not update notifications — please retry.');
  }
}

/* renderInternshipDrives() was removed with its card: three internship
   openings written as a literal array, shown on the Job Board beside the real
   postings from the jobs table. */


/* Key Metrics used to list six rates — a 72.3% profile update rate, 35.2% YoY
   donation growth, 83.1% mentorship completion, a 68.4% event conversion rate,
   99.94% uptime and 99.8% offline sync success — each with a "vs last period"
   delta. Not one of those six was computed; all twelve numbers were literals,
   and the schema holds nothing to compute them from: there is no historical
   snapshot to compare a period against, no uptime record, and no sync outcome
   log. They are replaced by counts and by ratios where both sides of the ratio
   are actually stored. */

// ─── REQ-12: BROADCAST HISTORY WITH READ RECEIPTS ────────────

// ─── BROADCAST HISTORY ───
async function renderBroadcastHistory() {
  const el = document.getElementById('broadcast-history');
  if (!el) return;

  const rows = await API.getBroadcasts();
  if (apiFailed(rows)) {
    el.innerHTML = renderErrorState(rows?.error || 'Could not load broadcast history.', 'renderBroadcastHistory()');
    return;
  }
  if (rows.length === 0) {
    el.innerHTML = renderEmptyState('<i data-lucide="megaphone" class="ui-icon"></i>', 'No broadcasts sent yet', 'Announcements you send will be listed here with delivery counts.');
    return;
  }

  el.innerHTML = rows.map(b => `
    <div class="broadcast-entry">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px">${escapeHtml(b.title)}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(b.body)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          ${escapeHtml(formatRelativeTime(b.created_at))} · by ${escapeHtml(b.sender_name || 'System')}
          ${b.target_role ? ` · to ${escapeHtml(b.target_role)}` : ' · to everyone'}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="card-badge teal">${b.delivered_count}/${b.recipients_count} delivered</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${(b.channels || []).join(' · ')}</div>
      </div>
    </div>`).join('');
}

/* The Developer API screen and everything that fed it were removed with the
   page itself: three registered OAuth2 applications with client ids and scopes,
   two webhook endpoints with delivery counters, a rolling request log, an
   endpoint catalogue, three SIS/ERP integrations with status lights, an OpenAPI
   document, and modals for creating applications and webhooks. The platform
   issues no API credentials and sends no webhooks, so all of it was invented.
   The real backend API routes are untouched. */

/* The tenant branding editor was removed. This is a single-institution
   deployment — there is no tenants table, no tenant column on any row, and no
   code path that resolves one — so the panel could only ever list Daffodil
   International College beside a hardcoded alumni count of 38,420. */

// ─── BROADCASTS ───

async function sendBroadcast() {
  const title = document.getElementById('broadcast-title')?.value.trim();
  const body = document.getElementById('broadcast-body')?.value.trim();
  const targetRole = document.getElementById('broadcast-target')?.value || 'all';
  const channels = [...document.querySelectorAll('.broadcast-channel.active')].map(c => c.dataset.channel);

  if (!title) { showToast('⚠ Enter a broadcast title.'); return; }
  if (!body) { showToast('⚠ Enter the message body.'); return; }

  const res = await API.sendBroadcastApi({ title, body, channels: channels.length ? channels : ['push'], targetRole });
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Broadcast failed.'}`); return; }

  closeModal();
  showToast(`📢 Broadcast delivered to ${res.recipients} recipient${res.recipients === 1 ? '' : 's'} via ${(channels.length ? channels : ['push']).join(' + ')}.`);
  if (typeof renderBroadcastHistory === 'function') renderBroadcastHistory();
  renderNotifications();
}

// ─── BROADCAST MODAL (was a toast-only shell) ───
function showBroadcastModal() {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="megaphone" class="ui-icon"></i> Send Broadcast</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div class="input-group"><label class="input-label">Title</label>
      <input type="text" id="broadcast-title" class="form-input" placeholder="e.g. Reunion registration now open" required /></div>
    <div class="input-group"><label class="input-label">Message</label>
      <textarea id="broadcast-body" class="form-input" rows="4" placeholder="Write your announcement…" required></textarea></div>
    <div class="input-group"><label class="input-label">Audience</label>
      <select id="broadcast-target" class="form-select">
        <option value="all">Everyone</option>
        <option value="alumni">Alumni only</option>
        <option value="moderator">Moderators</option>
        <option value="dept_admin">Department admins</option>
        <option value="univ_admin">College admins</option>
      </select></div>
    <div class="input-group"><label class="input-label">Channels</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${[['push','<i data-lucide="bell" class="ui-icon"></i> Push'],['sms','<i data-lucide="message-circle" class="ui-icon"></i> SMS'],['email','<i data-lucide="mail" class="ui-icon"></i> Email']].map((c, i) =>
          `<button type="button" class="chip broadcast-channel${i === 0 ? ' active' : ''}" data-channel="${c[0]}" onclick="this.classList.toggle('active')">${c[1]}</button>`).join('')}
      </div></div>
    <button class="btn btn-primary btn-full" onclick="sendBroadcast()"><i data-lucide="megaphone" class="ui-icon"></i> Send Broadcast</button>
    <div style="font-size:11px;color:var(--text-muted);margin-top:10px;text-align:center">Recipients are resolved from the live audience and delivered as in-app notifications.</div>
  `);
}

// ─── NOTIFICATION PANEL ───
function showNotifications() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  // Pull fresh rows every time the panel opens — it previously toggled a
  // container nothing had rendered into.
  if (!panel.classList.contains('hidden')) renderNotifications();
}

function closeNotifications() {
  const panel = document.getElementById('notif-panel');
  if (panel) panel.classList.add('hidden');
}
