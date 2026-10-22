import { Check, CheckCircle2, Copy, Download, LayoutTemplate, Package, Smartphone, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { BackfillForm, PlatformBinding, PostPushTodos } from '@/components/backfill'
import { XhsCardMaker } from '@/components/xhs-cards'
import { Button, Card, cn, HumanGate, Notice } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, post, rawRequest } from '@/lib/api'
import { copyText, runeLen } from '@/lib/format'
import type { Work } from '@/lib/types'
import { useMe } from '@/lib/session'
import { useWork, WorkHeaderAction } from './WorkLayout'
import { ToutiaoPack } from './ToutiaoPack'

function CopyBlock({ label, meta, text, multiline }: { label: string; meta?: string; text: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await copyText(text)
    setCopied(true)
    toast.success(`${label}已复制`)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-mist-700">{label}</span>
        {meta && <span className="text-xs text-mist-400">{meta}</span>}
        <Button size="sm" variant={copied ? 'outline' : 'secondary'} className="ml-auto" onClick={copy} icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <div className={cn('rounded-lg bg-mist-50 px-3 py-2.5 text-[14.5px] text-mist-800', multiline ? 'max-h-80 overflow-y-auto whitespace-pre-wrap leading-[1.85]' : 'font-medium')}>
        {text || <span className="text-mist-400">（空）</span>}
      </div>
      <button onClick={copy} disabled={!text}
        className={cn('mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition sm:hidden',
          copied ? 'bg-emerald-50 text-emerald-700' : 'bg-ink-600 text-white active:bg-ink-700')}>
        {copied ? <><Check className="size-4" />已复制 ✓</> : <><Copy className="size-4" />复制{label}</>}
      </button>
    </Card>
  )
}

/** saveImages hands images to the system share sheet (save to album on phones), else downloads them one by one. */
async function saveImages(urls: string[], downloadZip: () => Promise<void>) {
  try {
    const files = await Promise.all(urls.map(async (u, i) => {
      const b = await (await fetch(u)).blob()
      return new File([b], `${String(i + 1).padStart(2, '0')}.${b.type.split('/')[1] || 'jpg'}`, { type: b.type })
    }))
    if (navigator.canShare?.({ files })) {
      await navigator.share({ files })
      return
    }
    for (const [i, f] of files.entries()) {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(f)
      a.download = f.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 400))
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    toast.info('浏览器不允许逐张保存，已改为下载 zip')
    await downloadZip()
  }
}

export default function Pack() {
  const nav = useNavigate()
  const { work, setWork, refresh } = useWork()
  const { data: me } = useMe()
  const canManage = me?.role === 'owner' || me?.role === 'editor'
  const [busy, setBusy] = useState(false)
  const [zipBusy, setZipBusy] = useState(false)
  const [pages, setPages] = useState<{ title: string; body: string }[] | null>(null)
  const [pageBusy, setPageBusy] = useState(false)
  const [cards, setCards] = useState(false)
  const maker = (
    <XhsCardMaker workId={work.id} pages={pages} open={cards} onClose={() => setCards(false)} onAdded={() => void refresh()}
      warn={work.status === 'packed' ? '加入新图片会修改作品内容，需要重新检查后再生成发布包。' : undefined} />
  )
  if (work.platform === 'toutiao') return <ToutiaoPack work={work} setWork={setWork} refresh={refresh} />
  const packed = work.status === 'packed' || work.status === 'published'
  const suggestPages = async () => {
    setPageBusy(true)
    try {
      const r = await post<{ pages: { title: string; body: string }[] }>(`/works/${work.id}/xhs/pages`)
      setPages(r.pages)
    } catch (e) {
      aiError(e, '分页文案建议', suggestPages)
    } finally {
      setPageBusy(false)
    }
  }
  const create = async () => {
    setBusy(true)
    try {
      setWork(await post<Work>(`/works/${work.id}/xhs/pack`, { basis_revision: work.revision }))
      // PB-02：发布包生成只是"去 App 发布"，发布后要能一键回到回填。
      toast.success('发布包已生成，去小红书 App 发布', {
        description: '发布完成后回来回填链接，这篇才会进入复盘。',
        action: { label: '去回填', onClick: () => nav(`/a/${work.account_id}/review?work=${work.id}`) },
      })
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'version_conflict'
      const materialBasisStale = e instanceof ApiError && e.code === 'material_basis_stale'
      const needsCheck = materialBasisStale || (e instanceof ApiError && e.code === 'human_step_required')
      toast.error(errorMessage(e), {
        duration: Number.POSITIVE_INFINITY,
        action: conflict
          ? { label: '刷新', onClick: () => void refresh() }
          : needsCheck ? undefined : { label: '重试', onClick: () => void create() },
        cancel: needsCheck ? { label: '去检查', onClick: () => nav(`/works/${work.id}/check`) } : undefined,
      })
    } finally {
      setBusy(false)
    }
  }
  const downloadZip = async () => {
    setZipBusy(true)
    try {
      const query = new URLSearchParams({ basis_revision: String(work.revision) })
      const response = await rawRequest('GET', `/works/${work.id}/xhs/pack.zip?${query}`)
      const responseBasis = response.headers.get('X-OPS-Basis-Revision')
      if (responseBasis && responseBasis !== String(work.revision)) {
        throw new ApiError(409, 'version_conflict', '作品已修改，请刷新后重新下载发布包')
      }
      const objectURL = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = objectURL
      link.download = `xhs-${new Date().toISOString().slice(0, 10)}.zip`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 10_000)
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'version_conflict'
      const materialBasisStale = e instanceof ApiError && e.code === 'material_basis_stale'
      toast.error(conflict ? '作品内容已变化，请刷新后重新下载发布包。' : errorMessage(e), {
        duration: Number.POSITIVE_INFINITY,
        action: conflict ? { label: '刷新', onClick: () => void refresh() } : undefined,
        cancel: materialBasisStale ? { label: '去检查', onClick: () => nav(`/works/${work.id}/check`) } : undefined,
      })
    } finally {
      setZipBusy(false)
    }
  }
  if (!packed && work.status !== 'ready') {
    return (
      <>
        <WorkHeaderAction><Button size="sm" variant="primary" onClick={() => nav(`/works/${work.id}/check`)}>去检查</Button></WorkHeaderAction>
        <div className="mx-auto max-w-2xl px-6 py-12">
          <HumanGate code="H-04">发布前检查还没有全部确认，不能生成发布包。</HumanGate>
        </div>
      </>
    )
  }
  if (!packed) {
    return (
      <>
        <WorkHeaderAction>
          <Button size="sm" variant="primary" loading={busy} onClick={create} icon={<Package className="size-4" />}>生成发布包</Button>
        </WorkHeaderAction>
        <div className="mx-auto max-w-xl px-6 py-16 text-center">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-xhs/10 text-xhs"><Package className="size-7" /></div>
          <h1 className="font-display text-[22px] font-bold text-mist-900">生成小红书发布包</h1>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-mist-500">发布包包含标题、正文、话题和按顺序编号的图片。你需要在小红书 App 或创作服务平台里亲自发布，系统不会代发。</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" variant="secondary" loading={pageBusy} onClick={suggestPages} icon={<Sparkles className="size-4" />}>分页文案建议</Button>
            <Button size="lg" variant="ghost" onClick={() => setCards(true)} icon={<LayoutTemplate className="size-4" />}>生成文字卡片</Button>
          </div>
          {maker}
          {pages && (
            <div className="mt-6 space-y-2 text-left">
              {pages.map((p, i) => (
                <div key={i} className="rounded-lg border border-mist-200 px-3 py-2.5">
                  <div className="text-[13.5px] font-semibold text-mist-800">{i + 1}. {p.title}</div>
                  <p className="mt-1 text-[13px] text-mist-600">{p.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    )
  }
  const comic = work.content_format === 'comic'
  const body = comic
    ? work.panels.map((p) => [p.narration, p.dialogue].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
    : work.sections.map((s) => s.content_md.trim()).filter(Boolean).join('\n\n')
  const topics = work.topics.map((t) => '#' + t).join(' ')
  const images = comic
    ? work.panels.map((p) => work.assets.find((a) => a.id === p.asset_id)).filter(Boolean)
    : work.assets
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8 2xl:max-w-[1400px]">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-[22px] font-bold text-mist-900">小红书发布包</h1>
          <p className="text-[13px] text-mist-500">{work.account_name} · 内容修订 {work.revision} · 在手机上打开本页也可以直接复制</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {/* PB-02：桌面端也要有一键回填（原来只有移动端底部按钮）。 */}
          {work.status === 'packed' && (
            <Button variant="primary" icon={<CheckCircle2 className="size-4" />}
              onClick={() => document.getElementById('backfill')?.scrollIntoView({ behavior: 'smooth' })}>
              我已发布，去回填
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Smartphone className="size-4" />}
            onClick={async () => {
              const text = [work.title, body, topics].filter(Boolean).join('\n\n')
              try {
                if (navigator.share) {
                  await navigator.share({ title: work.title, text })
                  toast.success('已唤起系统分享；请选择小红书或保存到备忘录')
                } else {
                  await copyText(text)
                  toast.success('已复制全文，可粘贴到小红书 App（浏览器不支持系统分享）')
                }
              } catch (e) {
                if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
              }
            }}
          >
            系统分享 / 复制
          </Button>
          <Button
            variant="ghost"
            icon={<Smartphone className="size-4" />}
            onClick={async () => {
              const q = new URLSearchParams()
              if (work.title) q.set('title', work.title)
              if (body) q.set('body', body)
              if (topics) q.set('topics', topics)
              const link = `ops-xhs://import?${q.toString()}`
              await copyText(link)
              toast.success('已复制伴侣深链；在已安装 OPS 分享伴侣的手机上打开')
            }}
          >
            复制伴侣深链
          </Button>
          <Button variant="primary" loading={zipBusy} onClick={() => void downloadZip()} icon={<Download className="size-4" />}>下载图片 zip</Button>
        </div>
      </div>
      <Notice tone="ink" className="mb-5">
        小红书官方分享 SDK 需独立移动 App 与开放平台资质（FR-M10-08）。当前提供 Web 系统分享、伴侣深链（<code className="rounded bg-mist-100 px-1">ops-xhs://</code>）与发布包；Expo 工程见 <code className="rounded bg-mist-100 px-1">mobile/</code>。
      </Notice>
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <CopyBlock label="标题" meta={`${runeLen(work.title)} 字`} text={work.title} />
          <CopyBlock label="正文" meta={`${runeLen(body)} 字`} text={body} multiline />
          <CopyBlock label="话题" meta="在小红书里用话题选择器逐个添加，才会变成可点击的话题" text={topics} />
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[13px] font-semibold text-mist-700">分页文案建议</span>
              <span className="text-xs text-mist-400">封面页 + 要点页，便于做成竖图</span>
              <Button size="sm" variant="secondary" className="ml-auto" loading={pageBusy} onClick={suggestPages} icon={<Sparkles className="size-3.5" />}>生成</Button>
              {work.status !== 'published' && <Button size="sm" variant="ghost" onClick={() => setCards(true)} icon={<LayoutTemplate className="size-3.5" />}>做成文字卡片</Button>}
            </div>
            {maker}
            {pages ? (
              <div className="space-y-2">
                {pages.map((p, i) => (
                  <div key={i} className="rounded-lg border border-mist-200 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-mist-400">{String(i + 1).padStart(2, '0')}</span>
                      <span className="text-[13.5px] font-semibold text-mist-800">{p.title}</span>
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => { await copyText(`${p.title}\n${p.body}`); toast.success('已复制') }}>复制</Button>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-mist-600">{p.body}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-mist-500">把笔记拆成若干图片页文案，方便在外部做图。</p>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[13px] font-semibold text-mist-700">图片</span>
              <span className="text-xs text-mist-400">{images.length} 张，按编号顺序上传；手机上可长按单张保存</span>
              {images.length > 0 && (
                <Button size="sm" variant="secondary" className="ml-auto" icon={<Download className="size-3.5" />}
                  onClick={() => saveImages(images.map((a) => a!.url), downloadZip)}>逐张保存到相册</Button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {images.map((a, i) => a && (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="relative overflow-hidden rounded-lg border border-mist-200">
                  <img src={a.url} alt="" className="aspect-[3/4] w-full object-cover" />
                  <span className="absolute left-1.5 top-1.5 rounded bg-mist-900/60 px-1.5 text-[11px] font-medium text-white">{String(i + 1).padStart(2, '0')}</span>
                </a>
              ))}
            </div>
          </Card>
        </div>
        <aside className="space-y-4">
          <HumanGate code="H-06">发布由你在小红书里亲自完成。系统不登录小红书，也不代发。</HumanGate>
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-mist-700"><Smartphone className="size-4" />发布步骤</div>
            <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-mist-600">
              <li>下载图片 zip 并保存到手机相册（或在本页长按保存）</li>
              <li>打开小红书，按编号顺序选择图片</li>
              <li>依次复制粘贴标题和正文</li>
              <li>用话题选择器添加话题</li>
              <li className="font-medium text-gamboge-700">在「笔记内容声明」中勾选「笔记含 AI 合成内容」</li>
              <li>发布后回到这里回填链接</li>
            </ol>
          </Card>
          <Notice tone="gamboge">AI 声明：内容使用了 AI 辅助时，按平台规则必须声明。漏标可能导致限流或处罚。</Notice>
          {(work.status === 'packed' || work.status === 'published') && (work.post_push_todos ?? []).length > 0 && <Card className="p-4"><PostPushTodos work={work} setWork={setWork} /></Card>}
          <div id="backfill" className="scroll-mt-20"><BackfillForm work={work} setWork={setWork} /></div>
          {(work.status === 'published' || work.status === 'packed') && (
            <PlatformBinding work={work} setWork={setWork} canManage={canManage} />
          )}
        </aside>
      </div>
      {work.status === 'packed' && (
        <div className="sticky bottom-16 z-20 mt-6 sm:hidden">
          <Button variant="primary" size="lg" className="w-full shadow-pop" onClick={() => document.getElementById('backfill')?.scrollIntoView({ behavior: 'smooth' })}>
            我已在小红书发布，去回填
          </Button>
        </div>
      )}
    </div>
  )
}
