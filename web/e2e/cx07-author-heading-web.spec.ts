import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('网页端排版保留正文安全标题的作者样式', async ({ page }) => {
  await page.goto('/login')
  const html = await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/render.ts")')
    const { renderWechat } = await load()
    return renderWechat([{ heading: '段落', content_md: '<h2 style="color:#123456">作者标题</h2>' }], 'ink')
  })
  await page.setContent(html)
  await expect(page.getByText('作者标题')).toHaveCSS('color', 'rgb(18, 52, 86)')
})

test('网页端八套主题保持相同内容结构及基础标签样式', async ({ page }) => {
  await page.goto('/login')
  const result = await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/render.ts")')
    const { renderWechat, themes } = await load()
    const content = `<h3>标题</h3><p>正文 <strong>强调</strong> <em>斜体</em> <a href="https://example.test">链接</a></p>
<blockquote>引用</blockquote><ul><li>列表</li></ul><ol><li>列表</li></ol>
<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="图片"></p><pre><code>代码</code></pre><table><tbody><tr><td>表格</td></tr></tbody></table>`
    return themes.map((theme: { id: string }) => {
      const doc = new DOMParser().parseFromString(renderWechat([{ heading: '章节', content_md: content }], theme.id), 'text/html')
      const root = doc.body.firstElementChild!
      const styled = ['p', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'img', 'code', 'pre', 'table'].map(tag => [tag, !!root.querySelector(tag)?.getAttribute('style')])
      for (const element of [root, ...root.querySelectorAll('*')]) for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name)
      return { id: theme.id, tree: root.outerHTML, styled }
    })
  })
  expect(result).toHaveLength(8)
  for (const theme of result) {
    expect(theme.tree, theme.id).toBe(result[0].tree)
    for (const [tag, styled] of theme.styled) expect(styled, `${theme.id}: ${tag}`).toBe(true)
  }
})

test('网页端八套主题在 390px 宽度下不产生页面级横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/login')
  const rendered = await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/render.ts")')
    const { renderWechat, themes } = await load()
    const content = `## 一段手机宽度的测试标题

这段中文内容用于检查常见段落、加粗、斜体和链接在窄屏中的宽度。**重点内容**与 *补充说明* 都应保持在可视范围内。

> 引用内容会保留适当内边距，也不能推宽页面。

- 第一条普通列表
- 第二条包含一段较长的说明文字，用来观察列表缩进。

| 项目 | 说明 |
| --- | --- |
| 内容 | 手机宽度下的表格 |

\`\`\`text
const message = "narrow viewport"
\`\`\`

![示例图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lm1sAAAAASUVORK5CYII=)`
    return themes.map((theme: { id: string }) => ({ id: theme.id, html: renderWechat([{ heading: '390px 手机预览', content_md: content }], theme.id) }))
  })
  for (const { id, html } of rendered) {
    await page.setContent(html)
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(width.scroll, `${id}: 页面横向溢出`).toBeLessThanOrEqual(width.client)
  }
})

test('网页预览保留八套主题入口并将所选主题保存到作品', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '主题切换验收' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '主题是作品显式保存的排版选择。', base_revision: work.revision })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [{ heading: '章节标题', key_point: '检验主题样式', material_ids: [] }], confirm: true,
  })
  const current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${current.sections[0].id}`, {
    content_md: '### 正文内标题\n\n预览需要保留用户选择的主题。', base_revision: current.sections[0].revision,
  })

  await page.goto(`/works/${work.id}/preview`)
  for (const name of ['简洁', '黛青', '藤黄', '墨白', '橄榄手记', '教程浅绿', '红白观点', '石墨科技']) {
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  }
  await page.getByRole('button', { name: /藤黄/ }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).theme).toBe('tenghuang')
  await expect(page.getByTestId('wechat-rendered-html').locator('h3')).toHaveCSS('color', 'rgb(133, 83, 0)')
  await page.reload()
  await expect(page.getByTestId('wechat-rendered-html').locator('h3')).toHaveCSS('color', 'rgb(133, 83, 0)')
})
