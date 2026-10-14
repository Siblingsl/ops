import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT29 选题池按游标加载更多并保留全局状态总数', async ({ page }) => {
  const account = await registerAccount(page)
  for (let i = 0; i < 51; i++) {
    await api(page, 'POST', `/accounts/${account.id}/topics`, {
      title: `OPT29 分页选题 ${String(i).padStart(2, '0')}`,
      angle: '人工创建的分页验收选题',
    })
  }
  const cursors: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === `/api/v1/accounts/${account.id}/topics` && url.searchParams.has('cursor')) {
      cursors.push(url.searchParams.get('cursor')!)
    }
  })

  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText('OPT29 分页选题 50', { exact: true })).toBeVisible()
  await expect(page.getByText('OPT29 分页选题 00', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '加载更多选题' }).click()
  await expect(page.getByText('OPT29 分页选题 00', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /待定/ })).toContainText('51')
  expect(cursors).toHaveLength(1)
  expect(cursors[0]).not.toBe('')
})
