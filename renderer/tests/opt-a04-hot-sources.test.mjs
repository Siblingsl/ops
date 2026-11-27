import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// OPT-A04（docs/43 §3）：预置热点源、真实搜索方式与异常降级入口的静态契约。
// 只校验源码结构与关键文案，不启动浏览器；运行时行为由 Go 测试覆盖。

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
const repoRoot = path.resolve(rendererRoot, '..')

function read(relative) {
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8').replace(/\r\n/g, '\n')
}

test('OPT-A04 降级弹窗：固定文案、data-testid 与直达路径', () => {
  const source = read('components/hot-fallback-dialog.tsx')
  assert.match(source, /data-testid="hot-fallback-paste-reference-btn"/)
  assert.ok(source.includes('点击手动粘贴文章全文作为参考'))
  assert.match(source, /\/a\/\$\{accountId\}\/ops\?tab=references&paste=1/)
  assert.match(source, /\/a\/\$\{accountId\}\/topics\?hot=1/)
  assert.match(source, /from '@\/components\/dialog'/)
  assert.equal(/fetch\(/.test(source), false)
})

test('OPT-A04 工作区热点来源：预置模板一键填入与草稿移除', () => {
  const source = read('pages/settings/Crawl.tsx')
  assert.match(source, /data-testid="hot-source-presets"/)
  assert.match(source, /query\.data\?\.presets \?\? \[\]/)
  assert.match(source, /preset\.url\.trim\(\)/)
  assert.ok(source.includes("'已填入'"))
  assert.ok(source.includes('一键填入'))
  assert.match(source, /rss\.length >= 10/)
  assert.match(source, /!r\.key &&/)
  assert.match(source, /移除/)
})

test('OPT-A04 搜索来源表单：四种搜索方式与脱敏回显', () => {
  const source = read('pages/settings/Crawl.tsx')
  for (const engine of ['native', 'tavily', 'bocha', 'searxng']) {
    assert.match(source, new RegExp(`<option value="${engine}">`))
  }
  assert.match(source, /source\?\.config\.engine/)
  assert.match(source, /source\?\.config\.query/)
  assert.match(source, /source\?\.config\.base_url/)
  assert.match(source, /source\?\.config\.has_api_key === 'true'/)
  assert.ok(source.includes('已保存密钥，修改关键词可留空沿用；更换引擎需重新填写'))
  assert.match(source, /base_url: engine === 'searxng'/)
  assert.match(source, /api_key: apiKey\.trim\(\)/)
})

test('OPT-A04 搜索来源表单：baseUrl 不串用官方地址且按差值判脏', () => {
  const source = read('pages/settings/Crawl.tsx')
  assert.match(source, /const initialBaseUrl = initialEngine === 'searxng'/)
  assert.match(source, /const \[baseUrl, setBaseUrl\] = useState\(\(\) => initialBaseUrl\)/)
  assert.match(source, /nextEngine === 'searxng' && initialEngine === 'searxng'/)
  for (const field of ['engine', 'query', 'baseUrl', 'provider', 'model']) {
    assert.match(source, new RegExp(`(?:isDirty = |\\|\\| )${field} !== initial${field[0].toUpperCase()}${field.slice(1)}`))
  }
  assert.match(source, /apiKey\.trim\(\) !== ''/)
  assert.match(source, /useSettingsDraft\(!disabled && isDirty, busy\)/)
  // 外部配置变化时同步回显并清空密钥；保存成功只清密钥，不再清掉 query/baseUrl。
  assert.match(source, /source\.config\.provider_id[\s\S]{0,400}setApiKey\(''\)/)
  assert.match(source, /setApiKey\(''\)\n      refresh\(\)/)
})

test('OPT-A04 过期暂停：列表提示与弹窗数据都过滤失效时间', () => {
  const source = read('pages/settings/Crawl.tsx')
  assert.match(source, /export function isActivePause\(until\?: string \| null\)/)
  assert.match(source, /new Date\(until\)\.getTime\(\) > Date\.now\(\)/)
  assert.match(source, /!!s\.error\?\.trim\(\) \|\| activePause/)
  assert.match(source, /activePause \? ` · 暂停至/)
  assert.match(source, /paused_until: isActivePause\(source\.paused_until\)/)
})

test('OPT-A04 来源异常入口：列表原因与试采失败都挂载降级弹窗', () => {
  const source = read('pages/settings/Crawl.tsx')
  assert.match(source, /查看原因与手动粘贴参考/)
  assert.match(source, /HotFallbackDialog open=\{!!fallbackIssue\}/)
  assert.match(source, /HotFallbackDialog open=\{fallbackIssues\.length > 0\}/)
  assert.match(source, /useCurrentAccount\(\)/)
})

test('OPT-A04 Ops：tab 参数切换、参考区平滑滚动与手动切 Tab 清理参数', () => {
  const source = read('pages/Ops.tsx')
  assert.match(source, /useSearchParams/)
  assert.match(source, /const \[searchParams, setSearchParams\] = useSearchParams\(\)/)
  assert.match(source, /const selectDesktopTab = \(tab: string\) =>/)
  assert.match(source, /setSearchParams\(\{\}, \{ replace: true \}\)/)
  for (const tab of ['strategy', 'plan', 'hot', 'references', 'daily', 'stats']) {
    assert.ok(source.includes(`'${tab}'`), tab)
  }
  assert.match(source, /setDesktopTab\(tabParam\)/)
  assert.match(source, /selectDesktopTab\(value\)/)
  assert.ok(source.includes("selectDesktopTab('strategy')"))
  assert.match(source, /document\.getElementById\('references'\)\?\.scrollIntoView/)
  assert.match(source, /behavior: 'smooth'/)
})

test('OPT-A04 对标参考：id、引导条与自动展开首条粘贴框', () => {
  const source = read('pages/ops/References.tsx')
  assert.match(source, /<Card id="references"/)
  assert.match(source, /data-testid="reference-paste-guide"/)
  assert.match(source, /params\.get\('paste'\)\s*===\s*'1'/)
  assert.match(source, /autoPaste\.current\s*=\s*true/)
  assert.match(source, /setPaste\(q\.data\[0\]\.id\)/)
  assert.match(source, /linkRef\.current\?\.focus\(\)/)
  assert.match(source, /topics\?hot=1/)
})

test('OPT-A04 今日热点：source_issues 优先、旧数据回退、同一批异常只自动弹一次', () => {
  const source = read('pages/ops/Hot.tsx')
  assert.match(source, /data\.source_issues\?\.length/)
  assert.match(source, /data\.paused_sources/)
  assert.match(source, /autoShown\.current === issueSig/)
  assert.match(source, /if \(compact \|\| !issueSig \|\| autoShown\.current === issueSig\) return/)
  assert.match(source, /\[issueSig, compact\]/)
  assert.match(source, /setFallbackOpen\(true\)/)
  assert.match(source, /path\.endsWith\('\/hot\/refresh'\)/)
  assert.match(source, /手动粘贴参考/)
  assert.match(source, /HotFallbackDialog open=\{fallbackOpen\}/)
})

test('OPT-A04 共享类型：预置、异常与搜索配置字段', () => {
  const types = fs.readFileSync(path.join(repoRoot, 'shared', 'types.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(types, /export interface HotSourcePreset/)
  assert.match(types, /export interface HotSourceIssue/)
  assert.match(types, /presets\?: HotSourcePreset\[\]/)
  assert.match(types, /source_issues\?: HotSourceIssue\[\]/)
  assert.match(types, /has_api_key\?: string/)
  assert.match(types, /engine\?: 'native' \| 'tavily' \| 'bocha' \| 'searxng' \| string/)
})

test('OPT-A04 红线：不新增 HTTP 路由与 Agent 目录工具', () => {
  const server = fs.readFileSync(path.join(repoRoot, 'server', 'internal', 'app', 'server.go'), 'utf8')
  const presets = fs.readFileSync(path.join(repoRoot, 'server', 'internal', 'crawl', 'presets.go'), 'utf8')
  assert.equal(/presets/.test(server), false)
  assert.equal(/http\.Client|http\.Get\(/.test(presets), false)
  const aiSearch = fs.readFileSync(path.join(repoRoot, 'server', 'internal', 'ai', 'search.go'), 'utf8')
  assert.equal(/url\.Values\{/.test(aiSearch), false, '查询参数必须使用既有 URL 编码而非手拼')
})

test('OPT-A04 今日热点禁用原因：shared 类型与 Hot 精准引导', () => {
  const types = fs.readFileSync(path.join(repoRoot, 'shared', 'types.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(types, /disabled_reason\?: '' \| 'crawl_off' \| 'no_strategy' \| 'account_hot_off'/)
  const hot = read('pages/ops/Hot.tsx')
  assert.match(hot, /title="热点采集未开启"/)
  assert.match(hot, /no_strategy/)
  assert.match(hot, /account_hot_off/)
  assert.match(hot, /\/a\/\$\{accountId\}\/ops\?tab=strategy/)
  assert.match(hot, /去启用运营方案/)
  assert.match(hot, /去调整运营方案/)
})
