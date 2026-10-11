import { toast } from 'sonner'

export class ApiError extends Error {
  status: number
  code: string
  detail: unknown
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.detail = detail
  }
  get checkpoint(): string | undefined {
    const d = this.detail as { checkpoint?: string } | undefined
    return d?.checkpoint
  }
}

let csrf = ''
export function setCsrf(token: string) {
  csrf = token
}

type ReauthPrompt = () => Promise<boolean>
let reauthPrompt: ReauthPrompt | null = null
export function registerReauthPrompt(fn: ReauthPrompt) {
  reauthPrompt = fn
}

let onUnauthenticated: (() => void) | null = null
export function registerUnauthenticated(fn: () => void) {
  onUnauthenticated = fn
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json()
    const e = body?.error
    if (e) return new ApiError(res.status, e.code, e.message, e.detail)
  } catch {
    /* not JSON */
  }
  const messages: Record<number, string> = {
    413: '文件太大，最大 20MB',
    429: '请求太频繁，请稍后重试',
    502: '服务暂不可用，服务正在重启，请稍后重试',
    503: '服务暂不可用，请稍后重试',
    504: '服务暂不可用，请求超时，请稍后重试',
  }
  return new ApiError(res.status, 'internal', messages[res.status] || `请求失败（${res.status}）`)
}

let fallbackUntil = 0
/** preferFallbackModel sends AI requests straight to each route's backup model for the next few minutes. */
export function preferFallbackModel(minutes = 10) {
  fallbackUntil = Date.now() + minutes * 60_000
}

async function fetchResponse(method: string, path: string, payload: BodyInit | undefined, headers: Record<string, string>, init: RequestInit | undefined, streaming: boolean): Promise<Response> {
  const timeout = streaming ? 90_000 : payload instanceof FormData ? 120_000 : 30_000
  const controller = new AbortController()
  const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    for (let attempt = 0; ; attempt++) {
      let res = await fetch('/api/v1' + path, { method, headers, body: payload, credentials: 'same-origin', ...init, signal })
      if (streaming && res.ok && res.headers.get('Content-Type')?.startsWith('text/event-stream')) return res
      if (res.body) res = new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: res.headers })
      if (method === 'GET' && attempt === 0 && [502, 503, 504].includes(res.status)) continue
      if (res.ok) return res
      throw await parseError(res)
    }
  } catch (e) {
    if (init?.signal?.aborted) throw e
    if (controller.signal.aborted) throw new ApiError(504, 'timeout', '服务暂不可用，请求超时，请稍后重试')
    if (e instanceof ApiError) throw e
    throw new ApiError(0, 'network', '服务暂不可用，请检查网络后重试')
  } finally {
    window.clearTimeout(timer)
  }
}

export async function rawRequest(method: string, path: string, body?: unknown, init?: RequestInit, streaming = false): Promise<Response> {
  const headers: Record<string, string> = { 'X-CSRF-Token': csrf }
  if (fallbackUntil > Date.now()) headers['X-AI-Prefer'] = 'fallback'
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    for (const value of body.values()) {
      if (value instanceof File && value.size > 20 * 1024 * 1024) throw new ApiError(413, 'upload_too_large', '文件太大，最大 20MB')
    }
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  try {
    return await fetchResponse(method, path, payload, headers, init, streaming)
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    if (e.code === 'unauthenticated' && !path.startsWith('/auth/')) onUnauthenticated?.()
    if (e.code === 'reauth_required' && reauthPrompt && await reauthPrompt()) return rawRequest(method, path, body, init, streaming)
    throw e
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await rawRequest(method, path, body, init)
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

export const get = <T>(p: string) => api<T>('GET', p)
export const post = <T>(p: string, b?: unknown, signal?: AbortSignal) => api<T>('POST', p, b ?? {}, signal ? { signal } : undefined)
export const put = <T>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {})
export const patch = <T>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {})
export const del = <T>(p: string, b?: unknown) => api<T>('DELETE', p, b)

export interface SSEHandlers {
  onDelta?: (text: string) => void
  onEvent?: (name: string, data: any) => void
  signal?: AbortSignal
}

/** stream posts and reads server-sent events; resolves with the `done` payload. */
export async function stream<T = any>(path: string, body: unknown, h: SSEHandlers = {}): Promise<T> {
  const res = await rawRequest('POST', path, body, { signal: h.signal }, true)
  const ctype = res.headers.get('Content-Type') || ''
  if (!ctype.startsWith('text/event-stream')) return (await res.json()) as T
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done: T | undefined
  let failure: ApiError | undefined
  let queuedToast: string | number | undefined
  const handle = (block: string) => {
    let name = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (!data) return
    const parsed = JSON.parse(data)
    if (name === 'stage' && parsed.stage === 'queued') {
      queuedToast ??= toast.loading('排队中', { description: '当前工作区的 AI 任务正在运行，请稍候', duration: Infinity })
    } else if (queuedToast !== undefined && (name === 'stage' || name === 'delta')) {
      toast.dismiss(queuedToast)
      queuedToast = undefined
    }
    if (name === 'delta') h.onDelta?.(parsed.text)
    else if (name === 'error') failure = new ApiError(500, parsed.code || 'internal', parsed.message || '生成失败', parsed.detail)
    else if (name === 'done') done = parsed
    h.onEvent?.(name, parsed)
  }
  try {
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        handle(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
      }
    }
    if (buf.trim()) handle(buf)
    if (failure) throw failure
    return done as T
  } finally {
    if (queuedToast !== undefined) toast.dismiss(queuedToast)
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
