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
        windowOpenHandler: null,
        on(ev, fn) { this.listeners.set(ev, fn); },
        getURL() { return this.url; },
        getTitle() { return this.title; },
        isLoading() { return this.loadingFlag; },
        setWindowOpenHandler(fn) { this.windowOpenHandler = fn; },
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
  session: {
    // DEV-AI27-08g：persist:ops-inbrowse 分区 mock——统计/清理全部只落在该分区。
    fromPartition: (partition) => {
      if (partition !== 'ops-inbrowse') {
        // 业务 session 等其他分区：mock 一个"如果被误清会暴露"的对象。
        return { __partition: partition, clearCacheCalls: 0, clearStorageCalls: 0 };
      }
      const cookies = [{ name: 'a' }, { name: 'b' }];
      return {
        __partition: partition,
        getCacheSize: async () => 5 * 1024 * 1024,
        cookies: { get: async () => cookies },
        clearCache: async () => { clearedTargets.push('browse-cache'); },
        clearStorageData: async () => { clearedTargets.push('browse-storage'); },
      };
    },
  },
};
require.cache[require.resolve('electron')] = { exports: electronMock };

const { InBrowseViewController, IN_BROWSE_MIN_WIDTH, clearInBrowseData, inBrowseDataStats } = require('../.build/in-browse.js');

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

test('W08d: reorderTab 拖拽排序', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  const t1 = c.openTab();
  const t2 = c.openTab();
  const t3 = c.openTab();
  // 向左拖：把 t3 移到 t1 之前
  assert.equal(c.reorderTab(t3, t1), true);
  let snap = c.snapshot();
  assert.equal(snap.tabs[0].id, t3, 't3 应移到首位');
  assert.equal(snap.tabs[1].id, t1);
  assert.equal(snap.tabs[2].id, t2);
  // 向右拖：把 t3 拖到末位，应真的落到末尾而不是停在 t2 之前
  assert.equal(c.reorderTab(t3, t2), true);
  snap = c.snapshot();
  assert.equal(snap.tabs[0].id, t1);
  assert.equal(snap.tabs[1].id, t2);
  assert.equal(snap.tabs[2].id, t3, '向右拖应落在目标之后');
  // 同 id 排序无效
  assert.equal(c.reorderTab(t3, t3), false);
  // 不存在的 id 无效
  assert.equal(c.reorderTab('nope', t1), false);
  c.destroy();
});

test('W08e: 下载记录走真实快照，不清空页签', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  const t1 = c.openTab();
  const t2 = c.openTab();
  // 早前版本在下载完成时推送 { tabs: [], activeTabId: null }，
  // 一次下载就会把前端页签列表整个清掉；这里锁住「下载与页签互不影响」。
  c.recordDownload({ id: 'd1', filename: '报告.pdf', state: 'completed', receivedBytes: 2048, totalBytes: 2048, sourceUrl: 'https://example.com/a.pdf' });
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 2, '下载不得清空页签');
  assert.equal(snap.tabs[0].id, t1);
  assert.equal(snap.tabs[1].id, t2);
  assert.equal(snap.activeTabId, t2, '活动页签不应被下载改写');
  assert.equal(snap.downloads.length, 1);
  assert.equal(snap.downloads[0].filename, '报告.pdf');
  assert.equal(snap.downloads[0].state, 'completed');
  // 新的在前，且最多保留 20 条
  for (let i = 0; i < 25; i += 1) {
    c.recordDownload({ id: `x${i}`, filename: `f${i}.bin`, state: 'completed', receivedBytes: 1, totalBytes: 1, sourceUrl: 'https://example.com/' });
  }
  const after = c.snapshot();
  assert.equal(after.downloads.length, 20, '下载记录上限 20 条');
  assert.equal(after.downloads[0].filename, 'f24.bin', '最新记录排在最前');
  assert.equal(after.tabs.length, 2, '批量下载后页签仍在');
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

// ---------------------------------------------------------------------------
// DEV-AI27-08f（27 §7.8 弹窗处理）：deny 默认 + 同站进新页签 + 回执 lastBlockedPopup。
// 覆盖 6 类组合：同站 tab 型放行进页签、跨站拒绝、new-window 拒绝、非 http(s) 拒绝、
// 页签上限拒绝、will-navigate 非 http(s) 拦截。
// ---------------------------------------------------------------------------

/** 取控制器当前活动页签的 mock webContents（含 windowOpenHandler / will-navigate 监听）。 */
function activeMockWebContents(c) {
  const snap = c.snapshot();
  const tab = c.tabs.get(snap.activeTabId);
  return tab.view.webContents;
}

test('W08f: 同站 tab 型弹窗进新页签并导航', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  const result = wc.windowOpenHandler({ url: 'https://site.example/target', disposition: 'foreground-tab' });
  assert.deepEqual(result, { action: 'deny' }, '放行路径也不开原生窗');
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 2, '同站弹窗应进新页签');
  const newTab = snap.tabs.find((t) => t.id !== snap.tabs[0].id) ?? snap.tabs[1];
  assert.equal(newTab.url, 'https://site.example/target', '新页签导航到目标');
  assert.equal(snap.lastBlockedPopup, null, '放行路径无拒绝回执');
  c.destroy();
});

test('W08f: 跨站弹窗被拒并回执 cross_origin', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  wc.windowOpenHandler({ url: 'https://other.example/x', disposition: 'foreground-tab' });
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 1, '跨站不开新页签');
  assert.equal(snap.lastBlockedPopup.reason, 'cross_origin');
  assert.equal(snap.lastBlockedPopup.url, 'https://other.example/x');
  c.destroy();
});

test('W08f: new-window disposition 拒绝（不弹原生窗）', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  wc.windowOpenHandler({ url: 'https://site.example/pop', disposition: 'new-window' });
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 1);
  assert.equal(snap.lastBlockedPopup.reason, 'new_window');
  c.destroy();
});

test('W08f: 非 http(s) 协议拒绝（file: / javascript:）', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  wc.windowOpenHandler({ url: 'file:///C:/etc/passwd', disposition: 'foreground-tab' });
  assert.equal(c.snapshot().lastBlockedPopup.reason, 'protocol_denied');
  wc.windowOpenHandler({ url: 'javascript:alert(1)', disposition: 'foreground-tab' });
  assert.equal(c.snapshot().lastBlockedPopup.reason, 'protocol_denied');
  assert.equal(c.snapshot().tabs.length, 1, '非 http(s) 不开页签');
  c.destroy();
});

test('W08f: 页签上限 8 弹窗被拒并回执 tab_limit', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  for (let i = 0; i < 7; i += 1) {
    wc.windowOpenHandler({ url: `https://site.example/p${i}`, disposition: 'background-tab' });
  }
  assert.equal(c.snapshot().tabs.length, 8, '上限内正常开页签');
  wc.windowOpenHandler({ url: 'https://site.example/p9', disposition: 'background-tab' });
  const snap = c.snapshot();
  assert.equal(snap.tabs.length, 8, '超限不开');
  assert.equal(snap.lastBlockedPopup.reason, 'tab_limit');
  c.destroy();
});

test('W08f: will-navigate 非 http(s) 拦截（preventDefault + 回执）', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  const listener = wc.listeners.get('will-navigate');
  assert.ok(listener, 'will-navigate 监听已挂');
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  listener(event, 'javascript:void(0)');
  assert.equal(prevented, true, '非 http(s) 页内导航被 preventDefault');
  assert.equal(c.snapshot().lastBlockedPopup.reason, 'protocol_denied');
  // http(s) 导航不拦截
  prevented = false;
  listener(event, 'https://site.example/next');
  assert.equal(prevented, false, 'http(s) 页内导航放行');
  assert.equal(c.snapshot().lastBlockedPopup.reason, 'protocol_denied', '放行不改写既有回执');
  c.destroy();
});

test('W08f: destroy 清空弹窗回执', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.openTab();
  const wc = activeMockWebContents(c);
  wc.loadURL('https://site.example/page');
  wc.windowOpenHandler({ url: 'file:///tmp/x', disposition: 'foreground-tab' });
  assert.ok(c.snapshot().lastBlockedPopup);
  c.destroy();
  assert.equal(c.snapshot().lastBlockedPopup, null, 'destroy 后回执清空');
});

// ---------------------------------------------------------------------------
// DEV-AI27-08g（27 §14.5 浏览数据管理）：clearData 只作用于 persist:ops-inbrowse；
// 非法 kind 拒绝；统计如实返回。
// ---------------------------------------------------------------------------

const clearedTargets = [];

test('W08g: 统计返回浏览分区体积与 Cookies 数', async () => {
  const stats = await inBrowseDataStats();
  assert.equal(stats.cacheBytes, 5 * 1024 * 1024);
  assert.equal(stats.cookiesCount, 2);
});

test('W08g: clearData cache/all 只清浏览分区', async () => {
  clearedTargets.length = 0;
  const r1 = await clearInBrowseData('cache');
  assert.deepEqual(r1.cleared, ['cache']);
  assert.deepEqual(clearedTargets, ['browse-cache'], '只触碰浏览分区缓存');
  const r2 = await clearInBrowseData('all');
  assert.deepEqual(r2.cleared, ['cache', 'cookies', 'storage']);
  assert.deepEqual(clearedTargets, ['browse-cache', 'browse-cache', 'browse-storage'], 'all 仍只落浏览分区');
});

test('W08g: clearData cookies 清 Cookies 与站点数据', async () => {
  clearedTargets.length = 0;
  const r = await clearInBrowseData('cookies');
  assert.deepEqual(r.cleared, ['cookies', 'storage']);
  assert.deepEqual(clearedTargets, ['browse-storage']);
});

test('W08g: 非法 kind 拒绝（不静默清空）', async () => {
  clearedTargets.length = 0;
  await assert.rejects(() => clearInBrowseData('everything'), /inbrowse_data_kind_invalid/);
  await assert.rejects(() => clearInBrowseData(''), /inbrowse_data_kind_invalid/);
  assert.deepEqual(clearedTargets, [], '非法 kind 未触发任何清理');
});
