import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const ACCOUNT_ID_PLACEHOLDER = '00000000-0000-4000-8000-000000000001'

type FixtureBlock = {
  key: string
  label: string
  count: number
  count_label: string
  items: { id: string; kind: string; title: string; detail: string; meta: string; tone: string; to: string }[]
  more?: { label: string; to: string }
  error?: string
}

function fixture(accountID: string, options: { partial?: boolean; empty?: boolean } = {}) {
  const items = (label: string, to: string) => ({
    id: label, kind: label, title: `${label}示例`, detail: `${label}详情`, meta: '今天', tone: 'attention', to,
  })
  const blocks: FixtureBlock[] = [
    { key: 'pending', label: '待处理', count: options.empty ? 0 : 4, count_label: '项', items: options.empty ? [] : [items('待处理1', '/agent/c/' + ACCOUNT_ID_PLACEHOLDER), items('待处理2', '/agent'), items('待处理3', '/agent'), items('待处理4', '/agent')], more: { label: '打开 AI 对话', to: '/agent' } },
    { key: 'publishing', label: '待发布', count: options.empty ? 0 : 1, count_label: '条', items: options.empty ? [] : [items('待发布', '/works/' + ACCOUNT_ID_PLACEHOLDER)], more: { label: '打开发布看板', to: `/a/${accountID}/ops` } },
    { key: 'today', label: '今日数据', count: options.empty ? 0 : 1, count_label: '篇', items: options.empty ? [] : [items('今日数据', `/a/${accountID}/review?work=${ACCOUNT_ID_PLACEHOLDER}`)], more: { label: '打开数据复盘', to: `/a/${accountID}/review` } },
    {
      key: 'comments', label: '评论', count: options.empty ? 0 : 1, count_label: '条', items: options.empty ? [] : [items('评论', `/a/${accountID}/profile?tab=comments`)],
      more: { label: '打开评论台账', to: `/a/${accountID}/profile?tab=comments` },
      ...(options.partial ? { error: '该区块暂时不可用，其他区块仍可查看' } : {}),
    },
    { key: 'routines', label: '例行', count: options.empty ? 0 : 1, count_label: '项', items: options.empty ? [] : [items('例行', '/agent?panel=routine')], more: { label: '打开例行任务', to: '/agent?panel=routine' } },
    { key: 'risks', label: '风险', count: options.empty ? 0 : 1, count_label: '项', items: options.empty ? [] : [items('风险', '/works/' + ACCOUNT_ID_PLACEHOLDER)], more: { label: '打开发布看板', to: `/a/${accountID}/ops` } },
  ]
  return {
    account: { id: accountID, name: 'FN11 状态验收号', platform: 'xhs' },
    generated_at: new Date().toISOString(),
    summary: { pending: options.empty ? 0 : 4, publishing: options.empty ? 0 : 1, today_data: options.empty ? 0 : 1, comments: options.empty ? 0 : 1, routines: options.empty ? 0 : 1, risks: options.empty ? 0 : 1 },
    blocks,
  }
}

async function enableModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN11 状态验收模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL || 'http://127.0.0.1:8297/v1',
    api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
}

async function useDesktopAgent(page: Page) {
  // 浏览器渲染器里注册流程仍走普通网页形态；进入 Agent 前只打开桌面 presentation，
  // 让 workbench_ui 与 today_ops 的既有门控生效，不伪造成 Electron E2E。
  await page.addInitScript(() => {
    const apply = () => {
      document.documentElement.dataset.presentation = 'ops-creative-desktop'
      document.documentElement.dataset.theme = 'light'
      document.documentElement.dataset.reducedMotion = 'soft'
    }
    if (document.documentElement) apply()
    else document.addEventListener('DOMContentLoaded', apply, { once: true })
  })
  await page.goto('/agent')
  const applied = await page.evaluate(() => document.documentElement.dataset.presentation === 'ops-creative-desktop')
  if (!applied) {
    await page.evaluate(() => {
      document.documentElement.dataset.presentation = 'ops-creative-desktop'
      document.documentElement.dataset.theme = 'light'
      document.documentElement.dataset.reducedMotion = 'soft'
    })
    await page.reload()
  }
}

async function dismissPrivacy(page: Page) {
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined)
  if (await privacy.isVisible().catch(() => false)) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toHaveCount(0)
}

async function openFromMenu(page: Page) {
  await page.getByTestId('desktop-agent-add-menu-trigger').click()
  await page.getByRole('menuitem', { name: /今日运营/ }).click()
}

test('FN-11 门控：today_ops 关闭时保留三张场景卡与一行摘要，且无今日运营入口', async ({ page }) => {
  const account = await registerAccount(page)
  await enableModel(page)
  const bootstrap = await api(page, 'GET', '/agent/bootstrap') as { features: Record<string, boolean> }
  expect(bootstrap.features.workbench_ui).toBe(true)
  await page.route('**/api/v1/agent/bootstrap', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, features: { ...body.features, today_ops: false } } })
  })
  await useDesktopAgent(page)
  await dismissPrivacy(page)
  await expect(page.getByRole('button', { name: /填入：/ })).toHaveCount(3)
  await expect(page.getByTestId('today-ops-welcome-entry')).toHaveCount(0)
  await expect(page.locator('.desktop-agent-welcome-summary')).toContainText('今天 0 项待处理')
  await page.getByTestId('desktop-agent-add-menu-trigger').click()
  await expect(page.getByRole('menuitem', { name: /今日运营/ })).toHaveCount(0)
  await expect(page.getByTestId('today-ops-panel')).toHaveCount(0)
  expect(account.id).toBeTruthy()
})

test('FN-11 失败态：500 显示原因、请求 ID 与可重试，不伪装成空数据', async ({ page }) => {
  await registerAccount(page)
  await enableModel(page)
  let calls = 0
  await page.route('**/api/v1/agent/today-ops*', async (route) => {
    calls++
    await route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'today_ops_unavailable', message: '今日运营暂时不可用，请稍后重试', request_id: 'req-fn11-500' } }),
    })
  })
  await useDesktopAgent(page)
  await dismissPrivacy(page)
  await openFromMenu(page)
  const panel = page.getByTestId('today-ops-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('今日运营加载失败', { exact: true })).toBeVisible()
  await expect(panel).toContainText('请求 ID')
  await expect(panel.getByTestId('today-ops-block-pending')).toHaveCount(0)
  const retry = panel.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeVisible()
  const before = calls
  await retry.click()
  await expect.poll(() => calls).toBeGreaterThan(before)
 })

test('FN-11 部分失败：具体块名报错可单独重试，其余五块继续渲染；单块最多 3 条', async ({ page }) => {
  const account = await registerAccount(page)
  await enableModel(page)
  let calls = 0
  let retryQuery = ''
  await page.route('**/api/v1/agent/today-ops*', async (route) => {
    const url = new URL(route.request().url())
    const block = url.searchParams.get('block')
    calls++
    if (block) {
      retryQuery = url.search
      const full = fixture(account.id, { partial: false })
      const one = full.blocks.find((item) => item.key === block)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...full, blocks: one ? [one] : [] }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture(account.id, { partial: true })) })
  })
  await useDesktopAgent(page)
  await dismissPrivacy(page)
  await page.getByTestId('today-ops-welcome-entry').click()
  const panel = page.getByTestId('today-ops-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('today-ops-block-comments')).toContainText('“评论”暂时没有加载成功')
  await expect(panel.getByTestId('today-ops-block-publishing')).toContainText('待发布示例')
  await expect(panel.getByTestId('today-ops-block-routines')).toContainText('例行示例')
  await expect(panel.getByTestId('today-ops-block-pending').getByTestId('today-ops-item')).toHaveCount(3)
  await expect(panel.getByTestId('today-ops-block-pending')).toContainText('4 项')
  const before = calls
  await panel.getByTestId('today-ops-block-comments').getByRole('button', { name: '重试本块' }).click()
  await expect.poll(() => retryQuery).toContain('block=comments')
  await expect.poll(() => calls).toBeGreaterThan(before)
  await expect(panel.getByTestId('today-ops-block-comments')).toContainText('评论示例')
  await expect(panel.getByTestId('today-ops-block-comments')).not.toContainText('暂时没有加载成功')
  await expect(panel.getByTestId('today-ops-block-publishing')).toContainText('待发布示例')
 })

test('FN-11 空态/无权限：每块有独立空文案；403 不展示任何业务块', async ({ page }) => {
  const account = await registerAccount(page)
  await enableModel(page)
  let mode: 'empty' | 'forbidden' = 'empty'
  await page.route('**/api/v1/agent/today-ops*', async (route) => {
    if (mode === 'forbidden') {
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: '观察者仅可浏览，今日运营需要编辑权限', request_id: 'req-fn11-403' } }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture(account.id, { empty: true })) })
  })
  await useDesktopAgent(page)
  await dismissPrivacy(page)
  await page.getByTestId('today-ops-welcome-entry').click()
  const panel = page.getByTestId('today-ops-panel')
  for (const key of ['pending', 'publishing', 'today', 'comments', 'routines', 'risks']) {
    await expect(panel.getByTestId(`today-ops-block-${key}`)).toBeVisible()
  }
  await expect(panel).toContainText('今天没有待处理卡片')
  await expect(panel).toContainText('没有待发布的批次')
  await expect(panel).toContainText('今天还没有可信数据')
  await expect(panel).toContainText('没有待回复评论')
  await expect(panel).toContainText('今天没有到点的例行任务')
  await expect(panel).toContainText('没有失败或掉线任务')
  await panel.getByRole('button', { name: '关闭今日运营' }).click()

  mode = 'forbidden'
  await page.reload()
  await dismissPrivacy(page)
  await page.getByTestId('today-ops-welcome-entry').click()
  await expect(panel.getByText('今日运营需要编辑权限', { exact: true })).toBeVisible()
  await expect(panel).toContainText('观察者可以继续浏览原有页面')
  await expect(panel.getByTestId('today-ops-block-pending')).toHaveCount(0)
  expect(account.id).toBeTruthy()
})
