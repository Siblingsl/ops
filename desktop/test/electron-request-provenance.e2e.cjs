const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const desktopBinary = require('electron');

test('real Electron strips spoofed desktop headers from page, iframe, and service-worker API requests', { timeout: 60_000 }, async (t) => {
  const requests = new Map();
  const serverTraffic = [];
  const electronOutput = [];
  let pageReport;
  let resolvePageReport;
  const reportReady = new Promise((resolve) => { resolvePageReport = resolve; });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    serverTraffic.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><meta charset="utf-8"><script>
        (async () => {
          const spoofed = { 'X-OPS-Desktop-Device': 'renderer-spoof', 'X-OPS-Desktop-Policy': '999' };
          await fetch('/api/v1/e2e-probe?source=main-frame', { headers: spoofed });
          const iframeDone = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('iframe probe timed out')), 5000);
            addEventListener('message', (event) => {
              if (event.origin !== location.origin || event.data !== 'iframe-probe-done') return;
              clearTimeout(timer); resolve();
            }, { once: true });
          });
          const iframe = document.createElement('iframe');
          iframe.src = '/iframe.html'; document.body.appendChild(iframe);
          await iframeDone;
          await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('service worker did not control page')), 5000);
              navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
          }
          await fetch('/api/v1/e2e-probe?source=service-worker', { headers: spoofed });
          await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            requireType: typeof require,
            processType: typeof process,
            bridgeType: typeof window.opsDesktop,
            serviceWorkerControlled: Boolean(navigator.serviceWorker.controller)
          }) });
        })().catch(async (error) => {
          await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(error) }) });
        });
      </script>`);
      return;
    }
    if (url.pathname === '/iframe.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<script>
        fetch('/api/v1/e2e-probe?source=iframe', { headers: { 'X-OPS-Desktop-Device': 'iframe-spoof' } })
          .then(() => parent.postMessage('iframe-probe-done', location.origin));
      </script>`);
      return;
    }
    if (url.pathname === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' });
      response.end(`self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
        self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', (event) => {
          const url = new URL(event.request.url);
          if (url.pathname !== '/api/v1/e2e-probe' || url.searchParams.get('source') !== 'service-worker') return;
          const headers = new Headers(event.request.headers);
          headers.set('X-OPS-Desktop-Device', 'service-worker-spoof');
          headers.set('X-OPS-Desktop-Policy', '999');
          event.respondWith(fetch(new Request(event.request, { headers })));
        });`);
      return;
    }
    if (url.pathname === '/api/v1/auth/me') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not signed in' } }));
      return;
    }
    if (url.pathname === '/api/v1/e2e-probe') {
      requests.set(url.searchParams.get('source'), { ...request.headers });
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/report' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      pageReport = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      resolvePageReport();
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-electron-e2e-'));
  const child = spawn(desktopBinary, [`--user-data-dir=${userDataPath}`, '--disable-gpu', '--no-proxy-server', '--enable-logging=stderr', desktopRoot], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPS_DESKTOP_DEV_URL: origin,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => electronOutput.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => electronOutput.push(chunk.toString('utf8')));

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  await Promise.race([
    reportReady,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `Electron request probes did not finish within 15 seconds; traffic=${JSON.stringify(serverTraffic)}; output=${electronOutput.join('').slice(-3000)}`
      )), 15_000);
      timer.unref();
      child.once('exit', (code, signal) => reject(new Error(`Electron exited before probes completed (code=${code}, signal=${signal})`)));
    })
  ]);

  assert.deepEqual(pageReport, {
    requireType: 'undefined',
    processType: 'undefined',
    bridgeType: 'undefined',
    serviceWorkerControlled: true
  });
  assert.deepEqual([...requests.keys()].sort(), ['iframe', 'main-frame', 'service-worker']);
  for (const [source, headers] of requests) {
    assert.equal(headers['x-ops-desktop-device'], undefined, `${source} must not forward a device header`);
    assert.equal(headers['x-ops-desktop-policy'], undefined, `${source} must not forward a policy header`);
  }
});
