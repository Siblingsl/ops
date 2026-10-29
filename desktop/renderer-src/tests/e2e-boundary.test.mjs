// 桌面 renderer 的 E2E 边界守卫：用例目录只服务桌面形态，不得反向依赖 web/。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const e2eDir = join(root, 'e2e')

const FORBIDDEN = [
  { pattern: /\/web\/e2e/, name: '引用 web/e2e 路径' },
  { pattern: /\.\.\/\.\.\/web\//, name: '相对路径穿越到 web/' },
  { pattern: /127\.0\.0\.1:5179/, name: 'Web dev 端口 5179' },
  { pattern: /127\.0\.0\.1:8180/, name: 'Web e2e API 端口 8180' },
  { pattern: /127\.0\.0\.1:8191/, name: 'Web mock 端口 8191' },
  { pattern: /OPS_E2E_MOCK_BASE_URL\s*=\s*'http:\/\/127\.0\.0\.1:8191/, name: 'Web mock 端口' },
]

function files(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => join(dir, name))
}

// 注释里说明「本目录不依赖什么」属于文档，不是依赖，判定前先剥离。
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('桌面 e2e 不依赖 web 目录或 Web 端口', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(text)) offenders.push(`${relative(root, file)}: ${rule.name}`)
    }
  }
  assert.deepEqual(offenders, [], `桌面 e2e 出现跨端依赖：\n${offenders.join('\n')}`)
})

test('桌面 Playwright 配置的 testDir 指向自身 e2e', () => {
  const config = stripComments(readFileSync(join(root, 'playwright.config.ts'), 'utf8'))
  assert.match(config, /testDir:\s*'\.\/e2e'/)
  assert.equal(/web\/e2e/.test(config), false, '桌面配置不应再指向 web/e2e')
})

// 桌面 runner 的 process.cwd() 是 desktop/renderer-src，仓库根要上两级。
// 沿用 Web 的 ../ 深度会把产物写到 desktop/ 下，CI 只收集仓库根 .playwright-results。
const WRONG_DEPTH = [
  { pattern: /['"`]\.\.\/\.playwright-results\//, name: '截图路径少上溯一级（实际写入 desktop/.playwright-results）' },
  { pattern: /['"`]\.\.\/output\//, name: 'output 路径少上溯一级（实际写入 desktop/output）' },
  { pattern: /['"`]\.\.\/tmpverify\//, name: 'tmpverify 路径少上溯一级' },
  { pattern: /resolve\(process\.cwd\(\), '\.\.\/output\//, name: 'output 路径少上溯一级' },
  { pattern: /resolve\('\.\.\/output\//, name: 'output 路径少上溯一级' },
]

test('桌面 e2e 产物路径按 renderer-src 深度解析', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const rule of WRONG_DEPTH) {
      if (rule.pattern.test(text)) offenders.push(`${relative(root, file)}: ${rule.name}`)
    }
  }
  assert.deepEqual(offenders, [], `桌面 e2e 产物路径深度错误：\n${offenders.join('\n')}`)
})

test('仓库根目录引用使用 ../../ 前缀', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    // 只允许 desktop 级依赖（node_modules / .build）停留在单级 ..
    for (const match of text.matchAll(/resolve\((?:process\.cwd\(\), )?'(\.\.\/[^']*)'/g)) {
      const target = match[1]
      if (/^\.\.\/(node_modules|\.build)\//.test(target)) continue
      if (target === '../..' || target.startsWith('../../')) continue
      offenders.push(`${relative(root, file)}: ${target}`)
    }
  }
  assert.deepEqual(offenders, [], `桌面 e2e 存在非 desktop 级的单级相对路径：\n${offenders.join('\n')}`)
})

test('桌面 e2e 目录保留完整用例集与独立辅助文件', () => {
  const specs = readdirSync(e2eDir).filter((name) => name.endsWith('.spec.ts'))
  assert.ok(specs.length >= 38, `桌面 e2e 用例文件不足，当前 ${specs.length} 个`)
  const helper = stripComments(readFileSync(join(e2eDir, 'support.ts'), 'utf8'))
  assert.match(helper, /from '\.\/support'|from '\.\/support\.ts'|export async function createOutline/, '桌面 e2e 必须有独立的 support.ts')
  assert.equal(/web\/e2e\/support/.test(helper), false)
})

// 产物目录按端分树：仓库根 output/ 的根层文件属于 Web，桌面只写 output/ 下的子树
// （目前是 output/playwright/）。这样两端同时跑也不会互相覆盖截图。
test('桌面 e2e 只写 output/ 下自己的子树', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(/'\.\.\/\.\.\/output\/([^']*)'/g)) {
      const rest = match[1]
      if (rest === '' || !rest.includes('/')) {
        offenders.push(`${relative(root, file)}: output/${rest} 落在 Web 的根层`)
      }
    }
  }
  assert.deepEqual(offenders, [], `桌面 e2e 写到了 Web 的 output 根层：\n${offenders.join('\n')}`)
})

test('桌面 e2e 不写入 Web 的报告目录', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    if (/\.playwright-results\/(?:web|web-report|report)\b/.test(text)) offenders.push(relative(root, file))
  }
  assert.deepEqual(offenders, [], `桌面 e2e 写到 Web 的 .playwright-results 目录：\n${offenders.join('\n')}`)
})
