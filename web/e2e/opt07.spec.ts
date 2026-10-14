import { test, expect, type Page } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

async function article(page: Page) {
  await registerAccount(page)
  const account = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '保存与修订验收号', content_format: 'long_article' })
  await page.goto(`/a/${account.id}`)
  const id = await createOutline(page)
  return api(page, 'GET', `/works/${id}`)
}

const dialogWithTitle = (page: Page, name: string | RegExp) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name, exact: typeof name === 'string' }) })

test('OPT63 三秒慢保存下连续改标题正文三十秒，合并串行且最终修订正确', async ({ page }) => {
  const work = await article(page)
  const section = work.sections[0]
  const block = page.locator(`#sec-${section.id}`)
  const heading = block.getByPlaceholder('段落小标题', { exact: true })
  const editor = block.locator('[contenteditable="true"]')
  let active = 0, peak = 0, requests = 0, conflicts = 0
  const snapshots: { heading: string; content_md: string; base_revision: number }[] = []
  await page.route(`**/api/v1/sections/${section.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    active++; peak = Math.max(peak, active); requests++
    snapshots.push(route.request().postDataJSON())
    await new Promise(resolve => setTimeout(resolve, 3000))
    const response = await route.fetch()
    if (response.status() === 409) conflicts++
    await route.fulfill({ response })
    active--
  })
  const began = Date.now()
  let index = 0, title = '', body = ''
  while (Date.now() - began < 30_000) {
    title = `连续编辑标题 ${index}`
    body = `连续编辑的正文 ${index}，这一版应当完整保存。`
    await heading.fill(title)
    await editor.fill(body)
    await page.waitForTimeout(500)
    await expect(dialogWithTitle(page, '这一段已在其他地方修改过')).toHaveCount(0)
    index++
  }
  await expect.poll(async () => {
    const current = await api(page, 'GET', `/works/${work.id}`)
    return { heading: current.sections[0].heading, content: current.sections[0].content_md, active }
  }, { timeout: 15_000 }).toEqual({ heading: title, content: body, active: 0 })
  const final = (await api(page, 'GET', `/works/${work.id}`)).sections[0]
  expect(peak).toBe(1)
  expect(conflicts).toBe(0)
  expect(requests).toBeGreaterThan(1)
  expect(final.revision).toBe(section.revision + requests)
  for (let i = 0; i < snapshots.length; i++) {
    expect(typeof snapshots[i].heading).toBe('string')
    expect(typeof snapshots[i].content_md).toBe('string')
    expect(snapshots[i].base_revision).toBe(section.revision + i)
  }
  const elapsed = Date.now() - began
  console.log(`OPT63 延迟3000ms、连续编辑${index}次/${elapsed}ms，保存${requests}次，在途峰值${peak}，冲突${conflicts}，修订${section.revision}→${final.revision}`)
})

test('OPT26 输入后立即重新起草，先保存且段落历史保留最新输入', async ({ page }) => {
  const work = await article(page)
  const section = work.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '已经保存的原正文。', base_revision: section.revision })
  await page.reload()
  const block = page.locator(`#sec-${section.id}`)
  const firstInput = '点击重新起草前刚输入的完整版本。'
  const latest = '保存等待期间继续输入的最后版本。'
  let draftRequests = 0
  let bodyAtDraft = ''
  let historyAtDraft: { content_md: string }[] = []
  let releaseSave!: () => void, saveStarted!: () => void
  const saving = new Promise<void>(resolve => { saveStarted = resolve })
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
  let saves = 0
  await page.route(`**/api/v1/sections/${section.id}`, async route => {
    if (route.request().method() === 'PATCH' && ++saves === 1) { saveStarted(); await saveGate }
    await route.continue()
  })
  await page.route(`**/api/v1/sections/${section.id}/draft`, async route => {
    draftRequests++
    historyAtDraft = await api(page, 'GET', `/sections/${section.id}/revisions`)
    bodyAtDraft = (await api(page, 'GET', `/works/${work.id}`)).sections[0].content_md
    await route.continue()
  })
  await block.locator('[contenteditable="true"]').fill(firstInput)
  await block.getByRole('button', { name: '重新起草', exact: true }).click()
  await dialogWithTitle(page, '重新起草这一段？').getByRole('button', { name: '重新起草', exact: true }).click()
  await saving
  await block.locator('[contenteditable="true"]').fill(latest)
  releaseSave()
  await expect.poll(() => draftRequests).toBe(1)
  await expect(block.getByRole('button', { name: '重新起草', exact: true })).toBeVisible()
  expect(bodyAtDraft).toBe(latest)
  expect(historyAtDraft.some(item => item.content_md === latest)).toBe(true)
  const history = await api(page, 'GET', `/sections/${section.id}/revisions`)
  expect(history.some((item: { content_md: string }) => item.content_md === latest)).toBe(true)
})

test('OPT07 起草期间另一标签保存，显示三选项、对比并按人工选择处理', async ({ page, context }) => {
  const original = await article(page)
  for (const choice of ['keep', 'replace']) {
    const work = choice === 'keep' ? original : await api(page, 'GET', `/works/${original.id}`)
    const section = work.sections[choice === 'keep' ? 0 : 1]
    const block = page.locator(`#sec-${section.id}`)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const candidate = choice === 'replace' ? '这是很好的安排。' : `这一段的 AI 候选结果：${choice}。`
    await page.route(`**/api/v1/sections/${section.id}/draft`, async route => {
      await gate
      const current = (await api(page, 'GET', `/works/${work.id}`)).sections.find((item: { id: string }) => item.id === section.id)
      await route.fulfill({ contentType: 'text/event-stream', body: `event: error\ndata: ${JSON.stringify({ code: 'version_conflict', message: '这段在生成期间被修改过', detail: { server: current, candidate, ...(choice === 'replace' ? { self_check: { fixes: [{ from: '最好的', to: '很好的', count: 1 }], original: '这是最好的安排。' } } : {}) } })}\n\n` })
    })
    await block.getByRole('button', { name: '起草本段', exact: true }).click()
    const other = await context.newPage()
    await other.goto(`/works/${work.id}`)
    const manual = `另一标签页保存的正文：${choice}。`
    await other.locator(`#sec-${section.id} [contenteditable="true"]`).fill(manual)
    await expect.poll(async () => (await api(other, 'GET', `/works/${work.id}`)).sections.find((item: { id: string }) => item.id === section.id).content_md).toBe(manual)
    await other.close()
    release()
    await expect(block.getByText('这段在生成期间被修改过', { exact: true })).toBeVisible()
    await expect(block.getByRole('button', { name: '替换', exact: true })).toBeVisible()
    await expect(block.getByRole('button', { name: '保留当前', exact: true })).toBeVisible()
    await block.getByRole('button', { name: '对比', exact: true }).click()
    const dialog = dialogWithTitle(page, '对比生成结果与当前内容')
    await expect(dialog.getByText(manual, { exact: true })).toBeVisible()
    await expect(dialog.getByText(candidate, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: choice === 'keep' ? '保留当前' : '替换', exact: true }).click()
    await expect(block.getByText('这段在生成期间被修改过', { exact: true })).toHaveCount(0)
    const current = (await api(page, 'GET', `/works/${work.id}`)).sections.find((item: { id: string }) => item.id === section.id)
    expect(current.content_md).toBe(choice === 'keep' ? manual : candidate)
    if (choice === 'replace') {
      await expect(block.getByText(/AI 自检修正了 1 处/)).toBeVisible()
      await block.getByRole('button', { name: '还原 AI 原文', exact: true }).click()
      await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).sections.find((item: { id: string }) => item.id === section.id).content_md).toBe('这是最好的安排。')
      await expect(block.locator('[contenteditable="true"]')).toHaveText('这是最好的安排。')
    }
  }
})

test('OPT07 标题与排序携带过期修订，显示对比并保留人工选择', async ({ page }) => {
  const work = await article(page)
  const title = page.locator('#step-title input').first()
  await title.fill('我选择的标题')
  await api(page, 'PATCH', `/works/${work.id}`, { title: '另一标签的标题', base_revision: work.revision })
  await title.blur()
  const dialog = dialogWithTitle(page, '这篇作品已在其他地方修改过')
  await expect(dialog.getByText(/另一标签的标题/)).toBeVisible()
  await expect(dialog.getByText(/我选择的标题/)).toBeVisible()
  await dialog.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).title).toBe('我选择的标题')
  await page.reload()
  await expect(title).toHaveValue('我选择的标题')
  const before = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, { summary: '另一标签更新的摘要', base_revision: before.revision })
  const first = page.locator(`#sec-${before.sections[0].id}`)
  await first.hover()
  await first.getByRole('button', { name: '下移', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).sections[0].id).toBe(before.sections[1].id)
  expect((await api(page, 'GET', `/works/${work.id}`)).summary).toBe('另一标签更新的摘要')
})

test('OPT07 历史恢复与重新确认大纲的过期修订通过对比处理', async ({ page }) => {
  const work = await article(page)
  const section = work.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '可回退的历史正文。', base_revision: section.revision })
  await page.reload()
  const block = page.locator(`#sec-${section.id}`)
  await block.getByRole('button', { name: '段落历史', exact: true }).click()
  await expect(dialogWithTitle(page, /段落历史/).getByRole('button', { name: '回退到这个版本', exact: true })).toBeEnabled()
  const current = await api(page, 'GET', `/works/${work.id}`)
  const latest = '另一标签保存的最新正文。'
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: latest, base_revision: current.sections[0].revision })
  await dialogWithTitle(page, /段落历史/).getByRole('button', { name: '回退到这个版本', exact: true }).click()
  const conflict = dialogWithTitle(page, '这一段已在其他地方修改过')
  await expect(conflict.getByText(latest, { exact: true })).toBeVisible()
  await expect(conflict.getByText('可回退的历史正文。', { exact: true })).toBeVisible()
  await conflict.getByRole('button', { name: '使用另一处的版本', exact: true }).click()
  await expect(block.locator('[contenteditable="true"]')).toHaveText(latest)
  const before = await api(page, 'GET', `/works/${work.id}`)
  await page.getByRole('button', { name: '修改大纲', exact: true }).click()
  await page.locator('#step-outline').getByPlaceholder('段落小标题', { exact: true }).first().fill('人工重新确认的小标题')
  await api(page, 'PATCH', `/works/${work.id}`, { summary: '大纲编辑期间更新的摘要', base_revision: before.revision })
  await page.locator('#step-outline').getByRole('button', { name: '确认大纲', exact: true }).click()
  const outlineConflict = dialogWithTitle(page, '这篇作品已在其他地方修改过')
  await expect(outlineConflict.getByText(/人工重新确认的小标题/)).toBeVisible()
  await outlineConflict.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).sections[0].heading).toBe('人工重新确认的小标题')
  expect((await api(page, 'GET', `/works/${work.id}`)).summary).toBe('大纲编辑期间更新的摘要')
})
