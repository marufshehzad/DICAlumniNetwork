/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE (DIC) ALUMNI PLATFORM
   Production-Ready Express REST API Server Powered by PostgreSQL
   ============================================================ */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');
const jobs = require('./jobs');
const privacy = require('./privacy');
const scope = require('./scope');       // one definition of department scope
const photos = require('./photos');     // profile photo storage and processing
const location = require('./location');
const path = require('path');
const fs = require('fs');

const app = express();
/* Express advertises itself in X-Powered-By on every response. It tells an
   attacker which framework's advisories to try and tells a legitimate caller
   nothing. */
app.disable('x-powered-by');
const PORT = process.env.PORT || 8000;

/* How many reverse proxies sit in front of this process.

   Behind Vercel or nginx the socket address is the proxy's, and trusting one
   hop makes req.ip the real client — which the login throttle and the audit
   trail both need. But a numeric trust-proxy value is a hop COUNT, not an
   address allow-list: proxy-addr compiles `1` to "trust the peer,
   unconditionally". With nothing actually in front, the peer IS the attacker,
   so X-Forwarded-For becomes theirs to choose.

   This was hardcoded to 1 until Phase 5F, and measured: 32 wrong passwords
   against one account with a rotating forged X-Forwarded-For produced zero 429s
   — the per-IP and per-account throttles were both evaded, and the forged value
   is what the audit trail recorded. Behind the nginx configuration the runbook
   specifies it is not exploitable, because $proxy_add_x_forwarded_for appends
   the real peer last; with the port exposed directly, it is.

   So the topology is now declared rather than assumed. Unset means no proxy,
   which is the safe default: req.ip becomes the socket address, forgeable by
   nobody. Set TRUST_PROXY to the number of hops you actually have. */
const TRUST_PROXY = (() => {
  const raw = String(process.env.TRUST_PROXY || '').trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;                       // an address or CIDR list, per Express
})();
app.set('trust proxy', TRUST_PROXY);

/* CORS.

   Today both portals are served from this origin, so no cross-origin request is
   made at all and this middleware never fires. It matters the moment
   admin.<domain> is pointed at this deployment: set PUBLIC_ORIGIN and
   ADMIN_ORIGIN and only those two are allowed. With neither set the previous
   wildcard behaviour is kept, so nothing breaks in development.

   Credentials are deliberately not enabled. The session is a bearer token in an
   Authorization header, never a cookie, so there is nothing for the browser to
   attach automatically and no CSRF surface to defend. */
const ALLOWED_ORIGINS = [process.env.PUBLIC_ORIGIN, process.env.ADMIN_ORIGIN]
  .filter(Boolean).map(o => o.trim().replace(/\/$/, '').toLowerCase());

app.use(cors(ALLOWED_ORIGINS.length ? {
  origin(origin, cb) {
    // A same-origin request has no Origin header; so do curl and server-to-server.
    if (!origin) return cb(null, true);
    cb(null, ALLOWED_ORIGINS.includes(origin.replace(/\/$/, '').toLowerCase()));
  },
  credentials: false
} : undefined));
/* Phase 7F. The default 100kb body limit is right for every route on this
   platform except one: a profile photo arrives as a base64 data URL, and 10 MB
   of image is about 13.4 MB of base64. Raising the limit globally would let any
   endpoint accept a 14 MB body, so the larger parser is mounted on the photo
   route ALONE and everything else keeps the small one.

   The size is still enforced twice more after this — once on the decoded byte
   length in photos.js, and once on the decoded image's dimensions — because a
   body limit only says how much arrived, not what it was. */
const jsonSmall = bodyParser.json();
const jsonPhoto = bodyParser.json({ limit: '14mb' });
app.use((req, res, next) =>
  (req.method === 'POST' && req.path === '/api/profile/photo')
    ? jsonPhoto(req, res, next)
    : jsonSmall(req, res, next));
/* Security headers, set here rather than only in vercel.json. Those are edge
   headers: they exist on Vercel and nowhere else, so running this behind nginx,
   a VPS or `node server.js` left the staff portal indexable and framable. Both
   layers now set them, and the values agree.

   wantsAdminPortal() is declared further down; it is only called at request
   time, by which point the module has finished evaluating. */
/* Phase 7E §26 — what the Content-Security-Policy actually protects.

   It is worth stating plainly, because frame-ancestors and script-src are
   different protections and a policy carrying only the first is easy to read as
   a policy that stops script injection. It does not.

     frame-ancestors   clickjacking. The staff portal refuses to be framed at
                       all; the alumni site may frame itself.
     object-src        plugin-based injection. <object> and <embed> are used
                       nowhere in either portal, so forbidding them outright
                       costs nothing and closes a vector that survives most
                       output escaping.
     base-uri          <base> tag injection, which silently re-points every
                       relative URL on the page — including the API calls. No
                       <base> tag exists in either portal.
     form-action       a form hijacked to post somewhere else. Every form in
                       this application submits through JavaScript to its own
                       origin and none declares an action attribute.

   script-src is deliberately ABSENT and is the known gap. The application uses
   inline event-handler attributes throughout, so any workable script-src would
   have to include 'unsafe-inline', which would leave the directive looking like
   a defence while providing almost none. Moving to delegated listeners is the
   prerequisite and it is an architecture change, not a header change. Recorded
   in FINAL_SECURITY_REVIEW_FOLLOWUPS.md and in RELEASE_CANDIDATE.md rather than
   half-done here. */
const CSP_COMMON = "object-src 'none'; base-uri 'self'; form-action 'self'";
const ADMIN_CSP  = `frame-ancestors 'none'; ${CSP_COMMON}`;
const PUBLIC_CSP = `frame-ancestors 'self'; ${CSP_COMMON}`;

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (wantsAdminPortal(req)) {
    // The staff portal must never be indexed, and must never be framed — the
    // one place on the platform where a clickjacked click provisions accounts.
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', ADMIN_CSP);
  } else {
    /* The alumni site is framed by nothing today but is allowed to frame itself.
       The CSP equivalent is set alongside the legacy header so this portal is
       not left with no Content-Security-Policy at all — which is what it had
       until Phase 5F, on the portal every stored-XSS finding of that phase was
       reachable from. A script-src directive is NOT possible yet: the
       application uses inline event-handler attributes throughout, and moving
       to delegated listeners is the prerequisite. Recorded in
       FINAL_SECURITY_REVIEW_FOLLOWUPS.md rather than half-done here. */
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Content-Security-Policy', PUBLIC_CSP);
  }
  next();
});

/* index:false so that a bare "/" falls through to the SPA handler at the bottom
   of this file rather than being answered here with index.html. Without it the
   static middleware served the alumni site for "/" on every host, so
   admin.<domain>/ landed on the alumni portal while admin.<domain>/anything-else
   correctly landed on the staff portal. Named files, /admin.html included, are
   still served directly. */
/* The repository root is the web root, which meant `express.static(__dirname)`
   served every file in it to anyone who asked — including `.env` (SESSION_SECRET
   and ENCRYPTION_KEY), `admin-credentials.local.txt` (the super admin's
   password), `db.js`, every `routes_*.js`, and the SQL schema. A single
   unauthenticated GET was a total takeover, and it also handed out the key that
   signs ticket QR codes and encrypts the identity vault.

   Static serving is now an allow-list. Only the files the two portals actually
   reference are reachable; anything else with a file extension is a 404 before
   it reaches express.static. Extensionless paths fall through to the SPA
   handler at the bottom of this file, which is what routes /directory, /admin
   and friends. */
const PUBLIC_FILES = new Set([
  '/index.html', '/admin.html', '/styles.css', '/api.js', '/manifest.json',
  '/dic.png', '/dics.png', '/favicon.ico'
]);
const PUBLIC_DIRS = ['/js/', '/assets/'];

app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return res.status(400).type('text/plain').send('Bad request'); }

  if (p.startsWith('/api/')) return next();
  if (p.includes('..')) return res.status(404).type('text/plain').send('Not found');
  // A dotfile is never a page. path.extname('/.env') is '', so without this it
  // would fall through to the SPA handler and answer 200 with the app shell.
  if (p.split('/').some(seg => seg.startsWith('.') && seg.length > 1)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  /* Directories that must never resolve to anything, extension or not. Without
     this, "/backups/" has no extension, so it falls through to the SPA handler
     and answers 200 with the application shell — harmless in itself, but a
     path under the backup directory should say "no such thing", not hand back
     a page that implies something is there. */
  if (/^\/(backups|node_modules|ops|uploads|api\/index)\b/i.test(p)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  if (!path.extname(p)) return next();          // SPA route, not a file request

  const allowed = PUBLIC_FILES.has(p) ||
    /* Phase 7G added assets/geo/boundaries.json — static Natural Earth country
       outlines, public-domain reference geometry and not personal data. json is
       allowed only under the already-public /assets/ and /js/ prefixes, so this
       does not widen what else is reachable. */
    (PUBLIC_DIRS.some(d => p.startsWith(d)) && /\.(js|css|json|png|jpe?g|svg|webp|gif|ico|woff2?)$/i.test(p));
  if (!allowed) return res.status(404).type('text/plain').send('Not found');
  next();
});

app.use(express.static(__dirname, { index: false, dotfiles: 'deny' }));

/* ─── REQUEST LOG ───────────────────────────────────────────
   The platform logged almost nothing, so "the site was slow at 10am" or "a
   member says saving failed yesterday" had no evidence behind it. One line per
   API request, structured enough to grep and narrow enough to be safe.

   What is deliberately absent: the request body (it carries passwords and
   reset tokens), the Authorization header (it carries the session token), and
   query strings (a reset link arrives as ?reset=<token>). The correlation id
   goes out on the response so an operator can match a user's screenshot to a
   log line without either party quoting anything sensitive. */
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  const id = crypto.randomBytes(6).toString('hex');
  req.correlationId = id;
  res.setHeader('X-Request-Id', id);
  const started = Date.now();

  res.on('finish', () => {
    // Path only — never req.originalUrl, which would include the query string.
    const line = [
      new Date().toISOString(),
      id,
      req.method,
      req.path,
      res.statusCode,
      (Date.now() - started) + 'ms',
      req.user ? 'uid=' + req.user.uid : 'anon'
    ].join(' ');
    if (res.statusCode >= 500) console.error('[api] ' + line);
    else if (res.statusCode >= 400) console.warn('[api] ' + line);
    else if (process.env.LOG_REQUESTS === 'all') console.log('[api] ' + line);
  });
  next();
});

/* ============================================================
   AUTHENTICATION — password hashing, signed sessions, RBAC
   ============================================================ */

/* Production must not boot on improvised secrets. Development keeps its
   conveniences — an ephemeral session secret, a disabled vault — because
   neither can reach real data there. In production both are load-bearing:
   an ephemeral SESSION_SECRET silently signs out every user on each restart
   (and on every serverless cold start), and a missing ENCRYPTION_KEY disables
   the identity vault and, since this release, ticketing as well. Failing at
   boot with a named cause beats discovering either at 2am.

   This throws rather than calling process.exit so the reason is visible in a
   serverless function log instead of an opaque platform abort. */
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

if (IS_PRODUCTION) {
  const missing = [];
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY || '')) missing.push('ENCRYPTION_KEY (64 hex characters)');
  /* Without this the scheduler cannot authenticate, which means the 30-day
     deletion purge never runs. That is a promise the platform makes to every
     user who asks to be erased, so a deployment that cannot keep it should not
     start. */
  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
    missing.push('CRON_SECRET (32+ characters)');
  }
  /* Mail is required unless the operator has explicitly chosen to go without
     it and keep reset_link.js as the only recovery path. Silence is not
     consent: MAIL_TRANSPORT has to say so. */
  for (const v of mailer.missingMailConfig()) missing.push(v);

  /* PUBLIC_ORIGIN and ADMIN_ORIGIN are the entire CORS allow-list. With neither
     set, `cors(undefined)` is permissive and production answered every origin
     with `Access-Control-Allow-Origin: *` — verified. Bearer tokens live in a
     header rather than a cookie, so that is not classic CSRF, but it is a
     wildcard on a platform whose own documentation says these two variables
     are the allow-list, and a deployment that forgets them should not come up
     quietly permissive. They also decide which host resolves to the staff
     portal, so a production deployment needs them regardless. */
  if (!process.env.PUBLIC_ORIGIN) missing.push('PUBLIC_ORIGIN');
  if (!process.env.ADMIN_ORIGIN) missing.push('ADMIN_ORIGIN');

  /* Where the nightly dumps go. Backups are not an optional feature of a
     production deployment, so this is required rather than defaulted — and the
     default is the reason: it puts a full pg_dump of every alumnus's personal
     data inside the repository directory, which is also the web root. The
     static allow-list refuses to serve it, so this was never an exposure, but a
     dump belongs outside the application directory where a redeploy, a git
     clean or a future change to that allow-list cannot reach it.

     Rejected outright if it points inside the application directory, because
     the point is that it should not. */
  const backupDir = process.env.BACKUP_DIR;
  if (!backupDir) {
    missing.push('BACKUP_DIR (an absolute path outside the application directory)');
  } else {
    const resolved = path.resolve(backupDir);
    const appDir = path.resolve(__dirname);
    if (resolved === appDir || resolved.startsWith(appDir + path.sep)) {
      missing.push('BACKUP_DIR (it must not be inside the application directory)');
    }
  }
  if (missing.length) {
    // The names only — never the values, and never a partial value.
    throw new Error(
      `Refusing to start in production: required secret(s) missing or malformed: ${missing.join(', ')}. ` +
      'Set them in the environment. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠  SESSION_SECRET not set — using an ephemeral secret. ' +
               'Sessions will be invalidated on restart. Set SESSION_SECRET in .env for production.');
}
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Passwords are stored as `scrypt$<salt>$<derived>`. Seed rows still hold the
// legacy plaintext '12345678', so verifyPassword accepts those once and the
// login handler transparently re-hashes them.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  // A LOCKED$ sentinel is not a password and can never be matched. Seeded
  // accounts ship locked so a fresh database has no known default credential;
  // `node rotate_credentials.js` sets a real one.
  if (stored.startsWith('LOCKED$')) return false;
  if (!stored.startsWith('scrypt$')) {
    // Legacy plaintext row — constant-time compare, then caller upgrades it.
    const a = Buffer.from(String(plain));
    const b = Buffer.from(String(stored));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [, salt, expected] = stored.split('$');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function readToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/* Attaches req.user when a valid token is present; never rejects.

   The signed token carries the role that was current when it was issued, but
   that value is only a hint: the role used for every authorisation decision is
   re-read from the users row on each request. Two consequences that the
   previous token-only version got wrong — demoting a user took effect
   immediately rather than up to SESSION_TTL_MS later, and a deleted account's
   outstanding token stops working at once instead of staying valid until it
   expires. A user still cannot influence their own role: the token is
   HMAC-signed, and the column behind it is writable only by an administrator. */
async function attachUser(req, res, next) {
  const payload = verifyToken(readToken(req));
  if (!payload) { req.user = null; return next(); }

  try {
    const r = await db.query(
      `SELECT id, role, status, token_version, must_change_password, is_verified, department_id
         FROM users WHERE id = $1`,
      [payload.uid]);
    // Account deleted since the token was issued — the token is now inert.
    if (r.rows.length === 0) { req.user = null; return next(); }

    /* Session revocation. The token carries the version it was minted at; the
       row carries the current one. Bumping the column — on sign-out, password
       change, password reset or suspension — makes every token issued before
       the bump fail here, with no session table and no change to the token
       format. A token minted before this column existed carries no version and
       is treated as version 1, so no existing session breaks. */
    if ((payload.tv ?? 1) !== r.rows[0].token_version) {
      req.user = null;
      req.staleSession = true;
      return next();
    }

    /* Suspension takes effect on the next request, not when the token expires.
       Sessions are stateless bearer tokens with a 12-hour life, so without this
       check suspending an administrator would leave them working for the rest
       of the day. Reading status here costs nothing: the row is already being
       fetched for the role. */
    if (r.rows[0].status === 'suspended') {
      req.user = null;
      req.suspended = true;
      return next();
    }
    /* is_verified rides along on the row already being fetched, the same
       reasoning the status check above gives. It is read from the database
       rather than the token so revoking a verification takes effect on the
       next request instead of when the token expires. */
    /* department_id rides along on the row already being fetched, for the same
       reason is_verified does: a department reassignment must take effect on the
       next request, not when the token expires. It is deliberately NOT in the
       token — a scope a caller carries is a scope a caller can forge. */
    req.user = {
      ...payload,
      role: r.rows[0].role,
      verified: r.rows[0].is_verified === true,
      departmentId: r.rows[0].department_id === null ? null : Number(r.rows[0].department_id)
    };
    req.mustChangePassword = r.rows[0].must_change_password === true;
  } catch {
    // The database is unreachable. Fail closed rather than fall back to the
    // role asserted by the token.
    req.user = null;
  }
  next();
}
app.use(attachUser);

// A suspended account gets a distinct message so the holder knows to ask an
// administrator rather than retrying their password.
const SUSPENDED = { error: 'This account is suspended. Contact an administrator.' };

// A revoked session is not a permissions problem — the client should sign in
// again, which is exactly what api.js does with a 401.
const STALE = { error: 'This session has ended. Please sign in again.' };

/* Bulk import creates a whole batch of accounts sharing one initial password,
   which the administrator distributes to the roster. Until Phase 5F the
   must_change_password flag those accounts carry was advisory: the client
   prompted, and the token worked on all 63 authenticated routes regardless. So
   every recipient of that one password held a working credential for every
   other account in the batch — and most bulk-imported alumni never sign in, so
   the dormant ones stayed takeable indefinitely.

   The flag is now load-bearing. A session in this state may do exactly three
   things: read who it is, change the password, and sign out. That turns the
   shared batch password back into what the UI already claims it is — a
   one-time enrolment credential — without changing the operator's workflow. */
const ENROLMENT_ALLOWED_PATHS = new Set([
  '/api/auth/change-password', '/api/auth/me', '/api/auth/logout'
]);
const MUST_CHANGE = {
  error: 'This account must set its own password before it can be used.',
  mustChangePassword: true
};

function enrolmentBlocked(req) {
  return req.mustChangePassword === true && !ENROLMENT_ALLOWED_PATHS.has(req.path);
}

/* One unhandled-failure reply for the whole API.

   Every 500 used to return err.message verbatim, so any signed-in user could
   read PostgreSQL's own words back — `invalid input syntax for type integer:
   "NaN"`, column names, SQLSTATE. GET /api/alumni?batch=abc was enough to
   produce one. The message is now logged next to the correlation id that
   already goes out on X-Request-Id, so an operator can still find the exact
   failure from a screenshot without the error text ever reaching the browser. */
function serverError(res, err, tag) {
  const req = res.req || {};
  console.error(`[${tag}] ${req.correlationId || '-'} ${err && err.message}`);
  if (res.headersSent) return;
  res.status(500).json({
    error: 'Something went wrong handling that request.',
    requestId: req.correlationId || null
  });
}

/* Numeric route parameters, rejected before they reach the database.

   parseInt('abc') is NaN, node-pg sends it as the literal 'NaN', and PostgreSQL
   raises a type error — a 500 for what is really a malformed request. These
   names are integer primary keys everywhere they appear. `id` is the exception:
   custom_fields.id is a varchar key, so that one route keeps its string ids. */
function numericParam(name) {
  return (req, res, next, value) => {
    if (name === 'id' && req.path.startsWith('/api/custom-fields')) return next();
    if (!/^\d+$/.test(String(value))) {
      return res.status(400).json({ error: `Invalid ${name}` });
    }
    next();
  };
}
for (const p of ['id', 'userId', 'taskId', 'personId', 'ttId', 'eventId', 'itemId', 'vaultId']) {
  app.param(p, numericParam(p));
}

/* Actions that reach another member, commit the institution, or publish.
   See the Phase 7C-1 entry in PHASE_LOG.md for the policy and its reasoning.

   The message names the requirement and stops there: which administrator is
   reviewing, how long the queue is and why an account was not yet verified
   are all internal, and a rejected caller learning them is the leak this
   phrasing avoids. */
const VERIFICATION_REQUIRED = {
  error: 'Alumni verification is required for this action.',
  code: 'verification_required'
};

function requireVerified(req, res, next) {
  if (req.suspended) return res.status(403).json(SUSPENDED);
  if (req.staleSession) return res.status(401).json(STALE);
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (enrolmentBlocked(req)) return res.status(403).json(MUST_CHANGE);
  if (req.user.verified !== true) return res.status(403).json(VERIFICATION_REQUIRED);
  next();
}

function requireAuth(req, res, next) {
  if (req.suspended) return res.status(403).json(SUSPENDED);
  if (req.staleSession) return res.status(401).json(STALE);
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (enrolmentBlocked(req)) return res.status(403).json(MUST_CHANGE);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.suspended) return res.status(403).json(SUSPENDED);
    if (req.staleSession) return res.status(401).json(STALE);
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (enrolmentBlocked(req)) return res.status(403).json(MUST_CHANGE);
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }
    next();
  };
}

/* Three authorisation tiers, widest last. These constants are the only place
   permissions are defined: every guard spreads one of them, and
   GET /api/stats/rbac derives the displayed matrix from them, so the screen
   cannot disagree with the middleware.

   SUPER_ONLY separates platform authority from institutional authority. Before
   this, super_admin and univ_admin were interchangeable everywhere except
   /api/seed-db, so a college administrator could provision other
   administrators. Account provisioning and destructive platform operations are
   now super_admin only. */
const SUPER_ONLY = ['super_admin'];
const ADMIN_ROLES = ['super_admin', 'univ_admin'];
const MODERATOR_ROLES = ['super_admin', 'univ_admin', 'dept_admin', 'moderator'];

// Roles that belong to the institutional admin portal rather than the alumni
// site. Used by the portal gate and by the administrator directory.
const STAFF_ROLES = MODERATOR_ROLES;

// Initial credential for bulk-imported accounts. This used to be the constant
// '12345678', which was also the label of the only option in the wizard's
// dropdown in app.js — so the starting password of every imported alumnus was
// readable by anyone who opened the page source. It is now generated per import
// batch, returned once to the administrator who ran the import, and never
// stored in plaintext or written to a log. Every imported user is still flagged
// must_change_password.

/* A student id for an account the institution created for somebody, rather than
   one they told us. The obvious formula is DIC-<year>-<user id>, and it is what
   registration and bulk import have always used — unique, because the user id is.

   Except that alumni_profiles.student_id is UNIQUE across the whole table, and
   the seeded data occupies the same namespace: two seeded profiles carry
   DIC-2018-1001 and DIC-2018-1008 while belonging to users 7 and 14. Those were
   safe only while users.id stayed below 1001. Every rolled-back dry run burns
   ids without creating rows, so the sequence climbs faster than the table, and
   it reached 1046 during Phase 7D testing — at which point an ordinary import
   generated an id the seed already owned and the whole batch failed with a 500
   and a constraint name.

   So the formula is kept and the collision is handled: the id is checked, and a
   suffix is added if it is taken. In practice the first form is always free;
   this exists so that "in practice" is not load-bearing. */
async function uniqueStudentId(client, year, uid) {
  const base = year ? `DIC-${year}-${uid}` : `DIC-${uid}`;
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    const taken = await client.query(
      'SELECT 1 FROM alumni_profiles WHERE student_id = $1', [candidate]);
    if (!taken.rows.length) return candidate;
  }
  /* Fifty taken in a row means something is wrong that a suffix will not fix.
     A null student id is allowed by the schema and is honest about it. */
  return null;
}

function generateImportPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (const byte of crypto.randomBytes(48)) {
    if (byte < 232) { out += alphabet[byte % alphabet.length]; if (out.length === 12) break; }
  }
  return out;
}

// routes_v2 owns the hash-chained audit writer but is mounted after these
// routes are declared, so calls are routed through this late-bound shim.
let _writeAudit = null;
async function writeAuditSafe(action, meta, icon, ctx) {
  if (typeof _writeAudit === 'function') {
    try { await _writeAudit(action, meta, icon, ctx); } catch { /* audit must never break a request */ }
  }
}

// Shorthand for the common case: "this signed-in user did something to that
// record", with the client address, so an administrator action is attributable.
function auditCtx(req, targetType, targetId) {
  return { actorId: req.user?.uid ?? null, targetType, targetId, ip: clientIp(req) };
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.full_name,
    initials: row.initials,
    role: row.role,
    roleLabel: row.role_label,
    // Display title, deliberately separate from role: nothing authorises on it.
    designation: row.designation || null,
    dept: row.department,
    phone: row.phone || null,
    photoUrl: row.photo_url || null,
    status: row.status || 'active',
    icon: row.icon,
    verified: row.is_verified,
    // Carried on the user object rather than only alongside it, so a session
    // restored through /api/auth/me knows about it too — a page refresh used to
    // walk straight past the forced change.
    mustChangePassword: row.must_change_password === true,
    // Staff sign in at the admin portal; alumni at the main site. The client
    // uses this to refuse the wrong portal politely rather than showing an
    // empty shell.
    isStaff: STAFF_ROLES.includes(row.role)
  };
}

// ─── 1. HEALTH CHECK & CLOUD DB INITIALIZER ───
/* ─── HEALTH ────────────────────────────────────────────────
   A monitor needs a single unauthenticated URL that goes non-200 when the
   platform is actually broken, and reveals nothing when it is not.

   This used to answer with the database product and version, whether the
   deployment was cloud or local, and the exact number of user accounts — a
   free reconnaissance endpoint. It now reports liveness only. The detail an
   operator needs during an incident lives behind /api/ops/status, which
   requires an administrator session.

   The check is a real round trip to the database, not a process liveness
   ping: an app that cannot reach its database is down, however healthy the
   Node process feels. */
app.get('/api/health', async (req, res) => {
  const started = Date.now();
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'ok', latencyMs: Date.now() - started });
  } catch (err) {
    // The reason goes to the log for an operator; the caller is told only that
    // the dependency is down, in case the message carries connection detail.
    console.error('[health] database unreachable: ' + err.message);
    res.status(503).json({ status: 'degraded', database: 'unreachable' });
  }
});

// Destructive: re-runs schema + seed. Super admin only.
/* Destructive: re-runs the schema and re-seeds. Super admin only, and refused
   outright in production. A single mistaken click here would replace live
   alumni records with seed data, and no role is a good enough guard for that on
   a running deployment — so the environment decides, not the caller. Set
   ALLOW_DB_RESEED=true to override it deliberately on a staging box. */
app.post('/api/seed-db', requireRole(...SUPER_ONLY), async (req, res) => {
  const isProduction = IS_PRODUCTION;
  if (isProduction && process.env.ALLOW_DB_RESEED !== 'true') {
    await writeAuditSafe('Database Re-seed Refused',
      `blocked in production; requested by user ${req.user.uid}`, '🛑');
    return res.status(403).json({
      error: 'Re-seeding is disabled in production. Set ALLOW_DB_RESEED=true to override.'
    });
  }
  try {
    const result = await db.initDbSchemaAndSeed();
    await writeAuditSafe('Database Re-seeded', `by user ${req.user.uid}`, '⚠');
    res.json(result);
  } catch (err) {
    serverError(res, err, 'seed-db');
  }
});

/* ─── LOGIN THROTTLING ───
   Small in-process limiter for POST /api/auth/login. Two counters so neither
   attack shape works: repeated guesses at one account, and one guess sprayed
   across many accounts from the same address.

   Deployment note: this is per-process. Running `node server.js` that means
   one shared counter. On Vercel each warm lambda keeps its own, so a spread-out
   attacker gets `attempts x instances` before being locked — still a large
   reduction, but not a hard ceiling. A durable limit needs shared storage
   (a table or Redis); that is deliberately out of scope for this pass. */

const RL_MAX_PER_ACCOUNT = 5;        // failures against one email from one IP
const RL_MAX_PER_IP = 20;            // failures from one IP across any emails
const RL_WINDOW_MS = 15 * 60 * 1000; // rolling window
const RL_LOCK_MS = 15 * 60 * 1000;   // how long a tripped counter stays locked
const RL_MAX_ENTRIES = 10000;        // hard cap so the map cannot grow forever

const loginAttempts = new Map();     // key -> { count, first, lockedUntil }

function rlSweep(now) {
  for (const [key, rec] of loginAttempts) {
    const dead = (rec.lockedUntil && rec.lockedUntil <= now) ||
                 (!rec.lockedUntil && now - rec.first > RL_WINDOW_MS);
    if (dead) loginAttempts.delete(key);
  }
  // Still oversized (sustained distributed attack): drop the oldest entries.
  if (loginAttempts.size > RL_MAX_ENTRIES) {
    const excess = loginAttempts.size - RL_MAX_ENTRIES;
    let i = 0;
    for (const key of loginAttempts.keys()) {
      loginAttempts.delete(key);
      if (++i >= excess) break;
    }
  }
}

function clientIp(req) {
  // trust proxy is enabled, so req.ip already honours X-Forwarded-For.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/* Returns { limited: true, retryAfter } when the caller should be refused. */
function loginRateCheck(req, email) {
  const now = Date.now();
  rlSweep(now);

  const ip = clientIp(req);
  const keys = [
    { key: `a:${ip}:${String(email || '').toLowerCase()}`, max: RL_MAX_PER_ACCOUNT },
    { key: `i:${ip}`, max: RL_MAX_PER_IP }
  ];

  for (const { key } of keys) {
    const rec = loginAttempts.get(key);
    if (rec?.lockedUntil && rec.lockedUntil > now) {
      return { limited: true, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
    }
  }
  return { limited: false };
}

function loginRecordFailure(req, email) {
  const now = Date.now();
  const ip = clientIp(req);
  const targets = [
    { key: `a:${ip}:${String(email || '').toLowerCase()}`, max: RL_MAX_PER_ACCOUNT },
    { key: `i:${ip}`, max: RL_MAX_PER_IP }
  ];

  for (const { key, max } of targets) {
    let rec = loginAttempts.get(key);
    if (!rec || now - rec.first > RL_WINDOW_MS) rec = { count: 0, first: now, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= max) rec.lockedUntil = now + RL_LOCK_MS;
    loginAttempts.set(key, rec);
  }
}

function loginRecordSuccess(req, email) {
  const ip = clientIp(req);
  loginAttempts.delete(`a:${ip}:${String(email || '').toLowerCase()}`);
  loginAttempts.delete(`i:${ip}`);
}

// ─── 2. AUTHENTICATION ───
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Refuse before touching the database so a locked-out attacker costs nothing.
  const gate = loginRateCheck(req, email);
  if (gate.limited) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).json({
      error: 'Too many sign-in attempts. Please try again later.',
      retryAfter: gate.retryAfter
    });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);

    /* The durable lock is consulted BEFORE the password is compared.

       Until Phase 5F this check sat below verifyPassword, which made it useless
       in both directions. A guessing loop only ever produces wrong passwords,
       so it never reached the check — failed_login_count climbed past 400 and
       every attempt still got a full scrypt verification. Meanwhile the counter
       never decayed, so once an account was locked, one wrong guess every
       fifteen minutes re-armed the lock forever and the real owner could not
       sign in with the correct password. It denied service to the victim and
       throttled nobody.

       Answering identically for a locked account and an unknown address keeps
       the endpoint from confirming which addresses exist. */
    const locked = result.rows.length && result.rows[0].locked_until
                   && new Date(result.rows[0].locked_until) > new Date();
    if (locked) {
      loginRecordFailure(req, email);
      const retryAfter = Math.ceil((new Date(result.rows[0].locked_until) - Date.now()) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many sign-in attempts. Please try again later.', retryAfter
      });
    }

    // One generic message for both unknown-email and wrong-password so the
    // endpoint cannot be used to enumerate accounts. The previous version
    // returned a super_admin session for any unrecognised address.
    if (result.rows.length === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
      loginRecordFailure(req, email);
      /* The in-process limiter above is lost on restart and, on a serverless
         deployment, is per-instance. Counting failures on the row as well gives
         a lock that survives both. Only for an account that exists — counting
         against a missing address would leak which addresses are real.

         The lock is SET, never EXTENDED: once locked_until is in the future the
         branch above has already returned, so a persistent attacker cannot
         chain fifteen-minute windows into a permanent lockout. The window
         lapses on its own and the owner gets back in. */
      if (result.rows.length) {
        /* The counter restarts once a previous lock has lapsed. Left monotonic
           it stayed at or above the threshold forever, so every later failure
           immediately re-locked the account — which is the mechanism that made
           an indefinite lockout possible from four requests an hour. Reaching
           this line means no lock is live, so clearing locked_until in the ELSE
           branch cannot cut one short. */
        await db.query(`
          UPDATE users
             SET failed_login_count = next.n,
                 locked_until = CASE WHEN next.n >= $2
                                     THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
            FROM (SELECT CASE WHEN u.locked_until IS NOT NULL AND u.locked_until <= NOW()
                              THEN 1 ELSE u.failed_login_count + 1 END AS n
                    FROM users u WHERE u.id = $1) AS next
           WHERE users.id = $1`, [result.rows[0].id, RL_MAX_PER_ACCOUNT]);
      }
      /* Sign-in was the one privileged action the hash-chained log did not
         record. An institution investigating a compromised administrator
         account could see what that account DID and not one attempt to reach
         it — no failures, no successes, no source addresses. Recorded by user
         id where the account exists, never by the address typed, so a failed
         attempt against an unknown address cannot turn the audit log into the
         account-enumeration oracle the 401 above is careful not to be. */
      await writeAuditSafe('Sign-In Failed',
        result.rows.length ? `user ${result.rows[0].id}` : 'unknown account', '🔒',
        { actorId: result.rows.length ? result.rows[0].id : null,
          targetType: 'user',
          targetId: result.rows.length ? result.rows[0].id : null,
          ip: clientIp(req) });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    loginRecordSuccess(req, email);
    const row = result.rows[0];

    // A suspended account cannot sign in at all. Checking here as well as in
    // attachUser() means the holder gets a clear message instead of a session
    // that fails on its first real request.
    if (row.status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Contact an administrator.' });
    }
    /* The lock check that used to live here has moved above verifyPassword,
       where it can actually stop a guess. Nothing is left to check: a live lock
       has already returned 429 by this point. */

    // Transparently upgrade legacy plaintext rows on first successful login.
    if (!row.password_hash.startsWith('scrypt$')) {
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), row.id]);
    }

    // Nothing recorded a sign-in against the account before; the administrator
    // list needs it, and a stale last_login_at is how a dormant account is
    // spotted. The durable failure counters reset on the way through.
    await db.query(
      'UPDATE users SET last_login_at = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [row.id]);

    await writeAuditSafe('Signed In', `user ${row.id} (${row.role})`, '🔑',
      { actorId: row.id, targetType: 'user', targetId: row.id, ip: clientIp(req) });

    const user = publicUser(row);
    const token = signToken({
      uid: user.id, role: user.role,
      tv: row.token_version ?? 1,
      exp: Date.now() + SESSION_TTL_MS
    });

    // Bulk-imported accounts share an initial password; the client prompts for
    // a change when this is set.
    res.json({ token, user, mustChangePassword: row.must_change_password === true });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── SELF-REGISTRATION ───
// The app previously offered sign-in only, so an alumnus who was not bulk
// imported had no way to get an account.
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, hscPassingYear, hscGroup, mobile, bloodGroup } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'Full name is required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email address is required' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  /* alumni_profiles.batch and .passing_year are both NOT NULL, and this handler
     passed `parseInt(undefined) || null` straight into them — so signing up
     without an HSC year was a constraint violation surfacing as a 500. The form
     did not mark the field required either, so it was reachable by anyone who
     simply left it blank. Validated here rather than defaulted: a batch is the
     one thing that places an alumnus in the institution's records, and a guessed
     year is the same class of fabrication as the hardcoded 'Dhaka' Phase 5B
     removed. */
  const yearNum = parseInt(hscPassingYear, 10);
  if (!Number.isInteger(yearNum) || yearNum < 1960 || yearNum > 2100) {
    return res.status(400).json({ error: 'A valid HSC passing year is required (1960-2100)' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
    }

    const clean = name.trim();
    const initials = clean.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'AL';
    const year = yearNum;
    const group = normalizeHscGroup(hscGroup) || 'General';

    /* Phase 7D. Registration wrote the HSC group into users.department, exactly
       as the bulk import did — so a self-registered alumnus had a "department"
       of 'Science' and belonged to no department at all. No department
       administrator could verify their own graduates, which is the one thing a
       department administrator is for, and the scope would have decayed to
       nothing as new accounts arrived.

       A department is optional at sign-up: somebody who does not know theirs, or
       whose department this platform has not been told about, must still be able
       to register. When it is absent the account belongs to the institution and
       an institution-wide role verifies it — which is what happened to every
       account before this. */
    let regDepartment = null;
    if (req.body?.departmentId !== undefined && req.body.departmentId !== null && req.body.departmentId !== '') {
      const d = await client.query('SELECT id, name FROM departments WHERE id = $1 AND is_active',
        [parseInt(req.body.departmentId, 10)]);
      if (!d.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That department does not exist.' });
      }
      regDepartment = d.rows[0];
    }

    // Self-registered accounts start unverified — an admin verifies them before
    // they are treated as confirmed alumni.
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, full_name, initials, role, role_label,
                         department, is_verified, must_change_password, created_via,
                         department_id)
      VALUES ($1,$2,$3,$4,'alumni','Alumni Member',$5,FALSE,FALSE,'self_signup',$6)
      RETURNING *
    `, [email.trim().toLowerCase(), hashPassword(password), clean, initials,
        regDepartment ? regDepartment.name : group,
        regDepartment ? regDepartment.id : null]);

    const uid = userRes.rows[0].id;
    /* Location is NOT written here. This INSERT used to end in
       `'Dhaka','Bangladesh'`, so every account ever created was recorded as
       living in Dhaka whether or not it did, and no editor existed to correct
       it. An unknown location is stored as NULL and reads as "Location not
       set"; a guess stored as fact is indistinguishable from a fact. */
    await client.query(`
      INSERT INTO alumni_profiles (user_id, student_id, batch, passing_year, department,
                                   primary_email, mobile_number, blood_group, hsc_group,
                                   department_id)
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)
    `, [uid, await uniqueStudentId(client, year, uid), year,
        regDepartment ? regDepartment.name : group,
        email.trim().toLowerCase(), (mobile || '').trim() || null,
        normalizeBloodGroup(bloodGroup), group,
        regDepartment ? regDepartment.id : null]);

    // Verifying an account is a moderator's job, not only a super admin's, so
    // this reaches every role /api/verification-queue actually admits.
    for (const role of MODERATOR_ROLES) {
      await client.query(`
        INSERT INTO notifications (target_role, icon, title, subtitle)
        VALUES ($1, '🎓', 'New Alumni Registration', $2)
      `, [role, `${clean} signed up and is awaiting verification.`]);
    }

    await client.query('COMMIT');
    await writeAuditSafe('Alumni Self-Registered', `user ${uid} awaiting verification`, '🎓',
      { actorId: uid, targetType: 'user', targetId: uid, ip: clientIp(req) });

    const user = publicUser(userRes.rows[0]);
    const token = signToken({
      uid, role: user.role,
      tv: 1,                       // a freshly registered account starts at 1
      exp: Date.now() + SESSION_TTL_MS
    });
    res.json({ token, user, mustChangePassword: false });
  } catch (err) {
    await client.query('ROLLBACK');
    serverError(res, err, 'api');
  } finally {
    client.release();
  }
});

// Lets a user (especially a bulk-imported one) replace the shared initial password.
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  try {
    const row = await db.query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
    if (!row.rows.length) return res.status(404).json({ error: 'User not found' });
    if (!verifyPassword(currentPassword, row.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    /* The version bump ends every session that was opened with the old
       password, including this one — so the response carries a freshly minted
       token and the caller stays signed in without a round trip through the
       login screen. Anyone else holding a token for this account is signed out. */
    const updated = await db.query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE,
                        last_password_changed_at = NOW(), updated_at = NOW(),
                        token_version = token_version + 1
        WHERE id = $2 RETURNING token_version, role`,
      [hashPassword(newPassword), req.user.uid]
    );
    await writeAuditSafe('Password Changed', `user ${req.user.uid}`, '🔑',
      auditCtx(req, 'user', req.user.uid));
    res.json({
      success: true,
      token: signToken({
        uid: req.user.uid, role: updated.rows[0].role,
        tv: updated.rows[0].token_version,
        exp: Date.now() + SESSION_TTL_MS
      })
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* ─── PASSWORD RECOVERY ─────────────────────────────────────
   A super admin can reset any other administrator, but nobody could reset the
   super admin. This closes that: a self-service flow over the reset_token_hash
   and reset_expires_at columns added in v7.

   The token is 32 random bytes. Only its SHA-256 hash is stored, so a database
   reader — a backup, a log shipper, a leaked dump — cannot mint a reset from
   it. It lives for RESET_TTL_MS, is consumed on first use, and is cleared by any
   other password change on the account.

   Delivery is the honest gap. No mail transport is configured, so the request
   endpoint does not hand the token back over HTTP: doing that would let anyone
   who knows an address take over the account. Until SMTP exists, an operator
   with server access mints the link with `node reset_link.js --email <address>`,
   which writes it to a gitignored file. That is the same trust boundary the
   platform already relies on for rotate_credentials.js. */

const RESET_TTL_MS = 30 * 60 * 1000;   // 30 minutes

const hashResetToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/* Issues a reset token for an account and returns the plaintext. Shared by the
   forgot-password endpoint and the operator CLI so there is one implementation
   of what a valid token is. */
async function issueResetToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    'UPDATE users SET reset_token_hash = $1, reset_expires_at = NOW() + $2::interval WHERE id = $3',
    [hashResetToken(token), `${Math.round(RESET_TTL_MS / 1000)} seconds`, userId]);
  return token;
}

/* Always answers the same way, whether or not the address exists and whether or
   not a token was issued. Anything else turns this into an account-enumeration
   oracle, which matters more here than anywhere else on the platform: these are
   the addresses of the institution's administrators. */
const RESET_ACK = {
  message: 'If that address belongs to an account, a reset link has been issued. ' +
           'It expires in 30 minutes.'
};

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();

  // Rate-limited on the same counters as sign-in, so this cannot be used to
  // hammer the database or to time-probe which addresses exist.
  const gate = loginRateCheck(req, email);
  if (gate.limited) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  try {
    if (email) {
      const r = await db.query(
        `SELECT id, status, email, full_name FROM users WHERE LOWER(email) = $1`, [email]);
      const row = r.rows[0];
      // A suspended account gets no reset: recovering it is an administrator's
      // decision, not the holder's.
      if (row && row.status === 'active') {
        const token = await issueResetToken(row.id);

        /* Delivered by email since Phase 4. The base URL comes from
           PUBLIC_ORIGIN so the link points at the deployment rather than at
           whatever Host header the caller happened to send — otherwise anyone
           could have a reset link minted that points at their own server. */
        const base = (process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`)
          .replace(/\/$/, '');
        const msg = mailer.passwordResetMessage({
          name: row.full_name,
          url: `${base}/?reset=${encodeURIComponent(token)}`,
          minutes: Math.round(RESET_TTL_MS / 60000)
        });
        /* Awaited so a mail failure is logged against this request, but the
           result is deliberately ignored: the response below is identical
           whether the send worked, failed, or was dropped by configuration.
           A mail outage must not become a way to test which addresses exist. */
        await mailer.send({ to: row.email, subject: msg.subject, text: msg.text });

        // The action is audited; neither the token nor the link is part of the entry.
        await writeAuditSafe('Password Reset Requested', `user ${row.id}`, '🔑',
          { actorId: row.id, targetType: 'user', targetId: row.id, ip: clientIp(req) });
      }
    }
  } catch {
    /* Swallowed deliberately. A database error must not make this endpoint
       answer differently for an address that exists. */
  }

  res.json(RESET_ACK);
});

/* Completes the reset. The token is matched by hash, must be unexpired, and is
   cleared in the same statement that sets the password, so it cannot be
   replayed. token_version is bumped, which ends every session that was open
   under the old password. */
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'A reset token is required' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    const r = await db.query(`
      UPDATE users
         SET password_hash = $1,
             must_change_password = FALSE,
             last_password_changed_at = NOW(),
             updated_at = NOW(),
             failed_login_count = 0,
             locked_until = NULL,
             reset_token_hash = NULL,
             reset_expires_at = NULL,
             token_version = token_version + 1
       WHERE reset_token_hash = $2
         AND reset_expires_at > NOW()
         AND status = 'active'
       RETURNING id, full_name`,
      [hashPassword(newPassword), hashResetToken(String(token))]);

    // One message for an unknown token, an expired one and an already-used one:
    // none of them should tell the caller which it was.
    if (!r.rows.length) {
      return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
    }

    await writeAuditSafe('Password Reset Completed',
      `user ${r.rows[0].id}`, '🔑',
      { actorId: r.rows[0].id, targetType: 'user', targetId: r.rows[0].id, ip: clientIp(req) });

    res.json({ success: true, message: 'Password updated. Please sign in.' });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Ends the caller's sessions. Signing out used to be entirely client-side —
   localStorage.removeItem — which left the token itself valid for the rest of
   its twelve hours. Anyone who had copied it, or who picked up the machine
   before the browser was closed, still had a working session.

   Bumping token_version ends every session for that account, not just the one
   in this browser. That is the right default for a staff portal: "sign me out"
   from an administrator usually means "end this", and per-session revocation
   would need a session table this design deliberately avoids. */
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1',
      [req.user.uid]);
    await writeAuditSafe('Signed Out', `user ${req.user.uid}`, '🚪',
      auditCtx(req, 'user', req.user.uid));
    res.json({ success: true });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// Restores a session on page load so a refresh does not dump the user back to
// the login screen.
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Session user no longer exists' });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── 3. ALUMNI DIRECTORY & PROFILES ───
// Directory listing. INNER JOIN on alumni_profiles so admin accounts without a
// profile stop appearing as rows of nulls, and every filter/sort/page is
// resolved in PostgreSQL rather than in the browser.
const ALUMNI_SORTS = {
  name:    'u.full_name ASC',
  recent:  'ap.batch DESC, u.full_name ASC',
  batch:   'ap.batch ASC, u.full_name ASC',
  company: 'ap.current_company ASC NULLS LAST, u.full_name ASC'
};

app.get('/api/alumni', requireAuth, async (req, res) => {
  const { search, dept, batch, domain, mentor, sort, country, city, placeId, division, district } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 12, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const where = [];
  const params = [];

  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    const p = `$${params.length}`;
    /* City is no longer matched here. It was the only way to search by place,
       which meant a member who marks their location private could still be
       found by typing their city — a setting that hides a value while leaving
       it searchable is not a setting. Place is a structured filter now
       (?country=, ?city=, ?placeId=), and those honour the privacy level.
       Country was never in this predicate at all, which is why the "UK" and
       "USA" chips that fed it always returned nothing. */
    where.push(`(LOWER(u.full_name) LIKE ${p} OR LOWER(ap.current_company) LIKE ${p}
              OR LOWER(ap.skills) LIKE ${p} OR LOWER(ap.department) LIKE ${p}
              OR LOWER(ap.job_title) LIKE ${p}
              OR CAST(ap.batch AS TEXT) LIKE ${p})`);
  }
  if (dept)   { params.push(`%${dept.toLowerCase()}%`); where.push(`LOWER(ap.department) LIKE $${params.length}`); }
  /* A non-numeric ?batch reached PostgreSQL as the literal 'NaN' and raised a
     type error, so ?batch=abc was a 500. app.param() guards route parameters;
     query parameters need their own check. */
  if (batch) {
    if (!/^\d+$/.test(String(batch))) return res.status(400).json({ error: 'Invalid batch' });
    params.push(parseInt(batch, 10));                    where.push(`ap.batch = $${params.length}`);
  }
  if (domain) { params.push(domain.toLowerCase());      where.push(`LOWER(ap.industry) = $${params.length}`); }
  if (mentor === 'true') where.push('ap.can_mentor = TRUE');

  /* Structured location filters, matching on the place reference rather than
     on a free-text LIKE. The old UI offered "UK" and "USA" chips that fed the
     general search box, which never looked at the country column at all, so
     both returned nothing while looking like they worked.

     Every location filter is additionally constrained to profiles whose
     location is not private: a member who hides their city must not be
     discoverable by filtering for that city, or the setting would be
     decorative. */
  if (country) {
    params.push(String(country).toLowerCase());
    where.push(`(LOWER(lp.country_code) = $${params.length} OR LOWER(lp.country) = $${params.length})`);
    where.push(privacy.DIRECTORY_VISIBLE_SQL);
  }
  if (city) {
    params.push(String(city).toLowerCase());
    where.push(`LOWER(lp.city) = $${params.length}`);
    where.push(privacy.DIRECTORY_VISIBLE_SQL);
  }
  if (division) {
    params.push(String(division).toLowerCase());
    where.push(`LOWER(lp.division) = $${params.length}`);
    where.push(privacy.DIRECTORY_VISIBLE_SQL);
  }
  if (district) {
    params.push(String(district).toLowerCase());
    where.push(`LOWER(lp.district) = $${params.length}`);
    where.push(privacy.DIRECTORY_VISIBLE_SQL);
  }
  if (placeId && Number.isInteger(parseInt(placeId, 10))) {
    params.push(parseInt(placeId, 10));
    where.push(`ap.place_id = $${params.length}`);
    where.push(privacy.DIRECTORY_VISIBLE_SQL);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = ALUMNI_SORTS[sort] || ALUMNI_SORTS.name;

  try {
    const countRes = await db.query(`
      SELECT COUNT(*)::int AS total
      FROM users u JOIN alumni_profiles ap ON u.id = ap.user_id
      LEFT JOIN location_places lp ON lp.id = ap.place_id
      ${whereSql}
    `, params);

    const rowsRes = await db.query(`
      SELECT u.id, u.full_name AS name, u.initials, u.is_verified AS verified,
             ap.job_title AS role, ap.current_company AS company, ap.batch,
             ap.department AS dept, ap.industry AS domain,
             ap.place_id, ap.location_needs_confirmation,
             lp.city AS place_city, lp.country AS place_country,
             ap.city AS legacy_city, ap.country AS legacy_country,
             ${privacy.DIRECTORY_VISIBLE_SQL} AS location_visible,
             ap.skills, ap.can_mentor AS mentor, ap.color, ap.student_id,
             ap.degree, ap.bio,
             /* Phase 7F. A photo is exactly as visible as the profile it
                belongs to, which the directory already gates by requiring a
                session — so it rides along with the rest of the card. The
                bytes are still served by an authenticated route. */
             ap.photo_url
      FROM users u JOIN alumni_profiles ap ON u.id = ap.user_id
      LEFT JOIN location_places lp ON lp.id = ap.place_id
      ${whereSql}
      ORDER BY ${orderSql}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    /* Contact details are intentionally excluded from list results; they are
       served per-profile by /api/alumni/:id subject to privacy settings.

       Location is resolved here rather than in SQL so the three cases stay
       legible: a confirmed place, a value the pre-v13 hardcoded path wrote
       (shown, but flagged, never presented as the member's own answer), and a
       member who has marked their location private. */
    const alumni = rowsRes.rows.map(r => {
      const visible = r.location_visible === true;
      const confirmed = r.place_id !== null;
      const label = confirmed
        ? [r.place_city, r.place_country].filter(Boolean).join(', ')
        : [r.legacy_city, r.legacy_country].filter(Boolean).join(', ');
      const {
        place_id, location_needs_confirmation, place_city, place_country,
        legacy_city, legacy_country, location_visible, ...rest
      } = r;
      return {
        ...rest,
        color: r.color || '#00A859',
        location: visible ? (label || 'Location not set') : 'Not shared',
        locationConfirmed: visible && confirmed,
        locationNeedsConfirmation: visible ? location_needs_confirmation === true : false,
        skills: r.skills ? r.skills.split(',').map(s => s.trim()).filter(Boolean) : []
      };
    });

    res.json({ alumni, total: countRes.rows[0].total, limit, offset });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.get('/api/alumni/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    /* Column order matters here, and getting it wrong was a privacy hole.
       alumni_profiles has its own `id`, so `ap.*` listed AFTER `u.id` shadowed
       it: row.id became the PROFILE id. The isSelf test below then compared a
       user id against a profile id, and any member whose user id happened to
       equal some other member's profile id was treated as that person — and
       shown the contact details they had marked private. The response also
       handed the client a profile id under the name `id`, which is not the
       identifier any other endpoint uses.

       u.id is therefore selected last, so it wins, and the profile's own key is
       aliased out of the way rather than left to collide. */
    const result = await db.query(`
      SELECT ap.*,
             ap.id AS profile_id,
             lp.city AS place_city, lp.country AS place_country,
             lp.division AS place_division, lp.district AS place_district,
             u.full_name as name, u.email, u.role, u.initials, u.is_verified,
             u.id
      FROM users u
      LEFT JOIN alumni_profiles ap ON u.id = ap.user_id
      LEFT JOIN location_places lp ON lp.id = ap.place_id
      WHERE u.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alumni profile not found' });
    }

    const row = result.rows[0];

    // Report what is actually stored. This previously substituted invented
    // constants ("Brain Station 23", "+880 1712-345678", a fixed skill list)
    // for every null column, so empty profiles looked fully populated.
    /* Gated by privacy.js, which the browser also builds its controls from, so
       a field cannot be offered in the interface without being enforced here. */
    const settings = row.privacy_settings || {};
    const isSelf = !!(req.user && req.user.uid === row.id);
    const ctx = { settings, isSelf, viewerRole: req.user && req.user.role };
    const canSee = (field) => privacy.canSee(field, ctx);

    /* Structured location wins; the free-text columns are only a fallback for
       a profile that has not been confirmed since migration v13, and are
       labelled unconfirmed rather than presented as fact. `location` is gated
       — it was not before, so a member could not hide their city from anyone.

       No address, postal code or hometown appears in this response for any
       role. They are self-only, and `GET /api/profile/me` is where the owner
       reads them. */
    const confirmed = row.place_id !== null && row.place_id !== undefined;
    const placeLabel = confirmed
      ? [row.place_city, row.place_country].filter(Boolean).join(', ')
      : [row.city, row.country].filter(Boolean).join(', ');
    const locationVisible = canSee('location');

    res.json({
      id: row.id,
      name: row.name,
      initials: row.initials,
      email: canSee('email') ? (row.primary_email || row.email) : null,
      studentId: row.student_id,
      batch: row.batch,
      department: row.department,
      degree: row.degree,
      company: row.current_company,
      jobTitle: row.job_title,
      location: locationVisible ? (placeLabel || null) : null,
      city: locationVisible ? (confirmed ? row.place_city : row.city) : null,
      country: locationVisible ? (confirmed ? row.place_country : row.country) : null,
      // Says whether the location above is a value this person confirmed, or
      // one the pre-v13 hardcoded path wrote for them. The interface shows the
      // difference rather than letting a fabricated value read as a fact.
      locationConfirmed: locationVisible ? confirmed : null,
      industry: row.industry,
      bio: row.bio,
      skills: row.skills ? row.skills.split(',').map(s => s.trim()).filter(Boolean) : [],
      mobile: canSee('mobile') ? row.mobile_number : null,
      linkedin: row.linkedin,
      github: row.github,
      website: row.website,
      verified: row.is_verified,
      canMentor: row.can_mentor,
      hiring: row.hiring,
      hasProfile: row.student_id !== null
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── PROFILE SELF-SERVICE ───
// Returns the signed-in user's own profile with every field, unmasked.
app.get('/api/profile/me', requireAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.email, u.full_name, u.initials, u.role, u.role_label,
             u.department AS user_department, u.is_verified, u.must_change_password, u.created_via,
             ap.*,
             /* Phase 7F: whichever photo column belongs to this account. An
                alumnus's photo lives on the profile, a staff account's on the
                user row, and a staff account has no profile row at all — so
                ap.* alone would lose it. */
             COALESCE(ap.photo_url, u.photo_url) AS effective_photo_url,
             lp.id AS place_id_resolved, lp.city AS place_city, lp.country AS place_country,
             lp.country_code AS place_country_code, lp.division AS place_division,
             lp.district AS place_district
      FROM users u
      LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
      LEFT JOIN location_places lp ON lp.id = ap.place_id
      WHERE u.id = $1
    `, [req.user.uid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Profile not found' });
    // The owner's own row, unmasked — privacy gates protect a profile from
    // OTHER people, never from the person it describes.
    res.json({ ...r.rows[0], privacy_settings: privacy.effective(r.rows[0].privacy_settings) });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// Editable profile fields. Whitelisted so a caller cannot write arbitrary
// columns (role, verification status, etc.) by adding keys to the payload.
const EDITABLE_PROFILE_FIELDS = {
  bloodGroup:       'blood_group',
  presentAddress:   'present_address',
  permanentAddress: 'permanent_address',
  occupation:       'occupation',
  organization:     'current_company',   // "Current Organization / Institution"
  designation:      'job_title',         // "Current Designation"
  hscPassingYear:   'passing_year',
  hscGroup:         'hsc_group',
  hscVersion:       'hsc_version',
  photoUrl:         'photo_url',
  facebook:         'facebook',
  linkedin:         'linkedin',
  github:           'github',
  website:          'website',
  mobile:           'mobile_number',
  bio:              'bio',
  skills:           'skills',
  hometown:         'hometown',
  postalCode:       'postal_code'
  /* `city` and `country` are deliberately NOT here any more. Location is set
     by choosing a place — see the placeId branch below — so there is one
     writer and one source of truth. Accepting free text alongside a structured
     reference is how the two drift apart, and drift is what made the old map
     unfixable. */
};

app.put('/api/profile/me', requireAuth, async (req, res) => {
  const sets = [], vals = [req.user.uid];

  for (const [key, column] of Object.entries(EDITABLE_PROFILE_FIELDS)) {
    if (req.body[key] === undefined) continue;
    let value = req.body[key];

    if (key === 'bloodGroup') value = normalizeBloodGroup(value);
    else if (key === 'occupation') value = normalizeOccupation(value);
    else if (key === 'hscGroup') value = normalizeHscGroup(value);
    else if (key === 'hscPassingYear') value = parseInt(value) || null;
    else if (typeof value === 'string') value = value.trim() || null;

    vals.push(value);
    sets.push(`${column} = $${vals.length}`);
  }

  /* Field privacy. This is the only JSONB column a member may write, and it is
     validated key by key rather than passed through the scalar whitelist above,
     which would let a caller put arbitrary JSON into the column.

     The whitelist, the levels and the defaults all come from privacy.js — the
     same object the browser builds its controls from and the read side gates
     against. Previously this list was maintained here by hand, the database
     default carried four other keys, and the profile page rendered a fifth from
     an undefined value; nothing agreed with anything. */
  if (req.body.privacySettings !== undefined) {
    const checked = privacy.validateSettings(req.body.privacySettings);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    // Merged, not replaced, so a partial payload cannot silently clear the rest.
    vals.push(JSON.stringify(checked.clean));
    sets.push(`privacy_settings = COALESCE(privacy_settings, '{}'::jsonb) || $${vals.length}::jsonb`);
  }

  /* Structured location. `placeId` is the only way to set a location, and it
     must name a row of location_places — free text is not accepted, so the
     directory filters and the map aggregate can rely on the value.

     Writing a place also stamps the denormalised city/country and clears
     location_needs_confirmation: the member has now said where they are, which
     is precisely what the flag was waiting for. Passing null clears the
     location outright, and clears the flag too — "I would rather not say" is a
     confirmed answer, not an outstanding question. */
  if (req.body.placeId !== undefined) {
    if (req.body.placeId === null || req.body.placeId === '') {
      sets.push('place_id = NULL', 'city = NULL', 'country = NULL',
                'division = NULL', 'district = NULL',
                'location_needs_confirmation = FALSE');
    } else {
      const place = await location.placeById(db, req.body.placeId);
      if (!place) return res.status(400).json({ error: 'Unknown place' });
      vals.push(place.id);            const pi = vals.length;
      vals.push(place.city);          const pc = vals.length;
      vals.push(place.country);       const pn = vals.length;
      vals.push(place.division);      const pd = vals.length;
      vals.push(place.district);      const pt = vals.length;
      sets.push(`place_id = $${pi}`, `city = $${pc}`, `country = $${pn}`,
                `division = $${pd}`, `district = $${pt}`,
                'location_needs_confirmation = FALSE');
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied' });

  try {
    // passing_year and batch are kept in step so directory filters stay correct.
    if (req.body.hscPassingYear !== undefined) sets.push('batch = passing_year');

    const r = await db.query(`
      UPDATE alumni_profiles SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 RETURNING *
    `, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Profile not found' });

    if (req.body.name && req.body.name.trim()) {
      await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [req.user.uid, req.body.name.trim()]);
    }
    res.json({
      success: true,
      profile: { ...r.rows[0], privacy_settings: privacy.effective(r.rows[0].privacy_settings) }
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* ─── LOCATION REFERENCE DATA ────────────────────────────────
   The controlled list the profile editor and the directory filters are built
   from. Reference data about places, not about people: no alumnus appears in
   any response here, so it is readable by any signed-in member. */

// Every active place, for the cascading Country → Division → City selector.
app.get('/api/locations/places', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, country_code, country, division, district, city, latitude, longitude
        FROM location_places WHERE is_active
       ORDER BY country, division NULLS FIRST, city`);
    const countries = [];
    const byCountry = new Map();
    for (const p of rows) {
      if (!byCountry.has(p.country_code)) {
        const entry = { code: p.country_code, country: p.country, divisions: [], cities: [] };
        byCountry.set(p.country_code, entry);
        countries.push(entry);
      }
      const entry = byCountry.get(p.country_code);
      if (p.division && !entry.divisions.includes(p.division)) entry.divisions.push(p.division);
      entry.cities.push({
        id: p.id, city: p.city, division: p.division, district: p.district,
        latitude: Number(p.latitude), longitude: Number(p.longitude)
      });
    }
    res.json({ countries, total: rows.length });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* The privacy contract, so the browser renders exactly the fields and levels
   the server enforces instead of a hand-maintained copy that drifts. */
/* ═══ PROFILE PHOTO (Phase 7F) ══════════════════════════════

   Three routes: set one, remove one, serve one.

   WHERE THE PHOTO LIVES. Both photo columns already existed and both were
   empty. They are kept apart rather than merged, because they belong to
   different things: an alumnus's photo is part of their alumni profile
   (`alumni_profiles.photo_url`, already the field the profile editor writes and
   already what event people render from), and a staff account's photo is part
   of the account (`users.photo_url`, written by administrator provisioning).
   A staff account has no alumni_profiles row at all. No column was added.

   WHO MAY DO WHAT. A member sets and removes their OWN photo and nobody
   else's; the subject is always req.user.uid and is never read from the
   request. An administrator gains no photo-editing right here — the existing
   administrator form still sets an external photo URL on staff accounts, which
   is the policy that already existed, and nothing in this phase widens it.

   VISIBILITY. A photo is exactly as visible as the profile it belongs to:
   readable by any signed-in member, and by nobody who is not signed in. That is
   what the directory already does, and it is why photos are served by this
   route rather than from a public directory — the static allow-list in this
   file would 404 an uploads folder, which is the behaviour we want. No new
   privacy level was invented for photos. */

/* Which table carries this account's photo, and what it currently holds. */
async function photoRowFor(uid) {
  const prof = await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id = $1', [uid]);
  if (prof.rows.length) return { table: 'alumni_profiles', key: 'user_id', url: prof.rows[0].photo_url };
  const usr = await db.query('SELECT photo_url FROM users WHERE id = $1', [uid]);
  if (usr.rows.length) return { table: 'users', key: 'id', url: usr.rows[0].photo_url };
  return null;
}

app.post('/api/profile/photo', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const current = await photoRowFor(uid);
    if (!current) return res.status(404).json({ error: 'No profile to attach a photo to.' });

    const stored = await photos.storePhoto(uid, req.body && req.body.image);
    if (stored.error) return res.status(400).json({ error: stored.error });

    /* The new photo is recorded FIRST and the old file is deleted only once the
       record points at the new one. The other order leaves a member with a
       profile pointing at a file that is gone if anything fails in between. */
    const url = photos.photoUrl(uid, stored.name);
    await db.query(
      `UPDATE ${current.table} SET photo_url = $1 WHERE ${current.key} = $2`, [url, uid]);

    const previous = photos.nameFromUrl(current.url);
    if (previous && previous !== stored.name) await photos.removePhoto(previous);

    await writeAuditSafe('Profile Photo Updated', `user ${uid}`, '📷', auditCtx(req, 'user', uid));
    res.json({ success: true, photoUrl: url, width: stored.width, height: stored.height, bytes: stored.bytes });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.delete('/api/profile/photo', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const current = await photoRowFor(uid);
    if (!current) return res.status(404).json({ error: 'No profile to remove a photo from.' });

    await db.query(
      `UPDATE ${current.table} SET photo_url = NULL WHERE ${current.key} = $1`, [uid]);

    /* Only a file this platform stored is deleted. An external URL — the ones
       the bulk import and the administrator form still accept — is cleared from
       the profile but is not ours to delete from wherever it lives. */
    const name = photos.nameFromUrl(current.url);
    if (name) await photos.removePhoto(name);

    await writeAuditSafe('Profile Photo Removed', `user ${uid}`, '📷', auditCtx(req, 'user', uid));
    res.json({ success: true, photoUrl: null });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.get('/api/profile/photo/:id', requireAuth, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (!Number.isInteger(uid)) return res.status(400).json({ error: 'Invalid id' });

    const row = await photoRowFor(uid);
    /* One answer for "no such account", "no photo" and "the file is gone", so
       this route cannot be used to find out which accounts exist. */
    if (!row || !row.url) return res.status(404).json({ error: 'No photo' });

    const name = photos.nameFromUrl(row.url);
    if (!name) return res.status(404).json({ error: 'No photo' });

    /* The requested version must be the CURRENT one. An old ?v= is a photo the
       member has since replaced or removed, and serving it would mean a
       replaced face stayed reachable to anyone who had the URL. */
    if (req.query.v && req.query.v !== name) return res.status(404).json({ error: 'No photo' });

    const bytes = await photos.readPhoto(name);
    if (!bytes) return res.status(404).json({ error: 'No photo' });

    res.set('Content-Type', 'image/jpeg');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
    /* Private, because this is personal data behind a session — a shared cache
       must not hold it. Immutable, because the name changes whenever the photo
       does, so a browser may keep this exact URL as long as it likes. */
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.send(bytes);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.get('/api/profile/privacy-schema', requireAuth, (req, res) => {
  res.json(privacy.schemaForClient());
});

/* Directory filter options, derived from the alumni who are actually there.
   The chips used to be a hardcoded Dhaka / UK / USA, two of which matched
   nothing because the search they drove never looked at the country column.
   A place appears here only if somebody real is in it and has not marked their
   location private, so an empty directory produces empty filters rather than
   three confident buttons that return nothing.

   Deliberately NOT under /api/alumni/... — `/api/alumni/:id` is declared
   earlier and would match "location-filters" as an id. */
app.get('/api/locations/filters', requireAuth, async (req, res) => {
  try {
    /* Divisions and districts are queried the same way as countries and
       cities: grouped over the places alumni are actually in. A division
       nobody lives in produces no row, so the interface can never render a
       chip that would return an empty directory. */
    const [countries, cities, divisions, districts] = await Promise.all([
      db.query(`
        SELECT lp.country_code AS code, lp.country, COUNT(*)::int AS n
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE ${privacy.DIRECTORY_VISIBLE_SQL}
         GROUP BY lp.country_code, lp.country
         ORDER BY n DESC, lp.country`),
      db.query(`
        SELECT lp.id AS place_id, lp.city, lp.country, lp.country_code AS code, COUNT(*)::int AS n
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE ${privacy.DIRECTORY_VISIBLE_SQL}
         GROUP BY lp.id, lp.city, lp.country, lp.country_code
         ORDER BY n DESC, lp.city`),
      db.query(`
        SELECT lp.division, lp.country, lp.country_code AS code, COUNT(*)::int AS n
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE ${privacy.DIRECTORY_VISIBLE_SQL} AND lp.division IS NOT NULL
         GROUP BY lp.division, lp.country, lp.country_code
         ORDER BY n DESC, lp.division`),
      db.query(`
        SELECT lp.district, lp.division, lp.country_code AS code, COUNT(*)::int AS n
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE ${privacy.DIRECTORY_VISIBLE_SQL} AND lp.district IS NOT NULL
         GROUP BY lp.district, lp.division, lp.country_code
         ORDER BY n DESC, lp.district`)
    ]);
    res.json({
      countries: countries.rows,
      cities: cities.rows,
      divisions: divisions.rows,
      districts: districts.rows
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── 4. CHAPTERS & MEMBERSHIPS ───
app.get('/api/chapters', requireAuth, async (req, res) => {
  try {
    // members_count is derived from chapter_memberships rather than trusted
    // from the denormalised column, and is_member reflects the real session
    // user instead of a hardcoded Set([1, 3]) in the browser.
    /* The chapter's own location, from the shared reference table. It is the
       institution's city, never an aggregate of where its members live. */
    const result = await db.query(`
      SELECT c.*,
             lp.city        AS place_city,
             lp.country     AS place_country,
             lp.country_code AS place_country_code,
             lp.latitude::float8  AS place_latitude,
             lp.longitude::float8 AS place_longitude,
             (SELECT COUNT(*)::int FROM chapter_memberships m WHERE m.chapter_id = c.id) AS member_rows,
             EXISTS (SELECT 1 FROM chapter_memberships m
                     WHERE m.chapter_id = c.id AND m.user_id = $1) AS is_member
      FROM chapters c
      LEFT JOIN location_places lp ON lp.id = c.place_id
      WHERE c.status = 'approved'
      ORDER BY c.id ASC
    `, [req.user.uid]);
    res.json(result.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// Roles that may publish a chapter without review. Everyone else's submission
// enters the moderation queue — previously this was hardcoded to 'approved',
// which left the queue permanently empty.
const CHAPTER_AUTO_APPROVE_ROLES = ['super_admin', 'univ_admin', 'dept_admin'];

app.post('/api/chapters', requireVerified, async (req, res) => {
  const { name, type, icon, description, parentId, placeId } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Chapter name is required' });
  }

  // Role and author come from the verified session, never from the request body.
  const createdByRole = req.user.role;
  const createdById = req.user.uid;
  const status = CHAPTER_AUTO_APPROVE_ROLES.includes(createdByRole) ? 'approved' : 'pending_review';

  /* A place is optional, but a place that does not exist is a typo, not a
     location. Resolved against the table rather than trusted from the body. */
  let place = null;
  if (placeId !== undefined && placeId !== null && String(placeId).trim() !== '') {
    const pid = Number(placeId);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: 'Chapter location is not a valid place' });
    }
    const found = await db.query('SELECT id FROM location_places WHERE id = $1 AND is_active', [pid]);
    if (!found.rows.length) return res.status(400).json({ error: 'Chapter location is not a known place' });
    place = pid;
  }

  try {
    const result = await db.query(`
      INSERT INTO chapters (name, type, icon, description, parent_id, status, created_by_id, place_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [name.trim(), (type || 'regional').toLowerCase(), icon || '🏫', description || '',
        parentId || null, status, createdById || null, place]);

    /* Surface the submission to everyone who can actually act on it. This used
       to insert a single row with target_role = 'super_admin', so a moderator or
       a department admin — both of whom the guard on /api/moderation/chapter
       allows to approve it — was never told a chapter was waiting. A
       notification's target_role has to match the reader's role exactly, so one
       row is written per role that can approve. */
    if (status === 'pending_review') {
      for (const role of MODERATOR_ROLES) {
        await db.query(`
          INSERT INTO notifications (target_role, icon, title, subtitle, link_entity, link_id)
          VALUES ($1, '🏫', 'New Chapter Awaiting Approval', $2, 'chapter', $3)
        `, [role, `Chapter "${name.trim()}" was submitted for review.`, result.rows[0].id]);
      }
    }

    res.json({ chapter: result.rows[0], status });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Sets or clears a chapter's location. Chapters had no update route, so the
   three regional chapters that predate this phase could never be placed.
   Admin-only and audited, because a chapter's location is institutional
   information rather than something any member may edit. Passing null clears
   it, which is the correct answer for a chapter that spans more than a city. */
app.put('/api/chapters/:id/place', requireRole(...ADMIN_ROLES), async (req, res) => {
  // app.param already refuses a non-numeric :id before this runs.
  const id = parseInt(req.params.id, 10);
  const raw = (req.body || {}).placeId;

  let place = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: 'Chapter location is not a valid place' });
    }
    const found = await db.query('SELECT id FROM location_places WHERE id = $1 AND is_active', [pid]);
    if (!found.rows.length) return res.status(400).json({ error: 'Chapter location is not a known place' });
    place = pid;
  }

  try {
    const row = await db.query(
      `UPDATE chapters SET place_id = $2 WHERE id = $1
       RETURNING id, name, place_id`, [id, place]);
    if (!row.rows.length) return res.status(404).json({ error: 'Chapter not found' });

    await writeAuditSafe(
      place ? 'Chapter Location Set' : 'Chapter Location Cleared',
      `Chapter ${id} ${place ? 'placed in place ' + place : 'location cleared'}`,
      'map-pin', auditCtx(req, 'chapter', id));

    const full = await db.query(`
      SELECT c.id, c.name, c.place_id,
             lp.city AS place_city, lp.country AS place_country,
             lp.country_code AS place_country_code,
             lp.latitude::float8 AS place_latitude, lp.longitude::float8 AS place_longitude
        FROM chapters c LEFT JOIN location_places lp ON lp.id = c.place_id
       WHERE c.id = $1`, [id]);
    res.json(full.rows[0]);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.post('/api/chapters/:id/join', requireVerified, async (req, res) => {
  const chapterId = parseInt(req.params.id);
  const targetUserId = req.user.uid; // was `userId || 5` from the request body

  try {
    const check = await db.query('SELECT * FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2', [chapterId, targetUserId]);
    let joined = false;

    if (check.rows.length > 0) {
      // Leave chapter
      await db.query('DELETE FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2', [chapterId, targetUserId]);
      joined = false;
    } else {
      // Join chapter
      await db.query('INSERT INTO chapter_memberships (chapter_id, user_id) VALUES ($1, $2)', [chapterId, targetUserId]);
      joined = true;
    }

    const updatedChapter = await db.query('SELECT * FROM chapters WHERE id = $1', [chapterId]);
    res.json({ joined, chapter: updatedChapter.rows[0] });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* This endpoint was unauthenticated and returned real alumni names, employers,
   job titles, batches and departments to anyone. Worse, an empty or unknown
   chapter fell through to `SELECT ... FROM users LIMIT 4`, so a chapter that
   did not exist still answered with four real people. Both are fixed: sign-in
   is required, an unknown chapter is a 404, and an empty chapter is an empty
   list rather than borrowed strangers. */
app.get('/api/chapters/:id/members', requireAuth, async (req, res) => {
  const chapterId = parseInt(req.params.id);
  if (!chapterId) return res.status(400).json({ error: 'A valid chapter id is required' });

  try {
    const chapter = await db.query('SELECT id FROM chapters WHERE id = $1', [chapterId]);
    if (chapter.rows.length === 0) {
      return res.status(404).json({ error: 'Chapter not found' });
    }

    const result = await db.query(`
      SELECT u.id, u.full_name as name, u.initials, ap.job_title as role, ap.current_company as company,
             ap.batch, ap.department as dept
      FROM chapter_memberships cm
      JOIN users u ON cm.user_id = u.id
      LEFT JOIN alumni_profiles ap ON u.id = ap.user_id
      WHERE cm.chapter_id = $1
      ORDER BY u.full_name
    `, [chapterId]);

    res.json(result.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── 5. STORIES & NEWS FEED ───
/* Published stories.

   This was the only route in the product that answered without a session, and
   it ran `SELECT *`, so `author_id` — an internal user id — was readable by
   anyone on the internet. Nothing was designed that way: the news feed is
   reachable only from inside the signed-in application, every other data route
   requires a session, and the platform has no anonymous surface at all. The
   endpoint was public by omission, so it now requires a session like the rest.

   The column list is explicit as well. `author_id` is not returned to anybody:
   the feed renders `author_name` and never used the id. Should DIC later want a
   genuinely public news page, that is a deliberate decision to take then — with
   its own endpoint and its own column list — rather than one inherited from an
   oversight. */
app.get('/api/stories', requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, emoji, category, title, excerpt, content,
             author_name, status, published_date, created_at
        FROM stories WHERE status = $1 ORDER BY id DESC`, ['published']);
    res.json(result.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.post('/api/stories', requireVerified, async (req, res) => {
  const { title, category, content, emoji } = req.body;

  if (!title || !title.trim() || !content || !content.trim()) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  // Author identity comes from the session, not the request body.
  const authorId = req.user.uid;
  const excerpt = content.length > 150 ? content.slice(0, 150) + '…' : content;

  try {
    const authorRow = await db.query('SELECT full_name FROM users WHERE id = $1', [authorId]);
    const authorName = authorRow.rows[0]?.full_name || 'DIC Alumni';

    const result = await db.query(`
      INSERT INTO stories (emoji, category, title, excerpt, content, author_id, author_name, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review')
      RETURNING *
    `, [emoji || '🌟', category || 'Alumni Story', title.trim(), excerpt, content.trim(), authorId, authorName]);

    // One row per role that /api/moderation/story allows to act, for the same
    // reason as the chapter handler above: a notification's target_role must
    // match the reader's role exactly, so the single 'super_admin' row this
    // replaces left moderators and department admins unaware of the queue.
    for (const role of MODERATOR_ROLES) {
      await db.query(`
        INSERT INTO notifications (target_role, icon, title, subtitle, link_entity, link_id)
        VALUES ($1, '✐', 'New Story Submitted for Moderation', $2, 'story', $3)
      `, [role, `Story "${title.trim()}" submitted by ${authorName}`, result.rows[0].id]);
    }

    res.json({ story: result.rows[0], status: 'pending_review' });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── 6. MODERATION QUEUE & APPROVALS ───
app.get('/api/moderation', requireRole(...MODERATOR_ROLES), async (req, res) => {
  try {
    const pendingChapters = await db.query('SELECT * FROM chapters WHERE status = $1 ORDER BY id DESC', ['pending_review']);
    const pendingStories = await db.query('SELECT * FROM stories WHERE status = $1 ORDER BY id DESC', ['pending_review']);
    /* Events are deliberately absent. This endpoint used to also return
       pendingEvents, but nothing ever rendered them — renderModerationPanel
       draws chapters and stories only — so the queue silently claimed a
       responsibility it did not carry. Event approval lives where the event
       does: the workspace, which shows the proposal in full and calls
       PUT /api/events/:id/approve|reject. One path, not one and a half. */
    res.json({
      pendingChapters: pendingChapters.rows,
      pendingStories: pendingStories.rows
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.post('/api/moderation/chapter/:id/:action', requireRole(...MODERATOR_ROLES), async (req, res) => {
  const id = parseInt(req.params.id);
  const action = req.params.action; // approve or reject
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  try {
    const result = await db.query('UPDATE chapters SET status = $1 WHERE id = $2 RETURNING *', [newStatus, id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Chapter not found' });

    /* Tell the person who submitted the chapter. This used to be written as
       VALUES (5, …) — user 5 was notified about every chapter decision on the
       platform, whoever had actually submitted it, and the real submitter was
       never told. The recipient is chapters.created_by_id; when that is null
       (a seeded row with no author) no notification is written at all, rather
       than one addressed to an arbitrary account. */
    const recipient = result.rows[0].created_by_id;
    if (recipient) {
      await db.query(`
        INSERT INTO notifications (user_id, icon, title, subtitle, link_entity, link_id)
        VALUES ($1, '🏫', $2, $3, 'chapter', $4)
      `, [
        recipient,
        `Chapter ${action === 'approve' ? 'approved' : 'rejected'}`,
        `Your chapter submission "${result.rows[0].name}" was ${newStatus}.`,
        id
      ]);
    }

    res.json({ success: true, chapter: result.rows[0] });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.post('/api/moderation/story/:id/:action', requireRole(...MODERATOR_ROLES), async (req, res) => {
  const id = parseInt(req.params.id);
  const action = req.params.action;
  const newStatus = action === 'approve' ? 'published' : 'rejected';

  try {
    const result = await db.query('UPDATE stories SET status = $1 WHERE id = $2 RETURNING *', [newStatus, id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Story not found' });

    // Same fix as the chapter handler above: the author is stories.author_id,
    // not the hardcoded user 5 this used to notify.
    const recipient = result.rows[0].author_id;
    if (recipient) {
      await db.query(`
        INSERT INTO notifications (user_id, icon, title, subtitle, link_entity, link_id)
        VALUES ($1, '✐', $2, $3, 'story', $4)
      `, [
        recipient,
        `Story ${action === 'approve' ? 'published' : 'rejected'}`,
        `Your story "${result.rows[0].title}" was ${newStatus}.`,
        id
      ]);
    }

    res.json({ success: true, story: result.rows[0] });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// Event approval moved onto the event itself in v5:
//   PUT /api/events/:id/approve  ·  PUT /api/events/:id/reject

// ─── 7. NOTIFICATIONS ───
// Scoped to the caller: direct notifications (user_id), role broadcasts
// (target_role), and system-wide notices (both null). Previously this returned
// every row in the table to every user.
app.get('/api/notifications', requireAuth, async (req, res) => {
  // Scope comes from the verified session. Taking userId/role from the query
  // string would let any signed-in user read someone else's notifications.
  const userId = req.user.uid;
  const role = req.user.role;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const result = await db.query(`
      SELECT * FROM notifications
      WHERE ($1::int IS NOT NULL AND user_id = $1)
         OR ($2::text IS NOT NULL AND target_role = $2)
         OR (user_id IS NULL AND target_role IS NULL)
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [userId, role, limit]);
    res.json(result.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    // The WHERE clause also enforces ownership, so one user cannot mark
    // another user's notification as read.
    const result = await db.query(`
      UPDATE notifications SET is_unread = FALSE
      WHERE id = $1
        AND (user_id = $2 OR target_role = $3 OR (user_id IS NULL AND target_role IS NULL))
      RETURNING *
    `, [parseInt(req.params.id), req.user.uid, req.user.role]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json(result.rows[0]);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  const userId = req.user.uid;
  const role = req.user.role;
  try {
    const result = await db.query(`
      UPDATE notifications SET is_unread = FALSE
      WHERE is_unread = TRUE
        AND (($1::int IS NOT NULL AND user_id = $1)
          OR ($2::text IS NOT NULL AND target_role = $2)
          OR (user_id IS NULL AND target_role IS NULL))
      RETURNING id
    `, [userId || null, role || null]);
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

// ─── 8. BULK USER IMPORT ───
/* ─── IMPORT NORMALISERS ───
   Intake forms collect free text. The reunion CSV had 32 distinct spellings
   for 8 real blood groups ("0+" with a zero, "A positive", "Ab+", "AbB+",
   "O' possative"), so values are canonicalised here rather than stored raw.
   Anything unrecognised becomes 'Unknown' — it never fails the import. */
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

function normalizeBloodGroup(raw) {
  if (!raw || !String(raw).trim()) return null;
  let s = String(raw).trim().toUpperCase();

  // Strip punctuation/whitespace and expand written-out signs.
  s = s.replace(/[()'`.\s]/g, '');
  s = s.replace(/POSSATIVE|POSITIVE|POSITIVR|POSTIVE|POS(?![A-Z])|PLUS/g, '+');
  s = s.replace(/NEGATIVE|NEGETIVE|NEG(?![A-Z])|MINUS/g, '-');
  s = s.replace(/VE$/, '');            // "A+VE" -> "A+"
  s = s.replace(/^0/, 'O');            // digit zero typed for the letter O
  s = s.replace(/ABB/g, 'AB');         // "AbB+" typo
  s = s.replace(/\++/g, '+').replace(/-+/g, '-');

  // Pull the group letters and the sign out of whatever is left.
  const letters = (s.match(/AB|A|B|O/) || [])[0];
  const sign = s.includes('+') ? '+' : (s.includes('-') ? '-' : '');
  if (!letters) return 'Unknown';

  // No rhesus sign means the value is genuinely unknown. Guessing '+' on a
  // medical field used for emergency matching would be unsafe.
  if (!sign) return 'Unknown';
  const candidate = letters + sign;
  return BLOOD_GROUPS.includes(candidate) ? candidate : 'Unknown';
}

function normalizeOccupation(raw) {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim().toLowerCase();
  if (s.startsWith('student')) return 'Student';
  if (s.startsWith('job') || s.includes('service') || s.includes('employ')) return 'Job';
  if (s.startsWith('business') || s.includes('entrepreneur')) return 'Business';
  return 'Others';
}

function normalizeHscGroup(raw) {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim().toLowerCase();
  if (s.startsWith('sci')) return 'Science';
  if (s.includes('b. studies') || s.includes('business') || s.includes('commerce')) return 'Business Studies';
  if (s.includes('human') || s.includes('arts')) return 'Humanities';
  return String(raw).trim();
}

function normalizeMobile(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Bangladeshi numbers: keep the last 10 significant digits as the match key.
  return digits.slice(-10);
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e.trim());
}

// Intake forms produce sloppy addresses. Recovers the common damage rather
// than rejecting the row: "a.tafsina@ Gmail.com" (space after @) and
// "x@gmail.com x@gmail.com" (pasted twice) both appeared in the reunion CSV.
function sanitizeEmail(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/[\u00a0\s]+/g, " ");                 // normalise whitespace

  // If several tokens were pasted, keep the first that looks like an address.
  const tokens = s.split(" ").filter(Boolean);
  const token = tokens.find(t => t.includes("@"));
  if (token && tokens.length > 1 && isValidEmail(token)) return token;

  s = s.replace(/\s+/g, "");                           // "a@ gmail.com" -> "a@gmail.com"
  s = s.replace(/^mailto:/, "").replace(/[,;]+$/, "");
  return s || null;
}

app.post('/api/bulk-import', requireRole(...ADMIN_ROLES), async (req, res) => {
  const { records, filename, adminName, failedCount, duplicateCount, processingTime } = req.body;

  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'records must be an array' });
  }

  /* A dry run is the SAME code, committed or not. Everything below — every
     validation, every duplicate decision, every location lookup, every INSERT
     — runs exactly once either way; only the last statement differs, COMMIT or
     ROLLBACK. A dry run written as a separate "validate" pass would be a second
     implementation of the import, and the two would disagree the first time one
     of them was edited. This one cannot disagree with itself.

     What that buys the operator: the counts in the preview are the counts they
     will get, including duplicates found against accounts already in the
     database — which a client-side check cannot see at all. */
  const dryRun = req.body.dryRun === true;

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    let created = 0, updated = 0, skippedDuplicate = 0, rejected = 0;
    const rejectedRows = [];
    let withMissingOptional = 0;
    const missingFieldCounts = {};
    // hscPassingYear was listed here, but it is NOT optional — it is the batch,
    // and the column is NOT NULL. A row without it is rejected above.
    const OPTIONAL_FIELDS = ["mobile","department","hscGroup","hscVersion","bloodGroup",
                             "presentAddress","permanentAddress","hometown","postalCode",
                             "city","district","country",
                             "occupation","organization","designation",
                             "photoUrl","facebook"];
    /* Rows whose location text could not be matched to a reference place. They
       are imported without a location and listed back to the administrator, so
       an unrecognised city is visible rather than silently replaced. The old
       import wrote 'Dhaka','Bangladesh' onto every row regardless of what the
       file said, and discarded the Country, District, Hometown and
       PermanentAddress columns its own template asked for. */
    const unresolvedLocations = [];
    /* Departments the file named that this platform has no record of. Reported
       in full rather than counted, for the same reason unresolved locations
       are: "3 unknown departments" is not actionable and "row 12: Mechatronics"
       is. */
    const unresolvedDepartments = [];
    const seenEmail = new Set(), seenMobile = new Set();
    const strategy = (req.body.dupResolution || "skip").toLowerCase();

    /* How the imported accounts get a password.

       'generated' is what the platform has always done: one random credential
       for the whole batch, hashed, shown to the operator once, with every
       account flagged must_change_password. It replaced the hardcoded
       '12345678' that used to be readable in the page source, so it was a
       large improvement — but the credential is still shared by everyone in
       the batch, and it passes through a human on its way to them.

       'invite' has no shared credential at all. Each account is created with
       the LOCKED$ sentinel, which verifyPassword can never match, and its
       holder sets their own password through the existing reset flow using
       their own address. That is a unique credential per account, chosen by
       the person it belongs to, which never exists anywhere an operator could
       see, write down or forward.

       The operator chooses. 'invite' needs every imported address to be one
       the person can actually read; 'generated' does not, which is why it
       still exists and is still the default rather than being replaced. */
    /* Phase 7D — the roster's Department column.

       Until now the import had no Department field at all: it wrote
       normalizeHscGroup(r.hscGroup) into users.department and
       alumni_profiles.department, so an imported alumnus's "department" was
       their HSC group — 'Science', 'Commerce', 'Arts'. One account on this
       platform still reads 'Science' for exactly that reason.

       A department is now read from the file, resolved against the reference
       table by code or name, and checked against the administrator's own scope.
       A row naming a department the administrator does not govern is REJECTED
       by row number, like any other bad row — not silently reassigned, and not
       silently imported without one. */
    const deptRows = await client.query('SELECT id, code, name FROM departments WHERE is_active');
    const deptByKey = new Map();
    for (const d of deptRows.rows) {
      deptByKey.set(d.code.toLowerCase(), d);
      deptByKey.set(d.name.toLowerCase(), d);
    }
    const importerScope = scope.scopeOf(req.user);
    if (importerScope.kind === 'none') {
      await client.query('ROLLBACK');
      return res.status(403).json(scope.NO_DEPARTMENT);
    }

    const passwordStrategy = req.body.passwordStrategy === 'invite' ? 'invite' : 'generated';
    const batchPassword = passwordStrategy === 'invite' ? null : generateImportPassword();
    const passwordHash = passwordStrategy === 'invite'
      ? 'LOCKED$bulk-import-no-password'
      : hashPassword(batchPassword);

    /* The batch row is written FIRST, with zero counts, and updated at the end.
       It has to exist before the accounts do, because each created account
       records which batch made it — and without that link a bad import could be
       seen in the history and not undone. Both statements are inside this
       transaction, so a failure anywhere leaves neither.

       admin_name still carries whatever the client sent, because existing rows
       have it and the column is NOT NULL. created_by is the authenticated user
       id: a name a caller can choose is not an actor. */
    const batchRow = await client.query(
      `INSERT INTO import_history (batch_code, filename, total_records, success_count,
                                   failed_count, duplicate_count, admin_name,
                                   processing_time, created_by, status)
       VALUES ($1,$2,$3,0,0,0,$4,$5,$6,'completed') RETURNING id`,
      [`BATCH-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
       filename || "import.csv", records.length,
       adminName || "Admin", processingTime || "—", req.user.uid]
    );
    const batchId = batchRow.rows[0].id;

    for (const r of records) {
      const rowNo = r.row || 0;
      const name = (r.name || "").trim();
      const email = sanitizeEmail(r.email);

      // Maximum retention: only reject when the row cannot be saved at all.
      // users.email is UNIQUE NOT NULL and is the login identifier, so an
      // unrecoverable address is the one genuinely fatal case. Every other
      // blank field is stored as NULL.
      if (!name) { rejected++; rejectedRows.push({ row: rowNo, name, email, error: "Missing name (cannot identify the person)" }); continue; }
      if (!isValidEmail(email)) { rejected++; rejectedRows.push({ row: rowNo, name, email: r.email, error: "Email could not be recovered (required as the unique login identifier)" }); continue; }
      /* batch and passing_year are NOT NULL. A row without a usable year used to
         reach the INSERT and abort the TRANSACTION, so one bad line in a
         two-hundred-row roster failed the entire import with a 500 and no
         indication of which line was at fault. It is now an ordinary per-row
         rejection, reported by row number like every other one. */
      const rowYear = parseInt(r.hscPassingYear, 10);
      if (!Number.isInteger(rowYear) || rowYear < 1960 || rowYear > 2100) {
        rejected++;
        rejectedRows.push({ row: rowNo, name, email,
          error: "HSC passing year is missing or not a year between 1960 and 2100 (required: it is the batch)" });
        continue;
      }

      /* The row's department, resolved and scope-checked before anything is
         written. An unrecognised name is not an error — the institution's
         roster may legitimately carry a department this platform has not been
         told about — but it is reported, and the account is created without a
         department rather than with a guessed one. A department the importer
         may not reach IS an error. */
      const deptRaw = String(r.department || '').trim();
      let rowDepartment = null;
      if (deptRaw) {
        const found = deptByKey.get(deptRaw.toLowerCase());
        if (found) {
          if (!scope.canReach(req.user, found.id)) {
            rejected++;
            rejectedRows.push({ row: rowNo, name, email,
              error: `Department "${found.code}" is outside your scope — you cannot import into it` });
            continue;
          }
          rowDepartment = found;
        } else {
          unresolvedDepartments.push({ row: rowNo, supplied: deptRaw,
            reason: 'not a department this platform knows' });
        }
      } else if (importerScope.kind === 'department') {
        /* A department administrator importing a roster with no Department
           column is importing into their own department; there is nowhere else
           they could be importing to. */
        rowDepartment = { id: importerScope.departmentId, code: null, name: null };
      }

      // Record blanks for reporting; they never block the import.
      let missedAny = false;
      for (const f of OPTIONAL_FIELDS) {
        if (!r[f] || !String(r[f]).trim()) {
          missingFieldCounts[f] = (missingFieldCounts[f] || 0) + 1;
          missedAny = true;
        }
      }
      if (missedAny) withMissingOptional++;

      const mobileKey = normalizeMobile(r.mobile);

      // Same person appearing twice in the file. Under the "update" strategy
      // the later submission is allowed through so it can enrich the profile
      // created by the first — people resubmit the form to correct or complete
      // their entry, and discarding that loses real data.
      const isBatchDuplicate = seenEmail.has(email) || (mobileKey && seenMobile.has(mobileKey));
      if (isBatchDuplicate && strategy === "skip") { skippedDuplicate++; continue; }
      seenEmail.add(email);
      if (mobileKey) seenMobile.add(mobileKey);

      // Duplicates against existing accounts — email first, then mobile.
      const existing = await client.query(
        `SELECT u.id FROM users u
         LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
         WHERE LOWER(u.email) = $1
            OR ($2::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(COALESCE(ap.mobile_number,''), '\\D', '', 'g'), 10) = $2)
         LIMIT 1`,
        [email, mobileKey]
      );

      const year = rowYear;

      /* Location, resolved against the reference places. Four outcomes, and
         none of them is "assume Dhaka":
           resolved      → the place is stored, and the row counts as confirmed
                           because a person supplied it, not a default
           empty         → no location in the file; stored as NULL
           unknown/other → reported back to the administrator and stored as NULL
         The free-text city/country are also stored so the operator can see what
         the file actually said next to what could be matched. */
      const loc = await location.resolvePlace(client, { country: r.country, city: r.city });
      if (loc.status !== 'resolved' && loc.status !== 'empty') {
        unresolvedLocations.push({
          row: rowNo, name,
          supplied: [location.clean(r.city), location.clean(r.country)].filter(Boolean).join(', '),
          reason: loc.reason
        });
      }

      const profileVals = [
        year,                                   // batch + passing_year
        normalizeBloodGroup(r.bloodGroup),
        (r.presentAddress || "").trim() || null,
        normalizeOccupation(r.occupation),
        (r.organization || "").trim() || null,  // Current Organization / Institution
        (r.designation || "").trim() || null,   // Current Designation
        normalizeHscGroup(r.hscGroup),
        (r.hscVersion || "").trim() || null,
        (r.photoUrl || "").trim() || null,
        (r.facebook || "").trim() || null,
        (r.mobile || "").trim() || null,
        loc.placeId,                                            // $13 place_id
        loc.place ? loc.place.city : null,                      // $14 city
        loc.place ? loc.place.country : null,                   // $15 country
        loc.place ? loc.place.division : null,                  // $16 division
        loc.place ? loc.place.district : location.clean(r.district), // $17 district
        (r.permanentAddress || "").trim() || null,              // $18
        location.clean(r.hometown),                             // $19
        (r.postalCode || "").trim() || null                     // $20
      ];

      if (existing.rows.length > 0) {
        if (strategy === "skip") { skippedDuplicate++; continue; }
        // Non-null values from this row overwrite; blanks leave the stored
        // value intact (COALESCE below), so nothing is lost either way.
        // update / merge: refresh the profile, never touch the password.
        const uid = existing.rows[0].id;
        await client.query(
          `UPDATE alumni_profiles SET
             batch = COALESCE($2, batch), passing_year = COALESCE($2, passing_year),
             blood_group = COALESCE($3, blood_group), present_address = COALESCE($4, present_address),
             occupation = COALESCE($5, occupation), current_company = COALESCE($6, current_company),
             job_title = COALESCE($7, job_title), hsc_group = COALESCE($8, hsc_group),
             hsc_version = COALESCE($9, hsc_version), photo_url = COALESCE($10, photo_url),
             facebook = COALESCE($11, facebook), mobile_number = COALESCE($12, mobile_number),
             place_id = COALESCE($13, place_id),
             city = COALESCE($14, city), country = COALESCE($15, country),
             division = COALESCE($16, division), district = COALESCE($17, district),
             permanent_address = COALESCE($18, permanent_address),
             hometown = COALESCE($19, hometown), postal_code = COALESCE($20, postal_code),
             /* A row the institution supplied a matched location for is
                confirmed; a blank leaves whatever state the profile was in. */
             location_needs_confirmation = CASE WHEN $13::int IS NOT NULL
                                                THEN FALSE ELSE location_needs_confirmation END,
             updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1`,
          [uid, ...profileVals]
        );
        updated++;
        continue;
      }

      // New account. The shared initial password is hashed with scrypt before
      // insertion and flagged so the user is asked to change it on first login.
      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
        .map(w => w[0]).join("").toUpperCase().slice(0, 2) || "AL";

      /* role, is_verified, must_change_password, status and created_via are all
         literals here, never read from the file. A roster that carries a Role
         column saying super_admin imports an ordinary alumni member, because
         nothing in this statement consults the row for any of them. */
      const userRes = await client.query(
        `INSERT INTO users (email, password_hash, full_name, initials, role, role_label,
                            department, is_verified, must_change_password, created_via,
                            import_batch_id, department_id)
         VALUES ($1,$2,$3,$4,'alumni','Alumni Member',$5,TRUE,TRUE,'bulk_import',$6,$7)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        /* users.department keeps the display label. It reads the department
           name where the file gave one, and falls back to the HSC group only
           where it did not — which is what it always did, and is now visibly a
           fallback rather than the definition. department_id is the authority. */
        [email, passwordHash, name, initials,
         (rowDepartment && rowDepartment.name) || normalizeHscGroup(r.hscGroup) || "General",
         batchId, rowDepartment ? rowDepartment.id : null]
      );
      if (userRes.rows.length === 0) { skippedDuplicate++; continue; }
      const uid = userRes.rows[0].id;

      /* This INSERT used to end in `'Dhaka','Bangladesh'`, so every imported
         alumnus was recorded as living in Dhaka whatever the file said. It now
         stores what the file said, matched to a reference place, or nothing at
         all. location_needs_confirmation stays FALSE for an imported location:
         it came from the institution's own records, which is a source, unlike
         a literal in a query. */
      await client.query(
        `INSERT INTO alumni_profiles
           (user_id, student_id, batch, passing_year, department, primary_email,
            blood_group, present_address, occupation, current_company, job_title,
            hsc_group, hsc_version, photo_url, facebook, mobile_number,
            place_id, city, country, division, district,
            permanent_address, hometown, postal_code, department_id)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 $16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [uid, await uniqueStudentId(client, year, uid), year,
         (rowDepartment && rowDepartment.name) || normalizeHscGroup(r.hscGroup) || "General", email,
         profileVals[1], profileVals[2], profileVals[3], profileVals[4], profileVals[5],
         profileVals[6], profileVals[7], profileVals[8], profileVals[9], profileVals[10],
         profileVals[11], profileVals[12], profileVals[13], profileVals[14], profileVals[15],
         profileVals[16], profileVals[17], profileVals[18],
         rowDepartment ? rowDepartment.id : null]
      );
      created++;
    }

    await client.query(
      `UPDATE import_history
          SET success_count = $2, failed_count = $3, duplicate_count = $4
        WHERE id = $1`,
      [batchId, created, rejected, skippedDuplicate]
    );

    if (dryRun) {
      /* Nothing above reaches the database. The accounts, the profiles and the
         batch row are all discarded, and the counts the caller is about to read
         were produced by the real import doing the real work. */
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    /* The filename comes from the client and is unvalidated, so it is bounded
       and stripped of anything that would let it impersonate the surrounding
       log structure. An exported roster's filename can also carry personal
       data, which is another reason not to take it whole. */
    const safeName = String(filename || 'import.csv').replace(/[^\w.\- ]+/g, '').slice(0, 60);
    /* A dry run is recorded too, as a dry run. It reads the whole roster and is
       a disclosure of personal data even though it changes nothing, and an
       administrator who runs twenty of them should leave twenty marks. */
    /* An import can add hundreds of accounts, and until now the only trace
       another administrator could find was an audit entry they would have to go
       looking for. A bulk change to the alumni body is something the people who
       administer it should be told about, not something they should have to
       discover. A dry run changed nothing and is not announced. */
    if (!dryRun && (created > 0 || updated > 0)) {
      /* The name is read from the account, not from req.user (the token carries
         only uid, role and expiry) and not from req.body.adminName, which the
         caller chooses. */
      const actor = (await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.uid]))
        .rows[0]?.full_name || 'an administrator';
      for (const role of ADMIN_ROLES) {
        await db.query(
          `INSERT INTO notifications (target_role, icon, title, subtitle, link_entity, link_id)
           VALUES ($1, '📥', 'Bulk Import Completed', $2, 'import', $3)`,
          [role,
           `${created} account(s) created and ${updated} profile(s) enriched from a roster, ` +
           `by ${actor}.`,
           batchId]);
      }
    }

    await writeAuditSafe(dryRun ? "Bulk Import Dry Run" : "Bulk Import Completed",
      `${safeName}: ${created} created, ${updated} updated, ${skippedDuplicate} duplicates, ${rejected} rejected` +
      `; enrolment: ${passwordStrategy}` +
      (dryRun ? ' (nothing written)' : ''),
      '📥', auditCtx(req, 'import', dryRun ? null : batchId));

    res.json({
      success: true,
      total: records.length,
      count: created, created, updated,
      skipped: skippedDuplicate, duplicates: skippedDuplicate,
      rejected, rejectedRows: rejectedRows.slice(0, 100),
      withMissingOptional, missingFieldCounts,
      /* Locations the file supplied that could not be matched to a reference
         place. These rows imported fine, without a location. Reported in full
         rather than counted, because "8 unrecognised cities" is not actionable
         and "row 41: Chattogram Sadar" is. */
      unresolvedLocations: unresolvedLocations.slice(0, 100),
      unresolvedLocationCount: unresolvedLocations.length,
      unresolvedDepartments: unresolvedDepartments.slice(0, 100),
      unresolvedDepartmentCount: unresolvedDepartments.length,
      dryRun,
      /* A dry run has no batch to report and no batch to roll back: the row it
         wrote was rolled back with everything else. */
      batchId: dryRun ? null : batchId,
      passwordStrategy,
      // Shown once, to the administrator who ran this import, so they can pass
      // it on. Omitted when the batch created nobody, and withheld entirely on
      // a dry run — no account exists to use it, and a credential shown for a
      // thing that did not happen is a credential shown for no reason. Under
      // 'invite' there is nothing to show, because nothing was generated.
      temporaryPassword: !dryRun && created > 0 ? batchPassword : null
    });
  } catch (err) {
    await client.query("ROLLBACK");
    serverError(res, err, 'api');
  } finally {
    client.release();
  }
});

// Import audit trail — the wizard used to keep this in a local array only.
/* Each batch now reports who ran it as an account rather than as a typed name,
   how many of the accounts it created still exist, and whether it can still be
   undone. The last of those is computed, not stored: a batch becomes
   un-rollbackable the moment somebody signs in to one of its accounts, and
   nothing fires an event when that happens. */
app.get('/api/import-history', requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const result = await db.query(`
      SELECT h.*,
             actor.full_name  AS created_by_name,
             undoer.full_name AS rolled_back_by_name,
             COALESCE(m.accounts, 0)::int  AS accounts_present,
             COALESCE(m.signed_in, 0)::int AS accounts_signed_in
      FROM import_history h
      LEFT JOIN users actor  ON actor.id  = h.created_by
      LEFT JOIN users undoer ON undoer.id = h.rolled_back_by
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS accounts,
               COUNT(*) FILTER (WHERE u.last_login_at IS NOT NULL) AS signed_in
        FROM users u WHERE u.import_batch_id = h.id
      ) m ON TRUE
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT $1`, [limit]);

    res.json(result.rows.map(r => ({
      ...r,
      /* Spelled out rather than left as a boolean, because "you cannot undo
         this" without a reason is the kind of message an operator argues with. */
      rollback: rollbackEligibility(r)
    })));
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Why a batch can or cannot be rolled back. Used by the history endpoint to
   describe it and by the rollback endpoint to decide it, so the interface can
   never offer an action the server will refuse. */
function rollbackEligibility(row) {
  if (row.status === 'rolled_back') {
    return { allowed: false, reason: 'This batch has already been rolled back.' };
  }
  if (!row.accounts_present) {
    /* Every batch imported before this was built is in this state. There is no
       honest way to work out which accounts it created, and guessing would mean
       deleting somebody. */
    return { allowed: false, reason: row.success_count > 0
      ? 'This batch predates rollback support, so the accounts it created cannot be identified.'
      : 'This batch created no accounts, so there is nothing to undo.' };
  }
  if (row.accounts_signed_in > 0) {
    return { allowed: false, reason:
      `${row.accounts_signed_in} of these accounts has been signed in to. ` +
      'An account somebody has used is theirs, not the import\u2019s.' };
  }
  return { allowed: true, reason: `${row.accounts_present} account(s) created by this batch and never used.` };
}

/* ─── BATCH ROLLBACK ───────────────────────────────────────
   Undoes an import by deleting the accounts it created — and only those. An
   account the batch merely enriched existed beforehand and is left alone; so
   is every account somebody has since signed in to.

   The bar is deliberately high. Rollback exists for the case an operator
   actually has: the wrong file, noticed within minutes. It is not a general
   undo, and it does not try to be one, because past that first few minutes the
   accounts have started accumulating a person's own activity and deleting them
   destroys that person's data rather than the operator's mistake.

   Audit history is never deleted. audit_logs.actor_id is ON DELETE SET NULL, so
   what these accounts did survives them, and the rollback itself is recorded. */
app.post('/api/import-batches/:id/rollback', requireRole(...ADMIN_ROLES), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'A batch id is required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    /* FOR UPDATE, so two administrators clicking at once cannot both pass the
       eligibility check and both delete. */
    const batch = await client.query(
      `SELECT h.*,
              COALESCE(m.accounts, 0)::int  AS accounts_present,
              COALESCE(m.signed_in, 0)::int AS accounts_signed_in
       FROM import_history h
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS accounts,
                COUNT(*) FILTER (WHERE u.last_login_at IS NOT NULL) AS signed_in
         FROM users u WHERE u.import_batch_id = h.id
       ) m ON TRUE
       WHERE h.id = $1
       FOR UPDATE OF h`, [id]);

    if (!batch.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No such import batch.' });
    }

    const row = batch.rows[0];
    const eligible = rollbackEligibility(row);
    if (!eligible.allowed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: eligible.reason, code: 'rollback_refused' });
    }

    /* An account with activity against it is not the import's to delete either,
       even if nobody has signed in — staff can register somebody for an event,
       or record a donation on their behalf. Checked explicitly rather than left
       to the cascades, which would have removed the registration silently. */
    const activity = await client.query(`
      SELECT COUNT(*)::int AS n FROM users u
      WHERE u.import_batch_id = $1 AND (
        EXISTS (SELECT 1 FROM event_registrations r WHERE r.user_id = u.id) OR
        EXISTS (SELECT 1 FROM donations d          WHERE d.donor_user_id = u.id) OR
        EXISTS (SELECT 1 FROM job_applications a   WHERE a.applicant_id = u.id) OR
        EXISTS (SELECT 1 FROM mentorships m        WHERE m.mentor_id = u.id OR m.mentee_id = u.id) OR
        EXISTS (SELECT 1 FROM chapter_memberships c WHERE c.user_id = u.id) OR
        EXISTS (SELECT 1 FROM poll_votes v         WHERE v.user_id = u.id) OR
        EXISTS (SELECT 1 FROM stories st           WHERE st.author_id = u.id)
      )`, [id]);

    if (activity.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${activity.rows[0].n} of these accounts has activity recorded against it ` +
               '(a registration, donation, application, mentorship, membership, vote or story). ' +
               'Rollback would destroy that as well, so it is refused.',
        code: 'rollback_refused'
      });
    }

    const deleted = await client.query(
      'DELETE FROM users WHERE import_batch_id = $1 RETURNING id, email', [id]);

    await client.query(
      `UPDATE import_history
          SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP,
              rolled_back_by = $2, rolled_back_count = $3
        WHERE id = $1`,
      [id, req.user.uid, deleted.rowCount]);

    await client.query('COMMIT');

    /* The batch code and the count, never the addresses. A roster of everyone
       an import created is exactly the kind of thing an audit log should not
       become, and the accounts are gone in any case. */
    /* Deleting accounts is the most destructive thing this platform does on
       purpose. Every administrator is told, by name and by count — never by
       listing who was removed, which would put a roster of deleted people into
       a notifications table that outlives them. */
    const undoer = (await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.uid]))
      .rows[0]?.full_name || 'an administrator';
    for (const role of ADMIN_ROLES) {
      await db.query(
        `INSERT INTO notifications (target_role, icon, title, subtitle, link_entity, link_id)
         VALUES ($1, '↩', 'Import Rolled Back', $2, 'import', $3)`,
        [role,
         `${row.batch_code}: ${deleted.rowCount} imported account(s) were removed by ` +
         `${undoer}.`,
         id]);
    }

    await writeAuditSafe('Import Batch Rolled Back',
      `${row.batch_code}: ${deleted.rowCount} account(s) deleted`,
      '↩', auditCtx(req, 'import', id));

    res.json({ success: true, batchId: id, batchCode: row.batch_code, deleted: deleted.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    serverError(res, err, 'api');
  } finally {
    client.release();
  }
});

/* ─── 10. EVENTS ───
   Events, ticketing, check-in, tasks, people and the directory lookup all
   live in routes_events.js as of v5. The endpoints that used to sit here
   (/api/events/planner/:id, /api/events/proposals, /api/events/budgets,
   /api/events/sponsors, /api/events/tasks, /api/events/procurement and
   /api/events/ai-estimate) were a second, older implementation of the same
   features and have been removed so there is one source of truth. */

/* ============================================================
   MOUNTED ROUTE MODULES
   Registered before the SPA catch-all so /api/* resolves first.
   ============================================================ */

/* ─── 9. REAL PLATFORM STATISTICS ───────────────────────────
   Every number the dashboards, analytics page and map used to show was written
   into the markup by hand: 12,847 alumni, ৳45.2L raised, 1,203 mentorships, 47
   countries. None of it came from the database, and none of it was true. These
   endpoints are the single source for those figures, and each one is a COUNT or
   SUM over the rows that actually exist. Where a figure cannot be derived from
   stored data, it is not returned at all — the interface then shows nothing
   rather than something invented.

   Two stored counters exist that this deliberately ignores:
   chapters.members_count and campaigns.raised_amount. Both were seeded with
   values far larger than the rows behind them (18,420 against 0 memberships;
   ৳18.45L against ৳5,000 of settled donations) and both can drift, so neither
   is authoritative here. */

// Aggregates every signed-in user may see, plus the staff-only block.
app.get('/api/stats/overview', requireAuth, async (req, res) => {
  try {
    const isStaff = MODERATOR_ROLES.includes(req.user.role);
    const uid = req.user.uid;

    const [core, mine] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users)                                        AS users_total,
          (SELECT COUNT(*)::int FROM users WHERE is_verified)                      AS users_verified,
          (SELECT COUNT(*)::int FROM users WHERE NOT is_verified)                  AS users_unverified,
          (SELECT COUNT(*)::int FROM alumni_profiles)                              AS profiles_total,
          (SELECT COUNT(*)::int FROM events)                                       AS events_total,
          -- starts_on is the real DATE column; events.event_date is a display
          -- string ("Aug 15, 2026" in some rows, "15 Mar 2026" in others).
          (SELECT COUNT(*)::int FROM events
             WHERE status <> 'cancelled' AND starts_on >= CURRENT_DATE)            AS events_upcoming,
          (SELECT COUNT(*)::int FROM event_registrations)                          AS registrations_total,
          (SELECT COUNT(*)::int FROM jobs)                                         AS jobs_total,
          (SELECT COUNT(*)::int FROM job_applications)                             AS job_applications_total,
          (SELECT COUNT(*)::int FROM mentorships WHERE status = 'accepted')          AS mentorships_active,
          (SELECT COUNT(*)::int FROM mentorships)                                  AS mentorships_total,
          (SELECT COUNT(*)::int FROM chapters WHERE status = 'approved')           AS chapters_total,
          (SELECT COUNT(*)::int FROM chapter_memberships)                          AS chapter_memberships_total,
          (SELECT COUNT(*)::int FROM connections WHERE status = 'accepted')        AS connections_total,
          (SELECT COUNT(*)::int FROM stories WHERE status = 'published')            AS stories_total,
          (SELECT COUNT(*)::int FROM polls
            WHERE status = 'open' AND (closes_at IS NULL OR closes_at > CURRENT_TIMESTAMP))  AS polls_active,
          -- Money: settled donations only. donations.status is one of
          -- PENDING / SUCCESS / FAILED / REFUNDED, so SUCCESS is "settled".
          (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE status = 'SUCCESS')       AS donations_total,
          (SELECT COUNT(*)::int FROM donations WHERE status = 'SUCCESS')                  AS donations_count,
          (SELECT COUNT(DISTINCT donor_user_id)::int FROM donations WHERE status = 'SUCCESS') AS donors_count
      `),
      db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND is_unread)   AS my_unread_notifications,
          (SELECT COUNT(*)::int FROM event_registrations WHERE user_id = $1)             AS my_registrations,
          (SELECT COUNT(*)::int FROM chapter_memberships WHERE user_id = $1)             AS my_chapters,
          (SELECT COUNT(*)::int FROM job_applications WHERE applicant_id = $1)           AS my_job_applications,
          (SELECT COUNT(*)::int FROM connections
             WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1))     AS my_connections,
          (SELECT COUNT(*)::int FROM mentorships
             WHERE status = 'accepted' AND (mentor_id = $1 OR mentee_id = $1))             AS my_mentorships,
          (SELECT COALESCE(SUM(amount), 0) FROM donations
             WHERE status = 'SUCCESS' AND donor_user_id = $1)                            AS my_donations_total,
          (SELECT COUNT(*)::int FROM event_task_assignees WHERE user_id = $1)            AS my_assigned_tasks
      `, [uid])
    ]);

    const out = { ...core.rows[0], ...mine.rows[0] };
    out.donations_total = Number(out.donations_total);
    out.my_donations_total = Number(out.my_donations_total);

    if (isStaff) {
      const staff = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE NOT is_verified)                        AS pending_verifications,
          (SELECT COUNT(*)::int FROM chapters WHERE status = 'pending_review')           AS pending_chapters,
          (SELECT COUNT(*)::int FROM stories WHERE status = 'pending_review')                   AS pending_stories,
          (SELECT COUNT(*)::int FROM events WHERE approval_status = 'pending_approval')           AS pending_events,
          (SELECT COUNT(*)::int FROM event_tasks)                                        AS tasks_total,
          (SELECT COUNT(*)::int FROM event_tasks WHERE status = 'completed')             AS tasks_completed,
          (SELECT COUNT(*)::int FROM audit_logs)                                         AS audit_entries,
          (SELECT COUNT(*)::int FROM import_history)                                     AS imports_total,
          (SELECT COUNT(*)::int FROM broadcasts)                                         AS broadcasts_total,
          (SELECT COUNT(*)::int FROM custom_fields)                                      AS custom_fields_total
      `);
      Object.assign(out, staff.rows[0]);
      out.moderation_pending = out.pending_chapters + out.pending_stories + out.pending_events;
    }

    res.json(out);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Analytics figures, staff only. Returns only metrics that have rows behind
   them; the caller renders an empty state for anything absent. Deliberately no
   growth percentages, month-over-month deltas or trend lines: nothing in the
   schema records a historical snapshot to compare against, so any such number
   would be fabricated. */
app.get('/api/stats/analytics', requireRole(...MODERATOR_ROLES), async (req, res) => {
  try {
    const [totals, byDept, byBatch, campaigns, gateways, eventRoi] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users)                                   AS users,
          (SELECT COUNT(*)::int FROM alumni_profiles)                         AS profiles,
          (SELECT COUNT(*)::int FROM events)                                  AS events,
          (SELECT COUNT(*)::int FROM event_registrations)                     AS registrations,
          (SELECT COUNT(*)::int FROM jobs)                                    AS jobs,
          (SELECT COUNT(*)::int FROM job_applications)                        AS job_applications,
          (SELECT COUNT(*)::int FROM mentorships)                             AS mentorships,
          (SELECT COUNT(*)::int FROM chapter_memberships)                     AS chapter_memberships,
          (SELECT COUNT(*)::int FROM connections WHERE status = 'accepted')   AS connections,
          (SELECT COUNT(*)::int FROM donations WHERE status = 'SUCCESS')      AS donations,
          (SELECT COALESCE(SUM(amount),0) FROM donations WHERE status='SUCCESS') AS donations_amount
      `),
      db.query(`SELECT department, COUNT(*)::int AS n FROM alumni_profiles
                WHERE department IS NOT NULL AND department <> ''
                GROUP BY department ORDER BY n DESC, department`),
      db.query(`SELECT batch, COUNT(*)::int AS n FROM alumni_profiles
                WHERE batch IS NOT NULL GROUP BY batch ORDER BY batch`),
      db.query(`
        SELECT c.id, c.name, c.goal_amount,
               COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'SUCCESS'), 0)      AS raised,
               COUNT(d.id) FILTER (WHERE d.status = 'SUCCESS')::int                AS payments,
               COUNT(DISTINCT d.donor_user_id) FILTER (WHERE d.status='SUCCESS')::int AS donors
        FROM campaigns c LEFT JOIN donations d ON d.campaign_id = c.id
        GROUP BY c.id, c.name, c.goal_amount ORDER BY c.id`),
      db.query(`SELECT payment_gateway, COUNT(*)::int AS n,
                       COALESCE(SUM(amount),0) AS amount
                FROM donations WHERE status = 'SUCCESS'
                GROUP BY payment_gateway ORDER BY amount DESC`),
      // Ticket revenue is the sum of what registrations actually paid, so a free
      // event reports 0 rather than capacity x list price.
      db.query(`
        SELECT e.id, e.title, e.starts_on, e.capacity,
               COUNT(r.id)::int                       AS registrations,
               COALESCE(SUM(r.amount_paid), 0)        AS revenue
        FROM events e LEFT JOIN event_registrations r ON r.event_id = e.id
        GROUP BY e.id, e.title, e.starts_on, e.capacity
        ORDER BY e.starts_on DESC NULLS LAST, e.id DESC`)
    ]);

    const t = totals.rows[0];
    t.donations_amount = Number(t.donations_amount);

    res.json({
      totals: t,
      byDepartment: byDept.rows,
      byBatch: byBatch.rows,
      campaigns: campaigns.rows.map(c => ({
        ...c,
        goal_amount: Number(c.goal_amount),
        raised: Number(c.raised)
      })),
      gateways: gateways.rows.map(g => ({ ...g, amount: Number(g.amount) })),
      events: eventRoi.rows.map(e => ({ ...e, revenue: Number(e.revenue) }))
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Where alumni actually are, from alumni_profiles.country / .city. The map used
   to draw fixed clusters totalling 12,847 people across 47 countries. */
/* Alumni map data.
   Aggregates only — a count attached to a city, never a row attached to a
   person. Three properties hold by construction rather than by care:

   - Coordinates come from location_places. There is no coordinate anywhere in
     the system that describes where a person lives, so none can leak here.
   - Only profiles whose location privacy is 'public' are counted. 'alumni'
     means visible on a profile but not plotted; 'private' means neither.
   - Nothing identifies anybody. No id, no name, no row — just how many.

   `unconfirmed` is reported separately and is NOT plotted. Those are the rows
   the pre-v13 hardcoded path wrote, and putting them on a map would republish
   the fabrication this phase was opened to remove. The interface says how many
   are waiting rather than quietly drawing them. */
app.get('/api/stats/map', requireAuth, async (req, res) => {
  try {
    const [cities, countries, divisions, totals] = await Promise.all([
      db.query(`
        SELECT lp.id AS place_id, lp.city, lp.country, lp.country_code,
               lp.division, lp.district,
               lp.latitude::float8 AS latitude, lp.longitude::float8 AS longitude,
               COUNT(*)::int AS n
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE ${privacy.MAP_VISIBLE_SQL}
         GROUP BY lp.id, lp.city, lp.country, lp.country_code, lp.division,
                  lp.district, lp.latitude, lp.longitude
         ORDER BY n DESC, lp.city`),
      /* Country rollup. `cities` is the number of distinct places alumni are
         actually in, and latitude/longitude is the alumni-weighted mean of
         those city coordinates.

         That position is NOT a country centroid and carries no claim about
         borders. It is "where this country's alumni are, on average", which is
         a statement about the alumni and is exactly what the badge reports.
         The map does draw real country boundaries (Natural Earth), but they
         are drawn from that geometry — this position is never used as one.
         Computed here so the browser only ever draws what the server counted. */
      db.query(`
        SELECT lp.country, lp.country_code,
               COUNT(*)::int AS n,
               COUNT(DISTINCT lp.id)::int AS cities,
               (SUM(lp.latitude)  / COUNT(*))::float8 AS latitude,
               (SUM(lp.longitude) / COUNT(*))::float8 AS longitude
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE ${privacy.MAP_VISIBLE_SQL}
         GROUP BY lp.country, lp.country_code
         ORDER BY n DESC, lp.country`),
      /* Phase 7G — the Bangladesh view. Same privacy gate as every other
         rollup on this endpoint, so a member whose location is not public is
         absent here exactly as they are absent from the city and country
         layers. The position is the alumni-weighted mean of the division's
         city coordinates: it is "where this division's alumni are", not a
         division centroid. Real division and district polygons ARE drawn in
         the Bangladesh view (geoBoundaries, see tools/build_geo.js), and they
         come from that geometry — this weighted position is deliberately NOT
         used as a boundary or a centroid, only as the badge's anchor. */
      db.query(`
        SELECT lp.division,
               COUNT(*)::int AS n,
               COUNT(DISTINCT lp.id)::int AS cities,
               (SUM(lp.latitude)  / COUNT(*))::float8 AS latitude,
               (SUM(lp.longitude) / COUNT(*))::float8 AS longitude
          FROM alumni_profiles ap
          JOIN location_places lp ON lp.id = ap.place_id
         WHERE lp.country = 'Bangladesh' AND lp.division IS NOT NULL
           AND ${privacy.MAP_VISIBLE_SQL}
         GROUP BY lp.division
         ORDER BY n DESC, lp.division`),
      db.query(`
        SELECT COUNT(*)::int AS profiles,
               COUNT(*) FILTER (WHERE ap.place_id IS NOT NULL)::int AS confirmed,
               COUNT(*) FILTER (WHERE ap.place_id IS NOT NULL AND ${privacy.MAP_VISIBLE_SQL})::int AS mapped,
               COUNT(*) FILTER (WHERE ap.location_needs_confirmation)::int AS unconfirmed,
               COUNT(*) FILTER (WHERE ap.place_id IS NULL AND NOT ap.location_needs_confirmation)::int AS not_set
          FROM alumni_profiles ap`)
    ]);

    const t = totals.rows[0];
    res.json({
      cities: cities.rows,
      countries: countries.rows,
      /* Phase 7G. Bangladesh divisions, for the focused view. Empty is a real
         answer: it means no member with a public location has a Bangladeshi
         division recorded, and the view says so rather than drawing nothing
         and looking broken. */
      divisions: divisions.rows,
      profiles: t.profiles,
      confirmed: t.confirmed,
      mapped: t.mapped,
      unconfirmed: t.unconfirmed,
      notSet: t.not_set,
      in_bangladesh: countries.rows.filter(c => c.country_code === 'BD')
                                   .reduce((a, c) => a + c.n, 0),
      international: countries.rows.filter(c => c.country_code !== 'BD')
                                   .reduce((a, c) => a + c.n, 0),
      chapters: (await db.query(
        `SELECT COUNT(*)::int AS n FROM chapters WHERE status = 'approved'`)).rows[0].n
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* The permission matrix, generated from the guard constants this file actually
   enforces rather than from a second copy maintained by hand in the browser.
   ROLE_CAPABILITIES below is derived from ADMIN_ROLES / MODERATOR_ROLES, so the
   table can never disagree with the middleware. */
app.get('/api/stats/rbac', requireAuth, (req, res) => {
  const roles = ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin'];
  const capabilities = [
    { key: 'browse',      label: 'Browse directory, events, jobs and chapters', allowed: roles },
    { key: 'own_profile', label: 'Edit own profile and privacy settings',       allowed: roles },
    { key: 'register',    label: 'Register for events and hold tickets',        allowed: roles },
    { key: 'moderate',    label: 'Approve chapters, stories and profiles',      allowed: MODERATOR_ROLES },
    { key: 'events_manage', label: 'Create and manage events, tasks and people', allowed: MODERATOR_ROLES },
    { key: 'planner',     label: 'Event budget, sponsors, vendors, procurement', allowed: MODERATOR_ROLES },
    { key: 'broadcast',   label: 'Send broadcasts',                             allowed: MODERATOR_ROLES },
    { key: 'audit',       label: 'Read the immutable audit log',                allowed: ADMIN_ROLES },
    { key: 'bulk_import', label: 'Bulk-import alumni records',                  allowed: ADMIN_ROLES },
    { key: 'custom_fields', label: 'Define custom profile fields',              allowed: ADMIN_ROLES },
    { key: 'campaigns',   label: 'Create and edit donation campaigns',          allowed: ADMIN_ROLES },
    { key: 'compliance',  label: 'Identity vault and DSAR handling',            allowed: ADMIN_ROLES }
  ];
  res.json({
    roles,
    capabilities: capabilities.map(c => ({
      key: c.key,
      label: c.label,
      allowed: roles.filter(r => c.allowed.includes(r))
    }))
  });
});

/* The offline-sync ledger. sync_mutations is real and is written by the event
   registration path in routes_events.js, which uses client_mutation_id to make
   a retried registration idempotent. The admin panel that reads this used to
   show six invented queue entries — a 47.2 KB photo upload, a duplicate-checkin
   conflict, "247 synced today", a 99.8% success rate and a 3.8 MB payload
   against a 5 MB cap. None of those figures existed anywhere. */
app.get('/api/sync-mutations', requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT s.id, s.client_mutation_id, s.entity, s.action, s.applied, s.created_at,
             u.full_name AS user_name
      FROM sync_mutations s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 100
    `);
    const counts = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE applied)::int      AS applied,
             COUNT(*) FILTER (WHERE NOT applied)::int  AS unapplied
      FROM sync_mutations`);
    res.json({ mutations: rows.rows, ...counts.rows[0] });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Referral requests, so they stop disappearing into a black hole. POST
   /api/jobs/:id/refer has always written job_referrals rows, but nothing could
   read them back — no endpoint and no screen. This is the read path. */
app.get('/api/job-referrals', requireAuth, async (req, res) => {
  try {
    const isStaff = MODERATOR_ROLES.includes(req.user.role);
    // A poster sees requests against their own postings; staff see all.
    const rows = await db.query(`
      /* requester.email was returned to every reader of this list. A member
         who set email = 'private' had it disclosed to the person they asked
         for a referral, which is precisely the setting they had turned off.
         It now passes the same gate the directory uses: visible to the member
         themselves, to staff (email carries a staff bypass), and to anyone
         else only while the member has left it visible. */
      SELECT r.id, r.job_id, r.message, r.status, r.created_at, r.responded_at,
             r.requester_id, r.referrer_id,
             j.title AS job_title, j.company,
             requester.full_name AS requester_name,
             CASE WHEN r.requester_id = $1 OR $3::boolean
                    OR COALESCE(rp.privacy_settings ->> 'email', 'public') <> 'private'
                  THEN requester.email END AS requester_email,
             referrer.full_name  AS referrer_name
      FROM job_referrals r
      JOIN jobs j ON j.id = r.job_id
      LEFT JOIN users requester ON requester.id = r.requester_id
      LEFT JOIN alumni_profiles rp ON rp.user_id = r.requester_id
      LEFT JOIN users referrer  ON referrer.id  = r.referrer_id
      WHERE $2::boolean OR r.referrer_id = $1 OR r.requester_id = $1
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 100
    `, [req.user.uid, isStaff, privacy.STAFF_ROLES.includes(req.user.role)]);
    res.json(rows.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Answering a referral. The request had a status column and no way to move
   it, so every row ever written stayed 'pending'.

   Only the person it was addressed to may answer — the job's poster. An
   administrator is deliberately NOT given this: accepting a referral is a
   personal vouching, not an administrative act, and nobody should be able to
   vouch on someone else's behalf. */
app.put('/api/job-referrals/:id', requireVerified, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  if (!['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'A referral is either accepted or declined' });
  }

  try {
    const row = await db.query(
      `SELECT r.id, r.status, r.requester_id, r.referrer_id, j.title
         FROM job_referrals r JOIN jobs j ON j.id = r.job_id
        WHERE r.id = $1`, [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Referral request not found' });

    const ref = row.rows[0];
    if (ref.referrer_id !== req.user.uid) {
      return res.status(403).json({ error: 'Only the person asked for the referral can answer it' });
    }
    if (ref.status !== 'pending') {
      return res.status(409).json({ error: `This request was already ${ref.status}` });
    }

    const updated = await db.query(
      `UPDATE job_referrals SET status = $2, responded_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING id, status, responded_at`, [id, status]);

    const me = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.uid]);
    await db.query(
      `INSERT INTO notifications (user_id, icon, title, subtitle)
       VALUES ($1, $2, $3, $4)`,
      [ref.requester_id,
       status === 'accepted' ? 'handshake' : 'circle-x',
       status === 'accepted' ? 'Referral accepted' : 'Referral declined',
       `${me.rows[0]?.full_name || 'The poster'} ${status} your referral request for ${ref.title}.`]);

    await writeAuditSafe(status === 'accepted' ? 'Referral Accepted' : 'Referral Declined',
      `referral ${id} by user ${req.user.uid}`, 'handshake',
      auditCtx(req, 'job_referral', id));

    res.json(updated.rows[0]);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Audience segmentation, staff only.

   The panel this serves used to be entirely invented. Its match count started
   at a literal 3,420 and every filter change called updateSegmentCount(), whose
   whole body was Math.floor(Math.random() * 2000) + 1500 — a fresh random
   number between 1,500 and 3,500 each time, presented as "Alumni matched"
   beside a badge reading "Real-Time Vector Filtering". The filter options were
   invented too: a batch range of 2000-2026 over profiles that run 2014-2021,
   and three industry domains that did not match the values in the column.

   GET /api/segment/options returns the values that exist; GET /api/segment/count
   counts the profiles a filter combination actually selects. */
app.get('/api/segment/options', requireRole(...MODERATOR_ROLES), async (req, res) => {
  try {
    const [batches, depts, industries, span] = await Promise.all([
      db.query(`SELECT DISTINCT batch FROM alumni_profiles WHERE batch IS NOT NULL ORDER BY batch`),
      db.query(`SELECT department, COUNT(*)::int AS n FROM alumni_profiles
                WHERE department IS NOT NULL AND department <> '' GROUP BY department ORDER BY n DESC, department`),
      db.query(`SELECT industry, COUNT(*)::int AS n FROM alumni_profiles
                WHERE industry IS NOT NULL AND industry <> '' GROUP BY industry ORDER BY n DESC, industry`),
      db.query(`SELECT MIN(batch)::int AS min_batch, MAX(batch)::int AS max_batch,
                       COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE can_mentor)::int AS mentors
                FROM alumni_profiles`)
    ]);
    res.json({
      batches: batches.rows.map(r => r.batch),
      departments: depts.rows,
      industries: industries.rows,
      ...span.rows[0],
      // Donor status is derived from settled donations, not a stored flag.
      donors: (await db.query(
        `SELECT COUNT(DISTINCT donor_user_id)::int AS n FROM donations WHERE status = 'SUCCESS'`)).rows[0].n
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Counts the alumni profiles a filter combination selects, and returns the
   same filters back so the caller can show what was counted. Every filter maps
   to a column that exists; there is no filter here the query cannot honour. */
app.get('/api/segment/count', requireRole(...MODERATOR_ROLES), async (req, res) => {
  const { batchFrom, batchTo, department, industry, donor, mentor } = req.query;
  const where = ['1=1'];
  const params = [];

  const from = parseInt(batchFrom, 10);
  const to = parseInt(batchTo, 10);
  if (Number.isInteger(from)) { params.push(from); where.push(`ap.batch >= $${params.length}`); }
  if (Number.isInteger(to))   { params.push(to);   where.push(`ap.batch <= $${params.length}`); }
  if (department && department !== 'all') { params.push(department); where.push(`ap.department = $${params.length}`); }
  if (industry && industry !== 'all')     { params.push(industry);   where.push(`ap.industry = $${params.length}`); }
  if (mentor === 'true') where.push('ap.can_mentor = TRUE');

  if (donor === 'donors') {
    where.push(`EXISTS (SELECT 1 FROM donations d WHERE d.donor_user_id = u.id AND d.status = 'SUCCESS')`);
  } else if (donor === 'nondonors') {
    where.push(`NOT EXISTS (SELECT 1 FROM donations d WHERE d.donor_user_id = u.id AND d.status = 'SUCCESS')`);
  }

  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS matched
      FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id
      WHERE ${where.join(' AND ')}
    `, params);
    const total = (await db.query(
      'SELECT COUNT(*)::int AS n FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id')).rows[0].n;
    res.json({ matched: r.rows[0].matched, total, filters: { batchFrom, batchTo, department, industry, donor, mentor } });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Verify an account. The Approve button on the verification queue used to raise
   a toast reading "<name> approved successfully" and change nothing at all — the
   account stayed unverified and the same two invented people reappeared on the
   next render. This writes users.is_verified. */
app.put('/api/users/:id/verify', requireRole(...MODERATOR_ROLES), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });
  const verified = req.body?.verified !== false;
  try {
    /* Whose account this is decides whether this caller may touch it, and the
       answer comes from the database rather than from anything in the request.
       Changing ?id= to somebody in another department reaches this check, not
       the UPDATE. */
    const target = await db.query('SELECT department_id FROM users WHERE id = $1', [id]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    if (!scope.canReach(req.user, target.rows[0].department_id)) {
      return res.status(403).json(scope.OUT_OF_SCOPE);
    }

    const r = await db.query(
      'UPDATE users SET is_verified = $1 WHERE id = $2 RETURNING id, full_name, is_verified',
      [verified, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    await writeAuditSafe(verified ? 'Alumni Verified' : 'Verification Revoked',
      `user ${id} by user ${req.user.uid}`, '🛡', auditCtx(req, 'user', id));
    res.json(r.rows[0]);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* Accounts still awaiting verification — the real queue behind the dashboard
   panel that used to list two invented people. */
app.get('/api/verification-queue', requireRole(...MODERATOR_ROLES), async (req, res) => {
  try {
    /* A department admin is offered only the accounts it may actually verify.
       Listing one it would then be refused is worse than not listing it: it
       reads as a broken button rather than as a boundary. */
    const params = [];
    const where = 'WHERE NOT u.is_verified' + scope.sqlFor(req.user, 'u.department_id', params);
    const rows = await db.query(`
      SELECT u.id, u.full_name, u.initials, u.email, u.department, u.created_at,
             ap.batch, ap.student_id, d.code AS department_code
      FROM users u
      LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
      LEFT JOIN departments d ON d.id = u.department_id
      ${where}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT 50
    `, params);
    res.json(rows.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* The department list a sign-up form needs, before anyone is signed in.

   Department names are not sensitive — they are printed on the alumni
   directory, on events and on the institution's own website. What this
   deliberately does NOT return is the alumni count each department carries,
   which the staff endpoint does: a headcount per department is an
   institutional figure and an unauthenticated caller has no business with it. */
app.get('/api/departments/public', async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, code, name FROM departments WHERE is_active ORDER BY name');
    res.json(rows.rows);
  } catch (err) {
    serverError(res, err, 'api');
  }
});

/* The department list. Readable by any staff role — a department's name and
   code are not sensitive, and every screen that shows or filters by department
   needs them. Members do not get it: they have no screen that uses it. */
app.get('/api/departments', requireRole(...MODERATOR_ROLES), async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT d.id, d.code, d.name, d.is_active,
             COUNT(ap.id)::int AS alumni
      FROM departments d
      LEFT JOIN alumni_profiles ap ON ap.department_id = d.id
      GROUP BY d.id
      ORDER BY d.name`);
    /* What the caller's own scope is, so the interface can say "Department:
       CSE" rather than asking an administrator to pick their own department
       every time they open a screen. */
    const mine = scope.scopeOf(req.user);
    res.json({
      departments: rows.rows,
      scope: {
        kind: mine.kind,
        departmentId: mine.departmentId,
        department: mine.departmentId
          ? rows.rows.find(d => d.id === mine.departmentId) || null
          : null
      }
    });
  } catch (err) {
    serverError(res, err, 'api');
  }
});

const guards = { requireAuth, requireVerified, requireRole, ADMIN_ROLES, MODERATOR_ROLES, serverError, scope };

// v2: events, ticketing, jobs, campaigns/donations, custom fields,
// mentorship, connections, polls, broadcasts, audit log.
const v2 = require('./routes_v2')(app, guards);
_writeAudit = v2.writeAudit;   // late-bind the audit writer declared above

// Events, tickets, tasks, people, directory (v5). Mounted before the planner
// so the /api/events/* namespace resolves here.
// Held so the scheduler can run the same sweep the HTTP endpoint runs.
const eventsModule = require('./routes_events')(app, { ...guards, writeAudit: v2.writeAudit });

// Event "Advanced" modules: budget, sponsors, vendors, marketing, meetings,
// risks, committees, volunteers, logistics, timeline. Staff-only.
require('./routes_planner')(app, { ...guards, writeAudit: v2.writeAudit });

// Administrator account provisioning and lifecycle. Super admin only; these are
// ordinary users rows, not a second identity system.
require('./routes_admin_users')(app, {
  ...guards, SUPER_ONLY, STAFF_ROLES,
  hashPassword, writeAudit: v2.writeAudit, auditCtx, publicUser
});

// PDPA 2026 / CA 2023 compliance: consent, encrypted vault, DSAR.
require('./routes_compliance')(app, {
  ...guards,
  encryptField: v2.encryptField,
  decryptField: v2.decryptField,
  encryptionReady: v2.encryptionReady,
  writeAudit: v2.writeAudit
});

/* Reports and CSV exports. Every report is a registry entry served by two
   generic routes, so the permission check, the date range and the CSV writer
   exist once rather than once per report. */
require('./routes_reports')(app, { ...guards, writeAudit: v2.writeAudit });

/* ══════════════════════════════════════════════════════════
   SCHEDULER
   ══════════════════════════════════════════════════════════

   One entry point for every scheduled job. Whatever fires it — Vercel Cron, a
   system crontab, or an administrator clicking "run now" — arrives here, so
   there is one implementation of each job rather than one per trigger.

   Two credentials open this door and nothing else does:

     the scheduler secret   CRON_SECRET, sent as a bearer token or X-Cron-Key.
                            This is what a cron entry uses. It is never sent to
                            a browser and never appears in frontend code.

     a super admin session  so an operator can run a job by hand from the admin
                            portal when a scheduled run failed.

   Every other caller is refused, including moderators and college admins:
   these jobs delete accounts and mutate every event row, which is not a
   moderator's authority however legitimate their session is. */

function schedulerCredentialOk(req) {
  const expected = process.env.CRON_SECRET || '';
  if (!expected) return false;              // unset means nothing can pass

  const header = req.get('x-cron-key') || '';
  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const offered = header || bearer;
  if (!offered) return false;

  // Constant-time: a length-independent compare would leak the secret a byte
  // at a time to a patient caller.
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireScheduler(req, res, next) {
  if (schedulerCredentialOk(req)) { req.schedulerAuth = 'secret'; return next(); }
  // Fall back to a super admin session, which attachUser has already resolved.
  if (req.user && !req.staleSession && !req.suspended && req.user.role === 'super_admin') {
    req.schedulerAuth = 'super_admin';
    return next();
  }
  /* Deliberately 401 with no hint about which credential was missing or
     whether the job name exists. A caller without the secret learns nothing
     about the scheduler beyond its presence. */
  return res.status(401).json({ error: 'Scheduler credentials required' });
}

/* Runs one job, or every job when no name is given. Idempotent by design, so a
   cron that fires twice, or an operator who retries, causes no harm.

   GET as well as POST because platform schedulers differ: Vercel Cron issues a
   GET, a crontab line using curl can issue either. Refusing one of them would
   mean maintaining a second trigger path, which is how a system ends up with
   two schedulers that drift. */
const runJobsHandler = async (req, res) => {
  const name = String(req.query.job || req.body?.job || '').trim();
  const source = req.schedulerAuth === 'secret' ? 'cron' : 'manual';
  const deps = { runReminderSweep: eventsModule?.runReminderSweep, writeAudit: _writeAudit };

  try {
    if (!name || name === 'all') {
      const results = await jobs.runAllJobs(deps, source);
      const failed = results.filter(r => r.status === 'failed');
      return res.status(failed.length ? 500 : 200).json({ ran: results.length, failed: failed.length, results });
    }
    res.json(await jobs.runJob(name, deps, source));
  } catch (e) {
    console.error(`[scheduler] job "${name}" failed: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message, job: name, runId: e.runId || null });
  }
};

app.post('/api/internal/jobs/run', requireScheduler, runJobsHandler);
app.get('/api/internal/jobs/run', requireScheduler, runJobsHandler);

/* What the admin portal's operations panel reads, and what an operator checks
   after an incident. Administrator session required — this carries the mail
   host, the last error text of a failed job and the backup state, none of
   which belongs on a public endpoint. */
app.get('/api/ops/status', requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const runs = await db.query(`
      SELECT DISTINCT ON (job) job, status, started_at, finished_at, duration_ms, items, detail, source
        FROM ops_runs ORDER BY job, started_at DESC`);

    const recentFailures = await db.query(`
      SELECT COUNT(*)::int n FROM ops_runs
       WHERE status='failed' AND started_at > NOW() - INTERVAL '7 days'`);

    const pendingDeletions = await db.query(`
      SELECT COUNT(*)::int n FROM deletion_requests
       WHERE status='pending' AND user_id IS NOT NULL`);

    const overdueDeletions = await db.query(`
      SELECT COUNT(*)::int n FROM deletion_requests
       WHERE status='pending' AND user_id IS NOT NULL AND purge_after <= NOW()`);

    res.json({
      jobs: jobs.JOB_NAMES.map(name => {
        const r = runs.rows.find(x => x.job === name);
        return r ? { name, ...r } : { name, status: 'never run' };
      }),
      recentFailures: recentFailures.rows[0].n,
      deletions: { pending: pendingDeletions.rows[0].n, overdue: overdueDeletions.rows[0].n },
      mail: mailer.status(),
      scheduler: { configured: !!process.env.CRON_SECRET },
      backup: readBackupState()
    });
  } catch (err) {
    console.error('[ops] status failed: ' + err.message);
    res.status(500).json({ error: 'Could not read operational status' });
  }
});

/* ─── MACHINE-READABLE OPERATIONAL HEALTH ───────────────────
   The endpoint an external monitor polls.

   GET /api/health is the liveness probe and stays deliberately thin: it says
   whether the process is up and whether the database answers, and nothing else,
   because it is unauthenticated. The three states a monitor distinguishes are:

     200  {"status":"ok"}         healthy
     503  {"status":"degraded"}   the application is up, a dependency is not
     no answer at all             the application is down — which by definition
                                  only something outside it can observe

   But "the site responds" is not the same as "the platform is working". The
   deletion purge could have been failing for a fortnight, or the nightly backup
   could have stopped, and /api/health would report 200 throughout. Those are
   exactly the failures nobody notices until they matter.

   /api/ops/status already gathers that, and requires an administrator session —
   which an uptime service cannot hold. This endpoint reports the same facts to
   the scheduler credential instead: a server-side secret the monitor can carry
   and the browser never sees. It returns 200 when everything is within its
   freshness window and 503 when it is not, so a monitor needs no JSON parsing
   to raise an alert, and carries the reasons for a human who then looks.

   No dashboard is built. This is a status line for something else to watch. */
const MONITOR_JOB_MAX_HOURS = parseInt(process.env.MONITOR_JOB_MAX_HOURS || '36', 10);
const MONITOR_BACKUP_MAX_HOURS = parseInt(process.env.MONITOR_BACKUP_MAX_HOURS || '36', 10);

app.get('/api/internal/monitor', requireScheduler, async (req, res) => {
  /* Two lists, because they mean different things to whoever is on call.
     A PROBLEM is something that has gone wrong and returns 503, so a monitor
     raises it. An ADVISORY is something worth knowing that nobody should be
     woken for — most often a capability that was never configured. Collapsing
     them would either page somebody nightly or hide the fact that this
     deployment keeps one copy of its data. */
  const problems = [], advisories = [];
  const out = { status: 'ok', checkedAt: new Date().toISOString() };

  // 1. The database.
  const t0 = Date.now();
  try {
    await db.query('SELECT 1');
    out.database = { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    console.error('[monitor] database unreachable: ' + err.message);
    out.database = { ok: false };
    problems.push('database unreachable');
    // Nothing below can be read without it.
    out.status = 'failing';
    out.problems = problems;
    return res.status(503).json(out);
  }

  // 2. Every scheduled job: has it run, did it succeed, and was it recent?
  try {
    const runs = await db.query(`
      SELECT DISTINCT ON (job) job, status, started_at, finished_at, items, detail
        FROM ops_runs ORDER BY job, started_at DESC`);
    out.jobs = jobs.JOB_NAMES.map(name => {
      const r = runs.rows.find(x => x.job === name);
      if (!r) { problems.push(`job ${name} has never run`); return { name, state: 'never-run' }; }
      const ageHours = (Date.now() - new Date(r.started_at).getTime()) / 3600000;
      const stale = ageHours > MONITOR_JOB_MAX_HOURS;
      if (r.status === 'failed') problems.push(`job ${name} last run FAILED`);
      else if (stale) problems.push(`job ${name} last ran ${Math.round(ageHours)}h ago`);
      return {
        name, state: r.status, ageHours: Math.round(ageHours * 10) / 10,
        items: r.items, stale
      };
    });
  } catch (err) {
    console.error('[monitor] job state unreadable: ' + err.message);
    problems.push('job run log unreadable');
  }

  // 3. The nightly backup, from the receipt backup.js leaves behind.
  const b = readBackupState();
  out.backup = b;
  if (!b.known) problems.push('no backup has ever been recorded');
  else if (b.status !== 'ok') problems.push('the last backup FAILED');
  else if (b.ageHours > MONITOR_BACKUP_MAX_HOURS) {
    problems.push(`the last backup is ${Math.round(b.ageHours)}h old`);
  }

  // 4. The off-site copy, from its own receipt.
  const off = readOffsiteState();
  out.offsite = off;
  if (!off.configured) {
    advisories.push('no off-site backup destination is configured — this deployment keeps one copy of its data');
  } else if (!off.known) {
    problems.push('off-site copying is configured but has never run');
  } else if (off.status !== 'ok') {
    problems.push('the last off-site copy FAILED');
  } else if (off.ageHours > MONITOR_BACKUP_MAX_HOURS) {
    problems.push(`the last off-site copy is ${Math.round(off.ageHours)}h old`);
  }

  // 5. Deletion promises that are past their deadline and still unkept.
  try {
    const overdue = await db.query(`
      SELECT COUNT(*)::int n FROM deletion_requests
       WHERE status='pending' AND user_id IS NOT NULL AND purge_after <= NOW()`);
    out.overdueDeletions = overdue.rows[0].n;
    if (overdue.rows[0].n > 0) {
      problems.push(`${overdue.rows[0].n} account deletion(s) past their deadline and not yet purged`);
    }
  } catch { /* covered by the database check above */ }

  // 6. Mail, only when the deployment says it should be sending.
  out.mail = mailer.status();
  if (out.mail && out.mail.mode === 'smtp' && out.mail.configured === false) {
    problems.push('SMTP is selected but not fully configured');
  }

  if (out.mail && out.mail.mode === 'console') {
    advisories.push('MAIL_TRANSPORT=console — reset links are written to the log, not sent');
  } else if (out.mail && out.mail.mode === 'none') {
    advisories.push('MAIL_TRANSPORT=none — password reset is operator-only by deliberate choice');
  }

  out.problems = problems;
  out.advisories = advisories;
  out.status = problems.length ? 'degraded' : 'ok';
  res.status(problems.length ? 503 : 200).json(out);
});

/* The backup runs outside the application — it is a cron job calling
   backup.js, which must keep working when Node is down. It leaves a small
   receipt behind, and this reads it. An absent receipt is itself the signal an
   operator needs. */
/* The off-site copy leaves its own receipt, for the same reason the backup
   does: the copy runs outside the application and must be observable when the
   application is not the thing that failed. */
function readOffsiteState() {
  try { return require('./offsite').status(); }
  catch (e) { return { configured: false, known: false, error: e.message }; }
}

function readBackupState() {
  try {
    const f = path.join(process.env.BACKUP_DIR || path.join(__dirname, 'backups'), 'last-backup.json');
    if (!fs.existsSync(f)) return { known: false };
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ageHours = (Date.now() - new Date(raw.finishedAt).getTime()) / 3600000;
    return {
      known: true,
      status: raw.status,
      finishedAt: raw.finishedAt,
      sizeBytes: raw.sizeBytes,
      ageHours: Math.round(ageHours * 10) / 10,
      // The operational question is not "is there a file" but "is it recent".
      stale: ageHours > 36
    };
  } catch {
    return { known: false };
  }
}

// Unknown /api/* paths must 404 as JSON, not fall through to the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.originalUrl}` });
});

// A request for a real file that does not exist must 404, not fall through to
// the SPA shell. Returning index.html for a missing image made <img onerror>
// fallbacks download the whole page before failing to decode it.
const STATIC_FILE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|json|txt|csv|woff2?|ttf|otf|eot|pdf|xml)$/i;
app.use((req, res, next) => {
  if (STATIC_FILE.test(req.path)) {
    return res.status(404).type('txt').send('Not found');
  }
  next();
});

/* Two entry points, one backend.

   /admin serves the staff portal; everything else serves the alumni site. The
   split is by path today so it can be tested and reverted without touching DNS.
   When admin.<domain> is pointed at this deployment, the host check below picks
   the same file — set ADMIN_ORIGIN and the subdomain works with no further
   change. Both entry points call the same API on their own origin, so nothing
   about authentication moves.

   Note these serve different HTML but identical JavaScript files: the portals
   differ by which modules they load, not by having their own copies. */
const ADMIN_HOST_PREFIX = 'admin.';

/* The hostname of each configured origin, compared as a hostname.

   This used to be `adminOrigin.includes(host)` — a substring test. Under the
   recommended architecture (alumni.<domain> and admin.alumni.<domain>) the
   alumni host is a substring of the admin origin, so a request to the PUBLIC
   domain matched and was served the staff portal shell. Verified:
   'https://admin.alumni.dic.edu.bd'.includes('alumni.dic.edu.bd') === true.

   The API enforces roles server-side regardless of which shell is served, so
   this was the wrong page rather than an access-control failure — but the
   wrong page on the college's public alumni domain. */
function originHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(raw).hostname.toLowerCase(); }
  catch { return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0]; }
}

function wantsAdminPortal(req) {
  if (/^\/admin(\/|$)/.test(req.path)) return true;
  const host = String(req.hostname || '').toLowerCase();
  if (!host) return false;
  if (host.startsWith(ADMIN_HOST_PREFIX)) return true;

  const adminHost = originHost(process.env.ADMIN_ORIGIN);
  const publicHost = originHost(process.env.PUBLIC_ORIGIN);
  /* When both portals share one origin — the development setup, and any
     single-host deployment — the host cannot distinguish them and only the
     path can. Treating a shared host as "admin" would serve the staff portal
     for every request, including "/". */
  if (adminHost && adminHost === publicHost) return false;
  return !!adminHost && host === adminHost;
}

app.use((req, res) => {
  res.sendFile(path.join(__dirname, wantsAdminPortal(req) ? 'admin.html' : 'index.html'));
});

// Start Express Server locally or export for Vercel Serverless
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`🚀 DIC Alumni Platform API Server running on http://localhost:${PORT}`);
    /* This line printed the literal "dic_alumni_db" whatever it was actually
       connected to — it once reported that name while pointed at a database
       that did not exist. During a restore verification or an incident, the
       startup banner is exactly where an operator checks which copy they are
       talking to, so it now asks the connection.

       Reported, never assumed: on failure it says so rather than guessing, and
       it never prints the connection string, which carries the password. */
    try {
      const r = await db.query('SELECT current_database() AS db, version() AS v');
      console.log(`🐘 Connected to PostgreSQL database "${r.rows[0].db}" ` +
                  `(${String(r.rows[0].v).split(' ').slice(0, 2).join(' ')})`);
    } catch (err) {
      console.error('🐘 NOT connected to PostgreSQL: ' + err.message);
    }
  });
}

module.exports = app;
// The reset CLI mints tokens through the same helper the endpoint uses, so
// there is one definition of what a valid reset token is.
module.exports.issueResetToken = issueResetToken;
