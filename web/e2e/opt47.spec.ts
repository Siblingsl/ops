import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('OPT47 正文完成后主线直达标题步骤，导航不发起生成或发布', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这段正文由作者逐段填写。', base_revision: section.revision })
  }
  work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: '', base_revision: work.revision })
  await page.goto(`/a/${account.id}`)
  const next = page.getByRole('link', { name: /正文已写好，还没有标题.*去拟标题/ })
  await expect(next).toHaveAttribute('href', `/works/${id}#step-title`)
  const generated: string[] = []
  page.on('request', request => {
    const action = new URL(request.url()).pathname.split('/').pop() ?? ''
    if (request.method() === 'POST' && ['titles', 'draft', 'push', 'checks', 'derive'].includes(action)) generated.push(request.url())
  })
  await next.click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}#step-title$`))
  await expect(page.locator('#step-title')).toBeInViewport()
  expect(generated).toEqual([])
  expect((await api(page, 'GET', `/works/${id}`)).status).toBe('drafting')
})
