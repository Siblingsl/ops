'use strict';
// DEV-AI27-08 W08：内置浏览视图控制器测试（node --test；Electron API mock，
// 真实 Electron 视觉旅程按 27 §16.1 分层另测）。W08d：多页签。

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

let viewIdSeq = 0;

const electronMock = {
  ipcMain: { on() {} },
  WebContentsView: class {
    constructor(opts) {
      this.webPreferences = opts.webPreferences;
      this.__bounds = null;
      this.__id = ++viewIdSeq;
      this.webContents = {
        id: this.__id,
        sent: [],
        isDestroyed: () => false,
        url: '',
        title: '页面标题',
        loadingFlag: false,
        navigationCount: 0,
        listeners: new Map(),
        windowOpenHandler: null,
        on(ev, fn) { this.listeners.set(ev, fn); },
        emit(ev, ...args) {
          const fn = this.listeners.get(ev);
          if (fn) fn(...args);
        },
        send(channel, payload) { this.sent.push({ channel, payload }); },
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

const { InBrowseViewController, IN_BROWSE_MIN_WIDTH, clearInBrowseData, inBrowseDataStats, isHttpUrl, isBlockedDownloadFile } = require('../.build/in-browse.js');

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

test('BR-10: 协议白名单只放行 http/https', () => {
  assert.equal(isHttpUrl('http://127.0.0.1:8287/healthz'), true);
  assert.equal(isHttpUrl('https://mp.weixin.qq.com/'), true);
  assert.equal(isHttpUrl('file:///C:/Windows/win.ini'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('data:text/html,<p>x</p>'), false);
  assert.equal(isHttpUrl('ftp://example.com/a'), false);
  assert.equal(isHttpUrl('not a url'), false);
});

test('BR-10: 可执行文件下载拒绝（大小写/后缀）', () => {
  assert.equal(isBlockedDownloadFile('setup.exe'), true);
  assert.equal(isBlockedDownloadFile('SETUP.EXE'), true);
  assert.equal(isBlockedDownloadFile('tool.dmg'), true);
  assert.equal(isBlockedDownloadFile('run.sh'), true);
  assert.equal(isBlockedDownloadFile('build.bat'), true);
  assert.equal(isBlockedDownloadFile('installer.msi'), true);
  assert.equal(isBlockedDownloadFile('report.pdf'), false);
  assert.equal(isBlockedDownloadFile('image.png'), false);
  assert.equal(isBlockedDownloadFile(''), false);
});

test('BR-12: 渲染进程崩溃记 viewError 并移除视图，rebuildActive 重建恢复 URL', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  const id = c.openTab();
  c.navigate('https://example.com/article');
  const wc = activeMockWebContents(c);
  // 触发渲染进程崩溃（BR-07 同款路径）。
  wc.emit('render-process-gone', {}, { reason: 'crashed' });
  let snap = c.snapshot();
  assert.equal(snap.viewError?.reason, 'crashed', '崩溃记入 viewError');
  assert.equal(snap.viewError?.tabId, id);

  // rebuildActive：关闭旧页签、重建并恢复同一 URL。
  assert.equal(c.rebuildActive(), true);
  snap = c.snapshot();
  assert.equal(snap.viewError, null, '重建后错误清除');
  assert.equal(snap.tabs.length, 1, '重建为新页签');
  assert.notEqual(snap.activeTabId, id, '活动页签为新 id');
  const rebuilt = snap.tabs.find((x) => x.id === snap.activeTabId);
  assert.equal(rebuilt?.url, 'https://example.com/article', '恢复同一 URL');
  c.destroy();
});

test('BR-12: 关闭活动页签自动切到相邻（右邻优先，末位取左邻）', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  const t1 = c.openTab();
  const t2 = c.openTab();
  const t3 = c.openTab();
  c.switchTab(t2);
  c.closeTab(t2);
  assert.equal(c.snapshot().activeTabId, t3, '右邻激活');
  c.closeTab(t3);
  assert.equal(c.snapshot().activeTabId, t1, '末位取左邻');
  c.closeTab(t1);
  assert.equal(c.snapshot().activeTabId, null, '全部关闭为空');
  c.destroy();
});

test('BR-03: 元素选择只走活动页签、schema 截断、密码拒绝、导航失效', () => {
  const win = fakeWindow();
  const c = new InBrowseViewController(win, {}, () => {});
  c.setBounds({ x: 0, y: 0, width: 600, height: 800 });
  const tabID = c.openTab();
  c.navigate('https://example.com/article');
  const tab = c.snapshot().tabs.find((x) => x.id === tabID);
  const contents = win.contentView.children[0].webContents;

  assert.equal(c.startPicker().ok, true, '活动页签可开始选择');
  assert.equal(c.snapshot().pickerActive, true);
  assert.equal(contents.sent.at(-1).channel, 'inbrowse:picker:start', '只向当前页签发 start');

  const wrongSender = contents.id + 999;
  assert.equal(c.acceptPickerResult(wrongSender, { ok: true, data: { selector: '#x' } }), false, '非本页签结果忽略');

  // 密码框拒绝：preload 回传原因，主进程原样落快照，不伪造元素。
  assert.equal(c.acceptPickerResult(contents.id, { ok: false, reason: 'sensitive_control' }), true);
  assert.equal(c.snapshot().pickerError, 'sensitive_control');
  assert.equal(c.snapshot().pickedElement, null);
  assert.equal(c.snapshot().pickerActive, false, '拒绝后选择结束');

  // 正常结果：text 截断到 200，rect 取整；selector 为空视为无效。
  assert.equal(c.startPicker().ok, true);
  assert.equal(c.acceptPickerResult(contents.id, {
    ok: true,
    data: { title: '标题', url: 'https://example.com/article', selector: '#hero-title', text: '甲'.repeat(260), tag: 'h1', rect: { x: 12.4, y: 20.6, width: 120.2, height: 36.9 } },
  }), true);
  const picked = c.snapshot().pickedElement;
  assert.equal(picked.selector, '#hero-title');
  assert.equal(picked.text.length, 200, '文本最多 200 字');
  assert.deepEqual(picked.rect, { x: 12, y: 21, width: 120, height: 37 });
  assert.equal(c.snapshot().pickerError, null);

  // 页面刷新：旧选择失效并给出原因，不保留旧元素。
  assert.equal(c.startPicker().ok, true);
  contents.loadURL('https://example.com/next');
  assert.equal(c.snapshot().pickerActive, false);
  assert.equal(c.snapshot().pickerError, 'page_reloaded');
  assert.equal(c.snapshot().pickedElement, null);

  // 取消：只结束当前选择，不产生错误元素。
  assert.equal(c.startPicker().ok, true);
  c.stopPicker();
  assert.equal(c.snapshot().pickerError, 'cancelled');
  assert.equal(c.snapshot().pickedElement, null);
  c.destroy();
});

test('OT-03: 内置浏览强制隔离、关闭 DevTools、不导入 Cookie', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'in-browse.ts'), 'utf8');
  assert.match(src, /nodeIntegration: false/, '内置浏览必须关闭 nodeIntegration');
  assert.match(src, /contextIsolation: true/, '内置浏览必须开启 contextIsolation');
  assert.match(src, /sandbox: true/, '内置浏览必须开启 sandbox');
  assert.match(src, /webSecurity: true/, '内置浏览必须开启 webSecurity');
  assert.match(src, /webviewTag: false/, '内置浏览必须关闭 webviewTag');
  assert.match(src, /devTools: false/, '内置浏览必须关闭 DevTools');
  assert.equal(/cookies\.(set|remove)|setCookie|cookieImport/i.test(src), false, '不得把业务 Cookie 导入浏览分区');
});

test('OT-03: 生产主窗口关闭 DevTools，仅未打包开发态开启', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.match(src, /devTools: !app\.isPackaged/, '生产包必须关闭主窗口 DevTools');
});
