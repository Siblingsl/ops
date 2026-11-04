import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

test('OPT38 单篇 Markdown 导出保留标题、段落与图片顺序', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const title = 'OPT38: Markdown / 导出验收'
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '这是本人输入的核心观点：清楚说明每一步，读者才能重复执行。', base_revision: work.revision })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [
      { heading: '第一段', key_point: '先确认顺序', material_ids: [] },
      { heading: '第二段', key_point: '再检查图片', material_ids: [] },
    ],
    confirm: true,
  })
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#456'
    ctx.fillRect(0, 0, 2, 2)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const images: { id: string }[] = []
  for (const index of [1, 2]) {
    const response = await page.request.post(`/api/v1/works/${work.id}/assets`, {
      headers: { 'X-CSRF-Token': me.csrf_token },
      multipart: { file: { name: `opt38-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
    })
    expect(response.ok()).toBeTruthy()
    images.push(await response.json())
  }
  const [firstImage, secondImage] = images
  const current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${current.sections[0].id}`, {
    content_md: `第一段正文。\n\n![第一张图片](/api/v1/assets/${firstImage.id}/file)`,
    base_revision: current.sections[0].revision,
  })
  await api(page, 'PATCH', `/sections/${current.sections[1].id}`, {
    content_md: `第二段正文。\n\n![第二张图片](/api/v1/assets/${secondImage.id}/file)`,
    base_revision: current.sections[1].revision,
  })

  await page.goto(`/works/${work.id}`)
  // 页面上有作品级 + 每段一个「更多」菜单；导出入口在作品级。
  const outputRoot = resolve('../.playwright-results')
  await mkdir(outputRoot, { recursive: true })
  const runOutputDir = await mkdtemp(join(outputRoot, 'qa26-opt38-web-'))
  const firstAssetURL = new URL(`/api/v1/assets/${firstImage.id}/file`, page.url()).href
  const secondAssetURL = new URL(`/api/v1/assets/${secondImage.id}/file`, page.url()).href
  try {
    const latencies: number[] = []
    for (let i = 0; i < 20; i++) {
      await page.locator('.work-more').getByRole('button').click()
      const exportItem = page.getByRole('menuitem', { name: '导出 Markdown', exact: true })
      await expect(exportItem).toBeVisible()
      const downloaded = page.waitForEvent('download')
      const started = performance.now()
      await exportItem.click()
      const file = await downloaded
      expect(file.suggestedFilename()).toBe('OPT38_ Markdown _ 导出验收.md')
      await expect(page.getByText('已开始下载', { exact: true }).first()).toBeVisible()
      const savedPath = join(runOutputDir, `sample-${i + 1}.md`)
      await file.saveAs(savedPath)
      const markdown = await readFile(savedPath, 'utf8')
      expect(markdown).toContain(`# ${title}`)
      expect(markdown).toContain('第一段正文。')
      expect(markdown).toContain('第二段正文。')
      expect(markdown.indexOf('第一段正文。')).toBeLessThan(markdown.indexOf('第二段正文。'))
      expect(markdown.indexOf('## 第一段')).toBeLessThan(markdown.indexOf('## 第二段'))
      expect(markdown.indexOf(firstAssetURL)).toBeLessThan(markdown.indexOf('## 第二段'))
      expect(markdown.indexOf('## 第二段')).toBeLessThan(markdown.indexOf(secondAssetURL))
      latencies.push(performance.now() - started)
    }
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    console.log(`DEV-QA26 G4-17 Web Markdown 导出：样本=${latencies.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms failures=0`)
    await testInfo.attach('g4-17-web-export-latencies', {
      body: JSON.stringify({ samples: latencies, p50, p95, failures: 0 }),
      contentType: 'application/json',
    })

    const editorInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1 }) as { code: string }
    const editorContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const editorUsername = `qa26-opt38-editor-${Date.now()}`
      const registered = await editorContext.request.post('/api/v1/auth/register', {
        data: { username: editorUsername, password: 'local-e2e-password-123', invite_code: editorInvite.code },
      })
      expect(registered.ok()).toBeTruthy()
      const editor = await editorContext.newPage()
      const editorWork = editor.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'GET')
      await editor.goto(`/works/${work.id}`)
      expect((await editorWork).ok()).toBeTruthy()
      await expect.poll(() => editor.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('editor')
      const editorMore = editor.locator('.work-more')
      await expect(editorMore).toBeVisible()
      await editorMore.getByRole('button').click()
      const editorExport = editor.getByRole('menuitem', { name: '导出 Markdown', exact: true })
      await expect(editorExport).toBeVisible()
      const downloaded = editor.waitForEvent('download')
      await editorExport.click()
      const file = await downloaded
      expect(file.suggestedFilename()).toBe('OPT38_ Markdown _ 导出验收.md')
      const editorPath = join(runOutputDir, 'editor-export.md')
      await file.saveAs(editorPath)
      const editorMarkdown = await readFile(editorPath, 'utf8')
      expect(editorMarkdown).toContain(`# ${title}`)
      expect(editorMarkdown).toContain(firstAssetURL)
      expect(editorMarkdown).toContain(secondAssetURL)
    } finally {
      await editorContext.close()
    }

    const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 }) as { code: string }
    const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const viewerUsername = `qa26-opt38-viewer-${Date.now()}`
      const registered = await viewerContext.request.post('/api/v1/auth/register', {
        data: { username: viewerUsername, password: 'local-e2e-password-123', invite_code: invite.code },
      })
      expect(registered.ok()).toBeTruthy()
      const viewer = await viewerContext.newPage()
      const viewerWork = viewer.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'GET')
      await viewer.goto(`/works/${work.id}`)
      expect((await viewerWork).ok()).toBeTruthy()
      await expect.poll(() => viewer.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('viewer')
      await expect(viewer.locator('.work-more')).toHaveCount(0)
      await expect(viewer.getByRole('menuitem', { name: '导出 Markdown', exact: true })).toHaveCount(0)
    } finally {
      await viewerContext.close()
    }
  } finally {
    const resolvedOutput = resolve(runOutputDir)
    if (!resolvedOutput.startsWith(outputRoot + '\\') || !runOutputDir.includes('qa26-opt38-web-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(runOutputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
