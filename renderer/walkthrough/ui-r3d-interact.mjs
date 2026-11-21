// R3-D：交互级 UI——连点双提交 / 超长文本 / 空态 / 键盘焦点
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-r3d-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
const findings = [];
await page.goto(`${BASE}/register`);
await page.getByLabel('用户名', { exact: true }).fill('r3d' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(900);
const account = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: 'R3D号', platform: 'wechat_mp', content_format: 'long_article' }) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
// D1 连点 5 次"AI 选题建议"→ 应只发一次请求（loading 禁点）
await page.goto(`${BASE}/a/${account}`);
await page.waitForTimeout(1000);
let suggestReq = 0;
page.on('request', (rq) => { if (rq.url().includes('/topics/suggest') && rq.method() === 'POST') suggestReq++; });
const sugBtn = page.getByRole('button', { name: /AI 选题建议/ }).first();
if (await sugBtn.isVisible().catch(() => false)) {
  for (let i = 0; i < 5; i++) { try { await sugBtn.click({ timeout: 500 }); } catch { break; } }
  await page.waitForTimeout(2500);
  findings.push({ id: 'D1-suggest-rapid', reqs: suggestReq, ok: suggestReq <= 2 });
  console.log('D1 suggest rapid clicks:', suggestReq, suggestReq <= 2 ? 'OK' : 'DOUBLE-SUBMIT?');
} else { console.log('D1 skipped (button not visible)'); }
// D2 超长文本：素材 3 万字
await page.goto(`${BASE}/a/${account}/materials`);
await page.waitForTimeout(800);
const addBtn = page.getByRole('button', { name: /添加素材|新增素材/ }).first();
if (await addBtn.isVisible().catch(() => false)) {
  await addBtn.click();
  await page.waitForTimeout(500);
  const ta = page.locator('textarea').first();
  await ta.fill('M'.repeat(30000));
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  findings.push({ id: 'D2-material-30k-overflow', px: overflow, ok: overflow <= 2 });
  console.log('D2 30k material overflowX:', overflow);
} else console.log('D2 skipped');
// D3 空态：新账号作品列表空态文案
await page.goto(`${BASE}/a/${account}/works`);
await page.waitForTimeout(900);
const emptyText = await page.evaluate(() => document.body.textContent?.includes('还没有') || document.body.textContent?.includes('暂无') || document.body.textContent?.includes('第一篇'));
findings.push({ id: 'D3-works-empty-state', ok: !!emptyText });
console.log('D3 works empty-state text present:', !!emptyText);
// D4 键盘：命令面板 Ctrl+K 打开 + Escape 关闭
await page.keyboard.press('Control+KeyK');
await page.waitForTimeout(600);
const paletteOpen = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label*="命令"], [data-testid*="command-palette"], [cmdk-root]')));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const paletteClosed = await page.evaluate(() => !document.querySelector('[cmdk-root], [data-testid*="command-palette"][data-open="true"]'));
findings.push({ id: 'D4-palette-kbd', open: paletteOpen, closed: paletteClosed, ok: paletteOpen && paletteClosed });
console.log('D4 palette open:', paletteOpen, 'closed:', paletteClosed);
console.log('R3D SUMMARY:', JSON.stringify(findings, null, 1));
await app.close();
process.exit(0);
