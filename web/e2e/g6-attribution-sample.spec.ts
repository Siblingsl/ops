import { expect, test, type Page } from '@playwright/test'
import { api, finishChecks, registerAccount } from './support'

const day = 24 * 60 * 60_000
const chineseOrdinals = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']

function localDateInput(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function addLocalModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: `DEV-QA26 G6 归因本地模型 ${Date.now()}`,
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1',
    api_key: 'local-qa26-attribution-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', ['fact_flag', 'review_attribution', 'work_breakdown'].map((task_type) => ({
    task_type, provider_id: provider.id, model: 'mock-writer',
  })))
}

async function seedSample(page: Page, accountID: string, index: number) {
  const title = index % 2 === 0
    ? `含数字 ${index + 1} 的实际记录`
    : `实际记录${chineseOrdinals[index]}的复盘过程`
  let work = await api(page, 'POST', `/accounts/${accountID}/works`, { title, content_format: 'micro_post' }) as {
    id: string; revision: number; sections: Array<{ id: string; revision: number }>
  }
  work = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '这篇样本只描述可核对的实际做法和结果。', base_revision: work.revision,
  })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [
      { heading: '当时的情况', key_point: '说明一个具体起因', material_ids: [] },
      { heading: '实际处理', key_point: '记录采用的步骤', material_ids: [] },
      { heading: '得到的观察', key_point: '说明可验证的结果', material_ids: [] },
    ], confirm: true, base_revision: work.revision,
  })
  for (const [sectionIndex, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: `第 ${sectionIndex + 1} 段记录真实步骤和可以再次核对的依据。`, base_revision: section.revision,
    })
  }
  work = await api(page, 'GET', `/works/${work.id}`)
  work = await api(page, 'PATCH', `/works/${work.id}`, {
    topics: index % 2 === 0 ? ['实际记录', '复盘'] : ['过程记录'], base_revision: work.revision,
  })

  await finishChecks(page, work.id)
  await page.goto(`/works/${work.id}/pack`)
  await page.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('packed')

  const publishedAt = new Date(Date.now() - 8 * day + index * 2 * 60 * 60_000)
  const backfill = page.locator('#backfill')
  await backfill.getByLabel('作品链接（可选）').fill(`https://example.invalid/qa26-attribution-${index + 1}`)
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateInput(publishedAt))
  const marked = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${work.id}/published`) && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()

  const capturedAt = new Date(publishedAt.getTime() + 7 * day)
  const metric = await api(page, 'POST', `/works/${work.id}/metrics`, {
    captured_at: capturedAt.toISOString(),
    reads: index % 2 === 0 ? 1_000 + index * 100 : 3_000 + index * 100,
    likes: 20 + index, comments: 2 + index, shares: 4 + index,
  })
  expect(metric).toMatchObject({ source: 'manual', day_offset: 7 })
  const saved = await api(page, 'GET', `/works/${work.id}/metrics`)
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ source: 'manual', day_offset: 7 })
  return { id: work.id, title }
}

test('DEV-QA26 G6 Web 足量样本归因与高表现作品', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(480_000)
  const account = await registerAccount(page, '微头条', 'toutiao', `qa26-g6-attribution-web-${Date.now()}`)
  await addLocalModel(page)
  const seeded = []
  for (let index = 0; index < 10; index++) seeded.push(await seedSample(page, account.id, index))
  expect(new Set(seeded.map((sample: { id: string }) => sample.id)).size).toBe(10)

  await page.getByRole('link', { name: '复盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '数据复盘', exact: true })).toBeVisible()
  await page.getByLabel('复盘内容形态').selectOption('micro_post')
  await expect(page.getByRole('heading', { name: '什么在起作用', exact: true })).toBeVisible()
  const attributionPost = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/reviews/attribution`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '开始分析', exact: true }).click()
  const attribution = await (await attributionPost).json()
  expect(attribution).toMatchObject({ enough: true, samples: 10, content_format: 'micro_post' })
  expect(attribution.ai_call_id).toBeTruthy()
  expect(attribution.features.some((feature: { feature: string }) => feature.feature === 'title_digit')).toBeTruthy()
  await expect(page.getByText('结论（基于 10 篇）', { exact: true })).toBeVisible()
  await expect(page.getByText('含数字', { exact: true })).toBeVisible()
  await expect(page.getByText('不含数字', { exact: true })).toBeVisible()

  const preferences = await api(page, 'GET', `/accounts/${account.id}/data-preferences?content_format=micro_post`)
  expect(preferences.some((item: { applicability: string; basis_sample_count: number }) => item.applicability === 'current' && item.basis_sample_count === 10)).toBeTruthy()
  const topWorks = await api(page, 'GET', `/accounts/${account.id}/top-works?content_format=micro_post`)
  expect(topWorks).toHaveLength(1)
  await page.getByRole('heading', { name: '表现最好的作品', exact: true }).scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: '拆解这篇', exact: true }).click()
  const breakdown = page.getByRole('dialog')
  await expect(breakdown.getByText('结构', { exact: true })).toBeVisible()
  await expect(breakdown.getByText('开头方式', { exact: true })).toBeVisible()
  await expect(breakdown.getByText('可复用的写作规则', { exact: true })).toBeVisible()
  await breakdown.getByRole('button', { name: '完成', exact: true }).click()
})
