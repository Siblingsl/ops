import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX03 / T-CX05 Web 侧服务端契约证据：构建 UI 为桌面专属（06 文档"Web 独立构建 UI 未接入"），
// Web 以 API 旅程验证同一服务端行为——上传产物摘要不一致 422、渲染期间改稿 build_stale、
// 跨工作区对构建详情/manifest/evidence.csv 一律 404 且不返回内容片段。
// 完整 evidence.csv 200 下载链路由 Go 集成测试 cx_evidence_exports_test.go 以 built 注入覆盖；
// Q-CX-03/04 未决时正式下载保持关闭，本用例不开放任何下载。
async function seedWechatWork(page: import('@playwright/test').Page, title: string) {
  const account = await registerAccount(page, '长图文', 'wechat_mp', `cx03-web-${Date.now()}`)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title }) as { id: string; revision: number }
  const withViewpoint = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: `${title}的观点：服务端校验链以冻结快照为准。`, base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: withViewpoint.revision,
    items: [{ heading: '证据章节', key_point: '验证构建失败呈现', material_ids: [] }],
  }) as { revision: number; sections: Array<{ id: string; revision: number }> }
  const section = outlined.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '冻结来源正文，用于验证服务端校验链。', base_revision: section.revision })
  const settled = await api(page, 'GET', `/works/${work.id}`) as { revision: number; sections: Array<{ id: string; revision: number }> }
  return { work, section, workRevision: settled.revision }
}

async function startBuild(page: import('@playwright/test').Page, workId: number | string, revision: number) {
  return api(page, 'POST', `/works/${workId}/builds`, {
    basis_revision: revision, targets: ['wechat_html'], options: {}, client: 'web',
    renderer_contract_version: 'ops.wechat-html/v1',
  }) as Promise<{ build_id: string; source_hash: string; params_hash: string; status: string }>
}

test('Web API：上传摘要不一致 422 与渲染期间改稿 build_stale', async ({ page }) => {
  const { work, section, workRevision } = await seedWechatWork(page, '证据链 Web 契约验收')
  const created = await startBuild(page, work.id, workRevision)
  expect(created.status).toBe('running')

  // 上传产物：sha256 声明与文件字节不一致 → 422 artifact_hash_mismatch，构建落 failed。
  const me = await api(page, 'GET', '/auth/me') as { csrf_token: string }
  const bad = await page.request.post(`/api/v1/builds/${created.build_id}/artifacts`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: {
      kind: 'html',
      sha256: '0'.repeat(64),
      file: { name: 'article.html', mimeType: 'text/html; charset=utf-8', buffer: Buffer.from('<section><div data-section-id="x">不匹配的内容</div></section>') },
    },
  })
  expect(bad.status()).toBe(422)
  expect((await bad.json()).error.code).toBe('artifact_hash_mismatch')
  const tampered = await api(page, 'GET', `/builds/${created.build_id}`) as { status: string; error_code: string | null; download_gate: { allowed: boolean } }
  expect(tampered).toMatchObject({ status: 'failed', error_code: 'artifact_hash_mismatch', download_gate: { allowed: false } })

  // 渲染期间改稿：complete 以 build_stale 拒绝（服务端重算当前快照 hash 与冻结比对）。
  const afterFirst = await api(page, 'GET', `/works/${work.id}`) as { revision: number }
  const second = await startBuild(page, work.id, afterFirst.revision)
  expect(second.status).toBe('running')
  const fresh = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ id: string; revision: number }> }
  await api(page, 'PATCH', `/sections/${fresh.sections[0].id}`, { content_md: '渲染期间改写的正文。', base_revision: fresh.sections[0].revision })
  const complete = await page.request.post(`/api/v1/builds/${second.build_id}/complete`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    data: {
      source_hash: second.source_hash, params_hash: second.params_hash, artifacts: [],
      renderer_receipt: {
        client: 'web', application_version: '0.1.0', renderer_contract_version: 'ops.wechat-html/v1',
        chromium_version: 'e2e-stale-probe', font_family: 'sans-serif', device_scale_factor: 1,
        viewport_width: 1440, viewport_height: 1000,
      },
    },
  })
  expect(complete.status()).toBe(409)
  expect((await complete.json()).error.code).toBe('build_stale')
  const stale = await api(page, 'GET', `/builds/${second.build_id}`) as { status: string; error_code: string | null }
  expect(stale).toMatchObject({ status: 'failed', error_code: 'build_stale' })
})

test('Web API：跨工作区对构建与证据/清单下载一律 404', async ({ page }) => {
  const { work, workRevision } = await seedWechatWork(page, '证据链跨租户验收')
  const created = await startBuild(page, work.id, workRevision)
  expect(created.status).toBe('running')

  const second = await api(page, 'POST', '/workspaces', { name: 'Web 证据链隔离工作区', switch: false })
  await api(page, 'POST', `/workspaces/${second.id}/switch`)
  for (const path of [`/builds/${created.build_id}`, `/builds/${created.build_id}/manifest.json`, `/builds/${created.build_id}/evidence.csv`]) {
    const response = await page.request.fetch(`/api/v1${path}`)
    expect(response.status(), path).toBe(404)
    expect(await response.text()).not.toContain('source_hash')
  }
})
