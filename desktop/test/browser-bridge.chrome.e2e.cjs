'use strict';
// DEV-AI27-02 W02 桌面纵切技术验证：真实 Chrome for Testing（156.0.8078.80，Google 官方
// branded 自动化构建，与安装版同版本线）+ 自有 MV3 扩展 + Native Messaging 宿主 + OPS 桥。
// M1 连接配对 / M2 操作闭环 / M3 掉线恢复与停止。安装版 Chrome 的"开发者模式手工加载"
// 路径按 27 文档 §15.4 在 W12 安装矩阵人工验证；本文件不冒充安装版验证。
// 运行：cd desktop && node --test test/browser-bridge.chrome.e2e.cjs

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { chromium } = require('../renderer-src/node_modules/@playwright/test');
const bridgeMod = require('../.build/browser-bridge.js');
const hostMod = require('../src/native-host/host.js');

const EXT_DIR = path.resolve(__dirname, '..', 'chrome-extension');
const CFT = path.resolve(__dirname, '..', '.tmp', 'cft', 'chrome-win64', 'chrome.exe');
const HOST_STATE = path.join(os.homedir(), '.ops-browser-bridge', 'host-state.json');
const FIXTURE_PORT = 8899;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/`;

const FIXTURE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>OPS 桥接夹具页</title></head>
<body><h1>OPS 桥接夹具页</h1>
<p id="para">这是一段用于提取验证的文本：OPS-W02-EXTRACT-OK。</p>
<button id="btn">已点击 0 次</button>
<input id="box" type="text" placeholder="文本输入" />
<input id="pwd" type="password" placeholder="密码（应拒绝自动输入）" />
<script>let n=0;document.getElementById('btn').onclick=()=>{n++;document.getElementById('btn').textContent='已点击 '+n+' 次';};</script>
</body></html>`;

function waitFor(predicate, timeoutMs, stepMs = 200, label = 'condition') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try {
        v = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (v) {
        resolve(v);
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timeout: ${label}`));
      } else {
        setTimeout(tick, stepMs);
      }
    };
    tick();
  });
}

async function readHostPid() {
  return readHostPidSync();
}

function readHostPidSync() {
  try {
    const state = JSON.parse(fs.readFileSync(HOST_STATE, 'utf8'));
    return state.pid || null;
  } catch {
    return null;
  }
}

function dispatchOk(bridge, action, payload, requestId) {
  return bridge.dispatch(action, payload, requestId);
}

test('W02 M1/M2/M3 真实 Chrome 纵切：配对→操作闭环→掉线恢复→停止', { timeout: 240_000, concurrency: 1 }, async (t) => {
  killStaleHosts();
  // ---- 夹具与桥 ----
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => server.listen(FIXTURE_PORT, '127.0.0.1', resolve));
  t.after(() => server.close());

  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-m-')), 'ledger.json');
  const bridge = new bridgeMod.BrowserBridge(new bridgeMod.CommandLedger(ledgerPath), {
    port: hostMod.OPS_PORT,
    controlPort: null,
    autoPair: true,
    actionTimeoutMs: 1000,
  });
  await bridge.start();
  t.after(() => bridge.stop());

  // ---- 启动真实 Chrome（CfT）并等待配对 ----
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CFT,
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--no-default-browser-check'],
  });
  t.after(() => {
    try { context.close(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }, 3000);
  });

  // 只认带 pid 的新宿主 hello（残留旧宿主无 pid 字段，其配对不算数）
  await waitFor(() => bridge.state === 'paired' && Boolean(bridge.hostInfo && bridge.hostInfo.pid), 45_000, 300, 'M1 pairing').catch((err) => {
    throw new Error(`M1 配对失败，桥事件：${JSON.stringify(bridge.snapshot().events.slice(-10))} / ${err.message}`);
  });
  assert.equal(bridge.state, 'paired', 'M1: 桥进入 paired');
  assert.ok(bridge.hostInfo && bridge.hostInfo.host_instance_id, 'M1: 宿主实例 ID 上报');
  const worker = context.serviceWorkers()[0];
  assert.ok(worker, 'M1: 扩展 service worker 存在');
  const extState = await worker.evaluate(() => new Promise((r) => chrome.storage.local.get(['paired', 'extension_instance_id'], r)));
  assert.equal(extState.paired, true, 'M1: 扩展侧配对生效');
  assert.ok(extState.extension_instance_id, 'M1: 扩展实例 ID 存在');

  // ---- M2 操作闭环 ----
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await new Promise((r) => setTimeout(r, 500));
  const tabsResult = dispatchOk(bridge, 'tabs_list', {});
  assert.equal(tabsResult.accepted, true, 'M2: tabs_list 受理');
  const tabsCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === tabsResult.request_id && (e.state === 'succeeded' || e.state === 'failed')), 15_000, 150, 'tabs_list result').catch((err) => {
    throw new Error(`tabs_list 无回执：${JSON.stringify(bridge.snapshot().events.slice(-12))} ledger=${JSON.stringify(bridge.ledger.list())} / ${err.message}`);
  });
  assert.equal(tabsCmd.state, 'succeeded', 'M2: tabs_list 成功');
  const tabId = tabsCmd.result.payload.tabs.find((x) => x.origin.includes('127.0.0.1')).id;
  assert.ok(tabId, 'M2: 夹具标签可见（标题+域名摘要）');
  assert.ok(tabsCmd.result.payload.tabs.every((x) => !/\?|&|=/.test(x.origin)), 'M2: 标签摘要去除敏感查询串');

  const nav = dispatchOk(bridge, 'navigate', { tab_id: tabId, url: FIXTURE_URL });
  const navCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === nav.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 20_000, 150, 'navigate result');
  assert.equal(navCmd.state, 'succeeded', 'M2: navigate 成功并回实际地址');

  const obs = dispatchOk(bridge, 'observe', { tab_id: tabId });
  const obsCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === obs.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'observe result');
  if (obsCmd.state !== 'succeeded') {
    throw new Error(`observe 失败：${JSON.stringify(obsCmd.result)}`);
  }
  assert.equal(obsCmd.state, 'succeeded', 'M2: observe 成功');
  const observed = obsCmd.result.payload;
  assert.ok(observed.doc_rev, 'M2: 返回 document revision');
  assert.ok(observed.nodes.length > 0 && observed.node_total >= observed.nodes.length, 'M2: 返回可见交互节点（上限内）');
  assert.ok(observed.nodes.length <= 300, 'M2: 节点数受 300 上限约束');
  assert.ok(observed.text_head.includes('OPS-W02-EXTRACT-OK'), 'M2: 文本观察包含夹具段落');
  const btnRef = observed.nodes.find((n) => n.name.includes('已点击'));
  const boxRef = observed.nodes.find((n) => n.tag === 'input' && n.type === 'text');
  assert.ok(btnRef && boxRef, 'M2: 按钮与输入框在观察结果中');

  const click = dispatchOk(bridge, 'click', { tab_id: tabId, ref: btnRef.ref, doc_rev: observed.doc_rev });
  const clickCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === click.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'click result');
  assert.equal(clickCmd.state, 'succeeded', 'M2: 受控点击成功');
  const afterClick = await page.textContent('#btn');
  assert.equal(afterClick, '已点击 1 次', 'M2: 页面真实状态变化');

  const type = dispatchOk(bridge, 'type', { tab_id: tabId, ref: boxRef.ref, text: '中文输入验证ABC123', doc_rev: observed.doc_rev });
  const typeCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === type.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'type result');
  assert.equal(typeCmd.state, 'succeeded', 'M2: 中文+ASCII 输入成功');
  assert.equal(await page.inputValue('#box'), '中文输入验证ABC123', 'M2: 页面输入值核验');

  const pwdRef = observed.nodes.find((n) => n.tag === 'input' && n.type === 'password');
  assert.ok(pwdRef, 'M2: 密码控件在观察中可见（仅元数据）');
  const pwdType = dispatchOk(bridge, 'type', { tab_id: tabId, ref: pwdRef.ref, text: 'secret', doc_rev: observed.doc_rev });
  const pwdCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === pwdType.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'pwd type result');
  assert.equal(pwdCmd.state, 'failed', 'M2 反例: 密码控件输入被拒');
  assert.equal(pwdCmd.result.error_code, 'sensitive_control', 'M2 反例: 拒绝码 sensitive_control');
  assert.equal(await page.inputValue('#pwd'), '', 'M2 反例: 密码框未被写入');

  const extract = dispatchOk(bridge, 'extract', { tab_id: tabId, selector: '#para', doc_rev: observed.doc_rev });
  const extractCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === extract.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'extract result');
  assert.equal(extractCmd.state, 'succeeded', 'M2: extract 成功');
  assert.ok(extractCmd.result.payload.text.includes('OPS-W02-EXTRACT-OK'), 'M2: 提取内容正确');

  const shot = dispatchOk(bridge, 'screenshot', { tab_id: tabId });
  const shotCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === shot.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 20_000, 150, 'screenshot result');
  assert.equal(shotCmd.state, 'succeeded', 'M2: 截图成功');
  assert.ok(shotCmd.result.payload.data_url.startsWith('data:image/jpeg'), 'M2: 截图回执为受控图像');

  // doc_rev 失效反例：重新 observe 后旧 doc_rev 不再可用
  const nav2 = dispatchOk(bridge, 'navigate', { tab_id: tabId, url: FIXTURE_URL });
  await waitFor(() => bridge.ledger.list().find((e) => e.request_id === nav2.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 20_000, 150, 'navigate2');
  const stale = dispatchOk(bridge, 'click', { tab_id: tabId, ref: btnRef.ref, doc_rev: observed.doc_rev });
  const staleCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === stale.request_id && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'stale click result');
  assert.equal(staleCmd.state, 'failed', 'M2 反例: 旧 doc_rev 点击被拒');
  assert.equal(staleCmd.result.error_code, 'doc_rev_changed', 'M2 反例: 失效码 doc_rev_changed');

  // ---- M3 场景 1：杀宿主进程 → 派发无回执 → unknown_outcome → 扩展重连恢复 ----
  const hostPid = await readHostPid();
  assert.ok(hostPid, 'M3: 宿主 pid 记录在案');
  const m3cmd = dispatchOk(bridge, 'observe', { tab_id: tabId }, 'm3-unknown-1');
  assert.equal(m3cmd.accepted, true, 'M3: 派发受理');
  spawnSync('taskkill', ['/PID', String(hostPid), '/F', '/T'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  bridge.sweep();
  await waitFor(() => bridge.ledger.get('m3-unknown-1').state === 'unknown_outcome', 15_000, 200, 'unknown_outcome');
  assert.equal(bridge.ledger.get('m3-unknown-1').state, 'unknown_outcome', 'M3: 派发后无回执进入 unknown_outcome');
  const replayUnknown = bridge.dispatch('observe', { tab_id: tabId }, 'm3-unknown-1');
  assert.equal(replayUnknown.accepted, true, 'M3: 同编号重派走幂等路径');
  assert.equal(replayUnknown.state, 'unknown_outcome', 'M3: 幂等重派返回原状态 unknown_outcome');
  assert.match(replayUnknown.reason || '', /idempotent/, 'M3: 幂等重派不重发动作');
  await waitFor(() => bridge.state === 'paired', 45_000, 300, 'M3 reconnect pair');
  const recovered = dispatchOk(bridge, 'tabs_list', {}, 'm3-recover-1');
  const recoveredCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === 'm3-recover-1' && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'recover tabs_list');
  assert.equal(recoveredCmd.state, 'succeeded', 'M3: 恢复后新命令正常');

  // ---- M3 场景 2/3：关闭 Chrome → 断开；重启 → 重新配对，账本不重放 ----
  const ledgerLenBeforeClose = bridge.ledger.list().length;
  const unknownBeforeClose = bridge.ledger.list().filter((e) => e.state === 'unknown_outcome').length;
  await context.close();
  await waitFor(() => bridge.socket === null, 30_000, 300, 'M3 close disconnect');
  const eventsAfterClose = bridge.snapshot().events.map((e) => e.message).join('|');
  assert.ok(eventsAfterClose.includes('host disconnected'), 'M3: Chrome 关闭后桥感知断开');
  await waitFor(() => {
    const pid = readHostPidSync();
    return !pid || !processAlive(pid);
  }, 20_000, 500, 'host exit');

  const context2 = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CFT,
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--no-default-browser-check'],
  });
  t.after(() => {
    try { context2.close(); } catch {}
  });
  await waitFor(() => bridge.state === 'paired', 60_000, 300, 'M3 restart repair');
  // 配对确认到达扩展并存密钥需要一小段时间，避免重启后首个命令竞态。
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(bridge.ledger.list().length, ledgerLenBeforeClose + 0, 'M3: 重启后账本未自动重放（数量仅增不减）');
  assert.equal(bridge.ledger.list().filter((e) => e.state === 'unknown_outcome').length, unknownBeforeClose, 'M3: unknown_outcome 不被重置或重放');
  const afterRestart = dispatchOk(bridge, 'tabs_list', {}, 'm3-restart-1');
  const afterRestartCmd = await waitFor(() => bridge.ledger.list().find((e) => e.request_id === 'm3-restart-1' && e.state !== 'dispatched' && e.state !== 'queued'), 15_000, 150, 'restart tabs_list');
  assert.equal(afterRestartCmd.state, 'succeeded', 'M3: 重启后可重新派发');

  // ---- 停止/撤销：本机 generation 递增，拒新动作 p95≤200ms（30 样本，本机状态机口径）----
  const samples = [];
  for (let i = 0; i < 30; i += 1) {
    bridge.state = 'paired'; // 测试内部恢复配对态以重复测量
    const t0 = process.hrtime.bigint();
    bridge.revoke('perf-measure');
    const r = bridge.dispatch('tabs_list', {}, `perf-${i}`);
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.accepted, false, `M3: 撤销后第 ${i + 1} 次派发被拒`);
    samples.push(dtMs);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  assert.ok(p95 <= 200, `M3: 停止→拒新动作 p95=${p95.toFixed(2)}ms ≤ 200ms`);
});

function processAlive(pid) {
  const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
  return probe.status === 0 && String(probe.stdout).includes(String(pid));
}

/** 清理此前验证运行残留的宿主进程（仅按 host.js 命令行匹配，不触碰其他 node/chrome）。 */
function killStaleHosts() {
  const probe = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*native-host*host.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
    { stdio: 'ignore', timeout: 20_000 },
  );
  void probe;
}
