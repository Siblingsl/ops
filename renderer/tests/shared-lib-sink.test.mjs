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

test('6.3 批2：与 web 指向同一 shared 文件', () => {
  const sharedTypes = readFileSync(join(root, '../shared/types.ts'), 'utf8')
  const sharedFormat = readFileSync(join(root, '../shared/format.ts'), 'utf8')
  assert.ok(sharedTypes.includes('export type Platform'))
  assert.ok(sharedFormat.includes('export function runeLen'))
})
