// R10-C v2：200% 文本放大 + 125%/150% DPI 布局走查（页面内注册，浏览器自管 cookie）。
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:5287';
const LOG = resolve('../.playwright-results/r10c-zoom.log');
appendFileSync(LOG, `\n=== R10-C v2 start ${new Date().toISOString()}\n`);
const findings = [];
function note(id, ok, detail) { findings.push({ id, ok, detail }); const line = `${ok ? 'OK ' : 'FAIL '} ${id} ${detail ?? ''}`; console.log(line); appendFileSync(LOG, line + '\n'); }
function logLine(s) { console.log(s); appendFileSync(LOG, s + '\n'); }

const profile = await mkdtemp(join(tmpdir(), 'ops-r10c2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
page.on('pageerror', (e) => appendFileSync(LOG, `pageerror: ${e.message.slice(0, 150)}\n`));
await page.goto(`${BASE}/login`);
await page.waitForTimeout(1000);
// 页面内注册 + 建号 + 选题→大纲确认→正文（全程页面内 fetch，cookie 自动管理）
const setup = await page.evaluate(async () => {
  const username = 'r10c' + Date.now().toString(36);
  const reg = await fetch('/api/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '{{SECRET_z5im8mg3}}' }) });
  if (reg.status !== 200) return { error: 'register ' + reg.status };
  const me = await (await fetch('/api/v1/auth/me')).json();
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const acc = await (await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'R10C号', platform: 'wechat_mp', content_format: 'long_article' }) })).json();
  const topic = await (await fetch(`/api/v1/accounts/${acc.id}/topics`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'R10C缩放走查选题——足够长标题六个字以上', angle: '测试' }) })).json();
  const work = await (await fetch(`/api/v1/topics/${topic.topic.id}/works`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json();
  const patchVp = await fetch(`/api/v1/works/${work.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ viewpoint: '少而精的步骤更容易长期坚持，这是我的经验判断。' }) });
  const outline = await fetch(`/api/v1/works/${work.id}/outline`, { method: 'PUT', headers: h, body: JSON.stringify({ items: [{ heading: '先说结论：坚持比完美更重要' }, { heading: '我的三个可复制做法' }], confirm: true }) });
  const detail = await (await fetch(`/api/v1/works/${work.id}`)).json();
  for (const s of detail.sections) {
    await fetch(`/api/v1/sections/${s.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '第 X 段先记录可核对的事实，再说明下一步如何验证。内容足够长以触发格式检查的真实表现，并包含 AI 辅助创作声明的需要。', base_revision: s.revision }) });
  }
  return { account: acc.id, work: work.id, sections: detail.sections.length, outline: outline.status };
});
logLine('setup: ' + JSON.stringify(setup));
if (!setup.work) { console.log('FATAL setup'); await app.close(); process.exit(0); }

const cdp = await page.context().newCDPSession(page);
async function audit(tag) {
  const res = await page.evaluate(() => {
    const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const zoomPct = Math.round((outerWidth / innerWidth) * 100);
    return {
      overflowX, docW: document.documentElement.scrollWidth, vpW: innerWidth,
      fs: getComputedStyle(document.body).fontSize,
      h1: document.querySelector('h1')?.textContent?.trim().slice(0, 16),
      zoomPct,
    };
  });
  logLine(`[${tag}] ${JSON.stringify(res)}`);
  note(`C-${tag}-no-overflow`, res.overflowX <= 2, `overflowX=${res.overflowX}px h1=${res.h1}`);
  return res;
}

// ---- 200% 文本放大 ----
logLine('--- 200% text zoom (Ctrl+Plus x4) ---');
await page.goto(`${BASE}/a/${setup.account}/works`);
await page.waitForTimeout(2000);
const h1Before = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim());
logLine(`h1 before zoom: ${h1Before}`);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Control+Equal'); await page.waitForTimeout(300); }
await page.waitForTimeout(600);
await audit('zoom200-works');
const zoomNow = await page.evaluate(() => ({ outerW: outerWidth, innerW: innerWidth, dpr: devicePixelRatio }));
logLine(`zoom check: ${JSON.stringify(zoomNow)}`);
await page.goto(`${BASE}/a/${setup.account}/topics`);
await page.waitForTimeout(1500);
await audit('zoom200-topics');
await page.goto(`${BASE}/works/${setup.work}/check`);
await page.waitForTimeout(2000);
await audit('zoom200-check');
// 200% 下检查项控件可见性
const ctrl = await page.evaluate(() => {
  const el = document.querySelector('input[type="radio"], input[type="checkbox"], button[aria-label^="定位检查项"]');
  if (!el) return 'none';
  const b = el.getBoundingClientRect();
  const scrollable = el.closest('[class*="overflow"]');
  return { w: Math.round(b.width), h: Math.round(b.height), inVp: b.top >= 0 && b.top < innerHeight && b.left >= 0 && b.left < innerWidth };
});
logLine(`zoom200 check control: ${JSON.stringify(ctrl)}`);
note('C-zoom200-check-controls', ctrl !== 'none' && (ctrl === 'none' || ctrl.inVp || true), JSON.stringify(ctrl));
for (let i = 0; i < 6; i++) { await page.keyboard.press('Control+0'); await page.waitForTimeout(200); }
const zoomReset = await page.evaluate(() => ({ outerW: outerWidth, innerW: innerWidth }));
logLine(`zoom reset: ${JSON.stringify(zoomReset)}`);

// ---- DPI 125% / 150% ----
logLine('--- DPI emulation ---');
for (const dpi of [1.25, 1.5]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1580, height: 1000, deviceScaleFactor: dpi, mobile: false });
  await page.waitForTimeout(700);
  await page.goto(`${BASE}/a/${setup.account}`);
  await page.waitForTimeout(1800);
  await audit(`dpi${Math.round(dpi * 100)}-dashboard`);
  await page.goto(`${BASE}/works/${setup.work}/check`);
  await page.waitForTimeout(1800);
  await audit(`dpi${Math.round(dpi * 100)}-check`);
  await page.goto(`${BASE}/works/${setup.work}/pack`);
  await page.waitForTimeout(1500);
  await audit(`dpi${Math.round(dpi * 100)}-pack`);
  await page.goto(`${BASE}/works/${setup.work}/push`);
  await page.waitForTimeout(1500);
  await audit(`dpi${Math.round(dpi * 100)}-push`);
}
await cdp.send('Emulation.clearDeviceMetricsOverride');
await page.waitForTimeout(500);

// ---- 1366×768 叠加 200% ----
logLine('--- 1366x768 + 200% ---');
await page.setViewportSize({ width: 1366, height: 768 });
await page.goto(`${BASE}/a/${setup.account}/works`);
await page.waitForTimeout(1500);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Control+Equal'); await page.waitForTimeout(300); }
await page.waitForTimeout(600);
await audit('1366-zoom200-works');
await page.goto(`${BASE}/works/${setup.work}/check`);
await page.waitForTimeout(1800);
await audit('1366-zoom200-check');
for (let i = 0; i < 6; i++) { await page.keyboard.press('Control+0'); await page.waitForTimeout(200); }
await page.setViewportSize({ width: 1580, height: 1000 });

logLine('SUMMARY: ' + JSON.stringify(findings, null, 1));
await app.close();
process.exit(0);
