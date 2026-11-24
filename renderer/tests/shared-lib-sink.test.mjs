import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('6.3 批2：renderer types/format 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/types.ts'), 'utf8').trim(), "export * from '../../shared/types'")
  assert.equal(readFileSync(join(root, 'lib/format.ts'), 'utf8').trim(), "export * from '../../shared/format'")
})

test('6.3 批2：shared 核心类型与格式工具契约', () => {
  const sharedTypes = readFileSync(join(root, '../shared/types.ts'), 'utf8')
  const sharedFormat = readFileSync(join(root, '../shared/format.ts'), 'utf8')
  assert.ok(sharedTypes.includes('export type Platform'))
  assert.ok(sharedFormat.includes('export function runeLen'))
})

test('6.3 批3：renderer 纯模块只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/api-base.ts'), 'utf8').trim(), "export * from '../../shared/api-base'")
  assert.equal(readFileSync(join(root, 'lib/api-retry.ts'), 'utf8').trim(), "export * from '../../shared/api-retry'")
  assert.equal(readFileSync(join(root, 'lib/render-policy.ts'), 'utf8').trim(), "export * from '../../shared/render-policy'")
  assert.equal(readFileSync(join(root, 'lib/custom-theme-state.ts'), 'utf8').trim(), "export * from '../../shared/custom-theme-state'")
  assert.equal(readFileSync(join(root, 'lib/page-poll.ts'), 'utf8').trim(), "export * from '../../shared/page-poll'")
})

test('6.3 批3：renderer api/render 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/api.ts'), 'utf8').trim(), "export * from '../../shared/api'")
  assert.equal(readFileSync(join(root, 'lib/render.ts'), 'utf8').trim(), "export * from '../../shared/render'")
})

test('6.3：renderer skill-canon 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/skill-canon.ts'), 'utf8').trim(), "export * from '../../shared/skill-canon'")
  assert.match(readFileSync(join(root, '../shared/skill-canon.ts'), 'utf8'), /export function canonicalJSON/)
})

test('6.3 批4：renderer 纯 lib 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/platform-errors.ts'), 'utf8').trim(), "export * from '../../shared/platform-errors'")
  assert.equal(readFileSync(join(root, 'lib/zip.ts'), 'utf8').trim(), "export * from '../../shared/zip'")
  assert.equal(readFileSync(join(root, 'lib/skills.ts'), 'utf8').trim(), "export * from '../../shared/skills'")
  assert.equal(readFileSync(join(root, 'lib/cover-build.ts'), 'utf8').trim(), "export * from '../../shared/cover-build'")
  assert.equal(readFileSync(join(root, 'lib/agent-events.ts'), 'utf8').trim(), "export * from '../../shared/agent-events'")
  assert.match(readFileSync(join(root, '../shared/cover-build.ts'), 'utf8'), /from '\.\/types'/)
  assert.match(readFileSync(join(root, '../shared/skills.ts'), 'utf8'), /from '\.\/skill-canon'/)
  assert.match(readFileSync(join(root, '../shared/agent-events.ts'), 'utf8'), /from '\.\/api'/)
})

test('6.3 批5：renderer 无依赖纯 lib 只 re-export shared', () => {
  for (const name of ['canonical-json', 'cx-render-contract', 'keyboard', 'legacy-article', 'local-draft', 'recent', 'theme-contrast']) {
    assert.equal(readFileSync(join(root, `lib/${name}.ts`), 'utf8').trim(), `export * from '../../shared/${name}'`)
    assert.doesNotMatch(readFileSync(join(root, `../shared/${name}.ts`), 'utf8'), /^import /m)
  }
})

test('6.3 批6：renderer ai-error/undo 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/ai-error.ts'), 'utf8').trim(), "export * from '../../shared/ai-error'")
  assert.equal(readFileSync(join(root, 'lib/undo.ts'), 'utf8').trim(), "export * from '../../shared/undo'")
  assert.match(readFileSync(join(root, '../shared/ai-error.ts'), 'utf8'), /from 'sonner'/)
  assert.match(readFileSync(join(root, '../shared/ai-error.ts'), 'utf8'), /from '\.\/api'/)
  assert.match(readFileSync(join(root, '../shared/undo.ts'), 'utf8'), /from 'sonner'/)
  assert.match(readFileSync(join(root, '../shared/undo.ts'), 'utf8'), /from '\.\/api'/)
})

test('6.3 批3：renderer ui.tsx 保留桌面 embedded 设置差异（故意不下沉）', () => {
  const desk = readFileSync(join(root, 'components/ui.tsx'), 'utf8')
  assert.match(desk, /useEmbeddedSettings/)
  assert.match(desk, /desktop-settings/)
})
