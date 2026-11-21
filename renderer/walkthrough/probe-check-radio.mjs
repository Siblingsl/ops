// Q-04 定位：检查页 radio 的几何（getBoundingClientRect）与 sticky 容器滚动
import { _electron, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2o' + Date.now().toString(36);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill(USERNAME);
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(600);
const data = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  const accs = await (await fetch('/api/v1/accounts', { headers: { 'X-CSRF-Token': me.csrf_token }, method: 'POST', headers2: {} })).json().catch(() => null);
  return { me, accs };
});
await browser.close();
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-cr-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.setViewportSize({ width: 1440, height: 1000 });
await native.goto(`${BASE}/register`);
await native.getByLabel('用户名', { exact: true }).fill('wt2p' + Date.now().toString(36));
await native.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await native.getByRole('button', { name: '创建账号', exact: true }).click();
await native.waitForTimeout(800);
const ctx = await native.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  const csrf = me.csrf_token;
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const acc = await (await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: '检查radio号', platform: 'wechat_mp', content_format: 'long_article' }) })).json();
  const w = await (await fetch(`/api/v1/accounts/${acc.id}/works`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Q04radio作品', content_format: 'long_article' }) })).json();
  // 写正文触发敏感词/事实检查项
  await fetch(`/api/v1/works/${w.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '# 标题\n\n这个产品是全网最低价，绝对第一。\n\n## 第二节\n\n事实证明这样做有效果。', viewpoint: '低价比拼' }) });
  const secs = (await (await fetch(`/api/v1/works/${w.id}`)).json()).sections ?? [];
  for (const s of secs) await fetch(`/api/v1/sections/${s.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '第一段记录可核对的事实与验证方式，确保结论可靠。', base_revision: s.revision }) });
  const lcr = await fetch(`/api/v1/works/${w.id}/checks/latest`, { method: 'POST', headers: h, body: '{}' });
  const lcText = await lcr.text();
  const lc = lcText ? JSON.parse(lcText) : {};
  return { acc: acc.id, work: w.id };
});
console.log('ctx', JSON.stringify(ctx));
await native.goto(`${BASE}/works/${ctx.work}/check`);
await native.waitForTimeout(1200);
await native.getByRole('button', { name: '开始检查', exact: true }).click();
await native.waitForTimeout(9000);
const geo = await native.evaluate(() => {
  const radios = [...document.querySelectorAll('input[type="radio"]')].slice(0, 4);
  const sticky = [...document.querySelectorAll('div')].find((d) => typeof d.className === 'string' && d.className.includes('lg:sticky') && d.className.includes('overflow-y-auto'));
  return {
    vp: { w: innerWidth, h: innerHeight },
    radios: radios.map((r) => { const b = r.getBoundingClientRect(); return { name: r.name.slice(0, 8), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), inVp: b.y >= 0 && b.bottom <= innerHeight && b.x >= 0 && b.right <= innerWidth }; }),
    stickyY: sticky?.getBoundingClientRect().y, stickyH: sticky?.getBoundingClientRect().height, stickyScroll: sticky?.scrollTop, stickyScrollH: sticky?.scrollHeight,
  };
});
console.log(JSON.stringify(geo, null, 1));
await app.close();
process.exit(0);
