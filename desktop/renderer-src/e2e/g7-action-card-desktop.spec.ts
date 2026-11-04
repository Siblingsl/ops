import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-QA26（26 台账 G7-05）：桌面动作卡此前只断言卡片可见与红线（无「全部执行」），
// 没有逐张执行的实际写入走查（Web 端 agent-cards.spec.ts 已覆盖）。这里补齐：
// 执行→二次确认→服务端素材创建、拒绝路径，以及红线断言保持。
// 用 UA-mock 桌面形态（与 desktop-agent-restoration 相同模式），写入由服务端真实校验。

async function openAgent(page: Page, account: { id: string }) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'QA26 动作卡模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL!, api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`/a/${account.id}`)
  await page.getByRole('button', { name: /用户菜单/ }).click()
  await page.getByRole('menuitem', { name: '切换工作区与账号' }).click()
  await page.getByTestId('desktop-context-menu').getByRole('tab', { name: /小红书/ }).click()
  await page.getByTestId('desktop-context-menu').getByRole('button', { name: '浏览器验收号', exact: true }).click()
  await page.getByRole('link', { name: 'AI 对话', exact: true }).click()
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) }).getByRole('button', { name: '我知道了', exact: true }).click()
  await page.getByTestId('desktop-agent-list').getByRole('button', { name: '新对话', exact: true }).click()
}

async function sendToolMessage(page: Page, accountId: string, content: string) {
  await page.getByPlaceholder(/说说你想写什么/).fill(`请添加素材：${content}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: accountId, kind: 'opinion', content })}`)
  const create = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await create).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  const proposed = await api(page, 'GET', `/agent/conversations/${id}`)
  return { id, actions: proposed.actions as Array<{ id: string; status: string }> }
}

test('DEV-QA26 桌面动作卡逐张执行：确认门槛→服务端素材创建，红线无全部执行', async ({ page }) => {
  const account = await registerAccount(page)
  await openAgent(page, account)
  const message = '桌面动作卡逐张执行走查素材。'
  const { id: conversationId, actions } = await sendToolMessage(page, account.id, message)
  expect(actions).toHaveLength(1)
  expect(actions[0].status).toBe('pending')

  const card = page.locator('.desktop-agent-action-card').first()
  await expect(card).toBeAttached()
  // 红线（D-117）：不提供批量执行入口。
  await expect(page.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)

  // materials__create 是普通写入卡：点击执行即执行（无 H 门二次确认对话框，H-05 语义是"逐张亲自点击"本身）。
  const execFirst = page.waitForResponse((r) => /\/agent\/actions\/[^/]+\/execute$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await card.getByRole('button', { name: /执行|入库|保存/ }).first().click()
  const execResp = await execFirst
  expect(execResp.ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).actions[0].status).toBe('succeeded')

  // 服务端真实写入：素材库出现这条内容（写入不是前端假装的）。
  const materials = await api(page, 'GET', `/materials?account_id=${account.id}`) as Array<{ content: string }>
  expect(materials.some((m) => (m.content ?? '').includes('桌面动作卡逐张执行走查素材'))).toBeTruthy()
})

test('DEV-QA26 桌面动作卡拒绝：单卡拒绝后状态 rejected，不产生服务端写入', async ({ page }) => {
  const account = await registerAccount(page)
  await openAgent(page, account)
  const message = '桌面动作卡拒绝走查素材。'
  const { id, actions } = await sendToolMessage(page, account.id, message)
  expect(actions).toHaveLength(1)
  const card = page.locator('.desktop-agent-action-card').first()
  const reject = page.waitForResponse((r) => /\/agent\/actions\/[^/]+\/reject$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  await reject
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions[0].status).toBe('rejected')
  const materials = await api(page, 'GET', `/materials?account_id=${account.id}`) as Array<{ content: string }>
  expect(materials.some((m) => (m.content ?? '').includes('桌面动作卡拒绝走查素材'))).toBeFalsy()
})
