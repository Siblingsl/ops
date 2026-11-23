const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bridge = require('../.build/browser-bridge.js');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('B-02B.1 debugger 是可选权限，必须由 popup 用户手势请求', () => {
  const manifest = JSON.parse(read('chrome-extension/manifest.json'));
  assert.deepEqual(manifest.optional_permissions, ['debugger']);
  assert.equal(manifest.permissions.includes('debugger'), false, '不得成为安装即授予的权限');
  const popup = read('chrome-extension/popup.js');
  assert.match(popup, /chrome\.permissions\.contains\(\{ permissions: \['debugger'\] \}/);
  assert.match(popup, /addEventListener\('click'[\s\S]{0,120}chrome\.permissions\.request/);
  assert.match(popup, /仅 Input 域|Input 域/);
});

test('B-02B.2 只允许 Input.dispatchMouseEvent / Input.insertText，不接受任意 CDP 方法', () => {
  const bg = read('chrome-extension/background.js');
  assert.match(bg, /chrome\.debugger\.attach\(\{ tabId \}, DEBUGGER_PROTOCOL_VERSION\)/);
  assert.match(bg, /DEBUGGER_PROTOCOL_VERSION = '1\.3'/);
  const calls = [...bg.matchAll(/chrome\.debugger\.sendCommand\(\{ tabId \}, '([^']+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4, `固定方法调用数 ${calls.length}`);
  for (const method of calls) {
    assert.ok(method === 'Input.dispatchMouseEvent' || method === 'Input.insertText', `不允许 ${method}`);
  }
  assert.doesNotMatch(bg, /Runtime\.enable|Console\.enable|Debugger\.enable|sendCommand\(\{ tabId \}, method/);
  assert.doesNotMatch(bg, /params\.method|payload\.method|msg\.method/);
});

test('B-02B.3 可信输入动作登记到三处白名单，只读拒绝写动作', () => {
  for (const action of ['click_at', 'type_at', 'scroll_at']) {
    assert.ok(bridge.ALLOWED_ACTIONS.has(action), `桥缺 ${action}`);
    assert.equal(bridge.READ_ONLY_ACTIONS.has(action), false, `只读不得放 ${action}`);
  }
  const bg = read('chrome-extension/background.js');
  for (const fn of ['click_at: actionClickAt', 'type_at: actionTypeAt', 'scroll_at: actionScrollAt']) {
    assert.ok(bg.includes(fn), `扩展缺 ${fn}`);
  }
  const server = read('../server/internal/app/agent_browser_commands.go');
  for (const action of ['click_at', 'type_at', 'scroll_at']) {
    assert.ok(server.includes(`"${action}": true`), `服务端缺 ${action}`);
  }
});

test('B-02B.4 默认关闭：需开关 + 可选权限 + 已跟踪的自己的附着', () => {
  const bg = read('chrome-extension/background.js');
  assert.match(bg, /debuggerInput: false/);
  assert.match(bg, /sw\.debuggerInput = Boolean\(mode\.debugger_input\)/);
  assert.match(bg, /if \(!sw\.debuggerInput\) return \{ error: 'debugger_disabled' \}/);
  assert.match(bg, /permissions\.contains\(\{ permissions: \['debugger'\] \}\)/);
  assert.match(bg, /debugger_permission_missing/);
  assert.match(bg, /if \(sw\.debuggerTabs\.has\(tabId\)\) return \{ ok: true \}/, '只有自己跟踪的附着才复用');
});

test('B-02B.5 冲突明确失败不抢 DevTools；tab 关闭/revoke 释放附着', () => {
  const bg = read('chrome-extension/background.js');
  assert.match(bg, /already attached\|another debugger\|devtools/i);
  assert.match(bg, /error: 'debugger_conflict'/);
  assert.match(bg, /chrome\.debugger\.detach\(\{ tabId \}\)/);
  assert.match(bg, /void releaseDebugger\(tabId\)/);
  assert.match(bg, /sw\.debuggerTabs\.keys\(\)/);
  assert.match(read('src/browser-bridge.ts'), /OPS_BROWSER_DEBUGGER_INPUT === '1'/);
  assert.match(read('src/browser-bridge.ts'), /debugger_input: this\.debuggerInput/);
});

test('B-02B.6 可信输入不破坏 B-04：不请求 MAIN world，不开启页面可感知调试域', () => {
  const bg = read('chrome-extension/background.js');
  assert.doesNotMatch(bg, /world:\s*['"]MAIN['"]/);
  assert.doesNotMatch(bg, /Runtime\.enable|Console\.enable|Debugger\.enable/);
});
