import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT24 命令与通知面板首次打开时才加载', async ({ page }) => {
  const loadedModules: string[] = []
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith('/components/command-palette.tsx') || /\/assets\/command-palette-[\w-]+\.js$/.test(pathname) ||
      pathname.endsWith('/components/notification-panel.tsx') || /\/assets\/notification-panel-[\w-]+\.js$/.test(pathname)) {
      loadedModules.push(pathname)
    }
  })

  const commandPalette = (path: string) => path.endsWith('/components/command-palette.tsx') || /\/assets\/command-palette-[\w-]+\.js$/.test(path)
  const notificationPanel = (path: string) => path.endsWith('/components/notification-panel.tsx') || /\/assets\/notification-panel-[\w-]+\.js$/.test(path)

  await registerAccount(page)
  expect(loadedModules).toEqual([])

  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
  await expect.poll(() => loadedModules.filter(commandPalette).length).toBe(1)

  await page.keyboard.press('Escape')
  await page.locator('button[title="通知与 AI 任务"]').click()
  await expect(page.getByRole('button', { name: '通知' })).toBeVisible()
  await expect.poll(() => loadedModules.filter(notificationPanel).length).toBe(1)
})
