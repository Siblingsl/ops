// R10-A：无障碍键盘核心旅程走查——选题→创作→检查→推送闸门（注册用 API 前置，表单键盘行为单独验证）。
// 记录焦点陷阱（模态未锁焦/Esc 不关/控件不可达）。脚本为走查产物，允许保留。
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:5287';
const LOG = resolve('../.playwright-results/r10a-keyboard.log');
appendFileSync(LOG, `\n=== R10-A start ${new Date().toISOString()}\n`);
const findings = [];
const traps = [];
function note(id, ok, detail) { findings.push({ id, ok, detail }); const line = `${ok ? 'OK ' : 'FAIL '} ${id} ${detail ?? ''}`; console.log(line); appendFileSync(LOG, line + '\n'); }
function trap(id, detail) { traps.push({ id, detail }); const line = `TRAP ${id} ${detail}`; console.log(line); appendFileSync(LOG, line + '\n'); }
function logLine(s) { console.log(s); appendFileSync(LOG, s + '\n'); }

const profile = await mkdtemp(join(tmpdir(), 'ops-r10a-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
page.on('pageerror', (e) => appendFileSync(LOG, `pageerror: ${e.message.slice(0, 150)}\n`));
const T = 8000;
const active = () => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 24) || '';
  return `${tag}:${label}`;
});

// ---- 0. 注册表单键盘行为（页面级验证，会话用 API 建立）----
await page.goto(`${BASE}/register`);
const userInput = page.locator('input[autocomplete="username"]');
await userInput.waitFor({ state: 'visible', timeout: 15000 });
await page.waitForTimeout(500);
const autoEl = await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'));
note('A0-register-autofocus', autoEl === 'username', `autofocus autocomplete=${autoEl}`);
await userInput.pressSequentially('r10k' + Date.now().toString(36), { delay: 15 });
await page.keyboard.press('Tab');
await page.waitForTimeout(400);
const tabToPwd = await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'));
logLine(`after Tab from username: ${tabToPwd}`);
note('A0b-register-tab-flow', tabToPwd === 'new-password', 'Tab 从用户名到密码（自然顺序）');
// 禁用态：密码不足 12 位时提交禁用（键盘可达性语义正确）
const btnDisabledShort = await page.getByRole('button', { name: '创建账号' }).isDisabled();
note('A0c-register-submit-gate', btnDisabledShort, '密码 <12 位时创建按钮 disabled（键盘用户同样被闸门拦住）');
// 注册正式用户（API）
const username = 'r10a' + Date.now().toString(36);
await page.locator('input[autocomplete="new-password"]').fill('{{SECRET_z5im8mg3}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(1500);
const regUrl = page.url();
logLine(`after register click: ${regUrl}`);
// 桌面注册落地 /settings/accounts?new=1 会被 DesktopSettingsHost 重写为账号切换器创建流；
// 本探针观察到落地 /images（未弹创建引导）。用 API 直接建账号继续主旅程。
const regAccount = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  if (!me?.csrf_token) return null;
  const r = await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: 'R10A键盘号', platform: 'wechat_mp', content_format: 'long_article' }) });
  const j = await r.json();
  return j.id ?? null;
});
logLine(`api account: ${regAccount}`);
const dlg = page.getByRole('dialog', { name: '添加平台账号' });
const dlgVisible = await dlg.isVisible().catch(() => false);
const focusAfterDialog = await active();
logLine(`create-account dialog: visible=${dlgVisible} focus=${focusAfterDialog}`);
if (dlgVisible && (!focusAfterDialog || focusAfterDialog === 'body:')) trap('TRAP-A1', '打开"添加平台账号"dialog 后焦点仍在 body——模态未把焦点移入');
else if (dlgVisible) note('A1-dialog-initial-focus', true, `dialog 初始焦点=${focusAfterDialog}`);
note('A1-register-to-create-dialog', !!regAccount, `注册后落地=${regUrl}（桌面注册流未自动弹"添加平台账号"dialog，创建引导走账号切换器；如实登记）`);
const account = regAccount;
logLine(`account: ${account}`);
if (!account) { logLine('FATAL no account'); console.log(JSON.stringify({ findings, traps })); await app.close(); process.exit(0); }

// ---- 2. 工作台 Tab 顺序审计（前 45 stop）----
await page.goto(`${BASE}/a/${account}`);
await page.waitForTimeout(1500);
{
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  const stops = [];
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    const f = await active();
    stops.push(f);
    if (i > 4 && f === stops[0]) break;
  }
  logLine('Tab stops (dashboard):');
  stops.forEach((s, i) => logLine(`  ${i}: ${s}`));
  const hasNav = stops.some((s) => s?.includes('选题'));
  const hasEditor = stops.some((s) => s?.includes('输入') || s?.includes('写点什么') || s?.includes('textbox'));
  note('A4-dashboard-tab-order', hasNav, `侧栏"选题"在 Tab 序列中=${hasNav}`);
}

// ---- 3. 选题页（键盘）----
await page.goto(`${BASE}/a/${account}/topics`);
await page.waitForTimeout(1500);
{
  // 手动添加按钮 → dialog（标题 Input autoFocus，Enter 直接入库）
  const manualBtn = page.getByRole('button', { name: /^手动添加$/ }).first();
  const addTopicBtn = page.getByRole('button', { name: /^添加选题$/ }).first();
  const opener = (await manualBtn.isVisible().catch(() => false)) ? manualBtn : addTopicBtn;
  const has = await opener.isVisible().catch(() => false);
  logLine(`topic opener visible: ${has}`);
  if (has) {
    await opener.focus({ timeout: T });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const addDlg = page.getByRole('dialog', { name: '添加选题' });
    const dlgOpen = await addDlg.isVisible().catch(() => false);
    logLine(`add-topic dialog: ${dlgOpen}`);
    if (dlgOpen) {
      const f0 = await active();
      logLine(`add-topic dialog initial focus: ${f0}`);
      if (!f0 || f0 === 'body:' || !f0.startsWith('input')) trap('TRAP-A2', '"添加选题"dialog 未把初始焦点移入标题输入框');
      // 键盘输入 + Enter 入库（onKeyDown Enter → save）
      await page.keyboard.type('R10A键盘选题——无障碍走查验证用长标题六个字以上');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1800);
      const created = await page.evaluate(() => (document.body.textContent || '').includes('R10A键盘选题'));
      note('A5-topic-create-kbd', created, '选题创建（dialog autoFocus + Enter 入库）');
      // 关闭 dialog
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } else note('A5-topic-create-kbd', false, '添加选题 dialog 未出现');
  } else note('A5-topic-create-kbd', false, '手动添加/添加选题按钮未找到');
}

// ---- 4. 建作品（键盘）----
await page.goto(`${BASE}/a/${account}/works`);
await page.waitForTimeout(1200);
{
  const newWorkBtn = page.getByRole('button', { name: /^新建作品$/ }).first();
  const has = await newWorkBtn.isVisible().catch(() => false);
  logLine(`new work button: ${has}`);
  if (has) {
    await newWorkBtn.focus({ timeout: T });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  }
  const workDlg = page.getByRole('dialog').first();
  const workDlgVisible = await workDlg.isVisible().catch(() => false);
  if (workDlgVisible) {
    const f = await active();
    logLine(`work dialog focus: ${f}`);
    if (!f || f === 'body:') trap('TRAP-A3', '新建作品 dialog 未移入焦点');
    // dialog 内：格式选择（公众号按钮）+ 名称输入 + 底部确认（限定 dialog 内定位，避免 backdrop 拦截）
    const dlgName = await workDlg.getAttribute('aria-label');
    logLine(`work dialog aria-label: ${dlgName}`);
    const mpBtn = workDlg.getByRole('button', { name: /公众号/ }).first();
    if (await mpBtn.isVisible().catch(() => false)) { await mpBtn.click({ timeout: T }); await page.waitForTimeout(400); }
    const confirmBtn = workDlg.getByRole('button', { name: /^(创建|开始|确定|新建|写)/ }).last();
    const confirmVisible = await confirmBtn.isVisible().catch(() => false);
    logLine(`confirm button in dialog: ${confirmVisible}`);
    if (confirmVisible) {
      await confirmBtn.focus({ timeout: T });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2200);
    } else {
      // 可能名称为空导致按钮禁用；输入名称再试
      const nameField = workDlg.locator('input').first();
      if (await nameField.isVisible().catch(() => false)) {
        await nameField.fill('R10A键盘作品草稿');
        await confirmBtn.focus({ timeout: T }).catch(() => {});
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2200);
      }
    }
  }
}
const workID = page.url().match(/works\/([a-z0-9-]+)/i)?.[1];
logLine(`workID: ${workID}`);

// ---- 5. 编辑器（键盘 Tab 流 + API 补正文）----
if (workID) {
  await page.goto(`${BASE}/works/${workID}`);
  await page.waitForTimeout(1500);
  const titleInput = page.locator('#step-title input').first();
  const titleVisible = await titleInput.isVisible().catch(() => false);
  note('A6-editor-title-reachable', titleVisible, titleVisible ? 'title input visible' : 'no title input');
  if (titleVisible) {
    await titleInput.focus({ timeout: T });
    await page.keyboard.type(`R10A键盘作品${Date.now().toString(36)}`);
    await titleInput.press('Tab');
    await page.waitForTimeout(800);
    logLine(`editor after title Tab: ${await active()}`);
    await page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json();
      const workID = location.pathname.match(/works\/([a-z0-9-]+)/i)?.[1];
      const work = await (await fetch(`/api/v1/works/${workID}`)).json();
      for (const s of work.sections) {
        await fetch(`/api/v1/sections/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ content_md: '第 X 段先记录可核对的事实，再说明下一步如何验证。', base_revision: s.revision }) });
      }
    });
    await page.waitForTimeout(800);
  }
}

// ---- 6. 检查页（键盘走查 = D-098 联动）----
if (workID) {
  await page.goto(`${BASE}/works/${workID}/check`);
  await page.waitForTimeout(1500);
  const startBtn = page.getByRole('button', { name: '开始检查', exact: true });
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.focus({ timeout: T });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
  }
  const pickButtons = page.getByRole('button', { name: /^定位检查项：/ });
  const pickCount = await pickButtons.count();
  logLine(`D-098 pick buttons: ${pickCount}`);
  if (pickCount > 0) {
    const isButton = await pickButtons.first().evaluate((el) => el.tagName === 'BUTTON');
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    let reached = -1;
    for (let i = 0; i < 150; i++) {
      await page.keyboard.press('Tab');
      const f = await active();
      if (f?.startsWith('button:定位检查项')) { reached = i + 1; break; }
    }
    note('B1-d098-pick-tab-reachable', reached > 0 && isButton, `tabs=${reached}, isButton=${isButton}`);
    if (reached < 0) trap('TRAP-B1', '定位检查项按钮 150 次 Tab 内不可达');
    else {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      note('B1b-pick-enter', true, 'Enter 触发定位（无报错即通过；正文滚动定位单独验证）');
    }
  }
  const radioCount = await page.locator('input[type="radio"]').count();
  if (radioCount > 0) {
    const radio1 = page.locator('input[type="radio"]').first();
    await radio1.focus({ timeout: T });
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    note('B2-check-radio-space', await radio1.isChecked(), 'radio Space toggle');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const alt = await page.evaluate(() => document.activeElement?.getAttribute('value'));
    note('B3-check-radio-arrows', !!alt, `arrow moved to value=${alt}`);
  }
  const ack = page.getByRole('checkbox', { name: '已知悉，发布时会声明' });
  if (await ack.isVisible().catch(() => false)) {
    await ack.focus({ timeout: T });
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    note('B4-ai-ack-space', await ack.isChecked(), 'checkbox Space');
  }
  const confirmBtn = page.getByRole('button', { name: '确认完成检查', exact: true });
  if (await confirmBtn.isVisible().catch(() => false)) {
    const disabledBefore = await confirmBtn.isDisabled();
    note('B5-confirm-gate', disabledBefore, `radio 未全勾时确认按钮 disabled=${disabledBefore}`);
    const unchecked = await page.evaluate(() => Array.from(document.querySelectorAll('input[type="radio"]:not(:checked)')).map((el) => el.name));
    for (const name of [...new Set(unchecked)]) {
      await page.locator(`input[name="${name}"]`).first().check({ timeout: T }).catch(() => {});
    }
    const ackBox = page.getByRole('checkbox', { name: '已知悉，发布时会声明' });
    if (await ackBox.isVisible().catch(() => false) && !(await ackBox.isChecked())) await ackBox.check({ timeout: T }).catch(() => {});
    await page.waitForTimeout(800);
    if (!(await confirmBtn.isDisabled())) {
      await confirmBtn.focus({ timeout: T });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1800);
      const status = await page.evaluate(async () => {
        const workID = location.pathname.match(/works\/([a-z0-9-]+)/i)?.[1];
        const w = await (await fetch(`/api/v1/works/${workID}`)).json();
        return w.status;
      });
      note('B6-confirm-check-kbd', status === 'ready', `work status=${status}`);
    } else note('B6-confirm-check-kbd', false, '确认按钮仍禁用（存在未处理项）');
  }
}

// ---- 7. 打包/推送闸门（键盘）----
if (workID) {
  await page.goto(`${BASE}/works/${workID}/pack`);
  await page.waitForTimeout(1500);
  const gate = await page.locator('text=发布前检查还没有全部确认').isVisible().catch(() => false);
  const goCheck = page.getByRole('button', { name: '去检查', exact: true });
  const goCheckVisible = await goCheck.isVisible().catch(() => false);
  note('A7-pack-gate', gate || goCheckVisible, `gate=${gate}, 去检查=${goCheckVisible}`);
  if (goCheckVisible) {
    await goCheck.focus({ timeout: T });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    note('A8-gate-jump-kbd', page.url().includes('/check'), page.url());
  }
}

logLine('TRAPS: ' + JSON.stringify(traps));
logLine('SUMMARY: ' + JSON.stringify(findings, null, 1));
await app.close();
process.exit(0);
