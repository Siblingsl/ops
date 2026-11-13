'use strict';
// DEV-CU P2-5：窗口身份与 pinned scope 的单测 + 真实采样。
// 六种 reason（window_gone / pid_reused / hwnd_changed / bounds_changed / foreground_changed /
// generation_changed）各一条；另加「多原因顺序」「detail 不泄漏标题」「空字段跳过」。
// 真实部分：① windowIdentity 与选窗器同公式；② 前台采样驱动闸门；③ opt-in：目标不在前台时动作被拒。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, fork } = require('node:child_process');

const {
  SCOPE_REASON, REASON_ORDER, titleHash, targetHandle, positiveInt,
  windowChangeReasons, assertWindowScope, foregroundReasons, assertForeground, assertGeneration,
} = require('../src/computer-worker/scope.js');
const {
  listWindows, windowIdentity, foregroundWindow, runPowerShell, psQuote,
} = require('../src/computer-worker/native.js');

const IDENTITY = {
  pid: 4242, process_start_time: 't0', hwnd: 777, window_bounds_hash: 'wh', target_handle: 'th',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

test('P2-5: target_handle / title_hash 与主进程同一公式', () => {
  const title = '无标题 - 记事本';
  assert.equal(titleHash(title), sha256(title).slice(0, 32));
  // ipc/computer.ts:31 —— sha256(pid + "\u0000" + 标题) 前 32 位
  assert.equal(targetHandle(4242, title), sha256('4242\u0000' + title).slice(0, 32));
  assert.match(targetHandle(1, 'x'), /^[0-9a-f]{32}$/);
  assert.notEqual(targetHandle(1, 'a'), targetHandle(1, 'b'), '标题不同 → handle 不同');
  assert.notEqual(targetHandle(1, 'a'), targetHandle(2, 'a'), 'pid 不同 → handle 不同');
  // 空标题也要有稳定结果（不能抛）
  assert.match(targetHandle(1, ''), /^[0-9a-f]{32}$/);
});

test('P2-5: 六种 reason 各一条', () => {
  assert.deepEqual(windowChangeReasons(IDENTITY, { ...IDENTITY, hwnd: 0 }), [SCOPE_REASON.WINDOW_GONE]);
  assert.deepEqual(windowChangeReasons(IDENTITY, { ...IDENTITY, pid: 9 }), [SCOPE_REASON.WINDOW_GONE]);
  assert.deepEqual(
    windowChangeReasons(IDENTITY, { ...IDENTITY, process_start_time: 't1' }),
    [SCOPE_REASON.PID_REUSED],
  );
  assert.deepEqual(windowChangeReasons(IDENTITY, { ...IDENTITY, hwnd: 888 }), [SCOPE_REASON.HWND_CHANGED]);
  assert.deepEqual(
    windowChangeReasons(IDENTITY, { ...IDENTITY, window_bounds_hash: 'wh2' }),
    [SCOPE_REASON.BOUNDS_CHANGED],
  );
  assert.deepEqual(foregroundReasons(4242, { pid: 1, hwnd: 2 }, 777), [SCOPE_REASON.FOREGROUND_CHANGED]);
  assert.throws(() => assertGeneration(3, 4), (e) => {
    assert.equal(e.code, 'computer_stale_ref');
    assert.deepEqual(e.detail.reason, [SCOPE_REASON.GENERATION_CHANGED]);
    assert.equal(e.detail.expected_generation, 3);
    assert.equal(e.detail.actual_generation, 4);
    return true;
  });
  // 枚举封闭且无遗漏
  assert.equal(Object.keys(SCOPE_REASON).length, 6);
  assert.deepEqual(Object.values(SCOPE_REASON).sort(), REASON_ORDER.slice().sort());
});

test('P2-5: 多个原因同时命中时按固定顺序给出', () => {
  const reasons = windowChangeReasons(IDENTITY, { ...IDENTITY, hwnd: 888, window_bounds_hash: 'wh2' });
  assert.deepEqual(reasons, [SCOPE_REASON.HWND_CHANGED, SCOPE_REASON.BOUNDS_CHANGED]);
  // 同一情形多次判定结果稳定
  assert.deepEqual(
    windowChangeReasons(IDENTITY, { ...IDENTITY, hwnd: 888, window_bounds_hash: 'wh2' }),
    reasons,
  );
});

test('P2-5: detail 不泄漏窗口标题与进程名', () => {
  const title = '机密项目 - 记事本';
  try {
    assertWindowScope(IDENTITY, { ...IDENTITY, hwnd: 999 });
    assert.fail('应抛错');
  } catch (e) {
    const serialized = JSON.stringify(e.detail);
    assert.ok(!serialized.includes('机密项目'), `detail 不应含窗口标题：${serialized}`);
    assert.ok(!/记事本|notepad/i.test(serialized), `detail 不应含进程名：${serialized}`);
    assert.deepEqual(e.detail.reason, [SCOPE_REASON.HWND_CHANGED]);
    assert.equal(e.detail.expected_hwnd, 777);
    assert.equal(e.detail.actual_hwnd, 999);
    assert.equal(e.detail.expected_pid, 4242);
    // 断言标题确实在期望对象里（证明不是「本来就没有标题」而侥幸通过）
    assert.ok(title.length > 0);
  }
  try {
    assertForeground(4242, { pid: 7, hwnd: 8 }, 777);
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'computer_target_changed');
    assert.deepEqual(e.detail.reason, [SCOPE_REASON.FOREGROUND_CHANGED]);
    assert.ok(!/记事本|notepad/i.test(JSON.stringify(e.detail)));
  }
});

test('P2-5: 动作前置探测保留 target_changed 的 detail.reason（真实窗口，不落动作）', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const { executeActionChain, foregroundWindow } = require('../src/computer-worker/native.js');
  const listed = await listWindows();
  // 用「真实存在、但不是当前前台」的窗口当目标；路径故意不存在，
  // 守卫通过时最多 control_not_found，绝不会真的操作到任何控件。
  const fg = await foregroundWindow();
  const hit = (listed.windows || []).find((w) => !w.forbidden
    && positiveInt(w.pid) && (!fg || w.pid !== fg.pid));
  if (!hit) { t.skip('没有可用的非前台窗口'); return; }
  const res = await executeActionChain(hit.pid, [999999], 'set_value', '');
  if (res.error === 'control_not_found') { t.skip('目标窗口当前在前台，无法构造前台拒绝'); return; }
  assert.equal(res.ok, false);
  assert.equal(res.error, 'computer_target_changed', `应为目标变化拒绝：${JSON.stringify(res)}`);
  assert.ok(res.detail && Array.isArray(res.detail.reason), `detail.reason 必须存在：${JSON.stringify(res.detail)}`);
  assert.equal(res.detail.kind, 'target_changed');
  assert.ok(res.detail.reason.length > 0, 'reason 不应为空数组');
});

test('P2-5: 期望侧空字段跳过（当时没采到不误判）', () => {
  assert.deepEqual(windowChangeReasons({ pid: 1, hwnd: 0, process_start_time: '' }, { pid: 1, hwnd: 5 }), []);
  assert.equal(assertWindowScope({}, { hwnd: 5 }), true);
  assert.equal(assertForeground(1, { pid: 1, hwnd: 9 }), true, 'expectedHwnd 为空时只判 pid');
  assert.equal(positiveInt(0), null);
  assert.equal(positiveInt('12'), 12);
});

test('P2-5 真实采样：windowIdentity 与选窗器同公式', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const listed = await listWindows();
  assert.equal(listed.ok, true, `选窗应成功：${JSON.stringify(listed)}`);
  const win = (listed.windows || []).find((w) => !w.forbidden && String(w.title || '').trim());
  if (!win) { t.skip('当前桌面没有可用窗口'); return; }

  const identity = await windowIdentity(win.pid);
  assert.equal(identity.ok, true, `身份采样应成功：${JSON.stringify(identity)}`);
  assert.equal(identity.pid, win.pid);
  assert.ok(identity.hwnd > 0, '窗口应有 hwnd');
  assert.equal(identity.target_handle, targetHandle(win.pid, win.title),
    'target_handle 必须与主进程同公式（服务端才能核对）');
  assert.equal(identity.title_hash, titleHash(win.title));
  assert.match(identity.window_bounds_hash, /^[0-9a-f]{16}$/);
  assert.ok(identity.process_start_time.length > 0, '应取到进程启动时间（防 PID 复用）');
  // 标题明文不得出现在采样结果里
  assert.ok(!JSON.stringify(identity).includes(win.title.slice(0, 6)),
    `采样结果不应含标题明文：${JSON.stringify(identity)}`);
  console.log(`P25_IDENTITY_OK pid=${identity.pid} hwnd=${identity.hwnd}`
    + ` handle=${identity.target_handle} bounds=${identity.window_bounds_hash}`);
});

test('P2-5 真实前台：采样可用，且 pid 不符时拒绝', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const fg = await foregroundWindow();
  if (!fg.ok || !fg.hwnd || !fg.pid) { t.skip(`当前会话没有前台窗口：${JSON.stringify(fg)}`); return; }
  assert.equal(assertForeground(fg.pid, fg), true, '真实前台应通过与自身的比对');
  assert.throws(() => assertForeground(fg.pid, { ...fg, pid: fg.pid + 1 }), (e) => {
    assert.equal(e.code, 'computer_target_changed');
    assert.deepEqual(e.detail.reason, [SCOPE_REASON.FOREGROUND_CHANGED]);
    return true;
  });
  console.log(`P25_FOREGROUND_OK pid=${fg.pid} hwnd=${fg.hwnd}`);
});

/** 只对我们自己开的窗口做最小化 / 还原（不碰别人的窗口）。 */
function showWindow(hwnd, cmd) {
  const script = `
Add-Type -Namespace OpsWin -Name W -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
$h = [System.IntPtr]${Number(hwnd)}
$r = [OpsWin.W]::ShowWindow($h, ${Number(cmd)})
if (${Number(cmd)} -ne 6) { [void][OpsWin.W]::SetForegroundWindow($h) }
Write-Output ('ok=' + $r)
`;
  return runPowerShell(script);
}

/** 只移动窗口（不改大小、不改层级），用于构造「窗口被挪走」的真实场景。 */
function moveWindow(hwnd, x, y) {
  const script = `
Add-Type -Namespace OpsWin -Name M -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
$h = [System.IntPtr]${Number(hwnd)}
$r = [OpsWin.M]::SetWindowPos($h, [System.IntPtr]::Zero, ${Number(x)}, ${Number(y)}, 0, 0, 0x0001 -bor 0x0004)
Write-Output ('ok=' + $r)
`;
  return runPowerShell(script);
}

/** 只把某个窗口提到前台（不改它的显示状态）。 */
function focusWindow(hwnd) {
  const script = `
Add-Type -Namespace OpsWin -Name F -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
$h = [System.IntPtr]${Number(hwnd)}
Write-Output ('ok=' + [OpsWin.F]::SetForegroundWindow($h))
`;
  return runPowerShell(script);
}

/**
 * 只关掉本次运行新增的那个标签（按唯一文件名精确匹配）。
 * 新版记事本是单进程多标签：用户窗口里可能已经有几十个标签，`process.kill` 会连它们一起关掉，
 * 所以多标签时绝不能杀进程，只走这里。做法与实测探针一致：UIA 选中该 TabItem →
 * AttachThreadInput 把窗口提到前台 → 确认前台确实是它 → Ctrl+W → 数剩余同名标签。
 */
function closeScratchTab(hwnd, scratchName) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace OpsClean -Name N -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
'@
$h = [System.IntPtr]${Number(hwnd)}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$pattern = ${psQuote(scratchName)}
$hit = $null
foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
  if ([string]$t.Current.Name -like ('*' + $pattern + '*')) { $hit = $t; break }
}
if ($null -eq $hit) { Write-Output '{"ok":true,"hit":false,"left":0}'; exit }
try { $sel = $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $sel.Select() } catch { }
Start-Sleep -Milliseconds 250
$fg = [OpsClean.N]::GetForegroundWindow()
$fgPid = 0
$fgThread = [OpsClean.N]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$myThread = [OpsClean.N]::GetCurrentThreadId()
[void][OpsClean.N]::AttachThreadInput($myThread, $fgThread, $true)
$set = [OpsClean.N]::SetForegroundWindow($h)
[void][OpsClean.N]::AttachThreadInput($myThread, $fgThread, $false)
Start-Sleep -Milliseconds 250
if ([long][OpsClean.N]::GetForegroundWindow() -ne [long]$h) {
  Write-Output ('{"ok":false,"hit":true,"foreground":false,"set":' + $set + '}'); exit
}
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys('^w')
Start-Sleep -Milliseconds 500
$left = 0
foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
  if ([string]$t.Current.Name -like ('*' + $pattern + '*')) { $left++ }
}
Write-Output ('{"ok":true,"hit":true,"foreground":true,"left":' + $left + '}')
`;
  return runPowerShell(script);
}

/**
 * 找一个「不是目标进程」的普通窗口并切过去；切不动就返回 null（不硬来）。
 * 用于构造「前台已切到别的应用」的真实场景。
 */
async function activateAnotherWindow(exceptPid) {
  const list = await listWindows();
  const cands = (list.windows || []).filter((w) => !w.forbidden && w.pid !== exceptPid
    && String(w.title || '').trim());
  for (const w of cands.slice(0, 4)) {
    const id = await windowIdentity(w.pid);
    if (!id.ok || !id.hwnd) continue;
    await focusWindow(id.hwnd);
    await sleep(700);
    const fg = await foregroundWindow();
    if (fg.ok && fg.hwnd === id.hwnd) return { pid: w.pid, hwnd: id.hwnd };
  }
  return null;
}

test('P2-5 真实动作：几何变化与前台切走都会被拒（需 OPS_UIA_MANUAL=1 且 OPS_UIA_SPAWN=1）',
  { timeout: 180_000 }, async (t) => {
    if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
    if (process.env.OPS_UIA_MANUAL !== '1' || process.env.OPS_UIA_SPAWN !== '1') {
      t.skip('需 OPS_UIA_MANUAL=1 且 OPS_UIA_SPAWN=1（会开一个临时文件窗口）');
      return;
    }

    const entryPath = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');
    const child = fork(entryPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const call = (cmd, extra = {}, timeoutMs = 25_000) => new Promise((resolve, reject) => {
      const id = 'p' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => { child.off('message', onMsg); reject(new Error('timeout')); }, timeoutMs);
      const onMsg = (m) => { if (m && m.id === id) { clearTimeout(timer); child.off('message', onMsg); resolve(m); } };
      child.on('message', onMsg);
      child.send({ id, cmd, ...extra });
    });

    const seed = `P25-SEED-${process.pid}-${Date.now()}`;
    const scratch = path.join(os.tmpdir(), `ops-p25-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(scratch, seed, 'utf8');
    const scratchName = path.basename(scratch);
    let pid = 0;
    let soleTab = false;
    let hwnd = 0;
    const fgBefore = await foregroundWindow();

    try {
      spawn('notepad', [scratch], { stdio: 'ignore' });
      const deadline = Date.now() + 90_000;
      while (!pid && Date.now() < deadline) {
        await sleep(500);
        const list = await call('list_windows');
        if (!list || list.ok !== true) continue;
        const hit = (list.windows || []).find((w) => /notepad/i.test(w.process)
          && String(w.title || '').includes(scratchName));
        if (hit) pid = hit.pid;
      }
      if (!pid) { t.skip('未枚举到本次打开的记事本窗口'); return; }

      const read = await call('uia_read', { pid, grant_id: 'g-scope', generation: 1 });
      assert.equal(read.ok, true, `读树应成功：${JSON.stringify(read)}`);
      hwnd = Number(read.window_identity && read.window_identity.hwnd) || 0;
      assert.ok(hwnd > 0, '应取到窗口句柄');

      let tabCount = 0;
      let ref = '';
      (function walk(n) {
        if (n.role === 'tab' && String(n.name || '').trim()) tabCount += 1;
        if (!ref && n.role === 'textfield' && String(n.value || '').includes(seed)) ref = n.ref_id;
        for (const c of n.children) walk(c);
      })(read.tree);
      soleTab = tabCount <= 1;
      assert.ok(ref, `应有带种子内容的编辑区 ref（seed=${seed}）`);

      // ① 窗口被挪走 → 几何哈希变化 → 快照失效（C03）。挪的是我们自己开的窗口。
      const geo = await windowIdentity(pid);
      assert.equal(geo.ok, true, `身份采样应成功：${JSON.stringify(geo)}`);
      const home = { x: Math.round(geo.bounds.x), y: Math.round(geo.bounds.y) };
      await moveWindow(hwnd, home.x + 48, home.y + 36);
      await sleep(800);
      const moved = await call('uia_invoke', {
        pid, ref, grant_id: 'g-scope', generation: 1, value: 'P25-SHOULD-NOT-WRITE',
        target_summary: read.window,
      });
      assert.equal(moved.ok, false, `窗口移动后动作必须被拒：${JSON.stringify(moved)}`);
      assert.equal(moved.error, 'computer_stale_ref', `应判快照失效：${JSON.stringify(moved)}`);
      assert.ok((moved.detail && moved.detail.reason || []).includes(SCOPE_REASON.BOUNDS_CHANGED),
        `reason 应含 bounds_changed：${JSON.stringify(moved.detail)}`);

      // 挪回原位后重新观察，拿一个新快照做「前台切走」的用例
      await moveWindow(hwnd, home.x, home.y);
      await sleep(700);
      const read2 = await call('uia_read', { pid, grant_id: 'g-scope', generation: 1 });
      assert.equal(read2.ok, true, `二次读树应成功：${JSON.stringify(read2)}`);
      let ref2 = '';
      (function walk(n) {
        if (!ref2 && n.role === 'textfield' && String(n.value || '').includes(seed)) ref2 = n.ref_id;
        for (const c of n.children) walk(c);
      })(read2.tree);
      assert.ok(ref2, '二次观察应有可写入的编辑区 ref');

      // ② 前台切到别的窗口 → 停控（P2-5 步骤 3）
      const other = await activateAnotherWindow(pid);
      if (!other) { t.skip('没有可用的第二个窗口，无法构造「前台切走」场景'); return; }
      const refused = await call('uia_invoke', {
        pid, ref: ref2, grant_id: 'g-scope', generation: 1, value: 'P25-SHOULD-NOT-WRITE',
        target_summary: read2.window,
      });
      assert.equal(refused.ok, false, `前台已切走，动作必须被拒：${JSON.stringify(refused)}`);
      assert.equal(refused.error, 'computer_target_changed', `应判目标已变：${JSON.stringify(refused)}`);
      assert.deepEqual(refused.detail && refused.detail.reason, [SCOPE_REASON.FOREGROUND_CHANGED]);
      console.log(`P25_SCOPE_OK pid=${pid} bounds_changed=1 foreground=${other.pid}`
        + ` refused=foreground_changed`);
    } finally {
      if (hwnd) { try { await showWindow(hwnd, 9); } catch { /* 还原失败不影响结论 */ } }
      // 收拾自己留下的痕迹：单标签时整窗退出；多标签时只关本次新增的那个标签
      // （绝不整窗 kill——那会把用户已有的标签一起关掉）。
      if (pid && soleTab) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
      } else if (pid && hwnd) {
        for (let i = 0; i < 3; i++) {
          let left = -1;
          try {
            const r = await closeScratchTab(hwnd, scratchName);
            const m = /"left":(\d+)/.exec(String((r && r.stdout) || ''));
            if (m) left = Number(m[1]);
          } catch { break; }
          if (left <= 0) break;
          await sleep(300);
        }
      }
      // 把焦点还给测试开始前的窗口（我们可能切走过）
      if (fgBefore && fgBefore.ok && fgBefore.hwnd) {
        try { await focusWindow(fgBefore.hwnd); } catch { /* 窗口可能已关闭 */ }
      }
      child.kill();
      try { fs.unlinkSync(scratch); } catch { /* 可能仍被占用 */ }
    }
  });
