'use strict';
// DEV-AI27-17 第二批（W17b）：Windows 电脑控制执行 worker（utilityProcess 隔离进程）入口。
// 职责（27 §11.5.2）：窗口枚举（选窗器数据源）+ 目标窗口脱敏摘要。
// 边界：worker 只做读取与父进程授权后的受控动作；不开放任意 Win32/PowerShell RPC；
// 硬禁区在服务端（agent_computer.go）与本机双重校验；UIA 完整读写经 PowerShell UIA 桥分批引入。
//
// DEV-CU P2-0：本文件只保留通道适配 + 消息协议 + busy 串行化；能力函数搬到 native.js、
// 硬禁区搬到 policy.js，均为原样搬移（协议字节与 PowerShell 脚本内容不变）。

const { isHardForbidden } = require('./policy');
const { listWindows, readUIA, invokeUIA, resolveAndObserve, executeActionChain, readStateByPath } = require('./native');
const { RefStore } = require('./ref-store');
const { resolveRefTarget } = require('./refs');
const {
  dispatch, inferAction, normalizeArgs, legacyTargetAllowed,
} = require('./actions');
const { observe } = require('./observe');
const { executeWithReadback, toObserved, throwIfFailed } = require('./post-action');
const { DELIVERY, dispositionOf, wireFailure } = require('./response');
const { createCaptureService, OPEN_ENDED_KEYS } = require('./capture');

// DEV-CU P2-3：进程内快照存储。按 grant_id 分桶，不落盘；进程退出即全部失效。
const refStore = new RefStore();
// CF-DESK-04：窗口级截图原文只在隔离 worker 内存里，未接任何 host→IPC→preload
// 或服务端出口（27 §11.5.2 / §11.5.5）；进程退出即全部失效。
const captureService = createCaptureService({});
process.on('exit', () => { refStore.clear(); captureService.clear(); });

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
      identity: res.window_identity,
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

// P3-4：只读命令表（settleUnknownDelivery 用）。worker 侧只列 worker 自己实现的命令。
const WORKER_READONLY = Object.freeze(['ping', 'list_windows', 'uia_read', 'uia_observe', 'ref_store_stats', 'capture_stats', 'capture_evidence']);

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
  // P3-4 统一出口：成功保留 ok:true 并追加 disposition；失败走 wireFailure（error 保持字符串旧码）。
  const emit = (result) => {
    const r = result || {};
    if (r.ok === true) {
      // 已带 disposition 的原样透传；否则按「只读命令 not_delivered / 写命令 delivered_unverified」补齐。
      finish({
        ...r,
        disposition: r.disposition || (WORKER_READONLY.indexOf(String(msg && msg.cmd)) >= 0
          ? dispositionOf(DELIVERY.NOT_DELIVERED)
          : dispositionOf(DELIVERY.UNVERIFIED)),
      });
      return;
    }
    finish(wireFailure(r));
  };
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
    finish({ ok: false, error: 'invalid_message' });
    return;
  }
  switch (msg.cmd) {
    case 'list_windows':
      // 不上传全部清单到服务端（C09）：枚举在本机完成，OPS 只拿到用户选中项。
      listWindows().then(emit);
      return;
    case 'uia_read': {
      // C01/C03：读取目标进程主窗口的 UIA 控件树（ControlType/Name/Value，限 200 项）。
      // 硬禁区在服务端已拒（agent_computer.go），此处再校验一次（纵深防御，27 §11.5.2）。
      const summary = String(msg.target_summary || '');
      if (isHardForbidden(summary)) { emit({ ok: false, error: 'hard_forbidden' }); return; }
      const pid = Number(msg.pid);
      if (!Number.isInteger(pid) || pid <= 0) { emit({ ok: false, error: 'pid_invalid' }); return; }
      readUIA(pid).then((res) => { persistSnapshot(res, msg); emit(res); });
      return;
    }
    case 'uia_invoke': {
      // C05/C06：单控件动作（P3-1 起走 §4.7 的 14 项动作枚举）。
      // 单次批准绑定 action hash 由服务端票据管理；worker 只按授权执行。
      const summary2 = String(msg.target_summary || '');
      if (isHardForbidden(summary2)) { emit({ ok: false, error: 'hard_forbidden' }); return; }
      const pid2 = Number(msg.pid);
      const value = msg.value === undefined ? null : String(msg.value);
      if (!Number.isInteger(pid2) || pid2 <= 0) { emit({ ok: false, error: 'pid_invalid' }); return; }

      // P3-1：动作必须在 WORKER_ACTIONS 内。旧调用不带 action 时按 value 推断
      // （value 非 null → set_value，否则 click），保持既有 IPC 语义不变。
      let action;
      try {
        action = inferAction(msg.action, value);
      } catch (e) {
        emit({ ok: false, error: e.code || 'computer_action_not_supported', message: e.message });
        return;
      }

      // P2-4：优先走 ref + 身份谓词的严格再解析（不再用 AutomationId 猜目标）。
      if (msg.ref) {
        // §P3-1 步骤 4：ref 路径不接受任何外部目标字段。这里显式拒绝而不是「忽略」，
        // 否则调用方会以为 automation_id / hwnd / 坐标生效了。
        for (const key of ['automation_id', 'hwnd', 'x', 'y', 'script', 'coordinates', 'rect']) {
          if (Object.prototype.hasOwnProperty.call(msg, key)) {
            emit({
              ok: false,
              error: 'computer_invalid_args',
              message: `ref 路径不接受外部传入的 ${key}`,
            });
            return;
          }
        }
        let target;
        try {
          target = resolveRefTarget(String(msg.ref));
        } catch (e) {
          emit({ ok: false, error: e.code || 'computer_invalid_args', message: e.message });
          return;
        }
        const grantId = String(msg.grant_id || '');
        const generation = Number(msg.generation) || 0;
        let snapshot;
        try {
          snapshot = refStore.load(target.snapshotId, grantId, generation);
        } catch (e) {
          emit({ ok: false, error: e.code || 'computer_stale_ref', message: e.message });
          return;
        }
        const refEntry = snapshot.refmap && snapshot.refmap.get(`@e${target.index}`);
        if (!refEntry) {
          emit({ ok: false, error: 'computer_stale_ref', message: '该 ref 不在这个快照里，请重新观察' });
          return;
        }
        // 目标只能是本 grant / generation 的快照里的 ref；外部 automation_id / hwnd /
        // 坐标 / 脚本在 dispatch 里被拒（§P3-1 步骤 4）。
        let plan;
        try {
          plan = dispatch(
            action,
            { ref: String(msg.ref), grant_id: grantId, generation },
            { value },
            { snapshot_id: target.snapshotId, grant_id: grantId, generation },
          );
        } catch (e) {
          emit({ ok: false, error: e.code || 'computer_invalid_args', message: e.message });
          return;
        }
        // window_identity 来自快照元数据（RefMap 条目里不带它）
        const entry = { ...refEntry, window_identity: snapshot.identity || {} };
        resolveAndObserve(pid2, entry, target.snapshotId, String(msg.ref)).then((res) => {
          if (!res.ok) {
            emit({ ok: false, error: res.error, message: res.message, detail: res.detail });
            return;
          }
          // P3-2：走语义动作链（探能力 → 剪枝 → 逐 rung 执行），不再固定单 pattern。
          // clear 没有 value 入参，语义上就是「清空」→ 传空串；其余非文本动作 value 不参与。
          const text = plan.args.value === undefined ? '' : plan.args.value;
          // P3-3：动作落地后按 §4.8 读回验证。读回是纯读，不重放任何动作；
          // 读回不符 → computer_action_failed + delivered_unverified（retry 恒 unsafe）。
          // 注：链执行器把失败包成返回值，读回流程需要异常才能识别 not_delivered，
          // 故用 throwIfFailed 做一次形状转换（不改错误码 / 不改 detail）。
          executeWithReadback({
            action,
            expectedValue: text,
            selection: msg.selection,
            execute: (effective) => executeActionChain(pid2, res.path, effective, text).then(throwIfFailed),
            read: () => readStateByPath(pid2, res.path).then(toObserved),
          }).then((done) => emit({
            ok: true,
            action: plan.action,
            command: plan.command,
            snapshot_id: target.snapshotId,
            ref: String(msg.ref),
            resolved_path: res.path,
            // §4.3：读回已验证 / 证据不足都只能算 unsafe（成功但不可安全重放）。
            disposition: dispositionOf(done.delivery),
            verification_scope: done.verification_scope,
            verification_reason: done.verification_reason,
            post_state: done.post_state,
            action_satisfied: Boolean(done.executed && done.executed.action_satisfied),
            satisfied_without_delivery: Boolean(done.executed && done.executed.satisfied_without_delivery),
            steps: (done.executed && done.executed.steps) || [],
            features: done.executed && done.executed.features,
          }), (error) => {
            emit({
              ok: false,
              error: (error && error.code) || 'computer_action_failed',
              message: (error && error.message) || String(error),
              detail: error && error.detail,
            });
          });
        });
        return;
      }

      // 旧 AutomationId 分支：契约版本内保留一个发布周期（§P2-4 回退判据）。
      if (!legacyTargetAllowed()) {
        emit({ ok: false, error: 'computer_invalid_args', message: '本契约版本要求使用 ref 定位目标' });
        return;
      }
      // 旧分支只实现了 Invoke / SetValue 两种 pattern，其余动作不在这条链上。
      if (action !== 'click' && action !== 'set_value') {
        emit({
          ok: false,
          error: 'computer_action_not_supported',
          message: `旧 automation_id 分支只支持 click / set_value，收到 ${action}`,
        });
        return;
      }
      const autoId = String(msg.automation_id || '');
      if (!autoId) { emit({ ok: false, error: 'params_invalid' }); return; }
      let legacyArgs;
      try {
        legacyArgs = normalizeArgs(action, { value });
      } catch (e) {
        emit({ ok: false, error: e.code || 'computer_invalid_args', message: e.message });
        return;
      }
      invokeUIA(pid2, autoId, legacyArgs.value === undefined ? null : legacyArgs.value)
        .then((act) => emit({ ...act, action }));
      return;
    }
    case 'ping':
      emit({ ok: true, pong: true });
      return;
    case 'uia_observe': {
      // DEV-CU P2-7：把 P2-1～P2-6 串成一条可直接被 IPC 调用的观察命令。
      // 顺序（§P2-7 步骤 2）在 observe.js 里：硬禁区 → pid → 窗口身份 → 抓树 → 裁剪
      // → 分配 ref → 存 RefStore → qualifyTreeRefs → 输出。这里只做通道适配与存取。
      observe(msg, { refStore }).then((res) => {
        if (res && res.ok === true) persistSnapshot(res, msg);
        emit(res);
      });
      return;
    }
    case 'uia_invalidate': {
      // P2-3：租约撤销 / handoff / 锁屏时由主进程调用，清空该 grant 的全部快照。
      const gid = String(msg.grant_id || '');
      if (!gid) { emit({ ok: false, error: 'params_invalid' }); return; }
      const cleared = refStore.invalidate(gid);
      emit({ ok: true, cleared });
      return;
    }
    case 'ref_store_stats':
      // 只回计数，不回任何窗口/控件内容（C09）。
      emit({ ok: true, ...refStore.stats() });
      return;
    case 'capture_window': {
      // CF-DESK-04（A-03 前置）：窗口级截图。硬禁区与服务端一样做本机二次校验；
      // 返回只含选中目标的必要摘要，原文留在本进程（27 §11.5.2 / C09）。
      const captureSummary = String(msg.target_summary || '');
      if (isHardForbidden(captureSummary)) { emit({ ok: false, error: 'hard_forbidden' }); return; }
      captureService.capture(msg)
        .then(emit, () => emit({ ok: false, error: 'capture_failed' }));
      return;
    }
    case 'capture_invalidate': {
      // 失权 / handoff / 锁屏：清空该 grant 下全部截图，拒绝历史越权读取（C09）。
      const captureGrant = String(msg.grant_id || '');
      if (!captureGrant) { emit({ ok: false, error: 'params_invalid' }); return; }
      emit({ ok: true, cleared: captureService.invalidate(captureGrant) });
      return;
    }
    case 'capture_evidence': {
      // CF-DESK-05（C09 脱敏校验 / A-03）：只回固定白名单的脱敏证据，
      // 凭同一 grant 读取；**不**提供 capture_read / capture_bytes 类原文出口。
      const captureId = String(msg.capture_id || '');
      const evidenceGrant = String(msg.grant_id || '');
      if (!captureId || !evidenceGrant) { emit({ ok: false, error: 'params_invalid' }); return; }
      if (OPEN_ENDED_KEYS.some((k) => Object.prototype.hasOwnProperty.call(msg, k))) {
        emit({ ok: false, error: 'params_invalid' }); return;
      }
      emit(captureService.evidence(captureId, evidenceGrant));
      return;
    }
    case 'capture_stats':
      // 只回计数，不回任何截图原文 / 窗口标题 / 其它窗口清单。
      emit({ ok: true, ...captureService.stats() });
      return;
    default:
      emit({ ok: false, error: 'unknown_cmd' });
  }
});
