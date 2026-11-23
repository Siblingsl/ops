import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 C3-A6（桌面工作台）：与 Web 同一收口，但走桌面 BuildPanel 与独立下载 helper。
const TITLE = 'C3 桌面 Office 导出验收'

async function useDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const apply = () => {
      document.documentElement.dataset.presentation = 'ops-creative-desktop'
      document.documentElement.dataset.theme = 'light'
      document.documentElement.dataset.reducedMotion = 'soft'
    }
    if (document.documentElement) apply()
    else document.addEventListener('DOMContentLoaded', apply, { once: true })
  })
}

async function officeWork(page: Page, accountID: string) {
  const work = await api(page, 'POST', `/accounts/${accountID}/works`, { title: TITLE, content_format: 'long_article' }) as { id: string; revision: number }
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '桌面构建面板使用固定模板生成 PPTX/DOCX，同一版本得到同一文件。',
    base_revision: work.revision,
  }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true,
    base_revision: viewed.revision,
    items: [
      { heading: '桌面导出', key_point: '固定模板与确定性', material_ids: [] },
      { heading: '下载验收', key_point: '文件名与 SHA256', material_ids: [] },
    ],
  }) as { sections: Array<{ id: string; revision: number }> }
  for (const [index, section] of outlined.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: index === 0
        ? '桌面端同样通过 Office 校验链路上传产物，不绕过 AIGC 属性。'
        : '下载 helper 使用服务端文件名，并显示大小和 SHA256 前 12 位。',
      base_revision: section.revision,
    })
  }
  return await api(page, 'GET', `/works/${work.id}`) as { id: string; revision: number; title: string }
}

test('C3 桌面勾选 PPTX/DOCX 导出、下载并校验文件名与哈希', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const account = await registerAccount(page, '长图文', 'wechat_mp', undefined, origin)
  const work = await officeWork(page, account.id)
  await useDesktopPresentation(page)
  await page.goto(`${origin}/works/${work.id}`)
  await expect(page.getByTestId('desktop-editor-layout')).toBeVisible()

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
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(new RegExp(`c3-桌面-office-导出验收-${work.revision}\\.pptx`))
  await expect(detail.getByTestId('build-artifact-docx')).toContainText(new RegExp(`c3-桌面-office-导出验收-${work.revision}\\.docx`))
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(/SHA256 [a-f0-9]{12}/)
  await expect(detail.getByTestId('build-artifact-docx')).toContainText(/SHA256 [a-f0-9]{12}/)

  const builds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string }> }
  expect(builds.items[0]).toMatchObject({ status: 'built' })
  const build = await api(page, 'GET', `/builds/${builds.items[0].id}`) as {
    artifacts: Array<{ kind: string; name: string; bytes: number; sha256: string; downloadable: boolean }>
    download_gate: { allowed: boolean }
  }
  expect(build.download_gate.allowed).toBe(true)
  expect(build.artifacts.map(item => item.kind).sort()).toEqual(['docx', 'pptx'])
  const pptx = build.artifacts.find(item => item.kind === 'pptx')!
  const docx = build.artifacts.find(item => item.kind === 'docx')!
  expect(pptx.name).toBe(`c3-桌面-office-导出验收-${work.revision}.pptx`)
  expect(docx.name).toBe(`c3-桌面-office-导出验收-${work.revision}.docx`)
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

  const secondCompletion = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '重新生成', exact: true }).click()
  expect((await secondCompletion).status()).toBe(200)
  const secondBuilds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string }> }
  const secondBuild = await api(page, 'GET', `/builds/${secondBuilds.items[0].id}`) as { artifacts: Array<{ kind: string; sha256: string }> }
  expect(secondBuild.artifacts.find(item => item.kind === 'pptx')?.sha256).toBe(pptx.sha256)
  expect(secondBuild.artifacts.find(item => item.kind === 'docx')?.sha256).toBe(docx.sha256)

  const bumped = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '修订版本改变正文后，桌面 Office 产物必须得到不同哈希。',
    base_revision: work.revision,
  }) as { revision: number }
  expect(bumped.revision).toBeGreaterThan(work.revision)
  const thirdCompletion = page.waitForResponse(response => response.url().includes('/complete') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '重新生成', exact: true }).click()
  expect((await thirdCompletion).status()).toBe(200)
  await expect(detail.getByTestId('build-artifact-pptx')).toContainText(new RegExp(`c3-桌面-office-导出验收-${bumped.revision}\\.pptx`))
  const thirdBuilds = await api(page, 'GET', `/works/${work.id}/builds?limit=8`) as { items: Array<{ id: string; status: string }> }
  const thirdBuild = await api(page, 'GET', `/builds/${thirdBuilds.items[0].id}`) as { basis_revision: number; artifacts: Array<{ kind: string; sha256: string }> }
  expect(thirdBuild.basis_revision).toBe(bumped.revision)
  expect(thirdBuild.artifacts.find(item => item.kind === 'pptx')?.sha256).not.toBe(pptx.sha256)
  expect(thirdBuild.artifacts.find(item => item.kind === 'docx')?.sha256).not.toBe(docx.sha256)
})
