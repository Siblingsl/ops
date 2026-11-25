// OPT-E02（docs/43 §5）：桌面客户端轻量更新检查。
//
// 本模块不依赖 Electron，所有输入都由调用方注入，便于单测直接跑纯函数：
// 1) 语义版本解析/比较与服务端 Go 侧同口径（0.10.0 > 0.2.0、正式版 > 预发布）；
// 2) 下载链接只在 https + 无凭据 + 非本机/内网/保留地址时可信；
// 3) 服务端返回的任何字段都只作为候选值，客户端用本地版本重新比对，不盲信 update_available；
// 4) 网络/HTTP/JSON 异常一律收敛为 status: 'error'，绝不抛到主进程调用方。

export type DesktopUpdateStatusKind =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'up-to-date'
  | 'unconfigured'
  | 'error'

/** 固定 9 键；preload 与渲染器都按这个键集合逐项校验，多余键整份拒绝。 */
export type DesktopUpdateStatus = {
  status: DesktopUpdateStatusKind
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseNotes: string
  downloadUrl: string
  sha256: string
  checkedAt: number | null
  error: string
}

type DesktopSemver = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export type DesktopReleaseEvaluation = {
  latestVersion: string
  updateAvailable: boolean
  releaseNotes: string
  downloadUrl: string
  sha256: string
}

export type DesktopUpdateCheckerDeps = {
  currentVersion: () => string
  apiOrigin: () => string
  onStatus: (status: DesktopUpdateStatus) => void
  fetchImpl?: typeof fetch
  startupDelayMs?: number
}

export type DesktopUpdateChecker = {
  getStatus: () => DesktopUpdateStatus
  checkNow: () => Promise<DesktopUpdateStatus>
  scheduleStartupCheck: () => void
  dispose: () => void
}

const MAX_NOTES_CHARS = 2000
const DEFAULT_STARTUP_DELAY_MS = 15_000
const CHECK_TIMEOUT_MS = 10_000

function isSemverIdent(raw: string): boolean {
  return raw.length > 0 && raw.length <= 32 && /^[0-9A-Za-z-]+$/.test(raw)
}

function isSemverNumber(raw: string): boolean {
  return raw.length > 0 && raw.length <= 9 && /^[0-9]+$/.test(raw)
}

/** 接受可选前导 v/V、major.minor.patch 与可选 -prerelease；+build 元数据忽略。 */
export function parseSemver(raw: string): DesktopSemver | null {
  let value = String(raw ?? '').trim()
  if (!value || value.length > 128) return null
  if (value[0] === 'v' || value[0] === 'V') {
    value = value.slice(1)
    if (!value) return null
  }
  const buildAt = value.indexOf('+')
  if (buildAt >= 0) {
    const build = value.slice(buildAt + 1)
    if (!build) return null
    if (!build.split('.').every(isSemverIdent)) return null
    value = value.slice(0, buildAt)
  }
  let prerelease: string[] = []
  const preAt = value.indexOf('-')
  if (preAt >= 0) {
    const pre = value.slice(preAt + 1)
    if (!pre) return null
    const parts = pre.split('.')
    if (!parts.every(isSemverIdent)) return null
    prerelease = parts
    value = value.slice(0, preAt)
  }
  const parts = value.split('.')
  if (parts.length !== 3 || !parts.every(isSemverNumber)) return null
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10))
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n) && n >= 0)) return null
  return { major, minor, patch, prerelease }
}

export function formatSemver(v: DesktopSemver): string {
  const core = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join('.')}` : core
}

/** 同 Go 侧 compareDesktopSemver：数字段按数值，纯数字预发布段小于字母段，段数少者更小。 */
export function compareSemver(a: DesktopSemver, b: DesktopSemver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    const leftNumeric = isSemverNumber(left)
    const rightNumeric = isSemverNumber(right)
    if (leftNumeric && rightNumeric) {
      const l = Number(left)
      const r = Number(right)
      if (l !== r) return l < r ? -1 : 1
      continue
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  if (a.prerelease.length < b.prerelease.length) return -1
  if (a.prerelease.length > b.prerelease.length) return 1
  return 0
}

function isReservedIPv4(host: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const octets = match.slice(1).map((part) => Number(part))
  if (octets.some((part) => part > 255)) return true
  const [a, b, c] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 240) return true
  return false
}

function isReservedIPv6(host: string): boolean {
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fe80') || host.startsWith('ff')) return true
  if (host.startsWith('fc') || host.startsWith('fd')) return true
  if (host.startsWith('2001:db8')) return true
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length)
    return isReservedIPv4(mapped) !== false
  }
  return false
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const ipv4 = isReservedIPv4(host)
  if (ipv4 !== null) return ipv4
  if (host.includes(':')) return isReservedIPv6(host)
  // 单段主机名（如 releases）通常只在组织内网可解析，公开下载包不应使用。
  return !host.includes('.')
}

/** 只放行 https、无凭据、非本机/内网/保留地址的下载链接；与 Go 出口清洗同口径。 */
export function isTrustedDownloadUrl(raw: string): boolean {
  const value = String(raw ?? '').trim()
  if (!value || value.length > 4096) return false
  // WHATWG URL 会把 https:///ops.exe 规范成 https://ops.exe/（空 authority 被吞掉）；
  // 先按字符串要求 scheme 后紧跟非空主机，才能与 Go 侧 url.Parse 的 Host=="" 拒绝同口径。
  if (!/^https:\/\/[^/?#]/.test(value)) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return false
  return !isLocalHostname(parsed.hostname.replace(/^\[|\]$/g, ''))
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function truncateChars(raw: string, max: number): string {
  const chars = Array.from(raw)
  return chars.length <= max ? raw : chars.slice(0, max).join('')
}

/**
 * 把服务端响应转成本地可信的子集：版本由本地重新解析并比较，链接/SHA 由本地再校验，
 * 不采信 update_available（服务端算错也不能让客户端误报有新版本）。
 */
export function evaluateReleaseUpdate(currentVersion: string, payload: unknown): DesktopReleaseEvaluation {
  const empty: DesktopReleaseEvaluation = {
    latestVersion: '', updateAvailable: false, releaseNotes: '', downloadUrl: '', sha256: '',
  }
  const value = asRecord(payload)
  if (!value) return empty
  if (typeof value.latest_version !== 'string') return empty
  const latest = parseSemver(value.latest_version)
  if (!latest) return empty
  const current = parseSemver(currentVersion)
  const releaseNotes = typeof value.release_notes === 'string' ? truncateChars(value.release_notes.trim(), MAX_NOTES_CHARS) : ''
  const downloadUrl = typeof value.download_url === 'string' && isTrustedDownloadUrl(value.download_url)
    ? value.download_url.trim()
    : ''
  const rawSHA = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : ''
  const sha256 = /^[0-9a-f]{64}$/.test(rawSHA) ? rawSHA : ''
  return {
    latestVersion: formatSemver(latest),
    updateAvailable: Boolean(current && compareSemver(latest, current) > 0),
    releaseNotes,
    downloadUrl,
    sha256,
  }
}

function initialStatus(currentVersion: string): DesktopUpdateStatus {
  return {
    status: 'idle',
    currentVersion,
    latestVersion: '',
    updateAvailable: false,
    releaseNotes: '',
    downloadUrl: '',
    sha256: '',
    checkedAt: null,
    error: '',
  }
}

export function createDesktopUpdateChecker(deps: DesktopUpdateCheckerDeps): DesktopUpdateChecker {
  const fetchImpl = deps.fetchImpl ?? fetch
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS
  let status = initialStatus(deps.currentVersion())
  let inFlight: Promise<DesktopUpdateStatus> | null = null
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const snapshot = (): DesktopUpdateStatus => ({ ...status })

  const emit = (next: DesktopUpdateStatus): void => {
    status = next
    if (disposed) return
    try {
      deps.onStatus(snapshot())
    } catch {
      // 监听方异常不能把检查流程打断；状态仍以 getStatus() 为准。
    }
  }

  const run = async (): Promise<DesktopUpdateStatus> => {
    const currentVersion = deps.currentVersion()
    emit({ ...status, status: 'checking', currentVersion, error: '' })
    try {
      const origin = String(deps.apiOrigin() || '').replace(/\/+$/, '')
      const url = `${origin}/api/v1/desktop/release?current=${encodeURIComponent(currentVersion)}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
      let payload: unknown
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        payload = await response.json()
      } finally {
        clearTimeout(timer)
      }
      const evaluated = evaluateReleaseUpdate(currentVersion, payload)
      const next: DesktopUpdateStatus = {
        status: evaluated.latestVersion
          ? (evaluated.updateAvailable ? 'update-available' : 'up-to-date')
          : 'unconfigured',
        currentVersion,
        latestVersion: evaluated.latestVersion,
        updateAvailable: evaluated.updateAvailable,
        releaseNotes: evaluated.releaseNotes,
        downloadUrl: evaluated.downloadUrl,
        sha256: evaluated.sha256,
        checkedAt: Date.now(),
        error: '',
      }
      emit(next)
      return snapshot()
    } catch (error) {
      const aborted = (error as { name?: unknown } | null)?.name === 'AbortError'
      const next: DesktopUpdateStatus = {
        status: 'error',
        currentVersion,
        latestVersion: '',
        updateAvailable: false,
        releaseNotes: '',
        downloadUrl: '',
        sha256: '',
        checkedAt: Date.now(),
        error: aborted ? '检查更新超时，请稍后重试' : '暂时无法连接更新服务，请稍后重试',
      }
      emit(next)
      return snapshot()
    } finally {
      inFlight = null
    }
  }

  const checkNow = (): Promise<DesktopUpdateStatus> => {
    if (inFlight) return inFlight
    inFlight = run()
    return inFlight
  }

  const scheduleStartupCheck = (): void => {
    if (disposed || startupTimer) return
    startupTimer = setTimeout(() => {
      startupTimer = null
      void checkNow()
    }, Math.max(0, startupDelayMs))
    startupTimer.unref?.()
  }

  const dispose = (): void => {
    disposed = true
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
  }

  return {
    getStatus: snapshot,
    checkNow: checkNow,
    scheduleStartupCheck,
    dispose,
  }
}
