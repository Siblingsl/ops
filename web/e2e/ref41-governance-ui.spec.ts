import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

type Account = { id: string; name: string; platform: string; status: string }

async function dismissPrivacyIfPresent(page: Page) {
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await page.getByRole('button', { name: '我知道了', exact: true }).click({ timeout: 3_000 }).catch(() => undefined)
  await expect(privacy).toHaveCount(0)
}

// REF41 E2/F1/F2/F5 UI1 的独立功能复跑：不只看 tsc，逐卡走真实 API 与落库状态。
test('REF41 E2/F1/F2/F5 Web：MCP 令牌、告警规则、账号合并、浏览器策略', async ({ page }) => {
  test.setTimeout(120_000)
  const target = await registerAccount(page, '图文笔记', 'xhs', `ref41-gov-web-${Date.now()}`) as Account
  const source = await api(page, 'POST', '/accounts', {
    platform: 'xhs', name: `合并源 ${Date.now()}`, content_format: 'image_note',
  }) as Account
  expect(source.id).not.toBe(target.id)

  // E2-UI1：MCP 令牌创建只显示一次明文，列表不含明文，撤销后状态即时落库。
  await page.goto('/settings/security')
  const mcp = page.getByTestId('mcp-token-card')
  await expect(mcp).toBeVisible()
  const tokenName = `E2E MCP ${Date.now()}`
  await mcp.getByPlaceholder('外部看板 / 自动化脚本').fill(tokenName)
  const tokenCreated = page.waitForResponse((r) => r.url().endsWith('/api/v1/mcp/tokens') && r.request().method() === 'POST')
  await mcp.getByRole('button', { name: '创建令牌', exact: true }).click()
  expect((await tokenCreated).ok()).toBeTruthy()
  const plain = page.getByTestId('mcp-token-plain')
  await expect(plain).toBeVisible()
  await expect(plain).toContainText('新令牌（只显示这一次')
  await plain.getByRole('button', { name: '我已保存', exact: true }).click()
  await expect(plain).toHaveCount(0)
  const tokens = await api(page, 'GET', '/mcp/tokens') as { tokens: Array<{ id: string; name: string; status: string }> }
  const token = tokens.tokens.find((item) => item.name === tokenName)
  expect(token, JSON.stringify(tokens)).toBeTruthy()
  const tokenRow = mcp.getByText(tokenName, { exact: true }).locator('..')
  await expect(tokenRow).toContainText('read:topics')
  const revoked = page.waitForResponse((r) => r.url().endsWith(`/api/v1/mcp/tokens/${token!.id}`) && r.request().method() === 'DELETE')
  await tokenRow.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await revoked).ok()).toBeTruthy()
  await expect(tokenRow).toContainText('已撤销')
  const afterRevoke = await api(page, 'GET', '/mcp/tokens') as { tokens: Array<{ id: string; status: string }> }
  expect(afterRevoke.tokens.find((item) => item.id === token!.id)?.status).toBe('revoked')

  // F5-UI1：创建→续期→停用→启用，状态以 GET /browser-task-policies 为准。
  const policyCard = page.getByTestId('browser-policy-card')
  await expect(policyCard).toBeVisible()
  await policyCard.locator('textarea').fill('https://creator.xiaohongshu.com/publish')
  const policyCreated = page.waitForResponse((r) => r.url().endsWith('/api/v1/browser-task-policies') && r.request().method() === 'POST')
  await policyCard.getByTestId('browser-policy-create').click()
  const policyResponse = await policyCreated
  expect(policyResponse.ok()).toBeTruthy()
  const policyID = (await policyResponse.json() as { id: string }).id
  const policyRow = page.getByTestId(`browser-policy-${policyID}`)
  await expect(policyRow).toContainText('发布体检')
  await expect(policyRow).toContainText('生效')
  const renewed = page.waitForResponse((r) => r.url().endsWith(`/api/v1/browser-task-policies/${policyID}/renew`) && r.request().method() === 'POST')
  await policyRow.getByRole('button', { name: '续期', exact: true }).click()
  expect((await renewed).ok()).toBeTruthy()
  const disabled = page.waitForResponse((r) => r.url().endsWith(`/api/v1/browser-task-policies/${policyID}`) && r.request().method() === 'PATCH')
  await policyRow.getByRole('button', { name: '停用', exact: true }).click()
  expect((await disabled).ok()).toBeTruthy()
  await expect(policyRow).toContainText('已停用')
  const enabled = page.waitForResponse((r) => r.url().endsWith(`/api/v1/browser-task-policies/${policyID}`) && r.request().method() === 'PATCH')
  await policyRow.getByRole('button', { name: '启用', exact: true }).click()
  expect((await enabled).ok()).toBeTruthy()
  await expect(policyRow).toContainText('生效')
  const policies = await api(page, 'GET', '/browser-task-policies') as { policies: Array<{ id: string; status: string; purpose: string; url_patterns: string[] }> }
  expect(policies.policies.find((item) => item.id === policyID)).toMatchObject({
    status: 'active', purpose: 'publish_health', url_patterns: ['https://creator.xiaohongshu.com/publish'],
  })

  // F1-UI1：四规则卡的阈值/窗口保存与启停。
  await page.goto('/settings/job-runs')
  const alerts = page.getByTestId('alert-rules-card')
  await expect(alerts).toBeVisible()
  const rule = alerts.getByTestId('alert-rule-job_failure_rate')
  await rule.locator('input').nth(0).fill('1')
  await rule.locator('input').nth(1).fill('60')
  const savedRule = page.waitForResponse((r) => r.url().endsWith('/api/v1/alert-rules/job_failure_rate') && r.request().method() === 'PUT')
  await rule.getByRole('button', { name: '保存', exact: true }).click()
  expect((await savedRule).ok()).toBeTruthy()
  const rules = await api(page, 'GET', '/alert-rules') as { rules: Array<{ key: string; threshold: number; window_minutes: number; enabled: boolean }> }
  expect(rules.rules.find((item) => item.key === 'job_failure_rate')).toMatchObject({ threshold: 1, window_minutes: 60, enabled: true })
  await rule.getByRole('button', { name: '停用', exact: true }).click()
  await expect(rule).toContainText('停用')
  const disabledRule = await api(page, 'GET', '/alert-rules') as { rules: Array<{ key: string; enabled: boolean }> }
  expect(disabledRule.rules.find((item) => item.key === 'job_failure_rate')?.enabled).toBe(false)
  await rule.getByRole('button', { name: '启用', exact: true }).click()
  await expect(rule).toContainText('启用')

  // F2-UI1：停用前影响清单；合并对话框预览、确认词与迁移结果。
  await page.goto(`/settings/accounts?id=${target.id}`)
  await dismissPrivacyIfPresent(page)
  const mergeTrigger = page.getByTestId('account-merge-trigger')
  await expect(mergeTrigger).toBeVisible()
  await page.getByRole('button', { name: '停用', exact: true }).click()
  const disableDialog = page.getByRole('dialog').filter({ hasText: '影响清单：作品' })
  await expect(disableDialog).toBeVisible()
  await expect(disableDialog).toContainText('素材')
  await expect(disableDialog).toContainText('进行中发布任务')
  await disableDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(disableDialog).toHaveCount(0)

  await mergeTrigger.click()
  const merge = page.getByTestId('account-merge-dialog')
  await expect(merge).toBeVisible()
  await merge.locator('select').selectOption({ label: source.name })
  const preview = page.getByTestId('account-merge-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('影响清单：作品')
  await merge.getByPlaceholder('合并', { exact: true }).fill('合并')
  const merged = page.waitForResponse((r) => r.url().endsWith(`/api/v1/accounts/${target.id}/merge`) && r.request().method() === 'POST')
  await merge.getByRole('button', { name: '执行合并', exact: true }).click()
  expect((await merged).ok()).toBeTruthy()
  await expect(page.getByTestId('account-merge-result')).toBeVisible()
  await page.getByTestId('account-merge-result').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(merge).toHaveCount(0)
  const accounts = await api(page, 'GET', '/accounts') as Account[]
  expect(accounts.find((item) => item.id === source.id)?.status).toBe('disabled')
  expect(accounts.find((item) => item.id === target.id)?.status).toBe('active')
  await page.screenshot({ path: '../.playwright-results/web/ref41-governance-ui.png', fullPage: true })
})
