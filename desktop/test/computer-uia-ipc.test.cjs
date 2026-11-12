'use strict';
// DT-04（docs/33 §10.4 / 10.8）：暴露 UIA 主链路。
// 缺陷（修复前）：worker 已实现 uia_read/uia_invoke（computer-worker.js:98-118，含
// 硬禁区二次校验、200 项上限、15s 超时），但 ComputerWorkerHost.call() 是 private、
// 只导出 listWindows()/ping()——UIA 主链路断在 host→IPC 一段，能力「已编码但不可达」。
// 修复：
// ① host 暴露 readUIA(pid, targetSummary) / invokeUIA(pid, automationId, value, targetSummary)；
// ② main.ts 新增固定意图 computer:uia-read / computer:uia-invoke，复用
//    requireComputerCaller（仅业务窗主框架）；
// ③ preload 白名单逐项校验（controls ≤200、字段白名单、无进程路径）；
// ④ C09：读取结果只回本机渲染器，不含进程路径/窗口全集/截图；硬禁区纵深防御保持。
// 影响分析见 docs/08 DT-04 段：UIA 能力面属 docs/27 §11.5 C01~C09（用户已确认范围）；
// 服务端 UIA 执行接口属第二批（agent_computer.go:18），本轮不新增服务端接口。

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { fork } = require('node:child_process');
const path = require('node:path');

const { ComputerWorkerHost } = require('../.build/computer-worker-host.js');

// ---------------------------------------------------------------------------
// ① host 层：readUIA / invokeUIA 已暴露并可驱动 mock worker
// ---------------------------------------------------------------------------

/** 用注入式 mock 替换 utilityProcess.fork，驱动 host 公开方法。 */
function hostWithMockWorker(handlers) {
  const Module = require('node:module');
  const electronMock = {
    utilityProcess: {
      fork: () => {
        const listeners = { message: [], exit: [] };
        const child = {
          on(event, fn) { listeners[event]?.push(fn); },
          postMessage(msg) {
            const respond = (body) => setTimeout(() => listeners.message.forEach((fn) => fn(body)), 5);
            const h = handlers[msg.cmd];
            respond({ id: msg.id, ...(h ? h(msg) : { ok: false, error: 'unknown_cmd' }) });
          },
          kill() { listeners.exit.forEach((fn) => fn()); },
        };
        return child;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../.build/computer-worker-host.js')];
  try {
    const Host = require('../.build/computer-worker-host.js').ComputerWorkerHost;
    return new Host();
  } finally {
    Module._load = originalLoad;
  }
}

test('DT-04: host 暴露 readUIA（转发 pid+target_summary，返回 controls 白名单）', async () => {
  const host = hostWithMockWorker({
    uia_read: (msg) => ({ ok: true, window: '记事本', controls: [{ id: '1', type: 'Edit', name: '文本', value: 'abc' }] }),
  });
  assert.equal(typeof host.readUIA, 'function', 'host 应暴露 readUIA（修复前只有 listWindows/ping）');
  const view = await host.readUIA(1234, '记事本 - 无标题');
  assert.equal(view.window, '记事本');
  assert.equal(view.controls.length, 1);
  assert.deepEqual(view.controls[0], { id: '1', type: 'Edit', name: '文本', value: 'abc' });
});

test('DT-04: host 暴露 invokeUIA（转发 pid+automation_id+value+target_summary）', async () => {
  const seen = {};
  const host = hostWithMockWorker({
    uia_invoke: (msg) => {
      Object.assign(seen, msg);
      return { ok: true, action: 'setvalue' };
    },
  });
  assert.equal(typeof host.invokeUIA, 'function', 'host 应暴露 invokeUIA');
  const result = await host.invokeUIA(1234, 'edit-1', '新内容', '记事本 - 无标题');
  assert.equal(result.ok, true);
  assert.equal(result.action, 'setvalue');
  assert.equal(seen.pid, 1234);
  assert.equal(seen.automation_id, 'edit-1');
  assert.equal(seen.value, '新内容');
  assert.equal(seen.target_summary, '记事本 - 无标题');
});

test('DT-04: worker 失败如实上抛（hard_forbidden 不被吞）', async () => {
  const host = hostWithMockWorker({
    uia_invoke: () => ({ ok: false, error: 'hard_forbidden' }),
  });
  await assert.rejects(() => host.invokeUIA(9999, 'x', null, '命令提示符'), /hard_forbidden/,
    '硬禁区拒绝必须如实上抛（纵深防御）');
});

// ---------------------------------------------------------------------------
// ② preload 层：固定意图暴露 + schema 白名单（controls ≤200、无进程路径字段）
// ---------------------------------------------------------------------------

function loadPreload(electron) {
  const preloadPath = require.resolve('../.build/business-ui-preload.js');
  const originalLoad = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('DT-04: preload 暴露 readComputerUIA / invokeComputerUIA 固定意图', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const invokes = [];
  const ipcRenderer = {
    on() {}, removeListener() {},
    invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true, window: 'w', controls: [] }); },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.equal(typeof exposed.opsDesktopUI.readComputerUIA, 'function', 'preload 应暴露 readComputerUIA');
  assert.equal(typeof exposed.opsDesktopUI.invokeComputerUIA, 'function', 'preload 应暴露 invokeComputerUIA');
  await exposed.opsDesktopUI.readComputerUIA({ pid: 1234, target_summary: '记事本' });
  assert.deepEqual(invokes.at(-1), { channel: 'computer:uia-read', payload: { pid: 1234, target_summary: '记事本' } });
  await exposed.opsDesktopUI.invokeComputerUIA({ pid: 1234, automation_id: 'a1', value: 'v', target_summary: '记事本' });
  assert.deepEqual(invokes.at(-1), { channel: 'computer:uia-invoke', payload: { pid: 1234, automation_id: 'a1', value: 'v', target_summary: '记事本' } });
});

test('DT-04: preload 拒绝越界 schema（>200 controls、进程路径字段、非白名单值）', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {}, removeListener() {},
    invoke(_channel, payload) {
      const pid = Number(payload?.pid);
      if (pid === 201) {
        return Promise.resolve({
          ok: true, window: 'w',
          controls: Array.from({ length: 201 }, (_, i) => ({ id: String(i), type: 'Edit', name: '', value: '' })),
        });
      }
      if (pid === 202) {
        return Promise.resolve({
          ok: true, window: 'w',
          controls: [{ id: '1', type: 'Edit', name: '', value: '', process_path: 'C:\\Windows\\System32\\evil.exe' }],
        });
      }
      return Promise.resolve({ ok: true, window: 'w', controls: [{ id: '1', type: 'Edit', name: 'n', value: 'v' }] });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  const oversized = await exposed.opsDesktopUI.readComputerUIA({ pid: 201, target_summary: 'x' });
  assert.equal(oversized.ok, false, '超过 200 项的控件树整批拒绝');
  const leaked = await exposed.opsDesktopUI.readComputerUIA({ pid: 202, target_summary: 'x' });
  assert.equal(leaked.ok, false, '含进程路径等越界字段的控件整批拒绝（C09 脱敏）');
  const good = await exposed.opsDesktopUI.readComputerUIA({ pid: 1, target_summary: 'x' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.controls, [{ id: '1', type: 'Edit', name: 'n', value: 'v' }]);
});

test('DT-04: preload 参数校验（pid 正整数、automation_id 非空且限长）', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const invokes = [];
  const ipcRenderer = {
    on() {}, removeListener() {},
    invoke(channel, payload) {
      invokes.push({ channel, payload });
      return Promise.resolve(channel === 'computer:uia-invoke'
        ? { ok: true, action: 'invoke' }
        : { ok: true, window: 'w', controls: [] });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  const badPid = await exposed.opsDesktopUI.readComputerUIA({ pid: 0, target_summary: 'x' });
  assert.deepEqual(badPid, { ok: false, code: 'computer_uia_invalid', message: 'UIA 参数无效。' },
    '非法 pid 不发 IPC，直接本地拒绝');
  assert.equal(invokes.length, 0, '被拒参数不应触达 IPC');
  const emptyId = await exposed.opsDesktopUI.invokeComputerUIA({ pid: 1, automation_id: '', target_summary: 'x' });
  assert.deepEqual(emptyId, { ok: false, code: 'computer_uia_invalid', message: 'UIA 参数无效。' },
    '空 automation_id 不发 IPC');
  const longId = await exposed.opsDesktopUI.invokeComputerUIA({ pid: 1, automation_id: 'a'.repeat(201), target_summary: 'x' });
  assert.deepEqual(longId, { ok: false, code: 'computer_uia_invalid', message: 'UIA 参数无效。' },
    '超长 automation_id 不发 IPC');
  assert.equal(invokes.length, 0, '所有被拒参数都不应触达 IPC');
  const okResult = await exposed.opsDesktopUI.invokeComputerUIA({ pid: 1, automation_id: 'a1', value: 'v', target_summary: 'x' });
  assert.equal(okResult.ok, true);
  assert.deepEqual(invokes.at(-1), { channel: 'computer:uia-invoke', payload: { pid: 1, automation_id: 'a1', value: 'v', target_summary: 'x' } });
});

// ---------------------------------------------------------------------------
// ③ 集成（P1-3 步骤 3）：worker 真实输出 → preload 白名单必须整批接受
// ---------------------------------------------------------------------------

/** 直接 fork src 里的 worker（与产品同源，不用 .build 的旧产物）。 */
function forkWorker(t) {
  const child = fork(path.resolve(__dirname, '..', 'src', 'computer-worker.js'), [],
    { stdio: 'ignore', env: { ...process.env, OPS_DESKTOP_WORKER: '1' } });
  let nextID = 1;
  const pending = new Map();
  child.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'string') return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    call.resolve(msg);
  });
  t.after(() => { try { child.kill(); } catch {} });
  return {
    call(cmd, timeoutMs = 20_000, extra = {}) {
      const id = `i${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, timeoutMs);
        pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
        child.send({ id, cmd, ...extra });
      });
    },
  };
}

test('DT-04: worker 真实输出能被 preload 白名单接受（P1-3 集成，非 mock）', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  if (process.env.OPS_UIA_MANUAL !== '1') {
    t.skip('需真实桌面：设 OPS_UIA_MANUAL=1 开启（本机 2026-11-12 已实测通过）');
    return;
  }

  // 不 spawn / 不 kill：只借当前桌面已存在的窗口做只读采样。
  // 两个 GUI 用例分属不同测试文件、并行跑，谁都不该关别人的窗口。
  const worker = forkWorker(t);
  const listed = await worker.call('list_windows');
  assert.equal(listed.ok, true, `选窗应成功：${JSON.stringify(listed)}`);
  const candidates = (listed.windows || []).filter((w) => w.pid > 0 && !w.forbidden).slice(0, 3);
  if (candidates.length === 0) { t.skip('当前桌面没有可用窗口'); return; }

  let real = null;
  for (const win of candidates) {
    const got = await worker.call('uia_read', 20_000, { pid: win.pid });
    if (got.ok && Array.isArray(got.controls) && got.controls.length > 0) { real = got; break; }
  }
  if (!real) { t.skip('候选窗口都没有可读控件树'); return; }

  // 把真实输出原样回给 preload：字段名/长度/键集合都必须过白名单。
  // 断言只打印数量与键集合，不打印窗口标题或控件文本（避免把桌面内容写进日志）。
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = { on() {}, removeListener() {}, invoke: () => Promise.resolve(real) };
  loadPreload({ contextBridge, ipcRenderer });

  const view = await exposed.opsDesktopUI.readComputerUIA({ pid: candidates[0].pid, target_summary: '集成采样' });
  assert.equal(view.ok, true,
    `worker 真实输出应被白名单接受（失败说明字段名或长度越界）：ok=${view.ok} code=${view.code || ''}`);
  assert.equal(view.controls.length, real.controls.length, '白名单不应丢弃或新增控件项');
  const keySets = new Set(view.controls.map((c) => Object.keys(c).sort().join(',')));
  assert.deepEqual([...keySets], ['id,name,type,value'], `白名单应只留四键，实际：${[...keySets].join(' | ')}`);
  assert.equal(view.controls.filter((c) => c.type === null).length, 0, 'type 不应为 null');
  assert.equal(view.controls.filter((c) => typeof c.type !== 'string' || c.type.length === 0).length, 0,
    'type 应为非空字符串');
});
