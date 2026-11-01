import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), '../testdata/cx01-syntax-fixtures.json'), 'utf8')) as Array<{
  name: string
  markdown: string
  dom?: { headingTags?: string[]; strongParagraphs?: string[]; keptTags?: string[]; absentTags?: string[]; absentAttrs?: string[]; text?: string[] }
}>

test('共享排版夹具在 Web marked DOM 中保留结构与安全标签', async ({ page }) => {
  await page.goto('/login')
  const supported = fixtures.find(fixture => fixture.name === 'supported-and-converted')!
  const html = await page.evaluate(async ({ markdown }) => {
    const load = new Function('return import("/src/lib/render.ts")')
    const { renderWechat } = await load()
    return renderWechat([{ heading: '段落小标题', content_md: markdown }], 'ink')
  }, { markdown: supported.markdown })
  await page.setContent(html)

  expect(await page.locator('h2,h3').evaluateAll(nodes => nodes.map(node => node.tagName.toLowerCase()))).toEqual(supported.dom?.headingTags)
  for (const text of supported.dom?.strongParagraphs ?? []) await expect(page.locator('p > strong')).toContainText(text)
  for (const tag of supported.dom?.keptTags ?? []) await expect(page.locator(tag).first()).toBeVisible()
  for (const text of supported.dom?.text ?? []) await expect(page.locator('body')).toContainText(text)
  await expect(page.locator('dd')).toHaveCSS('color', 'rgb(18, 52, 86)')
  await expect(page.locator('input')).toHaveCount(0)

  const unsafe = fixtures.find(fixture => fixture.name === 'unsafe-and-fallback-html')!
  const unsafeHtml = await page.evaluate(async ({ markdown }) => {
    const load = new Function('return import("/src/lib/render.ts")')
    const { renderWechat } = await load()
    return renderWechat([{ heading: '', content_md: markdown }], 'ink')
  }, { markdown: unsafe.markdown })
  await page.setContent(unsafeHtml)
  for (const tag of unsafe.dom?.absentTags ?? []) await expect(page.locator(tag)).toHaveCount(0)
  for (const attr of unsafe.dom?.absentAttrs ?? []) await expect(page.locator(`[${attr}]`)).toHaveCount(0)
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(page.locator('custom-card')).toHaveCount(0)
  for (const text of unsafe.dom?.text ?? []) await expect(page.locator('body')).toContainText(text)
})
