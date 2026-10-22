const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'scope-lifecycle-e2e-app');
const desktopBinary = require('electron');

test('Electron drops the previous AI scope on user, workspace, and logout changes', { timeout: 20_000 }, async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-scope-e2e-'));
  const child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    harnessApp
  ], {
    cwd: desktopRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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
        if (event.type === 'failure') rejectDone(new Error(`${event.error}; output=${JSON.stringify(output)}`));
      } catch {
        output.push({ type: 'stdout', line });
      }
    }
  });
  child.stderr.on('data', (chunk) => output.push({ type: 'stderr', text: chunk.toString('utf8') }));
  child.once('exit', (code, signal) => {
    if (code === 0) resolveDone(output);
    else rejectDone(new Error(`Electron exited with code=${code}, signal=${signal}; output=${JSON.stringify(output)}`));
  });

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const result = await Promise.race([
    done,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Electron scope lifecycle timed out: ${JSON.stringify(output)}`)), 15_000);
      timer.unref();
    })
  ]);
  assert.deepEqual(result.filter((event) => event.type === 'scope-reset').map((event) => event.scope), ['user', 'workspace', 'logout']);
});
