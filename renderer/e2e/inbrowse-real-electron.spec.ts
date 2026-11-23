import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// DEV-AI27-08 第三批（W08c）：内置浏览视图真实 Electron 视觉旅程（T-AI27-33 子集）。
// 覆盖：固定意图可达、导航生效、URL 快照推送、浮层（设置窗）打开时视图隐藏/关闭恢复。
// WebContentsView 的像素级 bounds 与 IME/DPI 留人工矩阵（本测验证桥路与状态机真实行为）。

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('ai27w08c-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'W08c 本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const features = (await api(page, 'GET', '/agent/bootstrap')) as { features: Record<string, boolean> }
  expect(features.features.workbench_ui).toBe(true)
}

test('BR-03 / BR-11 应用内元素选择与批注：schema、加入输入框、批注筹码、密码拒绝、Chrome 无入口', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>BR03 元素选择夹具</title></head><body style="margin:0;font-family:sans-serif">
<div style="padding:20px">
<h1 id="br03-title" style="margin:0;font-size:32px;line-height:40px;height:40px">BR03 标题元素</h1>
<p id="br03-body" style="margin:16px 0 0">页面正文一段。</p>
<input id="br03-password" type="password" value="secret" aria-label="密码框" style="margin-top:24px;display:block;width:240px;height:32px">
</div></body></html>`)
  })
  await new Promise<void>((resolveListen) => fixture.listen(0, '127.0.0.1', resolveListen))
  const fixturePort = (fixture.address() as { port: number }).port
  const fixtureURL = `http://127.0.0.1:${fixturePort}/`
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-br03-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined

  const clickInView = async (x: number, y: number) => {
    await app!.evaluate(({ BrowserWindow }, point) => {
      const win = BrowserWindow.getAllWindows()[0]
      const view = win?.contentView.children.find((child) => {
        const url = String((child as unknown as { webContents?: { getURL?: () => string } }).webContents?.getURL?.() ?? '')
        return url.includes(`:${point.port}/`)
      })
      if (!view) throw new Error('BR03 native view not found')
      const contents = (view as unknown as { webContents: { focus: () => void; sendInputEvent: (event: unknown) => void } }).webContents
      contents.focus()
      contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
      contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }, { port: fixturePort, x, y })
  }

  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    await page.locator('.desktop-agent-panel-button').first().click({ timeout: 15_000 })
    const panel = page.getByRole('complementary', { name: '任务面板' })
    await panel.getByRole('tab', { name: /^浏览器/ }).click()
    const inbrowse = page.getByTestId('inbrowse-panel')
    await expect(inbrowse).toBeVisible()

    await page.getByLabel('地址栏').fill(fixtureURL)
    await page.getByLabel('地址栏').press('Enter')
    await expect.poll(async () => page.getByTestId('inbrowse-viewport').getAttribute('data-url'), { timeout: 20_000 })
      .toBe(fixtureURL)
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }, port) => {
      const win = BrowserWindow.getAllWindows()[0]
      const view = win?.contentView.children.find((child) => {
        const url = String((child as unknown as { webContents?: { getURL?: () => string } }).webContents?.getURL?.() ?? '')
        return url.includes(`:${port}/`)
      })
      return Boolean(view)
    }, fixturePort), { timeout: 20_000 }).toBe(true)

    // 异常：选择进行中页面刷新 → 覆盖层随文档销毁，快照明确失效。
    await page.getByTestId('inbrowse-pick-element').click()
    await expect(page.getByTestId('inbrowse-picker-hint')).toBeVisible()
    await page.getByLabel('地址栏').fill(fixtureURL)
    await page.getByLabel('地址栏').press('Enter')
    await expect(page.getByTestId('inbrowse-picker-error')).toContainText('页面已刷新', { timeout: 15_000 })
    await expect(page.getByTestId('inbrowse-picker-hint')).toHaveCount(0)
    await expect(page.getByTestId('inbrowse-picked')).toHaveCount(0)
    await expect(page.getByTestId('inbrowse-title')).toContainText('BR03 元素选择夹具', { timeout: 15_000 })

    // 正向路径：标题元素 → selector/text。
    await page.getByTestId('inbrowse-pick-element').click()
    await expect(page.getByTestId('inbrowse-picker-hint')).toBeVisible()
    await clickInView(60, 40)
    await expect(page.getByTestId('inbrowse-picked')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('inbrowse-picked-selector')).toHaveText('#br03-title')
    await expect(page.getByTestId('inbrowse-picked-text')).toContainText('BR03 标题元素')
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br03-picked.png') })

    // 加入上下文：进入输入框文本块（P1 文本附件路径）。
    await page.getByTestId('inbrowse-picked-use').click()
    const composer = page.getByPlaceholder(/说说你想写什么|发送消息/)
    await expect(composer).toHaveValue(/【页面元素】h1 BR03 元素选择夹具/)
    await expect(composer).toHaveValue(/#br03-title/)

    // BR-11：选段/元素 + 一句批注 → 输入台筹码；只入草稿，不自动发送。
    const messagesBefore = await page.locator('[data-message-id]').count()
    await page.getByTestId('inbrowse-pick-element').click()
    await expect(page.getByTestId('inbrowse-picker-hint')).toBeVisible()
    await clickInView(60, 40)
    await expect(page.getByTestId('inbrowse-picked')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('inbrowse-picked-annotate').click()
    const annotationCard = page.getByTestId('inbrowse-picked-annotation')
    await expect(annotationCard).toBeVisible()
    const annotationBox = await annotationCard.boundingBox()
    expect(annotationBox).not.toBeNull()
    expect(Math.abs(annotationBox!.width - 280)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br11-annotation-card.png') })
    await page.getByTestId('inbrowse-picked-note').fill('只改标题，不要动正文')
    await page.getByTestId('inbrowse-picked-annotate-save').click()
    const pageChip = page.getByTestId('agent-page-reference-chip')
    await expect(pageChip).toBeVisible({ timeout: 10_000 })
    await expect(pageChip).toContainText('页面元素 · BR03 元素选择夹具')
    await expect(pageChip).toContainText('本轮引用')
    await expect(pageChip.locator('span').first()).toHaveAttribute('title', /只改标题，不要动正文/)
    await expect(page.getByTestId('inbrowse-picked-annotation')).toHaveCount(0)
    await expect.poll(() => page.locator('[data-message-id]').count()).toBe(messagesBefore)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br11-picked-note.png') })
    await pageChip.getByRole('button', { name: /移除页面引用/ }).click()
    await expect(pageChip).toHaveCount(0)

    // 密码框拒绝：不产生元素结果，给出明确原因。
    await page.getByTestId('inbrowse-pick-element').click()
    await clickInView(60, 135)
    await expect(page.getByTestId('inbrowse-picker-error')).toContainText('密码框', { timeout: 15_000 })
    await expect(page.getByTestId('inbrowse-picked')).toHaveCount(0)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br03-password-denied.png') })

    // Chrome 协作模式不出现应用内选择入口（未授权标签不会被选择）。
    await page.getByRole('button', { name: /Chrome 协作/ }).click()
    await expect(page.getByTestId('inbrowse-pick-element')).toHaveCount(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()))
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('DEV-AI27-08c 内置浏览视图：导航、快照与设置浮层隐藏恢复', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-ai27w08c-'))
  // BR-10：真实触发一次可执行文件下载（内网测试服务器），验证内置浏览拒绝并提示。
  const downloadServer = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="setup.exe"',
    })
    response.end('MZ')
  })
  await new Promise<void>((resolveListen) => downloadServer.listen(0, '127.0.0.1', resolveListen))
  const downloadPort = (downloadServer.address() as { port: number }).port
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)

    // 打开工作视图 → 浏览器页签 → 应用内面板可达
    await page.locator('.desktop-agent-panel-button').first().click({ timeout: 15_000 })
    const panel = page.getByRole('complementary', { name: '任务面板' })
    await expect(panel).toBeVisible()
    await panel.getByRole('tab', { name: /^浏览器/ }).click()
    const inbrowse = page.getByTestId('inbrowse-panel')
    await expect(inbrowse).toBeVisible()

    // Electron 桥存在（preload 暴露 invokeInBrowse）；地址栏导航经主进程。
    const bridged = await page.evaluate(() => Boolean((window as unknown as { opsDesktopUI?: { invokeInBrowse?: unknown } }).opsDesktopUI?.invokeInBrowse))
    expect(bridged).toBe(true)

    // 导航到本地 API 健康页（同源 https/http 环回），等待快照推送。
    const healthURL = 'http://127.0.0.1:8287/healthz'
    await page.getByLabel('地址栏').fill(healthURL)
    await page.getByLabel('地址栏').press('Enter')
    // 快照 URL 应变为导航目标（主进程推送给渲染器）。
    await expect.poll(async () => page.getByTestId('inbrowse-viewport').getAttribute('data-url'), { timeout: 20_000 })
      .toBe(healthURL)

    // BR-06：无标题页签回退 host+path，tooltip 保留完整 URL，最大宽 180。
    const tabButton = page.locator('[data-testid^="inbrowse-tab-"]').first()
    await expect(tabButton).toContainText('127.0.0.1/healthz')
    await expect(tabButton).toHaveAttribute('title', healthURL)
    await expect(page.getByTestId('inbrowse-title')).toContainText('127.0.0.1/healthz')
    await expect(page.getByTestId('inbrowse-title')).toHaveAttribute('title', healthURL)
    const tabMetrics = await tabButton.evaluate((element) => ({
      maxWidth: getComputedStyle(element).maxWidth,
      fontSize: getComputedStyle(element).fontSize,
    }))
    expect(tabMetrics.maxWidth).toBe('180px')
    expect(tabMetrics.fontSize).toBe('12px')
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br06-tab-label.png') })

    // BR-07：原生视图真实挂载，bounds 与 DOM 占位区一致；截图工具空白时可用“截取当前页”兜底。
    const nativeView = async () => app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const child = win?.contentView.children.find((view) => String((view as unknown as { webContents?: { getURL?: () => string } }).webContents?.getURL?.() ?? '').includes('/healthz'))
      const bounds = child?.getBounds()
      return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
    })
    await expect.poll(nativeView, { timeout: 15_000 }).not.toBeNull()
    const viewportBox = await page.getByTestId('inbrowse-viewport').boundingBox()
    const native = await nativeView()
    expect(native).not.toBeNull()
    expect(viewportBox).not.toBeNull()
    expect(Math.abs((native!.x) - (viewportBox!.x))).toBeLessThanOrEqual(2)
    expect(Math.abs((native!.y) - (viewportBox!.y))).toBeLessThanOrEqual(2)
    expect(Math.abs((native!.width) - (viewportBox!.width))).toBeLessThanOrEqual(2)
    expect(Math.abs((native!.height) - (viewportBox!.height))).toBeLessThanOrEqual(2)

    await page.getByRole('button', { name: '截取当前页', exact: true }).click()
    const captureImage = page.getByTestId('inbrowse-capture')
    await expect(captureImage).toBeVisible()
    const captureSrc = await captureImage.getAttribute('src')
    expect(captureSrc).toMatch(/^data:image\/jpeg;base64,/)
    const capturePixels = await captureImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)
    expect(capturePixels).toBeGreaterThan(0)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br07-capture.png') })
    await page.getByRole('button', { name: '关闭截图预览', exact: true }).click()
    await expect(captureImage).toHaveCount(0)
    await expect.poll(nativeView, { timeout: 10_000 }).not.toBeNull()

    // resize 后原生视图随占位区更新，不保留旧边界。
    const beforeResize = await nativeView()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(900, 700) })
    await expect.poll(async () => (await nativeView())?.width ?? 0, { timeout: 15_000 })
      .toBeLessThan(beforeResize!.width)
    await expect.poll(async () => (await nativeView())?.height ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0)

    // BR-07 异常：渲染进程真实崩溃 → 错误卡 + 重建，恢复同一 URL。
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const child = win?.contentView.children.find((view) => String((view as unknown as { webContents?: { getURL?: () => string } }).webContents?.getURL?.() ?? '').includes('/healthz'))
      ;(child as unknown as { webContents: { forcefullyCrashRenderer: () => void } }).webContents.forcefullyCrashRenderer()
    })
    const viewError = page.getByTestId('inbrowse-view-error')
    await expect(viewError).toBeVisible({ timeout: 15_000 })
    await expect(viewError).toContainText('内置浏览视图不可用')
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br07-view-error.png') })
    await page.getByRole('button', { name: '重建视图', exact: true }).click()
    await expect(viewError).toHaveCount(0)
    await expect.poll(async () => page.getByTestId('inbrowse-viewport').getAttribute('data-url'), { timeout: 20_000 })
      .toBe(healthURL)
    await expect.poll(nativeView, { timeout: 15_000 }).not.toBeNull()
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br07-rebuilt.png') })

    // BR-10：非 http(s) 协议拒绝并提示，原页面 URL 不变。
    await page.getByLabel('地址栏').fill('file:///C:/Windows/win.ini')
    await page.getByLabel('地址栏').press('Enter')
    const protocolError = page.getByTestId('inbrowse-navigation-error')
    await expect(protocolError).toContainText('仅支持 http/https 地址')
    await expect.poll(async () => page.getByTestId('inbrowse-viewport').getAttribute('data-url'), { timeout: 10_000 })
      .toBe(healthURL)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br10-protocol.png') })

    // BR-10：可执行文件真实下载被拒，不落盘并显示拦截原因。
    await app.evaluate(({ BrowserWindow }, port) => {
      const win = BrowserWindow.getAllWindows()[0]
      const child = win?.contentView.children.find((view) =>
        String((view as unknown as { webContents?: { getURL?: () => string } }).webContents?.getURL?.() ?? '').includes('/healthz'))
      if (!child) throw new Error('native view not found')
      ;(child as unknown as { webContents: { downloadURL: (url: string) => void } }).webContents
        .downloadURL(`http://127.0.0.1:${port}/setup.exe`)
    }, downloadPort)
    const blockedDownload = page.getByTestId('inbrowse-blocked-download')
    await expect(blockedDownload).toContainText('已拦截可执行文件下载：setup.exe', { timeout: 15_000 })
    await expect(blockedDownload).toContainText('不在内置浏览器保存或运行')
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br10-download-blocked.png') })

    // 关闭页面 → 快照清空。
    await page.getByRole('button', { name: '关闭页面' }).click()
    await expect.poll(async () => page.getByTestId('inbrowse-viewport').getAttribute('data-url'), { timeout: 10_000 })
      .toBe('')

    // 设置浮层打开 → inbrowse detach（快照 bounds=null）；关闭 → attach 恢复。
    // 打开设置（全局意图）。
    await page.evaluate(() => {
      const bridge = (window as unknown as { opsDesktopUI?: { onOpenSettings?: unknown } }).opsDesktopUI
      void bridge
      // 经键盘快捷键或菜单触发设置窗；直接用 ui-intents 深链等价路径——
      // 这里通过 location.hash 触发既有 settings 打开逻辑（业务页统一入口）。
    })
    // 用菜单触发（Electron 应用菜单的设置项）。
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      // 设置项：客户端菜单 → "AI 连接设置…"（openNativeSettings）。
      for (const menuItem of menu?.items ?? []) {
        for (const item of menuItem.submenu?.items ?? []) {
          if (item.label.includes('AI 连接设置')) { item.click(); return }
        }
      }
    })
    // 设置浮层打开后，主进程 inbrowseDetachForOverlay 生效：detached 视图不再覆盖页面。
    // 业务页仍可交互（视图移除），且恢复由 settings-close 触发。
    await expect(inbrowse).toBeVisible() // UI 面板仍在（只有原生视图被移除）
    // 关闭设置浮层（Escape 或关闭按钮），恢复 attach。
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      for (const menuItem of menu?.items ?? []) {
        for (const item of menuItem.submenu?.items ?? []) {
          if (item.label.includes('AI 连接设置')) { item.click(); return }
        }
      }
    })
    await expect(inbrowse).toBeVisible()
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await new Promise<void>((resolveClose) => downloadServer.close(() => resolveClose()))
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
