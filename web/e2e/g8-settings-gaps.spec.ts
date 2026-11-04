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
