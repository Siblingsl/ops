/**
 * 父进程（终端 / IDE / 启动器）关掉 stdout/stderr 管道后，主进程再 console.*
 * 会抛 EPIPE。平台心跳与自动采集每 30s 打一次日志，就会反复弹出
 * 「A JavaScript error occurred in the main process」。
 *
 * 本模块在被 import 时立刻 patch write（见文件末尾），且必须排在
 * `import 'electron'` 之前，这样即便直接启动 `.build/main.js` 也能生效。
 */

export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPIPE' || code === 'EIO';
}

let installed = false;
let fatalHandler: ((error: unknown) => void) | undefined;

function patchWriteStream(stream: NodeJS.WriteStream | null | undefined): void {
  if (!stream || typeof stream.write !== 'function') return;

  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (isBrokenPipeError(error)) return;
  });

  const originalWrite = stream.write.bind(stream) as NodeJS.WriteStream['write'];
  stream.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    const done = typeof encoding === 'function' ? encoding : typeof cb === 'function' ? cb : undefined;
    try {
      if (typeof encoding === 'function' || encoding === undefined) {
        return (originalWrite as (chunk: unknown, cb?: unknown) => boolean)(chunk, done);
      }
      return (originalWrite as (chunk: unknown, encoding: unknown, cb?: unknown) => boolean)(chunk, encoding, done);
    } catch (error) {
      if (isBrokenPipeError(error)) {
        if (typeof done === 'function') {
          try {
            done();
          } catch {
            // ignore
          }
        }
        return true;
      }
      throw error;
    }
  }) as NodeJS.WriteStream['write'];
}

export function installBrokenPipeGuard(onOtherUncaught?: (error: unknown) => void): void {
  // bootstrap/main 可能各调用一次：第二次只更新 fatal handler。
  if (onOtherUncaught) fatalHandler = onOtherUncaught;
  if (installed) return;
  installed = true;

  patchWriteStream(process.stdout);
  patchWriteStream(process.stderr);

  process.on('uncaughtException', (error) => {
    if (isBrokenPipeError(error)) return;
    fatalHandler?.(error);
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

// 一被 require 就安装，抢在同文件后续的 require('electron') 之前（取决于 import 顺序）。
installBrokenPipeGuard();
