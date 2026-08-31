/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   chapters.js

   Chapters, membership and the chapter detail panel. Member counts come
   from chapter_memberships, not the stored members_count column.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


// Chapters loaded from PostgreSQL by renderChapters(). Was a hardcoded array.
let chaptersCache = [];
// The signed-in user's chapter memberships, also from PostgreSQL.
let USER_CHAPTER_MEMBERSHIPS = new Set();

/* Three arrays lived here and are gone: MOCK_VERIFICATION_QUEUE, which showed
   the same two people awaiting verification on every install; MOCK_TENANTS, a
   single institution with a hardcoded roll of 38,420; and MOCK_CAREER_TIMELINE,
   two invented jobs shown on every alumnus's profile. The verification queue is
   now GET /api/verification-queue, and the other two screens were removed. */

function selectChapter(id) {
  document.querySelectorAll('.chapter-node').forEach(n => n.classList.remove('active'));
  const c = chaptersCache.find(ch => ch.id === id);
  if (!c) return;

  const isJoined = USER_CHAPTER_MEMBERSHIPS.has(c.id);
  const detail = document.getElementById('chapter-detail');
  if (!detail) return;

  detail.innerHTML = `
    <div class="chapter-detail-content">
      <div class="chapter-detail-header">
        <div class="chapter-detail-icon">${emojiIcon(c.icon, 'hexagon')}</div>
        <div>
          <div class="chapter-detail-title">${escapeHtml(c.name)}</div>
          <!-- "Est. 2020 · PostgreSQL Synced" used to sit here. chapters has no
               founding-date column, and every chapter claimed the same year. -->
          <div class="chapter-detail-sub">${c.type.charAt(0).toUpperCase() + c.type.slice(1)} chapter</div>
        </div>
      </div>
      ${c.description ? `<p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${escapeHtml(c.description)}</p>` : ''}
      <!-- Two of the three tiles here were invented: an events count taken from
           chapters.events_count, which nothing ever writes and which cannot be
           derived because events carry no chapter reference, and a fixed "94%
           Active Rate" with nothing behind it at all. -->
      <div class="chapter-stats-grid">
        <div class="chapter-stat"><div class="chapter-stat-val" id="chap-member-count-${c.id}">${c.members.toLocaleString('en-IN')}</div><div class="chapter-stat-lab">${c.members === 1 ? 'Member' : 'Members'}</div></div>
      </div>
      <div style="font-size:14px;font-weight:700;margin-bottom:12px">Chapter Leadership &amp; Officers</div>
      <!-- Three officers were listed by name for every chapter, the same three
           each time. There is no officer or role column on chapters or on
           chapter_memberships, so there is nothing to list. -->
      <div class="chapter-empty-note">
        No chapter officers are recorded. The system does not yet store chapter
        leadership roles.
      </div>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn ${isJoined ? 'btn-outline' : 'btn-primary'} btn-sm" id="btn-join-${c.id}" onclick="toggleJoinChapter(${c.id})">
          ${isJoined ? '<i data-lucide="check" class="ui-icon"></i> Joined Chapter' : '+ Join Chapter'}
        </button>
        <button class="btn btn-outline btn-sm" onclick="showChapterMembersModal(${c.id})"><i data-lucide="users" class="ui-icon"></i> View Members</button>
      </div>
    </div>`;
}

async function toggleJoinChapter(id) {
  const c = chaptersCache.find(ch => ch.id === id);
  if (!c) return;

  // The server owns membership state and returns the resulting flag; the
  // client no longer guesses or maintains a parallel counter.
  const res = await API.joinChapter(id);

  if (!res || res.error) {
    showToast('⚠ Could not update your membership — please try again.');
    return;
  }

  showToast(res.joined ? `🎉 You have joined ${c.name}!` : `ℹ Left chapter ${c.name}.`);

  await renderChapters();
  selectChapter(id);
}

async function showChapterMembersModal(id) {
  const c = chaptersCache.find(ch => ch.id === id);
  let members = [];

  if (typeof API !== 'undefined') {
    const res = await API.getChapterMembers(id);
    if (res && Array.isArray(res)) members = res;
  }

  // An empty chapter shows an empty state — it used to display four unrelated
  // alumni as though they were members.
  if (members.length === 0) {
    openModal(`
      <div class="onboarding-header">
        <div class="onboarding-title"><i data-lucide="users" class="ui-icon"></i> Chapter Enrolled Members</div>
        <div class="onboarding-sub">${escapeHtml(c ? c.name : 'DIC Alumni Chapter')}</div>
        <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
      </div>
      ${renderEmptyState('<i data-lucide="user" class="ui-icon"></i>', 'No members yet', 'Be the first to join this chapter.')}
    `);
    return;
  }

  openModal(`
    <div class="onboarding-header">
      <div class="onboarding-title"><i data-lucide="users" class="ui-icon"></i> Chapter Enrolled Members</div>
      <div class="onboarding-sub">${escapeHtml(c ? c.name : 'DIC Alumni Chapter')} · ${members.length} Enrolled Member${members.length === 1 ? '' : 's'}</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px;max-height:55vh;overflow-y:auto">
      ${members.map(m => `
        <div class="glass-card" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="alumni-avatar" style="width:36px;height:36px;font-size:13px;background:var(--teal)">
              <span>${m.initials || (m.name ? m.name.slice(0,2).toUpperCase() : 'AL')}</span>
            </div>
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text-primary)">${escapeHtml(m.name)}</div>
              <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml([m.role, m.company].filter(Boolean).join(" · ") || "Profile incomplete")}</div>
              <div style="font-size:11px;color:var(--text-muted)">Batch ${m.batch || "—"} · ${escapeHtml(m.dept || "—")}</div>
            </div>
          </div>
          <button class="btn btn-outline btn-sm" onclick="closeModal(); viewAlumniProfile(${m.id || 5})">View Profile</button>
        </div>
      `).join('')}
    </div>
  `);
}

function showCreateChapterModal() {
  openModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="plus" class="ui-icon"></i> Create Chapter</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="handleCreateChapterSubmit(event)">
      <div class="input-group"><label class="input-label">Chapter Name</label><input type="text" id="chap-create-name" class="form-input" placeholder="e.g., Sylhet Regional Chapter" required /></div>
      <div class="input-group"><label class="input-label">Type</label><select id="chap-create-type" class="form-select"><option value="regional">Regional</option><option value="batch">Batch</option><option value="interest">Interest</option></select></div>
      <div class="input-group"><label class="input-label">Icon Emoji</label><input type="text" id="chap-create-icon" class="form-input" value="🏫" required /></div>
      <div class="input-group"><label class="input-label">Description</label><textarea id="chap-create-desc" class="form-input" rows="3" placeholder="What is this chapter for?"></textarea></div>
      <button type="submit" class="btn btn-primary btn-full mt-16"><i data-lucide="rocket" class="ui-icon"></i> Submit Chapter for Moderation</button>
    </form>
  `);
}

async function handleCreateChapterSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('chap-create-name').value.trim();
  const type = document.getElementById('chap-create-type').value;
  const icon = document.getElementById('chap-create-icon').value.trim() || '<i data-lucide="school" class="ui-icon"></i>';
  const description = document.getElementById('chap-create-desc').value.trim();

  if (!name) return;

  // The server decides the status from the session role: admins publish
  // immediately, everyone else enters the moderation queue.
  const res = await API.submitChapter({ name, type, icon, description });

  if (!res || res.error || !res.chapter) {
    showToast(`⚠ Could not create the chapter: ${res?.error || 'the server did not respond.'}`);
    return;
  }

  closeModal();

  if (res.status === 'pending_review') {
    showToast(`⏳ Chapter "${name}" submitted for moderator approval.`);
  } else {
    showToast(`✅ Chapter "${name}" created and published!`);
  }

  await renderChapters();
  // Only approved chapters are in the public list; select it if it is there.
  if (chaptersCache.some(c => c.id === res.chapter.id)) selectChapter(res.chapter.id);
  renderNotifications();
}

async function handleModerateChapter(id, action) {
  if (typeof API !== 'undefined') {
    await API.moderateChapter(id, action);
  }
  showToast(`✅ Chapter ${action === 'approve' ? 'Approved & Published' : 'Rejected'}`);
  // The moderation panel only exists on the staff portal; the chapter list is
  // on both. Refresh whichever of the two this portal actually has.
  if (typeof renderModerationPanel === 'function') renderModerationPanel();
  renderChapters();
}

// ─── CHAPTERS (REQ-13) — single source of truth is PostgreSQL ───
async function renderChapters() {
  const tree = document.getElementById('chapter-tree');
  if (!tree) return;

  tree.innerHTML = renderSkeletonCards(3, 'chapter');
  const rows = await API.getChapters();

  if (rows === null) {
    tree.innerHTML = renderErrorState('Could not load chapters.', 'renderChapters()');
    return;
  }

  chaptersCache = rows.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    icon: c.icon || '<i data-lucide="school" class="ui-icon"></i>',
    description: c.description || '',
    /* member_rows is COUNT(*) over chapter_memberships, computed by the API.
       chapters.members_count is a stored counter that was seeded at 18,420 /
       12,400 / 6,210 / 4,120 / 840 against zero actual memberships, so it is
       not read here at all. If the two ever disagree the row count wins. */
    members: Number(c.member_rows) || 0,
    parent: c.parent_id ?? null
  }));

  // Membership comes from PostgreSQL for the signed-in user.
  USER_CHAPTER_MEMBERSHIPS = new Set(rows.filter(c => c.is_member).map(c => c.id));

  if (chaptersCache.length === 0) {
    tree.innerHTML = renderEmptyState('<i data-lucide="hexagon" class="ui-icon"></i>', 'No chapters yet', 'Create the first regional, batch or interest chapter.');
    const detail = document.getElementById('chapter-detail');
    if (detail) detail.innerHTML = '';
    return;
  }

  const roots = chaptersCache.filter(c => c.parent === null);
  const children = (parentId) => chaptersCache.filter(c => c.parent === parentId);

  tree.innerHTML = roots.map(c => `
    <div class="chapter-node" onclick="selectChapter(${c.id})">
      <span class="chapter-icon">${emojiIcon(c.icon, 'hexagon')}</span>
      <span class="chapter-name">${escapeHtml(c.name)}</span>
      <span class="chapter-type ${escapeHtml(c.type)}">${escapeHtml(c.type)}</span>
      <span class="chapter-count">${c.members.toLocaleString()}</span>
    </div>
    ${children(c.id).map(sub => `
      <div class="chapter-node chapter-indent" onclick="selectChapter(${sub.id})">
        <span class="chapter-icon">${emojiIcon(sub.icon, 'hexagon')}</span>
        <span class="chapter-name">${escapeHtml(sub.name)}</span>
        <span class="chapter-type ${escapeHtml(sub.type)}">${escapeHtml(sub.type)}</span>
        <span class="chapter-count">${sub.members.toLocaleString()}</span>
      </div>
    `).join('')}
  `).join('');

  if (chaptersCache.length > 0) selectChapter(chaptersCache[chaptersCache.length - 1].id);
}
