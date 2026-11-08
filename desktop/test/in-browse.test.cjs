'use strict';
// DEV-AI27-08 W08：内置浏览视图控制器测试（node --test；Electron API mock，
// 真实 Electron 视觉旅程按 27 §16.1 分层另测）。

const assert = require('node:assert/strict');
const test = require('node:test');

// mock electron（Controller 只用 Minimal API 面）
const listeners = new Map();
let addedChildren = [];
let removedChildren = [];
const fakeView = () => {
  const wc = {
    destroyed: false,
    url: '',
    title: '页面标题',
    loadingFlag: false,
    navigationStarted: 0,
    listeners: new Map(),
    on(ev, fn) { this.listeners.set(ev, fn); },
    getURL() { return this.url; },
    getTitle() { return this.title; },
    isLoading() { return this.loadingFlag; },
    loadURL(u) { this.navigationStarted += 1; this.url = u; },
    goBack() {}, goForward() {}, reload() {}, stop() {},
  };
  return {
    webContents: wc,
    setBounds: (b) => { this.bounds = b; },
    getBounds: () => this.bounds,
    __setBounds: (b) => { this.bounds = b; },
    __bounds: null,
  };
};

const electronMock = {
  WebContentsView: class {
    constructor(opts) {
      this.webPreferences = opts.webPreferences;
      this.webContents = {
        isDestroyed: () => false,
        destroyed: false,
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
      addChildView(v) { addedChildren.push(v); },
      removeChildView(v) { removedChildren.push(v); },
    },
    once(ev, fn) { listeners.set(ev, fn); },
  };
}

test('W08: setBounds 挂载视图 + navigate http 限定', () => {
  addedChildren = []; removedChildren = [];
  const snapshots = [];
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, (s) => snapshots.push(s));
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  assert.equal(addedChildren.length, 1, '视图应挂载');
  assert.equal(c.snapshot().navigationGeneration, 0);

  const nav = c.navigate('https://example.com/page');
  assert.equal(nav.ok, true);
  assert.equal(c.snapshot().url, 'https://example.com/page');
  assert.equal(c.snapshot().navigationGeneration, 1, '导航后代数递增');

  // 反例：非 http/https 拒绝（27 §14.3）
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://version', 'data:text/html,x', 'not a url']) {
    assert.equal(c.navigate(bad).ok, false, `${bad} 应拒绝`);
  }
  assert.equal(c.snapshot().navigationGeneration, 1, '被拒导航不递增代数');
  c.destroy();
});

test('W08: detach/attach（审批浮层前隐藏，关闭后恢复）', () => {
  addedChildren = []; removedChildren = [];
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  c.navigate('https://example.com');
  assert.equal(addedChildren.length, 2, 'setBounds+navigate 各挂载一次');

  c.detach('approval-dialog');
  assert.equal(c.isDetached().detached, true);
  assert.equal(c.isDetached().reason, 'approval-dialog');
  assert.equal(removedChildren.length, 1, 'detach 应移除视图');
  assert.equal(c.snapshot().bounds, null, 'detach 后快照 bounds=null（不冒充可见）');

  c.attach();
  assert.equal(c.isDetached().detached, false);
  assert.equal(addedChildren.length, 3, 'attach 重新挂载');
  c.destroy();
});

test('W08: 最小宽度约束 + close 清空', () => {
  addedChildren = []; removedChildren = [];
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 100, height: 800 });
  // 视图 setBounds 收到 clamp 后宽度（mock 记录 __bounds），快照记录请求 bounds。
  assert.ok(c.snapshot().bounds.width >= IN_BROWSE_MIN_WIDTH, '宽度下限保护（快照）');
  assert.ok(addedChildren.length >= 1, '视图已挂载');
  c.navigate('https://example.com');
  c.close();
  assert.equal(removedChildren.length >= 1, true, 'close 移除视图');
  assert.equal(c.snapshot().url, '', 'close 后快照清空');
  assert.equal(c.snapshot().bounds, null);
});

test('W08: detached 状态下 navigate 拒绝', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  c.detach('menu');
  const nav = c.navigate('https://example.com');
  assert.equal(nav.ok, false);
  assert.equal(nav.reason, 'detached');
  assert.equal(c.snapshot().url, '', 'detached 下不得导航');
  c.destroy();
});
