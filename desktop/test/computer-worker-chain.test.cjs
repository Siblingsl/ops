'use strict';
// DEV-CU P3-2：语义动作链（备料版）。
// 覆盖：§4.7 链顺序逐行锁表、可用性守卫过滤、AlreadyInState 短路、absent 回退、
//       全部耗尽、deadline、HRESULT 分类矩阵、全程无物理投递。

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  CHAIN_SPEC, HRESULT, chainFor, guardOpen, classifyHresult, executeChain,
} = require('../src/computer-worker/actions.js');
const native = require('../src/computer-worker/native.js');

const labels = (action, features) => chainFor(action, features).map((r) => r.label);

test('P3-2: §4.7 链顺序逐行锁表', () => {
  assert.deepEqual(labels('click'), [
    'UIInvokePattern.Invoke',
    'UILegacyIAccessiblePattern.DoDefaultAction',
  ]);
  assert.deepEqual(labels('set_value'), [
    'UIValuePattern.SetValue',
    'UIRangeValuePattern.SetValue',
  ]);
  assert.deepEqual(labels('clear'), ['UIValuePattern.SetValue'], 'Clear 只走 ValuePattern');
  assert.deepEqual(labels('toggle'), ['UITogglePattern.Toggle', 'UIInvokePattern.Invoke']);
  assert.deepEqual(labels('expand'), ['UIExpandCollapsePattern.Expand', 'UIInvokePattern.Invoke']);
  assert.deepEqual(labels('collapse'), ['UIExpandCollapsePattern.Collapse', 'UIInvokePattern.Invoke']);
  assert.deepEqual(labels('select'), [
    'UISelectionItemPattern.Select',
    'UIExpandCollapsePattern.Expand',
  ]);
  assert.deepEqual(labels('scroll'), [
    'UIScrollPattern.Scroll',
    'UIScrollItemPattern.ScrollIntoView',
    'AncestorScrollPattern.Scroll',
  ]);
  assert.deepEqual(labels('scroll_to'), [
    'UIScrollItemPattern.ScrollIntoView',
    'UIScrollPattern.Scroll',
    'AncestorScrollPattern.Scroll',
  ]);
  assert.deepEqual(labels('set_focus'), ['UIAutomationElement.SetFocus']);
  assert.deepEqual(labels('observe'), [], 'observe 不产生动作链');

  // 14 个动作都要有链定义（observe 为空数组也算定义）
  for (const action of Object.keys(CHAIN_SPEC)) {
    assert.ok(Array.isArray(CHAIN_SPEC[action]));
  }
  // 需求矩阵 19 项里，hover / drag 只走物理光标（policy 直接拒），没有语义链 → 链表 18 项
  assert.equal(Object.keys(CHAIN_SPEC).length, 18);
  assert.deepEqual(labels('hover'), []);
  assert.deepEqual(labels('drag'), []);
  assert.equal(CHAIN_SPEC.hover, undefined, 'hover 不应有语义链定义');
});

test('P3-2: 每个 rung 都标 semantic_api，链里不存在物理投递', () => {
  for (const action of Object.keys(CHAIN_SPEC)) {
    for (const rung of chainFor(action)) {
      assert.equal(rung.mechanism, 'semantic_api');
      assert.doesNotMatch(rung.label, /SendInput|physical|cursor|mouse_event/i);
    }
    assert.ok(!JSON.stringify(CHAIN_SPEC[action]).match(/SendInput|physical/i));
  }
});

test('P3-2: 可用性守卫按 features 过滤', () => {
  // Invoke 不可用 → 只剩 legacy rung
  assert.deepEqual(labels('click', { invoke_available: false }), [
    'UILegacyIAccessiblePattern.DoDefaultAction',
  ]);
  // legacy 空串 → 只剩 Invoke
  assert.deepEqual(labels('click', { legacy_default_action: '' }), ['UIInvokePattern.Invoke']);
  // 两个都不可用 → 空链（调用方会得到 action_failed，而不是乱试）
  assert.deepEqual(labels('click', { invoke_available: false, legacy_default_action: '' }), []);

  // SetValue 只读 → 只能走 RangeValue（且值必须是数字）
  assert.deepEqual(
    labels('set_value', { value_writable: false, range_numeric: true }),
    ['UIRangeValuePattern.SetValue'],
  );
  // 只读 + 非数字 → 无可执行 rung（editable/action_supported 应在上游就拦住）
  assert.deepEqual(
    labels('set_value', { value_writable: false, range_numeric: false }),
    [],
  );
  // 不确定的开关不拦（undefined → 尝试，由 PS 回 absent）
  assert.equal(labels('click', {}).length, 2);
  assert.equal(guardOpen('always', { anything: false }), true);
  assert.equal(guardOpen('invoke', undefined), true, '规划视图不守卫');
});

test('P3-2: 首个 rung 成功即停，不做多余调用', async () => {
  const calls = [];
  const result = await executeChain(chainFor('click'), {
    run: async (rung) => { calls.push(rung.label); return { kind: 'delivered', verified: true }; },
  });
  assert.equal(calls.length, 1, '成功就不该再试第二个 rung');
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.satisfied_without_delivery, false);
  assert.deepEqual(result.steps.map((s) => s.label), ['UIInvokePattern.Invoke']);
  assert.equal(result.steps[0].outcome, 'succeeded');
  assert.equal(result.steps[0].mechanism, 'semantic_api');
});

test('P3-2: absent 回退到下一 rung，全部耗尽 → action_failed + steps', async () => {
  const calls = [];
  const result = await executeChain(chainFor('click'), {
    run: async (rung) => {
      calls.push(rung.label);
      if (calls.length === 1) return { kind: 'absent' };
      return { kind: 'delivered', verified: false };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.verified, false, '未读回 → delivered_unverified');
  assert.deepEqual(result.steps.map((s) => s.outcome), ['skipped', 'succeeded']);

  // 全部 absent
  await assert.rejects(
    () => executeChain(chainFor('set_value'), { run: async () => ({ kind: 'absent' }) }),
    (e) => {
      assert.equal(e.code, 'computer_action_failed');
      assert.equal(e.detail.steps.length, 2);
      assert.deepEqual(e.detail.steps_tried, ['UIValuePattern.SetValue', 'UIRangeValuePattern.SetValue']);
      assert.deepEqual(e.detail.disposition, { delivery: 'not_delivered', retry: 'safe' });
      return true;
    },
  );

  // 空链（守卫全部关掉）也走同一条耗尽路径，不得静默成功
  await assert.rejects(
    () => executeChain([], { run: async () => ({ kind: 'delivered' }) }),
    (e) => e.code === 'computer_action_failed' && e.detail.steps.length === 0,
  );
});

test('P3-2: 已满足目标态 → satisfied_without_delivery，不产生副作用', async () => {
  const calls = [];
  const result = await executeChain(chainFor('expand'), {
    run: async (rung) => {
      calls.push(rung.label);
      return { kind: 'satisfied' }; // 已展开
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.satisfied_without_delivery, true);
  assert.equal(result.action_satisfied, true);
  assert.equal(result.verified, true);
  assert.equal(result.steps[0].outcome, 'satisfied');
});

test('P3-2: deadline 到了立刻停，按 not_delivered 返回', async () => {
  let clock = 0;
  await assert.rejects(
    () => executeChain(chainFor('scroll'), {
      now: () => { clock += 10; return clock; },
      deadlineAt: 15,
      run: async () => ({ kind: 'absent' }),
    }),
    (e) => {
      assert.equal(e.code, 'computer_timeout');
      assert.deepEqual(e.detail.disposition, { delivery: 'not_delivered', retry: 'safe' });
      assert.equal(e.detail.steps.length, 1, '第一个 rung 之后就该发现超期');
      return true;
    },
  );
});

test('P3-2: HRESULT 分类矩阵（与上游 mutation.rs 一致）', () => {
  const rows = [
    [HRESULT.E_ACCESSDENIED, 'computer_policy_denied', 'not_delivered', false],
    [HRESULT.UIA_E_ELEMENTNOTAVAILABLE, 'computer_stale_ref', 'not_delivered', true],
    [HRESULT.E_INVALIDARG, 'computer_invalid_args', 'not_delivered', false],
    [HRESULT.UIA_E_ELEMENTNOTENABLED, 'computer_action_failed', 'not_delivered', false],
    [HRESULT.RPC_E_SERVERFAULT, 'computer_app_unresponsive', 'delivery_uncertain', true],
    [HRESULT.RPC_E_DISCONNECTED, 'computer_app_unresponsive', 'delivery_uncertain', true],
    [HRESULT.RPC_S_SERVER_UNAVAILABLE, 'computer_app_unresponsive', 'delivery_uncertain', true],
    [HRESULT.RPC_S_CALL_FAILED, 'computer_app_unresponsive', 'delivery_uncertain', true],
    [HRESULT.UIA_E_TIMEOUT, 'computer_timeout', 'delivery_uncertain', true],
    [0x80131509, 'computer_action_failed', 'delivery_uncertain', false], // UIA_E_INVALIDOPERATION：未分类
    [undefined, 'computer_action_failed', 'delivery_uncertain', false],
  ];
  for (const [hresult, code, delivery, retryable] of rows) {
    const got = classifyHresult(hresult);
    assert.equal(got.error_code, code, `0x${Number(hresult).toString(16)} 错误码`);
    assert.equal(got.disposition.delivery, delivery, `0x${Number(hresult).toString(16)} 投递语义`);
    assert.equal(got.retryable, retryable);
  }

  // UIA_E_NOTSUPPORTED 不是错误，是「这个 rung 没有该能力」→ 继续
  assert.deepEqual(classifyHresult(HRESULT.UIA_E_NOTSUPPORTED), { absent: true });
  // 有符号表示要能归一化（-2147024891 === 0x80070005）
  assert.equal(classifyHresult(-2147024891).error_code, 'computer_policy_denied');
  assert.equal(classifyHresult('0x80040201').error_code, 'computer_stale_ref');
});

test('P3-2: 链内失败按 HRESULT 映射成错误码', async () => {
  // 第一个 rung 报「元素不可用」→ stale，且不再试第二个
  let calls = 0;
  await assert.rejects(
    () => executeChain(chainFor('click'), {
      run: async () => { calls += 1; return { hresult: HRESULT.UIA_E_ELEMENTNOTAVAILABLE }; },
    }),
    (e) => {
      assert.equal(e.code, 'computer_stale_ref');
      assert.equal(e.detail.rung, 'UIInvokePattern.Invoke');
      assert.equal(e.detail.steps.length, 0, '失败前没有已完成的 step');
      assert.deepEqual(e.detail.disposition, { delivery: 'not_delivered', retry: 'safe' });
      return true;
    },
  );
  assert.equal(calls, 1);

  // UIA_E_NOTSUPPORTED → 当作 absent，继续下一个 rung
  calls = 0;
  const result = await executeChain(chainFor('toggle'), {
    run: async () => {
      calls += 1;
      return calls === 1 ? { hresult: HRESULT.UIA_E_NOTSUPPORTED } : { kind: 'delivered', verified: true };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.steps.map((s) => s.cause || s.outcome), ['uia_not_supported', 'succeeded']);
});

// ===========================================================================
// P3-2 接线：pattern 片段与标签表
// ===========================================================================

test('P3-2: PATTERN_LABELS 与 CHAIN_SPEC 双向一致（改一边必红）', () => {
  const used = new Set();
  for (const key of Object.keys(CHAIN_SPEC)) {
    for (const rung of CHAIN_SPEC[key]) used.add(rung.label);
  }
  assert.deepEqual(
    native.PATTERN_LABELS.slice().sort(),
    [...used].sort(),
    'PS 片段的标签表必须与 §4.7 的链表逐字一致（多一个=有片段没接线，少一个=链会打到空分支）',
  );
  assert.equal(new Set(native.PATTERN_LABELS).size, native.PATTERN_LABELS.length, '标签不得重复');
  // 标签形态锁定：`<Pattern>.<Method>`，全是 UIA 的英文常量，不带空格/分号
  for (const label of native.PATTERN_LABELS) {
    assert.match(label, /^(UI[A-Za-z]+\.[A-Za-z]+|AncestorScrollPattern\.Scroll|UIAutomationElement\.SetFocus)$/);
  }
});

test('P3-2: 未知 pattern 标签在执行前被拒，不会拼进脚本', async () => {
  const { invokePatternByPath } = native;
  for (const bad of ['Remove-Item', 'UIInvokePattern.Invoke; rm -rf /', '', null, undefined, 42]) {
    const res = await invokePatternByPath(1, [], bad, 'click', '');
    assert.equal(res.ok, false, String(bad));
    assert.equal(res.error, 'unknown_pattern_label');
  }
});

test('P3-2: 能力探测结果决定剪枝（value 只读 → 写类链为空）', () => {
  // 只读值：value_writable=false，range 也不可用 → set_value 没有任何 rung
  const ro = { value_writable: false, range_numeric: false, invoke_available: true };
  assert.deepEqual(chainFor('set_value', ro), [], '只读元素不该有写类 rung');

  // 可写 → 第一条 ValuePattern 通过
  const rw = { value_writable: true, range_numeric: false };
  assert.deepEqual(chainFor('set_value', rw).map((r) => r.label), ['UIValuePattern.SetValue']);

  // 只有 Range（滑块）→ 只剩第二条，且它要求 role 是数值型
  const rng = { value_writable: false, range_numeric: true };
  assert.deepEqual(chainFor('set_value', rng).map((r) => r.label), ['UIRangeValuePattern.SetValue']);

  // click：没有 invoke 但有 legacy → 只剩 legacy
  assert.deepEqual(
    chainFor('click', { invoke_available: false, legacy_default_action: true }).map((r) => r.label),
    ['UILegacyIAccessiblePattern.DoDefaultAction'],
  );
  // 两个都没有 → 空链（executeActionChain 会报 computer_action_not_supported）
  assert.deepEqual(chainFor('click', { invoke_available: false, legacy_default_action: false }), []);
});

test('P3-2: executeActionChain 对不存在的目标返回可分类错误（不加壳）', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const res = await native.executeActionChain(999_999_999, [0], 'click', '');
  assert.equal(res.ok, false);
  // 探测阶段就失败：错误码来自 native 的诊断文本，不能是 undefined
  assert.match(String(res.error), /^(uia_failed|control_not_found|feature_probe_failed)/);
});

test('P3-2: 真实记事本上的语义链（产品 ref 链路，OPS_UIA_SPAWN=1 opt-in）', { timeout: 180_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  if (process.env.OPS_UIA_SPAWN !== '1') { t.skip('未设 OPS_UIA_SPAWN=1'); return; }

  const { spawn, fork } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const child = fork(path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js'), [],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });
  const call = (cmd, extra = {}, timeoutMs = 25_000) => new Promise((resolve, reject) => {
    const id = 'p32' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => { child.off('message', onMsg); reject(new Error('timeout')); }, timeoutMs);
    const onMsg = (m) => { if (m && m.id === id) { clearTimeout(timer); child.off('message', onMsg); resolve(m); } };
    child.on('message', onMsg);
    child.send({ id, cmd, ...extra });
  });

  // 只测自己开的记事本：桌面已有记事本进程时直接跳过，绝不碰用户窗口。
  const listed0 = await call('list_windows');
  if ((listed0.windows || []).some((w) => /notepad/i.test(w.process))) {
    t.skip('桌面已有记事本进程（避免写入/关闭用户窗口，先关闭后再跑）');
    return;
  }

  const seed = `P32-SEED-${process.pid}-${Date.now()}`;
  const scratch = path.join(os.tmpdir(), `ops-p32-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(scratch, seed, 'utf8');
  const scratchName = path.basename(scratch);
  let spawned = null;
  let pid = 0;
  let hwnd = 0;
  let soleTab = true;
  t.after(() => { try { fs.unlinkSync(scratch); } catch { /* 可能仍被占用 */ } });

  try {
    spawned = spawn('notepad', [scratch], { stdio: 'ignore' });
    const deadline = Date.now() + 60_000;
    while (!pid && Date.now() < deadline) {
      await sleep(500);
      const list = await call('list_windows');
      if (!list || list.ok !== true) continue;
      const hit = (list.windows || []).find((w) => /notepad/i.test(w.process)
        && String(w.title || '').includes(scratchName));
      if (hit) pid = hit.pid;
    }
    if (!pid) { t.skip('未枚举到本次打开的记事本窗口'); return; }

    const read = await call('uia_read', { pid, grant_id: 'g-p32', generation: 1 });
    assert.equal(read.ok, true, `首次观察应成功：${JSON.stringify(read).slice(0, 200)}`);
    hwnd = Number(read.window_identity && read.window_identity.hwnd) || 0;
    assert.ok(hwnd > 0, '应取到窗口句柄');

    let ref = '';
    let buttonRef = '';
    let tabCount = 0;
    (function walk(n) {
      if (n.role === 'tab' && String(n.name || '').trim()) tabCount += 1;
      if (!ref && n.role === 'textfield' && String(n.value || '').includes(seed)) ref = n.ref_id;
      if (!buttonRef && n.role === 'button' && n.ref_id) buttonRef = n.ref_id;
      for (const c of n.children || []) walk(c);
    })(read.tree);
    const soleTabNow = tabCount <= 1;
    soleTab = soleTabNow;
    assert.ok(ref, `应有带种子内容的编辑区 ref（seed=${seed}）`);

    // 动作前必须把目标提到前台；做不到就跳过，不当失败。
    const activate = async (targetHwnd, targetPid) => {
      const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -Namespace OpsAct2 -Name N -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr hWnd, bool fAltTab);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint dwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(uint dwLockFlag);
'@
$h = [System.IntPtr]${Number(targetHwnd)}
if ([OpsAct2.N]::IsIconic($h)) { [void][OpsAct2.N]::ShowWindow($h, 9) }
[void][OpsAct2.N]::LockSetForegroundWindow(2)
[void][OpsAct2.N]::AllowSetForegroundWindow([uint32]::MaxValue)
$fg = [OpsAct2.N]::GetForegroundWindow()
$fgPid = 0
$fgThread = [OpsAct2.N]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$myThread = [OpsAct2.N]::GetCurrentThreadId()
[void][OpsAct2.N]::AttachThreadInput($myThread, $fgThread, $true)
# Alt 按下/抬起解除前台锁（探针已验证；这里不硬编码返回值）
[OpsAct2.N]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
[OpsAct2.N]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
$set = [OpsAct2.N]::SetForegroundWindow($h)
[void][OpsAct2.N]::BringWindowToTop($h)
[void][OpsAct2.N]::AttachThreadInput($myThread, $fgThread, $false)
Start-Sleep -Milliseconds 200
$now = [long][OpsAct2.N]::GetForegroundWindow()
if ($now -ne [long]$h) { [OpsAct2.N]::SwitchToThisWindow($h, $true) }
Start-Sleep -Milliseconds 200
$now = [long][OpsAct2.N]::GetForegroundWindow()
if ($now -ne [long]$h) {
  try { [void][Microsoft.VisualBasic.Interaction]::AppActivate(${Number(targetPid)}) } catch {}
}
Start-Sleep -Milliseconds 200
$now2 = [long][OpsAct2.N]::GetForegroundWindow()
@{ ok = ($now2 -eq [long]$h); set = $set; foreground = $now2 } | ConvertTo-Json -Compress
`;
      const r = await native.runPowerShell(script);
      if (!r.ok) return { ok: false };
      try { return JSON.parse(r.stdout || '{}'); } catch { return { ok: false }; }
    };

    const act = await activate(hwnd, pid);
    if (!act.ok) { t.skip(`无法把记事本提到前台（${JSON.stringify(act)}），本机当前会话不可交互`); return; }

    // 两次 PowerShell 之间前台可能被抢走 → product 判 target_changed（retryable）。
    // 每次动作前重激活，最多 3 次；其他错误原样返回。
    const invoke = async (extra) => {
      let last = null;
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const a = await activate(hwnd, pid);
        if (!a.ok) { last = { ok: false, error: 'computer_target_changed' }; continue; }
        // eslint-disable-next-line no-await-in-loop
        const r = await call('uia_invoke', extra);
        if (!(r && r.ok === false && r.error === 'computer_target_changed')) return r;
        last = r;
        // eslint-disable-next-line no-await-in-loop
        await sleep(800);
      }
      return last;
    };

    // 1) set_value：产品链路（ref + 身份谓词），断言语义 API、无物理投递
    const stamp = `P32-${Date.now()}`;
    const setRes = await invoke({
      pid, ref, grant_id: 'g-p32', generation: 1, action: 'set_value', value: stamp,
      target_summary: read.window,
    });
    assert.equal(setRes.ok, true, `set_value 应成功：${setRes.error || ''} ${setRes.message || ''}`);
    assert.equal(setRes.action, 'set_value');
    assert.ok(Array.isArray(setRes.steps) && setRes.steps.length >= 1);
    assert.equal(setRes.steps[0].label, 'UIValuePattern.SetValue');
    assert.equal(setRes.steps[0].outcome, 'succeeded');
    for (const step of setRes.steps) assert.equal(step.mechanism, 'semantic_api', '不得出现物理投递');
    assert.equal(setRes.satisfied_without_delivery, false);
    // P3-3 的读回也走同一链路：这里顺带确认值真的落到控件上
    assert.ok(String((setRes.post_state && setRes.post_state.value) || '').includes(stamp),
      '读回应能看到写入的文本');

    // 2) set_focus：写入后重新观察一次拿新 ref（值变更可能让树节点换位），
    //    再断单 rung + SetFocus 标签。
    const read2 = await call('uia_read', { pid, grant_id: 'g-p32', generation: 1 });
    assert.equal(read2.ok, true, `动作前重新观察应成功：${JSON.stringify(read2).slice(0, 200)}`);
    let ref2 = '';
    (function walk(n) {
      if (!ref2 && n.role === 'textfield' && String(n.value || '').includes(stamp)) ref2 = n.ref_id;
      for (const c of n.children || []) walk(c);
    })(read2.tree);
    assert.ok(ref2, '重新观察后仍应有带写入文本的编辑区 ref');
    const act2 = await activate(hwnd, pid);
    if (!act2.ok) { t.skip(`动作前无法保持前台（${JSON.stringify(act2)}）`); return; }
    const focusRes = await invoke({
      pid, ref: ref2, grant_id: 'g-p32', generation: 1, action: 'set_focus', target_summary: read2.window,
    });
    assert.equal(focusRes.ok, true, `set_focus 应成功：${focusRes.error || ''} ${focusRes.message || ''}`);
    assert.deepEqual((focusRes.steps || []).map((s) => s.label), ['UIAutomationElement.SetFocus']);

    // 3) 对按钮（无 ValuePattern）做 set_value：剪枝后没有 rung → 明确不支持，而不是乱点
    if (buttonRef) {
      const act3 = await activate(hwnd, pid);
      if (act3.ok) {
        const bad = await invoke({
          pid, ref: buttonRef, grant_id: 'g-p32', generation: 1, action: 'set_value',
          value: 'x', target_summary: read.window,
        });
        assert.equal(bad.ok, false);
        assert.equal(bad.error, 'computer_action_not_supported');
        assert.ok(!bad.steps || bad.steps.length === 0, '被剪枝时不该有已执行的 step');
      }
    }
  } finally {
    // 只回收自己 spawn 的进程：标题里带本次种子文件名才动，绝不按进程名误杀。
    if (spawned) { try { spawned.kill(); } catch { /* 已退出 */ } }
    if (pid) {
      try {
        await native.runPowerShell(`Get-Process | Where-Object { $_.MainWindowTitle -like `
          + `'*${scratchName.replace(/'/g, "''")}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`);
      } catch { /* 已退出或不可杀 */ }
    }
  }
});

test('P3-2: 12 个 pattern 片段可被 PS 解析，且引用的类型/枚举都存在', { timeout: 120_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const os = require('node:os');
  const fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'ops-p32-'));
  t.after(() => { try { fsx.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  // 每个标签按它与「已满足态」相关的 action 生成一次真实脚本文本
  const actionFor = {
    'UITogglePattern.Toggle': 'check',
    'UIExpandCollapsePattern.Expand': 'expand',
    'UIExpandCollapsePattern.Collapse': 'collapse',
    'UISelectionItemPattern.Select': 'select',
  };
  const files = [];
  for (const label of native.PATTERN_LABELS) {
    const name = `${label.replace(/[^A-Za-z]/g, '_')}.ps1`;
    // 故意带一个含单引号的 value，顺带验证转义后的文本仍能被解析
    const text = native.psPatternScript(4242, [0, 1], label, actionFor[label] || 'click', "a'b");
    fsx.writeFileSync(path.join(dir, name), text, 'utf8');
    files.push(name);
  }

  // ① 语法：用脚本引擎自己的 parser 解析每个片段（能抓括号/引号/switch 结构错）
  const parseScript = [
    '$out = @()',
    `foreach ($f in Get-ChildItem -LiteralPath ${native.psQuote(dir)} -Filter *.ps1) {`,
    '  $errs = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)',
    '  $msgs = @()',
    '  if ($errs) { foreach ($e in $errs) { $msgs += [string]$e.Message } }',
    '  $out += @{ name = $f.Name; errors = $msgs }',
    '}',
    '@{ files = $out } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const parsed = await native.runPowerShell(parseScript);
  assert.equal(parsed.ok, true, parsed.error || '');
  const report = JSON.parse(parsed.stdout || '{"files":[]}');
  assert.equal(report.files.length, files.length, '每个标签都应生成一个片段文件');
  for (const item of report.files) {
    assert.deepEqual(item.errors, [], `${item.name} 有语法错误`);
  }

  // ② 引用：parser 不查成员名，所以再把片段用到的 UIA 类型/枚举成员逐个求值一遍。
  //    全部取字符串形态（类型取 .Name，枚举/属性取 ToString），缺任何一个都会让脚本报错。
  const refScript = [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    '$checks = [ordered]@{}',
    "$checks['InvokePattern'] = [System.Windows.Automation.InvokePattern].Name",
    // .NET 的托管 UIA 包装**没有** LegacyIAccessiblePattern（实测类型解析失败），
    // 因此这一 rung 在当前宿主恒被剪枝。这里把这个事实锁成断言：
    // 哪天平台补上了，它会变红，提醒我们重新评估 click 的第二级回退。
    "$checks['LegacyIAccessible'] = 'ABSENT'",
    "try { $checks['LegacyIAccessible'] = [System.Windows.Automation.LegacyIAccessiblePattern].Name } catch { }",
    "$checks['ValuePattern'] = [System.Windows.Automation.ValuePattern].Name",
    "$checks['RangeValuePattern'] = [System.Windows.Automation.RangeValuePattern].Name",
    "$checks['TogglePattern'] = [System.Windows.Automation.TogglePattern].Name",
    "$checks['ExpandCollapse'] = [System.Windows.Automation.ExpandCollapsePattern].Name",
    "$checks['SelectionItem'] = [System.Windows.Automation.SelectionItemPattern].Name",
    "$checks['ScrollPattern'] = [System.Windows.Automation.ScrollPattern].Name",
    "$checks['ScrollItemPattern'] = [System.Windows.Automation.ScrollItemPattern].Name",
    "$checks['ToggleState.On'] = [string][System.Windows.Automation.ToggleState]::On",
    "$checks['ToggleState.Off'] = [string][System.Windows.Automation.ToggleState]::Off",
    "$checks['Expanded'] = [string][System.Windows.Automation.ExpandCollapseState]::Expanded",
    "$checks['Collapsed'] = [string][System.Windows.Automation.ExpandCollapseState]::Collapsed",
    "$checks['ScrollAmount.NoAmount'] = [string][System.Windows.Automation.ScrollAmount]::NoAmount",
    "$checks['ScrollAmount.Large'] = [string][System.Windows.Automation.ScrollAmount]::LargeIncrement",
    "$checks['IsInvokeAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty",
    // 同上：AutomationElement 上取不到这个标识符（实测 NULL）
    "$checks['IsLegacyAvailable'] = 'ABSENT'",
    "try { $v = [System.Windows.Automation.AutomationElement]::IsLegacyIAccessiblePatternAvailableProperty; if ($null -ne $v) { $checks['IsLegacyAvailable'] = $v.ProgrammaticName } } catch { }",
    "$checks['IsValueAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty",
    "$checks['IsRangeAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsRangeValuePatternAvailableProperty",
    "$checks['IsToggleAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty",
    "$checks['IsExpandAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty",
    "$checks['IsSelectionAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty",
    "$checks['IsScrollAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty",
    "$checks['IsScrollItemAvail'] = [string][System.Windows.Automation.AutomationElement]::IsScrollItemPatternAvailableProperty",
    '@{ checks = $checks } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

  const refs = await native.runPowerShell(refScript);
  assert.equal(refs.ok, true, `${refs.error || ''}（说明有 UIA 成员不存在，脚本已中断）`);
  const found = JSON.parse(refs.stdout || '{"checks":{}}').checks || {};
  // 这两项在当前平台**应当**缺失；其余 22 项必须解析出名字。
  const LEGACY_ABSENT = ['LegacyIAccessible', 'IsLegacyAvailable'];
  for (const [key, value] of Object.entries(found)) {
    assert.equal(typeof value, 'string', `${key} 应解析出名字字符串`);
    if (LEGACY_ABSENT.includes(key)) {
      assert.equal(value, 'ABSENT', `${key} 在当前平台应缺失；若已存在，说明可以启用 legacy rung，需重新评估`);
      continue;
    }
    assert.notEqual(value, 'ABSENT', `UIA 成员不存在：${key}`);
    assert.ok(String(value).length > 0, `UIA 成员不存在或为空：${key}`);
  }
  assert.equal(Object.keys(found).length, 24, '成员清单不得缩水');
});
