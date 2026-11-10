import assert from 'node:assert/strict'
import { test } from 'node:test'

const { browserEvidenceNotice } = await import('../src/pages/agent/browser-evidence.ts')

// A11：Web 端浏览器证据降级展示的判定规则。
// 无证据 / 请求失败 / 非法计数都不渲染；有证据时文本必须如实标注"仅桌面可见"。

test('浏览器证据占位：无证据或请求失败时不渲染', () => {
  assert.equal(browserEvidenceNotice(null), null)
  assert.equal(browserEvidenceNotice(undefined), null)
  assert.equal(browserEvidenceNotice(0), null)
  assert.equal(browserEvidenceNotice(-3), null)
})

test('浏览器证据占位：非法计数不渲染（不伪造 0 条或小数条）', () => {
  assert.equal(browserEvidenceNotice(Number.NaN), null)
  assert.equal(browserEvidenceNotice(Number.POSITIVE_INFINITY), null)
  assert.equal(browserEvidenceNotice(1.5), null)
})

test('浏览器证据占位：有证据时显示条数并如实标注仅桌面可见', () => {
  const notice = browserEvidenceNotice(3)
  assert.ok(notice)
  assert.equal(notice.count, 3)
  assert.match(notice.text, /3 条/)
  assert.match(notice.text, /仅桌面端可查看/)
  assert.doesNotMatch(notice.text, /加载失败/)
})

test('浏览器证据占位：单条证据文案正确', () => {
  const notice = browserEvidenceNotice(1)
  assert.ok(notice)
  assert.match(notice.text, /1 条/)
})
