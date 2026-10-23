import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allowedStyleProps,
  allowedTags,
  fallbackStyles,
  mergeStyle,
  normalizeBodyHeadings,
  parseStyle,
  stripMarkdownPlaceholders,
} from '../src/lib/render-policy.ts'

// ED-07：渲染链路此前零单元测试。这里覆盖渲染策略里不依赖 DOM 的部分，
// 每条用例对应 docs/22 的一个动线条目，改坏时能直接指出是哪个条目回归。

test('ED-08 预览白名单覆盖服务端推送白名单里的表格/代码块/多级标题', () => {
  // 服务端 publish.go 用的是 bluemonday UGCPolicy，以下标签预览不能再降级成纯文本。
  for (const tag of ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'h1', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'ins', 'strike']) {
    assert.ok(allowedTags.has(tag), `白名单缺少 ${tag}，预览会与推送不一致（ED-08）`)
  }
  // 危险标签必须始终不在白名单里。
  for (const tag of ['script', 'style', 'iframe', 'object']) {
    assert.ok(!allowedTags.has(tag), `${tag} 不允许进入白名单`)
  }
})

test('ED-06 表格与代码块有基础样式，不再是无分隔纯文本', () => {
  assert.match(fallbackStyles.table, /border-collapse:collapse/)
  assert.match(fallbackStyles.th, /border:1px solid/)
  assert.match(fallbackStyles.td, /border:1px solid/)
  assert.match(fallbackStyles.pre, /font-family|background-color/)
  assert.match(fallbackStyles.code, /font-family/)
  // 基础样式里的属性必须都在服务端放行清单内，否则推送会被 bluemonday 洗掉。
  for (const [tag, style] of Object.entries(fallbackStyles)) {
    for (const [prop] of parseStyle(style)) {
      assert.ok(allowedStyleProps.has(prop), `${tag} 的样式属性 ${prop} 服务端不放行，推送会丢（ED-08）`)
    }
  }
})

test('PB-15 作者内联样式只覆盖同名属性，主题其余样式保留', () => {
  const themeStyle = 'margin:0 0 18px;font-size:16px;color:#333;line-height:1.8;'
  const merged = mergeStyle(themeStyle, 'color:#c00')
  const map = new Map(parseStyle(merged))
  assert.equal(map.get('color'), '#c00', '作者颜色应覆盖主题颜色')
  assert.equal(map.get('font-size'), '16px', '作者没写的字号要保留主题值')
  assert.equal(map.get('line-height'), '1.8', '作者没写的行距要保留主题值')
  assert.equal(map.get('margin'), '0 0 18px', '作者没写的段间距要保留主题值')
})

test('PB-15 无内联样式时原样返回主题样式，空值不产生多余分号', () => {
  assert.equal(mergeStyle('margin:0 0 18px;', null), 'margin:0 0 18px;')
  assert.equal(mergeStyle('', null), '')
  assert.equal(mergeStyle('', 'color:#c00'), 'color:#c00;')
})

test('ED-08 服务端不认的内联样式属性会被丢弃，避免预览与推送不一致', () => {
  const merged = mergeStyle('margin:0 0 18px;', 'position:fixed;color:#c00;z-index:9;')
  const props = parseStyle(merged).map(([key]) => key)
  assert.ok(!props.includes('position'), 'position 服务端不放行，预览也不应保留')
  assert.ok(!props.includes('z-index'), 'z-index 服务端不放行，预览也不应保留')
  assert.ok(props.includes('color'))
  assert.ok(props.includes('margin'))
})

test('ED-12 正文标题降级：h1/h2 变 h3，h4+ 变加粗段落', () => {
  assert.equal(normalizeBodyHeadings('<h1>一级</h1><h2>二级</h2>'), '<h3>一级</h3><h3>二级</h3>')
  assert.equal(normalizeBodyHeadings('<h4>四级</h4>'), '<p><strong>四级</strong></p>')
  assert.equal(normalizeBodyHeadings('<h6>六级</h6>'), '<p><strong>六级</strong></p>')
  // 段落小标题（section.heading）由渲染层单独输出为 h2，不经过这个函数。
  assert.equal(normalizeBodyHeadings('<h3>小标题</h3>'), '<h3>小标题</h3>')
})

test('ED-10 往返保真：分隔线与代码块不被标题归一化改写', () => {
  const body = '<hr><pre><code>const a = 1</code></pre><p>正文</p>'
  assert.equal(normalizeBodyHeadings(body), body)
})

test('ED-11 [markdownHTMLNode] 占位符不会漏进成稿', () => {
  assert.equal(stripMarkdownPlaceholders('<p>前</p>[markdownHTMLNode]<p>后</p>'), '<p>前</p><p>后</p>')
  assert.equal(stripMarkdownPlaceholders('纯文本'), '纯文本')
})
