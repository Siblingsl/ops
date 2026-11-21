// Q-03 定性：真实 Electron 里直接调用 bridge.validateMcpConnection（stdio: node server.js）
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'ops-probe-mcpv-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5287' }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.goto('http://127.0.0.1:5287/settings/plugins');
await page.waitForTimeout(1500);
const out = await page.evaluate(async () => {
  const b = window.opsDesktopUI;
  if (!b?.validateMcpConnection) return { exists: false };
  const t0 = Date.now();
  try {
    const r = await b.validateMcpConnection({ connection_id: '00000000-0000-0000-0000-000000000000', transport: 'stdio', command: 'node', args: ['server.js'] });
    return { exists: true, ok: r.ok, code: r.code, message: (r.message ?? '').slice(0, 160), ms: Date.now() - t0 };
  } catch (e) {
    return { exists: true, threw: String(e).slice(0, 200), ms: Date.now() - t0 };
  }
});
console.log('VALIDATE:', JSON.stringify(out));
await app.close();
process.exit(0);
