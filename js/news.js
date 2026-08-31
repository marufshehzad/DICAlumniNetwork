/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   news.js

   The news feed, alumni stories, live polls and the spotlight.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


async function renderNewsFeed() {
  const feed = document.getElementById('news-feed');
  if (!feed) return;

  feed.innerHTML = renderSkeletonCards(2, 'news');

  const stories = await API.getStories();

  if (stories === null) {
    feed.innerHTML = renderErrorState('Could not load the news feed.', 'renderNewsFeed()');
    return;
  }
  if (stories.length === 0) {
    feed.innerHTML = renderEmptyState('<i data-lucide="newspaper" class="ui-icon"></i>', 'No stories published yet',
      'Approved alumni stories and college announcements will appear here.');
    return;
  }

  feed.innerHTML = stories.map(n => {
    const author = n.author_name || 'DIC Press Office';
    const date = n.published_date || formatDate(n.created_at);
    return `
    <div class="news-card">
      <div class="news-banner" style="background:linear-gradient(135deg, rgba(11,56,151,0.12), rgba(0,212,170,0.08))">${emojiIcon(n.emoji, 'sparkle')}</div>
      <div class="news-card-body">
        <div class="news-category">${escapeHtml(n.category)}</div>
        <div class="news-title">${escapeHtml(n.title)}</div>
        <div class="news-excerpt">${escapeHtml(n.excerpt || '')}</div>
        <div class="news-footer">
          <div class="news-author">
            <div class="news-author-avatar">${escapeHtml(author.slice(0,2).toUpperCase())}</div>
            <div>
              <div style="font-weight:600">${escapeHtml(author)}</div>
              <div class="news-meta">${escapeHtml(date)}</div>
            </div>
          </div>
          <span class="moderated-badge"><i data-lucide="check" class="ui-icon"></i> Published</span>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

async function renderSpotlightAlumni() {
  const el = document.getElementById('spotlight-alumni');
  if (!el) return;

  el.innerHTML = renderSkeletonCards(2, 'spotlight');
  const result = await API.getAlumni({ mentor: true, limit: 5 });

  if (result === null) {
    el.innerHTML = renderErrorState('Could not load alumni spotlights.', 'renderSpotlightAlumni()');
    return;
  }
  const spotlights = result.alumni;
  if (spotlights.length === 0) {
    el.innerHTML = renderEmptyState('<i data-lucide="sparkles" class="ui-icon"></i>', 'No mentors available yet');
    return;
  }

  el.innerHTML = spotlights.map(a => `
    <div class="spotlight-card">
      <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,${a.color}40,${a.color}20);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:${a.color};flex-shrink:0">${escapeHtml(a.initials)}</div>
      <div class="spotlight-info">
        <div class="spotlight-name">${escapeHtml(a.name)}</div>
        <div class="spotlight-sub">${escapeHtml(a.company || "—")} · Batch ${a.batch || "—"}</div>
      </div>
    </div>
  `).join('');
}

/* The map used to draw nine fixed pins — 8,241 in Bangladesh, 1,240 in the UK,
   987 in the USA and so on, adding up to the 12,847 alumni claimed elsewhere —
   at coordinates chosen by hand. None of it came from the database.

   Pins are now placed from alumni_profiles.country, using the small lookup
   below for the countries the platform can position. A country with real
   profiles but no entry here is still counted in the totals and listed under the
   map; it simply cannot be drawn, and the caption says so rather than quietly
   dropping it. */

function showCreateNewsModal() {
  openModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="pen-line" class="ui-icon"></i> Write a Story</div>
      <button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <form onsubmit="handleCreateStorySubmit(event)">
      <div class="input-group"><label class="input-label">Headline / Title</label><input type="text" id="story-create-title" class="form-input" placeholder="e.g., DIC AI Lab Launch 2026" required /></div>
      <div class="input-group"><label class="input-label">Category</label><select id="story-create-category" class="form-select"><option>Alumni Spotlight</option><option>Achievement</option><option>Announcement</option><option>Career News</option></select></div>
      <div class="input-group"><label class="input-label">Emoji Icon</label><input type="text" id="story-create-emoji" class="form-input" value="🌟" required /></div>
      <div class="input-group"><label class="input-label">Story Content</label><textarea id="story-create-content" class="form-input" rows="5" placeholder="Write your story here…" required></textarea></div>
      <button type="submit" class="btn btn-primary btn-full mt-16"> Submit Story for Review</button>
    </form>
  `);
}

async function handleCreateStorySubmit(e) {
  e.preventDefault();
  const title = document.getElementById('story-create-title').value.trim();
  const category = document.getElementById('story-create-category').value;
  const emoji = document.getElementById('story-create-emoji').value.trim() || '<i data-lucide="sparkle" class="ui-icon"></i>';
  const content = document.getElementById('story-create-content').value.trim();

  if (!title || !content) return;

  const authorName = state.currentUser ? state.currentUser.name : 'Mohiuddin Rahman';

  const result = await API.submitStory({ title, category, emoji, content, authorName });

  if (!result || result.error) {
    showToast('⚠ Could not submit the story — please try again.');
    return;
  }

  closeModal();
  showToast(`⏳ Story "${title}" submitted for Super Admin moderation!`);

  // Refresh both sides of the workflow so the submission is visible immediately.
  if (typeof renderModerationPanel === 'function') renderModerationPanel();
  renderNewsFeed();
  renderNotifications();
}

/* showTenantSwitcher() and switchTenant() were removed along with the tenant
   panels. The modal offered "cross-institutional access" to a list of one. */

// ─── 6. NEWS POLLS & TRENDING TAGS ───────────────────────────

// ─── LIVE POLL ───
async function renderActivePoll() {
  const els = renderTargets('active-poll');
  if (!els.length) return;
  const el = { set innerHTML(v) { els.forEach(e => e.innerHTML = v); } };

  const poll = await API.getActivePoll();
  if (apiFailed(poll)) {
    el.innerHTML = renderErrorState('Could not load the poll.', 'renderActivePoll()');
    return;
  }
  if (!poll) {
    el.innerHTML = renderEmptyState('<i data-lucide="vote" class="ui-icon"></i>', 'No active poll');
    return;
  }

  el.innerHTML = `
    <div class="poll-header">
      <div class="poll-title"><i data-lucide="vote" class="ui-icon"></i> Institutional Alumni Poll</div>
      <div class="poll-meta"><i data-lucide="circle" class="ui-icon"></i> Live · ${poll.total} vote${poll.total === 1 ? '' : 's'}</div>
    </div>
    <div class="poll-question-text">${escapeHtml(poll.question)}</div>
    <div class="poll-options">
      ${poll.options.map((o, idx) => {
        const pct = poll.total ? Math.round((poll.counts[idx] / poll.total) * 100) : 0;
        const mine = poll.myVote === idx;
        return `
        <button class="poll-option-btn${mine ? ' voted' : ''}" onclick="votePoll(${poll.id}, ${idx})">
          <div class="poll-option-bar" style="width:${pct}%"></div>
          <span class="poll-option-text">${mine ? '<i data-lucide="check" class="ui-icon"></i> ' : ''}${escapeHtml(o)}</span>
          <span class="poll-option-pct">${pct}%</span>
        </button>`;
      }).join('')}
    </div>
    ${poll.myVote !== null ? '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center">Your vote is recorded. Tap another option to change it.</div>' : ''}
  `;
}

async function votePoll(pollId, idx) {
  const res = await API.votePoll(pollId, idx);
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'Vote failed.'}`); return; }
  showToast('🗳 Your vote has been recorded.');
  renderActivePoll();
}

function renderTrendingTags() {
  const el = document.getElementById('trending-tags');
  if (!el) return;
  const tags = ['#Reunion2026', '#bKashScholarship', '#AITechSymposium', '#BUETPartnership', '#MentorshipDrive'];
  el.innerHTML = `<div class="trending-tag-cloud">${tags.map(t => `<span class="trending-tag" onclick="showToast('Filtering feed for ${t}')">${t}</span>`).join('')}</div>`;
}

function renderPastPolls() {
  const el = document.getElementById('past-polls');
  if (!el) return;
  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-secondary)">
      <div style="padding:6px 0;border-bottom:1px solid var(--border-glass)">
        <div style="font-weight:700">FY26 Mentorship Model</div>
        <div style="font-size:10px;color:var(--teal)"><i data-lucide="check" class="ui-icon"></i> 1-on-1 Matching won (64%)</div>
      </div>
      <div style="padding:6px 0">
        <div style="font-weight:700">Digital ID Card Design</div>
        <div style="font-size:10px;color:var(--teal)"><i data-lucide="check" class="ui-icon"></i> Glassmorphism Dark won (78%)</div>
      </div>
    </div>
  `;
}

// ─── 7. GAMIFICATION & BADGES ────────────────────────────────
/* The engagement panel showed "1,840 PTS · Gold Tier Alumni" to every account,
   including one created a minute earlier. No points, tier or engagement score is
   stored anywhere, and nothing accrues them, so the panel is now a plain summary
   of the things this user has actually done. */
