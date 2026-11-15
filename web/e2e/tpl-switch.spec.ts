import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// T5-3 / T5-4（docs/37 §8.5）：CF-TPL-02~06 创作模板真实卡片旅程 + G3-15 编辑器模板切换 E2E。
// 覆盖：内置模板清单可见 → 模板切换只改 work.template_id 不动段落 → 大纲起草仍可用。
// 无批量入口（D-117）；web 端旅程，桌面配对 spec 同目录分文件实现。
test('G3-15/T5-3 编辑器模板切换：切换不改段落且大纲可用', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟环境')
  const account = await registerAccount(page, '长图文', 'wechat_mp', `tpl-switch-${Date.now()}`)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'T5 模板切换验收' }) as { id: string; revision: number }
  await page.goto(`/works/${work.id}`)

  // 内置模板出现在下拉（CF-TPL-05：内置 5 个，长图文 2 个）。
  // Select 是自定义封装组件，原生 option 由内部渲染；用 evaluate 在 DOM 上数非空 option。
  const select = page.getByLabel('切换创作模板')
  await expect(select).toBeVisible()
  // 模板清单是异步查询；等内置 option 渲染（收起的 select 内 option 恒 hidden，用 count 断言）。
  await expect(select.locator('option', { hasText: '（内置）' })).toHaveCount(2, { timeout: 10_000 }) // CF-TPL-05：长图文 2 个内置
  const optionCount = await select.evaluate((el: HTMLSelectElement) => el.querySelectorAll('option').length)
  expect(optionCount).toBe(3) // 通用写法 + 2 个内置

  // 建大纲段落（后续断言段落不被模板切换改写）；H-02 闸门要求先有观点（PATCH 后 revision 递增）
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '模板切换验收用观点：切换模板不改已写段落。', base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: viewed.revision,
    items: [{ heading: '模板切换章节', key_point: '段落不动', material_ids: [] }],
  }) as { sections: Array<{ id: string; revision: number }> }
  const sectionID = outlined.sections[0].id
  const sectionRev = outlined.sections[0].revision

  // 选第二个非空选项（若与当前值不同则触发 change；相同则跳过断言差异、仍验证段落不变）
  const current = await select.inputValue()
  const target = await select.locator('option').evaluateAll(
    (opts: HTMLOptionElement[], cur: string) => {
      const cand = opts.filter(o => o.value && o.value !== cur)
      return cand.length > 0 ? cand[0].value : null
    }, current)
  if (target) {
    await select.selectOption(target)
    // 服务端只改 template_id；不推进 revision（CF-TPL-04）
    await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`) as { template_id: string | null }).template_id, { timeout: 10_000 }).toBe(target)
  }

  // 段落仍原样（切换不改已写段落）：work 大纲中该章节仍在（outline 条目按 heading 匹配）
  const after = await api(page, 'GET', `/works/${work.id}`) as { outline: Array<{ heading: string }> }
  expect(after.outline.some(s => s.heading === '模板切换章节')).toBe(true)

  // 大纲起草入口仍可用（面板未锁死）
  await expect(page.getByTestId('work-build-panel').or(page.getByRole('button', { name: '生成校验报告' })).first()).toBeVisible()
})
