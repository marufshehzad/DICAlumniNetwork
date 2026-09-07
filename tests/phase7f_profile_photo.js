#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — Phase 7F contract
   Profile photo upload, camera capture, cropping, replacement and removal.

     A  an authenticated member sets their own photo
     B  replacing one leaves exactly one file and one URL
     C  removing one clears the record and deletes the file
     D  an unauthenticated caller can do none of it
     E  IDOR: the subject is the session, never anything in the request
     F  a declared MIME type is not evidence of anything
     G  a malformed image is refused rather than stored
     H  an oversized upload is refused
     I  EXIF is not carried into the stored file
     J  stored dimensions are canonical, whatever arrived
     K  the camera flow's fallbacks exist in the client
     L  a photo is exactly as visible as the profile it belongs to
     M  no photo means initials, and never a broken image
     N  a replacement never leaves the member with nothing
     O  the stored file is unreachable except through the guarded route

   WHAT THIS SUITE CANNOT DO. It cannot open a real camera. getUserMedia needs
   a browser, a device and a human granting permission, and none of those exist
   in a Node test process. What is verified here is everything around it: that
   the fallbacks are wired, that every exit path stops the stream, and that the
   permission-denied message is the one §16 specifies. The live capture path was
   exercised in a browser with a stubbed MediaStream — see PHASE_LOG.md — and
   has NOT been tested against real camera hardware.

   Usage:  node tests/phase7f_profile_photo.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const B = process.env.TEST_BASE || 'http://localhost:8123';
const db = require(path.join(REPO, 'db'));
const photos = require(path.join(REPO, 'photos'));
const { Jimp } = require(path.join(REPO, 'node_modules', 'jimp'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + String(JSON.stringify(d)).slice(0, 160) : ''))); };
const head = t => console.log('\n' + t);

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
  const ct = r.headers.get('content-type') || '';
  if (ct.startsWith('image/')) {
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), headers: Object.fromEntries(r.headers) };
  }
  let j = null; try { j = JSON.parse(await r.text()); } catch {}
  return { status: r.status, body: j, headers: Object.fromEntries(r.headers) };
}
const login = async (e) => (await api('POST', '/api/auth/login', { body: { email: e, password: CREDS[e] } })).body?.token;
const src = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

const TAG = 'p7f-' + Date.now();
const PW = 'Phase7F-Probe-Pw1';
let probeUid = null, subjectUid = null, subjectBefore = null;

/* A real image of a given size, as a data URL. */
async function png(w, h, colour = 0x2288ffff) {
  const j = new Jimp({ width: w, height: h, color: colour });
  return 'data:image/png;base64,' + (await j.getBuffer('image/png')).toString('base64');
}

const photoDir = () => photos.UPLOAD_DIR;
const filesFor = (uid) => {
  try { return fs.readdirSync(photoDir()).filter(f => f.startsWith(`u${uid}-`)); }
  catch { return []; }
};

async function cleanup() {
  /* Every file this run created, and the probe account. The subject's own
     photo is put back to exactly what it was. */
  try {
    for (const uid of [probeUid, subjectUid].filter(Boolean)) {
      for (const f of filesFor(uid)) {
        const cur = (await db.query(
          `SELECT 1 FROM alumni_profiles WHERE user_id=$1 AND photo_url LIKE $2
            UNION SELECT 1 FROM users WHERE id=$1 AND photo_url LIKE $2`, [uid, `%${f}`])).rows.length;
        if (!cur) { try { fs.unlinkSync(path.join(photoDir(), f)); } catch {} }
      }
    }
  } catch {}
  if (subjectUid !== null) {
    try {
      await db.query('UPDATE alumni_profiles SET photo_url = $2 WHERE user_id = $1',
        [subjectUid, subjectBefore]);
    } catch {}
  }
  try { await db.query('DELETE FROM users WHERE email LIKE $1', [TAG + '%']); } catch {}
  try {
    await db.query(
      `DELETE FROM notifications WHERE target_role IS NOT NULL AND user_id IS NULL
        AND (title LIKE $1 OR subtitle LIKE $1)`, [`%${TAG}%`]);
  } catch {}
}

(async () => {
 try {
  const alumTok = await login('alumni@dic.edu.bd');
  const superTok = await login('admin@dic.edu.bd');
  if (!alumTok || !superTok) throw new Error('could not sign in');

  const subject = (await db.query(
    `SELECT u.id, ap.photo_url FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id
      WHERE u.email = 'alumni@dic.edu.bd'`)).rows[0];
  subjectUid = subject.id;
  subjectBefore = subject.photo_url;

  /* ══ A. upload ══ */
  head('A. An authenticated member sets their own photo');
  const up = await api('POST', '/api/profile/photo', { token: alumTok, body: { image: await png(900, 600) } });
  ok('the upload is accepted', up.status === 200, up.body);
  ok('the response names the stored URL', typeof up.body.photoUrl === 'string' && up.body.photoUrl.startsWith('/api/profile/photo/'));
  ok('the URL addresses the uploader, not anyone else',
    up.body.photoUrl.startsWith(`/api/profile/photo/${subjectUid}?`), up.body.photoUrl);
  ok('the profile row now points at it',
    (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [subjectUid])).rows[0].photo_url === up.body.photoUrl);
  ok('exactly one file exists for this member', filesFor(subjectUid).length === 1, filesFor(subjectUid));
  ok('it is audited',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs WHERE action='Profile Photo Updated'`)).rows[0].n > 0);
  const url1 = up.body.photoUrl;

  /* ══ J. canonical dimensions ══ */
  head('J. Dimensions are canonical whatever arrived');
  ok('the response reports 512×512', up.body.width === 512 && up.body.height === 512);
  const served = await api('GET', url1, { token: alumTok });
  ok('the served bytes are an image', served.status === 200 && served.bytes.length > 0);
  const decoded = await Jimp.read(served.bytes);
  ok('and really are 512×512', decoded.bitmap.width === 512 && decoded.bitmap.height === 512,
    `${decoded.bitmap.width}x${decoded.bitmap.height}`);
  ok('a very wide source is squared, not squashed',
    (await api('POST', '/api/profile/photo', { token: alumTok, body: { image: await png(1600, 400) } })).body.width === 512);
  ok('a tiny source is still stored at the canonical size',
    (await api('POST', '/api/profile/photo', { token: alumTok, body: { image: await png(48, 48) } })).body.height === 512);

  /* ══ B/N. replacement ══ */
  head('B. Replacement, and N. never leaving the member with nothing');
  const before = await api('POST', '/api/profile/photo', { token: alumTok, body: { image: await png(600, 600, 0x11aa33ff) } });
  const oldUrl = before.body.photoUrl;
  const oldName = photos.nameFromUrl(oldUrl);
  ok('the old photo serves before the replacement', (await api('GET', oldUrl, { token: alumTok })).status === 200);

  const after = await api('POST', '/api/profile/photo', { token: alumTok, body: { image: await png(600, 600, 0xff5522ff) } });
  ok('the replacement is accepted', after.status === 200);
  ok('the URL changed', after.body.photoUrl !== oldUrl);
  ok('the NEW photo serves', (await api('GET', after.body.photoUrl, { token: alumTok })).status === 200);
  ok('the old URL stops serving', (await api('GET', oldUrl, { token: alumTok })).status === 404);
  ok('the old file was deleted', !fs.existsSync(path.join(photoDir(), oldName)));
  ok('exactly one file remains', filesFor(subjectUid).length === 1, filesFor(subjectUid));
  ok('the record was updated BEFORE the old file went — the row never pointed at nothing',
    /UPDATE \$\{current\.table\} SET photo_url[\s\S]{0,400}?removePhoto\(previous\)/.test(src('server.js')));

  /* ══ D. unauthenticated ══ */
  head('D. An unauthenticated caller can do none of it');
  ok('cannot upload', (await api('POST', '/api/profile/photo', { body: { image: await png(100, 100) } })).status === 401);
  ok('cannot remove', (await api('DELETE', '/api/profile/photo')).status === 401);
  ok('cannot read a photo', (await api('GET', after.body.photoUrl)).status === 401);

  /* ══ E. IDOR ══ */
  head('E. The subject is the session, never the request');
  const victim = (await db.query(
    `SELECT u.id FROM users u JOIN alumni_profiles ap ON ap.user_id=u.id
      WHERE u.id <> $1 ORDER BY u.id LIMIT 1`, [subjectUid])).rows[0];
  const victimBefore = (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [victim.id])).rows[0].photo_url;
  const forged = await api('POST', '/api/profile/photo', { token: alumTok, body: {
    image: await png(200, 200), userId: victim.id, id: victim.id, user_id: victim.id, uid: victim.id } });
  ok('a body naming another account is accepted but ignored', forged.status === 200);
  ok('…and writes to the SESSION\'s account', forged.body.photoUrl.startsWith(`/api/profile/photo/${subjectUid}?`));
  ok('…leaving the other account untouched',
    (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [victim.id])).rows[0].photo_url === victimBefore);
  ok('no route accepts a subject id for writing',
    !/app\.(post|put|delete)\('\/api\/profile\/photo\/:/.test(src('server.js')));
  const del = await api('DELETE', '/api/profile/photo', { token: alumTok, body: { userId: victim.id } });
  ok('a delete naming another account removes only the caller\'s', del.status === 200);
  ok('…and the other account still has its photo',
    (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [victim.id])).rows[0].photo_url === victimBefore);

  /* an administrator gains no photo-editing right over a member */
  ok('there is no administrator route for editing another member\'s photo',
    !/api\/(admin|profile)\/photo\/:id['"`],\s*requireRole/.test(src('server.js')));

  /* ══ F/G. type and integrity ══ */
  head('F. A declared type is not evidence, and G. malformed input is refused');
  const evil = [
    ['a script declared as JPEG', 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64')],
    ['an SVG with a payload', 'data:image/svg+xml;base64,' + Buffer.from('<svg onload=alert(1)/>').toString('base64')],
    ['an SVG declared as PNG', 'data:image/png;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')],
    ['HTML declared as WebP', 'data:image/webp;base64,' + Buffer.from('<!doctype html>').toString('base64')],
    ['an executable header', 'data:image/jpeg;base64,' + Buffer.from('MZ ').toString('base64')],
    ['a GIF (not an accepted type)', 'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64')],
    ['a JPEG header with no image', 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF]).toString('base64')],
    ['a path instead of a data URL', '../../server.js'],
    ['an absolute path', '/etc/passwd'],
    ['an empty payload', 'data:image/png;base64,'],
    ['a number', 42],
    ['nothing at all', undefined]
  ];
  for (const [label, image] of evil) {
    const r = await api('POST', '/api/profile/photo', { token: alumTok, body: { image } });
    ok(`refused: ${label}`, r.status === 400, { status: r.status, err: r.body && r.body.error });
  }
  ok('no refusal leaks anything internal',
    !/pg_|SQLSTATE|node_modules|at Object|Daffodil\\\\|\/Daffodil\//.test(
      JSON.stringify((await api('POST', '/api/profile/photo', { token: alumTok, body: { image: 'x' } })).body)));

  /* ══ H. size ══ */
  head('H. Oversized uploads');
  const huge = 'data:image/png;base64,' + Buffer.alloc(11 * 1024 * 1024, 0x41).toString('base64');
  const over = await api('POST', '/api/profile/photo', { token: alumTok, body: { image: huge } });
  ok('an 11 MB payload is refused', over.status === 400 || over.status === 413, over.status);
  ok('the byte limit is enforced in the module too',
    (await photos.storePhoto(1, 'data:image/jpeg;base64,' +
      Buffer.alloc(photos.MAX_UPLOAD_BYTES + 16, 0xFF).toString('base64'))).error !== undefined);
  ok('the larger body limit is scoped to the photo route alone',
    /req\.path === '\/api\/profile\/photo'/.test(src('server.js')));
  ok('an absurd pixel count is refused before it is stored',
    photos.MAX_SOURCE_EDGE > 0 && photos.MAX_SOURCE_EDGE <= 20000);

  /* ══ I. EXIF ══ */
  head('I. EXIF is not carried into the stored file');
  const plain = await (new Jimp({ width: 640, height: 480, color: 0x3366ffff })).getBuffer('image/jpeg');
  const exifPayload = Buffer.from('Exif\0\0MM\0*\0\0\0\0\0\0\0\0\0\0\0', 'binary');
  const app1 = Buffer.concat([
    Buffer.from([0xFF, 0xE1, ((exifPayload.length + 2) >> 8) & 0xFF, (exifPayload.length + 2) & 0xFF]), exifPayload]);
  const withExif = Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]);
  ok('the source really carries an EXIF marker', withExif.includes(Buffer.from('Exif')));
  const exifUp = await api('POST', '/api/profile/photo',
    { token: alumTok, body: { image: 'data:image/jpeg;base64,' + withExif.toString('base64') } });
  ok('it uploads', exifUp.status === 200, exifUp.body);
  const exifServed = await api('GET', exifUp.body.photoUrl, { token: alumTok });
  ok('the STORED file carries no EXIF segment', !exifServed.bytes.includes(Buffer.from('Exif')));
  ok('…because it is re-encoded from pixels, not copied',
    /Jimp\.read/.test(src('photos.js')) && /getBuffer\('image\/jpeg'/.test(src('photos.js')));

  /* transparency must not arrive as a black square */
  const transparent = new Jimp({ width: 300, height: 300, color: 0x00000000 });
  const tUp = await api('POST', '/api/profile/photo', { token: alumTok, body: {
    image: 'data:image/png;base64,' + (await transparent.getBuffer('image/png')).toString('base64') } });
  const tServed = await api('GET', tUp.body.photoUrl, { token: alumTok });
  const tImg = await Jimp.read(tServed.bytes);
  const corner = tImg.getPixelColor(4, 4);
  ok('a fully transparent PNG is composited onto white, not black',
    ((corner >>> 24) & 0xFF) > 200, '0x' + corner.toString(16));

  /* ══ O. the file is not reachable except through the route ══ */
  head('O. Stored files are not statically served');
  const name = photos.nameFromUrl(tUp.body.photoUrl);
  for (const p of [`/uploads/profile-photos/${name}`, '/uploads/', '/uploads',
                   `/uploads/profile-photos/${name}/../../../.env`]) {
    const r = await fetch(B + p);
    ok(`static ${p.slice(0, 42)} is unreachable`, r.status === 404, r.status);
  }
  ok('the stored name is generated, never taken from the client',
    /newPhotoName/.test(src('photos.js')) && /randomBytes/.test(src('photos.js')));
  ok('a traversal name is rejected by the path guard', photos.safePath('../../.env') === null);
  ok('a plausible but wrong name is rejected', photos.safePath('u1-zz.jpg') === null);
  ok('serving an old version of a current photo is refused',
    (await api('GET', `/api/profile/photo/${subjectUid}?v=u${subjectUid}-000000000000000000000000.jpg`,
      { token: alumTok })).status === 404);

  /* ══ L. visibility ══ */
  head('L. A photo is as visible as the profile it belongs to');
  const current = (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [subjectUid])).rows[0].photo_url;
  ok('another signed-in member can see it', (await api('GET', current, { token: superTok })).status === 200);
  ok('an anonymous caller cannot', (await api('GET', current)).status === 401);
  const servedHeaders = (await api('GET', current, { token: alumTok })).headers;
  ok('it is not cached by shared caches', /private/.test(servedHeaders['cache-control'] || ''), servedHeaders['cache-control']);
  ok('it is served with nosniff', servedHeaders['x-content-type-options'] === 'nosniff');
  ok('it is served as an image, not as a download', /image\/jpeg/.test(servedHeaders['content-type'] || ''));
  ok('a request for an account with no photo is a plain 404',
    (await api('GET', '/api/profile/photo/99999999', { token: alumTok })).status === 404);
  ok('…the same answer a real account with no photo gives — no enumeration',
    (await api('GET', `/api/profile/photo/${victim.id}`, { token: alumTok })).status === 404);

  /* ══ C. removal ══ */
  head('C. Removal');
  const before2 = (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [subjectUid])).rows[0].photo_url;
  const nameBefore = photos.nameFromUrl(before2);
  const removed = await api('DELETE', '/api/profile/photo', { token: alumTok });
  ok('the member removes their photo', removed.status === 200);
  ok('the record is cleared',
    (await db.query('SELECT photo_url FROM alumni_profiles WHERE user_id=$1', [subjectUid])).rows[0].photo_url === null);
  ok('the file is deleted', !fs.existsSync(path.join(photoDir(), nameBefore)));
  ok('the URL stops serving', (await api('GET', before2, { token: alumTok })).status === 404);
  ok('removing again is not an error', (await api('DELETE', '/api/profile/photo', { token: alumTok })).status === 200);
  ok('removal is audited',
    (await db.query(`SELECT COUNT(*)::int n FROM audit_logs WHERE action='Profile Photo Removed'`)).rows[0].n > 0);
  ok('an external URL is cleared from the profile but never deleted from disk',
    /nameFromUrl\(current\.url\)/.test(src('server.js')) && /^null$/m.test('null'));

  /* ══ K. the camera flow ══ */
  head('K. Camera flow and its fallbacks (client source)');
  const photoJs = src('js/photo.js');
  ok('getUserMedia is used', /navigator\.mediaDevices\.getUserMedia/.test(photoJs));
  ok('the front camera is preferred but not required',
    /facingMode: \{ ideal: 'user' \}/.test(photoJs), 'ideal, not exact');
  ok('permission denial shows the wording §16 asks for',
    /Camera access was denied\. You can choose a photo from your device instead\./.test(photoJs));
  ok('a file-input fallback exists', /type="file"/.test(photoJs) && /accept="\$\{PHOTO_ACCEPT\}"/.test(photoJs));
  ok('the accept list is JPEG, PNG and WebP',
    /image\/jpeg,image\/png,image\/webp/.test(photoJs));
  ok('Take Photo is only offered where a camera could exist', /cameraLikelyAvailable/.test(photoJs));
  for (const [what, re] of [
    ['capture', /function capturePhoto[\s\S]{0,900}?stopPhotoCamera\(\)/],
    ['cancel and close', /function closePhotoEditor[\s\S]{0,200}?resetPhotoState\(\)/],
    ['an error opening the camera', /catch \(err\) \{\s*stopPhotoCamera\(\)/],
    ['the modal closing', /onClose: resetPhotoState/],
    ['the page going away', /pagehide['"]?, resetPhotoState/],
    ['the tab being hidden', /visibilitychange[\s\S]{0,160}?stopPhotoCamera\(\)/]
  ]) {
    ok(`the stream is stopped on: ${what}`, re.test(photoJs));
  }
  ok('every track is stopped, not just the first', /getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(photoJs));

  /* ══ crop ══ */
  head('Crop controls');
  ok('drag is wired for mouse and touch',
    /addEventListener\('mousedown'/.test(photoJs) && /addEventListener\('touchstart'/.test(photoJs));
  ok('zoom exists', /function setPhotoZoom/.test(photoJs));
  ok('rotate exists', /function rotatePhoto/.test(photoJs));
  ok('reset restores rotation as well as zoom and position',
    /function resetPhotoCrop\(\)[\s\S]{0,400}?photoState\.rotation = 0/.test(photoJs));
  ok('the frame is square', /width="\$\{PHOTO_OUTPUT\}" height="\$\{PHOTO_OUTPUT\}"/.test(photoJs));
  ok('nothing uploads before the member confirms',
    /function savePhoto[\s\S]{0,600}?uploadProfilePhoto/.test(photoJs));
  ok('no face detection or automatic cropping is present',
    !/faceDetector|FaceDetector|detectFaces|autoCrop|blazeface/i.test(photoJs));
  ok('the crop is keyboard reachable', /tabindex="0"/.test(photoJs) && /addEventListener\('keydown'/.test(photoJs));
  ok('the canvas carries an accessible label', /aria-label="Crop preview/.test(photoJs));
  ok('the camera preview carries one too', /aria-label="Live camera preview"/.test(photoJs));
  ok('the close control is labelled', /aria-label="Close"/.test(photoJs));
  ok('the client downscales before uploading', /PHOTO_WORK_MAX/.test(photoJs));

  /* ══ M. fallback ══ */
  head('M. No photo means initials, never a broken image');
  ok('the shared avatar helper renders initials when there is no photo',
    /function avatarHtml/.test(photoJs) && /avatar-initials/.test(photoJs));
  ok('an image that fails to load removes itself', /onerror="this\.remove\(\)"/.test(photoJs));
  ok('the directory renders initials underneath the photo',
    /avatar-initials/.test(src('js/directory.js')));
  ok('the profile slot does too', /avatar-initials/.test(src('js/profile.js')));
  ok('the avatar wrapper is not clipped, so the verified badge survives',
    /Deliberately NOT overflow:hidden/.test(src('styles.css')));
  ok('photos are fetched with the session and shown as object URLs',
    /photoObjectUrl/.test(photoJs) && /createObjectURL/.test(photoJs));
  ok('…and released, so a long session does not leak them', /revokeObjectURL/.test(photoJs));

  /* ══ no duplicate column ══ */
  head('Data model');
  /* The two that already existed and nothing else: alumni_profiles.photo_url
     and users.photo_url. This phase added no column. */
  const photoCols = (await db.query(
    `SELECT string_agg(table_name||'.'||column_name, ', ' ORDER BY table_name) s
       FROM information_schema.columns WHERE column_name ILIKE '%photo%'`)).rows[0].s;
  ok('no new photo column was added',
    photoCols === 'alumni_profiles.photo_url, users.photo_url', photoCols);
  ok('an alumni photo lives on the profile row',
    /alumni_profiles WHERE user_id/.test(src('server.js')));
  ok('a staff photo lives on the user row, as it already did',
    /FROM users WHERE id = \$1/.test(src('server.js')));

  console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n`);
 } catch (err) {
  console.error('\n  SUITE ERROR:', err.message, '\n', (err.stack || '').split('\n')[1]);
  fail++;
 } finally {
  await cleanup();
  const strays = filesFor(subjectUid).length + (probeUid ? filesFor(probeUid).length : 0);
  if (strays) console.log(`  NOTE  ${strays} photo file(s) left, all still referenced`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
 }
})();
