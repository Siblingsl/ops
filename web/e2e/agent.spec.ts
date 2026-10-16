import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// 本组只运行 ops-e2e 启动的本地 mock；拒绝生产形态或其他 baseURL。
test.beforeEach(async ({ baseURL }) => {
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  expect(baseURL).toBe('http://127.0.0.1:5179')
})

async function prepareModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: '智能体验收模拟模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested', 'mock-agent-untested'],
  })
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  return provider
}

async function dismissPrivacy(page: Page) {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/发送消息|观察者可以提问|请先配置支持工具调用的模型/).fill(text)
  const response = page.waitForResponse(r => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  return id
}

test('E2E-22 模型能力自检与对话新建、改名、置顶、搜索、删除', async ({ page }) => {
  await registerAccount(page)
  const provider = await prepareModel(page)
  await page.goto('/settings/models')
  const card = page.locator('.group').filter({ has: page.getByText(provider.name, { exact: true }) })
  await card.getByRole('button', { name: '自检', exact: true }).click()
  const selftest = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '供应商能力自检', exact: true }) })
  await expect(selftest).toBeVisible()
  const capabilities = (await api(page, 'GET', '/model-providers')).find((p: { id: string }) => p.id === provider.id).capabilities
  expect(capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'mock-agent-tested', tools_ok: true, vision_ok: true })]))
  await selftest.getByRole('button', { name: '关闭', exact: true }).click()
  const tested = card.locator('span.inline-flex').filter({ has: page.getByText('mock-agent-tested', { exact: true }) })
  await expect(tested.getByText('工具调用·通过', { exact: true })).toBeVisible()
  await expect(tested.getByText('看图·通过', { exact: true })).toBeVisible()
  await page.goto('/agent')
  await dismissPrivacy(page)
  await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  const models = settings.getByRole('combobox', { name: '选择模型' })
  await expect(models.locator('option', { hasText: 'mock-agent-tested' })).toHaveCount(1)
  await expect(models.locator('option', { hasText: 'mock-agent-untested' })).toHaveCount(0)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  const id = await send(page, '#text 新建对话验收已完成')
  await expect(page.getByRole('article').getByText('新建对话验收已完成', { exact: true })).toBeVisible()
  const list = page.locator('aside').filter({ has: page.getByRole('textbox', { name: '搜索对话' }) })
  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '重命名对话', exact: true }) })
  await rename.getByRole('textbox').fill('智能体对话验收标题')
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(list.getByText('智能体对话验收标题', { exact: true })).toBeVisible()
  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).conversation.pinned_at).not.toBeNull()
  await expect(list.locator('section').filter({ has: page.getByText('置顶', { exact: true }) }).getByText('智能体对话验收标题', { exact: true })).toBeVisible()
  await list.getByRole('textbox', { name: '搜索对话' }).fill('不存在的验收对话')
  await expect(list.getByText('没有匹配的对话', { exact: true })).toBeVisible()
  await list.getByRole('textbox', { name: '搜索对话' }).fill('智能体对话验收标题')
  await expect(list.getByText('智能体对话验收标题', { exact: true })).toBeVisible()
  await list.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  const remove = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除这段对话？', exact: true }) })
  await remove.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page).toHaveURL(/\/agent$/)
  await expect(list.getByText('智能体对话验收标题', { exact: true })).toHaveCount(0)
  expect((await page.request.get(`/api/v1/agent/conversations/${id}`)).status()).toBe(404)
})

test('E2E-27 观察者可以查询，强制请求写工具也不会产生卡片或写入', async ({ page, browser }) => {
  const account = await registerAccount(page)
  const provider = await prepareModel(page)
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 })
  const member = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await member.request.post(new URL('/api/v1/auth/register', page.url()).toString(), { data: { username: `agent-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code } })
    expect(registered.ok()).toBeTruthy()
    const viewer = await member.newPage()
    await viewer.goto('/agent')
    await dismissPrivacy(viewer)
    await expect(viewer.getByText('当前为观察者：智能体只能查询，不能修改。', { exact: true })).toBeVisible()
    const bootstrap = await api(viewer, 'GET', '/agent/bootstrap')
    expect(bootstrap).toMatchObject({ can_use: true, read_only: true, role: 'viewer' })
    await expect(viewer.locator('textarea')).toBeEnabled()
    const id = await send(viewer, '#tool global_search {"q":"浏览器验收号"}')
    const query = await api(viewer, 'GET', `/agent/conversations/${id}`)
    expect(query.messages.some((m: { tool_calls: { name: string; result_preview: string }[] }) => m.tool_calls.some(t => t.name === 'global_search' && !t.result_preview.includes('unknown_tool')))).toBeTruthy()
    expect(query.actions).toEqual([])
    const before = await api(page, 'GET', `/materials?account_id=${account.id}`)
    await send(viewer, `请添加素材\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create {"account_id":"${account.id}","kind":"opinion","content":"观察者不应写入"}`)
    const rejected = await api(viewer, 'GET', `/agent/conversations/${id}`)
    expect(rejected.actions).toEqual([])
    expect(rejected.messages.some((m: { tool_calls: { name: string; result_preview: string }[] }) => m.tool_calls.some(t => t.name === 'materials__create' && t.result_preview.includes('unknown_tool')))).toBeTruthy()
    expect(await api(page, 'GET', `/materials?account_id=${account.id}`)).toEqual(before)
    await expect(viewer.getByRole('button', { name: '执行', exact: true })).toHaveCount(0)
  } finally { await member.close() }
})

test('E2E-27 所有者关闭观察者使用后，观察者入口消失且直达被阻止', async ({ page, browser }) => {
  await registerAccount(page)
  const provider = await prepareModel(page)
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 })
  const member = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await member.request.post(new URL('/api/v1/auth/register', page.url()).toString(), { data: { username: `agent-disabled-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code } })
    expect(registered.ok()).toBeTruthy()
    const viewer = await member.newPage()
    await viewer.goto('/settings/agent')
    await expect(viewer.getByRole('switch', { name: '允许观察者使用', exact: true })).toBeDisabled()
    await expect(viewer.getByRole('link', { name: 'AI 对话', exact: true }).first()).toBeVisible()
    await page.goto('/settings/agent')
    const saved = page.waitForResponse(r => r.url().endsWith('/api/v1/agent/settings') && r.request().method() === 'PUT')
    await page.getByRole('switch', { name: '允许观察者使用', exact: true }).click()
    expect((await saved).ok()).toBeTruthy()
    await viewer.reload()
    await expect.poll(async () => (await api(viewer, 'GET', '/agent/bootstrap')).reason).toBe('viewer_disabled')
    await expect(viewer.getByRole('link', { name: 'AI 对话', exact: true })).toHaveCount(0)
    await viewer.goto('/agent')
    await expect(viewer.getByText('所有者已关闭观察者使用智能体', { exact: true })).toBeVisible()
    await expect(viewer.locator('textarea')).toHaveCount(0)
  } finally { await member.close() }
})

async function prepareSlowAgent(page: Page) {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '智能体慢速模拟模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-slow'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-slow' }])
  await page.goto('/agent')
  await dismissPrivacy(page)
  return account
}

test('E2E-29 运行中刷新后，通过轮询显示服务端完成的完整回复', async ({ page }) => {
  await prepareSlowAgent(page)
  const reply = '刷新恢复验收。' + '服务端持续生成，刷新不会取消运行。'.repeat(35) + '完整回复结束。'
  await page.getByPlaceholder(/发送消息|观察者可以提问|请先配置支持工具调用的模型/).fill('#text ' + reply)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => !!(await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeTruthy()
  let detailRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === `/api/v1/agent/conversations/${id}` && request.method() === 'GET') detailRequests++
  })
  await page.reload()
  await expect(page.getByRole('button', { name: '停止', exact: true }).first()).toBeVisible()
  await expect(page.locator('article').getByText(reply, { exact: true })).toBeVisible({ timeout: 25_000 })
  expect(detailRequests).toBeGreaterThanOrEqual(2)
  const completed = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(completed.active_run).toBeNull()
  expect(completed.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: reply })]))
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
})

test('E2E-29 点击停止中断当前运行，已经提出的操作卡片保留', async ({ page }) => {
  const account = await prepareSlowAgent(page)
  const content = '停止运行验收素材，未经卡片执行不得入库。'
  const id = await send(page, `请添加素材：${content}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: account.id, kind: 'opinion', content })}`)
  const before = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(before.actions).toHaveLength(1)
  expect(before.actions[0]).toMatchObject({ tool_name: 'materials__create', status: 'pending' })
  const reply = '停止验收长回复。'.repeat(120) + '不应生成到这里。'
  await expect(page.getByPlaceholder(/发送消息|观察者可以提问|请先配置支持工具调用的模型/)).toBeEnabled()
  await page.getByPlaceholder(/发送消息|观察者可以提问|请先配置支持工具调用的模型/).fill('#text ' + reply)
  const running = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/agent/conversations/${id}/messages` && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(async () => !!(await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeTruthy()
  const cancelled = page.waitForResponse(r => /\/agent\/runs\/[^/]+\/cancel$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '停止', exact: true }).first().click()
  expect((await cancelled).ok()).toBeTruthy()
  const response = await running
  await response.finished()
  expect(await response.text()).not.toContain('不应生成到这里。')
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  const stopped = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(stopped.actions).toEqual(before.actions)
  expect(stopped.messages.some((m: { role: string; content: string }) => m.role === 'assistant' && m.content === reply)).toBeFalsy()
  await expect(page.getByText('等待你逐张处理 1 项后，智能体会继续。卡片操作入口显示在对应消息下方。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
})

test('E2E-30 手机视口可开关对话抽屉，输入区避开底部导航并可执行单张卡片', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await prepareModel(page)
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/agent')
  await dismissPrivacy(page)
  await page.getByRole('button', { name: '打开对话列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '对话', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '搜索对话' }).last()).toBeVisible()
  await page.getByRole('button', { name: '关闭对话列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '对话', exact: true })).toHaveCount(0)
  const composer = page.getByPlaceholder(/发送消息/)
  const nav = page.getByRole('navigation', { name: '底部导航' })
  await expect(composer).toBeVisible()
  await expect(nav).toBeVisible()
  const inputBox = await composer.boundingBox()
  const sendBox = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
  const navBox = await nav.boundingBox()
  expect(inputBox).not.toBeNull()
  expect(sendBox).not.toBeNull()
  expect(navBox).not.toBeNull()
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(navBox!.y)
  expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(navBox!.y)
  const content = '手机逐张执行素材验收。'
  const id = await send(page, `请添加素材：${content}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: account.id, kind: 'opinion', content })}`)
  const proposed = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(proposed.actions).toHaveLength(1)
  await page.getByRole('button', { name: '执行', exact: true }).first().click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions[0].status).toBe('succeeded')
  expect(await api(page, 'GET', `/materials?account_id=${account.id}`)).toEqual(expect.arrayContaining([expect.objectContaining({ content })]))
})

test('E2E-30 手机视口不可撤销卡片必须二次确认，取消不写入，确认只执行该项', async ({ page }) => {
  await registerAccount(page)
  const provider = await prepareModel(page)
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  const word = `手机二次确认词条${Date.now()}`
  await api(page, 'POST', '/sensitive-words', { words: [word], category: 'sensitive' })
  const fixture = (await api(page, 'GET', '/sensitive-words')).find((item: { word: string }) => item.word === word)
  expect(fixture).toBeTruthy()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/agent')
  await dismissPrivacy(page)
  const id = await send(page, `请删除自建词条 ${word}（ID ${fixture.id}）\n#tool load_tool_domain {"domain":"settings"}\n#tool words__delete {"id":"${fixture.id}"}`)
  const proposed = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(proposed.actions).toHaveLength(1)
  expect(proposed.actions[0]).toMatchObject({ kind: 'X', status: 'pending', tool_name: 'words__delete' })
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '再次确认此操作', exact: true }) })
  await page.getByRole('button', { name: '执行', exact: true }).first().click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === fixture.id)).toBeTruthy()
  expect((await api(page, 'GET', `/agent/conversations/${id}`)).actions[0].status).toBe('pending')
  await page.getByRole('button', { name: '执行', exact: true }).first().click()
  await dialog.getByRole('button', { name: '确认执行这一项', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions[0].status).toBe('succeeded')
  expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === fixture.id)).toBeFalsy()
})
