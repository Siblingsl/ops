import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT36 作品标签可添加、移除、筛选并在命令面板搜索', async ({ page }) => {
  const account = await registerAccount(page)
  const workId = '3b62c0e8-f876-4755-ae06-8bc1bd3bfc36'
  const otherId = 'ce43d8cc-fab1-499c-8c53-5a0b0d3c7a36'
  let tags = ['旧主题']
  let searchQuery = ''
  const makeWork = (id: string, title: string, workTags: string[]) => ({
    id, title, tags: workTags, status: 'drafting', content_format: 'long_article',
    source_work_id: null, source_title: null, derived_count: 0, cover_asset_id: null, first_asset_id: null,
    char_count: 0, section_count: 0, published_at: null, updated_at: new Date().toISOString(),
    planned_date: null, assignee_id: null, target_chars: null, todos_done: 0, todos_total: 0,
  })
  await page.route(url => url.pathname === `/api/v1/accounts/${account.id}/works`, route => route.fulfill({ json: [
    makeWork(workId, 'OPT36 标签作品', tags), makeWork(otherId, 'OPT36 其他作品', ['其他主题']),
  ] }))
  await page.route(url => url.pathname === '/api/v1/stars', route => route.fulfill({ json: [] }))
  await page.route(url => url.pathname === `/api/v1/works/${workId}`, async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    tags = route.request().postDataJSON().tags
    await route.fulfill({ json: {} })
  })
  await page.route(url => url.pathname === '/api/v1/search', route => {
    searchQuery = new URL(route.request().url()).searchParams.get('q') ?? ''
    const items = searchQuery === '精选主题' ? [{
      type: 'work', id: workId, title: 'OPT36 标签作品', snippet: '精选主题', account_id: account.id,
      account_name: account.name, status: 'drafting', link: `/works/${workId}`, score: 1, matched: ['精选主题'],
      starred: false, updated_at: new Date().toISOString(),
    }] : []
    return route.fulfill({ json: { items } })
  })

  await page.goto(`/a/${account.id}/works`)
  const tagFilter = page.getByRole('combobox', { name: '按标签筛选' })
  await tagFilter.selectOption('旧主题')
  await expect(page.getByRole('link', { name: /OPT36 标签作品/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /OPT36 其他作品/ })).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get('tag')).toBe('旧主题')

  await page.getByRole('button', { name: '编辑作品标签' }).first().click()
  await page.getByRole('button', { name: '移除标签 旧主题' }).click()
  await page.getByRole('textbox', { name: '新增标签' }).fill('精选主题')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('button', { name: '保存标签' }).click()
  await expect(page.getByText('标签已保存')).toBeVisible()
  await expect(tagFilter.locator('option', { hasText: '精选主题' })).toBeAttached()
  await tagFilter.selectOption('精选主题')
  await expect(page.getByRole('link', { name: /OPT36 标签作品/ })).toBeVisible()

  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await palette.getByPlaceholder('搜索作品、选题、素材，或输入命令（支持拼音首字母）').fill('精选主题')
  await expect(palette.getByRole('button', { name: 'OPT36 标签作品' })).toBeVisible()
  await expect.poll(() => searchQuery).toBe('精选主题')
})
