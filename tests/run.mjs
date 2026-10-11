// Runs a browser test against the real pages with tests/mock-drive.js in place of Google Drive.
//   node tests/run.mjs tests/<name>.browser.js [screenshot.png]
// The test script runs in the page and must put its findings in <pre id="result">.
// Needs Google Chrome. For playback tests, put a short clip at tests/sample.mp4 (not kept in git).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [script, shot] = process.argv.slice(2);
const password = (() => { try { return readFileSync(join(root, '.admin-password'), 'utf8').trim(); } catch { return ''; } })();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  try {
    if (path === '/js/drive.js') return res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(readFileSync(join(root, 'tests/mock-drive.js')));
    if (path === '/js/test.js') return res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(readFileSync(join(root, script)));
    if (path === '/sample.mp4') path = '/tests/sample.mp4';
    const file = join(root, path);
    if (path === '/index.html') {
      const html = readFileSync(file, 'utf8').replace('<script type="module" src="js/app.js"></script>',
        `<script>window.__pw=${JSON.stringify(password)}</script><script type="module" src="js/app.js"></script><script type="module" src="js/test.js"></script>`);
      return res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(html);
    }
    const size = statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); // video seeking asks for byte ranges
    const start = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(file, { start, end }).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}/`;

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--remote-debugging-port=9333', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'reelbox-test-'))}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let tabs; for (let i = 0; i < 40 && !tabs; i++) { await sleep(250); tabs = await fetch('http://127.0.0.1:9333/json').then(r => r.json()).catch(() => null); }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let n = 0; const waiters = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); waiters.get(m.id)?.(m.result); };
  const send = (method, params = {}) => new Promise(r => { const id = ++n; waiters.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Page.navigate', { url: site });
  let out = null;
  for (let i = 0; i < 80 && !out; i++) { await sleep(500); out = (await send('Runtime.evaluate', { expression: "document.getElementById('result')?.textContent || ''" }))?.result?.value || null; }
  console.log(out ? out.replaceAll(password || '\u0000', '<password>') : 'NO RESULT');
  if (shot) writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
} finally { chrome.kill(); server.close(); }
