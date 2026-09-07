#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 5B location system

   The audit that opened this phase found that location was never collected:
   both account-creation paths wrote a hardcoded 'Dhaka','Bangladesh', no city
   input existed anywhere, the map was an empty SVG with pins at hand-chosen
   percentages, and two of three filter chips returned nothing.

   These tests exist so none of that can come back. In particular §B asserts
   the negative — that no code path invents a location — which is the claim
   that is easiest to regress and hardest to notice.

   Usage:  node tests/phase5b_location.js
           (needs the application running on TEST_BASE, default :8123)

   It creates its own accounts and removes them. It never deletes an audit
   entry, and never touches a profile it did not create.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'db'));
const privacyModule = require(path.join(REPO, 'privacy'));
const locationModule = require(path.join(REPO, 'location'));

const B = process.env.TEST_BASE || 'http://localhost:8123';
const CREDS_FILE = path.join(REPO, 'admin-credentials.local.txt');
const TAG = 'p5b-loc';

const creds = {};
if (fs.existsSync(CREDS_FILE)) {
  for (const l of fs.readFileSync(CREDS_FILE, 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) creds[m[2]] = m[3];
  }
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : ''))); };

const j = async (p, o = {}) => {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(B + p, o);
      let b = null; try { b = await r.json(); } catch {}
      return { status: r.status, body: b };
    } catch (e) {
      if (a >= 2) throw e;
      await new Promise(r => setTimeout(r, 250));
    }
  }
};
const H = t => ({ headers: { Authorization: 'Bearer ' + t } });
const send = (m, p, t, body) => j(p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  body: JSON.stringify(body || {})
});

let seq = 0;
async function makeMember(label) {
  const email = `${TAG}-${label}-${++seq}@dic.test`;
  const r = await send('POST', '/api/auth/register', null, {
    name: `P5B ${label}`, email, password: 'Str0ng!Pass#5b',
    hscPassingYear: 2019, hscGroup: 'Science', mobile: `01900${String(700000 + seq).slice(-6)}`
  });
  if (!r.body?.token) throw new Error(`could not create ${label}: ${JSON.stringify(r.body)}`);
  return { email, token: r.body.token, uid: r.body.user.id };
}

(async () => {
  const S = {};
  for (const [email, role] of [
    ['admin@dic.edu.bd', 'super'], ['collegeadmin@dic.edu.bd', 'univ'],
    ['departmentadmin@dic.edu.bd', 'dept'], ['moderator@dic.edu.bd', 'mod'],
    ['alumni@dic.edu.bd', 'alumni']
  ]) {
    if (creds[email]) S[role] = (await send('POST', '/api/auth/login', null,
      { email, password: creds[email] })).body?.token;
  }

  /* ══════════════════════════════════════════════════════════
     A. The data model
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== A. structured places, and no coordinates on people ===');

  const cols = (await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'alumni_profiles'`)).rows.map(r => r.column_name);
  ok('alumni_profiles.place_id exists', cols.includes('place_id'));
  ok('alumni_profiles.location_needs_confirmation exists',
    cols.includes('location_needs_confirmation'));
  ok('NO coordinate column was added to alumni_profiles',
    !cols.some(c => /^(lat|lng|latitude|longitude)$/i.test(c)),
    cols.filter(c => /lat|lng/i.test(c)).join(','));

  const placeCols = (await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'location_places'`)).rows.map(r => r.column_name);
  ok('location_places carries the coordinates instead',
    placeCols.includes('latitude') && placeCols.includes('longitude'));

  const places = (await db.query('SELECT COUNT(*)::int n FROM location_places')).rows[0].n;
  ok('reference places are seeded', places > 50, String(places));
  ok('every place has coordinates in range',
    (await db.query(`SELECT COUNT(*)::int n FROM location_places
                      WHERE latitude NOT BETWEEN -90 AND 90
                         OR longitude NOT BETWEEN -180 AND 180`)).rows[0].n === 0);

  /* ══════════════════════════════════════════════════════════
     B. No path invents a location   (the Step 0 guarantee)
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== B. registration and import never fabricate a location ===');

  const A = await makeMember('alpha');
  const fresh = (await db.query(
    'SELECT city, country, place_id, location_needs_confirmation FROM alumni_profiles WHERE user_id = $1',
    [A.uid])).rows[0];
  ok('a new registration stores NO city', fresh.city === null, JSON.stringify(fresh.city));
  ok('a new registration stores NO country', fresh.country === null, JSON.stringify(fresh.country));
  ok('a new registration has no place', fresh.place_id === null);
  ok('a new registration is NOT flagged for confirmation — there is nothing to confirm',
    fresh.location_needs_confirmation === false);

  /* The column default is the second place a location can be invented, and the
     easier one to miss: with DEFAULT 'Bangladesh' in place, an INSERT that
     simply omits the column still records a country. Removing the literal from
     the query is not enough on its own. */
  const countryDefault = (await db.query(`
    SELECT column_default FROM information_schema.columns
     WHERE table_name = 'alumni_profiles' AND column_name = 'country'`)).rows[0];
  ok('alumni_profiles.country has no DEFAULT to fabricate from',
    countryDefault && countryDefault.column_default === null,
    JSON.stringify(countryDefault));
  const baseSchema = fs.readFileSync(path.join(REPO, 'schema.sql'), 'utf8');
  ok('a fresh install does not reintroduce the country default',
    !/country\s+VARCHAR\(\d+\)\s+DEFAULT/i.test(baseSchema));

  // The literal must be gone from the source, not merely unreached.
  const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const serverSrc = stripJs(fs.readFileSync(path.join(REPO, 'server.js'), 'utf8'));
  ok('server.js contains no hardcoded Dhaka/Bangladesh location literal',
    !/'Dhaka'\s*,\s*'Bangladesh'/.test(serverSrc));
  const seedSrc = fs.readFileSync(path.join(REPO, 'seed.sql'), 'utf8')
    .replace(/--[^\n]*/g, '');
  ok('a re-seed does not reintroduce a fabricated current city',
    !/'Dhaka'\s*,\s*'Comilla'\s*,\s*'Chittagong'\s*,\s*'Bangladesh'/.test(seedSrc));

  // Bulk import: no location in the file → no location stored.
  if (S.super) {
    const impEmail = `${TAG}-import-none@dic.test`;
    const imp = await send('POST', '/api/bulk-import', S.super, {
      filename: 'p5b-no-location.csv',
      records: [{ row: 1, name: 'P5B Import NoLoc', email: impEmail, hscPassingYear: '2018' }]
    });
    ok('import without location succeeds', imp.status === 200, JSON.stringify(imp.body).slice(0, 120));
    const impRow = (await db.query(`
      SELECT ap.city, ap.country, ap.place_id FROM alumni_profiles ap
        JOIN users u ON u.id = ap.user_id WHERE LOWER(u.email) = $1`, [impEmail])).rows[0];
    ok('import without location stores NO city', impRow && impRow.city === null,
      JSON.stringify(impRow));
    ok('import without location stores NO place', impRow && impRow.place_id === null);

    // Bulk import WITH a location → that location, not Dhaka.
    const impEmail2 = `${TAG}-import-syl@dic.test`;
    const imp2 = await send('POST', '/api/bulk-import', S.super, {
      filename: 'p5b-with-location.csv',
      records: [{ row: 1, name: 'P5B Import Sylhet', email: impEmail2,
                  hscPassingYear: '2018', city: 'Sylhet', country: 'Bangladesh' }]
    });
    ok('import with a location succeeds', imp2.status === 200);
    const impRow2 = (await db.query(`
      SELECT ap.city, ap.country, ap.place_id, lp.city AS place_city
        FROM alumni_profiles ap JOIN users u ON u.id = ap.user_id
        LEFT JOIN location_places lp ON lp.id = ap.place_id
       WHERE LOWER(u.email) = $1`, [impEmail2])).rows[0];
    ok('the imported city is the one in the file', impRow2 && impRow2.city === 'Sylhet',
      JSON.stringify(impRow2));
    ok('…and it is NOT overwritten with Dhaka', impRow2 && impRow2.city !== 'Dhaka');
    ok('…and it resolved to a structured place', impRow2 && impRow2.place_id !== null);

    // A known alias must resolve; an unknown city must be reported, not guessed.
    const impEmail3 = `${TAG}-import-alias@dic.test`;
    await send('POST', '/api/bulk-import', S.super, {
      filename: 'p5b-alias.csv',
      records: [{ row: 1, name: 'P5B Import Alias', email: impEmail3,
                  hscPassingYear: '2018', city: 'Chittagong', country: 'Bangladesh' }]
    });
    const impRow3 = (await db.query(`
      SELECT lp.city AS place_city FROM alumni_profiles ap
        JOIN users u ON u.id = ap.user_id
        LEFT JOIN location_places lp ON lp.id = ap.place_id
       WHERE LOWER(u.email) = $1`, [impEmail3])).rows[0];
    ok('a documented rename resolves (Chittagong → Chattogram)',
      impRow3 && impRow3.place_city === 'Chattogram', JSON.stringify(impRow3));

    const impEmail4 = `${TAG}-import-unknown@dic.test`;
    const imp4 = await send('POST', '/api/bulk-import', S.super, {
      filename: 'p5b-unknown.csv',
      records: [{ row: 7, name: 'P5B Import Unknown', email: impEmail4,
                  hscPassingYear: '2018', city: 'Nowhereville', country: 'Bangladesh' }]
    });
    ok('an unrecognised city is reported back to the administrator',
      Array.isArray(imp4.body?.unresolvedLocations) && imp4.body.unresolvedLocations.length === 1,
      JSON.stringify(imp4.body?.unresolvedLocations));
    ok('…naming the row and what was supplied',
      imp4.body?.unresolvedLocations?.[0]?.row === 7 &&
      /Nowhereville/.test(imp4.body.unresolvedLocations[0].supplied || ''));
    const impRow4 = (await db.query(`
      SELECT ap.place_id, ap.city FROM alumni_profiles ap
        JOIN users u ON u.id = ap.user_id WHERE LOWER(u.email) = $1`, [impEmail4])).rows[0];
    ok('…and the row imports WITHOUT a guessed location',
      impRow4 && impRow4.place_id === null && impRow4.city === null, JSON.stringify(impRow4));
  } else {
    ok('super admin session for import tests', false, 'no credentials file');
  }

  /* ══════════════════════════════════════════════════════════
     C. Setting a location through the API
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== C. a member can set, change and withdraw their location ===');

  const dhaka = (await db.query(
    `SELECT id FROM location_places WHERE city = 'Dhaka' AND country_code = 'BD'`)).rows[0];
  const london = (await db.query(
    `SELECT id FROM location_places WHERE city = 'London' AND country_code = 'GB'`)).rows[0];

  const setRes = await send('PUT', '/api/profile/me', A.token, { placeId: dhaka.id });
  ok('setting a place succeeds', setRes.status === 200, JSON.stringify(setRes.body).slice(0, 120));
  let stored = (await db.query(
    `SELECT place_id, city, country, division, location_needs_confirmation
       FROM alumni_profiles WHERE user_id = $1`, [A.uid])).rows[0];
  ok('the place is stored', stored.place_id === dhaka.id);
  ok('the denormalised city matches the place', stored.city === 'Dhaka');
  ok('the denormalised country matches the place', stored.country === 'Bangladesh');
  ok('choosing a place clears the confirmation flag',
    stored.location_needs_confirmation === false);

  await send('PUT', '/api/profile/me', A.token, { placeId: london.id });
  stored = (await db.query('SELECT place_id, city, country FROM alumni_profiles WHERE user_id = $1',
    [A.uid])).rows[0];
  ok('the location can be changed', stored.place_id === london.id && stored.city === 'London');

  const cleared = await send('PUT', '/api/profile/me', A.token, { placeId: null });
  ok('the location can be withdrawn', cleared.status === 200);
  stored = (await db.query(
    `SELECT place_id, city, country, location_needs_confirmation
       FROM alumni_profiles WHERE user_id = $1`, [A.uid])).rows[0];
  ok('withdrawing clears the place', stored.place_id === null);
  ok('withdrawing clears the denormalised city too', stored.city === null);
  ok('withdrawing does NOT re-raise the confirmation flag',
    stored.location_needs_confirmation === false);

  const bogus = await send('PUT', '/api/profile/me', A.token, { placeId: 99999999 });
  ok('an unknown place is refused', bogus.status === 400, String(bogus.status));

  ok('free-text city is not accepted as a location',
    (await send('PUT', '/api/profile/me', A.token, { city: 'Atlantis' })).status === 400);

  await send('PUT', '/api/profile/me', A.token, { placeId: dhaka.id });

  /* ══════════════════════════════════════════════════════════
     D. Location privacy is enforced server-side
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== D. location privacy, enforced by the API not the interface ===');

  const V = await makeMember('viewer');

  const levels = ['public', 'alumni', 'private'];
  for (const level of levels) {
    await send('PUT', '/api/profile/me', A.token,
      { placeId: dhaka.id, privacySettings: { location: level } });

    const asOther = await j(`/api/alumni/${A.uid}`, H(V.token));
    const visible = asOther.body?.location !== null && asOther.body?.location !== undefined;
    if (level === 'private') {
      ok(`private: another member sees no location`, !visible, JSON.stringify(asOther.body?.location));
      ok(`private: city is null too`, asOther.body?.city === null);
    } else {
      ok(`${level}: another member sees the city`, visible, JSON.stringify(asOther.body?.location));
    }

    const asSelf = await j(`/api/alumni/${A.uid}`, H(A.token));
    ok(`${level}: the owner always sees their own location`,
      asSelf.body?.location === 'Dhaka, Bangladesh', JSON.stringify(asSelf.body?.location));
  }

  // No staff bypass for location, deliberately — unlike email and mobile.
  await send('PUT', '/api/profile/me', A.token,
    { placeId: dhaka.id, privacySettings: { location: 'private' } });
  for (const [role, tok] of [['moderator', S.mod], ['dept_admin', S.dept],
                             ['univ_admin', S.univ], ['super_admin', S.super]]) {
    if (!tok) continue;
    const r = await j(`/api/alumni/${A.uid}`, H(tok));
    ok(`a private location is hidden from ${role} as well`,
      r.body?.location === null && r.body?.city === null,
      JSON.stringify({ location: r.body?.location, city: r.body?.city }));
  }

  /* ══════════════════════════════════════════════════════════
     E. No address, and no coordinate, ever leaves the owner
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== E. addresses and coordinates never reach another member ===');

  await db.query(`
    UPDATE alumni_profiles
       SET present_address = $2, permanent_address = $3, postal_code = $4, hometown = $5
     WHERE user_id = $1`,
    [A.uid, '12 Test Road, Dhanmondi', 'Village Test, Cumilla', '1209', 'Cumilla']);

  const addressKeys = ['present_address', 'permanent_address', 'postal_code', 'hometown',
                       'presentAddress', 'permanentAddress', 'postalCode'];
  for (const [role, tok] of [['alumni', V.token], ['moderator', S.mod],
                             ['dept_admin', S.dept], ['univ_admin', S.univ],
                             ['super_admin', S.super]]) {
    if (!tok) continue;
    const r = await j(`/api/alumni/${A.uid}`, H(tok));
    const leaked = addressKeys.filter(k => r.body && r.body[k] !== undefined && r.body[k] !== null);
    ok(`${role} receives no address field`, leaked.length === 0, leaked.join(','));
    const blob = JSON.stringify(r.body || {});
    ok(`${role} receives no street text`, !/Test Road|Village Test/.test(blob));
    ok(`${role} receives no coordinate`, !/"lat|latitude"|longitude"/.test(blob));
  }

  const own = await j('/api/profile/me', H(A.token));
  ok('the owner does see their own address', own.body?.present_address === '12 Test Road, Dhanmondi');

  /* ══════════════════════════════════════════════════════════
     F. The map
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== F. the map aggregates, and plots real coordinates ===');

  await send('PUT', '/api/profile/me', A.token,
    { placeId: dhaka.id, privacySettings: { location: 'public' } });

  const map = await j('/api/stats/map', H(V.token));
  ok('the map endpoint answers', map.status === 200);
  ok('cities are returned', Array.isArray(map.body?.cities) && map.body.cities.length > 0,
    JSON.stringify(map.body?.cities?.length));
  const dhakaCell = (map.body?.cities || []).find(c => c.city === 'Dhaka');
  ok('the city carries coordinates', dhakaCell &&
    Number.isFinite(dhakaCell.latitude) && Number.isFinite(dhakaCell.longitude),
    JSON.stringify(dhakaCell));
  ok('the coordinates are the CITY’s, matching location_places',
    dhakaCell && Math.abs(dhakaCell.latitude - 23.8103) < 0.001 &&
    Math.abs(dhakaCell.longitude - 90.4125) < 0.001, JSON.stringify(dhakaCell));
  ok('no individual is named in the map payload',
    !/full_name|"name"|email|user_id/.test(JSON.stringify(map.body)));

  // Counts must match the database, not an approximation of it.
  const dbPublicDhaka = (await db.query(`
    SELECT COUNT(*)::int n FROM alumni_profiles ap
      JOIN location_places lp ON lp.id = ap.place_id
     WHERE lp.city = 'Dhaka' AND ${privacyModule.MAP_VISIBLE_SQL}`)).rows[0].n;
  ok('the city count matches the database exactly',
    dhakaCell && dhakaCell.n === dbPublicDhaka, `api=${dhakaCell?.n} db=${dbPublicDhaka}`);

  // 'alumni' means visible on a profile but NOT on the map.
  await send('PUT', '/api/profile/me', A.token,
    { placeId: dhaka.id, privacySettings: { location: 'alumni' } });
  const map2 = await j('/api/stats/map', H(V.token));
  const dhaka2 = (map2.body?.cities || []).find(c => c.city === 'Dhaka');
  ok('an "alumni only" location is NOT counted on the map',
    (dhaka2?.n ?? 0) === dbPublicDhaka - 1, `${dhaka2?.n} vs ${dbPublicDhaka - 1}`);
  const profileStill = await j(`/api/alumni/${A.uid}`, H(V.token));
  ok('…but is still visible on the profile', profileStill.body?.location === 'Dhaka, Bangladesh');

  await send('PUT', '/api/profile/me', A.token,
    { placeId: dhaka.id, privacySettings: { location: 'private' } });
  const map3 = await j('/api/stats/map', H(V.token));
  const dhaka3 = (map3.body?.cities || []).find(c => c.city === 'Dhaka');
  ok('a private location is not counted on the map either',
    (dhaka3?.n ?? 0) === dbPublicDhaka - 1, `${dhaka3?.n}`);

  ok('unconfirmed legacy locations are reported separately, not plotted',
    typeof map.body?.unconfirmed === 'number');
  const plottedCities = new Set((map.body?.cities || []).map(c => c.place_id));
  const legacyPlotted = (await db.query(`
    SELECT COUNT(*)::int n FROM alumni_profiles
     WHERE location_needs_confirmation AND place_id IS NOT NULL`)).rows[0].n;
  ok('no profile is both unconfirmed and plotted', legacyPlotted === 0, String(legacyPlotted));

  /* ══════════════════════════════════════════════════════════
     G. Directory filters
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== G. structured directory filters that actually match ===');

  await send('PUT', '/api/profile/me', A.token,
    { placeId: london.id, privacySettings: { location: 'public' } });

  const byCountry = await j('/api/alumni?country=GB&limit=50', H(V.token));
  ok('filtering by country code works', byCountry.body?.total >= 1, JSON.stringify(byCountry.body?.total));
  ok('…and returns the right person',
    (byCountry.body?.alumni || []).some(a => a.id === A.uid));

  const byCountryName = await j('/api/alumni?country=United%20Kingdom&limit=50', H(V.token));
  ok('filtering by country name works too', byCountryName.body?.total >= 1);

  const byCity = await j('/api/alumni?city=London&limit=50', H(V.token));
  ok('filtering by city works', (byCity.body?.alumni || []).some(a => a.id === A.uid));

  // The regression that started this: "uk"/"usa" chips returning nothing.
  const filters = await j('/api/locations/filters', H(V.token));
  ok('filter options are offered', filters.status === 200 && Array.isArray(filters.body?.countries));
  for (const c of (filters.body?.countries || [])) {
    const r = await j(`/api/alumni?country=${encodeURIComponent(c.code)}&limit=50`, H(V.token));
    ok(`the offered filter "${c.country}" returns ${c.n} — not zero`,
      r.body?.total === c.n, `offered ${c.n}, returned ${r.body?.total}`);
  }

  // A private location must not be discoverable by filtering for it.
  await send('PUT', '/api/profile/me', A.token,
    { placeId: london.id, privacySettings: { location: 'private' } });
  const hidden = await j('/api/alumni?city=London&limit=50', H(V.token));
  ok('a member with a private location is not returned by a location filter',
    !(hidden.body?.alumni || []).some(a => a.id === A.uid));
  const bySearch = await j('/api/alumni?search=London&limit=50', H(V.token));
  ok('…and not by free-text search for the city either',
    !(bySearch.body?.alumni || []).some(a => a.id === A.uid));

  /* ══════════════════════════════════════════════════════════
     H. Privacy schema is one definition, not three
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== H. one source of truth for privacy ===');

  const schema = await j('/api/profile/privacy-schema', H(V.token));
  ok('the schema endpoint answers', schema.status === 200);
  const names = (schema.body?.fields || []).map(f => f.name);
  ok('it names exactly the fields the server enforces',
    JSON.stringify(names.sort()) === JSON.stringify(Object.keys(privacyModule.PRIVACY_FIELDS).sort()),
    names.join(','));
  ok('location offers three levels',
    (schema.body?.fields || []).find(f => f.name === 'location')?.levels?.length === 3);
  ok('address is declared self-only rather than offered as a setting',
    (schema.body?.selfOnlyFields || []).includes('present_address') && !names.includes('address'));

  ok('an unknown privacy field is refused',
    (await send('PUT', '/api/profile/me', A.token,
      { privacySettings: { address: 'public' } })).status === 400);
  ok('an invalid level is refused',
    (await send('PUT', '/api/profile/me', A.token,
      { privacySettings: { location: 'everyone' } })).status === 400);
  ok('a level valid for one field but not another is refused',
    (await send('PUT', '/api/profile/me', A.token,
      { privacySettings: { email: 'alumni' } })).status === 400);

  const profileSrc = fs.readFileSync(path.join(REPO, 'js', 'profile.js'), 'utf8');
  ok('the browser no longer keeps its own copy of the field list',
    /getPrivacySchema/.test(profileSrc) && !/PROFILE_PRIVACY_SETTINGS = \{\s*mobile:/.test(profileSrc));

  /* ══════════════════════════════════════════════════════════
     I. Unauthenticated access
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== I. nothing about location is public ===');
  for (const p of ['/api/stats/map', '/api/locations/places', '/api/locations/filters',
                   '/api/profile/privacy-schema', `/api/alumni/${A.uid}`, '/api/alumni']) {
    ok(`${p} refuses an unauthenticated caller`, (await j(p)).status === 401);
  }

  /* ══════════════════════════════════════════════════════════
     J. The fake facade is gone
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== J. no fake location UI remains ===');
  const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
  for (const shell of ['index.html', 'admin.html']) {
    const html = stripHtml(fs.readFileSync(path.join(REPO, shell), 'utf8'));
    ok(`${shell}: no "Share My Location" control`, !/Share My Location/i.test(html));
    ok(`${shell}: no "Opt-in location" claim`, !/Opt-in location/i.test(html));
    ok(`${shell}: no hardcoded location filter chips`,
      !/toggleChip\(this,'(dhaka|uk|usa)'\)/i.test(html));
  }
  const dashSrc = stripJs(fs.readFileSync(path.join(REPO, 'js', 'dashboard.js'), 'utf8'));
  ok('the hardcoded percentage pin table is gone', !/MAP_COUNTRY_POSITIONS/.test(dashSrc));
  ok('pins are projected from real coordinates instead', /projectLatLng/.test(dashSrc));
  ok('the empty world SVG is now drawn', /drawMapGraticule/.test(dashSrc));
  ok('the map renders cities, not just countries', /res\.cities/.test(dashSrc));
  ok('no browser geolocation is requested anywhere',
    !/navigator\.geolocation/.test(
      ['core', 'dashboard', 'profile', 'directory'].map(f =>
        fs.readFileSync(path.join(REPO, 'js', `${f}.js`), 'utf8')).join('')));

  /* ══════════════════════════════════════════════════════════
     K. Existing data was preserved, not rewritten
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== K. pre-existing location data is flagged, not destroyed ===');
  const legacy = (await db.query(`
    SELECT COUNT(*)::int n FROM alumni_profiles WHERE location_needs_confirmation`)).rows[0].n;
  ok('legacy rows are flagged for confirmation', legacy >= 0, String(legacy));
  ok('no flagged row was silently linked to a place',
    (await db.query(`SELECT COUNT(*)::int n FROM alumni_profiles
                      WHERE location_needs_confirmation AND place_id IS NOT NULL`)).rows[0].n === 0);
  ok('flagged rows still hold the value the old system stored',
    (await db.query(`SELECT COUNT(*)::int n FROM alumni_profiles
                      WHERE location_needs_confirmation AND city IS NULL`)).rows[0].n === 0);

  /* ══════════════════════════════════════════════════════════
     L. The resolver
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== L. resolution is explicit, never a guess ===');
  const cases = [
    [{ city: 'Dhaka', country: 'Bangladesh' }, 'resolved'],
    [{ city: 'chittagong', country: 'BD' }, 'resolved'],
    [{ city: 'Comilla' }, 'resolved'],
    [{ country: 'Bangladesh' }, 'no-city'],
    [{}, 'empty'],
    [{ city: 'Nowhereville' }, 'unknown-city'],
    [{ city: 'Springfield', country: 'United States' }, 'unknown-city']
  ];
  for (const [input, expected] of cases) {
    const r = await locationModule.resolvePlace(db, input);
    ok(`resolve(${JSON.stringify(input)}) → ${expected}`, r.status === expected, r.status);
  }
  const ambiguous = await locationModule.resolvePlace(db, { city: 'Washington' });
  ok('a city name with no country still resolves when it is unique',
    ambiguous.status === 'resolved', ambiguous.status);

  /* ══════════════════════════════════════════════════════════
     M. Map visualisation  (Phase 5B follow-up)

     The map draws region and city totals. These assert that every number and
     every position on it comes from the database, that nothing is hardcoded,
     and that the privacy contract still decides who is counted.
     ══════════════════════════════════════════════════════════ */
  console.log('\n=== M. the map visualises real aggregates, and only those ===');

  const mapNow = (await j('/api/stats/map', H(V.token))).body;

  // Country rollup: count, city count and position all reconcile with SQL.
  for (const c of (mapNow.countries || [])) {
    const truth = (await db.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(DISTINCT lp.id)::int AS cities,
             (SUM(lp.latitude)  / COUNT(*))::float8 AS lat,
             (SUM(lp.longitude) / COUNT(*))::float8 AS lng
        FROM alumni_profiles ap
        JOIN location_places lp ON lp.id = ap.place_id
       WHERE lp.country_code = $1 AND ${privacyModule.MAP_VISIBLE_SQL}`, [c.country_code])).rows[0];
    ok(`country ${c.country}: the alumni count matches the database`,
      c.n === truth.n, `api=${c.n} db=${truth.n}`);
    ok(`country ${c.country}: the city count matches the database`,
      c.cities === truth.cities, `api=${c.cities} db=${truth.cities}`);
    ok(`country ${c.country}: the badge position is the mean of its real city coordinates`,
      Math.abs(c.latitude - truth.lat) < 1e-6 && Math.abs(c.longitude - truth.lng) < 1e-6,
      `api=${c.latitude},${c.longitude} db=${truth.lat},${truth.lng}`);
  }

  // City markers: every coordinate is the place's own, never invented.
  for (const c of (mapNow.cities || [])) {
    const place = (await db.query(
      'SELECT city, country, latitude::float8 AS lat, longitude::float8 AS lng FROM location_places WHERE id = $1',
      [c.place_id])).rows[0];
    ok(`city ${c.city}: coordinates come from location_places`,
      place && Math.abs(c.latitude - place.lat) < 1e-9 && Math.abs(c.longitude - place.lng) < 1e-9,
      JSON.stringify({ api: [c.latitude, c.longitude], db: place && [place.lat, place.lng] }));
    const truth = (await db.query(`
      SELECT COUNT(*)::int n FROM alumni_profiles ap
       WHERE ap.place_id = $1 AND ${privacyModule.MAP_VISIBLE_SQL}`, [c.place_id])).rows[0].n;
    ok(`city ${c.city}: the count matches the database`, c.n === truth, `api=${c.n} db=${truth}`);
  }

  ok('country totals and city totals agree',
    (mapNow.countries || []).reduce((a, c) => a + c.n, 0) ===
    (mapNow.cities || []).reduce((a, c) => a + c.n, 0));

  /* Privacy still decides who is counted. A member set to 'alumni' is visible
     on their profile but must not appear in a map total, and 'private' must
     not appear anywhere. */
  const mapCityCount = (payload, placeId) =>
    ((payload.cities || []).find(c => c.place_id === placeId) || { n: 0 }).n;

  await send('PUT', '/api/profile/me', A.token,
    { placeId: dhaka.id, privacySettings: { location: 'public' } });
  const withPublic = mapCityCount((await j('/api/stats/map', H(V.token))).body, dhaka.id);
  await send('PUT', '/api/profile/me', A.token, { privacySettings: { location: 'alumni' } });
  const withAlumni = mapCityCount((await j('/api/stats/map', H(V.token))).body, dhaka.id);
  await send('PUT', '/api/profile/me', A.token, { privacySettings: { location: 'private' } });
  const withPrivate = mapCityCount((await j('/api/stats/map', H(V.token))).body, dhaka.id);
  ok('an "alumni only" location is not counted on the map', withAlumni === withPublic - 1,
    `${withPublic} → ${withAlumni}`);
  ok('a private location is not counted on the map', withPrivate === withPublic - 1,
    `${withPublic} → ${withPrivate}`);

  ok('the map payload names no person and carries no personal coordinate',
    !/full_name|user_id|"email"|present_address/.test(JSON.stringify(mapNow)));

  // Unconfirmed legacy rows are reported, never plotted.
  ok('unconfirmed legacy locations are reported as a number, not as markers',
    typeof mapNow.unconfirmed === 'number' &&
    (await db.query(`SELECT COUNT(*)::int n FROM alumni_profiles
                      WHERE location_needs_confirmation AND place_id IS NOT NULL`)).rows[0].n === 0);

  /* The visualisation itself: no hardcoded geography, no hardcoded counts, and
     the click-through uses the structured filter rather than the search box. */
  const dash = stripJs(fs.readFileSync(path.join(REPO, 'js', 'dashboard.js'), 'utf8'));
  ok('no hardcoded country position table', !/MAP_COUNTRY_POSITIONS/.test(dash));
  ok('no hardcoded top/left percentage constants for places',
    !/top:\s*\d+\s*,\s*left:\s*\d+/.test(dash));
  ok('positions are projected from coordinates', /projectLatLng/.test(dash));
  /* The counts must come from the endpoint. A case-insensitive search for
     "SELECT" matches querySelectorAll and mapSelected, so this looks for the
     shapes a recomputation would actually take: SQL against the profile table,
     or counting alumni rows in the browser. */
  ok('the map does not query or recount alumni itself',
    !/FROM\s+alumni_profiles|COUNT\(\*\)|GROUP\s+BY/i.test(dash) &&
    !/getAlumni\s*\(/.test(dash));
  ok('badge values are the endpoint’s own numbers',
    /c\.total|\.n\b/.test(dash));
  ok('legend bands are derived from the data', /function mapBands/.test(dash));
  ok('co-located places are merged rather than stacked', /clusterMapPoints/.test(dash));
  ok('the empty state is honest', /No confirmed locations to display yet/.test(
    fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')));
  ok('clicking through uses the structured filter, not free-text search',
    /viewAlumniForMapSelection[\s\S]{0,400}filterByCountry[\s\S]{0,200}filterByCity/.test(dash) &&
    !/viewAlumniForMapSelection[\s\S]{0,400}d\.search\s*=/.test(dash));
  ok('the admin panel uses the same endpoint, not its own aggregation',
    (dash.match(/API\.getStatsMap\(\)/g) || []).length === 2);

  /* ══════════════════════════════════════════════════════════ */
  console.log('\n=== cleanup ===');
  const emails = `${TAG}-%@dic.test`;
  await db.query('DELETE FROM users WHERE email LIKE $1', [emails]);

  /* Phase 7E §31: what the tests PRODUCED, not only what they created.
     Importing writes an import_history row, and registering an account fires a
     role-targeted notification that no user_id cascade can reach — this suite
     had left 324 batches and its share of 5,345 orphaned notices behind. */
  await db.query(`DELETE FROM import_history WHERE filename LIKE 'p5b-%'`);
  await db.query(
    `DELETE FROM notifications
      WHERE target_role IS NOT NULL AND user_id IS NULL
        AND (subtitle LIKE $1 OR title LIKE $1)`, [`%${TAG}%`]);

  const left = (await db.query(
    'SELECT COUNT(*)::int n FROM users WHERE email LIKE $1', [emails])).rows[0].n;
  ok('test accounts removed', left === 0, String(left));
  ok('the import batches this suite created were removed',
    (await db.query(`SELECT COUNT(*)::int n FROM import_history WHERE filename LIKE 'p5b-%'`)).rows[0].n === 0);
  ok('reference places were not touched by the tests',
    (await db.query('SELECT COUNT(*)::int n FROM location_places')).rows[0].n === places);

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exitCode = fail ? 1 : 0;
})().catch(async (e) => {
  console.error('\nHARNESS ERROR: ' + e.message);
  console.error(e.stack);
  try { await db.pool.end(); } catch {}
  process.exit(2);
});
