// B-01.6：平台登录人工接管的原生窗口。
//
// 背景：平台登录浏览器由 platform-worker 以 `--disable-extensions` 启动，
// 扩展卡片不可达；docs/20 §5.1 又禁止向登录页注入 DOM。这里用 Electron 自己的
// always-on-top 窗口显示提示，用户点击后通过页面标题哨兵回传 handoff_complete。
// 它不是登录成功的证明：platform-login 收到信号后仍继续轮询平台页面的真实身份。

import { BrowserWindow } from 'electron';
import {
  buildPlatformLoginHandoffHtml,
  HANDOFF_COMPLETE_TITLE,
  type PlatformLoginHandoffPageInput
} from './platform-login-handoff-page';

export type PlatformLoginHandoffResult = 'completed' | 'dismissed' | 'timeout' | 'failed';

interface ActiveHandoff {
  win: BrowserWindow;
  finish: (result: PlatformLoginHandoffResult) => void;
}

let active: ActiveHandoff | null = null;

/** 关闭当前提示（登录成功/失败/退出时调用），返回 dismissed。 */
export function dismissPlatformLoginHandoff(): void {
  if (!active) return;
  active.finish('dismissed');
}

/**
 * 显示原生接管提示；同一时间只保留一个窗口。调用方不应 await 它来阻塞登录轮询，
 * 而应让轮询继续，点击后立即再探一次身份。
 */
export function showPlatformLoginHandoff(
  input: PlatformLoginHandoffPageInput,
  options: { timeoutMs?: number } = {}
): Promise<PlatformLoginHandoffResult> {
  dismissPlatformLoginHandoff();
  return new Promise<PlatformLoginHandoffResult>((resolve) => {
    let settled = false;
    const settle = (result: PlatformLoginHandoffResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active?.win === win) active = null;
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };

    const win = new BrowserWindow({
      width: 460,
      height: 260,
      center: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      title: 'OPS 平台登录人工接管',
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      }
    });
    active = { win, finish: settle };

    const timer = setTimeout(() => settle('timeout'), options.timeoutMs ?? 120_000);
    timer.unref?.();

    win.on('page-title-updated', (event, title) => {
      if (title !== HANDOFF_COMPLETE_TITLE) return;
      event.preventDefault();
      settle('completed');
    });
    win.on('closed', () => settle('dismissed'));
    win.webContents.on('did-fail-load', () => settle('failed'));

    const html = buildPlatformLoginHandoffHtml(input);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => settle('failed'));
    win.once('ready-to-show', () => {
      win.setAlwaysOnTop(true, 'floating');
      win.show();
      win.focus();
    });
  });
}
