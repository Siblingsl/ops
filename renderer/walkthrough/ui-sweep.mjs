// 细查①：全路由 UI 实拍。真实 Electron 窗口逐页停留，采集：
// console 错误 / pageerror / 失败请求(>=400) / 水平溢出(body scrollWidth>clientWidth+2) /
// 空 h1 / 可见占位与空态、重复 testid、button 无可访问名
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5287';
const SHOT = 'F:/code/project/OPS/.playwright-results/wt-round2';
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-ui-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
const findings = [];
const consoleErrs = {}, pageErrs = {}, badReqs = {};

page.on('console', (m) => {
  if (m.type() === 'error') { const t = m.text().slice(0, 180); consoleErrs[t] = (consoleErrs[t] ?? 0) + 1; }
});
page.on('pageerror', (e) => { const t = String(e).slice(0, 180); pageErrs[t] = (pageErrs[t] ?? 0) + 1; });
page.on('response', (r) => {
  if (r.url().includes('/api/v1') && r.status() >= 400) {
    const key = `${r.status()} ${new URL(r.url()).pathname}`;
    badReqs[key] = (badReqs[key] ?? 0) + 1;
  }
});

// 注册 + 建号（探针路径）
await page.goto(`${BASE}/register`);
await page.getByLabel('用户名', { exact: true }).fill('wt2sweep' + Date.now());
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(1000);
await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: '细查号', platform: 'wechat_mp', content_format: 'long_article' }) });
});
const acc = (await page.evaluate(async () => await (await fetch('/api/v1/accounts')).json()))[0];
// 关掉注册向导类弹窗
for (const label of ['我知道了', '知道了', '开始使用', '稍后再说', '跳过']) {
  const btn = page.getByRole('button', { name: label, exact: true });
  if (await btn.count() > 0) { try { await btn.first().click({ timeout: 1500 }); } catch {} }
}
await page.goto(`${BASE}/a/${acc.id}`);
await page.waitForTimeout(1200);

const routes = [
  `/a/${acc.id}`, `/a/${acc.id}/topics`, `/a/${acc.id}/calendar`, `/a/${acc.id}/works`,
  `/a/${acc.id}/materials`, `/a/${acc.id}/review`, `/a/${acc.id}/profile`, `/images`,
  '/agent', '/settings/accounts', '/settings/models', '/settings/preferences', '/settings/words',
  '/settings/export', '/settings/logs', '/settings/trash', '/settings/security', '/settings/usage',
  '/settings/skills', '/settings/members', '/settings/admin', '/settings/job-runs', '/settings/plugins',
  '/settings/prompts', '/settings/quality', '/settings/daily', '/settings/crawl', '/settings/capabilities',
  '/settings/feishu', '/settings/agent', '/settings/desktop-panels', '/settings/desktop-policy',
  '/settings/parser-diagnostics', '/settings/personal-memory', '/settings/personal-memories',
];
for (const path of routes) {
  const errsBefore = Object.keys(consoleErrs).length + Object.keys(pageErrs).length;
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    findings.push({ path, issue: 'GOTO_FAIL', detail: String(e).slice(0, 120) });
    continue;
  }
  await page.waitForTimeout(1600);
  const audit = await page.evaluate(() => {
    const out = {};
    out.path = location.pathname;
    out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    out.h1 = document.querySelector('h1')?.textContent?.trim().slice(0, 30) ?? null;
    // 重复 testid
    const ids = [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    const dup = {};
    for (const id of ids) if (id) dup[id] = (dup[id] ?? 0) + 1;
    out.dupTestids = Object.entries(dup).filter(([, n]) => n > 3).map(([id, n]) => `${id}x${n}`).slice(0, 5);
    // 无名按钮
    out.unnamedButtons = [...document.querySelectorAll('button')].filter((b) => {
      if (b.disabled) return false;
      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      return !name;
    }).length;
    // 可见错误横幅
    out.alerts = [...document.querySelectorAll('[role="alert"], .text-danger')].map((e) => e.textContent?.trim().slice(0, 60)).filter(Boolean).slice(0, 3);
    return out;
  }).catch((e) => ({ path, evalFail: String(e).slice(0, 100) }));
  const newErrs = Object.keys(consoleErrs).length + Object.keys(pageErrs).length - errsBefore;
  if (newErrs > 0) findings.push({ path, issue: 'CONSOLE_ERRS', count: newErrs });
  if (audit.overflowX > 2) findings.push({ path, issue: 'H_OVERFLOW', px: audit.overflowX });
  if (audit.dupTestids?.length) findings.push({ path, issue: 'DUP_TESTIDS', detail: audit.dupTestids.join(',') });
  if (audit.unnamedButtons > 0) findings.push({ path, issue: 'UNNAMED_BUTTONS', count: audit.unnamedButtons });
  if (audit.alerts?.length) findings.push({ path, issue: 'ALERTS', detail: audit.alerts.join(' | ') });
  const shot = `${SHOT}/ui-${path.replaceAll('/', '_').slice(0, 60)}.png`;
  try { await page.screenshot({ path: shot, fullPage: false }); } catch {}
}
// 汇总
const summary = { findings, consoleErrs, pageErrs, badReqs };
writeFileSync(`${SHOT}/ui-sweep-summary.json`, JSON.stringify(summary, null, 1));
console.log('FINDINGS:', findings.length);
for (const f of findings) console.log(' -', JSON.stringify(f));
console.log('CONSOLE_ERRS_TOP:', Object.entries(consoleErrs).sort((a, b) => b[1] - a[1]).slice(0, 6));
console.log('BAD_REQS:', Object.entries(badReqs).slice(0, 8));
await app.close();
process.exit(0);
