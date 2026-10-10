import { BookmarkPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Field, Select, Textarea } from '@/components/ui'
import { Dialog } from '@/components/dialog'
import { errorMessage, post } from '@/lib/api'
import { useCurrentAccount } from '@/lib/session'
import type { MaterialKind } from '@/lib/types'

export function QuickCollect() {
  const acc = useCurrentAccount()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MaterialKind>('opinion')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        const sel = window.getSelection()?.toString().trim()
        if (sel) setText(sel)
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const save = async () => {
    if (!acc || !text.trim()) return
    setBusy(true)
    try {
      await post('/materials', { account_id: acc.id, kind, content: text.trim() })
      toast.success('已存入素材库')
      setOpen(false)
      setText('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  if (!acc) return null
  return (
    <>
      <button type="button" title="快速收集素材（Ctrl+Shift+M）"
        onClick={() => { const sel = window.getSelection()?.toString().trim(); if (sel) setText(sel); setOpen(true) }}
        className="fixed bottom-5 right-5 z-30 flex size-11 cursor-pointer items-center justify-center rounded-full border border-mist-200 bg-white text-ink-700 shadow-md hover:bg-mist-50">
        <BookmarkPlus className="size-5" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="存入素材库" desc={`默认归属当前账号「${acc.name}」`}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button variant="primary" loading={busy} disabled={!text.trim()} onClick={save}>保存</Button></>}>
        <div className="space-y-4">
          <Field label="类型">
            <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
              <option value="experience">经历</option>
              <option value="opinion">观点</option>
              <option value="case">案例</option>
              <option value="data">数据</option>
            </Select>
          </Field>
          <Field label="内容"><Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="选中文字后按 Ctrl+Shift+M，或在此粘贴" /></Field>
        </div>
      </Dialog>
    </>
  )
}
