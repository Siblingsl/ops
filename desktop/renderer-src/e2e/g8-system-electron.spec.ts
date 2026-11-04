import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { toggleDesktopTheme } from './support'

test('DEV-QA26 G8 真实 Electron 命令面板、通知空态与主题重载', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-system-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-g8-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect(page.getByRole('button', { name: /用户菜单/ })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    const search = palette.getByRole('textbox')
    await expect(palette).toBeVisible()
    await expect(search).toBeFocused()
    await expect(palette.getByText('操作', { exact: true })).toBeVisible()
    await expect(palette.getByText('设置', { exact: true })).toBeVisible()
    await search.fill('偏好设置')
    await expect(palette.getByRole('button', { name: '偏好设置', exact: true })).toBeVisible()
    await search.press('Enter')
    await expect(page).toHaveURL(/\/settings\/preferences$/)
    await expect(page.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '查看快捷键', exact: true }).click()
    const shortcuts = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '快捷键', exact: true }) })
    await expect(shortcuts).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shortcuts).toBeHidden()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(page.getByTestId('desktop-settings-window')).toBeHidden()

    const initialTheme = await page.locator('html').getAttribute('data-theme')
    const selectedTheme = initialTheme === 'dark' ? '浅色' : '深色'
    await toggleDesktopTheme(page, selectedTheme)
    const selectedValue = selectedTheme === '深色' ? 'dark' : 'light'
    await expect(page.locator('html')).toHaveAttribute('data-theme', selectedValue)
    expect(await page.evaluate(() => localStorage.getItem('ops-desktop-theme'))).toBe(selectedValue)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', selectedValue)
    if (initialTheme === 'dark' || initialTheme === 'light') {
      const restoreTheme = initialTheme === 'dark' ? '深色' : '浅色'
      await toggleDesktopTheme(page, restoreTheme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', initialTheme)
    }

    const panel = page.locator('.notification-panel')
    let panelOpened = false
    for (let attempt = 0; attempt < 3 && !panelOpened; attempt++) {
      const menuButton = page.getByRole('button', { name: /用户菜单/ })
      if (await menuButton.getAttribute('aria-expanded') !== 'true') await menuButton.click()
      panelOpened = await Promise.race([
        page.getByRole('menuitem', { name: /通知与 AI 任务/ }).click().then(() => true).catch(() => false),
        panel.waitFor({ state: 'visible' }).then(() => true).catch(() => false),
      ])
    }
    await expect(panel).toBeVisible()
    await expect(panel.getByText('暂无通知', { exact: true })).toBeVisible()
    const notificationTab = panel.getByRole('button', { name: '通知', exact: true })
    await expect(notificationTab).toBeVisible()
    await panel.getByRole('button', { name: 'AI 任务', exact: true }).click()
    await expect(panel.getByText('最近没有 AI 任务。关闭页面不会中断正在生成的内容，完成后会在这里和通知里提醒你。', { exact: true })).toBeVisible()

    const persistedLists = await page.evaluate(async () => {
      const [notifications, jobs] = await Promise.all([
        fetch('/api/v1/notifications').then((response) => response.json()),
        fetch('/api/v1/ai-jobs').then((response) => response.json()),
      ])
      return { notifications, jobs }
    })
    expect(persistedLists.notifications).toMatchObject({ items: [], unread: 0, active_jobs: 0 })
    expect(persistedLists.jobs).toEqual([])
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 仅关闭本用例创建的客户端。 */ }
      await app.close().catch(() => undefined)
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !profile.includes('ops-qa26-g8-system-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
