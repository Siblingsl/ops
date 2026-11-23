// Q-27（docs/41，16 文档 §15.3 200% 文本放大）：业务窗与本机设置窗菜单收纳于
// 自绘标题栏，Windows 下菜单 role 缩放加速键不经菜单路径触发——webContents 层
// 必须有 before-input-event 拦截 Ctrl+=/Ctrl+-/Ctrl+0。此前两窗都没有，
// 键盘用户没有任何页面缩放入口（WCAG 1.4.4）。
//
// installWebContentsZoomShortcuts 是 main.ts 的模块内私有函数，这里用
// support/source-function.cjs 把实现原样转译求值后测真实行为，不是文本匹配。

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFunction, readSource } = require('./support/source-function.cjs');

const mainSource = () => readSource('src/main.ts');

// makeContents 造一个记录 setZoomLevel 调用的假 webContents。
function makeContents(initialLevel) {
  const calls = [];
  return {
    calls,
    level: initialLevel,
    handlers: {},
    on(name, handler) {
      this.handlers[name] = handler;
    },
    getZoomLevel() {
      return this.level;
    },
    setZoomLevel(next) {
      calls.push(next);
      this.level = next;
    }
  };
}

function press(contents, key, { control = true, shift = false, alt = false, meta = false } = {}) {
  let prevented = false;
  contents.handlers['before-input-event'](
    { preventDefault: () => {
      prevented = true;
    } },
    { type: 'keyDown', key, control, shift, alt, meta },
  );
  return prevented;
}

function install(contents, initialLevel) {
  const impl = loadFunction('src/main.ts', 'installWebContentsZoomShortcuts');
  const target = makeContents(initialLevel);
  impl(target);
  assert.ok(target.handlers['before-input-event'], '必须注册 before-input-event 监听');
  return target;
}

test('Q-27：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 回到 100%', () => {
  const contents = install(null, 0);
  assert.equal(press(contents, '='), true, 'Ctrl+= 必须被拦截');
  assert.equal(contents.level, 0.5);
  press(contents, '=');
  assert.equal(contents.level, 1);
  assert.equal(press(contents, '-'), true, 'Ctrl+- 必须被拦截');
  assert.equal(contents.level, 0.5);
  assert.equal(press(contents, '0'), true, 'Ctrl+0 必须被拦截');
  assert.equal(contents.level, 0);
  // 已在 100% 时 Ctrl+0 不再调用 setZoomLevel（幂等）。
  contents.calls.length = 0;
  press(contents, '0');
  assert.equal(contents.calls.length, 0);
});

test('Q-27：缩放档位 clamp 在 ±5，修饰键组合不误触', () => {
  const contents = install(null, 4.75);
  for (let i = 0; i < 3; i++) press(contents, '=');
  assert.equal(contents.level, 5, '放大必须 clamp 到 +5');
  const minContents = install(null, -4.75);
  for (let i = 0; i < 3; i++) press(minContents, '-');
  assert.equal(minContents.level, -5, '缩小必须 clamp 到 -5');
  // Shift/Ctrl 无主键、其它按键不拦截。
  const idle = install(null, 0);
  assert.equal(press(idle, 'a'), false);
  assert.equal(press(idle, '=', { control: false }), false, '无 Ctrl 不拦截');
  assert.equal(press(idle, '=', { shift: true }), false, 'Ctrl+Shift+= 不拦截');
  assert.equal(press(idle, '=', { alt: true }), false);
});

test('Q-27：业务窗与本机设置窗都已安装缩放快捷键', () => {
  const source = mainSource();
  assert.match(source, /installWebContentsZoomShortcuts\(currentWindow\.webContents\)/, '业务窗必须安装');
  assert.match(source, /installWebContentsZoomShortcuts\(window\.webContents\)/, '本机设置窗必须安装');
});
