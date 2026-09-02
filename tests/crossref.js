/* Checks each portal is self-contained: every function either entry point calls
   must be declared in a module that entry point actually loads. Catches exactly
   the class of bug that moving admin.js out of the alumni site introduced. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const D = REPO + '/';
const fs = require('fs');

const scriptsOf = (html) =>
  [...fs.readFileSync(D + html, 'utf8').matchAll(/src="js\/([a-z]+)\.js"/g)].map(m => m[1]);

const declsOf = (files) => {
  const out = new Set();
  for (const f of files) {
    const src = fs.readFileSync(D + 'js/' + f + '.js', 'utf8');
    for (const m of src.matchAll(/^(?:async\s+)?function ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^(?:const|let|var) ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  }
  return out;
};

// Anything that exists at runtime without being declared by a module.
const AMBIENT = new Set(['API', 'apiFailed', 'lucide', 'Chart', 'QRCode', 'window', 'document',
  'console', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'requestAnimationFrame', 'Math', 'Date', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Promise', 'Set', 'Map', 'Error', 'RegExp', 'URLSearchParams',
  'Intl', 'Event', 'MutationObserver', 'performance', 'isNaN', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'Blob', 'URL', 'FileReader', 'AbortController',
  'getSessionToken', 'setSessionToken', 'onSessionExpired', 'location', 'navigator', 'alert']);

// Only names DECLARED somewhere under js/ matter: anything else is a local
// helper inside a function body, or a word my scanner picked out of a template
// literal. A genuine cross-portal reference is a top-level declaration that
// exists in the codebase but not in this portal's module list.
const ALL_FILES = require('fs').readdirSync(D + 'js').filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
const ALL_DECLS = declsOf(ALL_FILES);

/* Quote removal is per LINE, not across the whole file.

   It used to run the single-quote regex over the entire source at once, which
   pairs apostrophes globally: one unbalanced apostrophe anywhere shifts every
   pair after it, and a "string" can then span hundreds of lines and blank out
   real code. That is not hypothetical. Until Phase 5F this suite reported both
   portals self-contained while js/admin.js called renderNewsFeed() — a function
   admin.html does not load — because an odd apostrophe count earlier in the
   file had swallowed the call. Editing an unrelated line elsewhere in admin.js
   is what revealed it. A test that goes quiet when the source shifts is worse
   than no test, so the pairing is confined to one line at a time. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map(l => l.replace(/(^|[^:"'`\\])\/\/.*$/, '$1'))
  .map(l => l.replace(/'(?:\\.|[^'\\])*'/g, ' ').replace(/"(?:\\.|[^"\\])*"/g, ' '))
  .join('\n');

let bad = 0;
for (const [portal, html] of [['alumni', 'index.html'], ['staff', 'admin.html']]) {
  const files = scriptsOf(html);
  const declared = declsOf(files);
  const missing = new Map();

  // Direct calls inside the loaded modules.
  for (const f of files) {
    const src = strip(fs.readFileSync(D + 'js/' + f + '.js', 'utf8'));
    for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = m[1];
      if (declared.has(n) || AMBIENT.has(n)) continue;
      if (/^(if|for|while|switch|catch|return|typeof|function|await|new|else|do|of|in)$/.test(n)) continue;
      // Guarded calls are intentional: the portal may not have that module.
      const at = m.index;
      const around = src.slice(Math.max(0, at - 140), at);
      // strip() has already removed the quoted 'function' literal, so match the
      // guard on the typeof and the name alone.
      const esc = n.replace(/\$/g, '\\$');
      if (new RegExp('typeof\\s+(window\\.)?' + esc + '\\b|window\\.' + esc + '\\b|warm\\($|render\\($').test(around)) continue;
      if (!ALL_DECLS.has(n)) continue;          // local helper or template noise
      if (!missing.has(n)) missing.set(n, f);
    }
  }

  // Inline handlers in the entry point's own markup.
  const markup = fs.readFileSync(D + html, 'utf8');
  for (const m of markup.matchAll(/on\w+="([A-Za-z_$][\w$]*)\(/g)) {
    if (!declared.has(m[1]) && !AMBIENT.has(m[1])) missing.set(m[1], html + ' (inline handler)');
  }

  console.log(`\n══ ${portal} portal — ${files.length} modules, ${declared.size} declarations`);
  if (missing.size) {
    bad += missing.size;
    for (const [n, where] of missing) console.log(`   MISSING  ${n.padEnd(30)} called from ${where}`);
  } else {
    console.log('   ok — every unguarded call resolves within this portal');
  }
}
console.log('\n  ' + (bad ? bad + ' unresolved reference(s)' : 'both portals are self-contained'));
process.exitCode = bad ? 1 : 0;
