import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function nearestNodeModules(fromImportMetaUrl) {
  let dir = dirname(fileURLToPath(fromImportMetaUrl))
  for (;;) {
    const candidate = join(dir, 'node_modules')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('node_modules not found from ' + fromImportMetaUrl)
    dir = parent
  }
}

/** Point Vite at package dirs (not CJS entry files) so ESM exports resolve. */
export function sharedNpmAliases(fromImportMetaUrl) {
  const nm = nearestNodeModules(fromImportMetaUrl)
  return {
    sonner: join(nm, 'sonner'),
    marked: join(nm, 'marked'),
  }
}
