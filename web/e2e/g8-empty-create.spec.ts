import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('DEV-QA26 G8 Web 空作品页的空白新建标题保持为空', async ({ page }) => {
  const account = await registerAccount(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`/a/${account.id}/works`)
  await expect(page.getByText('这里还没有作品', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '空白新建', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  const title = panel.getByPlaceholder('未命名作品')
  await expect(panel).toBeVisible()
  await expect(title).toHaveValue('')
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(panel).toHaveCount(0)
})

test('DEV-QA26 G8 Web 编辑器头部图标操作有可访问名称', async ({ page }) => {
  const account = await registerAccount(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await panel.getByPlaceholder('未命名作品').fill('QA26 toolbar names')
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)

  await expect(page.getByRole('button', { name: '计划与负责人设置', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开版本历史', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '派生作品', exact: true })).toBeVisible()
})
