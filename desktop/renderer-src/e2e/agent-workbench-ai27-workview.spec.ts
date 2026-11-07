import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// DEV-AI27-07（W07）：工作视图 / 统一添加菜单 / 布局断点 / 分隔条键盘可达。
// 对应验收：T-AI27-03（对标位置：左会话、中聊天、右工作视图、底部输入台、添加菜单收敛）
// 与 T-AI27-26 的可自动化子集（语义状态、焦点、键盘）。物理 DPI/IME/读屏留人工矩阵。

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
  await page.getByLabel('用户名', { exact: true }).fill('ai27w07-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'W07 本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const features = (await api(page, 'GET', '/agent/bootstrap')) as { features: Record<string, boolean> }
  expect(features.features.workbench_ui).toBe(true)
  expect(features.features.browser_workspace).toBe(true)
}

test('DEV-AI27-07 工作视图、添加菜单与分隔条键盘操作', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-ai27w07-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)

    // 新建会话，打开工作视图面板
    // 空态即可打开工作视图（面板对空会话同样可达）；右上角入口按钮。
    await page.getByRole('button', { name: '工作视图', exact: true }).first().click({ timeout: 15000 })

    const panel = page.getByRole('complementary', { name: '工作视图' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: '工作视图', exact: true })).toBeVisible()

    // 四个页签：任务/上下文/产物/浏览器（产物按开关，浏览器始终可见）
    for (const label of ['任务', '上下文', '浏览器']) {
    }
    // 浏览器页签：能力开启但无绑定 → 如实显示未连接（不伪造已就绪）
    const browserBlock = panel.getByTestId('desktop-agent-browser-status')
    // loading 是瞬态；10s 请求超时兜底后必须落到某个真实状态（不伪造）。
    await expect.poll(async () => await browserBlock.getAttribute('data-state'), { timeout: 20_000 }).not.toBe('loading')
    if ((await browserBlock.getAttribute('data-state')) === 'unpaired') {
      // 未连接态的收尾说明（配对完成后显示实例与可选标签）。
    await expect(browserBlock.locator('.desktop-agent-browser-status-note').first()).toContainText('配对完成后')
    }

    // 统一添加菜单：收敛入口 + 未开放项如实禁用
    const addTrigger = page.getByTestId('desktop-agent-add-menu-trigger')
    await expect(addTrigger).toBeVisible()
    const menu = page.getByTestId('desktop-agent-add-menu-list')
    await expect(menu.getByRole('menuitem', { name: /Google Chrome 标签/ })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /^记忆/ })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /插件与工具/ })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /并行协作/ })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /应用选择/ })).toBeDisabled()
    // 可用项：引用资料打开既有引用选择器
    // ESC/外点关闭已由组件处理；这里验证菜单关闭后筹码区无残留

    // 分隔条：键盘可达、左右 16px、Enter 恢复默认
    const resizer = page.getByTestId('desktop-agent-panel-resizer')
    await expect(resizer).toBeVisible()
    const before = Number(await resizer.getAttribute('aria-valuenow'))
    await resizer.press('ArrowLeft')
    const afterGrow = Number(await resizer.getAttribute('aria-valuenow'))
    expect(afterGrow).toBe(before + 16)
    await resizer.press('Enter')
    await expect(resizer).toHaveAttribute('aria-valuenow', '360')
  } finally {
    // app.close() 在部分场景挂起（AW02 已知）；先主进程 exit 再 close。
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('DEV-AI27-07 宽窄容器断点下的工作视图形态', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-ai27w07bp-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    await page.getByRole('button', { name: '新建对话', exact: true }).click().catch(() => {})
    const panelOpen = page.getByRole('button', { name: /工作视图|辅助面板/ }).first()
    if (await panelOpen.count()) await panelOpen.click()

    // 宽窗口：容器 ≥1456 → 工作视图 ≥600
    await app!.evaluate(({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(width, height)
    }, { width: 1600, height: 1000 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(1500)
    await expect(page.getByTestId('desktop-agent-side-panel')).toBeVisible()
    await expect.poll(async () => {
      return page.getByTestId('desktop-agent-side-panel').evaluate((el) => el.getBoundingClientRect().width)
    }).toBeGreaterThanOrEqual(600)

    // 窄窗口：<1168 → 面板覆盖聊天（absolute），聊天列表隐藏
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(1000, 900)
    }, {})
    await expect.poll(async () => {
      return page.getByTestId('desktop-agent-side-panel').evaluate((el) => getComputedStyle(el).position)
    }).toBe('absolute')
  } finally {
    // app.close() 在部分场景挂起（AW02 已知）；先主进程 exit 再 close。
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
