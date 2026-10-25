import { Eye, EyeOff, X } from 'lucide-react'
import React, { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button, cn, Input } from './ui'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { DesktopSettingsContext } from '@/lib/desktop-settings'
import { toast } from 'sonner'

function useEsc(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

function usePresence(open: boolean, duration: number, onExited?: () => void) {
  const [present, setPresent] = useState(open)
  const [exiting, setExiting] = useState(false)
  const onExitedRef = useRef(onExited)

  useEffect(() => { onExitedRef.current = onExited }, [onExited])
  useEffect(() => {
    if (open) {
      setPresent(true)
      setExiting(false)
      return
    }
    if (!present) return
    setExiting(true)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => {
      setPresent(false)
      setExiting(false)
      onExitedRef.current?.()
    }, reducedMotion ? 0 : duration)
    return () => window.clearTimeout(timer)
  }, [open, duration])

  return { present, exiting }
}

export function Dialog({ open, onClose, title, desc, children, footer, width = 'max-w-lg', className, onExited, ariaLabel }: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  desc?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  width?: string
  className?: string
  onExited?: () => void
  ariaLabel?: string
}) {
  const { present, exiting } = usePresence(open, 180, onExited)
  const dialogRef = useRef<HTMLDivElement>(null)
  const settings = useContext(DesktopSettingsContext)
  const close = () => {
    if (settings?.isBusy()) { toast.info('正在保存设置，请稍候再离开'); return }
    onClose()
  }
  useEsc(open, () => {
    const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
    if (dialogs[dialogs.length - 1] === dialogRef.current) close()
  })
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (present && !wasOpen.current) {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasOpen.current = present
  useEffect(() => {
    if (!open || !present) return
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
      if (Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1) !== dialog) return
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
  }, [open, present])
  if (!present) return null
  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-mist-900/35 p-4 pt-[8vh] backdrop-blur-[2px]', exiting ? 'animate-dialog-backdrop-out' : 'animate-dialog-backdrop-in')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} tabIndex={-1} className={cn('desktop-dialog-panel flex max-h-[calc(92vh-16px)] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-pop', exiting ? 'animate-dialog-panel-out' : 'animate-dialog-panel-in', width, className)} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {title && (
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div>
              <h2 className="desktop-dialog-title font-display text-lg font-bold text-mist-900">{title}</h2>
              {desc && <p className="mt-1 text-[13px] leading-relaxed text-mist-500">{desc}</p>}
            </div>
            <button onClick={close} className="-mr-2 rounded-md p-1.5 text-mist-400 hover:bg-mist-100 hover:text-mist-700 cursor-pointer" aria-label="关闭">
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="desktop-dialog-body min-h-0 overflow-y-auto px-6 py-4">{children}</div>
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
  const { present, exiting } = usePresence(open, 180)
  useEsc(open, onClose)
  if (!present) return null
  return createPortal(
    <div className={cn('desktop-drawer-overlay fixed inset-0 z-40 flex justify-end bg-mist-900/25', exiting ? 'animate-dialog-backdrop-out' : 'animate-dialog-backdrop-in')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('flex h-full max-w-full flex-col bg-white shadow-pop', exiting ? 'animate-drawer-panel-out' : 'animate-drawer-panel-in', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-mist-100 px-6 py-4">
          <div>
            <h2 className="desktop-dialog-title font-display text-lg font-bold text-mist-900">{title}</h2>
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
    root.render(<ConfirmDialog opts={opts} finish={finish} />)
  })
}

function ConfirmDialog({ opts, finish }: { opts: ConfirmOptions; finish: (value: boolean) => void }) {
  const [open, setOpen] = useState(true)
  const result = useRef(false)
  const close = (value: boolean) => {
    if (!open) return
    result.current = value
    setOpen(false)
  }
  return (
    <Dialog open={open} onClose={() => close(false)} onExited={() => finish(result.current)} title={opts.title} desc={undefined} width="max-w-md"
      footer={<>
        <Button variant="ghost" onClick={() => close(false)}>{opts.cancelText ?? '取消'}</Button>
        <Button autoFocus variant={opts.danger ? 'danger' : opts.human ? 'human' : 'primary'} onClick={() => close(true)}>{opts.confirmText ?? '确定'}</Button>
      </>}>
      {opts.desc && <div className="text-sm leading-relaxed text-mist-600">{opts.desc}</div>}
    </Dialog>
  )
}

export function PasswordPrompt({ onDone, submit }: { onDone: (ok: boolean) => void; submit: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // 密码错误时最常见的两种原因是输错和大小写/输入法，给一个明文开关让用户自己核对。
  const [show, setShow] = useState(false)
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
      <div className="relative">
        <Input type={show ? 'text' : 'password'} autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => isEnterWithoutComposition(e.nativeEvent) && !busy && pw && go()} placeholder="登录密码" invalid={!!err} className="pr-9" />
        <button type="button" aria-label={show ? '隐藏密码' : '显示密码'} title={show ? '隐藏密码' : '显示密码'}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-mist-700"
          onClick={() => setShow((v) => !v)}>
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </Dialog>
  )
}
