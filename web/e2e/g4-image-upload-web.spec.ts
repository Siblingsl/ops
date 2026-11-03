import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { api, registerAccount } from './support'

// DEV-QA26（26 台账 G4-09）：与桌面 g4-image-upload-desktop.spec.ts 同一旅程的浏览器形态。
// 编辑器「上传图片」按钮的 file chooser 路径此前只有粘贴（cx11）覆盖；这里补齐：
// 非法类型拒绝、多张入库、删除确认。Web 与桌面各自独立实现，本文件不与桌面共享代码。

/** 在页面里用 canvas 生成一张 96×96 真实 PNG（服务端会解码校验像素，1×1 占位 PNG 会被 422 拒绝）。 */
async function pngBase64(page: Parameters<typeof api>[0], color: string): Promise<string> {
  return page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, 96, 96)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }, color)
}

async function xhsWorkWithSection(page: Parameters<typeof api>[0], accountID: string, title: string) {
  let work = await api(page, 'POST', `/accounts/${accountID}/works`, { content_format: 'image_note' })
  work = await api(page, 'PATCH', `/works/${work.id}`, { title, viewpoint: '上传走查：图片是配图不是观点。', base_revision: work.revision })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [{ heading: '第一段', key_point: '上传走查', material_ids: [] }],
    confirm: true, base_revision: work.revision,
  })
  await api(page, 'PATCH', `/sections/${work.sections[0].id}`, { content_md: '先写正文，再补图。', base_revision: work.sections[0].revision })
  return work as { id: string }
}

test('DEV-QA26 Web 上传图片走文件选择路径：非法类型拒绝、多张入库、删除确认', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(120_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `g4-upload-web-${Date.now()}`)
  const work = await xhsWorkWithSection(page, account.id, 'Web 上传图片走查')
  const dir = await mkdtemp(join(tmpdir(), 'ops-g4-upload-web-'))
  const pngA = join(dir, 'a.png')
  const pngB = join(dir, 'b.png')
  const txt = join(dir, 'not-image.txt')
  await writeFile(pngA, Buffer.from(await pngBase64(page, '#2f6fed'), 'base64'))
  await writeFile(pngB, Buffer.from(await pngBase64(page, '#f5a524'), 'base64'))
  await writeFile(txt, '这不是图片')

  await page.goto(`/works/${work.id}`)
  // 图片区（editor-images）的 input 带 multiple；段落内联上传（section-block）没有，用 multiple 区分。
  const picker = page.locator('input[type="file"][accept="image/*"][multiple]')
  await expect(picker).toBeAttached()

  // 1) 非法类型走客户端拒绝路径：不产生上传请求，失败区出现提示。
  await picker.setInputFiles([txt])
  await expect(page.getByTestId('upload-failures')).toBeVisible()
  let workNow = await api(page, 'GET', `/works/${work.id}`) as { assets: Array<{ id: string }> }
  expect(workNow.assets).toHaveLength(0)

  // 2) 一次选择两张合法图片：逐张 POST 入库，界面显示「已选 2 张」。
  const first = page.waitForResponse((r) => r.url().includes(`/works/${work.id}/assets`) && r.request().method() === 'POST')
  const second = page.waitForResponse((r) => r.url().includes(`/works/${work.id}/assets`) && r.request().method() === 'POST')
  await picker.setInputFiles([pngA, pngB])
  expect([await first, await second].map((r) => r.status())).toEqual([200, 200])
  workNow = await api(page, 'GET', `/works/${work.id}`) as { assets: Array<{ id: string }> }
  expect(workNow.assets).toHaveLength(2)
  await expect(page.getByText(/已选 2 张/)).toBeVisible()
  await expect(page.getByText('第一张作为封面')).toBeVisible()

  // 3) 删除第一张：确认对话框保护，取消不删、确认后服务端与界面同步。
  const del = page.locator('button[title="删除"]').first()
  await del.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  workNow = await api(page, 'GET', `/works/${work.id}`) as { assets: Array<{ id: string }> }
  expect(workNow.assets).toHaveLength(2)
  await del.click()
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect.poll(async () => ((await api(page, 'GET', `/works/${work.id}`)) as { assets: unknown[] }).assets.length).toBe(1)
  await expect(page.getByText(/已选 1 张/)).toBeVisible()
})
