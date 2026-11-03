import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, FileText, RefreshCw } from 'lucide-react'
import { Button, Card, Notice } from '@/components/ui'
import { ApiError, errorMessage, get, post, rawRequest } from '@/lib/api'
import { customTheme, renderWechatSections, createStableWechatHTML, themes as renderThemes, type FrozenWechatImage, type Theme } from '@/lib/render'
import { builtinThemeResources, wechatHTMLRendererContractVersion } from '@/lib/cx-render-contract'
import type { Section, Work } from '@/lib/types'
import type { WorkSaveCoordinator } from './work-save'

type BuildTarget = 'wechat_html' | 'stable_html' | 'long_image'
type BuildSummary = {
  id: string
  targets: BuildTarget[]
  basis_revision: number
  source_hash: string
  params_hash: string
  status: 'running' | 'built' | 'failed'
  error_code: string | null
  created_at: string
  expires_at: string | null
  is_current: boolean
}
type BuildPage = { items: BuildSummary[]; next_cursor: string | null }
type BuildCreate = {
  build_id: string
  status: BuildSummary['status']
  source_hash: string
  params_hash: string
  basis_revision: number
  source_snapshot: string | BuildSnapshot
  targets?: BuildTarget[]
  reused: boolean
}
type BuildSnapshot = {
  work: { title: string; revision: number }
  sections: Array<Pick<Section, 'id' | 'heading' | 'content_md'> & { position: number }>
  assets: Array<{ id: string; mime: string; bytes: number; sha256: string; width: number; height: number; alt_text: string; work_id: string | null }>
  theme: Record<string, unknown>
}
type BuildArtifact = { id: string; kind: string; name: string; mime: string; bytes: number; sha256: string; downloadable?: boolean }
type PrivacyFinding = { id: string; rule: string; severity: 'error' | 'warn'; field: string; section_id?: string; masked_excerpt: string }
type BuildDetail = {
  id: string
  status: BuildSummary['status']
  basis_revision: number
  source_hash: string
  is_current: boolean
  error_code: string | null
  targets: BuildTarget[]
  artifacts: BuildArtifact[]
  manifest?: Record<string, unknown>
  manifest_sha256?: string
  validation?: { privacy?: { report_hash: string; scanner_ok: boolean; policy_ready: boolean; errors: number; warnings: number; level: string; blocked_by: string[]; findings: PrivacyFinding[]; truncated: boolean }; [key: string]: unknown }
  download_gate: { allowed: boolean; reason: string; report_hash?: string }
}
type UploadedArtifact = { artifact_id: string; kind: string; name: string }

const targetLabels: Record<BuildTarget, string> = { wechat_html: '公众号预览 HTML', stable_html: '离线稳定版 HTML', long_image: '390px 真实长图（仅桌面）' }
const artifactForTarget: Record<BuildTarget, string> = { wechat_html: 'html', stable_html: 'stable_html', long_image: 'png' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function snapshotFrom(value: string | BuildSnapshot): BuildSnapshot {
  const snapshot = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!isRecord(snapshot) || !isRecord(snapshot.work) || !Array.isArray(snapshot.sections) || !Array.isArray(snapshot.assets) || !isRecord(snapshot.theme)) {
    throw new Error('构建冻结快照格式无效，请刷新构建记录后重试。')
  }
  if (typeof snapshot.work.title !== 'string' || !Number.isInteger(snapshot.work.revision)) throw new Error('冻结快照缺少标题或版本。')
  return snapshot as unknown as BuildSnapshot
}

function themeFromSnapshot(value: Record<string, unknown>): Theme {
  const id = value.id
  if (typeof id !== 'string') throw new Error('冻结快照没有主题标识。')
  if (id === 'custom') {
    const base = value.base_theme
    const custom = value.custom_theme
    if (!isRecord(base) || !isRecord(custom) || typeof base.id !== 'string') throw new Error('冻结自定义主题不完整。')
    const resource = builtinThemeResources[base.id as keyof typeof builtinThemeResources]
    if (!resource || base.version !== resource.version || base.token_digest !== resource.token_digest || custom.base !== base.id) {
      throw new Error('当前桌面版本不包含冻结主题资源，不能用其他版本代替。')
    }
    const lineHeight = Number(custom.line_height)
    if (!Number.isFinite(lineHeight)) throw new Error('冻结自定义主题行距无效。')
    return customTheme({
      base: custom.base as string,
      primary_color: custom.primary_color as string,
      font_size: custom.font_size as number,
      line_height: lineHeight,
      paragraph_gap: custom.paragraph_gap as number,
      heading_style: custom.heading_style as 'plain' | 'underline' | 'bar' | 'block',
      quote_style: custom.quote_style as 'bar' | 'box' | 'italic',
    })
  }
  const resource = builtinThemeResources[id as keyof typeof builtinThemeResources]
  if (!resource || value.version !== resource.version || value.token_digest !== resource.token_digest) {
    throw new Error('当前桌面版本不包含冻结主题资源，不能用其他版本代替。')
  }
  return (awaitTheme(id))
}

function awaitTheme(id: string): Theme {
  const theme = renderThemes.find(item => item.id === id)
  if (!theme) throw new Error('当前桌面版本缺少冻结主题样式。')
  return theme
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function frozenImages(snapshot: BuildSnapshot, imageIDs: string[]): Promise<FrozenWechatImage[]> {
  const uniqueIDs = [...new Set(imageIDs)]
  const assetByID = new Map(snapshot.assets.map(asset => [asset.id.toLowerCase(), asset]))
  const images: FrozenWechatImage[] = []
  for (const id of uniqueIDs) {
    const asset = assetByID.get(id.toLowerCase())
    if (!asset || asset.work_id === null) throw new Error(`图片 ${id} 未绑定到本作品，构建已停止。`)
    const response = await rawRequest('GET', `/assets/${encodeURIComponent(id)}/file`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error(`图片 ${id} 与冻结摘要不一致，构建已停止。`)
    images.push({ id, mime: asset.mime, bytes })
  }
  return images
}

async function uploadArtifact(buildID: string, kind: string, filename: string, data: Uint8Array, mime: string): Promise<UploadedArtifact> {
  const form = new FormData()
  form.append('kind', kind)
  form.append('sha256', await sha256(data))
  form.append('file', new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mime }), filename)
  const response = await rawRequest('POST', `/builds/${encodeURIComponent(buildID)}/artifacts`, form)
  const value = await response.json() as { artifact_id: string }
  if (!value.artifact_id) throw new Error('服务端没有返回产物标识。')
  return { artifact_id: value.artifact_id, kind, name: filename }
}

function mountLongImageSource(buildID: string, sourceHash: string, html: string): HTMLTextAreaElement {
  document.getElementById('ops-cx-long-image-source')?.remove()
  const source = document.createElement('textarea')
  source.id = 'ops-cx-long-image-source'
  source.dataset.buildId = buildID
  source.dataset.sourceHash = sourceHash
  source.hidden = true
  source.tabIndex = -1
  source.setAttribute('aria-hidden', 'true')
  source.value = html
  document.body.append(source)
  return source
}

async function downloadFile(path: string, fallbackName: string) {
  const response = await rawRequest('GET', path)
  const disposition = response.headers.get('Content-Disposition') || ''
  const utf8Name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const ordinaryName = /filename="?([^";]+)"?/i.exec(disposition)?.[1]
  const name = utf8Name ? decodeURIComponent(utf8Name) : ordinaryName || fallbackName
  const url = URL.createObjectURL(await response.blob())
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

export function BuildPanel({ work, coordinator, setWork, canWrite }: { work: Work; coordinator: WorkSaveCoordinator; setWork: (work: Work) => void; canWrite: boolean }) {
  const [targets, setTargets] = useState<BuildTarget[]>(['wechat_html'])
  const [history, setHistory] = useState<BuildSummary[]>([])
  const [detail, setDetail] = useState<BuildDetail | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const active = useRef(false)

  const refreshHistory = async (preferred?: string) => {
    const page = await get<BuildPage>(`/works/${work.id}/builds?limit=8`)
    setHistory(page.items)
    const selected = preferred || detail?.id || page.items[0]?.id
    if (selected) setDetail(await get<BuildDetail>(`/builds/${selected}`))
    else setDetail(null)
  }

  useEffect(() => {
    let alive = true
    void get<BuildPage>(`/works/${work.id}/builds?limit=8`).then(async page => {
      if (!alive) return
      setHistory(page.items)
      const pending = page.items.find(item => item.status === 'running')
      const selected = pending?.id || page.items[0]?.id
      if (selected) setDetail(await get<BuildDetail>(`/builds/${selected}`))
    }).catch(e => { if (alive) setError(errorMessage(e)) })
    return () => { alive = false }
  }, [work.id])

  const renderAndComplete = async (buildID: string, build: BuildCreate, requestedTargets: BuildTarget[]) => {
    const snapshot = snapshotFrom(build.source_snapshot)
    const sourceSections = snapshot.sections.map(section => ({ ...section, key_point: '', material_ids: [], origin: 'human' as const, source_section_ids: [], revision: 1, updated_at: '' }))
    const altAssets = snapshot.assets.map(asset => ({ id: asset.id, alt_text: asset.alt_text }))
    const theme = themeFromSnapshot(snapshot.theme)
    const rendered = renderWechatSections(sourceSections, theme, altAssets)
    const images = await frozenImages(snapshot, rendered.sections.flatMap(section => section.image_occurrences))
    const binaryHTML = new TextEncoder().encode(rendered.html)
    const byKind = new Map<string, UploadedArtifact>()
    let stableHTML: string | null = null
    if (requestedTargets.includes('wechat_html')) {
      byKind.set('html', await uploadArtifact(buildID, 'html', 'article.html', binaryHTML, 'text/html; charset=utf-8'))
    } else if (requestedTargets.includes('stable_html')) {
      byKind.set('html', await uploadArtifact(buildID, 'html', 'source.html', binaryHTML, 'text/html; charset=utf-8'))
    }
    if (requestedTargets.includes('stable_html') || requestedTargets.includes('long_image')) {
      stableHTML = createStableWechatHTML(rendered.html, snapshot.work.title, snapshot.work.revision, images)
    }
    if (requestedTargets.includes('stable_html') && stableHTML) {
      const stableArtifact = await uploadArtifact(buildID, 'stable_html', `revision-${snapshot.work.revision}-stable.html`, new TextEncoder().encode(stableHTML), 'text/html; charset=utf-8')
      byKind.set('stable_html', stableArtifact)
    }
    let longImageReceipt: Extract<NonNullable<Awaited<ReturnType<NonNullable<Window['opsDesktopUI']>['captureLongImage']>>>, { ok: true }> | null = null
    if (requestedTargets.includes('long_image')) {
      if (!stableHTML || !window.opsDesktopUI?.captureLongImage) throw new Error('当前桌面客户端不支持安全长图，请升级客户端后重试。')
      const source = mountLongImageSource(buildID, build.source_hash, stableHTML)
      try {
        const capture = await window.opsDesktopUI.captureLongImage(buildID)
        if (!capture.ok) throw new Error(capture.message)
        if (capture.buildId !== buildID || capture.sourceHash !== build.source_hash || capture.width !== 780 || capture.dpr !== 2) {
          throw new Error('长图与当前冻结构建版本不一致，原稿保持不变。')
        }
        byKind.set('png', await uploadArtifact(buildID, 'png', `revision-${snapshot.work.revision}-long.png`, capture.png, 'image/png'))
        longImageReceipt = capture
      } finally {
        source.remove()
      }
    }
    const pageInfo = { client: 'desktop', application_version: '0.1.0', renderer_contract_version: wechatHTMLRendererContractVersion,
      chromium_version: /Chrom(?:e|ium)\/([^ )]+)/.exec(navigator.userAgent)?.[1] || 'Electron Chromium',
      font_family: getComputedStyle(document.body).fontFamily || 'sans-serif', device_scale_factor: window.devicePixelRatio || 1,
      viewport_width: window.innerWidth, viewport_height: window.innerHeight,
      long_image: longImageReceipt ? {
        source_hash: longImageReceipt.sourceHash,
        capture_engine: longImageReceipt.captureEngine,
        capture_engine_version: longImageReceipt.captureEngineVersion,
        height_css: longImageReceipt.heightCss,
        dpr: longImageReceipt.dpr,
        viewport_width: longImageReceipt.viewportWidth,
        viewport_height: longImageReceipt.viewportHeight,
        segments: longImageReceipt.segments,
        check_scope: longImageReceipt.captureCheckScope,
        captured_at: longImageReceipt.capturedAt,
        font_family: longImageReceipt.fontFamily,
      } : undefined }
    const uploaded = requestedTargets.map(target => byKind.get(artifactForTarget[target])).filter((value): value is UploadedArtifact => !!value)
    const persisted = await get<BuildDetail>(`/builds/${buildID}`)
    const artifacts = uploaded.map(item => {
      const stored = persisted.artifacts.find(artifact => artifact.id === item.artifact_id)
      if (!stored) throw new Error('服务端未确认上传的产物索引。')
      return { ...item, name: stored.name }
    })
    if (artifacts.length !== requestedTargets.length) throw new Error('本次构建有目标产物未生成，未提交完成。')
    try {
      await post(`/builds/${buildID}/complete`, { source_hash: build.source_hash, params_hash: build.params_hash, artifacts, renderer_receipt: pageInfo })
      setNotice('构建校验已完成。')
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'scanner_unverified') throw e
      setNotice('结构、正文和图片校验已完成；产物包含阻断级隐私发现，服务端已阻止交付。')
    }
    await refreshHistory(buildID)
  }

  const start = async (resumeID?: string) => {
    if (active.current) return
    active.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await coordinator.flushAll()
      const current = await get<Work>(`/works/${work.id}`)
      setWork(current)
      let created: BuildCreate
      if (resumeID) {
        const existing = await get<BuildDetail & { params_hash: string; source_snapshot: BuildSnapshot; targets: BuildTarget[]; status: BuildSummary['status'] }>(`/builds/${resumeID}`)
        if (existing.status !== 'running') {
          setDetail(existing)
          return
        }
        created = { build_id: existing.id, status: existing.status, source_hash: existing.source_hash, params_hash: existing.params_hash,
          basis_revision: existing.basis_revision, source_snapshot: existing.source_snapshot, reused: true }
        await renderAndComplete(existing.id, created, existing.targets)
        return
      }
      if (targets.length === 0) throw new Error('请至少选择一种构建产物。')
      created = await post<BuildCreate>(`/works/${work.id}/builds`, { basis_revision: current.revision, targets, options: {}, client: 'desktop', renderer_contract_version: wechatHTMLRendererContractVersion })
      if (created.status !== 'running') {
        setNotice(created.status === 'built' ? '已复用同一冻结版本的历史构建。' : '该构建已进入终态。')
        await refreshHistory(created.build_id)
        return
      }
      await renderAndComplete(created.build_id, created, targets)
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'scanner_unverified' ? '产物包含阻断级隐私发现，构建保持阻断。' : errorMessage(e))
      await refreshHistory().catch(() => undefined)
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  const toggleTarget = (target: BuildTarget) => setTargets(current => current.includes(target) ? current.filter(item => item !== target) : [...current, target])
  const privacy = detail?.validation?.privacy
  const findings = privacy?.findings || []
  const allWarningsSelected = findings.filter(item => item.severity === 'warn').every(item => acknowledged.includes(item.id))
  const acknowledgeWarnings = async () => {
    if (!detail || !privacy || !allWarningsSelected) return
    setBusy(true)
    setError('')
    try {
      await post(`/builds/${detail.id}/privacy-ack`, { report_hash: privacy.report_hash, finding_ids: findings.filter(item => item.severity === 'warn').map(item => item.id) })
      setAcknowledged([])
      await refreshHistory(detail.id)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return <Card className="mt-6 space-y-4 p-5" data-testid="work-build-panel">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-mist-800"><FileText className="size-4" />交付构建</h2>
        <p className="mt-1 text-xs text-mist-500">校验冻结版本并保存检查报告；产物包含阻断级隐私发现时不开放下载。不会修改原稿或替你发布。</p>
      </div>
      <Button size="sm" variant="secondary" disabled={busy} icon={<RefreshCw className="size-3.5" />} onClick={() => void refreshHistory()}>刷新历史</Button>
    </div>
    <div className="flex flex-wrap gap-4">
      {(Object.keys(targetLabels) as BuildTarget[]).map(target => <label key={target} className="flex cursor-pointer items-center gap-2 text-xs text-mist-700">
        <input type="checkbox" checked={targets.includes(target)} disabled={busy} onChange={() => toggleTarget(target)} />{targetLabels[target]}
      </label>)}
    </div>
    <p className="text-[11px] text-mist-400">长图在本机隔离 Electron 窗口生成，并按固定像素和内存预算分段；下载仍受服务端隐私策略门禁控制。</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" loading={busy} disabled={busy || !canWrite || work.locked || targets.length === 0} onClick={() => void start()}>生成校验报告</Button>
      {history.length > 0 && <span className="text-[11px] text-mist-400">保留最近 {history.length} 次构建</span>}
    </div>
    {error && <Notice tone="red">{error}</Notice>}
    {notice && <Notice tone="gamboge">{notice}</Notice>}
    {history.length > 0 && <div className="space-y-1 border-t border-mist-100 pt-3">
      <h3 className="text-xs font-semibold text-mist-600">构建历史</h3>
      {history.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-mist-50">
        <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" onClick={() => void get<BuildDetail>(`/builds/${item.id}`).then(setDetail).catch(e => setError(errorMessage(e)))}>
          <span className="font-medium">{item.status === 'built' ? '已构建' : item.status === 'running' ? '处理中断/运行中' : '未完成'}</span>
          <span className="text-mist-500">第 {item.basis_revision} 版 · {item.targets.map(target => targetLabels[target]).join('、')}</span>
          {!item.is_current && <span className="text-gamboge-700">历史版本</span>}
          {item.error_code && <span className="truncate text-danger">{item.error_code}</span>}
        </button>
        {item.status === 'running' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void start(item.id)}>继续此构建</Button>}
      </div>)}
    </div>}
    {detail && <div className="space-y-3 border-t border-mist-100 pt-3" data-testid="build-detail">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong className="text-mist-800">构建状态：{detail.status === 'built' ? '已完成' : detail.status === 'running' ? '运行中' : '未完成'}</strong>
        <span className="text-mist-500">输入版本 {detail.basis_revision} · SHA256 {detail.source_hash.slice(0, 12)}</span>
        {!detail.is_current && <span className="text-gamboge-700">这是历史快照，不代表当前作品</span>}
      </div>
      {detail.error_code === 'scanner_unverified' && <Notice tone="gamboge">校验报告已保存。产物包含阻断级隐私发现（ERROR），构建未完成，请修改内容后重新构建。</Notice>}
      {privacy && <div className="rounded-lg border border-mist-200 bg-mist-50/60 p-3 text-xs">
        <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-3.5" />隐私扫描：{privacy.level} · ERROR {privacy.errors} · WARN {privacy.warnings}</div>
        {!privacy.policy_ready && <p className="mt-1 text-mist-600">未发布的规则决策：{privacy.blocked_by.join('、') || '扫描策略未就绪'}。未扫描图片二进制、EXIF 和图像内可见文字。</p>}
        {findings.map(finding => <label key={finding.id} className="mt-2 flex items-start gap-2 rounded-md bg-white p-2">
          {finding.severity === 'warn' && privacy.policy_ready && <input type="checkbox" checked={acknowledged.includes(finding.id)} onChange={event => setAcknowledged(current => event.target.checked ? [...current, finding.id] : current.filter(id => id !== finding.id))} />}
          <span><strong>{finding.severity.toUpperCase()} · {finding.field}</strong> · {finding.rule}<span className="block text-mist-500">{finding.masked_excerpt}</span></span>
        </label>)}
        {privacy.truncated && <p className="mt-2 text-danger">报告条目已截断，隐私 WARN 不可确认放行。</p>}
        {detail.download_gate.reason === 'viewer_ack_unavailable' && <p className="mt-2 text-mist-600">viewer 角色尚未获准写入本人知悉回执。</p>}
        {detail.download_gate.reason === 'privacy_ack_required' && <Button size="sm" className="mt-3" disabled={busy || !allWarningsSelected || privacy.truncated} onClick={() => void acknowledgeWarnings()}>提交本人逐项知悉回执</Button>}
      </div>}
      {detail.download_gate.reason && !detail.download_gate.allowed && <Notice tone="gray">下载门禁：{detail.download_gate.reason}</Notice>}
      {detail.artifacts.filter(item => item.downloadable).map(item => <div key={item.id} className="flex items-center justify-between rounded-md border border-mist-200 p-2 text-xs">
        <span>{item.name} · {item.bytes.toLocaleString()} 字节 · SHA256 {item.sha256.slice(0, 12)}</span>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!detail.download_gate.allowed} onClick={() => void downloadFile(`/builds/${detail.id}/artifacts/${item.id}`, item.name).catch(e => setError(errorMessage(e)))}>下载</Button>
      </div>)}
      {detail.download_gate.allowed && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void downloadFile(`/builds/${detail.id}/manifest.json`, 'manifest.json').catch(e => setError(errorMessage(e)))}>下载 manifest.json</Button>
        <Button size="sm" variant="secondary" onClick={() => void downloadFile(`/builds/${detail.id}/evidence.csv`, 'evidence.csv').catch(e => setError(errorMessage(e)))}>下载图片证据 CSV</Button>
      </div>}
    </div>}
  </Card>
}
