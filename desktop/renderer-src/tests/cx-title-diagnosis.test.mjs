import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

test('CX11 本地标题规则按 Unicode 码点与固定版本口径精确计分', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { scoreTitleRules } = await server.ssrLoadModule('/pages/work/editor-title-diagnosis.ts')
    const exact = scoreTitleRules('wechat_mp', '3天内看懂内容', ['内容'])
    assert.equal(exact.ruleScore, 50)
    assert.equal(exact.ruleMax, 60)
    assert.equal(exact.coverage, 'complete')
    assert.equal(exact.dimensions.keywords.score, 10)

    const afterEmoji = scoreTitleRules('wechat_mp', '😀内容', ['内容'])
    assert.equal(afterEmoji.dimensions.keywords.score, 10)

    const noPosition = scoreTitleRules('wechat_mp', '复盘写作方法', [])
    assert.equal(noPosition.dimensions.keywords.state, 'unavailable')
    assert.equal(noPosition.coverage, 'partial')
    assert.equal(noPosition.ruleMax, 50)

    for (const [length, expected] of [[20, 10], [21, 6], [30, 6], [31, 3]]) {
      assert.equal(scoreTitleRules('xhs', '甲'.repeat(length), ['甲']).dimensions.length.score, expected)
    }

    const adLaw = scoreTitleRules('wechat_mp', '最好用的运营方法!!!!!', ['运营'])
    assert.equal(adLaw.dimensions.cleanliness.score, 0)
    assert.ok(adLaw.ruleScore > 0)
  } finally { await server.close() }
})
