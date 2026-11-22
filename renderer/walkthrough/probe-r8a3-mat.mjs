import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8a3-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('r8a3' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(2000);
const accId = await page.evaluate(async () => {
  const t = async (r) => { const x = await r.text(); return x ? JSON.parse(x) : {}; };
  const me = await t(await fetch('/api/v1/auth/me'));
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const acc = await t(await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'R8A3空素材', platform: 'wechat_mp', content_format: 'long_article' }) }));
  return acc.id;
});
await page.goto(`${BASE}/a/${accId}/materials`);
await page.waitForTimeout(2200);
const dump = await page.evaluate(() => {
  const main = document.querySelector('main');
  return { mainText: main?.innerText?.slice(0, 400).replace(/\n+/g, '|') ?? 'no-main', buttons: [...(main?.querySelectorAll('button') ?? [])].map(b => b.textContent?.trim()).slice(0, 6) };
});
console.log('MATERIALS-PAGE:', JSON.stringify(dump, null, 1));
await app.close();
process.exit(0);
