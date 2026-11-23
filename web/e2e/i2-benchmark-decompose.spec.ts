import { expect, test, type Page } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

// REF41 I2 浏览器旅程：AI 初拆只写草稿，确认才写结构；丢弃/失败保留旧结构；批量≤5且无批量确认。
// 只使用隔离本地 API 与 mock 模型，不访问真实竞对 URL，不复制原文。

async function seedTarget(page: Page, accountId: string, name: string) {
  return api(page, 'POST', `/accounts/${accountId}/benchmarks`, {
    platform: 'xhs', name, positioning: 'I2 竞对拆解验收',
  }) as Promise<{ id: string }>
}

async function seedNote(page: Page, targetId: string, title: string) {
  return api(page, 'POST', `/benchmarks/${targetId}/notes`, {
    title, content_summary: '开头用问题带入；中段拆三步做法；结尾给可验证结果。', structure: { manual: 'keep' }, metrics_snapshot: { followers: 1200, likes: 340 },
  }) as Promise<{ id: string; structure: Record<string, unknown>; structure_hash: string; revision: number }>
}

async function routeModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web I2 竞对拆解模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'benchmark_decompose', provider_id: provider.id, model: 'mock-writer' }])
}

test('Web 竞对拆解草稿确认、丢弃与旧结构保护', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-web-${Date.now()}`)
  await routeModel(page)
  const target = await seedTarget(page, account.id, `I2 Web 对标 ${Date.now()}`)
  const note = await seedNote(page, target.id, 'I2 单篇拆解')
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  const targetCard = panel.getByTestId('benchmark-target-item').filter({ hasText: `I2 Web 对标` })
  await expect(targetCard).toHaveCount(1)
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  const noteCard = targetCard.getByTestId('benchmark-note-item').filter({ hasText: 'I2 单篇拆解' })
  await expect(noteCard).toHaveCount(1)
  await expect(noteCard.getByTestId('benchmark-note-content-summary')).toContainText('开头用问题带入')

  await noteCard.getByTestId('benchmark-note-decompose').click()
  const draft = noteCard.getByTestId('benchmark-decompose-draft')
  await expect(draft).toBeVisible()
  await expect(draft.getByTestId('benchmark-decompose-source')).toContainText('原文摘要')
  await expect(draft.getByTestId('benchmark-decompose-source')).toContainText('开头用问题带入')
  await expect.poll(async () => (await api(page, 'GET', `/benchmark-notes/${note.id}`)).decompose_state).toBe('ai_draft')
  await page.screenshot({ path: '../.playwright-results/web/i2-web-benchmark-decompose.png' })
  const before = await api(page, 'GET', `/benchmark-notes/${note.id}`) as { structure: Record<string, unknown>; structure_hash: string; revision: number }
  expect(before.structure).toEqual({ manual: 'keep' })
  expect(before.structure_hash).toBe(note.structure_hash)
  expect(before.revision).toBe(note.revision)

  await draft.getByTestId('benchmark-decompose-hook').fill('E2E 编辑后的钩子')
  await draft.getByTestId('benchmark-decompose-structure').fill('编辑后的第一段\n编辑后的第二段')
  await draft.getByTestId('benchmark-decompose-confirm').click()
  await expect(noteCard.getByTestId('benchmark-decompose-confirmed')).toBeVisible()
  const confirmed = await api(page, 'GET', `/benchmark-notes/${note.id}`) as {
    structure: Record<string, unknown>; decompose_state: string; decompose_revision: number;
    structure_hash: string; revision: number; takeaways: string[]; not_borrowable: string[];
  }
  expect(confirmed.decompose_state).toBe('confirmed')
  expect(confirmed.decompose_revision).toBe(1)
  expect(confirmed.revision).toBe(note.revision + 1)
  expect(confirmed.structure.hook).toBe('E2E 编辑后的钩子')
  expect(confirmed.structure_hash).not.toBe(note.structure_hash)
  expect(confirmed.structure_hash).toHaveLength(64)
  expect(confirmed.takeaways.length).toBeGreaterThan(0)
  expect(confirmed.not_borrowable.length).toBeGreaterThan(0)

  // 已确认后再次初拆，再丢弃：structure 不回到草稿/不被清空。
  const confirmedStructure = confirmed.structure
  await noteCard.getByTestId('benchmark-note-decompose').click()
  await expect(noteCard.getByTestId('benchmark-decompose-draft')).toBeVisible()
  await noteCard.getByTestId('benchmark-decompose-discard').click()
  await expect(noteCard.getByTestId('benchmark-decompose-draft')).toHaveCount(0)
  const discarded = await api(page, 'GET', `/benchmark-notes/${note.id}`) as { structure: Record<string, unknown>; decompose_state: string }
  expect(discarded.decompose_state).toBe('none')
  expect(discarded.structure).toEqual(confirmedStructure)
})

test('Web 批量初拆最多 5 条、逐条确认且无批量确认', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-web-batch-${Date.now()}`)
  await routeModel(page)
  const target = await seedTarget(page, account.id, `I2 Web 批量 ${Date.now()}`)
  const notes = []
  for (let i = 0; i < 5; i += 1) notes.push(await seedNote(page, target.id, `I2 批量笔记 ${i + 1}`))
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  const targetCard = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I2 Web 批量' })
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  await expect(targetCard.getByTestId('benchmark-note-item')).toHaveCount(5)
  const checks = targetCard.getByTestId('benchmark-note-select')
  for (let i = 0; i < 5; i += 1) await checks.nth(i).check()
  await expect(targetCard.getByTestId('benchmark-decompose-batch')).toContainText('已选 5/5')
  await targetCard.getByTestId('benchmark-decompose-batch-button').click()
  await expect(targetCard.getByTestId('benchmark-decompose-draft')).toHaveCount(5)
  for (const note of notes) {
    await expect.poll(async () => (await api(page, 'GET', `/benchmark-notes/${note.id}`)).decompose_state).toBe('ai_draft')
  }
  await expect(page.getByRole('button', { name: /批量确认/ })).toHaveCount(0)
  const firstNote = targetCard.getByTestId('benchmark-note-item').filter({ hasText: 'I2 批量笔记 1' })
  await firstNote.getByTestId('benchmark-decompose-hook').fill('批量后逐条编辑')
  await firstNote.getByTestId('benchmark-decompose-confirm').click()
  await expect(firstNote.getByTestId('benchmark-decompose-confirmed')).toBeVisible()
  const one = await api(page, 'GET', `/benchmark-notes/${notes[0].id}`) as { decompose_state: string }
  expect(one.decompose_state).toBe('confirmed')
  const other = await api(page, 'GET', `/benchmark-notes/${notes[1].id}`) as { decompose_state: string }
  expect(other.decompose_state).toBe('ai_draft')
})

test('REF41 I2 Web：批量初拆 502 显示错误并可重试', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-web-error-${Date.now()}`)
  await routeModel(page)
  const target = await seedTarget(page, account.id, `I2 Web 异常对标 ${Date.now()}`)
  await seedNote(page, target.id, 'I2 Web 异常笔记')
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const targetCard = page.getByTestId('benchmark-tab').getByTestId('benchmark-target-item').filter({ hasText: 'I2 Web 异常对标' })
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  await targetCard.getByTestId('benchmark-note-select').check()
  const route = '**/benchmark/decompose-batch'
  await page.route(route, (r) => r.fulfill({
    status: 502, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'bad_gateway', message: '模型服务暂时不可用（I2 502）' } }),
  }))
  await targetCard.getByTestId('benchmark-decompose-batch-button').click()
  await expect(targetCard.getByText('模型服务暂时不可用（I2 502）')).toBeVisible()
  await page.unroute(route)
  await targetCard.getByTestId('benchmark-decompose-batch-button').click()
  await expect(targetCard.getByTestId('benchmark-decompose-draft')).toBeVisible()
})

test('REF41 I2 Web：空摘要时 AI 初拆按钮禁用', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-web-empty-${Date.now()}`)
  const target = await seedTarget(page, account.id, `I2 Web 空摘要对标 ${Date.now()}`)
  await api(page, 'POST', `/benchmarks/${target.id}/notes`, { title: 'I2 Web 空摘要笔记', structure: { manual: 'keep' } })
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const targetCard = page.getByTestId('benchmark-tab').getByTestId('benchmark-target-item').filter({ hasText: 'I2 Web 空摘要对标' })
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  const noteCard = targetCard.getByTestId('benchmark-note-item').filter({ hasText: 'I2 Web 空摘要笔记' })
  await expect(noteCard.getByTestId('benchmark-note-decompose')).toBeDisabled()
})
