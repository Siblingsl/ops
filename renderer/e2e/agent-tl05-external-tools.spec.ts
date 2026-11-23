import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// TL-05（docs/38 §14）：plugin_mcp 开启时能力中心单列外部工具，显示来源、权限、最近调用；
// 未启用连接与未通过 schema 白名单的工具不得出现；不泄露命令/地址/密钥/入参/结果。
async function localApi(page: Page, method: string, path: string, body?: unknown) {
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

test('TL-05 真实 Electron 能力中心：外部工具来源/权限/最近调用与白名单', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-tl05-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    const username = `tl05-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const bootstrap = await localApi(page, 'GET', '/agent/bootstrap')
    expect(bootstrap.features.plugin_mcp).toBe(true)
    expect(bootstrap.features.workbench_ui).toBe(true)

    // 真实连接：启用后目录包含支持/不支持基础 schema 的两类工具；只有支持者进白名单。
    const conn = await localApi(page, 'POST', '/agent/plugin-connections', {
      name: 'TL05 外部检索', transport: 'stdio', command: 'node',
      args: ['server.js'], env_keys: ['E2E_TOKEN'], cwd: 'F:\\secret\\tl05',
    }) as { id: string; revision: number }
    const enabled = await localApi(page, 'POST', `/agent/plugin-connections/${conn.id}/actions`, {
      action: 'enable', expected_revision: conn.revision,
      protocol_version: '2025-06-18', server_name: 'TL05 文档服务', server_version: '1.2.3',
      catalog_revision: 'tl05-e2e', tools_catalog: [
        { name: 'search_docs', description_hash: 'aa', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'list_docs', description_hash: 'bb', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
        { name: 'unsupported_docs', description_hash: 'cc', input_schema: { type: 'object', properties: { query: { anyOf: [] } } } },
      ],
    }) as { revision: number }
    expect(enabled.revision).toBeGreaterThan(conn.revision)

    const call = await localApi(page, 'POST', '/agent/plugin-calls', {
      connection_id: conn.id, request_id: crypto.randomUUID(), tool_name: 'search_docs',
      args: { query: 'TL05 E2E 入参不得展示' },
    }) as { id: string }
    await localApi(page, 'POST', `/agent/plugin-calls/${call.id}/receipt`, {
      state: 'succeeded', duration_ms: 37, result: { title: 'TL05 E2E 结果不得展示' },
    })

    // 已停用的连接必须从能力中心消失（行为门），即使目录里有工具。
    const off = await localApi(page, 'POST', '/agent/plugin-connections', {
      name: 'TL05 已停用连接', transport: 'stdio', command: 'node', args: ['off.js'], env_keys: [],
    }) as { id: string; revision: number }
    const offEnabled = await localApi(page, 'POST', `/agent/plugin-connections/${off.id}/actions`, {
      action: 'enable', expected_revision: off.revision, protocol_version: '2025-06-18',
      server_name: 'off-server', server_version: '0.1.0', catalog_revision: 'off-rev',
      tools_catalog: [{ name: 'hidden_docs', description_hash: 'dd', input_schema: { type: 'object', properties: {} } }],
    }) as { revision: number }
    await localApi(page, 'POST', `/agent/plugin-connections/${off.id}/actions`, {
      action: 'disable', expected_revision: offEnabled.revision,
    })

    await page.goto(`${baseURL}/settings/capabilities`)
    await expect(page.getByRole('heading', { name: '智能体能力', exact: true })).toBeVisible({ timeout: 15_000 })
    const section = page.getByTestId('agent-external-tools')
    await expect(section).toBeVisible()
    await section.scrollIntoViewIfNeeded()
    await expect(section.getByRole('heading', { name: '外部工具', exact: true })).toBeVisible()
    await expect(section).toContainText('只展示通过目录与参数 schema 校验的白名单工具')
    const rows = section.getByTestId('agent-external-tool')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'search_docs' })).toContainText('来源：TL05 外部检索 · 本机进程 · TL05 文档服务 v1.2.3')
    await expect(rows.filter({ hasText: 'search_docs' })).toContainText('权限：编辑及以上 · 结果仅生成，业务写入仍需逐卡确认')
    await expect(rows.filter({ hasText: 'search_docs' })).toContainText(/最近调用：成功 · 37ms/)
    await expect(rows.filter({ hasText: 'list_docs' })).toContainText('最近调用：尚无调用记录')
    await expect(section).not.toContainText('unsupported_docs')
    await expect(section).not.toContainText('TL05 已停用连接')
    await expect(section).not.toContainText('hidden_docs')

    const text = (await section.textContent()) ?? ''
    for (const leaked of ['server.js', 'off.js', 'E2E_TOKEN', 'F:\\secret\\tl05', 'TL05 E2E 入参不得展示', 'TL05 E2E 结果不得展示']) {
      expect(text).not.toContain(leaked)
    }

    mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-tl05-external-tools.png') })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    await rm(userData, { recursive: true, force: true }).catch(() => undefined)
  }
})
