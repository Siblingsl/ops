import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

const paragraphs = ['先记录一个可核对的具体观察。', '再把事实、解释与可能的反例分开。', '最后留下下一步可以验证的单变量行动。']
const wechatCoverCrops = {
  '2.35_1': { x1: 0, y1: 0.1, x2: 1, y2: 0.6 },
  '1_1': { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
}

async function uploadReviewImage(page: Page, origin: string, workId: string, width: number, height: number) {
  return page.evaluate(async ({ origin, workId, width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    context.fillStyle = '#3478d4'
    context.fillRect(0, 0, width, height)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'))
    const me = await (await fetch(`${origin}/api/v1/auth/me`)).json()
    const form = new FormData()
    form.append('file', new File([blob], 'qa26-review-platform.png', { type: 'image/png' }))
    const response = await fetch(`${origin}/api/v1/works/${workId}/assets`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form,
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`upload review image: ${response.status} ${body}`)
    return (JSON.parse(body) as { id: string }).id
  }, { origin, workId, width, height })
}

async function seedReviewWork(page: Page, accountId: string, title = '先核对来源，再总结观察', contentFormat = 'micro_post', origin?: string) {
  let work = await api(page, 'POST', `/accounts/${accountId}/works`, { content_format: contentFormat })
  work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '先核对来源，再写有限结论。', base_revision: work.revision })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: paragraphs.map((_, index) => ({ heading: `观察步骤${index + 1}`, key_point: `核对依据${index + 1}`, material_ids: [] })),
    confirm: true, base_revision: work.revision,
  })
  for (const [index, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: paragraphs[index], base_revision: section.revision })
  }
  work = await api(page, 'GET', `/works/${work.id}`)
  work = await api(page, 'PATCH', `/works/${work.id}`, { title, topics: ['观察记录'], base_revision: work.revision })

  if (contentFormat === 'image_note' || contentFormat === 'long_article') {
    if (!origin) throw new Error(`${contentFormat} fixture requires the local E2E origin`)
    const coverAssetId = await uploadReviewImage(page, origin, work.id, contentFormat === 'long_article' ? 1600 : 96, contentFormat === 'long_article' ? 1200 : 96)
    if (contentFormat === 'long_article') {
      const current = await api(page, 'GET', `/works/${work.id}`)
      work = await api(page, 'PATCH', `/works/${work.id}`, {
        cover_asset_id: coverAssetId, cover_crops: wechatCoverCrops, base_revision: current.revision,
      })
    }
  }

  await page.goto(`/works/${work.id}/check`)
  const initial = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`)
    return !!latest.run && !latest.run.stale && !latest.run.material_basis_stale && latest.run.fact_status !== 'pending'
  }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) await page.locator(`input[name="${item.id}"]`).first().check()
  }
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('ready')
  return work as { id: string; title: string }
}

function localDateTimeInput(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

test('DEV-QA26 G6 Windows Electron 发布回填、多时点手录、看板与建议采纳', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模拟模型')
  test.setTimeout(210_000)
  const username = `cx13-review-${Date.now()}-${test.info().workerIndex}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  const work = await seedReviewWork(page, account.id)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'CX13-B Electron 本地复盘模型',
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
    api_key: 'local-cx13-review-e2e-key', models: ['mock-writer'],
  })
  await api(page, 'PUT', '/model-routes', [{ task_type: 'review_analysis', provider_id: provider.id, model: 'mock-writer' }])

  const profilePrefix = join(tmpdir(), 'ops-cx13-review-')
  const profile = await mkdtemp(profilePrefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)

    await native.goto(`${baseURL}/works/${work.id}/pack`)
    const packResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/toutiao/pack` && response.request().method() === 'POST')
    await native.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
    expect((await packResponse).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('packed')
    const publishedAtInput = new Date(Date.now() - 40 * 24 * 60 * 60_000)
    const backfill = native.locator('#backfill')
    const publishedUrl = `https://example.invalid/qa26-g6-full-${work.id}`
    await backfill.getByLabel('作品链接（可选）').fill(publishedUrl)
    await backfill.getByLabel('发布时间', { exact: true }).fill(localDateTimeInput(publishedAtInput))
    const publishResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/published` && response.request().method() === 'POST')
    await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
    expect((await publishResponse).ok()).toBeTruthy()
    const publishedWork = await api(page, 'GET', `/works/${work.id}`)
    expect(publishedWork).toMatchObject({ status: 'published', published_url: publishedUrl })

    await native.goto(`${baseURL}/a/${account.id}/review`)

    const table = native.getByTestId('desktop-review-table')
    const descendingBoard = native.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'reads' && url.searchParams.get('order') === 'desc'
    })
    await native.getByLabel('按指标排序').selectOption('reads')
    expect((await descendingBoard).ok()).toBeTruthy()
    const ascendingBoard = native.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'reads' && url.searchParams.get('order') === 'asc'
    })
    await native.getByLabel('排序方向').selectOption('asc')
    expect((await ascendingBoard).ok()).toBeTruthy()
    const sortLatency: number[] = []
    for (let i = 0; i < 20; i++) {
      const order = i % 2 === 0 ? 'desc' : 'asc'
      const startedAt = Date.now()
      await native.getByLabel('排序方向').selectOption(order)
      await expect(native.getByLabel('排序方向')).toHaveValue(order)
      sortLatency.push(Date.now() - startedAt)
    }
    const sortedLatency = [...sortLatency].sort((a, b) => a - b)
    console.log(`DEV-QA26 G6 Electron sort-control samples: ${JSON.stringify({ n: sortLatency.length, p50_ms: sortedLatency[Math.ceil(sortedLatency.length * 0.5) - 1], p95_ms: sortedLatency[Math.ceil(sortedLatency.length * 0.95) - 1], failures: 0 })}`)
    const values = [
      { day: 1, impressions: 1200, reads: 800, likes: 15, favorites: 4, comments: 1, shares: 3, follows_gained: 1 },
      { day: 3, impressions: 2400, reads: 1700, likes: 31, favorites: 11, comments: 3, shares: 6, follows_gained: 2 },
      { day: 7, impressions: 3800, reads: 2500, likes: 48, favorites: 25, comments: 7, shares: 11, follows_gained: 4 },
      { day: 30, impressions: 15000, reads: 10000, likes: 160, favorites: 75, comments: 20, shares: 35, follows_gained: 12 },
    ]
    const workRow = table.getByRole('row').filter({ hasText: work.title })
    await workRow.getByRole('button', { name: /录入/ }).click()
    const recordDrawer = native.getByRole('dialog').filter({ hasText: work.title })
    await expect(recordDrawer).toBeVisible()
    for (const sample of values) {
      if (sample.day === 1) {
        await expect(recordDrawer.getByLabel(/数据采集时间/)).toBeVisible()
      } else {
        await recordDrawer.getByRole('button', { name: '录入一次数据', exact: true }).click()
      }
      const form = recordDrawer
      const capturedAt = new Date(new Date(publishedWork.published_at).getTime() + sample.day * 24 * 60 * 60_000)
      await form.getByLabel(/数据采集时间/).fill(localDateTimeInput(capturedAt))
      for (const [field, amount] of Object.entries(sample)) {
        if (field === 'day') continue
        const label = field === 'impressions' ? '展现量' : field === 'reads' ? '阅读' : field === 'favorites' ? '收藏' : field === 'comments' ? '评论' : field === 'shares' ? '转发' : field === 'follows_gained' ? '涨粉' : '点赞'
        await form.getByLabel(label, { exact: true }).fill(String(amount))
      }
      const metricResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/metrics` && response.request().method() === 'POST')
      await form.getByRole('button', { name: '保存', exact: true }).click()
      const response = await metricResponse
      expect(response.ok()).toBeTruthy()
      expect(await response.json()).toMatchObject({ source: 'manual', day_offset: sample.day })
      await expect(recordDrawer.getByRole('button', { name: '录入一次数据', exact: true })).toBeVisible()
    }
    const savedMetrics = await api(page, 'GET', `/works/${work.id}/metrics`)
    expect(savedMetrics.map((metric: { source: string; day_offset: number }) => [metric.source, metric.day_offset])).toEqual([['manual', 1], ['manual', 3], ['manual', 7], ['manual', 30]])
    expect(savedMetrics[2]).toMatchObject({ impressions: 3800, reads: 2500, likes: 48, favorites: 25, shares: 11 })
    const t30Metric = savedMetrics.find((metric: { day_offset: number }) => metric.day_offset === 30)
    expect(t30Metric).toMatchObject({ source: 'manual', impressions: 15000, reads: 10000, favorites: 75 })
    await recordDrawer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(recordDrawer).toBeHidden()
    await native.reload()
    await expect(table.getByRole('row').filter({ hasText: work.title })).toContainText('2,500')

    const review = native.getByTestId('cx-review-multitime')
    await expect(review).toBeVisible()
    await review.getByLabel('查看作品').selectOption(work.id)
    await expect(review.getByRole('cell', { name: '先核对来源，再总结观察' })).toBeVisible()
    await expect(review.getByText('发布后约 7 天', { exact: true }).first()).toBeVisible()
    await expect(review.getByText('发布后约 30 天', { exact: true }).first()).toBeVisible()
    const windows = await api(page, 'GET', `/works/${work.id}/metrics/windows`)
    const t30 = windows.windows.find((window: { window: string }) => window.window === 'T30')
    expect(t30.metric_ref).toMatchObject({ metric_id: t30Metric.id, source: 'manual' })
    await expect(review.getByText(new RegExp(`快照 ${t30Metric.id} · 修订`))).toBeVisible()
    const t30Compare = native.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/metrics/compare?window=T30`))
    await review.getByLabel('时间窗口').selectOption('T30')
    expect((await t30Compare).ok()).toBeTruthy()
    await expect(review.getByRole('row').filter({ hasText: work.title })).toBeVisible()
    await expect(review.getByText(/阅读单位：未知/).first()).toBeVisible()
    await expect(review.getByText('阅读单位未知', { exact: true }).first()).toBeVisible()
    await expect(review.getByText('同口径作品比较')).toBeVisible()

    await review.getByRole('button', { name: '新建实验', exact: true }).click()
    const experimentForm = review.getByTestId('cx-review-experiment-form')
    await experimentForm.getByLabel('实验假设').fill('更具体的标题可能与收藏率同时变化')
    await experimentForm.getByRole('button', { name: '创建这一项实验', exact: true }).click()
    await expect(review.getByText('进行中', { exact: true })).toBeVisible()
    let experiments = await api(page, 'GET', `/accounts/${account.id}/experiments`)
    const firstExperiment = review.getByTestId(`cx-review-experiment-${experiments.items[0].id}`)
    await firstExperiment.locator('details').nth(1).locator('summary').click()
    await firstExperiment.getByLabel('放弃原因').fill('本轮观察条件有变化，先停止并重设日期')
    await firstExperiment.getByRole('button', { name: '放弃并释放账号实验位', exact: true }).click()
    await expect(firstExperiment.getByText('已放弃', { exact: true })).toBeVisible()

    await review.getByRole('button', { name: '新建实验', exact: true }).click()
    await review.getByTestId('cx-review-experiment-form').getByLabel('实验假设').fill('保留一条可复核的探索假设')
    await review.getByRole('button', { name: '创建这一项实验', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/experiments`)).items.length).toBe(2)
    experiments = await api(page, 'GET', `/accounts/${account.id}/experiments`)
    const secondExperiment = review.getByTestId(`cx-review-experiment-${experiments.items[0].id}`)
    await secondExperiment.locator('details').first().locator('summary').click()
    await secondExperiment.getByRole('button', { name: '确认结案', exact: true }).click()
    await expect(secondExperiment.getByText('人工结论：暂不确定', { exact: true })).toBeVisible()
    await expect(secondExperiment.getByText(/观察性比较，不能证明因果关系/)).toBeVisible()

    await native.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    const generate = native.locator('#desktop-review-report-list').getByRole('button', { name: '生成复盘报告', exact: true }).first()
    const created = native.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/reviews`) && response.request().method() === 'POST')
    await generate.click()
    expect((await created).ok()).toBeTruthy()
    const evidence = native.getByTestId('cx-review-v2-evidence')
    await expect(evidence).toBeVisible({ timeout: 90_000 })
    await expect(evidence.getByText('增强复盘 v2')).toBeVisible()
    await expect(evidence.getByText('观察事实')).toBeVisible()
    await expect(evidence.getByText('可能解释（含反例与混杂）')).toBeVisible()
    await expect(evidence.getByText(/cx-review-v2-1/)).toBeVisible()

    const reportId = (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].id
    const reportCard = native.locator(`[data-testid="cx-review-report-${reportId}"]`)
    await reportCard.getByRole('button', { name: '编辑报告', exact: true }).click()
    await reportCard.getByLabel('观察事实 1').fill('人工修订后的观察，保留原始指标引用')
    await reportCard.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(reportCard.getByText('人工修订后的观察，保留原始指标引用')).toBeVisible()
    await reportCard.getByRole('button', { name: '采纳', exact: true }).first().click()
    await expect(reportCard.getByText('已采纳', { exact: true })).toBeVisible()
    const saved = await api(page, 'GET', `/accounts/${account.id}/reviews`)
    expect(saved[0].content.analysis_v2.observations[0].finding).toBe('人工修订后的观察，保留原始指标引用')
    expect(saved[0].adopted).toContain(0)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    expect(profile.startsWith(profilePrefix)).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G6 Windows Electron多作品看板按读取与收藏排序显示真实顺序', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模拟模型')
  test.setTimeout(180_000)
  const username = `cx13-sort-ui-${Date.now()}-${test.info().workerIndex}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  const samples = [
    { title: '排序样本阅读最高', reads: 9000, favorites: 10 },
    { title: '排序样本阅读中间', reads: 3000, favorites: 30 },
    { title: '排序样本阅读最低', reads: 1200, favorites: 20 },
  ]
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    const work = await seedReviewWork(page, account.id, sample.title)
    const current = await api(page, 'GET', `/works/${work.id}`)
    await api(page, 'POST', `/works/${work.id}/toutiao/pack`, { basis_revision: current.revision })
    const publishedAt = new Date(Date.now() - 40 * 24 * 60 * 60_000 - index * 10_000)
    await api(page, 'POST', `/works/${work.id}/published`, { published_at: publishedAt.toISOString() })
    await api(page, 'POST', `/works/${work.id}/metrics`, {
      captured_at: new Date(publishedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
      reads: sample.reads, favorites: sample.favorites, impressions: sample.reads * 2, shares: 3,
    })
    expect(await api(page, 'GET', `/works/${work.id}/metrics`)).toMatchObject([
      { source: 'manual', day_offset: 7, reads: sample.reads, favorites: sample.favorites },
    ])
  }

  const profilePrefix = join(tmpdir(), 'ops-cx13-review-sort-')
  const profile = await mkdtemp(profilePrefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}/review`)
    const table = native.getByTestId('desktop-review-table')
    await expect(table.locator('tbody .desktop-review-work-title')).toHaveCount(3)

    const readDesc = native.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'reads' && url.searchParams.get('order') === 'desc'
    })
    await native.getByLabel('按指标排序').selectOption('reads')
    const readDescResponse = await readDesc
    expect(readDescResponse.ok()).toBeTruthy()
    const readDescRows = await readDescResponse.json() as Array<{ title: string }>
    expect(readDescRows.map((row) => row.title)).toEqual(['排序样本阅读最高', '排序样本阅读中间', '排序样本阅读最低'])
    await expect(table.locator('tbody .desktop-review-work-title')).toHaveText(readDescRows.map((row) => row.title))

    const readAsc = native.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'reads' && url.searchParams.get('order') === 'asc'
    })
    await native.getByLabel('排序方向').selectOption('asc')
    const readAscResponse = await readAsc
    expect(readAscResponse.ok()).toBeTruthy()
    const readAscRows = await readAscResponse.json() as Array<{ title: string }>
    expect(readAscRows.map((row) => row.title)).toEqual(['排序样本阅读最低', '排序样本阅读中间', '排序样本阅读最高'])
    await expect(table.locator('tbody .desktop-review-work-title')).toHaveText(readAscRows.map((row) => row.title))

    const favoritesSort = native.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'favorites' && url.searchParams.get('order') === 'asc'
    })
    await native.getByLabel('按指标排序').selectOption('favorites')
    const favoritesResponse = await favoritesSort
    expect(favoritesResponse.ok()).toBeTruthy()
    const favoriteRows = await favoritesResponse.json() as Array<{ title: string }>
    expect(favoriteRows.map((row) => row.title)).toEqual(['排序样本阅读最高', '排序样本阅读最低', '排序样本阅读中间'])
    await expect(table.locator('tbody .desktop-review-work-title')).toHaveText(favoriteRows.map((row) => row.title))
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    expect(profile.startsWith(profilePrefix)).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G6 复盘看板全指标排序保留并列顺序并将缺值置末', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API')
  test.setTimeout(300_000)
  const stamp = Date.now()
  const username = `cx13-sort-matrix-${stamp}`
  const account = await registerAccount(page, '微头条', 'toutiao', username) as { id: string }
  const basePublishedAt = Date.now() - 40 * 24 * 60 * 60_000
  const samples: Array<{ title: string; publishedAt: number; values?: Record<string, number> }> = [
    { title: `排序低值 ${stamp}`, publishedAt: basePublishedAt - 30_000, values: { impressions: 30, reads: 3, likes: 1, favorites: 1, comments: 1, shares: 1, follows_gained: 1 } },
    { title: `排序并列较旧 ${stamp}`, publishedAt: basePublishedAt - 20_000, values: { impressions: 60, reads: 30, likes: 2, favorites: 2, comments: 2, shares: 2, follows_gained: 2 } },
    { title: `排序并列较新 ${stamp}`, publishedAt: basePublishedAt - 10_000, values: { impressions: 60, reads: 30, likes: 2, favorites: 2, comments: 2, shares: 2, follows_gained: 2 } },
    { title: `排序高值 ${stamp}`, publishedAt: basePublishedAt, values: { impressions: 100, reads: 80, likes: 3, favorites: 3, comments: 3, shares: 3, follows_gained: 3 } },
    { title: `排序无数据 ${stamp}`, publishedAt: basePublishedAt - 40_000 },
  ]
  for (const sample of samples) {
    const work = await seedReviewWork(page, account.id, sample.title)
    const current = await api(page, 'GET', `/works/${work.id}`)
    await api(page, 'POST', `/works/${work.id}/toutiao/pack`, { basis_revision: current.revision })
    const publishedAt = new Date(sample.publishedAt)
    await api(page, 'POST', `/works/${work.id}/published`, { published_at: publishedAt.toISOString() })
    if (sample.values) {
      await api(page, 'POST', `/works/${work.id}/metrics`, {
        captured_at: new Date(publishedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
        ...sample.values,
      })
      expect(await api(page, 'GET', `/works/${work.id}/metrics`)).toMatchObject([
        { source: 'manual', day_offset: 7, ...sample.values },
      ])
    }
  }

  const profilePrefix = join(tmpdir(), 'ops-cx13-review-sort-matrix-')
  const profile = await mkdtemp(profilePrefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}/review`)
    const table = native.getByTestId('desktop-review-table')
    await expect(table.locator('tbody .desktop-review-work-title')).toHaveCount(samples.length)

    const ascTitles = [samples[0].title, samples[2].title, samples[1].title, samples[3].title, samples[4].title]
    const descTitles = [samples[3].title, samples[2].title, samples[1].title, samples[0].title, samples[4].title]
    const keys = ['impressions', 'reads', 'likes', 'favorites', 'comments', 'shares', 'follows_gained', 'ctr'] as const
    let currentOrder: 'asc' | 'desc' = 'desc'
    for (const key of keys) {
      const sortResponse = native.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === key && url.searchParams.get('order') === currentOrder
      })
      await native.getByLabel('按指标排序').selectOption(key)
      const sorted = await sortResponse
      expect(sorted.ok(), `${key}/${currentOrder} board request`).toBeTruthy()
      const expected = currentOrder === 'desc' ? descTitles : ascTitles
      expect((await sorted.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(expected)
      await expect(table.locator('tbody .desktop-review-work-title')).toHaveText(expected)

      const nextOrder = currentOrder === 'desc' ? 'asc' : 'desc'
      const orderResponse = native.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === key && url.searchParams.get('order') === nextOrder
      })
      await native.getByLabel('排序方向').selectOption(nextOrder)
      const reordered = await orderResponse
      expect(reordered.ok(), `${key}/${nextOrder} board request`).toBeTruthy()
      const expectedNext = nextOrder === 'desc' ? descTitles : ascTitles
      expect((await reordered.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(expectedNext)
      await expect(table.locator('tbody .desktop-review-work-title')).toHaveText(expectedNext)
      currentOrder = nextOrder
    }
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    expect(profile.startsWith(profilePrefix)).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G6 Electron微信与小红书手录字段按平台展示并持久化', async ({ page, baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地 E2E API 与模拟微信')
  test.setTimeout(240_000)
  const stamp = `${Date.now()}-${testInfo.repeatEachIndex}`
  const username = `qa26-g6-cross-platform-${stamp}`
  const xhs = await registerAccount(page, '图文笔记', 'xhs', username) as { id: string }
  const wechat = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: `DEV-QA26 微信指标账号 ${stamp}`, content_format: 'long_article',
  }) as { id: string }
  const xhsWork = await seedReviewWork(page, xhs.id, `DEV-QA26 小红书字段 ${stamp}`, 'image_note', baseURL!)
  const wechatWork = await seedReviewWork(page, wechat.id, `DEV-QA26 微信字段 ${stamp}`, 'long_article', baseURL!)
  const publishedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000)
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${wechat.id}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-mock-wechat-secret' })
  await api(page, 'POST', `/accounts/${wechat.id}/wechat-credential/test`)

  const profilePrefix = join(tmpdir(), `ops-qa26-g6-cross-platform-${stamp}-`)
  const profile = await mkdtemp(profilePrefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const push = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${wechatWork.id}/wechat/push` && response.request().method() === 'POST')
    await native.goto(`${baseURL}/works/${wechatWork.id}/push`)
    await native.getByRole('button', { name: '写入草稿箱', exact: true }).click()
    expect((await push).ok()).toBeTruthy()
    await expect(native.getByText('已写入公众号草稿箱', { exact: true })).toBeVisible()
    await native.goto(`${baseURL}/works/${wechatWork.id}/push#backfill`)
    await expect(native).toHaveURL(new RegExp(`/works/${wechatWork.id}/push#backfill$`))
    const wechatBackfill = native.locator('#backfill')
    await expect(wechatBackfill).toBeVisible()
    await wechatBackfill.getByLabel('作品链接（可选）').fill(`https://example.invalid/qa26-g6-${stamp}-wechat`)
    await wechatBackfill.getByLabel('发布时间', { exact: true }).fill(localDateTimeInput(publishedAt))
    const markWechat = wechatBackfill.getByRole('button', { name: '标记为已发布', exact: true })
    await markWechat.scrollIntoViewIfNeeded()
    const wechatPublishedResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${wechatWork.id}/published` && response.request().method() === 'POST')
    await markWechat.click()
    expect((await wechatPublishedResponse).ok()).toBeTruthy()
    const publishedWechatWork = await api(page, 'GET', `/works/${wechatWork.id}`)
    expect(publishedWechatWork).toMatchObject({ status: 'published', published_url: `https://example.invalid/qa26-g6-${stamp}-wechat` })

    const xhsCurrent = await api(page, 'GET', `/works/${xhsWork.id}`)
    await native.goto(`${baseURL}/works/${xhsWork.id}/pack`)
    const xhsPackResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${xhsWork.id}/xhs/pack` && response.request().method() === 'POST')
    await native.getByRole('button', { name: '生成发布包', exact: true }).click()
    expect((await xhsPackResponse).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/works/${xhsWork.id}`)).status).toBe('packed')
    await native.goto(`${baseURL}/works/${xhsWork.id}/pack#backfill`)
    const xhsBackfill = native.locator('#backfill')
    const xhsURL = `https://example.invalid/qa26-g6-${stamp}-xhs`
    await xhsBackfill.getByLabel('作品链接（可选）').fill(xhsURL)
    await xhsBackfill.getByLabel('发布时间', { exact: true }).fill(localDateTimeInput(publishedAt))
    const markXhs = xhsBackfill.getByRole('button', { name: '标记为已发布', exact: true })
    await markXhs.scrollIntoViewIfNeeded()
    const xhsPublishedResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${xhsWork.id}/published` && response.request().method() === 'POST')
    await markXhs.click()
    expect((await xhsPublishedResponse).ok()).toBeTruthy()
    const publishedXhsWork = await api(page, 'GET', `/works/${xhsWork.id}`)
    expect(publishedXhsWork).toMatchObject({ status: 'published', published_url: xhsURL })
    expect(xhsCurrent.status).toBe('ready')

    const samples = [
      {
        accountId: xhs.id, workId: xhsWork.id, title: xhsWork.title, platform: 'xhs', readsLabel: '观看',
        expectedFields: ['观看', '点赞', '收藏', '评论', '分享', '涨粉'],
        absentFields: ['阅读', '在看', '留言', '新增关注', '展现量'],
        values: { reads: 221, likes: 21, favorites: 12, comments: 6, shares: 8, follows_gained: 7 },
      },
      {
        accountId: wechat.id, workId: wechatWork.id, title: wechatWork.title, platform: 'wechat_mp', readsLabel: '阅读',
        expectedFields: ['阅读', '点赞', '在看', '分享', '留言', '新增关注'],
        absentFields: ['观看', '收藏', '评论', '涨粉', '展现量'],
        values: { reads: 122, likes: 10, wows: 3, shares: 4, comments: 5, follows_gained: 6 },
      },
    ]
    for (const sample of samples) {
      await native.goto(`${baseURL}/a/${sample.accountId}/review`)
      const table = native.getByTestId('desktop-review-table')
      const row = table.getByRole('row').filter({ hasText: sample.title })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: /录入/ }).click()
      const drawer = native.getByRole('dialog').filter({ hasText: sample.title })
      await expect(drawer).toBeVisible()
      for (const label of sample.expectedFields) await expect(drawer.getByLabel(label, { exact: true })).toBeVisible()
      for (const label of sample.absentFields) await expect(drawer.getByLabel(label, { exact: true })).toHaveCount(0)
      await drawer.getByLabel(/数据采集时间/).fill(localDateTimeInput(new Date(publishedAt.getTime() + 24 * 60 * 60_000)))
      const readsInput = drawer.getByLabel(sample.readsLabel, { exact: true })
      const interactions: number[] = []
      for (let index = 0; index < 20; index++) {
        const value = String(sample.values.reads + (index % 2))
        const startedAt = performance.now()
        await readsInput.fill(value)
        await expect(readsInput).toHaveValue(value)
        interactions.push(performance.now() - startedAt)
      }
      await readsInput.fill(String(sample.values.reads))
      const sorted = [...interactions].sort((a, b) => a - b)
      console.log(`DEV-QA26 G6 ${sample.platform} manual metric input: ${JSON.stringify({ n: interactions.length, p50_ms: Number(sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(2)), p95_ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)), failures: 0 })}`)
      for (const [field, value] of Object.entries(sample.values)) {
        const label = field === 'reads' ? sample.readsLabel : field === 'likes' ? '点赞' : field === 'wows' ? '在看' : field === 'favorites' ? '收藏' : field === 'comments' ? (sample.platform === 'xhs' ? '评论' : '留言') : field === 'shares' ? '分享' : (sample.platform === 'xhs' ? '涨粉' : '新增关注')
        await drawer.getByLabel(label, { exact: true }).fill(String(value))
      }
      const metricResponse = native.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${sample.workId}/metrics` && response.request().method() === 'POST')
      await drawer.getByRole('button', { name: '保存', exact: true }).click()
      const savedResponse = await metricResponse
      expect(savedResponse.ok()).toBeTruthy()
      expect(await savedResponse.json()).toMatchObject({ source: 'manual', day_offset: 1, ...sample.values })
      const persisted = await api(page, 'GET', `/works/${sample.workId}/metrics`)
      expect(persisted).toMatchObject([{ source: 'manual', day_offset: 1, ...sample.values }])
      if (sample.platform === 'xhs') expect(persisted[0]).toMatchObject({ impressions: null, wows: null })
      else expect(persisted[0]).toMatchObject({ impressions: null, favorites: null })
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(drawer).toBeHidden()
    }
    await native.screenshot({ path: testInfo.outputPath('electron-g6-cross-platform-review.png') })
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes(`ops-qa26-g6-cross-platform-${stamp}-`)) throw new Error('拒绝清理测试目录之外路径')
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
