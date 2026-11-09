export function isEnterWithoutComposition(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229
}
