import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I3 浏览器旅程：两条同题评论 → 问题簇 → 单簇生成选题（source=comment）→
// 本周关注点；样例不显示评论者身份。桌面形态见 renderer/e2e/i3-comment-clusters.spec.ts。
test('REF41 I3 Web 读者提问归并、问题簇转选题与本周关注点', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I3 使用 ops-e2e 归并触发入口')
  const account = await registerAccount(page, '图文笔记', 'xhs', `i3-cluster-web-${Date.now()}`)
  const seed = async (content: string, alias: string) => {
    const created = await api(page, 'POST', '/comments', { account_id: account.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  await seed('价格为什么比同类高这么多？', '读者甲')
  await seed('价格为什么比同类高这么多呢', '读者乙')
  await seed('操作步骤能不能再详细一点？', '读者丙')
  await seed('操作步骤能不能再详细一点呢', '读者丁')
  const rebuilt = await page.request.post('http://127.0.0.1:8180/__e2e/comment-clusters/recompute', { data: { account_id: account.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()

  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const panel = page.getByTestId('comment-inbox-tab')
  const clusters = panel.getByTestId('comment-clusters')
  await expect(clusters).toBeVisible()
  await expect(clusters.getByTestId('comment-cluster-item')).toHaveCount(2)
  const priceCluster = clusters.getByTestId('comment-cluster-item').filter({ hasText: '价格为什么比同类高' })
  await expect(priceCluster).toContainText('2 条提及')
  await expect(priceCluster).not.toContainText('读者甲')
  await expect(priceCluster).not.toContainText('读者乙')
  await expect(priceCluster.getByTestId('comment-cluster-samples')).toContainText('小红书')

  // 单簇一键生成选题；不弹标题框、不提供批量入口。
  await priceCluster.getByRole('button', { name: '生成选题' }).click()
  await expect(priceCluster).toContainText('已转选题')
  await expect(priceCluster.getByRole('button', { name: '生成选题' })).toHaveCount(0)
  await expect.poll(async () => {
    const topics = await api(page, 'GET', `/accounts/${account.id}/topics`) as Array<{ title: string; source: string }>
    return topics.filter((topic) => topic.source === 'comment').length
  }).toBe(1)
  const topics = await api(page, 'GET', `/accounts/${account.id}/topics`) as Array<{ title: string; source: string }>
  const commentTopic = topics.find((topic) => topic.source === 'comment')
  expect(commentTopic?.title).toContain('价格为什么比同类高')

  // 本周关注点：价格/步骤各 2 条，徽标带 doc_freq；不显示评论者身份。
  const terms = panel.getByTestId('reader-terms')
  await expect(terms).toBeVisible()
  await expect(terms.getByText('价格 · 2', { exact: true })).toBeVisible()
  await expect(terms.getByText('步骤 · 2', { exact: true })).toBeVisible()
  await expect(terms).not.toContainText('读者甲')
  await page.screenshot({ path: '../.playwright-results/web/i3-web-comment-clusters.png' })
})

// REF41 I3 浏览器补充：忽略/重开是单簇操作；忽略后不显示生成按钮，重开后恢复。
test('REF41 I3 Web 问题簇忽略与重新打开', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I3 使用 ops-e2e 归并触发入口')
  const account = await registerAccount(page, '图文笔记', 'xhs', `i3-cluster-web-ignore-${Date.now()}`)
  for (const [content, alias] of [['退货流程到底怎么走', '读者A'], ['退货流程到底怎么走呢', '读者B']] as const) {
    const created = await api(page, 'POST', '/comments', { account_id: account.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  const rebuilt = await page.request.post('http://127.0.0.1:8180/__e2e/comment-clusters/recompute', { data: { account_id: account.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()
  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const card = page.getByTestId('comment-cluster-item').first()
  await expect(card).toContainText('2 条提及')
  await card.getByRole('button', { name: '忽略' }).click()
  await expect(card).toContainText('已忽略')
  await expect(card.getByRole('button', { name: '生成选题' })).toHaveCount(0)
  await card.getByRole('button', { name: '重新打开' }).click()
  await expect(card).toContainText('2 条提及')
  await expect(card.getByRole('button', { name: '生成选题' })).toBeVisible()
})

test('REF41 I3 Web：问题簇读取 500 显示错误，生成选题 500 提示失败', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I3 异常分支使用本地 API 拦截')
  const account = await registerAccount(page, '图文笔记', 'xhs', `i3-cluster-web-error-${Date.now()}`)
  for (const [content, alias] of [['退款多久到账', '读者甲'], ['退款多久到账呢', '读者乙']] as const) {
    const created = await api(page, 'POST', '/comments', { account_id: account.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  const rebuilt = await page.request.post('http://127.0.0.1:8180/__e2e/comment-clusters/recompute', { data: { account_id: account.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()

  const listRoute = '**/api/v1/accounts/*/comment-clusters*'
  await page.route(listRoute, (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I3 问题簇读取失败' } }),
  }))
  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const card = page.getByTestId('comment-clusters')
  await expect(card).toContainText('C 类 I3 问题簇读取失败')
  await page.unroute(listRoute)
  await page.route('**/api/v1/comment-clusters/*/convert', (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I3 生成选题失败' } }),
  }))
  await page.reload()
  const cluster = page.getByTestId('comment-cluster-item').first()
  await expect(cluster).toBeVisible()
  await cluster.getByRole('button', { name: '生成选题' }).click()
  await expect(page.getByText('C 类 I3 生成选题失败')).toBeVisible()
})
