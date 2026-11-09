import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  return page.evaluate(async ({ url, method, data, csrf }) => {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

test('DEV-QA26 G2-09 真实 Electron 图片库搜索、取消、替代文字保存与跨作品复用', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(150_000)

  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-g2-images-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${origin}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-images-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const account = await api(page, origin, 'POST', '/accounts', {
      platform: 'xhs', name: 'QA26 图片库验收号', content_format: 'image_note',
    }) as { id: string }
    const source = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: '图库来源作品' }) as { id: string }
    const target = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: '图库复用目标' }) as { id: string }
    await page.goto(`${origin}/images`)
    await expect(page.getByText('图片库还是空的', { exact: true })).toBeVisible()

    await page.goto(`${origin}/works/${source.id}`)
    const picker = page.locator('input[type="file"][accept="image/*"][multiple]')
    await expect(picker).toBeAttached()
    const pngs = await page.evaluate(async () => {
      const encode = async (color: string) => {
        const canvas = document.createElement('canvas')
        canvas.width = 96
        canvas.height = 96
        const context = canvas.getContext('2d')!
        context.fillStyle = color
        context.fillRect(0, 0, 96, 96)
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'))
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary)
      }
      return [await encode('#3b82f6'), await encode('#f59e0b')]
    })
    const uploaded = [
      { name: 'library-blue.png', mimeType: 'image/png', buffer: Buffer.from(pngs[0], 'base64') },
      { name: 'library-amber.png', mimeType: 'image/png', buffer: Buffer.from(pngs[1], 'base64') },
    ]
    const uploads = [
      page.waitForResponse((response) => response.url().includes(`/works/${source.id}/assets`) && response.request().method() === 'POST'),
      page.waitForResponse((response) => response.url().includes(`/works/${source.id}/assets`) && response.request().method() === 'POST'),
    ]
    await picker.setInputFiles(uploaded)
    expect((await Promise.all(uploads)).map((response) => response.status()).sort()).toEqual([200, 200])
    const sourceAfterUpload = await api(page, origin, 'GET', `/works/${source.id}`) as { assets: Array<{ id: string; alt_text: string }> }
    expect(sourceAfterUpload.assets).toHaveLength(2)

    await page.goto(`${origin}/works/${target.id}`)
    const journeyStarted = performance.now()
    await page.getByRole('button', { name: '从图片库选择', exact: true }).click()
    const editorLibrary = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '从图片库选择', exact: true }) })
    await expect(editorLibrary.getByRole('button', { name: /图库来源作品/ })).toHaveCount(2)
    await editorLibrary.getByRole('button', { name: '打开完整图片库', exact: true }).click()
    await expect(page).toHaveURL(`${origin}/images?target_work=${target.id}`)
    const grid = page.getByTestId('desktop-image-grid')
    await expect(grid.locator(':scope > button')).toHaveCount(2)
    const search = page.getByRole('textbox', { name: '搜索图片描述' })
    const latencies: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const query = index % 2 === 0 ? '图库来源作品' : '没有匹配的图片'
      const started = performance.now()
      await search.fill(query)
      if (index % 2 === 0) await expect(grid.locator(':scope > button')).toHaveCount(2)
      else await expect(page.getByText('没有符合条件的图片', { exact: true })).toBeVisible()
      latencies.push(performance.now() - started)
    }
    const sorted = [...latencies].sort((a, b) => a - b)
    const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    console.log('QA26 G2-09 search interactions', JSON.stringify({
      count: latencies.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
      samples_ms: latencies.map((value) => Number(value.toFixed(2))),
    }))

    await search.fill('')
    await page.getByLabel('按作品筛选').selectOption(source.id)
    await expect(grid.locator(':scope > button')).toHaveCount(2)
    await page.getByLabel('按作品筛选').selectOption('')
    const firstImageUrl = await grid.locator(':scope > button img').first().getAttribute('src')
    expect(firstImageUrl).toBeTruthy()
    const firstImagePath = new URL(firstImageUrl!, origin).pathname
    const assetId = firstImagePath.match(/\/assets\/([^/]+)\/file/)?.[1]
    expect(assetId).toBeTruthy()
    expect(sourceAfterUpload.assets.some((asset) => asset.id === assetId)).toBe(true)
    await grid.locator(':scope > button').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('image-source')).toContainText('图库来源作品')
    await dialog.getByLabel('替代文字').fill('取消保存不应写入')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    let library = await api(page, origin, 'GET', `/assets?account_id=${account.id}`) as Array<{ id: string; alt_text: string }>
    expect(library.map((asset) => asset.alt_text)).toEqual(['', ''])

    await grid.locator(':scope > button').first().click()
    const reopened = page.getByRole('dialog')
    const saveRoute = (url: URL) => url.pathname === `/api/v1/assets/${assetId}`
    let rejectNextSave = true
    await page.route(saveRoute, async (route) => {
      if (route.request().method() === 'PATCH' && rejectNextSave) {
        rejectNextSave = false
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '模拟图库保存失败' } }) })
      } else {
        await route.continue()
      }
    })
    const saveAltButton = reopened.getByRole('button', { name: '保存替代文字', exact: true })
    await reopened.getByLabel('替代文字').fill('一张蓝色方形图片')
    const failedSave = page.waitForResponse((response) => response.url().includes(`/assets/${assetId}`) && response.request().method() === 'PATCH')
    await saveAltButton.click()
    expect((await failedSave).status()).toBe(503)
    expect(rejectNextSave).toBe(false)
    const saveError = page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: '模拟图库保存失败' })
    await expect(saveError).toBeVisible()
    await expect(reopened.getByLabel('替代文字')).toHaveValue('一张蓝色方形图片')
    library = await api(page, origin, 'GET', `/assets?account_id=${account.id}`) as Array<{ id: string; alt_text: string }>
    expect(library.find((asset) => asset.id === assetId)?.alt_text).toBe('')
    await saveError.getByRole('button', { name: 'Close toast' }).click()
    await expect(saveError).toBeHidden()
    await expect(saveAltButton).toBeEnabled()
    const saved = page.waitForResponse((response) => response.url().includes(`/assets/${assetId}`) && response.request().method() === 'PATCH')
    await saveAltButton.click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByText('替代文字已保存', { exact: true })).toBeVisible()
    library = await api(page, origin, 'GET', `/assets?account_id=${account.id}`) as Array<{ id: string; alt_text: string }>
    expect(library.find((asset) => asset.id === assetId)?.alt_text).toBe('一张蓝色方形图片')

    await page.keyboard.press('Escape')
    await expect(reopened).toBeHidden()
    await expect(grid.locator(':scope > button')).toHaveCount(2)
    await grid.locator(':scope > button').first().click()
    const reuse = page.getByTestId('image-reuse-into-work')
    await expect(reuse).toBeVisible()
    const reused = page.waitForResponse((response) => response.url().includes(`/works/${target.id}/assets/reuse`) && response.request().method() === 'POST')
    await reuse.click()
    const reuseResponse = await reused
    expect(reuseResponse.status()).toBe(200)
    const reusedAsset = await reuseResponse.json() as { id: string; work_id: string; alt_text: string }
    expect(reusedAsset).toMatchObject({ work_id: target.id, alt_text: '一张蓝色方形图片' })
    expect(reusedAsset.id).not.toBe(assetId)
    const targetAfterReuse = await api(page, origin, 'GET', `/works/${target.id}`) as { assets: Array<{ id: string }> }
    expect(targetAfterReuse.assets.map((asset) => asset.id)).toContain(reusedAsset.id)
    console.log('QA26 G2-09 journey', JSON.stringify({ duration_ms: Number((performance.now() - journeyStarted).toFixed(2)) }))
    console.log('QA26 G2-09 persistence', JSON.stringify({ uploaded: sourceAfterUpload.assets.length, alt_text_saved: true, reused_asset_id: reusedAsset.id }))

    const invite = await api(page, origin, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 }) as { code: string }
    const viewerUserData = await mkdtemp(join(tmpdir(), 'ops-qa26-g2-images-viewer-'))
    let viewerApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      viewerApp = await _electron.launch({
        executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
        args: [`--user-data-dir=${viewerUserData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
        env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
        timeout: 60_000,
      })
      const viewerPage = await viewerApp.firstWindow()
      await viewerPage.goto(`${origin}/register`)
      const registered = await viewerPage.evaluate(async ({ code, username }) => fetch('/api/v1/auth/register', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'local-e2e-password-123', invite_code: code }),
      }).then((response) => response.status), { code: invite.code, username: `qa26-images-viewer-${Date.now()}` })
      expect(registered).toBe(200)
      await expect.poll(() => viewerPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
      await viewerPage.goto(`${origin}/images`)
      const viewerImage = viewerPage.locator('.desktop-image-grid > button').filter({ has: viewerPage.locator(`img[src*="${assetId}"]`) })
      await expect(viewerImage).toBeVisible()
      await viewerImage.click()
      const viewerDialog = viewerPage.getByRole('dialog')
      await expect(viewerDialog.getByText('一张蓝色方形图片', { exact: true })).toBeVisible()
      await expect(viewerDialog.getByRole('textbox')).toHaveCount(0)
      await expect(viewerDialog.getByRole('button', { name: '保存替代文字', exact: true })).toHaveCount(0)
      const viewerMe = await api(viewerPage, origin, 'GET', '/auth/me')
      const denied = await viewerPage.evaluate(async ({ url, csrf }) => fetch(url, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ alt_text: 'viewer 越权修改' }),
      }).then((response) => response.status), { url: `${origin}/api/v1/assets/${assetId}`, csrf: viewerMe.csrf_token })
      expect(denied).toBe(403)
      library = await api(page, origin, 'GET', `/assets?account_id=${account.id}`) as Array<{ id: string; alt_text: string }>
      expect(library.find((asset) => asset.id === assetId)?.alt_text).toBe('一张蓝色方形图片')
    } finally {
      await viewerApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
      await viewerApp?.close().catch(() => undefined)
      if (!resolve(viewerUserData).startsWith(resolve(tmpdir()) + sep) || !basename(viewerUserData).startsWith('ops-qa26-g2-images-viewer-')) {
        throw new Error('拒绝清理测试目录之外路径')
      }
      await rm(viewerUserData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-g2-images-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
