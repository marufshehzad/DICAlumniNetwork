#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7B location contract

   Phase 5B built the alumni location domain. Phase 7B modelled the other
   three and completed the parts of the first that were missing. This suite
   pins both halves, so neither can quietly regress:

     A  four location domains, kept separate, and none of them merged
     B  a person is never a coordinate
     C  privacy decides who is counted, for every role including staff
     D  the map is aggregated by the server and never fabricates a count
     E  a filter exists because somebody is there
     F  event venues are public, validated, and not governed by member privacy
     G  job work mode, and the Dhaka that used to be invented
     H  a chapter is located as an institution, never from its members
     I  the states a reader sees when there is nothing to show

   Usage:  node tests/phase7b_location.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';
const db = require(path.join(REPO, 'db'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 170) : ''))); };
const head = t => console.log('\n' + t);

const src = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const code = f => src(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const CREDS = (() => {
  const out = {};
  for (const l of fs.readFileSync(path.join(REPO, 'admin-credentials.local.txt'), 'utf8').split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+@\S+)\s+(\S+)\s*$/);
    if (m) out[m[2]] = m[3];
  }
  return out;
})();

async function api(method, p, { token, body } = {}) {
  const res = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}
const login = async (email) => {
  const r = await api('POST', '/api/auth/login', { body: { email, password: CREDS[email] } });
  if (!r.body || !r.body.token) throw new Error(`login ${email} failed: ${r.status}`);
  return r.body.token;
};
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];

(async () => {
  const T = {
    alumni: await login('alumni@dic.edu.bd'),
    moderator: await login('moderator@dic.edu.bd'),
    dept: await login('departmentadmin@dic.edu.bd'),
    univ: await login('collegeadmin@dic.edu.bd'),
    super: await login('admin@dic.edu.bd')
  };

  /* ── A. four domains, separate ─────────────────────────── */
  head('=== A. Four location domains, and none of them merged ===');
  {
    const cols = async (t) => (await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map(r => r.column_name);
    const [profile, event, job, chapter] = await Promise.all(
      ['alumni_profiles', 'events', 'jobs', 'chapters'].map(cols));

    ok('alumni location is structured and references a place',
       profile.includes('place_id') && profile.includes('city') && profile.includes('country'));
    ok('event location is a venue, an address and its own coordinates',
       event.includes('venue') && event.includes('address') &&
       event.includes('latitude') && event.includes('longitude'));
    ok('job location adds a work mode, keeping its free-text location',
       job.includes('work_mode') && job.includes('location'));
    ok('chapter location is a reference to a place', chapter.includes('place_id'));

    // the separation itself
    ok('an event does not borrow the alumni place table for its venue',
       !event.includes('place_id'), 'events.place_id would merge two domains');
    ok('a chapter carries no member-derived location',
       !chapter.some(c => /member_city|member_country|home_city/.test(c)));
    ok('reference places are shared, which is the one thing that should be',
       (await scalar(`SELECT COUNT(*)::int n FROM location_places`)).n > 0);
  }

  /* ── B. a person is never a coordinate ─────────────────── */
  head('=== B. A person is never a coordinate ===');
  {
    const profile = (await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='alumni_profiles'`)).rows.map(r => r.column_name);
    ok('alumni_profiles holds no latitude or longitude',
       !profile.some(c => ['latitude', 'longitude', 'lat', 'lng'].includes(c)), profile.filter(c => /lat|lng|lon/.test(c)));

    // and no endpoint hands one out for a person
    for (const [who, tok] of Object.entries(T)) {
      const dir = await api('GET', '/api/alumni?limit=50', { token: tok });
      const rows = dir.body?.alumni || [];
      const leaked = rows.filter(r => r.latitude != null || r.longitude != null ||
                                      r.present_address || r.permanent_address || r.postal_code);
      ok(`${who}: the directory returns no coordinate or street address`, leaked.length === 0,
         leaked.slice(0, 2));
    }
  }

  /* ── C. privacy decides who is counted ─────────────────── */
  head('=== C. Privacy decides who is counted — for every role ===');
  {
    const priv = require(path.join(REPO, 'privacy.js'));
    ok('location offers three levels', priv.PRIVACY_FIELDS.location.levels.length === 3);
    ok('location has no staff bypass — private means private for every role',
       priv.PRIVACY_FIELDS.location.staffBypass === false);
    ok('the map counts only public locations',
       /= *'public'/.test(priv.MAP_VISIBLE_SQL));
    ok('the directory excludes only private ones',
       /<> *'private'/.test(priv.DIRECTORY_VISIBLE_SQL));

    // the numbers the SQL produces, for comparison with every role's view
    const expected = (await scalar(
      `SELECT COUNT(*)::int n FROM alumni_profiles ap
        JOIN location_places lp ON lp.id = ap.place_id
       WHERE ${priv.MAP_VISIBLE_SQL}`)).n;

    for (const [who, tok] of Object.entries(T)) {
      const m = await api('GET', '/api/stats/map', { token: tok });
      const total = (m.body?.cities || []).reduce((a, c) => a + c.n, 0);
      ok(`${who}: sees exactly the publicly-mapped alumni (${expected})`, total === expected, total);
    }

    const anon = await api('GET', '/api/stats/map');
    ok('an anonymous caller gets no map at all', anon.status === 401, anon.status);
    ok('an anonymous caller gets no location filters',
       (await api('GET', '/api/locations/filters')).status === 401);
    ok('an anonymous caller gets no reference places',
       (await api('GET', '/api/locations/places')).status === 401);
  }

  /* ── D. the map is the server's arithmetic ─────────────── */
  head('=== D. The map is the server\'s arithmetic, not the browser\'s ===');
  {
    const m = (await api('GET', '/api/stats/map', { token: T.alumni })).body;
    const cityRows = await db.query(
      `SELECT lp.city, COUNT(*)::int n FROM alumni_profiles ap
         JOIN location_places lp ON lp.id = ap.place_id
        WHERE ${require(path.join(REPO, 'privacy.js')).MAP_VISIBLE_SQL}
        GROUP BY lp.city`);
    ok('every city count matches its SQL count',
       cityRows.rows.every(r => (m.cities || []).find(c => c.city === r.city)?.n === r.n),
       { api: m.cities, sql: cityRows.rows });

    ok('each mapped city carries the CITY\'s coordinates, from the reference table',
       (m.cities || []).every(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude)));
    for (const c of m.cities || []) {
      const p = await scalar(`SELECT latitude::float8 la, longitude::float8 lo FROM location_places WHERE id = $1`, [c.place_id]);
      ok(`${c.city}'s position is the city's own, unmodified`,
         Math.abs(p.la - c.latitude) < 1e-6 && Math.abs(p.lo - c.longitude) < 1e-6);
    }

    const totals = (await scalar(`
      SELECT COUNT(*)::int profiles,
             COUNT(*) FILTER (WHERE place_id IS NOT NULL)::int confirmed,
             COUNT(*) FILTER (WHERE location_needs_confirmation)::int unconfirmed
        FROM alumni_profiles`));
    ok('the profile total is real', m.profiles === totals.profiles, [m.profiles, totals.profiles]);
    ok('the confirmed total is real', m.confirmed === totals.confirmed, [m.confirmed, totals.confirmed]);
    ok('unconfirmed locations are reported, not mapped',
       m.unconfirmed === totals.unconfirmed && m.mapped <= m.confirmed, [m.unconfirmed, totals.unconfirmed]);

    // §14: no hardcoded marker counts anywhere in the map code
    const d = code('js/dashboard.js');
    ok('no fabricated count survives in the map code',
       !/12,?847|8,?241|4,?606|47 countries/.test(d));
    ok('the browser filters what the server sent and never recomputes a count',
       /function mapRows\(\)/.test(d) && !/\.length \* |Math\.random/.test(d.slice(d.indexOf('function mapRows'), d.indexOf('function mapRows') + 900)));
  }

  /* ── E. a filter exists because somebody is there ──────── */
  head('=== E. A filter exists because somebody is there ===');
  {
    const f = (await api('GET', '/api/locations/filters', { token: T.alumni })).body;
    for (const k of ['countries', 'cities', 'divisions', 'districts']) {
      ok(`${k} is offered`, Array.isArray(f[k]), typeof f[k]);
    }
    const realDiv = (await db.query(
      `SELECT DISTINCT lp.division FROM alumni_profiles ap JOIN location_places lp ON lp.id = ap.place_id
        WHERE lp.division IS NOT NULL AND ${require(path.join(REPO, 'privacy.js')).DIRECTORY_VISIBLE_SQL}`)).rows.length;
    ok('every division offered has somebody in it', (f.divisions || []).length === realDiv, [f.divisions?.length, realDiv]);
    ok('no filter is offered with a zero count', [...(f.countries||[]), ...(f.cities||[]),
        ...(f.divisions||[]), ...(f.districts||[])].every(r => r.n > 0));

    // and they actually filter
    for (const [param, row, key] of [['country', f.countries?.[0], 'code'],
                                     ['city', f.cities?.[0], 'city'],
                                     ['division', f.divisions?.[0], 'division'],
                                     ['district', f.districts?.[0], 'district']]) {
      if (!row) { ok(`${param} filter (no data to exercise)`, true); continue; }
      const r = await api('GET', `/api/alumni?${param}=${encodeURIComponent(row[key])}`, { token: T.alumni });
      ok(`filtering by ${param} returns exactly its count`, r.body?.total === row.n, [r.body?.total, row.n]);
    }
    const none = await api('GET', '/api/alumni?division=NoSuchDivision', { token: T.alumni });
    ok('a division nobody is in returns nobody', none.body?.total === 0, none.body?.total);
  }

  /* ── F. event venues ───────────────────────────────────── */
  head('=== F. An event venue is public, validated, and not a residence ===');
  {
    const mk = (extra) => ({ title: 'P7B suite probe', venue: 'Probe Hall', startsOn: '2027-03-01', ...extra });
    ok('half a coordinate is refused',
       (await api('POST', '/api/events', { token: T.super, body: mk({ latitude: 23.8 }) })).status === 400);
    ok('an out-of-range latitude is refused',
       (await api('POST', '/api/events', { token: T.super, body: mk({ latitude: 91, longitude: 0 }) })).status === 400);
    ok('an out-of-range longitude is refused',
       (await api('POST', '/api/events', { token: T.super, body: mk({ latitude: 0, longitude: 181 }) })).status === 400);
    ok('a non-numeric coordinate is refused',
       (await api('POST', '/api/events', { token: T.super, body: mk({ latitude: 'x', longitude: 'y' }) })).status === 400);

    const ev = await api('POST', '/api/events', { token: T.super,
      body: mk({ address: '12 Probe Road', latitude: 23.8103, longitude: 90.4125 }) });
    ok('a venue may carry an address and exact coordinates', ev.status === 200, ev.body);

    if (ev.status === 200) {
      const id = ev.body.id;
      const row = await scalar(`SELECT address, latitude::float8 la, longitude::float8 lo FROM events WHERE id = $1`, [id]);
      ok('they persist', row.address === '12 Probe Road' && Math.abs(row.la - 23.8103) < 1e-5, row);
      ok('an ordinary alumnus may see a venue address — a venue is public',
         (await api('GET', `/api/events/${id}`, { token: T.alumni })).body?.address === '12 Probe Road');
      const upd = await api('PUT', `/api/events/${id}`, { token: T.super, body: { address: '13 Probe Road' } });
      ok('the address can be corrected', upd.status === 200 && upd.body?.address === '13 Probe Road', upd.body?.address);
      await api('DELETE', `/api/events/${id}`, { token: T.super });
      ok('the probe event was removed',
         (await scalar(`SELECT COUNT(*)::int n FROM events WHERE id = $1`, [id])).n === 0);
    }

    const e = code('js/events.js');
    ok('the directions link is derived, never stored', /function evDirectionsUrl/.test(e) &&
       !(await db.query(`SELECT column_name FROM information_schema.columns
                          WHERE table_name='events' AND column_name IN ('map_url','directions_url')`)).rows.length);
    ok('it opens safely', /rel="noopener noreferrer"/.test(e));
    ok('it points at a provider needing no key', /openstreetmap\.org/.test(e));
    ok('it renders nothing when there is nothing to point at',
       /if \(!q\) return '';/.test(e));
  }

  /* ── G. job work mode ──────────────────────────────────── */
  head('=== G. Job work mode, and the Dhaka that used to be invented ===');
  {
    ok('an invented work mode is refused',
       (await api('POST', '/api/jobs', { token: T.alumni,
          body: { title: 'P7B probe', company: 'Probe', workMode: 'anywhere' } })).status === 400);

    const j = await api('POST', '/api/jobs', { token: T.alumni,
      body: { title: 'P7B probe', company: 'Probe', workMode: 'remote' } });
    ok('a real one is stored', j.body?.work_mode === 'remote', j.body?.work_mode);
    ok('a blank location is no longer recorded as Dhaka', j.body?.location === null, j.body?.location);
    ok('the database refuses anything outside the three',
       (await db.query(`SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='jobs_work_mode_valid'`)).rows[0].n === 1);

    const remote = (await api('GET', '/api/jobs?workMode=remote', { token: T.alumni })).body;
    ok('the work-mode filter selects it', remote.some(x => x.id === j.body.id));
    ok('and excludes it from another mode',
       !((await api('GET', '/api/jobs?workMode=onsite', { token: T.alumni })).body).some(x => x.id === j.body.id));

    await api('DELETE', `/api/jobs/${j.body.id}`, { token: T.alumni });
    ok('the probe job was removed',
       (await scalar(`SELECT COUNT(*)::int n FROM jobs WHERE id = $1`, [j.body.id])).n === 0);

    ok('the server no longer defaults a location to Dhaka',
       !/location \|\| 'Dhaka'/.test(code('routes_v2.js')));
  }

  /* ── H. a chapter is located as an institution ─────────── */
  head('=== H. A chapter is located as an institution, not from its members ===');
  {
    const chapters = (await api('GET', '/api/chapters', { token: T.super })).body;
    const target = chapters.find(c => c.type === 'regional');
    ok('chapters carry a joined place', 'place_city' in target, Object.keys(target).filter(k => /place/.test(k)));

    const places = (await api('GET', '/api/locations/places', { token: T.super })).body;
    const dhaka = (places.countries || []).flatMap(c => c.cities || []).find(p => p.city === 'Dhaka');

    ok('an alumnus cannot set one',
       (await api('PUT', `/api/chapters/${target.id}/place`, { token: T.alumni, body: { placeId: dhaka.id } })).status === 403);
    ok('a moderator cannot either',
       (await api('PUT', `/api/chapters/${target.id}/place`, { token: T.moderator, body: { placeId: dhaka.id } })).status === 403);
    ok('an unknown place is refused',
       (await api('PUT', `/api/chapters/${target.id}/place`, { token: T.super, body: { placeId: 999999 } })).status === 400);

    const original = target.place_id;
    const set = await api('PUT', `/api/chapters/${target.id}/place`, { token: T.super, body: { placeId: dhaka.id } });
    ok('an administrator can', set.status === 200 && set.body.place_id === dhaka.id, set.body);
    ok('the city and coordinates come back from the reference table',
       set.body?.place_city === 'Dhaka' && Number.isFinite(set.body?.place_latitude));
    ok('it is audited',
       (await scalar(`SELECT COUNT(*)::int n FROM audit_logs WHERE action LIKE 'Chapter Location%'`)).n > 0);

    const clear = await api('PUT', `/api/chapters/${target.id}/place`, { token: T.super, body: { placeId: null } });
    ok('and can be cleared, for a chapter that spans more than a city',
       clear.status === 200 && clear.body.place_id === null);

    // put it back exactly as found
    await api('PUT', `/api/chapters/${target.id}/place`, { token: T.super, body: { placeId: original } });

    ok('the interface says the location is the institution\'s, not its members\'',
       /not taken from where members live/i.test(src('js/chapters.js')));
  }

  /* ── I. the states a reader sees ───────────────────────── */
  head('=== I. What a reader sees when there is nothing to show ===');
  {
    const d = code('js/dashboard.js');
    const html = src('index.html');
    ok('the map has a search', /id="map-search"/.test(html) && /function setMapQuery/.test(d));
    ok('the search field is labelled', /id="map-search"[^>]*aria-label|aria-label[^>]*id="map-search"/.test(html));
    ok('the map has a loading state', /id="map-loading"/.test(html) && /map-loading/.test(d));
    ok('the map has an empty state', /id="map-empty"/.test(html));
    ok('"no locations yet" and "no search match" are different messages',
       /No \$\{mapMode === 'countries' \? 'country' : 'city'\} matches/.test(d));
    ok('the directory says why it has no location filters',
       /No location filters yet/.test(src('js/directory.js')));
    ok('a chapter with no location says so rather than guessing',
       /No location set/.test(src('js/chapters.js')));
    ok('a job with no location says so rather than showing a dash',
       /Location not stated/.test(src('js/jobs.js')));

    // §16 mobile: the map toolbar has to be able to wrap
    const css = src('styles.css');
    ok('the map toolbar wraps rather than overflowing', /\.map-toolbar\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
    ok('the map search shrinks on a narrow toolbar', /\.map-search\s*\{[^}]*flex:\s*1 1/.test(css));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nSUITE ERROR:', e.message);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
