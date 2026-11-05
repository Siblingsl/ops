import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

const paragraphs = ['先记录一个可核对的具体观察。', '再把事实、解释与可能的反例分开。', '最后留下下一步可以验证的单变量行动。']

async function seedReviewWork(page: Page, accountId: string) {
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
  work = await api(page, 'PATCH', `/works/${work.id}`, { title: '先核对来源，再总结观察', topics: ['观察记录'], base_revision: work.revision })

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
    const publishedAtInput = new Date(Date.now() - 8 * 24 * 60 * 60_000)
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
    const values = [
      { day: 1, impressions: 1200, reads: 800, likes: 15, favorites: 4, comments: 1, shares: 3, follows_gained: 1 },
      { day: 3, impressions: 2400, reads: 1700, likes: 31, favorites: 11, comments: 3, shares: 6, follows_gained: 2 },
      { day: 7, impressions: 3800, reads: 2500, likes: 48, favorites: 25, comments: 7, shares: 11, follows_gained: 4 },
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
    expect(savedMetrics.map((metric: { source: string; day_offset: number }) => [metric.source, metric.day_offset])).toEqual([['manual', 1], ['manual', 3], ['manual', 7]])
    expect(savedMetrics[2]).toMatchObject({ impressions: 3800, reads: 2500, likes: 48, favorites: 25, shares: 11 })
    await recordDrawer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(recordDrawer).toBeHidden()
    await native.reload()
    await expect(table.getByRole('row').filter({ hasText: work.title })).toContainText('2,500')

    const review = native.getByTestId('cx-review-multitime')
    await expect(review).toBeVisible()
    await review.getByLabel('查看作品').selectOption(work.id)
    await expect(review.getByRole('cell', { name: '先核对来源，再总结观察' })).toBeVisible()
    await expect(review.getByText('发布后约 7 天', { exact: true }).first()).toBeVisible()
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
