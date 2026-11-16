import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function norm(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

test('6.3 批2：web types/format 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'web/src/lib/types.ts'), 'utf8').trim(), "export * from '../../../shared/types'")
  assert.equal(readFileSync(join(root, 'web/src/lib/format.ts'), 'utf8').trim(), "export * from '../../../shared/format'")
})

test('6.3 批2：shared/types 含 AgentWorkbenchFeatureName 且先于 SystemSettings', () => {
  const src = readFileSync(join(root, 'shared/types.ts'), 'utf8')
  const iFeat = src.indexOf('export type AgentWorkbenchFeatureName')
  const iSys = src.indexOf('export interface SystemSettings')
  assert.ok(iFeat >= 0 && iSys >= 0 && iFeat < iSys)
  assert.match(src, /agent_features\?:\s*Partial<Record<AgentWorkbenchFeatureName,\s*boolean>>/)
})

test('6.3 批2：shared/format 导出 runeLen/fmtTime', async () => {
  const mod = await import(pathToFileURL(join(root, 'shared/format.ts')).href)
  assert.equal(mod.runeLen('你好'), 2)
  assert.equal(typeof mod.fmtTime, 'function')
})

test('6.3 批3：web 纯模块只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'web/src/lib/api-base.ts'), 'utf8').trim(), "export * from '../../../shared/api-base'")
  assert.equal(readFileSync(join(root, 'web/src/lib/api-retry.ts'), 'utf8').trim(), "export * from '../../../shared/api-retry'")
  assert.equal(readFileSync(join(root, 'web/src/lib/render-policy.ts'), 'utf8').trim(), "export * from '../../../shared/render-policy'")
  assert.equal(readFileSync(join(root, 'web/src/lib/custom-theme-state.ts'), 'utf8').trim(), "export * from '../../../shared/custom-theme-state'")
  assert.equal(readFileSync(join(root, 'web/src/lib/page-poll.ts'), 'utf8').trim(), "export * from '../../../shared/page-poll'")
})

test('6.3 批3：web api/render 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'web/src/lib/api.ts'), 'utf8').trim(), "export * from '../../../shared/api'")
  assert.equal(readFileSync(join(root, 'web/src/lib/render.ts'), 'utf8').trim(), "export * from '../../../shared/render'")
})

test('6.3：web skill-canon 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'web/src/lib/skill-canon.ts'), 'utf8').trim(), "export * from '../../../shared/skill-canon'")
  assert.match(readFileSync(join(root, 'shared/skill-canon.ts'), 'utf8'), /export function canonicalJSON/)
})

test('6.3 批4：web 纯 lib 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'web/src/lib/platform-errors.ts'), 'utf8').trim(), "export * from '../../../shared/platform-errors'")
  assert.equal(readFileSync(join(root, 'web/src/lib/zip.ts'), 'utf8').trim(), "export * from '../../../shared/zip'")
  assert.equal(readFileSync(join(root, 'web/src/lib/skills.ts'), 'utf8').trim(), "export * from '../../../shared/skills'")
  assert.equal(readFileSync(join(root, 'web/src/lib/cover-build.ts'), 'utf8').trim(), "export * from '../../../shared/cover-build'")
  assert.equal(readFileSync(join(root, 'web/src/lib/agent-events.ts'), 'utf8').trim(), "export * from '../../../shared/agent-events'")
  assert.match(readFileSync(join(root, 'shared/cover-build.ts'), 'utf8'), /from '\.\/types'/)
  assert.match(readFileSync(join(root, 'shared/skills.ts'), 'utf8'), /from '\.\/skill-canon'/)
  assert.match(readFileSync(join(root, 'shared/agent-events.ts'), 'utf8'), /from '\.\/api'/)
})

test('6.3 批5：web 无依赖纯 lib 只 re-export shared', () => {
  for (const name of ['canonical-json', 'cx-render-contract', 'keyboard', 'legacy-article', 'local-draft', 'recent', 'theme-contrast']) {
    assert.equal(readFileSync(join(root, `web/src/lib/${name}.ts`), 'utf8').trim(), `export * from '../../../shared/${name}'`)
    assert.doesNotMatch(readFileSync(join(root, `shared/${name}.ts`), 'utf8'), /^import /m)
  }
})

test('6.3 批6：web ai-error/undo 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'web/src/lib/ai-error.ts'), 'utf8').trim(), "export * from '../../../shared/ai-error'")
  assert.equal(readFileSync(join(root, 'web/src/lib/undo.ts'), 'utf8').trim(), "export * from '../../../shared/undo'")
  assert.match(readFileSync(join(root, 'shared/ai-error.ts'), 'utf8'), /from 'sonner'/)
  assert.match(readFileSync(join(root, 'shared/ai-error.ts'), 'utf8'), /from '\.\/api'/)
  assert.match(readFileSync(join(root, 'shared/undo.ts'), 'utf8'), /from 'sonner'/)
  assert.match(readFileSync(join(root, 'shared/undo.ts'), 'utf8'), /from '\.\/api'/)
})

test('6.3 批3：shared/api 与 shared/render 含 sonner/marked 入口', () => {
  assert.match(readFileSync(join(root, 'shared/api.ts'), 'utf8'), /from 'sonner'/)
  assert.match(readFileSync(join(root, 'shared/render.ts'), 'utf8'), /from 'marked'/)
})

test('6.3 批3：ui.tsx 仅允许桌面 embedded 设置差异（故意不下沉）', () => {
  const web = norm(join(root, 'web/src/components/ui.tsx'))
  const desk = norm(join(root, 'renderer/components/ui.tsx'))
  assert.notEqual(web, desk)
  assert.match(desk, /useEmbeddedSettings/)
  assert.match(desk, /desktop-settings/)
  assert.doesNotMatch(web, /useEmbeddedSettings/)
  assert.doesNotMatch(web, /desktop-settings/)
})
