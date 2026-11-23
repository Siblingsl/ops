import { _electron, expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

// REF41 C3-A6（真实 Electron 窗口）：在安装包同一主进程/渲染进程里完成构建、
// 下载并校验文件名、字节数与 SHA256，避免只以 desktop-renderer Chromium 充当桌面证据。
const TITLE = 'C3 Electron Office 导出验收'

async function officeWork(page: import('@playwright/test').Page, accountID: string) {
  const work = await api(page, 'POST', `/accounts/${accountID}/works`, { title: TITLE, content_format: 'long_article' }) as { id: string; revision: number }
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '真实 Electron 窗口使用固定模板生成 PPTX/DOCX，同一版本得到同一文件。',
    base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: viewed.revision,
    items: [
      { heading: 'Electron 导出', key_point: '真实窗口与确定性', material_ids: [] },
      { heading: '下载验收', key_point: '文件名、字节数与 SHA256', material_ids: [] },
    ],
  }) as { sections: Array<{ id: string; revision: number }> }
  for (const [index, section] of outlined.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: index === 0
        ? '真实 Electron 窗口通过 Office 校验链路上传产物，不绕过 AIGC 属性。'
        : '下载 helper 使用服务端文件名，并显示大小和 SHA256 前 12 位。',
      base_revision: section.revision,
    })
  }
  return await api(page, 'GET', `/works/${work.id}`) as { id: string; revision: number }
}

test('C3 真实 Electron 窗口导出、下载并校验字节数与 SHA256', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.setTimeout(180_000)
  const username = `c3-electron-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username, baseURL!)
  const work = await officeWork(page, account.id)

  const profile = await mkdtemp(join(tmpdir(), 'ops-c3-electron-'))
  const resultDir = resolve('../.playwright-results/desktop-renderer')
  await mkdir(resultDir, { recursive: true })
  const pptxPath = join(resultDir, `c3-electron-${Date.now()}.pptx`)
  const docxPath = join(resultDir, `c3-electron-${Date.now()}.docx`)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/works/${work.id}`)
    await expect(native.getByTestId('desktop-editor-layout')).toBeVisible()

    const panel = native.getByTestId('work-build-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('office-export-template-version')).toContainText('office-render-v1')
    await panel.getByRole('checkbox', { name: '公众号预览 HTML' }).uncheck()
    await panel.getByRole('checkbox', { name: 'PPTX 演示文稿' }).check()
    await panel.getByRole('checkbox', { name: 'DOCX 文档' }).check()
    const completion = native.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
    expect((await completion).status()).toBe(200)

    const detail = native.getByTestId('build-detail')
    const pptxName = `c3-electron-office-导出验收-${work.revision}.pptx`
    const docxName = `c3-electron-office-导出验收-${work.revision}.docx`
    await expect(detail.getByTestId('build-artifact-pptx')).toContainText(new RegExp(pptxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await expect(detail.getByTestId('build-artifact-docx')).toContainText(new RegExp(docxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const builds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string }> }
    const build = await api(page, 'GET', `/builds/${builds.items[0].id}`) as {
      artifacts: Array<{ kind: string; name: string; bytes: number; sha256: string }>
      download_gate: { allowed: boolean }
    }
    expect(build.download_gate.allowed).toBe(true)
    const pptx = build.artifacts.find(item => item.kind === 'pptx')!
    const docx = build.artifacts.find(item => item.kind === 'docx')!
    expect(pptx.name).toBe(pptxName)
    expect(docx.name).toBe(docxName)
    await expect(detail.getByTestId('build-artifact-pptx')).toContainText(`· ${pptx.bytes.toLocaleString()} 字节`)
    await expect(detail.getByTestId('build-artifact-docx')).toContainText(`· ${docx.bytes.toLocaleString()} 字节`)

    await app.evaluate(({ session }, paths) => {
      session.fromPartition('persist:ops-business-development').on('will-download', (_event, item) => {
        const name = item.getFilename()
        if (name === paths.pptxName) item.setSavePath(paths.pptxPath)
        if (name === paths.docxName) item.setSavePath(paths.docxPath)
      })
    }, { pptxName, docxName, pptxPath, docxPath })

    await detail.getByTestId('download-artifact-pptx').click()
    await expect.poll(() => readFile(pptxPath).then(file => file.length).catch(() => 0), { timeout: 30_000 }).toBe(pptx.bytes)
    const pptxBytes = await readFile(pptxPath)
    expect(createHash('sha256').update(pptxBytes).digest('hex')).toBe(pptx.sha256)
    expect(pptxBytes.length).toBe(pptx.bytes)
    expect(pptxBytes.includes('name="AIGC"')).toBe(true)
    expect(pptxBytes.includes('由 OPS 生成')).toBe(true)

    await detail.getByTestId('download-artifact-docx').click()
    await expect.poll(() => readFile(docxPath).then(file => file.length).catch(() => 0), { timeout: 30_000 }).toBe(docx.bytes)
    const docxBytes = await readFile(docxPath)
    expect(createHash('sha256').update(docxBytes).digest('hex')).toBe(docx.sha256)
    expect(docxBytes.length).toBe(docx.bytes)
    expect(docxBytes.includes('name="AIGC"')).toBe(true)
    expect(docxBytes.includes('AI 生成内容')).toBe(true)

    await native.screenshot({ path: join(resultDir, 'c3-electron-office-export.png'), fullPage: true })
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本用例创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    const resolvedProfile = resolve(profile)
    if (!resolvedProfile.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-c3-electron-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
