import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

async function openSetting(page: Page, label: string) {
  await page.getByRole('button', { name: /用户菜单/ }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

async function openAdvancedSetting(page: Page, label: string) {
  await page.getByRole('button', { name: /用户菜单/ }).click()
  const menu = page.getByRole('menu')
  const advanced = menu.getByRole('button', { name: '高级设置', exact: true })
  if (await advanced.getAttribute('aria-expanded') !== 'true') await advanced.click()
  await menu.getByRole('menuitem', { name: label, exact: true }).click()
}

test('DEV-QA26 G8 Web 模型删除取消与空态读回', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto('/a/' + account.id)
  await openSetting(page, '模型配置')
  const providers = await api(page, 'GET', '/model-providers') as Array<{ id: string; name: string }>
  expect(providers.length).toBeGreaterThan(0)
  const provider = providers[0]
  const card = page.locator('div.group.p-5').filter({ hasText: provider.name })
  await expect(card).toBeVisible()

  await card.getByRole('button', { name: '删除', exact: true }).click()
  let gate = page.getByRole('dialog').filter({ hasText: '删除「' + provider.name + '」？' })
  await gate.getByRole('button', { name: '删除', exact: true }).click()
  const secondGate = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '仍要删除？', exact: true }) })
  await expect(secondGate).toBeVisible()
  await secondGate.getByRole('button', { name: '取消', exact: true }).click()
  expect((await api(page, 'GET', '/model-providers')).some((item: { id: string }) => item.id === provider.id)).toBe(true)

  await card.getByRole('button', { name: '删除', exact: true }).click()
  gate = page.getByRole('dialog').filter({ hasText: '删除「' + provider.name + '」？' })
  await gate.getByRole('button', { name: '删除', exact: true }).click()
  const finalGate = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '仍要删除？', exact: true }) })
  const removed = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/model-providers/' + provider.id)
    && response.request().method() === 'DELETE'
    && response.request().postData()?.includes('true'))
  await finalGate.getByRole('button', { name: '删除', exact: true }).click()
  expect((await removed).ok()).toBe(true)
  await expect(page.getByText('还没有配置模型', { exact: true })).toBeVisible()
  expect(await api(page, 'GET', '/model-providers')).toEqual([])
  await page.reload()
  await expect(page.getByText('还没有配置模型', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'AI 对话', exact: true }).click()
  await expect(page.getByText(/还没有配置可用于对话的模型/)).toBeVisible()
  await expect(page.getByRole('link', { name: '去模型配置', exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('请先配置支持工具调用的模型')).toBeDisabled()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeDisabled()
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  if (await privacy.isVisible().catch(() => false)) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await page.getByRole('link', { name: '返回工作台', exact: true }).click()
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
})

test('DEV-QA26 G8 Web 编辑者邀请、角色、撤销与权限边界', async ({ page, browser }) => {
  await registerAccount(page)
  await openSetting(page, '成员与邀请')
  await page.getByRole('combobox').last().selectOption('editor')
  const inviteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
  const invite = await (await inviteResponse).json() as { id: string; code: string; role: string }
  expect(invite.role).toBe('editor')
  await expect(page.getByText(invite.code, { exact: true })).toBeVisible()

  const editorUsername = 'qa26-g8-web-editor-' + Date.now()
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const joined = await context.request.post('/api/v1/auth/register', {
      data: { username: editorUsername, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok()).toBeTruthy()
    const joinedMe = await (await context.request.get('/api/v1/auth/me')).json() as { user_id: string; role: string }
    expect(joinedMe.role).toBe('editor')
    expect((await api(page, 'GET', '/workspaces/current/members')).some((member: { user_id: string }) => member.user_id === joinedMe.user_id)).toBe(true)

    const editor = await context.newPage()
    await editor.goto('/settings/members')
    await expect(editor.getByText('只有工作区所有者可以生成邀请码、管理成员与模型/凭证。', { exact: true })).toBeVisible()
    await expect(editor.getByRole('button', { name: '生成邀请码', exact: true })).toHaveCount(0)
    await editor.goto('/settings/models')
    await expect(editor.getByText('你是编辑者，可查看模型配置，但不能修改密钥或路由。', { exact: true })).toBeVisible()
    await expect(editor.getByRole('button', { name: '手动添加', exact: true })).toHaveCount(0)
    await expect(editor.getByRole('button', { name: '快速配置', exact: true })).toHaveCount(0)
    const me = await (await context.request.get('/api/v1/auth/me')).json() as { csrf_token: string; user_id: string }
    const headers = { 'X-CSRF-Token': me.csrf_token }
    const attempts = [
      context.request.post('/api/v1/workspaces/current/invites', { data: { role: 'editor', max_uses: 1, days: 1 }, headers }),
      context.request.post('/api/v1/model-providers', { data: { name: '仅本地权限测试', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-only', models: ['mock-writer'] }, headers }),
      context.request.put('/api/v1/model-routes', { data: [], headers }),
      context.request.patch('/api/v1/workspaces/current/members/' + me.user_id, { data: { role: 'viewer' }, headers }),
    ]
    expect(await Promise.all(attempts.map(async (request) => (await request).status()))).toEqual([403, 403, 403, 403])

    await page.goto('/settings/members')
    const memberRow = page.locator('li').filter({ hasText: editorUsername })
    await expect(memberRow).toBeVisible()
    const roleSelect = memberRow.getByRole('combobox')
    await roleSelect.selectOption('viewer')
    await expect.poll(async () => {
      const members = await api(page, 'GET', '/workspaces/current/members')
      return members.find((member: { user_id: string }) => member.user_id === joinedMe.user_id)?.role
    }).toBe('viewer')
    await roleSelect.selectOption('editor')
    await expect.poll(async () => {
      const members = await api(page, 'GET', '/workspaces/current/members')
      return members.find((member: { user_id: string }) => member.user_id === joinedMe.user_id)?.role
    }).toBe('editor')

    const inviteCard = page.locator('li').filter({ hasText: invite.code })
    const revoked = page.waitForResponse((response) =>
      response.url().endsWith('/workspaces/current/invites/' + invite.id + '/revoke') && response.request().method() === 'POST')
    await inviteCard.getByRole('button', { name: '撤销', exact: true }).click()
    expect((await revoked).ok()).toBe(true)
    expect((await api(page, 'GET', '/workspaces/current/invites')).some((item: { id: string }) => item.id === invite.id)).toBe(false)

    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const cancel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '移出 ' + editorUsername + '？', exact: true }) })
    await cancel.getByRole('button', { name: '取消', exact: true }).click()
    expect((await api(page, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === joinedMe.user_id)).toBe(true)
    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const confirm = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '移出 ' + editorUsername + '？', exact: true }) })
    const removed = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/workspaces/current/members/' + joinedMe.user_id)
      && response.request().method() === 'PATCH')
    await confirm.getByRole('button', { name: '确定', exact: true }).click()
    expect((await removed).ok()).toBe(true)
    expect((await api(page, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === joinedMe.user_id)).toBe(false)
  } finally {
    await context.close()
  }
})

test('DEV-QA26 G2-13 Web 回收站读取失败可重试并区分空态', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto('/a/' + account.id)
  let injectedFailures = 0
  const matchTrash = (url: URL) => url.pathname === '/api/v1/trash'
  await page.route(matchTrash, (route) => { injectedFailures++; return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'qa26 injected failure' } } }) })
  await openAdvancedSetting(page, '回收站')
  await expect.poll(() => injectedFailures).toBeGreaterThan(0)
  await expect(page.getByRole('alert')).toContainText('加载失败')
  const retry = page.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled({ timeout: 15_000 })
  await page.unroute(matchTrash)
  await retry.click()
  await expect(page.getByText('回收站是空的', { exact: true })).toBeVisible()
  await expect(page.getByText('删除的内容保留 30 天，到期后自动彻底删除。', { exact: true })).toBeVisible()
  expect(await api(page, 'GET', '/trash')).toEqual([])
})

test('DEV-QA26 G8 Web 回收站彻底删除取消与确认', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto('/a/' + account.id)
  await openAdvancedSetting(page, '敏感词库')
  const word = 'qa26-web-trash-' + Date.now()
  await page.getByLabel(/^敏感词/).fill(word)
  const created = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/sensitive-words') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  expect((await created).ok()).toBe(true)
  const words = await api(page, 'GET', '/sensitive-words') as Array<{ id: string; word: string }>
  const createdWord = words.find((item) => item.word === word)
  expect(createdWord).toBeTruthy()
  const chip = page.getByText(word, { exact: true }).locator('xpath=..')
  const softDelete = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/sensitive-words/' + createdWord!.id)
    && response.request().method() === 'DELETE')
  await chip.getByRole('button', { name: '删除', exact: true }).click()
  expect((await softDelete).ok()).toBe(true)
  expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(false)
  expect((await api(page, 'GET', '/trash')).some((item: { id: string; type: string }) => item.id === createdWord!.id && item.type === 'sensitive_word')).toBe(true)

  await openAdvancedSetting(page, '回收站')
  const trashRow = page.locator('li').filter({ hasText: word })
  await trashRow.getByRole('button', { name: '彻底删除', exact: true }).click()
  const cancelDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '彻底删除？', exact: true }) })
  await cancelDialog.getByRole('button', { name: '取消', exact: true }).click()
  expect((await api(page, 'GET', '/trash')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(true)
  await trashRow.getByRole('button', { name: '彻底删除', exact: true }).click()
  const confirmDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '彻底删除？', exact: true }) })
  const purged = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/trash/sensitive_word/' + createdWord!.id)
    && new URL(response.url()).searchParams.get('confirm') === 'true'
    && response.request().method() === 'DELETE')
  await confirmDialog.getByRole('button', { name: '彻底删除', exact: true }).click()
  expect((await purged).ok()).toBe(true)
  await expect.poll(async () => (await api(page, 'GET', '/trash')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(false)
  expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(false)
})

test('DEV-QA26 G8 Web 回收站 viewer 不能恢复或彻底删除作品', async ({ page, browser }) => {
  const account = await registerAccount(page)
  const title = `QA26 Web 回收站权限作品 ${Date.now()}`
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title }) as { id: string }
  await page.goto(`/a/${account.id}/works`)
  const row = page.locator('div.group').filter({ hasText: title })
  await expect(row).toBeVisible()
  const softDelete = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/works/${work.id}`) && response.request().method() === 'DELETE')
  await row.getByRole('button', { name: '删除', exact: true }).click()
  expect((await softDelete).ok()).toBe(true)
  expect((await api(page, 'GET', '/trash?type=work') as Array<{ id: string }>).some((item) => item.id === work.id)).toBe(true)

  await openSetting(page, '成员与邀请')
  await page.getByRole('combobox').last().selectOption('viewer')
  const inviteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
  const invite = await (await inviteResponse).json() as { code: string; role: string }
  expect(invite.role).toBe('viewer')

  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await context.request.post('/api/v1/auth/register', {
      data: { username: 'qa26-g8-web-viewer-trash-' + Date.now(), password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(registered.ok()).toBeTruthy()
    const viewer = await context.newPage()
    await viewer.goto('/settings/trash')
    const me = await (await context.request.get('/api/v1/auth/me')).json() as { csrf_token: string; role: string }
    expect(me.role).toBe('viewer')
    const viewerRow = viewer.locator('li').filter({ hasText: title })
    await expect(viewerRow).toBeVisible()
    const allTab = viewer.getByRole('button', { name: /^全部/ })
    const workTab = viewer.getByRole('button', { name: /^作品/ })
    const tabSamples: number[] = []
    for (let i = 0; i < 20; i++) {
      const target = i % 2 === 0 ? workTab : allTab
      const started = performance.now()
      await target.click()
      await expect(target).toHaveClass(/bg-white/)
      await expect(viewerRow).toBeVisible()
      tabSamples.push(performance.now() - started)
    }
    const sortedTabSamples = [...tabSamples].sort((a, b) => a - b)
    const tabMetrics = { environment: 'Chromium', samples_ms: tabSamples.map((sample) => Number(sample.toFixed(2))), p50_ms: Number(sortedTabSamples[9].toFixed(2)), p95_ms: Number(sortedTabSamples[18].toFixed(2)), failures: 0 }
    await test.info().attach('trash-viewer-tab-click-metrics', { body: Buffer.from(JSON.stringify(tabMetrics)), contentType: 'application/json' })
    console.log(`DEV-QA26 trash viewer tab clicks n=20 p50=${tabMetrics.p50_ms}ms p95=${tabMetrics.p95_ms}ms failures=0 environment=Chromium`)
    await expect(viewerRow.getByRole('button', { name: '恢复', exact: true })).toHaveCount(0)
    await expect(viewerRow.getByRole('button', { name: '恢复并查看', exact: true })).toHaveCount(0)
    await expect(viewerRow.getByRole('button', { name: '彻底删除', exact: true })).toHaveCount(0)
    const writeStatuses = await viewer.evaluate(async ({ id, csrfToken }) => {
      const headers = { 'X-CSRF-Token': csrfToken }
      const [restore, purge] = await Promise.all([
        fetch(`/api/v1/trash/work/${id}/restore`, { method: 'POST', headers }),
        fetch(`/api/v1/trash/work/${id}?confirm=true`, { method: 'DELETE', headers }),
      ])
      return [restore.status, purge.status]
    }, { id: work.id, csrfToken: me.csrf_token })
    expect(writeStatuses).toEqual([403, 403])
    expect((await api(page, 'GET', '/trash?type=work') as Array<{ id: string }>).some((item) => item.id === work.id)).toBe(true)
  } finally {
    await context.close()
  }
})

test('DEV-QA26 G2-13 Web viewer 全类型回收站写权限矩阵', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '漫画')
  const stamp = Date.now()
  const workTitle = `QA26 Web viewer 回收站作品 ${stamp}`
  const topicTitle = `QA26 Web viewer 回收站选题 ${stamp}`
  const materialTitle = `QA26 Web viewer 回收站素材 ${stamp}`
  const sampleTitle = `QA26 Web viewer 回收站样本 ${stamp}`
  const characterTitle = `QA26 Web viewer 回收站角色 ${stamp}`
  const referenceTitle = `https://www.xiaohongshu.com/explore/qa26-trash-viewer-web-${stamp}`
  const wordTitle = `qa26-web-viewer-trash-${stamp}`

  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: workTitle }) as { id: string }
  const topic = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: topicTitle, angle: '隔离的权限矩阵记录' }) as { topic: { id: string } }
  const material = await api(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content: materialTitle, source: 'DEV-QA26 本地验收', tags: [] }) as { id: string }
  const sample = await api(page, 'POST', `/accounts/${account.id}/style-samples`, { title: sampleTitle, content_md: '仅用于 DEV-QA26 viewer 权限验收。' }) as { id: string }
  const character = await api(page, 'POST', `/accounts/${account.id}/characters`, { name: characterTitle, appearance: '测试角色', personality: '仅用于权限验收', catchphrase: 'DEV-QA26' }) as { id: string }
  const reference = await api(page, 'POST', `/accounts/${account.id}/references`, { links: [referenceTitle] }) as { ids: string[] }
  await api(page, 'POST', '/sensitive-words', { words: [wordTitle], category: 'DEV-QA26' })
  const word = (await api(page, 'GET', '/sensitive-words') as Array<{ id: string; word: string }>).find((item) => item.word === wordTitle)
  expect(word).toBeTruthy()

  const fixtures = [
    { type: 'work', id: work.id, title: workTitle, tab: '作品', deletePath: `/works/${work.id}` },
    { type: 'topic', id: topic.topic.id, title: topicTitle, tab: '选题', deletePath: `/topics/${topic.topic.id}` },
    { type: 'material', id: material.id, title: materialTitle, tab: '素材', deletePath: `/materials/${material.id}` },
    { type: 'style_sample', id: sample.id, title: sampleTitle, tab: '风格样本', deletePath: `/style-samples/${sample.id}` },
    { type: 'character_card', id: character.id, title: characterTitle, tab: '角色卡', deletePath: `/characters/${character.id}` },
    { type: 'reference', id: reference.ids[0], title: referenceTitle, tab: '对标参考', deletePath: `/references/${reference.ids[0]}` },
    { type: 'sensitive_word', id: word!.id, title: wordTitle, tab: '敏感词', deletePath: `/sensitive-words/${word!.id}` },
  ]
  await Promise.all(fixtures.map((item) => api(page, 'DELETE', item.deletePath)))
  const seededTrash = await api(page, 'GET', '/trash') as Array<{ id: string; type: string; title: string }>
  const confirmedFixtures = fixtures.map((item) => {
    const entry = seededTrash.find((candidate) => candidate.type === item.type && candidate.id === item.id)
    expect(entry, `${item.type} 应进入回收站`).toBeTruthy()
    return { ...item, title: entry!.title }
  })

  await openSetting(page, '成员与邀请')
  await page.getByRole('combobox').last().selectOption('viewer')
  const inviteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
  const invite = await (await inviteResponse).json() as { code: string; role: string }
  expect(invite.role).toBe('viewer')

  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await context.request.post('/api/v1/auth/register', {
      data: { username: `qa26-g8-web-trash-matrix-${stamp}`, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(registered.ok()).toBeTruthy()
    const viewer = await context.newPage()
    await viewer.goto('/settings/trash')
    const me = await (await context.request.get('/api/v1/auth/me')).json() as { csrf_token: string; role: string }
    expect(me.role).toBe('viewer')

    const filterSamples: number[] = []
    for (let index = 0; index < 20; index++) {
      const item = confirmedFixtures[index % confirmedFixtures.length]
      const tab = viewer.getByRole('button', { name: new RegExp(`^${item.tab}`) })
      const started = performance.now()
      await tab.click()
      await expect(tab).toHaveClass(/bg-white/)
      const row = viewer.locator('li').filter({ hasText: item.title })
      await expect(row).toBeVisible()
      filterSamples.push(performance.now() - started)
      if (index < confirmedFixtures.length) {
        await expect(row.getByRole('button', { name: '恢复', exact: true })).toHaveCount(0)
        await expect(row.getByRole('button', { name: '恢复并查看', exact: true })).toHaveCount(0)
        await expect(row.getByRole('button', { name: '彻底删除', exact: true })).toHaveCount(0)
      }
    }
    const sortedFilterSamples = [...filterSamples].sort((a, b) => a - b)
    const filterMetrics = {
      environment: 'Chromium', samples_ms: filterSamples.map((sample) => Number(sample.toFixed(2))),
      p50_ms: Number(sortedFilterSamples[9].toFixed(2)), p95_ms: Number(sortedFilterSamples[18].toFixed(2)), failures: 0,
    }
    await test.info().attach('trash-viewer-type-filter-metrics', { body: Buffer.from(JSON.stringify(filterMetrics)), contentType: 'application/json' })
    console.log(`DEV-QA26 trash viewer type filters n=20 p50=${filterMetrics.p50_ms}ms p95=${filterMetrics.p95_ms}ms failures=0 environment=Chromium`)

    const writeStatuses = await viewer.evaluate(async ({ items, csrfToken }) => await Promise.all(items.map(async (item) => {
      const headers = { 'X-CSRF-Token': csrfToken }
      const [restore, purge] = await Promise.all([
        fetch(`/api/v1/trash/${item.type}/${item.id}/restore`, { method: 'POST', headers }),
        fetch(`/api/v1/trash/${item.type}/${item.id}?confirm=true`, { method: 'DELETE', headers }),
      ])
      return { type: item.type, restore: restore.status, purge: purge.status }
    })), { items: confirmedFixtures.map(({ type, id }) => ({ type, id })), csrfToken: me.csrf_token })
    expect(writeStatuses).toEqual(confirmedFixtures.map(({ type }) => ({ type, restore: 403, purge: 403 })))
    const ownerTrashAfter = await api(page, 'GET', '/trash') as Array<{ id: string; type: string }>
    expect(confirmedFixtures.every((item) => ownerTrashAfter.some((entry) => entry.type === item.type && entry.id === item.id))).toBe(true)
  } finally {
    await context.close()
  }
})

test('DEV-QA26 G2-13 Web 回收站逐项验收选题素材样本角色参考', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '漫画')
  const stamp = Date.now()
  const topicTitle = `QA26 Web 回收站选题 ${stamp}`
  const materialContent = `QA26 Web 本地验收素材 ${stamp}`
  const sampleTitle = `QA26 Web 回收站样本 ${stamp}`
  const characterName = `QA26 Web 回收站角色 ${stamp}`
  const sampleBody = `仅用于 DEV-QA26 Web 回收站本地验收的风格样本正文 ${stamp}。`
  const referenceURL = `https://www.xiaohongshu.com/explore/qa26-trash-web-${stamp}`
  const trashTypes = [
    { type: 'topic', tab: '选题', title: topicTitle, route: `/a/${account.id}/topics` },
    { type: 'material', tab: '素材', title: materialContent, route: `/a/${account.id}/materials` },
    { type: 'style_sample', tab: '风格样本', title: sampleTitle, route: `/a/${account.id}/profile?tab=samples` },
    { type: 'character_card', tab: '角色卡', title: characterName, route: `/a/${account.id}/profile?tab=characters` },
    { type: 'reference', tab: '对标参考', title: referenceURL, sourceTitle: referenceURL, route: `/a/${account.id}/ops` },
  ]
  type TrashItem = { id: string; type: string; title: string }
  const getTrash = async () => await api(page, 'GET', '/trash') as TrashItem[]
  const findTrash = async (type: string, title: string) => {
    const found = (await getTrash()).find((item) => item.type === type && item.title === title)
    expect(found, `${type} ${title} 应在服务端回收站中`).toBeTruthy()
    return found!
  }
  const deleteFromSource = async (item: typeof trashTypes[number]) => {
    await page.goto(item.route)
    if (item.type === 'topic') {
      const row = page.locator('div.group.relative.p-4').filter({ has: page.getByText(item.title, { exact: true }) })
      await expect(row).toBeVisible()
      const deleted = page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes('/api/v1/topics/') && response.request().method() === 'DELETE')
      await row.getByRole('button', { name: '更多', exact: true }).click()
      await row.getByRole('button', { name: '删除', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    } else if (item.type === 'material') {
      const card = page.locator('div.group.mb-4').filter({ has: page.getByText(materialContent, { exact: true }) })
      await expect(card).toBeVisible()
      const deleted = page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes('/api/v1/materials/') && response.request().method() === 'DELETE')
      await card.getByRole('button', { name: '删除', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    } else if (item.type === 'style_sample' || item.type === 'character_card') {
      const row = page.locator('li').filter({ hasText: item.title })
      await expect(row).toBeVisible()
      const deleted = page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes(item.type === 'style_sample' ? '/api/v1/style-samples/' : '/api/v1/characters/') && response.request().method() === 'DELETE')
      await row.getByRole('button', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: `删除「${item.title}」？`, exact: true }) })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    } else {
      const refLink = page.locator(`a[href="${item.sourceTitle || item.title}"]`)
      await expect(refLink).toBeVisible()
      const deleted = page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes('/api/v1/references/') && response.request().method() === 'DELETE')
      await refLink.locator('xpath=..').getByRole('button', { name: '移入回收站', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    }
    await expect.poll(async () => (await getTrash()).some((entry) => entry.type === item.type && entry.title === item.title)).toBe(true)
  }
  const openTrash = async () => await openAdvancedSetting(page, '回收站')
  const restoreFromTrash = async (item: TrashItem) => {
    const tabName = trashTypes.find((candidate) => candidate.type === item.type)!.tab
    await page.getByRole('button', { name: new RegExp(`^${tabName}`) }).click()
    const row = page.locator('li').filter({ hasText: item.title })
    await expect(row).toBeVisible()
    const restored = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/trash/${item.type}/${item.id}/restore`) && response.request().method() === 'POST')
    await row.getByRole('button', { name: '恢复', exact: true }).click()
    expect((await restored).ok()).toBe(true)
    await expect.poll(async () => (await getTrash()).some((entry) => entry.id === item.id)).toBe(false)
  }
  const purgeWithCancelAndConfirm = async (item: TrashItem) => {
    const tabName = trashTypes.find((candidate) => candidate.type === item.type)!.tab
    await page.getByRole('button', { name: new RegExp(`^${tabName}`) }).click()
    const row = page.locator('li').filter({ hasText: item.title })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '彻底删除', exact: true }).click()
    const cancelDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '彻底删除？', exact: true }) })
    await cancelDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect((await getTrash()).some((entry) => entry.id === item.id)).toBe(true)
    await row.getByRole('button', { name: '彻底删除', exact: true }).click()
    const confirmDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '彻底删除？', exact: true }) })
    const purged = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/trash/${item.type}/${item.id}`)
      && new URL(response.url()).searchParams.get('confirm') === 'true'
      && response.request().method() === 'DELETE')
    await confirmDialog.getByRole('button', { name: '彻底删除', exact: true }).click()
    expect((await purged).ok()).toBe(true)
    await expect.poll(async () => (await getTrash()).some((entry) => entry.id === item.id)).toBe(false)
  }

  await api(page, 'POST', `/accounts/${account.id}/topics`, { title: topicTitle, angle: 'DEV-QA26 隔离测试选题' })
  await api(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content: materialContent, source: 'DEV-QA26 Web 本地验收', tags: [] })
  await api(page, 'POST', `/accounts/${account.id}/style-samples`, { title: sampleTitle, content_md: sampleBody })
  await api(page, 'POST', `/accounts/${account.id}/characters`, { name: characterName, appearance: '测试角色', personality: '仅本地验收', catchphrase: 'DEV-QA26' })
  await page.goto(`/a/${account.id}/ops`)
  await page.getByLabel('单篇链接（每行一条，最多 20 条）').fill(referenceURL)
  const referenceAdded = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/api/v1/accounts/${account.id}/references`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '添加参考链接', exact: true }).click()
  expect((await referenceAdded).ok()).toBe(true)
  await expect(page.locator(`a[href="${referenceURL}"]`)).toBeVisible()

  for (const item of trashTypes) await deleteFromSource(item)
  const items = await Promise.all(trashTypes.map((item) => findTrash(item.type, item.title)))
  await openTrash()
  const filterSamples: number[] = []
  for (let i = 0; i < 20; i++) {
    const item = trashTypes[i % trashTypes.length]
    const tab = page.getByRole('button', { name: new RegExp(`^${item.tab}`) })
    const started = Date.now()
    await tab.click()
    await expect(tab).toHaveClass(/bg-white/)
    await expect(page.locator('li').filter({ hasText: item.title })).toBeVisible()
    filterSamples.push(Date.now() - started)
  }
  const sorted = [...filterSamples].sort((a, b) => a - b)
  const metrics = { environment: 'Web Chromium', samples_ms: filterSamples, p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1], failures: 0 }
  await test.info().attach('trash-object-type-filter-metrics', { body: Buffer.from(JSON.stringify(metrics)), contentType: 'application/json' })
  console.log(`DEV-QA26 trash object filters n=20 p50=${metrics.p50_ms}ms p95=${metrics.p95_ms}ms failures=0 environment=Web Chromium`)
  for (const item of items) await restoreFromTrash(item)
  await page.reload()
  for (const item of trashTypes) {
    await page.getByRole('button', { name: new RegExp(`^${item.tab}`) }).click()
    await expect(page.getByText('回收站是空的', { exact: true })).toBeVisible()
  }
  expect((await getTrash()).some((entry) => items.some((item) => item.id === entry.id))).toBe(false)

  for (const item of trashTypes) await deleteFromSource(item)
  const secondPass = await Promise.all(trashTypes.map((item) => findTrash(item.type, item.title)))
  await openTrash()
  for (const item of secondPass) await purgeWithCancelAndConfirm(item)
  await page.reload()
  await expect(page.getByText('回收站是空的', { exact: true })).toBeVisible()
  expect((await getTrash()).some((entry) => secondPass.some((item) => item.id === entry.id))).toBe(false)
})
