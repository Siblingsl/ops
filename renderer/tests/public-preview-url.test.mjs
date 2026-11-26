// D8：打包桌面端渲染在 ops-desktop://business 下，公开预览的二维码与分享链接
// 必须指向构建期注入的真实 API 域名，不能把自定义协议 origin 当成可扫码地址。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(rendererRoot, '..')
const compiled = ts.transpileModule(readFileSync(join(repoRoot, 'shared/api-base.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

/** 按给定构建期基址与页面 origin 重新求值 api-base（RAW_BASE 在模块顶层只求值一次）。 */
function loadApiBase({ apiBase = '', origin } = {}) {
  const sandbox = { exports: {}, module: { exports: {} } }
  sandbox.__OPS_API_BASE__ = apiBase
  if (origin !== undefined) sandbox.window = { location: { origin } }
  vm.runInNewContext(compiled, sandbox)
  assert.equal(typeof sandbox.exports.publicPreviewUrl, 'function', 'shared/api-base 未导出 publicPreviewUrl')
  return sandbox.exports
}

test('D8：桌面打包端公开预览使用构建期 API 域名（去掉结尾斜杠）', () => {
  const m = loadApiBase({ apiBase: 'https://ops-api.88813888.xyz/', origin: 'ops-desktop://business' })
  assert.equal(m.publicPreviewUrl('tok123'), 'https://ops-api.88813888.xyz/preview/tok123')
})

test('D8：同源开发态（apiBase 为空）回退 window.location.origin', () => {
  const m = loadApiBase({ apiBase: '', origin: 'http://localhost:5173' })
  assert.equal(m.publicPreviewUrl('tok123'), 'http://localhost:5173/preview/tok123')
})

/** 注释里说明历史拼接不算依赖，静态检查前先剥离。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('D8：Preview/ToutiaoPack 不再直接用 window.location.origin 拼 /preview/', () => {
  for (const rel of ['pages/work/Preview.tsx', 'pages/work/ToutiaoPack.tsx']) {
    const src = stripComments(readFileSync(join(rendererRoot, rel), 'utf8'))
    assert.match(src, /import \{[^}]*publicPreviewUrl[^}]*\} from '@\/lib\/api-base'/, `${rel} 未从 @/lib/api-base 引入 publicPreviewUrl`)
    assert.match(src, /publicPreviewUrl\(/, `${rel} 未调用 publicPreviewUrl`)
    assert.doesNotMatch(src, /window\.location\.origin/, `${rel} 仍直接使用 window.location.origin`)
    assert.doesNotMatch(src, /origin\}\/preview\//, `${rel} 仍手工拼接 /preview/ 地址`)
  }
})
