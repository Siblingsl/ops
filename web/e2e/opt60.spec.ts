import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT60 放弃无需确认，九秒撤销恢复待定或已采用，失败不显示成功撤销', async ({ page }) => {
  const account = await registerAccount(page)
  const topics: { id: string; title: string; status: string }[] = []
  for (const status of ['pending', 'adopted']) {
    const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: `撤销恢复${status}` })
    if (status === 'adopted') await api(page, 'PATCH', `/topics/${topic.id}`, { status })
    topics.push({ ...topic, status })
  }
  await page.clock.install()
  for (const topic of topics) {
    await page.goto(`/a/${account.id}/topics?tab=${topic.status}`)
    const card = page.getByText(topic.title, { exact: true }).locator('..').locator('..').locator('..')
    await card.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/topics`)).find((t: { id: string }) => t.id === topic.id).status).toBe('dropped')
    await page.clock.runFor(9_000)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.clock.resume()
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/topics`)).find((t: { id: string }) => t.id === topic.id).status).toBe(topic.status)
  }
  await page.goto(`/a/${account.id}/topics`)
  await page.route(`**/api/v1/topics/${topics[0].id}`, route => route.fulfill({ status: 500, json: { error: { code: 'internal', message: '放弃失败模拟' } } }))
  const card = page.getByText(topics[0].title, { exact: true }).locator('..').locator('..').locator('..')
  await card.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '放弃', exact: true }).click()
  await expect(page.getByText('放弃失败模拟', { exact: true })).toBeVisible()
  await expect(page.getByText(`已放弃选题「${topics[0].title}」`, { exact: true })).toHaveCount(0)
  expect((await api(page, 'GET', `/accounts/${account.id}/topics`)).find((t: { id: string }) => t.id === topics[0].id).status).toBe('pending')
})
