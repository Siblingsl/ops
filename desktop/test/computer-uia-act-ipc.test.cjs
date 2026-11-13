'use strict';
// DEV-CU P3-6（§P3-6 步骤 5）：computer:uia-act / uia-invalidate 两通道定向测试。
// mock worker（经 host 注入）验证：三通道可达、参数越界、错误映射、无任意 cmd 透传。
// 不启动真实 Electron / 真实窗口 / 真实 UIA。

const assert = require('node:assert/strict');
const test = require('node:test');

// 直接构造 ipc/computer.ts 编译产物（.build）所需的依赖注入，
// 与 desktop/src/main.ts 的真实接线同形（ipcHandle / requireComputerCaller）。
const path = require('node:path');
const { loadCompiledIpcComputer } = require('./helpers/computer-ipc-loader.cjs');

function makeHarness() {
  const handlers = new Map();
  const calls = [];
  const ipcHandle = (channel, handler) => handlers.set(channel, handler);
  const requireComputerCaller = (event) => {
    if (event && event.computerCallerValid === false) {
      const e = new Error('forbidden');
      e.computerCallerReject = true;
      throw e;
    }
  };
  const { registerComputerIpcHandlers } = loadCompiledIpcComputer();
  // mock host：记录调用并按脚本应答。host 是模块级单例引用——必须在 register 之前注入，
  // 否则 handler 解引用到的 hostRef 是 undefined（合法入参会走 catch 变 500 形状）。
  const hostCalls = [];
  const host = {
    listWindows: async () => [],
    readUIA: async () => ({ ok: true, window: 'w', controls: [] }),
    invokeUIA: async () => ({ ok: true, action: 'setvalue' }),
    observe: async (input) => { hostCalls.push(['observe', input]); return { ok: true, snapshot_id: 's1', ref_count: 0 }; },
    act: async (input) => { hostCalls.push(['act', input]); return { ok: true, action: input.action, disposition: { delivery: 'delivered_verified', retry: 'unsafe' } }; },
    invalidate: async (grantId) => { hostCalls.push(['invalidate', grantId]); return { ok: true, cleared: 2 }; },
    captureWindow: async () => ({}),
    invalidateCaptures: async () => ({ ok: true }),
    captureEvidence: async () => ({}),
    ping: async () => true,
  };
  setHostOnCompiled(host);
  registerComputerIpcHandlers({ ipcHandle, requireComputerCaller });
  return { handlers, calls, hostCalls, host };
}

async function callChannel(h, channel, event, payload) {
  const handler = h.handlers.get(channel);
  assert.ok(handler, `通道 ${channel} 应已注册`);
  return await handler(event, payload);
}

const okEvent = { computerCallerValid: true };
const badEvent = { computerCallerValid: false };

test('P3-6: 三通道已注册（observe/act/invalidate）', () => {
  const h = makeHarness();
  // host 注入发生在 registerComputerIpcHandlers 内部闭包，通道注册即可断言存在
  for (const ch of ['computer:uia-observe', 'computer:uia-act', 'computer:uia-invalidate']) {
    assert.ok(h.handlers.has(ch), `${ch} 应注册`);
  }
  // 无任意 cmd 透传： computer:* 只允许固定意图集合
  const fixed = [
    'computer:list-windows', 'computer:uia-read', 'computer:uia-observe',
    'computer:uia-invoke', 'computer:uia-act', 'computer:uia-invalidate',
  ];
  for (const ch of h.handlers.keys()) {
    assert.ok(fixed.includes(ch) || ch.startsWith('computer:capture'), `通道 ${ch} 必须是固定意图`);
  }
});

test('P3-6: computer:uia-act 参数逐个校验（pid/grant/generation/ref/action）', async () => {
  const h = makeHarness();
  const base = {
    pid: 1234, ref: '@sabc123:e1', grant_id: 'g-1', generation: 3,
    action: 'click', value: null, target_summary: '记事本',
  };
  // 合法入参 → host.act 被调，参数原样转发
  const out = await callChannel(h, 'computer:uia-act', okEvent, { ...base });
  assert.equal(out.ok, true);
  assert.equal(h.hostCalls.at(-1)[0], 'act');
  assert.equal(h.hostCalls.at(-1)[1].ref, '@sabc123:e1');
  assert.equal(h.hostCalls.at(-1)[1].generation, 3);
  // 越界逐项拒绝
  for (const bad of [
    {}, // 全空
    { ...base, pid: 0 },
    { ...base, pid: 1.5 },
    { ...base, grant_id: '' },
    { ...base, grant_id: 'x'.repeat(65) },
    { ...base, generation: -1 },
    { ...base, generation: 1.5 },
    { ...base, ref: 'e1' },
    { ...base, ref: '@sabc:e0' },
    { ...base, ref: '@ab:e1' },
    { ...base, action: '' },
  ]) {
    await assert.rejects(() => callChannel(h, 'computer:uia-act', okEvent, bad),
      (e) => e.message === 'computer_uia_params_invalid',
      `应拒绝 ${JSON.stringify(bad).slice(0, 60)}`);
  }
  // value 超 32768：与既有 uia-invoke 同款——slice 截断放行（上限是截断语义，不是拒绝）。
  const long = await callChannel(h, 'computer:uia-act', okEvent, { ...base, value: 'x'.repeat(32769) });
  assert.equal(long.ok, true);
  assert.equal(h.hostCalls.at(-1)[1].value.length, 32768);
});

test('P3-6: computer:uia-act 错误映射（worker 语义码透传，其余统一 unavailable）', async () => {
  const h = makeHarness();
  const base = {
    pid: 1234, ref: '@sabc123:e1', grant_id: 'g-1', generation: 3,
    action: 'click', value: null, target_summary: '记事本',
  };
  for (const [code, want] of [
    ['computer_target_changed', 'computer_target_changed'],
    ['worker_timeout', 'worker_timeout'],
    ['some_other_error', 'computer_worker_unavailable'],
  ]) {
    const harness = makeHarness();
    harness.host.act = async () => { throw new Error(code); };
    setHostOnCompiled(harness.host);
    const outN = await callChannel(harness, 'computer:uia-act', okEvent, base);
    assert.equal(outN.ok, false);
    assert.equal(outN.error, want, `${code} 应映射为 ${want}`);
  }
  // host 引用切换的正确路径：loader 的 setComputerWorkerHost
  const h2 = makeHarness();
  h2.host.act = async () => { throw new Error('computer_stale_ref'); };
  setHostOnCompiled(h2.host);
  const out = await callChannel(h2, 'computer:uia-act', okEvent, base);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'computer_stale_ref');

  const h3 = makeHarness();
  h3.host.act = async () => { throw new Error('totally_unknown'); };
  setHostOnCompiled(h3.host);
  const out2 = await callChannel(h3, 'computer:uia-act', okEvent, base);
  assert.equal(out2.ok, false);
  assert.equal(out2.error, 'computer_worker_unavailable');
});

test('P3-6: computer:uia-invalidate 固定意图 + grant_id 校验', async () => {
  const h = makeHarness();
  setHostOnCompiled(h.host);
  const out = await callChannel(h, 'computer:uia-invalidate', okEvent, { grant_id: 'g-9' });
  assert.equal(out.ok, true);
  assert.equal(out.cleared, 2);
  assert.equal(h.hostCalls.at(-1)[0], 'invalidate');
  assert.equal(h.hostCalls.at(-1)[1], 'g-9');
  for (const bad of [{}, { grant_id: '' }, { grant_id: 'x'.repeat(65) }]) {
    await assert.rejects(() => callChannel(h, 'computer:uia-invalidate', okEvent, bad),
      (e) => e.message === 'computer_uia_params_invalid');
  }
});

test('P3-6: requireComputerCaller 来源校验不被绕过', async () => {
  const h = makeHarness();
  setHostOnCompiled(h.host);
  for (const ch of ['computer:uia-act', 'computer:uia-invalidate']) {
    await assert.rejects(() => callChannel(h, ch, badEvent, { grant_id: 'g' }),
      (e) => e.computerCallerReject === true, `${ch} 来源校验必须先于业务`);
  }
});

function setHostOnCompiled(host) {
  const { setComputerWorkerHost } = loadCompiledIpcComputer();
  setComputerWorkerHost(host);
}
