const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'account-clear-e2e-app');
const desktopBinary = require('electron');
const userId = '00000000-0000-4000-8000-000000000001';
const otherUserId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const deviceId = '00000000-0000-4000-8000-000000000004';
const providerId = '00000000-0000-4000-8000-000000000005';

test('Electron account cleanup removes only that account and clears business session storage', { timeout: 40_000 }, async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie ?? '' });
    if (url.pathname === '/api/v1/auth/me') {
      if (!request.headers.cookie?.includes('ops_session=account-clear-e2e')) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not signed in' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        csrf_token: 'account-clear-e2e-csrf',
        user_id: userId,
        username: 'account-clear-e2e',
        reauth_ok: true,
        workspace: { id: workspaceId, name: 'Account Cleanup Test', role: 'owner' }
      }));
      return;
    }
    if (url.pathname === '/api/v1/desktop/policy') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ global_enabled: false, policy: { enabled: false, allow_member_endpoints: false } }));
      return;
    }
    if (url.pathname === '/api/v1/desktop/capabilities' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        protocol_version: 1,
        platform_collection: {
          protocol_version: 1,
          enabled: false,
          platforms: ['wechat_mp', 'xhs'],
          purpose: 'platform_collection',
          operations: [],
          limits: {},
          protocol_versions: [1]
        }
      }));
      return;
    }
    if (url.pathname === '/api/v1/desktop/devices') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ devices: [], reauth_ok: true, csrf_token: 'account-clear-e2e-csrf' }));
      return;
    }
    if (url.pathname === '/api/v1/model-routes' || url.pathname === '/api/v1/model-providers') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }
    if (url.pathname === '/api/v1/desktop/routes') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ routes: [], policy_revision: 1 }));
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'ops_session=account-clear-e2e; Path=/; HttpOnly; SameSite=Lax'
      });
      response.end('<!doctype html><html><head><meta charset="utf-8"><title>Account cleanup test</title></head><body><main>Account cleanup acceptance test</main><script>window.opsDesktopUI.onOpenSettings(() => window.open("ops-desktop://ui/settings/account-device", "_blank", "noopener,noreferrer")); if (location.pathname === "/") localStorage.setItem("ops-account-clear-e2e", "present")</script></body></html>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Login</title>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-account-clear-e2e-'));
  const appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-account-clear-app-'));
  await fs.copyFile(path.join(harnessApp, 'package.json'), path.join(appPath, 'package.json'));
  await fs.copyFile(path.join(harnessApp, 'main.cjs'), path.join(appPath, 'main.cjs'));
  await fs.cp(path.join(desktopRoot, 'public', 'settings'), path.join(appPath, 'public', 'settings'), { recursive: true });
  const configPath = path.join(userDataPath, 'desktop-config.json');
  const accountKey = `${origin}\n${userId}`;
  const otherAccountKey = `${origin}\n${otherUserId}`;
  await fs.writeFile(configPath, JSON.stringify({
    version: 1,
    accounts: {
      [accountKey]: {
        device: { id: deviceId, publicKey: 'test-public-key', encryptedPrivateKey: 'test-private-key' },
        workspaces: {
          [workspaceId]: {
            appliedMode: 'server',
            models: [{
              providerId,
              name: 'Test local model',
              baseUrl: 'http://127.0.0.1:11434/v1',
              models: ['test-model'],
              endpointKind: 'loopback',
              configRevision: 1,
              encryptedApiKey: 'test-key-ciphertext'
            }],
            draftRoutes: [{ task_type: 'draft', provider_id: providerId, model: 'test-model' }]
          }
        }
      },
      [otherAccountKey]: { workspaces: {} }
    }
  }), 'utf8');

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
      OPS_DESKTOP_ACCOUNT_CLEAR_TEST_ORIGIN: origin,
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
        if (event.type === 'account-cleared') resolveDone(event);
        if (event.type === 'failure') rejectDone(new Error(`${event.error}; output=${JSON.stringify(output)}; requests=${JSON.stringify(requests)}`));
      } catch {
        output.push({ type: 'stdout', line });
      }
    }
  });
  child.stderr.on('data', (chunk) => output.push({ type: 'stderr', text: chunk.toString('utf8') }));
  child.once('exit', (code, signal) => {
    if (!output.some((event) => event.type === 'account-cleared')) {
      rejectDone(new Error(`Electron exited before cleanup completed (code=${code}, signal=${signal}); output=${JSON.stringify(output)}`));
    }
  });

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    await fs.rm(appPath, { recursive: true, force: true });
  });

  const result = await Promise.race([
    done,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Electron account cleanup timed out: ${JSON.stringify(output)}; requests=${JSON.stringify(requests)}`)), 30_000);
      timer.unref();
    })
  ]);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(Object.keys(config.accounts), [otherAccountKey]);
  assert.equal(result.cookiesBefore, 1);
  assert.equal(result.cookiesAfter, 0);
  assert.equal(result.storageAfter, null);
  assert.equal(result.businessUrl, `${origin}/login`);
  assert.ok(result.nativeStatus.includes('Account Cleanup Test'));
  assert.ok(result.nativeStatus.includes('服务器 AI'));
  assert.ok(result.businessTitle.includes('Account Cleanup Test'));
  assert.ok(output.some((event) => event.type === 'dialog' && event.title === '清除此账号本机数据' && event.response === 1));
  assert.ok(output.some((event) => event.type === 'dialog' && event.title === '本机数据已清除'));
  assert.ok(requests.some((request) => request.path === '/api/v1/auth/me'));
});
