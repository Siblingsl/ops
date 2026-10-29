// 两端 E2E 同名用例守卫。
//
// Web（web/e2e）与桌面（desktop/renderer-src/e2e）是两套独立套件，但有 14 个同名 spec：
// 它们覆盖同一段业务旅程，只是分别在浏览器形态与桌面工作台形态下验收，因此**必须各写一份**，
// 不能共用文件、也不能靠复制粘贴冒充"两端都测过"。
//
// 这个脚本由 CI 执行（不挂在任何一端的 test:unit 上——它需要同时看到两端目录，
// 挂到其中一端会把跨端读取写成常态依赖）：
//   1. 同名清单必须与下面的 ALLOWLIST 完全一致：新增同名文件要显式来登记；
//   2. 每一对内容必须有实质差异（至少 15 行不同），挡住"直接把一端拷到另一端"；
//   3. 任何一端都不许 import 另一端的 support/辅助文件。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_E2E = join(repoRoot, 'web', 'e2e')
const DESKTOP_E2E = join(repoRoot, 'desktop', 'renderer-src', 'e2e')
const MIN_DIFF_LINES = 15

// 同名不是疏漏，是"同一旅程两种形态"的显式登记。加新条目请同时写清为什么必须同名。
const ALLOWLIST = new Map([
  ['agent-documents.spec.ts', '文档上传与解析：浏览器 vs 桌面工作台'],
  ['agent-events.spec.ts', '运行事件恢复：浏览器 SSE vs 桌面 event_resume'],
  ['agent-goals.spec.ts', '任务目标：浏览器 vs 桌面工作台'],
  ['agent-modes.spec.ts', '对话模式：浏览器 vs 桌面工作台'],
  ['agent-plans-questions.spec.ts', '计划与澄清问题：浏览器 vs 真实 Electron'],
  ['agent-routines.spec.ts', '例行任务：浏览器 vs 桌面工作台'],
  ['agent-workbench-aw08.spec.ts', 'AW08 工作台布局：浏览器 vs 桌面 presentation'],
  ['agent-workbench-aw12-layout.spec.ts', 'AW12 窄窗布局：浏览器 vs 桌面 presentation'],
  ['agent-workbench.spec.ts', '工作台主链路：浏览器 vs 真实 Electron'],
  ['d122-ui-layout.spec.ts', 'D122 界面骨架：浏览器 vs 桌面 presentation'],
  ['d123-ui-alignment.spec.ts', 'D123 对齐：浏览器 vs 桌面 presentation'],
  ['skills-boundaries.spec.ts', '技能边界：浏览器有编辑弹窗，桌面只有浏览器入口'],
  ['toutiao-completion.spec.ts', '头条完成度：浏览器 vs 桌面内嵌步骤流'],
  ['toutiao-ui.spec.ts', '头条编辑器：浏览器 vs 桌面 presentation'],
])

function specNames(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.spec.ts')).sort()
}

function diffLines(a, b) {
  const left = readFileSync(a, 'utf8').split('\n')
  const right = readFileSync(b, 'utf8').split('\n')
  // 简单的 LCS 太慢也没必要：用行集合差 + 顺序敏感的长度差做下界估计即可，
  // 目的只是挡住"整文件复制"，不是精确 diff 统计。
  const rightSet = new Map()
  for (const line of right) rightSet.set(line, (rightSet.get(line) ?? 0) + 1)
  let unmatchedLeft = 0
  for (const line of left) {
    const count = rightSet.get(line) ?? 0
    if (count > 0) rightSet.set(line, count - 1)
    else unmatchedLeft += 1
  }
  let unmatchedRight = 0
  for (const count of rightSet.values()) unmatchedRight += count
  return unmatchedLeft + unmatchedRight
}

const failures = []

for (const dir of [WEB_E2E, DESKTOP_E2E]) {
  if (!existsSync(dir)) failures.push(`缺少用例目录：${dir}`)
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}

const webSpecs = specNames(WEB_E2E)
const desktopSpecs = specNames(DESKTOP_E2E)
const desktopSet = new Set(desktopSpecs)
const shared = webSpecs.filter((name) => desktopSet.has(name))

const unregistered = shared.filter((name) => !ALLOWLIST.has(name))
const missing = [...ALLOWLIST.keys()].filter((name) => !shared.includes(name))
if (unregistered.length) {
  failures.push(`新增了未登记的同名 spec：${unregistered.join('、')}\n`
    + '  两端同名意味着"同一旅程要各写一份"。确认确实需要同名后，把条目加进 scripts/check-e2e-pairs.mjs 的 ALLOWLIST；'
    + '如果只是把一端复制过来，请改名或删除。')
}
if (missing.length) {
  failures.push(`ALLOWLIST 登记了但实际不同名：${missing.join('、')}\n  一端已改名或删除时，请同步更新 ALLOWLIST。`)
}

for (const name of shared) {
  if (!ALLOWLIST.has(name)) continue
  const diff = diffLines(join(WEB_E2E, name), join(DESKTOP_E2E, name))
  if (diff < MIN_DIFF_LINES) {
    failures.push(`${name} 两端差异仅 ${diff} 行（下限 ${MIN_DIFF_LINES}）：\n`
      + '  同名用例必须各自适配所在端，疑似直接把一端文件复制到另一端。')
  }
}

// 跨端 import：两端都不许把对方的辅助文件当依赖。
const CROSS_IMPORT = [
  { dir: WEB_E2E, pattern: /from\s+['"][^'"]*desktop\//, name: 'Web 用例 import 了 desktop 目录' },
  { dir: DESKTOP_E2E, pattern: /from\s+['"][^'"]*\.\.\/\.\.\/web\//, name: '桌面用例 import 了 web 目录' },
  { dir: DESKTOP_E2E, pattern: /from\s+['"][^'"]*web\/e2e\//, name: '桌面用例 import 了 web/e2e' },
]
for (const { dir, pattern, name } of CROSS_IMPORT) {
  for (const spec of specNames(dir)) {
    if (pattern.test(readFileSync(join(dir, spec), 'utf8'))) failures.push(`${name}：${spec}`)
  }
}

if (failures.length) {
  console.error('E2E 同名用例守卫未通过：\n\n' + failures.map((item) => `- ${item}`).join('\n\n'))
  process.exit(1)
}

console.log(`E2E 同名用例守卫通过：Web ${webSpecs.length} 个、桌面 ${desktopSpecs.length} 个，`
  + `其中 ${shared.length} 对同名且各自独立（差异下限 ${MIN_DIFF_LINES} 行）。`)
