/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE — ALUMNI PLATFORM
   auth.js

   Sign-in, sign-up, session expiry, sign-out and the change-password flow.
   Identity comes only from the server: see the note in enterAuthenticatedApp.

   Split out of app.js. Loaded as a classic script in the order listed in
   index.html; all module files share one global scope.
   ============================================================ */


// ─── AUTHENTICATION ─────────────────────────────────────────
// The only way into the app is POST /api/auth/login with credentials the user
// types. The client never holds a password and never chooses a role.

function showLoginError(message) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function setLoginBusy(busy) {
  const btn = document.getElementById('login-submit-btn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Signing in…' : 'Sign In to DIC';
}

async function handleLoginSubmit(e) {
  if (e) e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  showLoginError('');
  setLoginBusy(true);
  const result = await API.login(email, password);
  setLoginBusy(false);

  if (!result || result.error) {
    showLoginError(result?.error || 'Sign in failed. Please try again.');
    return;
  }
  enterAuthenticatedApp(result.user);

  // Bulk-imported accounts share an initial password until it is replaced.
  // enterAuthenticatedApp() owns the forced-change flow; firing it here too
  // opened the modal twice.
}

/* The two instant-role-switch helpers that used to sit here were removed. Both
   signed in with the hardcoded administrator credentials above, so any visitor
   — or any alumnus from the browser console — could obtain a super_admin
   session. A user role is now whatever the server says it is on
   /api/auth/login and /api/auth/me, read from the users row on every request;
   changing it requires an administrator changing users.role. */

/* The admin portal admits staff only. An alumnus who reaches admin.<domain> —
   by link, bookmark or curiosity — is signed straight back out with an
   explanation rather than shown an empty shell. This is a courtesy, not the
   boundary: the server refuses every administrative endpoint for their token
   whatever page they are looking at. */
function portalRejects(user) {
  if (!isAdminPortal()) return null;
  if (!user.isStaff) {
    return 'This is the staff portal. Alumni sign in at the main site.';
  }
  return null;
}

function enterAuthenticatedApp(user) {
  const rejection = portalRejects(user);
  if (rejection) {
    API.logout();
    state.currentUser = null;
    showLoginScreen();
    showLoginError(rejection);
    return;
  }

  state.currentUser = user;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  updateUserUI();
  renderSidebarNav(user.role);
  initApp();

  /* An account still on an issued temporary password cannot use the portal
     until it chooses its own. The modal is non-dismissable, and the sidebar is
     hidden underneath it so there is nothing to click past it to. */
  if (user.mustChangePassword) {
    lockUntilPasswordChanged();
    return;
  }

  showToast(isAdminPortal()
    ? `Signed in as ${user.name} — ${user.designation || user.roleLabel}`
    : `🎉 Welcome to DIC Portal, ${user.name} (${user.roleLabel})`);
}

/* Blocks every screen until the password is replaced. showChangePasswordModal
   already refuses to close when called with forced=true; this additionally
   hides the navigation so no screen is reachable behind it, and re-opens the
   modal if anything does manage to dismiss it. */
function lockUntilPasswordChanged() {
  document.body.classList.add('password-change-required');
  const reopen = () => {
    if (!document.body.classList.contains('password-change-required')) return;
    if (document.getElementById('modal-overlay')?.classList.contains('hidden')) {
      showChangePasswordModal(true);
    }
  };
  showChangePasswordModal(true);
  window._pwGuard = setInterval(reopen, 400);
}

// Called by handleChangePassword() once the server has accepted the new one.
function releasePasswordLock() {
  document.body.classList.remove('password-change-required');
  if (window._pwGuard) { clearInterval(window._pwGuard); window._pwGuard = null; }
  if (state.currentUser) state.currentUser.mustChangePassword = false;
}

/* ─── PASSWORD RECOVERY ─────────────────────────────────────
   Two screens on the sign-in page: asking for a link, and setting a new password
   once you have one. A super admin has nobody above them to click "Reset
   password", so without this a forgotten password meant server access. */

function showForgotPassword() {
  showLoginError('');
  const panel = document.getElementById('auth-panel-signin');
  const forgot = document.getElementById('auth-panel-forgot');
  if (panel) panel.classList.add('hidden');
  if (forgot) forgot.classList.remove('hidden');
  const msg = document.getElementById('forgot-message');
  if (msg) msg.classList.add('hidden');
  const email = document.getElementById('forgot-email');
  if (email) email.value = document.getElementById('login-email')?.value || '';
}

function hideForgotPassword() {
  document.getElementById('auth-panel-forgot')?.classList.add('hidden');
  document.getElementById('auth-panel-reset')?.classList.add('hidden');
  document.getElementById('auth-panel-signin')?.classList.remove('hidden');
}

async function handleForgotSubmit(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('forgot-submit-btn');
  const msg = document.getElementById('forgot-message');
  const email = document.getElementById('forgot-email').value.trim();

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const res = await API.forgotPassword(email);
  if (btn) { btn.disabled = false; btn.textContent = 'Send reset link'; }

  /* The same message either way. The server answers identically whether or not
     the address exists, and the interface must not undo that by rendering a
     different string — these are the institution's administrator addresses. */
  if (msg) {
    msg.textContent = res?.message ||
      'If that address belongs to an account, a reset link has been issued. It expires in 30 minutes.';
    msg.classList.remove('hidden');
  }
}

/* Opens the set-a-new-password screen when the page is loaded with ?reset=<token>.
   The token is removed from the address bar immediately so it does not sit in
   history, get bookmarked, or leak through a Referer header. */
function checkForResetToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('reset');
  if (!token) return;

  history.replaceState(null, '', window.location.pathname);

  document.getElementById('auth-panel-signin')?.classList.add('hidden');
  document.getElementById('auth-panel-forgot')?.classList.add('hidden');
  const panel = document.getElementById('auth-panel-reset');
  if (panel) {
    panel.classList.remove('hidden');
    panel.dataset.token = token;
  }
}

async function handleResetSubmit(e) {
  if (e) e.preventDefault();
  const panel = document.getElementById('auth-panel-reset');
  const err = document.getElementById('reset-error');
  const pw = document.getElementById('reset-password').value;
  const pw2 = document.getElementById('reset-password2').value;

  const fail = (m) => { if (err) { err.textContent = m; err.classList.remove('hidden'); } };
  if (pw !== pw2) return fail('The two passwords do not match.');
  if (pw.length < 8) return fail('Password must be at least 8 characters.');

  const res = await API.resetPassword(panel.dataset.token, pw);
  if (apiFailed(res)) return fail(res?.error || 'Could not reset the password.');

  // The token is spent and every old session is dead; the only way on is a
  // fresh sign-in.
  delete panel.dataset.token;
  hideForgotPassword();
  showLoginError('');
  showToast('✅ Password updated. Please sign in.');
}

function showLoginScreen() {
  const mainApp = document.getElementById('main-app');
  const loginScreen = document.getElementById('login-screen');
  if (mainApp) mainApp.classList.add('hidden');
  if (loginScreen) loginScreen.classList.remove('hidden');
}

// Called by api.js when the server rejects a stored token.
// Called from core.js at boot, before anything else touches the login screen.
function initAuthScreen() {
  checkForResetToken();
}

function onSessionExpired() {
  API.logout();
  state.currentUser = null;
  showLoginScreen();
  showLoginError('Your session expired. Please sign in again.');
}

// ─── LOGIN FLOW ─────────────────────────────────────────────
function goToStep2() {
  document.getElementById('step-1').classList.add('hidden');
  document.getElementById('step-2').classList.remove('hidden');
}

function goToStep1() {
  document.getElementById('step-2').classList.add('hidden');
  document.getElementById('step-1').classList.remove('hidden');
}

function goToStep3() {
  document.getElementById('step-2').classList.add('hidden');
  document.getElementById('step-3').classList.remove('hidden');

  setTimeout(() => {
    document.querySelector('.sis-match-animation').style.display = 'none';
    document.getElementById('sis-result').style.display = 'flex';
    document.getElementById('continue-btn').classList.remove('hidden');
  }, 2000);
}

function logout() {
  // Drop the session token first — otherwise "signing out" left a valid
  // credential in localStorage that the next page load silently reused.
  API.logout();
  // Otherwise the forced-change guard keeps re-opening its modal over the
  // login screen.
  releasePasswordLock();
  state.currentUser = null;
  showLoginError('');

  const mainApp = document.getElementById('main-app');
  const loginScreen = document.getElementById('login-screen');
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');
  const step3 = document.getElementById('step-3');
  const sisResult = document.getElementById('sis-result');
  const continueBtn = document.getElementById('continue-btn');
  const sisAnim = document.querySelector('.sis-match-animation');

  if (mainApp) mainApp.classList.add('hidden');
  if (loginScreen) loginScreen.classList.remove('hidden');
  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');
  if (step3) step3.classList.add('hidden');
  if (sisResult) sisResult.style.display = 'none';
  if (continueBtn) continueBtn.classList.add('hidden');
  if (sisAnim) sisAnim.style.display = 'none';
}

function switchAuthMode(mode) {
  const signin = document.getElementById('auth-panel-signin');
  const signup = document.getElementById('auth-panel-signup');
  const tabIn = document.getElementById('auth-tab-signin');
  const tabUp = document.getElementById('auth-tab-signup');
  if (!signin || !signup) return;

  const isSignup = mode === 'signup';
  signup.classList.toggle('hidden', !isSignup);
  signin.classList.toggle('hidden', isSignup);
  tabUp.classList.toggle('active', isSignup);
  tabIn.classList.toggle('active', !isSignup);

  showLoginError('');
  showSignupError('');
}

function showSignupError(message) {
  const el = document.getElementById('signup-error');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function handleSignupSubmit(e) {
  if (e) e.preventDefault();

  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-password2').value;

  showSignupError('');

  if (password !== confirm) { showSignupError('The two passwords do not match.'); return; }
  if (password.length < 8) { showSignupError('Password must be at least 8 characters.'); return; }
  if (!document.getElementById('signup-consent').checked) {
    showSignupError('Please accept the data processing consent to continue.');
    return;
  }

  const btn = document.getElementById('signup-submit-btn');
  btn.disabled = true; btn.textContent = 'Creating your account…';

  const result = await API.register({
    name, email, password,
    hscPassingYear: document.getElementById('signup-hsc-year').value,
    hscGroup: document.getElementById('signup-hsc-group').value,
    mobile: document.getElementById('signup-mobile').value.trim(),
    bloodGroup: document.getElementById('signup-blood-group').value
  });

  btn.disabled = false; btn.textContent = 'Create Account';

  if (!result || result.error) { showSignupError(result?.error || 'Registration failed.'); return; }

  // Consent is logged server-side with IP and policy version (PDPA 2026).
  await API.recordConsent({ consentType: 'data_processing', granted: true });

  enterAuthenticatedApp(result.user);
  showToast('🎓 Account created. An administrator will verify your alumni status shortly.');
}

// Prompts users still on an issued temporary password to replace it.
function showChangePasswordModal(forced = false) {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="key" class="ui-icon"></i> ${forced ? 'Set a New Password' : 'Change Password'}</div>
      ${forced ? '' : '<button type="button" class="modal-close" aria-label="Close"><i data-lucide="x" class="ui-icon"></i></button>'}
    </div>
    ${forced ? `<p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">
      Your account still uses the temporary password it was issued.
      Please choose your own before continuing.</p>` : ''}
    <form onsubmit="handleChangePassword(event)">
      <div class="input-group">
        <label class="input-label" for="cp-current">Current Password</label>
        <input type="password" id="cp-current" class="form-input" autocomplete="current-password" required />
      </div>
      <div class="input-group">
        <label class="input-label" for="cp-new">New Password</label>
        <input type="password" id="cp-new" class="form-input" autocomplete="new-password" minlength="8" required />
      </div>
      <div class="input-group">
        <label class="input-label" for="cp-new2">Confirm New Password</label>
        <input type="password" id="cp-new2" class="form-input" autocomplete="new-password" minlength="8" required />
      </div>
      <div class="login-error hidden" id="cp-error" role="alert"></div>
      <button type="submit" class="btn btn-primary btn-full">Update Password</button>
    </form>
  `);
}

async function handleChangePassword(e) {
  if (e) e.preventDefault();
  const cur = document.getElementById('cp-current').value;
  const nw = document.getElementById('cp-new').value;
  const nw2 = document.getElementById('cp-new2').value;
  const err = document.getElementById('cp-error');

  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  if (nw !== nw2) return fail('The two passwords do not match.');
  if (nw.length < 8) return fail('Password must be at least 8 characters.');

  const res = await API.changePassword(cur, nw);
  if (apiFailed(res)) return fail(res?.error || 'Could not update the password.');

  /* The server bumped token_version, which revoked every session opened under
     the old password — including this browser's. It returns a replacement, so
     adopt it rather than signing the user out of the change they just made. */
  if (res.token) setSessionToken(res.token);

  closeModal();
  releasePasswordLock();
  showToast('✅ Password updated.');
}

/* ============================================================
   PROFILE EDITOR — includes the fields added for the reunion CSV:
   Blood Group, Occupation, Current Organization / Institution,
   Current Designation, HSC Passing Year / Group / Version.
   ============================================================ */
