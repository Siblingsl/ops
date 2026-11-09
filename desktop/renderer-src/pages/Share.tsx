import { BookOpen, Inbox } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { VoiceButton } from '@/components/voice'
import { Button, Card, cn, Field, PageHeader, Select, Textarea } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { useCurrentAccount } from '@/lib/session'
import type { MaterialKind } from '@/lib/types'
import { kindMeta } from './Materials'

type Dest = 'inbox' | 'material'

/** Share target (PWA, EX-O-01): text shared from other apps lands here; the user picks inbox or material library — one item, nothing automatic. */
export default function SharePage() {
  const [params] = useSearchParams()
  const acc = useCurrentAccount()
  const nav = useNavigate()
  const initial = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join('\n')
  const [text, setText] = useState(initial)
  const [dest, setDest] = useState<Dest>('inbox')
  const [kind, setKind] = useState<MaterialKind>('case')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      if (dest === 'inbox') {
        await post('/inbox', { account_id: acc?.id ?? null, content: text.trim(), source: 'share' })
        toast.success('已记入灵感收件箱')
        nav(acc ? `/a/${acc.id}/topics?tab=inbox` : '/')
      } else {
        await post('/materials', { account_id: acc?.id ?? null, kind, content: text.trim(), source: (params.get('url') || '分享').slice(0, 200) })
        toast.success('已存入素材库')
        nav(acc ? `/a/${acc.id}/materials` : '/')
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const opt = (d: Dest, icon: React.ReactNode, label: string, desc: string) => (
    <button type="button" onClick={() => setDest(d)} aria-pressed={dest === d}
      className={cn('flex flex-1 cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-left transition', dest === d ? 'border-ink-400 bg-ink-50' : 'border-mist-200 hover:border-mist-300')}>
      <span className="mt-0.5 text-ink-600 [&_svg]:size-4">{icon}</span>
      <span><span className="block text-[13.5px] font-semibold text-mist-800">{label}</span><span className="mt-0.5 block text-[11.5px] leading-snug text-mist-500">{desc}</span></span>
    </button>
  )
  return (
    <div className="mx-auto max-w-xl animate-fade-in">
      <PageHeader title="保存分享内容" desc="从其他应用分享过来的内容，先存下来，之后再逐条整理。" />
      <Card className="p-5">
        <div className="mb-4 flex gap-2">
          {opt('inbox', <Inbox />, '灵感收件箱', '还没想好怎么用，之后在选题池「收件箱」里整理')}
          {opt('material', <BookOpen />, '素材库', '是可以直接引用的经历、案例、数据或观点')}
        </div>
        {dest === 'material' && (
          <Field label="素材类型">
            <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
              {(Object.keys(kindMeta) as MaterialKind[]).map((k) => <option key={k} value={k}>{kindMeta[k].label}</option>)}
            </Select>
          </Field>
        )}
        <Field label={<span className="flex items-center justify-between">内容<VoiceButton onText={(t) => setText((v) => v + t)} /></span>}>
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="分享的文字或链接" />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => nav(-1)}>取消</Button>
          <Button variant="primary" icon={dest === 'inbox' ? <Inbox className="size-4" /> : <BookOpen className="size-4" />} loading={busy} disabled={!text.trim()} onClick={save}>
            {dest === 'inbox' ? '存入收件箱' : '存入素材库'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
