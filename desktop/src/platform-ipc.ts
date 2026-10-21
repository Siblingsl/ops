// 平台采集的本机 IPC 契约（D-129 / 20 文档 §11.4）。
// 纯函数模块：信封校验、命令白名单、超时与单飞判定都能单测，不依赖 Electron。
//
// 统一信封 `{v, id, cmd, payload}`；错误结构只含稳定错误码与安全文案，
// 不回传路径、堆栈或原始平台响应。

export const PLATFORM_IPC_VERSION = 1;
export const PLATFORM_IPC_TIMEOUT_MS = 5000;
export const PLATFORM_IPC_MAX_BYTES = 64 * 1024;

// 命令白名单固定；新增命令必须同时改 preload 与本文件，不能由页面任意拼接。
export const PLATFORM_IPC_COMMANDS = Object.freeze([
  'open-login',
  'read-status',
  'request-collect',
  'pause',
  'clear-account-data'
] as const);

export type PlatformIPCCommand = typeof PLATFORM_IPC_COMMANDS[number];

export interface PlatformIPCEnvelope {
  v: number;
  id: string;
  cmd: PlatformIPCCommand;
  payload?: unknown;
}

export interface PlatformIPCError {
  code: string;
  message: string;
}

export class PlatformIPCErrorException extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformIPCError';
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// parseEnvelope 校验信封形状与体积；任何不符都直接拒绝，不做“尽力而为”的修复。
export function parseEnvelope(raw: unknown): PlatformIPCEnvelope {
  if (typeof raw !== 'object' || raw === null) {
    throw new PlatformIPCErrorException('ipc_invalid', '本机请求格式不正确');
  }
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (bytes > PLATFORM_IPC_MAX_BYTES) {
    throw new PlatformIPCErrorException('ipc_too_large', '本机请求超过允许大小');
  }
  const env = raw as Record<string, unknown>;
  if (env.v !== PLATFORM_IPC_VERSION) {
    throw new PlatformIPCErrorException('ipc_version_mismatch', '客户端版本不兼容，请重启应用');
  }
  if (typeof env.id !== 'string' || !ID_RE.test(env.id)) {
    throw new PlatformIPCErrorException('ipc_invalid', '本机请求标识无效');
  }
  if (typeof env.cmd !== 'string' || !(PLATFORM_IPC_COMMANDS as ReadonlyArray<string>).includes(env.cmd)) {
    throw new PlatformIPCErrorException('ipc_unknown_command', '不支持的本机命令');
  }
  return { v: env.v, id: env.id, cmd: env.cmd as PlatformIPCCommand, payload: env.payload };
}

// 单飞：同一命令在途时新的请求直接拒绝，避免并发拉起多个浏览器。
export class PlatformIPCSingleFlight {
  private readonly inflight = new Set<PlatformIPCCommand>();

  begin(cmd: PlatformIPCCommand): void {
    if (this.inflight.has(cmd)) {
      throw new PlatformIPCErrorException('ipc_busy', '该操作正在进行，请稍候');
    }
    this.inflight.add(cmd);
  }

  end(cmd: PlatformIPCCommand): void {
    this.inflight.delete(cmd);
  }

  isBusy(cmd: PlatformIPCCommand): boolean {
    return this.inflight.has(cmd);
  }
}

// withTimeout 给命令加固定超时；超时给出稳定错误码而不是挂起。
export async function withTimeout<T>(promise: Promise<T>, ms: number = PLATFORM_IPC_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PlatformIPCErrorException('ipc_timeout', '本机操作超时，请重试')), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// toIPCError 把内部异常压成稳定错误码 + 安全文案。
// 任何带路径、堆栈、上游响应的信息都不外泄：未知错误统一成 ipc_failed。
export function toIPCError(error: unknown): PlatformIPCError {
  if (error instanceof PlatformIPCErrorException) {
    return { code: error.code, message: error.message };
  }
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (/^(platform_|ipc_)[a-z_]+$/.test(code)) {
      return { code, message: '本机操作失败，请稍后重试' };
    }
  }
  return { code: 'ipc_failed', message: '本机操作失败，请稍后重试' };
}

// validatePayloadShape 只接受各命令已定义的结构化参数，拒绝额外字段。
export function validatePayloadShape(cmd: PlatformIPCCommand, payload: unknown): void {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  switch (cmd) {
    case 'open-login':
      // 本机连接需要同时知道「哪个 OPS 账号」与「哪个平台」：
      // 平台决定 profile 命名空间与允许的登录页，缺一个都无法安全启动浏览器。
      if (!isPlainObject(payload) || typeof payload.accountId !== 'string'
        || typeof payload.platform !== 'string' || Object.keys(payload).length !== 2) {
        throw new PlatformIPCErrorException('ipc_invalid', '登录参数无效');
      }
      if (!/^[0-9a-f-]{36}$/i.test(payload.accountId)) {
        throw new PlatformIPCErrorException('ipc_invalid', '登录参数无效');
      }
      if (payload.platform !== 'xhs' && payload.platform !== 'wechat_mp') {
        throw new PlatformIPCErrorException('platform_not_supported', '该平台暂不支持本机登录采集');
      }
      return;
    case 'read-status':
      if (payload !== undefined && !isPlainObject(payload)) {
        throw new PlatformIPCErrorException('ipc_invalid', '状态查询参数无效');
      }
      return;
    case 'request-collect':
      if (!isPlainObject(payload) || typeof payload.accountId !== 'string' || Object.keys(payload).length !== 1) {
        throw new PlatformIPCErrorException('ipc_invalid', '采集参数无效');
      }
      return;
    case 'pause':
      if (payload !== undefined && (!isPlainObject(payload) || typeof payload.accountId !== 'string')) {
        throw new PlatformIPCErrorException('ipc_invalid', '暂停参数无效');
      }
      return;
    case 'clear-account-data':
      if (!isPlainObject(payload) || typeof payload.accountId !== 'string' || Object.keys(payload).length !== 1) {
        throw new PlatformIPCErrorException('ipc_invalid', '清理参数无效');
      }
      return;
    default:
      throw new PlatformIPCErrorException('ipc_unknown_command', '不支持的本机命令');
  }
}
