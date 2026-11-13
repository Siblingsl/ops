'use strict';
// DEV-AI27-17 W17b：电脑控制 worker 测试（真实 utilityProcess 子进程枚举真实窗口）。

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');

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
    call(cmd, timeoutMs = 20_000, extra = {}) {
      const id = `t${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('worker_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject: (e) => reject(new Error(e)) , timer });
        child.send({ id, cmd, ...extra });
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

test('W17c UIA: 真实记事本读控件树 + SetValue 输入 + 读回验证（C01/C03/C05 子集）', { timeout: 150_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  // node:test 的 t.skip() 只标记结果、不中断函数执行（历史坑：曾因此每次跑都真开一个记事本）。
  // DEV-CU P1-2：GUI 旅程在 OPS_UIA_MANUAL=1 时**真实执行并通过**，不再 skip。
  // 走 worker 自己的命令（list_windows → uia_read），即产品实际路径，而不是另写一套 PS。
  if (process.env.OPS_UIA_MANUAL !== '1') {
    t.skip('GUI 旅程需真实桌面：设 OPS_UIA_MANUAL=1 开启（本机 2026-11-12 已实测通过）');
    return;
  }

  // 1. 选一个真实记事本窗口当被测对象。
  // 默认**不自动开窗**（会打断使用者）：只有显式 OPS_UIA_SPAWN=1 才 spawn，
  // 否则复用已经开着的记事本；没有就 skip，让用例本身不产生副作用。
  // 2026-11-13：改为自带临时文件的记事本，并按文件名精确选窗；清理只回收本用例起的进程。
  // 旧写法挑「任意记事本」再 Stop-Process -Force，会连带杀掉用户正开着的窗口（已真实发生）。
  let spawned = null;
  let scratch = '';
  if (process.env.OPS_UIA_SPAWN === '1') {
    scratch = path.join(os.tmpdir(), `ops-w17c-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(scratch, 'W17C-SEED', 'utf8');
    // Win11 为打包版：spawn 返回的是启动器桩进程，随后自行退出；按窗口标题认领更可靠。
    spawned = spawn('notepad', [scratch], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 2500));
  }
  const scratchName = scratch ? path.basename(scratch) : '';

  // 2. 用 worker 的选窗器找真实窗口（不用桩 PID：桩进程已退出，按 -Id 反查必失败）
  const worker = withWorker(t);
  const listed = await worker.call('list_windows');
  assert.equal(listed.ok, true, `选窗应成功：${JSON.stringify(listed)}`);
  const notepadWin = (listed.windows || []).find((w) => /notepad/i.test(w.process)
    && (!scratchName || String(w.title || '').includes(scratchName)));
  if (!notepadWin) {
    t.skip('未找到本次打开的记事本窗口（默认不自动开窗；需要真实旅程时设 OPS_UIA_SPAWN=1）');
    return;
  }
  const pid = notepadWin.pid;
  t.after(async () => {
    // 只回收自己 spawn 的进程；复用用户窗口时绝不动它。
    if (spawned) { try { spawned.kill(); } catch { /* 可能已退出 */ } }
    if (scratch) { try { fs.unlinkSync(scratch); } catch { /* 可能仍被占用 */ } }
  });

  // 3. worker 读树：窗口名非空，且至少一个控件的 name / id 非空（P1-1 完成判据）
  // 新版记事本启动后会**恢复上次会话的标签页**：恢复期间窗口标题为空、Document 还没生成
  // （实测读到 nodes_observed=6、只有 Pane、window 为空）。固定 2.5s 后单次读树会因此假红，
  // 改为有界等待「标题非空 + 出现 Document/Edit」，最多 20s；超时仍按原断言判红。
  let read1 = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    read1 = await worker.call('uia_read', 20_000, { pid });
    const ready = read1 && read1.ok === true && String(read1.window || '').length > 0
      && (read1.controls || []).some((c) => /^ControlType\.(Document|Edit)$/.test(String(c.type || '')));
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(read1.ok, true, `读树应成功：${JSON.stringify(read1)}`);
  assert.ok(String(read1.window || '').length > 0, `窗口名不应为空：${JSON.stringify(read1)}`);
  const controls = read1.controls || [];
  assert.ok(controls.length > 0, '控件树不应为空');
  const named = controls.filter((c) => String(c.name || c.id || '').length > 0);
  assert.ok(named.length > 0,
    `至少一个控件的 name/id 非空（修复前 CurrentName 恒空）：${JSON.stringify(controls.slice(0, 5))}`);

  // P1-3 步骤 1/2：四键齐备、值不为 null，且 type 形如 ControlType.X（修复前这些字段恒为 null/空）。
  for (const c of controls) {
    for (const key of ['id', 'type', 'name', 'value']) {
      assert.ok(Object.prototype.hasOwnProperty.call(c, key), `控件缺少字段 ${key}：${JSON.stringify(c)}`);
      assert.notEqual(c[key], null, `控件字段 ${key} 不应为 null：${JSON.stringify(c)}`);
      assert.equal(typeof c[key], 'string', `控件字段 ${key} 应为字符串：${JSON.stringify(c)}`);
    }
    assert.ok(c.type.length > 0, `控件 type 不应为空：${JSON.stringify(c)}`);
  }
  const typed = controls.filter((c) => /^ControlType\./.test(c.type));
  assert.ok(typed.length > 0, `至少一个控件 type 形如 ControlType.X：${JSON.stringify(controls.slice(0, 5))}`);

  // 4. SetValue：编辑区在新版记事本里是 Document（不是 Edit），两种都要能命中
  // 稳定性：新版记事本会恢复上次会话的标签页，刚启动时 SetValue 可能落在「恢复中的文档」上，
  // 读回值会带上恢复出来的一小段前缀（实测出现过 deW17c-UIA-TEST-INPUT）。
  // 语义断言改为「读回值以写入串结尾」——仍要求我们的写入是最终内容，但不把恢复前缀当失败；
  // 最多重试 3 次以跨过恢复窗口。
  const marker = 'W17c-UIA-TEST-INPUT';
  const psSetValue = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$condEdit = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)
$condDoc = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
$target = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condEdit)
if (-not $target) { $target = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condDoc) }
if (-not $target) { Write-Output 'NOEDIT'; exit }
$obj = $null
if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) { Write-Output 'NOVALUE'; exit }
$obj.SetValue('${marker}')
Start-Sleep -Milliseconds 300
Write-Output ('SETVALUE-OK:' + $obj.Current.Value)
`;
  let setText = '';
  let matched = false;
  for (let attempt = 0; attempt < 3 && !matched; attempt++) {
    setText = String(await psScript(psSetValue)).trim();
    if (setText === 'NOEDIT') { t.skip('记事本无 Edit/Document 编辑区（Store 版差异）'); return; }
    assert.notEqual(setText, 'NOVALUE', '编辑区应支持 ValuePattern');
    matched = setText.endsWith(marker);
    if (!matched) await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(matched, `SetValue 应读回以写入串结尾：${setText}`);

  // 5. 再用 worker 读一次，确认 value 字段真的带出写入内容（C03 观察变化）
  const read2 = await worker.call('uia_read', 20_000, { pid });
  assert.equal(read2.ok, true, `二次读树应成功：${JSON.stringify(read2)}`);
  const withValue = (read2.controls || []).filter((c) => String(c.value || '').includes('W17c-UIA-TEST-INPUT'));
  assert.ok(withValue.length > 0,
    `读回的 value 应包含写入文本：${JSON.stringify((read2.controls || []).slice(0, 5))}`);
});
