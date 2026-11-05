import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { createServer } from 'node:net'
import { api, registerAccount } from './support'

type LocalSmtpSink = { port: number; messages: string[]; close: () => Promise<void> }

async function startLocalSmtpSink(rejectGreeting = false): Promise<LocalSmtpSink> {
  const messages: string[] = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('220 qa26-local-smtp ESMTP\r\n')
    let pending = ''
    let message = ''
    let readingMessage = false
    socket.on('error', () => undefined)
    socket.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const boundary = pending.indexOf('\r\n')
        if (boundary < 0) break
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (readingMessage) {
          if (line === '.') {
            messages.push(message)
            message = ''
            readingMessage = false
            socket.write('250 2.0.0 queued\r\n')
          } else message += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
        } else if (/^(EHLO|HELO)\b/i.test(line)) {
          socket.write(rejectGreeting ? '550 qa26 injected SMTP failure\r\n' : '250 qa26-local-smtp\r\n')
        } else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) socket.write('250 2.1.0 accepted\r\n')
        else if (/^DATA$/i.test(line)) { readingMessage = true; socket.write('354 end with .\r\n') }
        else if (/^QUIT$/i.test(line)) { socket.write('221 2.0.0 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('SMTP sink did not bind TCP port')); return }
      resolve(address.port)
    })
  })
  return {
    port,
    messages,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

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

test('DEV-QA26 G1-05 修改密码拒绝与会话失效', async ({ page, browser }) => {
  const username = `qa26-password-change-${Date.now()}-${test.info().workerIndex}`
  await registerAccount(page, '图文笔记', 'xhs', username)
  const origin = new URL(page.url()).origin
  const otherContext = await browser.newContext({ baseURL: origin })
  try {
    const otherPage = await otherContext.newPage()
    await otherPage.goto('/login')
    await otherPage.getByLabel('用户名', { exact: true }).fill(username)
    await otherPage.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    const otherLogin = otherPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await otherPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await otherLogin).status()).toBe(200)
    await expect(otherPage.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()

    await openAdvancedSetting(page, '登录与安全')
    const oldPassword = page.getByLabel('当前密码')
    const newPassword = page.getByLabel('新密码')
    const confirmPassword = page.getByLabel('再输入一次')
    const submit = page.getByRole('button', { name: '修改密码', exact: true })
    const nextPassword = 'local-e2e-password-456'
    await newPassword.fill(nextPassword)
    await confirmPassword.fill(nextPassword)
    const wrongPasswordSamples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      await oldPassword.fill('local-e2e-wrong-password')
      const rejected = page.waitForResponse((response) =>
        response.url().endsWith('/api/v1/auth/password') && response.request().method() === 'PUT')
      const started = performance.now()
      await submit.click()
      const response = await rejected
      wrongPasswordSamples.push(performance.now() - started)
      expect(response.status()).toBe(422)
      await expect(page.getByText(/当前密码不正确/).first()).toBeVisible()
      await expect(submit).toBeEnabled()
    }
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200)

    await oldPassword.fill('local-e2e-password-123')
    const changed = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/password') && response.request().method() === 'PUT')
    await submit.click()
    expect((await changed).status()).toBe(200)
    await expect(page.getByText('密码已修改，其他设备上的登录已失效', { exact: true })).toBeVisible()
    await expect(oldPassword).toHaveValue('')
    await expect(newPassword).toHaveValue('')
    await expect(confirmPassword).toHaveValue('')

    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200)
    expect((await otherContext.request.get(`${origin}/api/v1/auth/me`)).status()).toBe(401)
    await page.reload()
    await expect(page.getByLabel('当前密码')).toBeVisible()
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200)

    await otherPage.goto('/login')
    await otherPage.getByLabel('用户名', { exact: true }).fill(username)
    await otherPage.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    const oldLogin = otherPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await otherPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await oldLogin).status()).toBe(401)
    await expect(otherPage.getByText(/用户名或密码不正确/)).toBeVisible()

    await otherPage.getByLabel('密码', { exact: true }).fill(nextPassword)
    const newLogin = otherPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await otherPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await newLogin).status()).toBe(200)
    await expect(otherPage.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()

    const sorted = [...wrongPasswordSamples].sort((a, b) => a - b)
    console.log(`G1-05 Web 20 次旧密码拒绝 p50=${sorted[9].toFixed(2)}ms p95=${sorted[18].toFixed(2)}ms; rejected=20`)
  } finally {
    await otherContext.close()
  }
})

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

test('DEV-QA26 G8 Web 邮箱邀请无 SMTP 时只记录且拒绝无效地址', async ({ page }) => {
  await registerAccount(page)
  await openSetting(page, '成员与邀请')
  const config = await api(page, 'GET', '/settings') as { smtp: { host: string; from: string } }
  expect(config.smtp.host).toBe('')
  expect(config.smtp.from).toBe('')

  const inviteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
  const invite = await (await inviteResponse).json() as { id: string; code: string }
  const inviteCard = page.locator('li').filter({ hasText: invite.code })
  const email = inviteCard.getByPlaceholder('收件邮箱')
  const send = inviteCard.getByRole('button', { name: '发送邮件', exact: true })

  await send.click()
  await expect(page.getByText('请填写收件邮箱', { exact: true })).toBeVisible()
  await email.fill('not-an-email')
  const invalidToast = expect(page.getByText(/请填写有效邮箱/)).toBeVisible()
  const invalidResponse = page.waitForResponse((response) =>
    response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
  await send.click()
  expect((await invalidResponse).status()).toBe(422)
  await invalidToast

  const samples: number[] = []
  for (let i = 0; i < 20; i++) {
    const recipient = `qa26-no-send-${i}@example.invalid`
    await email.fill(recipient)
    const successToast = i === 0
      ? expect(page.getByText('开发模式已记录邀请（未配置 SMTP，未真实发信）', { exact: true })).toBeVisible()
      : undefined
    const started = performance.now()
    const sentResponse = page.waitForResponse((response) =>
      response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
    await send.click()
    const response = await sentResponse
    samples.push(performance.now() - started)
    expect(response.status()).toBe(200)
    const result = await response.json() as { status: string; message: string }
    expect(result.status).toBe('dev_logged')
    expect(result.message).toContain('未真实发信')
    if (successToast) await successToast
    await expect(email).toHaveValue('')
  }
  const sortedSamples = [...samples].sort((a, b) => a - b)
  const p50 = sortedSamples[Math.ceil(0.50 * sortedSamples.length) - 1]
  const p95 = sortedSamples[Math.ceil(0.95 * sortedSamples.length) - 1]
  console.log('[QA26 email invite click samples] ' + JSON.stringify({ p50_ms: Number(p50.toFixed(2)), p95_ms: Number(p95.toFixed(2)) }))

  const logs = await api(page, 'GET', '/audit-logs?action=invite_email&limit=200') as Array<{ target_id: string; result: string; detail: { to: string; status: string } }>
  const recorded = logs.filter((entry) => entry.target_id === invite.id)
  expect(recorded).toHaveLength(20)
  expect(recorded.every((entry) => entry.result === 'ok' && entry.detail.status === 'dev_logged' && entry.detail.to.endsWith('@example.invalid'))).toBe(true)

  await page.reload()
  await expect(page.getByText(invite.code, { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('收件邮箱')).toHaveValue('')
  expect((await api(page, 'GET', '/workspaces/current/invites')).some((entry: { id: string }) => entry.id === invite.id)).toBe(true)
})

test('DEV-QA26 G2-04 Web 本机 SMTP sink 投递邀请与失败恢复', async ({ page }) => {
  test.setTimeout(180_000)
  const sinks: LocalSmtpSink[] = []
  try {
    const smtp = await startLocalSmtpSink()
    sinks.push(smtp)
    const rejectingSmtp = await startLocalSmtpSink(true)
    sinks.push(rejectingSmtp)
    await registerAccount(page)

    await openSetting(page, '成员与邀请')
    await expect(page.getByText('还没有有效邀请码', { exact: true })).toBeVisible()
    const emptyConfig = await api(page, 'GET', '/settings') as { smtp: { host: string; from: string; has_password: boolean; password?: string } }
    expect(emptyConfig.smtp).toMatchObject({ host: '', from: '', has_password: false })
    expect(emptyConfig.smtp).not.toHaveProperty('password')
    await page.getByRole('combobox').last().selectOption('editor')
    const inviteResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { id: string; code: string; role: string }
    expect(invite.role).toBe('editor')
    const inviteCard = page.locator('li').filter({ hasText: invite.code })
    const email = inviteCard.getByPlaceholder('收件邮箱')

    await openAdvancedSetting(page, '登录与安全')
    await page.getByLabel('SMTP 主机').fill('127.0.0.1')
    await page.getByLabel('端口').fill(String(rejectingSmtp.port))
    await page.getByLabel('发件人 From').fill('qa26-sender@example.invalid')
    const saveRejectedConfig = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT')
    await page.getByRole('button', { name: '保存 SMTP', exact: true }).click()
    expect((await saveRejectedConfig).status()).toBe(200)
    expect((await api(page, 'GET', '/settings')).smtp.port).toBe(rejectingSmtp.port)

    await openSetting(page, '成员与邀请')
    const failingCard = page.locator('li').filter({ hasText: invite.code })
    const failingEmail = failingCard.getByPlaceholder('收件邮箱')
    await failingEmail.fill('qa26-failure@example.invalid')
    const failedSend = page.waitForResponse((response) =>
      response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
    await failingCard.getByRole('button', { name: '发送邮件', exact: true }).click()
    expect((await failedSend).status()).toBe(502)
    await expect(page.getByText(/邮件发送失败/)).toBeVisible()
    await expect(failingEmail).toHaveValue('qa26-failure@example.invalid')
    const failedLog = (await api(page, 'GET', '/audit-logs?action=invite_email&limit=200') as Array<{ target_id: string; result: string }>).find((entry) => entry.target_id === invite.id)
    expect(failedLog?.result).toBe('failed')

    await openAdvancedSetting(page, '登录与安全')
    await page.getByLabel('SMTP 主机').fill('127.0.0.1')
    await page.getByLabel('端口').fill(String(smtp.port))
    await page.getByLabel('发件人 From').fill('qa26-sender@example.invalid')
    const saveWorkingConfig = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT')
    await page.getByRole('button', { name: '保存 SMTP', exact: true }).click()
    expect((await saveWorkingConfig).status()).toBe(200)
    await page.reload()
    await expect(page.getByLabel('SMTP 主机')).toHaveValue('127.0.0.1')
    await expect(page.getByLabel('端口')).toHaveValue(String(smtp.port))
    await expect(page.getByLabel('发件人 From')).toHaveValue('qa26-sender@example.invalid')
    const persistedConfig = await api(page, 'GET', '/settings') as { smtp: { host: string; port: number; from: string; has_password: boolean; password?: string } }
    expect(persistedConfig.smtp).toMatchObject({ host: '127.0.0.1', port: smtp.port, from: 'qa26-sender@example.invalid', has_password: false })
    expect(persistedConfig.smtp).not.toHaveProperty('password')

    await openSetting(page, '成员与邀请')
    const messageCard = page.locator('li').filter({ hasText: invite.code })
    const messageEmail = messageCard.getByPlaceholder('收件邮箱')
    const clickSamples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const recipient = `qa26-local-${index}@example.invalid`
      await messageEmail.fill(recipient)
      const sent = page.waitForResponse((response) =>
        response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
      const started = performance.now()
      await messageCard.getByRole('button', { name: '发送邮件', exact: true }).click()
      const response = await sent
      clickSamples.push(performance.now() - started)
      expect(response.status()).toBe(200)
      expect((await response.json()).status).toBe('sent')
      expect(smtp.messages).toHaveLength(index + 1)
      await expect(messageEmail).toHaveValue('')
    }
    for (const [index, message] of smtp.messages.entries()) {
      expect(message).toContain(`To: qa26-local-${index}@example.invalid`)
      expect(message).toContain(`邀请码：${invite.code}`)
      expect(message).toContain('编辑者')
    }
    const sortedSamples = [...clickSamples].sort((a, b) => a - b)
    const percentile = (p: number) => sortedSamples[Math.ceil(p * sortedSamples.length) - 1]
    console.log('[QA26 local SMTP Web click samples] ' + JSON.stringify({
      count: clickSamples.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
    }))
    const inviteLogs = (await api(page, 'GET', '/audit-logs?action=invite_email&limit=200') as Array<{ target_id: string; result: string; detail: { status: string } }>).filter((entry) => entry.target_id === invite.id)
    expect(inviteLogs).toHaveLength(21)
    expect(inviteLogs.filter((entry) => entry.result === 'ok' && entry.detail.status === 'sent')).toHaveLength(20)
    expect(inviteLogs.filter((entry) => entry.result === 'failed')).toHaveLength(1)

    await page.reload()
    await expect(page.getByText(invite.code, { exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('收件邮箱')).toHaveValue('')
    expect((await api(page, 'GET', '/workspaces/current/invites')).some((entry: { id: string }) => entry.id === invite.id)).toBe(true)
  } finally {
    await Promise.allSettled(sinks.map((sink) => sink.close()))
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

test('DEV-QA26 G2-02 Web 账号编辑、迁移、停用与恢复', async ({ page }) => {
  const account = await registerAccount(page)
  const oldWork = await api(page, 'POST', '/accounts/' + account.id + '/works', { title: 'Web 迁移前作品 ' + Date.now() }) as { id: string; content_format: string }
  expect(oldWork.content_format).toBe('image_note')
  await page.goto('/settings/accounts?id=' + account.id)
  await expect(page.getByRole('heading', { name: '平台账号与凭证', exact: true })).toBeVisible()
  const dialogSamples: number[] = []
  const journeyStarted = performance.now()
  const changeType = page.getByRole('button', { name: '修改类型', exact: true })

  let failedReadInjected = false
  await page.route('**/api/v1/accounts/' + account.id + '/works', async (route) => {
    if (route.request().method() === 'GET' && !failedReadInjected) {
      failedReadInjected = true
      await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'QA26 注入作品读取失败' } } })
      return
    }
    await route.continue()
  })
  await changeType.click()
  let migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改账号类型', exact: true }) })
  await expect(migration.getByRole('alert')).toContainText('读取修改影响失败')
  await expect(migration.getByRole('button', { name: '确认修改', exact: true })).toBeDisabled()
  await migration.getByRole('button', { name: '重新读取修改影响', exact: true }).click()
  await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
  await page.unroute('**/api/v1/accounts/' + account.id + '/works')
  await migration.getByRole('button', { name: '取消', exact: true }).click()
  expect((await api(page, 'GET', '/accounts/' + account.id)).content_format).toBe('image_note')

  for (let index = 0; index < 20; index += 1) {
    const started = performance.now()
    await changeType.click()
    migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改账号类型', exact: true }) })
    await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
    dialogSamples.push(performance.now() - started)
    await migration.getByRole('button', { name: '取消', exact: true }).click()
    await expect(migration).toHaveCount(0)
  }

  await changeType.click()
  migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改账号类型', exact: true }) })
  await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
  await migration.getByRole('radio', { name: /漫画/ }).check()
  const migratedResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/accounts/' + account.id) && response.request().method() === 'PATCH')
  await migration.getByRole('button', { name: '确认修改', exact: true }).click()
  const migrated = await migratedResponse
  expect(migrated.status()).toBe(200)
  const migrationBody = await migrated.json() as {
    account: { content_format: string }
    type_change: { from: string; to: string; works_kept: number; character_cards_kept: number; stale_plan_slots: number }
  }
  expect(migrationBody.account.content_format).toBe('comic')
  expect(migrationBody.type_change).toMatchObject({ from: 'image_note', to: 'comic', works_kept: 1, character_cards_kept: 0, stale_plan_slots: 0 })
  expect((await api(page, 'GET', '/works/' + oldWork.id)).content_format).toBe('image_note')
  const newWork = await api(page, 'POST', '/accounts/' + account.id + '/works', { title: 'Web 迁移后新作品 ' + Date.now() }) as { id: string; content_format: string }
  expect(newWork.content_format).toBe('comic')

  const savedName = 'QA26 Web 账号保存 ' + Date.now()
  const name = page.getByRole('textbox', { name: '账号名称', exact: true })
  await name.fill(savedName)
  const saveResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/accounts/' + account.id) && response.request().method() === 'PATCH')
  await name.blur()
  expect((await saveResponse).status()).toBe(200)
  expect((await api(page, 'GET', '/accounts/' + account.id)).name).toBe(savedName)
  await page.reload()
  await page.goto('/settings/accounts?id=' + account.id)
  await expect(page.getByRole('textbox', { name: '账号名称', exact: true })).toHaveValue(savedName)
  await expect(page.getByText('漫画', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: '停用', exact: true }).click()
  let disableDialog = page.getByRole('dialog').filter({ hasText: '停用「小红书 · ' + savedName + '」？' })
  await expect(disableDialog).toBeVisible()
  await disableDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(disableDialog).toHaveCount(0)
  expect((await api(page, 'GET', '/accounts/' + account.id)).status).toBe('active')
  await page.getByRole('button', { name: '停用', exact: true }).click()
  disableDialog = page.getByRole('dialog').filter({ hasText: '停用「小红书 · ' + savedName + '」？' })
  const disabledResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/accounts/' + account.id + '/disable') && response.request().method() === 'POST')
  await disableDialog.getByRole('button', { name: '停用', exact: true }).click()
  expect((await disabledResponse).status()).toBe(200)
  expect((await api(page, 'GET', '/accounts/' + account.id)).status).toBe('disabled')
  await expect(page.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
  const enabledResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/accounts/' + account.id + '/enable') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '重新启用', exact: true }).click()
  expect((await enabledResponse).status()).toBe(200)
  expect((await api(page, 'GET', '/accounts/' + account.id)).status).toBe('active')
  await page.reload()
  await page.goto('/settings/accounts?id=' + account.id)
  await expect(page.getByRole('textbox', { name: '账号名称', exact: true })).toHaveValue(savedName)
  await expect(page.getByText('漫画', { exact: true }).first()).toBeVisible()
  const sorted = [...dialogSamples].sort((a, b) => a - b)
  console.log('DEV-QA26 G2-02 Web modify-type dialog n=20 p50=' +
    ((sorted[9] + sorted[10]) / 2).toFixed(2) + 'ms p95=' + sorted[18].toFixed(2) +
    'ms failures=0; journey_ms=' + (performance.now() - journeyStarted).toFixed(2) + ' environment=Web Chromium')
})

test('DEV-QA26 G2-02 Web 编辑者只能查看平台账号', async ({ page, browser }) => {
  const account = await registerAccount(page)
  const username = 'qa26-g2-web-account-editor-' + Date.now()
  await openSetting(page, '成员与邀请')
  await expect(page.getByRole('heading', { name: '成员与邀请', exact: true })).toBeVisible()
  await page.getByRole('combobox').last().selectOption('editor')
  const inviteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
  const invite = await (await inviteResponse).json() as { code: string; role: string }
  expect(invite.role).toBe('editor')
  const editorContext: BrowserContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const editorPage = await editorContext.newPage()
    await editorPage.goto('/register')
    await editorPage.getByLabel('用户名', { exact: true }).fill(username)
    await editorPage.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await editorPage.getByLabel('邀请码（可选）').fill(invite.code)
    await editorPage.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => editorPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const ownerWorkspace = (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace
    const editorMe = await editorPage.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as {
      workspace: { id: string }; role: string
    }
    expect(editorMe.workspace.id).toBe(ownerWorkspace.id)
    expect(editorMe.role).toBe('editor')
    expect((await editorPage.evaluate(async () => await (await fetch('/api/v1/accounts')).json()) as Array<{ id: string }>)
      .some((candidate) => candidate.id === account.id)).toBe(true)
    await editorPage.goto('/settings/accounts?id=' + account.id)
    await expect(editorPage.getByRole('heading', { name: '平台账号与凭证', exact: true })).toBeVisible()
    await expect(editorPage.getByText('编辑者可查看账号，修改由所有者操作。', { exact: true })).toBeVisible()
    await expect(editorPage.getByRole('textbox', { name: '账号名称', exact: true })).toBeDisabled()
    await expect(editorPage.getByRole('button', { name: '修改类型', exact: true })).toHaveCount(0)
    await expect(editorPage.getByRole('button', { name: '停用', exact: true })).toHaveCount(0)
    await expect(editorPage.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
    const denied = await editorPage.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
      const [edit, disable, remove] = await Promise.all([
        fetch('/api/v1/accounts/' + accountId, { method: 'PATCH', headers, body: JSON.stringify({ name: '越权账号名' }) }),
        fetch('/api/v1/accounts/' + accountId + '/disable', { method: 'POST', headers }),
        fetch('/api/v1/accounts/' + accountId + '?confirm=true', { method: 'DELETE', headers }),
      ])
      return [edit.status, disable.status, remove.status]
    }, account.id)
    expect(denied).toEqual([403, 403, 403])
    expect((await api(page, 'GET', '/accounts/' + account.id)).name).toBe(account.name)
    expect((await api(page, 'GET', '/accounts/' + account.id)).status).toBe('active')
  } finally {
    await editorContext.close()
  }
})

test('DEV-QA26 G2-02 Web 删除账号取消后保留，确认后只删除目标账号数据', async ({ page }) => {
  const account = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', {
    platform: 'toutiao', name: 'QA26 删除后保留的账号 ' + Date.now(), content_format: 'long_article', type_note: '',
  }) as { id: string; name: string }
  const work = await api(page, 'POST', '/accounts/' + account.id + '/works', {
    title: 'QA26 删除账号级联作品 ' + Date.now(),
  }) as { id: string }
  const trigger = page.getByRole('button').filter({ hasText: account.name }).first()
  const openDeleteMenu = async () => {
    const switcher = page.getByTestId('workspace-account-menu')
    if (await switcher.count() === 0) {
      await trigger.click()
      await expect(switcher).toBeVisible()
    }
    const platform = switcher.getByRole('button').filter({ hasText: '小红书' }).first()
    if (await switcher.getByRole('button').filter({ hasText: account.name }).count() === 0) await platform.click()
    await switcher.getByRole('button').filter({ hasText: account.name }).click({ button: 'right' })
    await page.getByRole('menu').getByRole('menuitem', { name: '删除账号', exact: true }).click()
    return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除「' + account.name + '」？', exact: true }) })
  }

  let confirmDialog = await openDeleteMenu()
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmDialog).toHaveCount(0)
  expect((await api(page, 'GET', '/accounts') as Array<{ id: string }>).some((row) => row.id === account.id)).toBe(true)
  expect((await page.request.get('/api/v1/works/' + work.id)).status()).toBe(200)

  confirmDialog = await openDeleteMenu()
  const deletion = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/api/v1/accounts/' + account.id) && response.request().method() === 'DELETE')
  await confirmDialog.getByRole('button', { name: '确认删除', exact: true }).click()
  expect((await deletion).status()).toBe(200)
  const accounts = await api(page, 'GET', '/accounts') as Array<{ id: string }>
  expect(accounts.some((row) => row.id === account.id)).toBe(false)
  expect(accounts.some((row) => row.id === other.id)).toBe(true)
  expect((await page.request.get('/api/v1/works/' + work.id)).status()).toBe(404)
  await expect(page.getByText('账号已删除', { exact: true })).toBeVisible()
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
