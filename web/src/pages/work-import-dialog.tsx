import { useRef, useState, type ClipboardEvent } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, Field, Input, Textarea } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { clipboardHtmlToMarkdown, parseLegacyArticle, type LegacyArticleSection } from '@/lib/legacy-article'
import type { Work } from '@/lib/types'

export function WorkImportDialog({ accountId, onClose, onImported }: { accountId: string; onClose: () => void; onImported: (id: string) => void }) {
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [publishedDate, setPublishedDate] = useState('')
  const [sections, setSections] = useState<LegacyArticleSection[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const preview = () => {
    setError('')
    if (!title.trim()) {
      setError('请填写作品标题')
      return
    }
    const parsed = parseLegacyArticle(body)
    if (!parsed.length) {
      setError('请粘贴包含正文的旧文')
      return
    }
    setSections(parsed)
  }

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const html = event.clipboardData.getData('text/html')
    if (!html) return
    const converted = clipboardHtmlToMarkdown(html)
    if (!converted) return
    event.preventDefault()
    const field = event.currentTarget
    const start = field.selectionStart
    const end = field.selectionEnd
    const next = body.slice(0, start) + converted + body.slice(end)
    setBody(next)
    setSections(null)
    requestAnimationFrame(() => {
      field.focus()
      field.setSelectionRange(start + converted.length, start + converted.length)
    })
  }

  const submit = async () => {
    if (!sections || busy) return
    setBusy(true)
    setError('')
    try {
      const work = await post<Work>(`/accounts/${accountId}/works/import`, {
        confirm_published: true,
        title: title.trim(),
        published_date: publishedDate || undefined,
        sections,
      })
      toast.success('旧文已导入为已发布作品')
      onImported(work.id)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="导入已发布旧文" desc="只导入一篇公众号长图文。粘贴内容后预览分段，确认它已经在公众号发表后再导入。" width="max-w-3xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        {!sections ? <Button variant="primary" onClick={preview}>预览分段</Button> : <>
          <Button variant="secondary" onClick={() => { setSections(null); setError('') }}>返回编辑</Button>
          <Button variant="human" loading={busy} onClick={submit}>确认导入为已发布作品</Button>
        </>}
      </>}>
      <div className="space-y-4">
        <Field label="作品标题" required hint="最多64字；导入前请先删减超长标题。">
          <Input aria-label="作品标题" value={title} maxLength={64} onChange={e => setTitle(e.target.value)} placeholder="输入原文标题" />
        </Field>
        <Field label="发布日期" hint="可留空；填写后用于数据回填">
          <Input aria-label="发布日期" type="date" value={publishedDate} onChange={e => setPublishedDate(e.target.value)} />
        </Field>
        <Field label="旧文正文" hint="支持 Markdown 小标题，也可直接粘贴公众号富文本。">
          <Textarea ref={bodyRef} aria-label="旧文正文" value={body} onPaste={paste} onChange={e => { setBody(e.target.value); setSections(null) }} rows={12} className="resize-y font-mono text-[13px]" placeholder={'粘贴或输入旧文正文，例如：\n\n## 小标题\n正文内容……'} />
        </Field>
        {sections && <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-mist-200 bg-mist-50 p-3">
          {sections.map(section => <section key={`${section.heading}-${section.content_md.slice(0, 32)}`} data-testid="import-preview-section" className="rounded-md bg-white p-3">
            <h3 className="text-sm font-semibold text-mist-800">{section.heading || '未命名段落'}</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-mist-600">{section.content_md}</p>
          </section>)}
        </div>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  )
}
