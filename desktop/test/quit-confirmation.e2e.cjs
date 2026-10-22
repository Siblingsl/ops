const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'quit-e2e-app');
const desktopBinary = require('electron');

async function startBusinessServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/me') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not signed in' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Quit E2E</title>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runQuitScenario(t, responses) {
  const expectsExit = responses.includes(1);
  const { server, origin } = await startBusinessServer();
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-quit-e2e-'));
  const child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    '--no-proxy-server',
    harnessApp
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPS_DESKTOP_DEV_URL: origin,
      OPS_DESKTOP_QUIT_TEST_ORIGIN: origin,
      OPS_DESKTOP_QUIT_TEST_RESPONSES: JSON.stringify(responses),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const output = [];
  let stdoutBuffer = '';
  let resolveEvent;
  const events = new Promise((resolve) => { resolveEvent = resolve; });
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
        if (!expectsExit && event.type === 'quit-cancelled' && output.filter((entry) => entry.type === 'quit-cancelled').length === responses.filter((response) => response === 0).length) {
          resolveEvent(output);
        }
      } catch {
        output.push({ type: 'stdout', line });
      }
    }
  });
  child.stderr.on('data', (chunk) => output.push({ type: 'stderr', text: chunk.toString('utf8') }));
  child.once('exit', () => {
    if (expectsExit) resolveEvent(output);
  });

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

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Electron quit scenario timed out: ${JSON.stringify(output)}`)), 15_000);
    timer.unref();
  });
  return { output: await Promise.race([events, timeout]), child };
}

test('Electron close cancellation keeps the business window open and confirmed quit exits', { timeout: 30_000 }, async (t) => {
  const { output, child } = await runQuitScenario(t, [0, 1]);
  const dialogs = output.filter((event) => event.type === 'quit-dialog');
  assert.equal(dialogs.length, 2);
  assert.deepEqual(dialogs.map((event) => event.response), [0, 1]);
  assert.ok(dialogs[0].detail.includes('保存业务页面'));
  assert.ok(dialogs[0].detail.includes('本机模型调用'));
  assert.ok(output.some((event) => event.type === 'quit-cancelled' && event.windowOpen));
  assert.notEqual(child.exitCode, null);
});

test('Electron stays open when the user cancels the close confirmation', { timeout: 30_000 }, async (t) => {
  const { output, child } = await runQuitScenario(t, [0]);
  assert.equal(output.filter((event) => event.type === 'quit-dialog').length, 1);
  assert.ok(output.some((event) => event.type === 'quit-cancelled' && event.windowOpen));
  assert.equal(child.exitCode, null);
});
