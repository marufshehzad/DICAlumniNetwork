/* ============================================================
   DIC ALUMNI PLATFORM — PROFILE PHOTO STORAGE AND PROCESSING
   Phase 7F.

   Everything that turns bytes a browser sent into a profile photo this platform
   is willing to serve. The rule throughout: nothing the client says about the
   file is believed. Not the filename, not the MIME type, not the dimensions.
   The bytes are decoded, and if they do not decode to an image, they are not an
   image, whatever they claim.

   WHY THE SERVER RE-ENCODES RATHER THAN VALIDATES

   Checking magic numbers and reading a header would tell us a file LOOKS like a
   JPEG. It would not stop a JPEG carrying a payload after its end marker, or a
   polyglot that is a valid image and a valid something-else. Decoding to a
   pixel buffer and writing a NEW file means the bytes on disk are bytes this
   process produced from pixels — not attacker bytes that passed a check. EXIF,
   colour profiles, comment segments, trailing data and anything hidden in them
   are gone because they were never carried across.

   That is also how orientation is normalised: EXIF orientation is applied
   during decode and then the tag is simply not written out.

   WHERE FILES GO

   Not into the repository, and not anywhere express.static can reach. The
   static allow-list in server.js serves only a fixed set of files and two
   directories, so an uploads directory is a 404 by default — photos are served
   by an authenticated route that applies the same visibility the directory
   does. UPLOAD_DIR makes the location configurable for a VPS without any
   provider-specific code.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Jimp } = require('jimp');

/* ─── limits, all enforced server-side ───────────────────────
   The client downscales before uploading, so a well-behaved browser sends
   something far below the first limit. These are for everyone else. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;   // 10 MB of source image
const CANONICAL_SIZE   = 512;                // stored photos are 512×512
const MAX_SOURCE_EDGE  = 8000;               // refuse absurd dimensions before decoding cost
const JPEG_QUALITY     = 82;

/* Where photos live. Absolute so a change of working directory cannot silently
   relocate the store, and created on demand rather than assumed. */
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads', 'profile-photos'));

function ensureDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* ─── the stored name ────────────────────────────────────────
   Generated here, never derived from anything the client sent. A filename is
   the classic path-traversal vector and the simplest defence is to not use
   theirs at all. The random half means a removed photo's URL cannot be guessed
   back into existence, and a replacement gets a new name so caches do not serve
   the old face. */
function newPhotoName(userId) {
  return `u${Number(userId)}-${crypto.randomBytes(12).toString('hex')}.jpg`;
}

/* A name is only ever accepted back from our own database, but it is validated
   anyway: one path segment, our exact shape, nothing else. */
const NAME_RE = /^u\d+-[0-9a-f]{24}\.jpg$/;
function safePath(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const full = path.resolve(UPLOAD_DIR, name);
  // Belt and braces: the resolved path must still be inside the store.
  if (!full.startsWith(UPLOAD_DIR + path.sep)) return null;
  return full;
}

/* ─── what the caller is allowed to send ─────────────────────
   A data URL, because it means no multipart parser and no temporary file: the
   bytes arrive as one JSON string and are decoded here. The declared type in
   the prefix is READ but not TRUSTED — it only decides whether to bother
   decoding at all. */
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { error: 'No image was sent.' };
  const m = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!m) return { error: 'That is not an image file.' };

  const declared = m[1].toLowerCase();
  if (!ACCEPTED_TYPES.includes(declared)) {
    return { error: 'Profile photos must be a JPEG, PNG or WebP image.' };
  }

  let buf;
  try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); }
  catch { return { error: 'That image could not be read.' }; }

  if (!buf.length) return { error: 'That image is empty.' };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { error: `Images must be smaller than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` };
  }
  return { buffer: buf, declared };
}

/* ─── the real check ─────────────────────────────────────────
   Magic numbers first, because they are cheap and they end the argument about
   what an SVG is: an SVG is text, it has no image magic, and it never reaches
   the decoder. Then a real decode, which is what actually decides. */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF'
      && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Turn whatever arrived into a stored 512×512 JPEG, or refuse it.
 * @returns {{name: string, bytes: number} | {error: string}}
 */
async function storePhoto(userId, dataUrl) {
  const decoded = decodeDataUrl(dataUrl);
  if (decoded.error) return { error: decoded.error };

  const actual = sniff(decoded.buffer);
  if (!actual) {
    /* The declared type said image; the bytes disagree. This is the case that
       catches a script, an HTML file or an SVG renamed and sent as a photo. */
    return { error: 'That file is not a JPEG, PNG or WebP image.' };
  }

  let image;
  try {
    image = await Jimp.read(decoded.buffer);
  } catch {
    return { error: 'That image is damaged and could not be opened.' };
  }

  const w = image.bitmap.width, h = image.bitmap.height;
  if (!w || !h) return { error: 'That image has no usable dimensions.' };
  if (w > MAX_SOURCE_EDGE || h > MAX_SOURCE_EDGE) {
    return { error: `Images must be no more than ${MAX_SOURCE_EDGE} pixels on a side.` };
  }

  /* Cover-crop to a square, then to the canonical size. The client crops
     already and normally sends a square; this is what happens when it does not.
     Cropping the centre is the least surprising thing to do to a photo nobody
     framed. */
  try {
    const edge = Math.min(w, h);
    if (w !== h) {
      image.crop({ x: Math.floor((w - edge) / 2), y: Math.floor((h - edge) / 2), w: edge, h: edge });
    }
    image.resize({ w: CANONICAL_SIZE, h: CANONICAL_SIZE });
  } catch {
    return { error: 'That image could not be processed.' };
  }

  /* A PNG with transparency becomes a JPEG, which has none, and un-composited
     transparency renders black. Compositing onto white first is why a
     transparent avatar does not arrive as a black square. */
  let out;
  try {
    const canvas = new Jimp({ width: CANONICAL_SIZE, height: CANONICAL_SIZE, color: 0xffffffff });
    canvas.composite(image, 0, 0);
    out = await canvas.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
  } catch {
    return { error: 'That image could not be converted.' };
  }

  ensureDir();
  const name = newPhotoName(userId);
  const full = safePath(name);
  if (!full) return { error: 'That image could not be stored.' };

  /* Written to a temporary name and renamed into place, so a reader can never
     observe a half-written file — and so a failure part-way leaves the previous
     photo untouched. */
  const tmp = full + '.part';
  await fs.promises.writeFile(tmp, out, { mode: 0o600 });
  await fs.promises.rename(tmp, full);

  return { name, bytes: out.length, width: CANONICAL_SIZE, height: CANONICAL_SIZE };
}

/** Remove a stored photo. Missing is success: the caller wanted it gone. */
async function removePhoto(name) {
  const full = safePath(name);
  if (!full) return false;
  try { await fs.promises.unlink(full); return true; }
  catch (e) { return e.code === 'ENOENT'; }
}

/** Read a stored photo for serving. Null when there is nothing to serve. */
async function readPhoto(name) {
  const full = safePath(name);
  if (!full) return null;
  try { return await fs.promises.readFile(full); }
  catch { return null; }
}

/* The stored file name embedded in a photo URL this platform issued. Returns
   null for anything else — including the external URLs the bulk import and the
   administrator form still accept, which are not ours to delete. */
function nameFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^\/api\/profile\/photo\/\d+\?v=(u\d+-[0-9a-f]{24}\.jpg)$/.exec(url);
  return m && NAME_RE.test(m[1]) ? m[1] : null;
}

function photoUrl(userId, name) {
  return `/api/profile/photo/${Number(userId)}?v=${name}`;
}

module.exports = {
  storePhoto, removePhoto, readPhoto, nameFromUrl, photoUrl, safePath, sniff,
  UPLOAD_DIR, MAX_UPLOAD_BYTES, CANONICAL_SIZE, MAX_SOURCE_EDGE, ACCEPTED_TYPES
};
