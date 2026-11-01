import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('网页账号视觉 DNA 明确导入、自增版本并从历史回滚', async ({ page }) => {
  const account = await registerAccount(page)
  const importedTheme = {
    base: 'ink', primary_color: '#2F5D62', font_size: 16, line_height: 1.8,
    paragraph_gap: 18, heading_style: 'underline', quote_style: 'bar',
  }
  await api(page, 'PUT', `/accounts/${account.id}/custom-theme`, importedTheme)
  await page.goto(`/a/${account.id}/profile?tab=visual-dna`)
  const panel = page.getByTestId('visual-dna-tab')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('当前版本 v0 · 尚未保存')).toBeVisible()
  await expect(panel.getByText('旧自定义主题仍保留')).toBeVisible()
  await panel.getByRole('button', { name: '从当前自定义主题导入' }).click()
  await expect(panel.getByText('当前版本 v1')).toBeVisible()
  const imported = await api(page, 'GET', `/accounts/${account.id}/visual-dna`)
  expect(imported.version).toBe(1)
  expect(imported.tokens.palette.primary).toBe('#2F5D62')
  expect((await api(page, 'GET', `/accounts/${account.id}/custom-theme`)).primary_color).toBe('#2F5D62')

  for (const copy of ['网页版本二', '网页版本三']) {
    await panel.getByLabel('结尾文案').fill(copy)
    await panel.getByRole('button', { name: '保存为新版本' }).click()
    await expect(panel.getByText(/当前版本 v[23]/)).toBeVisible()
  }
  const first = panel.getByTestId('visual-dna-version-1')
  await first.getByRole('button', { name: '回滚为新版本' }).click()
  await expect(panel.getByText('当前版本 v4')).toBeVisible()
  const current = await api(page, 'GET', `/accounts/${account.id}/visual-dna`)
  expect(current.version).toBe(4)
  expect(current.tokens.palette.primary).toBe('#2F5D62')
  expect(current.tokens.end_copy).toBe('')
  await page.reload()
  await expect(page.getByTestId('visual-dna-tab').getByText('当前版本 v4')).toBeVisible()
})

test('网页双窗口 CAS 冲突保留本地草稿并可显式接续', async ({ page }) => {
  const account = await registerAccount(page)
  const otherTab = await page.context().newPage()
  await Promise.all([
    page.goto(`/a/${account.id}/profile?tab=visual-dna`),
    otherTab.goto(`/a/${account.id}/profile?tab=visual-dna`),
  ])
  const firstPanel = page.getByTestId('visual-dna-tab')
  const secondPanel = otherTab.getByTestId('visual-dna-tab')
  await expect(firstPanel).toBeVisible()
  await expect(secondPanel).toBeVisible()
  await firstPanel.getByLabel('结尾文案').fill('浏览器窗口一')
  await secondPanel.getByLabel('结尾文案').fill('浏览器窗口二草稿')

  await firstPanel.getByRole('button', { name: '保存为新版本' }).click()
  await expect(firstPanel.getByText('当前版本 v1')).toBeVisible()
  await secondPanel.getByRole('button', { name: '保存为新版本' }).click()
  await expect(secondPanel.getByText(/其他窗口已保存新版本/)).toBeVisible()
  await expect(secondPanel.getByLabel('结尾文案')).toHaveValue('浏览器窗口二草稿')
  await secondPanel.getByRole('button', { name: /保留本地编辑并以 v1 为基础继续/ }).click()
  await secondPanel.getByRole('button', { name: '保存为新版本' }).click()
  await expect(secondPanel.getByText('当前版本 v2')).toBeVisible()
  const current = await api(page, 'GET', `/accounts/${account.id}/visual-dna`)
  expect(current.version).toBe(2)
  expect(current.tokens.end_copy).toBe('浏览器窗口二草稿')
  await otherTab.close()
})
