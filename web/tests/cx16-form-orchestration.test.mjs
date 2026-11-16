import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('CF-CX-16：双端编排入口禁止「生成全部形态」并区分产物/派生', () => {
  for (const rel of [
    'web/src/pages/work/FormOrchestration.tsx',
    'renderer/pages/work/FormOrchestration.tsx',
  ]) {
    const src = readFileSync(join(root, rel), 'utf8')
    assert.match(src, /本作品组图产物/)
    assert.match(src, /跨平台派生独立稿/)
    assert.match(src, /form-orch-cards/)
    assert.match(src, /form-orch-derive/)
    // 文案可写「多种形态」，但不得出现批量一次生成的入口措辞。
    for (const banned of ['生成全部', '一键生成全部', 'generate all', '批量派生', '全部派生']) {
      assert.ok(!src.includes(banned), `${rel} 不得包含 ${banned}`)
    }
    assert.match(src, /不会一次生成多种形态/)
  }
  const webLayout = readFileSync(join(root, 'web/src/pages/work/WorkLayout.tsx'), 'utf8')
  const deskLayout = readFileSync(join(root, 'renderer/pages/work/WorkLayout.tsx'), 'utf8')
  assert.match(webLayout, /FormOrchestrationDialog/)
  assert.match(deskLayout, /FormOrchestrationDialog/)
  assert.match(webLayout, /work-forms/)
  assert.match(deskLayout, /work-forms/)
})
