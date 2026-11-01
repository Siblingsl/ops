import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createServer } from 'vite'

test('公众号 renderer contract 与八套内置主题 token 摘要匹配共享登记', async () => {
  const fixture = JSON.parse(await readFile('../testdata/cx02-render-contract.json', 'utf8'))
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { themes } = await server.ssrLoadModule('/src/lib/render.ts')
    const { canonicalJSON } = await server.ssrLoadModule('/src/lib/canonical-json.ts')
    const { builtinThemeResources, wechatHTMLRendererContractVersion } = await server.ssrLoadModule('/src/lib/cx-render-contract.ts')
    assert.equal(wechatHTMLRendererContractVersion, fixture.renderer_contract_version)
    assert.deepEqual(Object.keys(builtinThemeResources).sort(), fixture.themes.map((theme) => theme.id).sort())
    assert.deepEqual(themes.map((theme) => theme.id).sort(), fixture.themes.map((theme) => theme.id).sort())
    for (const theme of themes) {
      const expected = fixture.themes.find((item) => item.id === theme.id)
      const digest = createHash('sha256').update(canonicalJSON({ root: theme.root, tags: theme.tags, sectionHeading: theme.sectionHeading }), 'utf8').digest('hex')
      assert.equal(builtinThemeResources[theme.id].version, expected.version, theme.id)
      assert.equal(builtinThemeResources[theme.id].token_digest, expected.token_digest, theme.id)
      assert.equal(digest, expected.token_digest, theme.id)
    }
  } finally { await server.close() }
})
