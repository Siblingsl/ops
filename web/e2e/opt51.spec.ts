import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT51 模型配置可统一覆盖零温度并恢复任务默认', async ({ page }) => {
  await registerAccount(page)
  await page.goto('/settings/models')
  const card = page.getByText('采样温度', { exact: true }).locator('..').locator('..').locator('..')
  const toggle = page.getByRole('switch', { name: '统一温度', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await page.getByLabel('统一温度值').fill('0')
  await page.getByRole('button', { name: '保存采样温度', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', '/settings')).ai_sampling.temperature).toBe(0)
  await page.reload()
  await expect(toggle).toBeChecked()
  await expect(page.getByLabel('统一温度值')).toHaveValue('0')
  await expect(card).toContainText('部分模型会忽略此参数')
  await toggle.click()
  await page.getByRole('button', { name: '保存采样温度', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', '/settings')).ai_sampling.temperature).toBeNull()
})
