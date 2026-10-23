import { test, expect } from '@playwright/test'
import { api, registerAccount, createOutline, finishChecks } from './support'

test('OPT04 流式起草排队提示在执行后清除', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  const work = await api(page, 'GET', `/works/${id}`)
  const section = work.sections[0]
  await page.evaluate((section) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith(`/sections/${section.id}/draft`)) return originalFetch(input, init)
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: stage\ndata: {"stage":"queued"}\n\n'))
          window.setTimeout(() => {
            controller.enqueue(encoder.encode('event: stage\ndata: {"stage":"context"}\n\n'))
            const done = { result: { section: { ...section, content_md: '队列结束后生成的测试正文', revision: section.revision + 1 } }, refs: [], ai_call_id: null }
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`))
            controller.close()
            window.fetch = originalFetch
          }, 2_000)
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
  }, section)
  await page.locator(`#sec-${section.id}`).getByRole('button', { name: '起草本段', exact: true }).click()
  await expect(page.getByText('排队中', { exact: true })).toBeVisible()
  await expect(page.getByText('当前工作区的 AI 任务正在运行，请稍候', { exact: true })).toBeVisible()
  await expect(page.getByText('排队中', { exact: true })).toBeHidden({ timeout: 5_000 })
})

test('OPT13 工作台加载、首次失败一秒内提示、空态与手动重试恢复', async ({ page }) => {
  const account = await registerAccount(page)
  let mode: 'loading' | 'error' | 'empty' | 'ready' = 'loading'
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const endpoint = `/api/v1/accounts/${account.id}/dashboard`
  await page.route((url) => url.pathname === endpoint, async (route) => {
    await gate
    if (mode === 'error') return route.fulfill({ status: 500, json: { error: { code: 'internal', message: '模拟工作台加载失败，请重试' } } })
    if (mode === 'empty') return route.fulfill({ status: 200, json: null })
    return route.continue()
  })
  const first = page.waitForResponse((r) => new URL(r.url()).pathname === endpoint)
  await page.goto(`/a/${account.id}`)
  const main = page.locator('main')
  await expect(main.getByLabel('加载中', { exact: true })).toBeVisible()
  mode = 'error'
  release()
  expect((await first).status()).toBe(500)
  const failedAt = Date.now()
  const alert = main.getByRole('alert')
  await expect(alert.getByText('模拟工作台加载失败，请重试')).toBeVisible({ timeout: 1_000 })
  await expect(alert.getByRole('button', { name: '重试', exact: true })).toBeVisible({ timeout: 1_000 })
  const elapsed = Date.now() - failedAt
  expect(elapsed).toBeLessThanOrEqual(1_000)
  test.info().annotations.push({ type: 'OPT13 响应到错误与重试入口', description: `${elapsed}ms` })
  console.log(`OPT13 工作台错误与重试入口 ${elapsed}ms`)
  await expect(main.getByLabel('加载中', { exact: true })).toBeHidden()
  await expect(alert.getByText('正在重试…')).toBeVisible()
  await expect(alert.getByRole('button', { name: '重试', exact: true })).toBeDisabled()
  await expect(alert.getByRole('button', { name: '重试', exact: true })).toBeEnabled({ timeout: 6_000 })
  mode = 'empty'
  await alert.getByRole('button', { name: '重试', exact: true }).click()
  await expect(main.getByText('暂无工作台数据', { exact: true })).toBeVisible()
  await expect(alert).toBeHidden()
  mode = 'ready'
  await main.getByRole('button', { name: '重试', exact: true }).click()
  await expect(main.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  await expect(main.getByText('暂无工作台数据', { exact: true })).toBeHidden()
})

test('OPT13 同类页面首次失败及时提示且重试恢复', async ({ page }) => {
  const account = await registerAccount(page)
  const wechat = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '错误恢复验收公众号', content_format: 'long_article' })
  const work = await api(page, 'POST', `/accounts/${wechat.id}/works`, { title: '只验证预览，不执行写入' })
  const cases = [
    { name: '账号档案', path: `/a/${account.id}/profile`, endpoint: `/api/v1/accounts/${account.id}/profile`, ready: '账号健康度' },
    { name: 'AI 用量', path: '/settings/usage', endpoint: '/api/v1/usage', ready: '区间合计' },
    { name: '质量看板', path: '/settings/quality', endpoint: '/api/v1/quality', ready: '各任务效果' },
    { name: '推送预览', path: `/works/${work.id}/push`, endpoint: `/api/v1/works/${work.id}/wechat/push-preview`, ready: '去检查' },
  ]
  for (const item of cases) {
    await test.step(item.name, async () => {
      let failing = true
      const match = (url: URL) => url.pathname === item.endpoint
      await page.route(match, (route) => failing
        ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: `模拟${item.name}加载失败` } } })
        : route.continue())
      const first = page.waitForResponse((r) => new URL(r.url()).pathname === item.endpoint).then((response) => ({ response, at: Date.now() }))
      await page.goto(item.path, { waitUntil: 'domcontentloaded' })
      const failed = await first
      expect(failed.response.status()).toBe(500)
      const failedAt = failed.at
      const main = page.locator('main')
      const alert = main.getByRole('alert')
      await expect(alert.getByText(`模拟${item.name}加载失败`)).toBeVisible({ timeout: 1_000 })
      await expect(alert.getByRole('button', { name: '重试', exact: true })).toBeVisible({ timeout: 1_000 })
      const elapsed = Date.now() - failedAt
      expect(elapsed).toBeLessThanOrEqual(1_000)
      console.log(`OPT13 ${item.name}错误与重试入口 ${elapsed}ms`)
      await expect(alert.getByRole('button', { name: '重试', exact: true })).toBeEnabled({ timeout: 6_000 })
      failing = false
      await alert.getByRole('button', { name: '重试', exact: true }).click()
      await expect(alert).toBeHidden()
      await expect(main.getByText(item.ready, { exact: true }).first()).toBeVisible()
      if (item.name === '推送预览') {
        await expect(main.getByText('H-04', { exact: true }).locator('..')).toContainText('发布前检查还没有全部确认，不能写入草稿。')
        await expect(main.getByRole('button', { name: '写入草稿箱', exact: true })).toHaveCount(0)
        const nextAction = page.locator('[data-testid="work-next-action"]').getByRole('button', { name: '去检查', exact: true })
        await expect(nextAction).toBeVisible()
        await nextAction.click()
        await expect(page).toHaveURL(`/works/${work.id}/check`)
      }
      await page.unroute(match)
    })
  }
})

test('OPT14 网关 GET 仅重试一次、停机及时提示、写请求不重试', async ({ page }) => {
  await registerAccount(page)
  for (const status of [502, 503, 504]) {
    let calls = 0
    const endpoint = '/api/v1/usage'
    await page.route((url) => url.pathname === endpoint, (route) => ++calls === 1
      ? route.fulfill({ status, contentType: 'text/html', body: '<html>gateway unavailable</html>' })
      : route.continue())
    await page.goto('/settings/usage')
    await expect(page.locator('main').getByText('区间合计', { exact: true })).toBeVisible()
    expect(calls).toBe(2)
    await page.unroute((url) => url.pathname === endpoint)
  }
  const began = Date.now()
  await page.route('**/api/v1/usage*', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>backend stopped</html>' }))
  await page.goto('/settings/usage', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main').getByRole('alert')).toContainText('服务暂不可用')
  const elapsed = Date.now() - began
  expect(elapsed).toBeLessThanOrEqual(30_000)
  console.log(`OPT14 后端停止提示 ${elapsed}ms`)
  await page.unroute('**/api/v1/usage*')
  await page.goto('/settings/export')
  let writes = 0
  await page.route('**/api/v1/exports', (route) => {
    writes++
    return route.fulfill({ status: 503, contentType: 'text/html', body: '<html>unavailable</html>' })
  })
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.getByText('服务暂不可用，请稍后重试', { exact: true })).toBeVisible()
  expect(writes).toBe(1)
  await page.unroute('**/api/v1/exports')
  await page.route('**/api/v1/exports', (route) => route.fulfill({ status: 429, contentType: 'text/html', body: '<html>too many requests</html>' }))
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.getByText('请求太频繁，请稍后重试', { exact: true })).toBeVisible()
  await page.unroute('**/api/v1/exports')
  await page.route('**/api/v1/exports', (route) => route.fulfill({ status: 422, json: { error: { code: 'validation', message: '保留服务端校验原因' } } }))
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.getByText('保留服务端校验原因', { exact: true })).toBeVisible()
  await page.unroute('**/api/v1/exports')
  const bytes = Buffer.from([0, 255, 128, 13, 10, 65])
  await page.route('**/api/v1/exports', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bytes }))
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await downloaded).createReadStream()) chunks.push(chunk)
  expect(Buffer.concat(chunks)).toEqual(bytes)
})

for (const body of [false, true]) {
  test(`OPT14 普通请求${body ? '响应体' : '响应头'}在三十秒超时`, async ({ page }) => {
    await registerAccount(page)
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1_000))
    await page.evaluate((body) => {
      const original = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        if (typeof input !== 'string' || !input.startsWith('/api/v1/usage')) return original(input, init)
        const started = Date.now()
        Object.assign(window, { opt14RequestAt: started })
        init?.signal?.addEventListener('abort', () => Object.assign(window, { opt14Elapsed: Date.now() - started }), { once: true })
        if (!body) return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')), { once: true })
          },
        }), { headers: { 'Content-Type': 'application/json' } })
      }
    }, body)
    await page.getByRole('button', { name: /今日.*token/ }).click()
    await expect(page.locator('main').getByLabel('加载中', { exact: true })).toBeAttached()
    const remaining = await page.evaluate(() => 30_000 - (Date.now() - (window as any).opt14RequestAt))
    expect(remaining).toBeGreaterThan(0)
    await page.clock.fastForward(remaining - 1)
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
    await page.clock.fastForward(1)
    expect(await page.evaluate(() => (window as any).opt14Elapsed)).toBe(30_000)
    await page.clock.resume()
    await expect(page.locator('main').getByRole('alert')).toContainText('服务暂不可用，请求超时，请稍后重试')
    console.log(`OPT14 ${body ? '响应体' : '响应头'}悬挂：浏览器时钟 30000ms 超时`)
  })
}

test('OPT14 三十 MB 上传提示限制且上传独立于普通期限', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  const input = page.locator('#step-images input[type="file"]')
  const file = { name: 'local-30MB.png', mimeType: 'image/png', buffer: Buffer.alloc(30 * 1024 * 1024) }
  let uploads = 0
  await page.route(`**/api/v1/works/${id}/assets`, (route) => {
    uploads++
    return route.fulfill({ status: 413, contentType: 'text/html', body: '<html>request entity too large</html>' })
  })
  await input.setInputFiles(file)
  await expect(page.getByText('local-30MB.png：文件太大，最大 20MB', { exact: true })).toBeVisible()
  expect(uploads).toBe(0)
  await input.setInputFiles({ ...file, name: 'local-gateway.png', buffer: Buffer.alloc(1_024) })
  await expect(page.getByText('local-gateway.png：文件太大，最大 20MB', { exact: true })).toBeVisible()
  expect(uploads).toBe(1)
  await page.unroute(`**/api/v1/works/${id}/assets`)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1_000))
  const image = await page.evaluate((id) => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      if (input === `/api/v1/works/${id}/assets`) await new Promise<void>((resolve, reject) => {
        window.setTimeout(resolve, 45_000)
        init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      })
      return original(input, init)
    }
    const canvas = document.createElement('canvas')
    canvas.width = 100; canvas.height = 100
    return canvas.toDataURL('image/png').split(',')[1]
  }, id)
  await input.setInputFiles({ name: 'local-delayed.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
  await page.clock.fastForward(30_000)
  await expect(page.locator('#step-images').getByRole('button', { name: '上传图片', exact: true })).toBeDisabled()
  await page.clock.fastForward(15_000)
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).assets.length).toBe(1)
  await expect(page.locator('#step-images').getByRole('button', { name: '上传图片', exact: true })).toBeEnabled()
  await page.clock.resume()
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1_000)))
  await page.evaluate((id) => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      if (input !== `/api/v1/works/${id}/assets`) return original(input, init)
      const started = Date.now()
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        Object.assign(window, { opt14UploadElapsed: Date.now() - started })
        reject(new DOMException('cancelled', 'AbortError'))
      }, { once: true }))
    }
  }, id)
  await input.setInputFiles({ name: 'local-timeout.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
  await page.clock.fastForward(120_000)
  expect(await page.evaluate(() => (window as any).opt14UploadElapsed)).toBe(120_000)
  await page.clock.resume()
  await expect(page.getByText('local-timeout.png：服务暂不可用，请求超时，请稍后重试', { exact: true })).toBeVisible()
})

test('OPT14 流式等待与正文超过三十秒仍完成且主动停止保留取消', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  const work = await api(page, 'GET', `/works/${id}`)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1_000))
  await page.evaluate((sections) => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const index = sections.findIndex((s: any) => input === `/api/v1/sections/${s.id}/draft`)
      if (index < 0) return original(input, init)
      if (index === 0) await new Promise<void>((resolve, reject) => {
        window.setTimeout(resolve, 45_000)
        init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      })
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"text":"流式生成仍在继续"}\n\n'))
          init?.signal?.addEventListener('abort', () => {
            Object.assign(window, { opt14Cancelled: true })
            controller.error(new DOMException('cancelled', 'AbortError'))
          }, { once: true })
          if (index === 0) window.setTimeout(() => {
            const done = { result: { section: { ...sections[0], content_md: '较慢的完整正文', revision: sections[0].revision + 1 } }, refs: [], ai_call_id: null }
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`))
            controller.close()
          }, 45_000)
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
  }, work.sections.slice(0, 2))
  const first = page.locator(`#sec-${work.sections[0].id}`)
  await first.getByRole('button', { name: '起草本段', exact: true }).click()
  await page.clock.fastForward(30_000)
  await expect(first.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await page.clock.fastForward(15_000)
  await expect(first.getByText('流式生成仍在继续', { exact: true })).toBeVisible()
  await page.clock.fastForward(30_000)
  await expect(first.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await page.clock.fastForward(15_000)
  await page.clock.resume()
  await expect(first.getByRole('button', { name: '停止生成', exact: true })).toBeHidden()
  const second = page.locator(`#sec-${work.sections[1].id}`)
  await second.getByRole('button', { name: '起草本段', exact: true }).click()
  await expect(second.getByText('流式生成仍在继续', { exact: true })).toBeVisible()
  await second.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(second.getByRole('button', { name: '起草本段', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).opt14Cancelled)).toBe(true)
  await expect(page.getByText(/服务暂不可用/)).toHaveCount(0)
})

test('OPT06 草稿写入期间按钮禁用、并发提示与人工重试', async ({ page }) => {
  await registerAccount(page)
  const account = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '并发写入验收号', content_format: 'card_post' })
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 's3cret-value-for-test' })
  await api(page, 'POST', `/accounts/${account.id}/wechat-credential/test`)
  let work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '把任务拆成小步骤' })
  const id = work.id
  await api(page, 'PATCH', `/works/${id}`, { viewpoint: '先做小目标更容易坚持，这是我的经验判断。' })
  const outline = await api(page, 'POST', `/works/${id}/outline/generate`)
  work = await api(page, 'PUT', `/works/${id}/outline`, { items: outline.items, confirm: true })
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先明确目标，再安排一小步，完成后记录感受。', base_revision: section.revision })
    await api(page, 'POST', `/works/${id}/cards/${section.id}/generate-image`)
  }
  await finishChecks(page, id)
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/v1/works/${id}/wechat/push`, async (route) => {
    requests++
    if (requests !== 1) return route.continue()
    await gate
    return route.fulfill({ status: 409, json: { error: { code: 'wechat_push_running', message: '正在写入，请稍候' } } })
  })
  await page.goto(`/works/${id}/push`)
  const write = page.getByRole('button', { name: '写入图片消息草稿', exact: true })
  await expect(write).toBeEnabled()
  await write.click()
  await expect(write).toBeDisabled()
  await expect.poll(() => requests).toBe(1)
  release()
  await expect(page.getByText('写入失败：正在写入，请稍候', { exact: true })).toBeVisible()
  await expect(write).toBeEnabled()
  expect((await api(page, 'GET', `/works/${id}/wechat/push-preview`)).today_count).toBe(0)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByText('已写入公众号草稿箱', { exact: true })).toBeVisible()
  expect(requests).toBe(2)
  expect((await api(page, 'GET', `/works/${id}/wechat/push-preview`)).today_count).toBe(1)
  expect((await api(page, 'GET', `/works/${id}`)).wechat_draft_media_id).toMatch(/^mock-draft-/)
})

test('注册、创建作品、大纲、逐段起草、检查与小红书打包', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  const initial = await api(page, 'GET', `/works/${id}`)
  const draftRequests: string[] = []
  page.on('request', r => { if (/\/sections\/[^/]+\/draft$/.test(r.url()) && r.method() === 'POST') draftRequests.push(r.url()) })
  await page.locator(`#sec-${initial.sections[0].id}`).getByRole('button', { name: '起草本段', exact: true }).focus()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Enter')
    await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[i].content_md).not.toBe('')
    const next = page.locator(`#sec-${initial.sections[i + 1].id}`).getByRole('button', { name: '起草本段', exact: true })
    await expect(next).toBeFocused()
    expect(draftRequests).toHaveLength(i + 1)
    expect(draftRequests[i]).toContain(initial.sections[i].id)
  }
  // 焦点移动不会启动下一次生成，下一空段仍保持空白。
  expect((await api(page, 'GET', `/works/${id}`)).sections[3].content_md).toBe('')
  // 人工整理稿件与图片属于测试准备，不跳过检查或直接改状态。
  let work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先明确要解决的问题，再把任务拆成能够完成的一小步。记录自己的过程，比追求复杂的方法更容易持续。', base_revision: section.revision })
  await api(page, 'PATCH', `/works/${id}`, { title: '把复杂任务拆成一小步', topics: ['日常记录'] })
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const fixtureImage = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100; canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#d9e8ee'; ctx.fillRect(0, 0, 100, 100)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const image = await page.request.post(`/api/v1/works/${id}/assets`, { headers: { 'X-CSRF-Token': me.csrf_token }, multipart: {
    file: { name: 'local-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixtureImage, 'base64') },
  } })
  expect(image.ok(), await image.text()).toBeTruthy()
  await finishChecks(page, id)
  await page.goto(`/works/${id}/pack`)
  await page.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  work = await api(page, 'GET', `/works/${id}`)
  expect(work.status).toBe('packed')
  const packZip = await page.request.get(`/api/v1/works/${id}/xhs/pack.zip?basis_revision=${work.revision}`)
  expect(packZip.ok()).toBeTruthy()
  expect(packZip.headers()['x-ops-basis-revision']).toBe(String(work.revision))
})

test('首次价值路径：旧文建档、方案启用、生成推荐并逐条采用', async ({ page }) => {
  const began = Date.now()
  const account = await registerAccount(page)
  const guide = page.getByRole('region', { name: '首次推荐路径' })
  await expect(guide).toContainText('约 2 分钟 · 可跳过')
  await guide.getByRole('link', { name: '去粘贴建档' }).click({ noWaitAfter: true })
  const wizard = page.getByRole('dialog').filter({ hasText: '粘贴' }).first()
  await expect(wizard).toBeVisible()
  const sample = '我习惯先把问题拆开，再用自己的经历说明原因。小团队做事时，先明确目标，再选择工具。我带过三人运营团队，做过用户增长，也会记录每一次尝试的结果。'.repeat(5)
  await wizard.getByPlaceholder('粘贴正文', { exact: true }).first().fill(sample)
  await wizard.getByRole('button', { name: /生成|分析/ }).first().click()
  await expect(wizard.getByRole('button', { name: /应用|保存|确认/ }).last()).toBeEnabled()
  await wizard.getByRole('button', { name: /应用|保存|确认/ }).last().click()
  await page.goto(`/a/${account.id}`)
  await createOutline(page)
  await page.goto(`/a/${account.id}/ops`)
  await page.getByLabel('想做的领域').fill('互联网运营')
  await page.getByLabel('真实经历与资源').fill('在电商公司做了五年用户增长，带过三人小团队')
  await page.getByRole('button', { name: '生成 2–3 个方案', exact: true }).click()
  await page.getByRole('button', { name: '选择并编辑', exact: true }).first().click()
  await page.getByRole('button', { name: '启用方案', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/strategy`)).active?.id).toBeTruthy()
  await page.goto(`/a/${account.id}`)
  const generate = page.getByRole('button', { name: '生成第一条推荐', exact: true })
  const adopt = page.getByRole('button', { name: '采用为选题', exact: true }).first()
  await expect.poll(async () => await generate.isVisible() || await adopt.isVisible()).toBe(true)
  if (await generate.isVisible()) await generate.click()
  await expect(page.getByRole('button', { name: '采用为选题', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '采用为选题', exact: true }).first().click()
  await page.getByRole('button', { name: '确认这一条', exact: true }).click()
  await expect(page.getByText('已采用', { exact: true }).first()).toBeVisible()
  expect(Date.now() - began).toBeLessThan(10 * 60_000)
})

// D-123 / DEV-415：账号类型不再「创建后固定」，改为同平台内需显式 confirm_type_change 才能迁移；
// 目标形态仍必须属于本平台（跨平台请新建账号）。
test('账号类型同平台内需显式确认才可迁移，平台不支持的形态仍被拒绝', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto('/settings/accounts')
  await expect(page.getByText('同平台内可以更换类型；跨平台请新建账号')).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)

  const patch = (body: Record<string, unknown>) => page.evaluate(async ([id, payload]) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const r = await fetch(`/api/v1/accounts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify(payload) })
    return { status: r.status, body: await r.json() }
  }, [account.id, body] as [string, Record<string, unknown>])

  // 未显式确认：拒绝，账号类型保持不变
  const blocked = await patch({ content_format: 'comic' })
  expect(blocked.status).toBe(409)
  expect(blocked.body.error.code).toBe('confirm_required')
  expect(blocked.body.error.message).toContain('已有作品保持原类型不变')
  expect((await api(page, 'GET', `/accounts/${account.id}`)).content_format).toBe('image_note')

  // 目标形态不属于本平台（long_article 仅公众号）：即使带确认也拒绝
  const notForPlatform = await patch({ content_format: 'long_article', confirm_type_change: true })
  expect(notForPlatform.status).toBe(422)
  expect(notForPlatform.body.error.fields.content_format).toContain('该平台不支持这种内容类型')
  expect((await api(page, 'GET', `/accounts/${account.id}`)).content_format).toBe('image_note')

  // 同平台 + 显式确认：迁移成功，并返回影响面摘要
  const migrated = await patch({ content_format: 'comic', confirm_type_change: true })
  expect(migrated.status).toBe(200)
  expect(migrated.body.account.content_format).toBe('comic')
  expect(migrated.body.type_change.from).toBe('image_note')
  expect(migrated.body.type_change.to).toBe('comic')
  expect(migrated.body.type_change.works_kept).toBe(0)
  expect((await api(page, 'GET', `/accounts/${account.id}`)).content_format).toBe('comic')
})

test('卡片大纲确认、逐卡配图、检查与含文案发布包', async ({ page }) => {
  await registerAccount(page, '图文卡片')
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先写目标，再安排一小步，做完后记录感受。', base_revision: section.revision })
  await page.goto(`/works/${id}`)
  const buttons = page.getByRole('button', { name: '生成配图', exact: true })
  await expect(buttons.first()).toBeVisible()
  const count = await buttons.count()
  expect(count).toBeGreaterThan(1)
  for (let i = 0; i < count; i++) {
    await buttons.first().click()
    await expect(page.getByRole('button', { name: '重新生成配图', exact: true })).toHaveCount(i + 1)
  }
  work = await api(page, 'GET', `/works/${id}`)
  const firstId = work.sections[0].id
  const secondId = work.sections[1].id
  await page.getByRole('button', { name: '下移卡片 1', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).cards[0].section_id).toBe(secondId)
  await expect(page.locator('[data-card-section]').first()).toHaveAttribute('data-card-section', secondId)
  await expect(page.getByRole('button', { name: '上移卡片 2', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '上移卡片 2', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).cards[0].section_id).toBe(firstId)
  await expect(page.locator('[data-card-section]').first()).toHaveAttribute('data-card-section', firstId)
  const first = page.locator(`[data-card-section="${firstId}"]`)
  await first.getByLabel('配图提示词（可选）').fill('绿色书桌与笔记本，保持留白')
  let generations = 0
  page.on('request', r => { if (r.url().endsWith('/generate-image') && r.method() === 'POST') generations++ })
  await first.getByRole('button', { name: '重新生成配图', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(generations).toBe(0)
  const oldURL = work.cards[0].image_url
  await first.getByRole('button', { name: '重新生成配图', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('旧图保留')
  const regenerated = page.waitForResponse(r => r.url().endsWith('/generate-image') && r.request().method() === 'POST')
  await page.getByRole('button', { name: '重新生成这一张', exact: true }).click()
  const response = await regenerated
  expect(response.request().postDataJSON().prompt).toBe('绿色书桌与笔记本，保持留白')
  expect(response.ok()).toBeTruthy()
  expect(generations).toBe(1)
  expect((await page.request.get(oldURL)).ok()).toBeTruthy()
  await api(page, 'PATCH', `/works/${id}`, { title: '把任务拆成小步骤' })
  await finishChecks(page, id)
  await page.goto(`/works/${id}/pack`)
  await page.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  work = await api(page, 'GET', `/works/${id}`)
  const zip = await page.request.get(`/api/v1/works/${id}/xhs/pack.zip?basis_revision=${work.revision}`)
  expect(zip.ok()).toBeTruthy()
  expect(zip.headers()['x-ops-basis-revision']).toBe(String(work.revision))
  expect((await zip.body()).includes(Buffer.from('文案.txt'))).toBeTruthy()
  expect(work.cards).toHaveLength(count)
})

test('新类型跨平台派生目标置灰', async ({ page }) => {
  const account = await registerAccount(page, '口播脚本')
  await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '目标脚本号', content_format: 'script' })
  await page.goto(`/a/${account.id}`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const createPanel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(createPanel).toBeVisible()
  await createPanel.getByRole('button', { name: '开始创作', exact: true }).click()
  await expect(page).toHaveURL(/\/works\/[a-f0-9-]+$/)
  await page.getByRole('button', { name: '派生', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '派生到其他平台', exact: true }) })
  await expect(dialog.getByRole('button', { name: /目标脚本号/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /创建|派生/ }).last()).toBeDisabled()
})


test('副驾驶理由、删除预览与原目标绑定，拒绝过期建议', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  await page.getByRole('button', { name: '起草本段', exact: true }).first().click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[0].content_md).not.toBe('')
  let work = await api(page, 'GET', `/works/${id}`)
  const firstId = work.sections[0].id
  const other = work.sections[1]
  await api(page, 'PATCH', `/sections/${other.id}`, { content_md: '这一段应当保留。', base_revision: other.revision })
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.post(`/api/v1/works/${id}/copilot`, { headers: { 'X-CSRF-Token': me.csrf_token }, data: { message: '这一段可以怎么改？', scope: 'section', section_id: firstId } })
  expect(response.ok()).toBeTruthy()
  expect(await response.text()).toContain('event: done')
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe(work.sections[0].content_md)
  await page.goto(`/works/${id}`)
  await expect(page.getByRole('button', { name: '重新起草', exact: true }).first()).toBeVisible()
  await page.keyboard.press('Control+j')
  await expect(page.getByText('理由：先给结论，减少铺垫')).toBeVisible()
  await page.locator(`#sec-${other.id} textarea`).first().focus()
  await page.getByRole('button', { name: '预览删除这一处', exact: true }).click()
  const first = page.locator(`#sec-${firstId}`)
  await expect(first.getByText('（删除以上原文）', { exact: true })).toBeVisible()
  await first.getByRole('button', { name: '放弃', exact: true }).click()
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe(work.sections[0].content_md)
  await page.getByRole('button', { name: '预览删除这一处', exact: true }).click()
  await first.getByRole('button', { name: '确认删除这一处', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe('')
  work = await api(page, 'GET', `/works/${id}`)
  expect(work.sections[1].content_md).toBe('这一段应当保留。')
  expect(work.sections[0].origin).toBe('mixed')
  // 已修改的原文不能再用旧建议覆盖。
  await page.getByRole('button', { name: '预览修改这一处', exact: true }).click()
  await expect(page.getByText('原文已改动，请重新生成建议', { exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe('')
  // 服务端明确拒绝的动作不能从分析文字重新构造为可应用卡片。
  const copilotURL = `**/api/v1/works/${id}/copilot`
  await page.route(copilotURL, route => route.fulfill({ json: [{ id: 'refused-action', role: 'assistant', content: '建议改为：后端拒绝的内容', context_scope: 'section', section_id: firstId, ai_call_id: null, created_at: new Date().toISOString(), suggestions: [] }] }))
  await page.reload()
  await expect(page.locator(`#sec-${firstId}`)).toBeVisible()
  await page.getByRole('button', { name: '副驾驶', exact: true }).click()
  await expect(page.getByText('建议改为：后端拒绝的内容', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '应用到当前段', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '预览修改这一处', exact: true })).toHaveCount(0)
  await page.unroute(copilotURL)
  // 空段落的建议也有快照；后来写入文字后不能覆盖。
  const emptyReply = await page.request.post(`/api/v1/works/${id}/copilot`, { headers: { 'X-CSRF-Token': me.csrf_token }, data: { message: '这一段可以怎么改？', scope: 'section', section_id: firstId } })
  expect(await emptyReply.text()).toContain('event: done')
  const latest = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/sections/${firstId}`, { content_md: '空段落后来补写的正文。', base_revision: latest.sections[0].revision })
  await page.reload()
  await expect(page.locator(`#sec-${firstId}`)).toBeVisible()
  await page.getByRole('button', { name: '副驾驶', exact: true }).click()
  await page.getByRole('button', { name: '预览修改这一处', exact: true }).last().click()
  await expect(page.getByText('原文已改动，请重新生成建议', { exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe('空段落后来补写的正文。')
})
