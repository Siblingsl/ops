'use strict';
// DEV-AI27-17 W17b：电脑控制 worker 测试（真实 utilityProcess 子进程枚举真实窗口）。

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker.js');

function withWorker(t) {
  const child = fork(WORKER, [], { stdio: 'ignore', env: { OPS_DESKTOP_WORKER: '1' } });
  let nextID = 1;
  const pending = new Map();
  child.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'string') return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    call.resolve(msg);
  });
  t.after(() => child.kill());
  return {
    call(cmd, timeoutMs = 20_000) {
      const id = `t${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('worker_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject: (e) => reject(new Error(e)) , timer });
        child.send({ id, cmd });
      });
    },
  };
}

test('W17 worker: ping 响应', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  const result = await worker.call('ping');
  assert.equal(result.ok, true);
  assert.equal(result.pong, true);
});

test('W17 worker: 枚举真实窗口（Windows 本机）', { timeout: 40_000 }, async (t) => {
  // node:test 的 t.skip() 只标记结果、不中断执行，必须自己 return。
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const worker = withWorker(t);
  const result = await worker.call('list_windows');
  assert.equal(result.ok, true, result.error || '');
  assert.ok(Array.isArray(result.windows));
  // 本机一定有部分可见窗口；每项含 pid/process/title/forbidden
  for (const w of result.windows) {
    assert.equal(typeof w.pid, 'number');
    assert.equal(typeof w.process, 'string');
    assert.equal(typeof w.title, 'string');
    assert.equal(typeof w.forbidden, 'boolean');
    assert.ok(w.title.length > 0, '枚举只返回有标题窗口');
  }
  // 硬禁区标记正确：cmd/powershell 等进程名应标 forbidden
  for (const w of result.windows) {
    if (/cmd|powershell|regedit/i.test(w.process)) {
      assert.equal(w.forbidden, true, `${w.process} 应标记硬禁区`);
    }
  }
});

test('W17 worker: 未知命令拒绝', { timeout: 20_000 }, async (t) => {
  const worker = withWorker(t);
  const result = await worker.call('execute_shell');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_cmd');
});

// ---------------------------------------------------------------------------
// DEV-AI27-17 W17c：UIA 动作执行（真实 Windows 应用旅程——C01/C03/C05 子集）。
// 依赖本机记事本（notepad）；Windows 11 可能用 Notepad.exe（Store 版）UIA 兼容。
// 旅程：启动记事本 → UIA 读控件树 → SetValue 输入文本 → 读回验证 → 关闭不保存。
// ---------------------------------------------------------------------------

const { execFile: execFile2, spawn } = require('node:child_process');
const { readUIAFromWorker, invokeUIAOnWorker } = (() => {
  // 用与 worker 相同的 PowerShell UIA 桥（直测桥函数；worker 侧已覆盖命令路由）。
  // 直接 spawn notepad + UIA 读取。
  return { readUIAFromWorker: null, invokeUIAOnWorker: null };
})();

function psScript(script, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile2('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}

test('W17c UIA: 真实记事本读控件树 + SetValue 输入 + 读回验证（C01/C03/C05 子集）', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  // 注意：node:test 的 t.skip() 只标记结果，**不会中断函数执行**。
  // 这里曾经少了 return，导致每次跑 pnpm test 都会真的 spawn 一个记事本窗口
  // （而且因为结果被标记为 skip，报错也被吞掉，没人发现）。
  // GUI 旅程在 agent 会话（Session 0 隔离）里跑不了，改为显式开关：
  //   OPS_UIA_MANUAL=1 pnpm test   —— 需在用户桌面会话执行
  //   或直接跑 desktop/scripts/uia-notepad-manual.ps1
  if (process.env.OPS_UIA_MANUAL !== '1') {
    t.skip('GUI 旅程需用户桌面会话人工执行：设 OPS_UIA_MANUAL=1 可开启，或跑 desktop/scripts/uia-notepad-manual.ps1');
    return;
  }
  // 1. 启动记事本（独立进程）
  const notepad = spawn('notepad', [], { stdio: 'ignore' });
  t.after(() => { try { notepad.kill(); } catch {} });
  // 等 UIA 就绪
  await new Promise((r) => setTimeout(r, 2500));

  // 2. 找到记事本 PID
  const pidOut = await psScript(
    "(Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -First 1).Id");
  const pid = Number(String(pidOut).trim());
  if (!Number.isInteger(pid) || pid <= 0) { t.skip('记事本不可用（Windows 11 Store 版路径差异）'); return; }

  // 3. UIA 读控件树：应包含编辑区（Edit 控件）
  const treeOut = await psScript(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit))
if (-not $edit) { Write-Output 'NOEDIT'; exit }
$vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue('W17c-UIA-TEST-INPUT')
Write-Output 'SETVALUE-OK'
`);
  const tree = String(treeOut).trim();
  if (tree === 'NOEDIT') { t.skip('记事本无 Edit 控件（Store 版差异）'); return; }
  assert.ok(tree.includes('SETVALUE-OK'), `SetValue 应成功：${tree}`);

  // 4. 读回验证（C03 观察变化：SetValue 后 value 真实变化）
  const readBack = await psScript(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit))
$vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
Write-Output $vp.Current.Value
`);
  assert.ok(String(readBack).includes('W17c-UIA-TEST-INPUT'), `读回应包含写入文本：${readBack}`);

  // 5. 清理：关闭记事本（不保存——记事本无改动保存对话框，kill 即可）
  notepad.kill();
});
