import { test, expect, type Page } from '@playwright/test'

async function api(page: Page, method: string, path: string, data?: unknown) {
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.fetch('/api/v1' + path, { method, data, headers: { 'X-CSRF-Token': me.csrf_token } })
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy()
  return response.json()
}

async function registerAccount(page: Page, type = '图文笔记') {
  const username = `e2e-${Date.now()}-${test.info().workerIndex}`
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /小红书/ }).click()
  await dialog.getByLabel('账号名称').fill('浏览器验收号')
  await dialog.getByRole('radio', { name: new RegExp('^' + type) }).check()
  const created = page.waitForResponse(r => r.url().endsWith('/api/v1/accounts') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  const account = await (await created).json()
  await page.goto(`/a/${account.id}`)
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  if (process.env.OPS_E2E_PROD === '1') {
    const provider = await api(page, 'POST', '/model-providers', {
      name: '隔离生产验收模拟模型', base_url: 'http://mock:8191/v1', api_key: 'local-e2e-key', models: ['mock-writer'],
    })
    await api(page, 'PUT', '/model-routes', [{ task_type: 'default', provider_id: provider.id, model: 'mock-writer' }])
    // 注册已经创建会话；生产形态另验一次退出与密码登录。
    await api(page, 'POST', '/auth/logout')
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
    await page.goto(`/a/${account.id}`)
    await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  }
  return account
}

async function createOutline(page: Page) {
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await expect(page.getByRole('button', { name: 'AI 生成大纲', exact: true })).toBeDisabled()
  await viewpoint.fill('少而精的步骤更容易长期坚持，这是我的经验判断。')
  await viewpoint.blur()
  await page.getByRole('button', { name: 'AI 生成大纲', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认大纲', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '起草本段', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '确认大纲', exact: true }).click()
  await expect(page.getByText('已确认', { exact: true }).first()).toBeVisible()
  return id
}

async function finishChecks(page: Page, id: string) {
  await page.goto(`/works/${id}/check`)
  await expect.poll(async () => {
    const { run } = await api(page, 'GET', `/works/${id}/checks/latest`)
    return !!run && run.fact_status !== 'pending'
  }, { timeout: 20_000 }).toBeTruthy()
  await expect(page.getByText('事实核查', { exact: true }).locator('..')).toContainText('已完成')
  const { run } = await api(page, 'GET', `/works/${id}/checks/latest`)
  expect(run).toBeTruthy()
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      if (item.category === 'ai_disclosure') {
        const saved = page.waitForResponse(r => r.url().endsWith(`/check-items/${item.id}`) && r.request().method() === 'PATCH')
        const checkbox = page.getByRole('checkbox', { name: '已知悉，发布时会声明' })
        await checkbox.click()
        expect((await saved).ok()).toBeTruthy()
        await expect(checkbox).toBeChecked()
      }
      else await page.locator(`input[name="${item.id}"]`).first().check()
    }
  }
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).status).toBe('ready')
}

test('注册、创建作品、大纲、逐段起草、检查与小红书打包', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  const initial = await api(page, 'GET', `/works/${id}`)
  const draftRequests: string[] = []
  page.on('request', r => { if (/\/sections\/[^/]+\/draft$/.test(r.url()) && r.method() === 'POST') draftRequests.push(r.url()) })
  await page.locator(`#sec-${initial.sections[0].id}`).getByRole('button', { name: '起草本段', exact: true }).focus()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Enter')
    await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[i].content_md).not.toBe('')
    const next = page.locator(`#sec-${initial.sections[i + 1].id}`).getByRole('button', { name: '起草本段', exact: true })
    await expect(next).toBeFocused()
    expect(draftRequests).toHaveLength(i + 1)
    expect(draftRequests[i]).toContain(initial.sections[i].id)
  }
  // 焦点移动不会启动下一次生成，下一空段仍保持空白。
  expect((await api(page, 'GET', `/works/${id}`)).sections[3].content_md).toBe('')
  // 人工整理稿件与图片属于测试准备，不跳过检查或直接改状态。
  let work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先明确要解决的问题，再把任务拆成能够完成的一小步。记录自己的过程，比追求复杂的方法更容易持续。', base_revision: section.revision })
  await api(page, 'PATCH', `/works/${id}`, { title: '把复杂任务拆成一小步', topics: ['日常记录'] })
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const fixtureImage = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100; canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#d9e8ee'; ctx.fillRect(0, 0, 100, 100)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const image = await page.request.post(`/api/v1/works/${id}/assets`, { headers: { 'X-CSRF-Token': me.csrf_token }, multipart: {
    file: { name: 'local-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixtureImage, 'base64') },
  } })
  expect(image.ok(), await image.text()).toBeTruthy()
  await finishChecks(page, id)
  await page.goto(`/works/${id}/pack`)
  await page.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  work = await api(page, 'GET', `/works/${id}`)
  expect(work.status).toBe('packed')
  expect((await page.request.get(`/api/v1/works/${id}/xhs/pack.zip`)).ok()).toBeTruthy()
})

test('首次价值路径：旧文建档、方案启用、生成推荐并逐条采用', async ({ page }) => {
  const began = Date.now()
  const account = await registerAccount(page)
  const guide = page.getByRole('region', { name: '首次推荐路径' })
  await expect(guide).toContainText('约 2 分钟 · 可跳过')
  await guide.getByRole('link', { name: '去粘贴建档' }).click({ noWaitAfter: true })
  const wizard = page.getByRole('dialog').filter({ hasText: '粘贴' }).first()
  await expect(wizard).toBeVisible()
  const sample = '我习惯先把问题拆开，再用自己的经历说明原因。小团队做事时，先明确目标，再选择工具。我带过三人运营团队，做过用户增长，也会记录每一次尝试的结果。'.repeat(5)
  await wizard.getByPlaceholder('粘贴正文', { exact: true }).first().fill(sample)
  await wizard.getByRole('button', { name: /生成|分析/ }).first().click()
  await expect(wizard.getByRole('button', { name: /应用|保存|确认/ }).last()).toBeEnabled()
  await wizard.getByRole('button', { name: /应用|保存|确认/ }).last().click()
  await page.goto(`/a/${account.id}/ops`)
  await page.getByLabel('想做的领域').fill('互联网运营')
  await page.getByLabel('真实经历与资源').fill('在电商公司做了五年用户增长，带过三人小团队')
  await page.getByRole('button', { name: '生成 2–3 个方案', exact: true }).click()
  await page.getByRole('button', { name: '选择并编辑', exact: true }).first().click()
  await page.getByRole('button', { name: '启用方案', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/strategy`)).active?.id).toBeTruthy()
  await page.goto(`/a/${account.id}`)
  const generate = page.getByRole('button', { name: '生成第一条推荐', exact: true })
  if (await generate.isVisible()) await generate.click()
  await expect(page.getByRole('button', { name: '采用为选题', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '采用为选题', exact: true }).first().click()
  await page.getByRole('button', { name: '确认这一条', exact: true }).click()
  await expect(page.getByText('已采用', { exact: true }).first()).toBeVisible()
  expect(Date.now() - began).toBeLessThan(10 * 60_000)
})

test('账号类型只读且 PATCH 无法绕过锁定', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto('/settings/accounts')
  await expect(page.getByText('创建时选定后固定，不可修改；如需其他类型请新建账号')).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  const result = await page.evaluate(async id => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const r = await fetch(`/api/v1/accounts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ content_format: 'comic', confirm: true }) })
    return { status: r.status, body: await r.json() }
  }, account.id)
  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(result.body.error.message).toContain('创建后不可修改')
  expect((await api(page, 'GET', `/accounts/${account.id}`)).content_format).toBe('image_note')
})

test('卡片大纲确认、逐卡配图、检查与含文案发布包', async ({ page }) => {
  await registerAccount(page, '图文卡片')
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先写目标，再安排一小步，做完后记录感受。', base_revision: section.revision })
  await page.goto(`/works/${id}`)
  const buttons = page.getByRole('button', { name: '生成配图', exact: true })
  await expect(buttons.first()).toBeVisible()
  const count = await buttons.count()
  expect(count).toBeGreaterThan(1)
  for (let i = 0; i < count; i++) {
    await buttons.first().click()
    await expect(page.getByRole('button', { name: '重新生成配图', exact: true })).toHaveCount(i + 1)
  }
  work = await api(page, 'GET', `/works/${id}`)
  const firstId = work.sections[0].id
  const secondId = work.sections[1].id
  await page.getByRole('button', { name: '下移卡片 1', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).cards[0].section_id).toBe(secondId)
  await expect(page.locator('[data-card-section]').first()).toHaveAttribute('data-card-section', secondId)
  await expect(page.getByRole('button', { name: '上移卡片 2', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '上移卡片 2', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).cards[0].section_id).toBe(firstId)
  await expect(page.locator('[data-card-section]').first()).toHaveAttribute('data-card-section', firstId)
  const first = page.locator(`[data-card-section="${firstId}"]`)
  await first.getByLabel('配图提示词（可选）').fill('绿色书桌与笔记本，保持留白')
  let generations = 0
  page.on('request', r => { if (r.url().endsWith('/generate-image') && r.method() === 'POST') generations++ })
  await first.getByRole('button', { name: '重新生成配图', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(generations).toBe(0)
  const oldURL = work.cards[0].image_url
  await first.getByRole('button', { name: '重新生成配图', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('旧图保留')
  const regenerated = page.waitForResponse(r => r.url().endsWith('/generate-image') && r.request().method() === 'POST')
  await page.getByRole('button', { name: '重新生成这一张', exact: true }).click()
  const response = await regenerated
  expect(response.request().postDataJSON().prompt).toBe('绿色书桌与笔记本，保持留白')
  expect(response.ok()).toBeTruthy()
  expect(generations).toBe(1)
  expect((await page.request.get(oldURL)).ok()).toBeTruthy()
  await api(page, 'PATCH', `/works/${id}`, { title: '把任务拆成小步骤' })
  await finishChecks(page, id)
  await page.goto(`/works/${id}/pack`)
  await page.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  const zip = await page.request.get(`/api/v1/works/${id}/xhs/pack.zip`)
  expect(zip.ok()).toBeTruthy()
  expect((await zip.body()).includes(Buffer.from('文案.txt'))).toBeTruthy()
  work = await api(page, 'GET', `/works/${id}`)
  expect(work.cards).toHaveLength(count)
})

test('新类型跨平台派生目标置灰', async ({ page }) => {
  const account = await registerAccount(page, '口播脚本')
  await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '目标脚本号', content_format: 'script' })
  await page.goto(`/a/${account.id}`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByRole('button', { name: '派生', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '派生到其他平台', exact: true }) })
  await expect(dialog.getByRole('button', { name: /目标脚本号/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /创建|派生/ }).last()).toBeDisabled()
})


test('副驾驶理由、删除预览与原目标绑定，拒绝过期建议', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  await page.getByRole('button', { name: '起草本段', exact: true }).first().click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[0].content_md).not.toBe('')
  let work = await api(page, 'GET', `/works/${id}`)
  const firstId = work.sections[0].id
  const other = work.sections[1]
  await api(page, 'PATCH', `/sections/${other.id}`, { content_md: '这一段应当保留。', base_revision: other.revision })
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.post(`/api/v1/works/${id}/copilot`, { headers: { 'X-CSRF-Token': me.csrf_token }, data: { message: '这一段可以怎么改？', scope: 'section', section_id: firstId } })
  expect(response.ok()).toBeTruthy()
  expect(await response.text()).toContain('event: done')
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe(work.sections[0].content_md)
  await page.goto(`/works/${id}`)
  await expect(page.getByRole('button', { name: '重新起草', exact: true }).first()).toBeVisible()
  await page.keyboard.press('Control+j')
  await expect(page.getByText('理由：先给结论，减少铺垫')).toBeVisible()
  await page.locator(`#sec-${other.id} textarea`).first().focus()
  await page.getByRole('button', { name: '预览删除这一处', exact: true }).click()
  const first = page.locator(`#sec-${firstId}`)
  await expect(first.getByText('（删除以上原文）', { exact: true })).toBeVisible()
  await first.getByRole('button', { name: '放弃', exact: true }).click()
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe(work.sections[0].content_md)
  await page.getByRole('button', { name: '预览删除这一处', exact: true }).click()
  await first.getByRole('button', { name: '确认删除这一处', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe('')
  work = await api(page, 'GET', `/works/${id}`)
  expect(work.sections[1].content_md).toBe('这一段应当保留。')
  expect(work.sections[0].origin).toBe('mixed')
  // 已修改的原文不能再用旧建议覆盖。
  await page.getByRole('button', { name: '预览修改这一处', exact: true }).click()
  await expect(page.getByText('原文已改动，请重新生成建议', { exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe('')
})
