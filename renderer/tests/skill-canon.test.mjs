import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createServer } from 'vite'

// DEEP-04 / 6.3 批1：与 Go/Web 共用 testdata/skill-canon-vectors.json。
test('skill-canon 与 Go 共用规范向量', async () => {
  const vectors = JSON.parse(await readFile('../testdata/skill-canon-vectors.json', 'utf8'))
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
  })
  try {
    const { canonicalJSON, canonHash } = await server.ssrLoadModule('/lib/skill-canon.ts')
    for (const v of vectors) {
      const input = JSON.parse(v.input_json)
      if (v.reject) {
        assert.throws(() => canonicalJSON(input), /浮点数/, v.name)
        continue
      }
      if (v.same_hash) {
        const other = JSON.parse(v.input_json_b)
        assert.equal(await canonHash(input), await canonHash(other), v.name)
        continue
      }
      assert.equal(canonicalJSON(input), v.canonical, v.name)
      if (v.sha256) assert.equal(await canonHash(input), v.sha256, v.name)
    }
  } finally {
    await server.close()
  }
})
