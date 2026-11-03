import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX02 Web 独立 BuildPanel（D-161 后续）。桌面侧已闭合冻结快照渲染/主题校验/重哈希/稳定版/历史恢复；
// 本用例覆盖 Web 对称缺口：浏览器端渲染冻结快照、上传产物、服务端校验与隐私门禁。
// Q-CX-03/04 已拍板（90 D-165）：纯净产物 complete 直接 built、下载门禁 clear；正文引入邮箱候选（WARN）
// 时构建仍 built，下载需本人逐项知悉回执（privacy_ack_required → acknowledged）。长图只在桌面端生成。
test('DEV-CX02 Web 稳定版提交冻结产物并覆盖 WARN 知悉放行', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'Web 冻结快照构建验收' }) as { id: string; revision: number }
  const withViewpoint = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '我会按已保存的观点完成浏览器端只读内容构建。', base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: withViewpoint.revision,
    items: [{ heading: '冻结章节', key_point: '验证只读构建', material_ids: [] }],
  }) as { sections: Array<{ id: string; revision: number }> }
  const section = outlined.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这段正文用于验证浏览器构建。', base_revision: section.revision })
  await page.goto(`/works/${work.id}`)

  const panel = page.getByTestId('work-build-panel')
  await expect(panel).toBeVisible()
  // 能力边界：Web 不提供长图目标，也不伪造长图回执。
  await expect(panel.getByRole('checkbox', { name: /390px 真实长图/ })).toHaveCount(0)
  await expect(panel.getByText(/390px 真实长图依赖桌面客户端/)).toBeVisible()

  await panel.getByRole('checkbox', { name: '离线稳定版 HTML' }).check()
  const complete = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
  const completion = await complete
  const completionBody = await completion.text()
  // Q-CX-03 拍板后：纯净产物无 ERROR/WARN，complete 直接置 built。
  expect(completion.status(), completionBody).toBe(200)
  expect(completionBody).toContain('"status":"built"')
  await expect(panel.getByText(/隐私扫描：pass · ERROR 0 · WARN 0/)).toBeVisible()
  await expect(panel.getByText(/未发布的规则决策/)).toHaveCount(0)

  const list = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
  expect(list.items[0]).toMatchObject({ status: 'built', error_code: null })
  const cleanBuildID = list.items[0].id
  const build = await api(page, 'GET', `/builds/${cleanBuildID}`) as { artifacts: Array<{ kind: string; downloadable: boolean }>; download_gate: { allowed: boolean; reason: string } }
  // Web 只提交 html + stable_html；没有 png，也不应出现服务端合成的中间 HTML。
  expect(build.artifacts.map(item => item.kind).sort()).toEqual(['html', 'stable_html'])
  expect(build.artifacts.every(item => item.downloadable)).toBe(true)
  expect(build.download_gate).toMatchObject({ allowed: true, reason: 'clear' })
  const detailPanel = page.getByTestId('build-detail')
  await expect(detailPanel.getByRole('button', { name: '下载 manifest.json' })).toBeVisible()
  await expect(detailPanel.getByRole('button', { name: '下载图片证据 CSV' })).toBeVisible()
  const unchanged = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ content_md: string }> }
  expect(unchanged.sections[0].content_md).toBe('这段正文用于验证浏览器构建。')

  // WARN 旅程：正文引入邮箱候选（WARN）→ 构建仍 built，下载门禁要求本人逐项知悉回执。
  const currentWork = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ id: string; revision: number; content_md: string }> }
  await api(page, 'PATCH', `/sections/${section.id}`, {
    content_md: '这段正文包含 ops-fixture@example.com 作为知悉确认验收样本。',
    base_revision: currentWork.sections[0].revision,
  })
  const warnComplete = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
  const warnCompletion = await warnComplete
  const warnBody = await warnCompletion.text()
  expect(warnCompletion.status(), warnBody).toBe(200)
  expect(warnBody).toContain('"status":"built"')
  // 同一正文渲染进 html 与 stable_html，两个 DOM 各报一条 email 候选 → WARN 2。
  await expect(detailPanel.getByText(/隐私扫描：warn · ERROR 0 · WARN [1-9]/)).toBeVisible()
  await expect(detailPanel.getByText('下载门禁：privacy_ack_required')).toBeVisible()
  const warnList = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
  expect(warnList.items[0]).toMatchObject({ status: 'built', error_code: null })
  const warnBuildID = warnList.items[0].id
  const ackGate = await api(page, 'GET', `/builds/${warnBuildID}`) as { download_gate: { allowed: boolean; reason: string }; validation?: { privacy?: { warnings: number } } }
  expect(ackGate.download_gate).toMatchObject({ allowed: false, reason: 'privacy_ack_required' })
  expect(ackGate.validation?.privacy?.warnings).toBeGreaterThan(0)

  // 逐项勾选全部 WARN 发现并提交本人知悉回执 → 门禁转 acknowledged，下载开放。
  const warnBoxes = detailPanel.locator('input[type="checkbox"]')
  const boxCount = await warnBoxes.count()
  expect(boxCount).toBeGreaterThan(0)
  for (let index = 0; index < boxCount; index += 1) await warnBoxes.nth(index).check()
  await detailPanel.getByRole('button', { name: '提交本人逐项知悉回执' }).click()
  await expect(detailPanel.getByText('下载门禁：privacy_ack_required')).toHaveCount(0)
  await expect(detailPanel.getByRole('button', { name: '下载 manifest.json' })).toBeVisible()
  const acknowledgedGate = await api(page, 'GET', `/builds/${warnBuildID}`) as { download_gate: { allowed: boolean; reason: string } }
  expect(acknowledgedGate.download_gate).toMatchObject({ allowed: true, reason: 'acknowledged' })
})

// 上传字节被篡改 → 服务端 422 artifact_hash_mismatch；渲染期间改稿 → build_stale；
// 门禁关闭时详情里不渲染任何下载控件；跨工作区读构建/清单/证据一律 404。
test('DEV-CX02 Web 422/stale 呈现与门禁关闭时不渲染下载控件', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'Web 构建失败呈现验收' }) as { id: string; revision: number }
  const withViewpoint = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '浏览器端构建失败呈现验收作品的观点。', base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: withViewpoint.revision,
    items: [{ heading: '证据章节', key_point: '校验 422 呈现', material_ids: [] }],
  }) as { sections: Array<{ id: string; revision: number }> }
  const section = outlined.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '冻结来源正文，用于验证浏览器构建失败呈现。', base_revision: section.revision })
  await page.goto(`/works/${work.id}`)

  const panel = page.getByTestId('work-build-panel')
  await expect(panel).toBeVisible()
  await panel.getByRole('checkbox', { name: '离线稳定版 HTML' }).check()

  // 场景一：保留 kind/sha256 声明，只替换 file 字节 → artifact_hash_mismatch。
  await page.route('**/api/v1/builds/*/artifacts', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.continue()
    const original = request.postDataBuffer()
    if (!original) return route.continue()
    const text = original.toString('utf8')
    const kind = /name="kind"\r\n\r\n([^\r\n]+)/.exec(text)?.[1]
    const sha = /name="sha256"\r\n\r\n([^\r\n]+)/.exec(text)?.[1]
    const filename = /filename="([^"]+)"/.exec(text)?.[1]
    const mime = /Content-Type: ([^\r\n]+)\r\n\r\n/.exec(text)?.[1]
    if (!kind || !sha || !filename || !mime) return route.continue()
    const boundary = '----web-e2e-tamper-boundary'
    const tampered = 'TAMPERED-CONTENT-BY-WEB-E2E —— 该内容不再匹配声明的 sha256。'
    const body = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="kind"\r\n\r\n${kind}`,
      `--${boundary}`,
      `Content-Disposition: form-data; name="sha256"\r\n\r\n${sha}`,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${mime}\r\n\r\n${tampered}`,
      `--${boundary}--`,
      '',
    ].join('\r\n')
    await route.continue({
      postData: Buffer.from(body, 'utf8'),
      headers: { ...request.headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
  })
  await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
  await expect(panel.getByText('上传摘要与服务端计算结果不一致')).toBeVisible({ timeout: 30_000 })
  await page.unroute('**/api/v1/builds/*/artifacts')
  const tamperedList = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
  expect(tamperedList.items[0]).toMatchObject({ status: 'failed', error_code: 'artifact_hash_mismatch' })
  const tamperedDetail = await api(page, 'GET', `/builds/${tamperedList.items[0].id}`) as { download_gate: { allowed: boolean } }
  expect(tamperedDetail.download_gate).toMatchObject({ allowed: false })

  // 场景二：complete 放行前改写正文 → build_stale。
  const current = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ id: string; revision: number; content_md: string }> }
  let completeBody: Record<string, unknown> | null = null
  await page.route('**/api/v1/builds/*/complete', async (route) => {
    completeBody = route.request().postDataJSON() as Record<string, unknown>
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: 'complete 放行前改写的正文，构成渲染期间来源变化。', base_revision: current.sections[0].revision,
    })
    await route.continue()
  })
  await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
  await expect.poll(async () => {
    const list = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ status: string; error_code: string | null }> }
    return list.items[0]?.error_code ?? ''
  }, { timeout: 30_000 }).toBe('build_stale')
  await expect(panel.getByText('构建输入在渲染期间已变化')).toBeVisible({ timeout: 15_000 })
  expect(completeBody).toBeTruthy()

  // 门禁关闭：详情不渲染任何下载控件（含 manifest.json / evidence.csv）。
  await page.reload()
  const detailPanel = page.getByTestId('build-detail')
  await expect(detailPanel).toBeVisible()
  await expect(detailPanel.getByRole('button', { name: '下载 manifest.json' })).toHaveCount(0)
  await expect(detailPanel.getByRole('button', { name: '下载图片证据 CSV' })).toHaveCount(0)
  await expect(detailPanel.getByText('下载门禁：build_not_complete')).toBeVisible()

  // 跨工作区隔离：另一工作区 owner 读构建详情/manifest/evidence.csv 全部 404。
  const staleList = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string }> }
  const staleBuild = staleList.items[0].id
  const second = await api(page, 'POST', '/workspaces', { name: 'Web 证据链隔离工作区', switch: false }) as { id: string }
  await api(page, 'POST', `/workspaces/${second.id}/switch`)
  const crossDetail = await page.request.fetch(`/api/v1/builds/${staleBuild}`)
  expect(crossDetail.status()).toBe(404)
  const crossManifest = await page.request.fetch(`/api/v1/builds/${staleBuild}/manifest.json`)
  expect(crossManifest.status()).toBe(404)
  const crossCSV = await page.request.fetch(`/api/v1/builds/${staleBuild}/evidence.csv`)
  expect(crossCSV.status()).toBe(404)
  expect(await crossManifest.text()).not.toContain('source_hash')
  expect(await crossCSV.text()).not.toContain('section_id')
})
