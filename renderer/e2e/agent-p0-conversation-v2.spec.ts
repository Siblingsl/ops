import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 P0-1（DEV-AI-39）：对话页 v2 布局、四态、页签、分段、首屏层级与菜单分组回归。
test('DEV-AI-39 P0 对话页 v2 布局与证据截图', async ({ page, browser, baseURL }) => {
  await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'P0 布局验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  const unavailableProvider = await api(page, 'POST', '/model-providers', {
    name: 'P0 自检失败模型', base_url: 'http://127.0.0.1:8297/bad/v1', api_key: 'local-e2e-key', models: ['mock-unavailable'],
  })
  await api(page, 'POST', `/model-providers/${unavailableProvider.id}/selftest`, { model: 'mock-unavailable' })
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const workbench = page.locator('.desktop-agent-workbench')
  await expect(workbench).toBeVisible()
  await expect(page.getByRole('heading', { name: '让智能体接手一件运营工作', exact: true })).toBeVisible()
  await expect(page.locator('.desktop-agent-welcome-card')).toHaveCount(3)
  await expect(page.locator('.desktop-agent-welcome-summary')).toHaveCount(1)

  // UI-01：56px 双行头、隐私浮层、无设置齿轮。
  const header = page.locator('.desktop-agent-header')
  await expect(header).toBeVisible()
  expect(Math.round((await header.boundingBox())!.height)).toBe(56)
  await expect(header.getByRole('button', { name: /仅本人可见，查看隐私说明/ })).toBeVisible()
  await header.getByRole('button', { name: /仅本人可见，查看隐私说明/ }).click()
  await expect(page.locator('#agent-privacy-popover')).toContainText('团队成员不能读取消息、附件与产物')
  await page.keyboard.press('Escape')
  await expect(page.locator('#agent-privacy-popover')).toBeHidden()
  await expect(header.locator('svg[aria-label="设置"]')).toHaveCount(0)
  await expect(header).not.toContainText('设置')

  // IX-05：模型行两行信息、自检状态与设置入口。
  await page.getByRole('button', { name: '选择模型' }).click()
  const modelMenu = page.getByRole('menu', { name: '选择模型' })
  await expect(modelMenu).toBeVisible()
  await expect(modelMenu).toContainText('工具')
  await expect(modelMenu).toContainText('已自检')
  await expect(modelMenu.getByRole('menuitemradio')).toHaveCount(2)
  const unavailableModel = modelMenu.getByRole('menuitemradio', { name: /mock-unavailable/ })
  await expect(unavailableModel).toBeDisabled()
  await expect(unavailableModel).toHaveAttribute('title', /未通过工具调用自检/)
  await expect(unavailableModel).toContainText('自检失败')
  await expect(unavailableModel).toContainText('未通过工具调用自检')
  await expect(modelMenu.getByRole('button', { name: '模型设置', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-model-menu-1440.png') })
  await page.keyboard.press('Escape')

  // IX-06：模式菜单三项说明；切换后主按钮文案同步。
  const modeTrigger = page.getByRole('button', { name: /对话模式/ })
  await expect(modeTrigger).toHaveAttribute('aria-description', '可产生卡片，写入逐张确认，不批量执行')
  await modeTrigger.click()
  const modeMenu = page.getByRole('menu', { name: '对话模式选项' })
  await expect(modeMenu.getByRole('menuitemradio')).toHaveCount(3)
  await expect(modeMenu).toContainText('只读分析，不产生卡片')
  await expect(modeMenu).toContainText('先给步骤，不执行')
  await expect(modeMenu).toContainText('不批量执行')
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-mode-menu-1440.png') })
  await modeMenu.getByRole('menuitemradio', { name: /计划/ }).click()
  await expect(modeTrigger).toContainText('计划')
  await expect(page.getByRole('button', { name: '生成计划', exact: true })).toBeVisible()
  await modeTrigger.click()
  await modeMenu.getByRole('menuitemradio', { name: /执行（逐卡确认）/ }).click()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()

  // UI-01 / UI-03：任务面板入口带 aria-controls，面板四个页签，方向键切换。
  const toggle = header.locator('.desktop-agent-panel-button')
  await expect(toggle).toHaveAttribute('aria-controls', 'agent-workbench-panel')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const panel = page.locator('#agent-workbench-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('group', { name: '任务面板空态' }).getByRole('button')).toHaveCount(3)
  await expect(panel.getByRole('tab')).toHaveCount(4)
  await expect(panel.locator('.desktop-agent-panel-tab-count')).toHaveCount(0)
  await panel.getByRole('tab', { name: /任务/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(panel.getByRole('tab', { name: /上下文/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /agent-panel-tab-context/)

  // UI-08：应用内 / Chrome 协作分段，同一时刻只挂一个浏览视图。
  await panel.getByRole('tab', { name: /浏览器/ }).click()
  const segmented = panel.locator('.desktop-agent-segmented')
  await expect(segmented.getByRole('button', { name: '应用内' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('[data-testid="inbrowse-panel"], [data-testid="inbrowse-unavailable"]')).toHaveCount(1)
  await expect(panel).not.toContainText('浏览器协作未开启')
  const panelBox = await panel.boundingBox()
  const headerBox = await page.locator('.desktop-agent-header').boundingBox()
  expect(panelBox!.x, '浏览器面板横向不覆盖会话头').toBeGreaterThanOrEqual(headerBox!.x + headerBox!.width - 1)
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-browser-inapp-1440.png') })
  await segmented.getByRole('button', { name: 'Chrome 协作' }).click()
  await expect(segmented.getByRole('button', { name: 'Chrome 协作' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.desktop-agent-browser-status')).toHaveCount(1)
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-browser-chrome-1440.png') })

  // UI-05：首屏只有一个实心主按钮。
  await expect(page.locator('.desktop-agent-workbench-main [data-variant="primary"]')).toHaveCount(1)

  // UI-04：8 个代表元素计算字号 ≥12px（38 §10 UI-04 验收）。
  const ui04Targets = [
    { name: '会话头标题', locator: page.locator('.desktop-agent-header-title').first() },
    { name: '会话头副行', locator: page.locator('.desktop-agent-header-sub').first() },
    { name: '欢迎卡标题', locator: page.locator('.desktop-agent-welcome-heading').first() },
    { name: '欢迎卡说明', locator: page.locator('.desktop-agent-welcome-card > span:last-child').first() },
    { name: '空态摘要', locator: page.locator('.desktop-agent-welcome-summary').first() },
    { name: '输入台占位', locator: page.getByRole('textbox', { name: '发送消息' }) },
    { name: '模式按钮', locator: page.getByRole('button', { name: /对话模式/ }) },
    { name: '浏览器分段', locator: panel.locator('.desktop-agent-segmented').first() },
  ]
  for (const target of ui04Targets) {
    const size = await target.locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(size, `${target.name} 字号 ≥12px`).toBeGreaterThanOrEqual(12)
  }

  // UI-04/A：消息列不再做纯白卡面，消息区与工作区统一走 --ops-canvas。
  const canvasBackground = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--ops-canvas)'
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  })
  const chatStream = page.locator('.desktop-agent-workbench .desktop-agent-chat-stream')
  const streamBackground = await chatStream.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(streamBackground, '消息区底色应等于 --ops-canvas').toBe(canvasBackground)
  expect(streamBackground, '消息区不应是纯白阅读面').not.toBe('rgb(255, 255, 255)')
  const columnBackground = await page.locator('.desktop-agent-workbench .desktop-agent-message-column').evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(columnBackground, '消息列不应再叠白色卡面').toBe('rgba(0, 0, 0, 0)')
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ui04-canvas.png') })

  // UI-06：运营卡只填输入框。
  const composer = page.getByRole('textbox', { name: '发送消息' })
  const prompt = '帮我找下一批可写的选题，并说明理由。'
  await page.getByRole('button', { name: '填入：帮我找选题' }).click()
  await expect(composer).toHaveValue(prompt)
  await expect(page).toHaveURL(/\/agent$/)

  // IX-01/02：输入 / 打开统一候选浮层，Esc 关闭。
  await composer.fill('@')
  const candidates = page.locator('.agent-composer-candidates')
  await expect(candidates).toBeVisible()
  await expect(candidates.getByRole('tab')).toHaveCount(6)
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Escape')
  await expect(candidates).toBeHidden()
  await composer.fill('/')
  await expect(candidates.getByRole('option')).toHaveCount(10)
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Escape')
  await expect(candidates).toBeHidden()
  await composer.fill('')

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-v2-1440.png') })
  for (const width of [1024, 860]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(workbench).toBeVisible()
    const bounds = await workbench.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(bounds.scrollWidth, `${width}px 不应横向溢出`).toBeLessThanOrEqual(bounds.clientWidth + 1)
    await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/agent-p0-v2-${width}.png`) })
    if (width === 1024) {
      const backdrop = page.locator('.desktop-agent-panel-backdrop')
      await expect(backdrop).toBeVisible()
      await backdrop.click({ position: { x: 12, y: 12 } })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }
  }

  // IX-08：真实 429 错误事件渲染原因、request_id 与恢复动作。
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errorConversation = await api(page, 'POST', '/agent/conversations', {})
  await page.route(new RegExp(`/api/v1/agent/conversations/${errorConversation.id}/messages$`), (route) => route.fulfill({
    status: 429, contentType: 'application/json', headers: { 'X-Request-ID': 'req-e2e-rate-limit' },
    body: JSON.stringify({ error: { code: 'rate_limited', message: '请求过于频繁', request_id: 'req-e2e-rate-limit' } }),
  }))
  await page.goto(`/agent/c/${errorConversation.id}`)
  await page.getByRole('textbox', { name: '发送消息' }).fill('触发一次限流错误')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const errorCard = page.locator('.desktop-agent-error-card')
  await expect(errorCard).toContainText('请求过于频繁')
  await expect(errorCard).toContainText('请求 ID：req-e2e-rate-limit')
  await expect(errorCard.getByRole('button', { name: '稍后重试', exact: true })).toBeVisible()
  await expect(errorCard.getByRole('button', { name: '复制请求 ID', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-error-card.png') })

  // UI-10 断网态：详情请求被浏览器网络层中断，统一 StateBlock 显示“连接中断”。
  const offlineConversation = await api(page, 'POST', '/agent/conversations', {})
  await page.route(new RegExp(`/api/v1/agent/conversations/${offlineConversation.id}$`), (route) => route.abort('internetdisconnected'))
  await page.goto(`/agent/c/${offlineConversation.id}`)
  const offlineState = page.locator('.desktop-agent-state-error')
  await expect(offlineState).toContainText('连接中断')
  await expect(offlineState).toContainText('任务可能仍在运行，恢复连接后可继续查看')
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-state-offline.png') })

  // UI-01 权限门：viewer 邀请码账号进同一工作区，看到“观察者 · 只读”且发送禁用。
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 })
  const viewerContext = await browser.newContext({ baseURL: baseURL! })
  try {
    const joined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username: `p0-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok(), '通过邀请码注册 viewer').toBeTruthy()
    const viewer = await viewerContext.newPage()
    await viewer.addInitScript(() => {
      const userAgent = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    })
    await viewer.goto('/agent')
    const viewerPrivacy = viewer.getByRole('dialog').filter({ has: viewer.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await viewerPrivacy.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    if (await viewerPrivacy.isVisible()) await viewerPrivacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(viewerPrivacy).toBeHidden()
    await expect(viewer.locator('.desktop-agent-header')).toContainText('观察者 · 只读')
    await expect(viewer.getByRole('textbox', { name: '发送消息' })).toHaveAttribute('placeholder', /观察者可以提问/)
    await expect(viewer.getByRole('button', { name: /对话模式/ })).toBeDisabled()
    await viewer.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-observer-readonly.png') })
  } finally {
    await viewerContext.close()
  }

  // G-01：全局菜单回归由 Shell 源码守卫与 git diff 证明；这里留一张桌面壳截图。
  await page.goto('/')
  await expect(page.locator('body')).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-global-menu-1440.png') })
})

test('DEV-AI-39 P0 会话行与用量证据', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 })
  await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'P0 会话行模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  await page.getByRole('button', { name: '新对话', exact: true }).first().click()
  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill('#text 39 台账会话行验收')
  const sendResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await sendResponse).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)

  const row = page.locator('.desktop-agent-conv-row').first()
  await expect(row).toBeVisible()
  expect(Math.round((await row.boundingBox())!.height)).toBe(52)
  await expect(row).toHaveClass(/is-selected/)
  expect(await row.evaluate((element) => getComputedStyle(element).boxShadow)).toContain('inset')
  await expect(page.locator('.desktop-agent-usage-chip')).toBeVisible()
  const usageChipText = (await page.locator('.desktop-agent-usage-chip').textContent())?.trim() ?? ''
  expect(usageChipText, '头部用量 chip 为 k 格式而非原始数').toMatch(/^[\d.]+k?m?$/)
  await page.locator('.desktop-agent-usage-chip').click()
  const usage = page.getByRole('dialog', { name: '用量明细' })
  await expect(usage).toContainText('输入')
  await expect(usage).toContainText('输出')
  await expect(usage).toContainText('合计')
  await expect(usage).toContainText('按服务端记账')
  const usageRows = await usage.locator('.desktop-agent-usage-row strong').allTextContents()
  expect(usageRows.length).toBeGreaterThanOrEqual(3)
  expect(usageRows.every((text) => /^[\d,]+$/.test(text)), '明细为本地化整数，不显示金额').toBeTruthy()
  await page.keyboard.press('Escape')
  await expect(usage).toBeHidden()
  await expect(page.locator('.desktop-agent-header')).toBeVisible()
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-conversation-row-1680.png') })
})

test('DEV-AI-39 P0 四态证据', async ({ page }) => {
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  const conversation = await api(page, 'POST', '/agent/conversations', {})
  const detailPath = new RegExp(`/api/v1/agent/conversations/${conversation.id}$`)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(detailPath, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await gate
    await route.continue()
  })
  await page.goto(`/agent/c/${conversation.id}`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await privacy.isVisible()) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  await expect(page.locator('.desktop-agent-state-loading')).toContainText('正在加载对话')
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-state-loading.png') })
  release()
  await expect(page.locator('.desktop-agent-state-loading')).toHaveCount(0)

  await page.unroute(detailPath)
  await page.route(detailPath, (route) => route.fulfill({ status: 500, contentType: 'application/json', headers: { 'X-Request-ID': 'req-e2e-detail-500' }, body: JSON.stringify({ error: { code: 'internal', message: '模拟读取失败', request_id: 'req-e2e-detail-500' } }) }))
  await page.goto(`/agent/c/${conversation.id}`)
  await privacy.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await privacy.isVisible()) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  await expect(page.locator('.desktop-agent-state-error')).toContainText('服务暂时不可用')
  await expect(page.locator('.desktop-agent-state-error')).toContainText('模拟读取失败')
  await expect(page.locator('.desktop-agent-state-error')).toContainText('请求 ID')
  await expect(page.locator('.desktop-agent-state-error').getByRole('button', { name: '复制请求 ID', exact: true })).toBeVisible()
  await expect(page.locator('.desktop-agent-state-error').getByRole('button', { name: '重试', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-state-error.png') })
})

test('DEV-AI-39 P0 无模型态', async ({ page }) => {
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  await expect(page.locator('.desktop-agent-header-model-warning')).toContainText('模型未自检')
  await expect(page.locator('.desktop-agent-welcome-card')).toHaveCount(0)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeDisabled()
  expect(await send.evaluate((element) => getComputedStyle(element).opacity)).toBe('0.45')
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-no-model.png') })
})
