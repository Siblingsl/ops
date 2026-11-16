import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-QA-02 批次 QA-B2（docs/26 G3-07/G3-09，docs/34 §14.7）：
// G3-07 今日热点与转选题：admin 开采集（mode=allow 由 e2e 服务器环境变量控制时才可用）
// → 账号启用热点 → 刷新热点（mock 榜单）→ 匹配项逐条「转为选题」（标题/角度）→ 选题池可见；
// 「不感兴趣」逐条拒绝（无批量）。G3-09 趋势条目：近 7 天趋势页可达且返回结构化数据。
// [EXT] 数据源由 DEV 栈 mock（/mock/hot/baidu）承载，不访问真实站点。

async function adminApi(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

test('DEV-QA26 G3-07 热点刷新/转选题逐条与 G3-09 趋势条目', async ({ page, baseURL }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `qa26-g3-hot-${Date.now()}`)

  // 系统管理员开采集：必须用独立浏览器上下文登录 skyeder——复用 page.context() 会覆盖
  // owner 的会话 Cookie（ST-14 同款陷阱），导致后续账号接口 404。
  const adminContext = await page.context().browser()!.newContext()
  const adminPage = await adminContext.newPage()
  await adminPage.goto('/login')
  await adminPage.getByLabel('用户名', { exact: true }).fill('skyeder')
  await adminPage.getByLabel('密码', { exact: true }).fill('local-e2e-admin-pass-456')
  await adminPage.getByRole('button', { name: '登录', exact: true }).click()
  await expect.poll(async () => (await adminPage.request.get('/api/v1/auth/me')).status()).toBe(200)
  const adminMe = (await adminPage.request.get('/api/v1/auth/me').then(r => r.json())) as { is_system_admin?: boolean }
  test.skip(!adminMe?.is_system_admin, 'e2e 服务器未配置全站管理员；热点批次按 26 台账保持未检查')
  const adminFetch = (method: string, path: string, body?: unknown) => adminPage.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
  const boot = await adminFetch('GET', '/admin/crawl') as { settings: { mode: string } }
  test.skip(boot.settings.mode !== 'allow', '部署方未开启采集（OPS_CRAWL_MODE!=allow）；真实采集验收另列 CF-PS')
  await adminFetch('PUT', '/admin/crawl', { level: 'conservative', summary_fetch: false, retention_days: 14, limits: { interval_min: 60, max_items: 50, daily_requests: 300, fail_limit: 3, pause_hours: 6 } })
  await adminFetch('PUT', '/admin/crawl/sources/baidu', { enabled: true, interval_min: 10, max_items: 50 })
  // 工作区选择热点来源（app_setting hot.sources）：服务端 1 分钟 ticker 的 collectHot
  // 会自动试采启用的全局源（mock 榜单），不需要（也不应）在这里抢采集配额。
  await adminApi(page, 'PUT', '/hot-sources', { sources: ['baidu'], rss: [] })
  // 启用热点走既有方案问卷链（strategy 为 POST 激活；UI 勾选「账号启用热点」后保存为新版本）。
  // strategy/options 是 SSE 流（done 事件携带 options），用页面内 fetch 手动聚合。
  const options = await page.evaluate(async ({ accountId }: { accountId: string }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const res = await fetch('/api/v1/accounts/' + accountId + '/strategy/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: JSON.stringify({ domain: '运营经验分享', experiences: '做过三年内容运营，熟悉选题到复盘全流程' }),
    })
    if (!res.ok || !res.body) throw new Error('options: ' + res.status)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let payload: any = null
    let eventName = 'message'
    const handle = (block: string) => {
      eventName = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (!data) return
      const parsed = JSON.parse(data)
      if (eventName === 'done') payload = parsed
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        handle(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
      }
    }
    if (!payload?.result?.options?.length) throw new Error('options empty')
    return payload.result.options as Array<Record<string, unknown>>
  }, { accountId: account.id })
  await adminApi(page, 'POST', `/accounts/${account.id}/strategy`, { ...options[0], hot_enabled: true })

  // 热点匹配：页面加载触发 on_open 预备（prepareOps→matchHot 非强制，claim 当日冷却），
  // 等 GET /hot 出匹配项；仅在仍为空时点「匹配今日热点」，并接受既有 10 分钟冷却 409。
  await page.goto(`/a/${account.id}/ops`)
  await expect(page.getByRole('main')).toContainText('今日')
  let matches = 0
  for (let i = 0; i < 12 && matches === 0; i++) {
    await page.waitForTimeout(5000)
    const hot = await adminApi(page, 'GET', `/accounts/${account.id}/hot?prepare=false`) as { items: Array<{ id: string; status: string }> }
    matches = hot.items.length
  }
  if (matches === 0) {
    const refresh = page.waitForResponse(r => r.url().includes(`/accounts/${account.id}/hot/refresh`) && r.request().method() === 'POST', { timeout: 20_000 }).catch(() => null)
    await page.getByRole('button', { name: '匹配今日热点' }).click().catch(() => undefined)
    const res = await refresh
    if (res && !res.ok()) {
      const body = await res.json() as { error?: { code?: string; message?: string } }
      if (body?.error?.code !== 'state_invalid') throw new Error(`hot/refresh ${res.status()}: ${body?.error?.message}`)
    }
    await expect.poll(async () => {
      const hot = await adminApi(page, 'GET', `/accounts/${account.id}/hot?prepare=false`) as { items: Array<{ id: string; status: string }> }
      return hot.items.length
    }, { timeout: 60_000 }).toBeGreaterThan(0)
  }

  // 转为选题：逐条（标题+角度），无批量入口
  const hot = await adminApi(page, 'GET', `/accounts/${account.id}/hot?prepare=false`) as { items: Array<{ id: string; status: string; hot_item: { title: string } }> }
  const first = hot.items.find(m => m.status !== 'converted')!
  await page.getByRole('button', { name: '转为选题' }).first().click()
  const dialog = page.locator('div.rounded-lg.border', { hasText: '选题标题' })
  await dialog.getByLabel('选题标题').fill('QA-B2 热点转选题验收')
  await dialog.getByLabel('切入角度').fill('从运营新人视角切入')
  await page.getByRole('button', { name: '确认转为选题' }).click()
  await expect.poll(async () => {
    const again = await adminApi(page, 'GET', `/accounts/${account.id}/hot?prepare=false`) as { items: Array<{ id: string; status: string; topic_id?: string }> }
    return again.items.find(m => m.id === first.id)?.status
  }).toBe('converted')
  // 不感兴趣（逐条拒绝）：dismissed 行从台账列表消失（status<>'dismissed' 过滤），
  // 以「该条不再出现」断言，不冒读回 status。
  const remaining = await adminApi(page, 'GET', `/accounts/${account.id}/hot?prepare=false`) as { items: Array<{ id: string }> }
  const dismissTarget = remaining.items.find(m => m.id !== first.id)
  if (dismissTarget) {
    await page.getByRole('button', { name: '不感兴趣' }).first().click()
    await expect.poll(async () => {
      const after = await adminApi(page, 'GET', `/accounts/${account.id}/hot?prepare=false`) as { items: Array<{ id: string }> }
      return after.items.some(m => m.id === dismissTarget.id)
    }).toBe(false)
  }

  // G3-09：近 7 天趋势与赛道雷达可达（API 结构化返回）
  const trends = await adminApi(page, 'GET', `/accounts/${account.id}/hot/trends`) as Record<string, unknown>
  expect(trends).toBeTruthy()
  await page.getByRole('button', { name: '近 7 天趋势与赛道雷达' }).click()
  await expect(page.getByRole('main')).toContainText('趋势')
})
