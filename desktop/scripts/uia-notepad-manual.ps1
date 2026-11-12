# DEV-AI27-17 W17c：UIA 真实窗口旅程（PowerShell 5.1 兼容）
# DEV-CU P1-1 修订（2026-11-12）：不再按 Start-Process 返回的 PID 找窗口。
# 根因：Win11 的 System32\notepad.exe 是打包版启动器，-PassThru 拿到的桩进程 1~2 秒内退出、
#       真实记事本换了 PID，按 -Id 反查必然报 "Cannot find a process with the process identifier"。
#       会话隔离不是原因（正常桌面会话复跑同样失败）。
#
# 用法：
#   .\uia-notepad-manual.ps1                        # 启动记事本，按顶层窗口反查
#   .\uia-notepad-manual.ps1 -List                  # 只列出当前可见顶层窗口
#   .\uia-notepad-manual.ps1 -TitleLike "无标题"     # 挂到已打开的窗口（标题片段）
#   .\uia-notepad-manual.ps1 -ProcessId 1234         # 挂到指定进程的窗口
#   .\uia-notepad-manual.ps1 -KeepOpen               # 跑完不关窗口
param(
  [string]$TitleLike = '',
  [int]$ProcessId = 0,
  [switch]$List,
  [switch]$KeepOpen
)
$ErrorActionPreference = 'Stop'
[System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient') | Out-Null
[System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes') | Out-Null

$WindowCond = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)
$EditCond = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)
$DocCond = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)

function Get-TopWindows {
  $col = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $WindowCond)
  $out = @()
  foreach ($w in $col) { $out += $w }
  return $out
}

function Get-WinInfo($w) {
  [pscustomobject]@{
    Element = $w
    ProcId  = [int]$w.Current.ProcessId
    Class   = [string]$w.Current.ClassName
    Name    = [string]$w.Current.Name
  }
}

function Show-Candidates($wins) {
  foreach ($w in $wins) {
    $i = Get-WinInfo $w
    if ([string]::IsNullOrWhiteSpace($i.Name)) { continue }
    Write-Output ("CANDIDATE:pid={0} class={1} name={2}" -f $i.ProcId, $i.Class, $i.Name)
  }
}

$before = @(Get-Process -Name notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$wins = @(Get-TopWindows)
$launched = $null

if ($List) { Show-Candidates $wins; exit 0 }

$target = $null
if ($ProcessId -gt 0) {
  foreach ($w in $wins) {
    $i = Get-WinInfo $w
    if ($i.ProcId -eq $ProcessId -and $i.Name) { $target = $i; break }
  }
} elseif ($TitleLike -ne '') {
  foreach ($w in $wins) {
    $i = Get-WinInfo $w
    if ($i.Name -like ('*' + $TitleLike + '*')) { $target = $i; break }
  }
} else {
  $launched = Start-Process 'C:\Windows\System32\notepad.exe' -PassThru
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $wins = @(Get-TopWindows)
    $npPids = @(Get-Process -Name notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if ($npPids.Count -gt 0) {
      foreach ($w in $wins) {
        $i = Get-WinInfo $w
        if (($npPids -contains $i.ProcId) -and $i.Name) { $target = $i; break }
      }
    }
    if ($target) { break }
  } while ((Get-Date) -lt $deadline)
}

if (-not $target) {
  Write-Output 'NOWINDOW'
  Show-Candidates $wins
  Write-Output 'HINT: use -TitleLike <substring> or -ProcessId <pid>; CANDIDATE lines list visible top-level windows.'
  exit 1
}

$root = $target.Element
Write-Output ("PROC:pid={0} class={1}" -f $target.ProcId, $target.Class)
Write-Output ('WINDOW:' + $root.Current.Name)

# 读树：前 3 个后代，人工核对 Name / AutomationId / ControlType。
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$top = @()
for ($i = 0; $i -lt [Math]::Min(3, $all.Count); $i++) {
  $el = $all.Item($i)
  $top += @{ name = $el.Current.Name; id = $el.Current.AutomationId; type = $el.Current.ControlType.ProgrammaticName }
}
Write-Output ('CONTROLS:' + (ConvertTo-Json -InputObject $top -Compress))

# 可编辑元素：先 Edit，再退 Document（Win11 新版记事本的编辑区是 Document）。
$edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $EditCond)
if (-not $edit) { $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $DocCond) }
if (-not $edit) {
  Write-Output 'NOEDIT'
  if ($launched -and (-not $KeepOpen) -and ($before -notcontains $target.ProcId)) {
    Stop-Process -Id $target.ProcId -Force -ErrorAction SilentlyContinue
  }
  exit
}

Write-Output ("EDIT:name={0} id={1} type={2}" -f $edit.Current.Name, $edit.Current.AutomationId, $edit.Current.ControlType.ProgrammaticName)

$objValue = $null
$objText = $null
$hasValue = $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$objValue)
$hasText = $edit.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$objText)
Write-Output ("PATTERNS:value={0} text={1}" -f $hasValue, $hasText)

if ($hasValue) {
  $objValue.SetValue('W17c-UIA-TEST-INPUT')
  Start-Sleep -Milliseconds 300
  Write-Output ('VALUE:' + $objValue.Current.Value)
  Write-Output 'MODE:valuepattern'
} else {
  # 新版记事本的编辑区是 Document，可能只暴露 TextPattern：读出当前文本作为对照，
  # 写值留待有 ValuePattern 的宿主（如 -App charmap）再验；不谎报 SetValue 成功。
  if ($hasText) {
    Write-Output ('TEXT_LEN:' + $objText.DocumentRange.GetText(-1).Length)
  }
  Write-Output 'VALUE_UNSUPPORTED'
}

# 只关掉本次启动出来的窗口；运行前已存在的记事本不动。
if ($launched -and (-not $KeepOpen) -and ($before -notcontains $target.ProcId)) {
  Stop-Process -Id $target.ProcId -Force -ErrorAction SilentlyContinue
}
