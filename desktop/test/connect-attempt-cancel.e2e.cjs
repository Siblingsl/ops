const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'connect-cancel-e2e-app');
const desktopBinary = require('electron');

test('a suspended in-flight connection cannot reopen after its auth response arrives', { timeout: 30_000 }, async (t) => {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount++;
    if (request.url === '/api/v1/auth/me') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        user_id: 'f7e4c9f8-77f5-4ff6-bbbc-c6841d96a0a2',
        username: 'desktop-e2e',
        csrf_token: 'test-csrf-token',
        reauth_ok: true,
        workspace: { id: '7f623028-71ca-4e2d-a778-c32172810aa1', name: 'Test workspace' }
      }));
      return;
    }
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'A cancelled connection must not issue follow-up requests.' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-connect-cancel-e2e-'));
  const address = server.address();
  const child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    '--no-proxy-server',
    harnessApp
  ], {
    cwd: desktopRoot,
    env: { ...process.env, OPS_DESKTOP_CONNECT_CANCEL_ORIGIN: `http://127.0.0.1:${address.port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const output = [];
  const stderr = [];
  const waiters = new Map();
  let stdoutBuffer = '';
  const waitFor = (type) => {
    const existing = output.find((message) => message.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => waiters.set(type, { resolve, reject }));
  };
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        output.push(message);
        waiters.get(message.type)?.resolve(message);
        waiters.delete(message.type);
      } catch {
        stderr.push(line);
      }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  child.once('exit', (code, signal) => {
    for (const waiter of waiters.values()) waiter.reject(new Error(
      `Electron exited before completing the connection test (code=${code}, signal=${signal}); output=${JSON.stringify(output)}; stderr=${stderr.join('').slice(-2000)}`
    ));
  });

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  await waitFor('attempt-started');
  const settled = await waitFor('settled');
  assert.ok(output.some((message) => message.type === 'disconnected'), 'the test must disconnect while auth completion is being delivered');
  assert.equal(settled.channelState, 'disconnected');
  assert.equal(settled.socketPresent, false);
  assert.equal(settled.workerPresent, false);
  assert.equal(settled.routing.mode, 'server');
  assert.equal(requestCount, 1, 'cancelled validation must not issue another request after resuming');
});
