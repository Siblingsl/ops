# DEV-AI27-17 W17c：UIA 真实记事本旅程（PS 5.1 单行兼容）
$ErrorActionPreference = 'Stop'
[System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient') | Out-Null
[System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes') | Out-Null

$np = Start-Process 'C:\Windows\System32\notepad.exe' -PassThru
Start-Sleep -Seconds 3
try {
  $proc = Get-Process -Id $np.Id -ErrorAction Stop
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  Write-Output "WINDOW:$($root.CurrentName)"
  # DEV-CU P1-1 步骤 5：追加控件诊断输出，供人工核对 Name / AutomationId / ControlType。
  # 放在 NOEDIT 分支之前，确保即使没有 Edit 控件也能看到读树结果；此行用正确写法 .Current.* 与上行旧写法形成对照。
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $top = @()
  for ($i = 0; $i -lt [Math]::Min(3, $all.Count); $i++) {
    $el = $all.Item($i)
    $top += @{ name=$el.Current.Name; id=$el.Current.AutomationId; type=$el.Current.ControlType.ProgrammaticName }
  }
  Write-Output ("CONTROLS:" + (ConvertTo-Json -InputObject $top -Compress))

  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $edit) { Write-Output 'NOEDIT'; exit }

  $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue('W17c-UIA-TEST-INPUT')
  Write-Output "VALUE:$($vp.Current.Value)"
} catch {
  Write-Output "ERR:$($_.Exception.Message)"
} finally {
  Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue
}
