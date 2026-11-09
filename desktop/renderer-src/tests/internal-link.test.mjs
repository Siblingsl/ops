// docs/28 §2.2：桌面端独立维护同一契约（AGENTS.md：两端各自实现）。
// 模型输出的链接可以控制 href，站内跳转必须挡住 CVE-2026-53669 的反斜杠绕过。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isInternalPath } from '../src/lib/internal-link.ts'

const allow = [
  '/',
  '/agent',
  '/agent?panel=task&item=abc',
  '/works/123#section-2',
  '/settings/admin',
]

const block = [
  ['空串', ''],
  ['相对路径', 'agent'],
  ['绝对 http', 'http://example.com/agent'],
  ['绝对 https', 'https://example.com/agent'],
  ['javascript 协议', 'javascript:alert(1)'],
  ['data 协议', 'data:text/html,<script>alert(1)</script>'],
  ['协议相对', '//evil.com'],
  ['三斜杠', '///evil.com'],
  ['纯反斜杠', '\\\\evil.com'],
  ['斜杠+反斜杠', '/\\evil.com'],
  ['双反斜杠', '/\\\\evil.com'],
  ['编码反斜杠', '/%5Cevil.com'],
  ['小写编码反斜杠', '/%5cevil.com'],
  ['编码双斜杠', '/%2F%2Fevil.com'],
  ['前导空格', ' /agent'],
  ['尾随空格', '/agent '],
  ['NUL 注入', '/ag\u0000ent'],
  ['换行注入', '/agent\n'],
  ['超长', '/' + 'a'.repeat(2048)],
]

test('站点内部路径放行', () => {
  for (const href of allow) {
    assert.equal(isInternalPath(href), true, `应放行：${JSON.stringify(href)}`)
  }
})

test('站外跳转与绕过一律拒绝', () => {
  for (const [label, href] of block) {
    assert.equal(isInternalPath(href), false, `应拒绝（${label}）：${JSON.stringify(href)}`)
  }
})

test('组件确实使用该判定（防止只有函数没接线）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/lib/agent-markdown.tsx', import.meta.url)), 'utf8')
  assert.match(src, /import \{ isInternalPath \} from '\.\/internal-link'/, '应导入 isInternalPath')
  assert.match(src, /isInternalPath\(value\)/, 'safeHref 应使用白名单判定')
  assert.match(src, /isInternalPath\(href\)/, '点击拦截应使用白名单判定')
  assert.ok(!/href\.startsWith\('\/\/'\)/.test(src), '不应回退到只挡 "//" 的旧写法')
})
