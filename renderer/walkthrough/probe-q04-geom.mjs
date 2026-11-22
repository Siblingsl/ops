// Q-04 geometry probe rebuilt (short-content sticky fix verification)
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-q04fix-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.setViewportSize({ width: 1440, height: 1000 });
await native.goto(BASE + '/register');
await native.getByLabel('用户名', { exact: true }).fill('q04fix' + Date.now().toString(36));
await native.getByLabel('密码（至少 12 位）').fill('Passw0rdQ04fix!');
await native.getByRole('button', { name: '创建账号', exact: true }).click();
await native.waitForTimeout(1200);
const setup = await native.evaluate(async () => {
  const t = async (r) => { const x = await r.text(); return x ? JSON.parse(x) : {}; };
  const me = await t(await fetch('/api/v1/auth/me'));
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const acc = await t(await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Q04fix号', platform: 'wechat_mp', content_format: 'long_article' }) }));
  const wr = await t(await fetch(`/api/v1/accounts/${acc.id}/works`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Q04布局修复作品（六字以上）', viewpoint: '布局修复走查观点', content_format: 'long_article' }) }));
  const NL2 = String.fromCharCode(92) + 'n';
  const CM = '# Q04修复' + NL2 + NL2 + '第一节事实与验证。' + NL2 + NL2 + '## 第二节' + NL2 + NL2 + '第二节。';
  await fetch(`/api/v1/works/${wr.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: CM }) });
  await fetch(`/api/v1/works/${wr.id}/outline`, { method: 'PUT', headers: h, body: JSON.stringify({ items: [{ heading: '一', summary: 's1' }, { heading: '二', summary: 's2' }], confirm: true }) });
  await new Promise(r => setTimeout(r, 800));
  const w = await t(await fetch(`/api/v1/works/${wr.id}`));
  for (const s of (w.sections ?? [])) await fetch(`/api/v1/sections/${s.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。', base_revision: s.revision }) });
  await fetch(`/api/v1/works/${wr.id}/checks`, { method: 'POST', headers: h, body: '{}' });
  return { work: wr.id };
});
const W = setup.work;
await native.goto(`${BASE}/works/${W}/check`);
await native.waitForTimeout(2500);
const geo = await native.evaluate(() => {
  const sticky = [...document.querySelectorAll('div')].find((d) => typeof d.className === 'string' && d.className.includes('lg:sticky') && d.className.includes('overflow-y-auto'));
  const radio = document.querySelector('input[type="radio"]');
  const sb = sticky?.getBoundingClientRect();
  const rb = radio?.getBoundingClientRect();
  return { vp: innerHeight, sticky: sb ? { y: Math.round(sb.y), h: Math.round(sb.height), bottom: Math.round(sb.bottom) } : null, radio: rb ? { y: Math.round(rb.y), inVp: rb.y >= 0 && rb.bottom <= innerHeight } : 'no-radio-yet' };
});
console.log('GEOMETRY-AFTER-FIX:', JSON.stringify(geo));
await app.close();
process.exit(0);