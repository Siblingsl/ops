import { Check, Copy, Download, Package, Smartphone } from 'lucide-react'
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
  const packed = work.status === 'packed' || work.status === 'published'
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
        <Button variant="primary" size="lg" className="mt-6" loading={busy} onClick={create} icon={<Package className="size-4" />}>生成发布包</Button>
      </div>
    )
  }
  const body = work.sections.map((s) => s.content_md.trim()).filter(Boolean).join('\n\n')
  const topics = work.topics.map((t) => '#' + t).join(' ')
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
              <span className="text-[13px] font-semibold text-mist-700">图片</span>
              <span className="text-xs text-mist-400">{work.assets.length} 张，按编号顺序上传</span>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {work.assets.map((a, i) => (
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
