// D-224 / OPT-S03：非核心外围能力软冻结的 UI 契约。
// 只锁「入口隐藏 + 深链保留」与「Office 导出目标不再默认暴露」，不改后端路由与历史构建回读。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const registry = readFileSync(join(root, 'lib/settings-registry.ts'), 'utf8')
const desktopSettings = readFileSync(join(root, 'lib/desktop-settings.tsx'), 'utf8')
const shell = readFileSync(join(root, 'layout/Shell.tsx'), 'utf8')
const palette = readFileSync(join(root, 'components/command-palette.tsx'), 'utf8')
const buildPanel = readFileSync(join(root, 'pages/work/BuildPanel.tsx'), 'utf8')

/** 取出 settingsEntries 数组字面量（到数组闭合 ] 为止）。 */
function entriesLiteral(source) {
  const start = source.indexOf('export const settingsEntries')
  assert.ok(start >= 0, 'settings-registry 缺少 settingsEntries')
  const end = source.indexOf('\n]', start)
  assert.ok(end > start, 'settingsEntries 数组未闭合')
  return source.slice(start, end)
}

/** 按 `path: '...'` 切出每个条目片段，便于逐项断言。 */
function entryChunk(literal, path) {
  const marker = `path: '${path}'`
  const start = literal.indexOf(marker)
  if (start < 0) return null
  const next = literal.indexOf("path: '", start + marker.length)
  return literal.slice(start, next < 0 ? literal.length : next)
}

const literal = entriesLiteral(registry)

test('OPT-S03：SettingsEntry 提供 frozenHidden 可选字段，未落库到类型必填项', () => {
  assert.match(registry, /frozenHidden\?: boolean/, '缺少 frozenHidden?: boolean 字段声明')
})

test('OPT-S03：仅 plugins / desktop-ai / crawl 三个真实条目被标记软冻结（D-225 解冻 mail）', () => {
  const frozen = ['/settings/plugins', '/settings/desktop-ai', '/settings/crawl']
  for (const path of frozen) {
    const chunk = entryChunk(literal, path)
    assert.ok(chunk, `settingsEntries 缺少条目 ${path}`)
    assert.match(chunk, /frozenHidden: true/, `${path} 未标记 frozenHidden: true`)
  }
  const allFrozen = [...literal.matchAll(/frozenHidden: true/g)].length
  assert.equal(allFrozen, frozen.length, 'frozenHidden 标记数必须正好 3 项，不得误伤其他设置项')
})

test('OPT-S03：未引入 feishu / parser-diagnostics 条目，memory / skills / mail 不冻结', () => {
  for (const path of ['/settings/feishu', '/settings/parser-diagnostics']) {
    assert.equal(entryChunk(literal, path), null, `${path} 本不在 settingsEntries，不得新增`)
  }
  // D-225 / RC-11：恢复小团队邀请邮件入口，/settings/mail 解冻并归入「团队与工作区」。
  for (const path of ['/settings/memory', '/settings/skills', '/settings/mail']) {
    const chunk = entryChunk(literal, path)
    assert.ok(chunk, `settingsEntries 缺少条目 ${path}`)
    assert.doesNotMatch(chunk, /frozenHidden/, `${path} 不得被软冻结（D-151 / OPT-W02 / D-225 已放开）`)
  }
})

test('OPT-S03：三处导航取数统一过滤 frozenHidden，深链查找保持原样', () => {
  assert.match(registry, /export const webSettingsEntries = settingsEntries\.filter\(\(entry\) => !entry\.webHidden && !entry\.adminOnly && !entry\.frozenHidden\)/)
  assert.match(desktopSettings, /export const desktopSettingsEntries = settingsEntries\.filter\(\(entry\) => !entry\.desktopHidden && !entry\.frozenHidden\)/)
  assert.match(shell, /\.filter\(\(entry\) => !entry\.webHidden && !entry\.frozenHidden\)/)
  assert.match(palette, /settingsEntries\.filter\(\(entry\) => entry\.adminOnly && !entry\.webHidden && !entry\.frozenHidden\)/)
  // 深链与标题查找仍走完整数组。
  assert.match(registry, /return settingsEntries\.filter\(\(entry\) => path\.startsWith\(entry\.path\)\)/)
  assert.match(registry, /if \(path === '\/settings'\) return settingsEntries\[0\]/)
})

test('OPT-S03：desktopSettingsPanel 不参与冻结过滤，冻结项深链仍能打开设置窗', () => {
  const start = desktopSettings.indexOf('export function desktopSettingsPanel')
  assert.ok(start >= 0, '缺少 desktopSettingsPanel')
  const body = desktopSettings.slice(start, desktopSettings.indexOf('\n}', start) + 2)
  assert.match(body, /return entry\?\.tool \|\| entry\?\.desktopHidden \? undefined : entry/)
  assert.doesNotMatch(body, /frozenHidden/, 'desktopSettingsPanel 加入 frozenHidden 会让 /settings/desktop-ai、/settings/plugins、/settings/crawl 深链失效')
})

test('OPT-S03：命令面板冻结项对管理员同样不下发', () => {
  assert.equal((palette.match(/entry\.frozenHidden/g) ?? []).length, 1, '命令面板只需在管理员追加处过滤一次')
  assert.match(palette, /const settings = commandPaletteSettings\(\)/)
})

test('OPT-S03：BuildPanel 勾选列表仅展示三个核心交付目标', () => {
  assert.match(buildPanel, /const visibleBuildTargets: BuildTarget\[\] = \['wechat_html', 'stable_html', 'long_image'\]/)
  assert.match(buildPanel, /\{visibleBuildTargets\.map\(target =>/)
  assert.doesNotMatch(buildPanel, /Object\.keys\(targetLabels\)/, '勾选列表不得再用 targetLabels 全量枚举（会重新暴露 pptx/docx）')
  const labels = buildPanel.match(/const visibleBuildTargets: BuildTarget\[\] = \[([^\]]*)\]/)
  assert.ok(labels, '缺少 visibleBuildTargets 定义')
  const targets = [...labels[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
  assert.deepEqual(targets, ['wechat_html', 'stable_html', 'long_image'])
})

test('OPT-S03：Office 模板版本与确定性说明提示块已从界面移除', () => {
  assert.doesNotMatch(buildPanel, /data-testid="office-export-template-version"/)
  assert.doesNotMatch(buildPanel, /data-testid="office-export-deterministic-note"/)
  assert.doesNotMatch(buildPanel, /模板版本：\{OFFICE_TEMPLATE_VERSION\}/)
})

test('OPT-S03：历史兼容保留，旧 PPTX/DOCX 构建记录仍可显示与回读', () => {
  // 目标标签全量保留，历史列表用 targetLabels 回显；Office 渲染与模板版本仍按需触发。
  assert.match(buildPanel, /pptx: 'PPTX 演示文稿'/)
  assert.match(buildPanel, /docx: 'DOCX 文档'/)
  assert.match(buildPanel, /item\.targets\.map\(target => targetLabels\[target\]\)/)
  assert.match(buildPanel, /async function renderOfficeArtifact\(buildID: string, kind: OfficeKind\)/)
  assert.match(buildPanel, /`\/builds\/\$\{encodeURIComponent\(buildID\)\}\/office-render`/)
  assert.match(buildPanel, /OFFICE_TEMPLATE_VERSION/)
  // 隐私门禁与产物下载链路不动。
  assert.match(buildPanel, /data-testid=\{`download-artifact-\$\{item\.kind\}`\}/)
  assert.match(buildPanel, /detail\.download_gate\.allowed/)
})
