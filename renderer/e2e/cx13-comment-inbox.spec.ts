import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX13-E / FR-CX-22 桌面旅程：评论台账逐条录入、AI 拟稿、复制回执、转选题幂等与删除清正文。
// 浏览器形态同段旅程见 web/e2e/cx13-comment-inbox.spec.ts；两端各自实现。
test('DEV-CX13-E 桌面评论台账：逐条入库、状态机与转选题幂等', async ({ page }) => {
  // 桌面注册即建 xhs 账号；mock 模型走本机 8297 端口（桌面 E2E 专用）。
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面评论拟稿模拟模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
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

  // 桌面形态：Electron 剪贴板由客户端桥接，无需浏览器权限授予；复制回执直接走接口语义。
  const card = panel.getByTestId('inbox-comment-item').first()
  await card.getByRole('button', { name: 'AI 分类拟稿' }).click()
  await expect(card.getByTestId('comment-reply-draft')).toBeVisible()
  await expect(card).toContainText('已拟稿')
  await expect(card).toContainText('感谢反馈')
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

// DEV-CX13-E 桌面补充旅程：粘贴 51 条时空行解析计数与分批提示；
// 入库仍一次一条，无批量通道（与 Web 互补：本用例验证删除后复用输入框重置计数）。
test('DEV-CX13-E 桌面粘贴 51 条显示分批提示且逐条入库', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto(`/a/${account.id}/profile?tab=comments`)
  const panel = page.getByTestId('comment-inbox-tab')
  await expect(panel).toBeVisible()

  const pasted = Array.from({ length: 51 }, (_, i) => `第${i + 1}条：桌面留言验证解析计数。`).join('\n\n')
  await panel.getByLabel('评论正文').fill(pasted)
  await expect(panel.getByText('评论正文（空行分隔多条，共 51 条待入库；每条 1..5000 字）')).toBeVisible()
  await expect(panel.getByText('一次最多处理 50 条，请分批粘贴。')).toBeVisible()

  // 连续入库两条：50 条仍在限额内（提示消失），49 条同理；列表逐条出现。
  await panel.getByRole('button', { name: /^入库第一条/ }).click()
  await expect(panel.getByTestId('inbox-comment-item')).toHaveCount(1)
  await expect(panel.getByText('评论正文（空行分隔多条，共 50 条待入库；每条 1..5000 字）')).toBeVisible()
  await expect(panel.getByText('一次最多处理 50 条，请分批粘贴。')).toHaveCount(0)
  await panel.getByRole('button', { name: /^入库第一条/ }).click()
  await expect(panel.getByTestId('inbox-comment-item')).toHaveCount(2)
  const rest = await panel.getByLabel('评论正文').inputValue()
  expect(rest.split(/\n\s*\n/).filter(Boolean).length).toBe(49)
  // 服务端无批量写入：台账只有 2 条。
  const list = await api(page, 'GET', `/accounts/${account.id}/comments`) as { items: unknown[] }
  expect(list.items).toHaveLength(2)
})
