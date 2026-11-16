import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-QA-02 批次 QA-B1（docs/26 G2-06/G2-07，docs/34 §14.7）：
// G2-06 账号定位档案（positioning tab 保存 + GET 读回）；
// G2-07 风格样本管理（新增/编辑/删除回收站语义/数量上限提示）。
// 无外部依赖：AI 提炼走既有 mock 模型路由的路径不触发也能走查（人工编辑为主）。

async function apiFn(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

test('DEV-QA26 G2-06 定位档案保存读回与 G2-07 风格样本增改删', async ({ page, baseURL }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `qa26-g2-profile-${Date.now()}`)
  await page.goto(`/a/${account.id}/profile`)
  await expect(page.getByRole('main')).toContainText('定位')

  // G2-06：定位 tab 编辑保存 → GET 读回
  await page.getByLabel('目标读者', { exact: true }).fill('刚入行的运营新人')
  await page.getByLabel('人设与语气', { exact: true }).fill('克制、直接、给步骤')
  await page.getByPlaceholder('职场 效率 新人成长').fill('运营, 写作')
  await page.getByRole('button', { name: /保存/ }).first().click()
  await expect(page.getByText('定位档案已保存')).toBeVisible()
  await expect.poll(async () => {
    const p = (await apiFn(page, 'GET', `/accounts/${account.id}/profile`)) as { target_audience: string; persona_tone: string; positioning_tags: string[] }
    return p.target_audience === '刚入行的运营新人' && p.persona_tone === '克制、直接、给步骤' && p.positioning_tags.join(',') === '运营,写作'
  }).toBe(true)

  // G2-07：风格样本 tab → 新增 → 列表读回 → 编辑 → 删除（确认）→ 读回不存在
  await page.goto(`/a/${account.id}/profile?tab=samples`)
  const sampleText = 'QA-B1 样本验收正文：先给结论再给依据，段落短，结尾留一个具体行动。'.repeat(3)
  await page.getByRole('button', { name: '粘贴第一篇样本' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('标题', { exact: true }).fill('QA-B1 样本')
  await dialog.getByLabel('正文').fill(sampleText)
  await dialog.getByRole('button', { name: /保存/ }).click()
  await expect(page.getByText('QA-B1 样本').first()).toBeVisible()
  await expect.poll(async () => {
    const list = (await apiFn(page, 'GET', `/accounts/${account.id}/style-samples`)) as Array<{ title: string; char_count: number }>
    return list.length === 1 && list[0].title === 'QA-B1 样本' && list[0].char_count > 0
  }).toBe(true)

  // 编辑标题
  await page.locator('li', { hasText: 'QA-B1 样本' }).hover()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editDialog = page.getByRole('dialog')
  await editDialog.getByLabel('标题', { exact: true }).fill('QA-B1 样本（改）')
  await editDialog.getByRole('button', { name: /保存/ }).click()
  await expect(page.getByText('QA-B1 样本（改）').first()).toBeVisible()

  // 删除：确认对话框 → 服务端读回不存在
  await page.locator('li', { hasText: 'QA-B1 样本（改）' }).hover()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog').filter({ hasText: '删除' }).getByRole('button', { name: '删除', exact: true }).click()
  await expect.poll(async () => {
    const list = (await apiFn(page, 'GET', `/accounts/${account.id}/style-samples`)) as Array<{ title: string }>
    return list.length
  }).toBe(0)

  // 空态回归
  await expect(page.getByText('还没有风格样本')).toBeVisible()
})
