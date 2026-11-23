// Q-27（docs/41，16 文档 §15.3 200% 文本放大）：业务窗菜单收纳于自绘标题栏，
// Windows 下菜单 role 缩放加速键不经菜单路径触发——webContents 层必须有
// before-input-event 拦截 Ctrl+=/Ctrl+-/Ctrl+0。本用例启动真实 Electron 业务窗，
// 用 Electron 原生 sendInputEvent 注入 Ctrl 组合键（Playwright 的 CDP keyboard
// 事件不经过 webContents 的 before-input-event，2026-11-23 探针实测），
// 断言 zoomLevel 与 devicePixelRatio 的实际放大效果。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { _electron } from '@playwright/test'

async function stopElectron(app: Awaited<ReturnType<typeof _electron.launch>> | undefined): Promise<void> {
  if (!app) return
  try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
  await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2000))])
}

test('业务窗 Ctrl+=/-/0 键盘缩放生效（Q-27）', async () => {
  test.skip(process.platform !== 'win32', '仅在 Windows 客户端验收环境运行。')
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-electron-zoom-e2e-'))
  let electronApp: Awaited<ReturnType<typeof _electron.launch>> | undefined

  try {
    electronApp = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5287' },
      timeout: 60_000,
    })
    const business = await electronApp.firstWindow()
    await expect.poll(() => electronApp!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) =>
        window.webContents.getURL().startsWith('http://127.0.0.1:5287') && window.isVisible()
      )
    )).toBe(true)
    // 业务窗是首个可见窗口后，等待其 URL 稳定（失败窗/设置窗可能先出现）。
    await expect.poll(() => business.url()).toMatch(/^http:\/\/127\.0\.0\.1:5287/)
    // 页面完成首帧渲染后业务窗才真正 show；缩放断言前先等主内容挂载。
    await business.waitForSelector('.desktop-titlebar', { timeout: 30_000 })

    const businessWindow = async () => {
      const w = await electronApp!.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows()
        const window = windows.find((candidate) =>
          candidate.webContents.getURL().startsWith('http://127.0.0.1:5287')
        )
        if (!window) throw new Error(`找不到业务窗口，现有：${windows.map((w) => w.webContents.getURL()).join(' | ')}`)
        return window.webContents.getZoomLevel()
      })
      return w
    }

    const press = async (keyCode: '=' | '-' | '0') => {
      await electronApp!.evaluate(({ BrowserWindow }, keyCode) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().startsWith('http://127.0.0.1:5287')
        )
        if (!window) throw new Error('找不到业务窗口')
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] })
      }, keyCode)
    }

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith('http://127.0.0.1:5287')
      )
      window?.webContents.setZoomLevel(0)
    })
    await expect.poll(businessWindow, { timeout: 30_000 }).toBe(0)
    const dprAt100 = await business.evaluate(() => window.devicePixelRatio)

    await press('=')
    await expect.poll(businessWindow).toBe(0.5)
    await press('=')
    await expect.poll(businessWindow).toBe(1)
    // 真实放大效果：zoomLevel 1 = 120%，devicePixelRatio 必须随之变大。
    await expect.poll(() => business.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(dprAt100 * 1.15)

    await press('-')
    await expect.poll(businessWindow).toBe(0.5)
    await press('0')
    await expect.poll(businessWindow).toBe(0)
  } finally {
    await stopElectron(electronApp)
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  }
})
