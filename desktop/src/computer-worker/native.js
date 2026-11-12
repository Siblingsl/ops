'use strict';
// DEV-CU P2-0：Windows 本机执行层（从 computer-worker.js 原样搬出，零行为变更）。
// 内容：窗口枚举 + PowerShell UIA 桥（读树/单控件动作）。
// 隔离说明（27 §11.5.2）：UIA 具备进程级读取能力，不是应用沙箱——服务端逐动作校验
// 所选窗口与范围（agent_computer_grant + 硬禁区双层），worker 只按授权 PID 执行。
// 本文件不碰消息协议，只提供能力函数；协议与 busy 串行化在 index.js。

const { execFile } = require('node:child_process');

const { isHardForbidden } = require('./policy');
const { buildObserveTree } = require('./tree');
const {
  newSnapshotId, nextRevision, allocateTreeRefs, qualifyTreeRefs,
  assertTreeSize, countRefs, refsAreUnique, WorkerError,
} = require('./refs');

/** 枚举可见顶层窗口（PowerShell：有主窗口的进程）。返回脱敏摘要（pid/标题/进程名）。 */
function listWindows() {
  return new Promise((resolve) => {
    const script =
      "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | " +
      "Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: 'enum_failed: ' + err.message.slice(0, 120), windows: [] });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout || '[]');
        } catch {
          resolve({ ok: false, error: 'enum_parse_failed', windows: [] });
          return;
        }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const windows = list
          .filter((w) => w && w.Id && w.MainWindowTitle)
          .map((w) => ({
            pid: Number(w.Id),
            process: String(w.ProcessName || '').slice(0, 64),
            title: String(w.MainWindowTitle || '').slice(0, 120),
            forbidden: isHardForbidden(w.ProcessName) || isHardForbidden(w.MainWindowTitle),
          }));
        resolve({ ok: true, windows });
      });
  });
}

// ---------------------------------------------------------------------------
// DEV-AI27-17 UIA 桥（W17 第三批）：PowerShell + System.Windows.Automation。
// ---------------------------------------------------------------------------

const UIA_TIMEOUT_MS = 15_000;

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: UIA_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: 'uia_failed: ' + String(err.message).slice(0, 120) });
          return;
        }
        resolve({ ok: true, stdout: stdout || '' });
      });
  });
}

/** C01/C03 + P2-1：读取 PID 主窗口 UIA 控件树（RawViewWalker 递归，带三重上限）。 */
function readUIA(pid) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
$startTime = ''
try { $startTime = $proc.StartTime.ToUniversalTime().ToString('o') } catch {}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
# DEV-CU P1-1 步骤 4：四字段强制字符串并裁剪，上限对齐 business-ui-preload.ts:192-195（200/60/500/4000）。
function Clip([string]$s, [int]$n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { return $s.Substring(0,$n) }; return $s }
# P2-1：UIA 的 BoundingRectangle 在虚拟化/屏外元素上可能返回 NaN 或 Infinity，
# ConvertTo-Json 会原样写出 Infinity 导致整段 JSON 非法（实测 W17c 报 uia_parse_failed）。
function SafeNum([double]$v) { if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 0.0 }; return $v }
$MAX_NODES = 200
$MAX_DEPTH = 50
$MAX_SIBLINGS = 10000
$complete = $true
# P2-1 步骤 1：RawViewWalker 逐层遍历，记录 depth/parent，不再 FindAll 平铺。
# 队列元素 parent 指向「已产出节点」的下标；节点自身失效时子节点继承其 parent，避免断链。
$queue = New-Object System.Collections.ArrayList
$null = $queue.Add(@{ el=$root; depth=0; parent=-1 })
$emitted = New-Object System.Collections.ArrayList
$qi = 0
while ($qi -lt $queue.Count) {
  $item = $queue[$qi]
  $qi++
  $el = $item.el
  $roleRaw = ''
  $name = ''; $id = ''; $value = ''
  $enabled = $false; $offscreen = $false
  $bx = 0; $by = 0; $bw = 0; $bh = 0
  $hasValue = $false; $hasInvoke = $false
  # 快照条目可能在枚举期间失效：读不到 ControlType 就不产出该节点（同 P1-1 的空行修复）。
  try {
    $roleRaw = [string]$el.Current.ControlType.ProgrammaticName
    $name = [string]$el.Current.Name
    $id = [string]$el.Current.AutomationId
    $enabled = [bool]$el.Current.IsEnabled
    $offscreen = [bool]$el.Current.IsOffscreen
    $r = $el.Current.BoundingRectangle
    $bx = SafeNum ([double]$r.X); $by = SafeNum ([double]$r.Y)
    $bw = SafeNum ([double]$r.Width); $bh = SafeNum ([double]$r.Height)
  } catch { $roleRaw = '' }
  $ownIndex = -1
  if (-not [string]::IsNullOrEmpty($roleRaw)) {
    $vpObj = $null
    try { $hasValue = [bool]$el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vpObj) } catch { $hasValue = $false }
    if ($hasValue) { try { $value = [string]$vpObj.Current.Value } catch { $value = '' } }
    $ipObj = $null
    try { $hasInvoke = [bool]$el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ipObj) } catch { $hasInvoke = $false }
    $rec = @{
      parent=$item.parent; depth=$item.depth; role_raw=$roleRaw; name=(Clip $name 500); id=(Clip $id 200);
      value=(Clip $value 4000); enabled=$enabled; offscreen=$offscreen;
      bounds=@{ x=$bx; y=$by; w=$bw; h=$bh }; has_value=$hasValue; has_invoke=$hasInvoke;
      children_count=0; stale=$false
    }
    $null = $emitted.Add($rec)
    $ownIndex = $emitted.Count - 1
  }
  $childParent = $item.parent
  if ($ownIndex -ge 0) { $childParent = $ownIndex }
  # 深度上限：还有子节点就置 complete=false，不再深入。
  if ($item.depth -ge $MAX_DEPTH) {
    try { if ($null -ne $walker.GetFirstChild($el)) { $complete = $false } } catch { }
    continue
  }
  $count = 0
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { $child = $null }
  while ($null -ne $child) {
    $count++
    if ($count -gt $MAX_SIBLINGS) { $complete = $false; break }
    if ($queue.Count -lt $MAX_NODES) {
      $null = $queue.Add(@{ el=$child; depth=$item.depth+1; parent=$childParent })
    } else { $complete = $false }
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
  if ($ownIndex -ge 0) { $emitted[$ownIndex].children_count = $count }
}
$winName = ''
try { $winName = [string]$root.Current.Name } catch {}
@{ ok=$true; window=$winName; pid=${pid}; hwnd=[long]$hwnd; process_start_time=$startTime; tree_complete=$complete; nodes_observed=$queue.Count; nodes=$emitted } | ConvertTo-Json -Compress -Depth 6
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try {
      const parsed = JSON.parse(r.stdout || '{}');
      if (parsed.ok !== true) return { ok: false, error: parsed.error || 'uia_failed' };
      const built = buildObserveTree(parsed);
      // P2-2：一次观察绑定一个 snapshot_id + 单调 revision；ref 在本进程内分配后立即限定。
      const snapshotId = newSnapshotId();
      const revision = nextRevision();
      let allocated;
      try {
        allocated = allocateTreeRefs(built.tree, { snapshotId, revision, identity: built.window_identity });
        qualifyTreeRefs(allocated.tree, snapshotId);
        assertTreeSize(allocated.tree);
      } catch (e) {
        if (e instanceof WorkerError) return { ok: false, error: e.code, message: e.message };
        throw e;
      }
      // 自检：ref_count 必须与树中 ref_id 数量一致、且两两不同（P2-2 完成判据）。
      if (countRefs(allocated.tree) !== allocated.count || !refsAreUnique(allocated.tree)) {
        return { ok: false, error: 'computer_internal', message: 'ref 分配自检失败' };
      }
      return {
        ok: true,
        window: parsed.window,
        // P2-2 新增
        snapshot_id: snapshotId,
        revision,
        ref_count: allocated.count,
        tree: allocated.tree,
        // P2-1 字段
        complete: built.complete,
        nodes_observed: built.nodes_observed,
        window_identity: built.window_identity,
        // 兼容视图：P1-3 的 preload 集成用例仍按四键平铺校验，P3-7 切树后移除
        controls: built.controls,
      };
    } catch {
      return { ok: false, error: 'uia_parse_failed' };
    }
  });
}

/** C05/C06：单控件动作——ValuePattern.SetValue（有 value 时）或 InvokePattern.Invoke。 */
function invokeUIA(pid, automationId, value) {
  const valueBlock = value === null
    ? `try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); Write-Output '{"ok":true,"action":"invoke"}' } catch { Write-Output '{"ok":false,"error":"no_invoke_pattern"}' }`
    : `try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $vp.SetValue(${psQuote(value)}); Write-Output '{"ok":true,"action":"setvalue"}' } catch { Write-Output '{"ok":false,"error":"no_value_pattern"}' }`;
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ${psQuote(automationId)})
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { Write-Output '{"ok":false,"error":"control_not_found"}'; exit }
${valueBlock}
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try { return JSON.parse(r.stdout || '{"ok":false,"error":"empty"}'); }
    catch { return { ok: false, error: 'uia_parse_failed' }; }
  });
}

module.exports = { listWindows, readUIA, invokeUIA, runPowerShell, psQuote, UIA_TIMEOUT_MS };
