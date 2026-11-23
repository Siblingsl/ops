const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bridge = require('../.build/browser-bridge.js');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('B-11.1 桥/扩展/服务端动作表都不登记 execute/eval/run_script', () => {
  const forbidden = ['execute', 'eval', 'run_script', 'execute_arbitrary_js', 'run_js'];
  for (const name of forbidden) {
    assert.equal(bridge.ALLOWED_ACTIONS.has(name), false, `桥不得登记 ${name}`);
  }
  const bg = read('chrome-extension/background.js');
  const server = read('../server/internal/app/agent_browser_commands.go');
  for (const name of forbidden) {
    assert.doesNotMatch(bg, new RegExp(`${name}:`), `扩展不得登记 ${name}`);
    assert.doesNotMatch(server, new RegExp(`"${name}": true`), `服务端不得登记 ${name}`);
  }
});

test('B-11.1 扩展源码无 eval / new Function / 任意脚本注入', () => {
  const bg = read('chrome-extension/background.js');
  assert.doesNotMatch(bg, /\beval\s*\(/);
  assert.doesNotMatch(bg, /new\s+Function\s*\(/);
  assert.doesNotMatch(bg, /executeScript\(\{[^}]*files:\s*\[[^\]]*\]/s, '只注入包内固定文件，不拼接任意脚本');
});

test('B-11.2 桥的 README 红线保持“不接受任意 JS/CDP”', () => {
  const readme = read('chrome-extension/README.md');
  assert.match(readme, /只执行包内|动作登记表|任意 JS|执行任意/);
  assert.match(readme, /不接受任意 JS|不接收任意 JS|不执行任意/);
});

test('B-11.3 文档结论存在：不引入 execute，沙箱不是权限边界', () => {
  const doc = read('../docs/41-browse可借鉴实现清单.md');
  assert.match(doc, /不引入.*execute|不引入 execute/);
  assert.match(doc, /沙箱不是边界|不是权限隔离/);
  assert.match(doc, /B-11\.1|B-11\.2/);
});
