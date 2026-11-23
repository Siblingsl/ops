import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I2 桌面渲染器旅程：竞对笔记草稿 → 逐条确认/丢弃；批量只生成草稿，不批量入库。
// 桌面形态使用本文件与 renderer/e2e/support.ts，不读取 web/e2e。

const mockBase = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'

async function seedTargetForDesktop(page: Page, accountId: string, name: string) {
  return api(page, 'POST', `/accounts/${accountId}/benchmarks`, {
    platform: 'xhs', name, positioning: '桌面 I2 验收',
  }) as Promise<{ id: string }>
}

async function seedDesktopNote(page: Page, targetId: string, title: string) {
  return api(page, 'POST', `/benchmarks/${targetId}/notes`, {
    title, content_summary: '桌面用例摘要：先给结论，再拆步骤，最后收束。', structure: { manual: 'desktop-keep' }, metrics_snapshot: { followers: 800 },
  }) as Promise<{ id: string; structure_hash: string }>
}

test('桌面竞对拆解：批量草稿、逐条确认与丢弃保留旧结构', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-desktop-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面 I2 竞对拆解模拟模型', base_url: mockBase, api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'benchmark_decompose', provider_id: provider.id, model: 'mock-writer' }])

  const target = await seedTargetForDesktop(page, account.id, 'I2 桌面批量对标')
  const notes = []
  for (let i = 0; i < 5; i += 1) notes.push(await seedDesktopNote(page, target.id, `桌面拆解 ${i + 1}`))
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  const targetCard = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I2 桌面批量对标' })
  await expect(targetCard).toHaveCount(1)
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  await expect(targetCard.getByTestId('benchmark-note-item')).toHaveCount(5)
  await expect(targetCard.getByTestId('benchmark-note-content-summary').first()).toContainText('桌面用例摘要')

  const checks = targetCard.getByTestId('benchmark-note-select')
  for (let i = 0; i < 5; i += 1) await checks.nth(i).check()
  await targetCard.getByTestId('benchmark-decompose-batch-button').click()
  await expect(targetCard.getByTestId('benchmark-decompose-draft')).toHaveCount(5)
  await expect(targetCard.getByTestId('benchmark-decompose-source').first()).toContainText('原文摘要')
  await expect(targetCard.getByTestId('benchmark-decompose-source').first()).toContainText('桌面用例摘要')
  for (const note of notes) {
    await expect.poll(async () => (await api(page, 'GET', `/benchmark-notes/${note.id}`)).decompose_state).toBe('ai_draft')
    const beforeConfirm = await api(page, 'GET', `/benchmark-notes/${note.id}`) as { structure: Record<string, unknown> }
    expect(beforeConfirm.structure).toEqual({ manual: 'desktop-keep' })
  }

  const first = targetCard.getByTestId('benchmark-note-item').filter({ hasText: '桌面拆解 1' })
  await first.getByTestId('benchmark-decompose-hook').fill('桌面编辑后的钩子')
  await first.getByTestId('benchmark-decompose-confirm').click()
  await expect(first.getByTestId('benchmark-decompose-confirmed')).toBeVisible()
  const confirmed = await api(page, 'GET', `/benchmark-notes/${notes[0].id}`) as {
    structure: Record<string, unknown>; decompose_state: string; decompose_revision: number; structure_hash: string
  }
  expect(confirmed.decompose_state).toBe('confirmed')
  expect(confirmed.decompose_revision).toBe(1)
  expect(confirmed.structure.hook).toBe('桌面编辑后的钩子')
  expect(confirmed.structure_hash).not.toBe(notes[0].structure_hash)

  const second = targetCard.getByTestId('benchmark-note-item').filter({ hasText: '桌面拆解 2' })
  await second.getByTestId('benchmark-decompose-discard').click()
  await expect(second.getByTestId('benchmark-decompose-draft')).toHaveCount(0)
  const discarded = await api(page, 'GET', `/benchmark-notes/${notes[1].id}`) as { structure: Record<string, unknown>; decompose_state: string }
  expect(discarded.decompose_state).toBe('none')
  expect(discarded.structure).toEqual({ manual: 'desktop-keep' })
  await expect(page.getByRole('button', { name: /批量确认/ })).toHaveCount(0)

  await page.screenshot({ path: '../.playwright-results/desktop-renderer/i2-desktop-benchmark-decompose.png' })
})

test('REF41 I2 桌面：批量初拆 502 显示错误并可重试', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-desktop-error-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面 I2 异常态模拟模型', base_url: mockBase, api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'benchmark_decompose', provider_id: provider.id, model: 'mock-writer' }])
  const target = await seedTargetForDesktop(page, account.id, 'I2 桌面异常对标')
  await seedDesktopNote(page, target.id, 'I2 桌面异常笔记')
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const targetCard = page.getByTestId('benchmark-tab').getByTestId('benchmark-target-item').filter({ hasText: 'I2 桌面异常对标' })
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  await targetCard.getByTestId('benchmark-note-select').check()
  const route = '**/benchmark/decompose-batch'
  await page.route(route, (r) => r.fulfill({
    status: 502, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'bad_gateway', message: 'C 类 I2 桌面模型服务暂时不可用' } }),
  }))
  await targetCard.getByTestId('benchmark-decompose-batch-button').click()
  await expect(targetCard.getByText('C 类 I2 桌面模型服务暂时不可用')).toBeVisible()
  await page.unroute(route)
  await targetCard.getByTestId('benchmark-decompose-batch-button').click()
  await expect(targetCard.getByTestId('benchmark-decompose-draft')).toBeVisible()
})

test('REF41 I2 桌面：空摘要时 AI 初拆按钮禁用', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `i2-desktop-empty-${Date.now()}`)
  const target = await seedTargetForDesktop(page, account.id, 'I2 桌面空摘要对标')
  await api(page, 'POST', `/benchmarks/${target.id}/notes`, { title: 'I2 桌面空摘要笔记', structure: { manual: 'desktop-keep' } })
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const targetCard = page.getByTestId('benchmark-tab').getByTestId('benchmark-target-item').filter({ hasText: 'I2 桌面空摘要对标' })
  await targetCard.getByRole('button', { name: /笔记拆解库/ }).click()
  const noteCard = targetCard.getByTestId('benchmark-note-item').filter({ hasText: 'I2 桌面空摘要笔记' })
  await expect(noteCard.getByTestId('benchmark-note-decompose')).toBeDisabled()
})
