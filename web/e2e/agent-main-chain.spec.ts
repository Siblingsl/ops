import { expect, test, type Page } from '@playwright/test'
import type { AgentAction, AgentConversationDetail } from '../src/lib/agent'
import { api, registerAccount } from './support'

test.beforeEach(async ({ baseURL }) => {
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  expect(baseURL).toBe('http://127.0.0.1:5179')
})

const tool = (name: string, args: Record<string, unknown>) => `#tool ${name} ${JSON.stringify(args)}`

async function prepareAgent(page: Page) {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-e2e-secret' })
  await api(page, 'POST', `/accounts/${account.id}/wechat-credential/test`)

  const provider = await api(page, 'POST', '/model-providers', {
    name: '公众号主链路验收模拟模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-main-chain'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    ...['agent_chat', 'default', 'outline', 'section_draft', 'fact_flag'].map((task_type) => ({ task_type, provider_id: provider.id, model: 'mock-agent-main-chain' })),
  ])

  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '公众号智能体主链路验收' })
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 900; canvas.height = 500
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f4e3c1'; ctx.fillRect(0, 0, 900, 500)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${work.id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'local-agent-cover.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  const cover = await upload.json()
  const current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, {
    summary: '从真实经验出发，把观点拆成可执行的小步骤。', base_revision: current.revision,
    cover_asset_id: cover.id,
    cover_crops: { '2.35_1': { x1: 0, y1: 0.2, x2: 1, y2: 0.6 }, '1_1': { x1: 0.2, y1: 0, x2: 0.75, y2: 1 } },
  })

  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  await page.getByRole('button', { name: '对话设置' }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  const accountSelect = settings.getByRole('combobox', { name: '选择账号' })
  await expect(accountSelect).toBeEnabled()
  await accountSelect.selectOption(account.id)
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  return { account, work }
}

async function send(page: Page, text: string, conversationId?: string) {
  await page.getByPlaceholder(/发送消息/).fill(text)
  const sendButton = page.getByRole('button', { name: '发送', exact: true })
  await expect(sendButton).toBeEnabled()
  const path = conversationId
    ? `/api/v1/agent/conversations/${conversationId}/messages`
    : /\/api\/v1\/agent\/conversations\/[^/]+\/messages$/
  const response = page.waitForResponse((r) => {
    const url = new URL(r.url())
    const matches = typeof path === 'string' ? url.pathname === path : path.test(url.pathname)
    return matches && r.request().method() === 'POST'
  })
  await sendButton.click()
  expect((await response).ok()).toBeTruthy()
  if (!conversationId) await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = conversationId ?? page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run, { timeout: 30_000 }).toBeNull()
  return id
}

function actionCard(page: Page, action: AgentAction) {
  return page.getByRole('heading', { name: action.title, exact: true }).locator('..').locator('..')
}

async function actionForRun(page: Page, conversationId: string, toolName: string) {
  const detail = await api(page, 'GET', `/agent/conversations/${conversationId}`) as AgentConversationDetail
  const lastAssistant = [...detail.messages].reverse().find((message) => message.role === 'assistant')
  expect(lastAssistant?.run_id).toBeTruthy()
  const action = detail.actions.find((item) => item.run_id === lastAssistant!.run_id && item.tool_name === toolName)
  expect(action, `本轮应提出 ${toolName} 卡片`).toBeTruthy()
  return { detail, action: action! }
}

async function executeCard(page: Page, conversationId: string, action: AgentAction, buttonName = '执行') {
  const card = actionCard(page, action)
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: buttonName, exact: true }).click()
  await expect.poll(async () => {
    const detail = await api(page, 'GET', `/agent/conversations/${conversationId}`) as AgentConversationDetail
    return detail.actions.find((item) => item.id === action.id)?.status
  }, { timeout: 30_000 }).toBe('succeeded')
  return card
}

test('E2E-24 公众号主链路经智能体逐张确认到回填已发布', async ({ page }) => {
  // 四个连续 agent 回合（观点 → 生成大纲 → 保存大纲 → 确认大纲），默认 90s 不够稳定。
  test.setTimeout(240_000)
  const { work } = await prepareAgent(page)
  const viewpoint = '先把目标拆成今天能完成的一小步，再用持续记录代替一味追求复杂方法。'

  const conversationId = await send(page, [
    `这是我的核心观点原话：${viewpoint}`,
    '请按原文保存为这篇作品的核心观点，不能改写。',
    tool('load_tool_domain', { domain: 'works' }),
    tool('works__set_viewpoint', { id: work.id, viewpoint }),
  ].join('\n'))
  const viewpointResult = await actionForRun(page, conversationId, 'works__set_viewpoint')
  expect(viewpointResult.action).toMatchObject({ status: 'pending', gate: 'H-02', target: { id: work.id } })
  const viewpointCard = actionCard(page, viewpointResult.action)
  await expect(viewpointCard.getByText(viewpoint, { exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/works/${work.id}`)).viewpoint).toBe('')
  await viewpointCard.getByRole('checkbox').check()
  await executeCard(page, conversationId, viewpointResult.action, '保存我的观点')
  expect((await api(page, 'GET', `/works/${work.id}`)).viewpoint).toBe(viewpoint)

  const generateId = await send(page, [
    '围绕已保存的观点生成大纲。',
    tool('load_tool_domain', { domain: 'writing' }),
    tool('outline__generate', { id: work.id }),
  ].join('\n'), conversationId)
  const generatedDetail = await api(page, 'GET', `/agent/conversations/${generateId}`) as AgentConversationDetail
  const generatedCall = generatedDetail.messages.flatMap((message) => message.tool_calls).find((call) => call.name === 'outline__generate')
  expect(generatedCall).toBeTruthy()
  const generated = JSON.parse(generatedCall!.result_preview) as { items: { heading: string; key_point: string; material_ids: string[] }[] }
  expect(generated.items.length).toBeGreaterThanOrEqual(2)

  const saveId = await send(page, [
    '请保存刚才生成的大纲，保存前仍由我逐张确认。',
    tool('load_tool_domain', { domain: 'writing' }),
    tool('outline__save', { id: work.id, items: generated.items }),
  ].join('\n'), conversationId)
  const saveResult = await actionForRun(page, saveId, 'outline__save')
  expect(saveResult.action.status).toBe('pending')
  await executeCard(page, conversationId, saveResult.action)
  expect((await api(page, 'GET', `/works/${work.id}`)).outline).toHaveLength(generated.items.length)

  const confirmId = await send(page, [
    '请展示当前大纲并提出确认卡片。',
    tool('load_tool_domain', { domain: 'writing' }),
    tool('outline__confirm', { id: work.id }),
  ].join('\n'), conversationId)
  const confirmResult = await actionForRun(page, confirmId, 'outline__confirm')
  expect(confirmResult.action).toMatchObject({ status: 'pending', gate: 'H-03' })
  const confirmCard = actionCard(page, confirmResult.action)
  await expect(confirmCard.getByText(generated.items[0].heading, { exact: false }).first()).toBeVisible()
  const confirmGate = confirmCard.getByRole('checkbox', { name: '我已阅读并确认大纲', exact: true })
  await expect(confirmGate).not.toBeChecked()
  await confirmGate.check()
  await executeCard(page, conversationId, confirmResult.action)
  const confirmedWork = await api(page, 'GET', `/works/${work.id}`)
  expect(confirmedWork.outline_confirmed_at).toBeTruthy()
  expect(confirmedWork.sections).toHaveLength(generated.items.length)

  // 每个段落各提出并执行一张卡；刻意选中“为什么”段落，让本地 mock 产生事实核查项。
  const sections = confirmedWork.sections as { id: string; heading: string }[]
  const factSection = sections.find((section) => section.heading.includes('为什么'))
  expect(factSection).toBeTruthy()
  for (const section of sections) {
    const draftId = await send(page, [
      `请只起草这一段：${section.heading}`,
      tool('load_tool_domain', { domain: 'writing' }),
      tool('sections__draft', { id: section.id }),
    ].join('\n'), conversationId)
    const draftResult = await actionForRun(page, draftId, 'sections__draft')
    expect(draftResult.action.status).toBe('pending')
    await executeCard(page, conversationId, draftResult.action)
    await expect.poll(async () => {
      const latest = await api(page, 'GET', `/works/${work.id}`)
      return latest.sections.find((item: { id: string }) => item.id === section.id)?.content_md?.trim().length ?? 0
    }, { timeout: 30_000 }).toBeGreaterThan(0)
  }

  const draftedWork = await api(page, 'GET', `/works/${work.id}`)
  const flaggedSection = draftedWork.sections.find((section: { content_md: string }) => section.content_md.includes('【待核实：'))
  expect(flaggedSection).toBeTruthy()
  const correctedContent = flaggedSection.content_md.replace(
    '有调查显示，【待核实：相关比例数据及来源】的人都遇到过类似的问题。',
    '我在自己的记录中发现，先把目标拆成今天能完成的一小步，更容易持续执行。',
  )
  const editId = await send(page, [
    `我核对后把这一段改为以下个人体验：\n${correctedContent}`,
    tool('load_tool_domain', { domain: 'writing' }),
    tool('sections__update', { id: flaggedSection.id, content_md: correctedContent, base_revision: flaggedSection.revision }),
  ].join('\n'), conversationId)
  const editResult = await actionForRun(page, editId, 'sections__update')
  await executeCard(page, conversationId, editResult.action)
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}`)
    return latest.sections.find((item: { id: string }) => item.id === flaggedSection.id)?.content_md
  }).toContain('我在自己的记录中发现')

  const checkStartId = await send(page, [
    '发起这篇公众号作品的发布前检查。',
    tool('load_tool_domain', { domain: 'publish' }),
    tool('checks__start', { id: work.id }),
  ].join('\n'), conversationId)
  const checkStart = await actionForRun(page, checkStartId, 'checks__start')
  expect(checkStart.action.status).toBe('pending')
  await executeCard(page, conversationId, checkStart.action)
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`)
    return !!latest.run && latest.run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  const checkData = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  const unresolved = checkData.run.items.filter((item: { category: string; resolution?: string }) => item.category !== 'format' && !item.resolution)
  expect(unresolved.length).toBeGreaterThan(0)
  expect(unresolved.some((item: { category: string }) => item.category === 'fact')).toBeTruthy()

  for (const item of unresolved) {
    const resolveId = await send(page, [
      `请让我逐项处理检查项 ${item.id}。`,
      tool('load_tool_domain', { domain: 'publish' }),
      tool('checks__resolve_item', { id: item.id }),
    ].join('\n'), conversationId)
    const resolveResult = await actionForRun(page, resolveId, 'checks__resolve_item')
    expect(resolveResult.action).toMatchObject({ status: 'pending', gate: 'H-04' })
    const card = actionCard(page, resolveResult.action)
    const radios = card.locator('input[type="radio"]')
    await expect(radios.first()).toBeVisible()
    for (let i = 0; i < await radios.count(); i++) await expect(radios.nth(i)).not.toBeChecked()
    await radios.first().check()
    await card.getByRole('checkbox').check()
    await executeCard(page, conversationId, resolveResult.action)
  }

  const completeId = await send(page, [
    '所有逐项检查都已处理，请提出完成检查卡片。',
    tool('load_tool_domain', { domain: 'publish' }),
    tool('checks__complete', { id: work.id }),
  ].join('\n'), conversationId)
  const completeResult = await actionForRun(page, completeId, 'checks__complete')
  expect(completeResult.action).toMatchObject({ status: 'pending', gate: 'H-04' })
  const completeCard = actionCard(page, completeResult.action)
  await expect(completeCard.getByText('检查项总数', { exact: true })).toBeVisible()
  await completeCard.getByRole('checkbox').check()
  await executeCard(page, conversationId, completeResult.action)
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('ready')

  const pushId = await send(page, [
    '请提出写入公众号草稿箱的卡片，不要代替我发布。',
    tool('load_tool_domain', { domain: 'publish' }),
    tool('wechat__push', { id: work.id }),
  ].join('\n'), conversationId)
  const pushResult = await actionForRun(page, pushId, 'wechat__push')
  expect(pushResult.action).toMatchObject({ status: 'pending', gate: 'H-05' })
  const pushCard = actionCard(page, pushResult.action)
  await expect(pushCard).toContainText('公众号智能体主链路验收')
  await pushCard.getByRole('checkbox').check()
  await pushCard.getByRole('button', { name: '写入草稿箱', exact: true }).click()
  const pushDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '写入公众号草稿箱（不会发表）', exact: true }) })
  await expect(pushDialog).toBeVisible()
  await pushDialog.getByRole('button', { name: '确认执行这一项', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status, { timeout: 30_000 }).toBe('pushed')
  const pushed = await api(page, 'GET', `/works/${work.id}`)
  expect(pushed.wechat_draft_media_id).toMatch(/^mock-draft-/)
  expect(pushed.published_at).toBeNull()

  const publishedURL = 'https://mp.weixin.qq.com/s/local-agent-main-chain'
  const publishedAt = new Date(Date.now() - 60_000).toISOString()
  const publishId = await send(page, [
    `我已在公众号后台发布。发布链接：${publishedURL}。发布时间：${publishedAt}。`,
    tool('load_tool_domain', { domain: 'publish' }),
    tool('works__mark_published', { id: work.id, url: publishedURL, published_at: publishedAt }),
  ].join('\n'), conversationId)
  const publishedResult = await actionForRun(page, publishId, 'works__mark_published')
  expect(publishedResult.action).toMatchObject({ status: 'pending', gate: 'H-07' })
  const publishedCard = actionCard(page, publishedResult.action)
  await expect(publishedCard.getByText(publishedURL, { exact: true })).toBeVisible()
  const publishedGate = publishedCard.getByRole('checkbox', { name: '我确认已在平台上发布', exact: true })
  await expect(publishedGate).not.toBeChecked()
  await publishedGate.check()
  await executeCard(page, conversationId, publishedResult.action)
  const published = await api(page, 'GET', `/works/${work.id}`)
  expect(published).toMatchObject({ status: 'published', published_url: publishedURL })
  expect(new Date(published.published_at).getTime()).toBe(new Date(publishedAt).getTime())
})
