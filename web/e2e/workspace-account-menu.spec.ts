import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('Web 工作区与账号菜单保留原有管理入口', async ({ page }) => {
  const account = await registerAccount(page)
  const accountTrigger = page.getByRole('button').filter({ hasText: account.name })
  await accountTrigger.click()
  const menu = page.getByTestId('workspace-account-menu')
  await expect(menu).toBeVisible()
  // 面板只放平台账号与创建入口；「成员与邀请」一直在右键菜单里（拆分前即如此）。
  await expect(menu.getByText('成员与邀请', { exact: true })).toHaveCount(0)
  await expect(menu.getByText('管理平台账号', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await accountTrigger.click({ button: 'right' })
  const contextMenu = page.getByRole('menu')
  await expect(contextMenu.getByRole('menuitem', { name: '成员与邀请', exact: true })).toBeVisible()
  await expect(contextMenu.getByRole('menuitem', { name: '管理平台账号', exact: true })).toBeVisible()
})

