// 登录与采集策略分开；策略在导航和新 target 继续执行前安装。
import { isAllowedPlatformUrl, PlatformBrowserError, type CDPPageClient } from './platform-worker';

export function isAllowedLoginNavigation(rawUrl: string, platform: string): boolean {
  if (rawUrl === 'about:blank' || isAllowedPlatformUrl(rawUrl, platform)) return true;
  // 2026-10-21 Chrome / Edge 真实首屏：公众号首页在此 iframe 呈现登录码，
  // 并打开同域 /connect/qrconnect 子页。仅允许这两个认证路由。
  try {
    const url = new URL(rawUrl);
    return platform === 'wechat_mp' && !url.username && !url.password && url.origin === 'https://open.weixin.qq.com' && ['/cgi-bin/mpqrconnect', '/connect/qrconnect'].includes(url.pathname);
  } catch { return false; }
}

export async function installLoginNavigationPolicy(cdp: CDPPageClient, platform: string, blocked: () => void): Promise<() => void> {
  const installs = new Map<string, Promise<void>>();
  let active = true;
  const enable = (sessionId?: string): Promise<void> => {
    const key = sessionId ?? '';
    if (installs.has(key)) return installs.get(key)!;
    const pending = (async () => {
      // Document 同时覆盖顶层、iframe 及认证弹窗。未知认证来源先拒绝。
      await cdp.request('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, 5000, sessionId);
      await cdp.request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 5000, sessionId);
    })();
    installs.set(key, pending);
    return pending;
  };
  const unsubscribe = cdp.onEvent((method, raw, sessionId) => {
    if (!active) return;
    const data = raw as { sessionId?: string; targetInfo?: { type?: string }; requestId?: string; request?: { url?: string } };
    if (method === 'Target.attachedToTarget' && data.sessionId) {
      const childSession = data.sessionId;
      const childType = data.targetInfo?.type ?? '';
      void (async () => {
        if (['page', 'iframe'].includes(childType)) await enable(childSession);
        else if (['service_worker', 'shared_worker', 'worker'].includes(childType)) {
          // 登录阶段不启动后台读取 worker；不允许它绕开文档导航策略。
          await cdp.request('Runtime.terminateExecution', {}, 5000, childSession);
        }
        await cdp.request('Runtime.runIfWaitingForDebugger', {}, 5000, childSession);
      })().catch((error) => {
        // 子框架（尤其是扫码 iframe）在受限环境下常让某个 CDP 调用失败
        // （`Fetch.enable` 被拒、`setAutoAttach` 冲突、target 已销毁等）。
        //
        // 早期这里直接 `blocked()` —— 会**关掉整个浏览器**，用户刚切到扫码
        // 窗口就消失（实测：小红书 `/login` 点“切到扫码”必现）。
        //
        // 现在只记录并放行：**主框架的文档导航策略仍然生效**
        // （下面 `Fetch.requestPaused` 分支照常拦截并 `blocked()`），
        // 安全边界没有降低——只是不再因为一个子框架装不上就把整个会话杀掉。
        if (process.env.OPS_DIAG_LOGIN_NAV === '1') {
          console.error('[login-policy] child-attach-failed', JSON.stringify({
            platform, childType, err: String((error as Error)?.message ?? error).slice(0, 120)
          }));
        }
      });
    }
    if (method === 'Fetch.requestPaused' && data.requestId) {
      const pausedUrl = data.request?.url ?? '';
      const allowed = isAllowedLoginNavigation(pausedUrl, platform);
      // 诊断：被拦时打印域名（只打 origin + path 前缀，不含查询串与任何凭据），
      // 便于确认登录跳转到底经过哪些官方域名，而不是凭猜测放宽白名单。
      if (!allowed && process.env.OPS_DIAG_LOGIN_NAV === '1') {
        try {
          const u = new URL(pausedUrl);
          console.error('[login-policy] blocked', JSON.stringify({
            platform, origin: u.origin, path: u.pathname.slice(0, 60)
          }));
        } catch {
          console.error('[login-policy] blocked', JSON.stringify({ platform, origin: '(unparsable)' }));
        }
      }
      void cdp.request(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: data.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, 5000, sessionId).catch(() => blocked());
      if (!allowed) blocked();
    }
  });
  try {
    await enable();
    await cdp.request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 5000, null);
  } catch {
    unsubscribe();
    throw new PlatformBrowserError('platform_capability_denied', '无法建立官方登录页导航保护');
  }
  return () => { active = false; unsubscribe(); };
}
