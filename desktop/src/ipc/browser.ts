import type { IpcMainInvokeEvent } from 'electron';
import { getActiveBridge } from '../browser-bridge';

// DT-08 片 9（docs/33 §10.8 DT-08）：main.ts 的 browser:* 通道拆分。
// 本机标签枚举（A30）与配对快照/确认（A30b）3 个固定意图搬入本模块；
// requireComputerCaller 由 main.ts 依赖注入，行为逐字节搬移：
// 枚举在本机、服务端只知道选中项，不进服务端命令账本；桥未启动/未配对时如实返回。

export function registerBrowserIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  requireComputerCaller: (event: IpcMainInvokeEvent) => void;
}): void {
  const { ipcHandle, requireComputerCaller } = deps;
  // DEV-AI27-A30：本机标签枚举（选标签授权弹窗用）。与 computer:list-windows 同构——
  // 用户主动 UI 动作的本机枚举（27 §13.2/C09 精神）：枚举在本机、服务端只知道选中项，
  // 不进服务端命令账本（账本只记 AI 动作）。桥未启动/未配对时如实返回真实状态，不伪造列表。
  ipcHandle('browser:list-tabs', async (event) => {
    requireComputerCaller(event);
    const bridge = getActiveBridge();
    if (!bridge) {
      return { ok: false as const, code: 'browser_bridge_not_running', message: '浏览器桥未在本会话启动；浏览器协作链路尚未在正式版开启。' };
    }
    if (bridge.state !== 'paired') {
      return { ok: false as const, code: 'browser_not_paired', message: `浏览器桥未配对（当前状态 ${bridge.state}）；请先完成 OPS 与 Chrome 扩展的配对。` };
    }
    const result = await bridge.dispatchAndWait('tabs_list', {}, 15000);
    if (!result.ok) {
      return { ok: false as const, code: result.code, message: '标签枚举未得到回执；请确认 Chrome 与 OPS 扩展正在运行后重试。' };
    }
    const raw = result.result as { tabs?: Array<Record<string, unknown>> } | null;
    const tabs = Array.isArray(raw?.tabs) ? (raw?.tabs as Array<Record<string, unknown>>) : [];
    const out: Array<{ tab_id: number; title: string; origin: string; window_id: number; active: boolean }> = [];
    for (const t of tabs.slice(0, 200)) {
      if (typeof t.id !== 'number' || !Number.isSafeInteger(t.id)) continue;
      out.push({
        tab_id: t.id,
        title: typeof t.title === 'string' ? t.title.slice(0, 120) : '',
        origin: typeof t.origin === 'string' ? t.origin.slice(0, 200) : '',
        window_id: typeof t.window_id === 'number' && Number.isSafeInteger(t.window_id) ? t.window_id : 0,
        active: t.active === true,
      });
    }
    return { ok: true as const, tabs: out };
  });
  // A30b（用户拍板：一次动作两产物）：配对统一。工作台"浏览器"页签向导读桥侧配对
  // 快照（短码与 Chrome 扩展弹窗同源）；用户核对后点"确认配对"→ 桥建 HMAC 会话并
  // 把扩展实例 ID 交给渲染器，由渲染器调服务端 pairings+confirm 落绑定。快照经
  // pairingSnapshot() 生成，源头就不含会话密钥；preload 白名单校验兜底。
  ipcHandle('browser:pairing-state', (event) => {
    requireComputerCaller(event);
    const bridge = getActiveBridge();
    if (!bridge) {
      return { ok: false as const, code: 'browser_bridge_not_running', message: '浏览器桥未在本会话启动。' };
    }
    return { ok: true as const, snapshot: bridge.pairingSnapshot() };
  });
  ipcHandle('browser:confirm-pairing', (event) => {
    requireComputerCaller(event);
    const bridge = getActiveBridge();
    if (!bridge) {
      return { ok: false as const, code: 'browser_bridge_not_running', message: '浏览器桥未在本会话启动。' };
    }
    const confirmed = bridge.confirmPairing();
    if (!confirmed.ok) {
      return { ok: false as const, code: 'browser_pairing_confirm_failed', message: confirmed.reason ?? '配对确认失败' };
    }
    return { ok: true as const, extension_instance_id: bridge.pairingSnapshot().extension_instance_id };
  });
}
