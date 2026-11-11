import { _electron, expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), '../testdata/cx01-syntax-fixtures.json'), 'utf8')) as Array<{ name: string; markdown: string }>
const unsupportedFixture = fixtures.find(fixture => fixture.name === 'unsupported-markdown-syntax')!
const fingerprintFixture = JSON.parse(readFileSync(resolve(process.cwd(), '../testdata/deep02-artifact-fingerprint-fixture.json'), 'utf8')) as {
  title: string
  viewpoint: string
  heading: string
  key_point: string
  content_md: string
  content_md_changed: string
}
type TestWork = { id: string; revision: number; sections: Array<{ id: string; revision: number; content_md: string }> }

async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  const response = await page.evaluate(async ({ url, method, data, csrf }) => {
    const result = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await result.text()
    if (!result.ok) throw new Error(`${method} ${url}: ${result.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
  return response
}

async function launchElectron(baseURL: string, label: string) {
  const userData = await mkdtemp(join(tmpdir(), `ops-cx01-${label}-`))
  const app = await _electron.launch({
    executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL },
    timeout: 60_000,
  })
  return { app, userData, page: await app.firstWindow(), origin: baseURL }
}

async function disposeElectron(app: Awaited<ReturnType<typeof _electron.launch>> | undefined, userData: string) {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app?.close().catch(() => {})
  await rm(userData, { recursive: true, force: true })
}

test('真实 Electron 可查看公众号语法报告并定位问题段，检查不写入作品', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(120_000)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let userData = ''
  try {
    const launched = await launchElectron(baseURL!, 'render-check')
    app = launched.app
    userData = launched.userData
    const { page, origin } = launched
    await page.goto(`${origin}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`cx01-electron-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const account = await api(page, origin, 'POST', '/accounts', { platform: 'wechat_mp', name: 'Electron 语法检查旅程', content_format: 'long_article' }) as { id: string }
    let work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: 'Electron 语法检查旅程' }) as TestWork
    await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '引用需要能定位。', base_revision: work.revision })
    work = await api(page, origin, 'GET', `/works/${work.id}`) as TestWork
    work = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      items: [{ heading: '引用段', key_point: '检查脚注位置', material_ids: [] }],
      confirm: true,
      base_revision: work.revision,
    })
    const section = work.sections[0]
    const content = unsupportedFixture.markdown
    await api(page, origin, 'PATCH', `/sections/${section.id}`, { content_md: content, base_revision: section.revision })
    const before = await api(page, origin, 'GET', `/works/${work.id}`)

    await page.goto(`${origin}/works/${work.id}`)
    await page.getByRole('button', { name: '检查排版语法', exact: true }).click()
    await expect(page.getByText('发现不能可靠排版的语法', { exact: true })).toBeVisible()
    await expect(page.getByText(/第 1 行，第 3 列/).first()).toBeVisible()
    await expect(page.getByText(/定义列表/).first()).toBeVisible()
    await expect(page.getByText(/引用式链接/).first()).toBeVisible()
    await expect(page.getByText(/数学公式/).first()).toBeVisible()
    await expect(page.getByText(/Mermaid/).first()).toBeVisible()
    await page.getByRole('button', { name: '定位到第 1 段', exact: true }).first().click()
    await expect(page.locator(`#sec-${section.id}`)).toHaveClass(/flash/)

    const after = await api(page, origin, 'GET', `/works/${work.id}`)
    expect(after.revision).toBe(before.revision)
    expect(after.sections[0].content_md).toBe(content)
  } finally {
    await disposeElectron(app, userData)
  }
})

// DEEP-02：真实 Electron 窗口走 BuildPanel → complete；与 Web 共用 testdata 夹具断言指纹稳定性。
test('真实 Electron 构建 complete 在同一夹具下产物指纹一致，改稿后变化', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(180_000)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let userData = ''
  try {
    const launched = await launchElectron(baseURL!, 'fingerprint')
    app = launched.app
    userData = launched.userData
    const { page, origin } = launched
    await page.goto(`${origin}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`cx01-fp-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const account = await api(page, origin, 'POST', '/accounts', {
      platform: 'wechat_mp', name: 'Electron 指纹验收', content_format: 'long_article',
    }) as { id: string }
    let work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: fingerprintFixture.title }) as TestWork
    await api(page, origin, 'PATCH', `/works/${work.id}`, {
      viewpoint: fingerprintFixture.viewpoint, base_revision: work.revision,
    })
    work = await api(page, origin, 'GET', `/works/${work.id}`) as TestWork
    work = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      items: [{ heading: fingerprintFixture.heading, key_point: fingerprintFixture.key_point, material_ids: [] }],
      confirm: true,
      base_revision: work.revision,
    }) as TestWork
    const section = work.sections[0]
    await api(page, origin, 'PATCH', `/sections/${section.id}`, {
      content_md: fingerprintFixture.content_md, base_revision: section.revision,
    })
    await page.goto(`${origin}/works/${work.id}`)

    const panel = page.getByTestId('work-build-panel')
    await expect(panel).toBeVisible()
    // 桌面默认可勾长图；本用例只验 HTML 产物指纹，显式保持默认 wechat_html。
    const firstComplete = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
    const firstBody = await (await firstComplete).json() as { status: string; artifact_fingerprint: string; manifest: { artifact_fingerprint?: string } }
    expect(firstBody.status).toBe('built')
    expect(firstBody.artifact_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(firstBody.manifest.artifact_fingerprint).toBe(firstBody.artifact_fingerprint)

    const secondComplete = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '重新生成', exact: true }).click()
    const secondBody = await (await secondComplete).json() as { status: string; artifact_fingerprint: string; manifest: { artifact_fingerprint?: string } }
    expect(secondBody.status).toBe('built')
    expect(secondBody.artifact_fingerprint).toBe(firstBody.artifact_fingerprint)
    expect(secondBody.manifest.artifact_fingerprint).toBe(firstBody.artifact_fingerprint)

    const current = await api(page, origin, 'GET', `/works/${work.id}`) as TestWork
    await api(page, origin, 'PATCH', `/sections/${section.id}`, {
      content_md: fingerprintFixture.content_md_changed, base_revision: current.sections[0].revision,
    })
    const changedComplete = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '重新生成', exact: true }).click()
    const changedBody = await (await changedComplete).json() as { status: string; artifact_fingerprint: string }
    expect(changedBody.status).toBe('built')
    expect(changedBody.artifact_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(changedBody.artifact_fingerprint).not.toBe(firstBody.artifact_fingerprint)
  } finally {
    await disposeElectron(app, userData)
  }
})
