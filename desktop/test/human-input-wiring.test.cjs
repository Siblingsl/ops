const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bridge = require('../.build/browser-bridge.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('B-02A.2/.3 扩展点击/输入走人类化分支，默认关闭时保留旧行为', () => {
  const bg = read('chrome-extension/background.js');
  assert.match(bg, /async function clickFn\(ref, docRev, humanize\)/);
  assert.match(bg, /el\.dispatchEvent\(new MouseEvent\('mousedown'/);
  assert.match(bg, /el\.dispatchEvent\(new MouseEvent\('mouseup'/);
  assert.match(bg, /minimum-jerk|jerk\(/i);
  assert.match(bg, /async function typeFn\(ref, text, docRev, humanize\)/);
  assert.match(bg, /KeyboardEvent\('keydown'/);
  assert.match(bg, /KeyboardEvent\('keyup'/);
  assert.match(bg, /U\(30, 110\)/);
  assert.match(bg, /if \(!humanize\) \{[\s\S]{0,120}el\.click\(\)/, '默认关闭必须走旧 el.click()');
});

test('B-02A.4 滚轮动作登记到桥/扩展/服务端，且只读可用', () => {
  const bg = read('chrome-extension/background.js');
  const server = read('../server/internal/app/agent_browser_commands.go');
  assert.match(bg, /async function scrollFn\(deltaY, docRev, humanize\)/);
  assert.match(bg, /scroll: actionScroll/);
  assert.match(bg, /WheelEvent\('wheel'/);
  assert.match(bg, /15\.5, 18/);
  assert.ok(bridge.ALLOWED_ACTIONS.has('scroll'), '桥必须登记 scroll');
  assert.ok(bridge.READ_ONLY_ACTIONS.has('scroll'), 'scroll 不改数据，只读采集可用');
  assert.match(server, /"scroll": true/);
});

test('B-02A.5 人类化开关默认关闭，可经 setAccessMode 下发扩展', () => {
  assert.equal(bridge.ALLOWED_ACTIONS.has('scroll'), true);
  assert.match(read('src/browser-bridge.ts'), /OPS_BROWSER_HUMAN_INPUT === '1'/);
  assert.match(read('src/browser-bridge.ts'), /human_input: this\.humanInput/);
  const bg = read('chrome-extension/background.js');
  assert.match(bg, /humanInput: false/);
  assert.match(bg, /sw\.humanInput = Boolean\(mode\.human_input\)/);
  assert.match(bg, /human_input: sw\.humanInput/);
});

test('B-02A 人类化轨迹不含 MAIN world，不破坏 B-04 隔离', () => {
  const bg = read('chrome-extension/background.js');
  assert.doesNotMatch(bg, /world:\s*['"]MAIN['"]/);
  const isolation = read('test/isolation.test.cjs');
  assert.match(isolation, /world:'MAIN'|world: 'MAIN'|MAIN/);
});
