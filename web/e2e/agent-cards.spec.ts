import { expect, test, type Page } from '@playwright/test'
import type { AgentAction } from '../src/lib/agent'

const previewFields: Record<string, string[]> = {
  wechat__push: ['title', 'summary', 'cover', 'images', 'today', 'draft'],
  checks__complete: ['passed', 'total'],
  works__approve_review: ['check_summary'],
}

function card(tool = 'works__update', patch: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'action-fixture', run_id: 'run-fixture', tool_name: tool, title: '逐张卡片回归',
    kind: tool === 'works__update' ? 'W' : 'H',
    gate: tool === 'wechat__push' ? 'H-05' : tool === 'checks__complete' ? 'H-04' : tool === 'works__approve_review' ? 'H-09' : '',
    second_confirm: tool === 'wechat__push' ? {} : null,
    status: 'pending', target: { type: 'work', id: 'work-fixture', name: '回归作品', link: '/works/work-fixture/push' },
    changes: (previewFields[tool] ?? []).map((field) => ({ field, label: field, before: field === 'summary' ? '' : '0', after: field === 'summary' ? '' : '0', editable: false, blank: false })),
    notices: [], ai_cost: false, need: null, result_summary: '', error: null, last_error: null,
    expires_at: '2099-01-01T00:00:00Z', batch_id: 'batch-fixture', created_at: '2026-10-15T00:00:00Z',
    editable_fields: [], blank_fields: [], ...patch,
  }
}

async function mount(page: Page, action: AgentAction) {
  // 保留 Vite 的 React 初始化与依赖版本，只把应用入口替换为隔离组件夹具。
  await page.route('**/src/main.tsx*', async (route) => {
    const source = await (await route.fetch()).text()
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1])
    const dependency = (name: string) => imports.find((path) => path.includes(`/${name}.js`))!
    await route.fulfill({ contentType: 'application/javascript', body: `
      import '/src/styles.css';
      import React from '${dependency('react')}';
      import ReactDOM from '${dependency('react-dom_client')}';
      import { QueryClient, QueryClientProvider } from '${dependency('@tanstack_react-query')}';
      import { BrowserRouter } from '${dependency('react-router-dom')}';
      import { AgentActionCards } from '/src/pages/agent/ActionCards.tsx';
      window.__continued = 0;
      window.__refreshed = 0;
      function Fixture() {
        const [actions, setActions] = React.useState(${JSON.stringify([action])});
        window.__setActions = setActions;
        return React.createElement(AgentActionCards, { actions, running: false,
          onRefresh: async () => { window.__refreshed++ },
          onContinue: async () => { window.__continued++ }
        });
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,
        { client: new QueryClient() }, React.createElement(BrowserRouter, null, React.createElement(Fixture))));
    ` })
  })
  await page.goto('/__agent-cards')
  await expect(page.getByRole('heading', { name: action.title, exact: true })).toBeVisible()
}

async function count(page: Page, key: '__continued' | '__refreshed') {
  return page.evaluate((name) => (window as unknown as Record<string, number>)[name], key)
}

for (const tool of Object.keys(previewFields)) {
  test(`${tool} 完整预览保留空摘要与零计数，确认门槛后可执行`, async ({ page }) => {
    await mount(page, card(tool))
    await page.getByRole('checkbox').check()
    await expect(page.getByRole('button', { name: tool === 'wechat__push' ? '写入草稿箱' : '执行', exact: true })).toBeEnabled()
  })

  test(`${tool} 缺少任一必需预览字段时禁止执行`, async ({ page }) => {
    const action = card(tool)
    action.changes.pop()
    await mount(page, action)
    await page.getByRole('checkbox').check()
    await expect(page.getByRole('button', { name: tool === 'wechat__push' ? '写入草稿箱' : '执行', exact: true })).toBeDisabled()
    await expect(page.getByText(/卡片尚未返回/)).toBeVisible()
  })
}

test('今日头条微头条动作卡在窄屏显示目标形态和来源提示，逐条确认', async ({ page }, testInfo) => {
  const action = card('toutiao__create_pack', {
    title: '为今日头条准备微头条发布包',
    changes: [{ field: 'content_format', label: '作品形态', before: '', after: '微头条', editable: false, blank: false }],
    notices: ['external_source'],
  })
  await page.setViewportSize({ width: 740, height: 640 })
  await mount(page, action)
  await expect(page.getByText(/修改后\s*微头条/)).toBeVisible()
  await expect(page.getByText('本次参考了外部资料，请核对内容', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '执行', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: testInfo.outputPath('toutiao-agent-card-source-740x640.png'), fullPage: true })
})

for (const canContinue of [true, false]) {
  test(`拒绝响应 can_continue=${canContinue} 决定是否自动续跑`, async ({ page }) => {
    await page.route('**/api/v1/agent/actions/action-fixture/reject', (route) => route.fulfill({ json: { ok: true, batch_resolved: canContinue, can_continue: canContinue } }))
    await mount(page, card())
    await page.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => count(page, '__refreshed')).toBe(1)
    await expect.poll(() => count(page, '__continued')).toBe(canContinue ? 1 : 0)
  })
}

test('拒绝结束时路由已变化，只显示继续按钮并等待人工点击', async ({ page }) => {
  let release!: () => void
  const responseReady = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/agent/actions/action-fixture/reject', async (route) => {
    await responseReady
    await route.fulfill({ json: { ok: true, batch_resolved: true, can_continue: true } })
  })
  await mount(page, card())
  const request = page.waitForRequest('**/api/v1/agent/actions/action-fixture/reject')
  await page.getByRole('button', { name: '拒绝', exact: true }).click()
  await request
  await page.evaluate(() => history.pushState(null, '', '/another-conversation'))
  release()
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible()
  expect(await count(page, '__continued')).toBe(0)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect.poll(() => count(page, '__continued')).toBe(1)
})

test('草稿选择转超限再转草稿缺失时，每种选择必须重新确认且载荷匹配当前类型', async ({ page }) => {
  const initial = card('wechat__push', { status: 'needs_input', need: { kind: 'draft_modified' } })
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/v1/works/work-fixture', (route) => route.fulfill({ json: { platform: 'wechat_mp', content_format: 'comic', revision: 9 } }))
  await page.route('**/api/v1/agent/actions/action-fixture/execute', async (route) => {
    bodies.push(route.request().postDataJSON())
    const next = bodies.length === 1 ? { ...initial, need: { kind: 'over_limit' } }
      : bodies.length === 2 ? { ...initial, need: { kind: 'draft_missing' } }
        : { ...initial, status: 'succeeded', need: null }
    await route.fulfill({ contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify({ action: next, can_continue: false })}\n\n` })
  })
  await mount(page, initial)
  const execute = page.getByRole('button', { name: '写入草稿箱', exact: true })
  await page.getByRole('checkbox', { name: /我已核对/ }).check()
  await expect(execute).toBeDisabled()
  await page.getByRole('radio', { name: '另存为新草稿（计入当日次数）', exact: true }).check()
  await execute.click()
  await page.getByRole('button', { name: '确认执行这一项', exact: true }).click()
  const overLimit = page.getByRole('checkbox', { name: '我了解超限风险，仍需写入', exact: true })
  await expect(overLimit).toBeVisible()
  await expect(overLimit).not.toBeChecked()
  await expect(execute).toBeDisabled()
  await overLimit.check()
  await expect(execute).toBeEnabled()
  await overLimit.uncheck()
  await expect(execute).toBeDisabled()
  await overLimit.check()
  await execute.click()
  await page.getByRole('button', { name: '确认执行这一项', exact: true }).click()
  const newDraft = page.getByRole('radio', { name: '新建草稿（计入当日次数）', exact: true })
  await expect(newDraft).toBeVisible()
  await expect(newDraft).not.toBeChecked()
  await expect(execute).toBeDisabled()
  await newDraft.check()
  await execute.click()
  await page.getByRole('button', { name: '确认执行这一项', exact: true }).click()
  await expect.poll(() => bodies.length).toBe(3)
  expect(bodies.map((body) => body.choice)).toEqual([{ overwrite_choice: 'new' }, { confirm_over_limit: true }, { overwrite_choice: 'new' }])
  expect(bodies.every((body) => JSON.stringify(body.client_payload) === JSON.stringify({ revision: 9 }))).toBeTruthy()
})
