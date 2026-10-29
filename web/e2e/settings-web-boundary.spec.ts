import { test, expect } from '@playwright/test'
import { registerAccount } from './support'

test('D-126 Web 仍使用原高级菜单及整页设置', async ({ page }) => {
  await registerAccount(page)
  await page.getByRole('button', { name: /^用户菜单/ }).click()
  await expect(page.getByRole('button', { name: '高级设置', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '偏好设置', exact: true }).click()
  await expect(page.getByTestId('desktop-settings-window')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()
})
