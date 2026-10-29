// Web 端 E2E 边界守卫：Web 套件里不允许出现桌面形态证据。
// 只读扫描，不依赖浏览器或后端，可随 `pnpm test:unit` 一起跑。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const e2eDir = join(root, 'e2e')

const FORBIDDEN = [
  { pattern: /_electron/, name: 'Electron 启动器' },
  { pattern: /Electron\/\d/, name: 'Electron UA 注入' },
  { pattern: /ops-creative-desktop/, name: '桌面呈现标记' },
  { pattern: /TestSkillDesktopDirectRoutes/, name: '桌面直达路由用例' },
  { pattern: /OPS_DESKTOP_DEV_URL/, name: '桌面开发地址' },
  { pattern: /127\.0\.0\.1:5287/, name: '桌面 renderer 端口' },
]

function files(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
}

// 注释里说明「本文件不做什么」是合法的，只对真实代码判定。
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('Web e2e 不包含桌面形态证据', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(text)) offenders.push(`${relative(root, file)}: ${rule.name}`)
    }
  }
  assert.deepEqual(offenders, [], `Web 套件出现桌面形态证据：\n${offenders.join('\n')}`)
})

test('Web e2e 指向桌面 renderer 私有目录时失败', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    if (/desktop\/renderer-src\/(src|e2e)/.test(text)) offenders.push(relative(root, file))
  }
  assert.deepEqual(offenders, [])
})

test('Web Playwright 配置不再维护桌面黑名单', () => {
  const config = stripComments(readFileSync(join(root, 'playwright.config.ts'), 'utf8'))
  assert.equal(/testIgnore/.test(config), false, 'Web 配置不应再用 testIgnore 排除桌面用例')
  assert.equal(/grepInvert:\s*\/Electron/.test(config), false, 'Web 配置不应再用 Electron 标题过滤')
})

// Web e2e 不在 tsconfig 范围内，导入失效符号不会被 typecheck 捕获，这里显式核对。
test('Web e2e 从 support 导入的符号必须真实导出', () => {
  const helper = stripComments(readFileSync(join(e2eDir, 'support.ts'), 'utf8'))
  const exported = new Set()
  for (const match of helper.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)) {
    exported.add(match[1])
  }
  const offenders = []
  for (const file of files(e2eDir)) {
    if (file.endsWith('support.ts')) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/support'/g)) {
      const names = match[1].split(',').map((item) => item.trim().split(/\s+as\s+/)[0]).filter(Boolean)
      for (const name of names) {
        if (!exported.has(name)) offenders.push(`${relative(root, file)}: ${name}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `Web e2e 导入了 support.ts 未导出的符号：\n${offenders.join('\n')}`)
})

// 产物目录按端分树，两端各写各的：仓库根 output/ 的根层文件属于 Web，output/playwright/ 属于桌面；
// .playwright-results/ 下 web（含 web-report）属于 Web，desktop-renderer* 属于桌面。
// 这条守卫保证 Web 用例不会因为某个帮手函数写成 ../output/playwright 而覆盖桌面截图。
const DESKTOP_ARTIFACT = [
  { pattern: /output\/playwright/, name: 'output/playwright 是桌面产物目录' },
  { pattern: /\.playwright-results\/(?:desktop-renderer|report)/, name: '.playwright-results 下的桌面目录' },
]

test('Web e2e 不写入桌面产物目录', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const rule of DESKTOP_ARTIFACT) {
      if (rule.pattern.test(text)) offenders.push(`${relative(root, file)}: ${rule.name}`)
    }
  }
  assert.deepEqual(offenders, [], `Web 用例写到了桌面产物目录：\n${offenders.join('\n')}`)
})

test('Web Playwright 产物只落在自己的子目录', () => {
  const config = stripComments(readFileSync(join(root, 'playwright.config.ts'), 'utf8'))
  assert.match(config, /outputDir:\s*'\.\.\/\.playwright-results\/web',/)
  assert.match(config, /outputFolder:\s*'\.\.\/\.playwright-results\/web-report'/)
})

// 桌面 testid 只允许出现在「应不存在」的反向断言里；用它定位并 toBeVisible 属于桌面行为。
const DESKTOP_TESTIDS = [
  'desktop-agent-workbench',
  'desktop-agent-side-panel',
  'desktop-editor-steps',
  'desktop-settings-window',
  'desktop-dialog-panel',
  'desktop-drawer-overlay',
]

test('Web e2e 不把桌面 testid 当作可操作元素', () => {
  const offenders = []
  for (const file of files(e2eDir)) {
    const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const testid of DESKTOP_TESTIDS) {
        if (!line.includes(testid)) continue
        // 允许的反向断言：应不存在 / 计数为 0
        if (/toHaveCount\(0\)|count\(\)\s*>\s*0\s*\?/.test(line)) continue
        offenders.push(`${relative(root, file)}:${index + 1}: ${testid}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `Web 用例把桌面元素当成可见目标：\n${offenders.join('\n')}`)
})
