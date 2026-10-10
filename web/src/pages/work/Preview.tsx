import { ArrowRight, Check, Copy, Smartphone, Wand2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { AIFeedback } from '@/components/refs'
import { Button, Card, cn, Notice } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { errorMessage, get, patch, post } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { CUSTOM_THEME_ID, customTheme, HTML_BYTE_LIMIT, HTML_CHAR_LIMIT, htmlStats, renderWechat, setCustomTheme, themeById, themes } from '@/lib/render'
import type { Work } from '@/lib/types'
import { useCustomTheme } from '@/lib/v3'
import { useWork } from './WorkLayout'

export function PhoneFrame({ title, account, children }: { title: string; account: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-[390px] shrink-0 rounded-[44px] border border-mist-300 bg-mist-900 p-3 shadow-[0_30px_60px_-20px_rgba(20,30,40,.35)]">
      <div className="overflow-hidden rounded-[34px] bg-white">
        <div className="flex h-11 items-center justify-between px-7 text-[12px] font-semibold text-mist-900">
          <span>9:41</span>
          <span className="h-[22px] w-24 rounded-full bg-mist-900" />
          <span className="flex gap-1"><span className="size-2 rounded-full bg-mist-800" /><span className="size-2 rounded-full bg-mist-800" /></span>
        </div>
        <div className="scrollbar-thin h-[680px] overflow-y-auto px-4 pb-10">
          <h1 className="mt-3 text-[22px] font-bold leading-snug text-[#222]">{title || '（未填写标题）'}</h1>
          <div className="mt-3 mb-6 flex items-center gap-2 text-[14px]">
            <span className="text-[#576b95]">{account}</span>
            <span className="text-mist-400">刚刚</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

export function useWechatHtml(work: Work, themeId?: string) {
  const ct = useCustomTheme(work.account_id).data
  return useMemo(() => {
    setCustomTheme(ct ?? null)
    const html = renderWechat(work.sections, themeId ?? work.theme)
    return { html, ...htmlStats(html) }
  }, [work.sections, work.theme, themeId, ct])
}

interface LayoutSuggestion { section_id: string; kind: 'bold' | 'list' | 'divider'; text: string; reason: string }

const layoutKind = { bold: '加粗', list: '改成列表', divider: '加分割线' }

function applyLayout(content: string, s: LayoutSuggestion): string | null {
  if (!content.includes(s.text)) return null
  switch (s.kind) {
    case 'bold':
      return content.replace(s.text, `**${s.text}**`)
    case 'list': {
      const items = s.text.split(/(?=第[一二三四五六七八九十]|首先|其次|最后|[1-9][.、])/).map((x) => x.trim()).filter(Boolean)
      return content.replace(s.text, items.map((x) => `- ${x}`).join('\n'))
    }
    case 'divider':
      return content.replace(s.text, `---\n\n${s.text}`)
  }
}

/** LayoutSuggest lists rule-based layout ideas (EX-G-02); each one is applied separately. */
function LayoutSuggest({ work, onApplied }: { work: Work; onApplied: () => Promise<unknown> }) {
  const [list, setList] = useState<LayoutSuggestion[] | null>(null)
  const [busy, setBusy] = useState<'rules' | 'ai' | null>(null)
  const [applying, setApplying] = useState<number | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const load = async (ai: boolean) => {
    setBusy(ai ? 'ai' : 'rules')
    try {
      const r = await post<{ suggestions: LayoutSuggestion[]; ai_call_id?: string; ai_error?: string }>(`/works/${work.id}/layout-suggest`, { ai })
      setList(r.suggestions)
      setCallId(r.ai_call_id ?? null)
      if (r.ai_error) aiError(new Error(r.ai_error), 'AI 排版建议', () => load(true))
    } catch (e) {
      if (ai) aiError(e, 'AI 排版建议', () => load(true))
      else toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const apply = async (s: LayoutSuggestion, i: number) => {
    setApplying(i)
    try {
      const fresh = await get<Work>(`/works/${work.id}`)
      const sec = fresh.sections.find((x) => x.id === s.section_id)
      const next = sec && applyLayout(sec.content_md, s)
      if (!sec || !next) {
        toast.info('原文已经改动过，这条建议不再适用')
      } else {
        await patch(`/sections/${sec.id}`, { content_md: next, base_revision: sec.revision })
        await onApplied()
      }
      setList((l) => l?.filter((_, j) => j !== i) ?? null)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setApplying(null)
    }
  }
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-medium text-mist-700">排版建议</span>
        <Button size="sm" variant="ghost" className="ml-auto" loading={busy === 'rules'} disabled={!!busy} icon={<Wand2 className="size-3.5" />} onClick={() => load(false)}>{list ? '重新看看' : '看看'}</Button>
        <Button size="sm" variant="ghost" loading={busy === 'ai'} disabled={!!busy} onClick={() => load(true)}>再让 AI 看看</Button>
      </div>
      {callId && <AIFeedback callId={callId} className="mb-2" />}
      {!list ? <p className="text-[12px] text-mist-400">找出适合加粗的观点句、你收藏的金句、可以改成列表的并列要点和过长的段落。AI 只建议排版，不改文字。每条单独应用。</p>
        : list.length === 0 ? <p className="text-[12px] text-mist-400">没有新的排版建议。</p> : (
          <ul className="space-y-2">
            {list.map((s, i) => (
              <li key={i} className="rounded-lg border border-mist-200 p-2 text-[12px]">
                <div className="flex items-center gap-1.5"><span className="font-medium text-ink-700">{layoutKind[s.kind]}</span><span className="text-mist-400">{s.reason}</span></div>
                <p className="mt-1 line-clamp-2 text-mist-600">{s.text}</p>
                {!work.locked && <Button size="sm" variant="secondary" className="mt-1.5" loading={applying === i} disabled={applying !== null} onClick={() => apply(s, i)}>应用</Button>}
              </li>
            ))}
          </ul>
        )}
    </Card>
  )
}

async function copyRich(html: string) {
  if (window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([html], { type: 'text/plain' }) })])
  } else await navigator.clipboard.writeText(html)
}

export default function Preview() {
  const { work, setWork, refresh } = useWork()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const ct = useCustomTheme(work.account_id).data
  const [themeId, setThemeId] = useState(work.theme === CUSTOM_THEME_ID ? CUSTOM_THEME_ID : themeById(work.theme).id)
  const allThemes = ct ? [...themes, { ...customTheme(ct), id: CUSTOM_THEME_ID, name: '我的主题', desc: '账号自定义主题，可在账号档案中调整' }] : themes
  const { html, chars, bytes } = useWechatHtml(work, themeId)
  const over = chars >= HTML_CHAR_LIMIT || bytes >= HTML_BYTE_LIMIT
  const pick = async (id: string) => {
    if (id === themeId) return
    setThemeId(id)
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { theme: id }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const copy = async () => {
    try {
      await copyRich(html)
      toast.success('已复制排版后的 HTML，可以粘贴到公众号编辑器。正文图片需要在后台重新上传。')
    } catch {
      toast.error('浏览器不允许访问剪贴板')
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-[1280px] gap-10 px-6 py-8 2xl:max-w-[1480px]">
      <aside className="w-72 shrink-0 space-y-5">
        <div>
          <h2 className="mb-1 font-display text-[17px] font-bold text-mist-900">排版主题</h2>
          <p className="text-[13px] text-mist-500">切换即时生效，推送时使用当前主题。</p>
        </div>
        <div className="space-y-2">
          {allThemes.map((t) => (
            <button key={t.id} onClick={() => pick(t.id)} disabled={work.locked}
              className={cn('flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 text-left transition',
                themeId === t.id ? 'border-ink-400 bg-ink-50/50 ring-3 ring-ink-100' : 'border-mist-200 bg-white hover:border-mist-300')}>
              <div className="flex shrink-0 -space-x-1.5">
                {t.swatch.map((c) => <span key={c} className="size-5 rounded-full border-2 border-white" style={{ background: c }} />)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-mist-800">{t.name}</div>
                <div className="truncate text-xs text-mist-500">{t.desc}</div>
              </div>
              {themeId === t.id && <Check className="size-4 text-ink-600" />}
            </button>
          ))}
          {!ct && <Link to={`/a/${work.account_id}/profile?tab=layout`} className="block text-[12px] text-ink-700 hover:underline">调一套自己的主题 →</Link>}
        </div>
        <LayoutSuggest work={work} onApplied={refresh} />
        <Card className="p-4">
          <div className="mb-3 text-[13px] font-medium text-mist-700">正文 HTML 体积</div>
          <Meter label="字符数" value={chars} max={HTML_CHAR_LIMIT} text={`${chars.toLocaleString()} / ${HTML_CHAR_LIMIT.toLocaleString()}`} />
          <Meter label="大小" value={bytes} max={HTML_BYTE_LIMIT} text={`${fmtBytes(bytes)} / 1 MB`} />
          {over && <p className="mt-2 text-xs text-danger">超出公众号正文上限，需要精简内容或拆成多篇后才能推送。</p>}
        </Card>
        <div className="space-y-2">
          <Button className="w-full" icon={<Copy className="size-4" />} onClick={copy}>复制 HTML</Button>
          <Button variant="primary" className="w-full" disabled={over} onClick={() => nav(`/works/${work.id}/check?start=1`)}>
            下一步：发布前检查<ArrowRight className="size-4" />
          </Button>
        </div>
        {params.get('next') === 'check' && <Notice tone="ink" icon={<Smartphone className="size-4" />}>先确认排版效果，再进入发布前检查。检查时会使用这里的排版结果统计正文体积。</Notice>}
        <p className="text-xs leading-relaxed text-mist-400">预览按手机宽度模拟，最终效果以公众号后台预览为准（D-024 实测前，主题只使用基础样式）。</p>
      </aside>
      <div className="flex flex-1 justify-center">
        <PhoneFrame title={work.title} account={work.account_name}>
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </PhoneFrame>
      </div>
    </div>
  )
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = Math.min(100, (value / max) * 100)
  const over = value >= max
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex justify-between text-xs"><span className="text-mist-500">{label}</span><span className={cn('tabular-nums', over ? 'font-semibold text-danger' : 'text-mist-600')}>{text}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-mist-100">
        <div className={cn('h-full rounded-full transition-all', over ? 'bg-danger' : pct > 80 ? 'bg-gamboge-400' : 'bg-ink-500')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
