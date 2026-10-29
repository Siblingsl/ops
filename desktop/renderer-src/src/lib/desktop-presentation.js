const PRESENTATION = 'ops-creative-desktop'
const THEME_KEY = 'ops-desktop-theme'
const MOTION_KEY = 'ops-desktop-motion'

export function isElectronDesktop(userAgent) {
  return /\bElectron\/\d+(?:\.\d+)*/i.test(userAgent)
}

export function initializeDesktopPresentation(document, storage, userAgent, systemReducedMotion = false, sharedTheme) {
  if (!isElectronDesktop(userAgent)) return null

  const root = document.documentElement
  root.dataset.presentation = PRESENTATION
  const theme = sharedTheme === 'dark' || sharedTheme === 'light'
    ? sharedTheme
    : storage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  root.dataset.theme = theme
  storage.setItem(THEME_KEY, theme)
  root.dataset.reducedMotion = String(storage.getItem(MOTION_KEY) === 'reduce' || systemReducedMotion)
  return theme
}

export function setDesktopTheme(document, storage, theme) {
  const root = document.documentElement
  if (root.dataset.presentation !== PRESENTATION || (theme !== 'light' && theme !== 'dark')) return null

  root.dataset.theme = theme
  storage.setItem(THEME_KEY, theme)
  return theme
}

export function setDesktopMotion(document, storage, reduced) {
  const root = document.documentElement
  if (root.dataset.presentation !== PRESENTATION || typeof reduced !== 'boolean') return null

  root.dataset.reducedMotion = String(reduced)
  storage.setItem(MOTION_KEY, reduced ? 'reduce' : 'soft')
  return reduced
}
