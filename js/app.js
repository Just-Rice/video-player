// Screen logic: library, player, upload queue.
import * as drive from './drive.js';
import { guessDetails } from './names.js';
import { ADMIN_SALT, ADMIN_HASH, API_KEY, FOLDER_ID } from './config.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { manifest: { version: 1, videos: [] }, files: [], loaded: false, loadError: '', query: '', sort: 'recent', current: null, uploads: [], busy: false, canStream: false };
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
const durationOf = f => Number(f.duration) || 0;
const titleOf = f => f.title;

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

// The manage page is unlocked by the password; changing anything also needs the Google sign-in.
let unlocked = store.get('admin', false) === ADMIN_HASH;
const isOwner = () => unlocked && drive.isSignedIn();

function paintChrome() {
  const owner = isOwner();
  document.querySelectorAll('[data-owner]').forEach(el => { el.hidden = !owner; });
  $('manage-link').hidden = !unlocked;
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

// Shrinks a chosen picture to a sensible thumbnail size.
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = Math.min(960, bmp.width); c.height = Math.round(c.width * bmp.height / bmp.width);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.82));
}

// A video's own picture if it has one, otherwise the one Google Drive makes for it.
function paintThumb(img, f) {
  const auto = `https://drive.google.com/thumbnail?id=${f.id}&sz=w640`;
  const custom = f.thumb ? drive.imageUrl(f.thumb) : '';
  img.hidden = false;
  img.onerror = () => { if (custom && img.src !== auto) img.src = auto; else { img.onerror = null; img.hidden = true; } };
  img.src = custom || auto;
}

// ---------- library ----------
function visibleFiles() {
  const q = state.query.toLowerCase();
  const list = state.files.filter(f => !q || `${f.title} ${f.description || ''} ${f.category || ''} ${f.series || ''}`.toLowerCase().includes(q));
  const by = {
    recent: (a, b) => b.added.localeCompare(a.added),
    oldest: (a, b) => a.added.localeCompare(b.added),
    name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
    size: (a, b) => Number(b.size) - Number(a.size),
  };
  return list.sort(by[state.sort]);
}

// ---------- series ----------
// Videos that share a series name are its episodes, ordered by season then episode number.
const episodesOf = name => state.files.filter(f => f.series === name)
  .sort((a, b) => (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0) || a.added.localeCompare(b.added));
const epLabel = f => (f.series ? `S${f.season || 1} E${f.episode || '?'}` : '');
const seriesHref = name => `#/series/${encodeURIComponent(name)}`;
// On the home page a series takes one card instead of one per episode.
function collapse(list) {
  const seen = new Set();
  return list.flatMap(f => {
    if (!f.series) return [f];
    if (seen.has(f.series)) return [];
    seen.add(f.series);
    return [{ seriesName: f.series, episodes: episodesOf(f.series) }];
  });
}

function seriesCard(item) {
  const first = item.episodes[0];
  const seasons = new Set(item.episodes.map(e => e.season || 1)).size;
  const a = document.createElement('a');
  a.className = 'card';
  a.href = seriesHref(item.seriesName);
  a.innerHTML = `
    <div class="thumb stack"><img alt="" loading="lazy"><span class="dur">${item.episodes.length} episode${item.episodes.length > 1 ? 's' : ''}</span></div>
    <div class="card-text"><strong>${esc(item.seriesName)}</strong><span>Series${seasons > 1 ? ` · ${seasons} seasons` : ''}${first.category ? ` · ${esc(first.category)}` : ''}</span></div>`;
  paintThumb(a.querySelector('img'), first);
  return a;
}

function renderSeries(name) {
  const eps = episodesOf(name);
  const pos = store.get('pos', {});
  const resume = eps.find(e => pos[e.id] > 5) || eps[0];
  const seasons = [...new Set(eps.map(e => e.season || 1))];
  $('series-title').textContent = name;
  $('series-meta').textContent = `${seasons.length > 1 ? `${seasons.length} seasons · ` : ''}${eps.length} episode${eps.length > 1 ? 's' : ''}`;
  $('series-play').href = `#/watch/${resume.id}`;
  $('series-play').textContent = pos[resume.id] > 5 ? `▶ Continue ${epLabel(resume)}` : '▶ Play';
  $('series-list').replaceChildren(...seasons.map(n => {
    const sec = document.createElement('section');
    sec.innerHTML = seasons.length > 1 ? `<h3>Season ${n}</h3>` : '';
    sec.append(...eps.filter(e => (e.season || 1) === n).map(e => card(e, true)));
    return sec;
  }));
}

function card(f, compact) {
  if (f.seriesName) return seriesCard(f);
  const dur = durationOf(f);
  const pos = store.get('pos', {})[f.id] || 0;
  const pct = dur && pos > 5 ? Math.min(100, pos / dur * 100) : 0;
  const a = document.createElement('a');
  a.className = compact ? 'card compact' : 'card';
  a.href = `#/watch/${f.id}`;
  a.innerHTML = `
    <div class="thumb"><img alt="" loading="lazy">
      ${dur ? `<span class="dur">${fmtTime(dur)}</span>` : ''}
      ${pct ? `<span class="seen"><i style="width:${pct}%"></i></span>` : ''}
    </div>
    <div class="card-text"><strong>${f.series && compact ? `${f.episode || '?'}. ` : ''}${esc(titleOf(f))}</strong><span>${f.series && !compact ? `${esc(f.series)} ${epLabel(f)} · ` : ''}${f.category && !f.series ? `${esc(f.category)} · ` : ''}${compact && f.description ? esc(f.description) : fmtDate(f.added)}</span></div>`;
  paintThumb(a.querySelector('img'), f);
  return a;
}

// "My List" is kept on each viewer's own device.
const inList = id => store.get('list', []).includes(id);
function toggleList(id) {
  const list = store.get('list', []);
  store.set('list', list.includes(id) ? list.filter(x => x !== id) : [id, ...list]);
  toast(inList(id) ? 'Added to My List.' : 'Removed from My List.');
}
const listLabel = id => (inList(id) ? '✓ My List' : '+ My List');

// One sideways-scrolling shelf of videos.
function row(title, list) {
  const sec = document.createElement('section');
  sec.className = 'row';
  sec.innerHTML = `<h3>${esc(title)}</h3><button class="row-nav prev" aria-label="Scroll back">‹</button><div class="row-scroll"></div><button class="row-nav next" aria-label="Scroll forward">›</button>`;
  const scroller = sec.querySelector('.row-scroll');
  scroller.append(...list.map(f => card(f)));
  sec.querySelector('.prev').addEventListener('click', () => scroller.scrollBy({ left: -scroller.clientWidth * 0.85, behavior: 'smooth' }));
  sec.querySelector('.next').addEventListener('click', () => scroller.scrollBy({ left: scroller.clientWidth * 0.85, behavior: 'smooth' }));
  return sec;
}

function renderHero(f) {
  const hero = $('hero');
  hero.hidden = !f;
  if (!f) return;
  hero.innerHTML = `<img alt=""><div class="hero-text">
    ${f.category ? `<span class="tag">${esc(f.category)}</span>` : ''}
    <h1>${esc(f.title)}</h1>
    ${f.description ? `<p>${esc(f.description)}</p>` : ''}
    <div class="actions"><a class="btn hero-play" href="#/watch/${f.id}">▶ Play</a><button class="btn hero-list">${listLabel(f.id)}</button></div></div>`;
  paintThumb(hero.querySelector('img'), f);
  hero.querySelector('.hero-list').addEventListener('click', e => { toggleList(f.id); e.currentTarget.textContent = listLabel(f.id); renderLibrary(); });
}

function renderLibrary() {
  const list = visibleFiles();
  const searching = !!state.query;
  const all = state.files;
  const newest = [...all].sort((a, b) => b.added.localeCompare(a.added));

  // Home: a featured video and shelves. Searching: just the matching videos.
  renderHero(searching ? null : all.find(f => f.featured) || newest[0]);
  const rows = [];
  if (!searching && all.length) {
    const pos = store.get('pos', {});
    const resume = all.filter(f => pos[f.id] > 5);
    const mine = store.get('list', []).map(id => all.find(f => f.id === id)).filter(Boolean);
    if (resume.length) rows.push(row('Continue watching', resume));
    if (mine.length) rows.push(row('My List', mine));
    if (all.length > 1) rows.push(row('New', collapse(newest).slice(0, 12)));
    const shows = collapse(newest).filter(x => x.seriesName);
    if (shows.length) rows.push(row('Series', shows));
    const cats = [...new Set(all.map(f => f.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    for (const c of cats) rows.push(row(c, collapse(newest.filter(f => f.category === c))));
  }
  $('rows').replaceChildren(...rows);

  $('grid').replaceChildren(...(searching ? list : collapse(list)).map(f => card(f)));
  const none = (state.loaded && !list.length) || !!state.loadError;
  $('empty').hidden = !none;
  if (none) {
    const noMatch = searching && all.length;
    $('empty-title').textContent = state.loadError ? "Couldn't load the videos" : noMatch ? 'Nothing matches' : 'No videos yet';
    $('empty-text').textContent = state.loadError || (noMatch ? `Nothing matches “${state.query}”.`
      : isOwner() ? 'Drop video files anywhere on this page, or use the Upload button.' : 'Nothing has been added here yet.');
    $('empty-upload').hidden = !!noMatch || !isOwner() || !!state.loadError;
  }
  $('lib-title').textContent = !state.loaded ? (state.loadError ? 'Videos' : 'Loading videos…')
    : searching ? `Results for “${state.query}” (${list.length})` : `All videos${all.length ? ` (${all.length})` : ''}`;
}

const saveGallery = () => drive.saveManifest(state.manifest);

// What the gallery remembers about one video. Title, series, season and episode are read from
// the file name; a new episode of a series already in the gallery joins it and takes its category.
function entryFrom(meta, extra = {}) {
  const guess = guessDetails(meta.name);
  if (guess.series) {
    const known = state.files.find(f => f.series?.toLowerCase() === guess.series.toLowerCase());
    if (known) { guess.series = known.series; if (known.category) guess.category = known.category; }
  }
  return {
    id: meta.id, description: '', mimeType: meta.mimeType, size: Number(meta.size) || 0,
    duration: Number(meta.videoMediaMetadata?.durationMillis) / 1000 || 0, width: meta.videoMediaMetadata?.width || 0, height: meta.videoMediaMetadata?.height || 0,
    added: new Date().toISOString(), thumb: '', subs: [], own: false, ...guess, ...extra,
  };
}
// How a freshly added video was filled in, for the owner to check at a glance.
const filledAs = f => (f.series ? `${f.series} ${epLabel(f)} · ${f.title}` : f.title);

async function refresh() {
  try {
    let manifest;
    try { manifest = await drive.loadManifest(); } catch (err) {
      if (!(err instanceof drive.AuthError) || !drive.isPublic) throw err;
      manifest = await drive.loadManifest(); // owner session just ran out: read as a visitor instead
    }
    state.manifest = manifest; state.files = manifest.videos;
    state.loaded = true; state.loadError = '';
  } catch (err) {
    if (!(err instanceof drive.AuthError)) state.loadError = err.message;
    handleError(err);
  }
  route();
  if (isOwner()) drive.getAccount().then(renderAccount).catch(handleError);
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
  cancelNext();
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
  $('watch-meta').textContent = [fmtDate(f.added), fmtSize(f.size), f.height ? `${f.width}×${f.height}` : ''].filter(Boolean).join(' · ');
  $('watch-desc').textContent = f.description || ''; $('watch-desc').hidden = !f.description;
  $('open-drive').href = `https://drive.google.com/file/d/${f.id}/view`;
  const dl = $('download-btn');
  dl.hidden = !drive.isPublic && !state.canStream;
  dl.href = drive.isPublic ? `https://drive.google.com/uc?export=download&id=${f.id}` : `${drive.mediaUrl(f)}&download=${encodeURIComponent(f.title)}`;
  $('copy-btn').hidden = !drive.isPublic;
  $('list-btn').textContent = listLabel(f.id);
  // Beside the player: the rest of the series, or other videos.
  $('upnext-title').textContent = f.series ? `${f.series}: episodes` : 'More videos';
  $('upnext').replaceChildren(...(f.series ? episodesOf(f.series) : collapse(visibleFiles().filter(x => x.id !== f.id)).slice(0, 12)).map(x => {
    const c = card(x, true);
    if (x.id === f.id) c.classList.add('now');
    return c;
  }));
  $('watch-series').hidden = !f.series;
  $('watch-series').textContent = f.series ? `${f.series} · ${epLabel(f)}` : '';
  $('watch-series').href = f.series ? seriesHref(f.series) : '#/';
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

const nextVideo = () => { const list = state.current?.series ? episodesOf(state.current.series) : visibleFiles().filter(f => !f.series); return list[list.findIndex(x => x.id === state.current?.id) + 1]; };
const playNext = () => { cancelNext(); const n = nextVideo(); if (n) location.hash = `#/watch/${n.id}`; };

// When a video ends, the next one starts after a short countdown the viewer can cancel.
let nextTimer;
function cancelNext() { clearInterval(nextTimer); $('next-card').hidden = true; }
function queueNext() {
  const n = nextVideo();
  if (!n) return;
  let left = 5;
  $('next-title').textContent = n.title;
  $('next-count').textContent = left;
  $('next-card').hidden = false;
  stage.classList.remove('idle');
  clearInterval(nextTimer);
  nextTimer = setInterval(() => { if (--left <= 0) playNext(); else $('next-count').textContent = left; }, 1000);
}
$('next-now').addEventListener('click', playNext);
$('next-cancel').addEventListener('click', cancelNext);

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
  for (const sub of f.subs || []) {
    try {
      const text = await drive.fetchText(sub.id);
      if (state.current !== f) return;
      addTrack(sub.label, asVtt('', text));
    } catch { /* a broken subtitle file shouldn't stop the video */ }
  }
  const want = store.get('sub', '');
  if (want && [...video.textTracks].some(t => t.label === want)) showSubtitle(want);
}

let subTarget = null; // set when subtitles are being added from the details window
$('sub-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  const f = subTarget || state.current;
  subTarget = null;
  if (!file || !f) return;
  try {
    const vtt = asVtt(file.name, await file.text());
    const guess = /\.([a-z]{2,3}(?:-[a-z]{2})?)\.(?:srt|vtt)$/i.exec(file.name)?.[1];
    let label = guess ? guess.toUpperCase() : 'English';
    if (isOwner()) {
      label = await ask({ title: 'Name these subtitles', text: 'They will be saved with the video so every viewer can turn them on.', ok: 'Add subtitles', input: label });
      if (!label) return;
      const saved = await drive.uploadFile(new Blob([vtt]), { name: `${f.title}.${label}.vtt`, type: 'text/vtt' });
      (f.subs ||= []).push({ label, id: saved.id });
      await saveGallery();
      if (editing === f) { renderEditSubs(); $('edit').showModal(); }
    }
    if (state.current === f) { addTrack(label, vtt); showSubtitle(label); }
    toast(isOwner() ? 'Subtitles added for everyone.' : 'Subtitles loaded on this device.');
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
  const h = state.current?.height || video.videoHeight;
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
    { label: isOwner() ? 'Add a subtitle file for everyone…' : 'Load a subtitle file…', pick: () => { subTarget = null; $('sub-input').click(); } },
  ], tracks.length ? '' : 'This video has no subtitles yet. You can load a .srt or .vtt file.');
});

$('c-quality').addEventListener('click', e => {
  const h = state.current?.height || video.videoHeight;
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
video.addEventListener('ended', () => { rememberPosition(true); if (!video.loop) queueNext(); });
video.addEventListener('play', cancelNext);
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
$('list-btn').addEventListener('click', e => { toggleList(state.current.id); e.currentTarget.textContent = listLabel(state.current.id); });
$('copy-btn').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}#/watch/${state.current.id}`;
  navigator.clipboard.writeText(link).then(() => toast('Link copied. Anyone can watch with it.'), () => toast(link));
});

$('rename-btn').addEventListener('click', () => openEdit(state.current));
$('delete-btn').addEventListener('click', () => removeVideo(state.current));

// ---------- owner: details window ----------
let editing = null;
let newThumb; // undefined = unchanged, null = back to automatic, Blob = new picture

function renderEditSubs() {
  $('e-subs').replaceChildren(...(editing.subs || []).map(sub => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(sub.label)}</span><button class="btn small danger" type="button">Remove</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      try {
        editing.subs = editing.subs.filter(x => x !== sub);
        await saveGallery();
        drive.removeFile(sub.id).catch(() => {});
        renderEditSubs();
      } catch (err) { handleError(err); }
    });
    return li;
  }));
}

function openEdit(f) {
  editing = f; newThumb = undefined;
  $('e-title').value = f.title;
  $('e-desc').value = f.description || '';
  $('e-cat').value = f.category || '';
  $('e-feat').checked = !!f.featured;
  $('e-series').value = f.series || '';
  $('e-season').value = f.series ? f.season || 1 : '';
  $('e-episode').value = f.series ? f.episode || '' : '';
  $('e-series-list').innerHTML = [...new Set(state.files.map(x => x.series).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');
  $('e-cats').innerHTML = [...new Set(state.files.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');
  paintThumb($('e-thumb-img'), f);
  renderEditSubs();
  $('edit').showModal();
}

$('e-thumb-pick').addEventListener('click', () => $('thumb-input').click());
$('thumb-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    newThumb = await shrinkImage(file);
    const img = $('e-thumb-img');
    img.onerror = null; img.hidden = false; img.src = URL.createObjectURL(newThumb);
  } catch { toast("That picture couldn't be read."); }
});
$('e-thumb-auto').addEventListener('click', () => { newThumb = null; paintThumb($('e-thumb-img'), { id: editing.id }); });
$('e-sub-add').addEventListener('click', () => { subTarget = editing; $('edit').close(); $('sub-input').click(); });
$('e-cancel').addEventListener('click', () => $('edit').close());
$('edit').addEventListener('close', () => { if (!subTarget) editing = null; });
$('e-save').addEventListener('click', async () => {
  const f = editing;
  $('e-save').disabled = true;
  try {
    f.title = $('e-title').value.trim() || f.title;
    f.description = $('e-desc').value.trim();
    f.category = $('e-cat').value.trim();
    f.series = $('e-series').value.trim();
    if (f.series) {
      f.season = Math.max(1, parseInt($('e-season').value, 10) || 1);
      // No episode number given: it becomes the next one in that season.
      const taken = state.files.filter(x => x !== f && x.series === f.series && (x.season || 1) === f.season).map(x => x.episode || 0);
      f.episode = parseInt($('e-episode').value, 10) || Math.max(0, ...taken) + 1;
    } else { delete f.season; delete f.episode; }
    if ($('e-feat').checked) state.files.forEach(x => { x.featured = false; }); // one featured video at a time
    f.featured = $('e-feat').checked;
    if (newThumb !== undefined) {
      const old = f.thumb;
      f.thumb = newThumb ? (await drive.uploadFile(newThumb, { name: `thumb-${f.id}.jpg`, type: 'image/jpeg' })).id : '';
      if (old) drive.removeFile(old).catch(() => {});
    }
    await saveGallery();
    $('edit').close();
    if (state.current === f) { $('watch-title').textContent = f.title; $('watch-desc').textContent = f.description; $('watch-desc').hidden = !f.description; document.title = `${f.title} · Reelbox`; }
    else route();
    toast('Saved.');
  } catch (err) { handleError(err); }
  $('e-save').disabled = false;
});

async function removeVideo(f) {
  const text = f.own
    ? `“${f.title}” will disappear from the gallery and move to your Google Drive bin, where it stays for 30 days.`
    : `“${f.title}” will disappear from the gallery and stop being public. The file itself stays in your Google Drive.`;
  if (!await ask({ title: 'Remove this video?', text, ok: 'Remove', danger: true })) return;
  try {
    state.manifest.videos = state.files = state.files.filter(x => x !== f);
    await saveGallery();
    (f.own ? drive.removeFile(f.id) : drive.makePrivate(f.id)).catch(() => {});
    [f.thumb, ...(f.subs || []).map(x => x.id)].filter(Boolean).forEach(id => drive.removeFile(id).catch(() => {}));
    if (state.current === f) location.hash = '#/'; else route();
    toast('Removed from the gallery.');
  } catch (err) { handleError(err); }
}

async function addFromDrive() {
  try {
    const ids = await drive.pickVideos();
    const names = [];
    for (const id of ids) {
      if (state.files.some(f => f.id === id)) continue;
      const meta = await drive.getMeta(id);
      if (!meta.mimeType.startsWith('video/')) continue;
      await drive.makePublic(id);
      const entry = entryFrom(meta);
      state.files.unshift(entry);
      names.push(filledAs(entry));
    }
    const added = names.length;
    if (added) { await saveGallery(); route(); }
    if (ids.length) toast(added === 1 ? `Added as “${names[0]}”. Open Edit to change anything.` : added ? `Added ${added} videos, named from their files. Open Edit to change anything.` : 'Nothing new to add.');
  } catch (err) { handleError(err); }
}

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
    const line = { waiting: 'Waiting…', uploading: `${pct}% · ${fmtSize(u.sent)} of ${fmtSize(u.file.size)}`, done: `Added as “${u.note || u.file.name}”`, error: u.error || 'Failed', cancelled: 'Cancelled' }[u.status];
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
  while (isOwner() && (u = state.uploads.find(x => x.status === 'waiting'))) {
    u.status = 'uploading';
    renderQueue();
    try {
      const frame = await grabFrame(u.file);
      let painted = 0;
      const saved = await drive.uploadFile(u.file, {
        signal: u.abort.signal,
        onProgress: sent => { u.sent = sent; if (Date.now() - painted > 250) { painted = Date.now(); renderQueue(); } },
      });
      let thumb = '';
      if (frame.blob) thumb = (await drive.uploadFile(frame.blob, { name: `thumb-${saved.id}.jpg`, type: 'image/jpeg' }).catch(() => null))?.id || '';
      const entry = entryFrom(saved, { own: true, thumb, duration: frame.duration || 0 });
      state.files.unshift(entry);
      u.note = filledAs(entry);
      await saveGallery();
      u.status = 'done';
      if (!state.current) route();
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
window.addEventListener('dragenter', e => { if (hasFiles(e) && isOwner()) { dragDepth++; $('drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (dragDepth && !--dragDepth) $('drop').hidden = true; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('drop').hidden = true;
  if (isOwner()) addFiles(e.dataTransfer.files);
});

window.addEventListener('beforeunload', e => { if (state.uploads.some(u => u.status === 'uploading' || u.status === 'waiting')) e.preventDefault(); });
window.addEventListener('pagehide', () => rememberPosition(true));

// ---------- manage page ----------
async function checkPassword(pw) {
  const enc = t => new TextEncoder().encode(t);
  const key = await crypto.subtle.importKey('raw', enc(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(ADMIN_SALT), iterations: 200000 }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('') === ADMIN_HASH;
}

$('gate').addEventListener('submit', async e => {
  e.preventDefault();
  const ok = await checkPassword($('gate-pw').value).catch(() => false);
  $('gate-pw').value = '';
  $('gate-error').textContent = 'That password is not right.'; $('gate-error').hidden = ok;
  if (!ok) return;
  unlocked = true; store.set('admin', ADMIN_HASH);
  route();
  if (drive.isSignedIn()) refresh();
});

async function lock() {
  unlocked = false; store.set('admin', false);
  state.uploads.forEach(u => u.abort.abort());
  state.uploads = []; renderQueue();
  $('account-menu').hidden = true; $('notice').hidden = true;
  await drive.signOut();
  location.hash = '#/';
  route();
}
$('lock-btn').addEventListener('click', lock);
$('lock-btn-2').addEventListener('click', lock);
$('signout-btn').addEventListener('click', lock);
$('admin-upload').addEventListener('click', () => $('file-input').click());
$('admin-pick').addEventListener('click', addFromDrive);

async function renderAdmin() {
  $('gate').hidden = unlocked;
  $('gate-google').hidden = !unlocked || drive.isSignedIn();
  $('admin-panel').hidden = !isOwner();
  if (!unlocked) { $('gate-pw').focus(); return; }
  if (!isOwner()) return;
  $('admin-list').replaceChildren(...visibleFiles().map(f => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML = `<a class="thumb" href="#/watch/${f.id}"><img alt="" loading="lazy"></a>
      <div class="card-text"><strong>${esc(f.title)}</strong><span>${fmtDate(f.added)} · ${fmtSize(f.size)}${f.subs?.length ? ` · ${f.subs.length} subtitle${f.subs.length > 1 ? 's' : ''}` : ''}${f.own ? '' : ' · from your Drive'}${f.category ? ` · ${esc(f.category)}` : ''}${f.featured ? ' · featured' : ''}${f.series ? ` · ${esc(f.series)} ${epLabel(f)}` : ''}</span>
      <span>${esc(f.description || 'No description')}</span></div>
      <div class="actions"><button class="btn small">Edit</button><button class="btn small danger">Remove</button></div>`;
    paintThumb(row.querySelector('img'), f);
    const [edit, remove] = row.querySelectorAll('button');
    edit.addEventListener('click', () => openEdit(f));
    remove.addEventListener('click', () => removeVideo(f));
    return row;
  }));
  $('admin-empty').hidden = !!state.files.length;
  // Until the public key and folder ID are in js/config.js, visitors can't see the gallery.
  const steps = [];
  if (!FOLDER_ID) steps.push(`Folder ID: <code>${esc(await drive.getFolder().catch(() => 'not ready yet'))}</code>`);
  if (!API_KEY) steps.push('The public read-only key has not been added yet.');
  $('setup').innerHTML = steps.length ? `<strong>Setup not finished: visitors can't see the gallery yet.</strong><br>${steps.join('<br>')}` : '';
  $('setup').hidden = !steps.length;
}

// ---------- routing & sign-in ----------
function show(view) {
  for (const id of ['view-admin', 'view-library', 'view-series', 'view-watch']) $(id).hidden = id !== view;
}

function route() {
  paintChrome();
  const old = /^#\/v\/([\w-]+)/.exec(location.hash)?.[1]; // links from the earlier share feature
  if (old) { location.replace(`#/watch/${old}`); return; }
  if (location.hash.startsWith('#/admin')) { closePlayer(); show('view-admin'); renderAdmin(); return; }
  const series = /^#\/series\/(.+)/.exec(location.hash)?.[1];
  if (series) {
    const name = decodeURIComponent(series);
    if (!state.loaded && !state.loadError) { renderLibrary(); return show('view-library'); }
    if (!episodesOf(name).length) { location.hash = '#/'; return; }
    closePlayer(); renderSeries(name); window.scrollTo(0, 0);
    return show('view-series');
  }
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

drive.onAuthChange(async signedIn => {
  if (signedIn) {
    $('notice').hidden = true;
    await refresh();
    pump();
    return;
  }
  if (state.uploads.some(u => u.status === 'waiting')) {
    showNotice('Your Google sign-in ran out (it lasts an hour). Sign in again to finish the uploads.', 'Sign in', connect);
  }
  route();
});

$('signin-btn').addEventListener('click', connect);

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

$('search').addEventListener('input', e => { state.query = e.target.value.trim(); if (state.current || /^#\/(admin|series)/.test(location.hash)) location.hash = '#/'; else renderLibrary(); window.scrollTo(0, 0); });
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
  await Promise.all([drive.initAuth(), startWorker()]);
  route();
  await refresh();
})();
