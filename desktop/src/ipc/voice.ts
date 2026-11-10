import type { IpcMainInvokeEvent } from 'electron';
import { RealtimeBridge } from '../voice-realtime';

// DT-08 片 2（≡DEV-S02）：voice:realtime-* 固定意图拆分。从 main.ts 原样搬出，
// 返回值形状与调用方校验逐字节不变；realtimeBridge 单例由 main.ts 创建后传入
// （事件转发回 businessWindow 的闭包留在 main.ts）。

let realtimeBridgeRef: RealtimeBridge | null = null;

/** 退出清理（DT-03）触达句柄。 */
export function stopRealtimeBridge(): void {
  realtimeBridgeRef?.stop();
}

/** main.ts 创建 RealtimeBridge 后登记；registerVoiceIpcHandlers 依赖它非空。 */
export function setRealtimeBridge(bridge: RealtimeBridge | null): void {
  realtimeBridgeRef = bridge;
}

export function registerVoiceIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  requireRealtimeCaller: (event: IpcMainInvokeEvent) => RealtimeBridge;
}): void {
  const { ipcHandle, requireRealtimeCaller } = deps;
  // DEV-AI27-16 第六批（A2，27 §11.4.5）：realtime 双向音频桥——固定意图，渲染器不接触密钥。
  // start/append/commit/interrupt/stop 转发 RealtimeBridge；事件经 desktop-ui:realtime-event 推送。
  ipcHandle('voice:realtime-status', () => realtimeBridgeRef?.statusView() ?? null);
  ipcHandle('voice:realtime-start', async (event, raw) => {
    const bridge = requireRealtimeCaller(event);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('realtime_args_invalid');
    const b = raw as { session_id?: unknown; token?: unknown; proxy_endpoint?: unknown; proxy_url?: unknown; model?: unknown; provider?: unknown };
    const result = await bridge.start({
      sessionID: String(b.session_id ?? ''),
      token: String(b.token ?? ''),
      proxyEndpoint: String(b.proxy_endpoint ?? ''),
      proxyURL: b.proxy_url === undefined ? undefined : String(b.proxy_url),
      model: String(b.model ?? ''),
      provider: String(b.provider ?? ''),
    });
    return result;
  });
  ipcHandle('voice:realtime-append', (event, raw) => {
    const bridge = requireRealtimeCaller(event);
    if (!raw || typeof raw !== 'object' || typeof (raw as { dataBase64?: unknown }).dataBase64 !== 'string') {
      throw new Error('realtime_chunk_invalid');
    }
    return bridge.append({ dataBase64: String((raw as { dataBase64: unknown }).dataBase64) });
  });
  ipcHandle('voice:realtime-commit', (event) => {
    const bridge = requireRealtimeCaller(event);
    return bridge.commit();
  });
  ipcHandle('voice:realtime-interrupt', (event) => {
    const bridge = requireRealtimeCaller(event);
    return bridge.interrupt();
  });
  ipcHandle('voice:realtime-stop', (event) => {
    const bridge = requireRealtimeCaller(event);
    bridge.stop();
    return null;
  });
}
