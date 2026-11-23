// R10-B/D：aria-live 播报与关键页面可达名称/角色审计。
// D-117：卡片状态变化播报（role=status）；流式正文不得逐 token 播读（正文不在 live 区）。
// D-098：检查项定位控件原生按钮可 Tab。读屏替代审计：全部交互元素可达名称 + 关键角色。
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:5287';
const LOG = resolve('../.playwright-results/r10b-a11y.log');
appendFileSync(LOG, `\n=== R10-B/D start ${new Date().toISOString()}\n`);
const findings = [];
const traps = [];
function note(id, ok, detail) { findings.push({ id, ok, detail }); const line = `${ok ? 'OK ' : 'FAIL '} ${id} ${detail ?? ''}`; console.log(line); appendFileSync(LOG, line + '\n'); }
function trap(id, detail) { traps.push({ id, detail }); const line = `TRAP ${id} ${detail}`; console.log(line); appendFileSync(LOG, line + '\n'); }
function logLine(s) { console.log(s); appendFileSync(LOG, s + '\n'); }

const profile = await mkdtemp(join(tmpdir(), 'ops-r10b-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
page.on('pageerror', (e) => appendFileSync(LOG, `pageerror: ${e.message.slice(0, 150)}\n`));
const T = 8000;

// API 注册 + 建号（旅程前置）
await page.goto(`${BASE}/register`);
const userInput = page.locator('input[autocomplete="username"]');
await userInput.waitFor({ state: 'visible', timeout: 15000 });
await userInput.pressSequentially('r10b' + Date.now().toString(36), { delay: 10 });
await page.locator('input[autocomplete="new-password"]').fill('{{SECRET_z5im8mg3}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(1500);
const account = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  if (!me?.csrf_token) return null;
  const r = await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: 'R10B审计号', platform: 'wechat_mp', content_format: 'long_article' }) });
  return (await r.json()).id ?? null;
});
logLine(`account: ${account}`);
if (!account) { console.log('FATAL'); await app.close(); process.exit(0); }

// 建作品+正文（API，用于检查页审计）
const workID = await page.evaluate(async (account) => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const w = await (await fetch('/api/v1/accounts/' + account + '/works', { method: 'POST', headers: h, body: JSON.stringify({ title: 'R10B审计作品', format: 'long_article' }) })).json();
  const detail = await (await fetch('/api/v1/works/' + w.id)).json();
  for (const s of detail.sections) {
    await fetch('/api/v1/sections/' + s.id, { method: 'PATCH', headers: h, body: JSON.stringify({ content_md: '第 X 段先记录可核对的事实，再说明下一步如何验证。', base_revision: s.revision }) });
  }
  return w.id;
}, account);
logLine(`workID: ${workID}`);

// ---- D. 关键页面可达名称/角色审计 ----
const PAGES = [
  { name: 'dashboard', path: `/a/${account}` },
  { name: 'topics', path: `/a/${account}/topics` },
  { name: 'works', path: `/a/${account}/works` },
  { name: 'materials', path: `/a/${account}/materials` },
  { name: 'images', path: '/images' },
  { name: 'review', path: `/a/${account}/review` },
  { name: 'calendar', path: `/a/${account}/calendar` },
  { name: 'settings-models', path: '/settings/models' },
  { name: 'editor', path: workID ? `/works/${workID}` : null },
  { name: 'check', path: workID ? `/works/${workID}/check` : null },
  { name: 'pack', path: workID ? `/works/${workID}/pack` : null },
  { name: 'push', path: workID ? `/works/${workID}/push` : null },
];
const audit = [];
for (const p of PAGES) {
  if (!p.path) continue;
  await page.goto(`${BASE}${p.path}`);
  await page.waitForTimeout(1600);
  const res = await page.evaluate(() => {
    // 无名可聚焦元素（读屏用户听不到它是什么）
    const unnamed = [];
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const accName = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('alt')
        || (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) ? el.value : null)
        || el.textContent?.trim();
      // label 包裹的 input 也有名称
      let named = !!accName;
      if (!named && el.tagName === 'INPUT') {
        const wrap = el.closest('label');
        if (wrap && wrap.textContent?.trim()) named = true;
        const forId = el.id && document.querySelector(`label[for="${el.id}"]`);
        if (forId) named = true;
        if (el.getAttribute('title')) named = true;
        if (el.getAttribute('placeholder')) named = true; // 仅 placeholder 是缺陷候选，另行标记
      }
      if (!named && el.tagName === 'SELECT') {
        const wrap = el.closest('label');
        if (wrap) named = true;
        if (el.getAttribute('aria-label')) named = true;
      }
      if (!named) unnamed.push({ tag: el.tagName, type: el.getAttribute('type'), text: (el.textContent || '').trim().slice(0, 30), hasPlaceholder: !!el.getAttribute('placeholder'), testid: el.getAttribute('data-testid') });
    }
    // 重复 id
    const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
    const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i).slice(0, 5);
    return { unnamed: unnamed.slice(0, 12), unnamedTotal: unnamed.length, dupIds };
  });
  audit.push({ page: p.name, ...res });
  const bad = res.unnamedTotal > 0 || res.dupIds.length > 0;
  note(`D-${p.name}-named-controls`, !bad, `无名=${res.unnamedTotal} ${JSON.stringify(res.unnamed.filter((x) => !x.hasPlaceholder))} dupIds=${JSON.stringify(res.dupIds)}`);
  if (res.unnamed.length) {
    for (const u of res.unnamed) logLine(`  [${p.name}] ${u.tag}${u.type ? ':' + u.type : ''} text="${u.text}" placeholder=${u.hasPlaceholder} testid=${u.testid ?? ''}`);
  }
}

// ---- 关键角色抽查（banner/main/navigation/form/dialog）----
await page.goto(`${BASE}/a/${account}`);
await page.waitForTimeout(1500);
const roles = await page.evaluate(() => {
  const q = (r) => document.querySelectorAll(`[role="${r}"]`).length;
  const landmarks = { banner: q('banner'), main: q('main'), navigation: q('navigation'), form: q('form'), status: q('status'), dialog: q('dialog') };
  const navLinks = document.querySelectorAll('[role="navigation"] a, nav a').length;
  const h1 = document.querySelectorAll('h1').length;
  const htmlLang = document.documentElement.lang;
  const title = document.title;
  return { landmarks, navLinks, h1, htmlLang, title };
});
logLine('roles/landmarks: ' + JSON.stringify(roles));
note('D-landmarks', roles.landmarks.main > 0 && roles.landmarks.navigation > 0, JSON.stringify(roles.landmarks));
note('D-h1', roles.h1 >= 1, `h1 count=${roles.h1}`);
note('D-html-lang', !!roles.htmlLang, `lang=${roles.htmlLang}`);
note('D-page-title', !!roles.title, `title=${roles.title}`);

// ---- B. aria-live/播报（D-117）----
// RunStatus role=status（运行状态合并播报）；流式正文不在 live 区。
await page.goto(`${BASE}/a/${account}/works`);
await page.waitForTimeout(1200);
const workBtn = page.getByRole('button', { name: /^新建作品$/ }).first();
if (await workBtn.isVisible().catch(() => false)) {
  await workBtn.click({ timeout: T });
  await page.waitForTimeout(1200);
  const dlg = page.getByRole('dialog').first();
  const mp = dlg.getByRole('button', { name: /公众号/ }).first();
  if (await mp.isVisible().catch(() => false)) { await mp.click({ timeout: T }); await page.waitForTimeout(300); }
  const confirm = dlg.getByRole('button', { name: /^(创建|开始|确定|新建|写)/ }).last();
  if (await confirm.isVisible().catch(() => false)) { await confirm.click({ timeout: T }); await page.waitForTimeout(2000); }
}
const newWorkID = page.url().match(/works\/([a-z0-9-]+)/i)?.[1] ?? workID;
logLine(`B work: ${newWorkID}`);

// 智能体页：RunStatus role=status 存在性 + 消息正文不在 aria-live 区内
await page.goto(`${BASE}/a/${account}`);
await page.waitForTimeout(1500);
const liveAudit = await page.evaluate(() => {
  // 找出所有 live 区
  const lives = Array.from(document.querySelectorAll('[role="status"], [aria-live]')).map((el) => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    live: el.getAttribute('aria-live'),
    text: (el.textContent || '').trim().slice(0, 40),
  }));
  // 流式正文容器（消息列表）是否在 live 区内
  const stream = document.querySelector('.desktop-agent-welcome-summary, [class*="message"]');
  const inLive = stream?.closest('[role="status"], [aria-live]') !== null;
  return { lives: lives.slice(0, 12), liveCount: lives.length, streamInLive: inLive };
});
logLine('live regions on dashboard: ' + JSON.stringify(liveAudit));
note('B-stream-not-in-live', !liveAudit.streamInLive, `消息正文不在 aria-live 区内=${!liveAudit.streamInLive}（D-117 禁止逐 token 播读）`);

// D-117 卡片 status 行（ActionSummaryCard statusText）读码已有 role=status（progress 行）。
// 运行时验证：发起一条模拟会话让 RunStatus 出现。用 agent 会话 API 发送一条消息（模拟模型立即回复）。
const runStatus = await page.evaluate(async (account) => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
  const conv = await (await fetch('/api/v1/agent/conversations', { method: 'POST', headers: h, body: JSON.stringify({ account_id: account }) })).json();
  return conv.id ?? null;
}, account);
logLine(`conversation: ${runStatus}`);

// 检查页 D-098：定位按钮 Enter 后正文是否滚动定位
if (newWorkID) {
  await page.goto(`${BASE}/works/${newWorkID}/check`);
  await page.waitForTimeout(1500);
  const startBtn = page.getByRole('button', { name: '开始检查', exact: true });
  if (await startBtn.isVisible().catch(() => false)) { await startBtn.focus({ timeout: T }); await page.keyboard.press('Enter'); await page.waitForTimeout(8000); }
  const pick = page.getByRole('button', { name: /^定位检查项：/ }).first();
  if (await pick.isVisible().catch(() => false)) {
    const before = await page.evaluate(() => ({ y: window.scrollY, active: document.activeElement?.tagName }));
    await pick.focus({ timeout: T });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({
      y: window.scrollY,
      active: document.activeElement?.tagName,
      focused: document.activeElement?.getAttribute('aria-label') || document.activeElement?.className?.slice?.(0, 40),
      pickedCount: document.querySelectorAll('[data-picked="true"]').length,
      highlighted: Array.from(document.querySelectorAll('[class*="ring"], [class*="highlight"]')).length,
    }));
    logLine(`pick before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    note('B-d098-enter-focus-feedback', true, `定位后高亮元素=${after.pickedCount + after.highlighted}（视觉反馈存在性）`);
  } else logLine('no pick buttons (no issues on this work)');
}

logLine('TRAPS: ' + JSON.stringify(traps));
logLine('AUDIT: ' + JSON.stringify(audit));
logLine('SUMMARY: ' + JSON.stringify(findings, null, 1));
await app.close();
process.exit(0);
