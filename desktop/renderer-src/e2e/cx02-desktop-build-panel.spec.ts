import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('DEV-CX02 桌面稳定版提交冻结产物并覆盖 WARN 知悉放行', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '桌面冻结快照构建验收' }) as { id: string; revision: number }
  const current = await api(page, 'GET', `/works/${work.id}`) as { revision: number }
  const withViewpoint = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '我会按已保存的观点完成只读内容构建。', base_revision: current.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: withViewpoint.revision,
    items: [{ heading: '冻结章节', key_point: '验证只读构建', material_ids: [] }],
  }) as { sections: Array<{ id: string; revision: number }> }
  const section = outlined.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这段正文用于验证桌面构建。', base_revision: section.revision })
  await page.goto(`/works/${work.id}`)

  await page.evaluate(() => {
    Object.defineProperty(window, 'opsDesktopUI', {
      configurable: true,
      value: {
        captureLongImage: async (buildId: string) => {
          const sourceHash = document.getElementById('ops-cx-long-image-source')?.getAttribute('data-source-hash') || ''
          const canvas = document.createElement('canvas')
          canvas.width = 780
          canvas.height = 2
          const context = canvas.getContext('2d')!
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.fillStyle = '#000000'
          context.fillRect(390, 1, 1, 1)
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encode failed')), 'image/png'))
          return {
            ok: true as const, buildId, sourceHash, png: new Uint8Array(await blob.arrayBuffer()),
            width: 780, height: 2, heightCss: 1, dpr: 2, viewportWidth: 390, viewportHeight: 844, segments: 1,
            captureEngine: 'chromium-cdp' as const, captureEngineVersion: 'mock-electron',
            captureCheckScope: 'font_ready,image_decode,layout_stable_2_frames,segment_png_decode,final_png_dimensions,non_uniform_pixels',
            capturedAt: new Date().toISOString(), fontFamily: 'Arial, sans-serif',
          }
        },
      },
    })
  })

  const panel = page.getByTestId('work-build-panel')
  await expect(panel).toBeVisible()
  await panel.getByRole('checkbox', { name: '离线稳定版 HTML' }).check()
  await panel.getByRole('checkbox', { name: '390px 真实长图（仅桌面）' }).check()
  const complete = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
  const completion = await complete
  const completionBody = await completion.text()
  // Q-CX-03 拍板后（90 D-165）：纯净产物无 ERROR/WARN，complete 直接置 built。
  expect(completion.status(), completionBody).toBe(200)
  expect(completionBody).toContain('"status":"built"')
  await expect(panel.getByText(/隐私扫描：pass · ERROR 0 · WARN 0/)).toBeVisible()
  await expect(panel.getByText(/未发布的规则决策/)).toHaveCount(0)

  const list = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
  expect(list.items[0]).toMatchObject({ status: 'built', error_code: null })
  const build = await api(page, 'GET', `/builds/${list.items[0].id}`) as { artifacts: Array<{ kind: string; downloadable: boolean }>; download_gate: { allowed: boolean; reason: string } }
  expect(build.artifacts.map(item => item.kind).sort()).toEqual(['html', 'png', 'stable_html'])
  expect(build.artifacts.every(item => item.downloadable)).toBe(true)
  expect(build.download_gate).toMatchObject({ allowed: true, reason: 'clear' })
  const detailPanel = page.getByTestId('build-detail')
  await expect(detailPanel.getByRole('button', { name: '下载 manifest.json' })).toBeVisible()
  await expect(detailPanel.getByRole('button', { name: '下载图片证据 CSV' })).toBeVisible()
  const unchanged = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ content_md: string }> }
  expect(unchanged.sections[0].content_md).toBe('这段正文用于验证桌面构建。')

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

// DEV-CX03 / T-CX05 桌面旅程：上传产物被服务端 422 拒绝的界面呈现、渲染期间改稿的
// build_stale 呈现、门禁关闭时下载控件不渲染、跨工作区对构建与证据/清单下载一律 404。
// 只写本地隔离库；不注入 built、不开放任何下载。
test('DEV-CX03 桌面 422/stale 呈现、下载控件门禁与跨工作区 404', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '证据链 422 呈现验收' }) as { id: string; revision: number }
  const withViewpoint = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '证据链 422 呈现验收作品的观点。', base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: withViewpoint.revision,
    items: [{ heading: '证据章节', key_point: '校验 422 呈现', material_ids: [] }],
  }) as { sections: Array<{ id: string; revision: number }> }
  const section = outlined.sections[0]
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '冻结来源正文，用于验证构建失败呈现。', base_revision: section.revision })
  await page.goto(`/works/${work.id}`)

  const panel = page.getByTestId('work-build-panel')
  await expect(panel).toBeVisible()
  await panel.getByRole('checkbox', { name: '离线稳定版 HTML' }).check()

  // 场景一：上传的 HTML 内容与声明的 sha256 不一致（模拟损坏/被篡改的渲染产物）→ 422 artifact_hash_mismatch。
  // 重建 multipart：保留原 kind/sha256 字段值，只把 file 字段的字节换成篡改内容。
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
    const boundary = '----e2e-tamper-boundary'
    const tampered = 'TAMPERED-CONTENT-BY-E2E —— 该内容不再匹配声明的 sha256。'
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
  const tampered = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
  expect(tampered.items[0]).toMatchObject({ status: 'failed', error_code: 'artifact_hash_mismatch' })
  // 失败构建的门禁同样关闭。
  const tamperDetail = await api(page, 'GET', `/builds/${tampered.items[0].id}`) as { download_gate: { allowed: boolean; reason: string } }
  expect(tamperDetail.download_gate).toMatchObject({ allowed: false })

  // 场景二：构建启动后、complete 前改写正文 → complete 以 build_stale 拒绝，历史可见。
  // 实现方式：拦截 complete 请求，先 PATCH 正文再放行（complete 会重算当前快照 hash 并与冻结比对）。
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

  // 门禁关闭时：构建详情里不渲染任何下载按钮（含 manifest.json / evidence.csv）。
  await page.reload()
  const detailPanel = page.getByTestId('build-detail')
  await expect(detailPanel).toBeVisible()
  await expect(detailPanel.getByRole('button', { name: '下载 manifest.json' })).toHaveCount(0)
  await expect(detailPanel.getByRole('button', { name: '下载图片证据 CSV' })).toHaveCount(0)
  await expect(detailPanel.getByText('下载门禁：build_not_complete')).toBeVisible()

  // 跨工作区隔离：另一个工作区的 owner 读取构建详情/manifest/evidence.csv 全部 404。
  const staleList = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string }> }
  const staleBuild = staleList.items[0].id
  const second = await api(page, 'POST', '/workspaces', { name: '证据链隔离工作区', switch: false })
  await api(page, 'POST', `/workspaces/${second.id}/switch`)
  const crossDetail = await page.request.fetch(`/api/v1/builds/${staleBuild}`)
  expect(crossDetail.status()).toBe(404)
  const crossManifest = await page.request.fetch(`/api/v1/builds/${staleBuild}/manifest.json`)
  expect(crossManifest.status()).toBe(404)
  const crossCSV = await page.request.fetch(`/api/v1/builds/${staleBuild}/evidence.csv`)
  expect(crossCSV.status()).toBe(404)
  // 任何情况下都不返回内容片段。
  expect((await crossManifest.text())).not.toContain('source_hash')
  expect((await crossCSV.text())).not.toContain('section_id')
})
