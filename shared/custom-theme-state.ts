import type { CustomTheme } from './types'

let activeCustom: CustomTheme | null = null

export function setCustomTheme(theme: CustomTheme | null) {
  activeCustom = theme
}

export function getCustomTheme() {
  return activeCustom
}
