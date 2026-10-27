import { expect, test, type Page } from '@playwright/test'
import type { AgentAction, AgentAttachment, AgentConversationDetail } from '../src/lib/agent'
import { api, finishChecks, registerAccount } from './support'

test.beforeEach(async ({ baseURL }) => {
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  expect(baseURL).toBe('http://127.0.0.1:5179')
})

const instruction = (name: string, args: Record<string, unknown>) => `#tool ${name} ${JSON.stringify(args)}`

async function prepareAccount(page: Page) {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const provider = await api(page, 'POST', '/model-providers', {
    name: '推送与附件验收模拟模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-publish'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-publish' },
    { task_type: 'default', provider_id: provider.id, model: 'mock-agent-publish' },
  ])
  return account
}

async function openAgent(page: Page) {
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
}

async function send(page: Page, content: string) {
  await page.getByPlaceholder(/发送消息/).fill(content)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  const response = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  return id
}

function cardFor(page: Page, action: AgentAction) {
  return page.getByRole('heading', { name: action.title, exact: true }).locator('..').locator('..').last()
}

async function png(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 900; canvas.height = 500
    const context = canvas.getContext('2d')!
    context.fillStyle = '#efd5ab'; context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(data, 'base64')
}

async function readyDraft(page: Page, accountId: string) {
  await api(page, 'PATCH', `/accounts/${accountId}`, { daily_push_limit: 20 })
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${accountId}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-e2e-wechat-secret' })
  await api(page, 'POST', `/accounts/${accountId}/wechat-credential/test`, {})
  let work = await api(page, 'POST', `/accounts/${accountId}/works`, { title: '智能体推送选择验收' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '先明确要解决的问题，再完成一个小步骤，这是我的个人经验。' })
  const outline = await api(page, 'POST', `/works/${work.id}/outline/generate`, {})
  work = await api(page, 'PUT', `/works/${work.id}/outline`, { items: outline.items, confirm: true })
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先明确要解决的问题，再把任务拆成能够完成的一小步。记录自己的过程，比追求复杂的方法更容易持续。这是我在日常实践中的个人经验，适合根据自己的情况调整。', base_revision: section.revision })
  }
  const me = await api(page, 'GET', '/auth/me')
  const uploaded = await page.request.post(`/api/v1/works/${work.id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token }, multipart: { file: { name: 'local-agent-cover.png', mimeType: 'image/png', buffer: await png(page) } },
  })
  expect(uploaded.ok()).toBeTruthy()
  const image = await uploaded.json()
  const fresh = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, { summary: '本地模拟推送人工选择验收。', base_revision: fresh.revision, cover_asset_id: image.id,
    cover_crops: { '2.35_1': { x1: 0, y1: 0.2, x2: 1, y2: 0.6 }, '1_1': { x1: 0.2, y1: 0, x2: 0.75, y2: 1 } } })
  await finishChecks(page, work.id)
  await page.goto(`/works/${work.id}/push`)
  await page.getByRole('button', { name: '写入草稿箱', exact: true }).click()
  await expect(page.getByText('已写入公众号草稿箱', { exact: true })).toBeVisible()
  return api(page, 'GET', `/works/${work.id}`)
}

async function executePush(page: Page, action: AgentAction) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/agent/actions/${action.id}/execute` && r.request().method() === 'POST')
  await cardFor(page, action).getByRole('button', { name: '写入草稿箱', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认执行这一项', exact: true }).click()
  const result = await response
  expect(result.ok()).toBeTruthy()
  await result.finished()
  return result.request().postDataJSON()
}

test('E2E-26 后台修改草稿后分别覆盖与另存，超限必须再次确认', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await prepareAccount(page)
  let work = await readyDraft(page, account.id)
  await openAgent(page)
  const propose = async () => {
    const id = await send(page, ['请逐篇写入这一篇公众号草稿，遇到后台修改或次数上限必须等我选择。', instruction('load_tool_domain', { domain: 'publish' }), instruction('wechat__push', { id: work.id })].join('\n'))
    const detail = await api(page, 'GET', `/agent/conversations/${id}`) as AgentConversationDetail
    const actions = detail.actions.filter((action) => action.tool_name === 'wechat__push')
    const action = actions[actions.length - 1]
    expect(action.status).toBe('pending')
    await cardFor(page, action).getByRole('checkbox', { name: /我已核对/ }).check()
    return { id, action }
  }
  for (const choice of ['overwrite', 'new'] as const) {
    const oldMediaId = work.wechat_draft_media_id
    const touched = await page.request.post(`http://127.0.0.1:8191/mock/drafts/${oldMediaId}/touch`)
    expect(touched.ok()).toBeTruthy()
    const { id, action } = await propose()
    const first = await executePush(page, action)
    expect(first.choice).toBeUndefined()
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions.find((a: AgentAction) => a.id === action.id)).toMatchObject({ status: 'needs_input', need: { kind: 'draft_modified' } })
    const card = cardFor(page, action)
    const option = card.getByRole('radio', { name: choice === 'overwrite' ? '仍然覆盖' : '另存为新草稿（计入当日次数）', exact: true })
    await expect(option).not.toBeChecked()
    await expect(card.getByRole('button', { name: '写入草稿箱', exact: true })).toBeDisabled()
    await option.check()
    expect((await executePush(page, action)).choice).toEqual({ overwrite_choice: choice })
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions.find((a: AgentAction) => a.id === action.id)?.status).toBe('succeeded')
    work = await api(page, 'GET', `/works/${work.id}`)
    if (choice === 'overwrite') expect(work.wechat_draft_media_id).toBe(oldMediaId)
    else expect(work.wechat_draft_media_id).not.toBe(oldMediaId)
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  }
  await api(page, 'PATCH', `/accounts/${account.id}`, { daily_push_limit: 1 })
  const { id, action } = await propose()
  await executePush(page, action)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions.find((a: AgentAction) => a.id === action.id)).toMatchObject({ status: 'needs_input', need: { kind: 'over_limit' } })
  const card = cardFor(page, action)
  const acknowledgment = card.getByRole('checkbox', { name: '我了解超限风险，仍需写入', exact: true })
  await expect(acknowledgment).not.toBeChecked()
  await expect(card.getByRole('button', { name: '写入草稿箱', exact: true })).toBeDisabled()
  await acknowledgment.check()
  const executed = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/agent/actions/${action.id}/execute` && r.request().method() === 'POST')
  await card.getByRole('button', { name: '写入草稿箱', exact: true }).click()
  const confirmation = page.getByRole('dialog')
  await expect(confirmation.getByRole('heading', { name: '超出今日次数，仍要写入？', exact: true })).toBeVisible()
  await confirmation.getByRole('button', { name: '确认执行这一项', exact: true }).click()
  expect((await executed).request().postDataJSON().choice).toEqual({ confirm_over_limit: true })
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions.find((a: AgentAction) => a.id === action.id)?.status).toBe('succeeded')
  expect((await api(page, 'GET', `/works/${work.id}`)).published_at).toBeNull()
})

test('E2E-28 上传图片与md，经各自卡片保存作品图片和素材，并显示非视觉提示', async ({ page }) => {
  const account = await prepareAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '附件保存验收作品' })
  // UI 分支使用非视觉能力响应；上传、分发、图片与素材写入均使用真实本地服务。
  await page.route('**/api/v1/agent/bootstrap', async (route) => {
    const response = await route.fetch()
    const bootstrap = await response.json()
    await route.fulfill({ response, json: { ...bootstrap, models: bootstrap.models.map((model: { vision: boolean }) => ({ ...model, vision: false })) } })
  })
  await openAgent(page)
  const markdown = '# 实践记录\n\n每次先完成一个小步骤，再记录自己的体会。\n这是上传文件中的原始内容。'
  const upload = async (name: string, mimeType: string, buffer: Buffer) => {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/v1/agent/attachments') && r.request().method() === 'POST')
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer })
    const result = await response
    expect(result.ok()).toBeTruthy()
    const attachment = await result.json() as AgentAttachment
    await expect(page.getByText(name, { exact: true })).toBeVisible()
    return attachment
  }
  const image = await upload('agent-local-image.png', 'image/png', await png(page))
  const text = await upload('agent-notes.md', 'text/markdown', Buffer.from(markdown, 'utf8'))
  expect(image).toMatchObject({ kind: 'image', width: 900, height: 500 })
  expect(text.kind).toBe('text')
  const id = await send(page, ['把我上传的图片保存到指定作品，把md全文保存为一条经验素材。都先给卡片，等我逐张执行。',
    instruction('load_tool_domain', { domain: 'visual' }), instruction('assets__upload', { id: work.id, attachment_id: image.id }),
    instruction('load_tool_domain', { domain: 'materials' }), instruction('materials__create', { account_id: account.id, kind: 'experience', content: markdown }),
  ].join('\n'))
  const detail = await api(page, 'GET', `/agent/conversations/${id}`) as AgentConversationDetail
  const user = detail.messages.find((message) => message.role === 'user')!
  expect(user.attachments.map((attachment) => attachment.id).sort()).toEqual([image.id, text.id].sort())
  const bubble = page.locator('article').filter({ has: page.getByText('agent-notes.md', { exact: true }) })
  await expect(bubble.getByText('当前模型不能看图，图片只能用于保存或数据截图识别。', { exact: true })).toBeVisible()
  const thumbnail = bubble.getByRole('img', { name: 'agent-local-image.png', exact: true })
  const thumbnailURL = new URL(await thumbnail.getAttribute('src') ?? '', page.url())
  const attachmentURL = new URL(image.url, page.url())
  expect(thumbnailURL.origin).toBe(new URL(page.url()).origin)
  expect(thumbnailURL.pathname).toBe(attachmentURL.pathname)
  expect(thumbnailURL.searchParams.get('variant')).toBe('thumb')
  expect(thumbnailURL.searchParams.get('conversation_id')).toBe(id)
  await expect.poll(() => thumbnail.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBeTruthy()
  expect((await api(page, 'GET', `/works/${work.id}`)).assets).toHaveLength(0)
  expect((await api(page, 'GET', `/materials?account_id=${account.id}`)).some((material: { content: string }) => material.content === markdown)).toBeFalsy()
  expect(detail.actions).toHaveLength(2)
  for (const tool of ['assets__upload', 'materials__create']) {
    const action = detail.actions.find((item) => item.tool_name === tool)!
    expect(action.status).toBe('pending')
    await cardFor(page, action).getByRole('button', { name: '执行', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).actions.find((a: AgentAction) => a.id === action.id)?.status).toBe('succeeded')
    if (tool === 'assets__upload') expect((await api(page, 'GET', `/materials?account_id=${account.id}`)).some((material: { content: string }) => material.content === markdown)).toBeFalsy()
  }
  const saved = await api(page, 'GET', `/works/${work.id}`)
  expect(saved.assets).toEqual([expect.objectContaining({ work_id: work.id, width: 900, height: 500 })])
  expect(await api(page, 'GET', `/materials?account_id=${account.id}`)).toEqual(expect.arrayContaining([expect.objectContaining({ content: markdown, kind: 'experience' })]))
})
