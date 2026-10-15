import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT24 命令与通知面板首次打开时才加载', async ({ page }) => {
  const loadedModules: string[] = []
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith('/components/command-palette.tsx') || pathname.endsWith('/components/notification-panel.tsx')) {
      loadedModules.push(pathname)
    }
  })

  await registerAccount(page)
  expect(loadedModules).toEqual([])

  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
  await expect.poll(() => loadedModules.filter(path => path.endsWith('/components/command-palette.tsx')).length).toBe(1)

  await page.keyboard.press('Escape')
  await page.locator('button[title="通知与 AI 任务"]').click()
  await expect(page.getByRole('button', { name: '通知' })).toBeVisible()
  await expect.poll(() => loadedModules.filter(path => path.endsWith('/components/notification-panel.tsx')).length).toBe(1)
})
