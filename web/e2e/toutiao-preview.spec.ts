import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { api, finishChecks, registerAccount } from './support'

for (const format of ['long_article', 'micro_post']) {
  test(`头条 ${format} 主动分享、匿名预览、图文布局及改稿失效`, async ({ page, browser }) => {
    test.setTimeout(150_000)
    const account = await registerAccount(page, format === 'micro_post' ? '微头条' : '文章', 'toutiao')
    let work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '分享作品内部名称', content_format: format })
    work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '先记录事实，再复盘自己的行动。', topics: ['日常记录'], base_revision: work.revision })
    work = await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '不进入微头条的内部小标题', key_point: '记下实际观察', material_ids: [] }], confirm: true, base_revision: work.revision })
    const me = await (await page.request.get('/api/v1/auth/me')).json()
    const uploaded = await page.request.post(`/api/v1/works/${work.id}/assets`, {
      headers: { 'X-CSRF-Token': me.csrf_token }, multipart: { file: { name: '公开配图.png', mimeType: 'image/png', buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 32, height: 32 } }) } },
    })
    expect(uploaded.ok()).toBe(true)
    const image = await uploaded.json()
    await api(page, 'PATCH', `/sections/${work.sections[0].id}`, { content_md: `先做一件**小事**，完成后记录过程。${format === 'long_article' ? `\n\n![观察配图](/api/v1/assets/${image.id}/file)` : ''}`, base_revision: work.sections[0].revision })
    await finishChecks(page, work.id)
    work = await api(page, 'GET', `/works/${work.id}`)
    await api(page, 'POST', `/works/${work.id}/toutiao/pack`, { basis_revision: work.revision })
    await page.addInitScript(() => {
      const ua = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${ua} Electron/44.8.0` })
    })
    await page.goto(`/works/${work.id}/preview`)
    await page.waitForURL(`/works/${work.id}/pack`)
    await expect(page.getByRole('link', { name: '打开分享预览', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '生成 24 小时分享预览', exact: true }).click()
    let dialog = page.getByRole('dialog').filter({ has: page.getByText('生成匿名分享预览？', { exact: true }) })
    await expect(dialog).toContainText('无需登录')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('link', { name: '打开分享预览', exact: true })).toHaveCount(0)
    // A second editor changes and repacks after the copy preflight succeeds.
    // Hold only the share POST so the API must reject the confirmed old revision.
    await page.route(`**/api/v1/works/${work.id}/preview-link`, async route => {
      expect(route.request().postDataJSON()).toEqual({ basis_revision: work.revision })
      const editor = await page.context().newPage()
      try {
        work = await api(editor, 'PATCH', `/works/${work.id}`, { title: '分享作品更新后的内部名称', base_revision: work.revision })
        await api(editor, 'POST', `/works/${work.id}/checks`, {})
        await finishChecks(editor, work.id)
        work = await api(editor, 'GET', `/works/${work.id}`)
        await api(editor, 'POST', `/works/${work.id}/toutiao/pack`, { basis_revision: work.revision })
      } finally { await editor.close() }
      await route.continue()
    }, { times: 1 })
    await page.getByRole('button', { name: '生成 24 小时分享预览', exact: true }).click()
    dialog = page.getByRole('dialog').filter({ has: page.getByText('生成匿名分享预览？', { exact: true }) })
    const conflict = page.waitForResponse(response => response.url().endsWith(`/works/${work.id}/preview-link`) && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '生成分享链接', exact: true }).click()
    expect((await conflict).status()).toBe(409)
    await expect(page.getByText('作品已修改，请刷新后重新确认分享内容。', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: '打开分享预览', exact: true })).toHaveCount(0)
    await page.setViewportSize({ width: 740, height: 640 })
    const refresh = page.getByRole('button', { name: '刷新作品', exact: true })
    await expect(refresh).toBeVisible()
    await mkdir(resolve('../output'), { recursive: true })
    await page.screenshot({ path: resolve(`../output/toutiao-share-conflict-${format}-740.png`), fullPage: true })
    await refresh.click()
    await expect(page.getByText(new RegExp(`修订 ${work.revision} · 手动发布`))).toBeVisible()
    await page.getByRole('button', { name: '生成 24 小时分享预览', exact: true }).click()
    dialog = page.getByRole('dialog').filter({ has: page.getByText('生成匿名分享预览？', { exact: true }) })
    await dialog.getByRole('button', { name: '生成分享链接', exact: true }).click()
    const link = page.getByRole('link', { name: '打开分享预览', exact: true })
    await expect(link).toBeVisible()
    const url = await link.getAttribute('href')
    expect(url).toContain('/preview/')
    await expect(page.getByText(/^有效期至/)).toBeVisible()
    await mkdir(resolve('../output'), { recursive: true })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      for (const width of [1440, 960, 740]) {
        await page.setViewportSize({ width, height: 640 })
        const copy = page.getByRole('button', { name: '复制分享链接', exact: true })
        await copy.scrollIntoViewIfNeeded()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
        const box = await copy.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
        expect(box!.y + box!.height).toBeLessThanOrEqual(640)
        await page.screenshot({ path: resolve(`../output/toutiao-share-card-${format}-${theme}-${width}.png`), fullPage: true })
      }
    }
    const anonymous = await browser.newContext()
    try {
      const preview = await anonymous.newPage()
      expect((await anonymous.request.get('http://127.0.0.1:5179/api/v1/auth/me')).status()).toBe(401)
      await preview.goto(url!)
      await expect(preview.getByTestId('toutiao-public-preview')).toContainText('内容预览，不代表平台已发布')
      await expect(preview.getByTestId('toutiao-preview-body')).toContainText('先做一件小事，完成后记录过程。')
      await expect(preview.getByText(`今日头条 · ${format === 'micro_post' ? '微头条' : '文章'}`, { exact: true })).toBeVisible()
      if (format === 'micro_post') {
        await expect(preview.getByText('分享作品内部名称', { exact: true })).toHaveCount(0)
        await expect(preview.getByText(work.title, { exact: true })).toHaveCount(0)
        await expect(preview.getByText('不进入微头条的内部小标题', { exact: true })).toHaveCount(0)
      } else await expect(preview.getByRole('heading', { name: work.title, exact: true })).toBeVisible()
      await expect.poll(() => preview.locator('article img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBeTruthy()
      await mkdir(resolve('../output'), { recursive: true })
      for (const width of [1440, 960, 740, 390]) {
        await preview.setViewportSize({ width, height: 640 })
        await expect.poll(() => preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
        await preview.screenshot({ path: resolve(`../output/toutiao-share-${format}-${width}.png`), fullPage: true })
      }
      work = await api(page, 'GET', `/works/${work.id}`)
      await api(page, 'PATCH', `/works/${work.id}`, { title: '共享后改稿', base_revision: work.revision })
      await preview.reload()
      await expect(preview.getByText(/^共享内容已修改或失效，请让作者重新生成分享预览/)).toBeVisible()
      await expect(preview.getByTestId('toutiao-preview-body')).toHaveCount(0)
      const token = new URL(url!).pathname.split('/').pop()
      expect((await anonymous.request.get(`http://127.0.0.1:5179/api/v1/public-previews/${token}/assets/${image.id}`)).status()).toBe(410)
    } finally { await anonymous.close() }
  })
}
