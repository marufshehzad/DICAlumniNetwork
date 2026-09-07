#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7G contract
   A real geographic map, and modal close controls that actually close.

   PART A — MAP
     A1  the geometry is real, licensed, and bundled rather than fetched
     A2  every country projects where the projection formula says it does
     A3  the map depends on no library, no tiles and no API key
     A4  counts come from the database; nothing is invented
     A5  location privacy is unchanged — private stays off the map
     A6  the accessible list carries the same numbers as the map

   PART B — MODALS
     B1  a dialog's resting position does not depend on an animation
     B2  every close control is a button, labelled, and typed
     B3  one delegated handler closes, and it survives a re-render
     B4  Escape closes; the backdrop closes only what is safe to close
     B5  no Cancel button can submit a form
     B6  closing scopes to the current dialog
     B7  a dialog's teardown runs however it is closed

   WHY B1 IS THE HEADLINE. Below 900px every dialog is a bottom sheet, and its
   slide-up animation used to run from translateY(100%) — the sheet began a full
   height BELOW the viewport and the animation was the only thing that brought
   it into view. Whenever that animation did not complete, the dialog sat off
   the bottom of the screen with its close button unreachable. On a phone that
   was every dialog in the application. The animation now travels 24px, so the
   resting position is correct with no animation at all.

   Usage:  node tests/phase7g_modals.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';
const db = require(path.join(REPO, 'db'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + String(JSON.stringify(d)).slice(0, 160) : ''))); };
const head = t => console.log('\n' + t);
const src = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

const CREDS = (() => {
  const out = {};
  for (const l of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) out[m[2]] = m[3];
  }
  return out;
})();

async function api(method, p, { token, body } = {}) {
  const r = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null; try { j = JSON.parse(await r.text()); } catch {}
  return { status: r.status, body: j };
}
const login = async (e) => (await api('POST', '/api/auth/login', { body: { email: e, password: CREDS[e] } })).body?.token;

/* Every file that renders a dialog. */
const CLIENT = fs.readdirSync(path.join(REPO, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f);
const MARKUP = CLIENT.concat(['index.html', 'admin.html']);

(async () => {
 try {
  const alumTok = await login('alumni@dic.edu.bd');
  const superTok = await login('admin@dic.edu.bd');
  if (!alumTok || !superTok) throw new Error('could not sign in');

  /* ══ A1. the geometry ══ */
  head('A1. Real, licensed, bundled geometry');
  const geoPath = path.join(REPO, 'assets', 'geo', 'boundaries.json');
  ok('the geometry file is committed', fs.existsSync(geoPath));
  const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
  ok('it names its source', /Natural Earth/i.test(geo.source), geo.source);
  ok('it names its licence', /public domain/i.test(geo.licence), geo.licence);
  ok('it names how it was obtained', /world-atlas/i.test(geo.via), geo.via);
  ok('it carries world countries', Array.isArray(geo.world) && geo.world.length > 100, geo.world.length);
  ok('it carries a detailed Bangladesh', Array.isArray(geo.bangladesh) && geo.bangladesh.length === 1);
  const kb = Math.round(fs.statSync(geoPath).size / 1024);
  ok('it is small enough to bundle', kb < 250, kb + ' KB');
  ok('the build script is committed so the asset can be regenerated',
    fs.existsSync(path.join(REPO, 'tools', 'build_geo.js')));
  ok('the source packages are dev-only, so nothing ships to the browser',
    !!(require(path.join(REPO, 'package.json')).devDependencies || {})['world-atlas'] &&
    !(require(path.join(REPO, 'package.json')).dependencies || {})['world-atlas']);

  /* ══ A2. the projection ══ */
  head('A2. Every country lands where the projection says');
  const W = 900, H = 450;
  const project = (lat, lng) => ({ x: ((lng + 180) / 360) * W, y: ((90 - lat) / 180) * H });
  const bboxOf = (rings) => {
    let a = [Infinity, -Infinity, Infinity, -Infinity];
    for (const r of rings) for (const [x, y] of r) {
      a[0] = Math.min(a[0], x); a[1] = Math.max(a[1], x);
      a[2] = Math.min(a[2], y); a[3] = Math.max(a[3], y);
    }
    return a;
  };
  /* Independently known bounding boxes. If the geometry were fabricated or
     mis-projected these would not agree. */
  const KNOWN = [
    ['Bangladesh', 88, 93, 20, 27],
    ['India', 68, 98, 6, 36],
    ['Australia', 112, 154, -44, -10],
    ['Brazil', -74, -34, -34, 6],
    ['Japan', 122, 154, 24, 46]
  ];
  for (const [name, wLng, eLng, sLat, nLat] of KNOWN) {
    const f = geo.world.find(x => x.name === name);
    if (!f) { ok(`${name} is present`, false); continue; }
    const [minX, maxX, minY, maxY] = bboxOf(f.rings);
    ok(`${name} sits in its real bounding box`,
      minX >= wLng - 2 && maxX <= eLng + 2 && minY >= sLat - 2 && maxY <= nLat + 2,
      `lon ${minX.toFixed(1)}..${maxX.toFixed(1)} lat ${minY.toFixed(1)}..${maxY.toFixed(1)}`);
  }
  const bd = geo.world.find(x => x.name === 'Bangladesh');
  const [bx0, bx1, by0, by1] = bboxOf(bd.rings);
  const p = project((by0 + by1) / 2, (bx0 + bx1) / 2);
  ok('Bangladesh projects into the right quadrant of the canvas',
    p.x > W * 0.7 && p.x < W * 0.78 && p.y > H * 0.3 && p.y < H * 0.42,
    `x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} of ${W}x${H}`);
  ok('the detailed outline is genuinely more detailed',
    geo.bangladesh[0].rings.reduce((a, r) => a + r.length, 0) >
    bd.rings.reduce((a, r) => a + r.length, 0) * 5);

  /* ══ A3. no external dependency ══ */
  head('A3. No library, no tiles, no key');
  const dash = src('js/dashboard.js');
  for (const [what, re] of [
    ['Leaflet', /leaflet/i], ['Mapbox', /mapbox/i], ['MapLibre', /maplibre/i],
    ['Google Maps', /maps\.google|googleapis\.com\/maps/i], ['OpenLayers', /openlayers|\bol\.Map\b/],
    ['a tile URL', /\{z\}\/\{x\}\/\{y\}|tile\.openstreetmap/i], ['d3-geo', /d3-geo|geoPath\(/],
    ['an API key', /api[_-]?key|access[_-]?token/i]
  ]) {
    ok(`the map uses no ${what}`, !re.test(dash));
  }
  ok('the geometry is fetched from this application, not a CDN',
    /const GEO_URL = '\/assets\/geo\/boundaries\.json'/.test(dash));
  ok('boundaries use the same projection as the markers',
    /countryPath[\s\S]{0,600}?projectLatLng\(/.test(dash));
  for (const html of ['index.html', 'admin.html']) {
    ok(`${html} loads no mapping library`,
      !/leaflet|mapbox|maplibre|openlayers/i.test(src(html)));
  }

  /* ══ A4/A5/A6. real counts, unchanged privacy ══ */
  head('A4. Real counts, and A5. unchanged privacy');
  const map = await api('GET', '/api/stats/map', { token: superTok });
  ok('the map endpoint answers', map.status === 200);
  ok('it now carries divisions for the Bangladesh view', Array.isArray(map.body.divisions));

  const privacy = require(path.join(REPO, 'privacy'));
  ok('the map still shows only public locations, unchanged from Phase 7B',
    /= 'public'/.test(privacy.MAP_VISIBLE_SQL), privacy.MAP_VISIBLE_SQL);
  ok('location still has no staff bypass', privacy.PRIVACY_FIELDS.location.staffBypass === false);

  const sqlCities = (await db.query(`
    SELECT lp.id, COUNT(*)::int n FROM alumni_profiles ap JOIN location_places lp ON lp.id = ap.place_id
     WHERE ${privacy.MAP_VISIBLE_SQL} GROUP BY lp.id`)).rows;
  ok('every city count equals the database',
    map.body.cities.length === sqlCities.length &&
    map.body.cities.every(c => sqlCities.find(s => s.id === c.place_id)?.n === c.n),
    { api: map.body.cities.length, sql: sqlCities.length });

  const sqlDiv = (await db.query(`
    SELECT lp.division, COUNT(*)::int n FROM alumni_profiles ap JOIN location_places lp ON lp.id = ap.place_id
     WHERE lp.country = 'Bangladesh' AND lp.division IS NOT NULL AND ${privacy.MAP_VISIBLE_SQL}
     GROUP BY lp.division`)).rows;
  ok('every division count equals the database',
    map.body.divisions.length === sqlDiv.length &&
    map.body.divisions.every(d => sqlDiv.find(s => s.division === d.division)?.n === d.n),
    { api: map.body.divisions.length, sql: sqlDiv.length });

  /* a member whose location is private must be absent from every layer */
  const subject = (await db.query(
    `SELECT ap.user_id, ap.privacy_settings, ap.place_id FROM alumni_profiles ap
      WHERE ap.place_id IS NOT NULL ORDER BY ap.user_id LIMIT 1`)).rows[0];
  const restore = subject.privacy_settings;
  await db.query(
    `UPDATE alumni_profiles SET privacy_settings = COALESCE(privacy_settings,'{}'::jsonb) || '{"location":"public"}'::jsonb
      WHERE user_id = $1`, [subject.user_id]);
  const shown = await api('GET', '/api/stats/map', { token: superTok });
  const inPublic = shown.body.cities.reduce((a, c) => a + c.n, 0);
  await db.query(
    `UPDATE alumni_profiles SET privacy_settings = COALESCE(privacy_settings,'{}'::jsonb) || '{"location":"private"}'::jsonb
      WHERE user_id = $1`, [subject.user_id]);
  const hidden = await api('GET', '/api/stats/map', { token: superTok });
  const inPrivate = hidden.body.cities.reduce((a, c) => a + c.n, 0);
  ok('setting a location to private removes that member from the map',
    inPrivate === inPublic - 1, { public: inPublic, private: inPrivate });
  ok('…and from the division rollup too',
    hidden.body.divisions.reduce((a, d) => a + d.n, 0) <= shown.body.divisions.reduce((a, d) => a + d.n, 0));
  if (restore === null) {
    await db.query('UPDATE alumni_profiles SET privacy_settings = NULL WHERE user_id = $1', [subject.user_id]);
  } else {
    await db.query('UPDATE alumni_profiles SET privacy_settings = $2::jsonb WHERE user_id = $1',
      [subject.user_id, JSON.stringify(restore)]);
  }
  ok('the fixture\'s privacy setting was restored exactly',
    JSON.stringify((await db.query('SELECT privacy_settings p FROM alumni_profiles WHERE user_id=$1',
      [subject.user_id])).rows[0].p) === JSON.stringify(restore));

  head('A6. The accessible list');
  ok('a ranked list is rendered beside the map', /function renderMapRanking/.test(dash));
  ok('it draws from the same rows as the markers', /renderMapRanking[\s\S]{0,400}?mapRows\(\)/.test(dash));
  ok('the map carries an accessible name', /setAttribute\('aria-label',[\s\S]{0,120}?listed in the table/.test(dash));
  ok('the level control is a labelled group', /aria-label="Map detail level"/.test(src('index.html')));
  ok('every level button reports its state', (src('index.html').match(/data-map-mode="[a-z]+"\s+\n?\s*aria-pressed=/g) || []).length >= 1 ||
    /aria-pressed/.test(src('index.html')));
  ok('the legend explains the size scale', /legend-title">Alumni per/.test(dash));

  /* ══ B1. the headline ══ */
  head('B1. A dialog is in place without any animation');
  const css = src('styles.css');
  ok('the mobile sheet no longer starts a full height off-screen',
    !/@keyframes slideUpMobile\s*\{[^}]*translateY\(100%\)/.test(css));
  ok('it travels a short distance instead',
    /@keyframes slideUpMobile\s*\{[\s\S]{0,120}?translateY\(24px\)/.test(css));
  ok('the resting transform is declared, not left to the animation',
    /\.modal-content\s*\{[^}]*transform:\s*translateY\(0\)/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('the animation holds its final frame', /slideUpMobile[^;]*both;/.test(css));
  ok('turning motion off cannot park a dialog off-screen',
    /prefers-reduced-motion[\s\S]{0,900}?\.modal-content\s*\{[^}]*transform:\s*none\s*!important/.test(css));
  ok('the heavy dark sheet shadow is gone', !/box-shadow:\s*0 -10px 40px rgba\(0,0,0,0\.8\)/.test(css));

  /* ══ B2. close controls ══ */
  head('B2. Every close control is a real, labelled button');
  let closeButtons = 0, untyped = 0, unlabelled = 0;
  for (const f of MARKUP) {
    const s = src(f);
    for (const m of s.matchAll(/<button([^>]*class=["'][^"']*modal-close[^"']*["'][^>]*)>/g)) {
      closeButtons++;
      if (!/type\s*=\s*["']button["']/.test(m[1])) { untyped++; console.log(`        untyped: ${f}`); }
      if (!/aria-label/.test(m[1])) { unlabelled++; console.log(`        unlabelled: ${f}`); }
    }
  }
  ok(`${closeButtons} close buttons found`, closeButtons > 30, closeButtons);
  ok('every one is type="button"', untyped === 0, untyped);
  ok('every one carries aria-label', unlabelled === 0, unlabelled);
  ok('showModal normalises them anyway, whatever a call site wrote',
    /querySelectorAll\('\.modal-close'\)[\s\S]{0,300}?setAttribute\('type', 'button'\)/.test(src('js/core.js')));
  ok('…including the accessible name', /setAttribute\('aria-label', 'Close'\)/.test(src('js/core.js')));

  head('B5. No Cancel can submit a form');
  let cancelUntyped = 0;
  for (const f of MARKUP) {
    for (const m of src(f).matchAll(/<button([^>]*)>([\s\S]{0,80}?)<\/button>/g)) {
      const text = m[2].replace(/<[^>]*>/g, '').replace(/'\s*\+\s*\w+\([^)]*\)\s*\+\s*'/g, '').trim();
      if (!/^(cancel|close|back|dismiss|keep|not now)/i.test(text)) continue;
      if (!/type\s*=\s*["']button["']/.test(m[1])) { cancelUntyped++; console.log(`        ${f}: "${text.slice(0, 30)}"`); }
    }
  }
  ok('every cancel/close/back button is explicitly type="button"', cancelUntyped === 0, cancelUntyped);

  /* ══ B3/B4/B6/B7. behaviour ══ */
  head('B3. One delegated handler, and B4. Escape and backdrop');
  const core = src('js/core.js');
  ok('closing is delegated at the document, so it survives every re-render',
    /document\.addEventListener\('click'[\s\S]{0,400}?closest\('\[data-modal-close\], \.modal-close'\)/.test(core));
  ok('a click on the icon inside the button still closes',
    /e\.target\.closest/.test(core));
  ok('the handler only acts while a dialog is open',
    /overlay\.classList\.contains\('hidden'\)\) return;/.test(core));
  ok('Escape closes', /key !== 'Escape'[\s\S]{0,200}?closeModal\(\)/.test(core));
  ok('the backdrop closes ONLY a dialog marked dismissable',
    /e\.target === overlay && _modalDismissable/.test(core));
  ok('…so a data-entry form is not dismissed by a stray click',
    /_modalDismissable = opts\.dismissable === true/.test(core));

  /* Which dialogs opt into backdrop dismissal, and are they the safe ones? */
  let dismissable = [];
  for (const f of CLIENT) {
    for (const m of src(f).matchAll(/showModal\(([\s\S]{0,4000}?)\{\s*dismissable:\s*true/g)) {
      dismissable.push(f);
    }
  }
  ok('backdrop dismissal is opt-in, not the default', dismissable.length < closeButtons,
    `${dismissable.length} dialogs opt in`);

  head('B6. Closing scopes to the current dialog');
  ok('closeModal hides one overlay rather than removing every .modal',
    /getElementById\('modal-overlay'\)[\s\S]{0,120}?classList\.add\('hidden'\)/.test(core) &&
    !/querySelectorAll\('\.modal'\)[\s\S]{0,80}?remove\(\)/.test(core));
  ok('there is exactly one modal overlay in each portal',
    (src('index.html').match(/id="modal-overlay"/g) || []).length === 1 &&
    (src('admin.html').match(/id="modal-overlay"/g) || []).length === 1);

  head('B7. Teardown runs however a dialog is closed');
  ok('a dialog may register an onClose hook', /_modalOnClose/.test(core));
  ok('closeModal runs it', /function closeModal[\s\S]{0,200}?_modalOnClose/.test(core));
  ok('a replacing dialog runs the outgoing one\'s hook first',
    /function showModal[\s\S]{0,400}?if \(_modalOnClose\)/.test(core));
  ok('the camera uses it, so a stream cannot outlive its dialog',
    /onClose: resetPhotoState/.test(src('js/photo.js')));

  head('Focus (Phase 7A behaviour preserved)');
  ok('focus moves into the dialog on open', /requestAnimationFrame\([\s\S]{0,260}?\.focus\?\.\(\)/.test(core));
  ok('focus returns to the opener on close', /_modalReturnFocus[\s\S]{0,200}?\.focus\(\)/.test(core));
  ok('Tab is trapped inside the dialog', /if \(e\.key !== 'Tab'\) return;/.test(core));
  ok('the dialog announces itself as one',
    /setAttribute\('role', 'dialog'\)/.test(core) && /setAttribute\('aria-modal', 'true'\)/.test(core));


  /* ══════════════════════════════════════════════════════════════════
     PHASE 7G CLOSURE PASS
     The notification drawer, the map's pointer gestures, and the real
     Bangladesh internal boundaries that replaced the labelled points.
     ══════════════════════════════════════════════════════════════════ */

  head('C1. Notification drawer close control');
  const notifJs = src('js/notifications.js');
  for (const portal of ['index.html', 'admin.html']) {
    const h = src(portal);
    const btn = (h.match(/<button[^>]*class="notif-close"[\s\S]{0,200}?<\/button>/) || [''])[0];
    ok(portal + ': the drawer has a dedicated close control', /class="notif-close"/.test(h));
    ok(portal + ': it is type="button", so it can never submit a form', /type="button"/.test(btn));
    ok(portal + ': it is named for a screen reader', /aria-label="Close notifications"/.test(btn));
    ok(portal + ': it closes the drawer', /onclick="closeNotifications\(\)"/.test(btn));
  }
  /* The defect was an 18x21px target in the corner of the screen: it closed
     correctly when hit, and was very hard to hit. The size IS the fix. */
  const notifCss = (css.match(/\.notif-close \{[\s\S]*?\}/) || [''])[0];
  ok('the close target is at least 44px wide', /min-width:\s*44px/.test(notifCss));
  ok('the close target is at least 44px tall', /min-height:\s*44px/.test(notifCss));
  ok('it has a visible keyboard focus ring', /\.notif-close:focus-visible\s*\{[^}]*outline:/.test(css));
  ok('Escape closes the drawer', /e\.key !== 'Escape'/.test(notifJs) && /closeNotifications\(\)/.test(notifJs));
  ok('the Escape listener is registered exactly once', /__notifEscapeWired/.test(notifJs));
  ok('Escape defers to an open dialog rather than closing both',
    /modal-overlay[\s\S]{0,160}?return;/.test(notifJs));

  /* The drawer and the modal overlay both sit at z-index 2000 and the drawer
     comes second in the document, so it wins the tie and paints over any dialog
     opened while it is showing. Below 900px the drawer is full-screen, which
     made such a dialog completely unreachable — hit-testing its close button at
     390px returned a notification row, and so did the middle of its body.
     A dialog is the topmost surface, so opening one closes the drawer. */
  ok('opening a dialog closes the notification drawer',
    /function showModal[\s\S]{0,1400}?typeof closeNotifications === 'function'[\s\S]{0,60}?closeNotifications\(\)/.test(core));
  ok('the drawer and the overlay are still the same stacking layer, so the ' +
     'close above is what keeps them apart',
    /\.notif-panel\s*\{[^}]*z-index:\s*2000/.test(css) && /\.modal-overlay\s*\{[^}]*z-index:\s*2000/.test(css));

  head('C2. Map pointer zoom — wheel and pinch');
  ok('the map handles the mouse wheel', /addEventListener\('wheel', mapWheel/.test(dash));
  ok('the wheel listener is non-passive, so it can stop the page scrolling',
    /addEventListener\('wheel', mapWheel, \{ passive: false \}\)/.test(dash));
  ok('the wheel handler prevents the default page scroll',
    /function mapWheel[\s\S]{0,120}?e\.preventDefault\(\)/.test(dash));
  ok('the map handles two-finger pinch',
    /addEventListener\('touchstart', mapTouchStart/.test(dash) &&
    /addEventListener\('touchmove', mapTouchMove/.test(dash));
  ok('touchmove is non-passive, so a pinch cannot pan the page',
    /addEventListener\('touchmove', mapTouchMove, \{ passive: false \}\)/.test(dash));
  ok('a cancelled touch resets the gesture', /addEventListener\('touchcancel', mapTouchEnd\)/.test(dash));
  /* Two wheel listeners would zoom two steps per notch. The map is re-rendered
     on every visit to the page, so this guard is what keeps one notch to one step. */
  ok('listeners are attached at most once per canvas',
    /dataset\.gesturesWired === '1'/.test(dash) && /dataset\.gesturesWired = '1'/.test(dash));
  ok('gestures are wired after the map renders', /wireMapGestures\(\);/.test(dash));
  ok('the browser does not claim the canvas gestures for itself',
    /\.map-canvas\s*\{[^}]*touch-action:\s*none/.test(css));
  ok('zoom is stepped, and a gesture cannot leave the defined steps',
    /const next = mapZoomIndex \+ direction;[\s\S]{0,140}?if \(next < 0 \|\| next > MAP_ZOOM_STEPS\.length - 1\) return false;/.test(dash));

  head('C3. Bangladesh internal boundaries — real, licensed geometry');
  ok('division polygons ship', Array.isArray(geo.bdDivisions) && geo.bdDivisions.length === 8,
    'divisions: ' + (geo.bdDivisions || []).length);
  ok('district polygons ship', Array.isArray(geo.bdDistricts) && geo.bdDistricts.length === 64,
    'districts: ' + (geo.bdDistricts || []).length);
  ok('the source is recorded in the data itself, pinned to a commit',
    /geoBoundaries gbOpen BGD ADM1 and ADM2, commit [0-9a-f]{7}/.test(geo.bdSource || ''), geo.bdSource);
  ok('the licence is recorded and is attribution-only, not share-alike',
    /CC0 1\.0/.test(geo.bdLicence || '') && /CC BY 3\.0 IGO/.test(geo.bdLicence || '') &&
    /no share-alike/.test(geo.bdLicence || ''));
  ok('a visible attribution is rendered, as those licences require',
    /class="map-attribution"/.test(src('index.html')) && /geoboundaries\.org/.test(src('index.html')));
  /* The whole point of this layer is that it is NOT drawn from memory. Every
     polygon must come from the build tool, and the build tool must fetch from
     the pinned upstream rather than carry coordinates in its own source. */
  const buildTool = src('tools/build_geo.js');
  ok('the build fetches from the pinned upstream',
    /releaseData\/gbOpen\/BGD/.test(buildTool) && /GB_COMMIT = '[0-9a-f]{7}'/.test(buildTool));
  ok('no boundary coordinates are hardcoded in client code',
    !/\[\s*8[89]\.\d{3,}\s*,\s*2[0-6]\.\d{3,}\s*\]/.test(dash));

  /* The strongest check available: the geometry and the alumni data are
     independent, so if every recorded city falls inside its own recorded
     district then the polygons are real, correctly georeferenced, and the 2018
     name changes were mapped correctly. A renamed district that silently never
     matched would show up here as a miss rather than as a blank on the map. */
  const places = (await db.query(
    "SELECT city, division, district, latitude::float8 AS lat, longitude::float8 AS lng " +
    "FROM location_places WHERE country = 'Bangladesh' AND district IS NOT NULL")).rows;
  const divNames = new Set(geo.bdDivisions.map(f => f.name));
  const distByName = new Map(geo.bdDistricts.map(f => [f.name, f]));
  const unresolvedDiv = [...new Set(places.map(p => p.division))].filter(n => n && !divNames.has(n));
  const unresolvedDist = [...new Set(places.map(p => p.district))].filter(n => !distByName.has(n));
  ok('every division in location_places has a polygon',
    unresolvedDiv.length === 0, 'unresolved: ' + JSON.stringify(unresolvedDiv));
  ok('every district in location_places has a polygon',
    unresolvedDist.length === 0, 'unresolved: ' + JSON.stringify(unresolvedDist));

  const inRings = (rings, x, y) => {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
    }
    return inside;
  };
  const outside = places.filter(p => {
    const f = distByName.get(p.district);
    return !f || !inRings(f.rings, p.lng, p.lat);
  }).map(p => p.city + '/' + p.district);
  ok('every recorded city falls geographically inside its recorded district',
    places.length > 0 && outside.length === 0,
    (places.length - outside.length) + '/' + places.length +
    (outside.length ? ' — outside: ' + outside.join(', ') : ''));

  /* Shading must come from the counted rows, never from the geometry. */
  ok('district shading is driven by the server-counted city rows',
    /for \(const c of \(mapData && mapData\.cities\) \|\| \[\]\)/.test(dash) &&
    /perDistrict\.set\(c\.district/.test(dash));
  ok('the map endpoint returns the district each city belongs to',
    /lp\.division, lp\.district/.test(src('server.js')));

  console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n`);
 } catch (err) {
  console.error('\n  SUITE ERROR:', err.message, '\n', (err.stack || '').split('\n')[1]);
  fail++;
 } finally {
  await db.pool.end();
  process.exit(fail ? 1 : 0);
 }
})();
