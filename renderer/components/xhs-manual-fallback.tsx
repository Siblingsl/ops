import { Copy, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui'
import { errorMessage as readError, get, rawRequest } from '@/lib/api'
import { copyText } from '@/lib/format'
import { hasDesktopBridgeMethod, openXhsManualImageFolder } from '@/lib/platform-bridge'

// OPT-U03（docs/43 §4）：小红书填草稿失败「一键人工接管兜底包」。
// 只提供「复制标题 / 复制正文（含内联 #话题）/ 打开有序图片文件夹」三件事；
// 不提供任何「立即提交 / 直接发布」入口（D-222），发布仍由用户在小红书里亲自完成。

const LOGIN_CODES = new Set(['platform_login_required', 'not_logged_in'])
const ACCOUNT_CODES = new Set(['account_mismatch', 'platform_profile_mismatch'])
const ANCHOR_CODES = new Set(['anchor_missing', 'draft_save_button_missing', 'draft_save_unconfirmed', 'draft_save_failed', 'readback_mismatch'])
const MANIFEST_CODES = new Set(['manifest_invalid'])
const TIMEOUT_CODES = new Set(['timeout', 'publish_timeout', 'page_timeout'])
const CJK = /[\u4e00-\u9fa5]/

/** 把真实错误码翻成可读原因；未知码保留原始错误码便于排障，避免只给裸英文码。 */
export function formatXhsFallbackReason(errorCode?: string, errorMessage?: string, state?: string): string {
  const code = (errorCode ?? '').trim()
  if (LOGIN_CODES.has(code) || state === 'not_logged_in') {
    return '小红书登录会话已过期或未登录：请重新登录后重试，或直接用下方「复制标题 / 复制正文（含内联 #话题） / 打开有序图片文件夹」完成人工发布。'
  }
  if (ACCOUNT_CODES.has(code)) {
    return '当前登录的小红书账号与任务账号不一致：请切换到任务所属账号后重试，或按下方人工接管包直接发布。'
  }
  if (ANCHOR_CODES.has(code)) {
    return '小红书创作中心页面结构可能已变化，未能自动填入或确认保存草稿：请用下方人工接管包（复制标题与正文、打开有序图片文件夹）手动发布。'
  }
  if (MANIFEST_CODES.has(code)) {
    return '发布字段校验未通过（如缺少标题或素材）：请先回作品页补齐标题、正文或图片，再重试。'
  }
  if (TIMEOUT_CODES.has(code)) {
    return '小红书页面加载或填表超时：请重试，或直接用下方人工接管包手动发布。'
  }
  const detail = (errorMessage ?? '').trim()
  const base = detail
    ? (CJK.test(detail) ? detail : `小红书自动填草稿未完成：${detail}`)
    : '小红书自动填草稿未完成，请用下方人工接管包手动发布。'
  return code ? `${base}（错误码 ${code}）` : base
}

/** 正文 + 内联话题，口径对齐 desktop/src/publish-page.ts（每项去前导 #、去空去重）。 */
export function formatXhsBodyWithTags(bodyText: string, tags: string[]): string {
  const body = (bodyText ?? '').trim()
  const cleaned: string[] = []
  for (const raw of tags ?? []) {
    const tag = String(raw ?? '').trim().replace(/^#+/, '').trim()
    if (!tag || cleaned.includes(tag)) continue
    cleaned.push(tag)
  }
  if (cleaned.length === 0) return body
  const tagLine = cleaned.map((tag) => `#${tag}`).join(' ')
  // 空正文只贴话题行，不产生前导空行。
  return body === '' ? tagLine : `${body}\n\n${tagLine}`
}

/** 封面置顶：role === 'cover' 或匹配 coverAssetId 的那张排第 1，其余保持原序；无显式封面时第 1 张即封面位。 */
export function resolveXhsImageOrder(
  assets: Array<{ asset_id: string; role?: string }>,
  coverAssetId?: string | null,
): Array<{ asset_id: string; isCover: boolean }> {
  const coverId = (coverAssetId ?? '').trim()
  const rows = assets.filter((asset) => typeof asset?.asset_id === 'string' && asset.asset_id !== '')
  if (rows.length === 0) return []
  const coverIndex = rows.findIndex((asset) => asset.role === 'cover' || (coverId !== '' && asset.asset_id === coverId))
  if (coverIndex <= 0) {
    return rows.map((asset, index) => ({ asset_id: asset.asset_id, isCover: index === 0 }))
  }
  const ordered = [rows[coverIndex], ...rows.filter((_, index) => index !== coverIndex)]
  return ordered.map((asset, index) => ({ asset_id: asset.asset_id, isCover: index === 0 }))
}

/** 服务端只回 Content-Type；导出扩展名仅允许 png/jpg/webp/gif，其余默认 png。 */
export function mimeToAllowedImageExt(mime?: string | null): 'png' | 'jpg' | 'webp' | 'gif' {
  const value = (mime ?? '').split(';')[0].trim().toLowerCase()
  if (value === 'image/jpeg' || value === 'image/jpg') return 'jpg'
  if (value === 'image/webp') return 'webp'
  if (value === 'image/gif') return 'gif'
  return 'png'
}

// 服务端 GET /works/{id}/publish-manifests/xhs 返回 { id, platform, payload: { fields, assets } }，
// 字段与素材都在 payload 内（见 server/internal/app/publish_manifest.go）。
type XhsManifestLike = {
  payload?: {
    fields?: { title?: string; body_text?: string; tags?: string[]; cover_asset_id?: string | null }
    assets?: Array<{ asset_id: string; role?: string }>
  }
}

type XhsWorkLike = {
  title?: string
  tags?: string[]
  topics?: string[]
  content_format?: string
  cover_asset_id?: string | null
  sections?: Array<{ content_md?: string }>
  panels?: Array<{ narration?: string; dialogue?: string; asset_id?: string | null }>
  assets?: Array<{ id: string; position?: number }>
}

export type XhsManualFallbackData = {
  title: string
  body: string
  tags: string[]
  images: Array<{ asset_id: string; isCover: boolean }>
}

function workBody(work: XhsWorkLike | null | undefined): string {
  if (!work) return ''
  if (work.content_format === 'comic') {
    return (work.panels ?? [])
      .map((panel) => [panel.narration, panel.dialogue].filter(Boolean).join('\n').trim())
      .filter(Boolean)
      .join('\n\n')
  }
  return (work.sections ?? []).map((section) => (section.content_md ?? '').trim()).filter(Boolean).join('\n\n')
}

/** manifest 优先、作品字段兜底：标题 / 正文 / 话题 / 有序图片一次性收敛成兜底包数据。 */
export function buildXhsManualFallbackData(
  manifest: XhsManifestLike | null | undefined,
  work: XhsWorkLike | null | undefined,
): XhsManualFallbackData {
  const payload = manifest?.payload
  const fields = payload?.fields ?? {}
  const title = (fields.title ?? work?.title ?? '').trim()
  const manifestBody = typeof fields.body_text === 'string' ? fields.body_text.trim() : ''
  const body = manifestBody || workBody(work)
  const manifestTags = Array.isArray(fields.tags) ? fields.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '') : []
  const workTags = work?.tags ?? []
  const tags = manifestTags.length > 0 ? manifestTags : (workTags.length > 0 ? workTags : (work?.topics ?? []))
  let assets: Array<{ asset_id: string; role?: string }> = []
  let coverAssetId: string | null = null
  if (payload && Array.isArray(payload.assets) && payload.assets.length > 0) {
    assets = payload.assets
    coverAssetId = fields.cover_asset_id ?? null
  } else {
    assets = (work?.assets ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((asset) => ({ asset_id: asset.id }))
    coverAssetId = work?.cover_asset_id ?? null
  }
  return { title, body, tags, images: resolveXhsImageOrder(assets, coverAssetId) }
}

// 按需拉取（不缓存跨次结果，避免用户改稿后仍复制陈旧标题/正文/图片）；并发点击只共享在途请求。
const fallbackDataLoading = new Map<string, Promise<XhsManualFallbackData>>()

async function loadXhsManualFallbackData(workId: string): Promise<XhsManualFallbackData> {
  const inflight = fallbackDataLoading.get(workId)
  if (inflight) return inflight
  const task = (async () => {
    let manifest: XhsManifestLike | null = null
    try {
      manifest = await get<XhsManifestLike>(`/works/${workId}/publish-manifests/xhs`)
    } catch {
      // 404 / 未生成发布字段：降级到作品本身。
      manifest = null
    }
    const payload = manifest?.payload
    // payload 缺失，或标题 / 正文 / 图片任一缺失时，补拉作品兜底。
    const needWork = !payload || !payload.fields?.title?.trim() || !payload.fields?.body_text?.trim() || !(payload.assets?.length)
    const work = needWork ? await get<XhsWorkLike>(`/works/${workId}`) : null
    return buildXhsManualFallbackData(manifest, work)
  })()
  fallbackDataLoading.set(workId, task)
  try {
    return await task
  } finally {
    fallbackDataLoading.delete(workId)
  }
}

async function downloadImageBytes(assetId: string): Promise<{ ext: 'png' | 'jpg' | 'webp' | 'gif'; bytes: Uint8Array }> {
  const response = await rawRequest('GET', `/assets/${encodeURIComponent(assetId)}/file`)
  return {
    ext: mimeToAllowedImageExt(response.headers.get('Content-Type')),
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

/** 浏览器态降级：直接下载发布包 zip（不静默失败，也不假装打开了文件夹）。 */
async function downloadXhsPackZip(workId: string): Promise<void> {
  const response = await rawRequest('GET', `/works/${workId}/xhs/pack.zip`)
  const objectURL = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = objectURL
  link.download = `xhs-${new Date().toISOString().slice(0, 10)}.zip`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(objectURL), 10_000)
}

const MAX_EXPORT_FILES = 18
const MAX_EXPORT_BYTES = 100 * 1024 * 1024

/** 小红书发布任务失败 / 掉线时的人工接管工具栏：三个按钮 30 秒内完成手动发文。 */
export function XhsManualFallbackBar({ workId, errorCode, errorMessage, state }: {
  workId: string
  errorCode?: string
  errorMessage?: string
  state?: string
}) {
  const [busy, setBusy] = useState<'title' | 'body' | 'images' | ''>('')
  const reason = formatXhsFallbackReason(errorCode, errorMessage, state)

  const ensureData = async (): Promise<XhsManualFallbackData | null> => {
    try {
      return await loadXhsManualFallbackData(workId)
    } catch (e: unknown) {
      toast.error(readError(e))
      return null
    }
  }

  const copyTitle = async () => {
    setBusy('title')
    try {
      const data = await ensureData()
      if (!data) return
      if (!data.title) { toast.info('该作品暂无标题，请先到作品页补充'); return }
      await copyText(data.title)
      toast.success('标题已复制，可直接粘贴到小红书')
    } catch (e: unknown) {
      toast.error(readError(e))
    } finally {
      setBusy('')
    }
  }

  const copyBody = async () => {
    setBusy('body')
    try {
      const data = await ensureData()
      if (!data) return
      const text = formatXhsBodyWithTags(data.body, data.tags)
      if (!text) { toast.info('该作品暂无正文，请先到作品页补充'); return }
      await copyText(text)
      toast.success('正文已复制（含内联 #话题），可直接粘贴到小红书')
    } catch (e: unknown) {
      toast.error(readError(e))
    } finally {
      setBusy('')
    }
  }

  const openImages = async () => {
    setBusy('images')
    try {
      // 非 Electron 浏览器态没有本机文件夹能力：直接下发布包 zip，不先白下载最多 18 张原图。
      if (!hasDesktopBridgeMethod('openXhsManualImageFolder')) {
        await downloadXhsPackZip(workId)
        toast.info('当前不是桌面端，已改为下载发布包 zip；解压后按编号顺序上传即可')
        return
      }
      const data = await ensureData()
      if (!data) return
      if (data.images.length === 0) { toast.info('该作品暂无可导出的图片'); return }
      if (data.images.length > MAX_EXPORT_FILES) toast.info('小红书一次最多 18 张图片，已只导出前 18 张')
      const files: Array<{ ext: 'png' | 'jpg' | 'webp' | 'gif'; bytes: Uint8Array }> = []
      let totalBytes = 0
      let skipped = 0
      let truncated = false
      for (const image of data.images.slice(0, MAX_EXPORT_FILES)) {
        const file = await downloadImageBytes(image.asset_id)
        // 单张 0 字节或超 20MB：跳过并记录，交给主进程前就挡掉。
        if (file.bytes.byteLength === 0 || file.bytes.byteLength > 20 * 1024 * 1024) {
          skipped += 1
          continue
        }
        if (totalBytes + file.bytes.byteLength > MAX_EXPORT_BYTES) {
          truncated = true
          break
        }
        totalBytes += file.bytes.byteLength
        files.push(file)
      }
      if (skipped > 0) toast.info(`已跳过 ${skipped} 张异常图片（0 字节或超过 20MB）`)
      if (truncated) toast.info('图片总量超过 100MB，已只导出前面的图片')
      if (files.length === 0) {
        toast.error(skipped > 0 ? '没有可导出的有效图片（0 字节或超过 20MB），请检查素材' : '图片下载失败，请稍后重试')
        return
      }
      const result = await openXhsManualImageFolder({ workId, files })
      if (result.ok) toast.success(`已按序导出 ${result.count} 张图片并打开文件夹（01_封面 起）`)
      else toast.error(result.message)
    } catch (e: unknown) {
      toast.error(readError(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div data-testid="xhs-manual-fallback-bar" className="mt-1.5 rounded-lg border border-gamboge-200 bg-gamboge-50/60 px-2 py-2">
      <p data-testid="xhs-manual-fallback-reason" className="text-[11px] leading-relaxed text-gamboge-800">{reason}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" loading={busy === 'title'} data-testid="xhs-fallback-copy-title"
          icon={<Copy className="size-3.5" />} onClick={() => void copyTitle()}>复制标题</Button>
        <Button size="sm" variant="secondary" loading={busy === 'body'} data-testid="xhs-fallback-copy-body"
          icon={<Copy className="size-3.5" />} onClick={() => void copyBody()}>复制正文（含内联 #话题）</Button>
        <Button size="sm" variant="ghost" loading={busy === 'images'} data-testid="xhs-fallback-open-images"
          icon={<FolderOpen className="size-3.5" />} onClick={() => void openImages()}>打开有序图片文件夹</Button>
      </div>
      <p className="mt-1 text-[10.5px] text-mist-500">不会代发：这里只把标题、正文与有序图片交给你，发布仍由你在小红书里完成。</p>
    </div>
  )
}
