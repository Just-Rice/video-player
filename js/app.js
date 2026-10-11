// Screen logic: library, player, upload queue.
import * as drive from './drive.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const THUMB_CACHE = 'reelbox-thumbs';
const state = { files: [], subs: [], loaded: false, loadError: '', query: '', sort: 'recent', current: null, uploads: [], busy: false, canStream: false };
const video = $('video');
const stage = $('stage');

// Per-device preferences and watch positions.
const store = {
  get(key, fallback) { try { const v = JSON.parse(localStorage.getItem(`reelbox.${key}`)); return v ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`reelbox.${key}`, JSON.stringify(value)); } catch { /* private window */ } },
};

// ---------- formatting ----------
const fmtSize = b => { b = Number(b) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`; };
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const durationOf = f => (Number(f.videoMediaMetadata?.durationMillis) / 1000) || Number(f.appProperties?.dur) || 0;
const titleOf = f => f.name.replace(/\.[a-z0-9]{2,5}$/i, '');

// ---------- small UI helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  (document.fullscreenElement || document.body).appendChild(t); // stay visible in full screen
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function ask({ title, text = '', ok, input, danger }) {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  const d = $('dialog');
  $('dialog-title').textContent = title;
  $('dialog-text').textContent = text;
  $('dialog-text').hidden = !text;
  $('dialog-ok').textContent = ok;
  $('dialog-ok').classList.toggle('danger', !!danger);
  const field = $('dialog-input');
  field.hidden = input === undefined;
  field.value = input ?? '';
  d.returnValue = 'cancel';
  d.showModal();
  if (input !== undefined) field.select();
  return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? (input === undefined ? true : field.value.trim()) : null), { once: true }));
}

let noticeAction = null;
function showNotice(text, button, action) {
  $('notice-text').textContent = text;
  $('notice-btn').textContent = button;
  noticeAction = action;
  $('notice').hidden = false;
}
$('notice-btn').addEventListener('click', () => noticeAction?.());

function handleError(err) {
  if (err instanceof drive.AuthError) return; // the auth listener reacts to an expired session
  console.error(err);
  toast(err.message || 'Something went wrong.');
}

// Owner-only buttons, and the quiet sign-in link visitors see instead.
function paintChrome() {
  const owner = drive.isSignedIn();
  document.querySelectorAll('[data-owner]').forEach(el => { el.hidden = !owner; });
  $('owner-btn').hidden = owner || !drive.isPublic;
  $('search-box').hidden = !state.loaded;
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
  const pos = store.get('pos', {})[f.id] || 0;
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
  const none = (state.loaded && !list.length) || !!state.loadError;
  $('empty').hidden = !none;
  if (none) {
    const searching = !!state.query && state.files.length;
    $('empty-title').textContent = state.loadError ? "Couldn't load the videos" : searching ? 'Nothing matches' : 'No videos yet';
    $('empty-text').textContent = state.loadError || (searching ? `No video has “${state.query}” in its name.`
      : drive.isSignedIn() ? 'Drop video files anywhere on this page, or use the Upload button.' : 'Nothing has been uploaded here yet.');
    $('empty-upload').hidden = !!searching || !drive.isSignedIn() || !!state.loadError;
  }
  $('lib-title').textContent = state.loaded ? `Videos${state.files.length ? ` (${state.files.length})` : ''}` : state.loadError ? 'Videos' : 'Loading videos…';
}

// Subtitle files sit beside the videos, named "sub.<video id>.<label>.vtt".
const SUB_NAME = /^sub\.([\w-]+)\.(.+)\.vtt$/;

async function refresh() {
  try {
    let all;
    try { all = await drive.listFiles(); } catch (err) {
      if (!(err instanceof drive.AuthError) || !drive.isPublic) throw err;
      all = await drive.listFiles(); // owner session just ran out: read as a visitor instead
    }
    state.files = all.filter(f => f.mimeType.startsWith('video/'));
    state.subs = all.filter(f => SUB_NAME.test(f.name));
    state.loaded = true; state.loadError = '';
  } catch (err) {
    if (!(err instanceof drive.AuthError)) state.loadError = err.message;
    handleError(err);
  }
  paintChrome();
  route();
  if (drive.isSignedIn()) drive.getAccount().then(renderAccount).catch(handleError);
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

// ---------- player: loading ----------
let blobUrl = null;
let trackUrls = [];
let lastSaved = 0;
let driveMode = false;

function stageMsg(html) { $('stage-msg').innerHTML = html || ''; $('stage-msg').hidden = !html; }

function clearTracks() {
  video.querySelectorAll('track').forEach(t => t.remove());
  trackUrls.forEach(u => URL.revokeObjectURL(u));
  trackUrls = [];
}

function setDriveMode(on) {
  const f = state.current;
  driveMode = on && !!f;
  stage.classList.toggle('drive-mode', driveMode);
  $('drive-frame').hidden = !driveMode;
  $('drive-back').hidden = !driveMode;
  if (driveMode) { video.pause(); closeMenu(); $('drive-frame').src = `https://drive.google.com/file/d/${f.id}/preview`; }
  else $('drive-frame').removeAttribute('src');
  $('c-quality').textContent = qualityLabel();
}
$('drive-back').addEventListener('click', () => setDriveMode(false));

function closePlayer() {
  if (!state.current) return;
  rememberPosition(true);
  setDriveMode(false);
  closeMenu();
  video.pause(); video.removeAttribute('src'); clearTracks(); video.load();
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  state.current = null;
  document.title = 'Reelbox';
}

async function openPlayer(f, resumeAt) {
  closePlayer();
  state.current = f;
  document.title = `${titleOf(f)} · Reelbox`;
  $('watch-title').textContent = titleOf(f);
  const m = f.videoMediaMetadata;
  $('watch-meta').textContent = [fmtDate(f.createdTime), fmtSize(f.size), m?.height ? `${m.width}×${m.height}` : ''].filter(Boolean).join(' · ');
  $('open-drive').href = `https://drive.google.com/file/d/${f.id}/view`;
  const dl = $('download-btn');
  dl.hidden = !drive.isPublic && !state.canStream;
  dl.href = drive.isPublic ? `https://drive.google.com/uc?export=download&id=${f.id}` : `${drive.mediaUrl(f)}&download=${encodeURIComponent(f.name)}`;
  $('copy-btn').hidden = !drive.isPublic;
  $('upnext').replaceChildren(...visibleFiles().filter(x => x.id !== f.id).slice(0, 12).map(x => card(x, true)));
  $('c-next').hidden = !nextVideo();
  $('c-quality').textContent = qualityLabel();
  stageMsg('');
  paintTime();

  const dur = durationOf(f);
  const saved = resumeAt ?? (store.get('pos', {})[f.id] || 0);
  const start = saved > 5 && (!dur || saved < dur - 10) ? saved : 0;
  try {
    if (drive.isPublic || state.canStream) {
      video.src = drive.mediaUrl(f);
    } else {
      stageMsg('Loading video…');
      const blob = await drive.downloadBlob(f.id, p => stageMsg(`Loading video… ${Math.round(p * 100)}%`));
      if (state.current !== f) return;
      blobUrl = URL.createObjectURL(blob);
      video.src = blobUrl;
      stageMsg('');
    }
    applyPrefs();
    if (start) video.currentTime = start;
    video.play().catch(() => {}); // autoplay may be refused; the play button still works
    loadSubtitles(f);
  } catch (err) {
    stageMsg(esc(err instanceof drive.AuthError ? 'Sign in again to keep watching.' : err.message));
    handleError(err);
  }
}

function rememberPosition(force) {
  const f = state.current;
  if (!f || !isFinite(video.currentTime) || !video.currentTime) return;
  const now = Date.now();
  if (!force && now - lastSaved < 5000) return;
  lastSaved = now;
  const ended = video.duration && video.currentTime > video.duration - 10;
  const pos = store.get('pos', {});
  if (ended) delete pos[f.id]; else pos[f.id] = Math.floor(video.currentTime);
  store.set('pos', pos);
}

const nextVideo = () => { const list = visibleFiles(); return list[list.findIndex(x => x.id === state.current?.id) + 1]; };
const playNext = () => { const n = nextVideo(); if (n) location.hash = `#/watch/${n.id}`; };

// ---------- player: subtitles ----------
const srtToVtt = text => `WEBVTT\n\n${text.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2')}`;
const asVtt = (name, text) => (/\.srt$/i.test(name) || !/^\uFEFF?WEBVTT/.test(text) ? srtToVtt(text) : text);

function addTrack(label, vtt) {
  const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  trackUrls.push(url);
  const t = document.createElement('track');
  t.kind = 'subtitles'; t.label = label; t.srclang = 'en'; t.src = url;
  video.appendChild(t);
  t.track.mode = 'disabled';
}

function showSubtitle(label) {
  for (const t of video.textTracks) t.mode = t.label === label ? 'showing' : 'disabled';
  store.set('sub', label || '');
  $('c-sub').classList.toggle('on', !!label && [...video.textTracks].some(t => t.label === label));
}
const activeSubtitle = () => [...video.textTracks].find(t => t.mode === 'showing')?.label || '';

async function loadSubtitles(f) {
  $('c-sub').classList.remove('on');
  const mine = state.subs.map(s => ({ s, m: SUB_NAME.exec(s.name) })).filter(x => x.m[1] === f.id);
  for (const { s, m } of mine) {
    try {
      const text = await drive.fetchText(s.id);
      if (state.current !== f) return;
      addTrack(m[2], asVtt(s.name, text));
    } catch { /* a broken subtitle file shouldn't stop the video */ }
  }
  const want = store.get('sub', '');
  if (want && [...video.textTracks].some(t => t.label === want)) showSubtitle(want);
}

$('sub-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  const f = state.current;
  if (!file || !f) return;
  try {
    const vtt = asVtt(file.name, await file.text());
    const guess = /\.([a-z]{2,3}(?:-[a-z]{2})?)\.(?:srt|vtt)$/i.exec(file.name)?.[1];
    let label = guess ? guess.toUpperCase() : 'English';
    if (drive.isSignedIn()) {
      label = await ask({ title: 'Name these subtitles', text: 'They will be saved with the video so every viewer can turn them on.', ok: 'Add subtitles', input: label });
      if (!label) return;
      label = label.replace(/[\\/]/g, '-');
      state.subs.push(await drive.uploadText(`sub.${f.id}.${label}.vtt`, 'text/vtt', vtt));
    }
    if (state.current !== f) return;
    addTrack(label, vtt);
    showSubtitle(label);
    toast(drive.isSignedIn() ? 'Subtitles added for everyone.' : 'Subtitles loaded on this device.');
  } catch (err) { handleError(err); }
});

// ---------- player: controls ----------
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const menu = $('pmenu');

function applyPrefs() {
  video.volume = store.get('volume', 1);
  video.muted = store.get('muted', false);
  video.loop = store.get('loop', false);
  setSpeed(store.get('speed', 1), true);
  paintVolume();
}

function setSpeed(rate, quiet) {
  video.playbackRate = rate;
  video.defaultPlaybackRate = rate; // some browsers reset the rate when a new file loads
  store.set('speed', rate);
  $('c-speed').textContent = `${rate}×`;
  if (!quiet) toast(`Speed ${rate}×`);
}

function qualityLabel() {
  if (driveMode) return 'Auto';
  const h = state.current?.videoMediaMetadata?.height || video.videoHeight;
  return h ? `${h}p` : 'HD';
}

function closeMenu() { menu.hidden = true; menu.dataset.for = ''; }
function openMenu(btn, title, items, note) {
  if (!menu.hidden && menu.dataset.for === btn.id) return closeMenu();
  const head = document.createElement('h4');
  head.textContent = title;
  const rows = items.map(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmenu-item';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(!!it.checked));
    b.textContent = it.label;
    b.addEventListener('click', () => { closeMenu(); it.pick(); });
    return b;
  });
  menu.replaceChildren(head, ...rows);
  if (note) { const p = document.createElement('p'); p.textContent = note; menu.appendChild(p); }
  menu.dataset.for = btn.id;
  menu.style.right = `${Math.max(8, stage.getBoundingClientRect().right - btn.getBoundingClientRect().right - 8)}px`;
  menu.hidden = false;
  wake();
}

$('c-speed').addEventListener('click', e => openMenu(e.currentTarget, 'Speed', [
  ...SPEEDS.map(r => ({ label: r === 1 ? 'Normal' : `${r}×`, checked: video.playbackRate === r, pick: () => setSpeed(r) })),
  { label: video.loop ? 'Loop: on' : 'Loop: off', checked: video.loop, pick: () => { video.loop = !video.loop; store.set('loop', video.loop); toast(video.loop ? 'Loop on' : 'Loop off'); } },
]));

$('c-sub').addEventListener('click', e => {
  const active = activeSubtitle();
  const tracks = [...video.textTracks].map(t => ({ label: t.label, checked: t.label === active, pick: () => showSubtitle(t.label) }));
  openMenu(e.currentTarget, 'Subtitles', [
    { label: 'Off', checked: !active, pick: () => showSubtitle('') },
    ...tracks,
    { label: drive.isSignedIn() ? 'Add a subtitle file for everyone…' : 'Load a subtitle file…', pick: () => $('sub-input').click() },
  ], tracks.length ? '' : 'This video has no subtitles yet. You can load a .srt or .vtt file.');
});

$('c-quality').addEventListener('click', e => {
  const h = state.current?.videoMediaMetadata?.height || video.videoHeight;
  openMenu(e.currentTarget, 'Quality', [
    { label: `Original${h ? ` (${h}p)` : ''}`, checked: !driveMode, pick: () => setDriveMode(false) },
    { label: 'Auto / lower quality', checked: driveMode, pick: () => { rememberPosition(true); setDriveMode(true); } },
  ], "Lower qualities are made by Google Drive and play in Drive's own player, which has its own quality menu. They can take a while to appear after an upload.");
});

const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
const seekBy = s => { if (isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + s)); wake(); };
function setVolume(v) {
  video.volume = Math.max(0, Math.min(1, v));
  video.muted = video.volume === 0;
}
function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (stage.requestFullscreen) return stage.requestFullscreen().catch(() => {});
  video.webkitEnterFullscreen?.(); // iPhone only allows the video itself to go full screen
}
async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch { toast("Picture in picture isn't available here."); }
}
function toggleCaptions() {
  if (activeSubtitle()) return showSubtitle('');
  const labels = [...video.textTracks].map(t => t.label);
  if (!labels.length) return toast('This video has no subtitles.');
  const want = store.get('sub', '');
  showSubtitle(labels.includes(want) ? want : labels[0]);
}

$('c-play').addEventListener('click', togglePlay);
$('big-play').addEventListener('click', togglePlay);
$('c-back').addEventListener('click', () => seekBy(-10));
$('c-fwd').addEventListener('click', () => seekBy(10));
$('c-next').addEventListener('click', playNext);
$('c-mute').addEventListener('click', () => { video.muted = !video.muted; if (!video.muted && !video.volume) video.volume = 0.5; });
$('c-vol').addEventListener('input', e => setVolume(Number(e.target.value)));
$('c-pip').addEventListener('click', togglePip);
$('c-fs').addEventListener('click', toggleFullscreen);
$('c-pip').hidden = !document.pictureInPictureEnabled;

// Click the picture to play/pause, double-click for full screen.
let clickTimer;
video.addEventListener('click', () => {
  if (!menu.hidden) return closeMenu();
  clearTimeout(clickTimer);
  clickTimer = setTimeout(togglePlay, 220);
});
video.addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFullscreen(); });

// Seek bar
const seek = $('seek');
function paintTime() {
  const d = isFinite(video.duration) ? video.duration : 0;
  const t = video.currentTime || 0;
  seek.max = d || 0;
  if (!seek.matches(':active')) seek.value = t;
  let buffered = 0;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 1) buffered = Math.max(buffered, video.buffered.end(i));
  seek.style.setProperty('--p', d ? `${t / d * 100}%` : '0%');
  seek.style.setProperty('--b', d ? `${buffered / d * 100}%` : '0%');
  $('c-time').textContent = `${fmtTime(t)} / ${fmtTime(d || durationOf(state.current || {}))}`;
}
seek.addEventListener('input', () => { video.currentTime = Number(seek.value); paintTime(); });
seek.addEventListener('mousemove', e => {
  const r = seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const tip = $('seek-tip');
  tip.textContent = fmtTime(ratio * (video.duration || 0));
  tip.style.left = `${ratio * 100}%`;
  tip.hidden = !isFinite(video.duration);
});
seek.addEventListener('mouseleave', () => { $('seek-tip').hidden = true; });

function paintVolume() {
  stage.classList.toggle('is-muted', video.muted || !video.volume);
  $('c-vol').value = video.muted ? 0 : video.volume;
  $('c-vol').style.setProperty('--p', `${(video.muted ? 0 : video.volume) * 100}%`);
}

// Controls fade away while playing and come back on any movement.
let idleTimer;
function wake() {
  stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && menu.hidden) stage.classList.add('idle'); }, 2600);
}
['mousemove', 'touchstart', 'focusin'].forEach(ev => stage.addEventListener(ev, wake, { passive: true }));
stage.addEventListener('mouseleave', () => { if (!video.paused && menu.hidden) stage.classList.add('idle'); });

video.addEventListener('play', () => { stage.classList.add('is-playing'); wake(); });
video.addEventListener('pause', () => { stage.classList.remove('is-playing', 'idle'); rememberPosition(true); });
video.addEventListener('timeupdate', () => { paintTime(); rememberPosition(false); });
video.addEventListener('progress', paintTime);
video.addEventListener('durationchange', paintTime);
video.addEventListener('loadedmetadata', () => { $('c-quality').textContent = qualityLabel(); paintTime(); });
video.addEventListener('volumechange', () => { store.set('volume', video.volume); store.set('muted', video.muted); paintVolume(); });
video.addEventListener('waiting', () => { $('spinner').hidden = false; });
['playing', 'canplay', 'seeked', 'pause', 'error', 'emptied'].forEach(ev => video.addEventListener(ev, () => { $('spinner').hidden = true; }));
video.addEventListener('playing', () => stageMsg(''));
video.addEventListener('ended', () => { rememberPosition(true); if (!video.loop) playNext(); });
video.addEventListener('error', () => {
  if (!state.current || !video.getAttribute('src')) return;
  stageMsg(!drive.isPublic && !drive.isSignedIn() ? 'Sign in again to keep watching.'
    : `The video couldn't be played here. It may be in a format this browser can't play (${esc(state.current.mimeType)}): try “Auto / lower quality” in the quality menu, which uses Google Drive's converted copy.`);
});
document.addEventListener('fullscreenchange', () => stage.classList.toggle('is-fs', document.fullscreenElement === stage));

document.addEventListener('keydown', e => {
  if (!state.current || driveMode || e.metaKey || e.ctrlKey || e.altKey || $('dialog').open) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target !== seek && e.target !== $('c-vol')) return;
  if (e.key === 'Escape' && !menu.hidden) return closeMenu();
  const stepSpeed = n => setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(video.playbackRate) + n))] ?? 1);
  const keys = {
    ' ': togglePlay, k: togglePlay,
    ArrowLeft: () => seekBy(-5), ArrowRight: () => seekBy(5), j: () => seekBy(-10), l: () => seekBy(10),
    ArrowUp: () => { video.muted = false; setVolume(video.volume + 0.05); wake(); }, ArrowDown: () => { setVolume(video.volume - 0.05); wake(); },
    m: () => { video.muted = !video.muted; }, f: toggleFullscreen, p: togglePip, c: toggleCaptions,
    Home: () => { video.currentTime = 0; }, End: () => { if (isFinite(video.duration)) video.currentTime = video.duration - 1; },
    '<': () => stepSpeed(-1), ',': () => stepSpeed(-1), '>': () => stepSpeed(1), '.': () => stepSpeed(1),
  };
  let act = e.key === 'N' ? playNext : keys[e.key] || keys[e.key.toLowerCase()]; // next needs Shift so a stray key doesn't skip
  if (!act && /^[0-9]$/.test(e.key) && isFinite(video.duration)) act = () => { video.currentTime = video.duration * Number(e.key) / 10; };
  // Space on a focused button already clicks it; don't also toggle playback.
  if (!act || (e.key === ' ' && /^(BUTTON|A)$/.test(e.target.tagName))) return;
  e.preventDefault();
  act();
});

// ---------- video actions ----------
$('copy-btn').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}#/watch/${state.current.id}`;
  navigator.clipboard.writeText(link).then(() => toast('Link copied. Anyone can watch with it.'), () => toast(link));
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
  if (!await ask({ title: 'Delete this video?', text: `“${titleOf(f)}” will disappear from the gallery for everyone and move to your Google Drive bin, where it stays for 30 days before it's gone for good.`, ok: 'Delete', danger: true })) return;
  try {
    await drive.removeFile(f.id);
    const subs = state.subs.filter(s => SUB_NAME.exec(s.name)[1] === f.id);
    await Promise.all(subs.map(s => drive.removeFile(s.id).catch(() => {})));
    state.files = state.files.filter(x => x.id !== f.id);
    state.subs = state.subs.filter(s => !subs.includes(s));
    location.hash = '#/';
    toast('Moved to your Drive bin.');
  } catch (err) { handleError(err); }
});

// ---------- uploads (owner only) ----------
function renderQueue() {
  const q = state.uploads;
  $('queue').hidden = !q.length;
  const left = q.filter(u => u.status === 'waiting' || u.status === 'uploading').length;
  $('queue-title').textContent = left ? `Uploading ${left} video${left > 1 ? 's' : ''}` : 'Uploads finished';
  $('queue-list').replaceChildren(...q.map(u => {
    const li = document.createElement('li');
    li.className = u.status;
    const pct = u.file.size ? Math.round(u.sent / u.file.size * 100) : 0;
    const line = { waiting: 'Waiting…', uploading: `${pct}% · ${fmtSize(u.sent)} of ${fmtSize(u.file.size)}`, done: 'Saved, and now public in the gallery', error: u.error || 'Failed', cancelled: 'Cancelled' }[u.status];
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
      else if (err instanceof drive.AuthError) { u.status = 'waiting'; u.sent = 0; } // resumes after signing in again
      else { u.status = 'error'; u.error = err.message; }
    }
    renderQueue();
  }
  state.busy = false;
  if (drive.isSignedIn() && state.uploads.some(x => x.status === 'done')) drive.getAccount().then(renderAccount).catch(() => {});
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
  for (const id of ['view-welcome', 'view-library', 'view-watch']) $(id).hidden = id !== view;
}

function route() {
  paintChrome();
  const old = /^#\/v\/([\w-]+)/.exec(location.hash)?.[1]; // links from the earlier share feature
  if (old) { location.replace(`#/watch/${old}`); return; }
  // Before the gallery is public there is nothing a visitor can see.
  if (!drive.isPublic && !drive.isSignedIn() && !state.loaded) { closePlayer(); return show('view-welcome'); }
  const id = /^#\/watch\/([\w-]+)/.exec(location.hash)?.[1];
  if (!id) { closePlayer(); renderLibrary(); return show('view-library'); }
  if (state.current?.id === id) return show('view-watch');
  const f = state.files.find(x => x.id === id);
  if (!f && !state.loaded && !state.loadError) { renderLibrary(); return show('view-library'); } // route() runs again once loaded
  if (!f) { toast("That video isn't in the gallery any more."); location.hash = '#/'; return; }
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
    toast(err.message);
  }
}

// First sign-in before the gallery is public: make the folder and show its ID for js/config.js.
async function finishSetup() {
  try {
    const id = await drive.getFolder();
    showNotice(`One-time setup: your Drive folder is ready. Folder ID: ${id}`, 'Copy ID',
      () => navigator.clipboard.writeText(id).then(() => toast('Folder ID copied.'), () => {}));
  } catch (err) { handleError(err); }
}

drive.onAuthChange(async signedIn => {
  paintChrome();
  if (signedIn) {
    $('notice').hidden = true;
    await refresh();
    if (!drive.isPublic) finishSetup();
    pump();
    return;
  }
  const waiting = state.uploads.some(u => u.status === 'waiting');
  if (waiting || (state.loaded && !drive.isPublic)) {
    showNotice(waiting ? 'Your sign-in ran out (Google allows an hour at a time). Sign in again to finish the uploads.' : 'Your sign-in ran out. Sign in again to carry on.', 'Sign in', connect);
  } else if (!drive.isPublic) {
    route();
  }
  if (!state.current) renderLibrary();
});

$('signin-btn').addEventListener('click', connect);
$('owner-btn').addEventListener('click', connect);
$('signout-btn').addEventListener('click', async () => {
  state.uploads.forEach(u => u.abort.abort());
  state.uploads = [];
  renderQueue();
  $('account-menu').hidden = true; $('notice').hidden = true;
  if (!drive.isPublic) { closePlayer(); Object.assign(state, { files: [], subs: [], loaded: false, query: '' }); location.hash = '#/'; }
  await drive.signOut();
});

$('account-btn').addEventListener('click', e => {
  e.stopPropagation();
  const m = $('account-menu');
  m.hidden = !m.hidden;
  $('account-btn').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', e => {
  if (!e.target.closest('.account')) $('account-menu').hidden = true;
  if (!menu.hidden && !e.target.closest('#pmenu, .ctl, #video')) closeMenu();
});

$('search').addEventListener('input', e => { state.query = e.target.value.trim(); if (state.current) location.hash = '#/'; else renderLibrary(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; renderLibrary(); });
window.addEventListener('hashchange', route);

async function startWorker() {
  if (drive.isPublic || !('serviceWorker' in navigator)) return; // public files play straight from Google
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
  applyPrefs();
  const [signedIn] = await Promise.all([drive.initAuth(), startWorker()]);
  route();
  if (drive.isPublic || signedIn) await refresh();
  if (signedIn && !drive.isPublic) finishSetup();
})();
