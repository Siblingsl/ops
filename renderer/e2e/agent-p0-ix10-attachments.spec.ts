import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-10（DEV-AI-39）：失败附件红边 + 重试成功后可发送；失败项阻断发送并说明。
test('DEV-AI-39 IX-10 失败附件重试后发送', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-10 验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
    key: `ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, id: account.id,
  })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()

  let uploadAttempts = 0
  await page.route('**/api/v1/agent/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    uploadAttempts += 1
    if (uploadAttempts === 1) {
      return route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'upload_failed', message: 'IX-10 首次上传失败' } }),
      })
    }
    return route.continue()
  })

  await page.getByRole('button', { name: '添加', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: /上传附件/ }).click()
  await (await chooser).setFiles([{ name: '重试附件.txt', mimeType: 'text/plain', buffer: Buffer.from('IX-10 重试后应可发送。', 'utf8') }])
  const failedRow = page.getByLabel('重试附件.txt failed', { exact: true })
  await expect(failedRow).toBeVisible({ timeout: 20_000 })
  await expect(failedRow).toHaveClass(/border-danger/)
  await expect(failedRow.getByText('上传失败', { exact: true })).toBeVisible()
  await expect(page.getByText('有 1 个附件未就绪，请处理失败项或移除后再发送。')).toBeVisible()
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ix10-failed-attachment.png') })

  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill('请读取重试附件。')
  const sendButton = page.getByRole('button', { name: '发送', exact: true })
  await expect(sendButton).toBeDisabled()

  await failedRow.getByRole('button', { name: '重试', exact: true }).click()
  const readyRow = page.getByLabel('重试附件.txt ready', { exact: true })
  await expect(readyRow).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('有 1 个附件未就绪，请处理失败项或移除后再发送。')).toBeHidden()
  await expect(sendButton).toBeEnabled()

  let payload: Record<string, unknown> | null = null
  await page.route(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/, async (route) => {
    payload = route.request().postDataJSON()
    await route.abort()
  })
  await sendButton.click()
  await expect.poll(() => payload).not.toBeNull()
  expect(payload!.attachment_ids).toHaveLength(1)
})
