import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT19 第四次供应商故障快速中文提示，模型页显示熔断状态', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '供应商故障验收' })
  const [provider] = await api(page, 'GET', '/model-providers')
  await api(page, 'PUT', '/model-routes', [{ task_type: 'tag_suggest', provider_id: provider.id, model: 'mock-down' }])
  const me = await api(page, 'GET', '/auth/me')
  const request = () => page.request.post(`/api/v1/works/${work.id}/tag-suggest`, { data: {}, headers: { 'X-CSRF-Token': me.csrf_token } })
  for (let i = 0; i < 3; i++) expect((await request()).status()).toBe(502)
  const start = performance.now()
  const response = await request()
  const elapsed = performance.now() - start
  expect(response.status()).toBe(503)
  const error = (await response.json()).error
  expect(error.code).toBe('ai_provider_unavailable')
  expect(error.message).toMatch(/供应商暂不可用，约 \d+ 秒后恢复/)
  expect(elapsed).toBeLessThan(1000)
  console.log(`OPT19 fourth request=${elapsed.toFixed(2)}ms`)
  await page.goto('/settings/models')
  await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible()
  await expect(page.getByText(/供应商暂不可用，约 \d+ 秒后恢复/)).toBeVisible()
  expect((await api(page, 'GET', '/model-providers'))[0].circuit_state).toBe('open')
})
