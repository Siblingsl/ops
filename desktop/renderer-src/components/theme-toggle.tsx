import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { setDesktopTheme, type DesktopTheme } from '@/lib/desktop-presentation.js'

export function ThemeToggle({ onToggle }: { onToggle?: () => void }) {
  const [theme, setTheme] = useState<DesktopTheme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  useEffect(() => {
    const update = (event: Event) => setTheme((event as CustomEvent<DesktopTheme>).detail)
    window.addEventListener('ops:desktop-theme', update)
    return () => window.removeEventListener('ops:desktop-theme', update)
  }, [])

  const toggleTheme = () => {
    const next: DesktopTheme = theme === 'light' ? 'dark' : 'light'
    if (!setDesktopTheme(document, window.localStorage, next)) return
    setTheme(next)
    window.dispatchEvent(new CustomEvent('ops:desktop-theme', { detail: next }))
    window.open(`ops-desktop://ui/theme/${next}`, '_blank', 'noopener,noreferrer')
    onToggle?.()
  }

  return (
    <button
      type="button"
      role="menuitem"
      onClick={toggleTheme}
      aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
      title={theme === 'light' ? '深色主题' : '浅色主题'}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-700 hover:bg-mist-50"
    >
      {theme === 'light' ? <Moon className="size-4" /> : <Sun className="size-4" />}
      <span>{theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}</span>
    </button>
  )
}

export default ThemeToggle
