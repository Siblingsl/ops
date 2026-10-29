import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

test('头条合法非默认形态选题不误报，可开写；旧平台仍提示形态冲突', async ({ page }) => {
  const account = await registerAccount(page, '文章', 'toutiao')
  const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '非默认微头条选题', format: 'micro_post' })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText(topic.title, { exact: true })).toBeVisible()
  await expect(page.getByText('形态与账号类型不匹配', { exact: true })).toHaveCount(0)
  await expect(page.getByText('微头条', { exact: true })).toBeVisible()
  await mkdir(resolve('../output'), { recursive: true })
  for (const width of [1440, 960, 740]) {
    await page.setViewportSize({ width, height: 640 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    const button = page.getByRole('button', { name: '采用并开始写', exact: true })
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: resolve(`../output/toutiao-topic-shapes-${width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: '采用并开始写', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const work = await api(page, 'GET', `/works/${page.url().split('/').pop()}`)
  expect(work.content_format).toBe('micro_post')
  expect(work.account_id).toBe(account.id)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出 Markdown', exact: true }).click()
  const download = await downloadEvent
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  const markdown = Buffer.concat(chunks).toString('utf8')
  expect(markdown).toContain('今日头条 · 微头条')
  expect(markdown).toContain('内部名称与段落标题不作为发布正文')
  await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '修改默认后仍可开写的文章', format: 'long_article' })
  await api(page, 'PATCH', `/accounts/${account.id}`, { content_format: 'micro_post', confirm_type_change: true })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText('修改默认后仍可开写的文章', { exact: true })).toBeVisible()
  await expect(page.getByText('文章', { exact: true })).toBeVisible()
  await expect(page.getByText('长图文', { exact: true })).toHaveCount(0)
  await expect(page.getByText('形态与账号类型不匹配', { exact: true })).toHaveCount(0)
  const xhs = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '旧平台形态回归', content_format: 'image_note' })
  const old = await api(page, 'POST', `/accounts/${xhs.id}/topics`, { title: '迁移前图文选题', format: 'image_note' })
  await api(page, 'PATCH', `/accounts/${xhs.id}`, { content_format: 'list_note', confirm_type_change: true })
  await page.goto(`/a/${xhs.id}/topics`)
  await expect(page.getByText(old.topic.title, { exact: true })).toBeVisible()
  await expect(page.getByText('形态与账号类型不匹配', { exact: true })).toBeVisible()
})
