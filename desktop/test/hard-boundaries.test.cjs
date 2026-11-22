const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bridge = require('../.build/browser-bridge.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('B-08.1 浏览器硬禁区清单存在且与登记动作互斥', () => {
  const forbidden = ['clear_cookies', 'clear_cache', 'delete_cookies', 'clear_storage', 'close_browser', 'grant_permissions', 'set_permission', 'reset_permissions', 'webauthn', 'bring_to_front', 'load_network_resource'];
  assert.deepEqual([...bridge.HARD_FORBIDDEN_BROWSER_CAPABILITIES], forbidden);
  for (const name of forbidden) {
    assert.equal(bridge.ALLOWED_ACTIONS.has(name), false, `${name} 不得登记`);
    assert.equal(bridge.READ_ONLY_ACTIONS.has(name), false, `${name} 不得在只读集`);
  }
  const bg = read('chrome-extension/background.js');
  const server = read('../server/internal/app/agent_browser_commands.go');
  for (const name of forbidden) {
    assert.doesNotMatch(bg, new RegExp(`${name}:`), `扩展不得登记 ${name}`);
    assert.doesNotMatch(server, new RegExp(`"${name}": true`), `服务端不得登记 ${name}`);
  }
});

test('B-08.1 URL 仅 http(s)，内部页不进入标签列表', () => {
  const bg = read('chrome-extension/background.js');
  assert.ok(bg.includes("if (!/^https?:$/.test(parsed.protocol)) return { error: 'url_not_http' };"), 'navigate 只允许 http(s)');
  assert.ok(bg.includes("filter((t) => /^https?:\\/\\//i.test(t.url || ''))"), 'tabs_list 过滤内部页');
  assert.ok(bg.includes("if (!tab.url || !/^https?:/.test(tab.url)) return { error: 'tab_not_http' };"), '动作前校验 tab');
});

test('B-08.2 电脑控制 UIA 硬禁区保持并与浏览器清单同表记录', () => {
  const policy = read('src/computer-worker/policy.js');
  assert.match(policy, /const HARD_FORBIDDEN = \[/);
  for (const name of ['winlogon', 'csrss', 'lsass', 'credential', 'vault', 'uac']) {
    assert.match(policy, new RegExp(`'${name}'`), `UIA 词表缺 ${name}`);
  }
  // Q-17（docs/41）：终端与系统管理/滥用面补齐（词表断言 + 行为断言 + 误报防线）。
  const { isHardForbidden } = require('../src/computer-worker/policy.js');
  for (const name of ['wt.exe', 'windowsterminal', 'wmic', 'certutil', 'bitsadmin', 'mshta', 'rundll32', 'reg add', 'net user', 'taskschd', 'lusrmgr', 'eventvwr', 'diskmgmt', 'services.msc', 'devmgmt', 'ncpa.cpl']) {
    assert.match(policy, new RegExp(`'${name.replace('.', '\\.')}'`), `硬禁区词表缺 ${name}`);
  }
  assert.equal(isHardForbidden('Windows Terminal'), true, '终端（docs/16 §11.5.2 点名）未拦');
  assert.equal(isHardForbidden('wmic.exe'), true);
  assert.equal(isHardForbidden('任务计划程序'), true);
  assert.equal(isHardForbidden('记事本 - 未命名'), false, '普通窗口被误伤');
  assert.equal(isHardForbidden('资源管理器'), false, '普通窗口被误伤');
  assert.equal(isHardForbidden('浏览器验收号 - 公众号平台'), false, '普通窗口被误伤');
  const doc = read('../docs/41-browse可借鉴实现清单.md');
  assert.match(doc, /B-08 硬禁区总表|本机能力硬禁区总表|CDP 硬禁区清单/);
  assert.match(doc, /B-08\.2|computer-worker\/policy\.js/);
});

test('B-08.3 本地文件只走显式根白名单；当前无任意路径文件动作', () => {
  assert.ok(!bridge.ALLOWED_ACTIONS.has('read_file'));
  assert.ok(!bridge.ALLOWED_ACTIONS.has('write_file'));
  const doc = read('../docs/41-browse可借鉴实现清单.md');
  assert.match(doc, /显式根目录白名单|文件类动作/);
});

test('B-08.4 新增动作三问与审计锚点已写入文档', () => {
  const doc = read('../docs/41-browse可借鉴实现清单.md');
  for (const q of ['会不会清用户状态', '会不会改用户权限', '会不会打开浏览器内部页面']) {
    assert.match(doc, new RegExp(q));
  }
  assert.match(read('src/browser-bridge.ts'), /B-08：永不允许的浏览器能力/);
});
