import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// T5-3 / T5-4 桌面配对（与 web/e2e/tpl-switch.spec.ts 同旅程独立实现）：
// CF-TPL-02~06 创作模板真实卡片旅程 + G3-15 编辑器模板切换 E2E。
// 桌面差异：WorkLayout 顶部 TemplateSwitch（同一 aria-label）、桌面构建面板 testid、
// 「派生」入口同排；无批量入口（D-117）。
test('G3-15/T5-3 桌面编辑器模板切换：切换不改段落且大纲可用', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟环境')
  const account = await registerAccount(page, '长图文', 'wechat_mp', `tpl-switch-desktop-${Date.now()}`)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'T5 桌面模板切换验收' }) as { id: string; revision: number }
  await page.goto(`/works/${work.id}`)

  const select = page.getByLabel('切换创作模板')
  await expect(select).toBeVisible()
  // 异步清单加载完成：2 个内置（CF-TPL-05 长图文）+ 通用写法（收起 select 内 option 恒 hidden，用 count）
  await expect(select.locator('option', { hasText: '（内置）' })).toHaveCount(2, { timeout: 10_000 })
  const optionCount = await select.evaluate((el: HTMLSelectElement) => el.querySelectorAll('option').length)
  expect(optionCount).toBe(3)

  // H-02 闸门要求先有观点（PATCH 后 revision 递增）
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '桌面模板切换验收用观点：切换模板不改已写段落。', base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: viewed.revision,
    items: [{ heading: '桌面模板切换章节', key_point: '段落不动', material_ids: [] }],
  }) as { sections: Array<{ id: string; revision: number }> }
  const sectionID = outlined.sections[0].id

  // 切到第一个与当前值不同的模板；服务端只改 template_id 不推进 revision（CF-TPL-04）
  const current = await select.inputValue()
  const target = await select.locator('option').evaluateAll(
    (opts: HTMLOptionElement[], cur: string) => {
      const cand = opts.filter(o => o.value && o.value !== cur)
      return cand.length > 0 ? cand[0].value : null
    }, current)
  if (target) {
    await select.selectOption(target)
    await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`) as { template_id: string | null }).template_id, { timeout: 10_000 }).toBe(target)
  }

  // 段落仍原样：work 大纲中该章节仍在（outline 条目按 heading 匹配）
  const after = await api(page, 'GET', `/works/${work.id}`) as { outline: Array<{ heading: string }>, revision: number }
  expect(after.outline.some(s => s.heading === '桌面模板切换章节')).toBe(true)
  expect(after.revision).toBeGreaterThanOrEqual(viewed.revision)

  // 桌面构建面板仍可达（大纲起草入口未锁死）
  await expect(page.getByTestId('work-build-panel')).toBeVisible()
  expect(sectionID).toBeTruthy()
})
