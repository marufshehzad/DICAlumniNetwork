/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   operations.js

   The operations panel. Deliberately small: it answers the four questions an
   administrator actually asks — is the platform up, did last night's jobs run,
   is there a recent backup, can the system send email — and stops there.

   It is not the monitoring system. The external probe watching /api/health is,
   and OPERATIONS_RUNBOOK.md says so. This screen exists because "is the
   scheduler working?" should not require SSH access.

   Loaded only by admin.html; ADMIN_ROLES only, enforced by the server.
   ============================================================ */

const OPS_JOB_LABEL = {
  'event-maintenance': 'Event maintenance',
  'deletion-purge': 'Account deletion purge',
  'mentorship-expiry': 'Mentorship expiry'
};

function opsAgo(ts) {
  if (!ts) return 'never';
  return typeof formatRelativeTime === 'function' ? formatRelativeTime(ts)
                                                  : new Date(ts).toLocaleString('en-GB');
}

function opsPill(tone, text) {
  return `<span class="card-badge ${tone}">${escapeHtml(text)}</span>`;
}

async function renderOperationsPanel() {
  const el = document.getElementById('ops-panel');
  if (!el) return;

  el.innerHTML = renderSkeletonCards(2, 'ops');
  const s = await API.getOpsStatus();

  if (apiFailed(s)) {
    el.innerHTML = renderErrorState(s?.error || 'Could not read operational status.',
      'renderOperationsPanel()');
    return;
  }

  const isSuper = state.currentUser && state.currentUser.role === 'super_admin';

  /* ── scheduled jobs ── */
  const jobRows = (s.jobs || []).map(j => {
    const label = OPS_JOB_LABEL[j.name] || j.name;
    let tone = '', text = j.status;
    if (j.status === 'ok') { tone = 'teal'; text = 'ok'; }
    else if (j.status === 'failed') { tone = 'red'; text = 'failed'; }
    else if (j.status === 'never run') { tone = 'amber'; text = 'never run'; }

    /* A job that has not run for more than a day is as much of a problem as
       one that failed, and it fails silently — so it is called out. */
    const stale = j.started_at && (Date.now() - new Date(j.started_at).getTime()) > 36 * 3600000;

    return `<div class="broadcast-entry">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px">${escapeHtml(label)}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(j.detail || '—')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          last run ${escapeHtml(opsAgo(j.started_at))}${j.source ? ' · ' + escapeHtml(j.source) : ''}${j.items ? ' · ' + j.items + ' item(s)' : ''}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
        ${opsPill(stale && j.status === 'ok' ? 'amber' : tone, stale && j.status === 'ok' ? 'stale' : text)}
        ${isSuper ? `<button class="btn btn-ghost btn-sm" onclick="opsRunJob('${escapeHtml(j.name)}')">
          <i data-lucide="play" class="ui-icon"></i> Run now</button>` : ''}
      </div>
    </div>`;
  }).join('');

  /* ── backup ── */
  const b = s.backup || { known: false };
  const backupCard = !b.known
    ? `<div class="login-note" style="display:block">
         <strong>No backup has been recorded.</strong> Either the nightly backup has never run,
         or it writes somewhere this application cannot see. See OPERATIONS_RUNBOOK.md section 5.
       </div>`
    : `<div class="broadcast-entry">
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">Last database backup</div>
          <div style="font-size:12px;color:var(--text-secondary)">
            ${escapeHtml(opsAgo(b.finishedAt))}${b.sizeBytes ? ' · ' + Math.round(b.sizeBytes / 1024) + ' KB' : ''}
          </div>
        </div>
        <div>${opsPill(b.status !== 'ok' ? 'red' : (b.stale ? 'amber' : 'teal'),
                       b.status !== 'ok' ? 'failed' : (b.stale ? 'stale' : 'ok'))}</div>
      </div>`;

  /* ── email ── */
  const m = s.mail || {};
  const mailTone = m.mode === 'smtp' && m.ready ? 'teal' : 'amber';
  const mailText = m.mode === 'smtp' ? (m.ready ? 'sending' : 'not configured')
                 : m.mode === 'console' ? 'development — not sending'
                 : 'disabled by configuration';

  /* ── deletions ── */
  const d = s.deletions || { pending: 0, overdue: 0 };

  el.innerHTML = `
    <div class="glass-card">
      <div class="card-header"><h3 class="card-title"><i data-lucide="timer" class="ui-icon"></i> Scheduled jobs</h3></div>
      ${s.scheduler && s.scheduler.configured ? '' :
        `<div class="login-note" style="display:block;margin-bottom:10px">
           <strong>No scheduler credential is configured.</strong> Nothing can trigger these jobs,
           which means the account-deletion purge is not running. Set CRON_SECRET.
         </div>`}
      ${jobRows || renderEmptyState('<i data-lucide="timer" class="ui-icon"></i>', 'No jobs have run yet',
        'Scheduled jobs record every run here.')}
      ${s.recentFailures ? `<div class="login-note" style="display:block;margin-top:10px">
        ${s.recentFailures} job run(s) failed in the last 7 days.</div>` : ''}
    </div>

    <div class="glass-card mt-16">
      <div class="card-header"><h3 class="card-title"><i data-lucide="database-backup" class="ui-icon"></i> Backup</h3></div>
      ${backupCard}
    </div>

    <div class="glass-card mt-16">
      <div class="card-header"><h3 class="card-title"><i data-lucide="mail" class="ui-icon"></i> Email delivery</h3></div>
      <div class="broadcast-entry">
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">Password reset delivery</div>
          <div style="font-size:12px;color:var(--text-secondary)">
            ${m.mode === 'smtp' && m.host ? escapeHtml(m.host) : 'No SMTP server configured'}
          </div>
          ${m.mode !== 'smtp' ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">
            Reset links must be issued by an operator with server access
            (<code>node reset_link.js</code>).</div>` : ''}
        </div>
        <div>${opsPill(mailTone, mailText)}</div>
      </div>
    </div>

    <div class="glass-card mt-16">
      <div class="card-header"><h3 class="card-title"><i data-lucide="user-x" class="ui-icon"></i> Account deletions</h3></div>
      <div class="broadcast-entry">
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">${d.pending} request(s) in their grace period</div>
          <div style="font-size:12px;color:var(--text-secondary)">
            Accounts are erased 30 days after the request unless it is cancelled.
          </div>
        </div>
        <div>${d.overdue ? opsPill('red', d.overdue + ' overdue') : opsPill('teal', 'on schedule')}</div>
      </div>
      ${d.overdue ? `<div class="login-note" style="display:block;margin-top:10px">
        ${d.overdue} request(s) are past their purge date and still pending. The purge job is
        not running — this is a commitment the institution has already made to those people.</div>` : ''}
    </div>`;

  if (typeof refreshIcons === 'function') refreshIcons();
}

/* Super admin only, and the server enforces it. This exists for the morning
   after a failed run: an operator should not need a shell to retry a job. */
async function opsRunJob(name) {
  if (!confirm(`Run "${OPS_JOB_LABEL[name] || name}" now?`)) return;
  showToast('Running…');
  const res = await API.runOpsJob(name);
  if (apiFailed(res)) { showToast('⚠ ' + ((res && res.error) || 'The job failed.')); return; }
  showToast(`${OPS_JOB_LABEL[name] || name}: ${res.detail || 'done'}`);
  renderOperationsPanel();
}
