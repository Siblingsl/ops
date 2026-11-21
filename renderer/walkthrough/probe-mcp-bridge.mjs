// 最小复现：真实 Electron 打开设置插件页，读 window.opsDesktopUI 的方法表
import { _electron, test, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('probe: opsDesktopUI bridge methods', async ({ baseURL }) => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(join(tmpdir(), 'ops-probe-mcp-'));
  const app = await _electron.launch({
    executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5287' }, timeout: 60_000,
  });
  const page = await app.firstWindow();
  const keys = await page.evaluate(() => {
    const b = window.opsDesktopUI;
    if (!b) return { exists: false };
    return { exists: true, methods: Object.keys(b).sort() };
  });
  console.log('BRIDGE:', JSON.stringify(keys, null, 1));
  await app.close();
});
