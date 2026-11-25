import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { sharedNpmAliases } from '../../shared/vite-dep-alias.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
// shared/api.ts 引 sonner，仓库根外解析不到包；按既有测试口径把包目录写进 alias。
const npmAliases = sharedNpmAliases(import.meta.url)

async function readSource(relative) {
  return fs.readFile(path.join(rendererRoot, relative), 'utf8').then((text) => text.replace(/\r\n/g, '\n'))
}

const count = (source, token) => source.split(token).length - 1

async function loadFallbackModule() {
  const server = await createServer({
    configFile: false,
    root: rendererRoot,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: /^@\//, replacement: '/' },
        { find: 'sonner', replacement: npmAliases.sonner },
        { find: 'marked', replacement: npmAliases.marked },
      ],
    },
    define: { __OPS_API_BASE__: '""' },
  })
  try {
    return await server.ssrLoadModule('/components/xhs-manual-fallback.tsx')
  } finally {
    await server.close()
  }
}

// OPT-U03（docs/43 §4）：小红书填草稿失败「一键人工接管兜底包」。
// 1) 真实错误码必须翻成可读原因，未知码保留原始错误码；
// 2) 正文 + 内联 #话题 与 desktop/src/publish-page.ts 同口径（去前导 #、去空去重）；
// 3) 封面置顶排序 + Content-Type → 白名单扩展名；
// 4) 源码守卫：看板保留 row.platform !== 'xhs' 守卫、没有小红书直接发布按钮、两处都挂兜底栏。

const mod = await loadFallbackModule()

test('OPT-U03: 错误码映射为可读原因，未知码保留原始错误码', () => {
  const login = mod.formatXhsFallbackReason('platform_login_required')
  assert.match(login, /登录会话已过期或未登录/)
  assert.match(login, /重新登录/)
  assert.match(login, /人工发布/)
  assert.equal(mod.formatXhsFallbackReason(undefined, undefined, 'not_logged_in'), login)
  assert.match(mod.formatXhsFallbackReason('not_logged_in'), /登录/)

  assert.match(mod.formatXhsFallbackReason('account_mismatch'), /账号与任务账号不一致/)
  assert.match(mod.formatXhsFallbackReason('platform_profile_mismatch'), /账号与任务账号不一致/)

  for (const code of ['anchor_missing', 'draft_save_button_missing', 'draft_save_unconfirmed']) {
    assert.match(mod.formatXhsFallbackReason(code), /页面结构可能已变化/, code)
  }
  assert.match(mod.formatXhsFallbackReason('manifest_invalid'), /发布字段校验未通过/)
  for (const code of ['timeout', 'publish_timeout', 'page_timeout']) {
    assert.match(mod.formatXhsFallbackReason(code), /超时/, code)
  }

  // 未知码：中文原文直接可用，并附原始错误码；英文原文先补中文语境再附码。
  const unknown = mod.formatXhsFallbackReason('draft_something_new', '保存草稿时页面被跳转')
  assert.match(unknown, /保存草稿时页面被跳转/)
  assert.match(unknown, /错误码 draft_something_new/)
  const english = mod.formatXhsFallbackReason('weird_code', 'net::ERR_ABORTED')
  assert.match(english, /小红书自动填草稿未完成/)
  assert.match(english, /错误码 weird_code/)
  // 没有任何信息时也必须给可执行文案，不能是裸英文码或空串。
  assert.match(mod.formatXhsFallbackReason(), /人工接管包/)
})

test('OPT-U03: 正文 + 内联 #话题 与 publish-page 同口径', async () => {
  const body = '  今天聊聊选题  '
  assert.equal(mod.formatXhsBodyWithTags(body, ['#选题', '内容运营', '##选题', '', '   ']),
    '今天聊聊选题\n\n#选题 #内容运营')
  assert.equal(mod.formatXhsBodyWithTags(body, []), '今天聊聊选题')
  assert.equal(mod.formatXhsBodyWithTags(body, ['#']), '今天聊聊选题')
  // 空正文不能带前导空行：只贴话题行。
  assert.equal(mod.formatXhsBodyWithTags('   ', ['a', '#b', 'a']), '#a #b')
  assert.equal(mod.formatXhsBodyWithTags('', ['#封面']), '#封面')
  // 话题顺序保留首次出现顺序，不因去重丢项。
  assert.equal(mod.formatXhsBodyWithTags('正文', ['b', '#a', 'b']), '正文\n\n#b #a')
  // 与 desktop/src/publish-page.ts:601 的拼接格式逐字一致。
  const page = await readSource('../desktop/src/publish-page.ts')
  assert.ok(page.includes("body = `${bodyText}\\n\\n${tags.map((tag) => `#${tag}`).join(' ')}`"))
})

test('OPT-U03: 封面置顶排序，无显式封面时第 1 张即封面位', () => {
  const assets = [
    { asset_id: 'a1' },
    { asset_id: 'a2', role: 'cover' },
    { asset_id: 'a3' },
  ]
  assert.deepEqual(mod.resolveXhsImageOrder(assets), [
    { asset_id: 'a2', isCover: true },
    { asset_id: 'a1', isCover: false },
    { asset_id: 'a3', isCover: false },
  ])
  // coverAssetId 兜底（作品没有 role 字段时仍能认出封面）。
  assert.deepEqual(mod.resolveXhsImageOrder(assets.map((asset) => ({ asset_id: asset.asset_id })), 'a3'), [
    { asset_id: 'a3', isCover: true },
    { asset_id: 'a1', isCover: false },
    { asset_id: 'a2', isCover: false },
  ])
  assert.deepEqual(mod.resolveXhsImageOrder([{ asset_id: 'a1' }, { asset_id: 'a2' }]), [
    { asset_id: 'a1', isCover: true },
    { asset_id: 'a2', isCover: false },
  ])
  assert.deepEqual(mod.resolveXhsImageOrder([]), [])
})

test('OPT-U03: Content-Type → 白名单扩展名', () => {
  assert.equal(mod.mimeToAllowedImageExt('image/png'), 'png')
  assert.equal(mod.mimeToAllowedImageExt('image/jpeg'), 'jpg')
  assert.equal(mod.mimeToAllowedImageExt('image/jpg'), 'jpg')
  assert.equal(mod.mimeToAllowedImageExt('image/webp'), 'webp')
  assert.equal(mod.mimeToAllowedImageExt('image/gif'), 'gif')
  assert.equal(mod.mimeToAllowedImageExt('image/jpeg; charset=binary'), 'jpg')
  assert.equal(mod.mimeToAllowedImageExt('application/octet-stream'), 'png')
  assert.equal(mod.mimeToAllowedImageExt(null), 'png')
  assert.equal(mod.mimeToAllowedImageExt(undefined), 'png')
})

test('OPT-U03: 数据归一——manifest（payload 嵌套结构）优先，作品 sections / comic panels / topics 兜底', () => {
  // 服务端 GET /works/{id}/publish-manifests/xhs 真实结构：{ id, platform, payload: { fields, assets } }。
  const manifest = {
    id: 'pm-1',
    platform: 'xhs',
    payload: {
      fields: { title: '标题A', body_text: '正文A', tags: ['话题A'], cover_asset_id: 'a2' },
      assets: [{ asset_id: 'a1', role: 'inline' }, { asset_id: 'a2', role: 'cover' }],
    },
  }
  const data = mod.buildXhsManualFallbackData(manifest, null)
  assert.equal(data.title, '标题A')
  assert.equal(data.body, '正文A')
  assert.deepEqual(data.tags, ['话题A'])
  assert.deepEqual(data.images, [{ asset_id: 'a2', isCover: true }, { asset_id: 'a1', isCover: false }])

  // payload 存在但缺正文时，正文从作品 sections 兜底；标题仍用 manifest。
  const partial = mod.buildXhsManualFallbackData(
    { payload: { fields: { title: 'manifes 标题' }, assets: [{ asset_id: 'm1' }] } },
    { title: '作品标题', sections: [{ content_md: '作品正文' }] },
  )
  assert.equal(partial.title, 'manifes 标题')
  assert.equal(partial.body, '作品正文')
  assert.deepEqual(partial.images, [{ asset_id: 'm1', isCover: true }])

  // 顶层老结构不再被误读（payload 缺失即视为无发布字段，全部落作品兜底）。
  const legacy = mod.buildXhsManualFallbackData(
    { fields: { title: '错层标题' }, assets: [{ asset_id: 'x' }] },
    { title: '作品标题', topics: ['话题B'], sections: [{ content_md: '作品正文' }], assets: [{ id: 'w1' }] },
  )
  assert.equal(legacy.title, '作品标题')
  assert.deepEqual(legacy.tags, ['话题B'])
  assert.deepEqual(legacy.images, [{ asset_id: 'w1', isCover: true }])

  const comic = mod.buildXhsManualFallbackData(null, {
    title: '漫画标题',
    topics: ['话题B'],
    content_format: 'comic',
    cover_asset_id: 'p2',
    panels: [
      { narration: '旁白1', dialogue: '对白1', asset_id: 'p1' },
      { narration: '', dialogue: '对白2', asset_id: 'p2' },
    ],
    assets: [{ id: 'p2', position: 1 }, { id: 'p1', position: 0 }],
  })
  assert.equal(comic.title, '漫画标题')
  assert.equal(comic.body, '旁白1\n对白1\n\n对白2')
  assert.deepEqual(comic.tags, ['话题B'])
  assert.deepEqual(comic.images, [{ asset_id: 'p2', isCover: true }, { asset_id: 'p1', isCover: false }])

  const sections = mod.buildXhsManualFallbackData(null, {
    title: '长文标题',
    tags: ['标签C'],
    sections: [{ content_md: '第一段' }, { content_md: '  ' }, { content_md: '第二段' }],
    assets: [{ id: 's1', position: 0 }],
  })
  assert.equal(sections.body, '第一段\n\n第二段')
  assert.deepEqual(sections.tags, ['标签C'])
  assert.deepEqual(sections.images, [{ asset_id: 's1', isCover: true }])
})

test('OPT-U03: 源码守卫——保留 xhs 提交守卫、无小红书直接发布入口、两处挂兜底栏', async () => {
  const board = await readSource('components/publish-task-board.tsx')
  // D-222：立即提交按钮的 row.platform !== 'xhs' 守卫必须原样保留。
  assert.ok(board.includes("row.state === 'filled' && row.mode === 'desktop' && row.platform !== 'xhs'"),
    '立即提交的小红书守卫被改动')
  assert.equal(count(board, "row.platform !== 'xhs'"), 1)
  // 兜底栏只挂在小红书失败/掉线行。
  assert.ok(board.includes("row.platform === 'xhs' && (row.state === 'failed' || row.state === 'not_logged_in')"))
  assert.match(board, /<XhsManualFallbackBar workId=\{row\.work_id\}/)
  assert.ok(board.includes('last_error_message?: string'))
  // 没有任何小红书直接发布 / 批量入口（既有「立即提交」只有受 row.platform !== 'xhs' 保护的那一个）。
  assert.equal(count(board, 'publish-task-submit-now'), 1, '只允许既有的一个立即提交入口')
  assert.doesNotMatch(board, /<Button[^>]*>\s*(批量发布|全部执行|全部确认|一键发布|批量执行|全部入库)/m)

  const manifest = await readSource('components/publish-manifest.tsx')
  assert.match(manifest, /<XhsManualFallbackBar workId=\{work\.id\}/)
  assert.ok(manifest.includes("platform.id === 'xhs' && task && (task.state === 'failed' || task.state === 'not_logged_in' || (readback && readback.ok === false))"))
  assert.ok(manifest.includes('last_error_message?: string'))

  // 兜底栏本身只复制/导出，不含任何发布动作。
  const bar = await readSource('components/xhs-manual-fallback.tsx')
  for (const testid of ['xhs-manual-fallback-bar', 'xhs-manual-fallback-reason', 'xhs-fallback-copy-title',
    'xhs-fallback-copy-body', 'xhs-fallback-open-images']) {
    assert.ok(bar.includes(`data-testid="${testid}"`), `缺少 ${testid}`)
  }
  assert.doesNotMatch(bar, /submit-now|submitNow|publish-tasks\//)
  assert.doesNotMatch(bar, /<Button[^>]*>\s*(立即提交|直接发布|一键发布)/m)
  assert.ok(bar.includes("rawRequest('GET', `/assets/${encodeURIComponent(assetId)}/file`)"))
  assert.ok(bar.includes("`/works/${workId}/publish-manifests/xhs`"))
  assert.ok(bar.includes("`/works/${workId}`"))
  assert.ok(bar.includes("`/works/${workId}/xhs/pack.zip`"))
  assert.ok(bar.includes('openXhsManualImageFolder'))
  assert.ok(bar.includes('已按序导出 ${result.count} 张图片并打开文件夹（01_封面 起）'))
  assert.ok(bar.includes("toast.info('该作品暂无可导出的图片')"))
})
