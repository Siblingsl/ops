import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX12 / FR-CX-14 桌面旅程：拆解骨架供大纲引用——
// 建对标与拆解 → 大纲生成处勾选骨架 → refs/cx_basis.omitted 回执。
// 浏览器形态同段旅程见 web/e2e/cx12-skeleton-reference.spec.ts；两端各自实现。
test('DEV-CX12 桌面骨架引用供大纲生成', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx12-skeleton-web-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: '桌面大纲模拟模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'outline', provider_id: provider.id, model: 'mock-writer' },
    { task_type: 'cx_structure_extract', provider_id: provider.id, model: 'mock-writer' },
  ])

  // 建对标与拆解骨架。
  const target = await api(page, 'POST', `/accounts/${account.id}/benchmarks`, { platform: 'xhs', name: '骨架引用对标' })
  const reference = Array.from({ length: 5 }, (_, i) => `骨架验收第${i + 1}段：内容围绕真实经历展开，先给出具体场景，再说明可执行的步骤与边界，最后回到核心观点。`).join('\n')
  await api(page, 'POST', `/benchmarks/${target.id}/notes`, {
    title: '大纲引用骨架', structure: {
      hook_type: 'contrast', hook_gist: '对比式开场',
      sections: [{ role: 'problem' }, { role: 'method' }, { role: 'conclusion' }],
      cta_type: 'save', rhythm: { paragraphs: 5, avg_chars: 100 },
    },
  })

  // 桌面注册流程创建的是默认 xhs 账号；这里再补一个显式作品并写观点（同 Web 语义）。
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { content_format: 'image_note' }) as { id: string; revision: number }
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '骨架只提供结构参考，观点是我的。', base_revision: work.revision })
  await page.goto(`/works/${work.id}`)
  // 桌面编辑器先渲染骨架下拉需要编辑态；这里只验证服务端契约与选择列表，下拉交互由既有桌面编辑器 E2E 覆盖。

  // 骨架选择列表：账号下唯一的拆解笔记，受限字段暴露（hook_type/roles/rhythm）。
  const notes = await api(page, 'GET', `/accounts/${account.id}/skeleton-notes`) as Array<{ id: string; hook_type: string; roles: string[]; paragraphs: number }>
  expect(notes.length).toBe(1)
  expect(notes[0].hook_type).toBe('contrast')
  expect(notes[0].roles).toEqual(['problem', 'method', 'conclusion'])

  // 携带骨架生成大纲：refs 登记骨架、cx_basis.omitted 说明来源类型缺失。
  const outline = await api(page, 'POST', `/works/${work.id}/outline/generate`, { skeleton_note_ids: [notes[0].id] }) as {
    refs: { benchmark_skeletons: string[] }
    cx_basis: { omitted: Array<{ ref: string; reason: string }> }
  }
  expect(outline.refs.benchmark_skeletons).toContain(notes[0].id)
  const omission = outline.cx_basis.omitted.find((o) => o.ref === 'benchmark_skeleton')
  expect(omission?.reason).toContain('refs.benchmark_skeletons')

  // 桌面形态不重复界面探针：Web 已覆盖下拉可见性，本用例聚焦同账号归属与受限字段。
  const foreign = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '别家', content_format: 'long_article' })
  const foreignWork = await api(page, 'POST', `/accounts/${foreign.id}/works`, { content_format: 'long_article' }) as { id: string; revision: number }
  await api(page, 'PATCH', `/works/${foreignWork.id}`, { viewpoint: '别家观点', base_revision: foreignWork.revision })
  const rejected = await api(page, 'POST', `/works/${foreignWork.id}/outline/generate`, { skeleton_note_ids: [notes[0].id] }).catch((e) => e)
  expect(String(rejected)).toContain('不在当前账号范围内')
})
