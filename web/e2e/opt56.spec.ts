import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT56 单条采用并开始写一次点击进编辑器，单独采用不创建作品', async ({ page }) => {
  const account = await registerAccount(page)
  const { topic: first } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '本条立即创作', angle: '人工选题角度' })
  const { topic: second } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '另一条仅排期', angle: '另一条人工角度' })
  await page.goto(`/a/${account.id}/topics`)
  const card = page.getByText(first.title, { exact: true }).locator('..').locator('..').locator('..')
  const started = page.waitForResponse(r => r.url().endsWith(`/topics/${first.id}/works`) && r.request().method() === 'POST')
  await card.getByRole('button', { name: '采用并开始写', exact: true }).click()
  const work = await (await started).json()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
  const stored = await api(page, 'GET', `/works/${work.id}`)
  expect(stored.topic_id).toBe(first.id)
  expect(stored.viewpoint).toBe('')
  expect(stored.outline_confirmed_at).toBeNull()
  let topics = await api(page, 'GET', `/accounts/${account.id}/topics`)
  expect(topics.find((t: { id: string }) => t.id === first.id).status).toBe('adopted')
  expect(topics.find((t: { id: string }) => t.id === second.id).status).toBe('pending')
  await page.goto(`/a/${account.id}/topics`)
  await page.getByRole('button', { name: '采用，稍后写' }).click()
  await expect.poll(async () => {
    topics = await api(page, 'GET', `/accounts/${account.id}/topics`)
    return topics.find((t: { id: string }) => t.id === second.id).status
  }).toBe('adopted')
  expect(topics.find((t: { id: string }) => t.id === second.id).work_id).toBeNull()
  expect((await api(page, 'GET', `/accounts/${account.id}/works`)).length).toBe(1)
})
