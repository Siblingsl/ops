const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const webDist = path.resolve(desktopRoot, '..', 'web', 'dist');
const desktopBinary = require('electron');

test('Electron loads the production Web build and its Service Worker keeps API traffic network-only', { timeout: 45_000 }, async (t) => {
  const apiRequests = [];
  let assetRequestCount = 0;
  let report;
  let resolveReport;
  const reportReady = new Promise((resolve) => { resolveReport = resolve; });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/me') {
      response.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: { message: 'not signed in' } }));
      return;
    }
    if (url.pathname === '/api/v1/e2e-probe') {
      const count = apiRequests.push({ source: url.searchParams.get('source'), headers: request.headers });
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Probe-Counter': String(count)
      });
      response.end(JSON.stringify({ count }));
      return;
    }
    if (url.pathname === '/assets/__e2e-cache-probe.js') {
      assetRequestCount++;
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Asset-Counter': String(assetRequestCount) });
      response.end(`window.__assetProbe=${assetRequestCount};`);
      return;
    }
    if (url.pathname === '/report' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      resolveReport();
      response.writeHead(204);
      response.end();
      return;
    }

    let filePath;
    try {
      const decodedPath = decodeURIComponent(url.pathname);
      filePath = path.resolve(webDist, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (filePath !== webDist && !filePath.startsWith(`${webDist}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      let body = await fs.readFile(filePath);
      if (url.pathname === '/') {
        const probeScript = `<script>
          window.addEventListener('load', () => { void (async () => {
            const timer = (message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 10000));
            await Promise.race([navigator.serviceWorker.ready, timer('production service worker did not become ready')]);
            if (!navigator.serviceWorker.controller) await Promise.race([
              new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
              timer('production service worker did not control the business page')
            ]);
            const probe = (source) => fetch('/api/v1/e2e-probe?source=' + source, {
              headers: { 'X-OPS-Desktop-Device': 'renderer-spoof', 'X-OPS-Desktop-Policy': '999' },
              cache: 'no-store'
            }).then((response) => response.headers.get('X-Probe-Counter'));
            const apiCounters = [await probe('production-sw-1'), await probe('production-sw-2')];
            const firstAsset = await fetch('/assets/__e2e-cache-probe.js').then((response) => response.headers.get('X-Asset-Counter'));
            await new Promise((resolve) => setTimeout(resolve, 150));
            const secondAsset = await fetch('/assets/__e2e-cache-probe.js').then((response) => response.headers.get('X-Asset-Counter'));
            await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
              controlled: Boolean(navigator.serviceWorker.controller), apiCounters, firstAsset, secondAsset,
              requireType: typeof require, processType: typeof process, bridgeType: typeof window.opsDesktop
            }) });
          })().catch(async (error) => {
            await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(error) }) });
          }); }, { once: true });
        </script>`;
        body = Buffer.from(body.toString('utf8').replace('</body>', `${probeScript}</body>`));
      }
      const extension = path.extname(filePath);
      const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' })[extension] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': contentType, ...(url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-production-sw-'));
  const child = spawn(desktopBinary, [`--user-data-dir=${userDataPath}`, '--disable-gpu', '--no-proxy-server', desktopRoot], {
    cwd: desktopRoot,
    env: { ...process.env, OPS_DESKTOP_DEV_URL: origin, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  await Promise.race([
    reportReady,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`production Service Worker probe timed out; output=${output.join('').slice(-3000)}`)), 20_000);
      timer.unref();
      child.once('exit', (code, signal) => reject(new Error(`Electron exited before probe report (code=${code}, signal=${signal}); output=${output.join('').slice(-3000)}`)));
    })
  ]);

  assert.equal(report.error, undefined, report.error);
  assert.equal(report.controlled, true);
  assert.deepEqual(report.apiCounters, ['1', '2'], 'production Service Worker must not cache API responses');
  assert.equal(report.firstAsset, report.secondAsset, 'production Service Worker should reuse cached app assets');
  assert.equal(assetRequestCount, 1);
  assert.deepEqual(apiRequests.map((entry) => entry.source), ['production-sw-1', 'production-sw-2']);
  for (const { headers } of apiRequests) {
    assert.equal(headers['x-ops-desktop-device'], undefined, 'renderer supplied device headers must be stripped');
    assert.equal(headers['x-ops-desktop-policy'], undefined, 'renderer supplied policy headers must be stripped');
  }
  assert.deepEqual({ requireType: report.requireType, processType: report.processType, bridgeType: report.bridgeType }, {
    requireType: 'undefined', processType: 'undefined', bridgeType: 'undefined'
  });
});
