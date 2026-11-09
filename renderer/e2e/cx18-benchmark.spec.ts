import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX12 / FR-CX-18 桌面旅程：对标账号库两层库、四问投影、归档恢复与笔记登记。
// 只用隔离本地 API；不访问对标 URL，不生成任何内容。
test('桌面对标库登记、四问投影、笔记与归档恢复闭环', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx18-benchmark-${Date.now()}`)
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('对标账号库')

  // 创建两个对标：一个带 URL、一个无 URL。
  await panel.getByLabel('名称（1..100 码点）').fill('对标小绿书')
  await panel.getByLabel('主页 URL（可选）').fill('https://www.xiaohongshu.com/user/example#frag')
  await panel.getByLabel('定位摘要（可选）').fill('只写真实经历的小红书账号')
  await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  await expect(panel.getByTestId('benchmark-target-item')).toHaveCount(1)
  await panel.getByLabel('名称（1..100 码点）').fill('无主页对标')
  await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  await expect(panel.getByTestId('benchmark-target-item')).toHaveCount(2)

  // 列表按 fit_score/ID 排序会随创建顺序变化，用固定名称文本定位目标卡片。
  const first = panel.getByTestId('benchmark-target-item').filter({ hasText: '对标小绿书' })
  await expect(first).toHaveCount(1)
  await expect(first).toContainText('https://www.xiaohongshu.com/user/example')
  // 四问：yes=25/no=0/unknown 不计分；不足 4 问时显示待服务端计算。
  await first.getByLabel('起点可持续答案').selectOption('yes')
  await expect(first.getByLabel('起点可持续答案')).toHaveValue('yes')
  await first.getByLabel('起点可持续理由').fill('选题方向可以长期产出')
  await expect(first).toContainText('已答 1/4')
  await first.getByLabel('效果非单篇答案').selectOption('no')
  await expect(first.getByLabel('效果非单篇答案')).toHaveValue('no')
  await first.getByLabel('效果非单篇理由').fill('数据主要靠一篇爆款')
  await expect(first).toContainText('已答 2/4 · 总分待四问答完由服务端计算')
  await first.getByLabel('读者匹配答案').selectOption('yes')
  await first.getByLabel('读者匹配理由').fill('读者画像与我方一致')
  await first.getByLabel('材料能力支持答案').selectOption('no')
  await first.getByLabel('材料能力支持理由').fill('我方暂无对应素材')
  await first.getByRole('button', { name: '保存四问', exact: true }).click()
  await expect(first).toContainText('fit_score 50')
  await expect(first).toContainText('weak_fit')

  // yes 缺理由被服务端拒绝：先清空一个理由再保存。
  await first.getByLabel('读者匹配答案').selectOption('yes')
  await first.getByLabel('读者匹配理由').fill('')
  await first.getByRole('button', { name: '保存四问', exact: true }).click()
  await expect(first).toContainText('必须给出')

  // URL 重复 409：fragment 与默认端口不参与识别，同一路径再次登记被拒；不同查询参数视为不同 URL。
  await panel.getByLabel('名称（1..100 码点）').fill('重复URL对标')
  await panel.getByLabel('主页 URL（可选）').fill('https://www.xiaohongshu.com/user/example?x=1#top')
  await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  await expect(panel.getByTestId('benchmark-target-item')).toHaveCount(3)
  await panel.getByLabel('名称（1..100 码点）').fill('真重复对标')
  await panel.getByLabel('主页 URL（可选）').fill('https://WWW.xiaohongshu.com/user/example#other')
  await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  await expect(panel).toContainText('同账号同平台已存在该 URL')
  // 409 后表单保留输入；换不同路径可创建（fragment 不参与识别）。
  await panel.getByLabel('主页 URL（可选）').fill('https://www.xiaohongshu.com/user/other')
  await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  await expect(panel.getByTestId('benchmark-target-item')).toHaveCount(4)

  // 笔记登记、同 URL 拒绝、归档恢复。
  const notesToggle = first.getByRole('button', { name: /笔记拆解库/ })
  await notesToggle.click()
  await first.getByLabel('笔记标题').fill('爆文拆解一')
  await first.getByLabel('来源 URL（可选）').fill('https://www.xiaohongshu.com/explore/note-1')
  await first.getByLabel('学到什么（takeaway）').fill('钩子先立冲突场景')
  await first.getByLabel('不借鉴什么').fill('虚构数据佐证')
  await first.getByRole('button', { name: '登记笔记', exact: true }).click()
  await expect(first.getByTestId('benchmark-note-item')).toHaveCount(1)
  // 表单成功后已清空；重填同 URL 触发 409，再清空 URL 走无 URL 笔记。
  await first.getByLabel('笔记标题').fill('同URL笔记')
  await first.getByLabel('来源 URL（可选）').fill('https://www.xiaohongshu.com/explore/note-1')
  await first.getByRole('button', { name: '登记笔记', exact: true }).click()
  await expect(first).toContainText('该对标账号下已存在同 URL 的笔记')
  await first.getByLabel('来源 URL（可选）').fill('')
  await first.getByLabel('笔记标题').fill('无URL笔记')
  await first.getByRole('button', { name: '登记笔记', exact: true }).click()
  await expect(first.getByTestId('benchmark-note-item')).toHaveCount(2)
  const noteItem = first.getByTestId('benchmark-note-item').first()
  await noteItem.getByRole('button', { name: '归档', exact: true }).click()
  await expect(first.getByTestId('benchmark-note-item')).toHaveCount(1)
  const allTargets = await api(page, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ id: string; name: string }> }
  const greenTarget = allTargets.items.find((i: { name: string }) => i.name === '对标小绿书')
  const notesAfter = await api(page, 'GET', `/benchmarks/${greenTarget.id}/notes`) as { items: Array<{ title: string; archived_at: string | null }> }
  expect(notesAfter.items).toHaveLength(1)
  expect(notesAfter.items[0].title).toBe('爆文拆解一')

  // AI 结构拆解（桌面形态同段旅程）：粘贴正文→生成→入库笔记，断言哈希与 ai_call。
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面结构拆解模拟模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_structure_extract', provider_id: provider.id, model: 'mock-writer' }])
  const reference = [
    '许多人开始记录生活，但坚持不下来。问题往往不在懒，而在反馈太慢，写了两周看不到任何变化就放弃了，于是怀疑方法没有用。',
    '解决办法是把记录降到一个不可能失败的最小动作。每天只写一句话，写完就算完成，多余的内容是奖励而不是负担，中断一天也不必补救。',
    '举一个例子，一位作者连续三十天只写一句话总结，第三个月自然开始扩写成段，因为素材已经堆在眼前，不需要凭空回忆当时的细节。',
    '执行清单分四步：定一个固定时间、准备一个顺手工具、写完立刻保存、每周日回读一次。每一步都可以单独放弃或调整，不追求完美的执行记录。',
    '结论是先保住连续性，再谈质量。记录本身不是目的，让想法有地方沉淀才是，等习惯自己长大，输出自然会跟着变多起来。',
  ].join('\n')
  const extractCard = first
  await extractCard.getByRole('button', { name: /AI 结构拆解/ }).click()
  await extractCard.getByLabel('参考正文').fill(reference)
  await extractCard.getByLabel('笔记 URL（可选，同 URL 将更新已有笔记）').fill('https://www.xiaohongshu.com/explore/desktop-extract')
  await extractCard.getByRole('button', { name: '生成结构拆解', exact: true }).click()
  await expect(extractCard.getByTestId('structure-extract-result')).toContainText('拆解完成')
  const allForCount = await api(page, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ id: string; name: string }> }
  const greenForCount = allForCount.items.find((i: { name: string }) => i.name === '对标小绿书')
  // 此前"无URL笔记"已归档，未归档列表应为：爆文拆解一 + 拆解 = 2 条。
  await expect.poll(async () => {
    const notesNow = await api(page, 'GET', `/benchmarks/${greenForCount.id}/notes`) as { items: unknown[] }
    return notesNow.items.length
  }, { timeout: 10_000 }).toBe(2)
  await expect(extractCard.getByTestId('benchmark-note-item')).toHaveCount(2)

  // 服务端状态核对：结构哈希由服务端计算、四问投影正确、不同查询参数视为不同 URL（同路径 +?x=1 合法共存）。
  const list = await api(page, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ id: string; name: string; fit_score: number | null; answered_count: number; weak_fit: boolean; status: string }> }
  const scored = list.items.find((item) => item.name === '对标小绿书')
  expect(scored?.fit_score).toBe(50)
  expect(scored?.answered_count).toBe(4)
  expect(scored?.weak_fit).toBe(true)
  expect(list.items.find((item) => item.name === '重复URL对标')).toBeDefined()
  const targetId = scored!.id
  const notes = await api(page, 'GET', `/benchmarks/${targetId}/notes`) as { items: Array<{ structure_hash: string; takeaways: string[]; ai_call_id: string | null }> }
  expect(notes.items.every((note) => note.structure_hash.length === 64)).toBe(true)
  const extracted = notes.items.find((note) => note.ai_call_id !== null)
  expect(extracted).toBeTruthy()
})

// DEV-CX12 / FR-CX-18 桌面补充旅程：旧方案对标只读——手动编辑既有方案时 benchmarks
// 区块无输入控件、提示到对标库编辑；调整方案（AI 修订确认后进入编辑器）同样只读。
test('桌面旧方案对标只读标注', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx18-desktop-legacy-ro-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面方案模拟模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'account_positioning', provider_id: provider.id, model: 'mock-writer' }])
  await page.goto(`/a/${account.id}/ops`)
  await page.getByLabel('想做的领域').fill('互联网运营')
  await page.getByLabel('真实经历与资源').fill('在电商公司做了五年用户增长，带过三人小团队')
  await page.getByRole('button', { name: '生成 2–3 个方案', exact: true }).click()
  await page.getByRole('button', { name: '选择并编辑', exact: true }).first().click()
  // AI 方案选择（choiceIndex 有值）不受限。
  await expect(page.getByRole('button', { name: '添加对标', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '启用方案', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/strategy`)).active?.id).toBeTruthy()

  // 手动编辑既有方案：只读提示出现、无添加/移除控件。
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  const readonlyHint = page.getByTestId('legacy-benchmarks-readonly')
  await expect(readonlyHint).toContainText('只读展示')
  await expect(readonlyHint).toContainText('对标库')
  await expect(page.getByRole('button', { name: '添加对标', exact: true })).toHaveCount(0)
  await expect(page.getByText('移除对标', { exact: true })).toHaveCount(0)
  // 取消不落库。
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(readonlyHint).toHaveCount(0)
})


// DEV-CX12 / FR-CX-15：改写度检查旅程——同源参考 → fail → 带理由已知悉；
// 临时原文不落库；重跑需重新粘贴。本用例只验证本地 mock。
const rewriteParagraphs = [
  '改写度验收的第一段讲清楚要做的事：记录生活的关键在于把反馈周期缩短到当天可见，写一句话也能积累素材，坚持三周后自然能看出主题轮廓，这种渐进的积累比一次性长文更容易保持动力，也更容易在回读时发现真正值得展开的线索。',
  '改写度验收的第二段补充操作细节：准备一个固定的时间和一个顺手的工具，写完立刻保存，每周回读一次，不追求完美的执行记录，中断一天也不必补救，让习惯自己长大。',
  '改写度验收的第三段给出边界：这套方法只适用于个人记录型写作，不适合需要严格事实核查的新闻内容，数据引用仍然要逐条核对来源。',
]

async function seedCheckWork(page: Page, accountId: string) {
  let work = await api(page, 'POST', `/accounts/${accountId}/works`, { content_format: 'long_article' })
  work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '改写度检查的验收作品', base_revision: work.revision })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: rewriteParagraphs.map((_, index) => ({ heading: `改写段落${index + 1}`, key_point: `要点${index + 1}`, material_ids: [] })),
    confirm: true, base_revision: work.revision,
  })
  for (const [index, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: rewriteParagraphs[index], base_revision: section.revision })
  }
  work = await api(page, 'GET', `/works/${work.id}`)
  return work
}

test('DEV-CX15 桌面改写度检查：同源 fail、理由确认与原文不落库', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp', `cx15-rewrite-${Date.now()}`)
  const work = await seedCheckWork(page, account.id)
  const origin = 'http://127.0.0.1:5287'
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面改写度模拟模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_rewrite_compare', provider_id: provider.id, model: 'mock-writer' }])

  await page.goto(`/works/${work.id}/check`)
  await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run?: { id: string; revision: number; stale: boolean; material_basis_stale: boolean; fact_status: string } }
    return !!latest.run && !latest.run.stale && !latest.run.material_basis_stale && latest.run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run: { id: string; revision: number } }

  // 无参考正文：not_applicable——不产生 rewrite 项。
  await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
    basis_revision: run.revision, check_run_id: run.id, reference_text: '',
  })
  const afterEmpty = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run: { items: Array<{ category: string }> } }
  expect(afterEmpty.run.items.some((i) => i.category === 'rewrite')).toBe(false)

  // 同源参考（直接粘贴作品正文）：表达 same、mock 同源 → fail。
  const body = (await api(page, 'GET', `/works/${work.id}`)) as { sections: Array<{ content_md: string }> }
  const workBody = body.sections.map((s) => s.content_md).join('\n\n')
  const failed = await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
    basis_revision: run.revision, check_run_id: run.id, reference_text: workBody,
  }) as { result: string; reference_hash: string }
  expect(failed.result).toBe('fail')

  // 检查页出现改写度待处理项；已知悉需要 20..500 字理由。
  await page.reload()
  const rewriteCard = page.locator('div.rounded-lg', { hasText: '改写度' }).filter({ hasText: '明显同源' }).first()
  await expect(rewriteCard).toBeVisible()
  await rewriteCard.getByText('已知悉风险', { exact: true }).click()
  const reasonBox = rewriteCard.getByPlaceholder(/说明原因/)
  await expect(rewriteCard.getByRole('button', { name: '提交确认' })).toBeDisabled()
  await reasonBox.fill('太短')
  await expect(rewriteCard.getByRole('button', { name: '提交确认' })).toBeDisabled()
  await reasonBox.fill('这段参考是我本人在其他平台发布的旧稿，本次改写自同一份材料，保留此说明备查。')
  await rewriteCard.getByRole('button', { name: '提交确认' }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run?: { items: Array<{ category: string; resolution: string | null; resolution_note?: string }> } }
    const item = latest.run?.items.find((i) => i.category === 'rewrite')
    return item?.resolution ?? ''
  }).toBe('acknowledged')

  // 临时原文不落库：作品字段与 context_refs 均无参考独特句。
  const needle = '渐进的积累比一次性长文更容易保持动力'
  const workAfter = await api(page, 'GET', `/works/${work.id}`) as { viewpoint: string; title: string }
  expect(workAfter.viewpoint + workAfter.title).not.toContain(needle)
})

// DEV-CX12 / FR-CX-15 桌面骨架引用显式路径：与 Web cx18 用例覆盖同一服务端契约，
// 断言在本端（5287 隔离服务）执行——骨架检查 undetermined + reference_text_required、
// 正文与骨架互斥、确认理由与 Web 相同、归档骨架失效。夹具用 API 建（登记 UI 由本文件前序用例覆盖）。
test('DEV-CX12 桌面改写度骨架引用：undetermined、互斥与归档失效', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx12-rewrite-skel-${Date.now()}`)
  // 骨架引用校验按作品账号匹配：对标库挂在 xhs 账号上，这里种一篇 image_note 作品。
  let work = await api(page, 'POST', `/accounts/${account.id}/works`, { content_format: 'image_note' })
  work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '骨架引用改写度验收', base_revision: work.revision })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: rewriteParagraphs.map((_, index) => ({ heading: `骨架段落${index + 1}`, key_point: `要点${index + 1}`, material_ids: [] })),
    confirm: true, base_revision: work.revision,
  })
  for (const [index, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: rewriteParagraphs[index], base_revision: section.revision })
  }
  work = await api(page, 'GET', `/works/${work.id}`)
  const target = await api(page, 'POST', `/accounts/${account.id}/benchmarks`, { platform: 'xhs', name: '桌面骨架引用对标' }) as { id: string }
  const structure = { hook_type: 'question', hook_gist: '为什么坚持不下来', sections: [] as unknown[], cta_type: 'none', rhythm: { paragraphs: 5, avg_chars: 80 } }
  const note = await api(page, 'POST', `/benchmarks/${target.id}/notes`, { title: '桌面骨架引用拆解', structure }) as { id: string; revision: number }

  await page.goto(`/works/${work.id}/check`)
  await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run?: { id: string; revision: number; stale: boolean; material_basis_stale: boolean; fact_status: string } }
    return !!latest.run && !latest.run.stale && !latest.run.material_basis_stale && latest.run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run: { id: string; revision: number } }
  const body = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ content_md: string }> }
  const workBody = body.sections.map((s) => s.content_md).join('\n\n')

  // 正文与骨架互斥：同时提供 422。
  await expect(async () => {
    await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
      basis_revision: run.revision, check_run_id: run.id, reference_text: workBody, skeleton_note_ids: [note.id],
    })
  }).rejects.toThrow(/只能二选一/)

  // 骨架路径：undetermined + reference_text_required；不调用 AI。
  const resp = await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
    basis_revision: run.revision, check_run_id: run.id, reference_text: '', skeleton_note_ids: [note.id],
  }) as { result: string; reference_text_required: boolean; prompt_version: string; ai_call_id?: string }
  expect(resp.result).toBe('undetermined')
  expect(resp.reference_text_required).toBe(true)
  expect(resp.prompt_version).toBe('skeleton_only')
  expect(resp.ai_call_id).toBeUndefined()

  // 检查页出现骨架改写度项；已知悉理由与正文路径同一约束（20..500 码点）。
  await page.reload()
  const rewriteCard = page.locator('div.rounded-lg', { hasText: '改写度' }).filter({ hasText: '结构骨架' }).first()
  await expect(rewriteCard).toBeVisible()
  await expect(rewriteCard).toContainText('仅参考骨架，需完整正文复核')
  await rewriteCard.getByText('已知悉风险', { exact: true }).click()
  const reasonBox = rewriteCard.getByPlaceholder(/说明原因/)
  await expect(rewriteCard.getByRole('button', { name: '提交确认' })).toBeDisabled()
  await reasonBox.fill('太短')
  await expect(rewriteCard.getByRole('button', { name: '提交确认' })).toBeDisabled()
  await reasonBox.fill('这是我自己账号的结构拆解，只参考了段落结构，没有复制任何原文，留此说明备查。')
  await rewriteCard.getByRole('button', { name: '提交确认' }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run?: { items: Array<{ category: string; resolution: string | null }> } }
    return latest.run?.items.find((i) => i.category === 'rewrite')?.resolution ?? ''
  }).toBe('acknowledged')

  // 归档骨架后同一 run 再次骨架检查 → 422。
  await api(page, 'PATCH', `/benchmark-notes/${note.id}`, { base_revision: note.revision, archived: true })
  await expect(async () => {
    await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
      basis_revision: run.revision, check_run_id: run.id, reference_text: '', skeleton_note_ids: [note.id],
    })
  }).rejects.toThrow(/不在当前账号范围内/)
})

// DEV-CX12 / FR-CX-14 桌面补充旅程：拆解 422 复制风险呈现与 20000 码点上限。
// #copy-echo 夹具让 mock 抄原句 → 服务端重试后 422 extraction_copy_risk 的界面呈现且不落库。
test('DEV-CX14 桌面拆解 422 复制风险呈现与 20000 码点上限', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面拆解边界模拟模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_structure_extract', provider_id: provider.id, model: 'mock-writer' }])

  const target = await api(page, 'POST', `/accounts/${account.id}/benchmarks`, { platform: 'xhs', name: '桌面拆解边界对标' }) as { id: string }
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  const card = panel.getByTestId('benchmark-target-item').filter({ hasText: '桌面拆解边界对标' })
  await card.getByRole('button', { name: /笔记拆解库/ }).click()
  await card.getByRole('button', { name: /AI 结构拆解/ }).click()

  // 上限与下限：输入层禁用生成按钮。
  await card.getByLabel('参考正文').fill('长'.repeat(20001))
  await expect(card.getByText(/超过 20000，请精简/)).toBeVisible()
  await expect(card.getByRole('button', { name: '生成结构拆解' })).toBeDisabled()
  await card.getByLabel('参考正文').fill('太短')
  await expect(card.getByRole('button', { name: '生成结构拆解' })).toBeDisabled()

  // 夹具正文：4 段各 >80 码点，总长超过 300。
  const segment = (i: number) => `桌面复制风险验收第${i + 1}段：这一段原句会被夹具原样抄进 gist，用来触发服务端反复制验证的拒绝路径，补足长度的说明文字让总码点超过三百的下限要求，段落内容保持稳定以便断言稳定通过，结尾补充方法性概括使每段更长。`
  const echo = '#copy-echo\n' + Array.from({ length: 4 }, (_, i) => segment(i)).join('\n')
  await card.getByLabel('参考正文').fill(echo)
  await card.getByRole('button', { name: '生成结构拆解', exact: true }).click()
  await expect(card.getByText('拆解结果与参考正文重合度过高，未保存；请更换文章或重试。')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId('benchmark-note-item')).toHaveCount(0)
  const notes = await api(page, 'GET', `/benchmarks/${target.id}/notes`) as { items: unknown[] }
  expect(notes.items).toHaveLength(0)
})
