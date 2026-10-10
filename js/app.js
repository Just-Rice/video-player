// Screen logic: library, player, upload queue.
import * as drive from './drive.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const THUMB_CACHE = 'reelbox-thumbs';
const state = { files: [], loaded: false, query: '', sort: 'recent', current: null, uploads: [], busy: false, canStream: false };
const video = $('video');

// ---------- formatting ----------
const fmtSize = b => { b = Number(b) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`; };
const fmtTime = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const durationOf = f => (Number(f.videoMediaMetadata?.durationMillis) / 1000) || Number(f.appProperties?.dur) || 0;
const titleOf = f => f.name.replace(/\.[a-z0-9]{2,5}$/i, '');

// ---------- small UI helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function ask({ title, text = '', ok, input, danger, extra, readOnly }) {
  const d = $('dialog');
  $('dialog-title').textContent = title;
  $('dialog-text').textContent = text;
  $('dialog-text').hidden = !text;
  $('dialog-ok').textContent = ok;
  $('dialog-ok').classList.toggle('danger', !!danger);
  const field = $('dialog-input');
  field.hidden = input === undefined;
  field.value = input ?? '';
  field.readOnly = !!readOnly;
  $('dialog-extra').hidden = !extra;
  $('dialog-extra').textContent = extra || '';
  d.returnValue = 'cancel';
  d.showModal();
  if (input !== undefined) field.select();
  return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? (input === undefined ? true : field.value.trim()) : d.returnValue === 'extra' ? 'extra' : null), { once: true }));
}

function showNotice(text, button) {
  $('notice-text').textContent = text;
  $('notice-btn').textContent = button;
  $('notice').hidden = false;
}

// Any Drive call can discover the hour-long Google session has run out.
function handleError(err) {
  if (err instanceof drive.AuthError) return; // the auth listener shows the reconnect bar
  console.error(err);
  toast(err.message || 'Something went wrong.');
}

// ---------- thumbnails ----------
// A frame grabbed in the browser at upload time, because Drive takes a few minutes to make its own.
function grabFrame(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = result => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(result); };
    const timer = setTimeout(() => done({ duration: isFinite(v.duration) ? v.duration : 0, blob: null }), 8000);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(v.duration * 0.1 || 0, 8); };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      c.width = 480; c.height = Math.round(480 * (v.videoHeight / v.videoWidth || 9 / 16));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(blob => done({ duration: v.duration, blob }), 'image/jpeg', 0.72);
    };
    v.onerror = () => done({ duration: 0, blob: null });
    v.src = url;
  });
}

const thumbKey = id => `/reelbox-thumbs/${id}`;
async function saveThumb(id, blob) {
  try { await (await caches.open(THUMB_CACHE)).put(thumbKey(id), new Response(blob)); } catch { /* optional */ }
}
async function paintThumb(img, file) {
  const fallback = () => { img.onerror = null; img.hidden = true; };
  img.onerror = () => { img.onerror = fallback; if (file.thumbnailLink && img.src !== file.thumbnailLink) img.src = file.thumbnailLink; else fallback(); };
  try {
    const hit = await (await caches.open(THUMB_CACHE)).match(thumbKey(file.id));
    if (hit) { img.src = URL.createObjectURL(await hit.blob()); return; }
  } catch { /* fall through */ }
  if (file.thumbnailLink) img.src = file.thumbnailLink; else fallback();
}

// ---------- library ----------
function visibleFiles() {
  const q = state.query.toLowerCase();
  const list = state.files.filter(f => !q || f.name.toLowerCase().includes(q));
  const by = {
    recent: (a, b) => b.createdTime.localeCompare(a.createdTime),
    oldest: (a, b) => a.createdTime.localeCompare(b.createdTime),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    size: (a, b) => Number(b.size) - Number(a.size),
  };
  return list.sort(by[state.sort]);
}

function card(f, compact) {
  const dur = durationOf(f);
  const pos = Number(f.appProperties?.pos) || 0;
  const pct = dur && pos > 5 ? Math.min(100, pos / dur * 100) : 0;
  const a = document.createElement('a');
  a.className = compact ? 'card compact' : 'card';
  a.href = `#/watch/${f.id}`;
  a.innerHTML = `
    <div class="thumb"><img alt="" loading="lazy" referrerpolicy="no-referrer">
      ${dur ? `<span class="dur">${fmtTime(dur)}</span>` : ''}
      ${pct ? `<span class="seen"><i style="width:${pct}%"></i></span>` : ''}
    </div>
    <div class="card-text"><strong>${esc(titleOf(f))}</strong><span>${fmtDate(f.createdTime)} · ${fmtSize(f.size)}</span></div>`;
  paintThumb(a.querySelector('img'), f);
  return a;
}

function renderLibrary() {
  const list = visibleFiles();
  $('grid').replaceChildren(...list.map(f => card(f)));
  const none = state.loaded && !list.length;
  $('empty').hidden = !none;
  if (none) {
    const searching = !!state.query && state.files.length;
    $('empty-title').textContent = searching ? 'Nothing matches' : 'No videos yet';
    $('empty-text').textContent = searching ? `No video has “${state.query}” in its name.` : 'Drop video files anywhere on this page, or use the Upload button.';
    $('empty-upload').hidden = !!searching;
  }
  $('lib-title').textContent = state.loaded ? `Your videos${state.files.length ? ` (${state.files.length})` : ''}` : 'Loading your videos…';
}

async function refresh() {
  try {
    const [files, about] = await Promise.all([drive.listVideos(), drive.getAccount()]);
    state.files = files; state.loaded = true;
    renderAccount(about);
    route();
  } catch (err) { handleError(err); }
}

function renderAccount({ user, storageQuota }) {
  const btn = $('account-btn');
  btn.innerHTML = user.photoLink ? `<img src="${esc(user.photoLink)}" alt="" referrerpolicy="no-referrer">` : esc((user.displayName || '?')[0]);
  $('acct-name').textContent = user.displayName || '';
  $('acct-email').textContent = user.emailAddress || '';
  const used = Number(storageQuota.usage), limit = Number(storageQuota.limit);
  $('quota-fill').style.width = limit ? `${Math.min(100, used / limit * 100)}%` : '0';
  $('quota-text').textContent = limit ? `${fmtSize(used)} of ${fmtSize(limit)} Drive space used` : `${fmtSize(used)} of Drive space used`;
}

// ---------- player ----------
const streamUrl = (f, download) => `stream/${f.id}?size=${f.size}&type=${encodeURIComponent(f.mimeType)}${download ? `&download=${encodeURIComponent(f.name)}` : ''}`;
let blobUrl = null;
let lastSaved = 0;

function stageMsg(html) { $('stage-msg').innerHTML = html || ''; $('stage-msg').hidden = !html; }

function closePlayer() {
  if (!state.current) return;
  rememberPosition(true);
  video.pause(); video.removeAttribute('src'); video.load();
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  state.current = null;
  document.title = 'Reelbox';
}

async function openPlayer(f, resumeAt) {
  closePlayer();
  state.current = f;
  document.title = `${titleOf(f)} · Reelbox`;
  $('watch-title').textContent = titleOf(f);
  const m = f.videoMediaMetadata;
  $('watch-meta').textContent = [fmtDate(f.createdTime), fmtSize(f.size), m?.height ? `${m.width}×${m.height}` : '', f.name].filter(Boolean).join(' · ');
  paintShare(f);
  $('open-drive').href = `https://drive.google.com/file/d/${f.id}/view`;
  const dl = $('download-btn');
  dl.hidden = !state.canStream;
  dl.href = streamUrl(f, true); dl.download = f.name;
  $('upnext').replaceChildren(...visibleFiles().filter(x => x.id !== f.id).slice(0, 12).map(x => card(x, true)));
  stageMsg('');

  const dur = durationOf(f);
  const saved = resumeAt ?? (Number(f.appProperties?.pos) || 0);
  const start = saved > 5 && (!dur || saved < dur - 10) ? saved : 0;
  video.playbackRate = Number($('speed').value);
  try {
    if (state.canStream) {
      video.src = streamUrl(f);
    } else {
      stageMsg('Loading video…');
      const blob = await drive.downloadBlob(f.id, p => stageMsg(`Loading video… ${Math.round(p * 100)}%`));
      if (state.current !== f) return;
      blobUrl = URL.createObjectURL(blob);
      video.src = blobUrl;
      stageMsg('');
    }
    if (start) video.currentTime = start;
    video.play().catch(() => {}); // autoplay may be refused; the play button still works
  } catch (err) {
    stageMsg(err instanceof drive.AuthError ? 'Your Google session ran out. Reconnect to keep watching.' : esc(err.message));
    handleError(err);
  }
}

function rememberPosition(force) {
  const f = state.current;
  if (!f || !isFinite(video.currentTime) || !video.currentTime) return;
  const now = Date.now();
  if (!force && now - lastSaved < 20000) return;
  lastSaved = now;
  const ended = video.duration && video.currentTime > video.duration - 10;
  const pos = ended ? 0 : video.currentTime;
  f.appProperties = { ...f.appProperties, pos: String(Math.floor(pos)) };
  if (drive.isSignedIn()) drive.savePosition(f.id, pos).catch(() => {});
}

video.addEventListener('timeupdate', () => rememberPosition(false));
video.addEventListener('pause', () => rememberPosition(true));
video.addEventListener('ended', () => {
  rememberPosition(true);
  const list = visibleFiles();
  const next = list[list.findIndex(x => x.id === state.current?.id) + 1];
  if (next) location.hash = `#/watch/${next.id}`;
});
video.addEventListener('error', () => {
  if (!state.current || !video.getAttribute('src')) return;
  if (!drive.isSignedIn()) return stageMsg('Your Google session ran out. Reconnect to keep watching.');
  const unsupported = video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || video.error?.code === MediaError.MEDIA_ERR_DECODE;
  stageMsg(unsupported
    ? `This browser can't play this file's format (${esc(state.current.mimeType)}). MP4 and WebM work everywhere. You can still open it in Drive or download it.`
    : "The video couldn't be loaded. Check your connection and try again.");
});
video.addEventListener('playing', () => stageMsg(''));

document.addEventListener('keydown', e => {
  if (!state.current || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName) || $('dialog').open) return;
  const speed = $('speed');
  const step = n => { const i = Math.max(0, Math.min(speed.options.length - 1, speed.selectedIndex + n)); speed.selectedIndex = i; video.playbackRate = Number(speed.value); toast(`Speed ${speed.value}×`); };
  const keys = {
    ' ': () => (video.paused ? video.play() : video.pause()), k: () => (video.paused ? video.play() : video.pause()),
    ArrowLeft: () => { video.currentTime -= 5; }, ArrowRight: () => { video.currentTime += 5; },
    j: () => { video.currentTime -= 10; }, l: () => { video.currentTime += 10; },
    m: () => { video.muted = !video.muted; },
    f: () => (document.fullscreenElement ? document.exitFullscreen() : (video.requestFullscreen || video.webkitEnterFullscreen)?.call(video)),
    '<': () => step(-1), ',': () => step(-1), '>': () => step(1), '.': () => step(1),
  };
  const act = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  // The focused <video> already handles space and arrows itself; don't do them twice.
  if (!act || (e.target === video && [' ', 'ArrowLeft', 'ArrowRight'].includes(e.key))) return;
  e.preventDefault();
  act();
});

$('speed').addEventListener('change', e => { video.playbackRate = Number(e.target.value); });

const shareLink = f => `${location.origin}${location.pathname}#/v/${f.id}`;
function paintShare(f) {
  const on = drive.isShared(f);
  $('share-btn').textContent = on ? 'Shared · link' : 'Share';
  $('share-btn').classList.toggle('on', on);
}

$('share-btn').addEventListener('click', async () => {
  const f = state.current;
  try {
    if (!drive.isShared(f)) {
      if (!await ask({ title: 'Share this video?', text: `Anyone who has the link will be able to watch “${titleOf(f)}” without signing in. They get this one video only: not your other videos, and nothing else in your Drive. You can stop sharing at any time.`, ok: 'Create link' })) return;
      await drive.shareVideo(f.id);
      f.permissionIds = [...(f.permissionIds || []), 'anyoneWithLink'];
      paintShare(f);
    }
    const choice = await ask({ title: 'Anyone with this link can watch', text: 'It opens this one video and nothing else.', input: shareLink(f), readOnly: true, ok: 'Copy link', extra: 'Stop sharing' });
    if (choice === 'extra') {
      await drive.unshareVideo(f.id);
      f.permissionIds = f.permissionIds.filter(p => p !== 'anyoneWithLink');
      paintShare(f);
      toast('Sharing stopped. The link no longer works.');
    } else if (choice) {
      await navigator.clipboard.writeText(shareLink(f)).then(() => toast('Link copied.'), () => toast('Copy the link from the box.'));
    }
  } catch (err) { handleError(err); }
});

$('rename-btn').addEventListener('click', async () => {
  const f = state.current;
  const ext = (/\.[a-z0-9]{2,5}$/i.exec(f.name) || [''])[0];
  const name = await ask({ title: 'Rename video', ok: 'Rename', input: titleOf(f) });
  if (!name || name === titleOf(f)) return;
  try {
    Object.assign(f, await drive.renameVideo(f.id, name + ext));
    $('watch-title').textContent = titleOf(f);
    document.title = `${titleOf(f)} · Reelbox`;
  } catch (err) { handleError(err); }
});

$('delete-btn').addEventListener('click', async () => {
  const f = state.current;
  if (!await ask({ title: 'Delete this video?', text: `“${titleOf(f)}” will move to your Google Drive bin, where it stays for 30 days before it's gone for good.`, ok: 'Delete', danger: true })) return;
  try {
    await drive.removeVideo(f.id);
    state.files = state.files.filter(x => x.id !== f.id);
    state.current = null; // nothing left to save a position for
    video.pause(); video.removeAttribute('src'); video.load();
    location.hash = '#/';
    toast('Moved to your Drive bin.');
  } catch (err) { handleError(err); }
});

// ---------- uploads ----------
function renderQueue() {
  const q = state.uploads;
  $('queue').hidden = !q.length;
  const left = q.filter(u => u.status === 'waiting' || u.status === 'uploading').length;
  $('queue-title').textContent = left ? `Uploading ${left} video${left > 1 ? 's' : ''}` : 'Uploads finished';
  $('queue-list').replaceChildren(...q.map(u => {
    const li = document.createElement('li');
    li.className = u.status;
    const pct = u.file.size ? Math.round(u.sent / u.file.size * 100) : 0;
    const line = { waiting: 'Waiting…', uploading: `${pct}% · ${fmtSize(u.sent)} of ${fmtSize(u.file.size)}`, done: 'Saved to your Drive', error: u.error, cancelled: 'Cancelled' }[u.status];
    li.innerHTML = `<div class="q-row"><span class="q-name">${esc(u.file.name)}</span>
      ${u.status === 'waiting' || u.status === 'uploading' ? '<button class="q-x" aria-label="Cancel upload">×</button>' : u.status === 'error' ? '<button class="q-retry">Retry</button>' : ''}</div>
      <div class="q-bar"><i style="width:${u.status === 'done' ? 100 : pct}%"></i></div><span class="q-line">${esc(line)}</span>`;
    li.querySelector('.q-x')?.addEventListener('click', () => { if (u.status === 'waiting') { u.status = 'cancelled'; renderQueue(); } else u.abort.abort(); });
    li.querySelector('.q-retry')?.addEventListener('click', () => { u.status = 'waiting'; u.sent = 0; u.abort = new AbortController(); renderQueue(); pump(); });
    return li;
  }));
}

function addFiles(fileList) {
  const files = [...fileList];
  const videos = files.filter(f => drive.videoType(f));
  if (videos.length < files.length) toast(videos.length ? 'Some files were skipped because they are not videos.' : 'Those are not video files.');
  for (const file of videos) state.uploads.push({ file, status: 'waiting', sent: 0, abort: new AbortController() });
  renderQueue();
  pump();
}

// One upload at a time: videos are big, and parallel uploads just make each one slower.
async function pump() {
  if (state.busy) return;
  state.busy = true;
  let u;
  while (drive.isSignedIn() && (u = state.uploads.find(x => x.status === 'waiting'))) {
    u.status = 'uploading';
    renderQueue();
    try {
      const frame = await grabFrame(u.file);
      let painted = 0;
      const saved = await drive.uploadVideo(u.file, {
        duration: frame.duration, signal: u.abort.signal,
        onProgress: sent => { u.sent = sent; if (Date.now() - painted > 250) { painted = Date.now(); renderQueue(); } },
      });
      if (frame.blob) await saveThumb(saved.id, frame.blob);
      u.status = 'done';
      state.files.unshift(saved);
      if (!state.current) renderLibrary();
    } catch (err) {
      if (err.name === 'AbortError') u.status = 'cancelled';
      else if (err instanceof drive.AuthError) { u.status = 'waiting'; u.sent = 0; } // resumes after reconnecting
      else { u.status = 'error'; u.error = err.message; }
    }
    renderQueue();
  }
  state.busy = false;
  if (state.uploads.some(x => x.status === 'done')) drive.getAccount().then(renderAccount).catch(() => {});
}

$('upload-btn').addEventListener('click', () => $('file-input').click());
$('empty-upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
$('queue-close').addEventListener('click', () => { state.uploads = state.uploads.filter(u => u.status === 'waiting' || u.status === 'uploading'); renderQueue(); });

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (hasFiles(e) && drive.isSignedIn()) { dragDepth++; $('drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (dragDepth && !--dragDepth) $('drop').hidden = true; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('drop').hidden = true;
  if (drive.isSignedIn()) addFiles(e.dataTransfer.files);
});

window.addEventListener('beforeunload', e => { if (state.uploads.some(u => u.status === 'uploading' || u.status === 'waiting')) e.preventDefault(); });
window.addEventListener('pagehide', () => rememberPosition(true));

// ---------- routing & sign-in ----------
function show(view) {
  for (const id of ['view-welcome', 'view-library', 'view-watch', 'view-shared']) $(id).hidden = id !== view;
  if (view !== 'view-shared') $('shared-frame').removeAttribute('src');
}

async function route() {
  // A shared link works for anyone, signed in or not. Drive's own player enforces the access.
  const sharedId = /^#\/v\/([\w-]+)/.exec(location.hash)?.[1];
  if (sharedId) {
    closePlayer();
    document.querySelectorAll('[data-signed-in]').forEach(el => { el.hidden = true; });
    $('notice').hidden = true;
    const src = `https://drive.google.com/file/d/${sharedId}/preview`;
    if ($('shared-frame').getAttribute('src') !== src) $('shared-frame').src = src;
    return show('view-shared');
  }
  const known = drive.isSignedIn() || state.loaded; // keep the library on screen while reconnecting
  document.querySelectorAll('[data-signed-in]').forEach(el => { el.hidden = !known; });
  if (!known) { closePlayer(); return show('view-welcome'); }
  const id = /^#\/watch\/([\w-]+)/.exec(location.hash)?.[1];
  if (!id) { closePlayer(); renderLibrary(); return show('view-library'); }
  if (state.current?.id === id) return show('view-watch');
  let f = state.files.find(x => x.id === id);
  if (!f && !state.loaded) { renderLibrary(); return show('view-library'); } // route() runs again once loaded
  if (!f) { toast("That video isn't in your library."); location.hash = '#/'; return; }
  show('view-watch');
  window.scrollTo(0, 0);
  openPlayer(f);
}

async function connect() {
  $('signin-error').hidden = true;
  try {
    await drive.signIn();
  } catch (err) {
    $('signin-error').textContent = err.message; $('signin-error').hidden = false;
    if (state.loaded) toast(err.message);
  }
}

drive.onAuthChange(async signedIn => {
  if (signedIn) {
    $('notice').hidden = true;
    const resume = state.current && { f: state.current, at: video.currentTime };
    await refresh();
    if (resume && state.current?.id === resume.f.id && video.error) openPlayer(state.files.find(x => x.id === resume.f.id) || resume.f, resume.at);
    pump();
  } else if (state.loaded) {
    showNotice('Google only keeps you signed in for an hour at a time. Reconnect to carry on.', 'Reconnect');
  } else {
    route();
  }
});

$('signin-btn').addEventListener('click', connect);
$('notice-btn').addEventListener('click', connect);
$('signout-btn').addEventListener('click', async () => {
  state.uploads.forEach(u => u.abort.abort());
  closePlayer();
  Object.assign(state, { files: [], loaded: false, uploads: [], query: '' });
  renderQueue();
  $('account-menu').hidden = true; $('notice').hidden = true;
  await drive.signOut();
  location.hash = '#/';
});

$('account-btn').addEventListener('click', e => {
  e.stopPropagation();
  const menu = $('account-menu');
  menu.hidden = !menu.hidden;
  $('account-btn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', e => { if (!e.target.closest('.account')) $('account-menu').hidden = true; });

$('search').addEventListener('input', e => { state.query = e.target.value.trim(); if (state.current) location.hash = '#/'; else renderLibrary(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; renderLibrary(); });
window.addEventListener('hashchange', route);

async function startWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    // On the very first visit the worker takes over a moment after it activates.
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    }
    state.canStream = !!navigator.serviceWorker.controller;
  } catch { /* falls back to downloading whole files */ }
}

(async function start() {
  if (!drive.isConfigured()) {
    show('view-welcome');
    $('signin-btn').disabled = true;
    $('signin-error').textContent = 'Google sign-in is not set up yet: add the client ID in js/config.js.';
    $('signin-error').hidden = false;
    return;
  }
  const [signedIn] = await Promise.all([drive.initAuth(), startWorker()]);
  route();
  if (signedIn) { await refresh(); }
})();
