import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

const mockBase = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'

type AgentDetail = {
  last_run: Record<string, unknown>
  [key: string]: unknown
}

// 桌面端必须单独走真实 Electron 窗口：与 Web 共用同一份服务端响应夹具，
// 但入口、模型通道和截图路径都按桌面运行器分别配置。
async function prepareDesktopAgent(page: Page) {
  await registerAccount(page, '长图文', 'wechat_mp', `a1-a2-trust-desktop-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A1A2 可信度桌面模型', base_url: mockBase, api_key: 'local-e2e-key', models: ['mock-agent-writing'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-writing' },
    { task_type: 'default', provider_id: provider.id, model: 'mock-agent-writing' },
  ])
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
}

async function seedDesktopConversation(page: Page) {
  await page.getByPlaceholder(/发送消息/).fill('A1/A2 桌面可信度 UI 验收：请用一句话确认收到')
  const response = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  return id
}

async function mockDesktopDetail(page: Page, id: string, detail: AgentDetail) {
  const pattern = `**/api/v1/agent/conversations/${id}`
  await page.unroute(pattern)
  await page.route(pattern, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(detail),
  }))
}

test('REF41 A1/A2 桌面：demo banner、partial chip、blocked 与收尾三段', async ({ page }) => {
  await prepareDesktopAgent(page)
  const id = await seedDesktopConversation(page)
  const detail = await api(page, 'GET', `/agent/conversations/${id}`) as AgentDetail
  expect(detail.last_run).toBeTruthy()

  await mockDesktopDetail(page, id, {
    ...detail,
    last_run: {
      ...detail.last_run,
      demo: true,
      outcome: 'partial',
      reason: '',
      final_check: { claims: ['publish'], evidence: 0, blocked: ['publish'] },
    },
  })
  await page.reload()
  await expect(page.getByTestId('agent-run-demo-banner')).toContainText('模拟模型演示，结果不代表真实执行')
  await expect(page.getByTestId('agent-run-partial-chip')).toContainText('部分完成')
  await expect(page.getByTestId('agent-run-blocked')).toContainText('未执行声明')
  await expect(page.getByTestId('agent-run-blocked')).toContainText('发布')
  mkdirSync(resolve(process.cwd(), '../.playwright-results/desktop-renderer'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/desktop-renderer/a1-a2-agent-trust-blocked.png'), fullPage: true })

  await mockDesktopDetail(page, id, {
    ...detail,
    last_run: {
      ...detail.last_run,
      demo: true,
      outcome: 'partial',
      reason: 'round_limit',
      final_check: {
        claims: [], evidence: 0, blocked: [],
        wrap_up: {
          done: ['第一步：选题（completed）'],
          pending: ['第二步：发布作品（pending）'],
          need_user: ['确认封面图'],
          next_actions: '缩小任务范围后重试。',
        },
      },
    },
  })
  await page.reload()
  await expect(page.getByTestId('agent-run-partial-chip')).toContainText('部分完成（轮次用尽）')
  await expect(page.getByTestId('agent-run-wrapup')).toHaveCount(0)
  await page.getByTestId('agent-run-wrapup-toggle').click()
  await expect(page.getByTestId('agent-run-wrapup')).toContainText('已完成')
  await expect(page.getByTestId('agent-run-wrapup')).toContainText('第一步：选题（completed）')
  await expect(page.getByTestId('agent-run-wrapup')).toContainText('未完成')
  await expect(page.getByTestId('agent-run-wrapup')).toContainText('第二步：发布作品（pending）')
  await expect(page.getByTestId('agent-run-wrapup')).toContainText('待你确认')
  await expect(page.getByTestId('agent-run-wrapup')).toContainText('确认封面图')
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/desktop-renderer/a1-a2-agent-trust-wrapup.png'), fullPage: true })
})
