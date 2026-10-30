import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('关闭workbench_ui时Electron保留原型布局与会话聊天操作', async ({ page }) => {
  // 本用例验证D-119旧布局回退；D-152新布局由agent-workbench.spec.ts验收。
  await page.route('**/agent/bootstrap', async (route) => {
    const response = await route.fetch()
    const bootstrap = await response.json()
    bootstrap.features.workbench_ui = false
    await route.fulfill({ response, json: bootstrap })
  })
  const account = await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面智能体复核模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL!, api_key: 'local-e2e-key', models: ['mock-agent-tested'],
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
  await expect(page.getByTestId('desktop-agent-list')).toBeVisible()
  await expect(page.getByRole('link', { name: 'AI 对话', exact: true })).toHaveAttribute('aria-current', 'page')

  const list = page.getByTestId('desktop-agent-list')
  await list.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page).toHaveURL(/\/agent$/)
  await expect(page.getByRole('button', { name: '选择操作账号', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '选择模型', exact: true }).click()
  await expect(page.getByRole('menu', { name: '选择模型' })).toBeVisible()
  await page.keyboard.press('Escape')

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({ name: 'agent-layout-check.txt', mimeType: 'text/plain', buffer: Buffer.from('智能体附件点测') })
  await expect(page.getByText('agent-layout-check.txt', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '移除 agent-layout-check.txt', exact: true }).click()
  await expect(page.getByText('agent-layout-check.txt', { exact: true })).toHaveCount(0)

  const message = '桌面智能体点击复核消息素材。'
  const content = `请添加素材：${message}`
  await page.getByPlaceholder(/说说你想写什么/).fill(`${content}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: account.id, kind: 'opinion', content: message })}`)
  const create = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await create).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  const proposed = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(proposed.actions).toHaveLength(1)
  expect(proposed.actions[0]).toMatchObject({ tool_name: 'materials__create', status: 'pending' })
  const card = page.locator('.desktop-agent-action-card').first()
  await expect(card).toBeAttached()
  await expect(card.getByRole('button', { name: /执行|入库|保存/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '全部执行', exact: true })).toHaveCount(0)
  const toolSummary = page.getByRole('button', { name: '工具活动 2 项', exact: true })
  await toolSummary.click()
  await expect(toolSummary).toHaveAttribute('aria-expanded', 'true')
  const toolDetails = page.locator(`[id="${await toolSummary.getAttribute('aria-controls')}"]`)
  await expect(toolDetails).toHaveAttribute('aria-hidden', 'false')
  await toolSummary.click()
  await expect(toolSummary).toHaveAttribute('aria-expanded', 'false')
  await api(page, 'PATCH', `/agent/conversations/${id}`, { title: '本周选题与写作安排' })
  await page.reload()
  await expect(page.getByRole('textbox', { name: '对话标题' })).toHaveValue('本周选题与写作安排')

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.assistant-invite [data-nav="agent"]').click()
  await expect(prototype.locator('.creative-agent-layout')).toBeVisible()
  await prototype.waitForTimeout(250)
  const productTargets = [
    page.locator('.desktop-agent-list'), page.locator('.desktop-agent-workspace'), page.locator('.desktop-agent-list input'),
    page.locator('.desktop-agent-workspace > section'), page.locator('.desktop-agent-workspace > section > div.relative.flex > div.scrollbar-thin'),
    page.locator('.desktop-agent-message-column'), page.locator('.desktop-agent-compose'), page.locator('.desktop-agent-compose textarea'),
    page.locator('.desktop-agent-chat-heading input'), page.locator('.desktop-agent-private-tag'),
  ]
  const expectedTargets = [
    prototype.locator('.agent-conversations'), prototype.locator('.creative-agent-layout'), prototype.locator('.agent-conversations input'),
    prototype.locator('.agent-shell'), prototype.locator('.chat-stream'), prototype.locator('.chat-inner'),
    prototype.locator('.compose-box'), prototype.locator('.compose-box textarea'),
    prototype.locator('.chat-header .meta strong'), prototype.locator('.chat-header .meta .tag'),
  ]
  const selectors = ['会话列表', '智能体页面框架', '会话搜索框', '聊天区', '消息滚动区', '消息内容列', '消息输入框容器', '消息输入框', '对话标题', '私密标记']
  const attachmentLimitNote = page.getByText('PDF / DOCX / CSV ≤20MB；文档≤100页，CSV≤10000行×100列。DOCX分页不可验证时请转PDF。', { exact: true })
  await expect(attachmentLimitNote).toBeVisible()
  const attachmentLimitNoteHeight = await attachmentLimitNote.evaluate((element) => element.getBoundingClientRect().height + parseFloat(getComputedStyle(element).marginBottom))
  const metrics = await Promise.all(selectors.map(async (selector, index) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    return { selector, actual: await productTargets[index].evaluate(rect), expected: await expectedTargets[index].evaluate(rect) }
  }))
  console.log('Agent layout comparison', JSON.stringify(metrics))
  // 桌面壳改为 64px 图标侧栏并移除 60px 业务顶栏；静态原型仍保留旧外壳。
  // 下方仅补偿外壳造成的几何变化，继续比较会话列表、聊天区与输入框自身布局。
  const shellAdjustments: Record<number, { x: number; y: number; width: number; height: number }> = {
    0: { x: -24, y: -60, width: 0, height: 47 },
    1: { x: -24, y: -60, width: 24, height: 48 },
    2: { x: -24, y: -60, width: 0, height: 0 },
    3: { x: -24, y: -60, width: 24, height: 47 },
    4: { x: -24, y: -60, width: 24, height: 47.5 },
    6: { x: -12, y: -12.5, width: 0, height: 0 },
    7: { x: -12, y: -12.5, width: 0, height: 0 },
    8: { x: -24, y: -60, width: 0, height: 0 },
    9: { x: -24, y: -60, width: 0, height: 0 },
  }
  for (const index of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
    const { selector, actual, expected } = metrics[index]
    const adjustment = shellAdjustments[index]
    const tolerance = index === 4 ? 3 : 2
    // AW11 的附件限制提示占用消息区高度；静态原型不包含该新增提示。
    const expectedHeight = (index === 4 ? expected.height - attachmentLimitNoteHeight : expected.height) + adjustment.height
    expect(Math.abs(actual.x - (expected.x + adjustment.x)), `${selector} 水平位置`).toBeLessThanOrEqual(tolerance)
    expect(Math.abs(actual.y - (expected.y + adjustment.y)), `${selector} 垂直位置`).toBeLessThanOrEqual(tolerance)
    expect(Math.abs(actual.width - (expected.width + adjustment.width)), `${selector} 宽度`).toBeLessThanOrEqual(tolerance)
    expect(Math.abs(actual.height - expectedHeight), `${selector} 高度`).toBeLessThanOrEqual(tolerance)
  }
  await page.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/agent-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/agent-layout-prototype.png') })

  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/agent-action-card-after.png') })
  const rejected = page.waitForResponse((response) => response.url().endsWith(`/agent/actions/${proposed.actions[0].id}/reject`) && response.request().method() === 'POST')
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  expect((await rejected).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions[0].status).toBe('rejected')

  await list.getByRole('textbox', { name: '搜索对话' }).fill('本周选题')
  await expect(list.getByText('本周选题与写作安排', { exact: true })).toBeVisible()
  await list.getByRole('textbox', { name: '搜索对话' }).fill('不存在的标题')
  await expect(list.getByText('没有匹配的对话', { exact: true })).toBeVisible()
  await list.getByRole('textbox', { name: '搜索对话' }).fill('')

  const titleInput = page.getByRole('textbox', { name: '对话标题' })
  await titleInput.fill('智能体顶栏改名')
  const titlePatch = page.waitForResponse((response) => response.url().endsWith(`/agent/conversations/${id}`) && response.request().method() === 'PATCH')
  await titleInput.press('Tab')
  expect((await titlePatch).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).conversation.title).toBe('智能体顶栏改名')

  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '重命名对话', exact: true }) })
  await rename.getByRole('textbox').fill('智能体桌面复核')
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(list.getByText('智能体桌面复核', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '对话标题' })).toHaveValue('智能体桌面复核')
  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
  await expect(list.getByText('置顶', { exact: true })).toBeVisible()
  await expect(list.getByText('智能体桌面复核', { exact: true })).toBeVisible()
  await list.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page).toHaveURL(/\/agent$/)
  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
  await expect(list.getByText('置顶', { exact: true })).toHaveCount(0)
  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  const remove = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除这段对话？', exact: true }) })
  await remove.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page).toHaveURL(/\/agent$/)
  await expect(list.getByText('智能体桌面复核', { exact: true })).toHaveCount(0)
  expect((await page.request.get(`/api/v1/agent/conversations/${id}`)).status()).toBe(404)
  await page.getByRole('button', { name: /^用户菜单/ }).click()
  await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
  await expect(page.getByTestId('desktop-settings-window')).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/preferences$/)
})
