// Stand-in for js/drive.js used by tests/run.mjs: a small pretend gallery, no Google.
export class AuthError extends Error {}
let signed = false; const ls = new Set();
export const onAuthChange = fn => ls.add(fn);
export const isSignedIn = () => signed;
export const isPublic = true;
export const initAuth = async () => false;
export const signIn = async () => { signed = true; for (const f of ls) await f(true); };
export const signOut = async () => { signed = false; ls.forEach(f => f(false)); };
export const getAccount = async () => ({ user: { displayName: 'Owner', emailAddress: 'owner@example.com' }, storageQuota: { usage: 5e9, limit: 15e9 } });
export const getFolder = async () => 'FOLDER123';
const vid = (id, title, d, x = {}) => ({ id, title, description: '', size: 1100000, mimeType: 'video/mp4', added: d, duration: 5, width: 960, height: 540, thumb: '', subs: [], own: true, ...x });
const T = ['Flower close-up', 'Harbour at dawn', 'Mountain road', 'Street food tour', 'Piano session', 'Birthday 2026', 'Night market', 'Coast walk'];
const C = ['Nature', 'Travel', 'Travel', 'Food', 'Music', 'Family', 'Food', 'Travel'];
let manifest = { version: 1, videos: T.map((t, i) => vid('v' + i, t, `2026-10-0${9 - i}T10:00:00Z`, {
  category: C[i], featured: i === 1, subs: i ? [] : [{ label: 'English', id: 's1' }],
  ...(i >= 5 ? { series: 'Road Trip', season: i === 7 ? 2 : 1, episode: i === 7 ? 1 : i - 4 } : {}),
})) };
window.__saves = 0;
export const loadManifest = async () => JSON.parse(JSON.stringify(manifest));
export const saveManifest = async d => { manifest = JSON.parse(JSON.stringify(d)); window.__saves++; };
export const getMeta = async id => ({ id, name: 'road trip - s02e02 - the_long_way.mov', mimeType: 'video/quicktime', size: '2000000', videoMediaMetadata: { durationMillis: '9000', width: 1920, height: 1080 } });
export const makePublic = async () => {}; export const makePrivate = async () => {}; export const removeFile = async () => {};
export const pickVideos = async () => ['p9'];
export const imageUrl = () => '';
export const mediaUrl = () => 'sample.mp4';
export const fetchText = async () => 'WEBVTT\n\n00:00.000 --> 00:02.500\nA flower opens.\n\n00:02.500 --> 00:05.000\nStill opening.';
export const downloadBlob = async () => (await fetch('sample.mp4')).blob();
export const videoType = f => ((f.type || '').startsWith('video/') ? f.type : '');
export const uploadFile = async (file, o = {}) => { o.onProgress?.(file.size); return { id: 'u' + Math.random().toString(36).slice(2), name: o.name || file.name, mimeType: o.type || file.type, size: String(file.size) }; };
