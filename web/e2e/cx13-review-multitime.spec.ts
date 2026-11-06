import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const paragraphs = ['先记录一个可核对的具体观察。', '再把事实、解释与可能的反例分开。', '最后留下下一步可以验证的单变量行动。']
const wechatCoverCrops = {
  '2.35_1': { x1: 0, y1: 0.1, x2: 1, y2: 0.6 },
  '1_1': { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
}

async function uploadReviewImage(page: Page, origin: string, workId: string) {
  return page.evaluate(async ({ origin, workId }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 1200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#3478d4'
    context.fillRect(0, 0, canvas.width, canvas.height)
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
  }, { origin, workId })
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

  if (contentFormat === 'long_article') {
    if (!origin) throw new Error('long_article fixture requires the local E2E origin')
    const coverAssetId = await uploadReviewImage(page, origin, work.id)
    const current = await api(page, 'GET', `/works/${work.id}`)
    work = await api(page, 'PATCH', `/works/${work.id}`, {
      cover_asset_id: coverAssetId, cover_crops: wechatCoverCrops, base_revision: current.revision,
    })
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

test('DEV-QA26 G6 Web 发布回填、多时点手录、看板与建议采纳', async ({ page, baseURL }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模拟模型')
  test.setTimeout(210_000)
  const username = `cx13-review-web-${Date.now()}-${test.info().workerIndex}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  const work = await seedReviewWork(page, account.id)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'CX13-B Web 本地复盘模型',
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1',
    api_key: 'local-cx13-review-web-e2e-key', models: ['mock-writer'],
  })
  await api(page, 'PUT', '/model-routes', [{ task_type: 'review_analysis', provider_id: provider.id, model: 'mock-writer' }])

  await page.goto(`${baseURL}/works/${work.id}/pack`)
  const packResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/toutiao/pack` && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  expect((await packResponse).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('packed')
  const publishedAtInput = new Date(Date.now() - 40 * 24 * 60 * 60_000)
  const backfill = page.locator('#backfill')
  const publishedUrl = `https://example.invalid/qa26-g6-full-${work.id}`
  await backfill.getByLabel('作品链接（可选）').fill(publishedUrl)
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateTimeInput(publishedAtInput))
  const publishResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/published` && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await publishResponse).ok()).toBeTruthy()
  const publishedWork = await api(page, 'GET', `/works/${work.id}`)
  expect(publishedWork).toMatchObject({ status: 'published', published_url: publishedUrl })

  await page.goto(`/a/${account.id}/review`)

  const table = page.locator('table').first()
  const descendingBoard = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'reads' && url.searchParams.get('order') === 'desc'
  })
  await page.getByLabel('按指标排序').selectOption('reads')
  expect((await descendingBoard).ok()).toBeTruthy()
  const ascendingBoard = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === 'reads' && url.searchParams.get('order') === 'asc'
  })
  await page.getByLabel('排序方向').selectOption('asc')
  expect((await ascendingBoard).ok()).toBeTruthy()
  const sortLatency: number[] = []
  for (let i = 0; i < 20; i++) {
    const order = i % 2 === 0 ? 'desc' : 'asc'
    const startedAt = Date.now()
    await page.getByLabel('排序方向').selectOption(order)
    await expect(page.getByLabel('排序方向')).toHaveValue(order)
    sortLatency.push(Date.now() - startedAt)
  }
  const sortedLatency = [...sortLatency].sort((a, b) => a - b)
  console.log(`DEV-QA26 G6 Web sort-control samples: ${JSON.stringify({ n: sortLatency.length, p50_ms: sortedLatency[Math.ceil(sortedLatency.length * 0.5) - 1], p95_ms: sortedLatency[Math.ceil(sortedLatency.length * 0.95) - 1], failures: 0 })}`)
  const values = [
    { day: 1, impressions: 1200, reads: 800, likes: 15, favorites: 4, comments: 1, shares: 3, follows_gained: 1 },
    { day: 3, impressions: 2400, reads: 1700, likes: 31, favorites: 11, comments: 3, shares: 6, follows_gained: 2 },
    { day: 7, impressions: 3800, reads: 2500, likes: 48, favorites: 25, comments: 7, shares: 11, follows_gained: 4 },
    { day: 30, impressions: 15000, reads: 10000, likes: 160, favorites: 75, comments: 20, shares: 35, follows_gained: 12 },
  ]
  const workRow = table.getByRole('row').filter({ hasText: work.title })
  await workRow.getByRole('button', { name: /录入/ }).click()
  const recordDrawer = page.getByRole('dialog').filter({ hasText: work.title })
  await expect(recordDrawer).toBeVisible()
  for (const sample of values) {
    if (sample.day === 1) {
      await expect(recordDrawer.getByLabel(/数据采集时间/)).toBeVisible()
    } else {
      await recordDrawer.getByRole('button', { name: '录入一次数据', exact: true }).click()
    }
    const drawer = recordDrawer
    const capturedAt = new Date(new Date(publishedWork.published_at).getTime() + sample.day * 24 * 60 * 60_000)
    await drawer.getByLabel(/数据采集时间/).fill(localDateTimeInput(capturedAt))
    for (const [field, amount] of Object.entries(sample)) {
      if (field === 'day') continue
      const label = field === 'impressions' ? '展现量' : field === 'reads' ? '阅读' : field === 'favorites' ? '收藏' : field === 'comments' ? '评论' : field === 'shares' ? '转发' : field === 'follows_gained' ? '涨粉' : '点赞'
      await drawer.getByLabel(label, { exact: true }).fill(String(amount))
    }
    const metricResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/metrics` && response.request().method() === 'POST')
    await drawer.getByRole('button', { name: '保存', exact: true }).click()
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
  await page.reload()
  await expect(table.getByRole('row').filter({ hasText: work.title })).toContainText('2,500')

  const review = page.getByTestId('cx-review-multitime')
  await expect(review).toBeVisible()
  await review.getByLabel('查看作品').selectOption(work.id)
  await expect(review.getByRole('cell', { name: work.title })).toBeVisible()
  await expect(review.getByText('发布后约 7 天', { exact: true }).first()).toBeVisible()
  await expect(review.getByText('发布后约 30 天', { exact: true }).first()).toBeVisible()
  const windows = await api(page, 'GET', `/works/${work.id}/metrics/windows`)
  const t30 = windows.windows.find((window: { window: string }) => window.window === 'T30')
  expect(t30.metric_ref).toMatchObject({ metric_id: t30Metric.id, source: 'manual' })
  await expect(review.getByText(new RegExp(`快照 ${t30Metric.id} · 修订`))).toBeVisible()
  const t30Compare = page.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/metrics/compare?window=T30`))
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

  const generate = page.locator('#review-report-list').getByRole('button', { name: '生成复盘报告', exact: true })
  const created = page.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/reviews`) && response.request().method() === 'POST')
  await generate.click()
  expect((await created).ok()).toBeTruthy()
  const evidence = page.getByTestId('cx-review-v2-evidence')
  await expect(evidence).toBeVisible({ timeout: 90_000 })
  await expect(evidence.getByText('增强复盘 v2')).toBeVisible()
  await expect(evidence.getByText('观察事实')).toBeVisible()
  await expect(evidence.getByText('可能解释（含反例与混杂）')).toBeVisible()
  await expect(evidence.getByText(/cx-review-v2-1/)).toBeVisible()

  const reportId = (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].id
  const reportCard = page.locator(`[data-testid="cx-review-report-${reportId}"]`)
  await reportCard.getByRole('button', { name: '编辑报告', exact: true }).click()
  await reportCard.getByLabel('观察事实 1').fill('人工修订后的观察，保留原始指标引用')
  await reportCard.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(reportCard.getByText('人工修订后的观察，保留原始指标引用')).toBeVisible()
  await reportCard.getByRole('button', { name: '采纳', exact: true }).first().click()
  await expect(reportCard.getByText('已采纳', { exact: true })).toBeVisible()
  const saved = await api(page, 'GET', `/accounts/${account.id}/reviews`)
  expect(saved[0].content.analysis_v2.observations[0].finding).toBe('人工修订后的观察，保留原始指标引用')
  expect(saved[0].adopted).toContain(0)
})

test('DEV-QA26 G6 Web公众号草稿写入后可通过发布页回填', async ({ page, baseURL }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地 E2E API 与模拟微信')
  test.setTimeout(120_000)
  const stamp = `${Date.now()}-${test.info().repeatEachIndex}`
  const username = `qa26-g6-web-wechat-backfill-${stamp}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username)
  const work = await seedReviewWork(page, account.id, `回填 ${stamp}`, 'long_article', baseURL!)
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-mock-wechat-secret' })
  await api(page, 'POST', `/accounts/${account.id}/wechat-credential/test`)

  await page.goto(`${baseURL}/works/${work.id}/push`)
  const pushed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/wechat/push` && response.request().method() === 'POST')
  await page.getByRole('button', { name: '写入草稿箱', exact: true }).click()
  expect((await pushed).ok()).toBeTruthy()
  await expect(page.getByText('已写入公众号草稿箱', { exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/works/${work.id}`)).status).toBe('pushed')

  await page.goto(`${baseURL}/works/${work.id}/push#backfill`)
  const backfill = page.locator('#backfill')
  await expect(backfill).toBeVisible()
  const publishedUrl = `https://example.invalid/qa26-g6-web-${stamp}`
  const publishedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000)
  await backfill.getByLabel('作品链接（可选）').fill(publishedUrl)
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateTimeInput(publishedAt))
  const marked = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/works/${work.id}/published` && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()
  expect(await api(page, 'GET', `/works/${work.id}`)).toMatchObject({ status: 'published', published_url: publishedUrl })
})

test('DEV-QA26 G6 复盘看板全指标排序保留并列顺序并将缺值置末', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API')
  test.setTimeout(180_000)
  const stamp = Date.now()
  const username = `cx13-sort-matrix-web-${stamp}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
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

  await page.goto(`/a/${account.id}/review`)
  const table = page.locator('#review-board table')
  await expect(table.locator('tbody tr')).toHaveCount(samples.length)
  const ascTitles = [samples[0].title, samples[2].title, samples[1].title, samples[3].title, samples[4].title]
  const descTitles = [samples[3].title, samples[2].title, samples[1].title, samples[0].title, samples[4].title]
  const rowTitles = table.locator('tbody tr td:nth-child(2) a')
  const keys = ['impressions', 'reads', 'likes', 'favorites', 'comments', 'shares', 'follows_gained', 'ctr'] as const
  let currentOrder: 'asc' | 'desc' = 'desc'
  for (const key of keys) {
    const sortResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === key && url.searchParams.get('order') === currentOrder
    })
    await page.getByLabel('按指标排序').selectOption(key)
    const sorted = await sortResponse
    expect(sorted.ok(), `${key}/${currentOrder} board request`).toBeTruthy()
    const expected = currentOrder === 'desc' ? descTitles : ascTitles
    expect((await sorted.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(expected)
    await expect(rowTitles).toHaveText(expected)

    const nextOrder = currentOrder === 'desc' ? 'asc' : 'desc'
    const orderResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/v1/accounts/${account.id}/board` && url.searchParams.get('sort') === key && url.searchParams.get('order') === nextOrder
    })
    await page.getByLabel('排序方向').selectOption(nextOrder)
    const reordered = await orderResponse
    expect(reordered.ok(), `${key}/${nextOrder} board request`).toBeTruthy()
    const expectedNext = nextOrder === 'desc' ? descTitles : ascTitles
    expect((await reordered.json() as Array<{ title: string }>).map((row) => row.title)).toEqual(expectedNext)
    await expect(rowTitles).toHaveText(expectedNext)
    currentOrder = nextOrder
  }
})
