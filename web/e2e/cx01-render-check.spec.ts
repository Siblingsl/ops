import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), '../testdata/cx01-syntax-fixtures.json'), 'utf8')) as Array<{ name: string; markdown: string }>
const unsupportedFixture = fixtures.find(fixture => fixture.name === 'unsupported-markdown-syntax')!

test('作者可查看公众号语法报告并定位问题段，检查不写入作品', async ({ page }) => {
  await registerAccount(page)
  const account = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '语法检查旅程', content_format: 'long_article' })
  let work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '语法检查旅程' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '引用需要能定位。', base_revision: work.revision })
  work = await api(page, 'GET', `/works/${work.id}`)
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [{ heading: '引用段', key_point: '检查脚注位置', material_ids: [] }],
    confirm: true,
    base_revision: work.revision,
  })
  const section = work.sections[0]
  const content = unsupportedFixture.markdown
  await api(page, 'PATCH', `/sections/${section.id}`, { content_md: content, base_revision: section.revision })
  const before = await api(page, 'GET', `/works/${work.id}`)

  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '检查排版语法', exact: true }).click()
  await expect(page.getByText('发现不能可靠排版的语法', { exact: true })).toBeVisible()
  await expect(page.getByText(/第 1 行，第 3 列/)).toBeVisible()
  await expect(page.getByText(/定义列表/)).toBeVisible()
  await expect(page.getByText(/引用式链接/).first()).toBeVisible()
  await expect(page.getByText(/数学公式/).first()).toBeVisible()
  await expect(page.getByText(/Mermaid/)).toBeVisible()
  await page.getByRole('button', { name: '定位到第 1 段', exact: true }).first().click()
  await expect(page.locator(`#sec-${section.id}`)).toHaveClass(/flash/)

  const after = await api(page, 'GET', `/works/${work.id}`)
  expect(after.revision).toBe(before.revision)
  expect(after.sections[0].content_md).toBe(content)
})
