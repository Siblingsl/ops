import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('NW-B1/B2/B3 首屏标题占位、H-03 可一键去大纲、右栏不出现不可能的提示', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)

  // B1：标题有占位，不再是无法理解的空行。
  await expect(page.getByPlaceholder('未命名作品 · 标题可以最后再定')).toBeVisible()

  // B3：空白作品右栏不出现"点一下任意段落"。
  await expect(page.getByText('点一下任意段落')).toHaveCount(0)

  // B2：正文的 H-03 提示带按钮，点了能到"确认大纲"。
  const gate = page.locator('text=确认大纲后，这里会按大纲生成段落块').locator('..')
  await expect(gate.getByRole('button', { name: /去(写|确认)大纲/ })).toBeVisible()
  await gate.getByRole('button', { name: /去(写|确认)大纲/ }).click()
  await expect(page.getByRole('button', { name: '确认大纲', exact: true })).toBeInViewport()
})

test('NW-B6 页头可直接给空作品命名', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '' })
  await page.goto(`/works/${work.id}`)
  const header = page.getByRole('button', { name: /未命名作品/ })
  await expect(header).toBeVisible()
  await header.click()
  const input = page.getByRole('textbox', { name: '作品标题' })
  await input.fill('页头命名的作品')
  await input.press('Enter')
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).title).toBe('页头命名的作品')
})

test('NW-B4 微头条的第 4 步不以内部名称为完成条件', async ({ page }) => {
  const account = await registerAccount(page, '微头条', 'toutiao')
  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await panel.getByRole('radio', { name: '微头条' }).check()
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const step = page.getByRole('link', { name: /内部名称与话题（可选）/ })
  await expect(step).toBeVisible()
  // 步骤标记为已完成（圆点变勾），不要求先填内部名称。
  await expect(step.locator('svg').first()).toHaveClass(/text-ink-500/)
})

test('NW-B7 图片计数不再像目标；空主题不能生成封面', async ({ page }) => {
  const account = await registerAccount(page)
  // 小红书：计数文案是"已选 n 张（最多 18 张）"，不再是 0 / 18 的目标感。
  const xhs = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '' })
  await page.goto(`/works/${xhs.id}`)
  await expect(page.getByText(/已选 0 张（最多 18 张）/)).toBeVisible()

  // 公众号：标题与观点都为空时不能生成封面。
  const wx = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${wx.id}/works`, { title: '' })
  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: 'AI 封面候选', exact: true }).click()
  await expect(page.getByText('先写下标题或核心观点，再让 AI 生成封面')).toBeVisible()
})

test('专注模式下仍可打开大纲确认', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '专注模式大纲' })
  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '专注模式（F11）' }).click()
  await page.getByRole('button', { name: '确认大纲后起草' }).click()
  await expect(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '生成与确认大纲', exact: true }) })).toBeVisible()
})
