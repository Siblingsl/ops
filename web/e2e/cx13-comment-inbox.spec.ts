import { expect, test } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

// DEV-CX13-E / FR-CX-22 浏览器旅程：评论台账逐条录入、AI 拟稿、复制回执、转选题幂等与删除清正文。
// 桌面形态同段旅程见 renderer/e2e/cx13-comment-inbox.spec.ts；两端各自实现。
test('DEV-CX13-E Web 评论台账：逐条入库、状态机与转选题幂等', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-inbox-web-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web 评论拟稿模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_comment_reply', provider_id: provider.id, model: 'mock-writer' }])

  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const panel = page.getByTestId('comment-inbox-tab')
  await expect(panel).toBeVisible()

  // 批量粘贴空行分隔；一次只入库第一条（无全部入库按钮）。
  await panel.getByLabel(/评论正文/).fill('第一条评论：这篇的步骤很清楚。\n\n第二条评论：能讲讲背后的原因吗？')
  await panel.getByLabel('作者别名（可选，最多 100 字）').fill('读者甲')
  await panel.getByRole('button', { name: /入库第一条/ }).click()
  await expect(panel.getByTestId('inbox-comment-item')).toHaveCount(1)
  await expect(panel.getByLabel(/评论正文/)).toHaveValue('第二条评论：能讲讲背后的原因吗？')

  // AI 分类拟稿 → drafted；复制回执（剪贴板权限在 Chromium 测试里需授权）。
  const card = panel.getByTestId('inbox-comment-item').first()
  await card.getByRole('button', { name: 'AI 分类拟稿' }).click()
  await expect(card.getByTestId('comment-reply-draft')).toBeVisible()
  await expect(card).toContainText('已拟稿')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await card.getByRole('button', { name: '复制草稿' }).click()
  await expect(card).toContainText('已复制')
  await card.getByRole('button', { name: '确认已人工发送' }).click()
  await expect(card).toContainText('已人工回复')

  // 转为选题：同 key 幂等（UI 内部用评论 id 作 key）；确认对话框一次填标题。
  page.once('dialog', (dialog) => dialog.accept('为什么读者总在第二步放弃'))
  await card.getByRole('button', { name: '转为选题' }).click()
  await expect.poll(async () => {
    const list = await api(page, 'GET', `/accounts/${account.id}/topics`) as Array<{ title: string; source: string }>
    return list.filter((t) => t.title === '为什么读者总在第二步放弃').length
  }).toBe(1)
  const topics = await api(page, 'GET', `/accounts/${account.id}/topics`) as Array<{ title: string; source: string }>
  expect(topics.find((t) => t.title === '为什么读者总在第二步放弃')?.source).toBe('manual')

  // 删除清正文：软删后列表消失。
  page.once('dialog', (dialog) => dialog.accept())
  await card.getByRole('button', { name: '删除评论' }).click()
  await expect(panel.getByTestId('inbox-comment-item')).toHaveCount(0)
})

// DEV-CX13-E 补充旅程：本地空行解析超过 50 条时的分批提示——
// 计数显示 51 条待入库、gamboge 提示出现、入库仍按第一条逐条进行（无批量入库通道）。
test('DEV-CX13-E Web 粘贴 51 条显示分批提示且只入库第一条', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-inbox-web-51-${Date.now()}`)
  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const panel = page.getByTestId('comment-inbox-tab')
  await expect(panel).toBeVisible()

  const pasted = Array.from({ length: 51 }, (_, i) => `第${i + 1}条：读者留言内容验证解析计数。`).join('\n\n')
  await panel.getByLabel('评论正文').fill(pasted)
  await expect(panel.getByText('评论正文（空行分隔多条，共 51 条待入库；每条 1..5000 字）')).toBeVisible()
  await expect(panel.getByText('一次最多处理 50 条，请分批粘贴。')).toBeVisible()
  // 入库仍按第一条逐条进行。
  await panel.getByRole('button', { name: /^入库第一条/ }).click()
  await expect(panel.getByTestId('inbox-comment-item')).toHaveCount(1)
  // 入库后输入框回填其余 50 条：计数更新且恰好 50 条在限额内、不再提示分批。
  const rest = await panel.getByLabel('评论正文').inputValue()
  expect(rest.split(/\n\s*\n/).filter(Boolean).length).toBe(50)
  await expect(panel.getByText('评论正文（空行分隔多条，共 50 条待入库；每条 1..5000 字）')).toBeVisible()
  await expect(panel.getByText('一次最多处理 50 条，请分批粘贴。')).toHaveCount(0)
  // 服务端无批量写入：台账只有 1 条。
  const list = await api(page, 'GET', `/accounts/${account.id}/comments`) as { items: unknown[] }
  expect(list.items).toHaveLength(1)
})
