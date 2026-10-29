import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import React, { forwardRef } from 'react'
import { createPortal } from 'react-dom'
import type { ContentFormat, Platform, WorkStatus } from '@/lib/types'
import { errorMessage } from '@/lib/api'

export const cn = clsx

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'human' | 'outline'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-ink-600 text-white hover:bg-ink-700 active:bg-ink-800 shadow-sm',
  secondary: 'bg-white text-mist-700 border border-mist-200 hover:border-mist-300 hover:bg-mist-50 shadow-card',
  outline: 'border border-ink-300 text-ink-700 hover:bg-ink-50',
  ghost: 'text-mist-600 hover:bg-mist-100 hover:text-mist-800',
  danger: 'bg-white text-danger border border-orange-200 hover:bg-orange-50',
  // 藤黄：人工确认点专用
  human: 'bg-gamboge-400 text-mist-900 hover:bg-gamboge-300 active:bg-gamboge-500 shadow-sm font-semibold',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: React.ReactNode
  /** 禁用原因（ST-05）：只在 disabled/loading 时作为悬停 title。 */
  disabledHint?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, disabledHint, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      title={disabledTitle(disabled || loading, disabledHint, title)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors duration-150 select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-400',
        'disabled:opacity-45 disabled:pointer-events-none cursor-pointer',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export interface MoreMenuItem { label: string; icon?: React.ReactNode; onClick: () => void; disabled?: boolean; loading?: boolean; hint?: string }

/** MoreMenu tucks secondary actions behind one "更多" button; each item still runs one action on click. */
export function MoreMenu({ items, label = '更多', className }: { items: MoreMenuItem[]; label?: string; className?: string }) {
  const [open, setOpen] = React.useState(false)
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null)
  const box = React.useRef<HTMLDivElement>(null)
  const menu = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    if (!open || !box.current || !menu.current) return
    const anchor = box.current.getBoundingClientRect()
    const bounds = menu.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: anchor.bottom + bounds.height + 4 <= window.innerHeight - 8
        ? anchor.bottom + 4 : Math.max(8, anchor.top - bounds.height - 4),
    })
  }, [open])
  React.useLayoutEffect(() => {
    if (open && position) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, position])
  React.useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return
        setOpen(false)
        box.current?.querySelector('button')?.focus()
      } else if (!box.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    const closeOnScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setOpen(false) }
    const closeOnResize = () => setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    document.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnResize)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      document.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('resize', closeOnResize)
    }
  }, [open])
  if (!items.length) return null
  const busy = items.some((i) => i.loading)
  return (
    <div ref={box} className={cn('relative', className)}>
      <Button size="sm" variant="ghost" aria-haspopup="menu" aria-expanded={open} loading={busy} onClick={() => { setPosition(null); setOpen((v) => !v) }}>
        {label}<span aria-hidden className="text-mist-400">▾</span>
      </Button>
      {open && createPortal(
        <div ref={menu} role="menu" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
          className="fixed z-50 max-h-[calc(100vh-16px)] min-w-44 overflow-y-auto rounded-lg border border-mist-200 bg-white p-1 shadow-pop">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled || it.loading} title={it.hint}
              onClick={() => { setOpen(false); it.onClick() }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-mist-700 hover:bg-mist-100 disabled:cursor-not-allowed disabled:opacity-45 [&>svg]:size-3.5">
              {it.icon}{it.label}
            </button>
          ))}
        </div>, document.body
      )}
    </div>
  )
}

export function IconButton({ className, label, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md text-mist-500 transition-colors hover:bg-mist-100 hover:text-mist-800 cursor-pointer',
        'disabled:opacity-40 disabled:pointer-events-none',
        className,
      )}
      {...rest}
    />
  )
}

const fieldBase =
  'w-full rounded-lg border border-mist-200 bg-white px-3 text-sm text-mist-800 placeholder:text-mist-400 transition-colors ' +
  'focus:border-ink-400 focus:outline-none focus:ring-3 focus:ring-ink-100 disabled:bg-mist-50 disabled:text-mist-500'

/**
 * 角色只读时的统一悬停说明（ST-05）：页面级 Notice 说明"为什么不能改"，
 * 控件 title 说明"谁可以改"，两者文案保持一致，不再逐页另写一套说法。
 */
export const roleReadOnlyHint = {
  owner: '只有工作区所有者可以修改',
  writer: '观察者只能查看，需要编辑者或所有者修改',
} as const

/** 只在禁用时挂 title：可编辑时不出现误导性的"只有所有者可以修改"。 */
function disabledTitle(disabled: boolean | undefined, hint: string | undefined, title: string | undefined) {
  return disabled && hint ? hint : title
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; disabledHint?: string }>(
  function Input({ className, invalid, disabledHint, title, ...rest }, ref) {
    return <input ref={ref} title={disabledTitle(rest.disabled, disabledHint, title)} className={cn(fieldBase, 'h-9', invalid && 'border-orange-400 focus:ring-orange-100', className)} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; disabledHint?: string }>(
  function Textarea({ className, invalid, disabledHint, title, ...rest }, ref) {
    return <textarea ref={ref} title={disabledTitle(rest.disabled, disabledHint, title)} className={cn(fieldBase, 'py-2 leading-relaxed', invalid && 'border-orange-400', className)} {...rest} />
  },
)

export function Select({ className, children, disabledHint, title, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { disabledHint?: string }) {
  return (
    <select className={cn(fieldBase, 'h-9 pr-8 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat', className)}
      title={disabledTitle(rest.disabled, disabledHint, title)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236f7881' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...rest}>
      {children}
    </select>
  )
}

export function Field({ label, hint, error, counter, children, className, required, plain }: {
  label?: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  counter?: { value: number; max: number }
  children: React.ReactNode
  className?: string
  required?: boolean
  /** 纯展示字段（内含按钮等非表单控件）用 div 包裹：label 会把整段文案算进子控件的可访问名，并让点击文字触发控件。 */
  plain?: boolean
}) {
  const over = counter && counter.value > counter.max
  const Tag = plain ? 'div' : 'label'
  return (
    <Tag className={cn('block', className)}>
      {(label || counter) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && (
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-mist-700">
              {label}
              {required && <span className="ml-0.5 text-danger">*</span>}
            </span>
          )}
          {counter && (
            <span className={cn('text-xs tabular-nums', over ? 'font-semibold text-danger' : 'text-mist-400')}>
              {counter.value} / {counter.max}
            </span>
          )}
        </div>
      )}
      {children}
      {error ? <p className="mt-1.5 text-xs text-danger">{error}</p> : hint ? <p className="mt-1.5 text-xs text-mist-500">{hint}</p> : null}
    </Tag>
  )
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-mist-200/80 bg-white shadow-card', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ title, desc, action, className }: { title: React.ReactNode; desc?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-mist-100 px-5 py-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-mist-900">{title}</h3>
        {desc && <p className="mt-0.5 text-[13px] text-mist-500">{desc}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

type Tone = 'gray' | 'ink' | 'gamboge' | 'green' | 'red' | 'wechat' | 'xhs' | 'toutiao' | 'blue'
const tones: Record<Tone, string> = {
  gray: 'bg-mist-100 text-mist-600',
  ink: 'bg-ink-50 text-ink-700 ring-1 ring-inset ring-ink-100',
  gamboge: 'bg-gamboge-50 text-gamboge-700 ring-1 ring-inset ring-gamboge-200',
  green: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100',
  red: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-100',
  wechat: 'bg-[#e8f8ef] text-[#078a46]',
  xhs: 'bg-[#ffecef] text-[#d81b3a]',
  toutiao: 'bg-[#fff0ed] text-[#d9362b]',
  blue: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-100',
}

export function Badge({ tone = 'gray', className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11.5px] font-medium', tones[tone], className)}>
      {children}
    </span>
  )
}

export const statusMeta: Record<WorkStatus, { label: string; tone: Tone }> = {
  drafting: { label: '创作中', tone: 'gray' },
  checking: { label: '检查中', tone: 'gamboge' },
  reviewing: { label: '待审阅', tone: 'gamboge' },
  ready: { label: '可发布', tone: 'ink' },
  pushed: { label: '已进草稿箱', tone: 'blue' },
  packed: { label: '发布包已生成', tone: 'blue' },
  published: { label: '已发布', tone: 'green' },
}

export function StatusBadge({ status }: { status: WorkStatus }) {
  const m = statusMeta[status]
  return (
    <Badge tone={m.tone}>
      <span className={cn('size-1.5 rounded-full', {
        'bg-mist-400': status === 'drafting', 'bg-gamboge-400': status === 'checking' || status === 'reviewing', 'bg-ink-500': status === 'ready',
        'bg-sky-500': status === 'pushed' || status === 'packed', 'bg-emerald-500': status === 'published',
      })} />
      {m.label}
    </Badge>
  )
}

export const platformLabel: Record<Platform, string> = { wechat_mp: '公众号', xhs: '小红书', toutiao: '今日头条' }
export const formatLabel: Record<string, string> = {
  long_article: '长图文', image_note: '图文笔记', comic: '漫画',
  qa_article: '问答体长图文', briefing: '资讯简报', list_note: '清单合集笔记',
  card_post: '图文卡片', script: '口播脚本', micro_post: '微头条',
}
export function platformFormatLabel(platform: Platform, format: string) {
  if (platform === 'toutiao' && format === 'long_article') return '文章'
  return formatLabel[format] ?? format
}
// 每平台可选的账号类型（D-048）。与后端 formatMatrix 保持一致；创建后可在同平台内迁移（D-123）。
export const platformFormats: Record<Platform, ContentFormat[]> = {
  wechat_mp: ['long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic'],
  xhs: ['image_note', 'list_note', 'card_post', 'script', 'comic'],
  toutiao: ['long_article', 'micro_post'],
}
// 文字类新类型在大纲/起草时的结构约定提示（与后端 formatBriefs 一致）。
export const formatBriefHint: Record<string, string> = {
  qa_article: '问答体：按「核心问题 → 追问 → 直接回答 → 论据 → 小结」组织段落，小标题可以是读者会问的问题。',
  briefing: '资讯简报：一句话导语＋并列条目（小标题＋要点）＋来源与核实提示，篇幅比长图文短。',
  list_note: '清单/合集：钩子导语＋编号清单项（每项一句结论加一句理由）＋收尾行动建议。',
  script: '口播脚本：每段一个镜头，小标题用「镜1：场景」；先写口播词，再用【画面】标注画面提示。仅脚本文档，不生成视频。',
}

export function PlatformMark({ platform, size = 'md' }: { platform: Platform; size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'sm' ? 'size-5 text-[10px] rounded' : size === 'lg' ? 'size-10 text-sm rounded-xl' : 'size-7 text-[11px] rounded-lg'
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center font-bold text-white', s, platform === 'wechat_mp' ? 'bg-wechat' : platform === 'xhs' ? 'bg-xhs' : 'bg-ink-700')}>
      {platform === 'wechat_mp' ? '公' : platform === 'xhs' ? '红' : '头'}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-mist-400', className)} />
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-mist-100', className)} />
}

/** PageLoading renders a skeleton of the page instead of a full-page spinner (4.5 骨架屏). */
export function PageLoading({ variant = 'list' }: { variant?: 'list' | 'editor' }) {
  if (variant === 'editor') {
    return (
      <div className="mx-auto w-full max-w-[860px] space-y-5 px-6 py-8" aria-busy="true" aria-label="加载中">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-24 w-full" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2.5 rounded-xl border border-mist-100 p-5">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="space-y-6" aria-busy="true" aria-label="加载中">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-80" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-3 rounded-xl border border-mist-100 bg-white p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function Empty({ icon, title, desc, action, className }: { icon?: React.ReactNode; title: string; desc?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-mist-100 text-mist-400">{icon}</div>}
      <p className="font-display text-[17px] font-semibold text-mist-800">{title}</p>
      {desc && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-mist-500">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function PageState({ loading, error, retrying, onRetry, emptyTitle = '暂无数据' }: {
  loading: boolean
  error?: unknown
  retrying?: boolean
  onRetry: () => void
  emptyTitle?: string
}) {
  const action = <div className="space-y-2">
    <Button loading={retrying} onClick={onRetry}>重试</Button>
    {retrying && <p className="text-xs text-mist-500">正在重试…</p>}
  </div>
  if (error) return <div role="alert"><Empty title="加载失败" desc={errorMessage(error)} action={action} /></div>
  if (loading) return <PageLoading />
  return <Empty title={emptyTitle} action={action} />
}

export function Switch({ checked, onChange, disabled, label, disabledHint, title }: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
  /** 禁用原因（ST-05）：只在 disabled 时作为悬停 title，避免可编辑时误报。 */
  disabledHint?: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={disabledTitle(disabled, disabledHint, title)}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-ink-600' : 'bg-mist-300')}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function Tabs<T extends string>({ value, onChange, items, className, role, ariaLabel }: {
  value: T
  onChange: (v: T) => void
  items: { value: T; label: React.ReactNode; count?: number }[]
  className?: string
  role?: 'tablist'
  ariaLabel?: string
}) {
  return (
    <div role={role} aria-label={ariaLabel} className={cn('inline-flex items-center gap-1 rounded-lg bg-mist-100 p-1', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role={role ? 'tab' : undefined}
          aria-selected={role ? value === it.value : undefined}
          onClick={() => onChange(it.value)}
          className={cn('inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-all',
            value === it.value ? 'bg-white text-mist-900 shadow-sm' : 'text-mist-500 hover:text-mist-800')}
        >
          {it.label}
          {it.count !== undefined && <span className={cn('tabular-nums text-xs', value === it.value ? 'text-ink-600' : 'text-mist-400')}>{it.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** HumanGate marks a step that only a person may perform (藤黄). */
export function HumanGate({ code, children, className, action }: { code: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border border-gamboge-200 bg-gamboge-50 px-4 py-3 text-[13px] text-gamboge-700', className)}>
      <span className="mt-px shrink-0 rounded bg-gamboge-400 px-1.5 py-px text-[11px] font-bold text-mist-900">{code}</span>
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function Notice({ tone = 'gray', icon, children, className }: { tone?: 'gray' | 'ink' | 'red' | 'gamboge'; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const t = {
    gray: 'bg-mist-50 border-mist-200 text-mist-600',
    ink: 'bg-ink-50 border-ink-100 text-ink-800',
    red: 'bg-orange-50 border-orange-200 text-orange-800',
    gamboge: 'bg-gamboge-50 border-gamboge-200 text-gamboge-700',
  }[tone]
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed', t, className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-mist-200 bg-mist-50 px-1 font-mono text-[11px] text-mist-500">{children}</kbd>
}

export function PageHeader({ title, desc, action, eyebrow }: { title: React.ReactNode; desc?: React.ReactNode; action?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium tracking-wide text-ink-600">{eyebrow}</div>}
        <h1 className="page-header-title font-display text-[26px] font-bold leading-tight text-mist-900">{title}</h1>
        {desc && <p className="mt-1.5 text-sm text-mist-500">{desc}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}
