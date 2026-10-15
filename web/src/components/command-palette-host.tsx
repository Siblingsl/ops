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
    const palette = () => { setLoaded(true); setOpen(true) }
    const shortcuts = () => { setLoaded(true); setShortcutsOpen(true) }
    let gPending = 0
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setLoaded(true)
        setOpen((value) => !value)
        return
      }
      const target = e.target as HTMLElement | null
      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
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
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('ops:palette', palette)
      window.removeEventListener('ops:shortcuts', shortcuts)
      window.removeEventListener('keydown', onKey)
    }
  }, [accountID, navigate])

  return loaded ? <Suspense fallback={null}><CommandPalette open={open} onOpenChange={setOpen} help={shortcutsOpen} onHelpChange={setShortcutsOpen} /></Suspense> : null
}
