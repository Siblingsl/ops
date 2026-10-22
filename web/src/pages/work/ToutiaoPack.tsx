import { AlertTriangle, Check, Copy, Download, ExternalLink, FileText, Image as ImageIcon, Package } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { QRCodeSVG } from 'qrcode.react'
import { confirm } from '@/components/dialog'
import { BackfillForm, PostPushTodos } from '@/components/backfill'
import { Button, Card, Empty, HumanGate, Notice, PageLoading, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, post, rawRequest } from '@/lib/api'
import { copyText, fmtTime } from '@/lib/format'
import type { Work } from '@/lib/types'
import { useCanWrite } from '@/lib/session'
import { WorkHeaderAction } from './WorkLayout'

interface ToutiaoPackImage {
  asset_id: string
  file: string
  url: string
  position?: number
  mime: string
  ai_generated: boolean
  alt_text?: string
  uses?: { section_id: string; ordinal: number; alt: string }[]
}

interface ToutiaoPackView {
  work_id: string
  platform: 'toutiao'
  content_format: 'long_article' | 'micro_post'
  basis_revision: number
  internal_title: string
  publish_title: string | null
  body_text: string
  body_chars: number
  topics: string[]
  instructions: string
  images: ToutiaoPackImage[]
  warnings: string[]
}

function CopyField({ label, value, multiline = false, validate }: { label: string; value: string; multiline?: boolean; validate: () => Promise<void> }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await validate()
    } catch (e) {
      toast.error(errorMessage(e))
      return
    }
    try {
      await copyText(value)
      setCopied(true)
      toast.success(`${label}已复制`)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.info('浏览器未允许复制；可点击文本框后手动复制')
    }
  }
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-mist-700">{label}</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void copy()} icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
          {copied ? '已复制' : `复制${label}`}
        </Button>
      </div>
      <Textarea readOnly aria-label={`${label}文本`} value={value} rows={multiline ? 11 : 2}
        className={multiline ? 'max-h-80 resize-y whitespace-pre-wrap break-words' : 'resize-y'} />
    </Card>
  )
}

export function ToutiaoPack({ work, setWork, refresh }: { work: Work; setWork: (w: Work) => void; refresh: () => Promise<unknown> }) {
  const nav = useNavigate()
  const canWrite = useCanWrite()
  const packed = work.status === 'packed' || work.status === 'published'
  const [pack, setPack] = useState<ToutiaoPackView | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [zipBusy, setZipBusy] = useState(false)
  const [shareLink, setShareLink] = useState<{ token: string; expires_at: string } | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const article = work.content_format === 'long_article'
  useEffect(() => setShareLink(null), [work.id, work.revision])

  const loadPack = async () => {
    setLoading(true)
    setLoadError(undefined)
    try {
      const query = new URLSearchParams({ basis_revision: String(work.revision) })
      setPack(await get<ToutiaoPackView>(`/works/${work.id}/toutiao/pack?${query}`))
    } catch (e) {
      setLoadError(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!packed) {
      setPack(null)
      setLoadError(undefined)
      return
    }
    let live = true
    setLoading(true)
    setLoadError(undefined)
    const query = new URLSearchParams({ basis_revision: String(work.revision) })
    void get<ToutiaoPackView>(`/works/${work.id}/toutiao/pack?${query}`).then((result) => {
      if (live) setPack(result)
    }).catch((e) => {
      if (live) setLoadError(e)
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [packed, work.id, work.revision])

  const create = async () => {
    setBusy(true)
    try {
      const result = await post<ToutiaoPackView>(`/works/${work.id}/toutiao/pack`, { basis_revision: work.revision })
      setPack(result)
      await refresh()
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'version_conflict'
      const materialStale = e instanceof ApiError && e.code === 'material_basis_stale'
      const needsCheck = materialStale || (e instanceof ApiError && e.code === 'human_step_required')
      toast.error(errorMessage(e), {
        duration: Number.POSITIVE_INFINITY,
        action: conflict ? { label: '刷新作品', onClick: () => void refresh() } : undefined,
        cancel: needsCheck ? { label: '去检查', onClick: () => nav(`/works/${work.id}/check`) } : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    setZipBusy(true)
    try {
      const query = new URLSearchParams({ basis_revision: String(work.revision) })
      const response = await rawRequest('GET', `/works/${work.id}/toutiao/pack.zip?${query}`)
      if (response.headers.get('X-OPS-Basis-Revision') !== String(work.revision)) {
        throw new ApiError(409, 'version_conflict', '作品已修改，请刷新后重新下载发布包')
      }
      const objectURL = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = objectURL
      link.download = `toutiao-${new Date().toISOString().slice(0, 10)}.zip`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 10_000)
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'version_conflict'
      const materialStale = e instanceof ApiError && e.code === 'material_basis_stale'
      toast.error(errorMessage(e), {
        duration: Number.POSITIVE_INFINITY,
        action: conflict ? { label: '刷新作品', onClick: () => void refresh() } : undefined,
        cancel: materialStale ? { label: '去检查', onClick: () => nav(`/works/${work.id}/check`) } : undefined,
      })
    } finally {
      setZipBusy(false)
    }
  }

  if (work.status !== 'ready' && !packed) {
    return (
      <>
        <WorkHeaderAction><Button size="sm" variant="primary" onClick={() => nav(`/works/${work.id}/check`)}>去检查</Button></WorkHeaderAction>
        <div className="mx-auto max-w-2xl px-6 py-12"><HumanGate code="H-04">发布前检查还没有全部确认，不能生成今日头条发布包。</HumanGate></div>
      </>
    )
  }

  if (!packed) {
    return (
      <>
        <WorkHeaderAction>
          <Button size="sm" variant="primary" disabled={!canWrite} loading={busy} onClick={() => void create()} icon={<Package className="size-4" />}>生成发布包</Button>
        </WorkHeaderAction>
        <main className="mx-auto w-full max-w-[760px] px-4 py-8 sm:px-6 sm:py-12">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-[#ed1c24]/10 text-[#c9161d]"><Package className="size-7" /></div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#c9161d]">今日头条 · {article ? '文章' : '微头条'}</p>
            <h1 className="mt-1 font-display text-[22px] font-bold text-mist-900">准备人工发布包</h1>
            <p className="mx-auto mt-2 max-w-xl text-[13.5px] leading-relaxed text-mist-500">发布包会按作品当前修订生成文字、图片映射和离线说明。系统不登录头条号，也不会代替你发布。</p>
          </div>
          <Notice tone="ink" className="mb-5">
            头条平台篇幅与图片上限尚待真实账号实测，本系统不按未核实数字阻断。请在头条发布页预览并遵循当前提示。
          </Notice>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="p-4">
              <div className="flex items-start gap-3"><FileText className="mt-0.5 size-4 shrink-0 text-mist-500" /><div><p className="text-[13px] font-semibold text-mist-800">按修订号交付</p><p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">作品修订 {work.revision}；文字、图片与清单使用同一修订。</p></div></div>
            </Card>
            <Card className="p-4">
              <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-gamboge-600" /><div><p className="text-[13px] font-semibold text-mist-800">声明需要本人核对</p><p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">AI 声明、原创资格和首发条件分别核实；首发默认不选。</p></div></div>
            </Card>
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button size="lg" variant="secondary" onClick={() => window.open('https://mp.toutiao.com/', '_blank', 'noopener,noreferrer')} icon={<ExternalLink className="size-4" />}>打开头条号后台</Button>
            <Button size="lg" variant="primary" disabled={!canWrite} loading={busy} onClick={() => void create()} icon={<Package className="size-4" />}>生成当前修订发布包</Button>
          </div>
        </main>
      </>
    )
  }

  if (loading) return <div className="mx-auto max-w-4xl px-4 py-8"><PageLoading /></div>
  if (loadError || !pack) {
    return <main className="mx-auto max-w-2xl px-4 py-8"><Empty title="发布包读取失败" desc={errorMessage(loadError)} action={<Button variant="secondary" onClick={() => void loadPack()}>重新读取</Button>} /></main>
  }
  if (pack.basis_revision !== work.revision) {
    return <main className="mx-auto max-w-2xl px-4 py-8"><Notice tone="red">作品已变化，当前发布包基于修订 {pack.basis_revision}，页面当前修订为 {work.revision}。请刷新后重新检查和打包。</Notice><Button className="mt-4" variant="secondary" onClick={() => void refresh()}>刷新作品</Button></main>
  }

  const topics = pack.topics.map((topic) => `#${topic.replace(/^#/, '')}`).join('\n')
  const combined = [pack.body_text, pack.topics
    .map((topic) => `#${topic.replace(/^#/, '')}`)
    .filter((topic) => !new RegExp(`${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(pack.body_text))
    .join('\n')].filter(Boolean).join('\n\n')
  const validateCopy = async () => {
    const query = new URLSearchParams({ basis_revision: String(pack.basis_revision) })
    const current = await get<ToutiaoPackView>(`/works/${work.id}/toutiao/pack?${query}`)
    if (current.basis_revision !== pack.basis_revision) {
      throw new ApiError(409, 'version_conflict', '作品已修改，请刷新后重新检查和打包')
    }
  }
  const imageLocation = (image: ToutiaoPackImage) => {
    if (!article) return `上传顺序 ${image.position ?? 0}`
    return (image.uses ?? []).map((use) => {
      const sectionIndex = work.sections.findIndex((section) => section.id === use.section_id)
      const heading = sectionIndex >= 0 ? work.sections[sectionIndex].heading.trim() : ''
      return `${heading || `正文段落 ${sectionIndex + 1}`} · 第 ${use.ordinal} 张`
    }).join('；')
  }
  const createShare = async () => {
    if (!(await confirm({ title: '生成匿名分享预览？', desc: '持有链接的人无需登录即可查看当前发布内容和图片，链接 24 小时后失效。作品修改或检查依据失效后，旧链接立即失效。', confirmText: '生成分享链接' }))) return
    setShareBusy(true)
    try {
      await validateCopy()
      setShareLink(await post<{ token: string; expires_at: string }>(`/works/${work.id}/preview-link`, { basis_revision: pack.basis_revision }))
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'version_conflict'
      toast.error(conflict ? '作品已修改，请刷新后重新确认分享内容。' : errorMessage(e), {
        action: conflict ? { label: '刷新作品', onClick: () => void refresh() } : undefined,
      })
    } finally { setShareBusy(false) }
  }
  const shareURL = shareLink ? `${window.location.origin}/preview/${shareLink.token}` : ''

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8 2xl:max-w-[1400px]">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#c9161d]">今日头条 · {article ? '文章' : '微头条'}</p>
          <h1 className="mt-1 font-display text-[22px] font-bold text-mist-900">发布包</h1>
          <p className="mt-1 text-[13px] text-mist-500">{work.account_name} · 修订 {pack.basis_revision} · 手动发布后回填真实链接和时间</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button variant="secondary" icon={<ExternalLink className="size-4" />} onClick={() => window.open('https://mp.toutiao.com/', '_blank', 'noopener,noreferrer')}>打开头条号后台</Button>
          <Button variant="primary" loading={zipBusy} onClick={() => void download()} icon={<Download className="size-4" />}>下载完整发布包</Button>
        </div>
      </div>
      <Notice tone="ink" className="mb-5">这是系统当前内容的交付包，不代表头条已收到、审核通过或发布。遇到审核中或状态不明时，请先核实平台状态，再填写实际发布时间。</Notice>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 space-y-4">
          {article && pack.publish_title && <CopyField label="发布标题" value={pack.publish_title} validate={validateCopy} />}
          {!article && <Notice tone="gray">“{pack.internal_title}”仅为系统内部名称，不会写入微头条发布正文。</Notice>}
          <CopyField label="发布正文" value={pack.body_text} multiline validate={validateCopy} />
          {!article && pack.topics.length > 0 && <CopyField label="正文与话题" value={combined} multiline validate={validateCopy} />}
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2"><span className="text-[13px] font-semibold text-mist-700">话题</span><span className="text-xs text-mist-400">在头条话题选择器中逐个核对和关联</span></div>
            <Textarea readOnly aria-label="头条话题" value={topics} rows={Math.max(2, Math.min(6, pack.topics.length || 2))} className="resize-y" placeholder="暂无系统话题" />
          </Card>
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ImageIcon className="size-4 text-mist-500" />
              <span className="text-[13px] font-semibold text-mist-700">配图</span>
              <span className="text-xs text-mist-400">{pack.images.length ? `${pack.images.length} 张，按文件名／位置说明上传` : '无图；微头条允许纯文字发布'}</span>
            </div>
            {pack.images.length > 0 ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {pack.images.map((image, index) => <div key={image.asset_id} className="min-w-0 overflow-hidden rounded-lg border border-mist-200">
                <img src={image.url} alt={image.uses?.[0]?.alt || image.alt_text || ''} loading="lazy" className="aspect-[4/3] w-full bg-mist-50 object-contain" />
                <div className="space-y-1 p-2"><p className="truncate text-xs font-semibold text-mist-700">{String(index + 1).padStart(2, '0')} · {image.file.split('/').pop()}</p><p className="break-words text-[11px] leading-relaxed text-mist-500">{imageLocation(image)}</p>{image.ai_generated && <p className="text-[11px] text-gamboge-700">保留 AI 生成标识，请发布前核对</p>}</div>
              </div>)}
            </div> : <p className="text-[13px] text-mist-500">当前作品没有需要导出的图片。</p>}
          </Card>
          <Card className="p-4">
            <p className="mb-2 text-[13px] font-semibold text-mist-700">发布步骤与格式说明</p>
            <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-mist-600">{pack.instructions}</pre>
          </Card>
          {pack.warnings.map((warning) => <Notice key={warning} tone="gamboge">{warning}</Notice>)}
        </section>
        <aside className="space-y-4">
          <Card className="space-y-3 p-4">
            <h2 className="text-[13px] font-semibold text-mist-700">分享内容预览</h2>
            <p className="text-[12.5px] leading-relaxed text-mist-500">由你主动生成；持有链接即可匿名查看发布内容，24 小时后失效。预览不代表平台已发布。</p>
            <Button size="sm" variant="secondary" disabled={!canWrite} loading={shareBusy} onClick={() => void createShare()}>生成 24 小时分享预览</Button>
            {shareLink && <>
              <a href={shareURL} target="_blank" rel="noopener noreferrer" className="block break-all text-[13px] text-ink-700 underline">打开分享预览</a>
              <p className="text-xs text-mist-500">有效期至 {fmtTime(shareLink.expires_at)}</p>
              <div className="inline-flex rounded-lg bg-white p-2"><QRCodeSVG value={shareURL} size={128} /></div>
              <Button size="sm" variant="ghost" onClick={() => void validateCopy().then(() => copyText(shareURL)).then(() => toast.success('分享链接已复制')).catch(e => toast.error(errorMessage(e)))}>复制分享链接</Button>
            </>}
          </Card>
          <HumanGate code="H-06">请在头条号后台亲自核对排版并发布。系统不会登录头条号或代发。</HumanGate>
          <Card className="p-4">
            <p className="mb-2 text-[13px] font-semibold text-mist-700">手动发布清单</p>
            <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-mist-600">
              <li>下载完整发布包并解压。</li>
              {article ? <><li>复制发布标题和正文，按图片映射逐张上传；封面在头条发布页选择。</li><li>预览基础排版，核实话题与链接。</li></> : <><li>复制正文并按顺序上传配图，内部名称不会作为发布标题。</li><li>在平台话题选择器里核对并关联话题。</li></>}
              <li>按实际情况处理 AI 内容声明，核实原创资格；首发默认不选。</li>
              <li>由你本人发布；审核或状态不明时不填写猜测时间。</li>
              <li>发布后回到下方回填实际链接和发布时间。</li>
            </ol>
          </Card>
          {work.post_push_todos?.length ? <Card className="p-4"><PostPushTodos work={work} setWork={setWork} /></Card> : null}
          <div id="backfill" className="scroll-mt-20"><BackfillForm work={work} setWork={setWork} /></div>
        </aside>
      </div>
      {work.status === 'packed' && <div className="sticky bottom-16 z-20 mt-6 sm:hidden"><Button variant="primary" size="lg" className="w-full shadow-pop" onClick={() => document.getElementById('backfill')?.scrollIntoView({ behavior: 'smooth' })}>我已在头条发布，去回填</Button></div>}
    </main>
  )
}
