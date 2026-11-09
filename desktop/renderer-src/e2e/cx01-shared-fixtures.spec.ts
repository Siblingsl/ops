import { _electron, expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), '../../testdata/cx01-syntax-fixtures.json'), 'utf8')) as Array<{
  name: string
  markdown: string
  dom?: { headingTags?: string[]; strongParagraphs?: string[]; keptTags?: string[]; absentTags?: string[]; absentAttrs?: string[]; text?: string[] }
}>

test('真实 Electron marked DOM 遵循共享夹具并保留安全结构', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景只加载本地排版模块')
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx01-shared-fixtures-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/login`)
    const supported = fixtures.find(fixture => fixture.name === 'supported-and-converted')!
    const html = await page.evaluate(async ({ markdown }) => {
      const load = new Function('return import("/lib/render.ts")')
      const { renderWechat } = await load()
      return renderWechat([{ heading: '段落小标题', content_md: markdown }], 'ink')
    }, { markdown: supported.markdown })
    await page.evaluate((rendered) => { document.body.innerHTML = rendered }, html)

    expect(await page.locator('h2,h3').evaluateAll(nodes => nodes.map(node => node.tagName.toLowerCase()))).toEqual(supported.dom?.headingTags)
    for (const text of supported.dom?.strongParagraphs ?? []) await expect(page.locator('p > strong')).toContainText(text)
    for (const tag of supported.dom?.keptTags ?? []) await expect(page.locator(tag).first()).toBeVisible()
    for (const text of supported.dom?.text ?? []) await expect(page.locator('body')).toContainText(text)
    await expect(page.locator('dd')).toHaveCSS('color', 'rgb(18, 52, 86)')
    await expect(page.locator('input')).toHaveCount(0)

    const unsafe = fixtures.find(fixture => fixture.name === 'unsafe-and-fallback-html')!
    const unsafeHtml = await page.evaluate(async ({ markdown }) => {
      const load = new Function('return import("/lib/render.ts")')
      const { renderWechat } = await load()
      return renderWechat([{ heading: '', content_md: markdown }], 'ink')
    }, { markdown: unsafe.markdown })
    await page.evaluate((rendered) => { document.body.innerHTML = rendered }, unsafeHtml)
    const renderedRoot = page.locator('body > section')
    for (const tag of unsafe.dom?.absentTags ?? []) await expect(renderedRoot.locator(tag)).toHaveCount(0)
    for (const attr of unsafe.dom?.absentAttrs ?? []) await expect(renderedRoot.locator(`[${attr}]`)).toHaveCount(0)
    await expect(renderedRoot.locator('a[href^="javascript:"]')).toHaveCount(0)
    await expect(renderedRoot.locator('custom-card')).toHaveCount(0)
    for (const text of unsafe.dom?.text ?? []) await expect(renderedRoot).toContainText(text)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
