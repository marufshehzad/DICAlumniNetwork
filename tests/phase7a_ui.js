#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7A interface contract

   Pins what Phase 7A established, so none of it can quietly regress:

     A  contrast — no rule inks text on a ground it cannot be read against
     B  the light theme holds — no component keeps a pre-light-theme ground
     C  emoji are lookup keys, never rendered output
     D  every field has a name a screen reader can announce
     E  dialogs — ARIA, the keyboard, and no silent data loss
     F  one idiom per state: empty, loading, error
     G  markup only uses classes the stylesheet actually defines
     H  no control that does nothing
     I  one name per concept

   The contrast maths here is the same as WCAG 2.1 1.4.3 and is computed
   from the stylesheet rather than asserted from a screenshot, so it holds
   for pages this suite never opens. Rules that state both a colour and a
   flat ground are self-contained and can be judged; rules that inherit a
   ground are verified in the browser instead, and the phase log records
   what that pass measured.

   Usage:  node tests/phase7a_ui.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };
const head = t => console.log('\n' + t);

const src = f => fs.readFileSync(path.join(REPO, f), 'utf8');
// Source assertions must not match the comment that explains the fix.
const code = f => src(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const JS = fs.readdirSync(path.join(REPO, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f);
const VIEWS = ['index.html', 'admin.html', ...JS];
const CSS = src('styles.css');

/* ─── colour maths ─────────────────────────────────────────── */
const vars = {};
for (const m of CSS.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) vars['--' + m[1]] = m[2].trim();

function toRGB(v, depth = 0) {
  if (!v || depth > 6) return null;
  v = String(v).trim();
  const varM = v.match(/^var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)$/i);
  if (varM) return toRGB(vars[varM[1]] || varM[2], depth + 1);
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { r: parseInt(m[1].slice(0,2),16), g: parseInt(m[1].slice(2,4),16), b: parseInt(m[1].slice(4,6),16), a: 1 };
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return { r: parseInt(m[1][0]+m[1][0],16), g: parseInt(m[1][1]+m[1][1],16), b: parseInt(m[1][2]+m[1][2],16), a: 1 };
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return { r:p[0], g:p[1], b:p[2], a: p.length>3?p[3]:1 }; }
  if (/^white$/i.test(v)) return { r:255, g:255, b:255, a:1 };
  if (/^black$/i.test(v)) return { r:0, g:0, b:0, a:1 };
  return null;
}
const WHITE = { r:255, g:255, b:255, a:1 };
const over = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a), a: 1 });
const lum = c => { const f = x => { x/=255; return x<=0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); };
  return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b), hi = Math.max(L1,L2), lo = Math.min(L1,L2); return (hi+0.05)/(lo+0.05); };

// Components that are light-on-dark by design. The stylesheet composites a
// translucent ground over white, which is wrong for these, so they are read
// in the browser instead of here.
const DARK_BY_DESIGN = /topbar|cipher|built-by|wallet-btn\.apple/;

function cssRules() {
  const out = [];
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (sel.startsWith('@') || /^\d/.test(sel)) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}

/* ─── A. contrast ──────────────────────────────────────────── */
head('=== A. Text is legible against the ground its own rule gives it ===');
{
  const failures = [];
  for (const { sel, body } of cssRules()) {
    if (DARK_BY_DESIGN.test(sel)) continue;
    const colorM = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
    const bgM = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
    if (!colorM || !bgM) continue;
    if (/gradient|url\(/i.test(bgM[1])) continue;
    // painted through the text by a gradient: colour is not what is seen
    if (/-webkit-text-fill-color\s*:\s*transparent|background-clip\s*:\s*text/.test(body)) continue;
    // a disabled control is exempt from 1.4.3
    if (/:disabled|\[disabled\]/.test(sel)) continue;
    const fg0 = toRGB(colorM[1]), bg0 = toRGB(bgM[1]);
    if (!fg0 || !bg0) continue;
    const bg = bg0.a < 1 ? over(bg0, WHITE) : bg0;
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    const cr = ratio(fg, bg);
    const sizeM = body.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/);
    const wM = body.match(/font-weight\s*:\s*(\d+)/);
    const size = sizeM ? parseFloat(sizeM[1]) : 14;
    const bold = wM ? parseInt(wM[1]) >= 700 : false;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (cr < need) failures.push(`${sel} ${cr.toFixed(2)}:1 (needs ${need})`);
  }
  ok('every self-grounded rule clears WCAG AA', failures.length === 0, failures.slice(0, 6).join(' | '));
}
{
  // the text-weight variants exist and really are darker than the fills
  for (const [text, fill] of [['--teal-text', '--teal'], ['--amber-text', '--amber'],
                              ['--green-text', '--green'], ['--red-text', '--red']]) {
    const t = toRGB(vars[text]), f = toRGB(vars[fill]);
    ok(`${text} is defined and darker than ${fill}`, !!t && !!f && lum(t) < lum(f),
       t && f ? `${text} lum ${lum(t).toFixed(3)} vs ${lum(f).toFixed(3)}` : 'missing');
    if (t) ok(`${text} clears 4.5:1 on white`, ratio(t, WHITE) >= 4.5, ratio(t, WHITE).toFixed(2));
  }
}
{
  // an accent used as ink on its own tint is the shape that failed everywhere
  const bad = [];
  for (const { sel, body } of cssRules()) {
    if (DARK_BY_DESIGN.test(sel)) continue;
    const c = body.match(/(?:^|;)\s*color\s*:\s*var\((--(?:teal|amber|green|red|diu-green))\s*[,)]/);
    const bg = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*(rgba\([^)]*\)|var\(--[a-z-]*glow\))/);
    if (c && bg) bad.push(sel + ' uses ' + c[1] + ' as ink');
  }
  ok('no accent token is used as ink on its own tint', bad.length === 0, bad.slice(0, 5).join(' | '));
}

/* ─── B. the light theme holds ─────────────────────────────── */
head('=== B. Nothing kept a ground from the pre-light theme ===');
{
  // the digital ID card was the last dark component and made its own text unreadable
  const cardRule = CSS.match(/\.digital-id-card\s*\{[^}]*\}/);
  ok('the digital ID card exists', !!cardRule);
  if (cardRule) {
    const bg = cardRule[0].match(/background:\s*linear-gradient\([^)]*\)/);
    const stops = bg ? [...bg[0].matchAll(/#[0-9a-fA-F]{6}/g)].map(m => toRGB(m[0])) : [];
    ok('the ID card ground is light, not dark', stops.length > 0 && stops.every(s => lum(s) > 0.5),
       stops.map(s => lum(s).toFixed(2)).join(','));
  }
  // An element that paints a DARK gradient and declares no colour inherits
  // the dark body ink and becomes unreadable. A gradient whose stops land
  // light over white is fine with the inherited ink, which is why the test
  // weighs the stops rather than just noticing a gradient.
  const noInk = [];
  for (const { sel, body } of cssRules()) {
    const g = body.match(/background:\s*linear-gradient\(([^;]*)\)/);
    if (!g) continue;
    if (/(?:^|;)\s*color\s*:/.test(body)) continue;
    if (!/avatar/.test(sel)) continue;           // the shape that actually bit: initials on a gradient
    const stops = [...g[1].matchAll(/#[0-9a-fA-F]{3,6}|rgba?\([^)]*\)|var\(--[a-z0-9-]+\)/g)]
      .map(m => toRGB(m[0])).filter(Boolean)
      .map(c => c.a < 1 ? over(c, WHITE) : c);
    if (!stops.length) continue;
    if (stops.some(s => lum(s) < 0.35)) noInk.push(sel);   // a dark stop under dark ink
  }
  ok('no avatar leaves dark ink on a dark gradient', noInk.length === 0, noInk.join(' | '));
  ok('skeleton lines are not white on white',
     /\.skeleton-line\s*\{[^}]*#EEF2F7/.test(CSS) && !/\.skeleton-line\s*\{[^}]*rgba\(255,255,255/.test(CSS));
}

/* ─── C. emoji ─────────────────────────────────────────────── */
head('=== C. Emoji are lookup keys, never rendered output ===');
{
  const core = src('js/core.js');
  const mapBody = core.slice(core.indexOf('const EMOJI_ICON_MAP'), core.indexOf('function emojiIcon'));
  const MAP = new Set([...mapBody.matchAll(/'([^']+)'\s*:\s*'[a-z0-9-]+'/g)].map(m => m[1]));
  ok('EMOJI_ICON_MAP is populated', MAP.size > 50, MAP.size + ' entries');
  ok('emojiIcon() renders a Lucide element, never the glyph',
     /function emojiIcon[\s\S]{0,900}data-lucide="\$\{name\}"/.test(core));
  ok('showToast() strips a leading mapped glyph',
     /EMOJI_ICON_MAP\[lead\[1\]\][\s\S]{0,200}message\.slice\(lead\[0\]\.length\)/.test(core));

  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2900}-\u{297F}\u{25A0}-\u{25FF}]/u;
  const rendered = [];
  for (const f of VIEWS) {
    const lines = src(f).split('\n');
    let block = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (block) { if (t.includes('*/')) block = false; return; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) block = true; return; }
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (!EMOJI.test(line)) return;
      if (f === 'js/core.js' && /^'|EMOJI_ICON_MAP/.test(t)) return;    // the map itself
      if (/\bicon:\s*'/.test(line)) return;                             // consumed by emojiIcon()
      // A toast's leading glyph is stripped and mapped. The call is often a
      // ternary broken across lines, so the branch carrying the glyph does
      // not itself contain showToast(.
      if (/showToast\(/.test(line)) return;
      if (/^[?:]/.test(t) && lines.slice(Math.max(0, i - 3), i).some(p => /showToast\(/.test(p))) return;
      if (/Icon Emoji|Emoji Icon/i.test(line)) return;                  // a field where a user picks one
      if (!/[<>`]|innerHTML|textContent/.test(line)) return;
      rendered.push(`${f}:${i + 1}`);
    });
  }
  // events.js keeps one prose arrow in a sentence naming a menu path
  const unexpected = rendered.filter(r => !r.startsWith('js/events.js'));
  ok('no glyph is rendered as a functional icon', unexpected.length === 0, unexpected.slice(0, 6).join(' '));
  ok('every nav icon resolves through the map',
     [...code('js/navigation.js').matchAll(/icon:\s*'([^']+)'/g)]
       .every(m => MAP.has(m[1]) || /^[a-z][a-z0-9-]*$/.test(m[1])));
}

/* ─── D. field names ───────────────────────────────────────── */
head('=== D. Every field has a name a screen reader can announce ===');
{
  const unnamed = [];
  for (const f of VIEWS) {
    // A <select> quoted inside a comment explaining why it was removed is
    // not a control, so comments come out before anything is counted. The
    // blanking keeps offsets intact so reported line numbers stay true.
    const blank = t => t.replace(/[^\n]/g, ' ');
    const s = src(f)
      .replace(/<!--[\s\S]*?-->/g, blank)
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
    const labelled = new Set([...s.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map(m => m[1]));
    for (const m of s.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
      const tag = m[0];
      if (/type="(hidden|submit|button|checkbox|radio)"/.test(tag)) continue;
      if (/aria-label(?:ledby)?\s*=/.test(tag)) continue;
      const id = (tag.match(/\sid="([^"]+)"/) || [])[1];
      if (id && labelled.has(id)) continue;
      const line = s.slice(0, m.index).split('\n').length;
      unnamed.push(`${f}:${line}`);
    }
  }
  ok('no input, select or textarea is unnamed', unnamed.length === 0, unnamed.slice(0, 8).join(' '));

  const orphan = [];
  for (const f of VIEWS) {
    const s = src(f);
    const ids = new Set([...s.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    for (const m of s.matchAll(/<label[^>]*\sfor="([^"]+)"/g))
      if (!ids.has(m[1]) && !/\$\{/.test(m[1])) orphan.push(`${f} for="${m[1]}"`);
  }
  ok('every for= points at a field that exists', orphan.length === 0, orphan.slice(0, 6).join(' | '));
}

/* ─── E. dialogs ───────────────────────────────────────────── */
head('=== E. Dialogs announce themselves, take the keyboard, and lose nothing ===');
{
  const core = code('js/core.js');
  ok('the dialog is marked role="dialog"', /setAttribute\('role',\s*'dialog'\)/.test(core));
  ok('the dialog is marked aria-modal', /setAttribute\('aria-modal',\s*'true'\)/.test(core));
  ok('the dialog is labelled by its own title', /aria-labelledby/.test(core) && /modal-heading/.test(core));
  ok('Escape closes whichever dialog is open', /key !== 'Escape'[\s\S]{0,220}closeModal\(\)/.test(core));
  ok('Tab is kept inside the dialog', /key !== 'Tab'[\s\S]{0,700}(shiftKey)/.test(core));
  ok('focus returns to whatever opened it', /_modalReturnFocus[\s\S]{0,200}\.focus\(\)/.test(core));
  ok('every close control is a button, not a submit',
     /\.modal-close[\s\S]{0,300}type[\s\S]{0,40}button/.test(core) || /setAttribute\('type',\s*'button'\)/.test(core));
  ok('the backdrop closes a dialog only when it opted in',
     /e\.target === overlay && _modalDismissable/.test(core));
  ok('dismissable is opt-in, so a data-entry dialog cannot be clicked away',
     /_modalDismissable\s*=\s*opts\.dismissable === true/.test(core));

  // a dialog holding something unrecoverable must not be dismissable
  const admin = src('js/administration.js');
  const tmp = admin.slice(admin.indexOf('function showTemporaryPassword'),
                          admin.indexOf('function showEditAdministrator'));
  ok('the one-time password dialog cannot be dismissed by a stray click',
     tmp.length > 0 && !/dismissable:\s*true/.test(tmp));

  // and every dialog that still opts in must be one that holds nothing to lose
  const optIn = [];
  for (const f of JS) {
    const s = src(f);
    for (const m of s.matchAll(/dismissable:\s*true/g)) {
      const before = s.slice(0, m.index);
      const fn = [...before.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].pop();
      const body = before.slice(before.lastIndexOf('showModal'));
      if (/<input|<textarea|<select|<form/.test(body)) optIn.push(`${f} ${fn ? fn[1] : '?'}`);
    }
  }
  ok('no dialog containing a form is dismissable', optIn.length === 0, optIn.join(' | '));
}

/* ─── F. states ────────────────────────────────────────────── */
head('=== F. One idiom each for empty, loading and error ===');
{
  const core = src('js/core.js');
  for (const h of ['renderEmptyState', 'renderErrorState', 'renderSkeletonCards'])
    ok(`${h}() is the shared helper`, new RegExp('function ' + h + '\\s*\\(').test(core));
  const adhoc = [];
  for (const f of JS) {
    src(f).split('\n').forEach((l, i) => {
      if (/innerHTML\s*=/.test(l) && /Loading[…\.]/.test(l)) adhoc.push(`${f}:${i + 1}`);
    });
  }
  ok('no page writes its own ad-hoc loading text', adhoc.length === 0, adhoc.join(' '));
}

/* ─── G. markup matches the stylesheet ─────────────────────── */
head('=== G. Markup only uses classes the stylesheet defines ===');
{
  // the audit trail rendered unstyled for want of six class names
  for (const c of ['audit-log-item', 'audit-log-icon', 'audit-log-body',
                   'audit-log-action', 'audit-log-meta', 'audit-log-hash']) {
    ok(`.${c} is both emitted and styled`,
       code('js/admin.js').includes('"' + c + '"') && CSS.includes('.' + c));
  }
  ok('no orphaned audit-* class survives in the markup',
     !/class="audit-(entry|icon|action|meta|hash)"/.test(code('js/admin.js')));
  ok('the audit hash chip reads the column the endpoint returns',
     /entry_hash/.test(code('js/admin.js')) && !/escapeHtml\(l\.hash\)/.test(code('js/admin.js')));
}

/* ─── H. dead controls ─────────────────────────────────────── */
head('=== H. Nothing invites a click it cannot answer ===');
{
  ok('the voice-search button is gone rather than inert',
     !src('index.html').includes('voice-btn') && !src('admin.html').includes('voice-btn'));
  // any button with a handler names a function that exists somewhere
  const defined = new Set();
  for (const f of JS) for (const m of src(f).matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)) defined.add(m[1]);
  const dangling = [];
  for (const f of ['index.html', 'admin.html']) {
    for (const m of src(f).matchAll(/onclick="([A-Za-z0-9_]+)\(/g))
      if (!defined.has(m[1]) && typeof globalThis[m[1]] !== 'function') dangling.push(`${f} ${m[1]}()`);
  }
  ok('every onclick in a portal names a function that exists', dangling.length === 0, dangling.slice(0, 6).join(' '));
}

/* ─── I. one name per concept ──────────────────────────────── */
head('=== I. One name per concept ===');
{
  const all = VIEWS.map(f => src(f)).join('\n');
  ok('the broadcast composer has one label everywhere',
     !/Open broadcast composer/.test(all) && !/>\s*New Broadcast\s*</.test(all));
  ok('dept_admin is spelled out wherever it is shown',
     !/'Dept Admin'/.test(code('js/admin.js')));
  ok('the alumni role is named consistently', !/Verified Alumnus/.test(all));
  // the labels shown for each backend role are the documented ones
  const map = code('js/admin.js').match(/alumni:\s*'Alumni'[\s\S]{0,200}?super_admin:\s*'Super Admin'/);
  ok('the role label map still covers all five roles',
     !!map && ['alumni', 'moderator', 'dept_admin', 'univ_admin', 'super_admin']
       .every(r => map[0].includes(r + ':')));
}

/* ─── result ───────────────────────────────────────────────── */
console.log('\n' + '='.repeat(60));
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
