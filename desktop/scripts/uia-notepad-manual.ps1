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
