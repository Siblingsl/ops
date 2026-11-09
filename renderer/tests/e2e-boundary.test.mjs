// 桌面 renderer 的 E2E 边界守卫：用例目录只服务桌面形态，不得反向依赖 web/。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

// 本包位于仓库根 renderer/，一层 .. 即仓库根。
const root = resolve(import.meta.dirname, '..')
const e2eDir = join(root, 'e2e')

const FORBIDDEN = [
  { pattern: /\/web\/e2e/, name: '引用 web/e2e 路径' },
  { pattern: /\.\.\/(?:\.\.\/)*web\//, name: '相对路径穿越到 web/' },
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

// 桌面 runner 的 process.cwd() 是仓库根 renderer/，到仓库根只需一级 ..
// 沿用 Web 的 ../ 深度（两级）会越出仓库根，产物落到 F:\code\project\.playwright-results
// 这类仓库外路径，CI 收集不到，本地还会静默污染上层目录。
const WRONG_DEPTH = [
  { pattern: /['"`]\.\.\/\.\.(?:['"`]|\/)/, name: '相对路径上溯两级（已越出仓库根）' },
  { pattern: /resolve\(\s*process\.cwd\(\),\s*['"`]\.\.\/\.\./, name: '相对路径上溯两级（已越出仓库根）' },
]

test('桌面 e2e 产物路径按 renderer 深度解析，不得越出仓库根', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const rule of WRONG_DEPTH) {
      if (rule.pattern.test(text)) offenders.push(`${relative(root, file)}: ${rule.name}`)
    }
  }
  assert.deepEqual(offenders, [], `桌面 e2e 产物路径深度错误：\n${offenders.join('\n')}`)
})

// 本包上移到仓库根后，单级 .. 是仓库根，不再是 desktop/。
// 主进程构建产物与 Electron 都在 desktop/ 下，必须写 ../desktop/...；
// 写成 ../node_modules 或 ../.build 会指向仓库根不存在的路径，用例启动即失败。
const DESKTOP_DEPS = [
  { pattern: /['"`]\.\.\/node_modules\//, name: '桌面依赖缺少 desktop/ 前缀（实际指向仓库根）' },
  { pattern: /['"`]\.\.\/\.build\//, name: '桌面构建产物缺少 desktop/ 前缀（实际指向仓库根）' },
  { pattern: /['"`]\.\.\/\.workbuddy-ai\//, name: '桌面暂存目录缺少 desktop/ 前缀（实际指向仓库根）' },
]

test('桌面 e2e 对 desktop 级依赖使用 ../desktop/ 前缀', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const rule of DESKTOP_DEPS) {
      if (rule.pattern.test(text)) offenders.push(`${relative(root, file)}: ${rule.name}`)
    }
  }
  assert.deepEqual(offenders, [], `桌面 e2e 的 desktop 级依赖路径错误：\n${offenders.join('\n')}`)
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
    for (const match of text.matchAll(/'\.\.\/output\/([^']*)'/g)) {
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
