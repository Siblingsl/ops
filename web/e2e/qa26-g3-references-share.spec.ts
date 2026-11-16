import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-QA-02 批次 QA-B3（docs/26 G3-08/G3-14，docs/34 §14.7）：
// G3-08 对标参考提炼：添加参考链接（真实平台 robots 禁读 → 手动粘贴正文）→「提炼方法」
// （mock reference_analyze）→ 标题结构/开头钩子/段落/角度/标签/可借鉴读回；移入回收站。
// G3-14 分享保存：/share 带 title/text/url → 选收件箱或素材库 → 逐条落库读回，无自动。

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

test('DEV-QA26 G3-08 对标参考手动粘贴提炼与 G3-14 分享保存', async ({ page, baseURL }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `qa26-g3-ref-${Date.now()}`)

  // G3-08：添加参考链接 → 手动粘贴正文 → 提炼（mock 模型）→ 结构读回
  await page.goto(`/a/${account.id}/ops`)
  await page.getByLabel('单篇链接（每行一条，最多 20 条）').fill('https://www.xiaohongshu.com/explore/qa26ref0000000000000000000000ab12')
  await page.getByRole('button', { name: '添加参考链接' }).click()
  await expect.poll(async () => {
    const refs = (await apiFn(page, 'GET', `/accounts/${account.id}/references`)) as Array<{ id: string; status: string; url: string }>
    return refs.length
  }).toBeGreaterThan(0)
  const ref = (await apiFn(page, 'GET', `/accounts/${account.id}/references`)) as Array<{ id: string; status: string }>

  await page.getByRole('button', { name: '手动粘贴正文' }).first().click()
  await page.getByLabel('原文标题').fill('QA-B3 参考原文')
  await page.getByLabel('正文（仅用于方法提炼和相似度自查）').fill('这篇文章先给出结论，再用三个真实案例支撑，每段以问题开头，结尾邀请读者留言交流运营困惑。')
  await page.getByRole('button', { name: '提炼方法' }).click()
  await expect.poll(async () => {
    const refs = (await apiFn(page, 'GET', `/accounts/${account.id}/references`)) as Array<{ id: string; status: string; analysis?: { title_pattern?: string } | null }>
    return refs.find(r => r.id === ref[0].id)?.analysis?.title_pattern ?? ''
  }, { timeout: 30_000 }).not.toBe('')
  await expect(page.getByRole('main')).toContainText('标题结构')

  // 移入回收站（单项删除）
  await page.getByRole('button', { name: '移入回收站' }).first().click()
  await expect.poll(async () => {
    const refs = (await apiFn(page, 'GET', `/accounts/${account.id}/references`)) as Array<{ id: string }>
    return refs.length
  }).toBe(0)

  // G3-14：分享目标页（PWA share_target）→ 收件箱
  await page.goto(`/share?title=QA-B3 分享&text=运营灵感正文&url=https://example.com/share-src`)
  await page.getByRole('button', { name: '存入收件箱' }).click()
  await page.waitForURL(/topics\?tab=inbox|\/$/, { timeout: 15_000 })
  await expect.poll(async () => {
    const inbox = (await apiFn(page, 'GET', '/inbox')) as { items: Array<{ content: string }> }
    return (inbox.items ?? []).some(item => item.content.includes('运营灵感正文'))
  }).toBe(true)

  // 分享 → 素材库（case）
  await page.goto(`/share?text=QA-B3 素材分享正文&url=https://example.com/share-mat`)
  await page.getByRole('button', { name: '素材库', exact: false }).first().click()
  await page.getByRole('button', { name: '存入素材库' }).click()
  await page.waitForURL(/materials|\/$/, { timeout: 15_000 })
  await expect.poll(async () => {
    const mats = (await apiFn(page, 'GET', `/materials?account_id=${account.id}&scope=account`)) as Array<{ content: string }>
    return (mats ?? []).some(item => item.content.includes('QA-B3 素材分享正文'))
  }).toBe(true)
})
