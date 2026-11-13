import { expect, test } from '@playwright/test'
import { api, expectedWebBaseUrl, registerAccount } from './support'

test('DEV-CU P5-5 Web 默认关闭电脑控制：能力门关闭且无控制条 / 批量执行入口', async ({ page, baseURL }, testInfo) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景只验证本地 E2E runtime gate')
  expect(baseURL).toBe(expectedWebBaseUrl())
  await registerAccount(page)

  const me = await api(page, 'GET', '/auth/me') as { features?: Record<string, boolean> }
  expect(me.features?.computer_use === true).toBe(false)
  const capabilities = await page.request.get('/api/v1/agent/computer/capabilities')
  expect(capabilities.status()).toBe(409)
  const capabilitiesBody = await capabilities.json() as { error?: { code?: string } }
  expect(capabilitiesBody.error?.code).toBe('agent_feature_unavailable')

  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
  await expect(page.getByText('AI 正在操作所选应用', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('web-computer-gate.png'), fullPage: true })
})
