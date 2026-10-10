import { Check, Copy, Download, Package, Smartphone, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { BackfillForm } from '@/components/backfill'
import { Button, Card, cn, HumanGate, Notice } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { copyText, runeLen } from '@/lib/format'
import type { Work } from '@/lib/types'
import { useWork } from './WorkLayout'

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
    </Card>
  )
}

export default function Pack() {
  const { work, setWork } = useWork()
  const [busy, setBusy] = useState(false)
  const [pages, setPages] = useState<{ title: string; body: string }[] | null>(null)
  const [pageBusy, setPageBusy] = useState(false)
  const packed = work.status === 'packed' || work.status === 'published'
  const suggestPages = async () => {
    setPageBusy(true)
    try {
      const r = await post<{ pages: { title: string; body: string }[] }>(`/works/${work.id}/xhs/pages`)
      setPages(r.pages)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPageBusy(false)
    }
  }
  const create = async () => {
    setBusy(true)
    try {
      setWork(await post<Work>(`/works/${work.id}/xhs/pack`))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  if (!packed && work.status !== 'ready') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <HumanGate code="H-04">发布前检查还没有全部确认，不能生成发布包。<Link to={`/works/${work.id}/check`} className="ml-1 font-semibold underline">去检查</Link></HumanGate>
      </div>
    )
  }
  if (!packed) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-xhs/10 text-xhs"><Package className="size-7" /></div>
        <h1 className="font-display text-[22px] font-bold text-mist-900">生成小红书发布包</h1>
        <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-mist-500">发布包包含标题、正文、话题和按顺序编号的图片。你需要在小红书 App 或创作服务平台里亲自发布，系统不会代发。</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button variant="primary" size="lg" loading={busy} onClick={create} icon={<Package className="size-4" />}>生成发布包</Button>
          <Button size="lg" variant="secondary" loading={pageBusy} onClick={suggestPages} icon={<Sparkles className="size-4" />}>分页文案建议</Button>
        </div>
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
          <p className="text-[13px] text-mist-500">{work.account_name} · 在手机上打开本页也可以直接复制</p>
        </div>
        <a href={`/api/v1/works/${work.id}/xhs/pack.zip`} download className="sm:ml-auto">
          <Button variant="primary" icon={<Download className="size-4" />}>下载图片 zip</Button>
        </a>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <CopyBlock label="标题" meta={`${runeLen(work.title)} 字`} text={work.title} />
          <CopyBlock label="正文" meta={`${runeLen(body)} 字`} text={body} multiline />
          <CopyBlock label="话题" meta="在小红书里用话题选择器逐个添加，才会变成可点击的话题" text={topics} />
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[13px] font-semibold text-mist-700">分页文案建议</span>
              <span className="text-xs text-mist-400">封面页 + 要点页，便于做成竖图</span>
              <Button size="sm" variant="secondary" className="ml-auto" loading={pageBusy} onClick={suggestPages} icon={<Sparkles className="size-3.5" />}>生成</Button>
            </div>
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
              <span className="text-xs text-mist-400">{images.length} 张，按编号顺序上传</span>
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
          <BackfillForm work={work} setWork={setWork} />
        </aside>
      </div>
    </div>
  )
}
