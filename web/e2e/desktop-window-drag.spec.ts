import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { _electron } from '@playwright/test'

test('Windows 原生输入可以拖动 Electron 标题栏业务窗口', async () => {
  test.skip(process.platform !== 'win32', '仅在 Windows 客户端验收环境运行。')
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-electron-drag-e2e-'))
  let electronApp: Awaited<ReturnType<typeof _electron.launch>> | undefined

  try {
    electronApp = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5179' },
      timeout: 60_000,
    })
    const business = await electronApp.firstWindow()
    await expect.poll(() => electronApp!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) =>
        window.webContents.getURL().startsWith('http://127.0.0.1:5179') && window.isVisible()
      )
    )).toBe(true)
    await expect.poll(() => business.locator('.desktop-titlebar').evaluate((element) => {
      return getComputedStyle(element).getPropertyValue('-webkit-app-region')
    })).toBe('drag')

    const handle = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith('http://127.0.0.1:5179')
      )
      if (!window) throw new Error('找不到 Electron 业务窗口')
      if (window.isMaximized()) window.unmaximize()
      window.setBounds({ x: 240, y: 100, width: 1100, height: 700 })
      await new Promise((resolveBounds) => setTimeout(resolveBounds, 400))
      return window.getNativeWindowHandle().readBigUInt64LE(0).toString(16)
    })
    const point = await business.locator('.desktop-titlebar').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }
    })
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct NativeWindowRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class NativeWindowInput {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out NativeWindowRect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public const uint LeftDown = 0x0002;
  public const uint LeftUp = 0x0004;
}
'@
$handle = [IntPtr]([Convert]::ToInt64('${handle}', 16))
$null = [NativeWindowInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
$before = New-Object NativeWindowRect
if (-not [NativeWindowInput]::GetWindowRect($handle, [ref]$before)) { throw 'GetWindowRect failed before drag' }
$scale = [NativeWindowInput]::GetDpiForWindow($handle) / 96.0
$x = $before.Left + [int][Math]::Round(${point.x} * $scale)
$y = $before.Top + [int][Math]::Round(${point.y} * $scale)
$foregroundSet = [NativeWindowInput]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250
$foreground = [NativeWindowInput]::GetForegroundWindow().ToInt64().ToString('x')
if (-not $foregroundSet -or $foreground -ne $handle.ToInt64().ToString('x')) {
  [pscustomobject]@{ dpi = [NativeWindowInput]::GetDpiForWindow($handle); beforeLeft = $before.Left; afterLeft = $before.Left; beforeTop = $before.Top; afterTop = $before.Top; pointerX = $x; pointerY = $y; foregroundSet = $foregroundSet; foreground = $foreground; handle = $handle.ToInt64().ToString('x') } | ConvertTo-Json -Compress
  return
}
$null = [NativeWindowInput]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 150
[NativeWindowInput]::mouse_event([NativeWindowInput]::LeftDown, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
$null = [NativeWindowInput]::SetCursorPos($x - [int][Math]::Round(140 * $scale), $y)
Start-Sleep -Milliseconds 300
[NativeWindowInput]::mouse_event([NativeWindowInput]::LeftUp, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
$after = New-Object NativeWindowRect
if (-not [NativeWindowInput]::GetWindowRect($handle, [ref]$after)) { throw 'GetWindowRect failed after drag' }
[pscustomobject]@{ dpi = [NativeWindowInput]::GetDpiForWindow($handle); beforeLeft = $before.Left; afterLeft = $after.Left; beforeTop = $before.Top; afterTop = $after.Top; pointerX = $x; pointerY = $y; foregroundSet = $foregroundSet; foreground = $foreground; handle = $handle.ToInt64().ToString('x') } | ConvertTo-Json -Compress
`
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '{}') as { beforeLeft: number; afterLeft: number; beforeTop: number; afterTop: number; dpi: number; pointerX: number; pointerY: number; foregroundSet: boolean; foreground: string; handle: string }
    console.log(`Win32 原生标题栏拖动：DPI=${result.dpi}，窗口 left ${result.beforeLeft} → ${result.afterLeft}，top ${result.beforeTop} → ${result.afterTop}，前台=${result.foreground}，目标=${result.handle}，SetForegroundWindow=${result.foregroundSet}`)
    if (!result.foregroundSet || result.foreground.toLowerCase() !== result.handle.toLowerCase()) {
      test.skip(true, 'Windows 未允许测试窗口取得前台输入焦点，当前会话无法验证系统级拖动。')
    }
    expect(result.afterLeft, JSON.stringify(result)).toBeLessThan(result.beforeLeft - 50)
  } finally {
    if (electronApp) {
      try { execFileSync('taskkill', ['/PID', String(electronApp.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
      await Promise.race([electronApp.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    }
    await rm(userData, { recursive: true, force: true })
  }
})
