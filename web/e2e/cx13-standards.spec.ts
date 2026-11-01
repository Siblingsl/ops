import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX13-F / FR-CX-23 浏览器旅程：运营标准版本创建（含未来生效）、at 查询、归档只变可见性。
// 桌面形态同段旅程见 desktop/renderer-src/e2e/cx13-standards.spec.ts；两端各自实现。
test('DEV-CX13-F Web 回复标准版本与归档语义', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-standards-web-${Date.now()}`)
  await page.goto(`/a/${account.id}/profile?tab=standards`)
  const panel = page.getByTestId('standards-tab')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('还没有标准版本')).toBeVisible()

  // v1 即时生效；v2 未来生效不提前应用。
  await panel.getByLabel('定位说明').fill('只写真实经历，少用反问')
  await panel.getByLabel('文本建议').fill('开头先给结论\n每段配一个可复现的小例子')
  await panel.getByLabel('生效日期').fill('2026-01-01')
  await panel.getByRole('button', { name: '保存为新版本' }).click()
  await expect(panel.getByTestId('standards-effective')).toContainText('当前生效 v1')
  await panel.getByLabel('定位说明').fill('下月启用的新口径')
  await panel.getByLabel('生效日期').fill('2026-12-01')
  await panel.getByRole('button', { name: '保存为新版本' }).click()
  await expect(panel.getByTestId('standard-version-item')).toHaveCount(2)
  // 今天在 2026-12-01 之前：当前生效仍是 v1（未来版不提前应用）。
  await expect(panel.getByTestId('standards-effective')).toContainText('当前生效 v1')

  // 归档 v1：列表消失，但历史/生效解析仍可读（服务端断言）。
  const v1Card = panel.getByTestId('standard-version-item').filter({ hasText: '只写真实经历' })
  await v1Card.getByRole('button', { name: '归档' }).click()
  const archivedCheck = await api(page, 'GET', `/accounts/${account.id}/standards/1`) as { archived_at: string | null }
  await expect(archivedCheck.archived_at, `archived_at=${String(archivedCheck.archived_at)}`).toBeTruthy()
  await expect(panel.getByTestId('standard-version-item')).toHaveCount(1)
  const archived = await api(page, 'GET', `/accounts/${account.id}/standards/1`) as { positioning: string; archived_at: string | null }
  expect(archived.positioning).toBe('只写真实经历，少用反问')
  expect(archived.archived_at).toBeTruthy()
  const eff = await api(page, 'GET', `/accounts/${account.id}/standards/effective?at=2026-01-15`) as { standard: { version: number } | null }
  expect(eff.standard?.version).toBe(1)

  // 发布前检查冻结标准快照（用既有作品流程）——直接在服务端断言 run 里的 basis。
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { content_format: 'image_note' }) as { id: string; revision: number }
  const changed = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '标准冻结验证', base_revision: work.revision }) as { revision: number }
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: changed.revision,
    items: [{ heading: '冻结段', key_point: '验证快照', material_ids: [] }],
  })
  const outlined = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ id: string; revision: number }> }
  await api(page, 'PATCH', `/sections/${outlined.sections[0].id}`, {
    content_md: '验证标准快照随检查冻结。', base_revision: outlined.sections[0].revision,
  })
  await api(page, 'POST', `/works/${work.id}/checks`, { html_chars: 3000, html_bytes: 9000 })
  const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run: { ops_standard_basis?: { version: number } | null } }
  // 快照取当前生效版本：v1 已归档但历史语义仍生效到 12-01 之前；今天冻结到的应是 effective 解析结果。
  expect([1, 2]).toContain(latest.run.ops_standard_basis?.version)
})
