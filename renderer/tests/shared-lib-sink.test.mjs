import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function norm(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

test('6.3 批2：renderer types/format 只 re-export shared', () => {
  assert.equal(readFileSync(join(root, 'lib/types.ts'), 'utf8').trim(), "export * from '../../shared/types'")
  assert.equal(readFileSync(join(root, 'lib/format.ts'), 'utf8').trim(), "export * from '../../shared/format'")
})

test('6.3 批2：与 web 指向同一 shared 文件', () => {
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
})

test('6.3 批3：api.ts / render.ts 与 web 同口径', () => {
  assert.equal(norm(join(root, 'lib/api.ts')), norm(join(root, '../web/src/lib/api.ts')))
  assert.equal(norm(join(root, 'lib/render.ts')), norm(join(root, '../web/src/lib/render.ts')))
})
