'use strict';
// DT-02（docs/33 §10.3）：诊断 IPC 来源校验与返回值语义。
// 缺陷（修复前）：
// ① 4 个 ops-bridge-diag:* handler 均忽略 event，无来源窗口校验——而产品路径
//    ensureProductBridge 无条件 registerIpc()，业务窗（或任何拿到 ipcRenderer 的
//    frame）也能调用 confirm-pairing / revoke / dispatch。
// ② revoke 在桥未运行时仍返回 {ok:true}（getActiveBridge()?.revoke 短路后无条件
//    ok:true）——「撤销成功」语义不实；confirm-pairing/dispatch 未运行时已是
//    ok:false/accepted:false，四通道口径不一致。
// 修复：
// ① registerDiagnosticsIpc(callerGuard) 注册时注入来源守卫；生产 guard 由
//    ensureProductBridge 注入（校验 event.sender 必须是诊断窗 webContents 主框架，
//    URL 含 diagnostics.html）；guard 拒绝时 handler 抛错，invoke 直接 reject。
// ② revoke 未运行/未配对时如实返回 {ok:false, reason}；已撤销返回 {ok:true,generation}。
// ③ 诊断窗资产 diagnostics.html 进入构建产物（此前从未复制到 .build/browser-bridge/，
//    诊断窗 loadFile 必然失败——与 E-15 同类的资产漏配，本轮一并修复并验证）。

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const bridge = require('../.build/browser-bridge.js');

// ---------------------------------------------------------------------------
// 模拟 ipcMain / 诊断窗 event：guard 按 main.ts 生产语义注入后逐通道验证
// ---------------------------------------------------------------------------

function mkElectronMock() {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    on() {},
  };
  return { ipcMain, handlers };
}

/** 模拟一次来自指定窗口的 invoke。 */
async function invoke(handlers, channel, senderOk, ...args) {
  const handler = handlers.get(channel);
  assert.ok(handler, `通道 ${channel} 应已注册`);
  const event = {
    sender: { id: senderOk ? 77 : 1 },
    senderFrame: { url: senderOk ? 'file:///.../browser-bridge/diagnostics.html' : 'https://ops.example.com/workspace' },
  };
  try {
    return { ok: true, value: await handler(event, ...args) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 生产语义的 guard：只放行诊断窗主框架（与 main.ts requireComputerCaller 同构）。 */
function productionGuard(diagWebContentsId) {
  return (event) => {
    if (event.sender?.id !== diagWebContentsId
      || !String(event.senderFrame?.url ?? '').includes('diagnostics.html')) {
      throw new Error('不允许此窗口调用浏览器桥诊断意图。');
    }
  };
}

function testBridge(t) {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-diag-ipc-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const b = new bridge.BrowserBridge(ledger, { port: 0, controlPort: null, seqStatePath: null });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return b;
}

// ---------------------------------------------------------------------------
// ① 来源校验：非诊断窗调用四个通道一律拒绝
// ---------------------------------------------------------------------------

test('DT-02: 注入生产 guard 后，四个诊断通道拒绝非诊断窗来源', async (t) => {
  const b = testBridge(t);
  const { ipcMain, handlers } = mkElectronMock();
  bridge.registerDiagnosticsIpcForTest(ipcMain, productionGuard(77), () => b);

  for (const channel of ['ops-bridge-diag:get-state', 'ops-bridge-diag:confirm-pairing', 'ops-bridge-diag:revoke', 'ops-bridge-diag:dispatch']) {
    const result = await invoke(handlers, channel, false, 'navigate', {});
    assert.equal(result.ok, false, `${channel} 非诊断窗应拒绝`);
    assert.match(String(result.error.message), /不允许此窗口调用浏览器桥诊断意图/);
  }
  // 桥未被 guard 拒绝路径触碰：revoke 未被误执行（generation 不变）。
  assert.equal(b.generation.n, 0);
});

test('DT-02: 诊断窗来源放行，get-state 返回快照', async (t) => {
  const b = testBridge(t);
  const { ipcMain, handlers } = mkElectronMock();
  bridge.registerDiagnosticsIpcForTest(ipcMain, productionGuard(77), () => b);
  const result = await invoke(handlers, 'ops-bridge-diag:get-state', true);
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'unpaired');
  assert.ok('generation' in result.value && 'ledger' in result.value && 'events' in result.value);
});

test('DT-02: 未注入 guard（缺省严格）时任何来源都拒绝——注册必须显式给守卫', async (t) => {
  const b = testBridge(t);
  const { ipcMain, handlers } = mkElectronMock();
  bridge.registerDiagnosticsIpcForTest(ipcMain, undefined, () => b);
  const result = await invoke(handlers, 'ops-bridge-diag:get-state', true);
  assert.equal(result.ok, false, '缺省 guard 必须拒绝（不允许无守卫注册）');
});

// ---------------------------------------------------------------------------
// ② revoke 返回值语义：桥未运行如实 ok:false；运行时 ok:true + generation
// ---------------------------------------------------------------------------

test('DT-02: revoke 在桥未运行时返回 {ok:false,reason}，不再无条件 ok:true', async (t) => {
  const { ipcMain, handlers } = mkElectronMock();
  bridge.registerDiagnosticsIpcForTest(ipcMain, productionGuard(77), () => null);
  const result = await invoke(handlers, 'ops-bridge-diag:revoke', true);
  assert.equal(result.ok, true, 'handler 本身不应抛错');
  assert.deepEqual(result.value, { ok: false, reason: 'bridge not running' });
});

test('DT-02: revoke 在桥运行时返回 {ok:true,generation} 且递增 generation', async (t) => {
  const b = testBridge(t);
  const { ipcMain, handlers } = mkElectronMock();
  bridge.registerDiagnosticsIpcForTest(ipcMain, productionGuard(77), () => b);
  const before = b.generation.n;
  const result = await invoke(handlers, 'ops-bridge-diag:revoke', true);
  assert.deepEqual(result.value, { ok: true, generation: before + 1 });
  assert.equal(b.generation.n, before + 1);
  assert.equal(b.state, 'revoked');
});

test('DT-02: confirm-pairing 与 dispatch 未运行时的拒绝语义保持既有口径', async (t) => {
  const { ipcMain, handlers } = mkElectronMock();
  bridge.registerDiagnosticsIpcForTest(ipcMain, productionGuard(77), () => null);
  const confirm = await invoke(handlers, 'ops-bridge-diag:confirm-pairing', true);
  assert.deepEqual(confirm.value, { ok: false, reason: 'bridge not running' });
  const dispatch = await invoke(handlers, 'ops-bridge-diag:dispatch', true, 'navigate', {});
  assert.equal(dispatch.value.accepted, false);
  assert.equal(dispatch.value.reason, 'bridge not running');
});

// ---------------------------------------------------------------------------
// ③ 诊断窗资产：diagnostics.html 必须进入构建产物（修复前从未复制）
// ---------------------------------------------------------------------------

test('DT-02: .build/browser-bridge/diagnostics.html 存在（诊断窗 loadFile 才能成功）', () => {
  const fs = require('node:fs');
  const target = path.join(__dirname, '..', '.build', 'browser-bridge', 'diagnostics.html');
  assert.ok(fs.existsSync(target), '构建产物应包含 browser-bridge/diagnostics.html');
  const html = fs.readFileSync(target, 'utf8');
  assert.ok(html.includes('opsBridgeDiag'), '诊断页应引用 preload 暴露的 opsBridgeDiag');
});

test('DT-02: 源码层诊断 handler 不再忽略 event（guard 已接线）', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser-bridge.ts'), 'utf8');
  assert.ok(source.includes('registerDiagnosticsIpc(callerGuard'), '注册函数应接受 callerGuard 参数');
  assert.ok(source.includes('callerGuard('), 'guard 应在 handler 内被调用');
});
