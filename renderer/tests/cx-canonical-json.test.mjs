import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createServer } from 'vite'

test('CX02 规范 JSON 与 Go 共用附录 E 向量', async () => {
  const vectors = JSON.parse(await readFile('../testdata/cx02-canonical-vectors.json', 'utf8'))
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { canonicalJSON } = await server.ssrLoadModule('/lib/canonical-json.ts')
    for (const vector of vectors) {
      const canonical = canonicalJSON(JSON.parse(vector.input_json))
      assert.equal(canonical, vector.canonical, vector.name)
      if (vector.sha256) assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), vector.sha256, vector.name)
    }
    const escapedControls = String.raw`{"s":"\b\f\n\n\t\u0000\u001f/<>` + '\u2028\u2029' + `"}`
    assert.equal(canonicalJSON({ s: '\b\f\n\r\t\x00\x1f/<>\u2028\u2029' }), escapedControls)
    assert.notEqual(canonicalJSON({ cover: null }), canonicalJSON({}))
    assert.throws(() => canonicalJSON({ 'a\r': 1, 'a\n': 2 }), /冲突/)
    assert.throws(() => canonicalJSON({ ratio: 0.8 }), /小数/)
    assert.throws(() => canonicalJSON({ field: undefined }), /undefined/)
  } finally { await server.close() }
})
