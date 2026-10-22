const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'channel-e2e-app');
const desktopBinary = require('electron');

async function main() {
  const origin = process.env.OPS_DESKTOP_CHANNEL_TEST_ORIGIN;
  if (!origin || !process.env.OPS_DESKTOP_CHANNEL_TEST_SESSION) throw new Error('Missing authenticated Go test server input.');

  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-go-channel-e2e-'));
  const child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    '--no-proxy-server',
    harnessApp
  ], {
    cwd: desktopRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const output = [];
  const stderr = [];
  let buffer = '';
  let resolveDisconnected;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveDisconnected = resolve;
    rejectResult = reject;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        output.push(message);
        if (message.type === 'disconnected') resolveDisconnected(message);
        if (message.type === 'failure') rejectResult(new Error(`${message.error}; output=${JSON.stringify(output)}`));
      } catch {
        stderr.push(line);
      }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  child.once('exit', (code, signal) => {
    if (!output.some((message) => message.type === 'disconnected')) {
      rejectResult(new Error(`Electron exited early (code=${code}, signal=${signal}); stderr=${stderr.join('').slice(-2000)}`));
    }
  });

  let finishTimer;
  let exitTimer;
  try {
    const disconnected = await Promise.race([
      result,
      new Promise((_, reject) => {
        finishTimer = setTimeout(() => reject(new Error(
          `Electron did not finish; output=${JSON.stringify(output)}; stderr=${stderr.join('').slice(-2000)}`
        )), 90_000);
      })
    ]);
    clearTimeout(finishTimer);
    const connected = output.find((message) => message.type === 'connected');
    assert.ok(connected, `missing connected state: ${JSON.stringify(output)}`);
    assert.equal(connected.state.channelState, 'ready');
    assert.equal(connected.state.deviceRegistered, true);
    assert.ok(connected.routing.requestContext.deviceId);
    assert.ok(connected.routing.requestContext.connectionId);
    assert.ok(connected.routing.requestContext.routeRevision >= (process.env.OPS_DESKTOP_CHANNEL_TEST_LOCAL_MODEL_URL ? 2 : 1));
    if (process.env.OPS_DESKTOP_CHANNEL_TEST_LOCAL_MODEL_URL) {
      assert.ok(connected.coldStartProviderId, 'missing local model provider from Electron setup');
      assert.equal(connected.routing.mode, 'desktop');
    }
    assert.equal(disconnected.state, 'disconnected');
    const lost = output.find((message) => message.type === 'connection-lost');
    const reconnected = output.find((message) => message.type === 'reconnected');
    assert.ok(lost, `missing disconnected state: ${JSON.stringify(output)}`);
    assert.equal(lost.channelState, 'error');
    assert.equal(lost.pendingCount, 0);
    assert.equal(lost.cancelObserved, true);
    assert.ok(reconnected, `missing manually reconnected state: ${JSON.stringify(output)}`);
    assert.equal(reconnected.state.channelState, 'ready');
    assert.equal(reconnected.pendingCount, 0);
    assert.ok(reconnected.generation > connected.routing.requestContext.generation);

    const [code] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('Electron did not exit after disconnect.')), 3000);
      })
    ]);
    clearTimeout(exitTimer);
    assert.equal(code, 0);
    return {
      type: 'reconnected',
      generation: reconnected.generation,
      pendingCount: reconnected.pendingCount,
      cancelObserved: lost.cancelObserved
    };
  } finally {
    clearTimeout(finishTimer);
    clearTimeout(exitTimer);
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stdout.write('Electron completed the authenticated Go WSS integration.\n');
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
