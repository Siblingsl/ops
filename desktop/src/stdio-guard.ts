/**
 * 父进程（终端 / IDE / 启动器）关掉 stdout/stderr 管道后，主进程再 console.*
 * 会抛 EPIPE。平台心跳与自动采集每 30s 打一次日志，就会反复弹出
 * 「A JavaScript error occurred in the main process」。
 *
 * 在这里统一吞掉 broken-pipe；其它未捕获异常仍交给调用方决定如何展示。
 */

export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPIPE' || code === 'EIO';
}

let installed = false;

export function installBrokenPipeGuard(onOtherUncaught?: (error: unknown) => void): void {
  if (installed) return;
  installed = true;

  const ignoreBrokenPipe = (error: NodeJS.ErrnoException): void => {
    if (isBrokenPipeError(error)) return;
  };
  process.stdout?.on('error', ignoreBrokenPipe);
  process.stderr?.on('error', ignoreBrokenPipe);

  process.on('uncaughtException', (error) => {
    if (isBrokenPipeError(error)) return;
    onOtherUncaught?.(error);
  });
}

/** 定时器路径上的日志：管道断开时不得变成未捕获异常弹窗。 */
export function safeConsoleError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch (error) {
    if (isBrokenPipeError(error)) return;
    throw error;
  }
}
