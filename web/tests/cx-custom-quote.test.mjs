import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

test('自定义斜体引用的文字在白底上达到 4.5:1', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { customTheme } = await server.ssrLoadModule('/src/lib/render.ts')
    const { customThemeContrastError } = await server.ssrLoadModule('/src/lib/theme-contrast.ts')
    const theme = customTheme({ base: 'ink', primary_color: '#2F5D62', font_size: 16, line_height: 1.8, paragraph_gap: 18, heading_style: 'underline', quote_style: 'italic' })
    const color = theme.tags.blockquote.match(/(?:^|;)color:(#[\da-f]{3,6})(?:;|$)/i)?.[1]
    assert.ok(color, '引用文字应有明确颜色')
    const expanded = color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color
    assert.equal(customThemeContrastError(expanded), null)
  } finally { await server.close() }
})
