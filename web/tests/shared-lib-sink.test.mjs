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
})

test('6.3 批3：api.ts / render.ts 双端同口径（归一化行尾）', () => {
  assert.equal(norm(join(root, 'web/src/lib/api.ts')), norm(join(root, 'renderer/lib/api.ts')))
  assert.equal(norm(join(root, 'web/src/lib/render.ts')), norm(join(root, 'renderer/lib/render.ts')))
})

test('6.3 批3：ui.tsx 仅允许桌面 embedded 设置差异', () => {
  const web = norm(join(root, 'web/src/components/ui.tsx'))
  const desk = norm(join(root, 'renderer/components/ui.tsx'))
  assert.notEqual(web, desk)
  assert.match(desk, /useEmbeddedSettings/)
  assert.match(desk, /desktop-settings/)
  assert.doesNotMatch(web, /useEmbeddedSettings/)
  assert.doesNotMatch(web, /desktop-settings/)
})
