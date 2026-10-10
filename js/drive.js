// Everything that talks to Google: sign-in, and the Drive calls for listing, uploading,
// renaming and removing videos.
import { CLIENT_ID, SCOPE, FOLDER_NAME } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id,name,size,mimeType,createdTime,thumbnailLink,videoMediaMetadata(durationMillis,width,height),appProperties';
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KB

const K_TOKEN = 'reelbox.token';
const K_HINT = 'reelbox.hint';
// The service worker reads the token from here so it can stream videos (see sw.js).
export const AUTH_CACHE = 'reelbox-auth';
export const AUTH_KEY = '/reelbox-auth/token';

export class AuthError extends Error {}

let token = null;
let tokenClient = null;
let pending = null;
const listeners = new Set();

export const onAuthChange = fn => listeners.add(fn);
export const isSignedIn = () => !!token && token.expires_at > Date.now();
export const isConfigured = () => !!CLIENT_ID;

async function shareToken() {
  try {
    const cache = await caches.open(AUTH_CACHE);
    if (token) await cache.put(AUTH_KEY, new Response(JSON.stringify(token)));
    else await cache.delete(AUTH_KEY);
  } catch { /* no Cache API: playback falls back to a full download */ }
}

async function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(K_TOKEN, JSON.stringify(next));
    else localStorage.removeItem(K_TOKEN);
  } catch { /* private window */ }
  await shareToken();
  listeners.forEach(fn => fn(isSignedIn()));
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't reach Google sign-in. Check your connection or ad blocker."));
    document.head.appendChild(s);
  });
}

// Restores a still-valid session from an earlier visit. Returns true when signed in.
export async function initAuth() {
  try {
    const saved = JSON.parse(localStorage.getItem(K_TOKEN) || 'null');
    if (saved && saved.expires_at > Date.now()) token = saved;
  } catch { /* ignore */ }
  await shareToken();
  if (CLIENT_ID) loadGis().catch(() => {});
  return isSignedIn();
}

// Opens Google's sign-in popup. Must be called from a click, or the browser blocks the popup.
export async function signIn() {
  await loadGis();
  tokenClient ??= google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: res => {
      const p = pending; pending = null;
      if (res.error) return p?.reject(new AuthError(res.error_description || res.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) {
        return p?.reject(new AuthError('Reelbox needs permission to save videos to your Google Drive. Please tick the box when signing in.'));
      }
      p?.resolve({ access_token: res.access_token, expires_at: Date.now() + (Number(res.expires_in) - 60) * 1000 });
    },
    error_callback: err => {
      const p = pending; pending = null;
      const msg = err.type === 'popup_failed_to_open' ? 'Your browser blocked the sign-in window. Allow pop-ups for this page and try again.'
        : err.type === 'popup_closed' ? 'Sign-in was cancelled.' : (err.message || 'Sign-in failed.');
      p?.reject(new AuthError(msg));
    },
  });
  const next = await new Promise((resolve, reject) => {
    pending = { resolve, reject };
    let hint;
    try { hint = localStorage.getItem(K_HINT) || undefined; } catch { /* ignore */ }
    tokenClient.requestAccessToken({ prompt: '', hint });
  });
  await setToken(next);
}

export async function signOut() {
  await setToken(null);
}

async function api(path, { method = 'GET', body, params, keepalive } = {}) {
  if (!isSignedIn()) { await setToken(null); throw new AuthError('Signed out'); }
  const url = new URL(path.startsWith('http') ? path : API + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method, keepalive,
    headers: { Authorization: `Bearer ${token.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { await setToken(null); throw new AuthError('Session expired'); }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error?.message || `Google Drive error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function getAccount() {
  const about = await api('/about', { params: { fields: 'user(displayName,emailAddress,photoLink),storageQuota(limit,usage)' } });
  try { localStorage.setItem(K_HINT, about.user.emailAddress); } catch { /* ignore */ }
  return about;
}

let folderId = null;
async function getFolder() {
  if (folderId) return folderId;
  const q = "mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='reelbox' and value='root' }";
  const found = await api('/files', { params: { q, fields: 'files(id)', pageSize: 1 } });
  folderId = found.files[0]?.id
    || (await api('/files', { method: 'POST', params: { fields: 'id' }, body: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { reelbox: 'root' } } })).id;
  return folderId;
}

export async function listVideos() {
  const files = [];
  let pageToken;
  do {
    const page = await api('/files', { params: {
      q: "trashed=false and mimeType contains 'video/'", fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'createdTime desc', pageSize: 200, ...(pageToken ? { pageToken } : {}),
    } });
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

export const getVideo = id => api(`/files/${id}`, { params: { fields: FILE_FIELDS } });
export const renameVideo = (id, name) => api(`/files/${id}`, { method: 'PATCH', params: { fields: FILE_FIELDS }, body: { name } });
// Moves to the Drive bin rather than deleting outright, so a mistake can be undone for 30 days.
export const removeVideo = id => api(`/files/${id}`, { method: 'PATCH', params: { fields: 'id' }, body: { trashed: true } });
export const savePosition = (id, seconds) =>
  api(`/files/${id}`, { method: 'PATCH', params: { fields: 'id' }, body: { appProperties: { pos: String(Math.floor(seconds)) } }, keepalive: true });

// Used when the service worker isn't available: pulls the whole file down before playing.
export async function downloadBlob(id, onProgress) {
  if (!isSignedIn()) throw new AuthError('Signed out');
  const res = await fetch(`${API}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (res.status === 401) { await setToken(null); throw new AuthError('Session expired'); }
  if (!res.ok) throw new Error(`Couldn't load the video (${res.status}).`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress?.(got / total);
  }
  return new Blob(parts, { type: res.headers.get('Content-Type') || 'video/mp4' });
}

const TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', ts: 'video/mp2t', wmv: 'video/x-ms-wmv', flv: 'video/x-flv' };
export const videoType = file => (file.type.startsWith('video/') ? file.type : TYPES[file.name.split('.').pop().toLowerCase()] || '');

function putChunk(url, blob, start, total, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Range', blob ? `bytes ${start}-${start + blob.size - 1}/${total}` : `bytes */${total}`);
    xhr.upload.onprogress = e => onProgress?.(start + e.loaded);
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob || null);
  });
}

// "Range: bytes=0-N" on a 308 says how much Google has received so far.
function receivedBytes(xhr, fallback) {
  const m = /-(\d+)$/.exec(xhr.getResponseHeader('Range') || '');
  return m ? Number(m[1]) + 1 : fallback;
}

// Uploads in pieces so a dropped connection resumes instead of starting over.
export async function uploadVideo(file, { duration, onProgress, signal } = {}) {
  if (!isSignedIn()) { await setToken(null); throw new AuthError('Session expired'); }
  const type = videoType(file);
  const parent = await getFolder();
  const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST', signal,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(file.size),
    },
    body: JSON.stringify({ name: file.name, mimeType: type, parents: [parent], appProperties: duration ? { dur: String(Math.round(duration)) } : {} }),
  });
  if (start.status === 401) { await setToken(null); throw new AuthError('Session expired'); }
  if (!start.ok) {
    const detail = await start.json().catch(() => null);
    const reason = detail?.error?.errors?.[0]?.reason;
    throw new Error(reason === 'storageQuotaExceeded' ? 'Your Google Drive is full.' : detail?.error?.message || `Upload refused (${start.status}).`);
  }
  const session = start.headers.get('Location');
  if (!session) throw new Error("Google didn't return an upload address.");

  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    const blob = file.slice(offset, Math.min(offset + CHUNK, file.size));
    let xhr;
    try {
      xhr = await putChunk(session, blob, offset, file.size, onProgress, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      xhr = null;
    }
    if (xhr && (xhr.status === 200 || xhr.status === 201)) { onProgress?.(file.size); return JSON.parse(xhr.responseText); }
    if (xhr && xhr.status === 308) { offset = receivedBytes(xhr, offset + blob.size); failures = 0; continue; }
    if (xhr && xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429) {
      throw new Error(xhr.status === 403 ? 'Your Google Drive is full, or the upload was refused.' : `Upload failed (${xhr.status}).`);
    }
    // Network drop or server hiccup: wait, ask Google how far it got, carry on from there.
    if (++failures > 6) throw new Error('The connection kept dropping. Try again when your internet is steadier.');
    await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** failures)));
    try {
      const status = await putChunk(session, null, 0, file.size, null, signal);
      if (status.status === 200 || status.status === 201) return JSON.parse(status.responseText);
      if (status.status === 308) offset = receivedBytes(status, 0);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  throw new Error('Upload ended unexpectedly.');
}
