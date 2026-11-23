import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// REF41 F4（docs/41 §F4）：桌面形态采集诊断页。
// 真实 Electron 窗口：种子样本 → Top 字段可见 → 配方 verify/activate 状态机。
// 与 web/e2e/parser-diagnostics.spec.ts 同旅程桌面形态，不共用文件。

test('REF41 F4 桌面采集诊断与配方状态机', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-f4-parser-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`f4-parser-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')

    const seeded = await page.request.post('http://127.0.0.1:8287/__e2e/parser-events/seed', { data: {} })
    expect(seeded.status()).toBe(200)

    await page.goto(`${baseURL}/settings/parser-diagnostics`)
    await expect(page.getByRole('heading', { name: '采集诊断' })).toBeVisible()
    await expect(page.getByTestId('parser-top-fields')).toBeVisible()
    await expect(page.getByTestId('parser-recipes')).toBeVisible()
    const verifyBtn = page.getByTestId(/^parser-verify-/)
    if (await verifyBtn.count() > 0) {
      await verifyBtn.first().click()
      await expect(page.getByText('已标记验证通过')).toBeVisible({ timeout: 15_000 })
      const activateBtn = page.getByTestId(/^parser-activate-/)
      await expect(activateBtn.first()).toBeVisible()
      await activateBtn.first().click()
      await expect(page.getByText('已启用（仅作参考，不会自动改适配器）')).toBeVisible({ timeout: 15_000 })
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
