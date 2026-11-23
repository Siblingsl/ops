import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 C3-A6（Web）：勾选 PPTX/DOCX → 生成 → 下载 → 文件名/SHA256/AIGC 页脚可见。
// 同一冻结版本与参数再次构建，Office 产物哈希必须一致（C3-A2 的 UI 路径）。
const TITLE = 'C3 Office 导出验收'

async function officeWork(page: Parameters<typeof api>[0], accountID: string) {
  const work = await api(page, 'POST', `/accounts/${accountID}/works`, { title: TITLE, content_format: 'long_article' }) as { id: string; revision: number }
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '固定模板只做占位替换；同一版本必须得到同一个 Office 文件。',
    base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: viewed.revision,
    items: [
      { heading: '确定性导出', key_point: '固定模板与固定 ZIP 顺序', material_ids: [] },
      { heading: '交付边界', key_point: '不自由排版', material_ids: [] },
    ],
  }) as { sections: Array<{ id: string; revision: number }> }
  for (const [index, section] of outlined.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: index === 0
        ? '同一冻结版本与参数生成相同 SHA256，产物包含 AIGC 文档属性。'
        : 'PPTX 一页封面、一页标题加正文；DOCX 标题、副标题、正文和 AI 生成内容页脚。',
      base_revision: section.revision,
    })
  }
  return await api(page, 'GET', `/works/${work.id}`) as { id: string; revision: number; title: string }
}

test('C3 Web 勾选 PPTX/DOCX 导出、下载并校验文件名与哈希', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await officeWork(page, account.id)
  await page.goto(`/works/${work.id}`)

  const panel = page.getByTestId('work-build-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('office-export-template-version')).toContainText('office-render-v1')
  await expect(panel.getByTestId('office-export-deterministic-note')).toContainText('相同 SHA256')
  await expect(panel.getByRole('checkbox', { name: 'PPTX 演示文稿' })).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: 'DOCX 文档' })).toBeVisible()

  await panel.getByRole('checkbox', { name: '公众号预览 HTML' }).uncheck()
  await panel.getByRole('checkbox', { name: 'PPTX 演示文稿' }).check()
  await panel.getByRole('checkbox', { name: 'DOCX 文档' }).check()
  const completion = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '生成校验报告', exact: true }).click()
  const completed = await completion
  expect(completed.status(), await completed.text()).toBe(200)

  const detail = page.getByTestId('build-detail')
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(new RegExp(`c3-office-导出验收-${work.revision}\\.pptx`))
  await expect(detail.getByTestId('build-artifact-docx')).toContainText(new RegExp(`c3-office-导出验收-${work.revision}\\.docx`))
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(/SHA256 [a-f0-9]{12}/)
  await expect(detail.getByTestId('build-artifact-docx')).toContainText(/SHA256 [a-f0-9]{12}/)

  const builds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string }> }
  expect(builds.items[0]).toMatchObject({ status: 'built' })
  const buildID = builds.items[0].id
  const build = await api(page, 'GET', `/builds/${buildID}`) as {
    artifacts: Array<{ kind: string; name: string; bytes: number; sha256: string; downloadable: boolean }>
    manifest?: { office?: { template_version?: string; aigc?: boolean } }
    download_gate: { allowed: boolean }
  }
  expect(build.download_gate.allowed).toBe(true)
  expect(build.artifacts.map(item => item.kind).sort()).toEqual(['docx', 'pptx'])
  expect(build.artifacts.every(item => item.downloadable)).toBe(true)
  const pptx = build.artifacts.find(item => item.kind === 'pptx')!
  const docx = build.artifacts.find(item => item.kind === 'docx')!
  expect(pptx.name).toBe(`c3-office-导出验收-${work.revision}.pptx`)
  expect(docx.name).toBe(`c3-office-导出验收-${work.revision}.docx`)
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(`· ${pptx.bytes.toLocaleString()} 字节`)
  await expect(detail.getByTestId('build-artifact-docx')).toContainText(`· ${docx.bytes.toLocaleString()} 字节`)

  const [pptxDownload] = await Promise.all([
    page.waitForEvent('download'),
    detail.getByTestId('download-artifact-pptx').click(),
  ])
  expect(pptxDownload.suggestedFilename()).toBe(pptx.name)
  const pptxPath = await pptxDownload.path()
  expect(pptxPath).toBeTruthy()
  const pptxBytes = await readFile(pptxPath!)
  expect(createHash('sha256').update(pptxBytes).digest('hex')).toBe(pptx.sha256)
  expect(pptxBytes.length).toBe(pptx.bytes)
  expect(pptxBytes.includes('name="AIGC"')).toBe(true)
  expect(pptxBytes.includes('由 OPS 生成')).toBe(true)

  const [docxDownload] = await Promise.all([
    page.waitForEvent('download'),
    detail.getByTestId('download-artifact-docx').click(),
  ])
  expect(docxDownload.suggestedFilename()).toBe(docx.name)
  const docxPath = await docxDownload.path()
  expect(docxPath).toBeTruthy()
  const docxBytes = await readFile(docxPath!)
  expect(createHash('sha256').update(docxBytes).digest('hex')).toBe(docx.sha256)
  expect(docxBytes.length).toBe(docx.bytes)
  expect(docxBytes.includes('name="AIGC"')).toBe(true)
  expect(docxBytes.includes('AI 生成内容')).toBe(true)

  // 同一版本、同一参数、同样 targets 再构建一次；固定模板 + 固定时间戳/顺序必须得到相同哈希。
  const secondCompletion = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '重新生成', exact: true }).click()
  expect((await secondCompletion).status()).toBe(200)
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText('c3-office-导出验收-')
  const secondBuilds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string }> }
  const secondBuild = await api(page, 'GET', `/builds/${secondBuilds.items[0].id}`) as { artifacts: Array<{ kind: string; sha256: string }> }
  expect(secondBuild.artifacts.find(item => item.kind === 'pptx')?.sha256).toBe(pptx.sha256)
  expect(secondBuild.artifacts.find(item => item.kind === 'docx')?.sha256).toBe(docx.sha256)

  // 修改正文使修订号变化，再构建一次；产物必须换名并产生不同哈希，证明“同输入同哈希”不是忽略版本。
  const bumped = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '修订版本改变正文后，Office 产物必须得到不同哈希。',
    base_revision: work.revision,
  }) as { revision: number }
  expect(bumped.revision).toBeGreaterThan(work.revision)
  const thirdCompletion = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '重新生成', exact: true }).click()
  expect((await thirdCompletion).status()).toBe(200)
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(new RegExp(`c3-office-导出验收-${bumped.revision}\\.pptx`))
  const thirdBuilds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string }> }
  const thirdBuild = await api(page, 'GET', `/builds/${thirdBuilds.items[0].id}`) as { basis_revision: number; artifacts: Array<{ kind: string; sha256: string }> }
  expect(thirdBuild.basis_revision).toBe(bumped.revision)
  expect(thirdBuild.artifacts.find(item => item.kind === 'pptx')?.sha256).not.toBe(pptx.sha256)
  expect(thirdBuild.artifacts.find(item => item.kind === 'docx')?.sha256).not.toBe(docx.sha256)
})
