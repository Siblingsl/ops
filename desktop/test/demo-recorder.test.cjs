const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSelector,
  roleOf,
  nameOf,
  nearestActionable,
  recordClick,
  recordInput,
  DemoRecorder,
  shouldEvictForeignFrames,
  isForeignFrame,
  evictForeignFrames
} = require('../.build/platforms/demo-recorder.js');

function el(tagName, options = {}) {
  const node = {
    tagName,
    id: options.id,
    attributes: options.attributes || {},
    textContent: options.textContent || '',
    children: [],
    shadowRoot: options.shadowRoot || null,
    parent: null
  };
  for (const child of options.children || []) {
    child.parent = node;
    node.children.push(child);
  }
  if (node.shadowRoot) node.shadowRoot.parent = node;
  return node;
}

function rootWith(...children) {
  const root = el('BODY');
  children.forEach((c) => { c.parent = root; root.children.push(c); });
  return root;
}

test('B-12.1 外部扩展 frame 识别：1Password/LastPass/Bitwarden/外来 chrome-extension iframe', () => {
  const own = 'abcdefghijklmnop';
  assert.equal(isForeignFrame(el('COM-1PASSWORD-WIDGET'), own).reason, '1password_tag');
  assert.equal(isForeignFrame(el('DIV', { attributes: { 'data-onepassword-extension': '' } }), own).reason, '1password_attr');
  assert.equal(isForeignFrame(el('DIV', { attributes: { 'data-lastpass-root': '' } }), own).reason, 'lastpass_attr');
  assert.equal(isForeignFrame(el('DIV', { id: 'bitwarden-inline' }), own).reason, 'bitwarden_id');
  assert.equal(isForeignFrame(el('IFRAME', { attributes: { src: 'chrome-extension://other/ext.html' } }), own).reason, 'foreign_extension_src');
  assert.equal(isForeignFrame(el('IFRAME', { attributes: { src: 'chrome-extension://abcdefghijklmnop/ext.html' } }), own).foreign, false);
  assert.equal(isForeignFrame(el('IFRAME', { attributes: { src: 'https://example.com/frame' } }), own).foreign, false);
});

test('B-12.1 只在 running 驱逐；attached/waiting/recording 保留密码管理器', () => {
  assert.equal(shouldEvictForeignFrames('running'), true);
  for (const state of ['attached', 'waiting', 'recording']) {
    assert.equal(shouldEvictForeignFrames(state), false, state);
  }
});

test('B-12.1 递归 open shadow root 移除宿主；正常页面元素不动', () => {
  const onePassword = el('DIV', { attributes: { 'data-onepassword-extension': '' } });
  const shadowHost = el('DIV', { shadowRoot: el('COM-1PASSWORD-FIELD') });
  const bitwarden = el('DIV', { id: 'bitwarden-inline' });
  const normalButton = el('BUTTON', { textContent: '保存' });
  const root = rootWith(onePassword, shadowHost, bitwarden, normalButton);
  const removed = evictForeignFrames(root, 'abcdefghijklmnop');
  assert.deepEqual(removed.sort(), ['1password_attr', '1password_tag', 'bitwarden_id'].sort());
  assert.deepEqual(root.children.map((c) => c.tagName), ['DIV', 'BUTTON']);
});

test('B-12.2 selector 优先 id → 唯一 data-testid → 逐级 nth-of-type', () => {
  const only = el('BUTTON', { id: 'submit', textContent: '提交' });
  const root = rootWith(only);
  assert.equal(buildSelector(only, root), '#submit');

  const testId = el('BUTTON', { attributes: { 'data-testid': 'publish' } });
  const root2 = rootWith(testId);
  assert.equal(buildSelector(testId, root2), '[data-testid="publish"]');

  const first = el('DIV');
  const second = el('DIV');
  const third = el('SPAN');
  const root3 = rootWith(first, second, third);
  assert.equal(buildSelector(second, root3), 'div:nth-of-type(2)');
  assert.equal(buildSelector(third, root3), 'span:nth-of-type(1)');

  // 重复 data-testid 不唯一 → 退回路径
  const a = el('BUTTON', { attributes: { 'data-testid': 'dup' } });
  const b = el('BUTTON', { attributes: { 'data-testid': 'dup' } });
  const root4 = rootWith(a, b);
  assert.equal(buildSelector(b, root4), 'button:nth-of-type(2)');
});

test('B-12.2 role 与 name：aria-label 优先，其次 aria-labelledby 文本，再 textContent 截 120', () => {
  assert.equal(roleOf(el('A', { attributes: { href: '/x' } })), 'link');
  assert.equal(roleOf(el('DIV', { attributes: { role: 'tab' } })), 'tab');
  const label = el('BUTTON', { attributes: { 'aria-label': '发布笔记' } });
  assert.equal(nameOf(label, rootWith(label)), '发布笔记');
  const labelNode = el('SPAN', { id: 'lb', textContent: '下一页' });
  const target = el('BUTTON', { attributes: { 'aria-labelledby': 'lb' } });
  const root = rootWith(labelNode, target);
  assert.equal(nameOf(target, root), '下一页');
  const long = 'x'.repeat(200);
  assert.equal(nameOf(el('BUTTON', { textContent: long }), root).length, 120);
});

test('B-12.3 点击从 composedPath 找最近可操作元素，span 冒泡到 button', () => {
  const span = el('SPAN', { textContent: '发布' });
  const button = el('BUTTON', { id: 'publish', textContent: '发布' });
  const root = rootWith(button);
  button.children.push(span);
  span.parent = button;
  const step = recordClick([span, button, root], root);
  assert.equal(step.kind, 'click');
  assert.equal(step.selector, '#publish');
  assert.equal(step.role, 'button');
  assert.equal(step.name, '发布');
  assert.equal(nearestActionable([span, button, root]), button);
  assert.equal(nearestActionable([span, root]), span, '没有可操作祖先时回退到有文本的点击目标');
  assert.equal(nearestActionable([el('DIV'), root]), null, '空白 div 不记录');
});

test('B-12.3 输入：普通值保留，password 值置空并标 redacted', () => {
  const normal = el('INPUT', { id: 'title', attributes: { type: 'text' } });
  const password = el('INPUT', { id: 'pwd', attributes: { type: 'password' } });
  const root = rootWith(normal, password);
  assert.deepEqual(recordInput(normal, 'hello', root), { kind: 'fill', selector: '#title', value: 'hello' });
  assert.deepEqual(recordInput(password, 'secret', root), { kind: 'fill', selector: '#pwd', redacted: true });
});

test('B-12.4 录制步骤立即入队、drain 后可取且不重复', () => {
  const recorder = new DemoRecorder();
  const button = el('BUTTON', { id: 'go', textContent: '开始' });
  const root = rootWith(button);
  assert.equal(recorder.record(recordClick([button], root)), true);
  assert.equal(recorder.record(null), false);
  assert.equal(recorder.size(), 1);
  const steps = recorder.drain();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].selector, '#go');
  assert.equal(recorder.size(), 0);
  assert.deepEqual(recorder.drain(), []);
});
