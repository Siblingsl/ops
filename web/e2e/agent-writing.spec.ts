import { expect, test, type Page } from '@playwright/test'
import type { AgentAction, AgentConversationDetail } from '../src/lib/agent'
import { api, registerAccount } from './support'

test.beforeEach(async ({ baseURL }) => {
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  expect(baseURL).toBe('http://127.0.0.1:5179')
})

async function prepareAgent(page: Page) {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const provider = await api(page, 'POST', '/model-providers', {
    name: '写入卡片浏览器模拟模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-writing'],
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
  return account
}

const tool = (name: string, args: Record<string, unknown>) => `#tool ${name} ${JSON.stringify(args)}`

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/发送消息/).fill(text)
  const response = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  return id
}

function actionCard(page: Page, action: AgentAction) {
  const cards = page.getByRole('heading', { name: action.title, exact: true }).locator('..').locator('..')
  const title = action.changes.find((change) => change.field === 'title')?.after
  return action.tool_name === 'topics__create' && title ? cards.filter({ has: page.getByText(title, { exact: true }) }) : cards
}

test('E2E-23 生成标题作为卡片来源，用户修改后逐张写入，作品及日志标记来自智能体', async ({ page }) => {
  const account = await prepareAgent(page)
  const originalTitle = '尚未修改的回归作品'
  const generatedTitle = '小步持续改进'
  const editedTitle = '用户确认后的小步改进'
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: originalTitle })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: generatedTitle })
  const conversationId = await send(page, [
    '先读取作品列表，再调用标题生成工具，只提出采用第一个生成候选的卡片；执行前不要修改作品。',
    tool('load_tool_domain', { domain: 'works' }),
    tool('works__list', { accountId: account.id }),
    tool('load_tool_domain', { domain: 'writing' }),
    tool('works__titles', { id: work.id }),
    tool('works__update', { id: work.id, title: generatedTitle }),
  ].join('\n'))
  const proposed = await api(page, 'GET', `/agent/conversations/${conversationId}`) as AgentConversationDetail
  expect(proposed.actions).toHaveLength(1)
  const action = proposed.actions[0]
  expect(action).toMatchObject({ tool_name: 'works__update', status: 'pending', target: { id: work.id } })
  expect(action.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title', after: generatedTitle, editable: true })]))
  const calls = proposed.messages.flatMap((message) => message.tool_calls)
  expect(calls.some((call) => call.name === 'works__list')).toBeTruthy()
  const generated = calls.find((call) => call.name === 'works__titles')
  expect(generated).toBeTruthy()
  expect(generated!.result_preview).toContain(generatedTitle)
  expect((await api(page, 'GET', `/works/${work.id}`)).title).toBe(originalTitle)
  const card = actionCard(page, action)
  await expect(card).toHaveCount(1)
  await card.getByRole('textbox', { name: '修改标题', exact: true }).fill(editedTitle)
  const executed = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/agent/actions/${action.id}/execute` && r.request().method() === 'POST')
  await card.getByRole('button', { name: '执行', exact: true }).click()
  const response = await executed
  expect(response.ok()).toBeTruthy()
  expect(response.request().postDataJSON()).toMatchObject({ confirm: true, edits: { title: editedTitle } })
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).title).toBe(editedTitle)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).actions[0].status).toBe('succeeded')
  await page.goto(`/works/${work.id}`)
  await expect(page.getByRole('main').getByText(editedTitle, { exact: true })).toBeVisible()
  const logs = await api(page, 'GET', '/audit-logs?limit=100')
  const audit = logs.find((log: { target_id: string; detail?: { via_agent?: boolean; agent_action_id?: string } }) => log.target_id === work.id && log.detail?.via_agent === true && log.detail.agent_action_id === action.id)
  expect(audit, '作品标题写入应记录关联这张卡片的 via_agent 审计').toBeTruthy()
  await page.goto('/settings/logs')
  const row = page.locator('li').filter({ hasText: action.id })
  await expect(row).toHaveCount(1)
  await expect(row.getByText('来自智能体', { exact: true })).toBeVisible()
})

test('E2E-25 同批五张选题卡逐张执行三张、拒绝两张后自动续跑汇报，且无批量执行入口', async ({ page }) => {
  const account = await prepareAgent(page)
  const titles = Array.from({ length: 5 }, (_, i) => `批次回归选题${i + 1}`)
  const conversationId = await send(page, [
    '请为以下五条选题分别提出入库卡片，由我逐张确认。',
    tool('load_tool_domain', { domain: 'topics' }),
    ...titles.map((title, i) => tool('topics__create', { accountId: account.id, title, angle: `第${i + 1}条选题的用户指定角度`, source: 'manual' })),
  ].join('\n'))
  const proposed = await api(page, 'GET', `/agent/conversations/${conversationId}`) as AgentConversationDetail
  expect(proposed.actions).toHaveLength(5)
  expect(new Set(proposed.actions.map((action) => action.batch_id)).size).toBe(1)
  expect(proposed.actions.every((action) => action.tool_name === 'topics__create' && action.status === 'pending' && action.gate === 'H-01')).toBeTruthy()
  const ordered = titles.map((title) => proposed.actions.find((action) => action.changes.some((change) => change.field === 'title' && change.after === title))!)
  expect(ordered.every(Boolean)).toBeTruthy()
  const requests = { execute: [] as string[], reject: [] as string[], continue: 0 }
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = new URL(request.url()).pathname
    const action = path.match(/^\/api\/v1\/agent\/actions\/([^/]+)\/(execute|reject)$/)
    if (action) requests[action[2] as 'execute' | 'reject'].push(action[1])
    if (path === `/api/v1/agent/conversations/${conversationId}/continue`) requests.continue++
  })
  await expect(page.getByRole('button', { name: /全部执行|批量执行|全部入库|全部确认/ })).toHaveCount(0)
  for (let i = 0; i < 3; i++) {
    const action = ordered[i]
    const card = actionCard(page, action)
    await expect(card).toHaveCount(1)
    await card.getByRole('checkbox', { name: /我已核对/ }).check()
    await card.getByRole('button', { name: '入库', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).actions.find((item: AgentAction) => item.id === action.id)?.status).toBe('succeeded')
    expect(requests.continue).toBe(0)
  }
  for (let i = 3; i < 5; i++) {
    const action = ordered[i]
    const rejected = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/agent/actions/${action.id}/reject` && r.request().method() === 'POST')
    await actionCard(page, action).getByRole('button', { name: '拒绝', exact: true }).click()
    const result = await (await rejected).json()
    expect(result).toMatchObject({ batch_resolved: i === 4, can_continue: i === 4 })
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).actions.find((item: AgentAction) => item.id === action.id)?.status).toBe('rejected')
    if (i === 3) expect(requests.continue).toBe(0)
  }
  await expect.poll(() => requests.continue).toBe(1)
  await expect(page.getByText(/当前批次处理完毕/)).toBeVisible()
  const completed = await api(page, 'GET', `/agent/conversations/${conversationId}`) as AgentConversationDetail
  expect(completed.actions).toHaveLength(5)
  expect(completed.actions.filter((action) => action.status === 'succeeded')).toHaveLength(3)
  expect(completed.actions.filter((action) => action.status === 'rejected')).toHaveLength(2)
  expect(requests.execute).toEqual(ordered.slice(0, 3).map((action) => action.id))
  expect(requests.reject).toEqual(ordered.slice(3).map((action) => action.id))
  const topics = await api(page, 'GET', `/accounts/${account.id}/topics?limit=100`)
  const storedTitles = topics.items.map((topic: { title: string }) => topic.title)
  expect(storedTitles.filter((title: string) => titles.includes(title)).sort()).toEqual(titles.slice(0, 3).sort())
  await expect(page.getByRole('button', { name: /全部执行|批量执行|全部入库|全部确认/ })).toHaveCount(0)
})
