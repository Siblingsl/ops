import { expect, test } from '@playwright/test'

test('桌面构建渲染保留逐段来源和重复图片顺序', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/login`)
  const rendered = await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/render.ts")')
    const { renderWechatSections, createStableWechatHTML } = await load()
    const assetID = '4f9c5897-1bf9-4812-981f-4d675ef4ad61'
    const build = renderWechatSections([
      { id: 'b78bf6bc-24a5-4ec9-a38f-3c833851bc30', heading: '第一段', content_md: `正文 ![图](/api/v1/assets/${assetID}/file)\n\n重复 ![图](/api/v1/assets/${assetID}/file)` },
      { id: 'dfad2f35-8b1c-41a1-8d20-78e8f9ebd501', heading: '第二段', content_md: '没有图片。' },
    ], 'ink', [{ id: assetID, alt_text: '冻结图片' }])
    return { ...build, stable: createStableWechatHTML(build.html, '归档 <稿件>', 7, [{ id: assetID, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }]) }
  })

  const dom = await page.evaluate((html) => {
    const root = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild
    return {
      tagName: root?.tagName,
      sectionIDs: Array.from(root?.children ?? []).map((node) => node.getAttribute('data-section-id')),
      assetIDs: Array.from(root?.querySelectorAll('img') ?? []).map((img) => img.getAttribute('data-asset')),
    }
  }, rendered.html)
  expect(dom.tagName).toBe('SECTION')
  expect(dom.sectionIDs).toEqual([
    'b78bf6bc-24a5-4ec9-a38f-3c833851bc30', 'dfad2f35-8b1c-41a1-8d20-78e8f9ebd501',
  ])
  expect(rendered.sections.map((section: { image_occurrences: string[] }) => section.image_occurrences)).toEqual([
    ['4f9c5897-1bf9-4812-981f-4d675ef4ad61', '4f9c5897-1bf9-4812-981f-4d675ef4ad61'], [],
  ])
  expect(dom.assetIDs).toEqual([
    '4f9c5897-1bf9-4812-981f-4d675ef4ad61', '4f9c5897-1bf9-4812-981f-4d675ef4ad61',
  ])
  const stable = await page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return {
      title: doc.title,
      imageSources: Array.from(doc.querySelectorAll('img')).map((img) => img.getAttribute('src')),
      hasNetworkResource: Boolean(doc.querySelector('link[href],script[src],iframe[src],img[src^="http"],img[src^="/api/"]')),
    }
  }, rendered.stable)
  expect(stable.title).toBe('归档 <稿件>')
  expect(stable.imageSources).toEqual(['data:image/png;base64,AQID', 'data:image/png;base64,AQID'])
  expect(stable.hasNetworkResource).toBe(false)
})
