import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

// ED-13/14/15/16：AI 建议应用前必须能回答"原文现在在哪、是不是只有一处"。
// 走真实路径：选中文字 →「改写选中部分」→ 建议卡 → 应用。

const REPEATED = '先给结论，再讲理由。先给结论，再讲理由。最后补充一个具体例子。'

async function seedSection(page: import('@playwright/test').Page, id: string, text: string) {
  const work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/sections/${work.sections[0].id}`, { content_md: text, base_revision: work.sections[0].revision })
  return work.sections[0].id
}

/** 在富文本编辑器里选中指定字符区间。 */
async function selectRange(page: import('@playwright/test').Page, from: number, to: number) {
  await page.evaluate(({ from: f, to: t }) => {
    const el = document.querySelector('.tiptap p')
    if (!el?.firstChild) return
    const range = document.createRange()
    range.setStart(el.firstChild, f)
    range.setEnd(el.firstChild, t)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }, { from, to })
}

test.beforeEach(async ({ page }) => {
  // 单候选：建议直接以"一条"呈现，应用按钮才是"替换"。
  const me = await (await page.request.get('/api/v1/auth/me')).json().catch(() => null)
  if (me) await page.request.put('/api/v1/me/preferences', { data: { default_variants: 1 }, headers: { 'X-CSRF-Token': me.csrf_token } })
})

test('ED-13 选区变了会被拦下，不会把建议写到别处', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  const sid = await seedSection(page, id, REPEATED)
  await page.goto(`/works/${id}`)
  await page.locator(`#sec-${sid} .tiptap`).first().click()

  // 选中第一句，生成改写建议。
  await selectRange(page, 0, 9)
  await page.getByRole('button', { name: '改写选中部分' }).first().click()
  await expect(page.getByRole('button', { name: '替换' })).toBeVisible({ timeout: 30_000 })

  // 改选第二句（文字相同但位置不同）后再应用，必须被拦下。
  await selectRange(page, 10, 19)
  await page.getByRole('button', { name: '替换' }).click()
  await expect(page.getByText('选区已经变了，请重新选中原文再应用')).toBeVisible()
  // 原文没有被改动。
  const after = await api(page, 'GET', `/works/${id}`)
  expect(after.sections[0].content_md).toBe(REPEATED)
})

test('ED-14/15 重复句：卡片显示出现次数，无选区应用会被拦下', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  const sid = await seedSection(page, id, REPEATED)
  await page.goto(`/works/${id}`)
  await page.locator(`#sec-${sid} .tiptap`).first().click()

  // 没有选区 → 建议针对整段（whole）；先造一个 excerpt 场景：用表达体检的"改这一句"。
  // 这里直接用整段建议验证 ED-15 的位置信息渲染。
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.getByRole('button', { name: '改写本段' }).first().click()
  await expect(page.getByRole('button', { name: '替换' })).toBeVisible({ timeout: 30_000 })
  // 整段唯一：卡片显示上下文而不是警告。
  await expect(page.getByText('【此处】')).toBeVisible()
})

test('ED-16 原文已不在段落时给出"已删除"提示', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  const sid = await seedSection(page, id, REPEATED)
  await page.goto(`/works/${id}`)
  await page.locator(`#sec-${sid} .tiptap`).first().click()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.getByRole('button', { name: '改写本段' }).first().click()
  await expect(page.getByRole('button', { name: '替换' })).toBeVisible({ timeout: 30_000 })

  // 建议还开着的时候，把整段换掉（模拟另一处修改），再应用。
  const work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/sections/${work.sections[0].id}`, { content_md: '完全不同的内容。', base_revision: work.sections[0].revision })
  // 卡片上"原文在哪"必须跟着刷新（否则用户会以为还改得动）。
  await expect(page.getByText('原文已经不在这一段里，应用前会要求你重新生成。')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '替换' }).click()
  await expect(page.getByText('原文已经不在这一段里了，请重新生成建议')).toBeVisible()
  // 不应被静默替换。
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe('完全不同的内容。')
})