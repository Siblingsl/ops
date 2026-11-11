import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

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
