const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'io-e2e-app');
const desktopBinary = require('electron');

test('Electron saves Blob and Content-Disposition downloads from the business window', { timeout: 40_000 }, async (t) => {
  const requests = [];
  const uploads = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/v1/auth/me') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not signed in' } }));
      return;
    }
    if (url.pathname === '/attachment') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="report.txt"'
      });
      response.end('attachment-download-e2e');
      return;
    }
    if (url.pathname === '/api/v1/upload' && request.method === 'POST') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        const contentType = String(request.headers['content-type'] ?? '');
        const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
        const marker = boundary?.[1] ?? boundary?.[2];
        const filename = body.toString('latin1').match(/filename="([^"]+)"/)?.[1];
        const contentStart = body.indexOf(Buffer.from('\r\n\r\n')) + 4;
        const contentEnd = marker ? body.lastIndexOf(Buffer.from(`\r\n--${marker}--`)) : -1;
        if (!filename || !marker || contentStart < 4 || contentEnd < contentStart) {
          response.writeHead(400);
          response.end('invalid multipart upload');
          return;
        }
        uploads.push({ filename, content: body.subarray(contentStart, contentEnd).toString('utf8') });
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('upload-received');
      });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8">
      <button id="copy">Copy</button>
      <a id="same-window" href="https://example.com/same-window">External</a>
      <a id="attachment" href="/attachment">Download</a>
      <input id="file-input" type="file">
      <button id="upload-file">Upload</button>
      <script>
        document.getElementById('copy').addEventListener('click', () => navigator.clipboard.writeText('clipboard-e2e-text').then(() => window.clipboardResult = 'written').catch((error) => window.clipboardResult = String(error)));
        document.getElementById('same-window').addEventListener('click', (event) => window.externalClickTrusted = event.isTrusted);
        document.getElementById('upload-file').addEventListener('click', async () => {
          const file = document.getElementById('file-input').files[0];
          if (!file) return;
          const form = new FormData();
          form.append('file', file);
          const response = await fetch('/api/v1/upload', { method: 'POST', body: form });
          window.uploadResult = await response.text();
        });
      </script>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-io-e2e-'));
  const appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-io-app-'));
  const downloadDirectory = path.join(userDataPath, 'downloads');
  await fs.mkdir(downloadDirectory, { recursive: true });
  const uploadPath = path.join(userDataPath, 'upload-e2e.txt');
  await fs.writeFile(uploadPath, 'file-upload-e2e-content');
  await fs.copyFile(path.join(harnessApp, 'package.json'), path.join(appPath, 'package.json'));
  await fs.copyFile(path.join(harnessApp, 'main.cjs'), path.join(appPath, 'main.cjs'));
  await fs.cp(path.join(desktopRoot, 'public', 'settings'), path.join(appPath, 'public', 'settings'), { recursive: true });

  const child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    '--no-proxy-server',
    appPath
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPS_DESKTOP_DEV_URL: origin,
      OPS_DESKTOP_IO_TEST_ORIGIN: origin,
      OPS_DESKTOP_IO_TEST_DOWNLOAD_DIR: downloadDirectory,
      OPS_DESKTOP_IO_TEST_UPLOAD_PATH: uploadPath,
      OPS_DESKTOP_MAIN_BUILD: path.join(desktopRoot, '.build', 'main.js'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const output = [];
  let stdoutBuffer = '';
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        output.push(event);
        if (event.type === 'io-complete') resolveDone(event);
        if (event.type === 'failure') rejectDone(new Error(`${JSON.stringify(event)}; requests=${JSON.stringify(requests)}`));
      } catch {
        output.push({ type: 'stdout', line });
      }
    }
  });
  child.stderr.on('data', (chunk) => output.push({ type: 'stderr', text: chunk.toString('utf8') }));

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(appPath, { recursive: true, force: true });
  });

  const result = await Promise.race([
    done,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Electron download scenario timed out: ${JSON.stringify(output)}; requests=${JSON.stringify(requests)}`)), 30_000);
      timer.unref();
    })
  ]);
  assert.equal(result.clipboardText, 'clipboard-e2e-text');
  assert.deepEqual(result.externalUrls, ['https://example.com/popup', 'https://example.com/same-window']);
  assert.deepEqual(result.externalPrompts, [
    '是否在系统浏览器中打开 example.com？',
    '是否在系统浏览器中打开 example.com？'
  ]);
  assert.equal(result.businessUrl, origin + '/');
  assert.equal(result.bridgeType, 'undefined');
  assert.deepEqual(result.downloaded, [
    { filename: 'blob-export.zip', content: 'blob-download-e2e' },
    { filename: 'report.txt', content: 'attachment-download-e2e' }
  ]);
  assert.equal(result.uploadResponse, 'upload-received');
  assert.deepEqual(uploads, [{ filename: 'upload-e2e.txt', content: 'file-upload-e2e-content' }]);
});
