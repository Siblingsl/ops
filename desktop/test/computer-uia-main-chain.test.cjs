'use strict';
// T7 / CF-DESK-08：DT-04 UIA 主链路「IPC 段」定向验收补强（2026-11-12）。
//
// 背景：docs/08:4124-4133 已于 2026-11-11 打通 worker→host→IPC→preload→渲染器，
// 并行会话 DEV-CU / DT-08 片 3 又把它拆到 src/ipc/computer.ts。但既有定向测试
// computer-uia-ipc.test.cjs 只覆盖 ①host（mock worker）与 ②preload（mock
// ipcRenderer.invoke），中间「主进程 IPC 注册点」一段被 mock 绕过，没有可执行断言。
//
// 本文件只补这一段：用 .build/ipc/computer.js 注入 mock host + mock
// requireComputerCaller，验证注册点集合、调用方校验顺序、参数校验、失败透出，
// 并把 IPC handler 真正串到 preload 白名单，构成「worker 输出 → host → IPC →
// preload → 渲染器」的完整可达链路与 C09 脱敏断言。
//
// 零产品代码改动；不启动真实 Electron / 真实窗口 / 真实 UIA。
// 运行前须先 `cd desktop && pnpm build`（.build/ipc/computer.js 为编译产物）。
//
// 开项期间并行会话 DEV-CU P2-7 在 src/ipc/computer.ts 新增了
// computer:uia-observe 通道（本轮不回退、不覆盖）。故注册点断言只钉
// 「必须含 3 个 DT-04 既有固定意图」与「不得夹带截图 / 批量 / 外发」，
// 不把通道总数硬编码成 3；docs/08 实施记录如实登记该并行改动。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const IPC_BUILD = path.join(ROOT, '.build', 'ipc', 'computer.js');
const PRELOAD_BUILD = path.join(ROOT, '.build', 'business-ui-preload.js');

const { setComputerWorkerHost, registerComputerIpcHandlers } = require(IPC_BUILD);

const CHANNELS = ['computer:list-windows', 'computer:uia-read', 'computer:uia-invoke'];

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
}
function readRepo(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** 与 preload 逐控件四键白名单一致的干净 worker 输出。 */
function cleanView() {
  return {
    ok: true,
    window: '记事本',
    controls: [{ id: 'e1', type: 'Edit', name: '文本', value: 'abc' }],
  };
}

/** 注册真实编译产物 IPC handler，注入 mock host 与 mock 调用方校验。 */
function harness(opts = {}) {
  const handlers = new Map();
  const callerCalls = [];
  const hostCalls = [];
  const events = [];
  let rejectCaller = Boolean(opts.rejectCaller);

  const host = {
    async listWindows() {
      events.push('listWindows');
      hostCalls.push(['listWindows']);
      return [{ pid: 4242, title: '记事本 - 无标题', process: 'notepad.exe', forbidden: false }];
    },
    async readUIA(pid, targetSummary) {
      events.push('readUIA');
      hostCalls.push(['readUIA', pid, targetSummary]);
      if (opts.readError) throw new Error(opts.readError);
      return opts.readResult !== undefined ? opts.readResult : cleanView();
    },
    async invokeUIA(pid, automationId, value, targetSummary) {
      events.push('invokeUIA');
      hostCalls.push(['invokeUIA', pid, automationId, value, targetSummary]);
      if (opts.invokeError) throw new Error(opts.invokeError);
      return opts.invokeResult !== undefined ? opts.invokeResult : { ok: true, action: 'setvalue' };
    },
  };

  setComputerWorkerHost(host);
  registerComputerIpcHandlers({
    ipcHandle: (channel, handler) => handlers.set(channel, handler),
    requireComputerCaller: (event) => {
      callerCalls.push(event);
      events.push('caller');
      if (rejectCaller) throw new Error('不允许此窗口调用本机选窗。');
    },
  });

  return {
    handlers,
    hostCalls,
    callerCalls,
    events,
    setRejectCaller: (v) => { rejectCaller = v; },
    invoke(channel, raw) {
      const handler = handlers.get(channel);
      assert.ok(handler, `通道 ${channel} 必须已注册`);
      return handler({ senderFrame: {}, sender: {} }, raw);
    },
  };
}

/** 加载编译产物 preload，用 contextBridge 捕获暴露给渲染器的固定意图。 */
function loadPreload(electron) {
  const originalLoad = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(PRELOAD_BUILD)];
    require(PRELOAD_BUILD);
  } finally {
    Module._load = originalLoad;
  }
}

/** 完整链路：preload 的 ipcRenderer.invoke 直接转发到真实 IPC handler。 */
function fullChain(opts = {}) {
  const h = harness(opts);
  const exposed = {};
  const channelsSeen = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) {
      channelsSeen.push(channel);
      const handler = h.handlers.get(channel);
      if (!handler) return Promise.resolve({ ok: false, error: 'unknown_channel' });
      return Promise.resolve(handler({ senderFrame: {}, sender: {} }, payload));
    },
  };
  loadPreload({
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer,
  });
  assert.ok(exposed.opsDesktopUI, 'preload 必须暴露 opsDesktopUI');
  return { ...h, api: exposed.opsDesktopUI, channelsSeen };
}

// ---------------------------------------------------------------------------
// ① IPC 注册点：固定意图、不夹带截图 / 批量 / 开放式执行
// ---------------------------------------------------------------------------

test('T7/CF-DESK-08: IPC 注册点含 3 个 DT-04 固定意图，不夹带截图 / 批量 / 开放执行通道', () => {
  const h = harness();
  const keys = [...h.handlers.keys()].sort();
  for (const ch of CHANNELS) {
    assert.ok(keys.includes(ch), `DT-04 固定意图 ${ch} 必须已注册`);
  }
  assert.equal(keys.some((k) => /capture|evidence|bytes|read_all|all_/i.test(k)), false,
    'DT-04 主链路不得夹带 T6/T8 截图 / 证据 / 原文 / 批量通道');
  const src = readSrc('ipc/computer.ts');
  assert.match(src, /ipcHandle\('computer:uia-read'/);
  assert.match(src, /ipcHandle\('computer:uia-invoke'/);
  assert.equal(/\bcapture_\w+/.test(src), false, 'DT-04 主链路不得夹带 T6/T8 截图能力面');
  assert.equal(/enableAll|toggleAll|bulkEnable|call_any_tool|execute_all/.test(src), false,
    'D-117：不得新增「全部执行 / 批量」入口');
  assert.equal(/fetch\(|axios|http\.request|net\.connect/.test(src), false,
    'C09：IPC 层不得把 UIA 结果外发服务端 / 模型');
});

test('T7/CF-DESK-08: uia-read 转发到 host.readUIA，requireComputerCaller 先于 host 调用', async () => {
  const h = harness();
  const out = await h.invoke('computer:uia-read', { pid: 4242, target_summary: '记事本 - 无标题' });
  assert.deepEqual(out, cleanView());
  assert.deepEqual(h.hostCalls, [['readUIA', 4242, '记事本 - 无标题']]);
  assert.equal(h.callerCalls.length, 1, '每个 UIA 通道必须先做调用方校验');
  assert.deepEqual(h.events, ['caller', 'readUIA'], '校验必须先于 worker 调用');
});

test('T7/CF-DESK-08: uia-invoke 四参数透传，value ≤32768、target_summary ≤256', async () => {
  const h = harness();
  const out = await h.invoke('computer:uia-invoke', {
    pid: 4242,
    automation_id: 'edit-1',
    value: 'x'.repeat(40000),
    target_summary: 's'.repeat(400),
  });
  assert.deepEqual(out, { ok: true, action: 'setvalue' });
  const call = h.hostCalls[0];
  assert.equal(call[0], 'invokeUIA');
  assert.equal(call[1], 4242);
  assert.equal(call[2], 'edit-1');
  assert.equal(call[3].length, 32768, 'value 必须在主进程截断');
  assert.equal(call[4].length, 256, 'target_summary 必须在主进程截断');
  assert.deepEqual(h.events, ['caller', 'invokeUIA']);
});

// ---------------------------------------------------------------------------
// ② 权限与失败边界
// ---------------------------------------------------------------------------

test('T7/CF-DESK-08: 非业务窗调用被 requireComputerCaller 拒绝且 host 零调用', async () => {
  const h = harness({ rejectCaller: true });
  await assert.rejects(
    () => h.invoke('computer:uia-read', { pid: 4242, target_summary: 'x' }),
    /不允许此窗口调用本机选窗/,
  );
  await assert.rejects(
    () => h.invoke('computer:uia-invoke', { pid: 4242, automation_id: 'a', target_summary: 'x' }),
    /不允许此窗口调用本机选窗/,
  );
  assert.equal(h.hostCalls.length, 0, '越权调用不得触达 worker host');
  assert.equal(h.callerCalls.length, 2);
  assert.deepEqual(h.events, ['caller', 'caller']);
});

test('T7/CF-DESK-08: 参数校验在本地拒绝（非法 pid / 空·超长 automation_id / 非对象），不触达 host', async () => {
  const badReads = [null, 'x', 42, {}, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: 'abc' }];
  for (const raw of badReads) {
    const h = harness();
    await assert.rejects(() => h.invoke('computer:uia-read', raw), /computer_uia_params_invalid/);
    assert.equal(h.hostCalls.length, 0, `uia-read 拒绝 ${JSON.stringify(raw)} 时不得触达 host`);
  }
  const badInvokes = [
    null,
    { pid: 1, target_summary: 'x' },
    { pid: 1, automation_id: '', target_summary: 'x' },
    { pid: 1, automation_id: 'a'.repeat(201), target_summary: 'x' },
    { pid: 0, automation_id: 'a', target_summary: 'x' },
  ];
  for (const raw of badInvokes) {
    const h = harness();
    await assert.rejects(() => h.invoke('computer:uia-invoke', raw), /computer_uia_params_invalid/);
    assert.equal(h.hostCalls.length, 0, `uia-invoke 拒绝 ${JSON.stringify(raw)} 时不得触达 host`);
  }
});

test('T7/CF-DESK-08: worker 失败如实透出（worker_ 前缀原样回传，硬禁区不伪造成功）', async () => {
  for (const err of ['worker_timeout', 'worker_exit']) {
    const h = harness({ readError: err });
    assert.deepEqual(await h.invoke('computer:uia-read', { pid: 1, target_summary: 'x' }), { ok: false, error: err });
  }
  for (const err of ['worker_timeout', 'worker_exit', 'worker_hard_forbidden']) {
    const h = harness({ invokeError: err });
    assert.deepEqual(await h.invoke('computer:uia-invoke', { pid: 1, automation_id: 'a', target_summary: 'x' }), { ok: false, error: err });
  }
  // 现取口径偏差（如实钉住，详见 docs/08 实施记录「剩余风险」）：
  // uia-read / uia-invoke 的错误码正则要求 worker_ 前缀，worker 侧实际返回的裸码
  // hard_forbidden 会被收敛成 computer_worker_unavailable；并行会话新增的
  // computer:uia-observe 已改用 known 白名单、可原样透出裸码。本轮零产品代码改动，
  // 不擅自修、也不把失败伪装成成功，只断言「必须失败」与两种可接受的失败形态。
  const h = harness({ invokeError: 'hard_forbidden' });
  const out = await h.invoke('computer:uia-invoke', { pid: 1, automation_id: 'a', target_summary: 'x' });
  assert.equal(out.ok, false, '硬禁区拒绝不得被吞成成功');
  assert.ok(['hard_forbidden', 'computer_worker_unavailable'].includes(out.error),
    `裸码只允许原样透出或按既有契约收敛，实得 ${out.error}`);
  assert.match(readSrc('ipc/computer.ts'), /'hard_forbidden', 'pid_invalid'/,
    '对照证据：新增 observe 通道的白名单已按裸码透出');
  const h2 = harness({ readError: 'EACCES' });
  assert.deepEqual(await h2.invoke('computer:uia-read', { pid: 1, target_summary: 'x' }),
    { ok: false, error: 'computer_worker_unavailable' }, '未知错误按既有契约收敛，不伪造具体原因码');
});

// ---------------------------------------------------------------------------
// ③ 完整链路可达 + C09 脱敏（T7 验收要求）
// ---------------------------------------------------------------------------

test('T7/CF-DESK-08: 完整链路 mock worker → host → IPC → preload → 渲染器四键白名单', async () => {
  const c = fullChain();
  assert.equal(typeof c.api.readComputerUIA, 'function');
  assert.equal(typeof c.api.invokeComputerUIA, 'function');

  const view = await c.api.readComputerUIA({ pid: 4242, target_summary: '记事本' });
  assert.equal(view.ok, true);
  assert.deepEqual(view.controls, [{ id: 'e1', type: 'Edit', name: '文本', value: 'abc' }]);
  assert.deepEqual(c.channelsSeen, ['computer:uia-read']);
  assert.deepEqual(c.hostCalls, [['readUIA', 4242, '记事本']]);

  const act = await c.api.invokeComputerUIA({ pid: 4242, automation_id: 'e1', value: '新内容', target_summary: '记事本' });
  assert.deepEqual(act, { ok: true, action: 'setvalue' });
  assert.deepEqual(c.channelsSeen, ['computer:uia-read', 'computer:uia-invoke']);
  assert.deepEqual(c.events, ['caller', 'readUIA', 'caller', 'invokeUIA']);
});

test('T7/CF-DESK-08: C09 脱敏——进程路径 / 截图 / 窗口全集 / 句柄字段整批拒绝；选窗只回 4 键不透明摘要', async () => {
  for (const extra of [
    { process_path: 'C:\\Windows\\System32\\evil.exe' },
    { screenshot: 'iVBORw0KGgo=' },
    { windows: [] },
    { hwnd: 12345 },
  ]) {
    const bad = cleanView();
    bad.controls = [{ ...cleanView().controls[0], ...extra }];
    const c = fullChain({ readResult: bad });
    const view = await c.api.readComputerUIA({ pid: 4242, target_summary: 'x' });
    assert.equal(view.ok, false, `越界字段 ${Object.keys(extra)[0]} 必须被整批拒绝`);
    assert.equal(view.code, 'computer_uia_invalid');
  }

  const h = harness();
  const listed = await h.invoke('computer:list-windows');
  assert.equal(listed.ok, true);
  // DEV-CU P5-2（用户选定方案①，2026-11-13）：窗口项增 pid——observe/act 必填，handle 不可逆。
  // 该字段只在本机 IPC 内流转；C09 仍禁 process_path / hwnd / class_name / 窗口全集。
  assert.deepEqual(Object.keys(listed.windows[0]).sort(), ['forbidden', 'handle', 'pid', 'process', 'title']);
  assert.equal(Number.isInteger(listed.windows[0].pid) && listed.windows[0].pid > 0, true, 'pid 为正整数');
  assert.match(listed.windows[0].handle, /^[0-9a-f]{32}$/, 'handle 为不可逆摘要');
  assert.equal(listed.windows[0].handle.includes('记事本'), false, 'handle 不得含明文标题');
  assert.equal(listed.windows[0].process.length <= 120, true);
  assert.equal(listed.windows[0].title.length <= 256, true);
  assert.equal(/screenshot|image|bytes|controls|all_windows/i.test(JSON.stringify(listed)), false,
    '选窗结果不得夹带截图原文 / 控件树 / 窗口全集');
  assert.match(readSrc('computer-worker/index.js'), /不上传全部清单到服务端/);
});

// ---------------------------------------------------------------------------
// ④ 四段链路符号守卫 + 能力面边界
// ---------------------------------------------------------------------------

test('T7/CF-DESK-08: 四段链路符号齐备（worker / host / IPC / preload / renderer 类型 / main 接线）', () => {
  const worker = readSrc('computer-worker/index.js');
  assert.match(worker, /case 'list_windows':/);
  assert.match(worker, /case 'uia_read':/);
  assert.match(worker, /case 'uia_invoke':/);
  const host = readSrc('computer-worker-host.ts');
  assert.match(host, /async readUIA\(/);
  assert.match(host, /async invokeUIA\(/);
  const ipc = readSrc('ipc/computer.ts');
  assert.match(ipc, /ipcHandle\('computer:uia-read'/);
  assert.match(ipc, /ipcHandle\('computer:uia-invoke'/);
  const registered = [...ipc.matchAll(/ipcHandle\('([^']+)'/g)].map((m) => m[1]);
  const callerChecks = (ipc.match(/requireComputerCaller\(event\)/g) || []).length;
  assert.ok(registered.includes('computer:uia-read'));
  assert.ok(registered.includes('computer:uia-invoke'));
  assert.equal(callerChecks, registered.length,
    '每个注册通道都必须复用调用方校验（含并行会话新增的 uia-observe）；不硬编码通道数');
  const preload = readSrc('business-ui-preload.ts');
  assert.match(preload, /async readComputerUIA\(/);
  assert.match(preload, /async invokeComputerUIA\(/);
  const types = readRepo('renderer/lib/desktop-presentation.d.ts');
  assert.match(types, /readComputerUIA\(/);
  assert.match(types, /invokeComputerUIA\(/);
  const main = readSrc('main.ts');
  assert.match(main, /registerComputerIpcHandlers\(\{ ipcHandle, requireComputerCaller \}\)/);
  assert.match(main, /senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /isBusinessUrl\(senderFrame\.url\)/);
});

test('T7/CF-DESK-08: 边界守卫——服务端仍第二批、computer_use 默认关、既有 7 例 UIA 定向未删改', () => {
  assert.match(readRepo('server/internal/app/agent_computer.go'), /UIA\/视觉执行 worker 属第二批/,
    '不得擅自新增服务端 UIA 执行接口');
  const bench = readRepo('server/internal/app/agent_workbench.go');
  assert.match(bench, /"computer_use"/);
  const defaultOn = bench.match(/var agentFeatureDefaultOn = map\[string\]bool\{([\s\S]*?)\}/);
  assert.ok(defaultOn, 'agentFeatureDefaultOn 必须存在');
  assert.ok(!defaultOn[1].includes('"computer_use"'), 'computer_use 不得进入默认开名单');
  assert.match(bench, /features\[name\] = !explicit && agentFeatureDefaultOn\[name\]/,
    'computer_use 默认关能力门不得被放开');
  const existing = fs.readFileSync(path.join(__dirname, 'computer-uia-ipc.test.cjs'), 'utf8');
  assert.equal((existing.match(/^test\(/gm) || []).length, 7,
    '既有 DT-04 定向 7 例不得删除 / 跳过 / 放宽');
  assert.match(existing, /OPS_UIA_MANUAL/, '真 GUI 手动开关仍保留，不冒充已验收');
  const preloadTest = fs.readFileSync(path.join(__dirname, 'business-ui-preload.test.cjs'), 'utf8');
  assert.match(preloadTest, /readComputerUIA/);
  assert.match(preloadTest, /invokeComputerUIA/);
});
