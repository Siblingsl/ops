import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT67 派生对话框困住键盘焦点，关闭后回到触发按钮', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT67 焦点循环验收' })
  await page.goto(`/works/${work.id}`)

  const trigger = page.getByRole('button', { name: '派生', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '派生到其他平台', exact: true }) })
  await expect(dialog).toBeVisible()

  const close = dialog.getByRole('button', { name: '关闭', exact: true })
  const cancel = dialog.getByRole('button', { name: '取消', exact: true })
  await page.keyboard.press('Shift+Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
})
