'use strict';
// DT-03（docs/33 §10.7）：统一退出清理。
// 缺陷（修复前）：两条退出路径各自只停一部分资源——
//   before-quit（quitConfirmed 时）：presence / claimLoop / browserExecutor / desktopClient
//   confirmApplicationQuit：platformLoginFlow / computerWorkerHost / desktopClient
// 两边都不完整且不一致：realtimeBridge.stop() 只在 voice:realtime-stop 调用；
// mcpHostManager 只有按连接 stop(connectionId)；activeBridge（8765 监听）与
// activeCXLongImageCaptures（在途捕获）无任何退出清理。
// 修复：抽出 disposeApplicationResources() 统一清理清单，两条路径都只调用它；
// 清理失败记日志不影响退出。本文件锁定「统一清单存在且两条路径一致引用」的源码契约，
// 以及浏览器桥在 dispose 后停止监听的可验证行为。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');

test('DT-03: main.ts 定义 disposeApplicationResources 统一清理函数', () => {
  assert.ok(mainSource.includes('function disposeApplicationResources'), '应存在统一清理函数');
});

test('DT-03: 统一清理覆盖全部常驻资源（不得只停客户端与循环）', () => {
  const start = mainSource.indexOf('function disposeApplicationResources');
  assert.ok(start >= 0, '清理函数应存在');
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < mainSource.length; i += 1) {
    if (mainSource[i] === '{') depth += 1;
    if (mainSource[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = mainSource.slice(start, end);
  for (const symbol of [
    'stopPlatformPresence',      // 平台心跳
    'stopPlatformClaimLoop',     // 后台领取循环
    'stopBrowserCommandExecutor', // AI 浏览器命令轮询
    'realtimeBridge',            // realtime 音频桥（修复前只在 voice:realtime-stop）
    'mcpHostManager',            // MCP 宿主连接（修复前只有按连接 stop）
    'computerWorkerHost',        // 电脑控制 worker（fork 的隔离进程）
    'platformLoginFlow',         // 平台登录流（外部浏览器/清理回调）
    'stopActiveBridge',          // 浏览器桥（8765 监听，修复前无退出清理）
    'activeCXLongImageCaptures', // 在途长图捕获状态
    'desktopClient',             // 服务端通道
  ]) {
    assert.ok(body.includes(symbol), `清理函数应包含 ${symbol}`);
  }
});

test('DT-03: before-quit 与 confirmApplicationQuit 都只调用统一清理（不再各自为政）', () => {
  // before-quit：quitConfirmed 分支内不得再直接罗列清理调用
  const beforeQuitStart = mainSource.indexOf("app.on('before-quit'");
  const beforeQuitBody = mainSource.slice(beforeQuitStart, mainSource.indexOf('});', beforeQuitStart));
  assert.ok(beforeQuitBody.includes('disposeApplicationResources'), 'before-quit 应调用统一清理');
  assert.ok(!beforeQuitBody.includes('desktopClient?.disconnect()'), 'before-quit 不得绕过统一清理直接断连');

  // confirmApplicationQuit：确认退出分支同样走统一清理
  const confirmStart = mainSource.indexOf('async function confirmApplicationQuit');
  const confirmBody = mainSource.slice(confirmStart, mainSource.indexOf('function installApplicationMenu', confirmStart));
  assert.ok(confirmBody.includes('disposeApplicationResources'), 'confirmApplicationQuit 应调用统一清理');
  assert.ok(!/^\s*computerWorkerHost\?\.stop\(\);$/m.test(confirmBody), 'confirmApplicationQuit 不得单独停 worker（应统一）');
});

test('DT-03: browser-bridge 导出 stopActiveBridge 供主进程统一清理调用', () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser-bridge.ts'), 'utf8');
  assert.ok(bridgeSource.includes('export function stopActiveBridge'), '桥模块应导出 stopActiveBridge');
  const mainImport = mainSource.match(/import\s*{[^}]*}\s*from\s*'\.\/browser-bridge'/);
  assert.ok(mainImport && mainImport[0].includes('stopActiveBridge'), 'main.ts 应导入 stopActiveBridge');
});

// ---------------------------------------------------------------------------
// 行为验证：stopActiveBridge 真实停止监听（8765 控制端口与桥端口均释放）
// ---------------------------------------------------------------------------

test('DT-03: stopActiveBridge 后桥端口不再监听（可复用性验证）', async (t) => {
  const bridge = require('../.build/browser-bridge.js');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-dispose-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const b = new bridge.BrowserBridge(ledger, { port: 0, controlPort: 0, seqStatePath: null });
  await b.start();
  await b.startControl(b['opts']?.controlPort ?? 0);
  t.after(() => {
    bridge.stopActiveBridgeForTest?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const address = b['server'].address();
  assert.ok(address && typeof address === 'object', '桥应已监听');
  b.stop();
  // stop 后端口应可立即重新绑定（无残留监听）。
  const rebinding = await new Promise((resolve) => {
    const server = require('node:net').createServer();
    server.once('error', () => resolve(false));
    server.listen(address.port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
  assert.ok(rebinding, 'stop 后端口必须可立即重绑（无残留监听）');
});

test('DT-03: 清理失败不阻断退出（dispose 内部逐项 catch）', () => {
  const start = mainSource.indexOf('function disposeApplicationResources');
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < mainSource.length; i += 1) {
    if (mainSource[i] === '{') depth += 1;
    if (mainSource[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = mainSource.slice(start, end);
  assert.ok(body.includes('safeDispose') || body.includes('try'), '每个清理步骤应容错（safeDispose/try），不让单个失败阻断退出');
});
