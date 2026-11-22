// 只做 A3：materials 页 dump（R8 探针，evaluate 内 try/catch + 状态 dump）
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8dbg2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
page.on('console', m => console.log('[PAGE]', m.text().slice(0, 150)));
await page.setViewportSize({ width: 1580, height: 1000 });
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('r8d2' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(1500);
const setup = await page.evaluate(async () => {
  try {
    const t = async (r) => { const x = await r.text(); return x ? JSON.parse(x) : {}; };
    const meR = await fetch('/api/v1/auth/me');
    console.log('AUTH-ME:', meR.status);
    const me = await t(meR);
    const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
    const accR = await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'DBG2号', platform: 'wechat_mp', content_format: 'long_article' }) });
    console.log('ACC:', accR.status);
    const acc = await t(accR);
    return { ok: true, id: acc.id, meStatus: meR.status, accStatus: accR.status };
  } catch (e) {
    console.log('SETUP-ERR:', String(e).slice(0, 150));
    return { ok: false, err: String(e).slice(0, 150) };
  }
});
console.log('SETUP:', JSON.stringify(setup));
const accId = setup?.id;
await page.goto(`${BASE}/a/${accId ?? 'NONE'}/materials`);
await page.waitForTimeout(2500);
console.log('URL:', page.url().slice(0, 60));
console.log('H1:', await page.evaluate(() => document.querySelector('h1,h2')?.textContent?.slice(0, 30) ?? 'none'));
console.log('EMPTY-TEXT:', await page.evaluate(() => document.body.innerText.match(/(还没有|暂无|没有|先添加)/)?.[0] ?? 'none'));
await app.close();
process.exit(0);
