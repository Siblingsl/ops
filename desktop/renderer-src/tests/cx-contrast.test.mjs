import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

test('自定义主题对比度按原始值校验并拒绝非法颜色', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { customThemeContrastError } = await server.ssrLoadModule('/lib/theme-contrast.ts')
    assert.equal(customThemeContrastError('#2F5D62'), null)
    assert.ok(customThemeContrastError('#999999'))
    assert.ok(customThemeContrastError('#777777'))
    assert.equal(customThemeContrastError('#767676'), null)
    assert.ok(customThemeContrastError('#fff'))
    assert.ok(customThemeContrastError('red; background:url(x)'))
    assert.equal(customThemeContrastError('#000000'), null)
  } finally { await server.close() }
})
