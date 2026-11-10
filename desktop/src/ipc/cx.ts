import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { captureCXLongImageFromBuild, cxLongImageFailure, CXLongImageError } from '../cx-long-image';

// DT-08 片 4（≡DEV-S02）：cx-long-image:capture 固定意图拆分。从 main.ts 原样搬出，
// 返回值与在途占用语义逐字节不变。在途捕获集合留在 main.ts（disposeApplicationResources
// 统一清理；单实例门 capture_busy 由集合驱动）。

export function registerCXIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  businessWindow: () => BrowserWindow | null;
  isBusinessUrl: (url: string) => boolean;
  activeCXLongImageCaptures: Set<string>;
}): void {
  const { ipcHandle, businessWindow, isBusinessUrl, activeCXLongImageCaptures } = deps;
  ipcHandle('cx-long-image:capture', async (event, raw) => {
    const senderFrame = event.senderFrame;
    const host = businessWindow();
    if (!host || host.isDestroyed() || event.sender !== host.webContents
      || !senderFrame || senderFrame !== event.sender.mainFrame || !isBusinessUrl(senderFrame.url)
      || !isBusinessUrl(event.sender.getURL())) {
      throw new Error('不允许此窗口发起长图构建。');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).join(',') !== 'buildId'
      || typeof (raw as { buildId?: unknown }).buildId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((raw as { buildId: string }).buildId)) {
      return cxLongImageFailure(new CXLongImageError('invalid_input', '长图构建参数无效。'));
    }
    const buildId = (raw as { buildId: string }).buildId.toLowerCase();
    if (activeCXLongImageCaptures.size > 0) {
      return cxLongImageFailure(new CXLongImageError('capture_busy', '当前已有长图正在生成，请稍后重试。'));
    }
    activeCXLongImageCaptures.add(buildId);
    try {
      return await captureCXLongImageFromBuild(host, buildId);
    } catch (error) {
      return cxLongImageFailure(error);
    } finally {
      activeCXLongImageCaptures.delete(buildId);
    }
  });
}
