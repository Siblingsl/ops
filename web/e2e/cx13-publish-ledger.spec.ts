import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

const paragraphs = ['先记录一个具体观察，再核对它来自哪里。', '把事实和推测分开，避免把相关性写成原因。', '最后留下一个可以亲自验证的下一步。']

async function seedPackedWork(page: Parameters<typeof api>[0], accountID: string) {
  let work = await api(page, 'POST', `/accounts/${accountID}/works`, { content_format: 'micro_post' })
  work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '记录依据，再决定是否采用。', base_revision: work.revision })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: paragraphs.map((_, index) => ({ heading: `验证步骤${index + 1}`, key_point: `核对依据${index + 1}`, material_ids: [] })),
    confirm: true, base_revision: work.revision,
  })
  for (const [index, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: paragraphs[index], base_revision: section.revision })
  }
  work = await api(page, 'GET', `/works/${work.id}`)
  work = await api(page, 'PATCH', `/works/${work.id}`, {
    title: '只按可核对的事实写作', topics: ['内容核验'], base_revision: work.revision,
  })

  await page.goto(`/works/${work.id}/check`)
  const initial = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`)
    return !!latest.run && !latest.run.stale && !latest.run.material_basis_stale && latest.run.fact_status !== 'pending'
  }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  for (const item of run.items) {
    if (item.category !== 'format' && !item.resolution) {
      const input = page.locator(`input[name="${item.id}"]`).first()
      await input.check()
      await expect(input).toBeChecked()
    }
  }
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('ready')
  await page.goto(`/works/${work.id}/pack`)
  await page.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
  return work as { id: string }
}

function localDateInput(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

test('DEV-CX13-A Web 记录发布里程碑、提前公开说明与正式基线失效', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(150_000)
  const username = `cx13-ledger-web-${Date.now()}-${test.info().workerIndex}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  const work = await seedPackedWork(page, account.id)
  await page.goto(`/works/${work.id}/pack`)

  const state = page.getByRole('heading', { name: '发布进度', exact: true })
  await expect(state).toBeVisible()
  await expect(page.getByText('未交接 · v0', { exact: true })).toBeVisible()
  await page.getByLabel('交接说明').fill('已在头条号后台核对当前发布包并交给发布人')
  await page.getByRole('button', { name: '记录已交接', exact: true }).click()
  await expect(page.getByText('已交接 · v1', { exact: true })).toBeVisible()

  const schedule = async () => {
    await page.getByLabel('平台预约时间').fill(localDateInput(new Date(Date.now() + 30 * 60_000)))
    await page.getByLabel('预约凭证类型', { exact: true }).selectOption('url')
    await page.getByLabel('平台后台链接').fill('https://mp.toutiao.com/profile_v4/article')
    await page.getByRole('button', { name: '记录已预约', exact: true }).click()
  }
  await schedule()
  await expect(page.getByText('已预约 · v2', { exact: true })).toBeVisible()
  await page.getByLabel('取消预约原因').fill('平台活动调整，取消这次预约')
  await page.getByRole('button', { name: '取消预约并退回已交接', exact: true }).click()
  await expect(page.getByText('已交接 · v3', { exact: true })).toBeVisible()

  await schedule()
  await expect(page.getByText('已预约 · v4', { exact: true })).toBeVisible()
  await expect(page.getByLabel('提前公开说明')).toBeVisible()
  await expect(page.getByRole('button', { name: '标记为已发布', exact: true })).toBeDisabled()
  await page.getByLabel('提前公开说明').fill('已在平台核实作品提前公开，记录实际时间')
  await page.getByRole('button', { name: '标记为已发布', exact: true }).click()
  await expect(page.getByText('已公开 · v5', { exact: true })).toBeVisible()
  const publication = await api(page, 'GET', `/works/${work.id}/publish-state`)
  expect(publication.history.at(-1).evidence.early_public_reason).toBe('已在平台核实作品提前公开，记录实际时间')

  const metric = await api(page, 'POST', `/works/${work.id}/metrics`, { captured_at: new Date().toISOString(), likes: 5 })
  await page.reload()
  await page.getByLabel('正式指标基线').selectOption(metric.id)
  await page.getByRole('button', { name: '登记正式基线', exact: true }).click()
  await expect(page.getByText('已登记基线 · v6', { exact: true })).toBeVisible()
  await api(page, 'PATCH', `/metrics/${metric.id}`, { base_revision: metric.revision, likes: 8 })
  await page.reload()
  await expect(page.getByText('已公开 · v7', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '登记正式基线', exact: true })).toBeVisible()
})
