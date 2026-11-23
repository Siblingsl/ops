import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const mockBase = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'
const ADD_MENU_TRIGGER_TESTID = 'desktop-agent-add-menu-trigger'
const ADD_MENU_LIST_TESTID = 'desktop-agent-add-menu-list'

async function useDesktopAgent(page: Page) {
  await page.addInitScript(() => {
    const apply = () => {
      document.documentElement.dataset.presentation = 'ops-creative-desktop'
      document.documentElement.dataset.theme = 'light'
      document.documentElement.dataset.reducedMotion = 'soft'
    }
    if (document.documentElement) apply()
    else document.addEventListener('DOMContentLoaded', apply, { once: true })
  })
}

/**
 * REF41 A7：工作流模板只建计划，不执行工具（桌面工作台形态）。
 * 从统一“添加”菜单进入模板弹窗，验证缺项标红、confirm/工具数预览和计划卡等待确认。
 */
test('A7 桌面工作流模板选择、缺项标红与计划预览', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const weeklyName = `周复盘桌面 E2E ${Date.now()}`
  await api(page, 'POST', '/workflows', {
    name: weeklyName,
    description: '拉指标 → 同龄对比 → 生成复盘 → 人工确认。',
    steps: [
      { key: 'pull_metrics', title: '拉取一周指标', requires: ['account_id', 'date_range'], outputs: ['metrics'], confirm: false, tools: ['metrics__read'] },
      { key: 'peer_compare', title: '同龄对比', requires: ['account_id', 'date_range'], outputs: ['peer_card'], confirm: false, tools: ['review__peer'] },
      { key: 'confirm_review', title: '人工确认复盘', requires: ['account_id'], outputs: [], confirm: true, tools: ['review__confirm'] },
    ],
  })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A7 工作流桌面模型', base_url: mockBase, api_key: 'local-e2e-key', models: ['mock-agent-writing'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-writing' },
    { task_type: 'default', provider_id: provider.id, model: 'mock-agent-writing' },
  ])
  await useDesktopAgent(page)
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  await expect(page.getByTestId(ADD_MENU_TRIGGER_TESTID)).toBeVisible()
  await page.getByTestId(ADD_MENU_TRIGGER_TESTID).click()
  const menu = page.getByTestId(ADD_MENU_LIST_TESTID)
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /工作流模板/ }).click()

  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('workflow-template-list') })
  await expect(dialog).toBeVisible()
  // A7-N4：新 workspace 由建区 seed 自动获得内置模板，不再依赖 E2E 自建模板。
  await expect(dialog.getByRole('button', { name: /周复盘 · 内置/ })).toBeVisible()
  await dialog.getByText(weeklyName, { exact: true }).click()
  await expect(dialog.getByTestId('workflow-inputs')).toBeVisible()
  await expect(dialog.getByTestId('workflow-plan-preview')).toContainText('拉取一周指标')
  await expect(dialog.getByTestId('workflow-step-confirm_review')).toContainText('需人工确认')
  await expect(dialog.getByTestId('workflow-step-confirm_review')).toContainText('工具 1')
  await expect(dialog.getByRole('button', { name: /全部执行/ })).toHaveCount(0)

  await dialog.locator('[data-testid="workflow-field-account_id"] select').selectOption(account.id)
  await dialog.getByTestId('workflow-create-plan').click()
  await expect(dialog.getByTestId('workflow-field-date_range')).toContainText('必填')
  await expect(dialog.getByText(/还缺少：日期范围/)).toBeVisible()
  await expect(dialog.getByTestId('workflow-plan-preview')).toBeVisible()

  await dialog.locator('[data-testid="workflow-field-date_range"] input').fill('2026-11-01~2026-11-07')
  const started = page.waitForResponse((response) => /\/api\/v1\/workflows\/[0-9a-f-]+\/start$/.test(response.url()) && response.request().method() === 'POST')
  await dialog.getByTestId('workflow-create-plan').click()
  const response = await started
  expect(response.status()).toBe(200)
  const body = await response.json() as {
    conversation_id: string
    run_id: string
    plan: {
      id: string
      version: number
      steps: { id: string; title: string; acceptance: string }[]
      step_states: { step_id: string; status: string }[]
    }
  }
  expect(body.conversation_id).toBeTruthy()
  expect(body.run_id).toBeTruthy()
  expect(body.plan).toBeTruthy()
  expect(body.plan.steps.map((step) => step.id)).toEqual(['pull_metrics', 'peer_compare', 'confirm_review'])
  expect(body.plan.steps[0].acceptance).toContain('metrics')
  await page.waitForURL(/\/agent\/c\/[0-9a-f-]+/)
  const planCard = page.getByTestId(`agent-plan-${body.plan.id}`)
  await expect(planCard).toBeVisible()
  await expect(planCard).toContainText('计划 · 第 1 版')
  await expect(planCard).toContainText('拉取一周指标')
  await expect(planCard.getByRole('button', { name: '按此计划继续', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /全部执行/ })).toHaveCount(0)

  // A7-N6：确认计划后进入执行轮；首步应由计划卡显示“进行中”，且不自动生成写卡。
  const acceptStarted = page.waitForResponse((response) => response.url().endsWith(`/api/v1/agent/plans/${body.plan.id}/accept`) && response.request().method() === 'POST')
  await planCard.getByRole('button', { name: '按此计划继续', exact: true }).click()
  expect((await acceptStarted).status()).toBe(202)

  type ConversationDetail = {
    conversation: { mode: string }
    last_run: { trigger: string } | null
    plans: { id: string; accepted_at: string | null; step_states: { step_id: string; status: string }[] }[]
    actions: unknown[]
  }
  const detail = async () => (await api(page, 'GET', `/agent/conversations/${body.conversation_id}`)) as ConversationDetail
  await expect.poll(async () => (await detail()).plans.find((plan) => plan.id === body.plan.id)?.accepted_at ?? null).not.toBeNull()
  const accepted = await detail()
  expect(accepted.conversation.mode).toBe('execute')
  expect(accepted.last_run?.trigger).toBe('plan_accept')
  expect(accepted.actions).toHaveLength(0)
  await expect.poll(async () => (await detail()).plans.find((plan) => plan.id === body.plan.id)?.step_states.find((state) => state.step_id === 'pull_metrics')?.status ?? '').toBe('in_progress')

  await expect(planCard).toContainText('已接受')
  await expect(planCard.getByRole('button', { name: '按此计划继续', exact: true })).toHaveCount(0)
  await expect(planCard.locator('li').first()).toContainText('进行中')
  await expect(page.getByRole('button', { name: /全部执行/ })).toHaveCount(0)
})
