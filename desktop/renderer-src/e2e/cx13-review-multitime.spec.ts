import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

const paragraphs = ['先记录一个可核对的具体观察。', '再把事实、解释与可能的反例分开。', '最后留下下一步可以验证的单变量行动。']

async function seedReviewWork(page: Page, accountId: string, title = '先核对来源，再总结观察') {
  let work = await api(page, 'POST', `/accounts/${accountId}/works`, { content_format: 'micro_post' })
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

  await page.goto(`/works/${work.id}/check`)
  const initial = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`)
    return !!latest.run && !latest.run.stale && !latest.run.material_basis_stale && latest.run.fact_status !== 'pending'
  }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  for (const item of run.items) {
    if (item.category !== 'format' && !item.resolution) await page.locator(`input[name="${item.id}"]`).first().check()
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
