import { BookmarkPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Field, Select, Tabs, Textarea } from '@/components/ui'
import { Dialog } from '@/components/dialog'
import { VoiceButton } from '@/components/voice'
import { errorMessage, post } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { useCurrentAccount, useInvalidate } from '@/lib/session'
import type { MaterialKind } from '@/lib/types'

type Mode = 'inbox' | 'material'

/** openQuickCollect lets the command palette and other pages open the collector. */
export function openQuickCollect(mode: Mode, text = '', source?: 'palette') {
  window.dispatchEvent(new CustomEvent('ops:collect', { detail: { mode, text, source } }))
}

export function QuickCollect() {
  const acc = useCurrentAccount()
  const inv = useInvalidate()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('inbox')
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MaterialKind>('opinion')
  const [busy, setBusy] = useState(false)
  const [readPage, setReadPage] = useState(false)
  const [source, setSource] = useState<string | undefined>()
  useEffect(() => {
    const show = (m: Mode, preset?: string, from?: string) => {
      const sel = preset || window.getSelection()?.toString().trim()
      if (sel) setText(sel)
      setMode(m)
      setSource(from)
      setReadPage(false)
      setOpen(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'm') {
        e.preventDefault()
        show('material')
      } else if (k === 'i') {
        e.preventDefault()
        show('inbox')
      }
    }
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<{ mode: Mode; text: string; source?: string }>).detail
      show(d.mode, d.text, d.source)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('ops:collect', onEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('ops:collect', onEvent)
    }
  }, [])
  const save = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      if (mode === 'material') {
        if (!acc) return
        await post('/materials', { account_id: acc.id, kind, content: text.trim(), read_page: readPage && /https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text) })
        toast.success('已存入素材库')
        inv(['materials'])
      } else {
        await post('/inbox', { account_id: acc?.id ?? null, content: text.trim(), read_page: readPage && /https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text), source: source ?? (window.innerWidth < 768 ? 'mobile' : 'quick') })
        toast.success('已记入灵感收件箱', { description: '空闲时到选题池「收件箱」里逐条整理。' })
        inv(['inbox'])
      }
      setOpen(false)
      setText('')
      setReadPage(false)
      if (readPage) inv(['references'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" title="记一条灵感（Ctrl+Shift+I）/ 存素材（Ctrl+Shift+M）"
        onClick={() => { const sel = window.getSelection()?.toString().trim(); if (sel) setText(sel); setReadPage(false); setOpen(true) }}
        className="fixed bottom-20 right-4 z-30 flex size-11 cursor-pointer items-center justify-center rounded-full border border-mist-200 bg-white text-ink-700 shadow-md hover:bg-mist-50 md:bottom-5 md:right-5">
        <BookmarkPlus className="size-5" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="随手记"
        desc={mode === 'inbox' ? '先记下来，不用分类。之后在选题池「收件箱」里逐条转成选题或素材。' : acc ? `存入素材库，默认归属当前账号「${acc.name}」` : '请先选择账号'}
        footer={<>
          <span className="mr-auto text-[11.5px] text-mist-400">Ctrl+Enter 保存</span>
          <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!text.trim() || (mode === 'material' && !acc)} onClick={save}>保存</Button>
        </>}>
        <div className="space-y-4">
          <Tabs value={mode} onChange={setMode} items={[{ value: 'inbox', label: '灵感' }, { value: 'material', label: '素材' }]} />
          {mode === 'material' && (
            <Field label="类型">
              <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
                <option value="experience">经历</option>
                <option value="opinion">观点</option>
                <option value="case">案例</option>
                <option value="data">数据</option>
              </Select>
            </Field>
          )}
          <Field label={<span className="flex items-center justify-between">内容<VoiceButton onText={(t) => setText((v) => v + t)} /></span>}>
            <Textarea rows={6} autoFocus value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && isEnterWithoutComposition(e.nativeEvent)) { e.preventDefault(); void save() } }}
              placeholder={mode === 'inbox' ? '一句话也行：看到的、想到的、被问到的…' : '选中文字后按 Ctrl+Shift+M，或在此粘贴'} />
          </Field>
          {acc && /https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text) && <label className="flex items-center gap-2 text-sm text-mist-600"><input type="checkbox" checked={readPage} onChange={(e) => setReadPage(e.target.checked)} />读取页面为对标参考（受 robots 和限额约束，可手动粘贴）</label>}
        </div>
      </Dialog>
    </>
  )
}
