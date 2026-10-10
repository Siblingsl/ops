import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import React, { forwardRef } from 'react'
import type { Platform, WorkStatus } from '@/lib/types'

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
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
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

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return <input ref={ref} className={cn(fieldBase, 'h-9', invalid && 'border-orange-400 focus:ring-orange-100', className)} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, 'py-2 leading-relaxed', invalid && 'border-orange-400', className)} {...rest} />
  },
)

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldBase, 'h-9 pr-8 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236f7881' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...rest}>
      {children}
    </select>
  )
}

export function Field({ label, hint, error, counter, children, className, required }: {
  label?: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  counter?: { value: number; max: number }
  children: React.ReactNode
  className?: string
  required?: boolean
}) {
  const over = counter && counter.value > counter.max
  return (
    <label className={cn('block', className)}>
      {(label || counter) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && (
            <span className="text-[13px] font-medium text-mist-700">
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
    </label>
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

type Tone = 'gray' | 'ink' | 'gamboge' | 'green' | 'red' | 'wechat' | 'xhs' | 'blue'
const tones: Record<Tone, string> = {
  gray: 'bg-mist-100 text-mist-600',
  ink: 'bg-ink-50 text-ink-700 ring-1 ring-inset ring-ink-100',
  gamboge: 'bg-gamboge-50 text-gamboge-700 ring-1 ring-inset ring-gamboge-200',
  green: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100',
  red: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-100',
  wechat: 'bg-[#e8f8ef] text-[#078a46]',
  xhs: 'bg-[#ffecef] text-[#d81b3a]',
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

export const platformLabel: Record<Platform, string> = { wechat_mp: '公众号', xhs: '小红书' }
export const formatLabel: Record<string, string> = { long_article: '长图文', image_note: '图文笔记', comic: '漫画' }

export function PlatformMark({ platform, size = 'md' }: { platform: Platform; size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'sm' ? 'size-5 text-[10px] rounded' : size === 'lg' ? 'size-10 text-sm rounded-xl' : 'size-7 text-[11px] rounded-lg'
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center font-bold text-white', s, platform === 'wechat_mp' ? 'bg-wechat' : 'bg-xhs')}>
      {platform === 'wechat_mp' ? '公' : '红'}
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

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-ink-600' : 'bg-mist-300')}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function Tabs<T extends string>({ value, onChange, items, className }: {
  value: T
  onChange: (v: T) => void
  items: { value: T; label: React.ReactNode; count?: number }[]
  className?: string
}) {
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-lg bg-mist-100 p-1', className)}>
      {items.map((it) => (
        <button
          key={it.value}
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
export function HumanGate({ code, children, className }: { code: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border border-gamboge-200 bg-gamboge-50 px-4 py-3 text-[13px] text-gamboge-700', className)}>
      <span className="mt-px shrink-0 rounded bg-gamboge-400 px-1.5 py-px text-[11px] font-bold text-mist-900">{code}</span>
      <div className="leading-relaxed">{children}</div>
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
        <h1 className="font-display text-[26px] font-bold leading-tight text-mist-900">{title}</h1>
        {desc && <p className="mt-1.5 text-sm text-mist-500">{desc}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}
