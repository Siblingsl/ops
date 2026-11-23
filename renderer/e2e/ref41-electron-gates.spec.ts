import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

// REF41 第 5 项：真实 Electron 窗口下的 permission/exception 收口。
// 覆盖 A1/A2 可信度 UI、I2 502、A8 读面、I5 同龄对比读面，
// viewer 在 I3/I6/I7/A3 的只读门，以及 I3/I5/A3/A8 的 500 异常态与恢复；
// 不替代各功能已有的 Go/浏览器证据。
const mockBase = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'

// 真实 Electron 窗口里的 page.request 会挂在自定义协议上；沿用项目既有做法，在窗口内 fetch。
async function electronApi(page: Page, origin: string, method: string, path: string, data?: unknown) {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json()) as { csrf_token: string }
      return await page.evaluate(async ({ url, method, data, csrf }) => {
        const response = await fetch(url, {
          method, credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        })
        const body = await response.text()
        if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
        return body ? JSON.parse(body) : null
      }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
    } catch (error) {
      lastError = error
      await page.waitForTimeout(500)
    }
  }
  throw lastError
}

type AgentDetail = {
  last_run: Record<string, unknown>
  [key: string]: unknown
}

async function launchLoggedIn(baseURL: string, username: string) {
  const profile = await mkdtemp(join(tmpdir(), 'ops-ref41-electron-'))
  const app = await _electron.launch({
    executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL },
    timeout: 60_000,
  })
  const native = await app.firstWindow()
  console.log('[ref41-electron] first window:', native.url())
  await native.goto(`${baseURL}/login`)
  await native.getByLabel('用户名', { exact: true }).fill(username)
  await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
  await native.getByRole('button', { name: '登录', exact: true }).click()
  await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  console.log('[ref41-electron] logged in:', native.url(), 'windows=', app.windows().map((w) => w.url()).join(','))
  return { app, native, profile }
}

async function closeElectron(app: Awaited<ReturnType<typeof _electron.launch>>, profile: string) {
  // ElectronApplication.close() 在 Windows 工作台上会等窗口自然退出而挂住；直接结束整棵进程树。
  const pid = app.process().pid
  if (pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  await Promise.race([
    rm(profile, { recursive: true, force: true }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ])
}

function shanghaiDay(daysAgo: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - daysAgo * 24 * 60 * 60_000))
}

async function seedPublished(page: Page, accountId: string, title: string, daysAgo: number) {
  return await api(page, 'POST', `/accounts/${accountId}/works/import`, {
    confirm_published: true,
    title,
    published_date: shanghaiDay(daysAgo),
    sections: [{ heading: '正文', content_md: `${title} 真实 Electron 回填正文。` }],
  }) as { id: string; published_at: string }
}

async function recordDay7(page: Page, work: { id: string; published_at: string }, reads: number, likes: number, isCurrent = false) {
  const captured = isCurrent
    ? new Date()
    : new Date(new Date(work.published_at).getTime() + 7 * 86_400_000 + 2 * 3_600_000)
  await api(page, 'POST', `/works/${work.id}/metrics`, {
    captured_at: captured.toISOString(), reads, likes, favorites: Math.round(likes / 2),
    comments: 1, shares: 1, follows_gained: Math.round(likes / 3),
  })
}

test('REF41 Electron：A1/A2 可信度、I2/A8 异常态与 I5 同龄对比', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.setTimeout(240_000)
  const username = `ref41-electron-owner-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username) as { id: string }
  const agentProvider = await api(page, 'POST', '/model-providers', {
    name: 'REF41 Electron A1A2 模型', base_url: mockBase, api_key: 'local-e2e-key',
    models: ['mock-agent-writing'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${agentProvider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'agent_chat', provider_id: agentProvider.id, model: 'mock-agent-writing' },
    { task_type: 'default', provider_id: agentProvider.id, model: 'mock-agent-writing' },
  ])
  const i2Provider = await api(page, 'POST', '/model-providers', {
    name: 'REF41 Electron I2 模型', base_url: mockBase, api_key: 'local-e2e-key',
    models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${i2Provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'agent_chat', provider_id: agentProvider.id, model: 'mock-agent-writing' },
    { task_type: 'default', provider_id: agentProvider.id, model: 'mock-agent-writing' },
    { task_type: 'benchmark_decompose', provider_id: i2Provider.id, model: 'mock-writer' },
  ])

  const target = await api(page, 'POST', `/accounts/${account.id}/benchmarks`, {
    platform: 'wechat_mp', name: 'REF41 Electron I2 异常对标', positioning: '真实 Electron 异常态',
  }) as { id: string }
  await api(page, 'POST', `/benchmarks/${target.id}/notes`, {
    title: 'REF41 Electron I2 异常笔记',
    content_summary: '真实 Electron 摘要：先给结论，再拆步骤。',
    structure: { manual: 'electron-keep' },
  })

  const current = await seedPublished(page, account.id, 'REF41 Electron I5 本期作品', 7)
  const peerA = await seedPublished(page, account.id, 'REF41 Electron I5 同批甲', 8)
  const peerB = await seedPublished(page, account.id, 'REF41 Electron I5 同批乙', 9)
  const peerC = await seedPublished(page, account.id, 'REF41 Electron I5 同批丙', 10)
  await recordDay7(page, current, 100, 10, true)
  await recordDay7(page, peerA, 80, 8)
  await recordDay7(page, peerB, 60, 6)
  await recordDay7(page, peerC, 120, 12)

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let profile = ''
  try {
    const launched = await launchLoggedIn(baseURL!, username)
    app = launched.app
    profile = launched.profile
    const native = launched.native

    // A1/A2：真实 Electron 里造出一条会话，再用详情接口夹具呈现 demo/partial/blocked。
    await native.goto(`${baseURL}/agent`)
    const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await privacy.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    if (await privacy.isVisible().catch(() => false)) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    console.log('[ref41-electron] agent page:', native.url())
    const composer = native.getByLabel('发送消息', { exact: true }).or(native.getByPlaceholder(/发送消息/)).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    console.log('[ref41-electron] composer visible')
    await composer.fill('REF41 Electron A1/A2 可信度验收：请用一句话确认收到')
    const send = native.getByRole('button', { name: '发送', exact: true })
    await expect(send).toBeEnabled({ timeout: 30_000 })
    console.log('[ref41-electron] send enabled')
    const createResponse = native.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/agent/conversations' && r.request().method() === 'POST')
    const response = native.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
    await send.click()
    console.log('[ref41-electron] send clicked')
    expect((await response).ok()).toBeTruthy()
    console.log('[ref41-electron] message response ok')
    const created = await (await createResponse).json() as { id?: string; conversation?: { id?: string }; data?: { id?: string } }
    let conversationID = created.id ?? created.conversation?.id ?? created.data?.id ?? ''
    if (!conversationID) {
      const list = await electronApi(native, baseURL!, 'GET', '/agent/conversations') as { conversations?: { id: string }[] }
      conversationID = list.conversations?.[0]?.id ?? ''
    }
    expect(conversationID).not.toBe('')
    console.log('[ref41-electron] conversation', conversationID, 'url', native.url())
    // 工作台形态不一定会把新会话写进地址栏；直接落到详情路由，保证后续断言针对同一会话。
    if (!native.url().endsWith(`/agent/c/${conversationID}`)) await native.goto(`${baseURL}/agent/c/${conversationID}`)
    await expect.poll(async () => {
      const current = await electronApi(native, baseURL!, 'GET', `/agent/conversations/${conversationID}`) as { last_run?: unknown; active_run?: unknown }
      return current.last_run ? 'done' : current.active_run ? 'running' : 'none'
    }, { timeout: 90_000 }).toBe('done')
    console.log('[ref41-electron] run finished')
    const detail = await electronApi(native, baseURL!, 'GET', `/agent/conversations/${conversationID}`) as AgentDetail
    expect(detail.last_run).toBeTruthy()
    await native.route(`**/api/v1/agent/conversations/${conversationID}`, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ...detail,
        last_run: { ...detail.last_run, demo: true, outcome: 'partial', reason: '', final_check: { claims: ['publish'], evidence: 0, blocked: ['publish'] } },
      }),
    }))
    console.log('[ref41-electron] detail fixture installed')
    await native.goto(`${baseURL}/agent/c/${conversationID}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    console.log('[ref41-electron] detail page loaded')
    await expect(native.getByTestId('agent-run-demo-banner')).toContainText('模拟模型演示，结果不代表真实执行')
    await expect(native.getByTestId('agent-run-partial-chip')).toContainText('部分完成')
    await expect(native.getByTestId('agent-run-blocked')).toContainText('未执行声明')
    mkdirSync(resolve('../docs/41-evidence/screenshots'), { recursive: true })
    await native.screenshot({ path: resolve('../docs/41-evidence/screenshots/REF41-electron-a1-a2-trust.png'), fullPage: true })

    // I2：真实 Electron 中拦截批量初拆 502，错误可见；解除后重试成功。
    await native.goto(`${baseURL}/a/${account.id}/profile?tab=benchmarks`)
    const panel = native.getByTestId('benchmark-tab')
    const targetCard = panel.getByTestId('benchmark-target-item').filter({ hasText: 'REF41 Electron I2 异常对标' })
    await expect(targetCard).toHaveCount(1)
    await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
    await targetCard.getByTestId('benchmark-note-select').check()
    const decomposeRoute = '**/benchmark/decompose-batch'
    await native.route(decomposeRoute, (route) => route.fulfill({
      status: 502, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'bad_gateway', message: 'REF41 Electron I2 模型服务暂时不可用' } }),
    }))
    await targetCard.getByTestId('benchmark-decompose-batch-button').click()
    await expect(targetCard.getByText('REF41 Electron I2 模型服务暂时不可用')).toBeVisible()
    await native.unroute(decomposeRoute)
    await targetCard.getByTestId('benchmark-decompose-batch-button').click()
    await expect(targetCard.getByTestId('benchmark-decompose-draft')).toBeVisible()

    // A8：真实 Electron 中打开智能体成本页，核对 run 成本与未定价行如实呈现。
    // A8 的 500 异常态已由 desktop-renderer 的 a8-agent-cost.spec.ts 覆盖；这里补真实 Electron 读面，
    // 不再用页面级 route 拦截已被设置窗预加载的成本查询，避免把缓存命中误判为异常未触发。
    await native.goto(`${baseURL}/settings/usage`)
    await native.getByRole('button', { name: '智能体成本', exact: true }).click()
    await expect(native.getByTestId('agent-cost')).toBeVisible()
    await expect(native.getByTestId('agent-cost-row')).toHaveCount(1)
    await expect(native.getByTestId('agent-cost-row').first()).toContainText('未配置价格')

    // I5：真实 Electron 中打开指标抽屉，同龄对比卡可见。
    await native.goto(`${baseURL}/a/${account.id}/review`)
    await native.getByRole('row').filter({ hasText: 'REF41 Electron I5 本期作品' }).getByRole('button', { name: /录入/ }).click()
    const drawer = native.getByRole('dialog').filter({ hasText: 'REF41 Electron I5 本期作品' })
    await expect(drawer.getByTestId('review-peer-card')).toBeVisible()
    await expect(drawer.getByTestId('review-peer-peers-toggle')).toContainText('查看同批作品（3）')
    await native.screenshot({ path: resolve('../docs/41-evidence/screenshots/REF41-electron-i2-a8-i5.png'), fullPage: true })
  } finally {
    if (app) await closeElectron(app, profile)
  }
})

test('REF41 Electron：viewer 在 I3/I6/I7/A3 的只读门', async ({ page, baseURL, browser }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.setTimeout(180_000)
  const owner = await registerAccount(page, '图文笔记', 'xhs', `ref41-electron-viewer-owner-${Date.now()}`) as { id: string }
  const ownerMe = await api(page, 'GET', '/auth/me') as { workspace: { id: string } }
  const ownerWorkspaceID = ownerMe.workspace.id
  await api(page, 'POST', `/accounts/${owner.id}/followers`, { date: shanghaiDay(1), cumulate: 120 })
  for (const [content, alias] of [['REF41 Electron viewer 问题怎么处理', '读者甲'], ['REF41 Electron viewer 问题怎么处理呢', '读者乙']] as const) {
    const created = await api(page, 'POST', '/comments', { account_id: owner.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  const rebuilt = await page.request.post('http://127.0.0.1:8287/__e2e/comment-clusters/recompute', { data: { account_id: owner.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()

  const wechat = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: 'REF41 Electron viewer 公众号', content_format: 'long_article' }) as { id: string }
  const work = await api(page, 'POST', `/accounts/${wechat.id}/works`, { title: 'REF41 Electron viewer 转化作品' }) as { id: string }
  await api(page, 'POST', `/works/${work.id}/conversion-links`, { platform: 'wechat_mp', target_url: 'https://example.com/ref41-electron-viewer' })

  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
  const viewerName = `ref41-electron-viewer-${Date.now()}`
  const viewerContext = await browser.newContext({ baseURL: baseURL! })
  const registered = await viewerContext.request.post('/api/v1/auth/register', {
    data: { username: viewerName, password: 'local-e2e-password-123', invite_code: invite.code },
  })
  expect(registered.ok(), await registered.text()).toBeTruthy()
  const viewerMe = await (await viewerContext.request.get('/api/v1/auth/me')).json() as { role: string; workspace: { id: string } }
  console.log('[ref41-electron] viewer joined', viewerMe.role, viewerMe.workspace.id, 'owner workspace', ownerWorkspaceID)
  expect(viewerMe.role).toBe('viewer')
  expect(viewerMe.workspace.id).toBe(ownerWorkspaceID)
  await viewerContext.close()

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let profile = ''
  try {
    const launched = await launchLoggedIn(baseURL!, viewerName)
    app = launched.app
    profile = launched.profile
    const native = launched.native
    // 登录默认回到 viewer 的个人工作区；用同一邀请码再切到所有者工作区（已是成员，不会重复占用次数）。
    await electronApi(native, baseURL!, 'POST', '/workspaces/join', { code: invite.code, switch: true })
    console.log('[ref41-electron] viewer identity', JSON.stringify(await native.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json() as { user_id?: string; username: string; role: string; workspace: { id: string } }
      const accounts = await (await fetch('/api/v1/accounts')).json() as { id: string; name: string; status: string }[]
      return { user_id: me.user_id, username: me.username, role: me.role, workspace: me.workspace?.id, accounts: accounts.map((a) => ({ id: a.id, status: a.status, name: a.name })) }
    })))
    // 桌面壳只把“当前账号偏好”指向本账号；viewer 查看的是所有者账号，必须显式指定。
    await native.evaluate(async ({ accountId }) => {
      const me = await (await fetch('/api/v1/auth/me')).json() as { user_id?: string; username: string; workspace: { id: string } }
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, { accountId: owner.id })
    console.log('[ref41-electron] viewer account preference', await native.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('ops.currentAccount.v2:'))))))

    await native.goto(`${baseURL}/a/${owner.id}/review`)
    await native.waitForTimeout(1_000)
    console.log('[ref41-electron] review url', native.url(), 'h1', await native.locator('h1').first().textContent().catch(() => ''))
    // 桌面复盘默认收起趋势区；先展开，I6 粉丝卡和只读提示才会挂载。
    await native.getByRole('button', { name: '查看趋势', exact: true }).click()
    const followers = native.getByTestId('i6-followers-card')
    console.log('[ref41-electron] i6 card counts', {
      cards: await followers.count(),
      readonly: await followers.getByTestId('i6-followers-readonly').count(),
      manage: await followers.getByRole('button', { name: '补录一天', exact: true }).count(),
    })
    await expect(followers.getByTestId('i6-followers-readonly')).toBeVisible()
    await expect(followers.getByRole('button', { name: '补录一天', exact: true })).toHaveCount(0)
    await expect(followers.getByTestId('i6-follower-gap')).toHaveCount(0)

    await native.goto(`${baseURL}/a/${owner.id}/profile?tab=comments`)
    const cluster = native.getByTestId('comment-cluster-item').first()
    await expect(cluster).toBeVisible()
    await expect(cluster.getByRole('button', { name: '生成选题', exact: true })).toHaveCount(0)
    await expect(cluster.getByRole('button', { name: '忽略', exact: true })).toHaveCount(0)
    await expect(cluster.getByRole('button', { name: '重新打开', exact: true })).toHaveCount(0)

    await native.goto(`${baseURL}/works/${work.id}/push`)
    const conversion = native.getByTestId('i7-conversion-card')
    await expect(conversion.getByTestId('i7-conversion-readonly')).toBeVisible()
    await expect(conversion.getByTestId('i7-conversion-generate')).toHaveCount(0)
    await expect(conversion.getByTestId('i7-conversion-url')).toBeVisible()

    await native.goto(`${baseURL}/settings/agent`)
    await expect(native.getByTestId('capability-gaps')).toHaveCount(0)
    await native.screenshot({ path: resolve('../docs/41-evidence/screenshots/REF41-electron-viewer-gates.png'), fullPage: true })
  } finally {
    if (app) await closeElectron(app, profile)
  }
})

test('REF41 Electron：I3/I5/A3/A8 异常态与重试', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.setTimeout(240_000)
  const username = `ref41-electron-error-${Date.now()}`
  const owner = await registerAccount(page, '图文笔记', 'xhs', username) as { id: string }
  for (const [content, alias] of [['REF41 Electron 退款多久到账', '读者甲'], ['REF41 Electron 退款多久到账呢', '读者乙']] as const) {
    const created = await api(page, 'POST', '/comments', { account_id: owner.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  const rebuilt = await page.request.post('http://127.0.0.1:8287/__e2e/comment-clusters/recompute', { data: { account_id: owner.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()

  const wechat = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: 'REF41 Electron 异常公众号', content_format: 'long_article' }) as { id: string }
  await seedPublished(page, wechat.id, 'REF41 Electron I5 异常作品', 0)

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let profile = ''
  try {
    const launched = await launchLoggedIn(baseURL!, username)
    app = launched.app
    profile = launched.profile
    const native = launched.native
    // 登录后工作台仍可能在完成首次账号路由；等 bootstrap 稳定后再深链到业务页。
    await native.waitForTimeout(1_500)

    // I3：问题簇读取 500 可见；解除后刷新恢复列表。
    const clusterRoute = '**/api/v1/accounts/*/comment-clusters*'
    await native.route(clusterRoute, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I3 Electron 问题簇读取失败' } }),
    }))
    await native.goto(`${baseURL}/a/${owner.id}/profile?tab=comments`)
    console.log('[ref41-electron] exception I3 url', native.url())
    const clusters = native.getByTestId('comment-clusters')
    await expect(clusters).toContainText('C 类 I3 Electron 问题簇读取失败')
    await native.unroute(clusterRoute)
    await native.reload()
    await expect(native.getByTestId('comment-cluster-item').first()).toBeVisible()

    // I5：同龄对比 500 显示通用错误；解除后重试恢复。
    await native.evaluate(async ({ accountId }) => {
      const me = await (await fetch('/api/v1/auth/me')).json() as { user_id?: string; username: string; workspace: { id: string } }
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, { accountId: wechat.id })
    const peerRoute = '**/peer-compare*'
    await native.route(peerRoute, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I5 Electron 同龄对比读取失败' } }),
    }))
    await native.goto(`${baseURL}/a/${wechat.id}/review`)
    await native.getByRole('row').filter({ hasText: 'REF41 Electron I5 异常作品' }).getByRole('button', { name: /录入/ }).click()
    const peer = native.getByRole('dialog').filter({ hasText: 'REF41 Electron I5 异常作品' }).getByTestId('review-peer-card')
    await expect(peer).toContainText('同龄对比加载失败')
    await native.unroute(peerRoute)
    await peer.getByRole('button', { name: '重试', exact: true }).click()
    await expect(peer).not.toContainText('同龄对比加载失败')

    // A3：能力缺口列表 500 显示“加载失败”；解除后重试恢复。
    const gapRoute = '**/api/v1/agent-capability-gaps*'
    await native.route(gapRoute, (route) => route.request().method() === 'GET'
      ? route.fulfill({
          status: 500, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 A3 Electron 能力缺口读取失败' } }),
        })
      : route.continue())
    await native.goto(`${baseURL}/settings/agent`)
    const gaps = native.getByTestId('capability-gaps')
    await expect(gaps).toContainText('加载失败：C 类 A3 Electron 能力缺口读取失败')
    await native.unroute(gapRoute)
    await gaps.getByRole('button', { name: '重试', exact: true }).click()
    await expect(gaps).not.toContainText('加载失败')

    // A8：智能体成本 500 显示服务端消息；解除后重试恢复。
    const costRoute = '**/api/v1/usage/agent-cost*'
    await native.route(costRoute, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 A8 Electron 用量读取失败' } }),
    }))
    await native.goto(`${baseURL}/settings/usage`)
    await native.getByRole('button', { name: '智能体成本', exact: true }).click()
    const alert = native.getByRole('alert')
    await expect(alert).toContainText('加载失败')
    await expect(alert).toContainText('C 类 A8 Electron 用量读取失败')
    await native.unroute(costRoute)
    // 用量页错误态带自动重试；解除拦截后等待恢复，不强行点正在重试的禁用按钮。
    await expect(native.getByTestId('agent-cost')).toBeVisible({ timeout: 20_000 })

    await native.screenshot({ path: resolve('../docs/41-evidence/screenshots/REF41-electron-exceptions.png'), fullPage: true })
  } finally {
    if (app) await closeElectron(app, profile)
  }
})
