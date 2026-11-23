import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 FN-05（DEV-AI-39）：目标证据与迭代——
// criteria 证据可展开/可定位（read_result → 消息）；goal-runs 迭代视图；卡点动作化。
test('DEV-AI-39 FN-05 目标证据展开与按运行迭代', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN-05 目标证据验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  const conversation = await api(page, 'POST', '/agent/conversations', {
    title: 'FN05 目标证据', account_id: account.id, model: { provider_id: provider.id, model: 'mock-agent-tested' },
  }) as { id: string }

  // 创建目标（未启动 run）。
  const goal = await api(page, 'POST', `/agent/conversations/${conversation.id}/goal`, {
    request_id: randomUUID(), objective: '核对本账号最近的作品数据并形成结论',
    criteria: [{ text: '读取到至少一篇作品的数据', requires_confirmation: false }],
    account_id: account.id, model: { provider_id: provider.id, model: 'mock-agent-tested' },
    allow_background: false, run_budget: 10, seconds_budget: 1800,
  }) as { goal: { id: string; revision: number } }

  // 第一轮 run：提出一张 inbox__create 卡片（W 类逐卡确认），并读取作品（goal 迭代行绑定）。
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'FN05 目标证据作品' }) as { id: string }
  await api(page, 'POST', `/agent/conversations/${conversation.id}/messages`, {
    text: ['提出一条灵感并读取作品', '#tool load_tool_domain {"domain":"materials"}',
      `#tool inbox__create ${JSON.stringify({ content: 'FN05 目标证据灵感' })}`,
      '#tool load_tool_domain {"domain":"works"}',
      `#tool works__get ${JSON.stringify({ id: work.id })}`,
    ].join('\n'),
    request_id: randomUUID(), protocol_version: 2,
  })
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversation.id}`)).active_run, { timeout: 30_000 }).toBeNull()

  // 真实执行卡片：先进入对话页（卡片在消息流中渲染），经审阅抽屉“执行”（响应为 SSE）。
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto(`/agent/c/${conversation.id}`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const detail0 = await api(page, 'GET', `/agent/conversations/${conversation.id}`)
  const card = detail0.actions.find((action: { tool_name: string; status: string }) => action.tool_name === 'inbox__create' && action.status === 'pending')
  expect(card, 'run 应提出 inbox__create 待审卡片').toBeTruthy()
  const cardArticle = page.locator(`#agent-action-${card.id}`)
  await expect(cardArticle).toBeVisible({ timeout: 15_000 })
  await cardArticle.getByRole('button', { name: '查看修改', exact: true }).click()
  const executed = page.waitForResponse((response) => response.url().endsWith(`/agent/actions/${card.id}/execute`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  expect((await executed).ok()).toBeTruthy()
  await expect.poll(async () => {
    const refreshed = await api(page, 'GET', `/agent/conversations/${conversation.id}`) as { actions: { id: string; status: string }[] }
    return refreshed.actions.find((action) => action.id === card.id)?.status
  }, { timeout: 30_000 }).toBe('succeeded')
  // 卡片执行结束且对话无活动 run 后才能发报告 run。
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversation.id}`)).active_run, { timeout: 30_000 }).toBeNull()

  // 用成功卡片作 action 证据，经 run 内元工具 report_goal_progress 报告 met。
  // 注意：报告 run 启动时 goal.revision 会 +1（agentStartRunTx），expected_revision 用“当前值 + 1”。
  // 若对话瞬时 busy（goal 后台续跑竞态），稍候重发。
  const reportProgress = async () => {
    const detail = await api(page, 'GET', `/agent/conversations/${conversation.id}`)
    const criterion = detail.goal.criteria[0] as { id: string }
    await page.evaluate(async ({ conversationID, goalID, revision, criterionID, actionID, requestID }) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch(`/api/v1/agent/conversations/${conversationID}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        body: JSON.stringify({
          text: ['报告目标进度', '#tool report_goal_progress ' + JSON.stringify({
            goal_id: goalID, expected_revision: revision + 1,
            criteria: [{ id: criterionID, result: 'met', evidence_refs: [{ kind: 'action', id: actionID }] }],
          })].join('\n'),
          request_id: requestID, protocol_version: 2,
        }),
      })
      if (!response.ok) throw new Error(`report: ${response.status} ${await response.text()}`)
    }, { conversationID: conversation.id, goalID: detail.goal.id, revision: detail.goal.revision, criterionID: criterion.id, actionID: card.id, requestID: randomUUID() })
  }
  // 瞬时 busy 时轮询重发。
  await expect(async () => { await reportProgress() }).toPass({ timeout: 45_000 })
  await expect.poll(async () => {
    const refreshed = await api(page, 'GET', `/agent/conversations/${conversation.id}`) as { goal?: { criteria: { status: string }[] } }
    return refreshed.goal?.criteria?.[0]?.status
  }, { timeout: 30_000 }).toBe('verified')

  // 打开任务面板：先关掉仍开着的审阅抽屉（执行成功后不自动关），目标 criteria 证据可展开并带“查看”。
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开任务面板' }).click()
  const evidenceToggle = page.getByRole('button', { name: /已关联 1 项证据/ })
  await expect(evidenceToggle).toBeVisible({ timeout: 15_000 })
  await evidenceToggle.click()
  await expect(page.getByText('已完成卡片', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '查看', exact: true }).first().click()

  // 按 run 迭代：goal-runs 至少一行（消息 run 绑定 goal）。
  await expect(page.getByText('按运行迭代', { exact: true })).toBeVisible({ timeout: 15_000 })
  const runRows = page.locator('[data-testid="agent-goal-runs"] li')
  await expect(runRows.first()).toContainText(/轮/)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-fn05-goal-evidence.png') })
})
