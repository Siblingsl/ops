import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

for (const platform of ['xhs', 'wechat_mp'] as const) {
  test(`OPT61 ${platform} 派生正文完整后一次点击去检查，空段保留继续编辑且不自动确认发布`, async ({ page }) => {
    const sourcePlatform = platform === 'xhs' ? 'wechat_mp' : 'xhs'
    const sourceAccount = await registerAccount(page, sourcePlatform === 'wechat_mp' ? '长图文' : '图文笔记', sourcePlatform)
    const sourceID = await createOutline(page)
    const source = await api(page, 'GET', `/works/${sourceID}`)
    for (const section of source.sections) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这是作者提供的正文，用于逐段派生验收。', base_revision: section.revision })
    const target = await api(page, 'POST', '/accounts', { platform, name: `派生目标${platform}`, content_format: platform === 'wechat_mp' ? 'long_article' : 'image_note' })
    const derived = await api(page, 'POST', `/works/${sourceID}/derive`, { target_account_id: target.id })
    expect(derived.sections.length).toBeGreaterThan(0)
    for (let i = 0; i < derived.sections.length; i++) {
      const section = derived.sections[i]
      await api(page, 'PATCH', `/sections/${section.id}`, { content_md: i === derived.sections.length - 1 ? '' : '这一段已由作者完成。', base_revision: section.revision })
    }
    await page.goto(`/works/${derived.id}/compare`)
    await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '去检查', exact: true })).toHaveCount(0)
    const latest = await api(page, 'GET', `/works/${derived.id}`)
    const last = latest.sections.at(-1)
    await api(page, 'PATCH', `/sections/${last.id}`, { content_md: '最后一段也已由作者完成。', base_revision: last.revision })
    await page.reload()
    const forbidden: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && /\/(checks\/complete|push|xhs\/pack)$/.test(path)) forbidden.push(path)
    })
    await page.getByRole('button', { name: '去检查', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/works/${derived.id}/check$`))
    expect(forbidden).toEqual([])
    expect(['ready', 'pushed', 'packed', 'published']).not.toContain((await api(page, 'GET', `/works/${derived.id}`)).status)
    expect((await api(page, 'GET', `/works/${sourceID}`)).account_id).toBe(sourceAccount.id)
  })
}
