// 稳定错误码与单次动作超时。超时一律映射 executor_timeout，不伪装成功。
export class PublishExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PublishExecutorError';
    this.code = code;
  }
}

export function publishExecutorErrorCode(err: unknown): string {
  if (!err) return '';
  if (err instanceof PublishExecutorError) return err.code;
  return 'executor_failed';
}

export async function withPublishTimeout<T>(work: Promise<T>, timeoutMs: number, action: string): Promise<T> {
  if (!(timeoutMs > 0)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PublishExecutorError('executor_timeout', `${action} 超过 ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
