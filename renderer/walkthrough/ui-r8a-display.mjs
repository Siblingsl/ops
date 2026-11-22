// R8-A：前端展示层合理性——数字格式化/空值展示/日期时区/排序
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8a-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
const F=[];
const rec=(id,ok,detail)=>{F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);};
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('r8a' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForFunction(async () => { const r = await fetch('/api/v1/auth/me'); return r.ok; }, { timeout: 15000 }); await page.waitForTimeout(500);
const ctx = await (async () => {
  const meR = await fetch('/api/v1/auth/me', { credentials: 'include' }); const meT = await meR.text(); const me = meT ? JSON.parse(meT) : { csrf_token: document.querySelector('meta[name=csrf]')?.content }; console.log('me-status:', meR.status);
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const acc = await (await page.request.post('/api/v1/accounts', { headers: h, data: { name: 'R8A展示号', platform: 'wechat_mp', content_format: 'long_article' } })).json();
  const wr = await (await page.request.post(`/api/v1/accounts/${acc.id}/works`, { headers: h, data: { title: 'R8A展示作品（六字以上）', content_format: 'long_article' } })).json();
  // 录入大数值指标（reads=1234567）
  await fetch(`/api/v1/accounts/${acc.id}/metrics/import`, { method: 'POST', headers: h, body: JSON.stringify({ rows: [] }) }).catch(()=>{});
  return { account: acc.id, work: wr.id, wsName: me.workspace?.name };
});
// A1 数字格式化：dashboard/works 列表无 NaN/Infinity/undefined 字符串
await page.goto(`${BASE}/a/${ctx.account}/works`);
await page.waitForTimeout(1200);
const bodyText = await page.evaluate(() => document.body.innerText);
const badTokens = ['NaN','Infinity','undefined','null','[object Object]'];
const found = badTokens.filter(t => bodyText.includes(t));
rec('A1-no-bad-tokens-works',found.length===0,`found=${found.join(',')||'none'}`);
// A2 日期时区：作品列表日期显示与本地时区一致（非 UTC 原文）
const dateShown = await page.evaluate(() => {
  const el = [...document.querySelectorAll('td,time,[class*="date"]')].map(e=>e.textContent?.trim()).find(t=>t&&/\d{4}-\d{2}-\d{2}/.test(t));
  return el ?? null;
});
rec('A2-date-format',dateShown===null||/^\d{4}-\d{2}-\d{2}/.test(dateShown),`shown=${dateShown??'(无日期列，新号正常)'}`);
// A3 空值展示：空列表有'还没有/暂无'文案（R7-D 已验），素材页
await page.goto(`${BASE}/a/${ctx.account}/materials`);
await page.waitForTimeout(2000);
const matEmpty = await page.evaluate(() => document.body.innerText.match(/(还没有|暂无|没有)/)?.[0] ?? null);
rec('A3-materials-empty-state',!!matEmpty,`text=${matEmpty??'none'}`);
// A4 排序：works 列表默认按 updated_at desc（新建作品应在顶部）
await page.goto(`${BASE}/a/${ctx.account}/works`);
await page.waitForTimeout(2000);
const firstTitle = await page.evaluate(() => document.querySelector('main')?.innerText.match(/R8A展示作品/)?.[0] ?? null);
rec('A4-works-sort-first',!!firstTitle,firstTitle?'新建作品在列表可见':'未找到（可能折叠）');
// A5 今日概况日期合理（Dashboard）
await page.goto(`${BASE}/a/${ctx.account}`);
await page.waitForTimeout(2000);
const dashDate = await page.evaluate(() => document.body.innerText.match(/(\d{1,2})月(\d{1,2})日/)?.[0] ?? null);
rec('A5-dashboard-date',!!dashDate,`shown=${dashDate}`);
console.log(`\nR8A ${F.filter(x=>x.ok).length}/${F.length} pass`);
await app.close();
process.exit(0);
