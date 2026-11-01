import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const paragraphs = ['先记录一个可核对的具体观察。', '再把事实、解释与可能的反例分开。', '最后留下下一步可以验证的单变量行动。']

async function seedPublishedWork(page: Page, accountId: string) {
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
  work = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'POST', `/works/${work.id}/toutiao/pack`, { basis_revision: work.revision })

  const publishedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000)
  await api(page, 'POST', `/works/${work.id}/published`, { published_at: publishedAt.toISOString() })
  await api(page, 'POST', `/works/${work.id}/metrics`, {
    captured_at: new Date(publishedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    reads: 1200, favorites: 42, likes: 25, comments: 7, shares: 9, follows_gained: 2,
  })
  return work as { id: string; title: string }
}

test('DEV-CX13-B Web 浏览器多窗口复盘、实验与报告逐项反馈', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模拟模型')
  test.setTimeout(210_000)
  const username = `cx13-review-web-${Date.now()}-${test.info().workerIndex}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  const work = await seedPublishedWork(page, account.id)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'CX13-B Web 本地复盘模型',
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1',
    api_key: 'local-cx13-review-web-e2e-key', models: ['mock-writer'],
  })
  await api(page, 'PUT', '/model-routes', [{ task_type: 'review_analysis', provider_id: provider.id, model: 'mock-writer' }])
  await page.goto(`/a/${account.id}/review`)

  const review = page.getByTestId('cx-review-multitime')
  await expect(review).toBeVisible()
  await review.getByLabel('查看作品').selectOption(work.id)
  await expect(review.getByRole('cell', { name: work.title })).toBeVisible()
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
