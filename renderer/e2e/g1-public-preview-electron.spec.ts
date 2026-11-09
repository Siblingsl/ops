import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

async function api(page: import('@playwright/test').Page, _origin: string, method: string, path: string, data?: unknown) {
  const result = await page.evaluate(async ({ method, path, data }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch(`/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    return { ok: response.ok, status: response.status, text: await response.text() }
  }, { method, path, data })
  expect(result.ok, `${method} ${path} (${result.status}): ${result.text}`).toBeTruthy()
  return JSON.parse(result.text)
}

async function registerDesktopAccount(page: import('@playwright/test').Page, origin: string, username: string) {
  await page.goto(`${origin}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(async () => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  return await api(page, origin, 'POST', '/accounts', {
    platform: 'wechat_mp', name: '浏览器验收号', content_format: 'long_article',
  }) as { id: string }
}

test('DEV-QA26 G1-04 真实 Electron 创建公众号分享、匿名只读与作品图片隔离', async ({ baseURL, browser }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景只允许连接本地开发 E2E API')
  test.skip(process.env.OPS_QA26_G104 !== '1', '该验收只在专用 QA26 配置中运行')
  test.setTimeout(180_000)

  const journeyStarted = performance.now()
  const origin = baseURL ?? 'http://127.0.0.1:5487'
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g104-electron-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(origin)
    const account = await registerDesktopAccount(page, origin, `qa26-g104-${Date.now()}-${test.info().repeatEachIndex}`)
    const work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: 'G1-04 公众号分享验收' })
    await api(page, origin, 'PATCH', `/works/${work.id}`, {
      viewpoint: '这段内容用于验证公开分享、图片范围与只读展示。', base_revision: work.revision,
    })
    await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      items: [{ heading: '公开预览正文', key_point: '匿名读者只看作品排版', material_ids: [] }], confirm: true,
    })
    const current = await api(page, origin, 'GET', `/works/${work.id}`)
    const me = await api(page, origin, 'GET', '/auth/me')
    const pngData = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      const context = canvas.getContext('2d')!
      context.fillStyle = '#2F5D62'
      context.fillRect(0, 0, 16, 16)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const uploaded = await page.evaluate(async ({ workId, pngData, csrfToken }) => {
      const bytes = Uint8Array.from(atob(pngData), character => character.charCodeAt(0))
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'image/png' }), 'g1-04-preview.png')
      const response = await fetch(`/api/v1/works/${workId}/assets`, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: form,
      })
      return { ok: response.ok, status: response.status, text: await response.text() }
    }, { workId: work.id, pngData, csrfToken: me.csrf_token })
    expect(uploaded.ok, `image upload (${uploaded.status}): ${uploaded.text}`).toBeTruthy()
    const asset = JSON.parse(uploaded.text) as { id: string }
    await api(page, origin, 'PATCH', `/sections/${current.sections[0].id}`, {
      content_md: `匿名页面仅公开当前作品图片。\n\n![一张公众号配图](/api/v1/assets/${asset.id}/file)`,
      base_revision: current.sections[0].revision,
    })
    await api(page, origin, 'PUT', `/accounts/${account.id}/custom-theme`, {
      base: 'ink', primary_color: '#2F5D62', font_size: 16, line_height: 1.8,
      paragraph_gap: 18, heading_style: 'underline', quote_style: 'bar',
    })
    const themed = await api(page, origin, 'GET', `/works/${work.id}`)
    await api(page, origin, 'PATCH', `/works/${work.id}`, { theme: 'custom', base_revision: themed.revision })

    await page.goto(`${origin}/works/${work.id}/preview`)
    await expect(page.getByTestId('wechat-rendered-html')).toContainText('公开预览正文')
    const createButton = page.getByRole('button', { name: '生成手机扫码预览', exact: true })
    const failMessage = 'QA26 分享服务暂不可用'
    let injectFailure = true
    await page.route(`**/api/v1/works/${work.id}/preview-link`, async (route) => {
      if (route.request().method() === 'POST' && injectFailure) {
        injectFailure = false
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'qa26_preview_unavailable', message: failMessage } }),
        })
      } else await route.continue()
    })
    const failedCreate = page.waitForResponse(response => response.url().endsWith(`/works/${work.id}/preview-link`) && response.request().method() === 'POST')
    await createButton.click()
    expect((await failedCreate).status()).toBe(503)
    await expect(page.getByText(failMessage, { exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: '手机扫码预览二维码' })).toHaveCount(0)
    await page.unroute(`**/api/v1/works/${work.id}/preview-link`)

    const clickLatencies: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now()
      const created = page.waitForResponse(response => response.url().endsWith(`/works/${work.id}/preview-link`) && response.request().method() === 'POST')
      await createButton.click()
      expect((await created).status()).toBe(200)
      await expect(createButton).toBeEnabled()
      await expect(page.getByRole('img', { name: '手机扫码预览二维码' })).toBeVisible()
      await expect(page.getByRole('link', { name: '打开手机预览', exact: true })).toBeVisible()
      await expect(page.getByText(/24 小时后过期/)).toBeVisible()
      clickLatencies.push(performance.now() - started)
    }
    const sortedLatencies = [...clickLatencies].sort((a, b) => a - b)
    const percentile = (p: number) => sortedLatencies[Math.ceil(p * sortedLatencies.length) - 1]
    console.log('QA26 G1-04 Electron share clicks', JSON.stringify({
      count: clickLatencies.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
      samples_ms: clickLatencies.map(value => Number(value.toFixed(2))),
    }))

    const link = await page.getByRole('link', { name: '打开手机预览', exact: true }).getAttribute('href')
    expect(link).toBeTruthy()
    const token = new URL(link!).pathname.split('/').pop()!
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/)

    const anonymous = await browser.newContext({ baseURL: origin })
    try {
      expect((await anonymous.request.get(`${origin}/api/v1/auth/me`)).status()).toBe(401)
      const anonymousCreate = await anonymous.request.post(`${origin}/api/v1/works/${work.id}/preview-link`, { data: {} })
      expect(anonymousCreate.status()).toBe(401)

      const previewResponse = await anonymous.request.get(`${origin}/api/v1/public-previews/${token}`)
      expect(previewResponse.status()).toBe(200)
      expect(previewResponse.headers()['cache-control']).toBe('no-store')
      expect(previewResponse.headers()['referrer-policy']).toBe('no-referrer')
      const payload = await previewResponse.json()
      expect(payload).toMatchObject({ title: 'G1-04 公众号分享验收', account_name: '浏览器验收号', theme: 'custom' })
      expect(payload).not.toHaveProperty('status')
      expect(payload).not.toHaveProperty('wechat_fields')

      const preview = await anonymous.newPage()
      await preview.goto(link!)
      await expect(preview.getByRole('heading', { name: 'G1-04 公众号分享验收', exact: true })).toBeVisible()
      await expect(preview.getByText('浏览器验收号', { exact: true })).toBeVisible()
      await expect(preview.getByTestId('wechat-rendered-html')).toContainText('匿名页面仅公开当前作品图片。')
      const publicImage = preview.getByTestId('wechat-rendered-html').locator('img')
      await expect(publicImage).toHaveAttribute('alt', '一张公众号配图')
      await expect.poll(() => publicImage.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBeTruthy()
      await expect(preview.getByTestId('wechat-rendered-html').locator('h2').evaluate(el => getComputedStyle(el).borderBottomColor)).resolves.toBe('rgb(47, 93, 98)')
      await expect(preview.locator('button, input, textarea, select, form')).toHaveCount(0)

      const allowedAsset = await anonymous.request.get(`${origin}/api/v1/public-previews/${token}/assets/${asset.id}`)
      expect(allowedAsset.status()).toBe(200)
      expect(allowedAsset.headers()['cache-control']).toBe('no-store')

      const otherWork = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: 'G1-04 另一篇公众号作品' })
      const otherLink = await api(page, origin, 'POST', `/works/${otherWork.id}/preview-link`)
      const crossWorkAsset = await anonymous.request.get(`${origin}/api/v1/public-previews/${otherLink.token}/assets/${asset.id}`)
      expect(crossWorkAsset.status()).toBe(404)

      const otherWorkspace = await api(page, origin, 'POST', '/workspaces', { name: 'G1-04 分享隔离工作区', switch: true })
      const otherAccount = await api(page, origin, 'POST', '/accounts', {
        platform: 'wechat_mp', name: '另一个工作区公众号', content_format: 'long_article',
      })
      const isolatedWork = await api(page, origin, 'POST', `/accounts/${otherAccount.id}/works`, { title: 'G1-04 隔离工作区作品' })
      const isolatedLink = await api(page, origin, 'POST', `/works/${isolatedWork.id}/preview-link`)
      const crossWorkspaceAsset = await anonymous.request.get(`${origin}/api/v1/public-previews/${isolatedLink.token}/assets/${asset.id}`)
      expect(crossWorkspaceAsset.status()).toBe(404)
      expect(otherWorkspace.id).toBeTruthy()

      const [payloadPart, signaturePart] = token.split('.')
      const changedSignature = `${signaturePart[0] === 'A' ? 'B' : 'A'}${signaturePart.slice(1)}`
      const invalidToken = `${payloadPart}.${changedSignature}`
      expect((await anonymous.request.get(`${origin}/api/v1/public-previews/${invalidToken}`)).status()).toBe(404)
      await preview.goto(`${origin}/preview/${invalidToken}`)
      await expect(preview.getByText('预览链接无效或作品已删除。', { exact: true })).toBeVisible()
      await expect(preview.getByRole('heading', { name: 'G1-04 公众号分享验收', exact: true })).toHaveCount(0)
    } finally {
      await anonymous.close()
    }

    console.log('QA26 G1-04 Electron journey', JSON.stringify({ duration_ms: Number((performance.now() - journeyStarted).toFixed(2)) }))
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !basename(profile).startsWith('ops-qa26-g104-electron-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
