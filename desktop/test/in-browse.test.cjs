'use strict';
// DEV-AI27-08 W08：内置浏览视图控制器测试（node --test；Electron API mock，
// 真实 Electron 视觉旅程按 27 §16.1 分层另测）。W08d：多页签。

const assert = require('node:assert/strict');
const test = require('node:test');

const electronMock = {
  WebContentsView: class {
    constructor(opts) {
      this.webPreferences = opts.webPreferences;
      this.__bounds = null;
      this.webContents = {
        isDestroyed: () => false,
        url: '',
        title: '页面标题',
        loadingFlag: false,
        navigationCount: 0,
        listeners: new Map(),
        on(ev, fn) { this.listeners.set(ev, fn); },
        getURL() { return this.url; },
        getTitle() { return this.title; },
        isLoading() { return this.loadingFlag; },
        loadURL(u) {
          this.navigationCount += 1;
          this.url = u;
          const fn = this.listeners.get('did-start-navigation');
          if (fn) fn();
        },
        goBack() {}, goForward() {}, reload() {}, stop() {},
      };
    }
    setBounds(b) { this.__bounds = b; }
  },
  session: { fromPartition: () => ({}) },
};
require.cache[require.resolve('electron')] = { exports: electronMock };

const { InBrowseViewController, IN_BROWSE_MIN_WIDTH } = require('../.build/in-browse.js');

function fakeWindow() {
  return {
    closed: false,
    contentView: {
      children: [],
      addChildView(v) { this.children.push(v); },
      removeChildView(v) { this.children = this.children.filter((x) => x !== v); },
    },
    once(ev, fn) { /* closed 回调省略 */ },
  };
}

test('W08d: openTab 多页签 + switchTab 切换 + closeTab 相邻激活', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });

  const t1 = c.openTab();
  const t2 = c.openTab();
  assert.ok(t1 && t2 && t1 !== t2, '两个页签不同 id');
  let snap = c.snapshot();
  assert.equal(snap.tabs.length, 2);
  assert.equal(snap.activeTabId, t2, '新开页签自动激活');

  assert.equal(c.navigate('https://example.com/a').ok, true);
  assert.equal(c.switchTab(t1), true);
  snap = c.snapshot();
  assert.equal(snap.activeTabId, t1);
  const t1Snap = snap.tabs.find((x) => x.id === t1);
  assert.equal(t1Snap.url, '', 't1 仍是空白');

  c.closeTab(t1);
  snap = c.snapshot();
  assert.equal(snap.tabs.length, 1);
  assert.equal(snap.activeTabId, t2, '关闭后激活相邻');
  c.destroy();
});

test('W08d: navigate 无活动页签时自动开新页签', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  assert.equal(c.navigate('https://example.com/first').ok, true);
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 1);
  assert.equal(snap.tabs[0].url, 'https://example.com/first');
  c.destroy();
});

test('W08d: 页签上限 8 与逐 tab 导航代数独立', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  for (let i = 0; i < 9; i += 1) c.openTab();
  assert.equal(c.snapshot().tabs.length, 8, '上限 8');
  c.navigate('https://a.example.com');
  const before = c.snapshot().tabs.find((x) => x.id === c.snapshot().activeTabId).navigationGeneration;
  c.navigate('https://b.example.com');
  const after = c.snapshot().tabs.find((x) => x.id === c.snapshot().activeTabId).navigationGeneration;
  assert.equal(after, before + 1, '同 tab 代数递增');
  c.destroy();
});

test('W08d: detach/attach 保留全部页签（不丢 tab）', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  c.openTab();
  c.openTab();
  c.navigate('https://example.com');
  c.detach('approval-dialog');
  assert.equal(c.snapshot().detached, true);
  assert.equal(c.snapshot().tabs.length, 2, 'detach 不丢页签');
  c.attach();
  assert.equal(c.snapshot().detached, false);
  assert.equal(c.snapshot().tabs.length, 2);
  assert.equal(c.navigate('https://example.com/x').ok, true, 'attach 后可继续导航');
  c.destroy();
});

test('W08d: 宽度钳制与 destroy 清空', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 100, height: 800 });
  assert.ok(c.snapshot().bounds.width >= IN_BROWSE_MIN_WIDTH, '宽度下限保护');
  c.openTab();
  c.navigate('https://example.com');
  c.destroy();
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 0);
  assert.equal(snap.activeTabId, null);
});
