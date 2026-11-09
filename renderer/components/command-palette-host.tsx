import { lazy, Suspense, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCurrentAccount } from '@/lib/session'

const CommandPalette = lazy(() => import('./command-palette').then((module) => ({ default: module.CommandPalette })))

export function CommandPaletteHost() {
  const account = useCurrentAccount()
  const accountID = account?.id
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  useEffect(() => {
    const palette = () => {
      setLoaded(true)
      setOpen(true)
      window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'palette' }))
    }
    const shortcuts = () => {
      setLoaded(true)
      setShortcutsOpen(true)
      window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'shortcuts' }))
    }
    const exclusive = (e: Event) => {
      const from = (e as CustomEvent<string>).detail
      if (from !== 'palette') setOpen(false)
      if (from !== 'shortcuts') setShortcutsOpen(false)
    }
    let gPending = 0
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setLoaded(true)
        setOpen((value) => {
          if (!value) window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'palette' }))
          return !value
        })
        return
      }
      const workbench = document.querySelector('.desktop-agent-workbench')
      if (workbench && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const shortcut = e.key.toLowerCase()
        const actions: Record<string, string> = { o: 'new', f: 'search-conversations', b: 'toggle-list', j: 'toggle-panel' }
        if (actions[shortcut]) {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('ops:agent-workbench-shortcut', { detail: actions[shortcut] }))
          return
        }
      }
      const target = e.target as HTMLElement | null
      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (workbench && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !isTyping && window.location.pathname.startsWith('/agent/c/')) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ops:agent-workbench-shortcut', { detail: 'find-message' }))
        return
      }
      if (isTyping || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === '?') {
        e.preventDefault()
        setLoaded(true)
        setShortcutsOpen(true)
        return
      }
      if (e.key.toLowerCase() === 'g') {
        gPending = Date.now()
        return
      }
      if (gPending && Date.now() - gPending < 1200) {
        gPending = 0
        const base = accountID ? `/a/${accountID}` : ''
        const map: Record<string, string> = { d: base || '/', t: `${base}/topics`, c: `${base}/calendar`, w: `${base}/works`, m: `${base}/materials`, r: `${base}/review` }
        const to = map[e.key.toLowerCase()]
        if (to && base) {
          e.preventDefault()
          navigate(to)
        }
      }
    }
    window.addEventListener('ops:palette', palette)
    window.addEventListener('ops:shortcuts', shortcuts)
    window.addEventListener('ops:overlay', exclusive)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('ops:palette', palette)
      window.removeEventListener('ops:shortcuts', shortcuts)
      window.removeEventListener('ops:overlay', exclusive)
      window.removeEventListener('keydown', onKey)
    }
  }, [accountID, navigate])

  return loaded ? <Suspense fallback={null}><CommandPalette open={open} onOpenChange={setOpen} help={shortcutsOpen} onHelpChange={setShortcutsOpen} /></Suspense> : null
}
