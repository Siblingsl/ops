import type { IpcMainInvokeEvent } from 'electron';
import { clearInBrowseData, inBrowseDataStats, type InBrowseViewController } from '../in-browse';

// DT-08 片 8（docs/33 §10.8 DT-08；≡DEV-S02）：main.ts 的 inbrowse:* 通道拆分。
// 14 个内置浏览视图固定意图搬入本模块；requireInBrowse 来源校验（业务窗主框架 +
// bindInBrowseController + 快照推送闭包）由 main.ts 依赖注入，行为逐字节搬移。

export function registerInBrowseIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  requireInBrowse: (event: IpcMainInvokeEvent) => InBrowseViewController;
}): void {
  const { ipcHandle, requireInBrowse } = deps;
  ipcHandle('inbrowse:set-bounds', (event, raw) => {
    const controller = requireInBrowse(event);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bounds 参数无效。');
    const b = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
    controller.setBounds({ x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height) });
    return controller.snapshot();
  });
  ipcHandle('inbrowse:navigate', (event, raw) => {
    const controller = requireInBrowse(event);
    const url = typeof raw === 'string' ? raw : '';
    const result = controller.navigate(url);
    if (!result.ok) throw new Error(`inbrowse_navigate_denied: ${result.reason}`);
    return controller.snapshot();
  });
  ipcHandle('inbrowse:back', (event) => { requireInBrowse(event).goBack(); return null; });
  ipcHandle('inbrowse:forward', (event) => { requireInBrowse(event).goForward(); return null; });
  ipcHandle('inbrowse:reload', (event) => { requireInBrowse(event).reload(); return null; });
  ipcHandle('inbrowse:stop', (event) => { requireInBrowse(event).stopLoading(); return null; });
  // DEV-AI27-08d（W08d）：多页签意图。
  ipcHandle('inbrowse:open-tab', (event) => { const c = requireInBrowse(event); return { id: c.openTab() }; });
  ipcHandle('inbrowse:switch-tab', (event, raw) => {
    const tabID = typeof raw === 'string' ? raw : '';
    if (!requireInBrowse(event).switchTab(tabID)) throw new Error('inbrowse_tab_unknown');
    return null;
  });
  ipcHandle('inbrowse:reorder-tab', (event, raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('reorder 参数无效。');
    const b = raw as { from?: unknown; to?: unknown };
    if (!requireInBrowse(event).reorderTab(String(b.from ?? ''), String(b.to ?? ''))) throw new Error('inbrowse_reorder_invalid');
    return null;
  });
  ipcHandle('inbrowse:close-tab', (event, raw) => {
    const tabID = typeof raw === 'string' ? raw : '';
    requireInBrowse(event).closeTab(tabID);
    return null;
  });
  ipcHandle('inbrowse:close', (event) => {
    // 兼容旧通道：关闭活动页签（无活动时等效清理）。
    const c = requireInBrowse(event);
    const active = c.snapshot().activeTabId;
    if (active) c.closeTab(active);
    return null;
  });
  ipcHandle('inbrowse:snapshot', (event) => requireInBrowse(event).snapshot());
  // DEV-AI27-08g（27 §14.5）：浏览数据管理——只读统计与受控清理，仅 persist:ops-inbrowse。
  ipcHandle('inbrowse:data-stats', () => inBrowseDataStats());
  ipcHandle('inbrowse:clear-data', (event, raw) => {
    requireInBrowse(event);
    const kind = typeof raw === 'string' ? raw : '';
    if (kind !== 'cache' && kind !== 'cookies' && kind !== 'all') throw new Error('inbrowse_data_kind_invalid');
    return clearInBrowseData(kind);
  });
}
