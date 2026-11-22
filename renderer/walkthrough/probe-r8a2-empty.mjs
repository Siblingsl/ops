// R8-A3 空态文案精确 dump（materials/works/topics 三页）
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8a2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('r8a2' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(2000);
const accId = await page.evaluate(async () => {
  const t = async (r) => { const x = await r.text(); return x ? JSON.parse(x) : {}; };
  const me = await t(await fetch('/api/v1/auth/me'));
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const acc = await t(await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'R8A2空态号', platform: 'wechat_mp', content_format: 'long_article' }) }));
  return acc.id;
});
for (const path of ['/materials', '/works', '/topics']) {
  await page.goto(`${BASE}/a/${accId}${path}`);
  await page.waitForTimeout(2200);
  const info = await page.evaluate(() => {
    const text = document.body.innerText;
    const emptyMatches = text.match(/(还没有[^。\n]{0,20}|暂无[^。\n]{0,15}|空空如也|去创建|先创建|创建第一)/g) ?? [];
    return { path: location.pathname.slice(-20), empties: emptyMatches.slice(0, 3), len: text.length };
  });
  console.log(path, JSON.stringify(info));
}
await app.close();
process.exit(0);
