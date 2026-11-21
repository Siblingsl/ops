// radio 几何对照：在**页面滚到底**前后 dump radio rect + 容器 rect
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-cr2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.setViewportSize({ width: 1440, height: 1000 });
await native.goto(`${BASE}/register`);
await native.getByLabel('用户名', { exact: true }).fill('wt2q' + Date.now().toString(36));
await native.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await native.getByRole('button', { name: '创建账号', exact: true }).click();
await native.waitForTimeout(800);
const ctx = await native.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const acc = await (await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'radio2号', platform: 'wechat_mp', content_format: 'long_article' }) })).json();
  const w = await (await fetch(`/api/v1/accounts/${acc.id}/works`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Q04b作品', content_format: 'long_article', viewpoint: '低价比拼' }) })).json();
  await fetch(`/api/v1/works/${w.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '# 标题\n\n这个产品是全网最低价，绝对第一。\n\n## 第二节\n\n事实证明这样做有效果。' }) });
  const secs = (await (await fetch(`/api/v1/works/${w.id}`)).json()).sections ?? [];
  for (const s of secs) await fetch(`/api/v1/sections/${s.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '第一段记录可核对的事实与验证方式，确保结论可靠。', base_revision: s.revision }) });
  return { work: w.id };
});
await native.goto(`${BASE}/works/${ctx.work}/check`);
await native.waitForTimeout(1200);
await native.getByRole('button', { name: '开始检查', exact: true }).click();
await native.waitForTimeout(9000);
const geo = await native.evaluate(() => {
  const radio = document.querySelector('input[type="radio"]');
  const boxes = [...document.querySelectorAll('div')].filter((d) => typeof d.className === 'string' && d.className.includes('lg:sticky') && d.className.includes('overflow-y-auto'));
  const sticky = boxes[0];
  const rb = radio?.getBoundingClientRect();
  const sb = sticky?.getBoundingClientRect();
  return {
    vp: innerHeight,
    radio: rb ? { y: Math.round(rb.y), bottom: Math.round(rb.bottom), inVp: rb.y >= 0 && rb.bottom <= innerHeight } : null,
    sticky: sb ? { y: Math.round(sb.y), h: Math.round(sb.height), bottom: Math.round(sb.bottom), scroll: sticky.scrollTop, scrollH: sticky.scrollHeight } : null,
    pageScrollY: scrollY,
    docH: document.documentElement.scrollHeight,
  };
});
console.log('BEFORE-SCROLL', JSON.stringify(geo));
await native.evaluate(() => { const b = [...document.querySelectorAll('div')].find((d) => typeof d.className === 'string' && d.className.includes('lg:sticky')); b?.scrollIntoView({ block: 'center' }); });
await native.waitForTimeout(600);
const geo2 = await native.evaluate(() => {
  const radio = document.querySelector('input[type="radio"]');
  const boxes = [...document.querySelectorAll('div')].filter((d) => typeof d.className === 'string' && d.className.includes('lg:sticky') && d.className.includes('overflow-y-auto'));
  const sticky = boxes[0];
  const rb = radio?.getBoundingClientRect();
  const sb = sticky?.getBoundingClientRect();
  return {
    radio: rb ? { y: Math.round(rb.y), bottom: Math.round(rb.bottom), inVp: rb.y >= 0 && rb.bottom <= innerHeight } : null,
    sticky: sb ? { y: Math.round(sb.y), h: Math.round(sb.height), bottom: Math.round(sb.bottom) } : null,
    pageScrollY: scrollY,
  };
});
console.log('AFTER-STICKY-SCROLL', JSON.stringify(geo2));
await app.close();
process.exit(0);
