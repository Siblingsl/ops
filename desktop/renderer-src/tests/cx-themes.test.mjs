import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

test('CX07 八套内置主题保持历史 ID，所有主题文字对比度达到 4.5:1', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { themes, themeById } = await server.ssrLoadModule('/lib/render.ts')
    const ids = ['simple', 'ink', 'tenghuang', 'mobai', 'olive', 'sage', 'redwhite', 'graphite']
    assert.deepEqual(themes.map(theme => theme.id), ids)
    for (const id of ids) assert.equal(themeById(id).id, id)
    const property = (style, name) => new Map(style.split(';').map(part => part.split(':').map(value => value.trim()))).get(name)
    const normalizeColor = color => {
      if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color ?? '')) return null
      return color.length === 4 ? `#${[...color.slice(1)].map(channel => channel + channel).join('')}` : color.toLowerCase()
    }
    const luminance = color => {
      const channels = color.match(/[\da-f]{2}/gi).map(x => parseInt(x, 16) / 255)
      return channels.map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
        .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0)
    }
    const contrast = (first, second) => {
      const l1 = luminance(first)
      const l2 = luminance(second)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    for (const theme of themes) {
      const rootColor = normalizeColor(property(theme.root, 'color') ?? '#333333')
      const rootBackground = normalizeColor(property(theme.root, 'background-color') ?? '#ffffff')
      const textStyles = [
        ['正文', theme.root, rootBackground],
        ['段落标题', theme.sectionHeading, rootBackground],
        ['正文标题', theme.tags.h3 ?? '', rootBackground],
        ['段落', theme.tags.p ?? '', rootBackground],
        ['强调', theme.tags.strong ?? '', rootBackground],
        ['斜体', theme.tags.em ?? '', rootBackground],
        ['链接', theme.tags.a ?? '', rootBackground],
      ]
      const quoteStyle = theme.tags.blockquote ?? ''
      textStyles.push(['引用', quoteStyle, normalizeColor(property(quoteStyle, 'background-color') ?? rootBackground)])
      for (const [label, style, background] of textStyles) {
        const color = normalizeColor(property(style, 'color') ?? rootColor)
        assert.ok(color, `${theme.id} ${label} 的文字颜色无法验证`)
        assert.ok(background, `${theme.id} ${label} 的背景无法验证`)
        assert.ok(contrast(color, background) >= 4.5, `${theme.id} ${label}: ${color} / ${background} 对比度不足`)
      }
    }
  } finally {
    await server.close()
  }
})
