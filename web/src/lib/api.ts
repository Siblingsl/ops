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
  return new ApiError(res.status, 'internal', `请求失败（${res.status}）`)
}

export async function rawRequest(method: string, path: string, body?: unknown, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { 'X-CSRF-Token': csrf }
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch('/api/v1' + path, { method, headers, body: payload, credentials: 'same-origin', ...init })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'network', '网络连接失败，请检查网络后重试')
  }
  if (res.ok) return res
  const err = await parseError(res)
  if (err.code === 'unauthenticated' && !path.startsWith('/auth/')) onUnauthenticated?.()
  if (err.code === 'reauth_required' && reauthPrompt) {
    if (await reauthPrompt()) return rawRequest(method, path, body, init)
  }
  throw err
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await rawRequest(method, path, body)
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

export const get = <T>(p: string) => api<T>('GET', p)
export const post = <T>(p: string, b?: unknown) => api<T>('POST', p, b ?? {})
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
  const res = await rawRequest('POST', path, body, { signal: h.signal })
  const ctype = res.headers.get('Content-Type') || ''
  if (!ctype.startsWith('text/event-stream')) return (await res.json()) as T
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done: T | undefined
  let failure: ApiError | undefined
  const handle = (block: string) => {
    let name = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (!data) return
    const parsed = JSON.parse(data)
    if (name === 'delta') h.onDelta?.(parsed.text)
    else if (name === 'error') failure = new ApiError(500, parsed.code || 'internal', parsed.message || '生成失败', parsed.detail)
    else if (name === 'done') done = parsed
    h.onEvent?.(name, parsed)
  }
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
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
