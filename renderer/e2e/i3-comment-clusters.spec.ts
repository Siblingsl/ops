import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I3 桌面工作台旅程：问题簇重算 → 单簇转选题 → 另一簇忽略/重开 → 本周关注点。
// 浏览器形态见 web/e2e/i3-comment-clusters.spec.ts；两端各自独立实现。
test('REF41 I3 桌面工作台：问题簇转选题、忽略重开与本周关注点', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I3 使用 ops-e2e 归并触发入口')
  test.setTimeout(120_000)
  const account = await registerAccount(page)

  const seedQuestion = async (content: string, alias: string) => {
    const created = await api(page, 'POST', '/comments', {
      account_id: account.id, author_alias: alias, content,
    }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, {
      base_revision: created.revision, category: 'question',
    })
  }
  await seedQuestion('会员价格为什么比同类高', '桌面读者甲')
  await seedQuestion('会员价格为什么比同类高呢', '桌面读者乙')
  await seedQuestion('发布步骤能不能再具体一点', '桌面读者丙')
  await seedQuestion('发布步骤能不能再具体一点呢', '桌面读者丁')

  // ops-e2e 专用归并触发：与生产每小时 job 共用同一重算实现，不 seed 问题簇结果。
  const rebuild = await page.request.post('http://127.0.0.1:8287/__e2e/comment-clusters/recompute', { data: { account_id: account.id } })
  expect(rebuild.ok(), await rebuild.text()).toBeTruthy()

  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const panel = page.getByTestId('comment-inbox-tab')
  const clusterPanel = panel.getByTestId('comment-clusters')
  await expect(clusterPanel).toBeVisible()
  await expect(clusterPanel.getByTestId('comment-cluster-item')).toHaveCount(2)

  const priceCluster = clusterPanel.getByTestId('comment-cluster-item').filter({ hasText: '会员价格为什么比同类高' })
  const stepCluster = clusterPanel.getByTestId('comment-cluster-item').filter({ hasText: '发布步骤能不能再具体一点' })
  await expect(priceCluster).toContainText('2 条提及')
  await expect(priceCluster.getByTestId('comment-cluster-samples')).toContainText('小红书')
  // 样例只给正文/平台/时间；输入时填的别名不能进入问题簇卡片。
  await expect(priceCluster).not.toContainText('桌面读者甲')
  await expect(priceCluster).not.toContainText('桌面读者乙')

  // 第一簇：单簇一键转选题，题目来源是簇内最新问法。
  await priceCluster.getByRole('button', { name: '生成选题' }).click()
  await expect(priceCluster).toContainText('已转选题')
  await expect(priceCluster.getByRole('button', { name: '生成选题' })).toBeHidden()
  const topics = await api(page, 'GET', `/accounts/${account.id}/topics`) as Array<{ title: string; source: string }>
  expect(topics.filter((topic) => topic.source === 'comment')).toHaveLength(1)
  expect(topics.find((topic) => topic.source === 'comment')?.title).toContain('会员价格为什么比同类高')

  // 第二簇：忽略后无生成按钮；重开恢复 2 条提及。
  await stepCluster.getByRole('button', { name: '忽略' }).click()
  await expect(stepCluster).toContainText('已忽略')
  await expect(stepCluster.getByRole('button', { name: '生成选题' })).toBeHidden()
  await stepCluster.getByRole('button', { name: '重新打开' }).click()
  await expect(stepCluster).toContainText('2 条提及')
  await expect(stepCluster.getByRole('button', { name: '生成选题' })).toBeVisible()

  // 本周关注点：价格/步骤各 2 条；桌面工作台与 Web 共用同一统计契约。
  const terms = panel.getByTestId('reader-terms')
  await expect(terms).toBeVisible()
  await expect(terms.getByText('价格 · 2', { exact: true })).toBeVisible()
  await expect(terms.getByText('步骤 · 2', { exact: true })).toBeVisible()
  await expect(terms).not.toContainText('桌面读者甲')
  await page.screenshot({ path: '../.playwright-results/desktop-renderer/i3-desktop-comment-clusters.png' })
})

test('REF41 I3 桌面：问题簇读取 500 显示错误，生成选题 500 提示失败', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I3 异常分支使用本地 API 拦截')
  const account = await registerAccount(page, '图文笔记', 'xhs', `i3-cluster-desktop-error-${Date.now()}`)
  for (const [content, alias] of [['退款多久到账', '桌面读者甲'], ['退款多久到账呢', '桌面读者乙']] as const) {
    const created = await api(page, 'POST', '/comments', { account_id: account.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  const rebuilt = await page.request.post('http://127.0.0.1:8287/__e2e/comment-clusters/recompute', { data: { account_id: account.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()

  const listRoute = '**/api/v1/accounts/*/comment-clusters*'
  await page.route(listRoute, (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I3 桌面问题簇读取失败' } }),
  }))
  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const card = page.getByTestId('comment-clusters')
  await expect(card).toContainText('C 类 I3 桌面问题簇读取失败')
  await page.unroute(listRoute)
  await page.route('**/api/v1/comment-clusters/*/convert', (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I3 桌面生成选题失败' } }),
  }))
  await page.reload()
  const cluster = page.getByTestId('comment-cluster-item').first()
  await expect(cluster).toBeVisible()
  await cluster.getByRole('button', { name: '生成选题' }).click()
  await expect(page.getByText('C 类 I3 桌面生成选题失败')).toBeVisible()
})
