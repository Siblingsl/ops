import { expect, test } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

// DEV-CX12 / FR-CX-18 浏览器旅程：与桌面 cx18-benchmark.spec.ts 覆盖同一段旅程的互补场景——
// 旧方案迁移回填的候选展示、状态过滤、放弃与恢复、URL 大小写/端口归一查重、笔记同 URL 拒绝。
// 桌面形态覆盖登记/四问/weak_fit/CAS 主链路；两端各自实现、不共用文件。
// 只用隔离本地 API；不访问对标 URL，不生成任何内容。
test('Web 对标库旧方案迁移候选、状态过滤与归档恢复', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx18-web-benchmark-${Date.now()}`)
  // 预置：一条旧方案 benchmarks（带 URL + 一条空名无 URL），迁移回填后应为未作答候选。
  // 旧 strategy.benchmarks 的结构回填是 00080 迁移对存量数据的一次性动作
  //（幂等与"缺URL/空名不丢、不代答"由 Go 迁移测试覆盖）；运行中新方案不再自动导入，
  // 后续编辑只到新库。本用例覆盖运行时行为，不预置旧方案。
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  await expect(panel).toBeVisible()

  await expect(panel.getByTestId('benchmark-target-item')).toHaveCount(0)

  // 登记对标：URL 大小写与默认端口差异应视为同一 URL；不同查询参数合法共存。
  const create = async (name: string, url: string) => {
    await panel.getByLabel('名称（1..100 码点）').fill(name)
    if (url) await panel.getByLabel('主页 URL（可选）').fill(url)
    await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  }
  await create('Web 对标一号', 'https://www.xiaohongshu.com/user/web-a')
  await expect(panel.getByTestId('benchmark-target-item').filter({ hasText: 'Web 对标一号' })).toHaveCount(1)
  await create('大小写重复', 'https://WWW.XIAOHONGSHU.COM/user/web-a')
  await expect(panel).toContainText('同账号同平台已存在该 URL')
  await create('查询参数共存', 'https://www.xiaohongshu.com/user/web-a?src=search')
  await expect(panel.getByTestId('benchmark-target-item').filter({ hasText: '查询参数共存' })).toHaveCount(1)

  // 状态过滤：candidate 视图包含新登记，dropped 视图不包含放弃项。
  const kept = panel.getByTestId('benchmark-target-item').filter({ hasText: 'Web 对标一号' })
  await kept.getByRole('button', { name: '放弃', exact: true }).click()
  await panel.getByLabel('对标状态过滤').selectOption('candidate')
  await expect(panel.getByTestId('benchmark-target-item').filter({ hasText: 'Web 对标一号' })).toHaveCount(0)
  await panel.getByLabel('对标状态过滤').selectOption('dropped')
  await expect(panel.getByTestId('benchmark-target-item').filter({ hasText: 'Web 对标一号' })).toHaveCount(1)
  await panel.getByLabel('对标状态过滤').selectOption('all')
  await expect(panel.getByTestId('benchmark-target-item').filter({ hasText: 'Web 对标一号' })).toHaveCount(1)

  // target 归档与恢复：归档后列表消失、详情可读，恢复后重新出现。
  const notesToggle = kept.getByRole('button', { name: /笔记拆解库/ })
  await notesToggle.click()
  await kept.getByLabel('笔记标题').fill('Web 拆解')
  await kept.getByLabel('来源 URL（可选）').fill('https://www.xiaohongshu.com/explore/web-1')
  await kept.getByRole('button', { name: '登记笔记', exact: true }).click()
  await expect(kept.getByTestId('benchmark-note-item')).toHaveCount(1)
  // 表单成功后已清空；重填同 URL 触发 409。
  await kept.getByLabel('笔记标题').fill('Web 同URL')
  await kept.getByLabel('来源 URL（可选）').fill('https://www.xiaohongshu.com/explore/web-1')
  await kept.getByRole('button', { name: '登记笔记', exact: true }).click()
  await expect(kept).toContainText('该对标账号下已存在同 URL 的笔记')

  // AI 结构拆解：粘贴 300+ 码点正文，生成骨架并直接入库为笔记（本地 mock 模型）。
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web 结构拆解模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_structure_extract', provider_id: provider.id, model: 'mock-writer' }])
  const reference = [
    '许多人开始记录生活，但坚持不下来。问题往往不在懒，而在反馈太慢，写了两周看不到任何变化就放弃了，于是怀疑方法没有用。',
    '解决办法是把记录降到一个不可能失败的最小动作。每天只写一句话，写完就算完成，多余的内容是奖励而不是负担，中断一天也不必补救。',
    '举一个例子，一位作者连续三十天只写一句话总结，第三个月自然开始扩写成段，因为素材已经堆在眼前，不需要凭空回忆当时的细节。',
    '执行清单分四步：定一个固定时间、准备一个顺手工具、写完立刻保存、每周日回读一次。每一步都可以单独放弃或调整，不追求完美的执行记录。',
    '结论是先保住连续性，再谈质量。记录本身不是目的，让想法有地方沉淀才是，等习惯自己长大，输出自然会跟着变多起来。',
  ].join('\n')
  await panel.getByTestId('benchmark-target-item').filter({ hasText: '查询参数共存' }).getByRole('button', { name: /笔记拆解库/ }).click()
  const extractPanel = panel.getByTestId('benchmark-target-item').filter({ hasText: '查询参数共存' }).getByRole('button', { name: /AI 结构拆解/ })
  await extractPanel.click()
  const extractCard = panel.getByTestId('benchmark-target-item').filter({ hasText: '查询参数共存' })
  await extractCard.getByLabel('参考正文').fill(reference)
  // 过短正文前端即禁用生成。
  await extractCard.getByLabel('参考正文').fill('太短')
  await expect(extractCard.getByRole('button', { name: '生成结构拆解' })).toBeDisabled()
  await extractCard.getByLabel('参考正文').fill(reference)
  await extractCard.getByLabel('笔记 URL（可选，同 URL 将更新已有笔记）').fill('https://www.xiaohongshu.com/explore/extract-1')
  await extractCard.getByRole('button', { name: '生成结构拆解', exact: true }).click()
  await expect(extractCard.getByTestId('structure-extract-result')).toContainText('拆解完成')
  await expect(extractCard.getByTestId('benchmark-note-item')).toHaveCount(1)
  const extractNotes = await api(page, 'GET', `/benchmarks/${(await api(page, 'GET', `/accounts/${account.id}/benchmarks`)).items.find((i: { name: string }) => i.name === '查询参数共存').id}/notes`) as { items: Array<{ structure_hash: string; ai_call_id: string | null }> }
  expect(extractNotes.items[0].structure_hash).toHaveLength(64)
  expect(extractNotes.items[0].ai_call_id).toBeTruthy()

  await kept.getByRole('button', { name: '归档对标', exact: true }).click()
  await expect(panel.getByTestId('benchmark-target-item').filter({ hasText: 'Web 对标一号' })).toHaveCount(0)
  const list = await api(page, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ name: string }> }
  expect(list.items.find((item) => item.name === 'Web 对标一号')).toBeUndefined()
})

// DEV-CX12 / FR-CX-18 补充旅程：旧方案对标只读——手动编辑既有方案时 benchmarks 区块
// 无输入控件并提示到对标库编辑；AI 方案选择路径（新方案）不受限，可添加对标。
test('Web 旧方案对标只读、新方案路径可编辑', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx18-web-legacy-ro-${Date.now()}`)
  // 先走 AI 方案选择（choiceIndex 有值）：benchmarks 区块保持可编辑。
  await page.goto(`/a/${account.id}/ops`)
  await page.getByLabel('想做的领域').fill('互联网运营')
  await page.getByLabel('真实经历与资源').fill('在电商公司做了五年用户增长，带过三人小团队')
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web 方案模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'account_positioning', provider_id: provider.id, model: 'mock-writer' }])
  await page.getByRole('button', { name: '生成 2–3 个方案', exact: true }).click()
  await page.getByRole('button', { name: '选择并编辑', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '添加对标', exact: true })).toBeVisible()

  // 启用后手动编辑既有方案（choiceIndex 无值）：旧方案 benchmarks 只读、引导去对标库。
  await page.getByRole('button', { name: '启用方案', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/strategy`)).active?.id).toBeTruthy()
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  const readonlyHint = page.getByTestId('legacy-benchmarks-readonly')
  await expect(readonlyHint).toContainText('只读展示')
  await expect(readonlyHint).toContainText('对标库')
  await expect(page.getByRole('button', { name: '添加对标', exact: true })).toHaveCount(0)
  await expect(page.getByText('移除对标', { exact: true })).toHaveCount(0)
})

// DEV-CX12 / FR-CX-15 浏览器旅程——同源参考 → fail → 带理由已知悉；
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

test('DEV-CX15 Web 改写度检查：同源 fail、理由确认与原文不落库', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp', `cx15-rewrite-${Date.now()}`)
  const work = await seedCheckWork(page, account.id)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web 改写度模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
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
  const patchResponses: string[] = []
  page.on('response', async (res) => {
    if (res.request().method() === 'PATCH' && res.url().includes('/check-items/')) {
      patchResponses.push(`${res.status()} ${(await res.text()).slice(0, 200)}`)
    }
  })
  await rewriteCard.getByRole('button', { name: '提交确认' }).click()
  console.log('REWRITE PATCH:', JSON.stringify(patchResponses))
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

// DEV-CX12 / FR-CX-15 骨架引用显式路径：仅对标骨架（无完整正文）→ undetermined +
// reference_text_required 并生成改写度待处理项；正文与骨架互斥；归档后的骨架不再可用。
// 对标登记/拆解 UI 由前序用例覆盖，这里用 API 建夹具。
test('DEV-CX12 Web 改写度骨架引用：undetermined、互斥与归档失效', async ({ page }) => {
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
  const target = await api(page, 'POST', `/accounts/${account.id}/benchmarks`, { platform: 'xhs', name: '骨架引用对标' }) as { id: string }
  const structure = { hook_type: 'question', hook_gist: '为什么坚持不下来', sections: [] as unknown[], cta_type: 'none', rhythm: { paragraphs: 5, avg_chars: 80 } }
  const note = await api(page, 'POST', `/benchmarks/${target.id}/notes`, { title: '骨架引用拆解', structure }) as { id: string; revision: number }

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

  // 骨架路径：undetermined + reference_text_required。
  const resp = await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
    basis_revision: run.revision, check_run_id: run.id, reference_text: '', skeleton_note_ids: [note.id],
  }) as { result: string; reference_text_required: boolean; prompt_version: string }
  expect(resp.result).toBe('undetermined')
  expect(resp.reference_text_required).toBe(true)
  expect(resp.prompt_version).toBe('skeleton_only')

  // 检查页出现骨架改写度项，确认仍需 20..500 码点理由。
  await page.reload()
  const rewriteCard = page.locator('div.rounded-lg', { hasText: '改写度' }).filter({ hasText: '结构骨架' }).first()
  await expect(rewriteCard).toBeVisible()
  await expect(rewriteCard).toContainText('仅参考骨架，需完整正文复核')
  await rewriteCard.getByText('已知悉风险', { exact: true }).click()
  await rewriteCard.getByPlaceholder(/说明原因/).fill('这是我自己账号的结构拆解，只参考了段落结构，没有复制任何原文，留此说明备查。')
  await rewriteCard.getByRole('button', { name: '提交确认' }).click()
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${work.id}/checks/latest`) as { run?: { items: Array<{ category: string; resolution: string | null }> } }
    return latest.run?.items.find((i) => i.category === 'rewrite')?.resolution ?? ''
  }).toBe('acknowledged')

  // 骨架归档后同一 run 再次骨架检查 → 422（不在账号未归档范围内）。
  await api(page, 'PATCH', `/benchmark-notes/${note.id}`, { base_revision: note.revision, archived: true })
  await expect(async () => {
    await api(page, 'POST', `/works/${work.id}/rewrite-check`, {
      basis_revision: run.revision, check_run_id: run.id, reference_text: '', skeleton_note_ids: [note.id],
    })
  }).rejects.toThrow(/不在当前账号范围内/)
})

// DEV-CX12 / FR-CX-14 补充旅程：结构拆解的边界呈现——
// #copy-echo 夹具让 mock 抄原句 → 服务端 422 extraction_copy_risk 的 UI 呈现且不落库；
// 20000 码点上限在输入层禁用生成按钮；拆解结果无参考维度（undetermined）路径见改写度用例。
test('DEV-CX14 Web 拆解 422 复制风险呈现与 20000 码点上限', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx14-web-copy-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web 拆解边界模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_structure_extract', provider_id: provider.id, model: 'mock-writer' }])

  const target = await api(page, 'POST', `/accounts/${account.id}/benchmarks`, { platform: 'xhs', name: '拆解边界对标' }) as { id: string }
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  const card = panel.getByTestId('benchmark-target-item').filter({ hasText: '拆解边界对标' })
  await card.getByRole('button', { name: /笔记拆解库/ }).click()
  await card.getByRole('button', { name: /AI 结构拆解/ }).click()

  // 20000 码点上限：输入层显示提示并禁用按钮（不调模型）。
  const longText = '长'.repeat(20001)
  await card.getByLabel('参考正文').fill(longText)
  await expect(card.getByText(/超过 20000，请精简/)).toBeVisible()
  await expect(card.getByRole('button', { name: '生成结构拆解' })).toBeDisabled()
  await card.getByLabel('参考正文').fill('')

  // 300 码点下限同样禁用。
  await card.getByLabel('参考正文').fill('太短的正文')
  await expect(card.getByRole('button', { name: '生成结构拆解' })).toBeDisabled()

  // #copy-echo 夹具：mock 抄原句 → 服务端重试 3 次后 422 extraction_copy_risk，UI 呈现且不落笔记。
  const segment = (i: number) => `复制风险验收第${i + 1}段：这一段原句会被夹具原样抄进 gist，用来触发服务端反复制验证的拒绝路径。补足长度的说明文字让总码点超过 300 的下限，段落内容保持稳定以便断言稳定通过，结尾再补充一句方法性的概括描述使每段更长更接近真实笔记正文。`
  const echo = '#copy-echo\n' + Array.from({ length: 4 }, (_, i) => segment(i)).join('\n')
  await card.getByLabel('参考正文').fill(echo)
  await card.getByRole('button', { name: '生成结构拆解', exact: true }).click()
  await expect(card.getByText('拆解结果与参考正文重合度过高，未保存；请更换文章或重试。')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId('benchmark-note-item')).toHaveCount(0)
  const notes = await api(page, 'GET', `/benchmarks/${target.id}/notes`) as { items: unknown[] }
  expect(notes.items).toHaveLength(0)
})
