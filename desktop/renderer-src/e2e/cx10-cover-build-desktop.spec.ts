import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * DEV-CX10 / FR-CX-09：真实 Electron 客户端里生成多比例封面交付包。
 *
 * 与浏览器端同一契约，但跑的是桌面工作台：面板只给当前平台合法预设、低分辨率必须确认、
 * complete 仍停在 scanner_unverified，不置 built、不开放下载，也不新建派生图片。
 */

async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  return page.evaluate(async ({ url, method, data, csrf }) => {
    const response = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

/** 在渲染进程里用 canvas 生成 PNG 并作为作品图片上传，返回资产 id。 */
async function uploadCover(page: Page, origin: string, workId: string, width: number, height: number) {
  return page.evaluate(async ({ origin, workId, width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#2f6fed')
    gradient.addColorStop(1, '#f5a524')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(10, 10, 32, 32)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const me = await (await fetch(`${origin}/api/v1/auth/me`)).json()
    const form = new FormData()
    form.append('file', new File([blob], 'cover.png', { type: 'image/png' }))
    const response = await fetch(`${origin}/api/v1/works/${workId}/assets`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form })
    const body = await response.text()
    if (!response.ok) throw new Error(`upload asset: ${response.status} ${body}`)
    return (JSON.parse(body) as { id: string }).id
  }, { origin, workId, width, height })
}

const coverCrops = {
  '2.35_1': { x1: 0, y1: 0.1, x2: 1, y2: 0.6 },
  '1_1': { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
}

test('DEV-CX10 桌面多比例封面交付构建逐预设校验与隐私门禁', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx10-cover-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/register`)
    const username = `cx10-cover-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const account = await api(page, origin, 'POST', '/accounts', {
      platform: 'wechat_mp', name: 'CX10 桌面封面交付号', content_format: 'long_article',
    }) as { id: string }
    const work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: '桌面封面交付构建', content_format: 'long_article' }) as { id: string; revision: number }
    const viewed = await api(page, origin, 'PATCH', `/works/${work.id}`, {
      viewpoint: '桌面封面交付验收：两种 1:1 与 2.35:1 独立命名。', base_revision: work.revision,
    }) as { revision: number }
    const outlined = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      confirm: true, base_revision: viewed.revision,
      items: [{ heading: '封面预设', key_point: '多比例封面验收', material_ids: [] }],
    }) as { id: string }

    const panel = page.getByTestId('cover-build-panel')
    // 低分辨率：先拒绝放大，确认后才允许生成。
    const small = await uploadCover(page, origin, outlined.id, 500, 400)
    const smallCurrent = await api(page, origin, 'GET', `/works/${outlined.id}`) as { revision: number }
    await api(page, origin, 'PATCH', `/works/${outlined.id}`, { cover_asset_id: small, cover_crops: coverCrops, base_revision: smallCurrent.revision })
    await page.goto(`${origin}/works/${outlined.id}`)
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('cover-preset-options')).toContainText('900×383')
    await expect(panel.getByTestId('cover-preset-options')).not.toContainText('1080×1440')
    await expect(panel.getByText(/需要放大输出/)).toBeVisible()
    await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
    await expect(panel.getByText(/请确认接受放大后重试/)).toBeVisible()
    await panel.getByRole('checkbox', { name: /放大不会增加细节/ }).check()
    await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
    await expect(panel.getByText(/逐预设像素校验已完成/)).toBeVisible({ timeout: 30_000 })

    // 清晰封面：一次点击完成创建→上传→complete，条目名带平台与像素。
    const big = await uploadCover(page, origin, outlined.id, 1600, 1200)
    const current = await api(page, origin, 'GET', `/works/${outlined.id}`) as { revision: number }
    await api(page, origin, 'PATCH', `/works/${outlined.id}`, { cover_asset_id: big, cover_crops: coverCrops, base_revision: current.revision })
    await page.reload()
    await expect(panel).toBeVisible()
    await expect(panel.getByText(/需要放大输出/)).toHaveCount(0)
    const created = page.waitForResponse((r) => r.url().endsWith(`/works/${outlined.id}/builds`) && r.request().method() === 'POST')
    const completion = page.waitForResponse((r) => r.url().includes('/complete') && r.request().method() === 'POST')
    await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
    expect((await created).status()).toBe(201)
    const completionResponse = await completion
    expect(completionResponse.status()).toBe(503)
    expect(await completionResponse.text()).toContain('scanner_unverified')
    await expect(panel.getByTestId('cover-build-detail')).toContainText('cover-wechat_235-900x383.png 900×383')
    await expect(panel.getByTestId('cover-build-detail')).toContainText('cover-wechat_square-383x383.png 383×383')
    await expect(panel.getByTestId('cover-build-detail')).toContainText('scanner_unverified')
    await expect(panel.getByTestId('cover-build-detail')).toContainText('下载门禁：build_not_complete')

    const builds = await api(page, origin, 'GET', `/works/${outlined.id}/builds`) as { items: Array<{ id: string; status: string; error_code: string; is_current: boolean; targets: string[] }> }
    expect(builds.items[0]).toMatchObject({ status: 'failed', error_code: 'scanner_unverified', is_current: true, targets: ['cover_images'] })
    const detail = await api(page, origin, 'GET', `/builds/${builds.items[0].id}`) as {
      artifacts: Array<{ kind: string; downloadable: boolean }>
      validation: { covers: { count: number; entries: Array<{ name: string; width: number; height: number }> } }
      download_gate: { allowed: boolean; reason: string }
    }
    expect(detail.artifacts.map((item) => item.kind)).toEqual(['zip'])
    expect(detail.artifacts.every((item) => !item.downloadable)).toBe(true)
    expect(detail.download_gate).toMatchObject({ allowed: false, reason: 'build_not_complete' })
    expect(detail.validation.covers.count).toBe(2)
    expect(detail.validation.covers.entries.map((entry) => entry.name)).toEqual(['cover-wechat_235-900x383.png', 'cover-wechat_square-383x383.png'])
    expect(((await api(page, origin, 'GET', `/works/${outlined.id}`)) as { assets: unknown[] }).assets).toHaveLength(2)
  } finally {
    // Electron 在 Windows 上偶发不响应 close 握手，先 exit 再 close，避免 worker teardown 超时。
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
