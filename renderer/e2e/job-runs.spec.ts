import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// REF41 F3（docs/41 §F3）：桌面形态系统任务台账。
// 真实 Electron 窗口：种子台账 → 任务页可见（状态/补跑标记/白名单补跑按钮）。
// 与 web/e2e/job-runs.spec.ts 同旅程桌面形态，不共用文件。

test('REF41 F3 桌面系统任务台账与补跑标记', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-f3-jobrun-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`f3-jobrun-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')

    // 种子必须带调用方会话（服务端按 cookie 解析 workspace_id，docs/41 Q-02）；
    // Electron 窗口的 page.request 是独立 APIRequestContext，不共享窗口 cookie，
    // 改在页面内 fetch 同源 /__e2e（vite 已代理到 ops-e2e；与 /api 同一 cookie 通道）。
    const seeded = await page.evaluate(async () => (await fetch('/__e2e/job-runs/seed', { method: 'POST' })).status)
    expect(seeded).toBe(200)

    await page.goto(`${baseURL}/settings/job-runs`)
    await expect(page.getByRole('heading', { name: '系统任务' })).toBeVisible()
    await expect(page.getByTestId('job-runs-card')).toBeVisible()
    await expect(page.getByText('daily-housekeeping').first()).toBeVisible()
    await expect(page.getByText('补跑').first()).toBeVisible()
    const nowBtn = page.getByTestId('job-run-now-memory-decay')
    if (await nowBtn.count() > 0) {
      await nowBtn.click()
      await expect(page.getByText('已补跑')).toBeVisible({ timeout: 15_000 })
    }
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    const pid = app?.process().pid
    if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* exited */ } }
    try {
      const profileArg = profile.replace(/'/g, "''")
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${profileArg}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' })
    } catch { /* best effort */ }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
})
