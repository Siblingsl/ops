import { X } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button, cn, Input } from './ui'
import { isEnterWithoutComposition } from '@/lib/keyboard'

function useEsc(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

export function Dialog({ open, onClose, title, desc, children, footer, width = 'max-w-lg', className }: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  desc?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  width?: string
  className?: string
}) {
  useEsc(open, onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasOpen.current = open
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0)
    if (!dialog.contains(document.activeElement)) {
      const initial = dialog.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? dialog
      initial.focus()
    }
    const containTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', containTab, true)
    return () => {
      document.removeEventListener('keydown', containTab, true)
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-mist-900/35 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} className={cn('w-full animate-fade-in rounded-2xl bg-white shadow-pop', width, className)} role="dialog" aria-modal="true">
        {title && (
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div>
              <h2 className="font-display text-lg font-bold text-mist-900">{title}</h2>
              {desc && <p className="mt-1 text-[13px] leading-relaxed text-mist-500">{desc}</p>}
            </div>
            <button onClick={onClose} className="-mr-2 rounded-md p-1.5 text-mist-400 hover:bg-mist-100 hover:text-mist-700 cursor-pointer" aria-label="关闭">
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="px-6 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 rounded-b-2xl border-t border-mist-100 bg-mist-50/60 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ open, onClose, title, desc, children, footer, width = 'w-[460px]' }: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  desc?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: string
}) {
  useEsc(open, onClose)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-mist-900/25" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('flex h-full max-w-full animate-slide-in flex-col bg-white shadow-pop', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-mist-100 px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-mist-900">{title}</h2>
            {desc && <p className="mt-1 text-[13px] text-mist-500">{desc}</p>}
          </div>
          <button onClick={onClose} className="-mr-2 rounded-md p-1.5 text-mist-400 hover:bg-mist-100 hover:text-mist-700 cursor-pointer" aria-label="关闭">
            <X className="size-4" />
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-mist-100 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmOptions {
  title: string
  desc?: React.ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  human?: boolean
}

/** confirm shows a modal and resolves true when the user confirms. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const finish = (v: boolean) => {
      root.unmount()
      host.remove()
      resolve(v)
    }
    root.render(
      <Dialog open onClose={() => finish(false)} title={opts.title} desc={undefined} width="max-w-md"
        footer={<>
          <Button variant="ghost" onClick={() => finish(false)}>{opts.cancelText ?? '取消'}</Button>
          <Button autoFocus variant={opts.danger ? 'danger' : opts.human ? 'human' : 'primary'} onClick={() => finish(true)}>{opts.confirmText ?? '确定'}</Button>
        </>}>
        {opts.desc && <div className="text-sm leading-relaxed text-mist-600">{opts.desc}</div>}
      </Dialog>,
    )
  })
}

export function PasswordPrompt({ onDone, submit }: { onDone: (ok: boolean) => void; submit: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    setErr('')
    try {
      await submit(pw)
      onDone(true)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={() => onDone(false)} title="确认是你本人" width="max-w-sm"
      footer={<>
        <Button variant="ghost" onClick={() => onDone(false)}>取消</Button>
        <Button variant="primary" loading={busy} onClick={go} disabled={!pw}>确认</Button>
      </>}>
      <p className="mb-3 text-[13px] leading-relaxed text-mist-500">修改凭证、模型密钥等敏感操作需要再次输入登录密码，5 分钟内有效。</p>
      <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => isEnterWithoutComposition(e.nativeEvent) && !busy && pw && go()} placeholder="登录密码" invalid={!!err} />
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </Dialog>
  )
}
