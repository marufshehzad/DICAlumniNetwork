/* ============================================================
   DIC ALUMNI PLATFORM — PROFILE PHOTO
   Phase 7F. Upload, camera capture, crop, replace and remove.

   Loaded by both portals. Everything here is client-side convenience: the
   server re-decodes and re-encodes whatever arrives, so nothing this file does
   is a security control. What it IS responsible for is not sending a 12-megapixel
   phone photo over a mobile connection when a 512-pixel square is what gets
   stored — the crop and downscale happen here, and the upload is a few tens of
   kilobytes rather than several megabytes.

   THE CAMERA. getUserMedia, front camera preferred, with a file-input fallback
   carrying `capture` for browsers that refuse the stream or where permission is
   denied. Every exit path from this module stops the tracks: capture, cancel,
   save, close, an error, and a page change. A camera light left on after a
   modal closes is the kind of thing people notice and do not forgive.

   THE CROP. A square frame, drag to move, a slider to zoom, buttons to rotate
   and reset. No face detection, no automatic framing — where the crop sits is
   the member's decision.
   ============================================================ */

/* Stored photos are 512×512. Producing exactly that here means the server's
   resize is a no-op for a well-behaved client and the preview matches the
   result. */
const PHOTO_OUTPUT = 512;
/* What we will hand to the canvas before cropping. A phone photo can be 4000px
   on a side; drawing that repeatedly while somebody drags is what makes a crop
   UI feel broken on a mid-range Android. */
const PHOTO_WORK_MAX = 1600;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

/* All mutable state for the editor, in one place so teardown can be one call. */
let photoState = {
  stream: null,       // the live MediaStream, when the camera is open
  image: null,        // the HTMLImageElement being cropped
  scale: 1,
  minScale: 1,
  rotation: 0,        // degrees, always a multiple of 90
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  lastX: 0,
  lastY: 0,
  busy: false
};

/* ─── teardown ───────────────────────────────────────────────
   Called from every exit. Stopping a track twice is harmless; not stopping it
   once leaves the camera running. */
function stopPhotoCamera() {
  if (photoState.stream) {
    try { photoState.stream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
    photoState.stream = null;
  }
  const v = document.getElementById('photo-camera-video');
  if (v) { try { v.pause(); } catch {} v.srcObject = null; }
}

function resetPhotoState() {
  stopPhotoCamera();
  photoState.image = null;
  photoState.scale = 1;
  photoState.minScale = 1;
  photoState.rotation = 0;
  photoState.offsetX = 0;
  photoState.offsetY = 0;
  photoState.dragging = false;
  photoState.busy = false;
}

/* A page change must not leave the camera on. closeModal is the single exit the
   rest of the application uses, so it is wrapped once rather than every caller
   being asked to remember. */
if (typeof window !== 'undefined' && !window.__photoTeardownWired) {
  window.__photoTeardownWired = true;
  window.addEventListener('pagehide', resetPhotoState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPhotoCamera();
  });
}

/* ─── making an authenticated image displayable ──────────────

   Photos are served by a route that requires a session, because a face is
   personal data and the directory it appears in requires one. An <img> tag
   cannot carry an Authorization header — it sends cookies, and this platform
   has none — so `src="/api/profile/photo/5?v=…"` is a guaranteed 401 and the
   onerror fallback would strip every avatar on the page.

   The alternatives were: put the photo in a public directory (the thing §10
   explicitly warns against), sign a URL that works without a session (a
   capability link to somebody's face, forwardable by anyone who gets it), or
   change how the platform authenticates (out of scope, and not worth it for
   this). So instead the bytes are fetched WITH the token and handed to the
   <img> as an object URL.

   Fetched once per URL per page. The map is keyed by the photo URL, which
   changes whenever the photo does, so a replacement is never served from here.
   Object URLs are released on unload; holding them is what leaks memory in a
   long-lived single-page session. */
const _photoObjectUrls = new Map();

async function photoObjectUrl(url) {
  if (!url) return null;
  if (_photoObjectUrls.has(url)) return _photoObjectUrls.get(url);

  const p = (async () => {
    try {
      const res = await fetchWithTimeout(url, {}, 20000);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size || !/^image\//.test(blob.type)) return null;
      return URL.createObjectURL(blob);
    } catch { return null; }
  })();

  _photoObjectUrls.set(url, p);
  return p;
}

/* Swap every pending avatar in a subtree for its fetched bytes. Renderers emit
   data-photo-src rather than src, so nothing ever issues an unauthenticated
   request that was always going to fail. */
async function hydrateAvatars(root) {
  const scope = root || document;
  const pending = scope.querySelectorAll('img.avatar-img[data-photo-src]');
  for (const img of pending) {
    const src = img.getAttribute('data-photo-src');
    img.removeAttribute('data-photo-src');
    const obj = await photoObjectUrl(src);
    /* No object URL means no photo: a 401, a deleted file, or a network
       failure. Removing the <img> reveals the initials underneath, which is
       the same fallback a member with no photo gets. */
    if (obj) img.src = obj; else img.remove();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const p of _photoObjectUrls.values()) {
      Promise.resolve(p).then(u => { if (u) URL.revokeObjectURL(u); }).catch(() => {});
    }
    _photoObjectUrls.clear();
  });
}

/* ─── the avatar everything else renders ─────────────────────
   One helper so the photo and the initials fallback cannot disagree between
   the directory, the profile, the topbar and the event people list. An <img>
   that fails to load removes itself and reveals the initials underneath, so a
   deleted file shows a normal avatar rather than a broken-image icon. */
function avatarHtml(person, size = 40, extraClass = '') {
  const name = (person && (person.name || person.full_name)) || '';
  const initials = (person && person.initials)
    || name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
    || '?';
  const url = person && (person.photoUrl || person.photo_url);
  const px = Number(size) || 40;
  const box = `width:${px}px;height:${px}px;font-size:${Math.max(10, Math.round(px * 0.36))}px`;

  if (url) {
    return `<span class="avatar-wrap ${extraClass}" style="${box}">
      <span class="avatar-initials" aria-hidden="true">${escapeHtml(initials)}</span>
      <img class="avatar-img" data-photo-src="${escapeHtml(url)}" alt=""
           onerror="this.remove()" />
    </span>`;
  }
  return `<span class="avatar-wrap ${extraClass}" style="${box}">
    <span class="avatar-initials" aria-hidden="true">${escapeHtml(initials)}</span>
  </span>`;
}

/* ─── the chooser ────────────────────────────────────────────
   Take Photo is offered only where a camera could plausibly exist. Offering it
   on a desktop with no webcam is a button that opens a permission prompt and
   then fails, which is worse than not offering it. */
function cameraLikelyAvailable() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function showPhotoChooser(hasPhoto) {
  resetPhotoState();
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="camera" class="ui-icon"></i> Profile photo</div>
      <button type="button" class="modal-close" aria-label="Close" onclick="closePhotoEditor()">
        <i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p class="photo-hint">A square photo of your face works best. It is shown to other DIC alumni
      in the directory and wherever your name appears.</p>
    <div class="photo-choices">
      ${cameraLikelyAvailable() ? `
        <button type="button" class="btn btn-primary btn-full" onclick="startPhotoCamera()">
          <i data-lucide="camera" class="ui-icon"></i> Take photo
        </button>` : ''}
      <button type="button" class="btn btn-outline btn-full" onclick="document.getElementById('photo-file-input').click()">
        <i data-lucide="image" class="ui-icon"></i> Choose from device
      </button>
      ${hasPhoto ? `
        <button type="button" class="btn btn-outline btn-full photo-remove" onclick="confirmRemovePhoto()">
          <i data-lucide="trash-2" class="ui-icon"></i> Remove current photo
        </button>` : ''}
    </div>
    <input type="file" id="photo-file-input" accept="${PHOTO_ACCEPT}"
           aria-label="Choose a photo from your device" style="display:none"
           onchange="handlePhotoFile(this)" />
    <p class="photo-note">JPEG, PNG or WebP, up to 10&nbsp;MB. Your photo is resized to
      ${PHOTO_OUTPUT}&times;${PHOTO_OUTPUT} and stripped of camera metadata before it is stored.</p>
  `, { onClose: resetPhotoState });
}

/* ─── camera ─────────────────────────────────────────────── */
async function startPhotoCamera() {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="camera" class="ui-icon"></i> Take a photo</div>
      <button type="button" class="modal-close" aria-label="Close" onclick="closePhotoEditor()">
        <i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <div class="photo-camera-frame">
      <video id="photo-camera-video" playsinline autoplay muted
             aria-label="Live camera preview"></video>
    </div>
    <div id="photo-camera-error" class="photo-error hidden" role="alert"></div>
    <div class="photo-actions">
      <button type="button" class="btn btn-outline" onclick="showPhotoChooser(false)">Back</button>
      <button type="button" class="btn btn-primary" id="photo-capture-btn" onclick="capturePhoto()">
        <i data-lucide="circle" class="ui-icon"></i> Capture
      </button>
    </div>
  `, { onClose: resetPhotoState });
  if (window.lucide) lucide.createIcons();

  try {
    /* facingMode is a preference, not a requirement — `ideal` rather than
       `exact`, so a laptop with one rear-less camera still works instead of
       throwing OverconstrainedError. */
    photoState.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    const v = document.getElementById('photo-camera-video');
    if (!v) { stopPhotoCamera(); return; }        // the modal closed while we waited
    v.srcObject = photoState.stream;
    await v.play().catch(() => { /* autoplay policy; the stream is still live */ });
  } catch (err) {
    stopPhotoCamera();
    const box = document.getElementById('photo-camera-error');
    const btn = document.getElementById('photo-capture-btn');
    if (btn) btn.disabled = true;
    if (box) {
      box.classList.remove('hidden');
      box.textContent = (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))
        ? 'Camera access was denied. You can choose a photo from your device instead.'
        : 'No camera is available on this device. You can choose a photo from your device instead.';
    }
  }
}

function capturePhoto() {
  const v = document.getElementById('photo-camera-video');
  if (!v || !v.videoWidth) return;
  const c = document.createElement('canvas');
  const edge = Math.min(v.videoWidth, v.videoHeight);
  c.width = edge; c.height = edge;
  /* Centre-crop the frame to a square as it is captured, so what the member
     framed in a square preview is what reaches the cropper. */
  c.getContext('2d').drawImage(v,
    Math.floor((v.videoWidth - edge) / 2), Math.floor((v.videoHeight - edge) / 2), edge, edge,
    0, 0, edge, edge);
  const dataUrl = c.toDataURL('image/jpeg', 0.92);
  stopPhotoCamera();                    // the moment the frame is taken
  loadPhotoForCrop(dataUrl);
}

/* ─── file picker ────────────────────────────────────────── */
function handlePhotoFile(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  /* The accept attribute is a filter in a dialog, not a check. Both of these
     are conveniences too — the server decides — but they save a member a slow
     upload that was always going to be refused. */
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    showToast('⚠ Choose a JPEG, PNG or WebP image.');
    input.value = '';
    return;
  }
  if (file.size > PHOTO_MAX_BYTES) {
    showToast('⚠ That image is larger than 10 MB. Choose a smaller one.');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => loadPhotoForCrop(String(reader.result));
  reader.onerror = () => showToast('⚠ That file could not be read.');
  reader.readAsDataURL(file);
  input.value = '';     // so choosing the same file twice fires change again
}

/* ─── crop ───────────────────────────────────────────────── */
function loadPhotoForCrop(dataUrl) {
  const img = new Image();
  img.onload = () => {
    /* Downscale before cropping. Nothing above PHOTO_WORK_MAX improves a
       512-pixel result, and dragging a 4000px bitmap is what makes this feel
       slow on a phone. */
    let { width: w, height: h } = img;
    if (Math.max(w, h) > PHOTO_WORK_MAX) {
      const k = PHOTO_WORK_MAX / Math.max(w, h);
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const small = new Image();
      small.onload = () => { photoState.image = small; showPhotoCropper(); };
      small.src = c.toDataURL('image/jpeg', 0.92);
      return;
    }
    photoState.image = img;
    showPhotoCropper();
  };
  img.onerror = () => showToast('⚠ That image could not be opened.');
  img.src = dataUrl;
}

function showPhotoCropper() {
  photoState.rotation = 0;
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="crop" class="ui-icon"></i> Crop photo</div>
      <button type="button" class="modal-close" aria-label="Close" onclick="closePhotoEditor()">
        <i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p class="photo-hint">Drag to move. Use the slider to zoom. The circle is what other
      people will see.</p>
    <div class="photo-crop-stage">
      <canvas id="photo-crop-canvas" width="${PHOTO_OUTPUT}" height="${PHOTO_OUTPUT}"
              role="img" aria-label="Crop preview. Drag to reposition your photo."
              tabindex="0"></canvas>
      <div class="photo-crop-ring" aria-hidden="true"></div>
    </div>
    <div class="photo-zoom">
      <label class="input-label" for="photo-zoom-range">Zoom</label>
      <input type="range" id="photo-zoom-range" min="100" max="400" value="100"
             oninput="setPhotoZoom(this.value)" />
    </div>
    <div class="photo-tools">
      <button type="button" class="btn btn-outline btn-sm" onclick="rotatePhoto(-90)" aria-label="Rotate left">
        <i data-lucide="rotate-ccw" class="ui-icon"></i> Left</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="rotatePhoto(90)" aria-label="Rotate right">
        <i data-lucide="rotate-cw" class="ui-icon"></i> Right</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="resetPhotoCrop()">
        <i data-lucide="refresh-cw" class="ui-icon"></i> Reset</button>
    </div>
    <div class="photo-actions">
      <button type="button" class="btn btn-outline" onclick="closePhotoEditor()">Cancel</button>
      <button type="button" class="btn btn-primary" id="photo-save-btn" onclick="savePhoto()">
        <i data-lucide="check" class="ui-icon"></i> Save photo</button>
    </div>
  `, { onClose: resetPhotoState });
  if (window.lucide) lucide.createIcons();
  resetPhotoCrop();
  wirePhotoDrag();
}

/* The smallest zoom that still covers the whole frame, given the rotation. */
function photoMinScale() {
  const img = photoState.image;
  if (!img) return 1;
  const swap = (photoState.rotation / 90) % 2 !== 0;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;
  return PHOTO_OUTPUT / Math.min(w, h);
}

function resetPhotoCrop() {
  /* Reset means reset. Leaving the rotation behind made the button return the
     zoom and position but keep the photo sideways, which is not what anyone
     pressing "Reset" is asking for. */
  photoState.rotation = 0;
  photoState.minScale = photoMinScale();
  photoState.scale = photoState.minScale;
  photoState.offsetX = 0;
  photoState.offsetY = 0;
  const range = document.getElementById('photo-zoom-range');
  if (range) range.value = '100';
  drawPhotoCrop();
}

function setPhotoZoom(pct) {
  photoState.scale = photoState.minScale * (Number(pct) / 100);
  clampPhotoOffset();
  drawPhotoCrop();
}

function rotatePhoto(deg) {
  photoState.rotation = (photoState.rotation + deg + 360) % 360;
  /* Rotating changes which edge is the short one, so the minimum zoom changes
     with it. Keeping the member's relative zoom rather than snapping back to
     fit is what makes two rotations feel like one action. */
  const prevRatio = photoState.scale / photoState.minScale;
  photoState.minScale = photoMinScale();
  photoState.scale = photoState.minScale * prevRatio;
  clampPhotoOffset();
  drawPhotoCrop();
}

/* The image may never be dragged far enough to show background inside the
   frame. */
function clampPhotoOffset() {
  const img = photoState.image;
  if (!img) return;
  const swap = (photoState.rotation / 90) % 2 !== 0;
  const w = (swap ? img.height : img.width) * photoState.scale;
  const h = (swap ? img.width : img.height) * photoState.scale;
  const maxX = Math.max(0, (w - PHOTO_OUTPUT) / 2);
  const maxY = Math.max(0, (h - PHOTO_OUTPUT) / 2);
  photoState.offsetX = Math.min(maxX, Math.max(-maxX, photoState.offsetX));
  photoState.offsetY = Math.min(maxY, Math.max(-maxY, photoState.offsetY));
}

function drawPhotoCrop() {
  const c = document.getElementById('photo-crop-canvas');
  const img = photoState.image;
  if (!c || !img) return;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PHOTO_OUTPUT, PHOTO_OUTPUT);
  ctx.save();
  ctx.translate(PHOTO_OUTPUT / 2 + photoState.offsetX, PHOTO_OUTPUT / 2 + photoState.offsetY);
  ctx.rotate(photoState.rotation * Math.PI / 180);
  ctx.scale(photoState.scale, photoState.scale);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
}

function wirePhotoDrag() {
  const c = document.getElementById('photo-crop-canvas');
  if (!c) return;
  const start = (x, y) => { photoState.dragging = true; photoState.lastX = x; photoState.lastY = y; };
  const move = (x, y) => {
    if (!photoState.dragging) return;
    /* The canvas is displayed smaller than its 512 backing store, so a pixel
       of finger movement is more than a pixel of image. Without this the drag
       lags behind the finger on a phone. */
    const k = PHOTO_OUTPUT / c.getBoundingClientRect().width;
    photoState.offsetX += (x - photoState.lastX) * k;
    photoState.offsetY += (y - photoState.lastY) * k;
    photoState.lastX = x; photoState.lastY = y;
    clampPhotoOffset();
    drawPhotoCrop();
  };
  const end = () => { photoState.dragging = false; };

  c.addEventListener('mousedown', e => { e.preventDefault(); start(e.clientX, e.clientY); });
  window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  window.addEventListener('mouseup', end);
  c.addEventListener('touchstart', e => {
    if (e.touches.length === 1) { e.preventDefault(); start(e.touches[0].clientX, e.touches[0].clientY); }
  }, { passive: false });
  c.addEventListener('touchmove', e => {
    if (e.touches.length === 1) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); }
  }, { passive: false });
  c.addEventListener('touchend', end);

  /* Keyboard: the crop is reachable without a pointer. Arrow keys nudge,
     + and - zoom, r rotates. */
  c.addEventListener('keydown', e => {
    const step = e.shiftKey ? 24 : 8;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      photoState.offsetX += moves[e.key][0];
      photoState.offsetY += moves[e.key][1];
      clampPhotoOffset(); drawPhotoCrop();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const r = document.getElementById('photo-zoom-range');
      if (r) { r.value = String(Math.min(400, Number(r.value) + 10)); setPhotoZoom(r.value); }
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      const r = document.getElementById('photo-zoom-range');
      if (r) { r.value = String(Math.max(100, Number(r.value) - 10)); setPhotoZoom(r.value); }
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault(); rotatePhoto(e.shiftKey ? -90 : 90);
    }
  });
}

/* ─── save ───────────────────────────────────────────────── */
async function savePhoto() {
  if (photoState.busy) return;
  const c = document.getElementById('photo-crop-canvas');
  if (!c) return;
  const btn = document.getElementById('photo-save-btn');
  photoState.busy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  /* What is sent is exactly what the canvas shows, so the preview and the
     stored photo are the same image. */
  const dataUrl = c.toDataURL('image/jpeg', 0.9);
  const res = await API.uploadProfilePhoto(dataUrl);

  photoState.busy = false;
  if (apiFailed(res)) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save photo'; }
    showToast(`⚠ ${res?.error || 'That photo could not be saved.'}`);
    return;
  }
  closePhotoEditor();
  showToast('✅ Profile photo updated.');
  applyPhotoEverywhere(res.photoUrl);
}

function confirmRemovePhoto() {
  showModal(`
    <div class="modal-header">
      <div class="modal-title"><i data-lucide="trash-2" class="ui-icon"></i> Remove your photo?</div>
      <button type="button" class="modal-close" aria-label="Close" onclick="closePhotoEditor()">
        <i data-lucide="x" class="ui-icon"></i></button>
    </div>
    <p class="photo-hint">Your initials will be shown instead, as they were before you added a photo.</p>
    <div class="photo-actions">
      <button type="button" class="btn btn-outline" onclick="closePhotoEditor()">Cancel</button>
      <button type="button" class="btn btn-danger" onclick="doRemovePhoto()">Remove photo</button>
    </div>
  `, { onClose: resetPhotoState });
  if (window.lucide) lucide.createIcons();
}

async function doRemovePhoto() {
  const res = await API.removeProfilePhoto();
  if (apiFailed(res)) { showToast(`⚠ ${res?.error || 'That photo could not be removed.'}`); return; }
  closePhotoEditor();
  showToast('✅ Photo removed.');
  applyPhotoEverywhere(null);
}

function closePhotoEditor() {
  resetPhotoState();
  closeModal();
}

/* Update the places showing this member's own avatar, so a save is visible
   without a page reload. */
function applyPhotoEverywhere(url) {
  if (window.state && state.currentUser) state.currentUser.photoUrl = url || null;
  for (const id of ['id-card-avatar', 'topbar-user-avatar', 'sidebar-user-avatar', 'profile-photo-slot']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const existing = el.querySelector('img.avatar-img');
    if (url) {
      if (existing) existing.remove();
      const img = document.createElement('img');
      img.className = 'avatar-img';
      img.alt = '';
      img.setAttribute('data-photo-src', url);
      img.onerror = function () { this.remove(); };
      el.appendChild(img);
      el.classList.add('has-photo');
      hydrateAvatars(el);
    } else if (existing) {
      existing.remove();
      el.classList.remove('has-photo');
    }
  }
  /* The page must agree with what just happened without a reload: the button
     changes between "Add a photo" and "Change photo", and the chooser only
     offers Remove when there is something to remove. loadMyProfile(true) drops
     the cached profile so the next read is the new one, but it does not
     re-render — these two lines are the render. */
  if (typeof MY_PHOTO_URL !== 'undefined') MY_PHOTO_URL = url || null;
  const cta = document.getElementById('profile-photo-cta');
  if (cta) cta.textContent = url ? 'Change photo' : 'Add a photo';
  if (typeof loadMyProfile === 'function') loadMyProfile(true);
}
