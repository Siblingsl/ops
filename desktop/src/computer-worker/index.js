'use strict';
// DEV-AI27-17 第二批（W17b）：Windows 电脑控制执行 worker（utilityProcess 隔离进程）入口。
// 职责（27 §11.5.2）：窗口枚举（选窗器数据源）+ 目标窗口脱敏摘要。
// 边界：worker 只做读取与父进程授权后的受控动作；不开放任意 Win32/PowerShell RPC；
// 硬禁区在服务端（agent_computer.go）与本机双重校验；UIA 完整读写经 PowerShell UIA 桥分批引入。
//
// DEV-CU P2-0：本文件只保留通道适配 + 消息协议 + busy 串行化；能力函数搬到 native.js、
// 硬禁区搬到 policy.js，均为原样搬移（协议字节与 PowerShell 脚本内容不变）。

const { isHardForbidden } = require('./policy');
const { listWindows, readUIA, invokeUIA } = require('./native');
const { RefStore } = require('./ref-store');

// DEV-CU P2-3：进程内快照存储。按 grant_id 分桶，不落盘；进程退出即全部失效。
const refStore = new RefStore();
process.on('exit', () => { refStore.clear(); });

/** uia_read 带 grant_id 时把 RefMap 存入 RefStore；未带则只做单次读取（兼容旧调用）。 */
function persistSnapshot(res, msg) {
  if (!res || res.ok !== true || !res.snapshot_id) return;
  const grantId = String((msg && msg.grant_id) || '');
  if (!grantId) return;
  try {
    refStore.save(grantId, res.snapshot_id, {
      refmap: res.refmap,
      generation: Number(msg.generation) || 0,
      tree: res.tree,
    });
  } catch (e) {
    // 存快照失败不阻断本次读取（ref 仍可用于同一批动作），只把原因带回给调用方。
    res.ref_store_error = String((e && e.code) || 'computer_internal');
  }
}

// 兼容三种宿主：
//  - Electron utilityProcess.fork：process.parentPort（生产路径，支持 asar 内文件）
//  - worker_threads：parentPort
//  - child_process.fork：process.send（desktop/test/computer-worker.test.cjs）
const channel = (() => {
  if (process.parentPort) {
    return {
      onMessage(fn) { process.parentPort.on('message', (event) => fn(event.data)); },
      reply(message) { process.parentPort.postMessage(message); },
    };
  }
  const { parentPort } = require('node:worker_threads');
  if (parentPort) {
    return { onMessage(fn) { parentPort.on('message', fn); }, reply(message) { parentPort.postMessage(message); } };
  }
  return { onMessage(fn) { process.on('message', fn); }, reply(message) { process.send(message); } };
})();

let busy = false;

channel.onMessage((msg) => {
  if (busy) {
    channel.reply({ id: msg && msg.id, ok: false, error: 'worker_busy' });
    return;
  }
  busy = true;
  const finish = (result) => {
    busy = false;
    channel.reply({ id: msg && msg.id, ...result });
  };
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
    finish({ ok: false, error: 'invalid_message' });
    return;
  }
  switch (msg.cmd) {
    case 'list_windows':
      // 不上传全部清单到服务端（C09）：枚举在本机完成，OPS 只拿到用户选中项。
      listWindows().then(finish);
      return;
    case 'uia_read': {
      // C01/C03：读取目标进程主窗口的 UIA 控件树（ControlType/Name/Value，限 200 项）。
      // 硬禁区在服务端已拒（agent_computer.go），此处再校验一次（纵深防御，27 §11.5.2）。
      const summary = String(msg.target_summary || '');
      if (isHardForbidden(summary)) { finish({ ok: false, error: 'hard_forbidden' }); return; }
      const pid = Number(msg.pid);
      if (!Number.isInteger(pid) || pid <= 0) { finish({ ok: false, error: 'pid_invalid' }); return; }
      readUIA(pid).then((res) => { persistSnapshot(res, msg); finish(res); });
      return;
    }
    case 'uia_invoke': {
      // C05/C06：单控件动作（ValuePattern.SetValue 或 InvokePattern.Invoke）。
      // 单次批准绑定 action hash 由服务端票据管理；worker 只按授权 PID+AutomationId 执行。
      const summary2 = String(msg.target_summary || '');
      if (isHardForbidden(summary2)) { finish({ ok: false, error: 'hard_forbidden' }); return; }
      const pid2 = Number(msg.pid);
      const autoId = String(msg.automation_id || '');
      const value = msg.value === undefined ? null : String(msg.value);
      if (!Number.isInteger(pid2) || pid2 <= 0 || !autoId) { finish({ ok: false, error: 'params_invalid' }); return; }
      invokeUIA(pid2, autoId, value).then(finish);
      return;
    }
    case 'ping':
      finish({ ok: true, pong: true });
      return;
    case 'uia_invalidate': {
      // P2-3：租约撤销 / handoff / 锁屏时由主进程调用，清空该 grant 的全部快照。
      const gid = String(msg.grant_id || '');
      if (!gid) { finish({ ok: false, error: 'params_invalid' }); return; }
      const cleared = refStore.invalidate(gid);
      finish({ ok: true, cleared });
      return;
    }
    case 'ref_store_stats':
      // 只回计数，不回任何窗口/控件内容（C09）。
      finish({ ok: true, ...refStore.stats() });
      return;
    default:
      finish({ ok: false, error: 'unknown_cmd' });
  }
});
