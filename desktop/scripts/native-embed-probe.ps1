# DEV-AI27-03 W03 原生内嵌技术门：最小实证（有界，单次实验，不堆叠补丁）。
# 目的：对唯一非内核候选（窗口句柄重挂 SetParent）做隔离实验，逐项记录 27 §6.4 第 4 项
# 硬条件的真实行为（窗口归属/焦点/输入/渲染/DPI），作为"不可作为正式路线"的证据链。
# 载体：CfT 156（与 W02 同源）独立临时 profile，不触碰用户日常 Chrome。

$ErrorActionPreference = 'Continue'
$cft = 'F:\code\project\OPS\desktop\.tmp\cft\chrome-win64\chrome.exe'
$profileDir = Join-Path $env:TEMP ('ops-embed-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$page = Join-Path $profileDir 'page.html'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
@'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>W03 内嵌实验页</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>W03 内嵌实验页</h1>
<input id="box" placeholder="输入观察点" /><button onclick="document.title='clicked'">按钮</button></body></html>
'@ | Set-Content -Path $page -Encoding UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeEmbed {
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-HwndPid([IntPtr]$h) {
    $pidOut = 0
    [void][NativeEmbed]::GetWindowThreadProcessId($h, [ref]$pidOut)
    return $pidOut
}

$result = [ordered]@{}
try {
    # 1. 启动 Chrome（CfT，独立 profile）
    $chrome = Start-Process -FilePath $cft -ArgumentList @(
        "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check',
        "--app=file:///$($page -replace '\\','/')", '--window-size=760,520'
    ) -PassThru
    Start-Sleep -Seconds 5

    # 2. 找 Chrome 顶层窗口（Chrome_WidgetWin_1）
    $chromeHwnd = [IntPtr]::Zero
    for ($i = 0; $i -lt 20 -and $chromeHwnd -eq [IntPtr]::Zero; $i++) {
        $chromeHwnd = [NativeEmbed]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, 'Chrome_WidgetWin_1', $null)
        if ($chromeHwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
    }
    if ($chromeHwnd -eq [IntPtr]::Zero) { throw '未找到 Chrome 窗口' }
    $result['chrome_pid'] = Get-HwndPid $chromeHwnd

    # 3. 宿主窗口（WinForms）
    $hostForm = New-Object System.Windows.Forms.Form
    $hostForm.Text = 'W03 宿主窗口'
    $hostForm.Size = New-Object System.Drawing.Size(820, 600)
    $hostForm.StartPosition = 'Manual'
    $hostForm.Location = New-Object System.Drawing.Size(60, 60)
    $hostForm.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $result['host_pid'] = $PID

    # 4. SetParent 重挂
    $before = [NativeEmbed]::GetWindowLong($chromeHwnd, -16)  # GWL_STYLE
    $setParentResult = [NativeEmbed]::SetParent($chromeHwnd, $hostForm.Handle)
    $result['setparent_returned_nonzero'] = ($setParentResult -ne [IntPtr]::Zero)
    [void][NativeEmbed]::MoveWindow($chromeHwnd, 10, 10, 780, 520, $true)
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Seconds 2

    # 5. 窗口归属与可见性
    $after = [NativeEmbed]::GetWindowLong($chromeHwnd, -16)
    $result['style_changed'] = ($before -ne $after)
    $result['chrome_visible_after'] = [NativeEmbed]::IsWindowVisible($chromeHwnd)
    $rect = New-Object NativeEmbed+RECT
    [void][NativeEmbed]::GetWindowRect($chromeHwnd, [ref]$rect)
    $result['chrome_rect'] = "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"

    # 6. 焦点行为：点击 Chrome 区域，检查前台窗口归属
    $cx = [int](($rect.Left + $rect.Right) / 2)
    $cy = [int](($rect.Top + $rect.Bottom) / 2)
    [void][NativeEmbed]::SetCursorPos($cx, $cy)
    [NativeEmbed]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
    [NativeEmbed]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
    Start-Sleep -Milliseconds 800
    $fg = [NativeEmbed]::GetForegroundWindow()
    $fgPid = Get-HwndPid $fg
    $result['focus_pid_after_click'] = $fgPid
    $result['focus_is_chrome'] = ($fgPid -eq (Get-HwndPid $chromeHwnd))
    $result['focus_is_host'] = ($fgPid -eq $PID)

    # 7. 键盘输入直发（PostMessage 语义经 SendKeys 到前台）
    [System.Windows.Forms.SendKeys]::SendWait('abc')
    Start-Sleep -Milliseconds 500
    # 用 UIA/标题变化不可靠，这里记录 SendKeys 已尝试与前台归属
    $fg2 = [NativeEmbed]::GetForegroundWindow()
    $result['focus_pid_after_keys'] = Get-HwndPid $fg2

    # 8. 截图存证（宿主整窗）
    $shotPath = 'F:\code\project\OPS\output\playwright\w03-embed-experiment.png'
    New-Item -ItemType Directory -Force -Path (Split-Path $shotPath) | Out-Null
    $bounds = [System.Drawing.Rectangle]::FromLTRB($hostForm.Left, $hostForm.Top, $hostForm.Right, $hostForm.Bottom)
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($hostForm.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $result['screenshot'] = $shotPath

    # 9. Chrome 侧输出观察（Chrome 是否崩溃/仍响应：读进程存活）
    Start-Sleep -Seconds 1
    $result['chrome_process_alive'] = (-not $chrome.HasExited)
    $result['chrome_exit_code'] = if ($chrome.HasExited) { $chrome.ExitCode } else { $null }
}
catch {
    $result['error'] = $_.Exception.Message
}
finally {
    # 10. 清理：实验 Chrome 与临时 profile（宿主窗口随 PowerShell 退出）
    if ($chrome -and -not $chrome.HasExited) { Stop-Process -Id $chrome.Id -Force -ErrorAction SilentlyContinue }
    Get-Process | Where-Object { $_.Path -eq $cft } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -Recurse -Force -Path $profileDir -ErrorAction SilentlyContinue
}

$result | ConvertTo-Json -Depth 3
