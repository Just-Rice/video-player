// Service worker with one job: let the <video> element play straight from Google Drive.
// Drive only hands a file over when the request carries the sign-in token in a header, and a
// <video> tag can't add headers. So the page points the player at ./stream/<id>, and this
// worker fetches the matching bytes from Drive with the token attached. Seeking works because
// the browser's "give me bytes X to Y" request is passed straight through.

const AUTH_CACHE = 'reelbox-auth';
const AUTH_KEY = '/reelbox-auth/token';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const match = /\/stream\/([\w-]+)$/.exec(url.pathname);
  if (match) event.respondWith(stream(event.request, match[1], url.searchParams));
});

async function accessToken() {
  const cache = await caches.open(AUTH_CACHE);
  const saved = await cache.match(AUTH_KEY);
  if (!saved) return null;
  const token = await saved.json();
  return token.expires_at > Date.now() ? token.access_token : null;
}

async function stream(request, id, params) {
  const token = await accessToken();
  if (!token) return new Response('Signed out', { status: 401 });

  const size = Number(params.get('size')) || 0;
  const range = request.headers.get('Range');
  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers, signal: request.signal });
  } catch {
    return new Response('Network error', { status: 502 });
  }
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  const out = new Headers({
    'Content-Type': params.get('type') || upstream.headers.get('Content-Type') || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (params.get('download')) out.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(params.get('download'))}`);

  if (upstream.status === 206) {
    // Google doesn't always let the page read Content-Range, so work it out from the request.
    let contentRange = upstream.headers.get('Content-Range');
    const asked = /bytes=(\d*)-(\d*)/.exec(range || '');
    if (!contentRange && asked && size) {
      const start = asked[1] === '' ? size - Number(asked[2]) : Number(asked[1]);
      const end = asked[1] === '' || asked[2] === '' ? size - 1 : Math.min(Number(asked[2]), size - 1);
      contentRange = `bytes ${start}-${end}/${size}`;
    }
    const span = /bytes (\d+)-(\d+)\//.exec(contentRange || '');
    if (span) out.set('Content-Length', String(Number(span[2]) - Number(span[1]) + 1));
    if (contentRange) out.set('Content-Range', contentRange);
    return new Response(upstream.body, { status: 206, headers: out });
  }
  if (size) out.set('Content-Length', String(size));
  return new Response(upstream.body, { status: 200, headers: out });
}
